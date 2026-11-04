import assert from "node:assert/strict";
import { test } from "node:test";

import { cleanRobloxName, collectSteadyRising, parseDemand, parseGrowth, parseMismatch, parseSteady, signalLabel, withoutRejected } from "../radar.mjs";

test("cleanRobloxName strips update tags and emoji", () => {
  assert.equal(cleanRobloxName("[🐟UPDATE] Hole Fishing"), "Hole Fishing");
  assert.equal(cleanRobloxName("🎃 [HALLOWEEN EVENT] FNaF World Multiplaye"), "FNaF World Multiplaye");
  assert.equal(cleanRobloxName("Anime Zero [FLAME DIRECTOR] 🔥👻"), "Anime Zero");
  assert.equal(cleanRobloxName("Run a Sari-Sari Store!"), "Run a Sari-Sari Store");
  assert.equal(cleanRobloxName("+1 Assassin Leveling"), "Assassin Leveling");
});

test("已否决候选只有翻转后才重新进头条", () => {
  const items = [{ name: "Build A Zombie" }, { name: "Merkado" }, { name: "Hole Fishing" }];
  const ledger = { decisions: [
    { name: "Build A Zombie", status: "manual" },
    { name: "Merkado", status: "active" },
    { name: "Hole Fishing", status: "flipped" },
  ] };
  assert.deepEqual(withoutRejected(items, ledger), [{ name: "Hole Fishing" }]);
});

test("否决账本按主名匹配：大小写、标点、Steam 副标题都不影响", () => {
  const ledger = { decisions: [{ name: "Probably Stolen", status: "manual" }, { name: "Queen's Domain", status: "active" }] };
  const items = [{ name: "Probably Stolen - Cyberpunk Shopkeeper Sim" }, { name: "QUEENS DOMAIN" }, { name: "Probably Stolen Twice" }];
  assert.deepEqual(withoutRejected(items, ledger), [{ name: "Probably Stolen Twice" }]);
});

test("头条标签：热度信号不写成 🟢", () => {
  assert.equal(signalLabel("🟢 起量"), "📈 关注者起量");
  assert.equal(signalLabel(" 🟢 冲榜"), "📈 冲榜");
  assert.equal(signalLabel("🟢 值得投入"), "📊 投入分高");
  assert.equal(signalLabel("🟢 机会"), "📈 搜索在涨");
  assert.equal(signalLabel("🔔 预埋（发售前抢位）"), "🔔 预埋（发售前抢位）");
});

test("collectSteadyRising adds wiki and H5 candidates without filtering existing verdicts", () => {
  const signal = { match: true, growths: [0.5, 0.5, 0.556], ratio: 2.06 };
  const rows = collectSteadyRising(
    { candidates: [
      { gameName: "Slow Wiki", trend: { classification: "weak", steadyRising: signal } },
      { gameName: "Flat Wiki", trend: { steadyRising: { match: false } } },
    ] },
    { names: {
      "slow-h5": { trend: { steady: signal } },
      "flat-h5": { trend: { steady: { match: false } } },
    } },
  );
  assert.deepEqual(rows.map((row) => [row.kind, row.name]), [["wiki", "Slow Wiki"], ["h5", "slow-h5"]]);
});

test("parseGrowth reads the growth-scan table", () => {
  const rows = parseGrowth(
    "  增长比   CCU     日访问估  年龄   更新     游戏\n" +
      "   33.3x    4698     282K   156天    0天前  [🛒] Run a Sari-Sari Store!  [10126644530]\n" +
      "   13.3x   18371    1102K    84天    0天前  Anime Zero [FLAME DIRECTOR] 🔥👻  [10512942223]\n",
  );
  assert.equal(rows.length, 2);
  assert.deepEqual(rows[0], { ageDays: 156, ccu: 4698, growth: 33.3, id: "10126644530", name: "[🛒] Run a Sari-Sari Store!", updatedDaysAgo: 0 });
});

test("parseSteady reads only the ⚓ rows, parseGrowth skips them", () => {
  const text =
    "   13.3x   18371    1102K    84天    0天前  Anime Zero  [10512942223]\n" +
    "  ⚓   3.2x    7660     460K    87天    0天前  [PETS] Deep Fishing🎣  [10526853622]\n";
  assert.deepEqual(parseSteady(text).map((r) => [r.id, r.ccu, r.growth]), [["10526853622", 7660, 3.2]]);
  assert.deepEqual(parseGrowth(text).map((r) => r.id), ["10512942223"]);
});

test("parseMismatch keeps the fishing-rod flags", () => {
  const rows = parseMismatch("  🎣🎣   3.2       7     12,400    3109  [🐟UPDATE] Hole Fishing  [9906378607]\n  🎣   1.1  3  800  900  Foo  [1]\n");
  assert.equal(rows.length, 2);
  assert.equal(rows[0].flag, "🎣🎣");
  assert.equal(rows[0].channels, 7);
  assert.equal(rows[0].ratio, 3.2);
});

test("parseDemand pulls verdicts per game", () => {
  const rows = parseDemand(
    "── Drop a Fruit\n   Trends(codes): 形状=rising · 峰值 100\n   子关键词: guide-rich  攻略词[10]\n   判决: 🟢 GO — Trends 上升/高位稳住 + 子关键词含攻略词（双源确认）\n" +
      "── Run a Sari-Sari Store\n   判决: 🟡 观察 — Trends 未取到数据（可能限频）\n",
  );
  assert.equal(rows.length, 2);
  assert.equal(rows[0].verdict, "🟢 GO");
  assert.match(rows[0].trend, /rising/);
  assert.equal(rows[1].verdict, "🟡 观察");
});

test("parseDemand marks plain 放弃 with an icon", () => {
  const rows = parseDemand("── Foo\n   判决: 放弃 — Trends 一座尖峰后掉头，且无攻略长尾，短命热度\n");
  assert.equal(rows[0].verdict, "❌ 放弃");
});
