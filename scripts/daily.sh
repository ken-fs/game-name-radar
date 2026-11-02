#!/bin/bash
source /Users/david/Desktop/david/Ship/scripts/notify.sh  # ship_notify：推飞书（2026-10-11）
# 每日雷达（launchd com.ken.game-radar 调用；北京时间 08:30–18:30 每小时一个时间点，
# 跑成功一次后当天其余时间点直接跳过。
# 2026-10-23 提前：原来卡「美东当天 00:30 之后」（北京 12:30、冬令时 13:30 才起跑，管线 ~76 分钟，
# 总报告 14 点后才出）→ 11:55 的站群后台快照永远只能带前一天的雷达。改到北京 08:30
# （美东前一晚 20:30 / 冬令时 19:30），~09:46 出报告、赶上当天 11:55 快照。
# 代价：美区「前一天」数据少最后 ~4 小时——YouTube 7 天中位 / Trends / Steam 实时畅销都是滚动周期，
# 影响可忽略；当晚新上的游戏次日仍在「新」窗口内会被扫到。）
#
# 为什么要这层壳（2026-10-08 排查）：
# - 10-04：08:30 没开机，整天没跑
# - 10-06、10-07：08:30 刚唤醒、网络和代理还没起来，20 个信息源全部 ENOTFOUND，等于白跑
# - 10-08：Google 探测一次超时，投入价值 / 梗 / 可玩三个子雷达被静默跳过
# - 日志在 /tmp，重启就没了，查不到原因
#
# 现在：先等网络就绪（最多 15 分钟）→ 跑 scan.mjs → 检查这次是不是「真成功」→ 成功才写当天的完成标记、
# 再跑 radar.mjs 出总报告；不成功就不写标记，下一个时间点自动重试；当天最后一次还失败就弹通知。
set -u
# 2026-10-23 教训：macOS bash 3.2 在 UTF-8 locale 下会把多字节标点（如「）」）误拼进变量名，
# 「$net_ok）」→ 报 unbound 直接挂（set -u）。launchd 环境无 LANG 所以一直没事，
# 但 agent / 用户手动跑会带着 LANG=zh_CN.UTF-8 → 必崩。钉死 C locale（只影响字符分类，中文照常输出）。
export LC_ALL=C
HERE="$HOME/Desktop/david/Ship/game-name-radar"
SHIP="$HOME/Desktop/david/Ship"
NODE="$HOME/.nvm/versions/node/v22.22.0/bin/node"
LOGDIR="$SHIP/out/logs"
TODAY=$(date +%F)                          # 报告文件名用的本地日期
BJ_HM=$(date +%H%M)
DONE="$LOGDIR/game-radar-ok-$TODAY"
LAST_SLOT_HOUR=18
mkdir -p "$LOGDIR"
exec >>"$LOGDIR/game-radar.log" 2>&1
cd "$HERE" || exit 1
echo "=== $(date '+%F %T') 开始"

if [ "${1:-}" != "--force" ]; then
  if [ "$BJ_HM" -lt 0830 ]; then
    # 08:30 之前不跑（launchd 时间点从 08:30 起；唤醒补跑落在更早时刻时直接跳过）
    echo "北京 $BJ_HM 未到 08:30，跳过"
    exit 0
  fi
  if [ -f "$DONE" ]; then
    echo "$TODAY 已经成功跑过，跳过"
    exit 0
  fi
fi

# 1. 等网络：能通过代理或直连拿到 Google 204，**且 suggestqueries 能连上**才算就绪。
#    2026-10-23 教训：只探 google.com/204 会被「google.com 没被污染、别的域名全被 DNS 污染」骗过，
#    当天头两轮雷达信息源全挂。suggestqueries 用 curl 退出码判（连上就算通，429 限流也算通，不卡）。
net_ok=""
for _ in $(seq 1 30); do
  if curl -s -x http://127.0.0.1:7897 --max-time 8 -o /dev/null -w '%{http_code}' https://www.google.com/generate_204 | grep -q 204; then
    if curl -s -x http://127.0.0.1:7897 --max-time 8 -o /dev/null "https://suggestqueries.google.com/complete/search?client=firefox&q=ok"; then
      export NODE_USE_ENV_PROXY=1 https_proxy=http://127.0.0.1:7897 http_proxy=http://127.0.0.1:7897
      net_ok="proxy"; break
    fi
    echo "⚠️ google 204 通（代理）但 suggestqueries 连不上——多半又是 DNS 污染（见 Ship/docs/PROXY.md），当未就绪处理"
  elif curl -s --max-time 8 -o /dev/null -w '%{http_code}' https://www.google.com/generate_204 | grep -q 204; then
    if curl -s --max-time 8 -o /dev/null "https://suggestqueries.google.com/complete/search?client=firefox&q=ok"; then
      unset NODE_USE_ENV_PROXY https_proxy http_proxy
      net_ok="direct"; break
    fi
    echo "⚠️ google 204 通（直连）但 suggestqueries 连不上——多半又是 DNS 污染（见 Ship/docs/PROXY.md），当未就绪处理"
  fi
  sleep 30
done
if [ -z "$net_ok" ]; then
  echo "等了 15 分钟网络还没就绪，这一轮不跑，下个时间点再试"
  exit 1
fi
echo "网络就绪（$net_ok）"

# 2. 主管线（Steam / itch / HTML5 / Trends / 投入价值 / 梗（含 Wikipedia 热门）/ 可玩）
#    同时在后台跑 Steam 关注者增速（2026-10-12 加）：steamcommunity 限流，要慢慢抓（4 秒一个、最多 30 分钟），
#    和 scan.mjs（约 30 分钟）打的不是同一个站，并行跑不拖长总时间；第 5 步出总报告前等它跑完。
( "$NODE" lib/steam-follow-watch.mjs 2>&1 | grep --line-buffered -v -e EnvHttpProxyAgent -e trace-warnings ) &
FOLLOW_PID=$!
"$NODE" --env-file-if-exists=.env scripts/scan.mjs 2>&1 | grep --line-buffered -v -e EnvHttpProxyAgent -e trace-warnings

# 3. 判断是不是真成功：核心发现源（Steam / itch / 门户 / Newgrounds）至少七成成功，而且梗 / 可玩两份
#    当天报告都生成了。Trends「上升词」源不算进成败：它们被 Google 按 IP 限流时一失败就重试，
#    只会越刷越被限（10-08 实测），所以只记警告。
verdict=$("$NODE" -e '
const fs=require("fs");const today=process.argv[1];
const r=JSON.parse(fs.readFileSync("data/latest-report.json","utf8"));
const fresh=(Date.now()-Date.parse(r.scannedAt))<3*3600e3;
const src=r.sources||[];const isTrends=s=>String(s.sourceId||"").startsWith("trends-");
const core=src.filter(s=>!isTrends(s)),trends=src.filter(isTrends);
const ok=core.filter(s=>s.ok).length,tOk=trends.filter(s=>s.ok).length;
const meme=fs.existsSync(`../reports/meme/RADAR-MEME-${today}.md`),playable=fs.existsSync(`../reports/playable/RADAR-PLAYABLE-${today}.md`);
const pass=fresh&&core.length>0&&ok/core.length>=0.7&&meme&&playable;
const warn=trends.length&&tOk<trends.length?` · ⚠️ Trends 上升词源 ${tOk}/${trends.length}（多半是被 Google 限流，不重试）`:"";
console.log(`${pass?"OK":"FAIL"} 核心信息源 ${ok}/${core.length} · 梗报告 ${meme?"有":"无"} · 可玩报告 ${playable?"有":"无"} · 本次扫描 ${fresh?"新":"旧"}${warn}`);
' "$TODAY")
echo "$verdict"

if [[ "$verdict" != OK* ]]; then
  if [ "$(date +%H)" -ge "$LAST_SLOT_HOUR" ]; then
    ship_notify "每日任务未跑成" "游戏雷达：$verdict。日志：Ship/out/logs/game-radar.log"
  fi
  exit 1
fi

# 4. 新数据源（2026-10-12 加，复盘盲区：volatiles / emberquest 这类 Steam 预发布游戏没有任何雷达报过）
#    - Google 联想差分：「codes for / tier list for / best class in …」+ a–z 的补全和过去 14 天比 → RADAR-SUGGEST（约 4 分钟，
#      放在 scan.mjs 之后跑：梗 / 可玩雷达也在打 Google 联想，错开）
#    - 等第 2 步后台的 Steam 关注者增速（预发布 / 刚发售 ±30 天的游戏池 ≤300 个）→ RADAR-STEAMFOLLOW
#    - Steam 畅销 / 在玩榜新上榜（2026-10-13 加，复盘盲区：Dressmaker / Graveyard Keeper 2 / Dawnwalker 发售后冲上畅销榜，
#      没有任何雷达报过）：周畅销 全球/美/德/日 + 在玩榜 + 实时畅销 美/德/日，新上榜或升 ≥30 名且刚发售 → RADAR-STEAMCHARTS
#      （约 4 分钟；榜单本身十几次请求，时间花在 🟢 的工具需求 / 投入价值上，都打 Google 联想，所以排在联想差分之后、不和 scan.mjs 并行）
#    失败不影响下面的总报告（读不到就写「还没生成」）。都不推通知，🟢 进总报告统一推。
"$NODE" lib/suggest-diff-watch.mjs 2>&1 | grep --line-buffered -v -e EnvHttpProxyAgent -e trace-warnings
"$NODE" lib/steam-charts-watch.mjs 2>&1 | grep --line-buffered -v -e EnvHttpProxyAgent -e trace-warnings
wait "$FOLLOW_PID"

# 5. 总报告（Roblox 现跑 + 汇总上面的报告）；RADAR_NOTIFY=1 → 跑完把「今天最值得看」推到通知中心
#    2026-10-13 加站型信号：「今天最值得看」每条带 🧮 工具需求（Google Suggest）+ codes 媒体进场数（treg，≤15 次/天、缓存 3 天）；
#    查不到只在那一条写「查询失败」，不影响总报告
RADAR_NOTIFY=1 "$NODE" radar.mjs 2>&1 | grep --line-buffered -v -e EnvHttpProxyAgent -e trace-warnings

# 6. 占位队列（2026-10-11 加）：把当日高信号候选（近 21 天新词 + 5 天有活动）直接变成
#    「域名可买性清单」——.wiki 生态位是抢出来的（BOMBANANA 复盘：发现躺 10 天、同行 9 域围上来）。
#    零成本（RDAP 免费 + 7 天缓存）；🟢 新出现的可买 .wiki 推通知。
"$NODE" --env-file-if-exists=.env lib/occupy-queue.mjs 2>&1 | grep --line-buffered -v -e EnvHttpProxyAgent -e trace-warnings

# 7. 否决候选到期复测（2026-10-30 加）：需求型否决 +3/+7/+14/+30 天复测，结构型只留档。
#    复用现有 Roblox / Steam 闸门；只有「判决上升 + 有需求证据」才推翻转，网络失败次日重试。
"$NODE" --env-file-if-exists=.env lib/rejection-recheck.mjs 2>&1 | grep --line-buffered -v -e EnvHttpProxyAgent -e trace-warnings

# 7b. 新词待复查 + 稳涨冷门（2026-11-01 加，复盘 Nomad Drive / Rip It 等 7 个漏词：首见热度低或未发售就被弃）
#     当天总报告的 Steam / Roblox / 联想新词 / H5 候选全部进 data/fresh-recheck-queue.json；
#     有发售日 → 发售后 48h 复查，没有 → 首见第 2 天复查：pytrends（免费）≥首见 ×1.5 且专用站 ≤1 → 推 GO；
#     另查稳涨冷门（连续 3 周 ≥+30%、近 4 周 ≥ 前 4 周 ×2）。专用站只做 NRD + RDAP 启发式，SERP 标「需人工核」，
#     不用 SearchAPI / SerpAPI / treg。→ reports/recheck/RADAR-RECHECK-<日期>.md；失败不挡管线。
"$NODE" --env-file-if-exists=.env lib/fresh-recheck.mjs --notify 2>&1 | grep --line-buffered -v -e EnvHttpProxyAgent -e trace-warnings -e '^\[pytrends\]'

# 7.5 每天挑「今天能做的 codes 站」（2026-11-02 用户定：找到能做的就发、不限数量，没有就不做）：
#     读当天 verdict-log + 复查 GO → Roblox / 联想 / SERP / 域名四道闸 → 推飞书「请买 X」或「今天没有」。
#     只用免费接口（DDG 直连优先，Tavily 免费档兜底且有月上限），约 3–8 分钟；失败不挡管线。
"$NODE" --env-file-if-exists=.env lib/codes-pick.mjs --notify 2>&1 | grep --line-buffered -v -e EnvHttpProxyAgent -e trace-warnings | tail -5

# 8. occupy / 否决账本数据入库（2026-10-16 加）：管线每天改、以前没人 commit → 巡检第二天必报「改了没 commit」。
#    跑完顺手提交 + 推送（失败不挡管线，巡检会抓）。
git add data/occupy-state.json data/occupy-domains.json data/rejections.json data/fresh-recheck-queue.json data/pick-state.json
if ! git diff --cached --quiet; then
  git commit -q -m "chore: occupy-queue 每日状态 $TODAY"
  GIT_TERMINAL_PROMPT=0 git push -q origin main \
    || GIT_TERMINAL_PROMPT=0 git -c http.proxy=http://127.0.0.1:7897 push -q origin main \
    || GIT_SSH_COMMAND="ssh -i $HOME/.ssh/id_ed25519 -o IdentitiesOnly=yes" git push -q git@github.com:ken-fs/game-name-radar-tools.git main \
    || echo "⚠️ occupy 数据 push 失败，留在本地，明天巡检会报"
fi

touch "$DONE"
find "$LOGDIR" -name 'game-radar-ok-*' -mtime +14 -delete
echo "=== $(date '+%F %T') 完成"
