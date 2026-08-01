#!/usr/bin/env bash
# ============================================================
# 荣耀赛鹿 · 腾讯云 Ubuntu 一键部署脚本
# 适用：腾讯云/阿里云 轻量应用服务器（Ubuntu 20.04 / 22.04）
# 用法：以 root 或 sudo 执行  bash deploy.sh
# ============================================================
set -e

# ---------- 配置区（按需修改） ----------
REPO_URL="https://github.com/IcySycamore/deer-racing.git"   # 你的 GitHub 仓库
BRANCH="main"
APP_DIR="/opt/deer-racing"        # 项目安装目录
DATA_DIR="/opt/deer-racing/data"  # 存档数据目录（务必指向磁盘，勿放 tmpfs）
APP_PORT="${PORT:-50865}"         # 游戏监听端口
APP_HOST="${HOST:-0.0.0.0}"       # 云服务器必须 0.0.0.0
ADMIN_USERS="${ADMIN_USERS:-}"    # 服主账号，逗号分隔，如 "admin,testplayer"
# -----------------------------------------

echo "==> [1/6] 更新系统并安装基础依赖"
export DEBIAN_FRONTEND=noninteractive
apt-get update -y
apt-get install -y curl git build-essential ufw

echo "==> [2/6] 安装 Node.js 22 (官方源)"
if ! command -v node >/dev/null 2>&1; then
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
  apt-get install -y nodejs
fi
echo "Node: $(node -v)  npm: $(npm -v)"

echo "==> [3/6] 安装 pm2 进程守护"
npm install -g pm2

echo "==> [4/6] 克隆代码"
if [ ! -d "$APP_DIR/.git" ]; then
  git clone -b "$BRANCH" "$REPO_URL" "$APP_DIR"
else
  cd "$APP_DIR" && git fetch origin && git reset --hard "origin/$BRANCH"
fi

echo "==> [5/6] 安装依赖"
cd "$APP_DIR"
npm install --omit=dev

echo "==> [6/6] 启动并设置开机自启"
mkdir -p "$DATA_DIR"
# 以环境变量方式传入配置（admin 账号请先在游戏里注册，再填入 ADMIN_USERS）
pm2 delete deer-racing >/dev/null 2>&1 || true
HOST="$APP_HOST" PORT="$APP_PORT" DATA_DIR="$DATA_DIR" \
  ADMIN_USERS="$ADMIN_USERS" \
  pm2 start server.js --name deer-racing
pm2 save
pm2 startup systemd >/dev/null 2>&1 || true

echo ""
echo "=============================================="
echo "✅ 部署完成！"
echo "   访问地址:  http://<你的服务器IP>:$APP_PORT"
echo "   管理命令:  pm2 logs deer-racing  查看日志"
echo "              pm2 monit           资源监控"
echo "   存档目录:  $DATA_DIR (已持久化)"
echo "   服主账号:  ${ADMIN_USERS:-未设置(游戏内注册后再填)}"
echo "=============================================="
echo ""
echo "⚠️ 请在腾讯云【防火墙/安全组】放行端口 $APP_PORT"
