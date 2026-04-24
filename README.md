# 🚗 TG开车机器人说明文档

一个基于 **Node.js** 的 Telegram 自动推送视频机器人，支持群组和个人使用。群组里Bot管理员、群主或者群聊管理员均可操控机器人！管理员可上传或转发视频至机器人，系统会自动收录视频并定时推送！

适合这类场景：

- 管理员持续给机器人补充视频库存
- 群组或私聊按固定间隔自动推送视频
- 希望跳过早期老库存，从较新的视频区间开始推送

## 📌 功能概述

- **获取ID**：可通过 @GetTheirIDBot 获取群组、频道、用户或机器人 ID。
- **开车命令**：
  - `/kc` → 开始推送视频（默认每 10 分钟推送一次）。
  - `/zt` → 暂停推送。
  - `/getstart` → 查看当前起始视频 ID（仅配置中的管理员可用）。
  - `/setstart 501` → 设置起始视频 ID（仅配置中的管理员可用）。
- **视频收录**：管理员发送视频后，机器人会自动保存视频 ID 至数据库。
- **视频去重**：管理员可通过内联按钮执行库存去重。
- **数据库备份**：管理员可通过内联按钮导出 `videos` 与 `groups` 数据。
- **配置热重载**：修改 `config.json` 后，机器人会自动重新加载配置。
- **入口文件**：项目主文件为 `tgkc.js`。

## 📁 项目结构

```text
.
├─ tgkc.js        # 机器人主程序
├─ config.json    # 运行配置
├─ init.sql       # 数据库初始化脚本
├─ package.json   # Node.js 项目依赖与脚本
└─ README.md      # 项目说明文档
```

## ⚡ 快速开始

1. 安装依赖

```bash
npm install
```

2. 初始化数据库

- 创建 MySQL 数据库
- 导入 `init.sql`

3. 修改 `config.json`

- 填入 `botToken`
- 填入 `adminIds`
- 填入 `sql.user`、`sql.password`、`sql.database`

4. 启动机器人

```bash
npm start
```

## ⚙️ 环境依赖

请确保本机已安装：

- Node.js
- MySQL
- `mysqldump`（仅管理员下载数据库备份时需要）

然后在项目目录执行：

```
npm install
```

- **node-telegram-bot-api** → Telegram Bot API 封装库
- **mysql2** → MySQL 数据库连接驱动
- **chokidar** → 文件监听工具
- **winston** → 日志管理工具
- **archiver** → zip压缩包工具

## 🗄️ 数据库配置

1. 创建一个数据库，并将 `init.sql` 文件导入至新创建的MySQL数据库。
2. 修改 `config.json` 文件，填入机器人 API Token 和数据库连接信息。

数据库包含两张核心表：

- `videos`：存储视频 `file_id`
- `groups`：存储每个群组或用户当前推送进度

## 📝 配置文件说明（config.json）

| Key                   | 类型   | 说明                                                         |
| --------------------- | ------ | ------------------------------------------------------------ |
| **botToken**          | String | 机器人 API Token                                             |
| **adminIds**          | Array  | 管理员 ID 列表，格式：`["1","2","3"]`                        |
| **sql**               | Object | 数据库连接信息（host、user、password、database 等）          |
| **logging**           | Object | 日志配置，支持日志级别、日志目录、是否输出到控制台           |
| **startVideoId**      | Number | 用户开始推送时允许推送的最小视频 ID，默认 `1`                |
| **infos**             | Object | 普通用户推送信息下的文字和按钮配置                           |
| **adminInfos**        | Object | 管理员推送信息下的文字和按钮配置                             |
| **uploadVideosInfos** | Object | 管理员上传视频后系统响应的按钮配置                           |
| **caption**           | String | 推送视频下方的文字说明                                       |
| **inline_keyboard**   | Array  | 内联按钮配置，每个元素为一行按钮，包含 `text`、`url`、`callback_data` |
| **pushInterval**      | Number | 视频推送间隔，单位为毫秒，默认 `600000`（10 分钟）           |
| **pingInterval**      | Number | 数据库心跳检测间隔，单位为毫秒，默认 `3600000`（1 小时）     |

`logging` 示例：

```json
"logging": {
  "level": "info",
  "dir": "logs",
  "console": true
}
```

`startVideoId` 说明：

- 默认值为 `1`，表示从第一条视频开始推送
- 当用户执行 `/kc` 时，如果该用户当前推送进度对应的视频 ID 小于 `startVideoId`，系统会自动跳到 `startVideoId` 对应的位置开始推送
- 适合库存较老、希望跳过早期视频时使用

补充说明：

- `startVideoId` 只影响“新开启的推送”
- 已经开始运行中的推送定时器不会立刻跳转，下一次重新执行 `/kc` 时按新规则生效
- `/setstart 501` 会把该值直接写回 `config.json`

## ▶️ 运行方式

在项目目录下执行：

```
npm start
```

机器人启动后即可使用以下命令：

- `/kc` → 开始推送视频（默认每 10 分钟一发车）
- `/zt` → 暂停推送
- `/getstart` → 查看当前 `startVideoId`
- `/setstart 501` → 将 `startVideoId` 设置为 `501`

说明：

- `/kc`、`/zt`：私聊可直接使用；群组里需要群管理员、群主或 `adminIds` 管理员权限
- `/getstart` 和 `/setstart`：仅 `config.json` 中 `adminIds` 里的管理员可以使用
- `/setstart` 会直接写回 `config.json`
- 设置完成后，新开启的 `/kc` 推送会按新的起始视频 ID 规则生效

## 🔐 权限说明

- `adminIds` 中配置的用户始终拥有管理员权限
- 管理员发送视频给机器人时，机器人会自动入库
- 群组中的普通成员不能暂停推送，也不能执行管理命令
- 去重、下载备份、查看和修改 `startVideoId` 都属于管理员能力

## 📦 视频入库与推送规则

1. 管理员发送或转发视频给机器人后，机器人会把 Telegram `file_id` 写入 `videos` 表
2. 用户执行 `/kc` 后，机器人会根据当前进度和 `startVideoId` 计算本次起推位置
3. 推送顺序按 `videos.id ASC` 顺序递增
4. 如果遇到失效 `file_id`，机器人会自动删除该记录并继续下一条
5. 如果视频库存推送完毕，会提示库存不足，并将进度重置为 `0`

如需仅检查语法，可执行：

```bash
npm run check
```

## 📄 日志文件

默认日志目录为 `logs/`：

- `logs/run.log`：运行日志
- `logs/error.log`：错误日志

日志目录、级别、是否输出到控制台都可以在 `config.json` 的 `logging` 字段中调整。

## 🚨 常见 Polling 报错说明

项目使用的是 Telegram `polling` 模式，偶发出现以下报错通常不代表业务代码有问题：

- `EFATAL: Error: read ETIMEDOUT`
- `EFATAL: Error: read ECONNRESET`
- `EFATAL: AggregateError`
- `ETELEGRAM: 502 Bad Gateway`

这些错误大多与网络波动、Telegram API 临时异常、IPv4/IPv6 路由问题有关。

如果看到下面这类报错：

- `ETELEGRAM: 429 Too Many Requests: retry after 5`

则通常表示同一个 Bot Token 可能被多个实例同时轮询，或者短时间内请求过于频繁。请优先检查：

1. 是否有多个进程同时运行同一个 Bot
2. 是否在不同服务器上部署了同一个 Token
3. 是否存在旧进程未退出、新进程又启动的情况

当前版本已经内置以下处理：

1. `429` 会按 `retry_after` 自动退避后恢复轮询
2. 网络类错误会自动延迟重试
3. 相同错误会做一定程度的日志抑制，避免刷屏

## 🛠️ 常见问题

1. 修改了 `config.json` 后要不要重启？

通常不用，当前版本支持配置热重载。

2. 为什么设置了 `startVideoId` 还是看到旧视频？

`startVideoId` 只在新开启 `/kc` 时参与起始位置计算。如果当前推送已经在运行，需要先 `/zt`，再重新 `/kc`。

3. `/setstart` 改完后有没有真正保存？

有，命令会直接把新的 `startVideoId` 写回 `config.json`。

4. 备份按钮为什么可能失败？

备份依赖本机存在 `mysqldump`。如果系统未安装 MySQL 客户端工具，数据库导出会失败。
