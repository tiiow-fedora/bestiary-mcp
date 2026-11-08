// Thin MediaWiki Action API client. Works for Fandom, wiki.gg, Miraheze, standalone wikis.
import { getJson, httpGet, qs } from "./http.js";

export interface WikiSite {
  api: string; // full URL to api.php
  name: string; // sitename
  articleUrl: string; // base for article links, "$1" replaced by title
  license: string;
  licenseUrl: string;
  articles: number;
  host: "fandom" | "wiki.gg" | "miraheze" | "independent" | "pcgamingwiki";
  lastEdit?: string; // ISO time of most recent edit anywhere on the wiki
}

export function hostKind(api: string): WikiSite["host"] {
  const h = new URL(api).host;
  if (h.endsWith(".fandom.com") || h.endsWith(".wikia.org")) return "fandom";
  if (h.endsWith(".wiki.gg")) return "wiki.gg";
  if (h.endsWith(".miraheze.org")) return "miraheze";
  if (h.endsWith("pcgamingwiki.com")) return "pcgamingwiki";
  return "independent";
}

function apiUrl(api: string, params: Record<string, string | number | undefined>) {
  return `${api}?${qs({ format: "json", formatversion: 2, ...params })}`;
}

/** Load site info. Returns null when the wiki doesn't exist or isn't a MediaWiki API.
 *  wiki.gg answers 401 (realm "Unreleased site") for names that aren't live; Fandom answers 404. */
export async function probeSite(api: string, ttl = 3600): Promise<WikiSite | null> {
  const r = await httpGet(apiUrl(api, { action: "query", meta: "siteinfo", siprop: "general|rightsinfo|statistics" }), ttl);
  if (r.status !== 200) return null;
  let j: any;
  try {
    j = JSON.parse(r.body);
  } catch {
    return null;
  }
  const g = j?.query?.general;
  if (!g) return null;
  // Fandom serves a "closed/redirected" wiki through the API of another one; check the server matches.
  const server: string = g.server?.startsWith("//") ? "https:" + g.server : g.server ?? "";
  const articlePath: string = g.articlepath ?? "/wiki/$1";
  return {
    api,
    name: g.sitename,
    articleUrl: server + articlePath,
    license: j.query.rightsinfo?.text || "see wiki",
    licenseUrl: j.query.rightsinfo?.url || "",
    articles: j.query.statistics?.articles ?? 0,
    host: hostKind(api),
  };
}

export async function lastActivity(site: WikiSite): Promise<string | undefined> {
  const j = await getJson(apiUrl(site.api, { action: "query", list: "recentchanges", rclimit: 1, rcprop: "timestamp", rctype: "edit", rcshow: "!bot" }), 3600);
  return j?.query?.recentchanges?.[0]?.timestamp;
}

export function pageUrl(site: WikiSite, title: string) {
  return site.articleUrl.replace("$1", encodeURIComponent(title.replace(/ /g, "_")).replace(/%2F/g, "/").replace(/%3A/g, ":"));
}

export interface SearchHit {
  title: string;
  snippet: string;
  words?: number;
  edited?: string;
}

export async function search(site: WikiSite, query: string, limit = 8): Promise<SearchHit[]> {
  const j = await getJson(apiUrl(site.api, { action: "query", list: "search", srsearch: query, srlimit: limit, srprop: "snippet|wordcount|timestamp", srnamespace: 0 }), 600);
  let hits: SearchHit[] = (j?.query?.search ?? []).map((s: any) => ({
    title: s.title,
    snippet: stripTags(s.snippet ?? ""),
    words: s.wordcount,
    edited: s.timestamp,
  }));
  if (hits.length === 0) {
    // Some wikis (or Fandom's search backend on a bad day) return nothing from full text; fall back to title prefix.
    const o = await getJson(apiUrl(site.api, { action: "opensearch", search: query, limit, namespace: 0, formatversion: undefined }), 600);
    if (Array.isArray(o) && Array.isArray(o[1])) hits = o[1].map((t: string) => ({ title: t, snippet: "" }));
  }
  return hits;
}

export interface Section {
  index: string;
  level: number;
  line: string;
  number: string;
}

export interface ParsedPage {
  title: string;
  html: string;
  sections: Section[];
  revid?: number;
}

/** Parse one section (0 = lead) or, with section undefined, the section list + lead. */
export async function parsePage(site: WikiSite, title: string, section?: string): Promise<ParsedPage | { error: string }> {
  const j = await getJson(
    apiUrl(site.api, {
      action: "parse",
      page: title,
      prop: "text|sections|revid",
      section: section ?? "0",
      redirects: 1,
      disableeditsection: 1,
      disabletoc: 1,
      disablelimitreport: 1,
    }),
    900,
  );
  if (!j) return { error: "wiki did not answer" };
  if (j.error) return { error: `${j.error.code}: ${j.error.info}` };
  const p = j.parse;
  let sections: Section[] = p.sections ?? [];
  if (section !== undefined && section !== "0") sections = [];
  else if (sections.length === 0 || section === "0") {
    // With section=0 MediaWiki still returns the full list; nothing else needed.
  }
  return { title: p.title, html: typeof p.text === "string" ? p.text : p.text?.["*"] ?? "", sections, revid: p.revid };
}

export async function sectionList(site: WikiSite, title: string): Promise<Section[]> {
  const j = await getJson(apiUrl(site.api, { action: "parse", page: title, prop: "sections", redirects: 1 }), 900);
  return (j?.parse?.sections ?? []).filter((s: Section) => /^\d+$/.test(s.index)); // skip transcluded-template sections ("T-1")
}

export async function lastEdited(site: WikiSite, title: string): Promise<string | undefined> {
  const j = await getJson(apiUrl(site.api, { action: "query", prop: "revisions", titles: title, rvprop: "timestamp", redirects: 1 }), 900);
  return j?.query?.pages?.[0]?.revisions?.[0]?.timestamp;
}

export function stripTags(s: string) {
  return s.replace(/<[^>]+>/g, "").replace(/&quot;/g, '"').replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&#039;/g, "'");
}
