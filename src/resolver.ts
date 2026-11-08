// Game name -> ranked list of wikis that cover it.
// Sources, in order of trust:
//   1. Wikidata game entity: P4073 (Fandom wiki ID), P6262 (Fandom article ID, often on a franchise wiki),
//      P856 (official site, probed for a wiki), P6337 (PCGamingWiki)
//   2. Wikidata series/franchise (P179, P8345): their Fandom wikis and names, for games covered by a
//      franchise wiki (Fallout 4 -> fallout wiki, Dark Souls III -> Dark Souls wiki)
//   3. Indie Wiki Buddy data (MIT): Fandom wiki -> where its community moved (wiki.gg / independent)
//   4. Probing {slug}.wiki.gg and {slug}.fandom.com, checked against the wiki's own name
// Wikis that block automated access or opt out of AI agents in robots.txt are listed, never read.
import { getJson, qs, USER_AGENT } from "./http.js";
import { aiOptOut } from "./robots.js";
import { lastActivity, probeSite, probeStatus, WikiSite } from "./mediawiki.js";

const IWB_URL = "https://raw.githubusercontent.com/KevinPayravi/indie-wiki-buddy/main/data/data.json";
export const PCGAMINGWIKI_API = "https://www.pcgamingwiki.com/w/api.php";

export interface Candidate extends WikiSite {
  confidence: "high" | "medium" | "low";
  via: string[];
  notes: string[];
  superseded?: boolean;
  official?: boolean;
  franchise?: boolean;
  newHomeUnreadable?: boolean;
  pageHint?: string; // article title for this game on that wiki, when Wikidata knows it
  score: number;
}

export interface Unreachable {
  name: string;
  url: string;
  reason: string;
}

export interface Resolution {
  query: string;
  game?: { label: string; description?: string; wikidata: string };
  otherMatches: { label: string; description?: string; wikidata: string }[];
  wikis: Candidate[];
  unreachable: Unreachable[];
  pcgamingwiki?: string;
}

// ---------- name helpers ----------
export function norm(s: string) {
  return s.toLowerCase().normalize("NFKD").replace(/[̀-ͯ]/g, "").replace(/&/g, "and").replace(/[^a-z0-9]+/g, " ").trim();
}
const STOP = new Set(["the", "wiki", "wikis", "fandom", "of", "a", "and", "game", "official", "community", "gg", "pedia"]);
const ROMAN: Record<string, string> = { i: "1", ii: "2", iii: "3", iv: "4", v: "5", vi: "6", vii: "7", viii: "8", ix: "9", x: "10", xi: "11", xii: "12", xiii: "13", xiv: "14", xv: "15", xvi: "16" };
function tokens(s: string) {
  return norm(s).split(" ").filter((t) => t && !STOP.has(t)).map((t) => ROMAN[t] ?? t);
}
/** fraction of a's words that appear in b */
export function nameMatch(a: string, b: string) {
  const g = tokens(a);
  if (g.length === 0) return 0;
  const bt = tokens(b);
  const w = new Set(bt);
  const joined = bt.join("");
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
const IWB_NOISE = /\b(fandom|fextra(life)?|neoseeker|wikis?)\b|[,&]/gi;

// ---------- Wikidata ----------
interface WdHit { id: string; label: string; description?: string }
type Claims = Record<string, string[]>;
const GAMEISH = /\b(game|video ?game|roblox|experience|mod|modpack|mmo|mmorpg|rpg|visual novel|expansion|esport)\b/i;
const PROPS = ["P4073", "P6262", "P6337", "P1733", "P856", "P179", "P8345"];
// Catch-all Fandom wikis that index every game; they're never the place a game's community lives.
const AGGREGATOR_WIKIS = new Set(["video-game-databank", "gamicus", "nintendo", "sega", "playstation", "xbox", "steam", "microsoft", "community", "vgmdb", "logos", "sonypictures", "ea", "ubisoft", "capcom", "bandainamco", "squareenix", "konami", "gaming", "videogames", "vgfaq", "video-games", "crossover", "vsbattles", "brickipedia", "speedydeletion", "allthetropes"]);

function claimsFrom(entity: any): Claims {
  const c = entity?.claims ?? {};
  const out: Claims = {};
  for (const p of PROPS)
    out[p] = (c[p] ?? [])
      .filter((x: any) => x?.rank !== "deprecated")
      .map((x: any) => x?.mainsnak?.datavalue?.value)
      .map((v: any) => (typeof v === "string" ? v : v?.id))
      .filter((v: any) => typeof v === "string");
  return out;
}

async function wdEntities(ids: string[], props = "claims|labels") {
  if (ids.length === 0) return {};
  const e = await getJson(`https://www.wikidata.org/w/api.php?${qs({ action: "wbgetentities", ids: ids.slice(0, 50).join("|"), props, languages: "en|mul", format: "json" })}`, 86_400);
  return (e?.entities ?? {}) as Record<string, any>;
}

/** Exact Wikidata item for a Steam app ID (P1733), the most reliable key for niche games. */
async function wdBySteamId(appId: number, lang: string): Promise<WdHit | undefined> {
  const s = await getJson(`https://www.wikidata.org/w/api.php?${qs({ action: "query", list: "search", srsearch: `haswbstatement:P1733=${appId}`, srlimit: 1, format: "json" })}`, 86_400);
  const id: string | undefined = s?.query?.search?.[0]?.title;
  if (!id) return undefined;
  const e = await getJson(`https://www.wikidata.org/w/api.php?${qs({ action: "wbgetentities", ids: id, props: "labels|descriptions", languages: `${lang}|en|mul`, format: "json" })}`, 86_400);
  const ent = e?.entities?.[id];
  const pick = (o: any) => o?.[lang]?.value ?? o?.en?.value ?? o?.mul?.value;
  return { id, label: pick(ent?.labels) ?? "", description: pick(ent?.descriptions) };
}

async function wikidata(game: string, lang: string, steamAppId?: number) {
  const s = await getJson(`https://www.wikidata.org/w/api.php?${qs({ action: "wbsearchentities", search: game, language: lang, uselang: lang, type: "item", limit: 8, format: "json" })}`, 86_400);
  let hits: WdHit[] = (s?.search ?? []).map((h: any) => ({ id: h.id, label: h.label, description: h.description }));
  const steamHit = steamAppId ? await wdBySteamId(steamAppId, lang) : undefined;
  if (steamHit) hits = [steamHit, ...hits.filter((h) => h.id !== steamHit.id)];
  const empty = { best: undefined as WdHit | undefined, others: [] as WdHit[], claims: {} as Claims, parents: [] as { label: string; claims: Claims }[] };
  if (hits.length === 0) return empty;
  const ents = await wdEntities(hits.map((h) => h.id), "claims");
  const scored = hits.map((h, i) => {
    const c = claimsFrom(ents[h.id]);
    let score = -i * 0.5;
    if (c.P4073.length || c.P6262.length) score += 4;
    if (c.P6337.length || c.P1733.length) score += 3;
    if (GAMEISH.test(h.description ?? "")) score += 3;
    if (/\b(series|franchise|universe|character|soundtrack|film|novel|album)\b/i.test(h.description ?? "")) score -= 3;
    score += nameMatch(game, h.label) * 2;
    if (norm(h.label) === norm(game)) score += 8;
    if (steamHit && h.id === steamHit.id) score += 50; // exact Steam app match beats any name match
    return { h, c, score };
  });
  scored.sort((a, b) => b.score - a.score);
  const gameish = scored.filter((x) => (steamHit && x.h.id === steamHit.id) || x.c.P4073.length || x.c.P6262.length || x.c.P6337.length || x.c.P1733.length || GAMEISH.test(x.h.description ?? ""));
  const best = gameish[0];
  if (!best) return { ...empty, others: [] };
  // One hop up: series and franchise.
  const parentIds = [...new Set([...(best.c.P179 ?? []), ...(best.c.P8345 ?? [])])].slice(0, 4);
  const pents = await wdEntities(parentIds);
  const parents = parentIds
    .filter((id) => pents[id])
    .map((id) => ({ label: pents[id]?.labels?.en?.value ?? pents[id]?.labels?.mul?.value ?? "", claims: claimsFrom(pents[id]) }))
    .filter((p) => p.label);
  return { best: best.h, claims: best.c, others: gameish.slice(1, 5).map((x) => x.h), parents };
}

function fandomApi(id: string, lang: string): string | null {
  // "hollowknight" (English) or "de.hollowknight" (-> hollowknight.fandom.com/de)
  const m = id.match(/^([a-z]{2,3}(?:-[a-z]{2,4})?)\.(.+)$/i);
  if (m) return m[1].toLowerCase() === lang ? `https://${m[2]}.fandom.com/${m[1]}/api.php` : null;
  return lang === "en" ? `https://${id}.fandom.com/api.php` : null;
}

function slugs(name: string) {
  const out = new Set<string>();
  // Full name, plus the part before a subtitle ("Hollow Knight: Silksong" -> "hollowknight") and without
  // publisher prefixes ("Tom Clancy's Rainbow Six Siege" -> "rainbowsixsiege").
  const afterColon = name.split(/\s*:\s*/)[1];
  const variants = [...(afterColon ? [afterColon] : []), name, name.split(/\s*[:–—]\s*|\s+-\s+/)[0], name.replace(/^(tom clancy'?s|sid meier'?s|marvel'?s|disney'?s|warhammer 40,?000:?)\s+/i, "")];
  for (const v of variants) {
    const words = norm(v).split(" ").filter(Boolean);
    out.add(words.join(""));
    out.add(words.join("-"));
    out.add(words.filter((w) => w !== "the").join(""));
    const digits = words.map((w) => ROMAN[w] ?? w);
    out.add(digits.join(""));
    out.add(digits.join("-"));
  }
  return [...out].filter((s) => s.length >= 3 && s.length <= 60);
}

/** Fandom's own wiki search (the one fandom.com uses). Returns API URLs of wikis whose name fits. */
async function fandomSearch(name: string, lang: string): Promise<string[]> {
  const j = await getJson(`https://services.fandom.com/unified-search/community-search?${qs({ query: name, lang, limit: 6 })}`, 86_400);
  const out: string[] = [];
  for (const r of j?.results ?? []) {
    if (typeof r?.url !== "string" || r.language !== lang) continue;
    try {
      const u = new URL(r.url);
      if (!u.host.endsWith(".fandom.com")) continue;
      out.push(`${u.origin}${u.pathname.replace(/\/$/, "")}/api.php`);
    } catch {
      /* skip */
    }
  }
  return out;
}

function officialSiteApis(url: string): string[] {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return [];
  }
  const host = u.host.replace(/^www\./, "");
  if (host.split(".").length > 3) return [];
  return [`https://wiki.${host}/w/api.php`, `https://wiki.${host}/api.php`, `https://${u.host}/wiki/api.php`, `https://${u.host}/Wiki/api.php`, `https://${u.host}/w/api.php`];
}

// ---------- main ----------
export async function resolveGame(query: string, lang = "en", steamAppId?: number): Promise<Resolution> {
  // Keyed by the wiki's canonical article URL so Fandom aliases (hollow-knight -> hollowknight) collapse.
  const cands = new Map<string, Candidate>();
  const unreachable = new Map<string, Unreachable>();

  const add = async (apis: string | string[], via: string, confidence: Candidate["confidence"], extra: Partial<Candidate> = {}, label?: string) => {
    const list = Array.isArray(apis) ? apis : [apis];
    const site = (await Promise.all(list.map((a) => probeSite(a)))).find(Boolean) ?? null;
    if (!site) {
      // Only worth reporting when a trusted source said a wiki lives here and it refused us.
      const statuses = list.map((a) => probeStatus(a));
      const url = new URL(list[0]).origin;
      if (label && statuses.includes(-1)) unreachable.set(url, { name: label, url, reason: "its robots.txt disallows automated API access, so it is not read" });
      else {
        const refused = statuses.find((st) => st === 403 || st === 503);
        if (label && statuses.includes(429)) unreachable.set(url, { name: label, url, reason: "is rate-limiting requests right now (HTTP 429); try again in a minute" });
        else if (label && refused) unreachable.set(url, { name: label, url, reason: `blocks automated access (HTTP ${refused})` });
      }
      return null;
    }
    const origin = new URL(site.articleUrl.replace("$1", "")).origin;
    if (await aiOptOut(origin)) {
      unreachable.set(origin, { name: site.name, url: origin, reason: "its robots.txt opts out of AI agents, so it is not read" });
      return null;
    }
    const key = site.articleUrl;
    const existing = cands.get(key);
    if (existing) {
      if (!existing.via.includes(via)) existing.via.push(via);
      if (rank(confidence) > rank(existing.confidence)) existing.confidence = confidence;
      if (extra.official) existing.official = true;
      if (extra.franchise === false) existing.franchise = false;
      if (extra.pageHint && !existing.pageHint) existing.pageHint = extra.pageHint;
      existing.notes.push(...(extra.notes ?? []).filter((n) => !existing.notes.includes(n)));
      return existing;
    }
    const c: Candidate = { ...site, confidence, via: [via], score: 0, ...extra, notes: [...(extra.notes ?? [])] };
    cands.set(key, c);
    return c;
  };

  const [wd, sites] = await Promise.all([wikidata(query, lang, steamAppId), iwb()]);
  const gameName = wd.best?.label ?? query;
  const jobs: Promise<unknown>[] = [];

  // 1. The game's own Wikidata links
  for (const id of wd.claims.P4073 ?? []) {
    const api = fandomApi(id, lang);
    // Wikidata sometimes links a game to a mod/fan wiki ("Half-Life Forever"); those get less trust.
    if (api) jobs.push(probeSite(api).then((site) => (site ? add(api, "wikidata", fits(site.name) ? "high" : "medium", { franchise: false }) : null)));
  }
  // P6262 also links crossover wikis (Brickipedia, VS Battles), so the wiki's name must match the game or its series.
  const seriesNames = [query, gameName, ...wd.parents.map((p) => p.label)];
  // Strict fit for weakly-linked sources: every word of the wiki's name must come from the game or series name.
  // "Rainbow Six Wiki" fits "Tom Clancy's Rainbow Six"; "Half-Life Forever Wiki" doesn't fit "Half-Life".
  const fits = (siteName: string) => seriesNames.some((n) => nameMatch(siteName, n) === 1);
  const p6262 = (wd.claims.P6262 ?? []).map(async (v) => {
    const [wiki, ...rest] = v.split(":");
    const api = fandomApi(wiki, lang);
    if (!api || AGGREGATOR_WIKIS.has(wiki.replace(/^[a-z]{2}\./, ""))) return;
    const site = await probeSite(api);
    if (!site || !fits(site.name)) return;
    // A franchise wiki's page for the game (Fallout Wiki -> "Fallout 4") is useful but series-wide.
    await add(api, "wikidata article", "high", { pageHint: rest.join(":").replace(/_/g, " "), franchise: nameMatch(gameName, site.name) < 1 || undefined });
  });
  jobs.push(...p6262);
  for (const site of (wd.claims.P856 ?? []).slice(0, 1)) jobs.push(add(officialSiteApis(site), "official site", "low", { official: true }));  // no label: most official sites have no wiki

  // 2. Series / franchise wikis
  for (const p of wd.parents) {
    for (const id of p.claims.P4073 ?? []) {
      const api = fandomApi(id, lang);
      if (!api) continue;
      jobs.push(
        probeSite(api).then((site) =>
          site && fits(site.name) ? add(api, `series: ${p.label}`, "medium", { franchise: true, notes: [`Covers the whole ${p.label} series`] }) : null,
        ),
      );
    }
  }

  // Phase 1 (always): Wikidata links above, one cheap wiki.gg guess, then Indie Wiki Buddy.
  const names = [...new Set([query, gameName, ...wd.parents.map((p) => p.label)])];
  for (const n of new Set([query, gameName])) {
    const sl = slugs(n)[0];
    if (sl) jobs.push(add(`https://${sl}.wiki.gg/api.php`, "slug probe", "low"));
  }
  await Promise.all(jobs);

  // Indie Wiki Buddy: Fandom -> new home, and direct name matches
  const local = sites.filter((s) => s.language === lang.toUpperCase());
  const fandomKey = (c: Candidate) => c.articleUrl.replace(/^https?:\/\//, "").replace(/\/wiki\/\$1$/, "");
  const iwbDone = new Set<IwbSite>();
  const runIwb = () => Promise.all(local.map(async (s) => {
    const label = s.origins_label.replace(IWB_NOISE, " ").trim();
    const nameHit = [gameName, ...wd.parents.map((p) => p.label)].some(
      (n) => Math.max(nameMatch(n, label), nameMatch(n, s.destination)) === 1 && Math.max(nameMatch(label, n), nameMatch(s.destination, n)) >= 0.75,
    );
    const fandoms = [...cands.values()].filter((c) => c.host === "fandom" && s.origins.some((o) => o.origin_base_url.replace(/\/$/, "") === fandomKey(c)));
    if ((!nameHit && fandoms.length === 0) || iwbDone.has(s)) return;
    iwbDone.add(s);
    const isFranchise = fandoms.length > 0 && fandoms.every((f) => f.franchise);
    const c = await add(iwbApis(s), "indie-wiki-buddy", fandoms.length ? (isFranchise ? "medium" : "high") : "medium", {
      official: s.tags?.includes("official"),
      franchise: isFranchise || undefined,
      notes: [
        ...(fandoms.length ? [`Community moved here from ${fandoms.map(fandomKey).join(", ")}`] : []),
        ...(isFranchise ? fandoms.flatMap((f) => f.notes.filter((n) => n.startsWith("Covers the whole"))) : []),
      ],
    }, s.destination);
    for (const f of fandoms) {
      f.superseded = true;
      if (!c) f.newHomeUnreadable = true;
      const where = c ? `${c.name} (${new URL(c.api).host})` : `${s.destination} (${s.destination_base_url})`;
      f.notes.push(`Editors moved to ${where}; this Fandom copy may be out of date`);
    }
  }));
  await runIwb();

  // Phase 2 (only when phase 1 found nothing solid): guess more addresses and ask Fandom's wiki search.
  // Kept behind the check because it costs ~10-20 requests per game, and wiki hosts rate-limit.
  const solid = [...cands.values()].some((c) => rank(c.confidence) >= 2 && (!c.superseded || c.newHomeUnreadable) && c.articles >= 50 && fits(c.name));
  if (!solid) {
    const more: Promise<unknown>[] = [];
    const probeApis = new Set<string>();
    for (const n of names)
      for (const sl of slugs(n)) {
        probeApis.add(`https://${sl}.wiki.gg/api.php`);
        probeApis.add(`https://${sl}.fandom.com/api.php`);
      }
    for (const a of probeApis) more.push(add(a, "slug probe", "low"));
    // Fandom's wiki search catches wikis whose address doesn't follow the game's name (rainbowsix for Siege).
    for (const n of [...new Set([gameName, ...wd.parents.map((p) => p.label)])].slice(0, 3))
      more.push(
        fandomSearch(n, lang).then((apis) =>
          Promise.all(apis.map(async (a) => {
            const site = await probeSite(a);
            return site && fits(site.name) ? add(a, "fandom search", "medium") : null;
          })),
        ),
      );
    await Promise.all(more);
    await runIwb();
  }



  // Name sanity check for weak sources; drop clear mismatches and fan-fiction wikis.
  const fanQuery = /fanon|fan ?fic|creepypasta|roleplay|ideas/i.test(query);
  for (const [key, c] of cands) {
    if (!fanQuery && /fanon|fan ?fic|creepypasta|role ?play|ideas wiki|fan ?made/i.test(c.name)) { cands.delete(key); continue; }
    const m = Math.max(...names.map((n) => nameMatch(n, c.name)));
    if (c.confidence === "low") {
      if (m < 0.5) cands.delete(key);
      else if (m === 1) c.confidence = "medium";
    }
  }

  // Freshness + scoring
  await Promise.all([...cands.values()].map(async (c) => (c.lastEdit = await lastActivity(c))));
  const now = Date.now();
  for (const c of cands.values()) {
    // A wiki named after the series rather than this game (RuneScape Wiki for Old School RuneScape) is series-wide,
    // however it was found.
    if (c.franchise === undefined && nameMatch(gameName, c.name) < 1 && wd.parents.some((p) => nameMatch(c.name, p.label) === 1)) c.franchise = true;
    let s = rank(c.confidence) * 10;
    // Extra words in the wiki's name beyond the game/series ("Half-Life Forever", "Half-Life Machinima")
    // usually mean a mod, fan project or spin-off wiki.
    const fit = Math.max(...names.map((n) => nameMatch(c.name, n)));
    s -= (1 - fit) * 14;
    if (c.official) s += 8;
    if (c.host !== "fandom") s += 3; // editors usually leave Fandom, not the other way round
    if (c.superseded) s -= c.newHomeUnreadable ? 4 : 25; // if the new home blocks us, the old copy is the best we can read
    if (c.franchise) s -= 8;
    if (c.pageHint) s += 4;
    s += Math.min(Math.log10(c.articles + 1) * 3, 15);
    if (c.lastEdit) {
      const days = (now - Date.parse(c.lastEdit)) / 86_400_000;
      if (days > 365) { s -= 10; c.notes.push(`No human edits for ${Math.round((days / 365) * 10) / 10} years`); }
      else if (days > 90) s -= 3;
    }
    if (c.articles < 20) { s -= 8; c.notes.push(`Very small wiki (${c.articles} articles)`); }
    c.score = Math.round(s * 10) / 10;
  }
  const wikis = [...cands.values()].sort((a, b) => b.score - a.score);

  // PCGamingWiki: technical info for nearly every PC game. Always listed last; it becomes the one used only
  // when nothing else covers the game, which is common for niche indie titles.
  let pcgwTitle: string | undefined = wd.claims.P6337?.[0]?.replace(/_/g, " ");
  if (!pcgwTitle && steamAppId) pcgwTitle = await pcgwBySteamId(steamAppId);
  if (!pcgwTitle && wikis.length === 0) pcgwTitle = await pcgwByName(gameName);
  if (pcgwTitle && !wikis.some((w) => w.host === "pcgamingwiki")) {
    const site = await probeSite(PCGAMINGWIKI_API);
    if (site)
      wikis.push({
        ...site,
        confidence: wikis.length ? "low" : "medium",
        via: ["pcgamingwiki"],
        notes: ["PC technical wiki: settings, fixes, performance, save locations. Not a gameplay wiki"],
        pageHint: pcgwTitle,
        score: -100,
      });
  }

  return {
    query,
    game: wd.best ? { label: wd.best.label, description: wd.best.description, wikidata: wd.best.id } : undefined,
    otherMatches: wd.others.map((o) => ({ label: o.label, description: o.description, wikidata: o.id })),
    wikis,
    unreachable: [...unreachable.values()],
    pcgamingwiki: pcgwTitle?.replace(/ /g, "_"),
  };
}

const pcgwIdCache = new Map<number, string | undefined>();
/** PCGamingWiki's own app-ID redirect (its Cargo query API is closed to anonymous use). */
async function pcgwBySteamId(appId: number): Promise<string | undefined> {
  if (pcgwIdCache.has(appId)) return pcgwIdCache.get(appId);
  let title: string | undefined;
  try {
    const r = await fetch(`https://www.pcgamingwiki.com/api/appid.php?appid=${appId}`, { headers: { "User-Agent": USER_AGENT }, redirect: "manual", signal: AbortSignal.timeout(6000) });
    const loc = r.headers.get("location") ?? "";
    const m = loc.match(/\/wiki\/([^?#]+)/);
    if (m) title = decodeURIComponent(m[1]).replace(/_/g, " ");
  } catch {
    /* network error: no PCGW link */
  }
  pcgwIdCache.set(appId, title);
  return title;
}
async function pcgwByName(name: string): Promise<string | undefined> {
  const o = await getJson(`${PCGAMINGWIKI_API}?${qs({ action: "opensearch", search: name, limit: 5, namespace: 0, format: "json" })}`, 86_400);
  const titles: string[] = Array.isArray(o?.[1]) ? o[1] : [];
  return titles.find((t) => norm(t) === norm(name));
}

function rank(c: Candidate["confidence"]) {
  return c === "high" ? 3 : c === "medium" ? 2 : 1;
}

/** Accept "terraria.wiki.gg", "https://minecraft.wiki/w/Creeper", or an api.php URL. */
export async function siteFromUrl(input: string): Promise<WikiSite | { optOut: string } | null> {
  let u: URL;
  try {
    u = new URL(/^https?:\/\//.test(input) ? input : `https://${input}`);
  } catch {
    return null;
  }
  if (await aiOptOut(u.origin)) return { optOut: u.origin };
  if (u.pathname.endsWith("api.php")) return probeSite(u.origin + u.pathname);
  const langSeg = u.pathname.match(/^\/([a-z]{2,3}(?:-[a-z]{2,4})?)\/(?:wiki\/|$)/)?.[1];
  const tries = [langSeg ? `${u.origin}/${langSeg}/api.php` : null, `${u.origin}/api.php`, `${u.origin}/w/api.php`, `${u.origin}/wiki/api.php`, `${u.origin}/mediawiki/api.php`].filter(Boolean) as string[];
  for (const t of tries) {
    const s = await probeSite(t);
    if (s) return s;
    if (probeStatus(t) === -1) return { optOut: u.origin };
  }
  return null;
}
