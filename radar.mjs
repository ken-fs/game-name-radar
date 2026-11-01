#!/usr/bin/env node
/**
 * radar.mjs — 游戏雷达统一入口（2026-10-08 加）
 *
 * 以前要分开跑 Roblox / Steam / 可玩游戏 / 梗 四套雷达，记不住该用哪个。现在两种用法：
 *
 *   node radar.mjs                    # 今日总报告 → ../reports/summary/RADAR-<日期>.md
 *       读当天每日管线（scripts/scan.mjs，launchd 08:30）产出的 Steam 投入价值 / 可玩游戏 /
 *       梗游戏三份报告，再现跑 Roblox 层（成长期扫描 + YouTube 错配 + 前几名的需求验证），
 *       汇总成一份，最上面是「今天最值得看」。launchd 在 scan.mjs 之后接着跑它。
 *
 *   node radar.mjs check "名字" [...]  # 单查一个或几个游戏 / 梗，自动判断该走哪条线（Roblox / Steam 末尾带 SERP 空位）：
 *       Roblox 上搜得到 → Roblox 需求验证（Trends 曲线 + 攻略子词）
 *       Steam 上搜得到  → Steam 工具闸门 + 投入价值五维评分
 *       都没有          → 可玩游戏走势 + 梗雷达（高 CPM 市场本地语言联想）
 *       同名多平台都有的，几条线都跑。
 *
 * 只做编排：各模块原样调用（子进程），不改它们的逻辑。全部零搜索额度
 * （Roblox 官方 API、yt-dlp、Google Suggest / Trends）。
 *
 *   node radar.mjs --skip-roblox      # 只汇总当天已有报告（Roblox 层慢，约 5–15 分钟）
 *
 * 站型信号（2026-10-13 加，依据 Ship/research/GAME-WIKI-STRUCTURE-2026-10.md）：「今天最值得看」的
 * Roblox / Steam / 联想新词候选每条再带两个标记——
 *   🧮 工具需求（lib/tool-demand.mjs，Google Suggest 免费）：有价值表 / 计算器需求 = 能做首页即工具的站
 *   codes 媒体 N 家（lib/codes-media.mjs，直接请求 8 家媒体的 codes 页网址，免费、缓存 1 天）：≥3 家 = codes 别当主打；
 *   只查 Roblox / 联想新词（买断制 Steam 游戏没有 codes 生态）
 * 两个都查不到只在那一条上写「查询失败」，不影响总报告。
 */
import { execFile, execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { nrdCounts, nrdNote } from "./lib/nrd.mjs";
import { codesMediaBatch } from "./lib/codes-media.mjs";
import { toolDemand, toolDemandNote } from "./lib/tool-demand.mjs";
import { num, writeVerdictLog } from "./lib/verdict-log.mjs";
import { reportPath } from "../scripts/lib/reports.mjs";
import { robloxUpdated, serpGap, serpGapDetail, serpGapNote, steamUpdated } from "./lib/serp-gap.mjs";
import { eventNote, robloxEvent } from "./lib/roblox-event.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const SHIP = join(HERE, "..");
const today = new Date().toLocaleDateString("sv-SE");
const args = process.argv.slice(2);

/** 跑一个模块，返回 stdout（失败也返回已有输出，绝不抛）。 */
function run(file, argv = [], timeoutMs = 30 * 60_000) {
  return new Promise((resolve) => {
    execFile(
      process.execPath,
      ["--env-file-if-exists=.env", join(HERE, file), ...argv],
      { cwd: HERE, maxBuffer: 32 * 1024 * 1024, timeout: timeoutMs, env: process.env },
      (error, stdout, stderr) => {
        const out = String(stdout || "");
        if (error && !out) {
          resolve(`⚠️ ${file} 失败：${String(stderr || error.message).split("\n").find((l) => l.trim()) ?? error.message}`);
          return;
        }
        resolve(out);
      },
    );
  });
}

/** 通知中心推送：daily.sh 成功路径设 RADAR_NOTIFY=1 才发，手动跑不打扰。 */
const PUSH_SCRIPT = new URL("../scripts/notify.mjs", import.meta.url).pathname;

function notify(title, body, sound = "Glass") {
  // 先推飞书（Ship/scripts/notify.mjs，2026-10-11 加：用户不在电脑前会漏 macOS 通知）；推不出去再走下面的 macOS 通知。
  try {
    execFileSync(process.execPath, [PUSH_SCRIPT, "--title", String(title), "--body", String(body)], { stdio: "ignore", timeout: 30000 });
    return;
  } catch {}
  const esc = (s) => String(s).replace(/\\/g, "\\\\").replace(/"/g, '\\"').slice(0, 400);
  try {
    execFileSync("osascript", ["-e", `display notification "${esc(body)}" with title "${esc(title)}" sound name "${sound}"`]);
  } catch {
    /* 通知失败不影响主流程 */
  }
}

/** Roblox 名字去掉 [UPDATE] / 🎃 / 开头「+1」这类装饰，留给 Trends 和 SERP 用（玩家搜的是「assassin leveling codes」）。 */
export function cleanRobloxName(name) {
  return name
    .replace(/\[[^\]]*\]|\([^)]*\)|【[^】]*】/g, " ")
    .replace(/^\s*\+\d+\s+/, " ")
    .replace(/[\p{Extended_Pictographic}\u{FE0F}\u{200D}]/gu, " ")
    .replace(/\s+/g, " ")
    .replace(/[!?.:,]+$/g, "")
    .trim();
}

/** 已否决候选只有复测翻转后才重新进头条；manual / closed 不被原始信号反复顶回来。 */
export function withoutRejected(items, ledger) {
  const rejected = new Set((ledger?.decisions ?? [])
    .filter((d) => d.name && d.status !== "flipped")
    .map((d) => d.name.trim().toLowerCase()));
  return items.filter((i) => !rejected.has(String(i.name).trim().toLowerCase()));
}

// ─── Roblox 层 ────────────────────────────────────────────────────────────────

const GROWTH_ROW = /^\s+([\d.]+)x\s+(\d+)\s+([\d.]+[KM]?)\s+(\d+)天\s+(\d+)天前\s+(.+?)\s+\[(\d+)\]\s*$/;
const MISMATCH_ROW = /^\s+(🎣🎣|🎣)\s+([\d.]+)\s+(\d+)\s+([\d,]+)\s+(\d+)\s+(.+?)\s+\[(\d+)\]/;

export function parseGrowth(text) {
  return text
    .split("\n")
    .map((line) => line.match(GROWTH_ROW))
    .filter(Boolean)
    .map((m) => ({ ageDays: Number(m[4]), ccu: Number(m[2]), growth: Number(m[1]), id: m[7], name: m[6].trim(), updatedDaysAgo: Number(m[5]) }));
}

/** 增长扫描的「大而稳」段（行首 ⚓，其余列同 GROWTH_ROW） */
export function parseSteady(text) {
  return parseGrowth(text.split("\n").filter((line) => /^\s+⚓/.test(line)).map((line) => line.replace("⚓", " ")).join("\n"));
}

export function parseMismatch(text) {
  return text
    .split("\n")
    .map((line) => line.match(MISMATCH_ROW))
    .filter(Boolean)
    .map((m) => ({ ccu: Number(m[5]), channels: Number(m[3]), flag: m[1], id: m[7], name: m[6].trim(), ratio: Number(m[2]) }));
}

export function parseDemand(text) {
  const out = [];
  let current = null;
  for (const line of text.split("\n")) {
    const head = line.match(/^── (.+)$/);
    if (head) {
      current = { name: head[1].trim(), verdict: "", reason: "", trend: "", magnitude: "", sub: "" };
      out.push(current);
      continue;
    }
    if (!current) continue;
    const verdict = line.match(/判决:\s*(.+?)\s*—\s*(.+)$/);
    if (verdict) {
      // 需求验证给的是「🟢 GO」「🟡 观察」「放弃」三种；放弃没带图标，这里补上
      current.verdict = verdict[1].trim() === "放弃" ? "❌ 放弃" : verdict[1].trim();
      current.reason = verdict[2].trim();
    }
    const trend = line.match(/Trends\((codes|wiki)\):\s*(.+)$/);
    if (trend) current.trend = trend[2].trim();
    // 量级（相对自家锚点站）：报告里不显示它，读者无法分辨「零量词 rising」和「真需求」
    const mag = line.match(/量级:\s*(.+)$/);
    if (mag) current.magnitude = mag[1].trim().replace(/^近期约锚点\(([^)]+)\)的\s*/, "vs $1：").replace(/（候选[^）]*）/, "");
    const sub = line.match(/子关键词:\s*(.+)$/);
    if (sub) current.sub = sub[1].trim().slice(0, 120);
  }
  return out;
}

/**
 * 拿去做需求验证的候选：强错配（🎣🎣）和成长期各占一半，成长期只要 CCU 800–60K
 * （太小撑不起站、太大 SERP 已锁死）。Trends 会限流，总数控制在 limit 以内。
 */
function shortlist(growth, mismatch, steady = [], limit = 8) {
  const picked = new Map();
  const half = Math.ceil(limit / 2);
  for (const m of mismatch.filter((r) => r.flag === "🎣🎣").slice(0, half)) picked.set(m.id, m.name);
  // 大而稳留 2 个名额（2026-10-14，Deep Fishing 漏报：它从来抢不过增长比高的小游戏）
  for (const g of steady.slice(0, 2)) picked.set(g.id, g.name);
  for (const g of growth.filter((r) => r.ccu >= 800 && r.ccu <= 60_000)) {
    if (picked.size >= limit) break;
    picked.set(g.id, g.name);
  }
  return [...picked.values()].map(cleanRobloxName).filter(Boolean);
}

async function robloxLayer() {
  const [growthText, mismatchText] = await Promise.all([
    run("lib/roblox-growth-scan.mjs"),
    run("lib/roblox-yt-mismatch.mjs"),
  ]);
  const growth = parseGrowth(growthText);
  const steady = parseSteady(growthText);
  const mismatch = parseMismatch(mismatchText);
  const names = shortlist(growth, mismatch, steady);
  const demand = names.length ? parseDemand(await run("lib/roblox-demand-scan.mjs", names)) : [];
  // 🧮 工具需求（2026-10-13 加）：结果缓存 24h，下面「今天最值得看」再查同名直接命中
  for (const d of demand) {
    try { d.tool = await toolDemand(d.name); } catch { d.tool = { ok: false }; }
  }
  return { demand, growth, steady, mismatch, errors: [growthText, mismatchText].filter((t) => t.startsWith("⚠️")) };
}

// ─── 读当天每日管线的报告 ─────────────────────────────────────────────────────

function readReport(kind) {
  const file = reportPath(`RADAR-${kind}-${today}.md`, { mkdir: false });
  return existsSync(file) ? readFileSync(file, "utf8") : null;
}

function readData(name, fallback) {
  try { return JSON.parse(readFileSync(join(HERE, "data", name), "utf8")); } catch { return fallback; }
}

/** 稳涨冷门只扩充候选来源；不参与、也不改变任何现有判决。 */
export function collectSteadyRising(candidatePayload = {}, playableState = {}) {
  const rows = [];
  for (const candidate of candidatePayload.candidates ?? []) {
    const signal = candidate.trend?.steadyRising;
    if (signal?.match) rows.push({ kind: "wiki", name: candidate.gameName, ...signal });
  }
  for (const [name, entry] of Object.entries(playableState.names ?? {})) {
    const signal = entry.trend?.steady;
    if (signal?.match) rows.push({ kind: "h5", name, ...signal });
  }
  return rows;
}

function steadyNote(row) {
  const growth = (row.growths ?? []).map((value) => value === null ? "从零起量" : `+${Math.round(value * 100)}%`).join(" / ");
  const ratio = row.ratio === null ? "从零起量" : `${Number(row.ratio).toFixed(1)}x`;
  return `最近 3 周 ${growth}，近 4 周÷前 4 周 ${ratio}`;
}

/** 表格里以某些判决开头的行，原样带出（最多 n 行）。 */
function rowsStartingWith(md, marks, n = 8) {
  if (!md) return [];
  return md
    .split("\n")
    .filter((line) => marks.some((mark) => line.startsWith(`| ${mark}`)))
    .slice(0, n);
}

// ─── 今日总报告 ───────────────────────────────────────────────────────────────

function table(header, rows) {
  return rows.length ? [header, header.replace(/[^|]+/g, "---"), ...rows] : ["（今天没有）"];
}

/** 表格行 → 单元格（去掉首尾的空格和竖线） */
const cells = (row) => row.split("|").slice(1, -1).map((c) => c.trim());
const unlink = (s = "") => s.replace(/\[([^\]]+)\]\([^)]*\)/g, "$1").replace(/\*\*/g, "").trim();

// ─── 站型信号（2026-10-13 加）──────────────────────────────────────────────────

/** 哪些线要查站型信号：可玩游戏 / 梗没有 codes、也不是交易类，跳过 */
const SIGNAL_KINDS = new Set(["roblox", "steam", "suggest"]);

/**
 * 「今天最值得看」每条的站型标记：🧮 工具需求 + codes 媒体进场数。返回 Map<item, string[]>。
 * 任何一步失败只在那一条上写「查询失败」，绝不抛（daily.sh 的总报告不能因为它挂掉）。
 */
export async function siteShapeSignals(items, { tool = toolDemand, codes = codesMediaBatch } = {}) {
  const out = new Map();
  const eligible = items.filter((i) => SIGNAL_KINDS.has(i.kind) && i.name);
  if (!eligible.length) return out;
  // codes 只对 Roblox / 联想新词有意义：买断制 Steam 游戏基本没有 codes 生态，
  // 硬查只会得到「0 家 · 还有窗口」的假信号（2026-10-21 修）。
  const codesEligible = eligible.filter((i) => i.kind !== "steam");
  let codesMap = new Map();
  if (codesEligible.length) {
    try {
      // 按 items 顺序占额度（Roblox 在最前面），每天最多 15 次新查询，缓存 1 天
      codesMap = await codes(codesEligible.map((i) => i.name));
    } catch (error) {
      console.error(`codes 媒体失败：${error.message}`);
    }
  }
  for (const i of eligible) {
    const notes = [];
    const shape = {};
    try {
      const t = await tool(i.name);
      shape.tool = t;
      if (!t.ok || t.count) notes.push(toolDemandNote(t, { examples: 1 }));
    } catch {
      notes.push("工具需求 查询失败");
    }
    if (i.kind !== "steam") {
      const c = codesMap.get(i.name);
      notes.push(c ? (c.verdict === "mismatch" ? "codes SERP 错配" : c.label) : "codes 媒体 查询失败");
      shape.codes = c;
    }
    i.shape = shape; // 原始值给判决记录（lib/verdict-log.mjs）
    out.set(i, notes);
  }
  return out;
}

async function daily() {
  const invest = readReport("INVEST");
  const playable = readReport("PLAYABLE");
  const meme = readReport("MEME");
  const follow = readReport("STEAMFOLLOW");
  const suggest = readReport("SUGGEST");
  const charts = readReport("STEAMCHARTS");
  const roblox = args.includes("--skip-roblox") ? null : await robloxLayer();

  // 稳涨冷门是独立入口：持续命中只留栏目，首次 / 重新进入才进头条。
  const steadyRows = collectSteadyRising(
    readData("candidates.json", {}),
    readData("playable-watch-state.json", {}),
  );
  const steadyStateFile = join(HERE, "data", "steady-rising-state.json");
  const steadyPrevious = readData("steady-rising-state.json", null);
  const previousActive = new Set(steadyPrevious?.active ?? []);
  const steadyActive = steadyRows.map((row) => `${row.kind}:${row.name.toLowerCase()}`);
  const steadyFresh = steadyPrevious ? steadyRows.filter((row) => !previousActive.has(`${row.kind}:${row.name.toLowerCase()}`)) : [];
  writeFileSync(steadyStateFile, JSON.stringify({ updatedAt: new Date().toISOString(), active: steadyActive }, null, 2) + "\n");

  const steamTop = rowsStartingWith(invest, ["🟢", "🔔"]);
  const steamWatch = rowsStartingWith(invest, ["🟡"], 5);
  const playableTop = rowsStartingWith(playable, ["🟢", "🟡 待复核"]);
  const memeTop = rowsStartingWith(meme, ["🚨"]);
  const followTop = rowsStartingWith(follow, ["🟢", "🌱"], 6);
  const suggestTop = rowsStartingWith(suggest, ["🟢"], 5);
  // Steam 畅销 / 在玩榜（2026-10-13 加）：周榜一周内天天是同一份数据，只把「今天第一次报」的 🟢（带 🆕）放进最值得看；
  // 投入价值已经判了 ❌ 放弃的不放（同 Roblox 错配的处理）
  const chartsTop = rowsStartingWith(charts, ["🟢 冲榜 🆕"], 10).filter((r) => !cells(r)[6]?.startsWith("❌")).slice(0, 5);
  const robloxGo = roblox?.demand.filter((d) => d.verdict.startsWith("🟢")) ?? [];
  // 已经验证为「放弃」的错配不进「最值得看」（视频多但没人搜攻略，做站也接不住流量）
  const strongMismatch =
    roblox?.mismatch.filter(
      (m) => m.flag === "🎣🎣" && !roblox.demand.some((d) => d.name === cleanRobloxName(m.name) && d.verdict.startsWith("❌")),
    ) ?? [];

  // 判决记录（2026-10-13 加）：每条带上当时的原始数值（data），跑完写进 data/verdict-log.jsonl
  const robloxStats = (name) => {
    const g = [...(roblox?.growth ?? []), ...(roblox?.steady ?? [])].find((x) => cleanRobloxName(x.name) === name);
    const m = roblox?.mismatch.find((x) => cleanRobloxName(x.name) === name);
    // universeId 不是 placeId（2026-10-20 修：VERDICT-LOG 里叫 placeId，拿它去 /places/<id> 查是 null）
    return { ageDays: g?.ageDays, ccu: g?.ccu ?? m?.ccu, growthX: g?.growth, universeId: g?.id ?? m?.id, updatedDaysAgo: g?.updatedDaysAgo, ytChannels: m?.channels, ytRatio: m?.ratio };
  };
  // 每条带上游戏名，后面统一查「最近 3 天新注册域名」
  let rejectionLedger = {};
  try { rejectionLedger = JSON.parse(readFileSync(join(HERE, "data", "rejections.json"), "utf8")); } catch {}
  const items = withoutRejected([
    ...robloxGo.map((d) => ({ kind: "roblox", line: "roblox-demand", name: d.name, text: `- **Roblox** ${d.name}：${d.verdict}（${d.reason}）`,
      data: { verdict: d.verdict, signals: { ...robloxStats(d.name), magnitude: d.magnitude || undefined, subKeywords: d.sub ? d.sub.split(/[,，、]/).filter(Boolean).length : undefined, trend: d.trend || undefined } } })),
    ...strongMismatch.map((m) => {
      const name = cleanRobloxName(m.name);
      const verified = roblox?.demand.find((d) => d.name === name);
      const demandNote = verified ? `；需求验证 ${verified.verdict}` : "；还没做需求验证";
      return { kind: "roblox", line: "roblox-mismatch", name, text: `- **Roblox 错配** ${name}：本周 ${m.channels} 个频道在做视频，热度是在线人数的 ${m.ratio} 倍（Hole Fishing 模型${demandNote}）`,
        data: { verdict: verified?.verdict ?? m.flag, signals: { ...robloxStats(name), demandVerdict: verified?.verdict } } };
    }),
    ...steamTop.map((r) => {
      const [verdict, game, total, demand, structure, window, ad, longevity] = cells(r).map((c) => c.replace(/\*/g, ""));
      return { kind: "steam", line: "steam-invest", name: r.split("|")[2]?.trim(), text: `- **Steam** ${r.split("|")[2]?.trim()}：${r.split("|")[1]?.trim()}（总分 ${r.split("|")[3]?.replace(/\*/g, "").trim()}）`,
        data: { verdict, signals: { investScore: num(total), investDemand: num(demand), investStructure: num(structure), investWindow: num(window), investAd: num(ad), investLongevity: num(longevity), game: unlink(game) } } };
    }),
    ...followTop.map((r) => {
      const [verdict, game, followers, dailyGain, growth, release] = cells(r);
      return { kind: "steam", line: "steam-follow", name: unlink(game), text: `- **Steam 关注者** ${unlink(game)}：${verdict}（关注者 ${followers}，日增 ${dailyGain}，7 天 ${growth}，发售 ${release}）`,
        data: { verdict, signals: { followers: num(followers), followersDailyGain: num(dailyGain), followers7dGrowthPct: num(growth), release } } };
    }),
    // kind 不进 SIGNAL_KINDS：工具需求 / 投入价值本模块已经查过（写在这一行里），Steam 游戏基本没有 codes，不花 treg
    ...chartsTop.map((r) => {
      const [verdict, game, hits, release, , tool, invest] = cells(r);
      const extra = [tool && tool !== "-" && tool !== "工具需求 0" ? tool : "", invest && invest !== "-" ? `投入价值 ${invest}` : ""].filter(Boolean).join(" · ");
      const bestRank = Math.min(...[...hits.matchAll(/#(\d+)/g)].map((m) => Number(m[1])));
      return { kind: "steamcharts", line: "steam-charts", name: unlink(game), text: `- **Steam 畅销榜** ${unlink(game)}：${verdict.replace(/ 🆕$/, "")}（${hits.replace(/<br>/g, "；")}，发售 ${release}）${extra ? ` · ${extra}` : ""}`,
        data: { verdict, signals: { bestChartRank: Number.isFinite(bestRank) ? bestRank : undefined, charts: hits.replace(/<br>/g, "；").slice(0, 200), investScore: num(invest), release, toolDemandText: tool && tool !== "-" ? tool : undefined } } };
    }),
    ...suggestTop.map((r) => {
      const [, game, intents] = cells(r);
      return { kind: "suggest", line: "suggest-diff", name: game, text: `- **联想新词** ${game}：Google 联想刚冒出（${intents}）`, data: { verdict: cells(r)[0], signals: { intents } } };
    }),
    ...steadyFresh.map((row) => ({
      kind: "steady", line: "steady-rising", name: row.name,
      text: `- **稳涨冷门** ${row.name}（${row.kind === "wiki" ? "Wiki" : "H5"}）：${steadyNote(row)}`,
      data: { verdict: "🟡 观察", signals: { steadyKind: row.kind, steadyGrowths: row.growths, steadyRatio: row.ratio } },
    })),
    ...playableTop.map((r) => {
      const [verdict, , heat, growth, yoy, peak] = cells(r);
      return { line: "playable", name: r.split("|")[2]?.trim(), text: `- **可玩游戏** ${r.split("|")[2]?.trim()}：${r.split("|")[1]?.trim()}`,
        data: { verdict, signals: { heat: num(heat), growth: num(growth), yoy: num(yoy), peak } } };
    }),
    ...memeTop.map((r) => {
      const name = unlink(r.split("|")[2]);
      return { line: "meme", name, text: `- **梗** ${name}：刚冒头（${r.split("|")[3]?.trim()}）`, data: { verdict: cells(r)[0], signals: { playableCompletions: r.split("|")[3]?.trim() } } };
    }),
  ], rejectionLedger);
  // 新注册域名（whoisds 免费版，每天约 7 万个抽样）：同行开始抢注 = 热度确认 / 窗口在关
  const nrd = items.length ? await nrdCounts(items.map((i) => i.name)) : { available: false, byName: {}, dates: [] };
  // 官方限时活动（2026-10-24 加，lib/roblox-event.mjs）：月量估算不作数，标截止日
  for (const i of items.filter((x) => x.kind === "roblox" && x.data.signals.universeId)) {
    const ev = await robloxEvent(i.data.signals.universeId);
    if (!ev) continue;
    i.text += ` · ${eventNote(ev, { short: true })}，别买新域名`;
    i.data.signals.officialEvent = { endsAt: ev.endsAt?.toISOString().slice(0, 10) ?? null, daysLeft: ev.daysLeft };
  }
  const signals = await siteShapeSignals(items);
  const gaps = await serpGapSignals(items);
  const headline = items.map((i) => {
    const note = nrd.available ? nrdNote(nrd.byName[i.name], { days: nrd.dates.length }) : "";
    const text = note && nrd.byName[i.name] !== null ? `${i.text} · ${note}` : i.text;
    return [text, ...(signals.get(i) ?? []), gaps.get(i)].filter(Boolean).join(" · ");
  });

  const lines = [
    `# 游戏雷达总报告 ${today}`,
    "",
    "> `game-name-radar/radar.mjs` · Roblox + Steam（投入价值 / 关注者增速 / 畅销·在玩榜）+ 联想新词 + 可玩游戏 + 梗，一份报告 · 零搜索额度",
    "> 细节在各自的报告：RADAR-INVEST / RADAR-STEAMFOLLOW / RADAR-STEAMCHARTS / RADAR-SUGGEST / RADAR-PLAYABLE / RADAR-PLAYABLE-EARLY / RADAR-MEME（同日期）",
    "> 站型信号（2026-10-13 加）：🧮 工具需求 = Google 联想里 ≥2 条 value / calculator / trading 类补全（能做首页即工具的价值表 / 计算器站）· codes 媒体 N 家 = 「<游戏> codes」美国前 10 里讲这个游戏的大媒体数：0–1 📣 抢速度 / 2 🟡 / ≥3 ⛔ codes 别当主打（做实体页 / 工具页），只对 Roblox / 联想新词查（买断制 Steam 游戏无 codes 生态）；SERP 错配 = 结果页讲的是别的游戏，不算数",
    "> SERP 空位（2026-10-20 加，前 5 个 Roblox / Steam 候选）：🌐 语言空位 = 德法西意日韩里本地联想有人搜、前 10 本地语言页 ≤2（能用本地语言页抢）· 🕰️ = 美国前 10 有日期的页面 ≥60% 早于游戏最近更新（30 天内还在更新的按 30 天前算）；单次 SERP 会抖，是提示不是判决",
    `> 「近 3 天 N 个新域名」= whoisds 免费新注册域名列表里含这个名字的个数（每天约 7 万个抽样，0 不等于没人注册；⚠️ = ≥3 个，同行在抢）${nrd.available ? `；用的是 ${nrd.dates.join(" / ")}（UTC）` : "；今天没拿到列表"}`,
    "",
    "## 今天最值得看",
    "",
    ...(headline.length ? headline : ["今天没有达到「值得投入」线的候选。"]),
    "",
    "## Roblox",
    "",
  ];
  if (!roblox) {
    lines.push("（本次用了 --skip-roblox，没跑 Roblox 层）", "");
  } else {
    if (roblox.errors.length) lines.push(...roblox.errors.map((e) => `> ${e}`), "");
    lines.push("**需求验证**（成长期 + 错配里挑的前几名；Trends 曲线 + 量级 + 攻略子词）：", "");
    lines.push(
      ...table(
        "| 判决 | 游戏 | Trends | 量级（vs 锚点） | 子关键词 | 工具需求 |",
        roblox.demand.map((d) => `| ${d.verdict || "?"} | ${d.name} | ${d.trend} | ${d.magnitude || "-"} | ${d.sub} | ${toolDemandNote(d.tool, { examples: 1 }) || "-"} |`),
      ),
      "",
      "**YouTube 错配**（创作者跑得比玩家快）：",
      "",
      ...table(
        "| 信号 | 游戏 | 本周频道 | 热度÷在线 | 在线 |",
        roblox.mismatch.slice(0, 8).map((m) => `| ${m.flag} | ${m.name} | ${m.channels} | ${m.ratio} | ${m.ccu} |`),
      ),
      "",
      "**成长期 top 10**（增长比 = 当前在线 × 60 ÷ 日均访问；越高越是刚起量）：",
      "",
      ...table(
        "| 增长比 | 游戏 | 在线 | 上线天数 | 最近更新 |",
        roblox.growth.slice(0, 10).map((g) => `| ${g.growth}x | ${g.name} | ${g.ccu} | ${g.ageDays} 天 | ${g.updatedDaysAgo} 天前 |`),
      ),
      "",
      "**大而稳**（在线 5K–60K、增长 ≥3x、上线 ≤120 天，按在线排；上面没列的。前 2 个进需求验证）：",
      "",
      ...table(
        "| 增长比 | 游戏 | 在线 | 上线天数 | 最近更新 |",
        (roblox.steady ?? []).slice(0, 8).map((g) => `| ${g.growth}x | ${g.name} | ${g.ccu} | ${g.ageDays} 天 | ${g.updatedDaysAgo} 天前 |`),
      ),
      "",
    );
  }
  lines.push("## Steam（投入价值）", "");
  if (!invest) lines.push("（今天的 RADAR-INVEST 还没生成：每日管线 08:30 跑，可能没开机或还没跑完）", "");
  else lines.push(...table("| 判决 | 游戏 | 总分 | 需求 | 结构 | 窗口 | 广告 | 持续 | 信号 |", [...steamTop, ...steamWatch]), "");
  lines.push("## Steam 关注者增速（预发布 / 刚发售）", "");
  if (!follow) lines.push("（今天的 RADAR-STEAMFOLLOW 还没生成）", "");
  else lines.push(...table("| 判决 | 游戏 | 关注者 | 日增 | 7 天增长 | 发售 | 新注册域名 | 来源 |", rowsStartingWith(follow, ["🟢", "🌱", "🔵", "🟡"], 10)), "");
  lines.push("## Steam 畅销 / 在玩榜新上榜（刚发售）", "");
  if (!charts) lines.push("（今天的 RADAR-STEAMCHARTS 还没生成）", "");
  else lines.push(...table("| 判决 | 游戏 | 上榜信号 | 发售 | 标签 | 工具需求 | 投入价值 | 新注册域名 | 也在 |", rowsStartingWith(charts, ["🟢", "🌱"], 10)), "");
  lines.push("## Google 联想新冒出的游戏词", "");
  if (!suggest) lines.push("（今天的 RADAR-SUGGEST 还没生成）", "");
  else lines.push(...table("| 判决 | 游戏名 | 攻略意图 | 补全例子 | 首见 | 新注册域名 |", suggestTop), "");
  lines.push("## 可玩游戏（HTML5 起量）", "");
  if (!playable) lines.push("（今天的 RADAR-PLAYABLE 还没生成）", "");
  else lines.push(...table("| 判决 | 游戏 | 热度 | 增长 | 同比 | 峰值 | 前 5 国 | 首见 | 域名 |", playableTop), "");
  const earlyFile = readReport("PLAYABLE-EARLY");
  const earlySource = playable?.includes("| 🟡 早期") ? playable : earlyFile;
  const playableEarly = rowsStartingWith(earlySource, ["🟡 早期"], 8);
  lines.push("## 早期每日 / 社交（Trends 未成型，不当 🟢）", "");
  if (!earlySource) lines.push("（今天的早期每日还没生成）", "");
  else lines.push(...table("| 判决 | 游戏 | 综合 | S | M | N | L | C | 上线 | Trends | 嵌入路径 | 内容路径 | 开源部署 | 来源 | 备注 |", playableEarly), "");
  lines.push("## 稳涨冷门（只增加候选）", "");
  lines.push("> 最近 3 周每周 ≥+30% 且近 4 周均值 ≥ 前 4 周 2 倍；不设绝对量下限。独立补充入口，不改变现有候选、阈值或 GO 判决；首次 / 重新进入才进头条。", "");
  lines.push(...table("| 类型 | 游戏 | 趋势 |", steadyRows.slice(0, 20).map((row) => `| ${row.kind === "wiki" ? "Wiki" : "H5"} | ${row.name} | ${steadyNote(row)} |`)), "");
  lines.push("## 梗游戏", "");
  if (!meme) lines.push("（今天的 RADAR-MEME 还没生成）", "");
  else lines.push(...table("| 判决 | 梗 | 各市场可玩补全 | 例子 | 来源 | 首见 | 域名 |", memeTop), "");

  const out = reportPath(`RADAR-${today}.md`);
  writeFileSync(out, `${lines.join("\n")}\n`);
  console.log(`✓ ${out}`);
  const logged = writeVerdictLog(items, { date: today, nrd });
  if (logged) console.log(`✓ 判决记录 ${logged} 条 → data/verdict-log.jsonl`);
  console.log(headline.length ? headline.join("\n") : "今天没有达到「值得投入」线的候选。");

  // 每日成功跑完推一次「今天最值得看」（008-10-10 复盘：GO 只写进报告文件没人看，
  // 用户 10-08 的 GO 到 10-10 才知道）。失败重试由 daily.sh 管，这里只管内容推送。
  if (process.env.RADAR_NOTIFY === "1" && headline.length) {
    // 2026-10-12：以前只推前 4 条（macOS 通知装不下），Roblox 一多新源（Steam 关注者 / 联想新词）就挤不进来。
    // 现在走飞书：按信号线分组，每组最多 4 条，其余写「还有 N 条」，完整版在报告里。
    const groups = new Map();
    for (const h of headline) {
      const line = h.match(/^- \*\*(.+?)\*\*/)?.[1] ?? "其他";
      groups.set(line, [...(groups.get(line) ?? []), h.replace(/^- \*\*.+?\*\*\s*/, "").replace(/（[^（）]{60,}）/g, "")]);
    }
    const body = [...groups].map(([line, items]) => [`**${line}**`, ...items.slice(0, 4).map((i) => `- ${i}`),
      ...(items.length > 4 ? [`- …还有 ${items.length - 4} 条`] : [])].join("\n"));
    notify(`🎮 游戏雷达日报 ${today.slice(5)}（${headline.length} 条）`, `${body.join("\n\n")}\n\n完整报告：\`Ship/reports/summary/RADAR-${today}.md\``, "Glass");
  }
}

// ─── 单查：自动判平台 ─────────────────────────────────────────────────────────

const norm = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, "");

/**
 * SERP 空位（2026-10-20 加，lib/serp-gap.mjs）：🌐 本地语言空位 + 🕰️ 前 10 过时。
 * 只查「今天最值得看」前 5 个 Roblox / Steam 候选（每个约 $0.001，缓存 3 天）；没空位不写，失败只在那一条上标，绝不抛。
 */
export async function serpGapSignals(items, { limit = 5, gap = serpGap } = {}) {
  const out = new Map();
  for (const i of items.filter((x) => (x.kind === "roblox" || x.kind === "steam") && x.name).slice(0, limit)) {
    try {
      const hit = i.kind === "roblox" ? await onRoblox(i.name) : await onSteam(i.name);
      const updatedAt = hit ? await (i.kind === "roblox" ? robloxUpdated(hit.universeId) : steamUpdated(hit.appId)) : null;
      const note = serpGapNote(await gap(hit?.name ?? i.name, { kind: i.kind, updatedAt }));
      if (note) out.set(i, note);
    } catch {
      out.set(i, "SERP 空位 查询失败");
    }
  }
  return out;
}

/** 判平台用的查询偶尔会超时（代理抖一下就漏判），失败重试两次。 */
async function fetchJson(url, attempts = 3) {
  for (let i = 0; i < attempts; i += 1) {
    try {
      const res = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0" }, signal: AbortSignal.timeout(20_000) });
      if (res.ok) {
        return await res.json();
      }
    } catch {
      // 重试
    }
    await new Promise((r) => setTimeout(r, 1500 * (i + 1)));
  }
  return null;
}

export async function onRoblox(name) {
  const d = await fetchJson(
    `https://apis.roblox.com/search-api/omni-search?searchQuery=${encodeURIComponent(name)}&sessionId=radar&pageType=all`,
  );
  const games = (d?.searchResults ?? []).flatMap((g) => g.contents ?? []).filter((c) => c.contentType === "Game");
  // 只认名字对得上的：完全一致，或包含查询词且有一定在线（防「Dressmaker」匹到 11 人在线的同名小游戏）。
  // 用包含不用开头：真名常带「+1 / Upd / 🔥」前缀，「Assassin Leveling」要能匹到「+1 Assassin Leveling」
  const q = norm(cleanRobloxName(name));
  const hit = games.find((g) => {
    const n = norm(cleanRobloxName(g.name ?? ""));
    return n === q || (n.includes(q) && (g.playerCount ?? 0) >= 300);
  });
  return hit ? { name: cleanRobloxName(hit.name), playing: hit.playerCount ?? 0, universeId: hit.universeId } : null;
}

async function onSteam(name) {
  const d = await fetchJson(`https://store.steampowered.com/api/storesearch/?term=${encodeURIComponent(name)}&cc=US&l=en`);
  const hit = (d?.items ?? []).find((i) => norm(i.name) === norm(name) || norm(i.name).startsWith(norm(name)));
  return hit ? { appId: hit.id, name: hit.name } : null;
}

async function check(names) {
  for (const name of names) {
    const [roblox, steam] = await Promise.all([onRoblox(name), onSteam(name)]);
    console.log(`\n════ ${name} ════`);
    console.log(
      `平台：${[roblox && `Roblox（${roblox.name}，在线 ${roblox.playing}）`, steam && `Steam（${steam.name}，appid ${steam.appId}）`].filter(Boolean).join(" + ") || "Roblox / Steam 都没有 → 按可玩游戏 / 梗查"}`,
    );
    const event = roblox ? await robloxEvent(roblox.universeId) : null;
    if (event) console.log(eventNote(event));
    if (roblox) {
      console.log("\n── Roblox 需求验证");
      console.log(await run("lib/roblox-demand-scan.mjs", [roblox.name]));
    }
    if (steam) {
      console.log("── Steam 工具闸门");
      console.log(await run("lib/steam-gate.mjs", [steam.name]));
      console.log("── Steam 投入价值");
      console.log(await run("lib/invest-score.mjs", [String(steam.appId), steam.name]));
    }
    if (roblox || steam) {
      // 站型信号（2026-10-13 加）：Steam 的工具需求已经算进上面的投入价值「结构」里，这里两条线一起再列一次
      const game = roblox?.name ?? steam.name;
      const [t, c] = await Promise.all([
        toolDemand(game).catch(() => ({ ok: false })),
        codesMediaBatch([game]).then((m) => m.get(game)).catch(() => null),
      ]);
      console.log("── 站型信号");
      console.log(`   ${toolDemandNote(t, { examples: 4 }) || "工具需求 0"}`);
      console.log(`   ${c ? c.label : "codes 媒体 查询失败"}${c?.media?.length ? `（${c.media.join(" / ")}）` : ""}${c?.cached ? "（缓存）" : ""}\n`);
      // SERP 空位（2026-10-20 加）：本地语言市场有人搜、前 10 没本地页 / 前 10 早于游戏更新
      const kind = roblox ? "roblox" : "steam";
      const updatedAt = roblox ? await robloxUpdated(roblox.universeId) : await steamUpdated(steam.appId);
      console.log("── SERP 空位（🌐 本地语言 / 🕰️ 过时）");
      console.log(`${serpGapDetail(await serpGap(game, { kind, updatedAt }).catch(() => null))}\n`);
    }
    if (!(roblox || steam)) {
      console.log("── 可玩游戏走势");
      console.log(await run("lib/playable-trend-watch.mjs", [name]));
      console.log("── 梗雷达（高 CPM 市场本地语言联想）");
      console.log(await run("lib/meme-game-watch.mjs", [name]));
    }
  }
}

// ─── 早间快扫：只跑 Roblox 增长 + 错配，首次出现的强候选弹通知 ───────────────────
//
// 背景（2026-10-10 复盘）：Anime Zero 起量窗口正好撞上管线断档，竞品 10-03 建站、
// 我们 10-08 才扫到。现在每天 12:30 的主管线之外，09:00 加一班只看 Roblox 榜单的
// 快扫（不花 Trends 额度）：刚冒头的强候选第一次出现就推通知。
async function morning() {
  const [growthText, mismatchText] = await Promise.all([
    run("lib/roblox-growth-scan.mjs"),
    run("lib/roblox-yt-mismatch.mjs"),
  ]);
  const growth = parseGrowth(growthText);
  const steady = parseSteady(growthText);
  const mismatch = parseMismatch(mismatchText);

  const hot = [
    ...mismatch
      .filter((m) => m.flag === "🎣🎣" && m.channels >= 5 && m.ccu >= 300)
      .map((m) => ({ id: m.id, name: cleanRobloxName(m.name), why: `错配 ${m.ratio}x（${m.channels} 频道 / ${m.ccu} 在线）` })),
    ...growth
      .filter((g) => g.growth >= 8 && g.ccu >= 300 && g.ccu <= 60000)
      .map((g) => ({ id: g.id, name: cleanRobloxName(g.name), why: `增长 ${g.growth}x（${g.ccu} 在线 / ${g.ageDays} 天）` })),
    ...steady.map((g) => ({ id: g.id, name: cleanRobloxName(g.name), why: `大而稳 ${g.ccu} 在线、增长 ${g.growth}x（${g.ageDays} 天）` })),
  ];

  const stateFile = join(HERE, "data", "roblox-morning-state.json");
  const prev = readData("roblox-morning-state.json", null);
  const seen = new Set(prev?.seen ?? []);
  const fresh = hot.filter((h) => !seen.has(h.id));
  for (const f of fresh.slice(0, 8)) {
    const ev = await robloxEvent(f.id);
    if (ev) f.why += ` · ${eventNote(ev, { short: true })}`;
  }
  // 只留最近 500 个 id，防止状态文件无限长大
  const keep = [...new Set([...seen, ...hot.map((h) => h.id)])].slice(-500);
  writeFileSync(stateFile, JSON.stringify({ scannedAt: new Date().toISOString(), hot: hot.length, seen: keep }, null, 2));

  console.log(`早扫：强候选 ${hot.length} 个 · 首次出现 ${fresh.length} 个`);
  for (const f of fresh.slice(0, 8)) console.log(`  🆕 ${f.name} — ${f.why}`);

  if (!prev) {
    console.log("（首次运行，只建基线，不通知）");
    return;
  }
  if (fresh.length) {
    notify(
      `🆕 早间扫描：${fresh.length} 条更新`,
      fresh.slice(0, 3).map((f) => `${f.name}（${f.why}）`).join("\n"),
      "Glass",
    );
  }
}

const IS_MAIN = import.meta.url === `file://${process.argv[1]}` || Boolean(process.argv[1]?.endsWith("radar.mjs"));
if (IS_MAIN) {
  if (args[0] === "check") {
    const names = args.slice(1).filter((a) => !a.startsWith("--"));
    if (!names.length) {
      console.error('用法：node radar.mjs check "游戏名" ["游戏名2" ...]');
      process.exit(1);
    }
    await check(names);
  } else if (args.includes("--morning")) {
    await morning();
  } else {
    await daily();
  }
}
