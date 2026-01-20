-- ==========================================
-- TG机器人数据库初始化脚本
-- 适用于 tgkc.js
-- ==========================================

SET NAMES utf8mb4;
SET FOREIGN_KEY_CHECKS = 0;

-- ----------------------------
-- Table structure for videos
-- ----------------------------
-- 如果表存在则删除（慎用，如果是新部署可以取消注释）
-- DROP TABLE IF EXISTS `videos`;

CREATE TABLE IF NOT EXISTS `videos` (
  `id` int(11) NOT NULL AUTO_INCREMENT,
  `url` varchar(255) NOT NULL COMMENT '存储Telegram的文件ID (File ID)',
  PRIMARY KEY (`id`),
  -- [优化] 添加索引以加快去重查询和随机读取速度
  KEY `idx_url` (`url`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='视频库存表';

-- ----------------------------
-- Table structure for groups
-- ----------------------------
-- 如果表存在则删除（慎用，如果是新部署可以取消注释）
-- DROP TABLE IF EXISTS `groups`;

CREATE TABLE IF NOT EXISTS `groups` (
  `id` int(11) NOT NULL AUTO_INCREMENT,
  `chatid` varchar(64) NOT NULL COMMENT '群组或用户的唯一ID (String类型防止精度丢失)',
  `now` int(11) NOT NULL DEFAULT '0' COMMENT '当前推送进度 (Offset)',
  PRIMARY KEY (`id`),
  -- [关键优化] 必须添加唯一索引，否则代码中的 INSERT IGNORE 会失效导致数据重复
  UNIQUE KEY `idx_chatid` (`chatid`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='群组推送进度表';

-- ----------------------------
-- 权限重置（可选，如果出现权限问题可参考）
-- ----------------------------
-- FLUSH PRIVILEGES;

SET FOREIGN_KEY_CHECKS = 1;
