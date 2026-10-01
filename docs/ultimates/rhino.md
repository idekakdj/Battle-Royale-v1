# Rhino — Seismic Stampede (v1.3, as built)

Reworked line ultimate: a steerable, CC-immune charge that **homes** on the foe locked at the cast, **gores** it on contact, **hoists it on the horn** and
carries it along until a wall / pillar / column **crushes** it; everyone else in the path is swept. Without a lock it stays steerable as before.

Files: `src/sim/ultimates/rhino.ts` · `src/config/ultimates/rhino.ts` (spec + `RHINO_STAMPEDE` numbers) · `src/ai/ultScripts/rhino.ts` ·
`src/render/animals/Rhino.ts` (`poseUltimate`, yaw-rate lean) · `src/render/ultFx/rhino.ts` · `src/audio/ults/rhino.ts` · `tests/sim/ultimates/rhino.test.ts`.

## Mechanic

| Item | Value |
|---|---|
| Targeting | `line`, `range 16`, `coneDeg 50`, `width 2.4`, **not** `requireTarget` (never fizzles). The lock-assist of a `line` spec picks the best foe in the cone (`selectLockTarget`: smallest angle, then nearest) and reports it as `ultimateTarget.targetId`; `start` copies it to `rt.lockId` (`startUlt` only does that for `lock` kinds). The charge itself reaches 12 m/s x 3 s ~ 33 m (`spec.range` 36), longer than the 16 m the lock reaches (the HUD ready-state ribbon shows the 16 m / lock-assisted line) |
| Windup 0.8 s (stage 0) | **Paw**: interruptible like any windup; the rhino turns (<= 150 deg/s) to sight the lock (else the aim), no movement. `ultimateTarget` (kind `line`, `targetId` = lock or -1) |
| Charge (Active, stage 1) up to 3 s | `ccImmuneChannel` (stagger / knockdown / fear / knockback do nothing). Speed 12 m/s after a heavy start: `0.35 + 0.65 * smoothstep(t / 0.5 s)` of full speed. **Steering:** homing on the lock = toward the victim's **current** position at <= **110 deg/s**; homing is dropped when the lock dies / flies (altitude > 2.5 m) / burrows / is > 28 m away, and with no lock (or after the gore) the aim steers at <= **90 deg/s** (unchanged player/bot intent). Crates in the path are smashed. `state.vel` carries the real speed (rig gait, audio) |
| **Gore** (stage 2) | Contact (radii + 0.25 m) with the **locked** foe (with no live lock: the **first fighter touched**): **120**, blockable, heavy, stagger. The victim is **hoisted 1.7 m up the horn** (0.3 s smoothstep), becomes grabbed / helpless and is **carried** 1.6 m ahead of the rhino (radius + 0.45) along the charge. CC-immune victims (rampaging gorilla, a charging rhino) or ones that stay mid-cast take the damage but are not carried. No second gore per cast |
| **Crush** (stage 3) | When the rhino (`chargeStep.stopped`: wall, pillar, fallen column) **or the carried victim** (pushed out of geometry against the heading) is stopped: **+100 true damage** (unblockable) + **stun 1.2 s**; the victim drops (normal gravity), the charge ends -> recovery. Total on a wall-side victim: **220** |
| Time-out (stage 4) | If the 3 s run out with a victim on the horn it is **flung off** (knockdown 0.6 s, 3 m push) and the rhino **skids** 0.45 s (quadratic deceleration, still sweeping); a stop against geometry with nobody on the horn is a stumbling stop (stage 4, no skid) |
| Sweeps | Every **other** ground-targetable fighter touched once (not carried / grabbed): **60** (blockable) + **knockdown 0.8 s** |
| Recovery 0.7 s | Shake-off (interruptible); `ccImmuneChannel` is dropped at the end of the charge |

Expected value: locked victim 120 (+100 against a wall / pillar) ~ 220 against walls; sweeps 60 each. Single-target total is below the 250-320 target when the victim is not crushed (120): the charge is unblockable-in-effect and cannot be dodged by bots (no danger zone declared), so the balance sweep (L4 5 %, L3 8 %) judged the numbers.

### Stage protocol (`ultimateStage` / snapshot `ultStage`)
0 paw (cast) · 1 charge · 2 gore (victim on the horn; `pos` = victim) · 3 crush (`pos` = victim at the geometry; recovery follows) · 4 skid / stop.
`actionT/actionDur` restart at the charge (3 s), the gore (0.3 s hoist), the skid (0.45 s) and the recovery (0.7 s). `ultTargetId` is the lock, then the victim on the horn.

## Counterplay
Block reduces the gore (not the carry or the crush: 100 true), a last-second **sidestep** beats the turn limit (min turn radius = 12 m/s / 110 deg/s ~ 6 m), a jump / flight (> 2.5 m) breaks the lock, stagger the rhino **in the windup** (the charge is immune), do not stand with a wall / pillar behind you.
Bots: no `dodge` is declared (a homing charge cannot be sidestepped by leaving a zone); script: gate target 2.5-15 m; Veteran/cluster = 2+ foes near the rhino; Apex = `wallBehindTarget` or helpless / rooted / mid-cast, or a blocker >= 5 m away.

## Animation beats (`RhinoRig.poseUltimate`, driven from `ultPhase / ultStage / actionT / actionDur / vel`, plus the heading's yaw rate)
1. **Paw** (windup 0.8 s): head **lowers** to the sand (cubic ease-out, 0.35 s), forefeet **paw alternately** (lift forward then scrape back, asymmetric cycle), body rocks with each scrape, the haunches bunch and tail raises in the last 0.2 s (coil).
2. **Gallop** (stage 1): blends from the crouch over 0.35 s into a thundering gallop whose legs / bob / head nod follow the real ground speed (`gaitPhase`); the body **rolls into turns** (low-passed yaw rate -> `body.rz`, clamp 0.26) with the head leading the turn.
3. **Gore-toss** (stage 2, 0.3 s clock): the horn **flicks up** (cubic ease-out with an overshoot bell) and holds raised while the victim rides it; the gallop continues beneath, the body rises slightly.
4. **Skid** (stage 4): legs braced forward, weight thrown back, body low, head up, over 0.2 s.
5. **Crush** (stage 3, in recovery): a jolt forward into the wall (cubic ease-in), the horn dips as the victim drops, then a hard head shake.
6. **Shake-off** (recovery): decaying head / body shake, the braced stance relaxes to idle.
The rig's per-action `slams` entry for the ultimate was removed (phase clocks restart per beat); impact decals come from `ultFx/rhino.ts`.

## VFX (`src/render/ultFx/rhino.ts`)
- **Cast:** a 2.4 m chevron **ribbon** from the rhino to the lock / aim line + a **lock bracket** on the foe (gold for the player, red tracking brackets for a bot's lock); steam snorts, paw dust + grit at the hooves.
- **Charge:** the ribbon **follows the rhino every frame**: it ends on the locked foe while homing, otherwise runs ahead along the heading to the arena wall (or as far as the charge can still reach) and keeps flowing at charge speed; a **dust wake** (density with speed), stride-cadence ground dust rings, a light camera rumble for nearby players.
- **Gore:** crack decal, impact ring, flash, debris burst, ground dust, shake; the lock bracket goes.
- **Crush:** wall-crush shock: two shock rings, impact ring, large crack decal, flash, stone chips + dust cloud, big shake.
- **Skid:** a long dust plume sliding to a halt.
All particle counts scale with `tierProfile().fxScale`; nothing allocates per frame.

## Audio (`src/audio/ults/rhino.ts`)
Two snorts + three paws + a low growl on the cast; a **thundering gallop bed** (sub-bass + lowpassed rumble amplitude-modulated at the stride cadence, speeding up 3.2 -> 5 Hz over the ramp, hide rattle) for the whole charge; gore thud + horn crack + grunt; crush boom + stone crack + falling debris (cuts the bed); skid scrape (cuts the bed). The bed is tracked per caster and faded by `onEnd` on death / interrupt.

## First-person notes
- **Windup:** the head lowers, so pitch the view **down** ~15-20 deg over 0.35 s with the horn tip rising into the lower-centre of the frame; paw scrapes give a small rhythmic bob (~1.6 Hz). Yaw is auto-sighting the lock (<= 150 deg/s): the camera should follow the rhino's heading, not just the mouse, while a lock is held.
- **Charge:** widen the FOV ~8-10 deg as speed ramps up (0.5 s), gait bob at the real stride cadence, roll the camera a few degrees **into turns** (same sign as the body roll); while **homing** the heading is sim-driven (<= 110 deg/s), so the view yaw should be pulled toward the rhino's yaw rather than ignoring it.
- **Gore:** a sharp upward flick (the victim rises into view above the horn), keep the horn lifted for the ride; **crush:** a violent forward kick + shake, then slow recovery; **skid:** FOV relaxes, a slight pitch-back.
- Note for the FP owner (updated v1.3.1): the whole head, horn included, is now hidden in first person (`keepFront` was removed for the Rhino) and a screen-space clip keeps the centre of the view free of the player's own body, so the horn-lift / head-down poses no longer show a horn tip; the first-person ultimate camera director carries the feel instead.

## Tests (`tests/sim/ultimates/rhino.test.ts`)
Config; lock in / out of the cone and range (never fizzles) and the HUD preview; paw windup (no movement, sighting turn <= 150 deg/s); stagger interrupts the windup only; homing on an off-line foe and on a runner; turn cap 110 deg/s (and 90 free); lock dropped when the victim flies; gallop ramp (12 m/s, ~33 m); gore exactly 120, hoist height, carry offset, grabbed state; block cuts the gore but not the carry; wall crush (120 + 100 = 220, stun 1.2 s, release, recovery, no more damage); pillar crush; time-out fling + skid; no-lock first-touch gore; CC-immune victim not carried; sweep 60 + knockdown once; crates broken; CC-immune charge; rhino death releases the carried victim; victim death ends the carry; determinism; audio smoke; bot script.

## Balance (see `rhino-balance.txt`)
L3 8 %, L4 5 % at N=300 (v1.2: 7 % / 2 % at N=60); 0 timeouts, ~1 ult / fighter / match.
