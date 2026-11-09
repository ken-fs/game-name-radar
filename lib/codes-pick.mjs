#!/usr/bin/env node
/**
 * codes-pick.mjs — 每天从雷达候选里挑「今天能做的 Roblox codes 站」，推飞书让用户买域名（2026-11-02 用户定）。
 *
 * 用户原话：「固定一天一个就很蠢，每天应该有找到可以做的词就发，不限制数量，如果没有合适的也不是非要做」。
 * 以前雷达只报候选，判断要人开口才做（11-01 报的 PAO PAO 其实是 WNBA 球员，Bey Rivals 前排已有 6 个专门站）。
 * 这个脚本把 11-02 手工走过两遍的流程（animevsanime / punchwalls）固化下来，每天跑在 fresh-recheck 之后。
 *
 * 花费：优先免费接口——Roblox 官方 API、Google Suggest、DuckDuckGo HTML、Spaceship 查域名（不注册）。
 *   DDG 失败才走 Tavily（共享 24h 缓存 + 月度预算）；不碰 Serper / treg / AIsa，不调任何模型。耗时主要在 DDG 的 20 秒间隔：
 *   便宜的闸门（Roblox、联想）先筛，只有过了的才查 SERP，每天最多 MAX_SERP 个 → 最多约 8 分钟。
 *
 * 门槛（照 docs/GAME-SITE-STRUCTURE.md A 和 STRATEGY.md「11 月破例」）：
 *   1. Roblox 上搜得到这个名字，而且是同一款游戏（名字里的词都在游戏名里）——防 PAO PAO 这种非游戏词
 *   2. 在线 ≥ MIN_CCU、14 天内更新过
 *   3. Google 联想里有「<游戏> codes」——codes 站只做有人搜码的
 *   4. 「<游戏> codes」前 10 里别人的专门站 ≤ MAX_CODES_SITES（媒体多不算挡：padeliber / punchwalls 都是跟媒体抢的）
 *   5. 「<游戏> wiki」前 10 里专门站 < LATE_WIKI_SITES（≥3 = 晚了，Bey Rivals 规则）
 *   6. 不是我们已经有站的游戏；GAME-DECISIONS 近 14 天因为竞争判过 ❌ / 晚了 的跳过（因为需求判 ❌ 的只提醒，见 lib/prior-verdict.mjs）
 *   7. .com / .wiki / .site 至少一个能注册
 *   SERP 拿不到（DDG 限频 / 空响应）→ 标「没核到」，不推荐——宁可漏报，不让用户为没核实的词花钱。
 *
 * 用法：
 *   node lib/codes-pick.mjs            # 打印 + 写报告
 *   node lib/codes-pick.mjs --notify   # 再推飞书（daily.sh 用）
 *   node lib/codes-pick.mjs --date 2026-11-02 --max 5
 * 输出：Ship/reports/pick/PICK-<日期>.md；状态 data/pick-state.json（报过的游戏，次日再报会标「N 天前报过」）
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tavilySearch } from './tavily-search.mjs';
import { recentRejection } from './prior-verdict.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const SHIP = join(ROOT, '..');
const STATE = join(ROOT, 'data', 'pick-state.json');
const REPORTS = join(SHIP, 'reports', 'pick');

const MIN_CCU = 1500; // padeliber 1.5K 在线时 28 天拿到 2,896 点击
const MAX_UPDATED_DAYS = 14;
const MAX_CODES_SITES = 2;
const LATE_WIKI_SITES = 3;
const MAX_SERP = 12;
const TLDS = ['com', 'wiki', 'site'];

const args = process.argv.slice(2);
const flag = (k) => args.includes(k);
const opt = (k, d) => (args.includes(k) ? args[args.indexOf(k) + 1] : d);
const DATE = opt('--date', new Date().toLocaleDateString('sv-SE', { timeZone: 'Asia/Shanghai' }));
const LIMIT = Number(opt('--max', MAX_SERP));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
async function getJson(url, tries = 3) {
  for (let i = 0; i < tries; i++) {
    try {
      const headers = { 'User-Agent': UA };
      const r = await fetch(url, { headers, signal: AbortSignal.timeout(20000) });
      if (r.ok) return await r.json();
      if (r.status === 404) return null;
    } catch {}
    await sleep(2000 * (i + 1));
  }
  throw new Error(`fetch failed: ${url.slice(0, 80)}`);
}

// ── 名字归一 ──
const STOP = new Set(['the', 'a', 'an', 'in', 'of', 'to', 'for', 'and', 'roblox', 'codes', 'code']);
const words = (s) => String(s).toLowerCase().replace(/\[[^\]]*\]/g, ' ').replace(/[^a-z0-9 ]+/g, ' ').split(/\s+/).filter(Boolean);
const keyWords = (s) => words(s).filter((w) => !STOP.has(w));
/** "[CH3] Punch Walls To Escape" → "Punch Walls To Escape"；emoji / 方括号标签 / 结尾标点都去掉 */
export const cleanGameName = (s) =>
  String(s)
    .split(/\s[|｜]\s/)[0]
    .replace(/\[[^\]]*\]|\([^)]*\)/g, ' ')
    .replace(/\b(update|upd|ch|chapter|season|part)\s*[\d.]+.*$/i, ' ')
    .replace(/[^\p{L}\p{N}' &:!-]/gu, ' ')
    .replace(/\s+/g, ' ')
    .replace(/^[\s!:-]+|[\s!:-]+$/g, '')
    .trim();
export const compact = (s) => words(cleanGameName(s)).join('');
/** 候选词的每个关键词都出现在游戏名里，才算同一款（「fall for brainrots in」→ fall + brainrots） */
export const sameGame = (term, gameName) => {
  const g = new Set(words(gameName));
  const k = keyWords(term);
  return k.length > 0 && k.every((w) => g.has(w) || g.has(w.replace(/s$/, '')) || g.has(`${w}s`));
};

// ── 1. 候选：雷达当天的 Roblox / 联想新词 🟢 + 复查队列里还在 go 的 Roblox ──
function candidates() {
  const out = new Map();
  const add = (term, extra) => {
    const k = keyWords(term).join(' ');
    if (k && !out.has(k)) out.set(k, { term, ...extra });
  };
  const log = join(ROOT, 'data', 'verdict-log.jsonl');
  if (existsSync(log)) {
    for (const line of readFileSync(log, 'utf8').split('\n')) {
      if (!line.includes(`"${DATE}"`)) continue;
      let r;
      try { r = JSON.parse(line); } catch { continue; }
      if (r.date !== DATE || !String(r.verdict).includes('🟢')) continue;
      if (/^roblox/.test(r.line)) add(r.name, { from: `雷达 ${r.line}`, universeId: r.signals?.universeId, growth: r.signals?.growthX, magnitude: r.signals?.magnitude });
      else if (r.line === 'suggest-diff') add(r.name, { from: '联想新词', intents: r.signals?.intents });
    }
  }
  const q = join(ROOT, 'data', 'fresh-recheck-queue.json');
  if (existsSync(q)) {
    const recent = new Date(Date.parse(DATE) - 3 * 864e5).toISOString().slice(0, 10);
    for (const v of Object.values(JSON.parse(readFileSync(q, 'utf8')))) {
      const last = v.checks?.[v.checks.length - 1];
      if (v.kind === 'roblox' && v.status === 'go' && last?.date >= recent) add(v.name, { from: `复查 GO ×${last.ratio}` });
    }
  }
  return [...out.values()];
}

// ── 2. Roblox：解析成具体游戏 ──
async function resolveGame(c) {
  let uid = c.universeId;
  if (!uid) {
    const d = await getJson(`https://apis.roblox.com/search-api/omni-search?searchQuery=${encodeURIComponent(c.term)}&sessionId=codes-pick&pageType=all`);
    const hit = (d?.searchResults ?? []).flatMap((r) => r.contents ?? []).find((x) => x.universeId && sameGame(c.term, x.name));
    uid = hit?.universeId;
  }
  if (!uid) return null;
  const g = (await getJson(`https://games.roblox.com/v1/games?universeIds=${uid}`))?.data?.[0];
  if (!g || !sameGame(c.term, g.name)) return null;
  return { universeId: String(uid), placeId: g.rootPlaceId, rawName: g.name, name: cleanGameName(g.name), playing: g.playing, visits: g.visits, created: g.created.slice(0, 10), updated: g.updated.slice(0, 10), creator: g.creator?.name };
}

// ── 3. Google 联想 ──
async function suggest(q) {
  const d = await getJson(`https://suggestqueries.google.com/complete/search?client=firefox&hl=en&gl=us&q=${encodeURIComponent(q)}`);
  return Array.isArray(d?.[1]) ? d[1] : [];
}

// ── 4. SERP：DDG 优先（免费、无额度，但会限流），拿不到再用 Tavily 免费档 ──
// DDG 走直连（curl --noproxy）：走 Clash 代理时 DDG 回空页（11-02 实测）。被限流也是空页 → 等 45 秒再试一次。
// Tavily：账户是免费 Researcher 档、没开 paygo（额度用完只会报错，不会扣钱）。本脚本每月最多用 TAVILY_CAP 次，
// 而且账户剩余 < TAVILY_RESERVE 就不碰，留给别的任务。SerpApi 免费 250 次 11-02 已用完、Serper 10-10 用完，不接。
const TAVILY_CAP = 150;
const TAVILY_RESERVE = 200;
let lastDdg = 0;
function ddgOnce(query) {
  const html = execFileSync('curl', ['-s', '--noproxy', '*', '--max-time', '25', '-A', UA, '-H', 'Accept-Language: en-US,en;q=0.9', `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`], { encoding: 'utf8', maxBuffer: 8e6 });
  const out = [];
  for (const m of html.matchAll(/class="result__a"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g)) {
    let href = m[1];
    const u = href.match(/uddg=([^&]+)/);
    if (u) href = decodeURIComponent(u[1]);
    try { out.push({ host: new URL(href).hostname.replace(/^www\./, ''), title: m[2].replace(/<[^>]+>/g, '').replace(/&amp;/g, '&').trim() }); } catch {}
    if (out.length >= 10) break;
  }
  return out;
}
async function ddg(query) {
  for (const gap of [20000, 45000]) {
    const wait = gap - (Date.now() - lastDdg);
    if (wait > 0) await sleep(wait);
    lastDdg = Date.now();
    let hosts = [];
    try { hosts = ddgOnce(query); } catch {}
    if (hosts.length) return hosts;
  }
  return [];
}
async function tavily(query, usage) {
  if (usage.tavily >= TAVILY_CAP) return { hosts: [], via: null };
  try {
    const { results, cached } = await tavilySearch(query, { maxResults: 10, reserve: TAVILY_RESERVE });
    if (!cached) usage.tavily++;
    const hosts = results.map((x) => { try { return { host: new URL(x.url).hostname.replace(/^www\./, ''), title: x.title ?? '' }; } catch { return null; } }).filter(Boolean);
    return { hosts, via: hosts.length ? (cached ? 'cache' : 'tavily') : null };
  } catch { return { hosts: [], via: null }; }
}
async function serp(query, usage) {
  const hosts = await ddg(query);
  if (hosts.length) { usage.ddg++; return { hosts, via: 'ddg' }; }
  return tavily(query, usage);
}
/** 写 codes 页的媒体（codes-media.mjs 的 9 家 + 本机 403 / 常见的几家）——只用来在推送里报个数，不当门槛 */
const MEDIA = new Set(['beebom.com', 'pockettactics.com', 'gamerant.com', 'pcgamesn.com', 'destructoid.com', 'urgametips.com', 'sportskeeda.com', 'thegamer.com', 'robloxden.com', 'progameguides.com', 'tryhardguides.com', 'dexerto.com', 'eurogamer.net', 'games.gg', 'twinfinite.net', 'game.guide', 'mrguider.org', 'gachapocket.com', 'newtoplay.com', 'bloxrant.com', 'ign.com', 'polygon.com', 'radiotimes.com', 'siliconera.com']);
/** 域名里带着游戏名（beyrivals-wiki.wiki、punchwallstoescape.wiki、xxx.fandom.com）= 专门站 */
const isDedicated = (host, key) => host.replace(/[^a-z0-9.]/g, '').split('.').slice(0, -1).join('').includes(key);

// ── 5. 我们已有的站 / 判过的游戏 ──
function ourDomains() {
  const set = new Set();
  for (const f of ['out/cf-sites.json', 'out/dashboard/data.json']) {
    try {
      const d = JSON.parse(readFileSync(join(SHIP, f), 'utf8'));
      for (const s of d.list ?? d.sites ?? []) if (s.domain) set.add(s.domain.replace(/^www\./, ''));
    } catch {}
  }
  return [...set];
}
// 判过的游戏：lib/prior-verdict.mjs（2026-11-09 拆出来；按原因分：竞争 → 挡，需求 → 只提醒）
const priorVerdict = (name) => recentRejection(name, { date: DATE, ship: SHIP });

// ── 6. 域名（Spaceship 只查不买）。凭据在 ~/.config/spaceship/env（launchd 不读 shell），自己加载，照 occupy-queue.mjs ──
function spaceshipEnv() {
  const env = { ...process.env };
  try {
    for (const line of readFileSync(join(process.env.HOME || '', '.config', 'spaceship', 'env'), 'utf8').split('\n')) {
      const m = line.match(/^\s*(?:export\s+)?([A-Z_]+)=["']?([^"'\s]+)/);
      if (m) env[m[1]] = m[2];
    }
  } catch {}
  return env;
}
const SPACESHIP_ENV = spaceshipEnv();
function domainCheck(name) {
  const res = {};
  for (const tld of TLDS) {
    const d = `${name}.${tld}`;
    try {
      const out = execFileSync(process.execPath, [join(SHIP, 'scripts', 'spaceship.mjs'), 'check', d], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 30000, env: SPACESHIP_ENV });
      res[d] = /"result":\s*"available"/.test(out) ? (/premiumPricing":\s*\[\s*\{/.test(out) ? 'premium' : 'available') : 'taken';
    } catch {
      res[d] = 'unknown';
    }
  }
  return res;
}

// ── 主流程 ──
const state = existsSync(STATE) ? JSON.parse(readFileSync(STATE, 'utf8')) : {};
const MONTH = DATE.slice(0, 7);
if (state._usage?.month !== MONTH) state._usage = { month: MONTH, ddg: 0, tavily: 0 };
const usage = state._usage;
const mine = ourDomains();
const cands = candidates();
const rows = [];
let serpUsed = 0;

for (const c of cands) {
  const row = { term: c.term, from: c.from, growth: c.growth, magnitude: c.magnitude };
  rows.push(row);
  try {
    const g = await resolveGame(c);
    if (!g) { row.reject = 'Roblox 上没有同名游戏（不是游戏词，或名字对不上）'; continue; }
    Object.assign(row, g);
    const key = compact(g.name);
    row.key = key;
    if (rows.some((r) => r !== row && r.universeId === g.universeId)) { row.reject = '同一款游戏已在上面'; row.dup = true; continue; }
    const ours = mine.find((d) => d.replace(/[^a-z0-9.]/g, '').includes(key));
    if (ours) { row.reject = `我们已有站 ${ours}`; continue; }
    // 判过 ❌ 按原因分（2026-11-09）：竞争类（专门站多 / 晚了 / 已进场）直接挡——竞品不会自己消失，Evermore High 11-05 判
    // 「已有 6 个专门站」，11-09 还被当「能做」推了出来。需求类不挡、只提醒：数据会变（Cut a Rock 10-31 判「发布尖峰后归零」，
    // 11-02 又 14 倍增长、1.3 万在线）。挡在查 SERP 之前，省 DDG / Tavily 额度
    const prior = priorVerdict(g.name);
    if (prior?.competition) { row.reject = `${prior.date} 判过 ❌（竞争）：${prior.text}`; continue; }
    row.prior = prior ? `${prior.date}：${prior.text}` : null;
    if (g.playing < MIN_CCU) { row.reject = `在线 ${g.playing} < ${MIN_CCU}`; continue; }
    const age = (Date.parse(DATE) - Date.parse(g.updated)) / 864e5;
    if (age > MAX_UPDATED_DAYS) { row.reject = `${Math.round(age)} 天没更新`; continue; }

    const sug = await suggest(`${g.name.toLowerCase()} `);
    row.suggest = sug;
    const codesSug = sug.filter((s) => /\bcodes?\b/.test(s) && sameGame(g.name, s));
    if (!codesSug.length) { row.reject = 'Google 联想里没有「<游戏> codes」'; continue; }

    if (serpUsed >= LIMIT) { row.reject = `今天查 SERP 的名额（${LIMIT}）用完了，明天再看`; row.unchecked = true; continue; }
    serpUsed++;
    const cs = await serp(`${g.name} codes`, usage);
    const ws = await serp(`${g.name} wiki`, usage);
    // 2026-11-02 Cut a Rock：「cut a rock codes」前 10 几乎全是 Cut a Gem 的码页。只看域名会把它们算成「媒体 8 家」，
    // 所以留着标题：讲别的游戏的结果单独计数，媒体只算标题里有本游戏名的
    const onTopic = (r) => sameGame(g.name, r.title);
    const codesSerp = cs.hosts.map((r) => r.host);
    const wikiSerp = ws.hosts.map((r) => r.host);
    row.offTopic = cs.hosts.filter((r) => !onTopic(r) && !isDedicated(r.host, key)).length;
    row.codesMediaOn = cs.hosts.filter((r) => MEDIA.has(r.host) && onTopic(r)).length;
    if (!codesSerp.length || !wikiSerp.length) { row.reject = 'SERP 没核到（DDG 被限流、Tavily 不可用或到了本月上限），不推荐'; row.unchecked = true; continue; }
    row.serpVia = [...new Set([cs.via, ws.via])].join('+');
    row.codesSerp = codesSerp;
    row.codesSites = codesSerp.filter((h) => isDedicated(h, key));
    row.codesMedia = row.codesMediaOn;
    row.wikiSites = [...new Set(wikiSerp.filter((h) => isDedicated(h, key)))];
    if (row.wikiSites.length >= LATE_WIKI_SITES) { row.reject = `晚了：wiki 前 10 已有 ${row.wikiSites.length} 个专门站（${row.wikiSites.slice(0, 3).join('、')}）`; continue; }
    if (row.codesSites.length > MAX_CODES_SITES) { row.reject = `codes 前 10 已有 ${row.codesSites.length} 个专门站（${row.codesSites.slice(0, 3).join('、')}）`; continue; }

    row.domains = domainCheck(key);
    row.buy = Object.entries(row.domains).find(([, v]) => v === 'available')?.[0] ?? null;
    if (!row.buy) { row.reject = `域名都被占（${Object.keys(row.domains).join(' / ')}）`; continue; }
    row.pick = true;
  } catch (e) {
    row.reject = `出错：${e.message}`;
    row.unchecked = true;
  }
}

// ── 报告 ──
const picks = rows.filter((r) => r.pick);
const line = (r) => {
  const prev = state[r.universeId];
  const seen = prev && prev.lastPicked !== DATE ? `（${Math.round((Date.parse(DATE) - Date.parse(prev.firstPicked)) / 864e5)} 天前报过，还没做）` : '';
  return [
    `**${r.name}**${seen}：${r.playing.toLocaleString('en-US')} 在线 · ${(r.visits / 1e6).toFixed(1)}M 访问 · ${r.created} 上线 · 开发者 ${r.creator}`,
    `  - 为什么能做：联想有 ${r.suggest.filter((s) => /codes?/.test(s)).slice(0, 2).join(' / ')}；codes 前 10 别人的专门站 ${r.codesSites.length} 个${r.codesSites.length ? `（${r.codesSites.join('、')}）` : ''}、讲这款的媒体 ${r.codesMedia} 家${r.offTopic >= 5 ? `（⚠️ ${r.offTopic} 条讲的是别的游戏：名字撞了，搜的人可能找的不是它）` : ''}，wiki 前 10 专门站 ${r.wikiSites.length} 个；来源：${r.from}${r.growth ? ` ×${r.growth}` : ''}`,
    `  - 建议买：**${r.buy}**（${Object.entries(r.domains).map(([d, v]) => `${d} ${v === 'available' ? '可买' : v === 'premium' ? '溢价' : v === 'taken' ? '被占' : '没查到'}`).join(' · ')}）`,
    ...(r.prior ? [`  - ⚠️ 判过：${r.prior}（今天数据又过了门槛，自己看一眼再买）`] : []),
    `  - Roblox：https://www.roblox.com/games/${r.placeId}`,
  ].join('\n');
};
const rejected = rows.filter((r) => !r.pick && !r.dup);
const md = [
  `# 今天能做的 codes 站 ${DATE}`,
  '',
  '> `game-name-radar/lib/codes-pick.mjs` 自动生成（免费接口：Roblox / Google 联想 / DuckDuckGo / Spaceship 查价，0 花费）。门槛见脚本头注释；SERP 没核到的不推荐。',
  '',
  `看了 ${rows.length} 个候选，查 SERP ${serpUsed} 个，**能做 ${picks.length} 个**。本月 SERP 用量：DDG ${usage.ddg} 次（免费）· Tavily ${usage.tavily}/${TAVILY_CAP} 次（免费档）。`,
  '',
  ...(picks.length ? ['## ✅ 能做', '', ...picks.map(line), ''] : ['今天没有过门槛的词。', '']),
  '## 没过的', '',
  ...rejected.map((r) => `- ${r.name ?? r.term}${r.playing ? `（${r.playing.toLocaleString('en-US')} 在线）` : ''}：${r.reject}`),
  '',
].join('\n');
mkdirSync(REPORTS, { recursive: true });
const reportFile = join(REPORTS, `PICK-${DATE}.md`);
writeFileSync(reportFile, md);
console.log(md);

for (const r of picks) state[r.universeId] = { name: r.name, firstPicked: state[r.universeId]?.firstPicked ?? DATE, lastPicked: DATE, buy: r.buy };
writeFileSync(STATE, `${JSON.stringify(state, null, 1)}\n`);

if (flag('--notify')) {
  const { notify } = await import(join(SHIP, 'scripts', 'notify.mjs'));
  const unchecked = rows.filter((r) => r.unchecked).length;
  if (picks.length) {
    await notify(
      `🎯 今天能做 ${picks.length} 个 codes 站，请买域名`,
      `${picks.map(line).join('\n\n')}\n\n买完回一声，当天建站。完整报告：reports/pick/PICK-${DATE}.md`,
    );
  } else {
    const top = rejected.filter((r) => r.playing).slice(0, 4).map((r) => `· ${r.name}：${r.reject}`).join('\n');
    await notify(
      '今天没有合适的 codes 站，不用买域名',
      `看了 ${rows.length} 个候选${unchecked ? `（${unchecked} 个没核到，明天再看）` : ''}。${top ? `\n${top}` : ''}\n完整报告：reports/pick/PICK-${DATE}.md`,
    );
  }
}
