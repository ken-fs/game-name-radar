/**
 * prior-verdict.mjs — has GAME-DECISIONS judged this game ❌ lately, and why? Used by codes-pick.mjs.
 *
 * 2026-11-09 split out of codes-pick.mjs after Evermore High was pushed as "能做" on 11-09 although 11-05 had
 * judged it ❌ for having 6 dedicated sites. Two bugs:
 *   1. a prior ❌ never blocked (on purpose, see below), so a competition verdict came back every day;
 *   2. the warning quoted the first 90 chars of the LINE, and that line listed a dozen games, so it showed
 *      "Ebbtide / Mycelarium / …" and cut off the actual reason.
 *
 * Now the reason decides:
 *   - competition (dedicated sites, "晚了", taken / full): blocks. Competitors don't go away on their own.
 *   - demand (spike faded, low CCU, no guide terms…): only warns. Demand comes back:
 *     Cut a Rock was judged "faded after launch" on 10-31 and grew 14x with 13K online on 11-02.
 * The excerpt starts at the game's name and stops at the end of that clause.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/** Reasons about the SERP being taken. Anything else (demand, data, attribution) is treated as "may change". */
const COMPETITION = /专门站|专用站|晚了|已占|占满|已进场|被占/;

/** "a / b / Evermore High ❌（已有 5 / 6 个专门站，这次补进账本）。xxx" → "Evermore High ❌（已有 5 / 6 个专门站，这次补进账本）" */
export function excerpt(line, name) {
  const i = line.toLowerCase().indexOf(name.toLowerCase());
  if (i < 0) return line.replace(/^[#\-*\s]+/, '').slice(0, 120);
  let s = line.slice(i);
  // End of the clause: a full-width sentence / clause break that is not inside the reason's parentheses.
  let depth = 0;
  for (let k = 0; k < s.length; k++) {
    const ch = s[k];
    if (ch === '（' || ch === '(') depth++;
    else if (ch === '）' || ch === ')') depth = Math.max(0, depth - 1);
    else if (depth === 0 && (ch === '。' || ch === '；' || ch === ';')) { s = s.slice(0, k); break; }
  }
  return s.replace(/\*+/g, '').trim().slice(0, 120);
}

/**
 * Most recent ❌ / 晚了 verdict for `name` within `days` of `date` (YYYY-MM-DD), or null.
 * Returns { date, text, competition }; `competition: true` means the caller should not recommend the game.
 */
export function recentRejection(name, { date, days = 14, ship }) {
  const since = new Date(Date.parse(date) - days * 864e5).toISOString().slice(0, 10);
  const needle = name.toLowerCase();
  for (const f of ['GAME-DECISIONS.md', 'GAME-DECISIONS-ARCHIVE.md']) {
    let txt = '';
    try {
      txt = readFileSync(join(ship, f), 'utf8');
    } catch {
      continue;
    }
    let d = '';
    for (const line of txt.split('\n')) {
      const h = line.match(/^## (\d{4}-\d{2}-\d{2})/);
      if (h) d = h[1];
      if (!d || d < since || d > date) continue;
      if (line.startsWith('|')) continue; // the index table at the top repeats titles without reasons
      if (!line.toLowerCase().includes(needle) || !/❌|晚了/.test(line) || /✅ 建站/.test(line)) continue;
      const text = excerpt(line, name);
      // Judged on this game's own clause only: a line that lists several games mixes several reasons.
      const competition = COMPETITION.test(text);
      return { date: d, text, competition };
    }
  }
  return null;
}
