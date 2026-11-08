---
game: Data Center
aliases: Data Center (WASEKU), datacenter
version: Steam release builds of 2026-09 (Steam app 4170200)
verified: hardware specs checked in-game by a player; engine internals confirmed while building a MelonLoader mod against the game (2026-09)
---

Hardware (in-game specs):
- Every server has 2 × 1 Gbps RJ45 ports. Each of the 4 colours (Yellow, Blue, Magenta, Green) comes in two sizes: 7U = 12,000 IOPS, 3U = 5,000 IOPS. Both sizes push 0.3 Gbps.
- Switches are all 1U:
  - Switch A: 16 × 10G RJ45, fixed
  - Switch B: 4 × SFP+/SFP28
  - Switch C: 32 × QSFP+
  - Switch D: 4 × QSFP+ plus 16 × SFP+/SFP28
- Patch panels are all 2U: RJ45 = 18 × RJ45; Combo = 10 × RJ45 + 8 × fiber; Fiber = 18 × fiber (up to 100 Gbps).
- SFP modules: SFP+ RJ45 (10G), SFP+ fiber (10G), SFP28 (25G).
- QSFP+ modules: 40G, 100G, 200G, 400G, 800G, 1.6T, 3.2T, 6.4T.
- The rack is 19-inch, 47U, 800 × 800 mm.
- Link bandwidth = min(ports at each end) × min(port speed at each end).

Engine and modding:
- Unity HDRP with DOTS/ECS, built with IL2CPP.
- There are 34 customers.
- App icons are **not** tied to the app. Each save assigns every customer's app a random logo slot.
- `CustomerItem.customerName` and `.logo` are IL2CPP field accessors and can't be Harmony-patched. Write the fields on the ScriptableObject directly instead.
- `CustomerColor.GetColorForCustomerId` can be patched.
- The first launch after a game update loads no MelonLoader mods.
