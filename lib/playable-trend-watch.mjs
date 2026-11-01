#!/usr/bin/env node
/**
 * playable-trend-watch.mjs — 可玩游戏起量监测 + 「梗 × 玩法」配对（2026-10-02 加）
 *
 * 为什么需要：雷达原有的 HTML5 源（poki-new / y8-new …）是「门户新上架」，上架 ≠ 有人搜，
 * 候选池里全是 Word Solitaire / Ball Sort 这类通用名。这里反过来：直接看**玩家正在搜什么可玩游戏**。
 * 10-02 手工跑出：PolyTrack 17×Monkey Mart ×5 增长（北欧/新西兰）、Capybara Clicker ×8.4（高 CPM 国家）、
 * noomiclone 新冒头但俄语区为主（低 CPM，且 9/26 已有人抢注 noomiclone.com）。
 *
 * 流程（全部零额度：Google Suggest + google-trends-api）：
 *   ① 发现：「poki / crazy games / unblocked」+ a-z 联想 + Trends 7 天上升相关词 → 去掉通用词
 *   ② 走势：Trends 15 个月周数据，锚定 monkey mart → 热度倍数 + 近 2 周增长 + 同比（去年同期，滤掉开学季老游戏）
 *   ③ 国家：起量的拉 interestByRegion → 前 5 国里几个是高 CPM（英语/西欧/北欧/日韩）
 *   ④ 风险：大厂 IP（halo/minecraft/pokemon …）标 ⚠️；查 .com 域名
 *   ⑤ 配对：梗雷达里已冒头的梗 × 正在涨的玩法词（clicker / escape / obby …）→ 联想有没有人做过 + 域名
 *
 * 判决：
 *   🟢 机会   增长 ≥ 2 且同比 ≥ 1.5 且热度 ≥ 0.3×MM 且前 5 国 ≥ 3 个高 CPM，非大厂 IP
 *   🟡 待复核 首日达标；Trends 小词抽样波动大，次日复查仍达标才升 🟢
 *   🟡 季节性 在涨但去年同期也这样（ragdoll hit 同比 ×0.7）
 *   🟡 过峰   峰值在半年前、现在不到一半（escape from school：去年 10 月上线冲过峰）
 *   🟡 观察   在涨但量小 / 国家混合
 *   ❌ 放弃   主要国家低 CPM / 大厂 IP
 *
 * 用法：
 *   node lib/playable-trend-watch.mjs                      # 跑一轮，写 ../reports/playable/RADAR-PLAYABLE-<日期>.md
 *   node lib/playable-trend-watch.mjs "polytrack" "capybara clicker"   # 只查这几个（不写状态）
 *   node lib/playable-trend-watch.mjs --early              # 只跑早期每日（All the Dles / itch / Newgrounds），不扫门户联想
 *
 * 早期每日见 lib/playable-early-watch.mjs：不靠门户联想，Trends 弱也进报告，但只标 early / social，不升 🟢。
 * 变现路径写三条：可试 iframe / 内容漏斗 / 开源自托管。
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { reportPath } from '../../scripts/lib/reports.mjs';
import { BIG_IP, renderEarlyReport, renderEarlySection, runEarlyPlayableWatch } from './playable-early-watch.mjs';

const require = createRequire(import.meta.url);
// 2026-10-08：google-trends-api 不带 Cookie，天天被 302 到 /sorry；换成带 Cookie 的同接口替身
import googleTrends from './google-trends.mjs';
import { steadyRising } from './trend-verifier.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const statePath = path.join(root, 'data', 'playable-watch-state.json');
const memeStatePath = path.join(root, 'data', 'meme-watch-state.json');
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/131.0 Safari/537.36';
const ANCHOR = 'monkey mart';
const NEW_LIMIT = Number(process.env.PLAYABLE_NEW_LIMIT ?? 40);
const RECHECK_LIMIT = Number(process.env.PLAYABLE_RECHECK_LIMIT ?? 20);
const REGION_LIMIT = 10;

// 'poki ' 会联想到 poke bowl（ingredients / dex / near me），用 'poki games '
const SUGGEST_SEEDS = ['poki games ', 'crazy games ', 'unblocked '];
const RISING_SEEDS = ['poki', 'crazy games', 'unblocked games', 'online game', 'browser game'];
const HIGH_CPM = new Set(['United States', 'United Kingdom', 'Canada', 'Australia', 'New Zealand', 'Ireland', 'Germany', 'France', 'Spain', 'Italy', 'Netherlands', 'Belgium', 'Switzerland', 'Austria', 'Sweden', 'Norway', 'Denmark', 'Finland', 'Iceland', 'Japan', 'South Korea', 'Singapore', 'Luxembourg']);
const MICRO = /^(Bermuda|Cayman Islands|Gibraltar|Isle of Man|Jersey|Guernsey|Monaco|Liechtenstein|Andorra|San Marino|Faroe Islands|Greenland|Guam|Puerto Rico|U\.S\. Virgin Islands|British Virgin Islands|Bahamas|Barbados|Aruba|Curaçao|Malta|Maldives|Brunei|Macao|Northern Mariana Islands|American Samoa|Saint .*|St\. .*)$/;
// 大厂 IP 名单在 playable-early-watch.mjs（门户判决和早期路径共用，含宝可梦变体）
// 玩法词：从起量游戏名里抽出来做「梗 × 玩法」配对
const MECHANICS = ['clicker', 'escape', 'obby', 'merge', 'run', 'simulator', 'tycoon', 'hide and seek', 'ragdoll', 'drift', 'racing', 'io', 'tag', 'jump', 'idle'];

// 通用词：去掉这些后什么都不剩 = 不是具体游戏名
const GENERIC = /\b(games?|app|apps|login|account|download|free|online|offline|website|websites|site|sites|url|link|links|meaning|near me|for (?:kids|girls|boys|school|free)|kids|girls|boys|unblocked|unblocker|poki|crazy|com|no ads|update|youtube|reddit|videos?|proxy|proxies|vpn|browser|chromebook|school|ai|play|player|2 players?|two players?|multiplayer|developer|portal|install|not working|not loading|reviews?|age rating|search|new|best|top|list|\d{4}|\d)\b/gi;
const NON_GAME = /(near me|food|instagram|facebook|snapchat|twitter|tiktok|discord|whatsapp|messenger|netflix|disney plus|tubi|spotify|chatgpt|omegle|ometv|umingle|quizlet|wikipedia|synonym|definition|news|articles|radio|music|movie|song|qr code|net worth|login|calculator|tester|quran|labor|idaho|japan|korea|hawaii|juegos|jogos|jeux|in english|easter eggs|ingredients|ice cream|kong$|dex$)/i;

let DICT = new Set();
try { DICT = new Set((await fs.readFile('/usr/share/dict/words', 'utf8')).toLowerCase().split('\n')); } catch {}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function autocomplete(query) {
  try {
    const res = await fetch(`https://suggestqueries.google.com/complete/search?client=firefox&hl=en&gl=us&q=${encodeURIComponent(query)}`, { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(12_000) });
    const d = JSON.parse(await res.text());
    return Array.isArray(d?.[1]) ? d[1] : [];
  } catch {
    return [];
  }
}

export function cleanGameQuery(q = '') {
  const name = q.toLowerCase().replace(/\s+/g, ' ').trim();
  if (name.length < 3 || name.length > 30 || NON_GAME.test(name)) return '';
  const rest = name.replace(GENERIC, ' ').replace(/\s+/g, ' ').trim();
  if (!rest.replace(/[^a-z]/g, '')) return '';
  // 去掉通用词后只剩单个字典词（chess / uno 2 players / pool）= 品类不是游戏名；polytrack / sprunki 不在字典里
  if (!rest.includes(' ') && DICT.has(rest.replace(/\.io$/, ''))) return '';
  return name;
}

async function discoverNames() {
  const found = new Map();
  for (const seed of SUGGEST_SEEDS) {
    for (const ch of 'abcdefghijklmnopqrstuvwxyz') {
      for (const s of await autocomplete(seed + ch)) {
        if (!s.startsWith(seed)) continue;
        const name = cleanGameQuery(s.slice(seed.length));
        if (name && !found.has(name)) found.set(name, `suggest:${seed.trim()}`);
      }
      await sleep(150);
    }
  }
  const errors = [];
  for (const seed of RISING_SEEDS) {
    try {
      const raw = await trendsCall(() => googleTrends.relatedQueries({ keyword: seed, startTime: new Date(Date.now() - 7 * 864e5), geo: 'US', hl: 'en-US' }));
      const lists = JSON.parse(raw)?.default?.rankedList || [];
      for (const item of lists[1]?.rankedKeyword || []) {
        const name = cleanGameQuery(String(item.query || '').replace(new RegExp(`\\b${seed}\\b`, 'i'), ''));
        if (name) found.set(name, `rising:${seed} ${item.formattedValue || ''}`.trim());
      }
    } catch (error) {
      errors.push(`rising ${seed}: ${error.message.slice(0, 50)}`);
    }
    await sleep(2500);
  }
  return { found, errors };
}

async function trendsCall(fn) {
  for (let t = 0; t < 3; t++) {
    try { return await fn(); } catch (error) { if (t === 2) throw error; await sleep(15000 * (t + 1)); }
  }
}

// 15 个月周数据（调用次数和 90 天日数据一样）：
//   增长 = 近 2 周 ÷ 5-12 周前；同比 = 近 2 周 ÷ 去年同 2 周
// 同比是关键：9 月一大批游戏同时「×3」是开学季（美国学生 Chromebook），drift boss 2014 年就有
export async function trajectory(names) {
  const out = {};
  for (let i = 0; i < names.length; i += 4) {
    const batch = names.slice(i, i + 4);
    try {
      const raw = await trendsCall(() => googleTrends.interestOverTime({ keyword: [ANCHOR, ...batch], startTime: new Date(Date.now() - 400 * 864e5), geo: 'US' }));
      const tl = JSON.parse(raw).default.timelineData.filter((p) => !p.isPartial);
      const n = tl.length;
      const avg = (k, from, to) => { const s = tl.slice(Math.max(0, from), Math.max(0, to)).map((p) => p.value[k]); return s.reduce((a, b) => a + b, 0) / Math.max(1, s.length); };
      const anchor = avg(0, n - 13, n) || 1;
      batch.forEach((name, j) => {
        const k = j + 1;
        const recent = avg(k, n - 2, n);
        const prior = avg(k, n - 12, n - 4);
        const lastYear = avg(k, n - 54, n - 52);
        const peak = tl.reduce((b, p, ix) => (p.value[k] > tl[b].value[k] ? ix : b), 0);
        const peakValue = tl[peak].value[k];
        out[name] = {
          peakAgoWeeks: n - 1 - peak,
          ofPeak: peakValue ? +(recent / peakValue).toFixed(2) : 0,
          scale: +(recent / anchor).toFixed(2),
          growth: prior ? +(recent / prior).toFixed(1) : recent ? 99 : 0,
          yoy: lastYear ? +(recent / lastYear).toFixed(1) : recent ? 99 : 0,
          steady: steadyRising(tl.map((p) => p.value[k])),
          peak: tl[peak].formattedTime,
        };
      });
    } catch (error) {
      batch.forEach((name) => { out[name] = { error: error.message.slice(0, 50) }; });
    }
    await sleep(4000);
  }
  return out;
}

async function topCountries(name) {
  try {
    // 90 天 + 去掉微型地区：Trends 按人口比例算，小词在 Bermuda 这种地方会冲到第一（capybara clicker 30 天只剩 Bermuda）
    const raw = await trendsCall(() => googleTrends.interestByRegion({ keyword: name, startTime: new Date(Date.now() - 90 * 864e5), resolution: 'COUNTRY' }));
    return JSON.parse(raw).default.geoMapData.filter((x) => x.value[0] > 0 && !MICRO.test(x.geoName)).slice(0, 5).map((x) => x.geoName);
  } catch {
    return null;
  }
}

async function domainStatus(domain) {
  try {
    const res = await fetch(`https://rdap.org/domain/${domain}`, { redirect: 'follow', headers: { 'User-Agent': UA, Accept: 'application/rdap+json' }, signal: AbortSignal.timeout(15_000) });
    if (res.status === 404) return 'free';
    if (!res.ok) return '?';
    const d = await res.json();
    const reg = (d.events || []).find((e) => e.eventAction === 'registration')?.eventDate?.slice(0, 10);
    return reg ? `taken ${reg}` : 'taken';
  } catch {
    return '?';
  }
}

const slug = (name) => name.toLowerCase().replace(/[^a-z0-9]+/g, '');

export function judge(t, countries, name) {
  if (BIG_IP.test(name)) return 'skip-ip';
  if (!t || t.error) return 'error';
  const rising = t.growth >= 2;
  if (!rising) return 'flat';
  if (t.yoy < 1.5) return 'seasonal';
  // 峰值在半年前、现在不到峰值一半 = 上线时冲过一波，现在只是回暖（escape from school：去年 10 月上线，同比 99 是因为去年同期还没上线）
  if (t.peakAgoWeeks > 26 && t.ofPeak < 0.5) return 'past-peak';
  // 不足 3 国 = 量太小 Trends 给不出分布，当数据不足（观察），不误杀成低 CPM
  if (countries && countries.length >= 3) {
    const high = countries.filter((c) => HIGH_CPM.has(c)).length;
    if (!HIGH_CPM.has(countries[0]) && high < 2) return 'skip-cpm';
    if (t.scale >= 0.3 && high >= 3) return 'go';
  }
  return 'watch';
}

const PUSH_SCRIPT = new URL('../../scripts/notify.mjs', import.meta.url).pathname;

function notify(title, body) {
  // 先推飞书（Ship/scripts/notify.mjs，2026-10-11 加：用户不在电脑前会漏 macOS 通知）；推不出去再走下面的 macOS 通知。
  try {
    execFileSync(process.execPath, [PUSH_SCRIPT, '--title', String(title), '--body', String(body)], { stdio: 'ignore', timeout: 30000 });
    return;
  } catch {}
  const esc = (s) => String(s).replace(/["\\]/g, '\\$&');
  try { execFileSync('osascript', ['-e', `display notification "${esc(body)}" with title "${esc(title)}" sound name "Glass"`]); } catch {}
}

async function readJson(file, fallback) {
  try { return JSON.parse(await fs.readFile(file, 'utf8')); } catch { return fallback; }
}

// 梗 × 玩法：梗雷达近 14 天冒头/持续的梗，配上今天起量游戏里出现的玩法词
async function pairMemes(rows) {
  const meme = await readJson(memeStatePath, { names: {} });
  // 只配 KYM / 手动名单的梗：trends 来源多是新闻 / 老 IP（formula 1、friday the 13th 配出来全是垃圾，10-04）；
  // wiki-xx（维基热门，10-12 加）同理，多是剧集 / 人物
  const memes = Object.values(meme.names).filter((e) => e.alertedAt && Date.now() - Date.parse(e.alertedAt) < 14 * 864e5 && slug(e.name) && !/^(trends|wiki)-/.test(e.source)).map((e) => e.name);
  const hot = rows.filter((r) => ['go', 'pending-go', 'watch', 'seasonal', 'past-peak'].includes(r.verdict));
  const mechanics = MECHANICS.filter((m) => hot.some((r) => new RegExp(`\\b${m}\\b`).test(r.name)));
  if (!mechanics.length) mechanics.push('clicker', 'escape', 'obby'); // 没抽到就用 10-02 验证过的品类兜底
  const pairs = [];
  for (const m of memes.slice(0, 8)) {
    for (const mech of mechanics.slice(0, 4)) {
      const q = `${m.toLowerCase()} ${mech}`;
      const sugg = (await autocomplete(q)).filter((s) => s.toLowerCase().startsWith(q));
      const domain = `play${slug(m)}${slug(mech)}.com`;
      pairs.push({ meme: m, mechanic: mech, query: q, taken: sugg.length > 0, sample: sugg.slice(0, 3), domain, domainStatus: await domainStatus(domain) });
      await sleep(300);
    }
  }
  return { pairs, mechanics };
}

export async function runPlayableWatch({ notifyOnAlert = true } = {}) {
  const now = new Date().toISOString();
  const today = now.slice(0, 10);
  const state = await readJson(statePath, { names: {} });
  const firstRun = !state.lastRun;

  const { found, errors } = await discoverNames();
  // 进 Trends 前用联想确认是游戏（「<名字> game / unblocked / crazy games / online」至少一条）；大厂 IP 直接不查
  const fresh = [];
  for (const n of [...found.keys()].filter((x) => !state.names[x] && !BIG_IP.test(x))) {
    const sugg = await autocomplete(`${n} `);
    if (sugg.some((x) => /\b(game|games|unblocked|crazy games|poki|online|play|io|2|3)\b/.test(x.slice(n.length)))) fresh.push(n);
    await sleep(150);
  }
  for (const n of fresh) state.names[n] = { firstSeen: now, source: found.get(n), history: [] };

  // 每天：新名字（rising 来源优先）+ 之前在涨的复查；Trends 有频控，不全量
  const newQueue = fresh.sort((a, b) => Number(found.get(b).startsWith('rising')) - Number(found.get(a).startsWith('rising'))).slice(0, NEW_LIMIT);
  // 复查：没查过 / 上次失败的优先（Trends 限流时补查），其次在涨的
  const recheck = Object.entries(state.names).filter(([n, e]) => !newQueue.includes(n) && (!e.verdict || ['error', 'go', 'pending-go', 'watch', 'seasonal', 'past-peak'].includes(e.verdict)))
    .sort((a, b) => Number(b[1].verdict === 'pending-go') - Number(a[1].verdict === 'pending-go') || Number(['go', 'watch', 'seasonal'].includes(a[1].verdict)) - Number(['go', 'watch', 'seasonal'].includes(b[1].verdict)) || Date.parse(a[1].lastChecked || 0) - Date.parse(b[1].lastChecked || 0)).slice(0, RECHECK_LIMIT).map(([n]) => n);
  const queue = [...newQueue, ...recheck];
  const traj = await trajectory(queue);

  const rows = [];
  let regionCalls = 0;
  for (const name of queue) {
    const e = state.names[name];
    const t = traj[name];
    let countries = e.countries || null;
    if (t && !t.error && t.growth >= 2 && !BIG_IP.test(name) && regionCalls < REGION_LIMIT) {
      countries = await topCountries(name);
      regionCalls += 1;
      await sleep(2500);
    }
    const prevVerdict = e.verdict;
    let verdict = judge(t, countries, name);
    // 小词的 Trends 是抽样估算，同一个词两次查询能差一倍（escape from school 10-03：×2 → ×1.2）
    // → 🟢 要连续两天达标：第一天只标待复核，次日复查仍达标才升 🟢 + 通知
    const prevDay = (e.history || []).filter((h) => h.date !== today).at(-1);
    if (verdict === 'go' && !(prevDay && prevDay.growth >= 2 && prevVerdict !== 'error')) verdict = 'pending-go';
    Object.assign(e, { lastChecked: now, countries, verdict, trend: t });
    if (t && !t.error) e.history = [...(e.history || []).filter((h) => h.date !== today), { date: today, scale: t.scale, growth: t.growth }].slice(-30);
    if (['go', 'pending-go'].includes(verdict) && !e.domains) {
      e.domains = {};
      for (const d of [`${slug(name)}.com`, `play${slug(name)}.com`, `${slug(name)}game.com`]) e.domains[d] = await domainStatus(d);
    }
    rows.push({ name, ...e, isNewGo: verdict === 'go' && prevVerdict !== 'go' });
  }

  // 清理：60 天没在涨过的丢掉，防止状态无限长
  for (const [n, e] of Object.entries(state.names)) {
    if (['flat', 'skip-cpm', 'skip-ip'].includes(e.verdict) && Date.now() - Date.parse(e.firstSeen) > 60 * 864e5) delete state.names[n];
  }

  const { pairs, mechanics } = await pairMemes(rows);
  state.lastRun = now;
  await fs.writeFile(statePath, JSON.stringify(state, null, 2) + '\n');

  const alerts = rows.filter((r) => r.isNewGo);
  const openPairs = pairs.filter((p) => !p.taken && p.domainStatus === 'free');
  if (notifyOnAlert && !firstRun && (alerts.length || openPairs.length)) {
    notify('📈 趋势更新', `${[...alerts.map((r) => r.name), ...openPairs.slice(0, 2).map((p) => p.query)].join(' / ')} → RADAR-PLAYABLE-${today}.md`);
  }
  let early = { rows: [], errors: [], discovered: 0, probed: 0 };
  if (process.env.PLAYABLE_EARLY !== '0') {
    try { early = await runEarlyPlayableWatch(); }
    catch (error) { early = { rows: [], errors: [error.message.slice(0, 120)], discovered: 0, probed: 0 }; }
  }
  const report = renderReport({ rows, pairs, mechanics, date: today, discovered: found.size, fresh: fresh.length, errors, firstRun, early });
  await fs.writeFile(reportPath(`RADAR-PLAYABLE-${today}.md`), report);
  try { await fs.writeFile(reportPath(`RADAR-PLAYABLE-EARLY-${today}.md`), renderEarlyReport(early, today)); } catch { /* 主报告已经落盘 */ }
  return { rows, alerts, pairs, openPairs, errors, discovered: found.size, firstRun, early };
}

const LABEL = { go: '🟢 机会', watch: '🟡 观察', 'pending-go': '🟡 待复核', seasonal: '🟡 季节性', 'past-peak': '🟡 过峰', 'skip-cpm': '❌ 低CPM', 'skip-ip': '❌ 大厂IP', flat: '⚪ 平', error: '⚠️ 失败' };

function renderReport({ rows, pairs, mechanics, date, discovered, fresh, errors, firstRun, early = null }) {
  const order = ['go', 'pending-go', 'watch', 'seasonal', 'past-peak', 'skip-cpm', 'skip-ip', 'error', 'flat'];
  const sorted = [...rows].sort((a, b) => order.indexOf(a.verdict) - order.indexOf(b.verdict) || (b.trend?.scale || 0) - (a.trend?.scale || 0));
  const lines = [
    `# 可玩游戏雷达 ${date}`,
    '',
    `来源：poki / crazy games / unblocked 联想 a-z + Trends 7 天上升 → 今天发现 ${discovered} 个游戏名（新 ${fresh}），查走势 ${rows.length} 个。`,
    '热度 = 近 2 周 Trends ÷ Monkey Mart 近 3 月（相对值，不是搜索量）；增长 = 近 2 周 ÷ 5-12 周前；同比 = 近 2 周 ÷ 去年同期（99 = 去年没有）。',
    '🟢 = 增长 ≥2 + 同比 ≥1.5 + 热度 ≥0.3 + 前 5 国 ≥3 个高 CPM，且**连续两天**达标（Trends 小词抽样波动大，首日只标 🟡 待复核）。这条 Monkey Mart 门槛只用于下面的门户联想词。',
    '早期每日（All the Dles / itch / Newgrounds）另起一节，Trends 还没成型也列出，但只标 early / social，不升 🟢。',
    firstRun ? '\n> ⚠️ 首次运行 = 建基线，不弹通知。\n' : '',
    errors.length ? `> 信源失败：${errors.join('；')}\n` : '',
  ];
  const shown = sorted.filter((r) => !['flat', 'error'].includes(r.verdict));
  const failed = sorted.filter((r) => r.verdict === 'error');
  if (failed.length) lines.push(`> Trends 查询失败 ${failed.length} 个（限流），明天优先补查：${failed.map((r) => r.name).join(' · ')}`, '');
  if (shown.length) {
    lines.push('| 判决 | 游戏 | 热度 | 增长 | 同比 | 峰值 | 前 5 国 | 首见 | 域名 |', '|---|---|---|---|---|---|---|---|---|');
    for (const r of shown) {
      const t = r.trend || {};
      const domains = Object.entries(r.domains || {}).map(([d, s]) => `${d} ${s === 'free' ? '✅' : s}`).join('<br>');
      lines.push(`| ${LABEL[r.verdict]}${r.isNewGo ? ' 🆕' : ''} | ${r.name} | ${t.scale ?? '-'}× | ×${t.growth ?? '-'} | ×${t.yoy ?? '-'} | ${t.peak ?? '-'} | ${(r.countries || []).join(', ') || '-'} | ${r.firstSeen.slice(0, 10)} | ${domains || '-'} |`);
    }
    lines.push('');
  }
  const flat = sorted.filter((r) => r.verdict === 'flat');
  if (flat.length) lines.push(`<details><summary>⚪ 没在涨 ${flat.length} 个</summary>`, '', flat.map((r) => `${r.name}（${r.trend?.scale}×）`).join(' · '), '', '</details>', '');

  if (early) lines.push(renderEarlySection(early).trim(), '');
  lines.push('## 梗 × 玩法配对', '');
  if (!pairs.length) lines.push('梗雷达近 14 天没有冒头的梗（或梗名没有英文名），今天无配对。', '');
  else {
    lines.push(`玩法词（从今天起量的游戏里抽）：${mechanics.join(' / ')}`, '', '| 组合 | 联想里已有人做？ | 域名 |', '|---|---|---|');
    for (const p of pairs.sort((a, b) => Number(a.taken) - Number(b.taken))) {
      lines.push(`| ${p.query} | ${p.taken ? `已有：${p.sample.join(' · ')}` : '✅ 空白'} | ${p.domain} ${p.domainStatus === 'free' ? '✅可注册' : p.domainStatus} |`);
    }
    lines.push('', '> 「已有」= 联想里有人在搜这个组合，说明需求被验证但有先行者；「空白」+ 可注册 = 抢先位，但也可能是没需求，上线前用梗雷达看梗本身的热度。', '');
  }
  lines.push('下一步（🟢 项）：①看 Poki/CrazyGames 是否就是原版（原版在门户排第一，嵌入站很难超）②想清楚是嵌入授权版还是自研同类玩法 ③`node scripts/spaceship.mjs check <域名>`');
  return lines.join('\n') + '\n';
}

const IS_MAIN = import.meta.url === `file://${process.argv[1]}` || Boolean(process.argv[1]?.endsWith('playable-trend-watch.mjs'));

if (IS_MAIN) {
  const names = process.argv.slice(2).filter((a) => !a.startsWith('--'));
  if (process.argv.includes('--early')) {
    const early = await runEarlyPlayableWatch();
    const today = new Date().toISOString().slice(0, 10);
    await fs.writeFile(reportPath(`RADAR-PLAYABLE-EARLY-${today}.md`), renderEarlyReport(early, today));
    const deployable = early.rows.filter((r) => r.paths?.oss?.deployable).length;
    console.log(`早期每日：目录 ${early.discovered}，探测 ${early.probed}，行 ${early.rows.length}，可部署开源 ${deployable}${early.errors.length ? `；缺口 ${early.errors.join('；')}` : ''}`);
  } else if (names.length) {
    const traj = await trajectory(names);
    for (const n of names) {
      const t = traj[n];
      const countries = t && !t.error && t.growth >= 2 ? await topCountries(n) : null;
      console.log(`${LABEL[judge(t, countries, n)]} ${n}：热度 ${t?.scale ?? '-'}× · 增长 ×${t?.growth ?? '-'} · 同比 ×${t?.yoy ?? '-'} · 峰值 ${t?.peak ?? '-'}${countries ? ` · ${countries.join(', ')}` : ''}${t?.error ? ` · ${t.error}` : ''}`);
    }
  } else {
    const r = await runPlayableWatch();
    const earlyN = r.early?.rows?.length ?? 0;
    console.log(`可玩游戏雷达：发现 ${r.discovered} 个，查 ${r.rows.length} 个，🟢 新增 ${r.alerts.length}${r.firstRun ? '（首次建基线）' : ''}；早期每日 ${earlyN}；梗×玩法 ${r.pairs.length} 组（空白可注册 ${r.openPairs.length}）${r.errors.length ? `；失败 ${r.errors.join('；')}` : ''}`);
  }
}
