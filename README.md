# 🚗 TG开车机器人说明文档

一个基于 **Node.js** 的 Telegram 自动推送视频机器人，支持群组和个人使用。 管理员可上传或转发视频至机器人，系统会自动收录视频并定时推送。

## 📌 功能概述

- **获取ID**：可通过 @GetTheirIDBot 获取群组、频道、用户或机器人 ID。
- **开车命令**：
  - `/kc` → 开始推送视频（默认每 10 分钟推送一次）。
  - `/zt` → 暂停推送。
- **视频收录**：管理员发送视频后，机器人会自动保存视频 ID 至数据库。
- **入口文件**：项目主文件为 `tgkc.js`。

## ⚙️ 环境依赖

请确保已安装以下模块：

```
npm install node-telegram-bot-api mysql2 winston chokidar archiver
```

- **node-telegram-bot-api** → Telegram Bot API 封装库
- **mysql2** → MySQL 数据库连接驱动
- **chokidar** → 文件监听工具
- **winston** → 日志管理工具
- **archiver** → zip压缩包工具

## 🗄️ 数据库配置

1. 创建一个数据库，并将 `init.sql` 文件导入至新创建的MySQL数据库。
2. 修改 `config.json` 文件，填入机器人 API Token 和数据库连接信息。

## 📝 配置文件说明（config.json）

| Key                   | 类型   | 说明                                                         |
| --------------------- | ------ | ------------------------------------------------------------ |
| **botToken**          | String | 机器人 API Token                                             |
| **adminIds**          | Array  | 管理员 ID 列表，格式：`["1","2","3"]`                        |
| **sql**               | Object | 数据库连接信息（host、user、password、database 等）          |
| **infos**             | Object | 普通用户推送信息下的文字和按钮配置                           |
| **adminInfos**        | Object | 管理员推送信息下的文字和按钮配置                             |
| **uploadVideosInfos** | Object | 管理员上传视频后系统响应的按钮配置                           |
| **caption**           | String | 推送视频下方的文字说明                                       |
| **inline_keyboard**   | Array  | 内联按钮配置，每个元素为一行按钮，包含 `text`、`url`、`callback_data` |
| **pushInterval**      | Number | 视频推送间隔（秒），默认 600 秒（10 分钟）                   |
| **pingInterval**      | Number | 数据库心跳检测间隔（秒），默认 600 秒（10 分钟）             |

## ▶️ 运行方式

在项目目录下执行：

```
node tgkc.js
```

机器人启动后即可使用以下命令：

- `/kc` → 开始推送视频（默认每 10 分钟一发车）
- `/zt` → 暂停推送
