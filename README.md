# Bestiary

An MCP server that gives AI assistants real video game knowledge. AI models know the general feel of most
games but guess at specifics: drop rates, recipes, boss health, which patch changed what. This server finds
the right wiki for **any** game and reads it, so the model can cite facts instead of making them up.

> MCP server for AI assistants. Contact: open an issue at https://github.com/tiiow-fedora/bestiary-mcp

## What it does

| Tool | Purpose |
|---|---|
| `find_game_wiki` | Game name → ranked wikis (independent / wiki.gg / Fandom), with freshness, size, and warnings. |
| `search_game_wiki` | Full-text search on the best wiki for a game (or a wiki you name). |
| `read_wiki_page` | A page as compact markdown, tables and infoboxes kept. Intro + section list first, then one section at a time. |
| `get_verified_facts` | Facts someone confirmed in-game, with the game version. They outrank the wiki. |

### Finding the right wiki

Many game communities left Fandom for wiki.gg or their own sites, and the Fandom copy kept getting traffic
while it went stale. The resolver combines:

1. **Wikidata** for the game entity: Fandom wiki ID (P4073), Fandom article ID (P6262), official site (P856),
   PCGamingWiki (P6337), plus its series/franchise for games covered by a franchise wiki (Fallout 4 → Fallout Wiki).
2. **[Indie Wiki Buddy](https://github.com/KevinPayravi/indie-wiki-buddy)** data (MIT) for where each
   Fandom community moved. The old copy is marked `SUPERSEDED`.
3. **Probing** `{slug}.wiki.gg` / `{slug}.fandom.com`, accepted only if the wiki's own name matches.

It then ranks by trust, freshness (last human edit), size, and whether the wiki covers one game or a whole series.
In a 53-game test it picked the right wiki for every one, including Minecraft → minecraft.wiki,
OSRS → oldschool.runescape.wiki, Zelda TotK → zeldawiki.wiki, and Skyrim → Fandom with a note pointing to UESP.

### Being a good guest

- Every request carries a descriptive User-Agent; per-host spacing and caching keep load low.
- A wiki that opts out of AI fetchers in robots.txt (`ChatGPT-User`, `Claude-User`, … or `*` site-wide), or that
  sits behind a bot challenge (Cloudflare, Anubis), is **never read**. It is still named, with a link, so the user can go
  there themselves. Today that covers stardewvalleywiki.com, UESP, fallout.wiki, Liquipedia, and the TF2 wiki.
- Path rules that keep crawlers off `api.php` aren't applied to single, user-requested lookups. Anything that
  bulk-fetches must use the full RFC 9309 check in `src/robots.ts`.
- Wiki text is wrapped in random per-response delimiters and labelled as untrusted data (prompt-injection defence).
- Every answer carries the page URL, the wiki's license (read from the wiki), and the page's last edit date.

## Use it

```bash
npm install
npm run build
claude mcp add bestiary-mcp --scope user -- node /path/to/bestiary-mcp/dist/stdio.js
```

Any MCP client works the same way: run `node dist/stdio.js` over stdio.

## Verified facts

Add `facts/<game>.md` (copy `facts/_TEMPLATE.md`). Front matter states the game version and how each fact was
verified. `npm run build` bundles them. There is no write tool: facts change only through reviewed commits.

## Dev

- `node scripts/smoke.mjs` runs the default checks; `node scripts/smoke.mjs <tool> '<json args>'` calls one tool.
- `node scripts/sweep.mjs [games...]` runs the resolution sweep.
