// Polite HTTP: descriptive bot User-Agent, timeout, small TTL cache, per-host spacing.
// Never send a browser User-Agent: wiki.gg answers those with 403.

export const USER_AGENT =
  "Bestiary-bot/0.1 (MCP server for game wiki lookups; https://github.com/tiiow-fedora/bestiary-mcp)";

const TIMEOUT_MS = 12_000;
const MIN_HOST_GAP_MS = 250; // per hosting platform, not per wiki: all *.fandom.com wikis share one budget
const DEFAULT_COOLDOWN_MS = 60_000;
const CACHE_MAX = 800;

type Entry = { at: number; ttl: number; status: number; body: string; headers: Record<string, string> };
const cache = new Map<string, Entry>();
const lastHit = new Map<string, number>();
const coolUntil = new Map<string, number>();
let requestCount = 0;
/** Number of real (uncached) HTTP requests made so far; used by tests to measure cost per lookup. */
export function requestsMade() {
  return requestCount;
}

/** Rate-limit key: the hosting platform. terraria.wiki.gg and dota2.wiki.gg share "wiki.gg". */
export function platformKey(host: string) {
  const parts = host.toLowerCase().split(".");
  return parts.length <= 2 ? parts.join(".") : parts.slice(-2).join(".");
}

export interface HttpResult {
  status: number;
  body: string;
  headers: Record<string, string>;
}

async function spaceHost(host: string) {
  const now = Date.now();
  const prev = lastHit.get(host) ?? 0;
  const wait = prev + MIN_HOST_GAP_MS - now;
  lastHit.set(host, Math.max(now, prev + MIN_HOST_GAP_MS));
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
}

export async function httpGet(url: string, ttlSeconds = 600, timeoutMs = TIMEOUT_MS): Promise<HttpResult> {
  const hit = cache.get(url);
  if (hit && Date.now() - hit.at < hit.ttl * 1000) {
    cache.delete(url); // refresh LRU position
    cache.set(url, hit);
    return { status: hit.status, body: hit.body, headers: hit.headers };
  }
  const key = platformKey(new URL(url).host);
  // While a platform is rate-limiting us, don't send it anything: answer locally with the 429.
  if ((coolUntil.get(key) ?? 0) > Date.now()) return { status: 429, body: "cooling down after a rate limit", headers: {} };
  await spaceHost(key);
  requestCount++;
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  let res: Response;
  try {
    res = await fetch(url, {
      headers: { "User-Agent": USER_AGENT, "Api-User-Agent": USER_AGENT, Accept: "application/json, text/html;q=0.9" },
      redirect: "follow",
      signal: ctl.signal,
    });
  } catch (e) {
    return { status: 0, body: String((e as Error)?.message ?? e), headers: {} };
  } finally {
    clearTimeout(timer);
  }
  const body = await res.text();
  const headers: Record<string, string> = {};
  res.headers.forEach((v, k) => (headers[k] = v));
  if (res.status === 429 || (res.status === 503 && headers["retry-after"])) {
    const ra = Number(headers["retry-after"]);
    coolUntil.set(key, Date.now() + (Number.isFinite(ra) && ra > 0 ? Math.min(ra, 900) * 1000 : DEFAULT_COOLDOWN_MS));
  }
  // Cache successes and definite "no such wiki" answers; not transient errors.
  if (ttlSeconds > 0 && (res.status === 200 || res.status === 404 || res.status === 401 || res.status === 410)) {
    cache.set(url, { at: Date.now(), ttl: ttlSeconds, status: res.status, body, headers });
    while (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value as string);
  }
  return { status: res.status, body, headers };
}

export async function getJson<T = any>(url: string, ttlSeconds = 600): Promise<T | null> {
  const r = await httpGet(url, ttlSeconds);
  if (r.status !== 200) return null;
  try {
    return JSON.parse(r.body) as T;
  } catch {
    return null;
  }
}

export function qs(params: Record<string, string | number | undefined>): string {
  const u = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined) u.set(k, String(v));
  return u.toString();
}
