# Giraffe — Timber Fall (v1.3, as built; was Guillotine Spin)

The Giraffe whips its neck far back while creeping in; a ground circle under the locked victim **tracks** them (lagging), then
**commits** (fixed circle: walk out of it to dodge); the neck then comes down like a felled tree. Everyone touching the committed circle
takes 230 and a 1 s stun, everyone else in the shock ring takes 50 and staggers.

Files: `src/sim/ultimates/giraffe.ts` · `src/config/ultimates/giraffe.ts` (spec + `GIRAFFE_TIMBER` timeline) ·
`src/ai/ultScripts/giraffe.ts` · `src/render/animals/Giraffe.ts` (`poseUltimate`) + `src/render/animals/ultPose/giraffe.ts` (keyframes) ·
`src/render/ultFx/giraffe.ts` · `src/audio/ults/giraffe.ts` · `tests/sim/ultimates/giraffe.test.ts`.

## Mechanic

| Item | Value |
|---|---|
| Targeting | `lock`, 7.5 m body range, 70° cone around `aimYaw`, `requireTarget: true` (no target → `ultimateFizzle`, nothing spent) |
| Windup | 1.1 s = **track 0.6 s** (stage 0) + **commit 0.5 s** (stage 1). The circle centre follows the victim with an exponential lag, τ = 0.2 s (a 6 m/s runner trails ≈ 1.2 m), `ultimateStage` 0 every 0.1 s carrying the lagging centre; at 0.6 s `ultimateStage` 1 freezes it |
| Creep | the giraffe turns (6 rad/s) toward the circle and creeps in at up to 4.4 m/s (0.3 s ease-in) until the head is in reach (3.1 m from the circle centre), so the whole 7.5 m cast range is usable; it stops as soon as it is in reach. Movement is owned by the ult (the body stays inside the wall, pushed out of pillars/crates) |
| Interruption | interruptible (stun / stagger / knockdown / fear cancels it, the charge is spent) while the circle tracks; **CC-immune from the commit through the slam** (`ccImmuneChannel`) so the committed 0.5 s is a pure dodge test |
| Slam (Active) | 0.14 s neck downswing, then the hit: everyone whose body touches the committed circle (r 1.6 + body, ground-reachable) takes **230** (blockable, heavy) and, if not blocked, a **1.0 s stun**; everyone else within the 2.2 m shock ring (+ body) takes **50** and staggers (0.4 s); a direct victim gets no shock on top |
| Recovery | hit (someone took the direct 230): 0.65 s · whiff (nobody in the circle, a shock-only clip still counts as a whiff): 0.9 s. The sim restarts `actionDur` at the impact (`actionDur = actionT + recovery`) so the rig stretches its recovery to it |
| Altitude / untargetable | a flier above 2.5 m or an untargetable (burrowed / soaring) fighter is missed and cannot be locked |
| Stage protocol | 0 = tracking (`pos` = lagging centre), 1 = committed (`pos` = fixed centre; also the whole slam), 2 = impact (also the whole recovery) |

Single unblocked victim: 230 + the free 1 s stun for follow-ups (the stunned victim also takes the staggered-vulnerability bonus) ≈ 290–310 total.
Timeline to impact: 1.1 + 0.14 = 1.24 s.

### Dodging
- Leave the committed circle (r 1.6 + your body) any time in the 0.5 s commit + 0.14 s swing (0.64 s total). The tracking half gives no
  information you can dodge yet (and a runner's circle lags behind them: they walk out of it for free).
- Leaving the direct circle still leaves a slow fighter inside the 2.2 m (+ body) shock ring (50 + stagger): getting > 3.4 m away takes a run.
- Interrupting the giraffe during its first 0.6 s cancels the whole ultimate.
- Bots: `dodge: { mode: 'commit', activeS: 1.2, commitS: 0.8, radius: 1.6 }`. L1 never dodges, L2 lazy, L3 reliable, L4 strict.
  A bot that is mid-melee / mid-special when the circle commits never dodges (integration test: hippo victim at 6 m, Apex ≤ 1/8 direct hits, Cubs ≥ 5/8).

## Animation beats (`GiraffeRig.poseUltimate`, keyframed from `actionT` / `actionDur` in `ultPose/giraffe.ts`, cubic-eased per segment)
1. **Whip-back** (0–0.6): neck swung back and up, head high and tilted back, forelegs braced forward, weight on the haunches (body rocks back, tail lifts).
2. **Tension hold** (0.6–1.06): the neck creeps further back while the whole neck trembles (43/37/51 rad/s, growing toward the slam); the legs shuffle in the
   shared diagonal gait from `state.vel` while the giraffe creeps in (weight fades out over the last 0.2 s before the slam).
3. **Final coil** (1.06–1.10), **the slam** (1.10–1.24, `in`-cubic): the neck arcs over and down (neck1 −0.84 → +1.22, neck2 and head whipping after it),
   forelegs buckle forward, body drops 0.3 m onto them.
4. **Follow-through**: an impact shudder (60 rad/s, 90 ms decay), the head bounces off the ground (12 % of the recovery), settles dazed and low; a whiff searches
   left and right with neck/head while it lies low; the neck rises and the body straightens back to the idle stance exactly at `actionDur`.

## VFX (`src/render/ultFx/giraffe.ts`) and audio (`src/audio/ults/giraffe.ts`)
- Cast: dust at the hooves; a lock-on reticle (gold brackets for the player, red for others) snaps onto the victim, tightening while the neck rears.
- Stage 0: the reticle switches to the tracking style and follows the sim's lagging centre (events smoothed).
- Stage 1: solid red `committed` ring (r 1.6) whose warning fill grows through the commit + swing, a dashed shock ring (2.2 m + 0.3), a faint path ribbon from the
  giraffe to the circle (where the felled neck will land) and a contracting lock flash.
- Stage 2: big radial crack, fast bright shock ring to the ring edge, a slower dust ring, flash, impact ring, a column of dirt and stone chips, strong shake by proximity.
- Audio: creaking neck (saw swept up through a narrow band with a slow wobble + a thin upper creak) and a long airy swing-up on the cast; two dry wooden "lock" knocks and a
  rising tension hum on the commit, the downswing whoosh timed to peak at the impact; slam: sub thud, timber-splitting crack, dust rumble, debris. Tracking cadence silent.

## First-person notes (for the camera pass)
- **Clear view (ultimate only):** while the ultimate runs (`action === 'ultimate'`, every phase / stage) the own rig is screen-space clipped out of the centre 50% x 60% of the screen (`ultClip` in the FP profile, `fp/clip.ts`). The normal first-person look (idle, run, attacks, block, ...) is unchanged. Measure with `await __gkFp.report()` (dev build): 0 safe-zone pixels, <= ~12% of the frame in every stage.
- Rear: pitch the view UP with the neck whip-back (the eye is ≈ 3.7 m up and moves with neck2; ≈ −8° to +20°), slow tremble roll ±0.5° through the tension hold.
- Commit: settle the view on the circle; the eye tips forward as the neck arcs over: the slam is a fast pitch-DOWN (≈ 35°) over 0.14 s ending on the crater, FOV +6 % at the impact,
  a hard shake, then a bounce and a slow pitch back to level over the recovery (the head is hidden in first person, the forelegs stay hidden).
- The yaw follows the circle during the creep (the sim turns the body at 6 rad/s), so the camera can stay on the mouse.

## Balance notes
See `docs/ultimates/giraffe-balance.txt`. Bands held (N = 200: L3 9 %, L4 13 %; N = 60: L1 3 %, L2 7 %, L3 5 %; the N = 60 L4 cell read 22 % on its seeds, which N = 200 does not confirm), ≈ 1.0 ult per fighter per match at L3/L4, 0 timeouts; the ultimate is worth
7–15 % of the giraffe's hit-event share (the old Guillotine Spin was 6–17 %).

## Tests (`tests/sim/ultimates/giraffe.test.ts`)
Config, fizzle (cone / range / altitude / untargetable), `ultimateTarget`, phases, interruptible-while-tracking / immune-from-commit, creep-in and stay-put, facing, stage events + cadence +
commit/impact timing, circle lag and freeze, 230 once + 1 s stun + short recovery, dodge by leaving (≤ 50 shock, 0.9 s whiff recovery), shock ring (50 + stagger at 2.9 m, none at 6.5 m),
blocking (reduced, no stun), flier missed, victim death mid-tracking, caster death / interrupt cleanup, bot danger-zone protocol with the real events, real Apex bots dodging, audio smoke test,
script gates, determinism.
