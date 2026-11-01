#!/usr/bin/env node
/**
 * 新词待复查队列 + 稳涨冷门检查（2026-11-01 加）
 *
 * 复盘（10-26..11-01）：Nomad Drive / Urban Reload / Terrible Lizards / Bey Rivals / Become a Striker /
 * PAO PAO / Rip It 首见时热度低或还没发售，当天被弃，3–7 天后热度翻倍、专用站全被同行占了。
 * 改成：
 *  1. 入队：当天总报告「今天最值得看」里的 Steam / Roblox / 联想新词 / 可玩游戏 候选全部进
 *     data/fresh-recheck-queue.json（不丢）。
 *  2. 到期复查：有发售日 → 发售后 48 小时内（发售日 +2 天）；没有发售日 → 首见第 2 天。
 *     pytrends（免费，US 近 3 个月日度）近 3 天均值 ≥ 首见（首见前 2 天..首见日）均值 ×1.5
 *     且「专用站 ≤1」→ 当天推 GO。
 *  3. 稳涨冷门：连续 ≥3 周周环比 ≥+30%、近 4 周均值 ≥ 前 4 周 ×2、专用站 ≤1；
 *     大攻略站（Destructoid / Pro Game Guides / GameRant / dlehints 一类）是否进前 10 需人工核 SERP；
 *     H5 还必须有开源仓库（开源部署列里有许可证）或 data/embed-permissions.json 里登记的书面嵌入授权。
 *
 * 专用站判断：不用 SearchAPI / SerpAPI / treg（付费）。只做启发式 ——
 *   whoisds 新注册域名（out/nrd，≤ 检查日）里名字匹配的域名 + RDAP 查 <名>.wiki 等 EMD 域名的注册日期
 *   （首见前 60 天以内注册才算同行专用站，更早的当官方/老站不计）。真实 SERP 前 10 → 一律标「需人工核 SERP」。
 *
 * 用法：
 *   node lib/fresh-recheck.mjs [--date YYYY-MM-DD] [--notify]           # 每日（daily.sh 第 7b 步）
 *   node lib/fresh-recheck.mjs --replay 2026-10-26:2026-11-01 [--focus "a,b"]  # 回放（不写队列、不推送）
 */
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { matchDomains, nameVariants, NRD_DIR } from './nrd.mjs';

const RADAR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SHIP = path.resolve(RADAR, '..');
const REPORTS = path.join(SHIP, 'reports');
const OUT_DIR = path.join(SHIP, 'out', 'fresh-recheck');
const QUEUE_FILE = path.join(RADAR, 'data', 'fresh-recheck-queue.json');
const EMBED_FILE = path.join(RADAR, 'data', 'embed-permissions.json');
const PY_HELPER = path.join(RADAR, 'lib', 'pytrends-series.py');

export const RULES = {
  riseRatio: 1.5,          // 复查：近 3 天 / 首见 ≥1.5
  riseWindow: 4,           // 48h 首查没过 → 之后每天再查，到期日 +4 天为止（回放：PAO PAO / bay rivals 首查 ×1.29 / ×0.74，第 3–4 天才过）
  maxDedicated: 1,         // 专用站 ≤1
  steadyWeeks: 3,          // 连续 ≥3 周
  steadyWoW: 1.3,          // 周环比 ≥+30%
  steadyBlock: 2,          // 近 4 周均值 ≥ 前 4 周 ×2
  oldDomainDays: 60,       // 首见前 60 天以前注册的域名当官方/老站，不算同行专用站
  keepDays: 56,            // 入队 8 周后出队
  maxTrendsPerRun: Number(process.env.FRESH_MAX_TERMS || 120),
};
const BIG_GUIDE = 'Destructoid / Pro Game Guides / GameRant / dlehints';
const LICENSE_RE = /\b(MIT|Apache|BSD|GPL|LGPL|AGPL|MPL|CC0|CC[- ]BY(?:[- ]SA)?|Unlicense|ISC|zlib)\b/i;

// ─── 日期 ────────────────────────────────────────────────────────────────
const sh = () => new Date(Date.now() + 8 * 3600e3).toISOString().slice(0, 10);
const addDays = (d, n) => new Date(Date.parse(`${d}T00:00:00Z`) + n * 86400e3).toISOString().slice(0, 10);
const daysBetween = (a, b) => Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86400e3);
const readJson = (f, dflt) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return dflt; } };

// ─── 候选：当天总报告「今天最值得看」 ──────────────────────────────────────
const TYPE_KIND = [
  [/^Roblox/, 'roblox'], [/^Steam/, 'steam'], [/^联想新词/, 'roblox'], [/^可玩游戏/, 'h5'],
];
export function collectCandidates(date) {
  const file = path.join(REPORTS, 'summary', `RADAR-${date}.md`);
  if (!fs.existsSync(file)) return [];
  const text = fs.readFileSync(file, 'utf8');
  const sec = text.split(/^## 今天最值得看/m)[1]?.split(/^## /m)[0] || '';
  const licenses = h5Licenses(date);
  const out = [];
  for (const line of sec.split('\n')) {
    const m = line.match(/^- \*\*(.+?)\*\* (.+?)：(.*)$/);
    if (!m) continue;
    const [, type, name, rest] = m;
    const kind = TYPE_KIND.find(([re]) => re.test(type))?.[1];
    if (!kind) continue; // 梗等不进
    const rel = rest.match(/发售 (\d{4}-\d{2}-\d{2})/)?.[1] || null;
    const e = { name: name.trim(), type, kind, firstSeen: date, release: rel, prerelease: /Coming soon|即将|未发售|天后/.test(rest) };
    if (kind === 'h5') e.license = licenses[norm(name)] || null;
    out.push(e);
  }
  return out;
}

/** H5：可玩报告（含 EARLY）的「开源部署」列 → 许可证。 */
function h5Licenses(date) {
  const res = {};
  for (const f of [`RADAR-PLAYABLE-${date}.md`, `RADAR-PLAYABLE-EARLY-${date}.md`]) {
    const file = path.join(REPORTS, 'playable', f);
    if (!fs.existsSync(file)) continue;
    let col = -1;
    for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
      if (!line.startsWith('|')) { col = -1; continue; }
      const cells = line.split('|').slice(1, -1).map((c) => c.trim());
      if (cells.includes('开源部署')) { col = cells.indexOf('开源部署'); continue; }
      if (col < 0 || !cells[1]) continue;
      const lic = cells[col].match(LICENSE_RE)?.[1];
      if (lic) res[norm(cells[1].replace(/\[(.+?)\]\(.*?\)/, '$1'))] = `${lic}（${cells[col].slice(0, 80)}）`;
    }
  }
  return res;
}

const norm = (s) => String(s).toLowerCase().replace(/[™®©]/g, '').replace(/[^a-z0-9]+/g, ' ').trim();
/** Trends 查询词：去副标题；两词以内且很短（如 pao pao）加 game 防撞车。 */
export function trendsTerm(name) {
  let t = String(name).replace(/[™®©]/g, '').split(/ [-–—:] |: /)[0];
  t = norm(t);
  if (t.split(' ').length <= 2 && t.replace(/ /g, '').length < 8) t += ' game';
  return t;
}

// ─── Trends（pytrends，按天缓存） ─────────────────────────────────────────
const PYTHON = [process.env.PYTHON, '/opt/miniconda3/bin/python3', '/usr/local/bin/python3', '/opt/homebrew/bin/python3', 'python3']
  .find((p) => p && (p === 'python3' || fs.existsSync(p)));
export function fetchTrends(terms, today) {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const cacheFile = path.join(OUT_DIR, `trends-${today}.json`);
  const cache = readJson(cacheFile, {});
  const need = [...new Set(terms)].filter((t) => !cache[t] || cache[t].error).slice(0, RULES.maxTrendsPerRun);
  for (let i = 0; i < need.length; i += 20) {
    const batch = need.slice(i, i + 20);
    try {
      const raw = execFileSync(PYTHON, [PY_HELPER], { input: JSON.stringify({ terms: batch }), maxBuffer: 64e6, timeout: 30 * 60e3, stdio: ['pipe', 'pipe', 'inherit'] });
      Object.assign(cache, JSON.parse(String(raw)));
    } catch (e) {
      for (const t of batch) cache[t] = { error: `pytrends 调用失败：${String(e.message).slice(0, 120)}` };
    }
    fs.writeFileSync(cacheFile, JSON.stringify(cache));
  }
  return cache;
}
const upTo = (s, d) => (s?.dates || []).map((x, i) => [x, s.values[i]]).filter(([x]) => x <= d);
const mean = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0);

/** 规则 2：首见基线 vs 检查日近 3 天。 */
export function riseCheck(series, firstSeen, d) {
  const pts = upTo(series, d);
  if (!pts.length) return null;
  const base = mean(pts.filter(([x]) => x >= addDays(firstSeen, -2) && x <= firstSeen).map(([, v]) => v));
  const now = mean(pts.slice(-3).map(([, v]) => v));
  return { base: +base.toFixed(1), now: +now.toFixed(1), ratio: +(now / Math.max(base, 1)).toFixed(2), last: pts.at(-1)[0] };
}

/** 规则 3：周均值（截到 d，往回 7 天一桶，取 8 桶）。 */
export function steadyCheck(series, d) {
  const pts = upTo(series, d);
  if (pts.length < 56) return { ok: false, why: '数据不足 8 周' };
  const weeks = [];
  for (let w = 7; w >= 0; w--) weeks.push(mean(pts.slice(pts.length - 7 * (w + 1), pts.length - 7 * w).map(([, v]) => v)));
  let streak = 0;
  for (let i = weeks.length - 1; i > 0; i--) {
    if (weeks[i - 1] > 0 && weeks[i] >= weeks[i - 1] * RULES.steadyWoW) streak++; else break;
  }
  const last4 = mean(weeks.slice(4)), prior4 = mean(weeks.slice(0, 4));
  const block = last4 / Math.max(prior4, 0.5);
  return { ok: streak >= RULES.steadyWeeks && block >= RULES.steadyBlock, streak, block: +block.toFixed(2), weeks: weeks.map((w) => +w.toFixed(1)) };
}

// ─── 专用站启发式（NRD + RDAP，免费） ──────────────────────────────────────
const nrdCache = new Map();
function nrdList(date) {
  if (!nrdCache.has(date)) {
    const f = path.join(NRD_DIR, `${date}.txt.gz`);
    nrdCache.set(date, fs.existsSync(f) ? zlib.gunzipSync(fs.readFileSync(f)).toString('utf8').split('\n').filter(Boolean) : null);
  }
  return nrdCache.get(date);
}
const rdapCacheFile = path.join(OUT_DIR, 'rdap-cache.json');
let rdapCache = null;
async function rdap(domain) {
  rdapCache ??= readJson(rdapCacheFile, {});
  const c = rdapCache[domain];
  if (c && c.available !== null && daysBetween(c.checkedAt, sh()) < 7) return c;
  let r = { available: null };
  for (let i = 0; i < 2 && r.available === null; i++) {
    try {
      const res = await fetch(`https://rdap.org/domain/${domain}`, { redirect: 'follow', signal: AbortSignal.timeout(20_000) });
      if (res.status === 404) r = { available: true };
      else if (res.ok) {
        const j = await res.json().catch(() => ({}));
        r = { available: false, registered: (j.events || []).find((e) => e.eventAction === 'registration')?.eventDate?.slice(0, 10) || null };
      }
    } catch { /* 重试 */ }
  }
  rdapCache[domain] = { ...r, checkedAt: sh() };
  fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.writeFileSync(rdapCacheFile, JSON.stringify(rdapCache));
  return r;
}
function emdDomains(name) {
  const base = String(name).replace(/[™®©]/g, '').split(/ [-–—:] |: /)[0].toLowerCase().normalize('NFKD');
  const s = base.replace(/[^a-z0-9]+/g, '');
  const h = base.replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  if (s.length < 5) return [];
  return [...new Set([`${s}.wiki`, `${h}.wiki`, `${s}wiki.com`, `${s}guide.com`, `${s}codes.com`])];
}
/** 名字匹配到的域名里，只有「名字 (+攻略类后缀/前缀)」才算专用站：paopao-yingyuan.cn 这类撞名不算。 */
const SITE_WORDS = new Set(['', 's', 'wiki', 'wikis', 'guide', 'guides', 'code', 'codes', 'game', 'games', 'hub', 'tips', 'map', 'maps', 'tracker', 'calc', 'calculator', 'tierlist', 'db', 'database', 'info', 'online', 'play', 'unblocked', 'fan', 'fans', 'news', 'the', 'official', 'help', 'build', 'builds', 'stats', 'value', 'values', 'trading', 'gg', 'io', 'get', 'free']);
function isDedicated(domain, name) {
  const sld = domain.toLowerCase().split('.').slice(0, -1).join('').replace(/[^a-z0-9]/g, '');
  return nameVariants(name).some((v) => {
    const i = sld.indexOf(v);
    if (i < 0) return false;
    return SITE_WORDS.has(sld.slice(0, i)) && SITE_WORDS.has(sld.slice(i + v.length));
  });
}
/** 截至 d 的同行专用站（≤ d 注册、且不早于首见前 60 天）。 */
export async function dedicatedSites(name, firstSeen, d) {
  const found = new Map();
  const from = addDays(firstSeen, -RULES.oldDomainDays);
  for (const f of fs.existsSync(NRD_DIR) ? fs.readdirSync(NRD_DIR) : []) {
    const day = f.slice(0, 10);
    if (!f.endsWith('.txt.gz') || day > d || day < from) continue;
    for (const dom of matchDomains(nrdList(day) || [], name) || []) if (!found.has(dom) && isDedicated(dom, name)) found.set(dom, `NRD ${day}`);
  }
  for (const dom of emdDomains(name)) {
    if (found.has(dom)) continue;
    const r = await rdap(dom);
    if (r.available === false && r.registered && r.registered <= d && r.registered >= from) found.set(dom, `RDAP 注册 ${r.registered}`);
  }
  return [...found].map(([domain, how]) => ({ domain, how }));
}

// ─── 核心：某天跑一轮 ──────────────────────────────────────────────────────
function dueDate(e) {
  if (e.release && e.release >= addDays(e.firstSeen, -1)) return addDays(e.release, 2);   // 发售后 48h 内
  if (e.release && e.release < e.firstSeen) return addDays(e.firstSeen, 1);                // 早就发售了：次日
  return addDays(e.firstSeen, 2);                                                           // 没有发售日：首见第 2 天
}
function enqueue(queue, cands) {
  const added = [];
  for (const c of cands) {
    const key = norm(c.name);
    if (!key || queue[key]) continue;
    queue[key] = { ...c, term: trendsTerm(c.name), due: dueDate(c), status: 'pending', checks: [] };
    added.push(queue[key]);
  }
  return added;
}

/** 'rise'：到期日..到期日+riseWindow 每天查热度；'steady'：之后每 7 天查一次稳涨。 */
export function needsCheck(e, d) {
  if (e.status === 'expired' || e.due > d) return null;
  const k = daysBetween(e.due, d);
  if ((e.status === 'pending' || e.status === 'watch') && k <= RULES.riseWindow) return 'rise';
  if (k > RULES.riseWindow && k % 7 === 0) return 'steady';
  return null;
}

/** 返回这一天的事件（GO / 过闸但被占 / 未起 / 稳涨）。trends = {term: series}，截到 d 再用。 */
async function runDay(queue, d, trends, { embed }) {
  const ev = { go: [], taken: [], flat: [], steady: [], failed: [], expired: [] };
  for (const e of Object.values(queue)) {
    if (e.status === 'expired') continue;
    if (daysBetween(e.firstSeen, d) > RULES.keepDays) { e.status = 'expired'; ev.expired.push(e); continue; }
    const s = trends[e.term];
    const need = needsCheck(e, d);
    if (!need) continue;
    const isDue = need === 'rise';
    if (!s || s.error) { ev.failed.push({ e, why: s?.error || '没拉到 Trends（超出单次上限，次日重试）' }); continue; }
    const sites = await dedicatedSites(e.name, e.firstSeen, d);
    if (isDue) {
      const r = riseCheck(s, e.firstSeen, d);
      const rec = { date: d, day: daysBetween(e.due, d) + 1, ...r, sites: sites.map((x) => x.domain) };
      e.checks.push(rec);
      if (r && r.ratio >= RULES.riseRatio && sites.length <= RULES.maxDedicated) { e.status = 'go'; ev.go.push({ e, r, sites }); }
      else if (r && r.ratio >= RULES.riseRatio) { e.status = 'taken'; ev.taken.push({ e, r, sites }); }
      else { e.status = 'watch'; ev.flat.push({ e, r, sites, day: rec.day }); }
    }
    const st = steadyCheck(s, d);
    if (st.ok && sites.length <= RULES.maxDedicated) {
      const h5ok = e.kind !== 'h5' || e.license || embed[norm(e.name)];
      ev.steady.push({ e, st, sites, h5: e.kind === 'h5' ? (e.license || embed[norm(e.name)] || '缺开源仓库/书面嵌入授权 → 不推') : null, push: !!h5ok });
      e.steady = { date: d, ...st };
    }
  }
  return ev;
}

// ─── 报告 ─────────────────────────────────────────────────────────────────
const fmtSites = (s) => (s.length ? `${s.length} 个：${s.slice(0, 4).map((x) => `${x.domain}（${x.how}）`).join('、')}` : '0 个');
const fmtR = (r) => (r ? `首见 ${r.base} → ${r.now}（×${r.ratio}，数据到 ${r.last}）` : '无数据');
function dayLines(d, added, ev) {
  const L = [`### ${d}`, `- 入队 ${added.length} 个${added.length ? `：${added.map((e) => `${e.name}（${e.kind}，到期 ${e.due}）`).join('、')}` : ''}`];
  for (const { e, r, sites } of ev.go) L.push(`- 🟢 **GO** ${e.name}：${fmtR(r)} · 专用站 ${fmtSites(sites)} · ⚠️ 需人工核 SERP 前 10（是否已有带游戏名专用站 / ${BIG_GUIDE}）`);
  for (const { e, r, sites } of ev.taken) L.push(`- 🟡 **热度过闸但专用站已 ≥2** ${e.name}：${fmtR(r)} · 专用站 ${fmtSites(sites)} · 需人工核 SERP（新注册未必进前 10）`);
  for (const { e, st, sites, h5 } of ev.steady) L.push(`- 📈 **稳涨冷门** ${e.name}：连续 ${st.streak} 周 ≥+30%，近4周/前4周 ×${st.block}（周均 ${st.weeks.join(' → ')}） · 专用站 ${fmtSites(sites)} · 大攻略站需人工核 SERP${h5 ? ` · H5 授权：${h5}` : ''}`);
  if (ev.flat.length) L.push(`- ⚪ 复查未过 ×${RULES.riseRatio}（窗口第 n/${RULES.riseWindow + 1} 天，过窗转稳涨观察）：${ev.flat.map(({ e, r, day }) => `${e.name} ×${r?.ratio ?? '?'}（${day}）`).join('、')}`);
  if (ev.failed.length) L.push(`- ❗ Trends 失败（次日重试）：${ev.failed.map(({ e, why }) => `${e.name}（${why.slice(0, 40)}）`).join('、')}`);
  return L;
}
const HEADER = [
  '> 规则：Steam / Roblox / 联想新词 / H5 候选全部入队；有发售日 → 发售后 48h 内复查，没有 → 首见第 2 天复查。',
  `> GO = pytrends（US 日度）近 3 天均值 ≥ 首见 ×${RULES.riseRatio} 且专用站 ≤${RULES.maxDedicated}；稳涨冷门 = 连续 ≥3 周周环比 ≥+30% 且近 4 周 ≥ 前 4 周 ×2 且专用站 ≤1（H5 另需开源许可证或书面嵌入授权）。`,
  '> 专用站 = 免费启发式（whoisds 新注册域名 + RDAP 查 <名>.wiki 等 EMD 注册日期），**不是 SERP**：GO / 稳涨都要人工核 SERP 前 10 和大攻略站。未用 SearchAPI / SerpAPI / treg。',
  '',
];

// ─── 入口 ─────────────────────────────────────────────────────────────────
async function daily(date, doNotify) {
  const queue = readJson(QUEUE_FILE, {});
  const embed = readJson(EMBED_FILE, {});
  const added = enqueue(queue, collectCandidates(date));
  const active = Object.values(queue).filter((e) => needsCheck(e, date));
  active.sort((a, b) => (needsCheck(a, date) === 'rise' ? 0 : 1) - (needsCheck(b, date) === 'rise' ? 0 : 1) || b.due.localeCompare(a.due));
  const trends = fetchTrends(active.map((e) => e.term), sh());
  const ev = await runDay(queue, date, trends, { embed });
  fs.writeFileSync(QUEUE_FILE, `${JSON.stringify(queue, null, 1)}\n`);
  const pending = Object.values(queue).filter((e) => e.status === 'pending').length;
  const file = path.join(REPORTS, 'recheck', `RADAR-RECHECK-${date}.md`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, [`# 新词复查 + 稳涨冷门 ${date}`, '', ...HEADER, `队列：${Object.keys(queue).length} 个（待复查 ${pending}）`, '', ...dayLines(date, added, ev), ''].join('\n'));
  console.log(`[fresh-recheck] ${date} 入队 ${added.length} · 到期 ${active.length} · GO ${ev.go.length} · 过闸被占 ${ev.taken.length} · 稳涨 ${ev.steady.length} · 失败 ${ev.failed.length} → ${file}`);
  const pushes = [...ev.go.map(({ e, r }) => `🟢 GO ${e.name} ×${r.ratio}（需人工核 SERP）`),
    ...ev.steady.filter((x) => x.push).map(({ e, st }) => `📈 稳涨冷门 ${e.name} 近4周×${st.block}（需人工核 SERP/大攻略站）`)];
  if (doNotify && pushes.length) {
    const { notify } = await import('../../scripts/notify.mjs');
    await notify('新词复查 GO', pushes.join('\n')).catch((err) => console.error('[fresh-recheck] notify 失败', err.message));
  }
}

async function replay(from, to, focus) {
  const queue = {};
  const embed = readJson(EMBED_FILE, {});
  const days = [];
  for (let d = from; d <= to; d = addDays(d, 1)) days.push(d);
  const addedBy = {};
  for (const d of days) addedBy[d] = collectCandidates(d);
  // 先把整段要查的词一次拉完（今天拉的 3 个月序列，按回放日截断，不看未来）
  const tmp = {};
  for (const d of days) enqueue(tmp, addedBy[d]);
  const dueTerms = Object.values(tmp).filter((e) => e.due <= to).map((e) => e.term);
  const trends = fetchTrends(dueTerms, sh());
  const lines = [`# 新词复查回放 ${from} → ${to}`, '', ...HEADER, '> 回放：每天按当天总报告入队，到期日用「今天拉的 pytrends 序列截到那天」复查（不看未来），专用站只算那天之前注册的域名。', ''];
  const hit = {};
  for (const d of days) {
    const added = enqueue(queue, addedBy[d]);
    const ev = await runDay(queue, d, trends, { embed });
    lines.push(...dayLines(d, added, ev), '');
    for (const e of added) (hit[norm(e.name)] ??= {}).enq = { d, e };
    for (const k of ['go', 'taken', 'flat']) for (const x of ev[k]) {
      const h = (hit[norm(x.e.name)] ??= {});
      h.first ??= { d, k, ...x };
      h.chk = { d, k, ...x };
    }
    for (const x of ev.steady) (hit[norm(x.e.name)] ??= {}).steady = { d, ...x };
  }
  const label = { go: '🟢 GO', taken: '🟡 热度过闸但专用站已 ≥2（进人工复核）', flat: '⚪ 未过 ×1.5' };
  const focusLines = ['## 重点词（复盘漏掉的 7 个）', '', '| 词 | 入队（首见） | 来源 | 发售 | 首查日（规则） | 首查结果 | 最终结果（日期） | 专用站（截至该日） |', '|---|---|---|---|---|---|---|---|'];
  for (const f of focus) {
    const k = Object.keys(hit).find((x) => x === norm(f) || x.includes(norm(f)) || norm(f).includes(x));
    const h = hit[k];
    if (!h?.enq) { focusLines.push(`| ${f} | 未进总报告 | - | - | - | - | 没抓到：那几天总报告里没有这个词 | - |`); continue; }
    const { e } = h.enq;
    const c = h.chk;
    const rule = e.release ? '发售后 48h 复查' : '首见第 2 天复查';
    const fst = h.first;
    focusLines.push(`| ${f}（报告写作「${e.name}」） | ✅ ${h.enq.d} | ${e.type} | ${e.release || '无'} | ${e.due}（${rule}） | ${fst ? `${label[fst.k]}：${fmtR(fst.r)}` : '-'} | ${c ? `${label[c.k]}（${c.d}）：${fmtR(c.r)}` : `到期日 ${e.due} 晚于 ${to}，还在队列`} | ${c ? fmtSites(c.sites) : '-'} |`);
  }
  const file = path.join(REPORTS, 'recheck', `RADAR-RECHECK-REPLAY-${from}_${to}.md`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, [...lines.slice(0, HEADER.length + 3), ...focusLines, '', '## 逐日', '', ...lines.slice(HEADER.length + 3)].join('\n'));
  console.log(focusLines.join('\n'));
  console.log(`[fresh-recheck] 回放报告 → ${file}`);
}

const args = process.argv.slice(2);
const opt = (k) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : undefined; };
if (args.includes('--replay')) {
  const [from, to] = opt('--replay').split(':');
  const focus = (opt('--focus') || 'Nomad Drive,Urban Reload,Terrible Lizards,Bey Rivals|bay rivals,Become a Striker,PAO PAO,Rip It').split(',');
  await replay(from, to, focus.map((f) => f.split('|').at(-1)));
} else {
  await daily(opt('--date') || sh(), args.includes('--notify'));
}
