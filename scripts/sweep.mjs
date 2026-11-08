// Resolution sweep: node scripts/sweep.mjs  -> one line per game with the top 2 wikis.
import { resolveGame } from "../dist/resolver.js";
const games = process.argv.slice(2).length ? process.argv.slice(2) : [
  "Stardew Valley","The Legend of Zelda: Tears of the Kingdom","Baldur's Gate 3","Factorio","Satisfactory","Valheim","Hades","Hades II",
  "Dark Souls III","Bloodborne","Sekiro","Path of Exile 2","Warframe","Destiny 2","League of Legends","Dota 2","Team Fortress 2",
  "Counter-Strike 2","Rimworld","Oxygen Not Included","Don't Starve Together","Subnautica","No Man's Sky","Cyberpunk 2077",
  "The Witcher 3","Skyrim","Fallout 4","Fallout: New Vegas","Pokemon Scarlet and Violet","Animal Crossing: New Horizons",
  "Genshin Impact","Honkai: Star Rail","Deep Rock Galactic","Risk of Rain 2","The Binding of Isaac: Rebirth","Slay the Spire",
  "Celeste","Undertale","Dead Cells","Grounded","Palworld","Lethal Company","Balatro","Helldivers 2","Monster Hunter Wilds",
  "Blox Fruits","Adopt Me!","Arknights","Final Fantasy XIV","World of Warcraft","Ark: Survival Evolved","The Powder Toy","Cookie Clicker",
];
for (const g of games) {
  const t = Date.now();
  try {
    const r = await resolveGame(g);
    const top = r.wikis.slice(0, 2).map((w) => `${new URL(w.api).host}(${w.host[0]}${w.superseded ? ",SUP" : ""},${w.confidence[0]},${w.articles})`).join("  ");
    console.log(`${g.padEnd(42)} | ${(r.game?.label ?? "-").slice(0, 28).padEnd(28)} | ${top || "NONE"}  ${Date.now() - t}ms`);
  } catch (e) { console.log(`${g} | ERROR ${e}`); }
}
