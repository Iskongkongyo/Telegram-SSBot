const TelegramBot = require('node-telegram-bot-api');
const mysql = require('mysql2/promise');
const fs = require('fs').promises;
const createReadStream = require('fs').createReadStream;
const createWriteStream = require('fs').createWriteStream;
const path = require('path');
const chokidar = require('chokidar');
const winston = require('winston');
const { exec } = require('child_process');
const os = require('os');
const archiver = require('archiver');

// ==========================================
// TG开车机器人 - 生产环境优化版（Gemini3Pro优化）
// 播放视频和上传视频响应均会出现去重和下载按钮！！！
//目前群组任何人均可操控芙芙开车机器人，例如：/kc@机器人用户名、/zt@机器人用户名
//部署本代码的机器人可以在群组或者个人用户中提供服务，频道暂时不行，被@也收不到消息
//本代码能存储错误信息到error.log文件中，存储运行日志信息到run.log文件中
//msg.chat.type可以获取聊天对象类型。private为用户，supergroup为群组
//id为负数的为群组，正数的为用户
// ==========================================

// 常量定义
const CONSTANTS = {
    UPLOAD_SUMMARY_DELAY: 60000, // 管理员上传视频响应合并时间
    PING_INTERVAL: 300000,       // 数据库保活心跳
    DEFAULT_PUSH_INTERVAL: 600000, // 默认推送间隔
    CONFIG_PATH: path.join(__dirname, 'config.json') // 使用绝对路径
};

// 初始化日志系统
const logger = winston.createLogger({
    level: 'info',
    format: winston.format.combine(
        winston.format.timestamp({ format: () => new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false }) }),
        winston.format.printf(({ timestamp, level, message }) => `${timestamp} [${level.toUpperCase()}] ${message}`)
    ),
    transports: [
        new winston.transports.File({ filename: path.join(__dirname, 'error.log'), level: 'error' }),
        new winston.transports.File({ filename: path.join(__dirname, 'run.log') }),
        new winston.transports.Console() // 开发调试时在控制台也输出
    ]
});

class VideoBot {
    constructor() {
        this.config = {};
        this.pool = null;
        this.bot = null;
        
        // 状态管理容器
        this.state = {
            pushTimers: new Map(),      // 推送定时器 Map<chatId, {timer, nextIndex}>
            uploadCooldown: new Map(),  // 上传防刷/合并 Map<adminId, {count, timer, chatId}>
            dbPingTimer: null           // 数据库心跳定时器
        };
    }

    async initialize() {
        await this.loadConfig();
        await this.initializeDatabase();
        this.setupConfigWatcher();
        this.startBot();
        
        // 优雅退出处理
        process.on('SIGINT', () => this.shutdown());
        process.on('SIGTERM', () => this.shutdown());
    }

    async shutdown() {
        logger.info('正在关闭服务...');
        if (this.state.dbPingTimer) clearInterval(this.state.dbPingTimer);
        
        // 清理所有推送定时器
        for (const [chatId, data] of this.state.pushTimers) {
            clearTimeout(data.timer);
        }
        
        if (this.pool) await this.pool.end();
        logger.info('已关闭服务');
        process.exit(0);
    }

    async loadConfig() {
        try {
            const rawData = await fs.readFile(CONSTANTS.CONFIG_PATH, 'utf8');
            this.config = JSON.parse(rawData);
            logger.info('配置已加载');
        } catch (err) {
            logger.error(`配置文件加载失败: ${err.message}`);
            // 首次加载失败直接退出，后续热重载失败则保持旧配置
            if (!this.bot) process.exit(1);
        }
    }

    setupConfigWatcher() {
        // 使用绝对路径监听
        chokidar.watch(CONSTANTS.CONFIG_PATH).on('change', async () => {
            logger.info('检测到配置文件更改，重新加载...');
            await this.loadConfig();
            // 重新初始化数据库连接（如果数据库配置变更）
            await this.initializeDatabase();
        });
    }

    async initializeDatabase() {
        // 1. 清理旧连接和定时器，防止内存泄漏
        if (this.state.dbPingTimer) {
            clearInterval(this.state.dbPingTimer);
            this.state.dbPingTimer = null;
        }
        if (this.pool) {
            try { await this.pool.end(); } catch (e) { /* ignore */ }
        }

        // 2. 创建新连接池
        this.pool = mysql.createPool({
            ...this.config.sql,
            waitForConnections: true,
            connectionLimit: 10,
            queueLimit: 0,
            // 建议添加 dateStrings 避免时间格式问题
            dateStrings: true 
        });

        // 3. 测试连接并设置心跳
        try {
            await this.pool.query('SELECT 1');
            logger.info('数据库连接成功');

            this.state.dbPingTimer = setInterval(async () => {
                try {
                    await this.pool.query('SELECT 1');
                } catch (err) {
                    logger.error('数据库心跳丢失，尝试重连...');
                    await this.initializeDatabase();
                }
            }, this.config.pingInterval || CONSTANTS.PING_INTERVAL);

        } catch (err) {
            logger.error(`数据库连接失败: ${err.message}`);
            if (!this.bot) process.exit(1);
        }
    }

    startBot() {
        if (this.bot) {
            // 如果是热重载导致重新启动bot，需要停止旧的 polling
            this.bot.stopPolling();
        }

        this.bot = new TelegramBot(this.config.botToken, { polling: true });
        this.registerHandlers();
        logger.info('机器人已启动，监听消息中...');
    }

    registerHandlers() {
        this.bot.on('message', this.handleMessage.bind(this));
        
        // 命令正则匹配
        this.bot.onText(/\/kc/, async (msg) => this.authWrapper(msg, this.handleKcCommand.bind(this)));
        this.bot.onText(/\/zt/, async (msg) => this.authWrapper(msg, (m) => this.handlePause(m.chat.id)));
        
        this.bot.on('callback_query', this.handleCallbackQuery.bind(this));
        
        // 错误处理，防止 crash
        this.bot.on('polling_error', (error) => logger.error(`Telegram Polling Error: ${error.code} - ${error.message}`));
    }

    // 统一权限验证包装器
    async authWrapper(msg, handler) {
        if (await this.checkGroupPermissions(msg)) {
            await handler(msg);
        }
    }

    async checkGroupPermissions(msg) {
        const { chat, from } = msg;
        if (!from) return false;
        
        // 私聊直接通过（或者根据需求拦截）
        if (chat.type === 'private') return true;
        
        // 群组验证管理员权限
        try {
            const member = await this.bot.getChatMember(chat.id, from.id);
            return ['administrator', 'creator'].includes(member.status);
        } catch (err) {
            logger.error(`权限验证失败: ${err.message}`);
            return false;
        }
    }

    isAdmin(userId) {
        return Array.isArray(this.config.adminIds) && this.config.adminIds.includes(String(userId));
    }

    // 处理消息（主要用于管理员上传）
    async handleMessage(msg) {
        const { chat, from, video } = msg;
        // 仅管理员且包含视频时处理
        if (video && this.isAdmin(from.id)) {
            await this.processVideoUpload(video.file_id, from.id, chat.id);
        }
    }

    async processVideoUpload(fileId, adminId, chatId) {
        try {
            await this.pool.query('INSERT INTO videos (url) VALUES (?)', [fileId]);
            logger.info(`管理员 ${adminId} 上传视频: ${fileId}`);

            const adminState = this.state.uploadCooldown.get(adminId) || { count: 0, timer: null, chatId };
            adminState.count++;
            
            // 防刷/合并通知逻辑
            if (adminState.timer) clearTimeout(adminState.timer);
            
            adminState.timer = setTimeout(async () => {
                try {
                    const [[{ count }]] = await this.pool.query('SELECT COUNT(*) as count FROM videos');
                    await this.bot.sendMessage(
                        adminState.chatId, 
                        `[管理员 ${adminId}] 您好，已成功入库 ${adminState.count} 个视频\n当前总库存：${count}`,
                        this.config.uploadVideosInfos
                    );
                    this.state.uploadCooldown.delete(adminId);
                } catch (err) {
                    logger.error(`上传汇总通知失败: ${err.message}`);
                }
            }, CONSTANTS.UPLOAD_SUMMARY_DELAY);

            this.state.uploadCooldown.set(adminId, adminState);
        } catch (err) {
            logger.error(`视频入库失败: ${err.message}`);
            // 只有数据库报错才回复，避免刷屏
            if(err.code !== 'ER_DUP_ENTRY') { 
                this.sendErrorMessage(chatId, '视频入库异常');
            }
        }
    }

    async handleKcCommand(msg) {
        const chatId = msg.chat.id;
        try {
            if (this.state.pushTimers.has(chatId)) {
                await this.bot.sendMessage(chatId, '正在推送中，请勿重复执行~');
                return;
            }

            // 获取群组当前进度
            // 注意：这里需要确保 groups 表 chatid 有唯一索引
            const [rows] = await this.pool.query('SELECT now FROM `groups` WHERE chatid = ?', [String(chatId)]);
            
            // 默认为 0
            const startIndex = rows.length > 0 ? rows[0].now : 0;
            
            // 只有不存在记录时才插入，存在则忽略 (INSERT IGNORE)
            // 这样比 ON DUPLICATE KEY UPDATE 少一次写操作
            await this.pool.query('INSERT IGNORE INTO `groups` (chatid, now) VALUES (?, ?)', [String(chatId), 0]);
            
            this.startPush(chatId, startIndex, msg.chat.username || msg.chat.title);
        } catch (err) {
            logger.error(`KC命令异常: ${err.message}`);
            this.sendErrorMessage(chatId, '启动失败，请检查机器人日志');
        }
    }

    async startPush(chatId, startIndex, name) {
        logger.info(`启动推送: ${chatId} (${name})`);
        await this.pushVideo(chatId, startIndex);
    }

    async pushVideo(chatId, index) {
        try {
            // 使用 OFFSET 分页
            const [rows] = await this.pool.query('SELECT url FROM videos LIMIT 1 OFFSET ?', [index]);

            if (rows.length === 0) {
                await this.handleLowInventory(chatId);
                return;
            }

            // 发送视频
            await this.sendVideoWithControls(chatId, rows[0].url);
            
            // 安排下一次推送
            this.scheduleNextPush(chatId, index + 1);
        } catch (err) {
            logger.error(`推送异常 [Chat: ${chatId}]: ${err.message}`);
            // 遇到错误（如视频文件ID失效），尝试跳过该视频
            this.scheduleNextPush(chatId, index + 1); 
        }
    }

    async sendVideoWithControls(chatId, url) {
        const opts = this.isAdmin(chatId) ? (this.config.adminInfos || {}) : (this.config.infos || {});
        await this.bot.sendVideo(chatId, url, opts);
    }

    scheduleNextPush(chatId, nextIndex) {
        const interval = this.config.pushInterval || CONSTANTS.DEFAULT_PUSH_INTERVAL;
        
        const timer = setTimeout(() => {
            this.pushVideo(chatId, nextIndex);
        }, interval);

        this.updatePushState(chatId, timer, nextIndex);
    }

    updatePushState(chatId, timer, nextIndex) {
        // 清除旧定时器引用
        if (this.state.pushTimers.has(chatId)) {
            clearTimeout(this.state.pushTimers.get(chatId).timer);
        }

        this.state.pushTimers.set(chatId, { timer, nextIndex });
        
        // 异步更新数据库进度，不阻塞流程
        this.pool.query('UPDATE `groups` SET now = ? WHERE chatid = ?', [nextIndex, String(chatId)])
            .catch(err => logger.error(`进度保存失败: ${err.message}`));
    }

    async handleLowInventory(chatId) {
        await this.bot.sendMessage(chatId, '已经没有更多视频啦，请联系管理员补充库存~');
        this.handlePause(chatId, false); // false 表示不发送"休息一下"的提示
        // 重置进度到 0
        await this.pool.query('UPDATE `groups` SET now = 0 WHERE chatid = ?', [String(chatId)]);
    }

    async handleCallbackQuery(query) {
        const { message, data, from } = query;
        const chatId = message.chat.id;

        // 按钮点击反馈，消除加载转圈
        this.bot.answerCallbackQuery(query.id).catch(() => {});

        try {
            switch (data) {
                case '/next':
                    await this.handleNextVideo(chatId);
                    break;
                case '/zt':
                    // 验证是否是管理员或群主点击暂停
                    const member = await this.bot.getChatMember(chatId, from.id);
                    if (['administrator', 'creator'].includes(member.status) || this.isAdmin(from.id)) {
                         await this.handlePause(chatId);
                    } else {
                        await this.bot.sendMessage(chatId, '只有管理员可以暂停哦~');
                    }
                    break;
                case '/adminClear':
                    if (this.isAdmin(from.id)) await this.handleAdminClear(chatId);
                    break;
                case '/adminDown':
                    if (this.isAdmin(from.id)) await this.handleAdminDown(chatId);
                    break;
            }
        } catch (err) {
            logger.error(`回调处理异常: ${err.message}`);
        }
    }

    async handleNextVideo(chatId) {
        if (!this.state.pushTimers.has(chatId)) {
            await this.bot.sendMessage(chatId, '请先使用 /kc 命令启动推送');
            return;
        }
        
        // 立即执行下一次推送
        const { timer, nextIndex } = this.state.pushTimers.get(chatId);
        clearTimeout(timer); // 清除等待中的定时器
        await this.pushVideo(chatId, nextIndex);
    }

    async handlePause(chatId, notify = true) {
        if (this.state.pushTimers.has(chatId)) {
            clearTimeout(this.state.pushTimers.get(chatId).timer);
            this.state.pushTimers.delete(chatId);
            if (notify) {
                await this.bot.sendMessage(chatId, '芙芙休息一下~ (推送已暂停)');
            }
            logger.info(`停止推送: ${chatId}`);
        }
    }

    // ==========================================
    // 核心优化：无锁高效去重
    // ==========================================
    async handleAdminClear(chatId) {
        try {
            await this.bot.sendChatAction(chatId, 'typing');
            
            // 使用 MySQL 多表删除语法，保留 ID 最小的记录，删除重复 URL
            // 不需要创建临时表，不需要重置 ID，速度极快且安全
            const result = await this.pool.query(`
                DELETE t1 FROM videos t1
                INNER JOIN videos t2 
                WHERE t1.id > t2.id AND t1.url = t2.url
            `);

            const [[{ count }]] = await this.pool.query('SELECT COUNT(*) as count FROM videos');
            const deletedCount = result[0].affectedRows;

            await this.bot.sendMessage(chatId, `✅ 整理完成！\n🗑️ 删除了 ${deletedCount} 个重复视频\n📊 当前有效库存：${count}`);
            logger.info(`管理员 ${chatId} 执行去重，删除 ${deletedCount} 条`);
        } catch (err) {
            logger.error(`去重失败: ${err.message}`);
            this.sendErrorMessage(chatId, '去重操作执行失败');
        }
    }

    // ==========================================
    // 核心优化：安全并行导出
    // ==========================================
    async handleAdminDown(chatId) {
        try {
            await this.bot.sendChatAction(chatId, 'upload_document');
            
            const { host, user, password, database } = this.config.sql;
            const tmpDir = os.tmpdir();
            const timestamp = Date.now();
            
            const videoDump = path.join(tmpDir, `videos_${timestamp}.sql`);
            const groupDump = path.join(tmpDir, `groups_${timestamp}.sql`);
            const zipFile = path.join(tmpDir, `dump_${timestamp}.zip`);

            // 封装 dump 命令，使用环境变量传递密码（比命令行参数更安全）
            const dumpCmd = (table, outputFile) => {
                return new Promise((resolve, reject) => {
                    exec(
                        `mysqldump -h${host} -u${user} ${database} ${table} > "${outputFile}"`,
                        { env: { ...process.env, MYSQL_PWD: password } },
                        (err) => err ? reject(err) : resolve()
                    );
                });
            };

            // 并行执行导出，速度更快
            await Promise.all([
                dumpCmd('videos', videoDump),
                dumpCmd('groups', groupDump)
            ]);

            // 打包
            await new Promise((resolve, reject) => {
                const output = createWriteStream(zipFile);
                const archive = archiver('zip', { zlib: { level: 9 } });
                
                output.on('close', resolve);
                archive.on('error', reject);
                
                archive.pipe(output);
                archive.file(videoDump, { name: 'videos.sql' });
                archive.file(groupDump, { name: 'groups.sql' });
                archive.finalize();
            });

            // 发送
            await this.bot.sendDocument(chatId, zipFile, {}, {
                filename: `backup_${timestamp}.zip`,
                contentType: 'application/zip'
            });

            // 清理临时文件
            [videoDump, groupDump, zipFile].forEach(f => fs.unlink(f).catch(() => {}));
            logger.info(`管理员 ${chatId} 下载了数据库备份`);

        } catch (err) {
            logger.error(`备份失败: ${err.message}`);
            this.sendErrorMessage(chatId, '数据库导出失败: ' + err.message);
        }
    }

    sendErrorMessage(chatId, message) {
        this.bot.sendMessage(chatId, `⚠️ ${message}`).catch(() => {});
        // 通知所有管理员
        if (this.config.adminIds) {
            this.config.adminIds.forEach(id => {
                this.bot.sendMessage(id, `🚨 系统故障: ${message}`).catch(() => {});
            });
        }
    }
}

// 启动
const botInstance = new VideoBot();
botInstance.initialize().catch(err => {
    console.error('FATAL ERROR:', err);
    process.exit(1);
});
