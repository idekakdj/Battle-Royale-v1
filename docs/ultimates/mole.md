# Mole — Sinkhole Vortex (v1.3, as built)

Ground-zone AoE, redesigned: the Mole digs in, a **tremor crack** races along the ground to the zone while the Mole tunnels beneath it,
the ground collapses into a **vortex pit** that drags grounded fighters to the centre and grinds them for 2 s, then **collapses** (damage + root).

Files: `src/sim/ultimates/mole.ts` · `src/config/ultimates/mole.ts` (spec + `MOLE_VORTEX` timeline) · `src/ai/ultScripts/mole.ts` ·
`src/render/animals/Mole.ts` (`poseUltimate`, tunnelling heap) · `src/render/ultFx/mole.ts` · `src/audio/ults/mole.ts` · `tests/sim/ultimates/mole.test.ts`.

## Mechanic

| Item | Value |
|---|---|
| Targeting | `ground`, aim point up to 10 m (snaps onto the foe you aim at, as before), zone radius 4.5 m; no `requireTarget` (can be cast as area denial) |
| Windup 1.3 s (`spec.windup`) | **Dig** 0.4 s in place (visible, targetable until 0.3 s) → **tunnel** 0.9 s: untargetable + uninterruptible, the Mole travels underground (smoothstep) along the crack to the pit rim |
| Surface point | 0.9 m outside the pit rim on the side it came from (a foe closer than that: the Mole stays put, the pit forms on the foe) |
| Active: **vortex** 2.0 s (stage 1) | Mole surfaces, vulnerable but still uninterruptible (`ccImmuneChannel`). Every fighter in the pit (radius 4.5 + body) and within ground reach (≤ 2.5 m): **grind 30/s** (7.5 every 0.25 s, unblockable, no flinch). Every *grounded* one (altitude ≤ 0.6 m, not CC-immune, not grabbed/holding someone) is **pulled toward the centre at 5 m/s** (stops 0.35 m short; respects pillars/crates/wall). Flyers and high jumpers are not pulled/ground-ticked; a hop breaks the pull |
| **Collapse** (stage 2) | 100 to everyone in the pit (blockable, stagger) + **root 2 s**; the Mole's +25 % vs rooted (every Mole hit, `bonusVsRooted`) stays |
| Recovery | 0.7 s (slam follow-through + shake-off), interruptible |

Expected value per victim that stays in the pit: 60 (grind) + 100 (collapse) = **160**, then a rooted +25 % punish window.
Bot-facing: `dodge: { mode: 'fixed', activeS: 2.2 }` → the zone (circle at the pit centre, radius 4.5) is live from the cast for 1.3 + 2.2 s.

### Stage protocol
`ultimateTarget` (ground, `windup` = 1.3 lead until the pit opens, `width` 9) · stage **1** at the pit opening (`pos` = centre) · stage **2** at the collapse.
`actionT/actionDur` restart at each phase (windup 1.3 → vortex 2.0 → recovery 0.7) so the rig can use `actionT/actionDur` per phase.

## Counterplay
Leave the marked ground while the crack races in (≈ 1.3 s to get out of 4.5 m + body); once the pit is open only fast/flying/jumping fighters escape
(a run at 6–7 m/s nets ≈ 1–2 m/s against the 5 m/s pull). Flyers are immune. Blocking does not stop the grind or the pull; it does soften the collapse.
Bots: L1 never dodges, L2 lazy, L3 reliable, L4 strict; real Apex bots are caught in ≤ 1 of 8 seeds.

## Animation beats (`MoleRig`, driven only from `ultPhase/actionT/actionDur`)
1. **Dig-in** (0–0.4 s): rears up, then claws scoop alternately while the body drives nose-first into the dirt (body sinks 0.34 m).
2. **Underground travel** (0.3–1.3 s): the body is hidden (`update` override) and a churning dirt heap with a trailing ridge (child of the rig root) rides the crack.
3. **Surface** (vortex t 0–0.35 s, cubic ease-out): bursts up at the rim, the heap collapses away, arms thrown up.
4. **Directing** (vortex): arms raised and spread, circling as if winding the vortex, head up, body swaying; the last 0.3 s it coils back (arms higher, body rearing).
5. **Slam finale** (recovery 0–0.1 s, cubic ease-in): both claws hammer the earth, held buried briefly.
6. **Shake-off**: decaying full-body shake, arms flick the dirt, back to idle.

## VFX (`src/render/ultFx/mole.ts`)
Dig dirt fountain + dust ring; crack ribbon (`setReveal`, chevrons) with crack decals left along the path and dirt kicked up over the tunnelling heap; zone ring with a growing warning fill.
Pit open: dust burst, shock ring, radial cracks, a **dark depression decal** growing over the zone with a **rotating sand swirl** on top, two counter-rotating dashed rings, sand spiralling inward and up.
Collapse: big dust cloud, shock rings, crack, flash, sparks; the crater decals fade over ~1.6 s on their own timers.

## Audio (`src/audio/ults/mole.ts`)
Dig scrabble + a swelling underground rumble + crackling crack sweep; pit opening boom then the sucking-whoosh bed (low-passed noise, cutoff rising and swirl-AM'd) over a trembling sub for the 2 s; collapse boom + crash + falling debris. Beds fade on an aborted cast (`onEnd`).

## First-person notes
- **Clear view (ultimate only):** while the ultimate runs (`action === 'ultimate'`, every phase / stage) the own rig is screen-space clipped out of the centre 50% x 60% of the screen (`ultClip` in the FP profile, `fp/clip.ts`). The normal first-person look (idle, run, attacks, block, ...) is unchanged. Measure with `await __gkFp.report()` (dev build): 0 safe-zone pixels, <= ~12% of the frame in every stage.
- Dig-in: pitch down and sink (eye height drops 0.3 m), dirt spray at the edges.
- Tunnel: hide the body, keep a low ground-skimming view with the crack ahead; screen rumble.
- Surface: rise to full eye height with a slight pitch up, then look at the pit centre (`ultimateStage` 1 `pos`) — the swirl should fill the lower view.
- Vortex: stay on the pit centre; subtle roll sway with the swirl.
- Slam: a hard downward kick on the collapse (stage 2), then a shake-off wobble.

## Balance notes
See `docs/ultimates/mole-balance.txt`. ≈ 160 per victim caught; the pit is dodgeable before it opens, so Apex casts at rooted / staggered / committed targets, blockers, kiters and clusters.

## Tests (`tests/sim/ultimates/mole.test.ts`)
Config, `ultimateTarget`, dig/tunnel/surface (untargetable, uninterruptible, rim position and facing), short-range case, phases, pull rate (~5 m/s) and grind, total ≈ 160 + root,
timings (collapse 2 s after opening, 0.7 s recovery), +25 % vs rooted, flyers / hoppers / outsiders unaffected, dodge by leaving, walls and pillars, several victims and the Mole unhurt,
death (vortex and underground) / interrupt cleanup, bot danger zone (fixed), real Apex bots sidestepping, audio smoke test, determinism.
