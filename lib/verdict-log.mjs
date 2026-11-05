/**
 * verdict-log.mjs — 「今天最值得看」每条候选按固定字段记一行（2026-10-13 加）
 *
 * 为什么：全雷达复盘的「信号 → 结果」账本（Ship/scripts/radar-review/outcomes.mjs）要拿「报出当天的信号」
 * 和「建站后的点击」对比，好在样本攒到 20–30 个后按结果调打分权重。补录 9–10 月时发现很多信号雷达当时
 * 根本没记（实体数、YouTube 中位播放、codes 媒体数、工具需求……），只能从 md 表格里猜，写法还不统一。
 * 以后每天总报告跑完，把每条候选的原始数值写进 data/verdict-log.jsonl，账本直接读这份。
 *
 * 一行 = { date, line, name, verdict, signals: {...}, nrd3d, toolDemand, codesMedia, text }
 *   - signals 只放这条线当时真有的数（没有的字段就不写，不填 0）
 *   - 同一天同一条线同一个名字重跑 = 覆盖，不重复记
 * 绝不抛：写失败只在 stderr 提示，总报告照常出。
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
export const VERDICT_LOG = join(HERE, '..', 'data', 'verdict-log.jsonl');

/** 「12.3K」「1,234」「35x」「+20%」→ 数字；认不出 = undefined（不写进 signals） */
export function num(value) {
  if (value == null) return undefined;
  const m = String(value).replace(/,/g, '').match(/-?\d+(?:\.\d+)?/);
  if (!m) return undefined;
  const n = Number(m[0]);
  const unit = String(value).match(/\d\s*([KkMm万])\b|\d([KkMm万])$/)?.slice(1).find(Boolean);
  return unit ? n * ({ K: 1e3, k: 1e3, M: 1e6, m: 1e6, 万: 1e4 })[unit] : n;
}

const clean = (obj) => Object.fromEntries(Object.entries(obj).filter(([, v]) => v !== undefined && v !== null && v !== '' && !Number.isNaN(v)));

/** 一条候选 → 一行记录。item = { kind, name, text, data }；shape = siteShapeSignals 拿到的原始结果 */
export function toRecord(item, { date, nrd } = {}) {
  const tool = item.shape?.tool;
  const codes = item.shape?.codes;
  const n = nrd?.available ? nrd.byName?.[item.name] : undefined;
  return clean({
    date,
    line: item.line ?? item.kind ?? 'other',
    name: item.name,
    verdict: item.data?.verdict,
    signals: clean(item.data?.signals ?? {}),
    nrd3d: typeof n?.count === 'number' ? n.count : typeof n === 'number' ? n : undefined, // byName 给的是 { count, samples }（以前按数字认，一直没记上）
    gate: item.data?.gate ? clean({ pass: item.data.gate.pass, why: item.data.gate.why ?? undefined }) : undefined, // 头条闸门（2026-11-05 加），复盘拿来算「过闸 → 人工核完还剩几条」
    toolDemand: tool ? clean({ ok: tool.ok, count: tool.count }) : undefined,
    codesMedia: codes ? clean({ verdict: codes.verdict, n: codes.media?.length, media: codes.media?.length ? codes.media : undefined }) : undefined,
    text: item.text?.replace(/^- /, '').slice(0, 300),
  });
}

export function writeVerdictLog(items, { date, nrd, file = VERDICT_LOG } = {}) {
  try {
    const fresh = items.filter((i) => i.name).map((i) => toRecord(i, { date, nrd }));
    if (!fresh.length) return 0;
    const key = (r) => `${r.date}|${r.line}|${r.name.toLowerCase()}`;
    const replace = new Set(fresh.map(key));
    const old = existsSync(file)
      ? readFileSync(file, 'utf8').split('\n').filter(Boolean).filter((l) => {
        try { return !replace.has(key(JSON.parse(l))); } catch { return true; }
      })
      : [];
    writeFileSync(file, `${[...old, ...fresh.map((r) => JSON.stringify(r))].join('\n')}\n`);
    return fresh.length;
  } catch (error) {
    console.error(`判决记录没写进去：${error.message}`);
    return 0;
  }
}
