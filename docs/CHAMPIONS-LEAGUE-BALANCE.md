# Champions League — balance log (WP-T)

Owner: WP-T (tuning). Dated iteration log: what changed, why, resulting numbers. Bands = plan §9 (L4 duels, both stages).
Tools: `npm run brawl:balance` (env `N`, `STAGE`, `MODE`, `LEVELS`, `WORKERS`, ...). Scratch tools (`scripts/_t_diag.ts`, `scripts/_t_sd.ts`) are deleted before hand-off.
Resume rule: the current numbers live in `src/brawl/config.ts` and `src/brawl/data/**`; the last "Current state" section below says where the work stands.

## 2026-10-02 — Baseline (WP-B first sweep, N=20 both stages, 3600 games)

| animal | win % | KO@% | SD % |
|---|---|---|---|
| lion | 60.6 | 206 | 18 |
| gorilla | 84.3 | 199 | 23 |
| crocodile | 14.7 | 165 | 10 |
| hippo | 47.5 | 140 | 18 |
| rhino | 48.3 | 189 | 15 |
| eagle | 61.9 | 153 | 0 |
| panther | 83.6 | 182 | 13 |
| python | 31.0 | 153 | 30 |
| giraffe | 43.1 | 186 | 23 |
| mole | 25.0 | 132 | 30 |

Overall: mean KO percent 167.7, self-destruct 18.2 %, timeouts 3.4 %, match 169 s. Blast sides L 747 / R 755 / top 4972 / bottom 9069 (side share 9.6 %).
Worst matchup crocodile vs eagle 0 %. Dominant moves: gorilla.heavyS 58 %, rhino.heavyS 49 %, mole.heavyS 47 %, python.lightS 46 %.

### Diagnosis (scratch diagnostic, 1440 duels)

* Kill probability per hit vs launch speed (L4 victims hold the stick toward the stage after hitstun, so air control eats ~25-35 m/s per second):
  side launches need kb >= 45-50 m/s (27 % kill at 45, 72 % at 55), upward launches kb >= 40. Heavy hits at 100 % deal 26-30 m/s, so kills only arrive at ~170-200 %.
* 58 % of KOs are bottom-blast: heavy / edge-guard hits at kb 25-35 send a fighter off the ledge and the recovery fails (recovery moves rise only 1.6-4.5 m, ledge grab box 0.8 m). Side kills (kb >= 40, flat angle) were ~10 % of KOs.
* "Self-destructs" are mostly long recoveries: the sim credits a kill only when the last hit is <= 240 frames old, so a fighter launched far off stage that dies 4+ s later counts as SD. Better recoveries and faster kills both shrink this.

## 2026-10-02 — Iteration 1: global kill calibration (N=20, 3600 games)

Changes (all numbers; no sim rules, no hitbox geometry, no timings, no `anim`):
* `config.ts` PHYS: `hitstunPerKb` 0.6 -> 0.9, `hitstunDecayX` 0.985 -> 0.99 (a strong launch keeps the victim out of air control longer), ledge grab box `ledgeBoxOut` 0.8 -> 1.1, `ledgeBoxUp` 0.4 -> 0.5, `ledgeBoxDown` 1.0 -> 1.3 (more off-stage launches are recoverable, so fewer bottom-blast deaths).
* Every heavy hitbox: `baseKb` x1.2, `kbGrowth` x1.5 (pull/bury/multi-tick boxes untouched); light chain `hitstunScale` x0.667 (0.6/0.9) so the true-combo timing is unchanged.
* All animals: `airSpeed`, `airAccel` x1.1; every Heavy-Up recovery `motion` vx, vy x1.25 (vertical reach is what turns a launch into a survivable one; horizontal alone barely helped).
* Result: mean KO percent 167.7 -> 115.9, side share 9.6 % -> 30.9 %, SD 18.2 % -> 14.3 %, match 169 s -> 121 s, timeouts 0 %.

Kill-calibration experiments (1440 duels each, scratch diagnostic): kills by blast side stay ~55-60 % bottom unless recoveries improve; hitstun/kb alone moved mean KO percent but not the side share. Recovery x1.2-1.5 + wider ledge box + air speed x1.1 moved bottom 56 % -> 33-38 %.

## 2026-10-02 — Iterations 2-3: per-animal first passes (N=20)

* Heavy kb tiers: Heavy-Up recovery hits 9.5 / 17 (they are not kill moves), ground Heavy-Down 10 / 20, Heavy-S / Heavy-N growth per animal (gorilla 25 / 22, hippo 25 / 31, rhino 28 / 18, croc 26 / 24, lion 23 / 20, giraffe 26 / 21, python 25 / 18, panther 21 / 19, eagle 24 / 17, mole 22 / 23).
* Armor made punishable: gorilla heavyN armor f6-14 (was f2-14), heavyS f10-20 (was f6-22), hippo heavyN f8-18 (f6-20), heavyS f10-22 (f8-24), dmgScale 0.5 -> 0.7.
* Panther: invulnerability Shadow Dash f4-13 (was f4-19), Shadow Leap f0-8 (was f0-14), run 9.8 -> 9.4, weight 90 -> 84, lightS damage 7 -> 6.
* Weights (plan +-15 %): gorilla 125 -> 115, hippo 140 -> 130, croc 115 -> 128 (run 7.0 -> 8.0, walk 3.6 -> 4.2, width 2.0 -> 1.8), python 85 -> 97, giraffe 98 -> 106 (hurtbox height 2.6 -> 2.3), mole 72 -> 82 (run 8.8 -> 9.2), lion 100 -> 98, eagle 78 -> 76 (air jump 13.5 -> 12.8), panther 90 -> 84.
* Damage nudges inside the §3 bands: lion lightS 7 -> 6; croc lightS 8 -> 9, lightD 6 -> 7, heavyS 19, heavyN final 6 -> 8 (-> 7 later for the 16 cap); python lightS kb 6/9 -> 8/10, heavyS 19; giraffe heavyS 18; mole lightN chain 3 -> 4 per hit, lightS 7 -> 8, lightD 6 -> 7, lightU 7 -> 8, heavyN final 5 -> 7, heavyS 14 -> 16; rhino heavyS 20 -> 19.

Result after iteration 3 (N=20, both stages): win % lion 51, gorilla 64, croc 27, hippo 52, rhino 53, eagle 55, panther 60, python 49, giraffe 50, mole 39. Mean KO 137.7 %, side 40.5 / top 15.0 / bottom 44.5 %, SD 15.0 %, timeouts 0.3 %, match 149 s. Worst matchup giraffe vs panther 7.5 %. Dominant: gorilla.heavyS 54 %, rhino.heavyS 47 %, mole.heavyS 56 %.

## 2026-10-02 — Iterations 4-5 (N=20): every animal inside 42-58 %

* Gorilla: weight 125 -> 112, walk 3.8 -> 4.1, run 7.2 -> 7.8 (long-reach animals were kiting it to death), heavyS 19 dmg, armor heavyS f11-20 (was f6-22), heavyN f8-14 (was f2-14), dmgScale 0.7.
* Panther: weight 80, run 9.2, hurtbox 1.1 x 1.3 -> 1.2 x 1.35, Claw Rake 4 -> 3 dmg, Dash invulnerability f4-13, Leap f0-8.
* Crocodile: weight 132, run 8.0, walk 4.2, hurtbox 2.0 x 1.0 -> 1.7 x 0.9, hitstunScale (frame advantage, so its pokes lead into follow-ups) on Tail Flick 2, Low Snap 2.5, Head Toss 2.
* Mole: hurtbox 0.8 -> 0.7, run 9.4, heavyS growth 24.
* Result N=20: win % lion 49, gorilla 55, croc 47, hippo 50, rhino 54, eagle 52, panther 53, python 49, giraffe 45, mole 47; mean KO 136 %, side 41.8 / top 14.6 / bottom 43.6 %, SD 14.6 %. Open: 14 matchups < 30 % (worst giraffe vs panther 12.5 %), dominant moves (gorilla.heavyS 53 %, rhino.heavyS 47 %, mole.heavyS 51 %), mean KO still 136 (aim 105-125).
* Finding: 73 % of the "self-destruct" KOs are launches that die 4-5 s after the last hit (credit window is 240 frames, plan §2.2 + `sim.match.test`); only ~3 % of KOs are true self-destructs. The credit window is a sim rule, not changed.

## 2026-10-03 — Iteration 6: tests follow the new calibration; tooling; what actually moves the matchup matrix

Tests made consistent (no band widened without a reason):
* `sim.combat` and `moveBudget` hitstun checks now read `PHYS.hitstunPerKb` instead of the literal 0.6.
* `KILL_MODEL` (analysis.ts) now reads every constant from `PHYS`, models the victim steering back toward the stage like a level-4 bot (`airAccel 30`, `airSpeed 6`, hit 4 m in from the centre) and counts a sweetspot at half weight (`sweetShare 0.5`). It orders the animals like the sweep and sits ~25-60 points below the measured mean KO percent of the move. Result: best kill 84-139 %, weakest heavy >= 150 % (all moveBudget kill assertions unchanged).
* `moveSmoke` KO test: the victim steers toward the stage once airborne (as a bot does); lower bound 75 -> 60 %, because a steering victim at 4 m is the model's case, the old passive victim was not.
* `moveBudget` stats tolerance +-10 % -> +-15 % (the brief allows +-15 %), Lion's Heavy-Up peak ceiling 5.0 -> 6.6 m (every recovery is x1.25; the plan text said 4.5 m).
* Panther hurtbox width 1.2 was rolled back to 1.1: the sim fuzz test counts an overlap > 0.75 m as embedded and a 1.2 m panther was 0.02 m over the line on one push-out frame.

Tooling (scratch, deleted at the end): a runtime patch hook (`PATCH="giraffe.stats.weight=100;retime:giraffe.heavyS=19,33"`) and a one-animal-versus-all evaluator, so a change is evaluated on 9 matchups x 2 stages in ~40 s without editing files.

Findings that drive the remaining work:
* Heavy-move startup is by far the strongest lever: -2 frames on one heavy moved an animal's win rate by 5-12 points (mole heavyS 15 -> 13: 42.8 -> 54.5 %; giraffe heavies -3: 46 -> 68 %; panther Pounce Spin +2: 61 -> 49 %). Slow heavies (22-frame startups: croc, python, giraffe, hippo) get interrupted by every fast counter; the dodge cooldown is not a lever (30 / 60 / 100 frames: matrix spread unchanged).
* Armor must start early to mean anything: with armor from frame 11 the gorilla's heavy was interrupted by every jab and lost 75-25 to a poking giraffe; armor from frame 3 with one hit made it a 69 % animal; two hits from frame 8 with a weaker heavy lands it near 50 %.
* Matchup extremes are structural (rush > zone > armor > rush). The pairs that stayed under 30 % needed their specific counter-move retimed, not a general nerf.

## 2026-10-03 — Final state (shipped numbers live in `src/brawl/config.ts` + `src/brawl/data/**`)

### What the last passes changed
* An automated per-animal coordinate search (one animal against the other nine, two rounds, ~40 candidate moves each) tuned weight, run speed and the Heavy-N/S/D startup (recovery compensates, so a move's total length is unchanged unless noted). **Frame-timing changes (startup / recovery), the only timing edits of the pass; hitbox shapes, positions, paths and `anim` were not touched:**
  crocodile heavyS 22/30 -> 19/33, heavyD 14/26 -> 13/27; python heavyS 22/32 -> 19/34 (budget cap 34), heavyD 14/26 -> 13/27; giraffe heavyS 22/30 -> 19/33, heavyN 16/28 -> 14/30; panther heavyN 14/22 -> 16/24, heavyD 12/22 -> 13/21; rhino heavyS 18/32 -> 16/34, heavyD 14/26 -> 15/25; mole heavyS 15/24 -> 14/25, heavyD 14/24 -> 13/25; lion heavyN 14/24 -> 16/22; eagle heavyS 15/24 -> 16/23; gorilla heavyN 14/26 -> 15/25. Lunge/dash `motion` windows moved with their startup. (Poses derive from the move data; all pose tests pass.)
* Gorilla: two-hit armor (heavyS f8-20, heavyN f8-14), weight 107, run 8.1, heavyS 16 dmg / growth 21, heavyN 12 dmg. Armor from frame 11 / one hit made it lose 75-25 to a poking giraffe and armor from frame 3 made it a 69 % animal; this is the middle.
* Weights / speeds (within +-15 % of plan §3.1): hippo 122, panther 78, giraffe 95 (run 7.2), python run 7.3, rhino run 7.9, mole run 9.1 and hurtbox 0.68 (-15 %, minimum), jump 14.5.
* Dominant-move shares: heavyS damage trimmed (gorilla 16, rhino 17, giraffe 16, mole 14), rhino Stomp Tremor 12.
* Test follow-ups: gorilla walk 4.25 / weight 107 inside the +-15 % tolerance; kill-ordering assertion now compares hippo and rhino (very high) against eagle / panther / mole, and the gorilla only has to stay within 25 points of the lion: raising the gorilla's kill power made it a 62-67 % animal because its armor makes every connect safe.

### Confirmation numbers (L4, both stages, `SEED=1`)
Duels N=60 per ordered pairing (7 200 games):

| animal | lion | gorilla | croc | hippo | rhino | eagle | panther | python | giraffe | mole |
|---|---|---|---|---|---|---|---|---|---|---|
| win % | 50 | 53 | 55 | 54 | 44 | 48 | 52 | 49 | 44 | 51 |
| mean KO % | 148 | 148 | 149 | 123 | 150 | 112 | 115 | 127 | 132 | 113 |
| self-destruct % | 9 | 20 | 16 | 10 | 16 | 0 | 4 | 26 | 23 | 18 |

| band (plan §9) | result |
|---|---|
| every animal 42-58 % | PASS (44-55) |
| worst matchup >= 30 % | **FAIL**: 18.3 % (giraffe vs mole); also < 30 %: giraffe vs panther 20, mole vs gorilla 21, rhino vs mole 25, mole vs croc 26, croc vs panther 28 |
| mean KO percent 80-150 | PASS 131.6 (side 44 % / top 14 % / bottom 42 % of KOs) |
| timeouts < 5 % | PASS 0.3 % |
| match 70-220 s | PASS 145 s |
| self-destructs < 15 % of stocks | PASS 14.1 % (73 % of the "self-destructs" are launches that die 4-5 s after the last hit, outside the 240-frame credit window; true self-destructs are ~3 %) |
| no move > 45 % of damage | **near**: gorilla.heavyS 48, mole.heavyS 51, rhino.heavyS 46 (was 58 / 47 / 49) |
| ladder (LEVELS=1,2,3,4 M=3, 5 400 games) | PASS: L4 beats L1 100 %, L2 99.4 %, L3 80.0 % |
| FFA N=30 (600 games), every animal 18-32 % | **FAIL**: lion 32.3, gorilla 24.8, croc 21.3, hippo 14.6, rhino 20.5, eagle 22.3, panther 17.5, python 37.1, giraffe 35.2, mole 26.5 |

### Known limits (honest)
* Matchup extremes are structural (rush beats zone, zone beats armor, armor beats rush; the small mole is hit by wide low attacks). Every fix that lifted one of the six pairs above 30 % pushed another animal's pair under it: e.g. extending the giraffe's neck-jab hitbox downward lifts giraffe-mole from 18 to 42 % but makes python-giraffe 73-27; python's Venom Lunge startup 19 -> 21 flips python-gorilla (25 -> 44) but sinks python to 37 % overall. The coordinate search had no move that cleared all six at once within the allowed levers; only 6 of 45 unordered pairs are outside 30-70 % (13 were outside before the pass).
* FFA is noisy (+-3 points per animal at N=30, and sensitive to small changes: lion swung 26-43 % between two patches) and conflicts with the duel balance: the weight changes that bring giraffe / python down and hippo / panther up in FFA broke the duels (panther 61 %, hippo 60 %). Duels were prioritised; FFA hippo (14.6), panther (17.5), python (37.1) and giraffe (35.2) stay out of band.
* `koCreditFrames` (240) was not changed: it is a plan §2.2 rule with its own sim test; widening it to 360 would turn the 14 % self-destruct share into ~4 %.

## 2026-10-05 — v1.6 changes (WP-B1: panther nerf, crocodile jump, mole burrow, ledge assist)

Owner: WP-B1. All sweeps below: L4 duels, both stages, `N=40 SEED=1` (7 200 games; the baseline was re-run on the v1.5.1 tree with the same settings and matches the "Final state" table above within noise), FFA `MODE=ffa N=30 SEED=1` (600 games), ladder `LEVELS=1,2,3,4 M=3` (5 400 games).

### What the user asked for, as implemented (numbers before -> after)

* **Panther (weaker, shorter lunges).** Damage per slot, victim total (lightN is the 3-hit chain total): lightN 9 -> 8 (last link 3 -> 2), lightS 6 -> 5, lightD 5 -> 4.5, lightU 6 -> 5, heavyN 10 -> 9, heavyS 15 -> 13, heavyD 12 -> 10.5 (ground and air), heavyU 7 -> 6: total 70 -> 61 (-13 %). Reach: Shadow Slash hitbox x 1.2 / w 1.2 -> 1.05 / 1.1 and lunge vx 5 -> 4.2 (total reach 2.22 -> 1.95 m, -12 %); Shadow Dash dash vx 15 -> 12.5 (2.5 -> 2.1 m) and front hitbox x 1.35 / w 1.5 -> 1.2 / 1.4 (dash + hitbox 4.6 -> 4.0 m, -13 %); Pounce Spin and Dive Claw reach untouched (they were not overextending). Frame data, invulnerability windows and the string timing are unchanged.
  *Budget exception (documented in `moveBudget.test.ts`):* nearly every panther slot already sat on the floor of its plan §3 damage band, so the damage floor is relaxed to 66 % **for the panther only**; a dedicated test checks that the panther really lost 8-20 % of its slot damage and that no slot got stronger, so the exception cannot hide a buff. The static power-index band is +-20 % (instead of +-15 %) for panther and mole for the same reason.
* **Crocodile (taller jump).** `jumpVel` 12.5 -> 17.6777 (= 12.5 x sqrt 2): apex = v^2 / (2 g gravityMult) goes 1.79 -> 3.58 m analytically, exactly x2.0. Measured in the sim (`tests/brawl/sim.crocJump.test.ts`, discrete integration): full ground jump 1.68 -> 3.43 m (x2.04), ground jump + air jump 3.10 -> 4.85 m. The air jump (11.5) is unchanged: the crocodile now reaches the Broken Colosseum side platforms (4.2 m) and the Sky Aqueduct small platforms (4.6 m) with ground jump + air jump (it did not before, nor with the ground jump alone), and its ledge jump (full `jumpVel`) climbs twice as high. `moveBudget` stats tolerance: `PLAN.crocodile.jumpVel` is now 12.5 x sqrt 2 (documented exception; every other stat keeps the +-15 % rule).
* **Mole (stronger, with a real tool).** Damage +1 on most hits (victim totals, v1.5 -> v1.6): lightN chain 12 -> 13 (last link 4 -> 5), lightS 8 -> 9, lightD 7 -> 8, lightU 8 -> 9, heavyN 13 -> 14 (final spin 7 -> 8), heavyU 10 -> 11 (finisher 4 -> 5), air Drill Down 12 -> 13: the six non-heavyD slots total 58 -> 64 (+10 %). `heavyS` (Tunnel Lunge, 14) stays: it is already the mole's dominant move (45 % of its damage). The **ground heavyD is now "Burrow Strike"** (archetype `burrow`, `anim.look` "Digs under the floor, tunnels a short way, and erupts upward under the target"): startup 24 (f0-5 dig / sink, f6-23 underground), active 4, recovery 20 (total 48); `burrow` and `invuln` f6-24; `motion` f6-24 vx 11 `set` + `stopAtEdge` (3.3 m); one eruption circle at (0.5, 0.7) r 0.95 active f24-28: damage 12, baseKb 11, kbGrowth 16, angle 88 (straight up), hitstunScale 1.1, no `bury`. Two numbers differ from the architect's sketch because the plan §3 heavyD band forces them: recovery 16 -> 20 (band 20-32) and damage 9 -> 12 (band 12-18); only the startup band was widened (to 24, for this one move, in `moveBudget`). The aerial form is still the drill-down (startup 13 / active 4 / recovery 25, no burrow window, no invulnerability, no motion). Data-level kill percent of the burrow: 161 % (the mole's best kill stays Tunnel Lunge, 121 %).
* **Ledge auto-grab assist (all animals).** New `PHYS.ledgeAssist*`: `Out` 2.0 m outward from the platform end, `Down` 2.4 m below the corner height, `Up` 0.3 m above it, `MinVx` 0.5 m/s, `RegrabCd` 75 frames. An actionable airborne fighter (same state machine as the old grab: free fall / rise only, so never while attacking, in hitstun, dodging or in a jump squat), not holding Down, `ledgeRegrab` and `assistCd` elapsed, ledge free, whose hand point is in the zone **and** that moves (> 0.5 m/s) or holds the stick (> `turnThreshold`) toward the stage, grabs automatically, also while still RISING (jumping up from underneath), and snaps into the normal hang pose. The original box (1.1 out / 1.3 down / 0.5 up, vy <= 0.5) is untouched and still works without the toward condition. Anti-stall unchanged (invulnerability decay per grab inside 4 s, 180 f max hang, 30 f regrab cooldown) plus one new rule: after releasing a ledge the *assist* cannot re-grab for 75 f (new saved fighter field `assistCd`, decremented with the other cooldowns, reset on respawn).

### Simulation semantics (all deterministic, rollback-exact)

* `underground` is **derived** (`Fighter.isUnderground()`: ground move body with `burrow`, `moveFrame` in the window) so it needs no extra saved state; `toState` publishes it. `isInvulnerable` includes it: hits skip the fighter exactly like dodge invulnerability (no hit event, no hitlag, no armor interaction, no stale push), other hitboxes pass through it. Burrow windows are ground-form only (the sim ignores `burrow` on air forms; the data clears `motion` / `invuln` / `burrow` on the Drill Down).
* `stopAtEdge` (per `motion` window): while the window runs and the fighter is grounded, each frame's planned step is clamped to the CURRENT span of the platform it stands on (moving platforms included; the platform's own displacement is carried first), the velocity becomes 0 at the end and the final position is clamped again, so the feet centre never leaves [x0, x1]. When the burrow window ends the mole surfaces standing still (vx = 0): without that, the 0.8 ground friction would slide it ~0.7 m past the end of the tunnel, i.e. possibly off the ledge.
* New saved field: `assistCd` only (appended to `Fighter.sync`, so `saveState` / `loadState` / `checksum` cover it; `determinism.state.test` enforces that). Golden checksums regenerated (comment in the test): the state layout changed (every checksum differs from frame 180 on) and the croc jump, the ledge assist and the tuned stats change the scripted matches.
* Bots: `moveInfo` knows `burrow` / `stopsAtEdge` (travel stops dead at the surfacing point), `probeHit(..., room)` clips a burrow to the platform end (the planner passes the room in front of the mole), `moveEnd` clamps `stopAtEdge` travel to the platform (so `endUnsafe` does not wrongly forbid or allow it), and a bot treats an underground opponent as invulnerable until `burrow.to`. `profiles.ts` unchanged (the mole keeps its `heavyD: 1.1` bias; its aerial `heavyD` is the drill-down). Tests: bots never leave the platform inside a ground Burrow Strike (all levels, both stages) and do use it.

### Balance (L4 duels, N=40, SEED=1)

First sweep after ONLY the requested changes (before any compensation): lion 44.7, gorilla 53.8, croc 60.6, hippo 62.7, rhino 48.8, eagle 55.1, **panther 21.5**, python 49.3, giraffe 43.1, mole 60.7; mean KO 136.7 %, SD 11.6 %. The panther collapse is NOT only its nerf: the same panther with both nerfs reverted scored 36 % in the new environment (52 % on the v1.5.1 tree): the ledge assist (+13 % ledge grabs) rescues poor recoverers (hippo / croc / mole up) and blunts the edge-guard kills the light animals live on (lion, giraffe, panther, python down). The requested numbers were kept; the OTHER numbers of the affected animals were re-centred:

| animal | change (not requested) | why |
|---|---|---|
| panther | weight 78 -> 84, airSpeed 7.7 -> 8.0 (plan 7.0 +15 % cap), airAccel 35.2 -> 44 | survive + disengage after the damage / reach cut; the assassin keeps low weight (84, plan 90) and gains air mobility |
| lion | weight 98 -> 104 (plan 100) | lost edge-guard kills to the assist (41.6 %) |
| giraffe | weight 95 -> 100 (plan 98) | same (40.7 %) |
| mole | weight 82 -> 79 | burrow + damage made it 58-61 % |
| crocodile | weight 132 -> 129 | taller jump made it 58-61 % |
| hippo | weight 122 -> 119 (plan -15 % floor), walk 3.5 -> 3.3, run 6.9 -> 6.5 | the assist helps the worst recovery most (60-63 %) |

Final (same settings), v1.5.1 tree -> v1.6:

| animal | win % | mean KO % | self-destruct % |
|---|---|---|---|
| lion | 49.7 -> 50.1 | 148.5 -> 157.9 | 9.5 -> 9.0 |
| gorilla | 53.0 -> 52.2 | 147.9 -> 154.0 | 19.9 -> 14.8 |
| crocodile | 54.8 -> 52.1 | 149.2 -> 149.2 | 15.3 -> 16.9 |
| hippo | 53.8 -> 56.8 | 122.7 -> 131.9 | 10.0 -> 7.0 |
| rhino | 43.2 -> 44.0 | 149.6 -> 159.6 | 16.0 -> 13.0 |
| eagle | 49.4 -> 50.1 | 111.5 -> 112.0 | 0.2 -> 0.2 |
| panther | 52.4 -> 51.9 | 115.2 -> 129.4 | 4.0 -> 4.7 |
| python | 48.1 -> 45.7 | 126.2 -> 133.0 | 26.6 -> 20.5 |
| giraffe | 45.2 -> 46.5 | 131.8 -> 142.3 | 22.9 -> 20.2 |
| mole | 50.5 -> 50.6 | 113.5 -> 109.5 | 17.7 -> 11.9 |

| band (plan §9) | v1.5.1 | v1.6 |
|---|---|---|
| every animal 42-58 % | PASS (43-55) | **PASS (44.0-56.8)** |
| worst matchup >= 30 % | FAIL 19.4 (giraffe vs mole) | FAIL **9.4 (giraffe vs panther, 91 % the other way)**; also < 30: croc vs panther 29, gorilla vs python 25, eagle vs hippo 24, panther vs eagle 26, python vs hippo 23, python vs eagle 21, giraffe vs mole 24, mole vs gorilla 24 (v1.5.1: 6 pairs, now 9) |
| mean KO percent 80-150 | PASS 131.6 | PASS **137.9** |
| timeouts < 5 % | 0.3 % | 0.4 % |
| match 70-220 s | 145 s | 150 s |
| self-destructs < 15 % of stocks | 14.2 % | **11.9 %** |
| ladder (LEVELS=1,2,3,4 M=3) | L4 beats L1 100 %, L2 99.4 %, L3 80.0 % | **PASS** 100 %, 99.6 %, 82.4 % |
| FFA N=30, every animal 18-32 % | FAIL (hippo 14.6, panther 17.5, python 37.1, giraffe 35.2, lion 32.3) | FAIL: lion 41.2, gorilla 20.1, croc 27.6, hippo 16.3, rhino 19.4, **eagle 12.6**, panther 20.3, python 33.2, giraffe 33.5, mole 28.6 |

Ledge assist effect (duels): blast sides L 7 643 / R 7 052 / top 4 557 / bottom 14 116 -> L 8 145 / R 7 597 / top 5 091 / bottom 12 727 (side share 44.0 % -> 46.9 %, bottom 42.3 % -> 37.9 %), self-destructs 14.2 % -> 11.9 %, ledge grabs per match 21.7 -> 24.6, mean KO percent +6 points (survivors live longer, so the per-animal KO percent of the heavy animals now sits at 150-160 %: the plan's 80-150 band is on the overall mean, which holds).

### Known limits (honest)

* The giraffe-panther pair got more extreme (the long-necked giraffe cannot hit the panther's low, fast body and the panther's air control is now its strongest tool); every tested panther compensation (weight 84-94, air control) left that pair at 85-93 % because it is structural (see the 2026-10-03 "Known limits"). The panther gets its identity-preserving compensation from air control rather than weight, which keeps it light.
* The eagle collapses in FFA (22.3 % -> 12.6 %) while staying at 50 % in duels: the assist helps everybody except the animal whose edge was its recovery; weight +6 fixed FFA (26.5 %) but made it a 64 % duel animal. Duels were prioritised again (FFA is +-3 points noisy at N=30; hippo, python, giraffe and lion stay out of the FFA band as they did before).
* The balance script reports Burrow Strike inside `heavyD`'s usage (ground and air form are one slot): mole.heavyD is 11 % of the mole's damage, 10 uses per game; `mole.heavyS` is still the dominant move (45 %).
* Pose / view layer (WP-B2): `underground` is published in the snapshot but the rig is not hidden yet; no pose or view test fails on the new data.

## 2026-10-05 — v1.6 dynamic maps (WP-M2: bots + balance on Clockwork Heights and Crumbling Amphitheatre)

Owner: WP-M2. Binding design: `docs/CL-MAPS-PLAN.md`. No stage data, sim rule, config number or golden checksum was changed (`breakable.hits` stayed 6 / 4 / 4: the bots alone reach the final-form targets), so no golden regeneration. Everything below is in `src/brawl/ai/**`, `scripts/brawl-balance.ts` and `tests/brawl/bot.dynamic.test.ts`.

### What was wrong (WP-M1 smoke, L3, 16 FFA + 30 duels per stage) and what the bots do now

`StageInfo.sync` only copied x0 / x1 / y, so a bot stood on, aimed at and recovered to platforms that no longer existed (or did not exist yet), walked into pits, planned recoveries to covered ledges and to the START position of the drifting core, and stood still for up to 1 527 frames.

* **Dynamic stage knowledge, every frame (`ai/stageInfo.ts`).** `sync(platforms, frame)` copies position, `active`, `hp / maxHp`; the velocity of drifting platforms comes from consecutive frames; `centerX` / `floorY` from the ACTIVE solids; ledges keep stable indices but carry the CURRENT corner and an `open` flag computed with the sim's own rule (platform active and the corner not covered by another active platform at the same height, `PHYS.ledgeCover*`). `platformBelow / overSolid / nearestLedge` only see active platforms and open ledges. `runSpan` / `rectAt` / `prepareHorizon` use the shared `platformAt` (the stages are pure functions of the frame) for look-ahead.
* **Recovery.** `kinematics.simRecovery` skips inactive platforms and closed ledges and, on stages with drifting platforms, evaluates every simulated frame against where the platforms WILL be (`setHorizon(f)`); ledge / landing targets are aimed at the lead position of a moving corner. The respawn drop picks the nearest existing platform (the crown, an arch, a floor). `flight` / `moveEnd` ignore dead platforms. Seams between touching tiles are one floor (`edgeBlocked` / `runSpan`): a pit or a vanished platform is a real edge, a tile seam is not.
* **Platform graph (dynamic stages only).** Walkable runs (touching platforms at one height) are the nodes; an edge (jump up / drop through a soft floor / walk off the end) exists only if a forward simulation of THIS animal's physics (`simRecovery`, with look-ahead) really lands on the target run; breadth-first search up to 3 hops to the floor the opponent stands on (or the reachable floor nearest to it). The bot walks to the launch point, commits to the walk-off (no back-and-forth around the edge) and steers / spends its air jump like the verified plan. A level-3/4 bot lets the opponent come across a gap first (the stall breaker `pressure` ends the standoff); jumps UP to another tier are not delayed. This replaced `navigateTiers` / `tryCross` on the two new stages only.
* **Breakables (level 2+).** `bestAttack` knows which breakable pieces a move would count a hit on (`probeRect` on the move's hitboxes, same pad as the sim): hitting the floor under our own feet when it is one hit from breaking is (nearly) forbidden (-30), chipping a floor two hits from breaking is discouraged (level 3+), breaking the piece under a grounded opponent is a bonus; aerials count every piece just below. In the downtime (opponent > 4.6 m away, not attacking) a bot with appetite (L2 0.4, L3 0.75, L4 0.85, times 0.75-1.25, drawn once) picks a piece top-down (crown, arches, then tiles): soft pieces by standing on them (graph hop) or, when they cannot be reached, by jumping under them and hitting them from below with an aerial (air jump spent at the top); tiles from the floor it stands on with the cheapest low move (`lightD`-type; every animal has at least one) from a stance that is not the piece about to break. The last piece (or a long standoff) is worth breaking even under our feet (the final form's platforms catch the fall). Level 3+: a bot standing on a solid piece two hits from breaking walks to a sturdier piece of the same floor while the opponent is within 5 m (committed, 5 s cooldown). Level 1 never smashes.
* **Stalemates and stalls.** (1) A bot that has stood still for 100-240 frames raises `pressure` (the old exchange timer is kept untouched), edge-guarding gives up after 180 frames, and after 200 still frames it walks to the far end of its floor. (2) On a breakable arena where nothing has happened for 35 s (not ahead: 35 s, ahead by 2+ stocks 45 s, narrow lead 60 s; at least 2 stocks left) a level-3/4 bot whose opponent is on another floor walks off its floor towards the middle and does not recover ("stalemate dive"): the respawn drops it onto the crown, which is exactly the piece that is unreachable from the floors once the arches are gone. Without it 13-29 % of Amphitheatre duels ended on the clock with everything but the crown broken.
* **The original stages are untouched for levels 1 and 2** (the recorded intent streams of 4 matches at L2 and 2 at L1 are asserted equal in `bot.dynamic.test.ts`), and stage-specific code is guarded by `StageInfo.dyn`. Levels 3 / 4 on the original stages only differ where the new stall breaker fires (see the numbers below: unchanged within noise).

### Harness (`scripts/brawl-balance.ts`)

`STAGE=` takes one id, a comma list, `both` (the two original stages, default), `new`, or `all`; with more than one stage a per-stage breakdown and per-stage verdicts are printed (bands: original 42-58 % / SD < 15 %, new 40-60 % / SD < 20 % / ledge grabs >= 12). Seeds of the original stages are unchanged (stage index 0 / 1). New reporting: counted platform hits, pieces broken per match and mean break time, FINAL FORM arrival rate and time distribution (min / p25 / median / p75 / max, early arrivals < 25 s), the longest stand-still of a grounded, idle fighter (no attack / jump / hit, moves < 0.5 m on its platform, at least one foe still fighting; `STILLCTX=1` prints every stall of 300 frames or more), and three self-destruct figures (below).

**Self-destruct definitions.** The sim credits a KO to the last attacker only within 240 frames, so a launch whose flight lasts longer than 4 s counts as a "self-destruct". On the narrow Clockwork core this is almost the whole column: 18 of 19 sampled "self-destructs" were launches whose last hit was 200-300 frames earlier (the fighter was 20+ m out, falling). The harness therefore prints (a) the sim definition (what the bands use), (b) "real": no hitstun in the 7 s before the KO, and (c) the deliberate stalemate dives.

### Results (L4 duels, N = 40 per ordered pairing, `SEED=1`, 3 stocks, 14 400 games)

| stage | win % range (every animal) | mean KO % | SD % (sim def.) | real SD % | timeouts | match | ledge grabs / match | stand-still >= 300 f |
|---|---|---|---|---|---|---|---|---|
| Broken Colosseum | 44.6 - 61.0 | 137.9 | 12.5 | 0.6 | 0.0 % | 127 s | 12.8 | 0 / 3600 (longest 211) |
| Sky Aqueduct | 42.9 - 55.6 | 136.9 | 11.0 | 2.4 | 0.5 % | 172 s | 35.9 | 0 / 3600 (longest 214) |
| Clockwork Heights | 35.4 - 65.8 | 136.3 | 26.6 | 1.0 | 0.1 % | 144 s | 11.4 | 0 / 3600 (longest 213) |
| Crumbling Amphitheatre | 37.5 - 68.8 | 121.2 | 23.5 | 14.5 (5.8 dives) | 2.8 % | 180 s | 47.6 | 0 / 3600 (longest 227) |

WP-M1 smoke baselines for comparison (L3, small samples): Clockwork SD 38 %, ledge grabs 5.3; Amphitheatre SD 44 % FFA / 23 % duels, ledge grabs 12.4, final form 0-1 of 40, stand-stills 400-1 527 frames. My first sweep before this work (L4, N = 4): Clockwork SD 47.5 %, ledge grabs 5.5; Amphitheatre SD 40.3 %, final form 0 %, a 396-frame stall.

Per animal, win % (L4 duels, N = 40; bold = outside the stage's band):

| animal | Colosseum | Aqueduct | Clockwork | Amphitheatre |
|---|---|---|---|---|
| lion | 47.2 | 52.6 | 54.2 | 56.1 |
| gorilla | **58.2** | 46.3 | 44.4 | 40.8 |
| crocodile | 49.2 | 55.1 | 46.8 | **68.8** |
| hippo | **61.0** | 53.3 | **35.4** | 46.0 |
| rhino | 44.6 | 48.1 | 58.2 | **37.5** |
| eagle | 46.0 | 51.3 | 52.2 | **37.9** |
| panther | 53.8 | 48.8 | 50.0 | 47.2 |
| python | 46.8 | 42.9 | 53.3 | **60.6** |
| giraffe | 46.3 | 46.0 | **39.6** | 58.1 |
| mole | 47.1 | 55.6 | **65.8** | 46.8 |

Original stages: the two-stage average per animal is lion 49.9, gorilla 52.3, crocodile 52.2, hippo 57.2, rhino 46.4, eagle 48.7, panther 51.3, python 44.9, giraffe 46.2, mole 51.4, against the v1.6 table above (50.1 / 52.2 / 52.1 / 56.8 / 44.0 / 50.1 / 51.9 / 45.7 / 46.5 / 50.6): no regression; SD 11.8 % (11.9), mean KO 137.4 (137.9), timeouts 0.3 % (0.4), match 150 s (150). The two stages split the hippo's 56.8 as 61.0 / 53.3 and the gorilla's 52.2 as 58.2 / 46.3; the per-stage 42-58 band is checked here for the first time (the v1.6 band was on the two-stage mean).

**Ladder (`LEVELS=1,2,3,4 M=3`, 2 700 games per stage): PASS on all four stages.** L4 beats L1: 100 / 100 / 100 / 100 %; L4 beats L2: 99.6 / 99.6 / 100 / 87.4 %; L4 beats L3: 81.5 / 83.3 / 82.2 / 75.2 % (Colosseum / Aqueduct / Clockwork / Amphitheatre; targets 90 / 75 / 55). Timeouts in the ladder: 0.0 / 0.7 / 0.0 / 4.7 %.

**FFA (`MODE=ffa N=30`, 300 games per stage, L4):** no stall and no stand-still on any stage (longest 208-213 frames), timeouts 0.0-0.3 %, mean KO 134-141 %, match 131 / 167 / 145 / 188 s. FFA win rates are out of the 18-32 % band on every stage (as on the original ones before, see the v1.6 table above): Clockwork hippo 4.0, crocodile 12.7, lion 42.4, giraffe 38.7; Amphitheatre rhino 10.5, hippo 14.8, python 39.8, giraffe 42.4. The Amphitheatre's final form arrives in 299 / 300 FFA matches (median 52 s, min 19.9 s, 6 matches before 25 s: four fighters break pieces about twice as fast).

### Crumbling Amphitheatre final form (the tuning target)

| bots | arrival | min | p25 | median | p75 | max | before 25 s |
|---|---|---|---|---|---|---|---|
| L4 duels, N = 40 (3 600) | 89.1 % (3 207) | 25.0 s | 64.1 s | **84.0 s** | 106.6 s | 282.5 s | 0 |
| L3 duels, N = 20 (1 800) | 82.2 % (1 479) | 23.7 s | 70.8 s | **89.2 s** | 112.3 s | 294.2 s | 2 |

Targets: arrival >= 60 %, median 60-130 s, not before 25 s: met, except 2 of 1 479 L3 matches (0.14 %) where the final form came at 23.7-24.9 s. A hard 25 s floor would need `breakable.hits` + 1 on one piece (data fingerprint, stage tests and goldens), which two outliers do not justify. Every piece breaks in 90-100 % of matches (crown 1.0, arches 1.0, tiles 0.9 per match): 29 counted hits and 5.7 pieces per match. What it took (L4, N = 4-10 iteration sweeps): bots that know nothing of the final form 0 %; seam-aware walking and the platform graph 6 %; smashing 26 %; top-down order and jabbing soft pieces from below 64 %; the stalemate dive and the last-piece rule 76-89 %. Timeouts 92.6 % -> 2.8 % on the way.

### Still out of band (honest list)

* **Per-animal win rate on the new stages (target 40-60 %)**: Clockwork hippo 35.4 (cannot reach the satellites, the slowest runner), giraffe 39.6, mole 65.8 (the burrow stays on its platform and is untouchable on a platform that carries it); Amphitheatre crocodile 68.8 (the doubled jump reaches the arches / crown that smash the arena and give it the high ground), python 60.6, rhino 37.5, eagle 37.9. These are structural (animal x map); the allowed levers (`breakable.hits`, tiny layout nudges) do not address them and the layouts are not degenerate (every animal reaches something on every frame). Candidates for a later pass: crocodile jump / rhino weight on the Amphitheatre, hippo run speed / giraffe reach on Clockwork.
* **Self-destructs by the sim definition (< 20 %)**: Clockwork 26.6 %, Amphitheatre 23.5 %. Real figures: Clockwork 1.0 % (the rest are 4-5 s launch flights across a 13 m-wide core that end outside the 240-frame credit window; `koCreditFrames` is a rule and was not tuned); Amphitheatre 14.5 % real, of which 5.8 points are the deliberate stalemate dives and 8.7 points falls into the pits (the heavy animals: rhino 44 %, gorilla 32 % by the sim definition). Without the dives the Amphitheatre is 17.7 % by the sim definition.
* **Clockwork ledge grabs 11.4 per match (target >= 12)**: up from 5.3; the core has only two ledge corners; a +1.2 m cost on landing targets did not move it and was reverted.
* **Amphitheatre**: timeouts 2.8 % (< 5 % met) but up to 4.7 % in the ladder; mean KO 121 % and match 180 s are in band.

### Tests (`tests/brawl/bot.dynamic.test.ts`, 27 tests)

StageInfo sync (inactive final-form platforms, broken pieces, hp, ledge exposure rebuilt per frame, the drifting core: corner, velocity estimate, `rectAt` equals the sim's own position, centre follows); recovery from below the pit edge to an open ledge / existing floor (>= 80 % at L3 and L4); closed ledges are never targets; determinism of the dynamic-stage bots; Clockwork self-destruct share; no stand-still >= 300 frames on all four stages (L3 and L4 seeded matches); a level-3/4 bot never breaks the floor it stands on; it uses downtime to hit pieces (>= 70 % of 20 trials); level 1 never smashes; a standoff over the unreachable crown ends (stalemate dive, then final form, 3 of 4 pairs); the final form arrives in >= 66 % of sampled L3/L4 duels and never before 25 s; legal intents at every level through breaks, the final form and respawns; intent-stream hashes of L1 / L2 on the original stages equal the pre-v1.6 bot.

## 2026-10-05 — v1.7: final-form span (Crumbling Amphitheatre)

Owner: WP-C1. One data change: a soft `finalOnly` platform `span` (x −6 … 6, y 3.0, thickness 0.5) abutting `sunL` / `sunR`, so sunL + span + sunR is one walkable run from x −11 to 11 in the air. No breakable, hit count, bot or sim-rule change. Goldens regenerated for the two Amphitheatre scenarios only (the other five are unchanged).

Sweeps (`STAGE=crumblingAmphitheatre N=20 WORKERS=8`, `SEED=1`, 1 800 games each; the "before" columns are the same harness on a clean checkout of v1.6.0):

| | L4 before | L4 v1.7 | L3 before | L3 v1.7 |
|---|---|---|---|---|
| final form arrives | 89.8 % (1 616) | 89.8 % (1 616) | 82.2 % (1 479) | 82.2 % (1 479) |
| median / min arrival | 84.9 s / 26.0 s | 84.9 s / 26.0 s | 89.2 s / 23.7 s | 89.2 s / 23.7 s |
| before 25 s | 0 | 0 | 2 | 2 (same two matches as before) |
| timeouts | 2.7 % | 0.9 % | 1.8 % | 1.6 % |
| self-destruct (sim def.) | 22.9 % | 15.2 % | 27.5 % | 19.8 % |
| self-destruct "real" (no hitstun in 7 s) / dives | 14.4 % / 5.9 % | 7.8 % / 5.8 % | 19.0 % / 8.8 % | 12.7 % / 8.8 % |
| match length / mean KO % | 181 s / 121.9 | 155 s / 131.1 | 164 s / 117.0 | 150 s / 126.4 |
| ledge grabs per match | 48.1 | 24.7 | 37.0 | 26.1 |
| longest stand-still | 227 f (0 matches >= 300) | 227 f (0) | 225 f (0) | 225 f (0) |

The arrival numbers are identical by construction (the span exists only after the flip, so the games are the same up to that frame); what changed is the second half: fighters no longer have to cross the pits by hopping the pedestal, the final form is fought along the walkway, the clock runs out less often and there are fewer long falls into the pit. No crash, no NaN, no stall in 7 200 games. Per-animal win rates (N = 20 per pairing, ±2.6 % 1 sigma per animal): L4 now 40.6 - 56.9 % (before: gorilla 39.2, rhino 39.2, crocodile 67.8, python 62.2 out of band); L3 spread is similar to before but different: rhino 67.2 / giraffe 30.6 (before crocodile 66.1 / hippo 35.3 / giraffe 37.8) — worth a look in a later balance pass, not tuned here. The "worst matchup >= 30 %" band fails before and after (hippo vs giraffe 12.5 %).

What the crossing looks like in the REAL sim (`tests/brawl/sim.finalCrossing.test.ts`; every hop is stepped from a saved state with the animal's own jump physics): all ten animals get from floorL to floorR and back in two hops; nine of them hop floorL -> walkway -> floorR (jump up 3 m, walk, step off), hippo needs floorL -> pedestal -> walkway because its ground jump + air jump peak at 3.04 m (a 3.0 m platform is out of its direct reach; from the pedestal the rise is only 1.6 m). Before the span, python and mole needed three hops (floorL -> pedestal -> sunR -> floorR); the other eight could already cross floorL -> pedestal -> floorR (a 5.5 m gap), so the span's main gains are the continuous high lane and the shorter routes for python / mole.
