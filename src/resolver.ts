// Game name -> ranked list of wikis that cover it.
// Sources, in order of trust:
//   1. Wikidata: game entity -> P4073 (Fandom wiki ID), P6337 (PCGamingWiki ID)
//   2. Indie Wiki Buddy data (MIT): Fandom wiki -> where its community moved (wiki.gg / independent)
//   3. Probing {slug}.wiki.gg and {slug}.fandom.com, checked against the wiki's own name
import { getJson, qs } from "./http.js";
import { lastActivity, probeSite, WikiSite } from "./mediawiki.js";

const IWB_URL = "https://raw.githubusercontent.com/KevinPayravi/indie-wiki-buddy/main/data/data.json";
const PCGW_API = "https://www.pcgamingwiki.com/w/api.php";

export interface Candidate extends WikiSite {
  confidence: "high" | "medium" | "low";
  via: string[];
  notes: string[];
  superseded?: boolean;
  official?: boolean;
  score: number;
}

export interface Resolution {
  query: string;
  game?: { label: string; description?: string; wikidata: string };
  otherMatches: { label: string; description?: string; wikidata: string }[];
  wikis: Candidate[];
  pcgamingwiki?: string; // page title on PCGamingWiki
}

// ---------- name helpers ----------
export function norm(s: string) {
  return s.toLowerCase().normalize("NFKD").replace(/[̀-ͯ]/g, "").replace(/&/g, "and").replace(/[^a-z0-9]+/g, " ").trim();
}
const STOP = new Set(["the", "wiki", "fandom", "of", "a", "and", "game", "official", "community", "gg"]);
function tokens(s: string) {
  return norm(s).split(" ").filter((t) => t && !STOP.has(t));
}
/** fraction of the game's words that appear in the wiki name */
export function nameMatch(game: string, wikiName: string) {
  const g = tokens(game);
  if (g.length === 0) return 0;
  const w = new Set(tokens(wikiName));
  const joined = tokens(wikiName).join("");
  return g.filter((t) => w.has(t) || joined.includes(t)).length / g.length;
}

// ---------- Indie Wiki Buddy ----------
interface IwbSite {
  origins_label: string;
  origins: { origin_base_url: string }[];
  destination: string;
  destination_base_url: string;
  destination_platform: string;
  destination_search_path: string;
  tags?: string[];
  language: string;
}
let iwbCache: { at: number; sites: IwbSite[] } | null = null;
async function iwb(): Promise<IwbSite[]> {
  if (iwbCache && Date.now() - iwbCache.at < 86_400_000) return iwbCache.sites;
  const j = await getJson<{ sites: IwbSite[] }>(IWB_URL, 86_400);
  const sites = (j?.sites ?? []).filter((s) => s.destination_platform === "mediawiki");
  if (sites.length) iwbCache = { at: Date.now(), sites };
  return sites;
}
function iwbApis(s: IwbSite): string[] {
  const base = `https://${s.destination_base_url.replace(/\/$/, "")}`;
  const out: string[] = [];
  if (/index\.php$/.test(s.destination_search_path)) out.push(base + s.destination_search_path.replace(/index\.php$/, "api.php"));
  out.push(`${base}/api.php`, `${base}/w/api.php`);
  return [...new Set(out)];
}

// ---------- Wikidata ----------
interface WdHit { id: string; label: string; description?: string }
const GAMEISH = /\b(game|video ?game|roblox|experience|mod|modpack|mmo|rpg|visual novel|expansion|franchise|series|esport)\b/i;

async function wikidata(game: string, lang: string) {
  const s = await getJson(`https://www.wikidata.org/w/api.php?${qs({ action: "wbsearchentities", search: game, language: lang, uselang: lang, type: "item", limit: 8, format: "json" })}`, 86_400);
  const hits: WdHit[] = (s?.search ?? []).map((h: any) => ({ id: h.id, label: h.label, description: h.description }));
  if (hits.length === 0) return { best: undefined, others: [] as WdHit[], claims: {} as Record<string, string[]> };
  const e = await getJson(`https://www.wikidata.org/w/api.php?${qs({ action: "wbgetentities", ids: hits.map((h) => h.id).join("|"), props: "claims", format: "json" })}`, 86_400);
  const claimsOf = (id: string): Record<string, string[]> => {
    const c = e?.entities?.[id]?.claims ?? {};
    const out: Record<string, string[]> = {};
    for (const p of ["P4073", "P6337", "P1733"]) {
      out[p] = (c[p] ?? []).map((x: any) => x?.mainsnak?.datavalue?.value).filter((v: any) => typeof v === "string");
    }
    return out;
  };
  // Prefer a game-looking entity whose label matches the query; Wikidata's own ranking breaks ties.
  const scored = hits.map((h, i) => {
    const c = claimsOf(h.id);
    let score = -i * 0.5;
    if (c.P4073.length) score += 4;
    if (c.P6337.length || c.P1733.length) score += 3;
    if (GAMEISH.test(h.description ?? "")) score += 3;
    score += nameMatch(game, h.label) * 2;
    if (norm(h.label) === norm(game)) score += 2;
    return { h, c, score };
  });
  scored.sort((a, b) => b.score - a.score);
  const gameish = scored.filter((s) => s.c.P4073.length || s.c.P6337.length || s.c.P1733.length || GAMEISH.test(s.h.description ?? ""));
  const best = gameish[0];
  return {
    best: best?.h,
    claims: best?.c ?? {},
    others: gameish.slice(1, 5).map((s) => s.h),
  };
}

function fandomApi(id: string, lang: string): string | null {
  // P4073 values: "hollowknight" (English) or "de.hollowknight" (-> hollowknight.fandom.com/de)
  const m = id.match(/^([a-z]{2,3}(?:-[a-z]{2,4})?)\.(.+)$/i);
  if (m) return m[1].toLowerCase() === lang ? `https://${m[2]}.fandom.com/${m[1]}/api.php` : null;
  return lang === "en" ? `https://${id}.fandom.com/api.php` : null;
}

function slugs(name: string) {
  const n = norm(name);
  const words = n.split(" ").filter(Boolean);
  const out = new Set<string>([words.join(""), words.join("-")]);
  const noThe = words.filter((w) => w !== "the");
  out.add(noThe.join(""));
  return [...out].filter((s) => s.length >= 3 && s.length <= 60);
}

// ---------- main ----------
export async function resolveGame(query: string, lang = "en"): Promise<Resolution> {
  const cands = new Map<string, Candidate>();
  // Keyed by the wiki's own canonical article URL, so Fandom aliases (hollow-knight.fandom.com ->
  // hollowknight.fandom.com) collapse into one entry.
  const add = async (apis: string | string[], via: string, confidence: Candidate["confidence"], extra: Partial<Candidate> = {}) => {
    let site: WikiSite | null = null;
    for (const api of Array.isArray(apis) ? apis : [apis]) if ((site = await probeSite(api))) break;
    if (!site) return null;
    const key = site.articleUrl;
    const existing = cands.get(key);
    if (existing) {
      if (!existing.via.includes(via)) existing.via.push(via);
      if (rank(confidence) > rank(existing.confidence)) existing.confidence = confidence;
      if (extra.official) existing.official = true;
      existing.notes.push(...(extra.notes ?? []));
      return existing;
    }
    const c: Candidate = { ...site, confidence, via: [via], score: 0, ...extra, notes: [...(extra.notes ?? [])] };
    cands.set(key, c);
    return c;
  };

  const [wd, sites] = await Promise.all([wikidata(query, lang), iwb()]);
  const gameName = wd.best?.label ?? query;

  // 1. Wikidata-linked Fandom wikis
  await Promise.all(
    (wd.claims.P4073 ?? []).map((id) => {
      const api = fandomApi(id, lang);
      return api ? add(api, "wikidata", "high") : null;
    }),
  );

  // 2. Probe common hosts by slug (both the query and the canonical Wikidata label)
  const names = [...new Set([query, gameName])];
  const probeApis = new Set<string>();
  for (const n of names)
    for (const s of slugs(n)) {
      probeApis.add(`https://${s}.wiki.gg/api.php`);
      probeApis.add(`https://${s}.fandom.com/api.php`);
    }
  await Promise.all([...probeApis].map((a) => add(a, "slug probe", "low")));

  // 3. Indie Wiki Buddy: name match + Fandom->independent redirects
  const langUp = lang.toUpperCase();
  const local = sites.filter((s) => s.language === langUp);
  const fandomHosts = () =>
    [...cands.values()].filter((c) => c.host === "fandom").map((c) => ({ c, key: c.articleUrl.replace(/^https?:\/\//, "").replace(/\/wiki\/\$1$/, "") }));
  for (const s of local) {
    const label = s.origins_label.replace(/(fandom|fextra(life)?|neoseeker|wikis?)|[,&]/gi, " ").trim();
    const byName = Math.max(nameMatch(gameName, label), nameMatch(gameName, s.destination)) === 1 && nameMatch(label, gameName) >= 0.5;
    const movedFrom = fandomHosts().filter(({ key }) => s.origins.some((o) => o.origin_base_url.replace(/\/$/, "") === key));
    if (!byName && movedFrom.length === 0) continue;
    const c = await add(iwbApis(s), "indie-wiki-buddy", movedFrom.length ? "high" : "medium", {
      official: s.tags?.includes("official"),
      notes: movedFrom.length ? [`Community moved here from ${movedFrom.map((m) => m.key).join(", ")}`] : [],
    });
    if (c) for (const m of movedFrom) {
      m.c.superseded = true;
      m.c.notes.push(`Editors moved to ${c.name} (${new URL(c.api).host}); this Fandom copy may be out of date`);
    }
  }

  // Name sanity check for weak sources; drop clear mismatches.
  for (const [api, c] of cands) {
    const m = Math.max(nameMatch(gameName, c.name), nameMatch(query, c.name));
    if (c.confidence === "low") {
      if (m < 0.5) cands.delete(api);
      else if (m === 1) c.confidence = "medium";
    }
  }

  // Freshness + scoring
  await Promise.all([...cands.values()].map(async (c) => (c.lastEdit = await lastActivity(c))));
  const now = Date.now();
  for (const c of cands.values()) {
    let s = rank(c.confidence) * 10;
    if (c.official) s += 8;
    if (c.host !== "fandom") s += 3; // independent/wiki.gg editors usually left Fandom, not the other way round
    if (c.superseded) s -= 25;
    s += Math.min(Math.log10(c.articles + 1) * 3, 15);
    if (c.lastEdit) {
      const days = (now - Date.parse(c.lastEdit)) / 86_400_000;
      if (days > 365) { s -= 10; c.notes.push(`No human edits for ${Math.round(days / 365 * 10) / 10} years`); }
      else if (days > 90) s -= 3;
    }
    if (c.articles < 20) { s -= 8; c.notes.push(`Very small wiki (${c.articles} articles)`); }
    c.score = Math.round(s * 10) / 10;
  }
  const wikis = [...cands.values()].sort((a, b) => b.score - a.score);

  return {
    query,
    game: wd.best ? { label: wd.best.label, description: wd.best.description, wikidata: wd.best.id } : undefined,
    otherMatches: wd.others.map((o) => ({ label: o.label, description: o.description, wikidata: o.id })),
    wikis,
    pcgamingwiki: wd.claims.P6337?.[0],
  };
}

function rank(c: Candidate["confidence"]) {
  return c === "high" ? 3 : c === "medium" ? 2 : 1;
}

/** Accept "terraria.wiki.gg", "https://minecraft.wiki/w/Creeper", or an api.php URL. */
export async function siteFromUrl(input: string): Promise<WikiSite | null> {
  let u: URL;
  try {
    u = new URL(/^https?:\/\//.test(input) ? input : `https://${input}`);
  } catch {
    return null;
  }
  if (u.pathname.endsWith("api.php")) return probeSite(u.origin + u.pathname);
  const lang = u.pathname.match(/^\/([a-z]{2,3}(?:-[a-z]{2,4})?)\/(?:wiki\/|$)/)?.[1];
  const tries = [lang ? `${u.origin}/${lang}/api.php` : null, `${u.origin}/api.php`, `${u.origin}/w/api.php`].filter(Boolean) as string[];
  for (const t of tries) {
    const s = await probeSite(t);
    if (s) return s;
  }
  return null;
}

export const PCGAMINGWIKI_API = PCGW_API;
