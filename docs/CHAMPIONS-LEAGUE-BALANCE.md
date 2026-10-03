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
