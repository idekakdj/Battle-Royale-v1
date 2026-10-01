# Lion — Royal Hunt (as built, v1.3 Phase 2)

A single-target **lock-on** ultimate: eyes fix on a foe within 12 m, a bounding pounce pins them, four guard-piercing maul strikes follow while the lion cannot be interrupted, and a face-to-face roar **marks** the victim and surges the lion.

Files: `src/config/ultimates/lion.ts` (numbers, `LION_HUNT` timeline) · `src/sim/ultimates/lion.ts` · `src/ai/ultScripts/lion.ts` · `src/render/animals/Lion.ts` + `src/render/animals/ultPose/lion.ts` · `src/render/ultFx/lion.ts` · `src/audio/ults/lion.ts` · `tests/sim/ultimates/lion.test.ts` · balance: `docs/ultimates/lion-balance.txt`.

## Targeting
`targeting: { kind: 'lock', range: 12, coneDeg: 70, requireTarget: true }` (no `dodge` opt-in: the landing point homes on the victim, so a fixed zone would be misleading). Candidates: alive, targetable, ground-reachable (not jumping / soaring), body within 12 m and inside the 70° aim cone; best = smallest angle, then nearest. **No target → `ultimateFizzle`, nothing spent.** The HUD preview (gold bracket + LOCK) uses the same shared selection.

## Timeline (seconds from cast; `LION_HUNT`)
| t | Beat | `ultPhase` / `ultStage` | Rules |
|---|---|---|---|
| 0 – 0.55 | Eye-lock coil | windup / 0 | interruptible; yaw tracks the victim; the landing point slides toward them at ≤ 3.2 m/s |
| 0.55 – 1.05 | Bounding pounce (0.5 s, parabolic arc, peak 1.4 + 0.09·d m, max 2.7) | active / 1 | **CC-immune from here to the end**; homing stops for the last 25% of the flight (committed) |
| 1.05 | Touchdown | active / 2 (recovery / 2 on a whiff) | victim within reach (+0.95 m beyond touching bodies, ground-reachable): **65 dmg, guard-piercing**, knockdown pin (`knockdownTimer` 2.0 s, cannot be cancelled by the victim). Miss → 0.9 s recovery, immunity dropped (punishable) |
| 1.25 / 1.55 / 1.85 / 2.15 | Four maul strikes (claw R, claw L, bite, double-claw slam) | active / 3, 4, 5, 6 | claws land 0.09 s after each beat: **48 each, guard-piercing** (`blockIgnore 1`) |
| 2.49 | Roar | active / 7 | 0.16 s later: **35 dmg**, stagger 0.7 s, **mark** (`dmgTakenUp +0.2` for 6 s) on the victim, lion `speedUp +0.2` for 4 s |
| 3.04 – 3.49 | Settle | recovery / 7 | 0.45 s |

Single-target total on an unblocked victim: **65 + 4 × 48 + 35 = 292**, plus the mark's +20% on the lion's (and everyone's) follow-up damage for 6 s. The victim is also staggered (+25% vulnerable) for 0.7 s after the roar.

Edge cases (all tested): victim dies mid-sequence → the claws stop hitting the corpse, the sequence still plays out cleanly; lion dies mid-pin → `abort` releases the pin (they rise over the normal 0.3 s); victim CC-immune (raging gorilla, charging rhino) → cannot be pinned but is still mauled (the lion tethers to them); victim jumps (> 2.5 m) or runs away during the coil/flight → whiff.

## Pin clock
The pin is simply a long knockdown: `pinVictim` sets the victim's `knockdownTimer` to `pinTotal` (2.0 s), and `releasePin` caps it to the 0.3 s rise if the lion aborts. The fall / hold / rise pose clock is the generic knockdown clock in `World` (v1.3 phase 3): `Fighter.knockdownClock` counts up while the victim is down and `World.resolveAction` publishes `actionT = knockdownClock`, `actionDur = knockdownClock + knockdownTimer`, so `u = actionT / actionDur` runs 0 to 1 and reaches 1 exactly when the victim can act again (the generic `poseKnockdown` falls over u 0–0.16 and rises over 0.72–1, i.e. down in about 0.3 s, rising from 1.44 s). The lion module no longer touches the victim's `actionT/actionDur`. If the lion dies mid-pin the timer is capped to 0.3 s, so `actionDur` shrinks and the rise starts a little early (a small pose jump, cosmetic only).

## Animation (rig driven only from `actionT`, `ultPhase`, `ultStage`, `pos`, `vel`)
`ultPose/lion.ts` = a keyframed, cubic-eased (`in` / `out` / `io`) timeline over 24 joint channels (shared sampler reused by the panther), plus secondary motion that fades in and out with envelopes (nothing pops):
- **coil**: crouch, weight back, forepaws tucked, hind paws tread, tail lashes, head locked up on the prey;
- **leap**: explosive extension (legs kick back, forepaws reach), long arc with nose-up then dive, mane flared, jaws open;
- **touchdown crunch → pin**: paws slam down, weight on the victim, claws splayed;
- **strike 1/2** alternating raised-paw rakes with body twist + head snap; **strike 3** jaws wide then snap with a 60 Hz head shake; **strike 4** rears, double-claw slam and bite;
- **roar**: inhale, rear up (body −0.85 rad, mane ×1.3, jaw 0.85 with tremble), hold, settle; a whiffed pounce instead skids into a wary head-sweeping stance.

## VFX (`ultFx/lion.ts`)
Reticle on the victim (gold for the player's own hunt, red for an enemy's) with a dashed arc for the pounce path; at take-off the reticle commits (solid), at touchdown both fade. Take-off dust, leap dust trail + sparks, touchdown shock ring / dust / crack / sparks / flash / shake, camera-facing **claw-slash streak quads** per strike (R rake, L rake, two fang marks, X slam; additive, drawn over the victim), roar sound-rings rolling out of the jaws + gold shock ring + shake. **Mark glow** (for as long as the `dmgTakenUp` buff): pulsing gold ground ring, glowing aura shell, floating claw glyph, rising embers (quality-scaled).

## Audio (`audio/ults/lion.ts`)
Lock: low growl (AM-wobbled saw). Stage 1: pounce whoosh + leg thump. Stage 2: landing thud. Stages 3–6: ripping noise sweep + tearing rasp on claw contact (bite adds a jaw crunch, slam is heavier). Stage 7: layered roar (formant-filtered saw pair, growl LFO, hiss, sub thump).

## AI (`ai/ultScripts/lion.ts`)
Gate: target within 9 m, not fleeing (the homing is weak: a sprinter outruns it) and not crowded (`enemiesNearSelf8 ≤ 1`: nobody within 8 m but the target). `ranged: true`, Veteran window: helpless / rooted / committed / isolated / target ≤ 55% HP. Apex: soft targets (helpless, rooted, committed, guard ≤ 30%, HP ≤ 60%) or an isolated duel while healthy. The brain already vetoes a cast that would fizzle (`ultTargetValid`).

## Balance notes
Bands held (see `lion-balance.txt`): N=120 L3 4% / L4 9%, N=60 L1 12% / L2 7%, 0 timeouts, ~1.0–1.15 ults per fighter per match. A full sequence costs the lion ~170 HP taken from third parties (it is CC-immune, not damage-immune), hence the crowd gate in the bot script. Tuning levers: `homingSpeed`, `landReach`, strike damage, `roarDamage`, mark magnitude.

## First-person notes (for the later FP pass)
- Coil: keep the camera on the victim, let it sink with the crouch (−0.3 m) and lock the look yaw softly onto the victim.
- Leap: the camera rides the arc (pitch up on take-off, pitch down into the dive); strong FOV kick at take-off, tuck forepaws into the lower frame corners.
- Pin/maul: the camera is low over the victim; forepaw viewmodels alternate per strike (stage 3 = right, 4 = left, 5 = bite — snap the view down, 6 = both paws); small view kick on each impact (0.09 s after the stage beat).
- Roar: rear-up tilts the view up ~45°, mane at the frame edges, shake; afterwards ease back to level over the 0.45 s settle.
- Whiff: a short stumble forward then look-around sway.
