# Battle Royale — Ocean Dome arena (v1.9)

Binding plan. User request (verbatim intent): "another map that is ocean themed with a circular dome over top, aquatic animals swimming in the ocean beyond that, multiple
different elevations you can reach via ramps, and a sea monster event that has a 1/10 chance to occur once every minute: it spawns a sea serpent that attacks starting from
a random point on the map's edge and reaches all the way to the center, dealing 300 damage to anyone within its path. It should be fast enough to be difficult to dodge but not impossible."
Contract already in the tree: `ArenaId` has `'ocean'`; `src/config/arenas.ts` has `ElevationPiece` (plateau / ring / ramp), `ArenaDef.heightfield?`, `ArenaDef.hazards?: {serpent?: boolean}`
and a PLACEHOLDER `OCEAN_ARENA` (a clone of the jungle) that WP-O1a replaces.

## 1. Design

* **Arena "Ocean Dome"**: the floor of a circular glass dome on the sea bed, wall radius 30 (hard clamp like the others). **Three levels** — the outer seabed ring (height 0, where the 10 spawns are),
  a mid terrace (≈ 1.5 m) and a raised inner plateau/altar (≈ 3 m) around the centre — connected by **ramps** (slope ≤ 25°, ≥ 5 m wide; ≥ 4 ramps up to the mid terrace at different angles and ≥ 3 from the
  terrace to the plateau, offset from each other so routes differ). Between ramps the level edges are **cliffs**: a grounded fighter can't step up more than `STEP_UP` (0.6 m, the dais rule) so it must use a
  ramp (or jump onto a 0.6–1.2 m step if its jump reaches; the eagle can soar onto anything); walking OFF a cliff just drops you. Cover: coral pillars/arches and rock outcrops (circle/segment solids like the
  other arenas, a few on each level), crate clusters on two levels, 6 pickup pads spread over the levels (the best-reward pad on the centre plateau — it is also where the serpent's strike ends).
* **Traps** keep working by difficulty; placement uses the arena's levels (a trap sits on the ground height of its position, never on ramps, never within the serpent-immune... — just never on ramps/cliff edges).
* **Sea serpent event** (numbers in `src/config/serpent.ts`): every 60 s of live match time (t = 60, 120, 180 …) the world rolls a seeded RNG (its own stream, salt XOR'd into the match seed so the sim RNG is never perturbed): 10 % → the event.
  A random angle θ on the dome edge is picked from the same stream. Timeline: **WARN** ≈ 1.3 s (the strip along the line from the edge to the centre, half-width ≈ 1.6 m, is telegraphed; the serpent coils outside) →
  **STRIKE** ≈ 0.55 s (the head travels from the wall to the centre at ≈ 55 m/s; every fighter whose body circle is overlapped by the head's swept capsule while its altitude above the LOCAL ground is ≤ 3 m takes **300 TRUE damage**
  once per event — blocking/guard/armour/bloodlust never change it, it grants no ult charge, a kill credits nobody: `killerId −1`, cause "serpent") → **HOLD** ≈ 0.35 s at the centre → **RETREAT** ≈ 0.8 s back out. Soaring eagles and anyone
  > 3 m above the ground are not hit. Tuning target ("difficult but not impossible"): a fighter who starts moving off the line when the warning begins always escapes (even the slowest animal); a fighter reacting after 0.7 s escapes only if
  fast/lucky; Apex bots dodge ≥ 90 %, Veteran ≥ 75 %, Fighter ≥ 50 %, Cub ≈ 25–40 %; a stationary fighter on the line is always hit. Matches rarely see it (≈ 10 % per minute).
* **Snapshot/events** (additive): `WorldSnapshot.serpent?: {phase: 'warn'|'strike'|'hold'|'retreat', angleDeg, t, headR}` while an event runs (absent otherwise); events `serpentWarning {angleDeg, warnS}`, `serpentStrike {angleDeg}`, `serpentHit {fighterId, damage, pos}`, `serpentEnd`.
* **Look**: the glass dome (dome mesh over the arena, fresnel-glass, a metal/coral base ring, light caustics through water) with the open ocean outside: blue-green volume, god-rays from the surface, kelp, coral reef, **aquatic life swimming beyond the dome** (fish schools, sharks circling, a whale passing, rays, turtles, drifting jellyfish — decorative, instanced/boid-like, looping), sandy seabed floor with ripples, glowing coral, tiers built of rock/coral with ramps; at the serpent event: the dome shudders, a huge silhouette coils outside, the strip glows on the floor, the head breaks through the dome (cracking glass VFX that heals), crosses to the centre with a shockwave, retreats; HUD banner + direction marker during the warning. Audio: muffled underwater ambience (bubbles, distant whale song), serpent sting + roar + crash.
* **Bots**: navigate by ramps (a walkability grid + A* over the arena's heights/solids), use levels tactically, **dodge the serpent** by level (reaction time per level; L1 mostly late).
* **Menus/online**: the Map row on the Difficulty screen gets a third card (Ocean Dome); the online BR room map picker offers it; QA shortcut `?br=1&arena=ocean&serpent=1&…` forces an early serpent event.
* **Rules**: the colosseum and jungle stay byte-identical in behaviour (heightfield/hazards absent); sim + wire-format change → MINOR bump (1.9.0), `ONLINE_PROTOCOL_VERSION` 3.

## 2. Work packages

| WP | wave | owns | notes |
|---|---|---|---|
| **O1a elevations + ocean data** | 1 | `src/config/arenas.ts` (replace `OCEAN_ARENA`, `arenaGroundHeight`), `src/sim/{MovementSystem,World (height parts),TrapSystem,PickupSystem,Fighter}.ts`, `tests/config`, `tests/sim/arena*` | height field + cliff/step rule + ramps, ocean layout, walkability helper for bots, identity proof for colosseum/jungle |
| **O1b serpent system** | 1 | new `src/sim/SerpentSystem.ts`, `src/config/serpent.ts`, `src/core/types.ts` (snapshot/events), `src/online/br/**` codecs + `ONLINE_PROTOCOL_VERSION`, `src/online/room/fingerprint.ts`, a one-line hook in `World.step`, `tests/sim/serpent*`, `tests/online/br*` | roll schedule, timeline, damage, determinism, codecs; `debugTriggerSerpent` + test override options |
| **O2 bots** | 2 | `src/ai/**`, `scripts/balance-sweep.ts`, `docs/BALANCE.md` | A* ramps, levels, serpent dodging, balance on the ocean arena |
| **O3 scene/VFX/audio** | 2 | `src/render/**` (except animals), `src/audio/**` | dome, ocean life, tiers/ramps, serpent set piece, camera vs terrain |
| **O4 menus/online/HUD** | 2–3 | `src/ui/**`, `src/match/**`, `src/online/{room,ui}/**`, `src/main.ts` | third map card, room picker, serpent warning HUD + marker, kill-feed cause, QA shortcut |

## 3. Serpent tuning (WP-O1b, measured)

**Final numbers** (`src/config/serpent.ts`, all within the plan's ±20 %): `warnS` **1.1** (plan 1.3, −15 %), `strikeS` **0.44** (plan 0.55, −20 %; head speed 30 m / 0.44 s = **68 m/s**), `stripHalfWidth` = `headRadius` **1.8**
(plan 1.6, +12.5 %), `holdS` 0.35, `retreatS` 0.8, `damage` 300 true, `hazardHeight` 3.0 above the local ground, `intervalS` 60, `chance` 0.10. One event lasts 2.69 s (≈ 161 ticks). Why: with the plan's own numbers (1.3 / 0.55 / 1.6)
even the slowest animal could start 0.77 s late and still escape from the rim, and every animal 0.9 s late — not "difficult". With the final numbers the slowest animal's budget at the rim is 0.52 s.

**Method** (`tests/sim/serpent.dodge.test.ts`): a scripted fighter of each animal stands ON the strike line (the worst spot) at distance r0 from the centre on a flat dome and, a given time after the `serpentWarning`, runs
perpendicular to the line at full speed through the real World physics (acceleration, body radius, 60 Hz). Table = the LATEST start (seconds after the warning begins, 1/60 s resolution) that still escapes:

| animal (speed m/s, radius m) | rim r0 = 26 m | 20 m | 12 m | centre 4 m |
|---|---|---|---|---|
| rhino (5.0, 1.15) | 0.52 | 0.60 | 0.72 | 0.83 |
| hippo (5.7, 1.20) | 0.57 | 0.65 | 0.77 | 0.88 |
| crocodile (5.6, 0.90) | 0.62 | 0.70 | 0.82 | 0.93 |
| gorilla (5.8, 0.80) | 0.63 | 0.73 | 0.85 | 0.97 |
| python (5.4, 0.70) | 0.63 | 0.72 | 0.83 | 0.95 |
| giraffe (6.0, 0.90) | 0.63 | 0.73 | 0.85 | 0.97 |
| mole (5.6, 0.50) | 0.68 | 0.77 | 0.88 | 1.00 |
| lion (6.5, 0.70) | 0.70 | 0.78 | 0.90 | 1.02 |
| panther (7.0, 0.65) | 0.72 | 0.82 | 0.93 | 1.05 |
| eagle (7.2, 0.55) | 0.75 | 0.83 | 0.95 | 1.07 |
| animals that escape if they start 0.0 s after the warning | 10/10 | 10/10 | 10/10 | 10/10 |
| … 0.4 s after | 10/10 | 10/10 | 10/10 | 10/10 |
| … 0.7 s after | **3/10** (lion, panther, eagle) | 8/10 | 10/10 | 10/10 |
| … 1.0 s after | 0/10 | 0/10 | 0/10 | 4/10 |
| … 1.1 s or later | 0/10 | 0/10 | 0/10 | 0/10 |

Targets: (a) starting with the warning → everybody escapes, everywhere ✓; (b) the slowest animal (rhino) escapes when starting within 0.5 s, everywhere ✓ (0.52 s at the rim); (c) starting 0.7 s after: only the fast animals
(lion / panther / eagle) escape from the rim, the slow ones never ✓ — nearer the centre the head still has to cross the dome, so more time remains (8/10 at 20 m, everyone at ≤ 12 m); (d) starting ≥ 1.1 s after → nobody escapes,
anywhere ✓ (fastest latest start: eagle 1.07 s at the centre); (e) a stationary fighter on the line is always hit ✓. The escape budget grows by 1 s per 68 m (the head's speed) of extra distance the head has to travel, i.e. toward the centre: the rim is the dangerous place, the centre plateau the
safest. **For O2 (bots):** a bot reacting `d` s after the warning at distance r0 escapes iff `d ≤ table[animal][r0]` (interpolate by r0), if it picks a direction perpendicular to the line (the shorter way out of the strip; it must
travel `stripHalfWidth + bodyRadius` ≈ 2.4–3.0 m laterally) — the target dodge rates (Apex ≥ 90 %, Veteran ≥ 75 %, Fighter ≥ 50 %, Cub 25–40 %) therefore map to reaction times of roughly ≤ 0.3 / 0.45 / 0.6 / 0.75-1.0 s plus
a 10-30 % chance to pick a bad direction or get blocked by an obstacle/another fighter. Cliffs and ramps cost extra time (the table is for flat ground).

**API for O2–O4 (all additive):**

* `WorldSnapshot.serpent?: { phase: 'warn'|'strike'|'hold'|'retreat'; angleDeg: number /* [0,360), direction (cos θ, sin θ) in (x, z) from the centre to the edge point */; t: number /* s into the phase */; headR: number /* head centre distance from the centre, m: wallRadius while warning, wallRadius → 0 in the strike, 0 while holding, 0 → wallRadius on the retreat */ }` — present ONLY while an event runs. Phase lengths from `SERPENT` (`warnS/strikeS/holdS/retreatS`); only STRIKE hurts.
* Events: `serpentWarning {angleDeg, warnS}`, `serpentStrike {angleDeg}`, `serpentHit {fighterId, damage /* hp actually removed */, pos}`, `serpentEnd`; a death caused by the strike is `death {killerId: -1, cause: 'serpent'}` (the optional `cause` exists ONLY on serpent kills — traps stay "killerId −1, no cause"; the `serpentHit` of the victim precedes the `death` in the same tick). The match ending mid-event ends it at once (`serpentEnd`, no snapshot block).
* Config: `import { SERPENT, serpentStrikeSpeed, SERPENT_EVENT_S } from 'config/serpent'`; arena flag `arena.hazards?.serpent`; geometry helper: a fighter is hit iff its centre is within `SERPENT.headRadius + def.radius` of the head's swept segment and `pos.y − arenaGroundHeight(arena, x, z) ≤ SERPENT.hazardHeight`, alive, not `untargetable`, not burrowed.
* QA / tests: `new World(cfg, seed, bus, { serpent: { chance?, intervalS?, firstAtS? } })` (first roll at `firstAtS` live seconds, then every `intervalS`; defaults = the real rules) and `world.debugTriggerSerpent(angleDeg?)` (queues a WARN that starts with the next tick; false when an event runs / is queued or the arena has no serpent). `world.serpent` (null off-ocean) exposes `rollLog`, `phase`, `active`.
* Wire: `ONLINE_PROTOCOL_VERSION` 3 — snapshot header flag 64 + a 6-byte block (angle u16, phase<<14 | t ms u16, headR cm u16; absent most of the time, ≈ 80 snapshots per event at 30 Hz), events tags 23–26 (7 / 3 / 11 / 1 bytes incl. tag) and a trailing cause byte on `death`. The client interpolates `serpent.t/headR` between snapshots (`lerpSnapshots`).
