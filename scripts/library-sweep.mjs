// Run the resolver over a Steam library export: node scripts/library-sweep.mjs apps.json > results.jsonl
// apps.json: { "<appid>": { "name": "...", "type": "game" | "dlc" | ... } }  (from the Steam store appdetails API)
import { readFileSync } from "node:fs";
import { resolveGame } from "../dist/resolver.js";
import { requestsMade } from "../dist/http.js";

const apps = JSON.parse(readFileSync(process.argv[2], "utf8"));
const games = Object.entries(apps).filter(([, v]) => v.name && (v.type === "game" || v.type === "mod"));
let i = 0;
const worker = async () => {
  while (i < games.length) {
    const [appid, v] = games[i++];
    const t = Date.now();
    const before = requestsMade();
    try {
      const r = await resolveGame(v.name, "en", Number(appid));
      console.log(JSON.stringify({
        appid, name: v.name, matched: r.game?.label ?? null, desc: r.game?.description ?? null, ms: Date.now() - t, requests: requestsMade() - before,
        wikis: r.wikis.slice(0, 3).map((w) => ({ host: new URL(w.api).host, kind: w.host, conf: w.confidence, articles: w.articles, sup: !!w.superseded, series: !!w.franchise, page: w.pageHint ?? null })),
        blocked: r.unreachable.map((u) => u.url),
      }));
    } catch (e) {
      console.log(JSON.stringify({ appid, name: v.name, error: String(e) }));
    }
  }
};
// One game at a time: wiki hosts rate-limit by platform, and a library sweep is a burst.
await worker();
