const TelegramBot = require('node-telegram-bot-api');
const mysql = require('mysql2/promise');
const fs = require('fs').promises;
const fsSync = require('fs');
const createReadStream = require('fs').createReadStream;
const createWriteStream = require('fs').createWriteStream;
const path = require('path');
const chokidar = require('chokidar');
const winston = require('winston');
const { exec } = require('child_process');
const os = require('os');
const archiver = require('archiver');

// ==========================================
// TG开车机器人 - 生产环境优化版
// 播放视频和上传视频响应均会出现去重和下载按钮！！！
// 目前群组里群主和管理员可操控芙芙开车机器人，例如：/kc@机器人用户名、/zt@机器人用户名
// 部署本代码的机器人可以在群组或者个人用户中提供服务，频道暂时不行，被@也收不到消息
// 本代码能存储错误信息到error.log文件中，存储运行日志信息到run.log文件中
// msg.chat.type可以获取聊天对象类型。private为用户，supergroup为群组
// id为负数的为群组，正数的为用户
// ==========================================

// 常量定义
const CONSTANTS = {
    UPLOAD_SUMMARY_DELAY: 60000,    // 管理员上传视频响应合并时间
    PING_INTERVAL: 3600000,         // 数据库保活心跳（1小时，避免资源浪费）
    DEFAULT_PUSH_INTERVAL: 600000,  // 默认推送间隔
    POLLING_ERROR_LOG_WINDOW: 10000,
    MIN_POLLING_RECOVERY_DELAY: 5000,
    MAX_POLLING_RECOVERY_DELAY: 300000,
    DEFAULT_LOG_DIR: path.join(__dirname, 'logs'),
    CONFIG_PATH: path.join(__dirname, 'config.json') // 使用绝对路径
};

const DEFAULT_CONFIG = {
    adminIds: [],
    sql: {
        host: '127.0.0.1',
        port: 3306,
        charset: 'utf8mb4'
    },
    logging: {
        level: 'info',
        dir: 'logs',
        console: true
    },
    infos: {},
    adminInfos: {},
    uploadVideosInfos: {},
    startVideoId: 1,
    pushInterval: CONSTANTS.DEFAULT_PUSH_INTERVAL,
    pingInterval: CONSTANTS.PING_INTERVAL
};

function ensureLogDir(logDir) {
    fsSync.mkdirSync(logDir, { recursive: true });
}

function buildLoggerTransports(logConfig = DEFAULT_CONFIG.logging) {
    const resolvedDir = path.isAbsolute(logConfig.dir)
        ? logConfig.dir
        : path.join(__dirname, logConfig.dir || 'logs');

    ensureLogDir(resolvedDir);

    const transports = [
        new winston.transports.File({ filename: path.join(resolvedDir, 'error.log'), level: 'error' }),
        new winston.transports.File({ filename: path.join(resolvedDir, 'run.log') })
    ];

    if (logConfig.console !== false) {
        transports.push(new winston.transports.Console());
    }

    return transports;
}

const LOG_FORMAT = winston.format.combine(
    winston.format.timestamp({ format: () => new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false }) }),
    winston.format.errors({ stack: true }),
    winston.format.printf(({ timestamp, level, message, stack }) => `${timestamp} [${level.toUpperCase()}] ${stack || message}`)
);

// 初始化日志系统
ensureLogDir(CONSTANTS.DEFAULT_LOG_DIR);
const logger = winston.createLogger({
    level: 'info',
    format: LOG_FORMAT,
    transports: buildLoggerTransports()
});

class VideoBot {
    constructor() {
        this.config = {};
        this.pool = null;
        this.bot = null;

        // 状态管理容器
        this.state = {
            pushTimers: new Map(),      // 推送定时器 Map<chatId, {timer, nextIndex, fromId}>
            uploadCooldown: new Map(),  // 上传防刷/合并 Map<adminId, {count, timer, chatId}>
            dbPingTimer: null,
            pollingRecoveryTimer: null,
            pollingRecoveryInProgress: false,
            pollingErrorCount: 0,
            lastPollingError: null
        };
    }

    async initialize() {
        await this.loadConfig();
        await this.initializeDatabase();
        this.setupConfigWatcher();
        await this.startBot(); // [Fix #4] 确保 await

        // 优雅退出处理
        process.on('SIGINT', () => this.shutdown());
        process.on('SIGTERM', () => this.shutdown());
    }

    async shutdown() {
        logger.info('正在关闭服务...');
        if (this.state.dbPingTimer) clearInterval(this.state.dbPingTimer);
        if (this.state.pollingRecoveryTimer) clearTimeout(this.state.pollingRecoveryTimer);

        // 清理所有推送定时器
        for (const [chatId, data] of this.state.pushTimers) {
            clearTimeout(data.timer);
        }

        if (this.bot) {
            try {
                await this.bot.stopPolling();
            } catch (err) {
                logger.warn(`停止轮询失败: ${err.message}`);
            }
        }

        if (this.pool) await this.pool.end();
        logger.info('已关闭服务');
        process.exit(0);
    }

    async loadConfig() {
        try {
            const rawData = await fs.readFile(CONSTANTS.CONFIG_PATH, 'utf8');
            const parsedConfig = JSON.parse(rawData);
            const normalizedConfig = this.normalizeConfig(parsedConfig);

            this.validateConfig(normalizedConfig);
            this.config = normalizedConfig;
            this.configureLogger();
            logger.info('配置已加载');
        } catch (err) {
            logger.error(`配置文件加载失败: ${err.message}`);
            // 首次加载失败直接退出，后续热重载失败则保持旧配置
            if (!this.bot) process.exit(1);
        }
    }

    async saveConfig() {
        const serialized = JSON.stringify(this.config, null, 4) + '\n';
        await fs.writeFile(CONSTANTS.CONFIG_PATH, serialized, 'utf8');
    }

    normalizeConfig(config = {}) {
        return {
            ...DEFAULT_CONFIG,
            ...config,
            adminIds: Array.isArray(config.adminIds)
                ? config.adminIds.filter(Boolean).map(id => String(id).trim())
                : DEFAULT_CONFIG.adminIds,
            sql: {
                ...DEFAULT_CONFIG.sql,
                ...(config.sql || {})
            },
            logging: {
                ...DEFAULT_CONFIG.logging,
                ...(config.logging || {})
            },
            infos: config.infos || DEFAULT_CONFIG.infos,
            adminInfos: config.adminInfos || DEFAULT_CONFIG.adminInfos,
            uploadVideosInfos: config.uploadVideosInfos || DEFAULT_CONFIG.uploadVideosInfos,
            startVideoId: this.normalizePositiveInteger(config.startVideoId, DEFAULT_CONFIG.startVideoId),
            pushInterval: this.normalizeInterval(config.pushInterval, CONSTANTS.DEFAULT_PUSH_INTERVAL),
            pingInterval: this.normalizeInterval(config.pingInterval, CONSTANTS.PING_INTERVAL)
        };
    }

    normalizeInterval(value, fallback) {
        const parsedValue = Number(value);
        return Number.isFinite(parsedValue) && parsedValue > 0 ? parsedValue : fallback;
    }

    normalizePositiveInteger(value, fallback) {
        const parsedValue = Number(value);
        return Number.isInteger(parsedValue) && parsedValue > 0 ? parsedValue : fallback;
    }

    validateConfig(config) {
        if (!config.botToken || typeof config.botToken !== 'string') {
            throw new Error('botToken 未配置');
        }

        const requiredSqlFields = ['host', 'user', 'database'];
        for (const field of requiredSqlFields) {
            if (!config.sql[field]) {
                throw new Error(`sql.${field} 未配置`);
            }
        }

        if (!Array.isArray(config.adminIds) || config.adminIds.length === 0) {
            logger.warn('adminIds 为空，当前仅私聊和群管理员可控制机器人');
        }
    }

    configureLogger() {
        logger.configure({
            level: this.config.logging.level || 'info',
            format: LOG_FORMAT,
            transports: buildLoggerTransports(this.config.logging)
        });
    }

    setupConfigWatcher() {
        // 使用绝对路径监听
        chokidar.watch(CONSTANTS.CONFIG_PATH).on('change', async () => {
            logger.info('检测到配置文件更改，重新加载...');
            try {
                await this.loadConfig();
                // 重新初始化数据库连接（如果数据库配置变更）
                await this.initializeDatabase();
            } catch (err) {
                logger.error(`配置热重载失败: ${err.message}`);
            }
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

    // [Fix #4] 改为 async，await stopPolling() 确保旧实例完全停止后再启动新实例，避免双重 polling 竞争
    async startBot() {
        if (this.bot) {
            try {
                await this.bot.stopPolling();
            } catch (err) {
                logger.warn(`停止旧轮询实例失败: ${err.message}`);
            }
        }

        if (this.state.pollingRecoveryTimer) {
            clearTimeout(this.state.pollingRecoveryTimer);
            this.state.pollingRecoveryTimer = null;
        }

        this.bot = new TelegramBot(this.config.botToken, { polling: true });
        this.state.pollingRecoveryInProgress = false;
        this.state.pollingErrorCount = 0;
        this.registerHandlers();
        logger.info('机器人已启动，监听消息中...');
    }

    registerHandlers() {
        this.bot.on('message', this.handleMessage.bind(this));

        // 命令正则匹配
        this.bot.onText(/\/kc/, async (msg) => this.authWrapper(msg, this.handleKcCommand.bind(this)));
        this.bot.onText(/\/zt/, async (msg) => this.authWrapper(msg, (m) => this.handlePause(m.chat.id)));
        this.bot.onText(/\/getstart(?:@\S+)?$/, async (msg) => this.handleGetStartCommand(msg));
        this.bot.onText(/\/setstart(?:@\S+)?\s+(\d+)$/, async (msg, match) => this.handleSetStartCommand(msg, match));
        this.bot.onText(/\/setstart(?:@\S+)?(?:\s+.*)?$/, async (msg, match) => this.handleSetStartCommand(msg, match));

        this.bot.on('callback_query', this.handleCallbackQuery.bind(this));

        // 错误处理，防止 crash
        this.bot.on('polling_error', (error) => {
            this.handlePollingError(error).catch(err => {
                logger.error(`Polling 异常恢复失败: ${err.stack || err.message}`);
            });
        });
    }

    buildPollingErrorSignature(error) {
        return `${error.code || 'UNKNOWN'}:${error.message || 'NO_MESSAGE'}`;
    }

    extractRetryAfter(error) {
        const retryAfter = error.response && error.response.body && error.response.body.parameters
            ? Number(error.response.body.parameters.retry_after)
            : NaN;

        if (Number.isFinite(retryAfter) && retryAfter > 0) {
            return retryAfter * 1000;
        }

        const matched = (error.message || '').match(/retry after\s+(\d+)/i);
        return matched ? Number(matched[1]) * 1000 : null;
    }

    classifyPollingError(error) {
        const message = (error.message || '').toLowerCase();
        const code = (error.code || '').toUpperCase();

        if (code === 'ETELEGRAM' && message.includes('429')) {
            return {
                type: 'rate_limit',
                delay: Math.max(this.extractRetryAfter(error) || 5000, CONSTANTS.MIN_POLLING_RECOVERY_DELAY),
                shouldRestart: true
            };
        }

        if (code === 'ETELEGRAM' && message.includes('502')) {
            return { type: 'telegram_5xx', delay: 15000, shouldRestart: true };
        }

        if (
            code === 'EFATAL' ||
            message.includes('econnreset') ||
            message.includes('etimedout') ||
            message.includes('aggregateerror')
        ) {
            const delay = Math.min(
                CONSTANTS.MIN_POLLING_RECOVERY_DELAY * Math.max(this.state.pollingErrorCount, 1),
                CONSTANTS.MAX_POLLING_RECOVERY_DELAY
            );

            return { type: 'network', delay, shouldRestart: true };
        }

        return { type: 'unknown', delay: 30000, shouldRestart: false };
    }

    logPollingError(error, recoveryPlan) {
        const now = Date.now();
        const signature = this.buildPollingErrorSignature(error);
        const lastError = this.state.lastPollingError;
        const withinWindow = lastError
            && lastError.signature === signature
            && now - lastError.loggedAt < CONSTANTS.POLLING_ERROR_LOG_WINDOW;

        if (withinWindow) {
            lastError.count += 1;
            this.state.lastPollingError = lastError;
            return;
        }

        if (lastError && lastError.count > 1) {
            logger.warn(`相同 Polling 错误在 ${CONSTANTS.POLLING_ERROR_LOG_WINDOW / 1000} 秒内重复 ${lastError.count} 次: ${lastError.signature}`);
        }

        const suffix = recoveryPlan.shouldRestart
            ? `，将在 ${Math.ceil(recoveryPlan.delay / 1000)} 秒后重试轮询`
            : '，暂不自动重启轮询';

        logger.error(`Telegram Polling Error [${recoveryPlan.type}]: ${error.code} - ${error.message}${suffix}`);
        this.state.lastPollingError = { signature, loggedAt: now, count: 1 };
    }

    schedulePollingRecovery(delay, reason) {
        if (this.state.pollingRecoveryTimer || this.state.pollingRecoveryInProgress) {
            logger.warn(`轮询恢复已在进行中，跳过重复调度: ${reason}`);
            return;
        }

        this.state.pollingRecoveryTimer = setTimeout(async () => {
            this.state.pollingRecoveryTimer = null;
            this.state.pollingRecoveryInProgress = true;

            try {
                logger.warn(`开始恢复 Telegram 轮询: ${reason}`);
                await this.startBot();
            } catch (err) {
                this.state.pollingRecoveryInProgress = false;
                this.state.pollingErrorCount += 1;
                const retryDelay = Math.min(
                    CONSTANTS.MIN_POLLING_RECOVERY_DELAY * Math.max(this.state.pollingErrorCount, 1),
                    CONSTANTS.MAX_POLLING_RECOVERY_DELAY
                );
                logger.error(`轮询恢复失败: ${err.message}，将在 ${Math.ceil(retryDelay / 1000)} 秒后再次尝试`);
                this.schedulePollingRecovery(retryDelay, 'recovery_failed');
            }
        }, delay);
    }

    async handlePollingError(error) {
        this.state.pollingErrorCount += 1;
        const recoveryPlan = this.classifyPollingError(error);

        this.logPollingError(error, recoveryPlan);

        if (!recoveryPlan.shouldRestart) {
            return;
        }

        if (this.bot) {
            try {
                await this.bot.stopPolling();
            } catch (stopErr) {
                logger.warn(`Polling 错误后停止轮询失败: ${stopErr.message}`);
            }
        }

        this.schedulePollingRecovery(recoveryPlan.delay, recoveryPlan.type);
    }

    // 统一权限验证包装器
    async authWrapper(msg, handler) {
        if (await this.checkGroupPermissions(msg)) {
            await handler(msg);
        }
    }

    // [Fix #3] adminIds 中的用户优先直接通过，不再要求其在群组中也是管理员
    //          保证 /zt 命令和 callback 按钮的权限逻辑一致
    async checkGroupPermissions(msg) {
        const { chat, from } = msg;
        if (!from) return false;

        // adminIds 中的用户始终有权限
        if (this.isAdmin(from.id)) return true;

        // 私聊直接通过
        if (chat.type === 'private') return true;

        // 群组：验证是否为群管理员或群主
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
            if (err.code !== 'ER_DUP_ENTRY') {
                this.sendErrorMessage(chatId, '视频入库异常');
            }
        }
    }

    // [Fix #1] 记录发起人 fromId，传入推送链，用于后续正确判断管理员界面
    async handleKcCommand(msg) {
        const chatId = msg.chat.id;
        const fromId = msg.from.id;
        try {
            if (this.state.pushTimers.has(chatId)) {
                await this.bot.sendMessage(chatId, '正在推送中，请勿重复执行~');
                return;
            }

            // 获取群组当前进度
            const [rows] = await this.pool.query('SELECT now FROM `groups` WHERE chatid = ?', [String(chatId)]);

            // 默认为 0
            const savedIndex = rows.length > 0 ? rows[0].now : 0;

            const [thresholdRows] = await this.pool.query(
                'SELECT COUNT(*) as offset FROM videos WHERE id < ?',
                [this.config.startVideoId]
            );

            const thresholdIndex = thresholdRows[0].offset;
            const startIndex = Math.max(savedIndex, thresholdIndex);

            // 只有不存在记录时才插入，存在则忽略 (INSERT IGNORE)
            await this.pool.query('INSERT IGNORE INTO `groups` (chatid, now) VALUES (?, ?)', [String(chatId), 0]);

            this.startPush(chatId, startIndex, msg.chat.username || msg.chat.title, fromId);
        } catch (err) {
            logger.error(`KC命令异常: ${err.message}`);
            this.sendErrorMessage(chatId, '启动失败，请检查机器人日志');
        }
    }

    async handleGetStartCommand(msg) {
        const { chat, from } = msg;
        if (!from || !this.isAdmin(from.id)) {
            await this.bot.sendMessage(chat.id, '只有配置中的管理员可以查看起始视频 ID。');
            return;
        }

        await this.bot.sendMessage(chat.id, `当前起始视频 ID 为：${this.config.startVideoId}`);
    }

    async handleSetStartCommand(msg, match) {
        const { chat, from } = msg;
        if (!from || !this.isAdmin(from.id)) {
            await this.bot.sendMessage(chat.id, '只有配置中的管理员可以设置起始视频 ID。');
            return;
        }

        const requestedStartVideoId = this.normalizePositiveInteger(match && match[1], NaN);
        if (!Number.isInteger(requestedStartVideoId) || requestedStartVideoId <= 0) {
            await this.bot.sendMessage(chat.id, '请输入有效的正整数，例如：/setstart 501');
            return;
        }

        try {
            const previousStartVideoId = this.config.startVideoId;
            this.config.startVideoId = requestedStartVideoId;
            await this.saveConfig();

            logger.info(`管理员 ${from.id} 将 startVideoId 从 ${previousStartVideoId} 更新为 ${requestedStartVideoId}`);
            await this.bot.sendMessage(
                chat.id,
                `起始视频 ID 已更新为：${requestedStartVideoId}\n新开启的 /kc 推送会自动跳过更早的视频。`
            );
        } catch (err) {
            logger.error(`保存 startVideoId 失败: ${err.message}`);
            await this.bot.sendMessage(chat.id, '保存起始视频 ID 失败，请检查配置文件写入权限。');
        }
    }

    async startPush(chatId, startIndex, name, fromId) {
        logger.info(`启动推送: ${chatId} (${name}), 发起人: ${fromId}`);
        await this.pushVideo(chatId, startIndex, fromId);
    }

    // [Fix #1] 全链路携带 fromId
    // [Fix #5] 捕获 Telegram file_id 失效错误，自动从数据库删除该视频并从当前位置继续
    async pushVideo(chatId, index, fromId) {
        let currentVideoId = null;
        try {
            // 同时查询 id 字段，供失效清理使用
            const [rows] = await this.pool.query('SELECT id, url FROM videos ORDER BY id ASC LIMIT 1 OFFSET ?', [index]);

            if (rows.length === 0) {
                await this.handleLowInventory(chatId);
                return;
            }

            currentVideoId = rows[0].id;

            // 发送视频
            await this.sendVideoWithControls(chatId, rows[0].url, fromId);

            // 安排下一次推送
            this.scheduleNextPush(chatId, index + 1, fromId);
        } catch (err) {
            logger.error(`推送异常 [Chat: ${chatId}]: ${err.message}`);

            // [Fix #5] file_id 失效时自动从数据库删除，从同一 index 继续（下一条顺位补上）
            if (currentVideoId && err.message && err.message.toLowerCase().includes('file_id')) {
                await this.pool.query('DELETE FROM videos WHERE id = ?', [currentVideoId])
                    .catch(e => logger.error(`删除失效视频失败: ${e.message}`));
                logger.warn(`已自动删除失效视频 ID: ${currentVideoId}，从当前位置继续推送`);
                this.scheduleNextPush(chatId, index, fromId); // index 不变，下一条顺位
                return;
            }

            // 其他错误跳过该视频
            this.scheduleNextPush(chatId, index + 1, fromId);
        }
    }

    // 按钮选择逻辑：
    //   - 私聊（chatId > 0）且发起者是管理员 → adminInfos（含去重/下载等管理按钮）
    //   - 群组（chatId < 0）→ 始终使用 infos（普通按钮）
    //
    // 原因：Telegram 的 inline keyboard 是绑在消息上的，群组所有人看到的按钮完全相同。
    // 若在群组里根据发起人显示管理员按钮，会导致：
    //   1. 管理员发起 → 群主/普通成员也看到去重/下载按钮（虽然点了无效，但UX混乱）
    //   2. 普通成员发起 → 管理员反而看不到管理按钮
    // 正确做法：管理员功能仅通过私聊使用，群组消息统一显示普通按钮。
    async sendVideoWithControls(chatId, url, fromId) {
        const isPrivateAdminChat = chatId > 0 && this.isAdmin(fromId);
        const opts = isPrivateAdminChat ? (this.config.adminInfos || {}) : (this.config.infos || {});
        await this.bot.sendVideo(chatId, url, opts);
    }

    // [Fix #1] 全链路携带 fromId
    scheduleNextPush(chatId, nextIndex, fromId) {
        const interval = this.config.pushInterval || CONSTANTS.DEFAULT_PUSH_INTERVAL;

        const timer = setTimeout(() => {
            this.pushVideo(chatId, nextIndex, fromId);
        }, interval);

        this.updatePushState(chatId, timer, nextIndex, fromId);
    }

    // [Fix #1] 将 fromId 存入推送状态，供 handleNextVideo 读取
    updatePushState(chatId, timer, nextIndex, fromId) {
        // 清除旧定时器引用
        if (this.state.pushTimers.has(chatId)) {
            clearTimeout(this.state.pushTimers.get(chatId).timer);
        }

        this.state.pushTimers.set(chatId, { timer, nextIndex, fromId });

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
                    // [Fix #10] 私聊下不调用 getChatMember（私聊会抛出 Telegram API Bad Request 错误）
                    //           adminIds 用户直接通过
                    if (message.chat.type === 'private' || this.isAdmin(from.id)) {
                        await this.handlePause(chatId);
                    } else {
                        try {
                            const member = await this.bot.getChatMember(chatId, from.id);
                            if (['administrator', 'creator'].includes(member.status)) {
                                await this.handlePause(chatId);
                            } else {
                                await this.bot.sendMessage(chatId, '只有管理员可以暂停哦~');
                            }
                        } catch (err) {
                            logger.error(`获取成员信息失败: ${err.message}`);
                        }
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

    // [Fix #1] 从推送状态中读取原始 fromId，保证下一个按钮的界面与最初 /kc 发起人一致
    async handleNextVideo(chatId) {
        if (!this.state.pushTimers.has(chatId)) {
            await this.bot.sendMessage(chatId, '请先使用 /kc 命令启动推送');
            return;
        }

        const { timer, nextIndex, fromId } = this.state.pushTimers.get(chatId);
        clearTimeout(timer); // 清除等待中的定时器
        await this.pushVideo(chatId, nextIndex, fromId);
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

    // [Fix #8] 排除 chatId 与管理员 ID 相同的情况，避免在私聊中重复收到两条相同的错误通知
    sendErrorMessage(chatId, message) {
        this.bot.sendMessage(chatId, `⚠️ ${message}`).catch(() => {});
        if (this.config.adminIds) {
            this.config.adminIds.forEach(id => {
                if (String(id) !== String(chatId)) {
                    this.bot.sendMessage(id, `🚨 系统故障: ${message}`).catch(() => {});
                }
            });
        }
    }
}

// 启动
const botInstance = new VideoBot();
botInstance.initialize().catch(err => {
    logger.error(`FATAL ERROR: ${err.stack || err.message}`);
    process.exit(1);
});

process.on('unhandledRejection', (reason) => {
    logger.error(`Unhandled Rejection: ${reason && reason.stack ? reason.stack : reason}`);
});

process.on('uncaughtException', (error) => {
    logger.error(`Uncaught Exception: ${error.stack || error.message}`);
    process.exit(1);
});
