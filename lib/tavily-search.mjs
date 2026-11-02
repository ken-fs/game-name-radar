import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const CACHE_FILE = process.env.TAVILY_CACHE_FILE || join(ROOT, 'data', 'tavily-cache.json');
const USAGE_FILE = process.env.TAVILY_USAGE_FILE || join(ROOT, 'data', 'tavily-usage.json');
const TTL = 24 * 3600e3;
const MONTHLY_LIMIT = Math.max(0, Number(process.env.TAVILY_MONTHLY_LIMIT ?? 800));
const RESERVE = Math.max(0, Number(process.env.TAVILY_RESERVE ?? 200));

export function getTavilyKey() {
  if (process.env.TAVILY_API_KEY) return process.env.TAVILY_API_KEY.trim();
  try {
    const env = readFileSync(join(ROOT, '.env'), 'utf8');
    const key = env.match(/^TAVILY_API_KEY=["']?([^"'\s]+)/m)?.[1];
    if (key) return key;
  } catch {}
  try {
    const cfg = JSON.parse(readFileSync(join(homedir(), '.pi/agent/mcp.json'), 'utf8'));
    const url = cfg?.mcpServers?.tavily?.url || cfg?.servers?.tavily?.url || '';
    const key = url.match(/tavilyApiKey=([^&]+)/) || url.match(/key=([^&]+)/);
    if (key) return decodeURIComponent(key[1]);
  } catch {}
  return null;
}

export const normalizeTavilyQuery = (query) => String(query).toLowerCase().replace(/\s+/g, ' ').trim();
const readJson = (file, fallback) => { try { return JSON.parse(readFileSync(file, 'utf8')); } catch { return fallback; } };
function writeJson(file, value) {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}
function localUsage() {
  const month = new Date().toISOString().slice(0, 7);
  const stored = readJson(USAGE_FILE, {});
  return stored.month === month ? stored : { month, credits: 0 };
}

let accountCache;
async function accountUsage(key) {
  if (accountCache !== undefined) return accountCache;
  accountCache = null;
  try {
    const r = await fetch('https://api.tavily.com/usage', {
      headers: { Authorization: `Bearer ${key}` },
      signal: AbortSignal.timeout(15000),
    });
    if (r.ok) {
      const d = await r.json();
      accountCache = d.account ?? d;
    }
  } catch {}
  return accountCache;
}

function quotaError(message) {
  const error = new Error(message);
  error.code = 'TAVILY_QUOTA_GUARD';
  return error;
}

/** Successful searches are cached for 24h. The local cap and real account balance both apply. */
export async function tavilySearch(query, {
  maxResults = 10,
  searchDepth = 'basic',
  ttlMs = TTL,
  monthlyLimit = MONTHLY_LIMIT,
  reserve = RESERVE,
} = {}) {
  const q = normalizeTavilyQuery(query);
  if (!q) throw new Error('Tavily query is empty');
  const cacheKey = JSON.stringify([q, maxResults, searchDepth]);
  const cache = readJson(CACHE_FILE, {});
  const hit = cache[cacheKey];
  if (hit && Date.now() - hit.at < ttlMs) return { results: hit.results, cached: true };

  const key = getTavilyKey();
  if (!key) throw new Error('Tavily key missing');
  const cost = searchDepth === 'advanced' ? 2 : 1;
  const usage = localUsage();
  const account = await accountUsage(key);
  const accountUsed = Number(account?.plan_usage);
  const used = Math.max(Number(usage.credits) || 0, Number.isFinite(accountUsed) ? accountUsed : 0);
  const planLimit = Number(account?.plan_limit);
  const limit = Number.isFinite(planLimit) && planLimit > 0
    ? Math.min(monthlyLimit, planLimit - reserve)
    : monthlyLimit;
  if (used + cost > limit) {
    throw quotaError(`Tavily monthly safety limit reached (${used}/${limit}, reserve ${reserve})`);
  }

  const r = await fetch('https://api.tavily.com/search', {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query: q, max_results: maxResults, search_depth: searchDepth }),
    signal: AbortSignal.timeout(45000),
  });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`tavily ${r.status} ${String(d?.detail?.error || d?.detail || '').slice(0, 100)}`);
  if (!Array.isArray(d.results)) throw new Error('Tavily returned no results array');

  usage.credits = (Number(usage.credits) || 0) + cost;
  usage.updatedAt = new Date().toISOString();
  writeJson(USAGE_FILE, usage);
  if (account && Number.isFinite(accountUsed)) account.plan_usage = accountUsed + cost;

  cache[cacheKey] = { at: Date.now(), results: d.results };
  for (const [k, v] of Object.entries(cache)) if (!v.at || Date.now() - v.at > 30 * 86400e3) delete cache[k];
  try { writeJson(CACHE_FILE, cache); } catch { /* 搜索成功时缓存写失败不丢结果 */ }
  return { results: d.results, cached: false };
}
