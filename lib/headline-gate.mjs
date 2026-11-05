#!/usr/bin/env node
/**
 * headline-gate.mjs — 雷达头条闸门（2026-11-05 加）
 *
 * 为什么：11-05 头条 20 条信号，人工复核后 0 条能做。热度都是真的，但雷达只回答了「什么在涨」，
 * 没回答「还有没有空位、量够不够」。拆下来：6 条早判过 / 自家已有，6 条同行早占了（Ebbtide 的 .wiki
 * 10-21 就被注册，「近 3 天 0 个新域名」反而像空位），5 条量太小（Roblox 400–800 在线），3 条梗是热搜人名。
 * 用户：「看到的都不能用，那拿来干嘛？」
 *
 * 现在每条信号过三关，全过才进「今天最值得看」，没过的折到下面并写原因：
 *   1. 没做过：舰队已有（SITES.md）/ 大厂 IP（只卡可玩 / 梗）
 *   2. 量够：Roblox 在线 ≥1500；Steam 已发售在线 ≥1000、预发布关注者 ≥10000；梗要确认是梗且联想 ≥4 条
 *   3. 没被占满：近 3 天新域名 ≥3 个；或「<游戏> wiki」美国前 10 里 ≥2 个专门站；或 Fandom / wiki.gg ≥100 篇；
 *      精确域（<slug>.wiki / <slug>wiki.com / <slug>wiki.wiki）已注册并上线也算专门站
 * 查不到的不当没过（写「未核」），宁可多放一条也别把真机会卡掉。
 *
 * 成本：竞品关只对过了前两关的查，每条 1 次 treg SERP（约 $0.001）+ 免费 RDAP / MediaWiki API，缓存 1 天。
 *
 * 用法：
 *   import { gateItems } from "./lib/headline-gate.mjs"   // radar.mjs 每日总报告用
 *   node lib/headline-gate.mjs [YYYY-MM-DD] [--no-ledger] [--no-fleet] [--as-of]
 *       回测：拿那天总报告的头条重新过闸。在线人数用的是现在的；--as-of 只算那天以前注册的专门站、不卡 Fandom 篇数
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { BIG_IP } from "./big-ip.mjs";
import { execFile } from "node:child_process";
import { serp } from "./serp-gap.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const SHIP = join(HERE, "..", "..");
const CACHE_FILE = join(HERE, "..", "data", "headline-gate-cache.json");
const DAY = 86400_000;
const TREG_CALL = join(HERE, "..", "..", "scripts", "treg", "call.py");
/** 同行最常注册的精确域（11-05 实测：ebbtide-game.wiki / ebbtidegame.wiki / evermorehigh-wiki.wiki / horsesofhoofprintbay.wiki / cozygamerestorationwiki.wiki） */
export const domainVariants = (slug, dashed) => [...new Set([
  `${slug}.wiki`, `${slug}wiki.wiki`, `${slug}game.wiki`, `${slug}wiki.com`,
  `${dashed}.wiki`, `${dashed}-wiki.wiki`, `${dashed}-game.wiki`,
])];
const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130 Safari/537.36";

export const LIMITS = { robloxCcu: 1500, steamCcu: 1000, steamFollowers: 10000, memeCompletions: 4, nrd: 3, dedicated: 2, wikiArticles: 100, strongCcu: 10000, strongDedicated: 7 };
// 需求大的游戏能容下更多竞品（回测：My Anime Mine 10-26 建站时已有 6 个专门站，1.5 万在线 + Trends 上升，建完一周 154 点击）——
// 在线 ≥1 万或需求双源确认（🟢 GO）时，专门站到 7 个才挡；Fandom / wiki.gg ≥100 篇照挡

const compact = (s) => String(s).toLowerCase().replace(/[™®©]/g, "").replace(/[^a-z0-9]/g, "");
/** Steam 名的「 - 副标题」/「: 副标题」去掉，留主名做域名和 SERP */
export const mainName = (name) => String(name).replace(/[™®©]/g, "").split(/\s+[-–—]\s+|:\s+/)[0].trim();

// ─── 小工具 ─────────────────────────────────────────────────────────────────

function loadCache() {
  try { return existsSync(CACHE_FILE) ? JSON.parse(readFileSync(CACHE_FILE, "utf8")) : {}; } catch { return {}; }
}
function saveCache(c) {
  const now = Date.now();
  for (const k of Object.keys(c)) if (now - (c[k]?.at ?? 0) > 7 * DAY) delete c[k];
  try { writeFileSync(CACHE_FILE, JSON.stringify(c, null, 1)); } catch { /* 写不了不影响结果 */ }
}
async function cached(cache, key, ttl, fn) {
  const hit = cache[key];
  if (hit && Date.now() - hit.at < ttl) return hit.v;
  const v = await fn();
  if (v !== undefined && v !== null) cache[key] = { at: Date.now(), v };
  return v;
}
async function getJson(url, ms = 15_000) {
  try {
    const res = await fetch(url, { headers: { "User-Agent": UA }, signal: AbortSignal.timeout(ms) });
    return res.ok ? await res.json() : null;
  } catch { return null; }
}

function fleetDomains() {
  const p = join(SHIP, "SITES.md");
  if (!existsSync(p)) return [];
  return readFileSync(p, "utf8").split("\n").filter((l) => l.startsWith("| ") && !l.startsWith("| 站") && !l.startsWith("|---"))
    .map((l) => l.split("|")[2]?.trim()).filter((d) => d && d.includes("."));
}
export function fleetHit(name, fleet) {
  const c = compact(mainName(name));
  return fleet.find((d) => {
    const stem = compact(d.split(".")[0]);
    return stem.length >= 5 && c.length >= 5 && (stem.includes(c) || c.includes(stem));
  }) ?? null;
}

/** RDAP：返回 { registered: bool|null, date } */
async function rdap(domain) {
  for (let i = 0; i < 2; i++) {
    try {
      const res = await fetch(`https://rdap.org/domain/${domain}`, { headers: { "User-Agent": UA }, redirect: "follow", signal: AbortSignal.timeout(20_000) });
      if (res.status === 404) return { registered: false };
      if (res.ok) {
        const d = await res.json().catch(() => ({}));
        return { registered: true, date: (d.events ?? []).find((e) => e.eventAction === "registration")?.eventDate?.slice(0, 10) ?? null };
      }
    } catch { /* 重试 */ }
    await new Promise((r) => setTimeout(r, 1500));
  }
  return { registered: null };
}
/** 注册了 ≠ 有站：首页 200 且正文 >5KB 才算上线（停放页一般很小或跳走） */
async function isLive(domain) {
  try {
    const res = await fetch(`https://${domain}/`, { headers: { "User-Agent": UA }, redirect: "follow", signal: AbortSignal.timeout(12_000) });
    if (!res.ok) return false;
    const host = new URL(res.url).hostname.replace(/^www\./, "");
    if (host !== domain) return false; // 跳去停放 / 卖域平台
    const body = await res.text();
    return body.length > 5000 && !/domain (is )?for sale|buy this domain|parked|sedo|dan\.com|afternic/i.test(body.slice(0, 20000));
  } catch { return false; }
}

const WIKI_FARMS = /(^|\.)(fandom\.com|wiki\.gg|miraheze\.org|wikidot\.com)$/;
/** MediaWiki 农场子站的文章数（Fandom / wiki.gg / Miraheze 都有 api.php） */
async function wikiArticles(host) {
  const base = host.endsWith("fandom.com") ? `https://${host}/api.php` : host.endsWith("wiki.gg") ? `https://${host}/api.php` : `https://${host}/w/api.php`;
  const d = await getJson(`${base}?action=query&meta=siteinfo&siprop=statistics&format=json`);
  return d?.query?.statistics?.articles ?? null;
}

/** 「<游戏> wiki」美国前 10：专门站（域名含游戏名）+ Wiki 农场子站。treg 失败返回 null */
export function classifySerp(results, name) {
  const slug = compact(mainName(name));
  const dedicated = new Set();
  const farms = new Set();
  for (const r of results ?? []) {
    let host;
    try { host = new URL(r.url ?? r.link).hostname.replace(/^www\./, ""); } catch { continue; }
    if (WIKI_FARMS.test(host)) {
      const sub = compact(host.split(".")[0]);
      if (sub.length >= 4 && (slug.includes(sub) || sub.includes(slug))) farms.add(host);
      continue;
    }
    const stem = compact(host.split(".").slice(0, -1).join(""));
    if (slug.length >= 5 && stem.includes(slug)) dedicated.add(host);
  }
  return { dedicated: [...dedicated], farms: [...farms] };
}

/** 第二家 SERP（anyapi，$0.0005）：treg 那家对新游戏常只回 1–2 条，两家取并集 */
function serpAny(q) {
  return new Promise((resolve) => {
    execFile("python3", ["-I", TREG_CALL, "anyapi.google.serp.organic", JSON.stringify({ query: q, gl: "us", hl: "en", limit: 10 })],
      { env: { ...process.env, TREG_CALLER: "headline-gate" }, timeout: 120_000, maxBuffer: 8 << 20 }, (err, stdout) => {
        if (err) return resolve(null);
        try { resolve(JSON.parse(stdout).output?.data?.results ?? null); } catch { resolve(null); }
      });
  });
}

// ─── 量级 ───────────────────────────────────────────────────────────────────

async function steamCcu(appId) {
  const d = await getJson(`https://api.steampowered.com/ISteamUserStats/GetNumberOfCurrentPlayers/v1/?appid=${appId}`);
  return d?.response?.result === 1 ? d.response.player_count : null;
}
async function steamComingSoon(appId) {
  const d = await getJson(`https://store.steampowered.com/api/appdetails?appids=${appId}&cc=us&l=en&filters=release_date`);
  return d?.[appId]?.data?.release_date?.coming_soon ?? null;
}

/** 文本里的数字：「关注者 22743」「在线 619」 */
const grab = (text, re) => { const m = String(text).match(re); return m ? Number(m[1].replace(/,/g, "")) : null; };

async function magnitude(item, deps, cache) {
  const { kind, line, name, text = "" } = item;
  const s = item.data?.signals ?? {};
  if (line === "meme") {
    if (/未确认是梗/.test(text) || /未确认是梗/.test(item.data?.source ?? "")) return { pass: false, why: "热搜词，没确认是梗 / 游戏" };
    const total = [...String(s.playableCompletions ?? text).matchAll(/[A-Z]{2} (\d+)/g)].reduce((a, m) => a + Number(m[1]), 0);
    return total >= LIMITS.memeCompletions ? { pass: true, fact: `可玩联想 ${total} 条` } : { pass: false, why: `可玩联想只有 ${total} 条（< ${LIMITS.memeCompletions}）` };
  }
  if (line === "playable" || line === "steady-rising") return { pass: true };

  const isSteamLine = kind === "steam" || kind === "steamcharts";
  if (!isSteamLine) {
    // Roblox / 联想新词：先认 Roblox，再认 Steam
    let ccu = s.ccu ?? null;
    let found = ccu !== null;
    if (!found) {
      const r = await cached(cache, `roblox:${compact(name)}`, DAY, () => deps.onRoblox(name));
      if (r) { ccu = r.playing; found = true; }
    }
    if (found) return ccu >= LIMITS.robloxCcu ? { pass: true, strong: ccu >= LIMITS.strongCcu, fact: `Roblox 在线 ${ccu}` } : { pass: false, why: `Roblox 在线 ${ccu}（< ${LIMITS.robloxCcu}）` };
    if (kind === "roblox") return { pass: null, fact: "在线人数没查到" };
  }
  const st = await cached(cache, `steam:${compact(name)}`, DAY, () => deps.onSteam(mainName(name)));
  if (!st) return isSteamLine ? { pass: null, fact: "Steam 没查到" } : { pass: false, why: "Roblox / Steam 都找不到这个游戏" };
  const soon = await steamComingSoon(st.appId);
  if (soon) {
    const followers = s.followers ?? grab(text, /关注者 ([\d,]+)/);
    if (followers === null) return { pass: null, fact: "预发布，关注者没查到" };
    return followers >= LIMITS.steamFollowers ? { pass: true, fact: `预发布 · 关注者 ${followers}` } : { pass: false, why: `预发布 · 关注者 ${followers}（< ${LIMITS.steamFollowers}）` };
  }
  const ccu = await steamCcu(st.appId);
  if (ccu === null) return { pass: null, fact: "Steam 在线没查到" };
  return ccu >= LIMITS.steamCcu ? { pass: true, strong: ccu >= LIMITS.strongCcu, fact: `Steam 在线 ${ccu}` } : { pass: false, why: `Steam 在线 ${ccu}（< ${LIMITS.steamCcu}）` };
}

// ─── 竞品 ───────────────────────────────────────────────────────────────────

async function competition(item, cache) {
  const name = mainName(item.name);
  const slug = compact(name);
  const dashed = name.toLowerCase().replace(/[™®©']/g, "").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  return cached(cache, `comp:${slug}`, DAY, async () => {
    const queries = [`${name} wiki`, `${name} game wiki`];
    const pages = (await Promise.all([...queries.map((q) => serp(q, "us", "en")), ...queries.map(serpAny)])).filter(Boolean);
    const fromSerp = classifySerp(pages.flat(), name);
    const exact = [];
    if (slug.length >= 4 && slug.length <= 30) {
      for (const d of domainVariants(slug, dashed)) {
        if (fromSerp.dedicated.includes(d)) continue;
        const r = await rdap(d);
        if (r.registered && await isLive(d)) exact.push({ domain: d, date: r.date });
      }
    }
    const farms = [];
    for (const host of fromSerp.farms) farms.push({ host, articles: await wikiArticles(host) });
    const dedicated = [...new Set([...fromSerp.dedicated, ...exact.map((e) => e.domain)])];
    // 每个专门站都查注册日：报告里写「最早哪天被占」，回测时只算那天之前就有的
    const dates = Object.fromEntries(exact.map((e) => [e.domain, e.date]));
    for (const d of dedicated) if (!(d in dates)) dates[d] = (await rdap(d)).date ?? null;
    return { serpOk: pages.some((p) => p.length), dedicated, exact, farms, dates };
  });
}

function compVerdict(c, nrd, strong = false) {
  if (nrd >= LIMITS.nrd) return { pass: false, why: `近 3 天已有 ${nrd} 个新域名进场` };
  const bigFarm = c.farms.find((f) => (f.articles ?? 0) >= LIMITS.wikiArticles);
  if (bigFarm) return { pass: false, why: `${bigFarm.host} 已有 ${bigFarm.articles} 篇` };
  // wiki.gg 挡 API 拿不到篇数的农场站也算一个专门站
  const sites = [...c.dedicated, ...c.farms.filter((f) => f.articles === null).map((f) => f.host)];
  if (sites.length >= (strong ? LIMITS.strongDedicated : LIMITS.dedicated)) {
    const first = c.dedicated.map((d) => [d, c.dates?.[d]]).filter(([, t]) => t).sort((x, y) => x[1].localeCompare(y[1]))[0];
    return { pass: false, why: `已有 ${sites.length} 个专门站（${sites.slice(0, 3).join("、")}${sites.length > 3 ? " 等" : ""}${first ? `；最早 ${first[0]} ${first[1]} 注册` : ""}）` };
  }
  if (!c.serpOk) return { pass: null, fact: "竞品 SERP 没查到" };
  const crowded = sites.length >= LIMITS.dedicated; // 只有 strong 才走到这里
  const facts = [c.dedicated.length ? `${crowded ? "⚠️ 靠量撑：" : ""}专门站 ${sites.length} 个（${sites.slice(0, 2).join("、")}）` : "专门站 0", ...c.farms.map((f) => `${f.host} ${f.articles ?? "?"} 篇`)];
  return { pass: true, fact: facts.join(" · ") };
}

// ─── 主入口 ─────────────────────────────────────────────────────────────────

/**
 * items: radar.mjs 头条候选（{ kind, line, name, text, data }）；nrdOf(name) → 近 3 天新域名数（拿不到 null）。
 * 返回 Map<item, { pass: boolean, why: string|null, facts: string[] }>，绝不抛。
 */
export async function gateItems(items, { onRoblox, onSteam, nrdOf = () => null, fleet = fleetDomains(), exclude = fleet, asOf = null } = {}) {
  const cache = loadCache();
  const out = new Map();
  for (const item of items) {
    const facts = [];
    try {
      const site = fleetHit(item.name, fleet);
      if (site) { out.set(item, { pass: false, why: `舰队已有 ${site}`, facts }); continue; }
      if ((item.line === "playable" || item.line === "meme") && BIG_IP.some((k) => item.name.toLowerCase().includes(k))) {
        out.set(item, { pass: false, why: "大厂 IP（授权方不给第三方做，浏览器版多是非授权移植）", facts }); continue;
      }
      const m = await magnitude(item, { onRoblox, onSteam }, cache);
      if (m.pass === false) { out.set(item, { pass: false, why: m.why, facts }); continue; }
      if (m.fact) facts.push(m.fact);
      const nrd = nrdOf(item.name) ?? 0;
      if (item.line === "meme") {
        out.set(item, nrd >= LIMITS.nrd ? { pass: false, why: `近 3 天已有 ${nrd} 个新域名进场`, facts } : { pass: true, why: null, facts });
        continue;
      }
      if (item.line === "playable" && nrd >= LIMITS.nrd) { out.set(item, { pass: false, why: `近 3 天已有 ${nrd} 个新域名进场`, facts }); continue; }
      const comp = await competition(item, cache);
      // 自家站不算竞品
      const own = new Set(exclude.map((d) => d.replace(/^www\./, "")));
      // 回测（asOf = 报告日期）：那天之后才注册的不算；Fandom 篇数拿不到历史值，回测时不卡
      const keep = (d) => !own.has(d) && !(asOf && comp.dates?.[d] && comp.dates[d] > asOf);
      const strong = Boolean(m.strong) || /🟢 GO/.test(`${item.data?.verdict ?? ""} ${item.text ?? ""}`);
      const c = compVerdict({ ...comp, dedicated: comp.dedicated.filter(keep), exact: comp.exact.filter((e) => keep(e.domain)), farms: asOf ? [] : comp.farms }, nrd, strong);
      if (c.pass === false) { out.set(item, { pass: false, why: c.why, facts }); continue; }
      if (c.fact) facts.push(c.fact);
      out.set(item, { pass: true, why: null, facts });
    } catch (error) {
      out.set(item, { pass: true, why: null, facts: [...facts, `闸门出错：${error.message}`] });
    }
  }
  saveCache(cache);
  return out;
}

/** 总报告里平台标签 → item 的 kind / line（回测和后台都按这个认） */
export const PLATFORM = {
  "Roblox": { kind: "roblox", line: "roblox-demand" },
  "Roblox 错配": { kind: "roblox", line: "roblox-mismatch" },
  "Steam": { kind: "steam", line: "steam-invest" },
  "Steam 关注者": { kind: "steam", line: "steam-follow" },
  "Steam 畅销榜": { kind: "steamcharts", line: "steam-charts" },
  "联想新词": { kind: "suggest", line: "suggest-diff" },
  "稳涨冷门": { kind: "steady", line: "steady-rising" },
  "可玩游戏": { kind: undefined, line: "playable" },
  "梗": { kind: undefined, line: "meme" },
};

/** 总报告的一行头条 → item（回测用） */
export function parseHeadlineLine(line) {
  const m = line.match(/^- \*\*(.+?)\*\*\s*(.+?)[：:](.*)$/);
  if (!m || !PLATFORM[m[1]]) return null;
  const nrd = grab(m[3], /近 3 天 (\d+) 个新域名/);
  return { ...PLATFORM[m[1]], platform: m[1], name: m[2].trim(), text: m[3], nrd, data: { signals: {} } };
}

// ─── 回测 CLI ───────────────────────────────────────────────────────────────

const IS_MAIN = process.argv[1]?.endsWith("headline-gate.mjs");
if (IS_MAIN) {
  const date = process.argv.slice(2).find((a) => /^\d{4}-/.test(a)) ?? new Date(Date.now() + 8 * 3600e3).toISOString().slice(0, 10);
  const { reportPath } = await import("../../scripts/lib/reports.mjs");
  const { onRoblox, onSteam, withoutRejected } = await import("./game-lookup.mjs");
  const text = readFileSync(reportPath(`RADAR-${date}.md`), "utf8");
  const block = text.match(/## 今天最值得看\n([\s\S]*?)\n## /)?.[1] ?? "";
  const all = block.split("\n").map(parseHeadlineLine).filter(Boolean);
  const ledger = JSON.parse(readFileSync(join(HERE, "..", "data", "rejections.json"), "utf8"));
  const items = process.argv.includes("--no-ledger") ? all : withoutRejected(all, ledger);
  if (items.length < all.length) console.log(`否决账本去掉 ${all.length - items.length} 条：${all.filter((i) => !items.includes(i)).map((i) => i.name).join("、")}\n`);
  // --no-fleet：回测已建站那几天时不按「舰队已有」挡，自家站也不算竞品（看闸门会不会误杀当时的真机会）
  const noFleet = process.argv.includes("--no-fleet");
  const res = await gateItems(items, { onRoblox, onSteam, nrdOf: (n) => items.find((i) => i.name === n)?.nrd ?? null, ...(noFleet ? { fleet: [], exclude: fleetDomains() } : {}), asOf: process.argv.includes("--as-of") ? date : null });
  let pass = 0;
  for (const i of items) {
    const r = res.get(i);
    if (r.pass) pass += 1;
    console.log(`${r.pass ? "✅" : "❌"} ${i.platform.padEnd(8)} ${i.name.padEnd(28)} ${r.pass ? r.facts.join(" · ") : r.why}`);
  }
  console.log(`\n${date}：${items.length} 条信号 → ${pass} 条过闸`);
}
