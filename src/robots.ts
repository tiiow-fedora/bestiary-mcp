// robots.txt handling (RFC 9309) for game wikis.
// Policy (decided 2026-11-08):
// - Single lookups made because a user asked are user-triggered fetches, not crawling. Path rules in the
//   "*" group (e.g. wiki.gg's "Disallow: /api.php", meant to keep crawlers off API URLs) don't apply to them,
//   the same way search engines' user-triggered fetchers treat robots.txt.
// - aiOptOut(): a site-wide Disallow for user-initiated AI fetchers (ChatGPT-User, Claude-User, ...) or for
//   everyone ("*" Disallow: /) IS respected. Those rules target exactly this use: a page fetched for an AI.
// - Blocks aimed at training/search crawlers (ClaudeBot, GPTBot) don't apply; wiki.gg labels them "Training crawlers".
// - allowedByRobots() is the full RFC check. Anything that bulk-fetches (dumps, indexing, pre-caching) must use it.
import { httpGet } from "./http.js";

export const PRODUCT_TOKEN = "bestiary-bot";
const AI_USER_AGENTS = ["claude-user", "chatgpt-user", "perplexity-user", "mistralai-user", "bestiary", PRODUCT_TOKEN];

interface Rule { allow: boolean; path: string }
interface Group { agents: string[]; rules: Rule[] }

export function parseRobots(text: string): Group[] {
  const groups: Group[] = [];
  let cur: Group | null = null;
  let lastWasAgent = false;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/#.*/, "").trim();
    const m = line.match(/^([A-Za-z-]+)\s*:\s*(.*)$/);
    if (!m) continue;
    const key = m[1].toLowerCase();
    const val = m[2].trim();
    if (key === "user-agent") {
      if (!cur || !lastWasAgent) groups.push((cur = { agents: [], rules: [] }));
      cur.agents.push(val.toLowerCase());
      lastWasAgent = true;
    } else if ((key === "allow" || key === "disallow") && cur) {
      lastWasAgent = false;
      if (val) cur.rules.push({ allow: key === "allow", path: val });
    } else lastWasAgent = false;
  }
  return groups;
}

function rulesFor(groups: Group[], agent: string): Rule[] | null {
  const mine = groups.filter((g) => g.agents.some((a) => a !== "*" && agent.startsWith(a)));
  if (mine.length) return mine.flatMap((g) => g.rules);
  const star = groups.filter((g) => g.agents.includes("*"));
  return star.length ? star.flatMap((g) => g.rules) : null;
}

function patternMatches(pattern: string, path: string): number {
  // returns match length (pattern specificity) or -1
  const anchored = pattern.endsWith("$");
  const body = anchored ? pattern.slice(0, -1) : pattern;
  const re = new RegExp("^" + body.split("*").map((s) => s.replace(/[.+?^${}()|[\]\\]/g, "\\$&")).join(".*") + (anchored ? "$" : ""));
  return re.test(path) ? pattern.length : -1;
}

export function robotsAllows(groups: Group[], agent: string, path: string): boolean {
  const rules = rulesFor(groups, agent);
  if (!rules) return true;
  let best: { len: number; allow: boolean } = { len: -1, allow: true };
  for (const r of rules) {
    const len = patternMatches(r.path, path);
    if (len > best.len || (len === best.len && len >= 0 && r.allow)) best = { len, allow: r.allow };
  }
  return best.allow;
}

export function siteWideAiOptOut(groups: Group[]): boolean {
  return groups.some((g) => g.agents.some((a) => AI_USER_AGENTS.includes(a)) && g.rules.some((r) => !r.allow && r.path === "/"))
    || groups.some((g) => g.agents.includes("*") && g.rules.some((r) => !r.allow && r.path === "/") && !g.rules.some((r) => r.allow));
}

const cache = new Map<string, { at: number; groups: Group[] }>();
async function groupsFor(origin: string): Promise<Group[]> {
  const hit = cache.get(origin);
  if (hit && Date.now() - hit.at < 86_400_000) return hit.groups;
  const r = await httpGet(`${origin}/robots.txt`, 86_400, 6000);
  // Missing or HTML (soft-404) robots.txt = no rules. An unreachable one (5xx) is treated as "no rules" too:
  // the API probe will fail on its own if the site is down.
  const groups = r.status === 200 && !/^\s*</.test(r.body) ? parseRobots(r.body) : [];
  cache.set(origin, { at: Date.now(), groups });
  if (cache.size > 500) cache.delete(cache.keys().next().value as string);
  return groups;
}

export async function allowedByRobots(url: string): Promise<boolean> {
  const u = new URL(url);
  return robotsAllows(await groupsFor(u.origin), PRODUCT_TOKEN, u.pathname + u.search);
}

export async function aiOptOut(origin: string): Promise<boolean> {
  return siteWideAiOptOut(await groupsFor(origin));
}
