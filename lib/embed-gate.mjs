#!/usr/bin/env node
// 嵌壳闸门（2026-11-04 起本机每日管线跑，替代 Grok Bot 工作日 10:30 的人工日筛；用户 11-04 把这件事从 Grok Bot 撤下，Grok 仍负责外链提交）
//
// 读当天 reports/playable/RADAR-PLAYABLE-<日期>.md 的 🟢 机会，按嵌壳闸门标：
//   GO   = 可以开嵌壳站（有 GameDistribution / GameMonetize / Scratch 授权嵌源、不是大厂 IP、门户没霸榜、舰队没有）
//   弃   = 大厂 IP / 非授权移植 / 禁止第三方嵌入 / 门户原版霸榜
//   已有 = 舰队里已经有这个游戏的站
//   待判 = 以上都没认出来，要人看一眼（后台「今天要你拍板」会列出来）
// 判过的游戏记在 data/embed-gate.json，之后每天沿用，不重判（同一批 🟢 会连着出现几周）。
// 结果写回同一份报告的「## 嵌壳闸门」小节（有就替换），站群后台 dash.dispatchgame.pro 从那里读。
//
// 用法：
//   node lib/embed-gate.mjs [--date=YYYY-MM-DD]            跑当天（默认今天）
//   node lib/embed-gate.mjs set "<游戏>" GO|弃|已有 "原因"   记一条人工判决（之后每天沿用）
//   node lib/embed-gate.mjs list                            看全部已判

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { REPORTS, SHIP } from '../../scripts/lib/reports.mjs';
import { BIG_IP } from './big-ip.mjs';
import { emit, slug } from '../../scripts/lib/autoloop.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const STORE = join(HERE, '..', 'data', 'embed-gate.json');
const VERDICTS = ['GO', '弃', '已有'];

// 大厂 / 知名 IP 关键词在 big-ip.mjs（头条闸门也用）

const compact = (s) => String(s).toLowerCase().replace(/[^a-z0-9]/g, '');
const today = () => new Date(Date.now() + 8 * 3600e3).toISOString().slice(0, 10); // 北京日期，和管线一致
const loadStore = () => (existsSync(STORE) ? JSON.parse(readFileSync(STORE, 'utf8')) : {});
const saveStore = (s) => writeFileSync(STORE, `${JSON.stringify(s, null, 2)}\n`);

// 舰队域名：SITES.md（每日巡检生成）第 2 列 = 域名
function fleetDomains() {
  const p = join(SHIP, 'SITES.md');
  if (!existsSync(p)) return [];
  return readFileSync(p, 'utf8').split('\n').filter((l) => l.startsWith('| ') && !l.startsWith('| 站') && !l.startsWith('|---'))
    .map((l) => l.split('|')[2]?.trim()).filter((d) => d && d.includes('.'));
}

// GAME-DECISIONS 索引 + 正文：名字出现在「放弃 / 不做 / 弃」的条目里 = 判过不做
function decisionHit(name) {
  for (const f of ['GAME-DECISIONS.md', 'GAME-DECISIONS-ARCHIVE.md']) {
    const p = join(SHIP, f);
    if (!existsSync(p)) continue;
    const line = readFileSync(p, 'utf8').split('\n').find((l) => l.toLowerCase().includes(name.toLowerCase()) && /放弃|不做|❌|弃/.test(l));
    if (line) return { file: f, line: line.replace(/\s+/g, ' ').slice(0, 140) };
  }
  return null;
}

function judge(name, store, fleet) {
  const key = name.toLowerCase();
  if (store[key]) return { ...store[key], carried: true };
  const c = compact(name);
  const site = fleet.find((d) => {
    const stem = compact(d.split('.')[0]);
    return stem.length >= 5 && c.length >= 5 && (stem.includes(c) || c.includes(stem));
  });
  if (site) return { verdict: '已有', reason: `舰队已有 ${site}`, by: 'auto' };
  const ip = BIG_IP.find((k) => key.includes(k));
  if (ip) return { verdict: '弃', reason: `大厂 / 知名 IP（${ip}）：授权方不给第三方嵌入，浏览器版多是非授权移植`, by: 'auto' };
  const dec = decisionHit(name);
  if (dec) return { verdict: '弃', reason: `${dec.file} 判过不做：${dec.line}`, by: 'auto' };
  return { verdict: '待判', reason: '没有自动认出：看 Poki / CrazyGames 是不是原版霸榜、有没有 GD / GM / Scratch 授权嵌源，判完用 `embed-gate.mjs set` 记下', by: 'auto' };
}

function run(date) {
  const p = join(REPORTS, 'playable', `RADAR-PLAYABLE-${date}.md`);
  if (!existsSync(p)) { console.log(`嵌壳闸门：没有 ${date} 的可玩游戏报告，跳过`); return; }
  let text = readFileSync(p, 'utf8');
  const greens = text.split('\n').filter((l) => l.startsWith('| 🟢')).map((l) => l.split('|')[2]?.trim()).filter(Boolean);
  const store = loadStore();
  const fleet = fleetDomains();
  const rows = greens.map((g) => ({ name: g, ...judge(g, store, fleet) }));
  // 自动认出的「已有 / 弃」也入库，之后沿用；「待判」不入库，每天重新认
  for (const r of rows) if (!r.carried && r.verdict !== '待判') store[r.name.toLowerCase()] = { verdict: r.verdict, reason: r.reason, at: date, by: r.by };
  saveStore(store);
  const go = rows.filter((r) => r.verdict === 'GO');
  const pending = rows.filter((r) => r.verdict === '待判');
  const section = [
    `## 嵌壳闸门（本机 embed-gate.mjs · ${date}）`,
    '',
    '对当日 🟢 机会按嵌壳闸门标 GO / 弃 / 已有 / 待判（大厂 IP · 舰队已有 · 门户霸榜 · 仅 GD/GM/Scratch 授权源）。判过的沿用 `data/embed-gate.json`，标「沿用」。',
    '',
    '| 游戏 | 判决 | 原因 |',
    '|---|---|---|',
    ...rows.map((r) => `| ${r.name} | ${r.verdict}${r.carried ? '（沿用）' : ''} | ${r.reason.replace(/\|/g, '/')} |`),
    '',
    `**今日结论**：${!rows.length ? '今天没有 🟢。' : go.length ? `GO ${go.length} 个：${go.map((r) => r.name).join('、')}。` : '无 GO，没有可开的嵌壳站。'}${pending.length ? ` 待判 ${pending.length} 个：${pending.map((r) => r.name).join('、')}。` : ''}`,
    '',
  ].join('\n');
  text = /^## 嵌壳闸门/m.test(text)
    ? text.replace(/^## 嵌壳闸门[\s\S]*?(?=^## (?!嵌壳闸门)|(?![\s\S]))/m, `${section}\n`)
    : `${text.trimEnd()}\n\n${section}`;
  writeFileSync(p, text);
  console.log(`嵌壳闸门 ${date}：🟢 ${rows.length} 个 · GO ${go.length} · 待判 ${pending.length} · ${rows.map((r) => `${r.name}=${r.verdict}`).join(' ')}`);
  return { pending, report: p };
}

// 2026-11-05：每个「待判」交给 agent-autoloop 中台 → Claude 查证据、发飞书卡片 GO / 弃 / 已有，点完自动 set（Ship/docs/AUTOLOOP.md）。
// id 按游戏名固定：同一个游戏连着几天待判也只发一次。中台没开就跳过，后台「今天要你拍板」照旧列出。
async function handOff({ pending, report }, date) {
  for (const r of pending) {
    const id = `embed-gate:${slug(r.name)}`;
    const ok = await emit({
      id, type: 'decide.embed-gate', subject: id,
      summary: `嵌壳闸门待判：${r.name}`,
      detail: `游戏：${r.name}\n日期：${date}\n报告：${report.replace(`${SHIP}/`, '')}\n脚本给的原因：${r.reason}`,
    });
    console.log(`嵌壳闸门 → 中台 ${r.name}：${ok ? '已交' : '没交上（中台没开），留在后台待判'}`);
  }
}

const [cmd, ...rest] = process.argv.slice(2);
if (cmd === 'set') {
  const [name, verdict, reason = ''] = rest;
  if (!name || !VERDICTS.includes(verdict)) { console.error('用法：embed-gate.mjs set "<游戏>" GO|弃|已有 "原因"'); process.exit(1); }
  const store = loadStore();
  store[name.toLowerCase()] = { verdict, reason, at: today(), by: 'manual' };
  saveStore(store);
  console.log(`已记：${name} = ${verdict}（${reason}）`);
} else if (cmd === 'list') {
  for (const [k, v] of Object.entries(loadStore())) console.log(`${k}\t${v.verdict}\t${v.at}\t${v.by}\t${v.reason}`);
} else {
  const date = process.argv.find((a) => a.startsWith('--date='))?.slice(7) ?? today();
  const result = run(date);
  if (result?.pending.length) await handOff(result, date);
}
