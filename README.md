# TG开车

获取群组/频道/用户/机器人ID的机器人：[@GetTheirIDBot](https://t.me/GetTheirIDBot)

使用Nodejs简单实现TG开车的功能，支持群组和个人开车。

/kc是开车命令，默认十分钟一发车。/zt是暂停命令，会停止发车。

管理员将TG中的视频（或自行上传的视频）发送给机器人，机器人即可收录该视频ID到数据库中。

tgkc.js项目入口文件。

## 需要安装模块

安装node-telegram-bot-api、mysql2、chokidar、winston模块

npm install node-telegram-bot-api mysql2 chokidar winston


## 修改配置信息

导入datas.sql文件到数据库中，自行修改config.json配置文件中机器人的API TOKEN、数据库等信息。

## 配置文件(config.json)说明

| Key             | Value                                                        |
| --------------- | ------------------------------------------------------------ |
| botToken        | 机器人API Token                                              |
| adminIds         | 管理员ID（以数组形式存储），可填写多个，多个管理员ID以“\,”分割。格式如下所示：["1","2","3"] |
| sql             | 填写导入data.sql文件数据库的连接信息                         |
| infos             | 普通用户在开车获取推送信息下面的文字和按钮内容                         |
| adminInfos             | 管理员在开车获取推送信息下面的文字和按钮内容                        |
| uploadVideosInfos             | 管理员在上传视频后系统响应内容下面的按钮内容                        |
| caption         | 推送视频下面的文字内容                                       |
| inline_keyboard | 其中每一个数组元素为一行按钮，text值为按钮名，url为跳转地址，callback_data通常为命令 |
| pushInterval    | 视频推送间隔，单位是秒，默认每间隔10分钟推送一次             |
| pingInterval    | SQL数据库心跳测试，单位是秒，默认10分钟测试一次              |

## 运行和命令

安装到Nodejs、所需模块和导入sql文件后。在tgkc.js所在目录下，输入node tgkc.js即可运行。

/kc是开车命令，默认十分钟一发车。/zt是暂停命令，会停止发车。
