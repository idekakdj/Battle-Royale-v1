# First-person notes per ultimate (input to the Phase-3 FP ultimate pass)

Collected from each Phase-2 agent's report. The FP camera is level (yaw/pitch only), anchored per-animal in `src/render/animals/fp/<animal>.ts` (`eye`, `hide`, `follow`, `eyeAction`, `pose(ctx)`, pinned viewmodel limbs via `ctx.limb`). General rule: the camera must NEVER inherit body roll/pitch/spin; use view kicks, FOV kicks and look-at easing instead. Use low/zero `follow` for `action: 'ultimate'` when the head heaves. Per-animal own-VFX near the camera must fade (see `src/render/fpFade.ts`; column/sphere/beam effects centred on the player should use `cameraRig.isFirstPerson` or `nearFadeFactor`).

## Eagle — Death From Above
- Ascent: pitch up with the climb, slight roll-into-bank feel (no real roll). Hold: pitch about −35°…−55° toward the reticle centre (`ultimateStage` 0/1 `pos`). Commit: settle view on the fixed circle. Stoop: look straight down the dive line at the committed point, FOV kick up to ~+10%, strong wind rush. Impact: snap back to normal eye height with a short shake.

## Mole — Sinkhole Vortex
- Dig-in: drop eye ~0.3 m with dirt at the edges. Tunnel: body hidden, low ground-skimming view with the crack ahead + screen rumble. Surface: rise to full height, look at the pit centre (`ultimateStage` 1 `pos`). Vortex: slight roll *sway* (fake, view-only) with the swirl. Collapse: hard downward kick.

## Crocodile — Death Roll
- The roll is rig-local `body.rz` only — camera must never inherit it; use low/zero `follow` for the head during `ultimate` (head heave/shudder). Victim sits ~2 m ahead at the jaws and orbits 0.55 m: keep snout + jaw gape visible at the bottom of the screen. Lunge: slight forward FOV kick. Toss: small shake.

## Python — Coil Snare
- All motion is rig-local neck/coil (no roll/spin). The rear lifts the neck ~1 m: keep `follow` small during the ult. Tether starts ~0.9 m ahead at 1.3 m height along the aim (visible from the eyes); the bound victim is ~1.6 m ahead, lifted 0.2 m, with the wrap rings tightening in view.

## Lion — Royal Hunt
- Coil: camera locks softly onto the victim. Leap: ride the arc (look at the landing point, slight FOV kick). Pin/maul: sit low over the victim, alternating viewmodel paw per strike, a small kick at each impact (stages 3–6). Roar (stage 7): tilt the view up ~45° then settle.

## Panther — Shadow Execution
- The camera never teleports with the body: on each `blink` re-aim at the victim within ~0.06 s plus a brief vignette flick (no position pop). Finisher: view rises and hangs, then slams down. Execute flash (stage 7): a short full-screen pulse. Panther is ~22% opacity/ghosted during the sequence (own body mostly hidden in FP anyway).

## Gorilla — Boulder Hurl
- Tiny pitch kicks on the two chest beats, a short down-pitch + shudder at the slab rip, the slab passes above the view during the hoist, forward kick (+3°, FOV +4%) at the release. Yaw follows the aim. (Held slab is a mesh on the rig root — check it doesn't clip the FP camera.)

## Giraffe — Timber Fall
- Pitch up with the whip-back, then a fast ~35° pitch-down over the 0.14 s slam with a hard shake, then a bounce and slow return to level. Yaw follows the circle during the creep. Eye is ~3.7 m up (existing FP profile).

## Hippo — Riverlord's Flood
- Yaw is locked for the windup + surge. Pitch up/back during the rear-up, hard down-kick + shake on the slam, forward surge, decaying breath bob. NOTE: `src/render/animals/fp/hippo.ts` opens the jaw from the phase-local `u`; the ultimate's `actionT` now restarts per phase, so it must key off `state.ultPhase` (and `ultStage`).

## Rhino — Seismic Stampede
- Pitch down on the windup; FOV widening + stride-cadence bob during the charge; roll into turns; pull the view yaw toward the rhino's heading while homing (heading is sim-driven); upward flick on the gore (carried victim rides the horn ahead); forward kick on the crush. `fp/rhino.ts` itself needs no change.

## Known cross-cutting issue (found by the Lion agent)
- `World` never advances `actionT/actionDur` for a knocked-down fighter, so the knockdown fall/rise pose does not animate for ANY victim (the lion's pin works around it by driving the victim's clock itself). Giving `knockdown` a real clock in `World` would fix every animal — candidate Phase-3 fix (also check FP knockdown view).
