# Battle Royale — Jungle arena (v1.8)

Binding plan. User request (verbatim intent): "a jungle themed map for battle royale: moss patches that slow movement, a pool in the middle that allows
animals to swim, animal swim speed based on each animal's attributes, new animations for swimming and attacking while swimming, the pool should not be deep
enough to go fully under, trees as obstacles, and keep the existing trap system based on difficulty."
Contract already in `src/core/types.ts`: `ArenaId = 'colosseum' | 'jungle'`, `ARENA_IDS`, `MatchConfig.arena?`.

## 1. Design (rules — numbers are starting values, tuned by sweeps)

* **Arena:** a jungle clearing, wall radius 30 (hard clamp like the colosseum), ring of dense foliage / mossy cliff instead of stands. ~14 **trees** (trunk
  colliders: circles r 0.8–1.5, tall = they block everyone incl. the eagle's soar), 3–4 **fallen logs** (jumpable segments, like the fallen columns), the same crate
  clusters / pickup pads / heal-and-buff mechanics as the colosseum (re-themed as wicker crates / glowing flowers), 10 spawn points on a ring (r ≈ 20).
* **Moss patches** (≈ 7 discs, r 2–3.5, kept out of the pool and away from spawns/pads): a grounded fighter (altitude ≤ 0.6 m, not burrowed) whose body circle overlaps a patch
  is **slowed 35 %** (same `slow` buff + linger mechanism as the hippo's mud pool; flyers/jumping fighters are not slowed; no damage). All animals are slowed equally.
* **Pool** in the centre (r ≈ 6.5): **shallow** — a visible water depth of ≈ 0.55 m, so the biggest animal is never fully submerged and nobody can go "under".
  A grounded fighter inside the pool is **wading/swimming**: its LOCOMOTION speed is multiplied by a per-animal **water multiplier** derived from a `swim` attribute on each animal
  (real-life-informed, applied to the animal's own land speed — so it also respects each animal's base speed/size/mass): crocodile ≫ hippo > python > panther > mole ≈ lion > eagle (on foot)
  > rhino > gorilla > giraffe (starting multipliers ≈ 0.95 / 0.85 / 0.75 / 0.6 / 0.55 / 0.5 / 0.45 / 0.4 / 0.35 / 0.35 of land speed; a unit test pins the ordering). Terrain slows only normal locomotion:
  abilities/ultimates that move the fighter (pounce, charges, dashes, soar) keep their own speeds. The mole's **Burrow** special does not work in the water (it fizzles, cooldown refunded).
  Block/attacks/ultimates work normally in water; knockback is unchanged.
* **Traps:** the existing difficulty-scaled trap system stays unchanged, but placement now uses the ARENA's obstacles, pads, spawns and **terrain exclusions** (never in the pool, never on moss, never inside/near trees).
* **State/events (additive, in snapshots):** `FighterState.inWater?: boolean`, `onMoss?: boolean` (absent = false) so the renderer/HUD/audio/bots/net don't recompute terrain; event `{type:'splash', fighterId, pos, entering, strength}` on entering/leaving the water (cosmetic: splash VFX + sound).
* **Bots:** avoid trees (obstacle steering as for pillars), treat moss/water as costly terrain (levels ≥ 3 avoid fighting in them unless they are fast swimmers; croc/hippo may use the pool as an advantage), never get stuck on trees/logs; behaviour on the colosseum must stay identical.
* **Look:** lush jungle — layered canopy, giant trunks with buttress roots, vines, ferns, mist, light shafts, glowing flowers/fireflies, mossy rocks; moss patches as soft green glowing decals with tufts; the pool with animated water (gentle waves, ripples, lily pads, a shoreline of wet stones/reeds), partially transparent so submerged legs read; trunks that sit between the camera and the player fade out.
* **Animation:** swimming locomotion for all 10 animals + **attack while swimming** (basic attacks 1–3 and block get a wading/swimming variant: body lowered into the water, pitched up, bigger lunge-recoil, splash at the impact frame); idle bobbing in water; smooth blend in/out (≈ 0.15 s); per-animal flavour (crocodile tail-sculling, hippo bobbing, python S-undulation, giraffe stilting through, eagle paddling with half-spread wings, mole tiny paddle, panther/lion dog-paddle, gorilla wading with arms, rhino plodding).
* **Audio:** jungle ambience bed (birds, insects, distant water), splash on enter/exit (scaled by `strength`), soft slosh loop while moving in water, squelch on moss (subtle, throttled).
* **Menus/flow:** Battle Royale gets a MAP choice (Colosseum / Jungle) on the Difficulty screen (stored in `gk-arena`); online Battle Royale rooms get a host-picked map (`RoomSettings.br.arena` → `OnlineStart.br.arena`); a QA shortcut `?br=1&arena=jungle&animal=…&level=…&qa=1` boots straight into a BR match.

## 2. Work packages (Sonnet 5.5 agents; sequential first, then parallel)

| WP | wave | owns | notes |
|---|---|---|---|
| **J1a arena refactor + jungle data** | 1 | `src/config/arenas.ts` (new `ArenaDef` + registry), `src/config/arena.ts` (kept as the colosseum's constants / re-exports), `src/sim/**` (World carries `arena`; every sim module reads obstacles/walls/pads/spawns/trap placement from it), `src/ai/**` (arena passed to BotManager/Perception/Steering/dangerZones), `scripts/balance-sweep.ts` (`ARENA=` env), tests | **colosseum behaviour must be IDENTICAL** (proof: fresh `npm run balance` baseline before/after + all tests); also defines the jungle `ArenaDef` data (trees, logs, crates, pads, spawns, wall, terrain zone definitions as DATA) |
| **J1b terrain mechanics** | 2 | `src/sim/**` (new `TerrainSystem`), `src/config/animals.ts` (`swim` attribute) + `src/config/terrain.ts`, `src/core/types.ts` (FighterState flags + `splash` event), `src/online/br/**` codecs (snapshot flags + event) + tests, TrapSystem placement exclusions, mole burrow rule | moss slow, water speed multipliers, flags/events, traps respect terrain, net codecs |
| **J2 bots + balance** | 3 | `src/ai/**`, `scripts/balance-sweep.ts`, `docs/BALANCE.md` | tree/terrain awareness; BR sweeps on the jungle at all 4 levels; tune swim multipliers/moss slow within the plan |
| **J3 scene + VFX + audio** | 3 | `src/render/**` (arena scene abstraction, `src/render/jungle/**`, water/splash/ripple VFX, camera tree-fade, quality tiers), `src/audio/**` | |
| **J4 swim animations** | 3 | `src/render/animals/**` (additive hooks in `Animator.ts`, per-animal swim/attack-swim overlays), demo + tests | uses `FighterState.inWater` |
| **J5 menus + online + HUD** | 4 | `src/ui/DifficultySelect.ts` + CSS (map cards), `src/ui/storage.ts` (`gk-arena`), `src/match/MatchController.ts` + `src/main.ts` (arena plumbing, QA shortcut), `src/online/room/**` + `src/online/ui/**` + `src/online/br/**` (host-picked arena in rooms/start), HUD terrain tag | |
| **Q** | 5 | everything | two-tab online BR on the jungle, packaged smoke, perf |

Rules: the colosseum stays byte-identical in behaviour; everything new is additive/optional; BR online codecs must cover every new field; sim changes → MINOR bump (1.8.0).
