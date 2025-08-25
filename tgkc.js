const TelegramBot = require('node-telegram-bot-api');
const mysql = require('mysql2/promise');
const fs = require('fs').promises;
const path = require('path');
const chokidar = require('chokidar');
const winston = require('winston');
const { exec } = require('child_process');
const os = require('os');

// TG开车最终版（新增去重和下载数据表功能）
// 播放视频和上传视频响应均会出现去重和下载按钮！！！
//目前群组任何人均可操控芙芙开车机器人，例如：/kc@机器人用户名、/zt@机器人用户名
//部署本代码的机器人可以在群组或者个人用户中提供服务，频道暂时不行，被@也收不到消息
//本代码能存储错误信息到error.txt文件中，存储运行日志信息到log.txt文件中
//msg.chat.type可以获取聊天对象类型。private为用户，supergroup为群组
//id为负数的为群组，正数的为用户

// 常量定义
const UPLOAD_SUMMARY_DELAY = 60000; // 管理员上传视频响应cd
const PING_INTERVAL = 300000;
const DEFAULT_PUSH_INTERVAL = 600000;

// 初始化日志系统
const logger = winston.createLogger({
  level: 'info',
  format: winston.format.combine(
    winston.format.timestamp({ format: getBeijingTimestamp }),
    winston.format.printf(({ timestamp, level, message }) => {
      return `${timestamp} [${level.toUpperCase()}] ${message}`;
    })
  ),
  transports: [
    new winston.transports.File({ filename: 'error.log', level: 'error' }),
    new winston.transports.File({ filename: 'run.log' })
  ]
});

// 定义VideoBot类
class VideoBot {

  constructor() {
    this.config = {};
    this.pool = null;
    this.timeoutMap = new Map();
    this.uploadCooldown = new Map();
    this.bot = null;
  }

  async initialize() {
    await this.loadConfig();
    await this.initializeDatabase();
    this.setupConfigWatcher();
    this.startBot();
  }

  async loadConfig() {
    try {
      const rawData = await fs.readFile(path.join(__dirname, './config.json'), 'utf8');
      this.config = JSON.parse(rawData);
      logger.info('配置已加载');
      console.log('配置已加载');
    } catch (err) {
      logger.error(`配置文件加载失败: ${err.message}`);
      process.exit(1);
    }
  }

// 在VideoBot类中添加权限验证方法
async checkGroupPermissions(msg) {
  const chat = msg.chat;
  const from = msg.from;
  
  if (!from) return false;

  // 非群组消息直接放行
  if (!['group', 'supergroup'].includes(chat.type)) return true;

  try {
    const member = await this.bot.getChatMember(chat.id, from.id);
    return ['administrator', 'creator'].includes(member.status);
  } catch (err) {
    logger.error(`权限验证失败: ${err.message}`);
    return false;
  }
}

  setupConfigWatcher() {
    chokidar.watch('./config.json').on('change', async () => {
      logger.info('检测到配置文件更改，重新加载...');
      console.log('检测到配置文件更改，重新加载...');
      await this.loadConfig();
      // 重新初始化数据库连接
      if (this.pool) {
        await this.pool.end();
        await this.initializeDatabase();
      }
    });
  }

  async initializeDatabase() {
    this.pool = mysql.createPool({
      ...this.config.sql,
      waitForConnections: true,
      connectionLimit: 10,
      queueLimit: 0
    });

    try {
      await this.pool.query('SELECT 1');
      logger.info('成功连接到数据库');
      console.log('成功连接到数据库');
      
      setInterval(async () => {
        try {
          await this.pool.query('SELECT 1');
        } catch (err) {
          logger.error('数据库心跳失败，尝试重新连接...');
          await this.initializeDatabase();
        }
      }, this.config.pingInterval || PING_INTERVAL);

    } catch (err) {
      logger.error(`数据库连接失败: ${err.message}`);
      process.exit(1);
    }
  }

  startBot() {
    this.bot = new TelegramBot(this.config.botToken, { polling: true });
    this.registerHandlers();
  }

 registerHandlers() {
  this.bot.on('message', this.handleMessage.bind(this));
  
  // 修改命令处理，添加权限验证
  this.bot.onText(/\/kc/, async (msg) => {
    if (!await this.checkGroupPermissions(msg)) return;
    this.handleKcCommand(msg);
  });

  this.bot.onText(/\/zt/, async (msg) => {
    if (!await this.checkGroupPermissions(msg)) return;
    this.handlePause(msg.chat.id);
  });

  this.bot.on('callback_query', this.handleCallbackQuery.bind(this));
}

  async handleMessage(msg) {
    try {
      const { chat, from, video } = msg;
      if (!video || !this.isAdmin(from.id)) return;

      await this.processVideoUpload(video.file_id, from.id, chat.id);
    } catch (err) {
      logger.error(`消息处理失败: ${err.message}`);
    }
  }

  // 管理员身份检测
  isAdmin(userId) {
  return Array.isArray(this.config.adminIds) && this.config.adminIds.includes(String(userId));
}

  async processVideoUpload(fileId, adminId, chatId) {
    try {
      await this.pool.query('INSERT INTO videos (url) VALUES (?)', [fileId]);
      logger.info(`管理员 ${adminId} 上传视频: ${fileId}`);
      
      const adminState = this.uploadCooldown.get(adminId) || { 
        count: 0, 
        timer: null,
        chatId 
      };

      adminState.count++;
      this.updateCooldownTimer(adminId, adminState);
    } catch (err) {
      logger.error(`视频插入失败: ${err.message}`);
      this.sendErrorMessage(chatId, '视频上传处理失败');
    }
  }

  updateCooldownTimer(adminId, state) {
    if (state.timer) clearTimeout(state.timer);
    
    state.timer = setTimeout(async () => {
      try {
        const [[{ count }]] = await this.pool.query('SELECT COUNT(*) as count FROM videos');
        this.bot.sendMessage(
          state.chatId,
          `[管理员 ${adminId}]您好，已成功收录 ${state.count} 个视频，当前总库存：${count}`,this.config.uploadVideosInfos
        );
        this.uploadCooldown.delete(adminId);
      } catch (err) {
        logger.error(`汇总消息发送失败: ${err.message}`);
      }
    }, UPLOAD_SUMMARY_DELAY);

    this.uploadCooldown.set(adminId, state);
  }

  async handleKcCommand(msg) {
    const chat = msg.chat;
    try {
      if (this.timeoutMap.has(chat.id)) {
        await this.bot.sendMessage(chat.id, '芙芙已经在推送视频的路上啦~');
        return;
      }

      const [rows] = await this.pool.query(
        'SELECT now FROM groups WHERE chatid = ?', 
        [chat.id]
      );

      const startIndex = rows.length > 0 ? rows[0].now : 0;
      await this.upsertGroup(chat.id, startIndex);
      this.startPush(chat.id, startIndex, chat.username);
    } catch (err) {
      logger.error(`处理/kc命令失败: ${err.message}`);
      this.sendErrorMessage(chat.id, '命令处理失败');
    }
  }

  async upsertGroup(chatId, startIndex) {
    if (startIndex === 0) {
      await this.pool.query(
        'INSERT INTO groups (chatid, now) VALUES (?, ?) ON DUPLICATE KEY UPDATE now = VALUES(now)',
        [chatId, startIndex]
      );
    }
  }

  async startPush(chatId, startIndex, username) {
    try {
      logger.info(`开始推送: ${chatId} (${username})`);
      await this.pushVideo(chatId, startIndex);
    } catch (err) {
      logger.error(`启动推送失败: ${err.message}`);
      this.sendErrorMessage(chatId, '推送启动失败');
    }
  }

 // 分页查询推送视频
  async pushVideo(chatId, index) {
  try {
    const [rows] = await this.pool.query(
      'SELECT url FROM videos ORDER BY id LIMIT 1 OFFSET ?',
      [index]
    );

    if (rows.length === 0) {
      await this.handleLowInventory(chatId);
      return;
    }

    await this.sendVideoWithControls(chatId, rows[0].url);
    this.scheduleNextPush(chatId, index + 1);
  } catch (err) {
    throw new Error(`视频推送失败: ${err.message}`);
  }
}

  async sendVideoWithControls(chatId, url) {

    if(this.isAdmin(chatId)){
    // 管理员推送
    await this.bot.sendVideo(chatId, url, this.config.adminInfos || {});
    return;
}

    // 非管理员推送
    await this.bot.sendVideo(chatId, url, this.config.infos || {});
  }

  scheduleNextPush(chatId, nextIndex) {
    const timer = setTimeout(async () => {
      await this.pushVideo(chatId, nextIndex);
    }, this.config.pushInterval || DEFAULT_PUSH_INTERVAL);

    this.updatePushState(chatId, timer, nextIndex);
  }

  updatePushState(chatId, timer, nextIndex) {
    if (this.timeoutMap.has(chatId)) {
      clearTimeout(this.timeoutMap.get(chatId).timer);
    }

    this.timeoutMap.set(chatId, { timer, nextIndex });
    this.pool.query(
      'UPDATE groups SET now = ? WHERE chatid = ?',
      [nextIndex, chatId]
    ).catch(err => logger.error(`状态更新失败: ${err.message}`));
  }

  async handleLowInventory(chatId) {
    await this.bot.sendMessage(chatId, '库存告急，请联系管理员~');
    this.timeoutMap.delete(chatId);
    await this.pool.query('UPDATE groups SET now = 0 WHERE chatid = ?', [chatId]);
  }

  // 处理视频回调按键
  async handleCallbackQuery(callbackQuery) {
  const { message, data } = callbackQuery;
  const chatId = message.chat.id;

  try {
    switch (data) {
      case '/next':
        await this.handleNextVideo(chatId);
        break;
      case '/zt':
        await this.handlePause(chatId);
        break;
      case '/adminClear':
        if (!this.isAdmin(callbackQuery.from.id)) return;
        await this.handleAdminClear(chatId);
        break;
      case '/adminDown':
        if (!this.isAdmin(callbackQuery.from.id)) return;
        await this.handleAdminDown(chatId);
        break;
    }
  } catch (err) {
    logger.error(`回调处理失败: ${err.message}`);
  }
}

  async handleNextVideo(chatId) {
    if (!this.timeoutMap.has(chatId)) {
      await this.bot.sendMessage(chatId, '请先使用/kc命令启动推送');
      return;
    }

    const { nextIndex } = this.timeoutMap.get(chatId);
    await this.pushVideo(chatId, nextIndex);
  }

  async handlePause(chatId) {
    if (this.timeoutMap.has(chatId)) {
      clearTimeout(this.timeoutMap.get(chatId).timer);
      this.timeoutMap.delete(chatId);
      await this.bot.sendMessage(chatId, '芙芙休息一下~');
      logger.info(`停止推送: ${chatId}`);
    }
  }

// 管理员去重实现
async handleAdminClear(chatId) {
  try {
    await this.pool.query(`
      CREATE TEMPORARY TABLE temp_videos AS
      SELECT MIN(id) AS id, url
      FROM videos
      GROUP BY url
    `);

    await this.pool.query(`
      DELETE FROM videos
      WHERE id NOT IN (SELECT id FROM temp_videos)
    `);

    await this.pool.query(`DROP TEMPORARY TABLE temp_videos`);

    await this.pool.query(`SET @id = 0`);
    await this.pool.query(`UPDATE videos SET id = (@id := @id + 1)`);

    await this.bot.sendMessage(chatId, '✅ 视频去重完成，ID 已重置。');
    logger.info(`管理员${chatId}执行了视频去重`);
  } catch (err) {
    logger.error(`视频去重失败: ${err.message}`);
    this.sendErrorMessage(chatId, '视频去重失败');
  }
}

// 下载videos.sql文件实现
async handleAdminDown(chatId) {
  try {
    const dumpFile = path.join(os.tmpdir(), `videos_${Date.now()}.sql`);
    const { host, user, password, database } = this.config.sql;

    // 执行 mysqldump 导出
    exec(
      `mysqldump -h${host} -u${user} -p${password} ${database} videos > ${dumpFile}`,
      async (err) => {
        if (err) {
          logger.error(`数据库导出失败: ${err.message}`);
          this.sendErrorMessage(chatId, '数据库导出失败');
          return;
        }

        try {
          await this.bot.sendDocument(chatId, dumpFile, {}, {
            filename: 'videos.sql',
            contentType: 'application/sql'
          });
          logger.info(`管理员${chatId}下载了视频表`);

          // 删除临时文件
          await fs.unlink(dumpFile);
        } catch (sendErr) {
          logger.error(`发送导出文件失败: ${sendErr.message}`);
          this.sendErrorMessage(chatId, '文件发送失败');
        }
      }
    );
  } catch (err) {
    logger.error(`handleAdminDown 出错: ${err.message}`);
    this.sendErrorMessage(chatId, '数据库导出出错');
  }
}

  // 推送错误信息
  sendErrorMessage(chatId, message) {
    this.bot.sendMessage(chatId, '服务暂时不可用，请稍后再试')
      .catch(() => logger.warn('发送错误消息失败'));
    this.bot.sendMessage(this.config.adminId, `故障通知: ${message}`)
      .catch(() => logger.warn('发送管理员通知失败'));
  }
}

// 工具函数
function getBeijingTimestamp() {
  return new Date().toLocaleString('zh-CN', {
    timeZone: 'Asia/Shanghai',
    hour12: false
  });
}

// 启动程序
const botInstance = new VideoBot();
botInstance.initialize().catch(err => {
  logger.error(`初始化失败: ${err.message}`);
  process.exit(1);
});

// 进程退出处理
['SIGINT', 'SIGTERM'].forEach(signal => {
  process.on(signal, async () => {
    logger.info('正在关闭服务...');
    if (botInstance.pool) await botInstance.pool.end();
    process.exit();
  });
});