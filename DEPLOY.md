# 部署指南（免费托管平台）

本游戏是 **Node.js + Express + Socket.IO** 实时多人应用，需要**常驻进程 + WebSocket**，纯静态托管（GitHub Pages / Gitee Pages）**跑不了后端**。

## 环境变量（Platform 上设置）

| 变量          | 作用                     | 建议值                                         |
| ------------- | ------------------------ | ---------------------------------------------- |
| `PORT`        | 监听端口                 | 平台自动注入（Render/Railway 会提供）          |
| `HOST`        | 绑定地址                 | `0.0.0.0`（托管平台必须，否则外部无法访问）    |
| `DATA_DIR`    | 账号存档目录             | 平台持久化卷（如 Render 的磁盘挂载点 `/data`） |
| `ADMIN_USERS` | 服主账号名单（逗号分隔） | 如 `admin`                                     |
| `NODE_ENV`    | 运行环境                 | 通常设 `production`                            |

> ⚠️ `DATA_DIR` 若不设置，账号会存到项目根目录的 `accounts.json`。免费平台重启后文件系统可能被重置，**务必用持久化卷**。

## 平台推荐

### 1. Render（推荐，免费 Web Service）

1. 推送代码到 GitHub 仓库
2. New → Web Service → 选该仓库
3. Build: `npm install`；Start: `npm start`（或选 Procfile 自动识别）
4. 环境变量：
   - `HOST=0.0.0.0`
   - `PORT`（Render 自动注入）
   - `DATA_DIR=/opt/render/project/src/data`（或挂载持久磁盘后填路径）
   - `ADMIN_USERS=你的服主账号`
5. **重要**：Render 免费实例会休眠，且免费磁盘不持久，需在付费层或挂 Persistence 才能保住账号。试玩够用。

### 2. Railway

1. New Project → Deploy from GitHub repo
2. 自动识别 Procfile，Start `node server.js`
3. 环境变量同上（Railway 自动注入 `PORT`）
4. `DATA_DIR` 指向挂载的 Volume

### 3. Fly.io

- `fly.toml` 中 `[env]` 设 `PORT`，启动 `node server.js`
- 需 `volumes` 挂载，`DATA_DIR=/data`，`HOST=0.0.0.0`

### 4. 腾讯云/阿里云轻量（正式运营）

- 装 Node + PM2：`pm2 start server.js --name deer`
- 设环境变量后用 Nginx/系统服务反代，或直接暴露端口
- 数据存本地磁盘，最稳

## 关键点

- **Socket.IO 需要 WebSocket**，务必 `HOST=0.0.0.0` 并确认平台放行 WebSocket 升级。
- `ADMIN_USERS` 的服主账号**先在你本地或平台上注册好**，再填进环境变量，防止被抢注。
- 公告文件 `announcements.txt` 随代码提交，启动时自动广播；服主可用聊天 `/公告 文字` 或 `/公告重载` 更新。
