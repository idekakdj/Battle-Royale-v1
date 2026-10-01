# Python — Coil Snare (v1.3 phase 2, as built)

Files: `src/sim/ultimates/python.ts` (rules) · `src/config/ultimates/python.ts` (numbers, `PYTHON_STAGE`, `PYTHON`) ·
`src/ai/ultScripts/python.ts` (bots) · `src/render/animals/Python.ts` + `src/render/animals/ultPose/python.ts` (rig) ·
`src/render/ultFx/python.ts` (VFX) · `src/audio/ults/python.ts` (audio) · `tests/sim/ultimates/python.test.ts`.

## Mechanic
`lock`, range 9 m, 60° cone, `requireTarget`. Unique: a ranged **tether** (a moving line, not a lunge) that **yanks** the victim all the way in.

| Beat | `ultimateStage` | Time | What happens |
|---|---|---|---|
| Windup | (0) | 0.6 s | Rear + hiss. Aim TRACKS the locked victim (4.4 rad/s). Interruptible as before. |
| Commit | `COMMIT` 1 | at 65 % (0.39 s) | Tether direction frozen; `pos` = tether end point (victim distance + 1.6 m, min 3 m, max 10.2 m). |
| Lash | `LASH` 2 | ~0.25–0.33 s flight | The tether flies at 32 m/s from 0.5 m ahead of the python. Its contact half-width is 0.4 m + the foe's radius; the FIRST ground-targetable foe on the swept segment is snared (a foe jumping above 0.7 m is missed; pillars, tall crates, tall walls and the arena wall stop it). Step out of the line (or jump it) and it whiffs. From here the runtime has grab resist (`isGrab`). |
| Snare | `SNARE` 3 | yank 0.26–0.5 s | Snare hit 20 (unblockable, heavy); victim seized (its own cast torn down), stunned, reeled in along the python→victim line to `radius + radius + 0.15` from the python (smoothstep, `clamp(pull/18, 0.26, 0.5)` s). A 8 m victim is pulled ~6 m. Python takes 30 % less damage from now until the crush. |
| Bind | `WRAP1..4` 4–7 | 2.6 s | 4 squeeze pulses (every 0.65 s), one `ultimateStage` each: the wrap tightens one notch per beat. Victim held, stunned, lifted 0.2 m, not moving; continuous **unblockable drain 200** (77/s). |
| Crush | `CRUSH` 8 | instant | 40 damage (unblockable, heavy, not amplified by the hold stun) + 0.45 s stagger; victim released. Recovery 0.45 s. |
| Whiff | `WHIFF` 9 | 0.28 s retract + 0.57 s | Nothing snared (or blocked): the tether snaps back; `spec.recovery` 0.85 s in total after the tether ends. |

Total 20 + 200 + 40 = **260** unblocked (block irrelevant). Victim held/stunned for yank (~0.4) + 2.6 s. Hit timeline: cast → crush ≈ 3.6 s → free ≈ 4.1 s; whiff: ≈ 1.9 s.
Cleanup on every exit: caster dies (`abort`), victim dies (hold or yank; `rt.targetId` cleared by `World.kill`), victim freed, crush — victim released on the ground, flags cleared.

## Targeting / indicators
`targeting: { kind: 'lock', range: 9, coneDeg: 60, requireTarget: true, dodge: { mode: 'fixed', activeS: 0.35, radius: 1.6 } }`.
Ready state: HUD range ring + gold LOCK bracket. Cast: lock reticle on the victim + ground ribbon python→victim that tracks; at COMMIT the ribbon freezes at the tether end and turns solid red (committed reticle). During the lash the ribbon's `setReveal` races out with the tether. Bots at L3/L4 leave the victim's cast position.

## Animation beats (`ultPose/python.ts`, only `ultPhase`/`ultStage`/`actionT`)
The 4-link neck chain + head + jaw + tongue + coil + tail tip, blended by per-channel followers:
- Rear (windup): neck straightens into a cobra rear (upright, leaning back), head tilts down at the target, jaws gape with a hiss tremor, tongue flicks fast, lateral neck sway, tail rattle. COMMIT: sway stops, neck winds back, chin tucks, jaws narrow.
- Lash: neck spears forward (eased snap, 12 % overshoot), body drives 0.4 m, tail whips out and back, jaws open then close.
- Snare/yank: neck arches back hauling, body recoils 0.3 m, coil compresses with strain tremor.
- Wrap 1–4: neck leans over the victim, head down, jaws working; the coil twists tighter (`coil.ry`) and squeezes harder each beat with a pulse (`coil.s`).
- Crush: coil snaps tight then rebounds with overshoot, head jerks up, jaws open, tail flicks; then settle (slow breathing, sway returning).
- Whiff: neck recoils with the tether.

## VFX (`ultFx/python.ts`)
Tether = an instanced rope of 30 spiralling coil links (scale-green / cream alternating, whip wiggle, bright additive tip) flying out at tether speed, with the ground ribbon's reveal racing with it and sparks at the tip. Snare: snap flash, sparks, shock ring, shake; the rope follows the victim while it is yanked (dust trail). Bind: 2/3/4/5 wrap rings (torus meshes) around the victim that tighten per `ultimateStage` with a squeeze pulse each beat (ring flash, sparks, dust), low rope linking python and victim. Crush: rings snap shut then burst outward and fade; flash, sparks, shock ring, ground dust, shake. Whiff: the rope retracts to the python. Meshes are built lazily and removed on `dispose`; ground-height aware (dais).

## Audio (`audio/ults/python.ts`)
Rearing hiss with shimmer + tail rattle; commit inhale; whip crack + tether whistle; snare thwack + body thud + yank whoosh; four bone-creak squeeze pulses (pitch rises each beat) with rope shhk + sub pulse; crush bone crack + low thump + released breath; whiff snap-back.

## AI (`ai/ultScripts/python.ts`)
`gate`: target within 8.4 m; `ranged: true` (Veteran uses the ranged window: helpless / rooted / fleeing / isolated / low-HP). Apex: helpless, FLEEING (runners fly straight down the tether), committed special, ≤ 40 % HP, blocking. Vetoed without a valid lock (`ultTargetValid`).

## Tests (`tests/sim/ultimates/python.test.ts`, 21)
Config/targeting, fizzle, lock event, full beat order, flight time 0.12–0.36 s, yank pulls 5+ m and holds at the bind gap, hold/stun/immobile + 30 % reduction only while holding, 260 total (blocked or not), crush + stagger, lateral dodge, off-line whiff + 0.85 s recovery, jump-over, pillar blocks the tether, first-foe-on-line, interrupt rules, caster/victim death (bind + yank) cleanup, determinism, bot script.

## Balance (see `python-balance.txt`)
Single target 260 (band 250–320).

## First-person notes
The python's ult is entirely rig-local neck/coil motion (no roll/spin): the camera may keep following the head but `follow` should be small during `ultimate` — the rear lifts the neck ~1 m and the lash throws it 1.5 m forward. The tether is visible from the eyes: it starts ~0.9 m ahead of the body at 1.3 m height and flies straight along the aim. While the victim is bound (1.6 m ahead, lifted 0.2 m) the wrap rings tighten in the view; the player should keep a forward-down look at the victim (the existing "held → look at the grabber" logic is for the victim, not the python).
