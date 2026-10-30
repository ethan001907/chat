# 智能聊天（chat-app）

一个**零依赖**的类微信聊天应用，纯 Node.js + 原生前端，无需任何 npm 包即可运行。

## 使用

访问https://chat.ha-box.xyz
或者扫描这个二维码：
<img width="450" height="450" alt="chat ha-box xyz" src="https://github.com/user-attachments/assets/d0cd080a-f428-4d3f-8634-32dcd9e27383" />

## 功能

- 注册 / 登录（昵称 + 用户名 + 密码，无手机号）
- 好友管理、搜索加好友
- 单聊、群聊
- 文字消息（WebSocket 实时推送，手写协议）
- 视频 / 语音通话（WebRTC，含静音、关摄像头、共享屏幕）
- 消息历史
- 头像上传、改昵称 / 用户名 / 密码
- 中英文切换（i18n）

## 技术栈

- **后端**：Node.js（`server.js`，端口 3000）
- **前端**：原生 JS（`public/`）
- **存储**：本地 JSON 文件（`data/db.json`）
- **通信**：WebSocket（自实现，无第三方库）+ WebRTC（浏览器原生）

## 快速开始

```bash
# 无需 npm install，直接运行
node server.js
```

然后浏览器打开 <http://localhost:3000>。

## 目录结构

```
chat-app/
├── server.js          # 后端服务器（HTTP + WebSocket + WebRTC 信令）
├── package.json       # 元信息（零依赖）
├── test-ws.js         # WebSocket 测试脚本
├── .gitignore
└── public/
    ├── index.html     # 页面
    ├── app.js         # 前端逻辑
    ├── style.css      # 样式
    └── i18n.js        # 中英文文案
```

## 数据存储

用户数据保存在 `data/db.json`（已加入 `.gitignore`，不会提交）。首次运行会自动创建 `data/` 目录。

## 部署

本地运行后，可通过 Cloudflare Tunnel 等方式暴露到公网。

## License

MIT
