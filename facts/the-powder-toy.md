---
game: The Powder Toy
aliases: Powder Toy, TPT
version: 100.1
verified: built and observed in-game (power plants, fusion and fission reactors) and checked against the game's source, 2026-09-24 to 2026-09-26
---

- Only basic WALL is indestructible enough to contain a fusion reactor.
- ARAY fires a light beam only when sparked through METL. A PSCN spark makes it a destroy ray instead.
- DMND is the only particle that survives as a heat pipe through a wall. The plug must cover the whole 4-pixel wall cell, or it leaks.
- EXOT turns into WARP at more than 200 pressure and more than 9000 K. WARP holds itself at 10000 K and stirs the gas, which keeps CO2 fusion going. CO2 only fuses above 9773 K and above 200 pressure.
- WATR and DSTW both conduct sparks. Any spark source touching water floods it with SPRK.
- A wall only passes a spark to a particle on the pixel directly next to a powered wall cell.
- Solid TTAN lines block air (a pressure trap). Dotted lines let it through.
- URAN self-heating is positive feedback with pressure, and runs away to about 9725 °C.
- POLO with tmp >= 5 stops emitting neutrons and only warms itself to about 115 °C.
- GOLD takes sparks from exactly 4 pixels away orthogonally, even through INSL. Keep gold away from other circuits and use PSCN/NSCN wires.
- PSTN pushes and pulls the whole contiguous column it touches. Set the piston's tmp to the rod length, or it drags floors along.
- When PSCN and NSCN both spark near a piston, NSCN wins (it comes later in the scan order).
- TSNS works through walls. Its range is tmp2 <= 25; tmp=0 triggers on hotter, tmp=2 on cooler.
- BRCK shatters at 8.8 pressure. GLAS shatters on pressure *change*, and its life value raises its strength.
- NEUT passes through WATR, DSTW, GLAS, CRMC, GOLD and DEUT. TTAN absorbs it.
- A steady DEUT burn needs a clone-fed neutron source.
- HEAC never melts or breaks, reflects neutrons, and doesn't conduct electricity.
- TUNG breaks into BRMT on pressure jumps above about 0.5 per frame.
- PRTI/PRTO and WIFI don't conduct heat. PRTI swallows any non-solid, including neutrons.
- WIFI only outputs into PSCN, NSCN or INWR.
- CLNE spawns the cloned element at that element's default temperature, not the clone's temperature.
- LCRY shows no visible change in the "Nothing" display mode, so it makes a bad light in that mode.
- In the Lua console (backtick key), `dofile()` needs a full absolute path. Wall IDs for `sim.wallMap`: WALL 8, conductive wall 1, EWALL 2, detector 3, liquid-only 6, fan 5, gas-only 13.
- Ctrl+click on the save icon quick-saves over the currently opened local save, without asking.
