#!/bin/bash
# 早间 Roblox 快扫（2026-11-06 起由中台规则「Roblox 早报」调用，原 launchd com.ken.roblox-morning，每天北京时间 09:00）
#
# 为什么（2026-10-10 复盘）：主雷达每天 12:30 才跑，而竞品的建站动作比我们早 5 天，
# 起量窗口正好落在管线的空档里。这班只看 Roblox 榜单（增长 + YouTube 错配），
# 不等 Trends、不占搜索额度，第一次上榜的强候选直接推通知。
#
# 不写报告文件（总报告仍由 12:30 的 daily.sh 出），只更新
# game-name-radar/data/roblox-morning-state.json 并弹通知。
set -u
HERE="$HOME/Desktop/david/Ship/game-name-radar"
SHIP="$HOME/Desktop/david/Ship"
NODE="$HOME/.nvm/versions/node/v22.22.0/bin/node"
LOG="$SHIP/out/logs/roblox-morning.log"
mkdir -p "$SHIP/out/logs"
exec >>"$LOG" 2>&1
echo "=== $(date '+%F %T') 开始"

# 等网络就绪（最多 10 分钟）——早上刚唤醒时 8:30 那班就是死在这
ready=""
for i in $(seq 1 10); do
  if curl -s -x http://127.0.0.1:7897 --max-time 8 -o /dev/null -w '%{http_code}' https://www.google.com/generate_204 | grep -q 204; then
    ready=1
    break
  fi
  sleep 60
done
if [ -z "$ready" ]; then
  echo "网络/代理 10 分钟没就绪，跳过这一班"
  exit 1
fi

export NODE_USE_ENV_PROXY=1 https_proxy=http://127.0.0.1:7897 http_proxy=http://127.0.0.1:7897
cd "$HERE" || exit 1
"$NODE" --env-file-if-exists=.env radar.mjs --morning 2>&1 | grep --line-buffered -v -e EnvHttpProxyAgent -e trace-warnings
echo "=== $(date '+%F %T') 完成"
