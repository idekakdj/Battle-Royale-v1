# Hippo — Riverlord's Flood (v1.3, as built)

Line ultimate that replaces Colossal Chomp: the Hippo rears up and **bellows** while the path of the coming flood is marked on the sand, slams both
forefeet, and a **wave** surges along an 11 m x 3.4 m line hitting everyone once; it then leaves a **mud pool** over the whole path that slows every
grounded fighter 40 % for ~5.5 s. The pool is a persistent sim object (`src/sim/groundZones.ts`) that outlives the ultimate and the caster.

Files: `src/sim/ultimates/hippo.ts` · `src/sim/groundZones.ts` (NEW, persistent mud) · `src/config/ultimates/hippo.ts` (spec + `HIPPO_FLOOD` timeline) ·
`src/ai/ultScripts/hippo.ts` · `src/render/animals/Hippo.ts` (`poseUltimate`) · `src/render/ultFx/hippo.ts` · `src/audio/ults/hippo.ts` ·
`tests/sim/ultimates/hippo.test.ts` · `tests/sim/groundZones.test.ts`. Shared-file hooks: see "Shared-file edits" below.

## Mechanic

| Item | Value |
|---|---|
| Targeting | `line`, range 11 m (clipped 0.5 m inside the arena wall, min 1.5 m), width 3.4 m along `aimYaw`; no lock-assist, no `requireTarget` (cannot fizzle) |
| Windup 0.9 s (`spec.windup`, stage 0) | Planted (position owned by the cast, facing locked to the cast aim), **interruptible** by a stagger like any windup (nothing happens: no slam, no mud, charge stays spent). `ultimateTarget` (kind `line`, `windup` 0.9) marks the rectangle at the cast |
| Slam + surge (Active, stage 1) | `ccImmuneChannel` while the forefeet are planted. The wave head moves at **14 m/s** (11 m = 0.79 s). A fighter is hit **once** when the head reaches its body (`along - r <= head`, lateral `<= 1.7 + r`, `along >= -r`): **130**, blockable, heavy, stagger (shared `ultOpts('stagger')` reaction), **directional shove 5 m** along the path (`applyDirectionalKnockback`; ~5.5 m in practice, the 0.15 s impulse integrates over 10 ticks). Only fighters within ground reach (altitude <= 2.5 m) and not untargetable are hit: a high jump / flight clears the flood |
| Mud pool | Laid at the slam, **one rectangle** along the whole path that fills as the wave passes (`growS` = surge time), expires **5.5 s after the slam** (`mudS`). Slows every **grounded** (altitude <= 0.6 m), alive, targetable fighter whose body overlaps the laid part by **40 %**. Applied as a normal `slow` buff refreshed each tick to 0.3 s (the mud clings after leaving / expiry); a stronger slow from elsewhere is never weakened. **The hippo itself is unaffected** (`mudSlowOwner: 0`): the lord of the river wades through its own mud; no allies exist in this mode |
| Recovery 0.7 s (stage 2) | Heavy exhale, interruptible |

Total commitment 0.9 + 0.79 + 0.7 = 2.4 s. Value per victim in the path: 130 (+ stagger, 5.5 m shove) plus ~4.7 s of -40 % speed if it stays in the pool.
Expected hit-event share of the ult at L3/L4 ~ 3-9 % (Apex bots sidestep the marked path).

### Persistent mud (`src/sim/groundZones.ts`)
`GroundZoneSystem` (World owns one: `world.groundZones`, `sim.groundZones?` on the `Sim` interface) holds `GroundZone` records
`{ kind:'mud', ownerId, ax, az, dx, dz, len, halfWidth, age, growS, lifeS, slow, ownerSlow, slowLingerS, groundedAlt }`.
`update(sim, dt)` runs once per tick after movement (and projectiles): age += dt, expired zones are compacted out (order kept), mud slows fighters in ascending id order.
Deterministic (no rng, ages advance by `dt` only). Helpers: `zoneExtent`, `zoneOverlaps`, `zonesAt`, `spawnGroundZone(sim, spec)` (no-op `-1` on a minimal test Sim).
No events are emitted: the renderer draws and fades the pool from the ultimate's `ultimateTarget` (path) and `ultimateStage` 1 (slam time) plus the constants in `HIPPO_FLOOD`.

### Stage protocol
`ultimateTarget` (kind `line`, `from` = hippo, `to` = path end, `width` 3.4, `windup` 0.9) · stage **1** at the slam (`pos` 1.6 m ahead of the hippo) · stage **2** when the surge ends (recovery).
`actionT/actionDur` restart at each phase (windup 0.9 -> surge 0.79 -> recovery 0.7) so the rig uses per-phase clocks.

### Shared-file edits (all marked `v1.3 hippo mud`)
- `src/sim/Fighter.ts`: `import type { GroundZoneSystem }` + optional `readonly groundZones?: GroundZoneSystem` on the `Sim` interface (like `projectiles?`).
- `src/sim/World.ts`: `import { GroundZoneSystem }`, `readonly groundZones = new GroundZoneSystem()`, and one tick line `if (this.groundZones.count > 0) this.groundZones.update(this, dt)` after the projectile update (step 3a'').
No snapshot / contract changes.

## Counterplay
Leave the marked rectangle during the 0.9 s windup (sidestep ~2.4 m), jump the wave (altitude > 2.5 m clears the hit; > 0.6 m is not slowed by the mud), block (130 -> reduced, the shove still applies), or stagger the Hippo in the windup.
Bots: `dodge: { mode: 'fixed', activeS: surge + 5.5 }` makes the zone (capsule from -> to, half width 1.7) live from the cast for windup + surge + mud:
L1 never dodges, L2 lazy, L3 reliable, L4 strict (also keeps out of the mud). Real Apex bots are caught in <= 1 of 8 seeds, Cubs more often (test).
Bot script: Veteran/cluster = target <= 10 m with 2+ foes near the hippo or another foe near the target; Apex = target <= 10 m and (helpless / rooted / mid-cast / blocking, or another foe near the target); Cub/Fighter = target <= 10 m.

## Animation beats (`HippoRig.poseUltimate`, driven only from `ultPhase / actionT / actionDur`)
1. **Rear-up** (windup 0-0.4 s, smoothstep): the forequarters rise on the planted hind legs (hind legs counter-rotate to stay vertical), forefeet tucked and spread.
2. **Gape + bellow** (0.18-0.72 s, cubic ease-out): jaw to 1.55 rad, head tips back, throat / chest **swell** (head and body scale pulse ~24 Hz), a fine roar shudder.
3. **Coil** (0.68-0.9 s): last lean back, front legs cocked: anticipation for the slam.
4. **Slam** (active 0-0.13 s, cubic ease-in): both forefeet hammer down, the body pitches forward.
5. **Surge** (0.05-0.8 s): the whole body **heaves forward** (push, cubic ease-out, then settle) with a bouncing roll, the maw still gaping as the flood pours out.
6. **Exhale** (recovery 0.7 s): the chest swell collapses in decaying breaths, the jaw sags shut, the head droops, the body settles to idle. Each phase starts from the previous phase's final pose (the Animator also cross-fades 0.1 s at each clock restart).
The rig's per-action `slams` entry for the ultimate was removed (the phase clocks restart per phase); the slam decals/splashes come from `ultFx/hippo.ts`.

## VFX (`src/render/ultFx/hippo.ts`)
- **Cast:** a chevron ribbon of the full flood width (3.4 m) reveals along the path over the windup; blue-white sparks are sucked toward the maw, steam from the nostrils, dust at the planted feet.
- **Slam:** shock rings + impact ring + crack decal + dust ring + flash + water burst at the forefeet, a fan of spray, camera shake (scaled by nearness).
- **Wave:** a translucent teal curled crest (custom strip geometry, 3.4 m wide) races along the path at the real wave head position, shrinking toward the end, with foam spray, droplets and muddy churn at the head.
- **Mud pool:** two ground decals (dark mud texture + additive wet sheen, own pooled meshes, sRGB canvas textures) stretched over the path, **laid out with the wave** (same `growS`), fading over the **last 1.0 s of the real 5.5 s life**, with occasional mud bubbles. They live on their own timers (outlive the ultimate, the recovery and the caster) and are reset when render time goes backwards (new match) / on `dispose`.
- **Exhale:** a soft steam cloud from the maw.
Particle counts scale with `tierProfile().fxScale`; nothing allocates per frame (pooled decals, shared geometry/materials).

## Audio (`src/audio/ults/hippo.ts`)
Bellow (rising saw + square sub through a rising lowpass, tremolo, breathy rasp; faded by `onEnd` if the cast is aborted), slam boom + crash, rushing water bed (bandpass noise surging with the wave, hiss, sub), six mud squelches, a breathy exhale.
The water and squelches carry their own envelopes (the pool outlives the hippo). Every voice is envelope-shaped (EPS start/end, no clicks); inaudible when far from the listener.

## First-person notes
The Hippo's yaw is locked to the cast aim for the windup and the surge (the rectangle is fixed), so the camera should keep looking along the path:
- **Windup:** the forequarters rise, so ease the view pitch **up** ~15-20 deg over 0.4 s and back a little (eye height rises with the rear-up), widen the FOV slightly on the bellow, add a faint 24 Hz shudder; the jaw gapes into the lower frame (the FP profile already shows the muzzle / jaw).
- **Slam:** a hard downward kick (pitch down ~8 deg, 0.12 s ease-in) + screen shake, then a forward surge (eye moves ~0.5 m forward, matching `body.pz`); the wave crest + spray race away down the centre of the view.
- **Exhale:** drop and slowly recover the view (heavy breathing bob, ~1 Hz, decaying over 0.7 s).
- Note for the FP owner: `src/render/animals/fp/hippo.ts` (not touched here) opens the jaw from the **phase-local** `u` of `action === 'ultimate'` (open 0.05-0.4, close 0.44-0.55): with v1.3 the clock restarts per phase, so key it off `state.ultPhase` (windup: open to ~0.7 by 0.7 s and stay open; active: open then relax; recovery: close).

## Tests (`tests/sim/ultimates/hippo.test.ts`, `tests/sim/groundZones.test.ts`)
Config + dodge numbers; line `ultimateTarget`; wall-clipped path; planted windup; stagger-interrupted windup (no mud); slam timing; exact 130; hit order by wave head; rectangle resolution (edge / behind / beyond / end); one hit per fighter (3 in a line); 5 m shove + stagger; blockable; jump clears; CC-immune surge; mud laid + grows + expires at 5.5 s; 40 % slow (buff and measured speed ratio ~0.6); hippo unaffected; grounded-only; 0.3 s linger; stronger slow kept; pool persists after the hippo dies; death mid-windup / mid-surge cleanup; determinism; danger zone live through windup + surge + mud; real bots (Apex dodge, Cub caught); audio smoke; bot script. `groundZones.test.ts`: geometry, growth, owner immunity, altitude / untargetable skip, refresh / linger / stronger-slow, expiry compaction, no-op without the system, World hook determinism.

## Balance (see `hippo-balance.txt`)
Damage 130 per victim in the 130-200 band; recovery 0.7 s; ~1.1 ult / fighter / match, 0 timeouts. L3 ~10 %, L4 ~5 % at N=300 (unchanged vs v1.2: the weakest L4 animal stays inside the 4-18 % band).
