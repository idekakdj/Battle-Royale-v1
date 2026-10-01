# Panther — Shadow Execution (as built, v1.3 Phase 2)

A single-target **lock-on** ultimate: the panther melts into shadow (evasive, CC-immune), shadow-steps around the victim for five quick strikes from shifting angles, then steps **behind** them for a heavy finisher that **executes** anyone under 35% HP, and is left visible and vulnerable for about a second.

Files: `src/config/ultimates/panther.ts` (numbers, `PANTHER_EXEC` timeline) · `src/sim/ultimates/panther.ts` · `src/ai/ultScripts/panther.ts` · `src/render/animals/Panther.ts` + `src/render/animals/ultPose/panther.ts` · `src/render/ultFx/panther.ts` · `src/audio/ults/panther.ts` · `tests/sim/ultimates/panther.test.ts` · balance: `docs/ultimates/panther-balance.txt`.

## Targeting
`targeting: { kind: 'lock', range: 11, coneDeg: 70, requireTarget: true }` (no `dodge` opt-in: there is nothing to sidestep once the shadow closes; counterplay is the 11 m range, the 0.35 s melt, the jump, and guarding the front arc). No target → `ultimateFizzle`, nothing spent. The old Night Prowl stealth-crit is gone (`stealthBonusDamage` removed; `stealthCritPending` is never set).

## Timeline (seconds from cast; `PANTHER_EXEC`)
| t | Beat | `ultPhase` / `ultStage` | Rules |
|---|---|---|---|
| 0 – 0.35 | Melt into shadow | windup / 0 | interruptible; the shared `stealth` buff fades the rig to ~22% (it expires by itself if the cast is cancelled) |
| 0.35 | Shadow closed | — | **CC-immune** (`ccImmuneChannel`) and **−60% damage taken** (`incomingDamageReduction 0.6`) until the recovery; stealth refreshed for the whole sequence |
| 0.35, 0.57, 0.79, 1.01, 1.23 | Strikes 1–5: `blink` to a new angle + `ultimateStage` | active / 1–5 | angles θ0 + [80°, −120°, 160°, −52°, 112°] (θ0 = bearing victim→panther at cast), at victimR + pantherR + 0.3 m, facing the victim; claws land **0.08 s after the blink**: **40 dmg**, `blockIgnore 0.5`, flinch, no backstab stacking |
| 1.45 | Finisher blink — directly **behind** the victim (their facing + 180°) | active / 6 | 0.16 s later: **85 dmg** (+ **90 execute** if the victim's HP < 35% at that moment, emitted as stage 7 at the impact instant), stagger |
| 1.85 | Reappearance | recovery / 8 | shadow drops: visible, vulnerable, not immune; **1.0 s** recovery |

Single-target total on an unblocked victim: **5 × 40 + 85 = 285** (**375** with the execute bonus). A victim who was at ≤ ~56% HP when the ult started is under the line by the finisher. The blinks keep the panther inside the arena and out of pillars (shared `blink`). A jumping victim dodges the claws (each strike checks ground reach) but the panther still finishes the sequence.

Edge cases (all tested): victim dies / becomes untargetable (burrowed mole) mid-sequence → the sequence breaks, 0.5 s recovery, all flags cleaned; panther dies mid-sequence → `abort` removes the ghost stealth, reduction and immunity; a guarding victim takes half-pierced damage and only the front-arc strikes (angle −52°) can be guarded — the other angles go around the guard.

## Animation (rig driven only from `actionT`, `ultPhase`, `ultStage`, `pos`, `vel`)
`ultPose/panther.ts` = keyframed, cubic-eased timeline (shared sampler with the lion) keyed on the fixed blink cadence. The root teleports on each blink (the match snaps interpolation); every beat ends in (or ahead of) the next beat's pre-pose so nothing pops:
- **melt**: flattens into a coiled crouch with a shadow shiver while the stealth fade takes it to ~20%;
- **five distinct slashes**: 1 rake (right paw raised, raked across), 2 overhead chop (left paw from high above), 3 low sweep (paw skimming the ground, body whips round), 4 lunge-bite (springs off the hind legs, forepaws reach, jaws snap), 5 spinning double rake (full torso twist); 0.08 s anticipation → strike → 0.14 s follow-through;
- **finisher**: rears up, hangs one breath, two-paw slam + snap, tail whip, long follow-through;
- **stalk**: a low prowl with head sweeps and tail flicks easing back to a stand (a broken sequence blends into it over 0.15 s).

## VFX (`ultFx/panther.ts`)
Reticle on the victim (gold own / red enemy, violet-tinted), dark smoke burst as it melts and trailing smoke while the shadow lasts (so its 20%-opacity position still reads). Every blink: shared shadow-step flicker, dark smoke + violet sparks along the jump, and a violet dashed **shadow mark** on the ground at the landing spot (fades ~0.8 s). Each strike: a dark-violet claw streak with a bright violet-white edge (normal blending so it reads on pale sand), shaped per strike (rake / vertical chop / flat sweep / fang pair / X) and timed to the claws landing; finisher: big X + vertical chop; **execute (stage 7)**: white-violet flash, shock ring, impact ring, bursts, shake. Reappearance: smoke puff + ring.

## Audio (`audio/ults/panther.ts`)
Lock: breathy whisper/hiss + faint sub breath. Blink: "thwip" (band-passed noise swept down + sine blip). Strikes 1–5: slash (rising band-passed noise), pitched up a little each strike. Stage 6: heavy whoosh + slam thump. Stage 7: execute thump (deep sine drop, crack, rising shimmer). Stage 8: soft exhale.

## AI (`ai/ultScripts/panther.ts`)
Gate: target within 10 m. `ranged: true`; Veteran window: target ≤ 65% HP, helpless, or isolated. Apex (and own HP > 20%): execute range (target ≤ 56% HP), helpless/rooted, a fleeing target ≤ 75% HP, or an isolated target ≤ 80% HP. The shared brain check vetoes casts that would fizzle.

## Balance notes
Bands held (see `panther-balance.txt`): N=120 L3 15% / L4 8%, N=60 L1 13% / L2 7%, 0 timeouts, ~1.0–1.2 ults per fighter per match; the ult is ~28–30% of the panther's hit events (was 0% — Night Prowl's damage was counted as basics). First tuning pass was 42 / 90 / +100 (300 total), which put L3/L4 at 19–22%; 40 / 85 / +90 is what shipped. Levers: strike / finisher / execute damage, `shadowReduction`, `strikeAngles`.

## First-person notes (for the later FP pass)
- **Clear view (ultimate only):** while the ultimate runs (`action === 'ultimate'`, every phase / stage) the own rig is screen-space clipped out of the centre 50% x 60% of the screen (`ultClip` in the FP profile, `fp/clip.ts`), and only the two fore paws are drawn (`ultHide`: body, hind legs and tail are not). The strike paws are small (scale 0.5), pushed to the edge bands (`bandTip`) and locked to the camera's real pitch (`ultViewLock`): rake R / chop L / low sweep / lunge / spin / slam read as paws moving along the lower corners and edges. While a blink slides the eye more than 0.45 m away from the body (`UltCamOut` slide, first frames after each blink) the whole rig is discarded so the translucent (stealth) body is never seen from outside, and its depth-only twin is switched off so it cannot occlude the victim or the VFX. The normal first-person look (idle, run, attacks, block, ...) is unchanged. Measure with `await __gkFp.report()` (dev build): 0 safe-zone pixels, <= ~12% of the frame in every stage.
- The camera should **never teleport with the body**: on each `blink` keep the look direction on the victim (re-aim yaw to the victim over ~0.06 s) and do a 2-frame vignette/darken flick instead of a cut.
- Melt: lower the eye slightly (crouch −0.25 m), desaturate / darken the edges, forepaws tucked low in frame.
- Strikes: alternate viewmodel paws per distinct slash (rake R, chop L from above, low sweep from the bottom edge, lunge with both paws forward, spin = a quick ±25° roll); impact kick 0.08 s after each blink.
- Finisher: rise ~0.3 m and pitch up (the rear-up), hang 0.1 s, then slam the view down with a strong kick; execute flash is a full-screen white-violet pulse (0.15 s).
- Stalk: low eye, slow head-sway, eased back to standing over the 1 s recovery.
