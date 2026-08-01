# 🦌 荣耀赛鹿 · 腾讯云部署教程

> 面向国内玩家，推荐使用**腾讯云轻量应用服务器（香港节点）**：访问快、**免备案**、真持久磁盘（数据不丢、永不休眠）。本文同样适用阿里云轻量 / 其他任意 Linux 云服务器。

---

## 一、购买服务器

1. 打开 [腾讯云轻量应用服务器](https://cloud.tencent.com/product/lh)
2. 购买配置推荐：
   | 项目 | 推荐值 | 说明 |
   |------|--------|------|
   | **地域** | 香港 | 国内访问快且**免备案** |
   | **套餐** | 2核2G 起 | 够跑此游戏 |
   | **系统** | **Ubuntu 22.04** | 本文脚本适用 |
   | **时长** | 按需 | 新用户活动常有低价 |
3. 付款后，在控制台 **重置密码**（设置 SSH 登录密码）

---

## 二、放行端口（防火墙）

在腾讯云控制台 → 该实例 → **防火墙**，添加规则放行端口：

| 端口         | 协议 | 用途                             |
| ------------ | ---- | -------------------------------- |
| `22`         | TCP  | SSH 登录（默认已有）             |
| `50865`      | TCP  | **游戏主端口**（本教程直接暴露） |
| `80`（可选） | TCP  | 若用 Nginx 反代 + 域名           |

> 本文用最简单方案：**直接访问 `http://IP:50865`**。若想要干净的 `http://IP` 或 `https` 域名，见下文"进阶：Nginx + 域名"。

---

## 三、SSH 登录

Windows 自带 SSH，打开 **PowerShell / 终端**：

```bash
ssh root@<你的服务器IP>
```

输入你重置的密码。若提示主机密钥，输入 `yes`。

> 腾讯云轻量默认用户是 `root`（阿里云是 `root` 或 `ubuntu`）。若报 Permission denied，用 `ssh root@IP` 或 `ssh ubuntu@IP` 试试。

---

## 四、一键部署

登录服务器后，粘贴运行（注意换行，逐条执行）：

```bash
cd /root
curl -fsSL -o deploy.sh https://raw.githubusercontent.com/IcySycamore/deer-racing/main/deploy/deploy.sh
bash deploy.sh
```

> 若 `raw.githubusercontent.com` 被墙拉不下来，改为**本地上传**：把项目里的 `deploy/deploy.sh` 通过 [WinSCP](https://winscp.net) 或 scp 传到服务器，再 `bash deploy.sh`。

脚本会自动完成：装 Node 22 → 装 pm2 → 拉取代码 → 装依赖 → 启动 → 开机自启。

---

## 五、完成

部署成功后终端会打印地址：`http://<服务器IP>:50865`

浏览器访问即可开玩。验证步骤：

```bash
pm2 logs deer-racing      # 查看启动日志，应看到 listening 提示
curl http://127.0.0.1:50865   # 应返回 HTML
```

---

## 六、设置服主账号（发全服通告）

1. 先在游戏里**注册你的服主账号**（比如 `admin`）
2. 把 `admin` 设为服主，重启服务：

```bash
# 停掉 → 带 ADMIN_USERS 重新启动
pm2 delete deer-racing
ADMIN_USERS="admin" pm2 start server.js --name deer-racing
pm2 save
```

> 多个服主用逗号分隔：`ADMIN_USERS="admin,testplayer"`

---

## 七、常用运维命令

```bash
pm2 status                 # 服务状态
pm2 logs deer-racing       # 实时日志
pm2 restart deer-racing    # 重启
pm2 stop deer-racing       # 停止
pm2 monit                  # CPU/内存监控
```

**更新代码**（改完代码推到 GitHub 后）：

```bash
cd /opt/deer-racing && git pull origin main && pm2 restart deer-racing
```

---

## 八、进阶：Nginx + 域名（可选）

若想要 `http://IP` 无端口访问，或上 HTTPS 域名，用 Nginx 反代。**必须配置 WebSocket 升级头**，否则实时连接失败。

`/etc/nginx/sites-available/deer`：

```nginx
server {
    listen 80;
    server_name <你的域名或IP>;

    location / {
        proxy_pass http://127.0.0.1:50865;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;      # WebSocket 必需
        proxy_set_header Connection "upgrade";       # WebSocket 必需
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_read_timeout 3600s;                    # 长连接
    }
}
```

启用并重载：

```bash
ln -s /etc/nginx/sites-available/deer /etc/nginx/sites-enabled/
nginx -t && systemctl reload nginx
```

> 然后可以只放行 `80`（游戏端口 50865 可关闭或只对本机开放）。

---

## 九、数据备份

存档在 `/opt/deer-racing/data/accounts.json`。备份：

```bash
cp /opt/deer-racing/data/accounts.json /root/backup-$(date +%F).json
```

建议用 crontab 每日备份：

```bash
crontab -e
# 加入一行：
0 3 * * * cp /opt/deer-racing/data/accounts.json /root/backup-$(date +\%F).json
```

---

## 十、常见问题

| 问题                               | 解决                                                                     |
| ---------------------------------- | ------------------------------------------------------------------------ |
| **打不开页面**                     | 检查腾讯云防火墙是否放行 `50865`；`pm2 logs` 看是否报错                  |
| **能开但连不上实时**               | 确认用 `http://IP:50865`，且没被 Nginx 拦截 WebSocket 升级头             |
| **重启后账号没了**                 | 检查 `DATA_DIR` 是否指向了持久磁盘（脚本已默认 `/opt/deer-racing/data`） |
| **`raw.githubusercontent` 拉不到** | 改用 WinSCP 手动上传 `deploy.sh`                                         |
| **国内访问还是慢**                 | 确认地域选的是**香港**；大陆节点需备案                                   |
