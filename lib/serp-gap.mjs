#!/usr/bin/env node
/**
 * serp-gap.mjs — 结果页有没有「答好」：本地语言空位 + 内容过时（2026-10-20 加）
 *
 * 为什么需要：以前看 SERP 只数「谁占着」（codes 媒体几家、论坛帖几条），不看「答没答好」。
 * 两种空位数不出来：
 *   🌐 语言空位：德 / 法 / 西 / 意 / 日 / 韩用户在搜（本地语言联想有补全），但前 10 几乎全是英文页
 *      ——我们的目标市场是这些高 CPM 国家（memory target-markets-high-cpm），这本身就是能抢的位置
 *   🕰️ 内容过时：游戏刚更新过，前 10 的页面日期大多还在更新之前
 * 起因：用户转来的选词文章（「SERP 缺口五类」），对照我们的雷达只缺这两类。
 *
 * 做法（每个游戏约 7 次 treg SERP ≈ $0.001，联想免费，缓存 3 天 data/serp-gap-cache.json）：
 *   - 美国英文「<游戏> codes / guide」1 次：数前 10 里日期早于游戏最近更新的页面
 *   - 6 个市场各 1 次本地语言查询（Roblox 查码、Steam 查攻略）：数前 10 里有几条是本地语言页
 *   - 6 个市场各查 Google 联想（hl/gl = 本地）：含游戏名、带本地语言词的补全 = 有本地需求
 * 判定：
 *   🌐 = 有本地需求 且 本地语言页（不算视频）≤ 2 条
 *   🕰️ = 有日期的页面（不算视频）≥ 3 条，其中 ≥ 60% 早于游戏最近更新（拿不到更新日就不判：已发售的 Steam 攻略\n *      本来就是几个月前写的，按「60 天前」算会把 Silksong 这种全判成过时）
 * ⚠️ treg 便宜路由单次结果会抖（codes-media.mjs 10-14 的教训），这是「值得人去看一眼」的提示，不是判决。
 *
 * 用法：node lib/serp-gap.mjs roblox "Grow a Garden" · node lib/serp-gap.mjs steam "Hollow Knight Silksong"
 */
import { execFile } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { normName } from './tool-demand.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const CACHE_FILE = join(HERE, '..', 'data', 'serp-gap-cache.json');
const TREG_CALL = join(HERE, '..', '..', 'scripts', 'treg', 'call.py');
const TTL = 3 * 86400_000;
const DAY = 86400_000;

// 查询词：Roblox 主意图是码，Steam 是攻略。demand = 判「本地人在搜」用的本地语言词（英文里不会出现的）
export const MARKETS = [
  { cc: 'de', lang: 'de', roblox: 'codes', steam: 'tipps', demand: /\b(tipps|deutsch|anleitung|lösung|komplettlösung)\b/i },
  { cc: 'fr', lang: 'fr', roblox: 'codes', steam: 'guide', demand: /\b(astuces?|soluce|français|francais|meilleur)\b/i },
  { cc: 'es', lang: 'es', roblox: 'códigos', steam: 'guía', demand: /\b(c[oó]digos?|gu[ií]a|trucos|español|mejor)\b/i },
  { cc: 'it', lang: 'it', roblox: 'codici', steam: 'guida', demand: /\b(codici|guida|trucchi|italiano|migliori?)\b/i },
  { cc: 'jp', lang: 'ja', roblox: 'コード', steam: '攻略', demand: /[぀-ヿ一-鿿]/ },
  { cc: 'kr', lang: 'ko', roblox: '코드', steam: '공략', demand: /[가-힯]/ },
];
const US_INTENT = { roblox: 'codes', steam: 'guide' };

const VIDEO = /(^|\.)(youtube\.com|youtu\.be|tiktok\.com|twitch\.tv|bilibili\.com|nicovideo\.jp)$/;

// 标题 + 摘要是不是本地语言：日韩看文字，欧洲语言看常用虚词数（比英文虚词多就算），网址里 /de/ 或 .de 也算
const STOP = {
  en: ['the', 'and', 'to', 'of', 'in', 'for', 'is', 'how', 'with', 'you', 'all', 'your', 'best', 'get'],
  de: ['der', 'die', 'das', 'und', 'ist', 'mit', 'für', 'alle', 'wie', 'ein', 'eine', 'nicht', 'auf', 'den', 'dem', 'zu', 'im', 'sind', 'aktuelle', 'neue'],
  fr: ['le', 'la', 'les', 'des', 'et', 'est', 'pour', 'avec', 'dans', 'une', 'du', 'tous', 'comment', 'sur', 'nouveaux', 'pas'],
  es: ['el', 'los', 'las', 'del', 'y', 'es', 'para', 'con', 'una', 'todos', 'cómo', 'como', 'en', 'nuevos', 'por'],
  it: ['il', 'lo', 'gli', 'della', 'del', 'e', 'è', 'per', 'con', 'una', 'tutti', 'come', 'nuovi', 'dei', 'di'],
};
export function isNative(result, m) {
  const text = `${result.title ?? ''} ${result.snippet ?? ''}`;
  if (m.lang === 'ja') return /[぀-ヿ]/.test(text);
  if (m.lang === 'ko') return /[가-힯]/.test(text);
  const url = String(result.url ?? '');
  if (new RegExp(`(/${m.lang}(-[a-z]{2})?/|\\.${m.cc}/|//${m.lang}\\.)`, 'i').test(url)) return true;
  const words = text.toLowerCase().match(/[\p{L}]+/gu) ?? [];
  const count = (list) => words.filter((w) => list.includes(w)).length;
  const local = count(STOP[m.lang]);
  return local >= 2 && local > count(STOP.en);
}

/**
 * 结果的日期 → 时间戳；拿不到返回 null。treg 按查询语言给本地格式：
 * 「13.07.2025」「Jul 13, 2025」「2025/07/13」「2025年7月13日」「2025. 7. 13.」「vor 1 Jahr」「3 days ago」「3日前」「3일 전」…
 */
const MONTHS = { jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11 };
const UNIT = [
  [/(year|jahr|\bans?\b|année|annee|año|\bano\b|\bann[oi]\b|年|년)/i, 365],
  [/(month|monat|mois|mes|mes[ei]|月|개월|달)/i, 30],
  [/(week|woche|semaine|semana|settiman|週|주)/i, 7],
  [/(day|tag|jour|día|dia|giorn|日|일)/i, 1],
  [/(hour|stunde|heure|hora|or[ae]|時間|시간|minute|minut|分|분)/i, 0],
];
export function parseDate(s, now = Date.now()) {
  const t = String(s ?? '').trim();
  if (!t) return null;
  let m = t.match(/(\d{4})\s*[-/.年]\s*(\d{1,2})\s*[-/.月]\s*(\d{1,2})/);
  if (m) return Date.UTC(+m[1], +m[2] - 1, +m[3]);
  m = t.match(/(\d{1,2})\.\s*(\d{1,2})\.\s*(\d{4})/) || t.match(/(\d{1,2})\/(\d{1,2})\/(\d{4})/);
  if (m) return Date.UTC(+m[3], +m[2] - 1, +m[1]);
  m = t.match(/([A-Za-z]{3})[a-z]*\.?\s+(\d{1,2}),?\s+(\d{4})/);
  if (m && MONTHS[m[1].toLowerCase()] !== undefined) return Date.UTC(+m[3], MONTHS[m[1].toLowerCase()], +m[2]);
  m = t.match(/(\d{1,2})\s+([A-Za-z]{3})[a-z]*\.?\s+(\d{4})/);
  if (m && MONTHS[m[2].toLowerCase()] !== undefined) return Date.UTC(+m[3], MONTHS[m[2].toLowerCase()], +m[1]);
  // 相对时间：数字 + 单位（「vor einem Jahr」「a year ago」没有数字 = 1）
  const n = Number(t.match(/\d+/)?.[0] ?? 1);
  for (const [re, days] of UNIT) if (re.test(t)) return now - n * days * DAY;
  return null;
}

/** 标题里写的年份早于今年（「… Codes 2025」）也算旧 */
const titleYear = (title) => Math.max(0, ...(String(title ?? '').match(/\b20[2-3]\d\b/g) ?? []).map(Number)) || null;

/**
 * 算「过时」的分界：游戏最近更新 和 30 天前 取较早的。Roblox 的 `updated` 几乎天天变（发一次服就算），
 * 直接拿它比，所有页面都会「早于更新」；30 天没动过、而游戏这期间还在更新，才算没跟上
 */
export const gapCutoff = (updatedAt, now = Date.now()) => Math.min(updatedAt ?? now - 60 * DAY, now - 30 * DAY);

/** 纯函数：一页结果 → 本地语言页数、有日期页数、过时页数 */
export function analyzeSerp(results, { market = null, updatedAt = null, now = Date.now() } = {}) {
  const pages = results.filter((r) => !VIDEO.test(String(r.domain ?? '')));
  const cutoff = gapCutoff(updatedAt, now);
  const thisYear = new Date(now).getUTCFullYear();
  let dated = 0, stale = 0;
  for (const r of pages) {
    const ts = parseDate(r.date, now);
    const y = titleYear(r.title);
    if (ts === null && !y) continue;
    dated += 1;
    if ((ts !== null && ts < cutoff) || (y && y < thisYear)) stale += 1;
  }
  return {
    total: results.length,
    pages: pages.length,
    native: market ? pages.filter((r) => isNative(r, market)).length : null,
    dated,
    stale,
  };
}

/** 纯函数：本地联想补全里有几条「含游戏名 + 本地语言词」 */
export function localDemand(game, completions, m) {
  const g = normName(game).split(' ').filter((w) => w.length > 2);
  return completions.filter((c) => {
    const n = normName(c);
    return g.every((w) => n.includes(w)) && m.demand.test(c);
  }).length;
}

// ── 网络 ──
// 用 curl 不用 fetch：代理 7897 节点坏死时（2026-10-20 当天就是）fetch 整段失败，curl 先按 https_proxy 走、不通再直连
const curl = (args) => new Promise((resolve) => {
  execFile('curl', ['-s', '-m', '15', '-A', 'Mozilla/5.0', ...args], { encoding: 'buffer', maxBuffer: 1 << 20 }, (err, stdout) => resolve(err ? null : stdout));
});
async function suggest(q, m) {
  const url = `https://suggestqueries.google.com/complete/search?client=firefox&ie=utf-8&oe=utf-8&hl=${m.lang}&gl=${m.cc}&q=${encodeURIComponent(q)}`;
  for (const args of [[url], ['--noproxy', '*', url]]) {
    const buf = await curl(args);
    try {
      const data = JSON.parse(buf.toString('utf8'));
      return Array.isArray(data?.[1]) ? data[1].map(String) : [];
    } catch {
      // 换直连再试
    }
  }
  return null;
}

export function serp(q, cc, lang) {
  return new Promise((resolve) => {
    execFile('python3', ['-I', TREG_CALL, 'treg.google.serp.organic', JSON.stringify({ q, country: cc, language: lang, limit: 10 })],
      { env: { ...process.env, TREG_CALLER: 'serp-gap' }, timeout: 120_000, maxBuffer: 8 << 20 }, (err, stdout) => {
        if (err) return resolve(null);
        try { resolve(JSON.parse(stdout).output.results ?? null); } catch { resolve(null); }
      });
  });
}

function loadCache() {
  try { return existsSync(CACHE_FILE) ? JSON.parse(readFileSync(CACHE_FILE, 'utf8')) : {}; } catch { return {}; }
}

/**
 * 查一个游戏。kind = 'roblox' | 'steam'；updatedAt = 游戏最近一次更新（ms，可空）。
 * 返回 { ok, us, markets: [{cc, query, demand, native, pages, stale, dated}], gaps: [cc…], outdated, cached }
 */
export async function serpGap(game, { kind = 'roblox', updatedAt = null, now = Date.now() } = {}) {
  const key = `${kind}:${normName(game)}`;
  const cache = loadCache();
  const hit = cache[key];
  if (hit && now - hit.at < TTL) return { ...hit.result, cached: true };

  const usQuery = `${game} ${US_INTENT[kind]}`;
  const usResults = await serp(usQuery, 'us', 'en');
  const markets = [];
  for (const m of MARKETS) {
    const query = `${game} ${m[kind]}`;
    const [results, a, b] = await Promise.all([serp(query, m.cc, m.lang), suggest(`${game} `, m), suggest(query, m)]);
    const completions = [...new Set([...(a ?? []), ...(b ?? [])])];
    const r = results ? analyzeSerp(results, { market: m, updatedAt, now }) : null;
    markets.push({ cc: m.cc, query, demand: a === null && b === null ? null : localDemand(game, completions, m), examples: completions.filter((c) => m.demand.test(c)).slice(0, 2), ...(r ?? { failed: true }) });
  }
  const us = usResults ? { query: usQuery, ...analyzeSerp(usResults, { updatedAt, now }) } : { query: usQuery, failed: true };
  const result = {
    at: now,
    ok: !us.failed || markets.some((m) => !m.failed),
    updatedAt,
    us,
    markets,
    gaps: markets.filter((m) => !m.failed && m.demand > 0 && m.total >= 5 && m.native <= 2).map((m) => m.cc),
    outdated: !us.failed && updatedAt !== null && us.dated >= 3 && us.stale / us.dated >= 0.6,
  };
  if (result.ok && result.markets.some((m) => m.demand !== null)) {
    const fresh = loadCache(); // 别覆盖并发写入的其他游戏
    fresh[key] = { at: now, result };
    try { writeFileSync(CACHE_FILE, JSON.stringify(fresh, null, 1)); } catch { /* 缓存写不了不影响结果 */ }
  }
  return result;
}

const CC_NAME = { de: '德', fr: '法', es: '西', it: '意', jp: '日', kr: '韩' };
const ymd = (ts) => new Date(ts).toISOString().slice(5, 10);
/** 「早于什么」的说法：游戏 30 天内还更新过 = 页面 30 天没动；更早的更新 = 页面早于那次更新 */
const staleWhat = (r) => (gapCutoff(r.updatedAt, r.at) < r.updatedAt ? `30 天前（游戏 ${ymd(r.updatedAt)} 还在更新）` : `游戏 ${ymd(r.updatedAt)} 那次更新`);

/** 一行摘要（总报告「今天最值得看」用）；没空位返回空串 */
export function serpGapNote(r) {
  if (!r?.ok) return 'SERP 空位 查询失败';
  const parts = [];
  if (r.gaps.length) parts.push(`🌐 语言空位 ${r.gaps.map((c) => CC_NAME[c]).join('')}（本地有人搜、前 10 本地语言页 ≤2）`);
  if (r.outdated) parts.push(`🕰️ 美国前 10 有 ${r.us.stale}/${r.us.dated} 页早于${staleWhat(r)}`);
  return parts.join(' · ');
}

/** 多行明细（radar.mjs check 用） */
export function serpGapDetail(r) {
  if (!r?.ok) return '   SERP 空位 查询失败（treg 不通？）';
  const lines = [];
  lines.push(`   美国「${r.us.query}」：${r.us.failed ? '查询失败' : r.updatedAt ? `有日期的 ${r.us.dated} 页里 ${r.us.stale} 页早于${staleWhat(r)}${r.outdated ? ' → 🕰️ 过时' : ''}` : `拿不到游戏更新日，不判过时（有日期的 ${r.us.dated} 页里 ${r.us.stale} 页早于 60 天前）`}`);
  for (const m of r.markets) {
    const demand = m.demand === null ? '联想失败' : m.demand ? `本地联想 ${m.demand} 条${m.examples.length ? `（${m.examples.join(' / ')}）` : ''}` : '本地联想 0';
    lines.push(`   ${CC_NAME[m.cc]}「${m.query}」：${m.failed ? 'SERP 失败' : `本地语言页 ${m.native}/${m.pages}（不算视频）`} · ${demand}${r.gaps.includes(m.cc) ? ' → 🌐 空位' : ''}`);
  }
  lines.push(`   ${r.cached ? '（缓存）' : ''}⚠️ SERP 单次会抖，🌐 / 🕰️ 是「值得人去看一眼」，不是判决`);
  return lines.join('\n');
}

// ── 游戏最近更新日（Roblox games API `updated` / Steam 最新公告） ──
export async function robloxUpdated(universeId) {
  try {
    const res = await fetch(`https://games.roblox.com/v1/games?universeIds=${universeId}`, { signal: AbortSignal.timeout(15_000) });
    const t = Date.parse((await res.json())?.data?.[0]?.updated ?? '');
    return Number.isFinite(t) ? t : null;
  } catch { return null; }
}
export async function steamUpdated(appId) {
  try {
    const res = await fetch(`https://api.steampowered.com/ISteamNews/GetNewsForApp/v2/?appid=${appId}&count=5&feeds=steam_community_announcements`, { signal: AbortSignal.timeout(15_000) });
    const t = Math.max(0, ...((await res.json())?.appnews?.newsitems ?? []).map((n) => n.date * 1000));
    return t || null;
  } catch { return null; }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const [kind, ...games] = process.argv.slice(2);
  if (!['roblox', 'steam'].includes(kind) || !games.length) {
    console.log('用法: node lib/serp-gap.mjs roblox|steam "游戏名" ["游戏名2" ...]');
    process.exit(1);
  }
  for (const g of games) {
    console.log(`\n── ${g}（${kind}）`);
    console.log(serpGapDetail(await serpGap(g, { kind })));
  }
}
