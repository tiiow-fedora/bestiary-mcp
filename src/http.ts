// Polite HTTP: descriptive bot User-Agent, timeout, small TTL cache, per-host spacing.
// Never send a browser User-Agent: wiki.gg answers those with 403.

export const USER_AGENT =
  "GameWikiScout-bot/0.1 (MCP server for game wiki lookups; https://github.com/tiiow-fedora/game-wiki-scout)";

const TIMEOUT_MS = 12_000;
const MIN_HOST_GAP_MS = 150;
const CACHE_MAX = 500;

type Entry = { at: number; ttl: number; status: number; body: string; headers: Record<string, string> };
const cache = new Map<string, Entry>();
const lastHit = new Map<string, number>();

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

export async function httpGet(url: string, ttlSeconds = 600): Promise<HttpResult> {
  const hit = cache.get(url);
  if (hit && Date.now() - hit.at < hit.ttl * 1000) {
    cache.delete(url); // refresh LRU position
    cache.set(url, hit);
    return { status: hit.status, body: hit.body, headers: hit.headers };
  }
  const host = new URL(url).host;
  await spaceHost(host);
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), TIMEOUT_MS);
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
