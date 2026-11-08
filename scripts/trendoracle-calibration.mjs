#!/usr/bin/env node
/**
 * TrendOracle 校准 — 用外部词源量我们雷达的「抓取率 + 提前量 + 判决」。
 *
 * 定位（2026-10-11 用户定）：TrendOracle 不当词源用，当**标尺**用——
 * 它是独立第三方的新词信号（group0 免费档，每天 3 词）。把它的词拿回候选池对：
 *   抓到了吗？比它早几天？我们当时判了什么？
 * 累积成覆盖率 / 提前量统计，衡量雷达精度是提升了还是退步了。
 *
 * 用法：node scripts/trendoracle-calibration.mjs          # 全部历史
 *      node scripts/trendoracle-calibration.mjs 7        # 最近 7 天
 * 输出：终端表格 + Ship/out/trendoracle/CALIBRATION.md（累积）
 */
import { readFileSync, writeFileSync, readdirSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { listReports } from "../../scripts/lib/reports.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..");
const SHIP = join(ROOT, "..");
const TO_DIR = join(SHIP, "out", "trendoracle");
const CAND = join(ROOT, "data", "candidates.json");
const OUT = join(TO_DIR, "CALIBRATION.md");

const days = Number(process.argv[2]) || 3650;
const cutoff = new Date(Date.now() - days * 86400e3).toISOString().slice(0, 10);

const norm = (s) => String(s).toLowerCase().replace(/[^a-z0-9]/g, "");
const day = (d) => new Date(d).toISOString().slice(0, 10);
const daysBetween = (a, b) => Math.round((Date.parse(a) - Date.parse(b)) / 86400e3);

// ─── 候选池（唯一对照面）────────────────────────────────────────────────────
const raw = JSON.parse(readFileSync(CAND, "utf8"));
const items = Array.isArray(raw) ? raw : raw.candidates || raw.items || [];
const pool = items.map((c) => ({
  name: c.gameName,
  norm: norm(c.gameName),
  firstSeen: c.firstSeen,
  lastSeen: c.lastSeen,
  recommendation: c.recommendation || c.status || "?",
  seo: c.seo?.classification || "?",
  sources: (c.sources || []).map((s) => s.kind),
  best: Math.min(...(c.sources || []).map((s) => s.bestRank ?? s.currentRank ?? 999).filter((n) => Number.isFinite(n)), 999),
}));

/** 匹配：精确 → 包含（≥5 字符防误配）。返回最好是 firstSeen 最早的那个。 */
function findInPool(keyword) {
  const k = norm(keyword);
  const hits = pool.filter((p) => {
    if (!p.norm || p.norm.length < 4) return false;
    if (p.norm === k) return true;
    if (k.length >= 5 && p.norm.includes(k)) return true;
    if (p.norm.length >= 5 && k.includes(p.norm)) return true;
    return false;
  });
  hits.sort((a, b) => Date.parse(a.firstSeen || 0) - Date.parse(b.firstSeen || 0));
  return hits[0] || null;
}

// 报告文本层：词出现过的雷达产出（区分「独立抓到」vs「推送后才被人处理过」）
const reportFiles = listReports().filter((r) => /^(RADAR|GAME-SCAN|OCCUPY)/.test(r.name)).map((r) => r.path);
for (const dir of [SHIP, ROOT]) { // 老位置（2026-10-23 前在 Ship 根目录）还有残留也照读
  try {
    for (const f of readdirSync(dir)) {
      if (/\.(md)$/.test(f) && /^(RADAR|GAME-SCAN|OCCUPY)/.test(f)) reportFiles.push(join(dir, f));
    }
  } catch {}
}
const reportText = reportFiles.map((f) => ({ f: f.split("/").pop(), t: readFileSync(f, "utf8").toLowerCase() }));
function findInReports(keyword) {
  const k = keyword.toLowerCase();
  return reportText.filter((r) => r.t.includes(k)).map((r) => r.f).slice(0, 2);
}

// 人工处理记录（GAME-DECISIONS = 推送后才处理，不算独立抓取，但供审计）
let decisionsText = "";
try { decisionsText = readFileSync(join(SHIP, "GAME-DECISIONS.md"), "utf8").toLowerCase(); } catch {}
const inDecisions = (keyword) => decisionsText.includes(keyword.toLowerCase());

// ─── 读 TrendOracle 全部存档 ─────────────────────────────────────────────────
const files = readdirSync(TO_DIR).filter((f) => /^\d{4}-\d{2}-\d{2}\.json$/.test(f)).sort();
const rows = [];
for (const f of files) {
  const d = JSON.parse(readFileSync(join(TO_DIR, f), "utf8"));
  if (!d.words?.length) continue;
  const pushDate = d.date || f.slice(0, 10);
  if (pushDate < cutoff) continue;
  for (const w of d.words) {
    const hit = findInPool(w.keyword);
    const leadDays = hit?.firstSeen ? daysBetween(pushDate, day(hit.firstSeen)) : null;
    rows.push({
      pushDate,
      keyword: w.keyword,
      platform: w.platform ?? "-", // 2026-11-08：TrendOracle 有的词没给平台，null 让 141 行 padEnd 崩（11-02 那次）
      kd: w.kd,
      volume: w.search_volume_estimate,
      peakIn7d: w.trend_peak && daysBetween(pushDate, w.trend_peak.date) >= -7 && w.trend_peak.daysBeforeEnd <= 0,
      hit,
      leadDays,
      reports: findInReports(w.keyword),
      decided: inDecisions(w.keyword),
    });
  }
}

// ─── 输出 ────────────────────────────────────────────────────────────────────
const covered = rows.filter((r) => r.hit);
const missed = rows.filter((r) => !r.hit);
const leads = covered.filter((r) => r.leadDays != null);
const avgLead = leads.length ? (leads.reduce((a, r) => a + r.leadDays, 0) / leads.length).toFixed(1) : "—";

const line = (r) => {
  const rep = r.reports.length ? r.reports.join(", ") : "—";
  const dec = r.decided ? " · 已入决策记录" : "";
  if (!r.hit) return `| ${r.pushDate} | ${r.keyword} | ${r.platform} | ❌ 未独立抓到 | 报告提及：${rep}${dec} |`;
  const src = [...new Set(r.hit.sources)].slice(0, 2).join("+");
  return `| ${r.pushDate} | ${r.keyword} | ${r.platform} | ✅ ${day(r.hit.firstSeen)}（${r.leadDays >= 0 ? "早 " + r.leadDays : "晚 " + -r.leadDays} 天） | ${r.hit.recommendation}/${r.hit.seo} | ${src}${r.hit.best < 999 ? ` #${r.hit.best}` : ""} |`;
};

const md = [];
md.push(`# TrendOracle 校准（更新 ${new Date().toISOString().slice(0, 16)}）`);
md.push("");
md.push(`> 标尺：TrendOracle group0 每日 3 词（独立第三方）。对照面：我们的候选池（data/candidates.json）。`);
md.push(`> 「早 N 天」= 我们 firstSeen 早于 TrendOracle 推送；负数 = 比它晚。`);
md.push("");
md.push(`**覆盖率：${covered.length}/${rows.length}（${rows.length ? Math.round((covered.length / rows.length) * 100) : 0}%）· 平均提前量：${avgLead} 天 · 未抓到：${missed.length} 个**`);
md.push("");
md.push("| 推送日 | 词 | 平台 | 我们（候选池） | 当时判决 | 来源 |\n|---|---|---|---|---|---|");
for (const r of rows.sort((a, b) => (a.pushDate < b.pushDate ? 1 : -1))) md.push(line(r));
md.push("");
md.push("## 未独立抓到的词（雷达盲区清单）");
for (const r of missed) md.push(`- **${r.keyword}**（${r.platform}，${r.pushDate} 推送，KD ${r.kd}，估量 ${r.volume}）· 报告提及：${r.reports.join(", ") || "无"}${r.decided ? " · 已入决策记录（推送后处理）" : ""}`);
md.push("");
writeFileSync(OUT, md.join("\n"));

console.log(`覆盖 ${covered.length}/${rows.length}（${rows.length ? Math.round((covered.length / rows.length) * 100) : 0}%）· 平均提前 ${avgLead} 天 · 未抓到 ${missed.length}`);
for (const r of rows.sort((a, b) => (a.pushDate < b.pushDate ? 1 : -1))) {
  const mark = r.hit ? `✅ ${r.leadDays >= 0 ? `早${r.leadDays}天` : `晚${-r.leadDays}天`}` : "❌ 未独立抓到";
  const verdict = r.hit ? `（${r.hit.recommendation}/${r.hit.seo}）` : r.reports.length ? `（报告提及 ${r.reports[0]}）` : "";
  console.log(`  ${r.pushDate} ${String(r.keyword).slice(0, 30).padEnd(32)} ${r.platform.padEnd(7)} ${mark} ${verdict}`);
}
console.log(`→ ${OUT}`);
