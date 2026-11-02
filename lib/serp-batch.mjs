// 批量 SERP 查询（共享 Tavily 缓存 + 月度预算）
// 用法: node lib/serp-batch.mjs "query1" "query2" ...
import { tavilySearch } from './tavily-search.mjs';

async function search(q) {
  try {
    const { results, cached } = await tavilySearch(q);
    return { q, cached, results: results.map((x) => ({ t: x.title, u: x.url })) };
  } catch (error) {
    return { q, err: error.message };
  }
}

const out = [];
for (const q of process.argv.slice(2)) {
  out.push(await search(q));
  await new Promise((r) => setTimeout(r, 500));
}
for (const r of out) {
  console.log(`\n── ${r.q}${r.cached ? '（缓存）' : ''}`);
  if (r.err) { console.log('   ERR', r.err); continue; }
  for (const x of r.results) console.log(`   ${x.t}  |  ${x.u}`);
}
