# Champions League — pose layer notes (WP-A1)

Owner: `src/brawl/render/pose/**`, `tests/brawl/pose*.test.ts`, demo `?demo=brawl-moves`. Binding contract: plan §6 / §10.
This file is the hand-off for **WP-A2** (crocodile, hippo, rhino, panther) and **WP-A3** (eagle, python, giraffe, mole) and for
**WP-R** (the view that consumes `BrawlRig`).

## 1. API (what the view uses)

```ts
import { createBrawlRig } from 'src/brawl/render/pose';        // index.ts
const rig = createBrawlRig('lion');   // pre-builds every move pose of that animal (≈ 50-150 ms, once per animal)
scene.add(rig.root);
rig.update(cur, prev, alpha, dtRender);   // every render frame; prev may be null
rig.tipWorld('strike');                   // THREE.Vector3 | null — world position of the striking limb tip
```

`BrawlRig` (src/brawl/render/pose/BrawlRig.ts):

| member | meaning |
|---|---|
| `root: THREE.Group` | the only thing to add to the scene; positioned at the fighter's feet centre (z = 0) |
| `update(cur, prev, alpha, dtRender)` | places + poses. Pose = pure function of `cur` (and `prev` for position interpolation) and the subframe `alpha`: the move pose is evaluated at the continuous frame `cur.moveFrame − (1 − alpha)`, so it is identical at any refresh rate. `dtRender` only drives the 2–3 frame cross-fades and the ambient idle/gait clocks. Hidden (`root.visible = false`) while `!cur.alive` or `action === 'ko'`. |
| `tipWorld(role)` | world position of a tip; `role` ∈ `'strike'` (the limb of the move being performed), `'foreNear'/'foreFar'/'hindNear'/'hindFar'/'head'/'jaw'/'tail'/'wingNear'/'wingFar'/'body'`, or the aliases `paw/claw/fore/hind/wing`. `null` if the animal has no such tip. |
| `tipLocal(role)` / `tipFighterLocal(role)` | the same in rig-local metres (x lateral, y up, z forward) / in the sim's hitbox space `{x: forward, y: up}`; squash/tilt aware |
| `shake` | hitlag shake scale for hit fighters (default 1; set 0 if the view shakes them itself) |
| `yawAngle`, `squashNow`, `currentBuilt`, `lastKey`, `strikeRole` | demo / test read-outs |

Coordinate convention: X right, Y up, **camera on the +Z side looking toward −Z**. Facing +1 → yaw `+(90° − 22°)` (the animal turns 22° toward the camera),
facing −1 → `−(90° − 22°)`; the yaw eases over ≈ 4 frames. The rig hierarchy is `root → pivot (hurtbox centre, tumble / ledge-hang / roll about z) → inner (feet, squash & stretch) → yaw → rig.root`.
The hurtbox height for the pivot comes from `getMoveset(animal).stats.height`.

Frame convention (matches the real `BrawlWorld`): a snapshot with `moveFrame = k` is move frame `k`; the hitboxes in that snapshot are the ones active in `[from, to)` at `k`, and the **strike peak pose is exactly frame `from`** of the first hitbox.
Data keys the animation reads (everything else in `anim` is ignored): `limb` (paw, claw, talon, forelimb → fore limb; hindleg → hind; jaw; head/horn/beak/neck → head; tail; wing; body), `side` (`R` = the camera-near limb, `L` = the far limb, `both`), `reach` / `height`
(the strike-tip target, projected into the hitbox core), `spin` (turns, spinAttack). The hitbox itself (shape, `path`, `from/to`) is the ground truth for the target.

## 2. The additive hook in `src/render/animals/Animator.ts` (the only edit outside `src/brawl/**`)

Added (Battle Royale `update()` path untouched; full pre-existing suite green):

* `Joint.applyBrawl(f, capRad)` — `apply()` plus a per-call rotation cap relative to the rotation applied last frame (safety net: no joint ever turns more than `capRad` in one call).
* `BaseRig.brawlJoints(): Map<string, Joint>` — every joint the subclass stored on itself by property name (`body`, `head`, `jaw`, `legs.0`, `armL`, …; same index as the first-person code).
* `BaseRig.brawlTick(dt, groundSpeed)` — advances the ambient idle / gait clocks.
* `BaseRig.brawlBase('idle' | 'run' | 'jump', arg)` — writes the rig's OWN authored idle / run / jump pose (so animal-specific idle breathing and gait come for free).
* `BaseRig.brawlApply(driver, dt, key, blendSec, capRad)` — resets the joints, runs `driver` (which writes joint targets), cross-fades from the pose on screen when `key` changed (per-call blend length), applies with the cap.

## 3. How a pose is made (so you know what to edit)

```
MoveBody ──archetype generator (archetypes.ts)──▶ ArchSpec {tip role, strike template B, free DOFs, anticipation A, pre/drift/end}
        ──solve free DOFs by forward kinematics on a scratch rig (solver.ts / build.ts) so the tip sits in the hitbox core──▶
        DOF keys: rest → A (ease out, ≈ first 55 % of startup, ≥ 2 frames when budget allows) → B at the FIRST ACTIVE FRAME (ease in)
        → hold / track the hitbox over the active window → overshoot → settle (ease in-out)  ──▶ Timeline (timeline.ts, pure fn of frame)
        ──profile.links (animals/<animal>.ts)──▶ joint channels  ──▶ BaseRig.brawlApply
```

* **DOFs** (dof.ts) are animal-independent: `bodyPitch` (+ = nose up), `bodyYaw` (+ = near side forward), `bodyRoll`, `bodyFwd`, `bodyUp`, `bodyStretch`, `rootSquash` (root-level, not a joint),
  `neckPitch/neckYaw/headPitch/headYaw/headRoll/jaw` (+ = up / toward the near side / open), `tailPitch/tailYaw/tail2Pitch/tail2Yaw` (+ = up), `foreNear*/foreFar*/hindNear*/hindFar*` × `Swing/Spread/Bend`
  (Swing + = forward & up, Spread + = outward, Bend + = flex), `wingNear*/wingFar*` × `Flap/Fold` (Flap + = raised, Fold + = swept forward), `neckExt`, `bodyCurl`.
* **Near / Far**: the profile is written for facing +1; `Near` = the rig's local −X side (the anatomical right limb, the camera side when facing right). For facing −1 the whole pose is mirrored automatically (joint pairs listed in `mirror` swap, `ry`/`rz`/`px` flip sign).
* **Smoothness budget** (enforced): ≤ 0.5 rad per joint per 60 Hz frame (≤ 0.9 on the strike frames `[strike − 2, activeEnd − 1]`). The builder shortens the anticipation / flattens the ease until the raw curve fits (fast 4-frame moves end up with little or no wind-up);
  `Joint.applyBrawl`'s cap is the safety net for blends from arbitrary poses (run → attack, hit → …).
* Grounded crouches (`bodyUp < 0`) become a root squash (`hipHeight`), because the legs are rigid and would sink into the floor.
* Aerials add a constant tuck (`AIR_TUCK`: hind legs / far fore limb drawn in).
* Tail DOFs lag 2–3.5 frames behind the body (secondary motion) unless the tail is the striker.

## 4. Writing a profile (WP-A2 / WP-A3)

Create `src/brawl/render/pose/animals/<animal>.ts`, export an `AnimalProfile`, call `registerProfile(...)` and re-export it from `animals/index.ts`. Until then the animal uses the auto-generated generic profile (`animals/generic.ts`: legs by rest position, head/jaw/neck/tail by name, tips from the baked bounding boxes) — it works, but tips and signs are guesses.

Checklist, per animal:

1. **Find the joints**: `rig.brawlJoints()` keys (`npx vite-node` a one-liner, or the demo's `__brawlMoves.rig().rig.brawlJoints()`), and `rig.describeJoints()` for bounding boxes / pivots. Joint names are the property names in the rig class (`legs.0`…, `wingLIn`, `neckJ.0`, `tail2`, …). Some joints appear under two names (gorilla `legs.0` = `armL`): use one.
2. **`links`**: for each DOF you can drive: `{ j: jointName, ch: 'rx'|'ry'|'rz'|'px'|'py'|'pz'|'s', k: coefficient }`. The joint channel receives `k × dof`. **Verify the signs against the rig**, do not assume: a limb hanging along −Y swings forward with **−rx** (so `foreNearSwing: k −1` on `rx`); the body joint's `+rx` pitches the nose DOWN (`bodyPitch` k −1); `neck/head +rx` dip the head (`neckPitch/headPitch` k −1); a jaw's `+rx` opens it (`jaw` k +1); outward `Spread` is `rz` k −1 on the −X (Near) limb and +1 on the +X limb. Joint rotations are applied in the joint's REST frame (rest rotations such as the lion tail's `rx = 1.25` change what `ry`/`rz` mean — check by looking at the demo).
   A DOF may drive several joints (`neckPitch` → neck and head) and a joint may serve several DOFs.
3. **`tips`**: `{ j, off: [x, y, z] }` — the striking end in the joint's local frame (rig metres): paw/fist bottom, snout tip, jaw tip, tail tip, wing tip, belly front (`body`). Provide at least `body`, and the roles the moves name (`foreNear` (+ `foreFar` for `side: 'L'`), `hindNear`, `head`, `jaw`, `tail`, `wingNear`…). Missing roles fall back (fore → head → body, hind → fore → head → body, jaw ↔ head, wing → fore → head).
4. **`mirror`**: pairs of joints that swap for facing −1 (`['legs.0','legs.1']`, `['wingLIn','wingRIn']`, …). Centre-line joints need no entry. Make sure `Near` links point at the **−X** joint of each pair.
5. **`limits`** (anatomical DOF bounds the solver respects), `hipHeight` (crouch → squash), `hipDrop` (collapse depth for knockdown), `hangTilt` (tilt about the hurtbox centre while hanging from a ledge: ≈ 1.1 quadrupeds, ≈ 0.9 upright, 0 for limbless).
6. **`overrides`**: replace a generic archetype for an odd anatomy: `overrides: { tailWhip: (c) => ({ tip: 'tail', B: {...}, free: [...], A: (b) => ({...}), swap: false }) }`. `ArchSpec`: `B` strike template (facing +1, striker = near), `free` = the DOFs the solver may change to reach the hitbox (`tie` = copy the value to other DOFs), `A` anticipation, optional `pre` keys (bite: jaw open until 1 frame before the strike), `drift` (added across the active window: spin angle), `end` (final pose; spins end a whole turn later `bodyYaw: 2π`), `noFit: true` (area bursts: do not pull the pose into the hitbox). See `animals/gorilla.ts` (`roar` = chest drum) for a worked example. Python / giraffe / mole / eagle will most likely need `overrides` for: python body arcs (`neckSwing`, `tether`, `spinAttack` = coil), giraffe neck (`neckSwing`, `tether`, front-leg `kick`), eagle wings (`wingBuffet`, `dive`, flap states), mole digging claws (`burrow`).
7. **`states`** (optional): `{ <stateKey>: dofPartial }` added on top of the generic state poses (`idle`, `run`, `jumpSquat`, `rise`, `fall`, `fastFall`, `landing`, `crouch`, `dodgeSpot`, `dodgeRoll`, `dodgeAir`, `hitstun`, `tumble`, `knockdown`, `getup`, `ledgeHang`, `ledgeClimb`, `respawn`). Idle / run / jump come from the rig's own `poseIdle/poseRun/poseJump` (use `brawlBase`): an animal whose BR idle/gait is wrong for a platform fighter (eagle flight, python slither) can override per state through `states`, or A3 may extend `states.ts` with a profile hook if more is needed (additive only).
8. **Tests**: add the animal to `ANIMALS` in `tests/brawl/pose.moves.test.ts` (tip-in-hitbox, ≤ 0.5 m, every move × air/ground × chain × both facings, smoothness, NaN) and to `tests/brawl/pose.sim.test.ts` (real `BrawlWorld`). Both are currently lion + gorilla only; the other eight run a looser "finite + smooth" check through the generic profile.
9. **Visual QA**: `/?demo=brawl-moves` (see §5). Look at anticipation, the peak frame (hitbox circle/rect + yellow tip marker + `d = … m` readout) and the follow-through for every move, ground and air, both facings, plus the states.

Fit errors you will see in the demo readout (`fit=0.10/…`): distance (m) of the tip to the target point inside the hitbox core after the solve (0.10 is the solver's built-in tolerance). Large values (> 0.5) mean the animal cannot reach: fix the profile (tip offset, limits, a missing DOF) or give the archetype a different striker.

## 5. Demo / QA tooling

`/?demo=brawl-moves` — animal / mode (move | state) / move / state / air / chain / face-left, play / pause / frame step (`<` `>`, arrow keys; Shift = 0.1 frame) / slow-mo (1×, ½, ¼, 0.1×) / scrubber, hitbox overlay (active = bright red) and strike-tip marker. Keys: Space, ←/→, 1–4 speed, L loop, H boxes, T tip.
Automation: `window.__brawlMoves = { set({animal, move, air, chain, facing, mode, state}), seek(moveFrame), sheet(frames, cols, dist, states?), shot(name, port), info(), rig() }`;
`sheet([0, 3, 5, 7, …], 4)` renders a contact sheet of several frames in one canvas (no pane screenshots needed; `shot` POSTs it as a PNG to a local receiver on port 5599, which is how this package was QA'd).

## 6. Known gaps / not verified

* Only lion and gorilla have hand-written profiles; the other eight use the generic fallback (plays, finite, smooth, but anatomy is approximate: e.g. crocodile tail whips and python/giraffe/eagle moves do not reach their hitboxes — they are WP-A2/A3's job).
* No hands-on playtest feel (only stills / contact sheets and the headless tests). The cross-fade lengths (2–3 frames) and the hitstun / tumble look were judged from stills.
* `invuln` flicker (panther dodge/leap), dodge ghost trail, percent steam and VFX are the view's job (WP-R); the rig does not touch materials/opacity.
* The foot-planting of grounded strikes relies on the root squash; large `bodyFwd` leans slide the feet slightly relative to the ground (the sim moves the fighter).
* Landing lag after aerials is shown as the generic `landing` squash pose (the sim switches the action), not as the move's own recovery.

## 7. Additive profile hooks added by WP-A3 (eagle / python / giraffe / mole)

All optional; a profile that does not use them behaves exactly as before.

* `AnimalProfile.neutral` / `neutralAir` — a constant DOF overlay added to EVERY key of every attack (and to the solver's finished pose), for animals whose joint rest transform is not their neutral pose: the eagle's wings rest at full span (neutral = folded), the python's rest neck is a 2 m tall cobra (neutral = a compact S-curve). DOF values in archetype specs are then RELATIVE to it (`animals/python.ts` `rel()`, `animals/eagle.ts` `rel()` convert absolute poses). `build.ts` also measures the entry blend from the neutral, not from zero DOFs.
* `AnimalProfile.states[key]` may be a pure function of the `StateCtx` (flap cycles, glide weights from `cur.vel.y`, a slither wave from `cur.pos.x`); `AnimalProfile.stateBase[key]` replaces the rig's own base pose of a state (`null` = none; the eagle drives rise / fall / fastFall itself because `poseJump` is a flight model of its own). `BrawlRig.chooseSource` resolves both.
* `ArchSpec.mid` — extra keys INSIDE the active window (deltas on the tracked strike pose, `at` frames after the first active frame): the eagle's three Soaring Updraft beats, the python's Constrict squeeze pulses and burst. A move with `mid` gets no intermediate tracking samples (it owns its window motion).
* Reused free DOFs, documented in each profile header: `bodyCurl` / `neckExt` / `neckPitch` are the python's chain (curl / straighten / base pitch) and the giraffe's neck-lay / neck2 bend / neck1 pitch; `neckExt` = burrow depth (mole) and primary-feather fan (eagle); `hindNear/FarBend` = the eagle's wrist fold; `bodyStretch` = coil scale (python) or neck stretch (giraffe).
* QA: `__brawlMoves.sheetCells(cells, cols, dist, camY, camX)` renders cells of different moves / forms / facings / states in one contact sheet; `sheet(..., states, camY, camX)` gained the camera arguments; the state list has a `glide` entry (fall at the eagle's glide speed).
* Projection gotcha found by `pose x sim`: the hitbox is tested in SCREEN x, and the rig is turned 68° about Y, so a tip's screen x = fwd × 0.93 + lateral × 0.38 — a neck / wing swept sideways shifts by up to ± 0.7 m. `tipFighterLocal` (the A1 move test) ignores lateral; `tipWorld` (the sim test) does not. Sweeps that cross from one side of a two-box move to the other (giraffe Neck Spin) must be timed against the screen-space value.

## 8. WP-P polish log (animation polish: wind-up, follow-through, transitions)

Status: DONE (tsc clean, `npx vitest run tests/brawl/pose` green, 285 tests; the only red test in `tests/brawl` is WP-T's `moveBudget` stats table).

**What changed (all additive; Battle Royale rig untouched, no edit outside `src/brawl/render/pose/**` and `tests/brawl/pose.polish.test.ts`)**

* `pose/windup.ts` (new) — the generic, weight-scaled wind-up layer. `moveWeight(body, strikeF)` (0 light … 1 heavy: startup, strongest hit's damage, armor) and `windupAmp(weight, strikeF)` (= budget(startup) × (0.4 + 0.6 × weight); 0 for ≤ 4-frame moves) are derived ONLY from the move data, so WP-T retuning is picked up automatically. `applyWindup` strengthens the archetype's anticipation vector `A` in two ways: (1) a per-archetype body COIL table (`COIL`: bodyFwd back, crouch = root squash on the ground, chest/nose pitch, shoulder twist `bodyYaw`, neck/head draw-back, tail counter-swing, hind legs gather, paws planted) pushed up to `amp × value` (never reduced, so hand-tuned `A`s that already coil harder stay as they are; translations scale with the animal's hurtbox width); (2) a minimum ARC between the anticipation and strike pose of the striking family's DOFs (fore/hind swing, neck/head, tail, wing flap), clamped to the profile limits. Hooks: `ArchSpec.windup = false | {coil, gain, noArcs}`, `AnimalProfile.windupGain`, `AnimalProfile.coil[archetype]` (per-animal replacement of the table pose; used by the lion's Maul Bite), `ArchSpec.commit`.
* `build.ts` — (a) `applyWindup` is called on `A` before the repair loop, so the loop still shrinks it when the 0.5/0.9 rad budget is exceeded; (b) a "load" key at `strike − clamp(0.2·S, 1.5, 3.5)` (the coil builds ~14 % deeper just before the release); it is a repair-loop candidate dimension (`ld`), so it is dropped when the release would be too fast; (c) heavier moves overshoot more (`over × (1 + 0.7·weight)`) and COMMIT: the overshoot pose is held with a slow creep for `recovery × 0.3 × weight` frames before the settle; (d) new translation budget `POS_NORMAL 0.26 / POS_STRIKE 0.34` m per frame on `bodyFwd`/`bodyUp(+squash)` inside the repair loop (a lunge release can no longer teleport the body); (e) selector hysteresis (a plainer candidate must beat an earlier one by 0.03, otherwise noise picked the amp-0 candidate on moves with an unavoidable constant violation: mole Tunnel Lunge had NO anticipation before); (f) moves with `spec.end` (spins/rolls finishing a turn) get a follow-through up to 14 frames (was 7).
* `animals/lion.ts` — Maul Bite coil (`coil.bite`): body sinks onto the haunches and draws back 0.32 m, chin tucked (`headPitch −0.3`) with the jaws wide, hind legs gathered, tail up; before, frames 4 and 10 were the same pose with the head thrown up like a howl. `animals/mole.ts` — Tunnel Lunge `ftFrac 0.6` (long spin-down of the corkscrew roll).
* `brawlMoves.demo.ts` QA hooks: `rowsSheet(rows, dist, camY, camX)` (one row per move: quarter / half / last startup frame, STRIKE, 25 % / 60 % of the recovery), `shootAll(prefix, animals, groups, port)` (standard review sheets A-E posted as PNGs), `windup(false|true)` (rebuilds every move without / with the WP-P layer for before/after sheets). `windupDebug.off` in windup.ts is the switch behind it.
* `tests/brawl/pose.polish.test.ts` (new, 40 tests): transitions (idle/run → attack → idle/run, fall/rise → aerial → fall/landing, attack interrupted by hitstun → idle) bounded in joint rotation (0.5/0.9/1.15 rad), joint TRANSLATION (0.3 m/frame, 0.36 on strike frames, 0.55 on the first two frames of hitstun/landing), joint scale and root squash; wind-up visible at 55 % of the startup for every move with startup ≥ 8 and heavy moves wind up harder than light ones. `P_REPORT=1` prints the worst offenders.
* QA flow that works while the pane is hidden: run a tiny PNG receiver (`node recv.mjs <port> <dir>` that writes POST bodies), open `?demo=brawl-moves` in an own tab (resize 1600x900), `await __brawlMoves.shootAll('new', ['lion'], ['A','B'], 5598)`, then Read the PNGs. (Pane screenshots time out while the pane is hidden.)
* Conflict rule (windup.ts): the generic `COIL` table never flips an authored anticipation that already goes the OTHER way by >= 0.15 (the gorilla's wide-armed Chest Drum keeps its raised arms); a per-animal / per-move table (`prof.coil`, `spec.windup.coil`) is authoritative and may flip it (lion Maul Bite tucked chin).
* Cut-off recovery: everything is on disk; the scratch tests (`_p_*.test.ts`), the PNG receiver and the dev server were removed / stopped.

**Before / after per animal (contact sheets A-D, 10 animals; the old behaviour = `__brawlMoves.windup(false)`)**

| animal | before | after |
|---|---|---|
| lion | Maul Bite f4 / f10 the same pose, head thrown up like a howl, no coil; Roar f4 / f7 near idle | Maul Bite: sinks onto the haunches, draws back, chin tucked, jaws wide, then a 3-frame release; Roar: crouch + head down + paws back (inhale) before the rear-up |
| gorilla | good (overhead arm raise, chest drum) | unchanged on purpose (conflict rule keeps the authored arms); slightly more crouch on Backhand |
| crocodile | Lunge Bite wind-up barely visible on a 3.5 m body | pulls back 0.4 m (size-scaled), deeper squash, longer follow-through; Tail Slam / Death Roll already read |
| hippo | crouch ok | deeper squash / pull-back on Mighty Yawn, Charging Gape, Belly Flop (rear up) |
| rhino | Charge and Horn Toss ok, headbutt small | Charge: planted, drawn back, lowered chest; headbutt: crouch + pull-back (still the subtlest) |
| eagle | wings sweep up / back, good | unchanged except dive pitch-back +0.1 |
| panther | Shadow Dash good, Pounce Spin small | Pounce Spin crouches deeper before the turn |
| python | coil / cobra-rise already strong | unchanged |
| giraffe | neck lay-back strong | unchanged |
| mole | Tunnel Lunge had NO anticipation (selector bug) | crouch + claws drawn back, long corkscrew spin-down |

**Still weak / unverified**

* Live 1x playback was not eyeballed: the Browser pane stayed hidden (screenshots and rAF stall), so smoothness was verified by consecutive-frame strips (`__brawlMoves.strip`) and by the 285 headless tests, not by watching it move.
* Short light moves (startup 4-7) keep the old 2-frame cue by design; Gorilla / Python / Giraffe are intentionally left near-unchanged. Hitstun entry and landing entry still change translation up to 0.55 m / 0.22 squash in one frame (impact) by design.
* The python's tongue pops in (scale 0 -> 1 over 3 frames) on every attack entry (rig idle hides it); exempted in the test.
* If WP-T moves frame data, the layer re-derives itself; the polish test fails only if a move with startup >= 8 ends up with no visible coil (then raise the move's `windup.gain` or widen its startup budget).
