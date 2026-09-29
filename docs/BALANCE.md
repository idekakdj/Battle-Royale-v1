# Gladiator Kingdom — Balance Report (v1.1, WP-J)

Owner: WP-J (Gameplay & Balance). Spec: `docs/UPGRADE-PLAN-v1.1.md` §1.1 / §3. Binding data: `src/config/animals.ts`, `src/config/balance.ts`, `src/config/botProfiles.ts` (BLUEPRINT §8 table synced).

## 1. Method

- **Tool:** `npm run balance` (`scripts/balance-sweep.ts`). Runs N headless all-bot matches per difficulty (10 animals, one bot each, World + BotManager at 60 Hz, 300 s cap). Deterministic per seed (seed = 1000 × level + match index), so two runs with the same N differ only if a rule or number changed.
  - `N=60 LEVELS=3,4 npm run balance` — the acceptance run. `SEATS=fixed` reproduces the v1.0 method, `DUEL=1` prints a 1v1 round-robin matrix, `TRACE=1` prints the survivors of any timed-out match, `MAX_S` changes the cap.
- **Seat shuffle (new default).** In v1.0 animal *i* always spawned in seat *i*, so every match had the same neighbours (the giraffe always spawned between python and mole). The sweep now deals the 10 animals into the 10 seats with a seeded permutation per match. How big the seating bias is: with the final v1.1 numbers, fixed seating puts the giraffe at **0 % / avg place 9.1** at L4, while shuffled seating puts it at **13 % / 5.2**. Fixed-seat tables mostly measure where you stand, not how strong you are.
- **Columns:** `win%`, `place` (avg placement, 1 = winner, lower is better), `rdy/m` (times the ult bar filled per match), `ult/m` (ults cast per match), `held` (avg seconds a full bar went unused), `spc/m` (specials per match), `dmg/m` (HP actually removed, including bleed/grab ticks and thorns), `kill/m`, `life` (avg seconds survived), and the share of *hit-event* damage from basics, specials and ults. **Counting gap:** grab ults (croc Death Roll, python Embrace) and bleed deal damage through DoT ticks that don't emit `hit` events, so their share shows as 0 % in the basic/spec/ult columns. `dmg/m` does include them. The crocodile's "100 % basic" is only this gap.
- **Noise:** one match gives one winner out of ten, so a win% cell at N=60 has a standard error of about ±3.9 points at a true 10 % (95 % range ≈ 3–19 %). I tuned against N=240–300 runs (±1.8 points) and used N=60 only for the acceptance check. Both are reported below.

## 2. Root causes found

### Giraffe monopoly (v1.0: 55–57 % at L3/L4, 48 % at L2)
1. **Reach × arc × cleave.** A 4.0 m reach with a 140° arc sweeps about 19.5 m² per swing. The lion's 2.2 m / 120° sweeps about 5 m². In a 10-fighter melee that means ~4× the targets per swing, so the giraffe did ~2× everyone's damage (2 900/match against ~1 200).
2. **The AI rewards reach.** Long-reach bots hold spacing at 0.85 × range while everyone else walks into the cut. Add Thunder Kick's 6 m peel and the giraffe kited every melee animal. The 1v1 duel matrix had it at 74–82 %.
3. **It was tanky too.** It had 1 050 HP, the 5th-highest pool, on top of the longest reach.

### Timeouts and 150 s matches (bloodlust in 85–97 % of v1.0 L3/L4 matches)
These were AI bugs, not numbers. `TRACE=1` duels showed four stall patterns:
1. **Low-wall standoff.** Two bots on opposite sides of a fallen column slid along it forever. The obstacle feelers only bend the path locally, and Cubs never jump.
2. **Crate-pile pocket.** The gap between the (7, −7) crate pile and fallen column 2 is narrower than a rhino or hippo. A big body chasing around the column got pinned there.
3. **Retreat with nothing to flee from.** A wounded bot with no heal pad and no perceived enemy (a pillar blocking line of sight) picked "retreat" and stood idle. Two such bots at opposite walls stood there until the cap.
4. **Endless kite.** A wounded bot as fast as its pursuer kited for minutes. Bloodlust damping (×0.4 at 1.5×) never overcame the +15 % goal hysteresis.

### Panther / mole / python underperforming (v1.0: 0–7 %)
- **Veteran ult trigger bug.** L3 casts ults "after landing a finisher". A finisher means the target is at melee range, but the eagle, mole and panther ult gates start at 5–7 m. So L3 eagles, moles and panthers almost never cast (mole 0.02 ults/match).
- **Aimed-point rule.** FighterIntent has only a yaw, so Pounce, Silverback Leap, Death From Above and Sinkhole always landed at max range. A Sinkhole could only hit someone 6–14 m away, and the mole could never follow up on its own root.
- **Mole "+25 % vs rooted" never triggered.** It was checked only inside the Sinkhole's own AoE, before the root it applies.
- **Panther crit leak (bug, other direction).** `stealthCritPending` was never cleared when Night Prowl expired, so any later swing crit for +200.
- **Numbers.** The low-HP assassins (panther 750, eagle 700) died first in brawls. The mole's 1.7 m reach couldn't touch big bodies (hippo contact distance 1.7 m). The python lost value once the ult/AI fixes landed and was retuned from there.

### Rare ults (v1.0: ~0.35 per fighter per L3/L4 match)
Charge came only from landed basics (8/8/14). Most fighters died without ever filling the bar, and several scripts sat on a full bar for 30–55 s waiting for a perfect window.

## 3. Changes

### 3.1 Sim rules and bug fixes (`src/sim`)
| Change | Where | Test |
|---|---|---|
| **Comeback lever:** the victim gains 0.045 ult charge per point of incoming damage, measured before block, also on bleed/grab ticks | `CombatSystem.grantTakenCharge`, `World.applyBleedDamage`, `ULT.gainPerDamageTaken` | `tests/sim/v11-fixes.test.ts` |
| **Aimed-point snap:** Pounce, Leap, DFA and Sinkhole land on the nearest targetable foe within 1.5 m (+ its radius) of the aim ray and ≤ max range + 1 m, else at max range | `abilities2.aimPointDist`, `simTuning.AIM_SNAP_*` | ✓ (4 tests) |
| Ambush Lunge stops on contact with a foe (it used to plough 7 m through/around the target) | `abilities1.ambushLunge` | ✓ |
| Panther stealth crit applies only while stealthed; the flag clears on the first swing | `CombatSystem.resolveSwingHit` | ✓ |
| Mole +25 % vs rooted applies to all mole damage | `CombatSystem.dealDamage` | ✓ |

### 3.2 AI fixes and script improvements (`src/ai`, tunables in `AI_TUNING` / `BotProfile`)
| Change | Test |
|---|---|
| `Steering.lowWallDetour`: when the path to the target, pickup or remembered foe crosses a fallen column, steer to the shorter tip | `tests/ai/stalls.test.ts` |
| Unstick: travelling but moved < 0.6 m in 1 s → swing at a crate in reach (crates break), else sidestep and hop for 0.7 s | ✓ |
| Retreat is scored 0 with no heal pad and no known threat | ✓ |
| Retreat budget: 4 s of heal-less retreat, then 5 s of forced re-engage; no retreat at all from bloodlust ×1.75 | ✓ |
| Veteran ranged ults (eagle, mole, panther) fire on isolated, fleeing, rooted, helpless or ≤50 % HP targets in range; panther casts when healthy | `tests/ai/scripts.test.ts` |
| Ult patience: a bar held 6 s is cast at any in-range target (Apex still refuses 3+-enemy bad trades) | ✓ |
| Apex croc and python grab into a raised guard (grabs ignore block); Apex hippo Chomps into a raised guard (its 112 guard drain breaks most guards) | — |
| Veteran eagle runs a simplified hit-and-run (1.0 s hop-out after a full combo); Veteran panther flanks behind while stealthed | — |
| Gap gates retuned for the aim snap (Pounce 3–9 m, Leap 3–8.8 m, DFA 3–9.5 m, Sinkhole 2.5–12 m, Death Roll ≤4.9 m) | — |
| **Cub (L1) human fairness:** `swingPauseMult` 2.0 (waits 3 × its own swing time between presses, so relative DPS is intact), `ultHesitateS` 3 s, `specialRandomChance` 0.10 → 0.03 per 10 Hz decision tick. These are decision knobs, not stat cheats | `tests/ai/fairness.test.ts` |

### 3.3 Economy (`src/config/balance.ts`)
| Tunable | v1.0 | v1.1 |
|---|---|---|
| Charge per landed hit1 / hit2 / finisher | 8 / 8 / 14 | 12 / 12 / 20 |
| Charge per point of damage taken | — | 0.045 (~28 % of the landed-hit rate) |

Result: 1.05–1.10 ults per fighter per L3/L4 match (v1.0 0.34–0.36). Survivors cast about 1.3. Average bar-held time dropped from 7–55 s to 2–9 s. A full combo is still only 44 % of a bar, so ults are not spammable.

### 3.4 Per-animal numbers (old → new) and reasoning
| Animal | Changes | Why |
|---|---|---|
| **Lion** | none. Pounce now snaps onto the aimed foe | Held 7–10 % everywhere once the others moved. Snap Pounce made its gap-closer real without a number buff |
| **Gorilla** | HP 1100 → 1150; rate 1.20 → 1.25 (DPS 108 → 113) | Sat at 3–9 %. Bruiser with no reach, so it gets more staying power and tempo |
| **Crocodile** | HP 1150 → 1250; speed 5.2 → 5.6; combo 75/75/120 → 80/80/125; rate 1.10 → 1.20; arc 90° → 100°; block 72 → 75 %; guard 120 → 140; bleed 30 → 45; Ambush Lunge cd 7 → 6, follow-up +60 % → +100 %, stops on contact; Death Roll lunge 4 → 4.5 m, 260 → 300 dmg | Lowest damage in the roster (~780/match). Too slow to reach anyone, and at L4 80 % of its basics were blocked. Buffs lean on unblockable identity (bleed, grab) and the ambush bite |
| **Hippo** | HP 1300 → 1100; speed 4.8 → 5.4; combo 85/85/120 → 75/75/140; rate 1.00 → 1.05; arc 130° → 100°; block 75 → 85 %; guard 140 → 180; River Rush cd 8 → 6.5, dmg 80 → 95, knockback 4 → 2.5 m | Level-split problem: dominant in L1/L2 brawls (Cubs never block, so raw HP and cleave win), weak at L4 (slowest body, kited forever). Levers were picked by the level they affect. HP and hit1 (the only hit a Cub throws) moved into block, guard and the finisher (used at L3/L4). Shorter Rush knockback lets it follow up |
| **Rhino** | HP 1250 → 1200; Lockdown cd 9 → 8, dmg 100 → 90; Stampede 180 → 160 | Tended high at L2/L3 (15–25 %). Trimmed damage, kept the tank body |
| **Eagle** | HP 700 → 760; glide cd 5 → 6 s | Died first in brawls. At L4 its hit-and-run gave the best average placement, so glide uptime came down |
| **Panther** | HP 750 → 875; combo 60/60/80 → 62/62/85 (DPS 120 → 125); backstab ×1.25 → ×1.30; Shadow Dash 50 → 60 | Lowest survival in the roster. Plus the crit-leak fix (a hidden buff going away) and the new Veteran flank |
| **Python** | HP 850 → 880; range 3.2 → 3.0 | After the giraffe nerf it became the new reach bully at L4 (17–21 %). Still the 2nd-longest reach |
| **Giraffe** | HP 1050 → 930; speed 6.2 → 6.0; combo 85/85/110 → 80/80/110; rate 0.95 → 0.85 (DPS 89 → 77); range 4.0 → 3.4 m; arc 140° → 100°; Thunder Kick knockback 6 → 5 m | Still the longest reach (identity kept), but a slow, heavy, narrower neck swing. Less HP and less peel |
| **Mole** | HP 800 → 850; range 1.7 → 2.0 m; Burrow cd 9 → 8; +25 % vs rooted now works; Sinkhole snaps onto the aimed foe | Could not reach big bodies and almost never cast its ult. Still the shortest reach |

## 4. Before / after

**Before** = v1.0 code with this sweep (shuffled seats, N=60). The architect's §1.1 table used fixed seats at N=30. **After** = final v1.1 (shuffled seats, N=60 = the acceptance run). Cells are win % / avg placement.

| Animal | L1 before | L1 after | L2 before | L2 after | L3 before | L3 after | L4 before | L4 after |
|---|---|---|---|---|---|---|---|---|
| lion | 10 % / 4.41 | 8 % / 4.98 | 7 % / 4.95 | 15 % / 4.35 | 7 % / 5.22 | 7 % / 6.15 | 7 % / 5.70 | 7 % / 5.85 |
| gorilla | 7 % / 4.55 | 7 % / 4.85 | 2 % / 6.07 | 7 % / 5.18 | 3 % / 6.24 | 7 % / 5.53 | 3 % / 5.43 | 10 % / 5.25 |
| crocodile | 14 % / 4.40 | 23 % / 4.17 | 2 % / 5.83 | 15 % / 4.72 | 3 % / 6.05 | 7 % / 4.55 | 2 % / 5.87 | 13 % / 4.83 |
| hippo | 28 % / 3.10 | 15 % / 3.60 | 23 % / 3.37 | 17 % / 4.83 | 7 % / 4.71 | 15 % / 5.33 | 5 % / 5.53 | 5 % / 6.05 |
| rhino | 14 % / 3.86 | 18 % / 4.22 | 10 % / 5.00 | 25 % / 3.80 | 7 % / 5.10 | 17 % / 5.05 | 12 % / 5.05 | 8 % / 5.15 |
| eagle | 0 % / 8.33 | 2 % / 7.52 | 2 % / 6.85 | 2 % / 6.35 | 3 % / 6.29 | 7 % / 6.22 | 7 % / 5.88 | 10 % / 4.90 |
| panther | 0 % / 7.09 | 15 % / 4.93 | 5 % / 6.45 | 8 % / 6.30 | 3 % / 5.98 | 5 % / 5.60 | 3 % / 6.15 | 10 % / 6.17 |
| python | 0 % / 7.53 | 3 % / 7.20 | 2 % / 6.73 | 3 % / 6.82 | 7 % / 6.31 | 13 % / 5.52 | 5 % / 5.93 | 13 % / 5.68 |
| giraffe | 28 % / 3.98 | 7 % / 6.02 | **48 % / 2.27** | 3 % / 5.73 | **57 % / 2.71** | 13 % / 5.38 | **55 % / 3.03** | 10 % / 5.40 |
| mole | 0 % / 7.74 | 2 % / 7.52 | 0 % / 7.48 | 3 % / 6.92 | 2 % / 6.38 | 10 % / 5.67 | 2 % / 6.42 | 13 % / 5.72 |
| **timeouts** | 2 | **0** | 0 | 0 | 2 | **0** | 0 | 0 |
| **avg match** | 40 s | 52 s | 60 s | 48 s | 160 s | 93 s | 148 s | 99 s |
| **bloodlust reached** | 0 % | 0 % | 10 % | 0 % | 93 % | 18 % | 85 % | 18 % |
| **ults / fighter / match** | 0.25 | 0.70 | 0.37 | 1.09 | 0.34 | 1.05 | 0.36 | 1.10 |
| **specials / fighter / match** | 2.2 | 2.1 | 2.6 | 3.0 | 3.2 | 4.2 | 3.4 | 4.6 |

**Acceptance (§1.1):**
- L3 and L4: every animal is between 4 % and 18 % at N=60 (L3 5–17 %, L4 5–13 %).
- L1 top animal 23 %, L2 top animal 25 % (target ≤ ~30 %).
- 0 timeouts at all four levels.
- L1 average match 52 s (target 35–60 s).

**Low-noise confirmation (N=300, shuffled seats), win % / avg placement:**

| Animal | L3 | L4 |
|---|---|---|
| lion | 10 % / 5.77 | 10 % / 5.61 |
| gorilla | 12 % / 5.34 | 7 % / 5.43 |
| crocodile | 9 % / 5.12 | 11 % / 5.09 |
| hippo | 12 % / 5.15 | 5 % / 6.10 |
| rhino | 12 % / 5.22 | 10 % / 5.44 |
| eagle | 7 % / 5.49 | 11 % / 4.80 |
| panther | 7 % / 5.72 | 11 % / 5.67 |
| python | 10 % / 6.05 | 13 % / 5.67 |
| giraffe | 9 % / 5.70 | 13 % / 5.20 |
| mole | 12 % / 5.44 | 9 % / 5.98 |

L1 / L2 at N=240: top animal 19–20 %, bottom (python / mole) 1–3 %, average match 50–52 s, 0 timeouts.

## 5. Human fairness (L1 / L2)
- `tests/ai/fairness.test.ts`: every animal as an L1 Cub attacks an idle, full-HP Eagle (760 HP, the lowest in the roster) from 3 m, pickups off, two seeds each. Fastest time from first damage to kill is **16.1 s** (panther). Typical is 18–27 s, and the slow giraffe takes up to 35 s. with v1.0 Cub behaviour the fastest kill was ~10 s.
- The Cub gets there without touching stats: it waits 3× its own swing time between presses, so every animal keeps its relative DPS. It also hesitates 3 s before noticing a full ult bar and uses specials less eagerly.
- L2 (Fighter) profile params are unchanged. L2 matches got shorter (60 → 48 s) because stalls are gone and ults are more common.

## 6. Known remaining imbalances and notes
- **Level split, true rates at N=300.** Hippo is 12 % at L3 but 5 % at L4. It is still the slowest-but-one body, and Apex bots kite it. Gorilla is 12 % at L3 and 7 % at L4. Every animal's true rate sits inside 5–13 %, but a single N=60 table can put one cell 1–2 wins outside 4–18 % purely from sampling (§1).
- **L1 / L2 brawls.** Low-HP animals (python, eagle, mole) win 1–3 % against Cubs and Fighters, because nobody blocks or retreats and HP decides. Humans playing them are unaffected: this measures bot-vs-bot brawls only.
- **Outside WP-J's files:** the real match (`src/match/MatchController.ts`) seats bots in fixed roster order around the player, so bots always have the same neighbours. I recommend a seeded shuffle of the bot seats there, since the sweep shows fixed seating swings an animal by more than 10 points. `src/render/animals/Python.ts` has a comment still saying "3.2 m reach" (cosmetic).
- **Damage counting:** see §1 on the grab/bleed hit-event gap.
