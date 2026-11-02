import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

test('Tavily cache deduplicates normalized queries and enforces one shared monthly budget', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'tavily-search-'));
  const oldFetch = globalThis.fetch;
  process.env.TAVILY_API_KEY = 'test-key';
  process.env.TAVILY_CACHE_FILE = join(dir, 'cache.json');
  process.env.TAVILY_USAGE_FILE = join(dir, 'usage.json');
  process.env.TAVILY_MONTHLY_LIMIT = '1';
  const { tavilySearch } = await import(`../lib/tavily-search.mjs?test=${Date.now()}`);
  let searches = 0;
  globalThis.fetch = async (url) => {
    if (String(url).endsWith('/usage')) {
      return new Response(JSON.stringify({ account: { plan_limit: 1000, plan_usage: 0 } }), { status: 200 });
    }
    searches++;
    return new Response(JSON.stringify({ results: [{ title: 'ok', url: 'https://example.com' }] }), { status: 200 });
  };
  t.after(() => {
    globalThis.fetch = oldFetch;
    rmSync(dir, { recursive: true, force: true });
  });

  const first = await tavilySearch('  Test   Game  ', { maxResults: 2 });
  const second = await tavilySearch('test game', { maxResults: 2 });
  assert.equal(first.cached, false);
  assert.equal(second.cached, true);
  assert.deepEqual(second.results, first.results);
  assert.equal(searches, 1);
  assert.equal(JSON.parse(readFileSync(process.env.TAVILY_USAGE_FILE, 'utf8')).credits, 1);

  await assert.rejects(tavilySearch('another query', { maxResults: 2 }), { code: 'TAVILY_QUOTA_GUARD' });
  assert.equal(searches, 1);
});
