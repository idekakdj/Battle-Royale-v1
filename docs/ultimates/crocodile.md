# Crocodile — Death Roll (v1.3 phase 2, as built)

Files: `src/sim/ultimates/crocodile.ts` (rules) · `src/config/ultimates/crocodile.ts` (numbers, `CROC_STAGE`, `CROC`, `crocRollAngle`) ·
`src/ai/ultScripts/crocodile.ts` (bots) · `src/render/animals/Crocodile.ts` + `src/render/animals/ultPose/crocodile.ts` (rig) ·
`src/render/ultFx/crocodile.ts` (VFX) · `src/audio/ults/crocodile.ts` (audio) · `tests/sim/ultimates/crocodile.test.ts`.

## Mechanic
`lock`, range 7 m, 60° cone, `requireTarget` (no valid target = fizzle, nothing spent). Cost 100 charge (unchanged).

| Beat | `ultimateStage` | Time | What happens |
|---|---|---|---|
| Windup | (0) | 0.55 s | Crouch + hiss. The croc's yaw TRACKS the locked victim (5.2 rad/s). Interruptible as before (`Fighter.interrupt()` cancels it). |
| Commit | `COMMIT` 1 | at 65 % (0.36 s) | Lunge direction frozen; `pos` = lunge end point (victim distance + 1.6 m, capped at 8 m, min 3 m). Leave the line now. |
| Lunge | `LUNGE` 2 | ~0.15–0.27 s | Burst at 30 m/s along the frozen line. First ground-targetable foe touched (body radii + 0.25 m pad + 0.35 m lunge reach; the locked victim wins a tie; a foe hopping above 0.85 m is jumped over) is clamped. A pillar / crate / wall stops the lunge (whiff). From here the runtime has grab resist (`isGrab`): `interrupt()` no longer cancels it. |
| Clamp | `CLAMP` 3 | 0.28 s | Bite 30 (unblockable, heavy); victim seized (whatever it was casting is torn down with `endAbility`), held + stunned, slaved to the jaws; croc takes 50 % less damage from now until the toss. |
| Drag | `DRAG` 4 | 0.42 s | The croc backs up 1.5 m (eased) hauling the victim. |
| Roll | `ROLL1..3` 5/6/7 | 2.5 s | 3 full revolutions (`crocRollAngle`, exact 6π). One beat per revolution. Victim orbits the croc's long axis at the jaws (0.55 m radius, lifted 0.5 m) — position-slaved by the sim; continuous **unblockable drain 240** (96/s). |
| Toss | `TOSS` 8 | instant | Victim released, 30 damage (unblockable, not amplified by the hold stun), 3 m knockback along the lunge line, 0.5 s stagger. |
| Recovery | (phase `recovery`) | 0.5 s | Exhale. |
| Whiff | `WHIFF` 9 | 0.45 s slide + 0.55 s | Nothing clamped: a decaying slide (9 m/s, ~1.35 m), then recovery; `spec.recovery` = 1.0 s in total after the lunge ends. |

Total on an unblocked/blocking victim: 30 + 240 + 30 = **300** (block is irrelevant: grabs ignore block). The victim is stunned for 0.28 + 0.42 + 2.5 = 3.2 s.
Hit timeline: cast → toss 3.93 s → free at 4.4 s. Whiff: cast → free at ~1.9 s.

Cleanup (every exit path releases the victim and clears `incomingDamageReduction` / `grabTargetId` / `movementOwned`; victim dropped to the ground): caster dies (`abort`), victim dies (`rt.targetId` cleared by `World.kill`), victim freed, toss.

## Targeting / indicators
`targeting: { kind: 'lock', range: 7, coneDeg: 60, requireTarget: true, dodge: { mode: 'fixed', activeS: 0.4, radius: 1.6 } }`.
Ready state: HUD range ring + gold LOCK bracket (shared preview). Cast: lock reticle on the victim (gold for the player, red tracking for others) + a lunge-line ribbon (1.7 m wide) that follows the victim; at COMMIT both go solid red (committed) and the ribbon freezes at the lunge end. Bots at L3/L4 leave the victim's cast position (danger zone 1.6 m, lives windup + 0.4 s).

## Animation beats (`ultPose/crocodile.ts`, driven only by `ultPhase`/`ultStage`/`actionT`)
Per-channel exponential followers make every beat blend (anticipation → strike → follow-through → recovery); oscillations are added on top.
- Windup: crouch (body sinks 0.15, pulls back 0.24), legs splay, tail curls to one side, jaws open to 0.95 rad with a hiss tremor; COMMIT deepens the crouch and adds a 10 Hz shudder.
- Lunge: body drives forward 0.55, flat, jaws to 1.3 rad, legs swept back, tail whips straight.
- Clamp: jaws slam shut (rate 46/s), head + body shudder decaying (46 Hz / 40 Hz), tail lashes.
- Drag: backwards walk (alternating leg swing), head hauled up, tail sweep.
- Roll: `body.rz = crocRollAngle` — exactly 3 turns, belly-up mid-turn, legs flail, tail whips against the roll, jaws clamped; small body heave so the belly clears the sand.
- Toss: jaws fling open, head whips up; the roll angle drops its whole turns and eases to 0 (never spins back). Exhale: breathing heave, mouth panting, legs relax.
- Whiff: braced slide (legs forward), missed-snap head shake.
The victim's rig shows its normal 'grabbed' pose; its position (orbit, lift) comes from the sim.

## VFX (`ultFx/crocodile.ts`)
Sand, not water: lunge takeoff burst + dust wake every frame while flying; clamp flash + ivory sparks + sand puffs + ring + shake; drag wake; continuous sand kicks while rolling and per revolution a ground dust ring, shock ring, radial sand spray and sparks (`ultimateStage` per revolution); toss: big shock ring, dust ring, crack, flash, sparks, stronger shake; whiff slide plume. Ground height aware (dais).

## Audio (`audio/ults/crocodile.ts`)
Windup hiss + throat growl; commit rumble; lunge whoosh + gape rasp; clamp crunch (noise burst + sub thump + bone-click rattle); drag scrape; roll: four body thumps per revolution (louder each turn) + sand rush + growl; toss thud + exhale; whiff skid + snap.

## AI (`ai/ultScripts/crocodile.ts`)
`gate`: target within 6.4 m. Apex: only with `gate` and never at a fleeing target; casts on helpless/rooted, low HP (≤ 45 %), blocking, or an isolated target within 4.5 m at ≤ 70 % HP. The framework vetoes casts with no valid lock (`ultTargetValid`). L3/L4 dodge through the shared danger zone.

## Tests (`tests/sim/ultimates/crocodile.test.ts`, 20)
Config/targeting, fizzle (range/cone/airborne), lock event + snapshot, full beat order, burst speed, 300 total (blocked or not), hold/stun/jaw distance/orbit, 50 % reduction only while holding, toss distance/stagger, whiff + 1 s, jump-over, first-foe clamp, victim's own cast torn down, interrupt rules, caster/victim death cleanup, determinism, roll-angle helper, bot script.

## Balance (see `crocodile-balance.txt`)
Single target 300 (band 250–320). ~1 ult per fighter per match. N=60 rows after tuning: L1 17 %, L2 25 %, L3 3 % (N=120: 5 %), L4 5 % (N=120: 6 %) — L3/L4 sit at the low edge of the band because Veteran/Apex bots dodge the lock zone; tuned with the 0.35 m lunge reach and a smaller dodge zone (without the bot dodge opt-in L3 was 7 %).

## First-person notes
The roll is a rig-local `body.rz` ONLY: the camera must never inherit it (the FP agent should take yaw/pitch from the mouse, eye offset from the profile with `follow` small / zero for action `ultimate`; the `head` joint sits on the roll axis, but the `track: 'head'` follow (0.4) picks up the head's heave/shudder, so keep the clamp during the roll). During the lunge the body drives 0.55 m forward in the rig — fine. While the victim is held in first person (croc is the caster) the camera can keep looking along the lunge line; the victim sits ~2 m ahead at the jaws and orbits ±0.55 m — consider a low eye and the jaws (snout) staying visible at the bottom of the screen; the gape (jaw up to 1.3 rad) reads well. The held player victim already looks at the grabber.
