/**
 * game-lookup.mjs — 查 Roblox / Steam 上有没有这个游戏、名字清洗、否决账本过滤（2026-11-05 从 radar.mjs 挪出，
 * radar.mjs 和 headline-gate.mjs 都用；radar.mjs 照旧 re-export）。
 */

const norm = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, "");

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
// 名字比对只看字母数字；Steam 名带「 - 副标题」的也按主名比（账本记「Probably Stolen」，
// 雷达报「Probably Stolen - Cyberpunk Shopkeeper Sim」——11-04 因为对不上，判过 ❌ 的又进了头条）
const ledgerKey = (s) => String(s).toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");
export function withoutRejected(items, ledger) {
  const rejected = new Set((ledger?.decisions ?? [])
    .filter((d) => d.name && d.status !== "flipped")
    .map((d) => ledgerKey(d.name)));
  return items.filter((i) => {
    const name = String(i.name);
    return !rejected.has(ledgerKey(name)) && !rejected.has(ledgerKey(name.split(/\s+[-–—]\s+/)[0]));
  });
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

export async function onSteam(name) {
  const d = await fetchJson(`https://store.steampowered.com/api/storesearch/?term=${encodeURIComponent(name)}&cc=US&l=en`);
  const hit = (d?.items ?? []).find((i) => norm(i.name) === norm(name) || norm(i.name).startsWith(norm(name)));
  return hit ? { appId: hit.id, name: hit.name } : null;
}
