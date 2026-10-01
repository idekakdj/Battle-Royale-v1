# Eagle — Death From Above (v1.3, as built)

Lock-on stoop: the Eagle spirals out of sight, a **red reticle** tracks the locked victim (lagging), then **commits**
(fixed circle, solid warning: leave it to dodge), then the Eagle stoops onto the committed point.

Files: `src/sim/ultimates/eagle.ts` · `src/config/ultimates/eagle.ts` (spec + `EAGLE_DFA` timeline) ·
`src/ai/ultScripts/eagle.ts` · `src/render/animals/Eagle.ts` (`poseUltimate` + helpers) ·
`src/render/ultFx/eagle.ts` · `src/audio/ults/eagle.ts` · `tests/sim/ultimates/eagle.test.ts`.

## Mechanic

| Item | Value |
|---|---|
| Targeting | `lock`, 16 m, 90° cone around `aimYaw`, `requireTarget: true` (no target → `ultimateFizzle`, nothing spent) |
| Cast → eagle untargetable + uninterruptible (`ccImmuneChannel`) until the touchdown | |
| Ascent (Windup) | 0.8 s corkscrew climb (helix r 1.25 m, 1.5 turns, smoothstep climb) to a 20 m hold altitude |
| Track (Active, stage 0) | 1.2 s; reticle centre follows the victim with an exponential lag, τ = 0.24 s (a runner at 6 m/s trails ≈ 1.4 m); the eagle circles the reticle at r 6.5 m, 1.15 rad/s, altitude 20 m |
| Commit (stage 1) | 0.5 s; the reticle freezes (`ultimateStage` 1 with the fixed `pos`); the eagle keeps circling |
| Stoop | dive along the straight line to the committed point, 25 m/s (0.12 s launch ramp from 55 %), ≈ 0.8–0.9 s from 20 m up |
| Impact (stage 2) | direct circle r 1.4 m (+ victim body radius, like every AoE): **240** (blockable, stagger); everyone else within 3 m (+ body): **60** splash; a direct victim gets no splash on top |
| Recovery | hit: 0.55 s · whiff (nobody hit): 1.0 s (vulnerable, interruptible) |
| Altitude rules | above `MOVE.groundHitMaxAltitude` (2.5 m) a fighter is missed by the impact; the eagle lands at ground height, `landRecoverT` stays 0, no `landingImpact`/slam (casting cancels any glide and skips `locomote`, so `pendingLandingPeak` never arms) |

Total cast time to impact ≈ 3.3 s; a single unblocked victim caught in the circle takes 240 (neighbours within 3 m take 60).
Bot-facing numbers: `dodge: { mode: 'commit', activeS: 2.6, commitS: 1.7, radius: 1.4 }`.

### Stage protocol (`ultimateStage` / `snapshot.ultStage`)
- `ultimateTarget` (lock, `windup` = 0.8 = ascent lead): the reticle appears on the victim. Bots do NOT dodge it yet.
- stage **0** every 0.1 s from the activation (start of the hold): `pos` = the lagging reticle centre (moves the bots' tracking zone).
- stage **1** once, at 2.0 s after the cast: the circle is committed at `pos` (bots dodge it now, for `commitS`).
- stage **2** once, at the touchdown: `pos` = landing point; it clears the bots' zone. `ultStage` stays 2 through the recovery.
- The stoop itself is the second half of stage 1 (no event of its own, so the bots' committed zone lives through the dive).
- `actionT/actionDur` restart at the touchdown so the rig has a clean recovery clock (`actionDur` = 0.55 or 1.0).

## Dodge rules
- Leave the committed circle (radius 1.4 + your body) any time before the eagle arrives (0.5 s warning + ≈ 0.85 s dive).
  A runner at 5.6 m/s is ≥ 7 m away by then; only stationary / slowed / rooted / staggered / casting / cornered foes are hit.
- Splash (3 m + body) still stings a fighter who only just left the circle (60).
- Jumping/flying above 2.5 m at the impact also dodges it.
- Bots: L1 never dodges, L2 lazy, L3 reliable, L4 strict (`BotProfile.ultDodge`, danger zones `src/ai/dangerZones.ts`).
  Integration test: a real Apex bot eats the direct hit in ≤ 1 of 8 seeds.

## Animation beats (`EagleRig.poseUltimate`, driven only from `ultPhase/ultStage/actionT/actionDur/pos/vel`)
Four phase weights (ascent / hold / stoop / recovery) are low-passed on the render side (≈ 70 ms), each sub-pose is cubic-eased:
1. **Takeoff + corkscrew ascent** (windup): crouch (wings coiled up, legs bent) → three powerful downstrokes (flap amplitude ±1.0, lagging tip whip),
   body snaps to a head-up rocket posture and banks left into the helix.
2. **High circling hold** (stage 0/1): wings wide, slow deep beats, banked toward the reticle (the circle centre is always on the eagle's left),
   head pitched down at the target, tail fanned. In the last 0.5 s before the stoop (commit) the body levels out of the bank, the nose dips and the wings draw in.
3. **Tucked stoop** (vel.y < −5 or commit + 0.5 s): wings swept back and pulled in (flutter at 38 rad/s), body pitched along the dive line (from `vel`), talons forward along it.
4. **Impact flare → proud recovery**: talon strike (legs lash forward), wings thrown up and cupped, then chest-out proud stance, then fold.
   A whiff (1 s recovery) adds a head-shake search before folding.

## VFX (`src/render/ultFx/eagle.ts`)
- Cast: takeoff dust ring + feathers; lock-on reticle (gold brackets for the player, red for others) snaps onto the victim and follows it exactly during the ascent; wind glints along the helix.
- Stage 0: the reticle switches to the tracking style and follows the sim's lagging centre (events smoothed).
- Stage 1: solid red `committed` ring with a warning fill growing over 0.5 s, dashed 3 m splash ring, contracting lock flash, translucent light shaft to the sky.
- Stoop: spark streak + wind puffs along the dive line.
- Stage 2: crack decal, dust ring, two shock rings, flash, sparks, feathers; shake scaled by proximity.

## Audio (`src/audio/ults/eagle.ts`)
Cast: three wing-beat thumps under a rising screech. Commit: two-note lock-on ping, then (scheduled 0.5 s later) a dive screech and a rising wind rush peaking at the touchdown. Impact: body thud + crack + dust whoosh + feather rustle. Tracking cadence is silent.

## First-person notes (for the WP-Q camera pass)
- Ascent: pitch the view up with the climb (look along the helix); slight roll into the bank.
- Hold: look DOWN at the reticle (pitch ≈ −35…−55°, yaw toward the reticle centre = `ultimateStage` 0/1 `pos`); hold the horizon low in frame.
- Commit: settle the view on the fixed circle.
- Stoop: look straight down the dive line at the committed point (follow `vel`), FOV kick up to ≈ +10 % by the end, strong wind rush.
- Impact: the eagle is upright again; snap back to the normal eye height with a short shake; recovery look-around on a whiff.

## Balance notes
See `docs/ultimates/eagle-balance.txt`. Single-target value 240 (+0 splash on the same victim); the stoop is easy to dodge at L3/L4 by design,
so the AI script only casts at helpless / rooted / mid-cast / blocking-and-isolated / hurt-and-isolated targets and never at runners.

## Tests (`tests/sim/ultimates/eagle.test.ts`)
Config, fizzle (cone / range / altitude / untargetable), `ultimateTarget`, phases + untargetable/uninterruptible, altitude and no double landing slam,
stage events + cadence + commit/impact timing, reticle lag and freeze, 240 direct, dodge by leaving (whiff recovery ≈ 1 s), splash (60 at 3.6 m, none at 6.5 m),
flier missed, victim death mid-tracking, caster death/interrupt cleanup, bot danger-zone protocol with the real events, real Apex bots dodging,
audio smoke test with a fake AudioContext, determinism.
