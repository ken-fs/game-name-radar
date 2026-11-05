import { test } from "node:test";
import assert from "node:assert/strict";
import { classifySerp, domainVariants, fleetHit, mainName, parseHeadlineLine } from "../lib/headline-gate.mjs";

test("mainName drops Steam subtitle and trademark signs", () => {
  assert.equal(mainName("Probably Stolen - Cyberpunk Shopkeeper Sim"), "Probably Stolen");
  assert.equal(mainName("Guild Wars® Afterlife™"), "Guild Wars Afterlife");
});

test("classifySerp counts dedicated sites and wiki farms, ignores media", () => {
  const results = [
    { link: "https://ebbtide-game.wiki/guides/x" },
    { url: "https://www.ebbtidegame.org/" },
    { link: "https://www.youtube.com/watch?v=1" },
    { link: "https://gamerant.com/ebbtide-guide/" },
    { link: "https://ebbtide.fandom.com/wiki/Main" },
    { link: "https://evermoorchronicles.fandom.com/wiki/X" },
  ];
  const r = classifySerp(results, "Ebbtide");
  assert.deepEqual(r.dedicated.sort(), ["ebbtide-game.wiki", "ebbtidegame.org"]);
  assert.deepEqual(r.farms, ["ebbtide.fandom.com"]);
});

test("domainVariants covers the shapes competitors registered on 11-05", () => {
  const v = domainVariants("evermorehigh", "evermore-high");
  for (const d of ["evermorehigh.wiki", "evermorehighwiki.wiki", "evermore-high-wiki.wiki", "evermore-high.wiki"]) assert.ok(v.includes(d), d);
});

test("fleetHit matches our own site by stem", () => {
  assert.equal(fleetHit("krillion", ["krillionanswers.xyz", "holefishing.com"]), "krillionanswers.xyz");
  assert.equal(fleetHit("Ebbtide", ["krillionanswers.xyz"]), null);
});

test("parseHeadlineLine reads platform, name and new-domain count", () => {
  const i = parseHeadlineLine("- **Steam 畅销榜** Playrooms：📈 冲榜（美国实时畅销 #64） · ⚠️ 近 3 天 3 个新域名（同行在抢）：a.wiki");
  assert.equal(i.kind, "steamcharts");
  assert.equal(i.name, "Playrooms");
  assert.equal(i.nrd, 3);
  assert.equal(parseHeadlineLine("今天 0 条过闸"), null);
});
