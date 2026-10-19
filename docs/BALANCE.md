# Gladiator Kingdom — Balance Report (v1.3 ultimates on top of v1.2 WP-N and v1.1 WP-J)

## v1.10 heights (WP-H3): bots on the towers, fall damage, two sea serpents

Plan: `docs/OCEAN-HEIGHTS-PLAN.md` (layout = `OCEAN_ARENA` in `src/config/arenas.ts`: three 6.5 m towers at 72 / 180 / 288 deg, reached by 0.39-grade ramps; `hazards.fallDamage` = a landing after a drop of >= 3.4 m costs 50 true HP; two serpent lanes, `snapshot.serpent` = LOW, `snapshot.serpentHigh` = HIGH, band split at 4.5 m). Bot code: `src/ai/NavGrid.ts`, `Navigator.ts`, `SerpentSense.ts`, the new `src/ai/FallGuard.ts`, hooks in `BotBrain.ts` / `BotManager.ts`. **No animal stat, no arena datum, no sim rule and no serpent number was touched.** Everything new is gated on arena data (`hazards.fallDamage`, `hazards.serpentSplitY`, `heightfield`), so the colosseum and the jungle stay byte-identical (proof below).

### What changed

| Area | Change | Why |
|---|---|---|
| **Navigation on the tower tier** | The grid already planned ramps; what was missing was the new tier's geometry. `NavGrid.rimD`: for every cell high enough to fall 3.0 m (`minDrop - 0.4`), the distance to the nearest ledge off which a RUNNING body lands that far down; paths pay for cells within 2 m of it (they keep to the middle of a 3.8 m tower ramp), string-pulled shortcuts keep 0.9 m off it (`lineWalk(..., rimMin)`), and a bot that already stands at an edge may always walk away from it. A route exists for every body radius 0.5-1.2 and every berth (0 / 0.15 / 0.3) from the seabed to every tower pad (`tests/ai/towers.test.ts`: 5 radii x 3 berths x 3 starts x 3 pads). | A 3.8 m ramp is 1.6 m narrower than the v1.9 ones and the tower top is a disc of radius 3.6: a path that cuts a corner there is a fall. |
| **Fall awareness** (the brief: "never plan a drop >= minDrop; steering must not walk a bot off a platform by accident; L1/L2 may blunder, L3/L4 essentially never") | (1) **Planned drops** are capped at 1.9 m as before AND must not overshoot: `deadlyEdgeAhead` flies a running body (7 m/s, g = 20) off the ledge over the real height field; a 1.5 m terrace beside a ramp that is 3.7 m up is NOT a safe landing (the body clears the terrace and lands 3.9 m down on the seabed: found in the first test, a Veteran lion left the chord ramp's side at 3.4 m and took 50). Such drop edges / straight-line drops are not generated. (2) A ledge edge on a path is approached to its TOP cell first (a straight line to the far side from afar left ramps by their side, metres higher). (3) **`FallGuard`**, the last pass on the final heading: probes the ledge ahead (reach 1.2 m + 0.25 x speed, ballistic landing test) and slides the heading to the nearest direction that does not run over a deadly edge; a bot that is already dropping lets go of the stick (a body keeps its run speed in the air; the sim's decel stops it within a metre); hops over a platform are steered like steps. L1: 30 % of the approaches to an edge are misjudged (the bot walks on for 0.9 s), L2: 10 %, L3 / L4: never. (4) A bot near an edge does not cast a MOVING special (lion / gorilla leap, croc lunge, hippo rush, rhino charge, panther dash) whose line runs over a deadly edge. | Knockback, melee push-out and non-moving abilities cannot be steered; everything the bot itself does can. |
| **Two-lane `SerpentSense`** | One view per lane (own reaction draw, miss / wrong-way rolls). A bot reacts to the lane of the BAND it stands in (`arenaSerpentBand` at its position): a Veteran on a tower top ignores a LOW strike across its spot, a bot on the seabed ignores a HIGH one. On low open ground the exit is the v1.9.1 one (24 straight headings), so the tuned low-lane numbers did not move. Within 4 m of a deadly edge (tower top, tower ramp) the exit is a Dijkstra over the nav grid to the nearest cell that is safe from EVERY live strip, never over a deadly drop: along the platform when it can, down the ramp otherwise; a cell inside the other lane's live strip costs extra. When no safe cell is reachable before the head arrives (`warn + strike x (1 - along / R)` against metres / speed) a Veteran / Apex at >= 60 % health takes the 50-HP fall on purpose by the shortest way off the platform (50 true damage instead of 300); a hurt bot or a Fighter / Cub never does. Cub / Fighter check their way out for a rim only some of the time (50 % / 85 % of the events), otherwise they step off perpendicular and may fall. `repel` (Veteran / Apex): a bot standing outside a lane's band does not walk up / down a ramp INTO that lane's live strip - it holds at the foot until the strike is over. | The v1.9 rules (reaction, miss, wrong way, margin) are kept per level; only WHERE the exit leads is new. |
| **Upper-pad pull** | `NAV_AI[level].upperPull` (0 / 0.15 / 0.3 / 0.35): a pad on the upper tier counts that much nearer in the pickup policies of the bots that collect pads (Fighter within range, Veteran proactive, Apex contest), only when no foe is within 8 m, health >= 50 % and the bot is not already up there; after a visit to the upper tier the pull is off for 25 s (a tower is a dead end, not a camp). | "They hold pickups; higher levels climb for them when safe." |
| **Crevices (stall fix)** | Two Fighter-level pairs wedged for 60-109 s in the notch between the plateau cliff, a causeway's side wall and the 36 deg coral arch (a body of radius >= 0.7 cannot walk the 2.2 m gap, the arch is a hop). (a) The navigator now has a HOP grid (jumpable arches do not block it): used only when the ordinary grids have no route; the follower presses jump when an arch is right ahead. (b) The unstick detector (`updateStuck`) also runs while a bot is retreating or running to a pad with a foe in reach (it used to be off whenever the target was within reach, which is exactly the two-bots-in-a-crevice case). Both are Ocean-only (`nav.active`). | The sweep's stall readout: L2 worst 517 / 6531 / 3780 frames before, 141 after. |
| Tooling | `scripts/balance-sweep.ts`: per-lane serpent readout (events, exposed - in the strip AND in the lane's band -, dodge, walked-in), fall readout (falls / match, HP lost, share of deaths and of all damage, deliberate vs accidental split by what the faller was doing: own ability / shoved, stunned or grabbed / jostled by a melee / walked alone), upper-tier readout (share of fighter-time above 4.5 m, tower-pad pickups), `TRACE_STALLS=1` and `TRACE_FALLS=1`. `scripts/serpentTrial.ts` / `serpent-dodge.ts`: lane-aware trials (angle drawn with `pickLaneAngle`, start point in the strip on the serpent's own band), `LANES=low,high`, falls and dives reported. | |

### Serpent dodge table (isolated trials, `npx vite-node scripts/serpent-dodge.ts`, N = 100 per animal = 1000 per level and lane)

Rate = no serpent damage taken (a fall off a tower is not a hit; its cost is the `fell` column). The v1.9.1 numbers were 33.6 / 60.0 / 83.5 / 93.8 %.

| Level | LOW lane dodge | HIGH lane dodge | HIGH: fell | HIGH: chose the fall | Mean reaction | Target |
|---|---|---|---|---|---|---|
| L1 Cub | **36.0 %** | **34.2 %** | 6.7 % | 0 % | 809 / 844 ms | 25-40 % |
| L2 Fighter | **59.8 %** | **59.6 %** | 3.0 % | 0 % | 617 / 628 ms | >= 50 % |
| L3 Veteran | **83.2 %** | **86.2 %** | 17.9 % | 20.3 % | 409 / 410 ms | >= 75 % |
| L4 Apex | **94.6 %** | **92.0 %** | 5.1 % | 4.6 % | 178 / 179 ms | >= 90 % |

The low lane is the v1.9.1 behaviour (no knob was retuned). On a tower top a Veteran is often out of options in time (reaction 0.4 s, a platform 7.2 m across with a strip 3.6 m wide through it): 20 % of its trials choose the deliberate 50-HP fall (18 % end in one) instead of risking the 300, an Apex needs it in 5 %. The old `serpent.dodge.test` failure (Cub 0.467 against the 0.45 cap) came from the v1.9 TRIAL, not from the bot: it drew the angle uniformly and the start point anywhere in the strip, and with the towers a "low" event could start the fighter on a tower top, where the low serpent cannot hurt it. The lane-aware trial gives the Cub 36.0 % (the bound is now 0.2-0.5 at N = 140, the table above at N = 1000).

### Ocean sweeps (final code)

Real rules (`ARENA=ocean N=60 npm run balance`, shuffled seats, traps on, 50 % every 20 s per lane):

| Level | Avg match | Timeouts | Worst stall (frames) | Runs >= 300 | Serpent events / match (low + high) | Dodge in matches (low / high lane) | Serpent share of deaths | Falls / match | HP lost to falls | Fall share of deaths | Fighter-time on the towers | Tower-pad pickups / match |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| L1 | 46 s | 0 | 159 | 0 | 0.87 + 1.02 | 50 % / - | 0.6 % | 0.00 | 0 % | 0 % | 0.2 % | 0.02 |
| L2 | 66 s | 0 | 141 | 0 | 1.23 + 1.33 | 64 % / 80 % (1 of 5) | 1.9 % | 0.60 | 0.2 % | 0.7 % | 4.5 % | 2.55 |
| L3 | 88 s | 0 | 224 | 0 | 2.17 + 1.88 | 84 % / 100 % (0 of 2) | 0.7 % | 0.85 | 0.3 % | 0.4 % | 6.0 % | 2.58 |
| L4 | 100 s | 0 | 139 | 0 | 2.25 + 2.30 | 90 % / 100 % (0 of 4) | 1.5 % | 0.75 | 0.3 % | 0.0 % | 6.2 % | 3.07 |

Forced events (`SERPENT_EVERY=20 SERPENT_CHANCE=1 ARENA=ocean N=40`, both lanes roll every 20 s): 0 timeouts, worst stall 158 / 125 / 237 / 192 frames (no run >= 300), serpent deaths 1.4 / 5.0 / 4.2 / 3.1 % of deaths (1.9-4.7 events per lane and match), low-lane dodge 57 / 66 / 79 / 89 %, high-lane dodge 100 % of 1 (L2), 67 % of 9 (L3), 100 % of 6 (L4), falls 0.00 / 0.78 / 0.85 / 0.68 per match, fall share of deaths 0 / 0.6 / 0 / 0 %. L4 over 180 matches (three windows of 60): worst stall 237, no run >= 300, falls 0.75-0.80 per match.

Reading:
- **Zero timeouts and no stall run >= 300 frames** in 240 real-rule matches, 160 forced-event matches and 180 more L4 matches. The sweeps run while this WP was being written found two more wedges (L2: 6531 frames; L4: 1011 frames, two bots bound for the same tower pad deadlocked beside an armed fire trap with the unstick detector off because the foe was within reach); both are fixed (`updateStuck` runs on pad runs and retreats on elevated arenas).
- **Fall damage is a rounding error**: 0.0-0.7 % of deaths (< 3 %), 0.2-0.4 % of all damage. Falls per match 0.6-0.85 at L2-L4. By what the faller was doing in the last second (L3 / L4, 60 matches each): its own ability 30-35 % (a charge or an ultimate; only the six moving specials are gated), shoved / stunned / grabbed 23-33 %, jostled by a melee push-out ~15 %, none of those ("walked alone") 16-32 %, i.e. 0.13-0.23 per match - those are not confirmed steering errors (a projectile or an area effect displaces a body without a knockback flag), but they are the number to look at if L3 / L4 are to "essentially never" fall. The Apex chose the fall on purpose once in 60 matches (the serpent dive). The tower-duel test that found the steering falls (two bots dropped on one tower top, 25 s, six seeds x three towers): one fall per duel at every level before the work (mostly bots hopping or stepping over the rim and over the side of a ramp top, plus charges), 0.44-1.0 per duel (L1 0.56, L2 1.0, L3 0.78, L4 0.44) after the first round of fixes; the final code was only measured in the full-match sweeps above.
- The high serpent is almost never a threat in matches (exposed per event 0.02-0.06): the towers are quiet, which is also why the tower falls cost more than the serpent does.
- L2 average match time is **+60 %** over the colosseum (66 s against 41 s at N = 60; v1.9 was 49 s): Fighters spend 4.5 % of their time on the towers and 19 % of their pickups are tower pads (heal runs by straight-line distance); L3 / L4 are +-0-12 % (88 / 100 s against 89 / 89). Not tuned here (the task's targets do not cover it); a hurt bot choosing a heal pad by walking distance rather than straight distance would shorten it.

Win % per animal (N = 60 per cell, +-4-6 points of noise per cell; bands: L3 / L4 4-18 %, L1 / L2 < 30 %):

| Animal | L1 | L2 | L3 | L4 (N = 60) | L4 (N = 180) |
|---|---|---|---|---|---|
| crocodile | 15 | 12 | 12 | 15 | 11.7 |
| eagle | 3 | 13 | 7 | 12 | 10.6 |
| giraffe | 5 | 7 | 10 | 8 | 7.2 |
| gorilla | 12 | 10 | 8 | 5 | 6.7 |
| hippo | 10 | 13 | 7 | 5 | 5.6 |
| lion | 13 | 7 | 13 | 10 | 11.1 |
| mole | 5 | 5 | 15 | 7 | 10.0 |
| panther | 10 | 7 | 10 | **20** | 17.2 |
| python | 8 | 15 | 13 | 12 | 13.3 |
| rhino | 17 | 12 | 5 | 7 | 6.1 |

Every cell is inside its band except the **L4 panther at N = 60 (20 %)**; at N = 180 it is 17.2 % (inside, but the highest animal at that level) and the hippo is 5.6 % (an N = 60 cell showed 3 %): the extra seeds are what to trust. L1 spread 3-17, L2 5-15, L3 5-15, L4 5.6-17.2. No animal number was retuned (animal balance is not this WP's to touch).

### Identity proof (colosseum and jungle unchanged)

`scripts/identity-hash.ts` before the first edit and after the last (12 full matches per arena): **colosseum chain `cd997f25`, jungle chain `7ab4f15e`, both times**, every per-match hash identical (re-run after each of the last three bot edits). The nav grid, the navigator, the fall guard, the serpent sense and every new `BotBrain` branch are inactive without `heightfield` / `hazards.fallDamage` / `hazards.serpent`.

### Findings for the other packages (not fixed here: sim / layout)

- **A charge keeps its altitude over a void.** A fighter whose ability owns its position (hippo River Rush, rhino charge) that leaves a platform mid-charge hovers at its starting height until the charge ends (`locomote` is skipped, `followGround` does not run while `airborne`), then falls the full height: a rush that starts on a tower and runs off the rim hangs in the air for up to 1.2 s and lands a deadly drop below. The bots no longer cast movers toward a rim; a human can.
- **Crevices at the causeway feet.** The notch between the plateau cliff (r = 8), a causeway's side wall and the coral arch at 36 deg (r 10.5) / the crate piles is a 1-5 m2 pocket for any body of radius >= 0.7 on the nav grid (the arch is a 0.9 m hop, the gap 2.2 m): animals can get in (by hopping the arch) and, without the hop planning above, could not get out. The bots now hop out; the layout could open it (move the arch 3 m outward).
- **Tower fights are knockback fights**: a duel on a 3.6 m disc ends with a fighter over the edge in roughly every second duel even with the guard; the tower top is a hard place to stand next to a gorilla (by design, per the plan).

### Not measured / limits

- Ultimates are not gated against a deadly edge (only the six moving specials are); 12-18 of the 60-match falls at L3 / L4 follow the faller's own ability.
- The deliberate fall exists only as a serpent emergency (no flee-by-falling, no chase-by-falling): a hurt bot never leaves a tower by the edge.
- The upper-pad pull is light by design: its effect is hard to separate from heal runs (the same pads are the nearest heal pad for a retreating bot); `NAV_TUNE='{"2":{"upperPull":0}}'` leaves the L2 numbers unchanged, because the Fighter's range-8 policy rarely reaches a tower pad on pull alone.
- Win rates carry +-4-6 points of noise per cell at N = 60.

## v1.9.1 serpent retune (50 % every 20 s)

User request: the sea serpent rolls **50 % every 20 s of live match time** (was 10 % every 60 s). Only `src/config/serpent.ts` `intervalS`/`chance` changed. Ocean sweep, real rules, N=60 per level (`ARENA=ocean N=60 npm run balance`):

| Level | Avg match | Timeouts | Serpent events/match | Exposed/event | Bot dodge (mid-fight) | Serpent share of deaths | Worst stall (frames) |
|---|---|---|---|---|---|---|---|
| L1 | 46 s | 0 | 0.97 | 0.26 | 47 % | 1.3 % | 157 |
| L2 | 51 s | 0 | 0.93 | 0.45 | 64 % | 1.1 % | 114 |
| L3 | 90 s | 0 | 2.10 | 0.36 | 73 % | 1.3 % | 167 |
| L4 | 109 s | 0 | 2.40 | 0.40 | 84 % | 0.7 % | 229 |

Roughly 1–2.4 attacks per match, no stalls ≥ 300 frames, no timeouts, serpent deaths stay ≤ 1.3 % of all deaths (bots dodge most of the time). Win-rate spread was not re-tuned (the event hits everyone equally and kills almost nobody).

## v1.9 ocean (WP-O2): bots on three levels, sea-serpent dodging, Ocean Dome balance

Plan: `docs/OCEAN-PLAN.md` (arena data `OCEAN_ARENA` in `src/config/arenas.ts`, serpent numbers `src/config/serpent.ts`, serpent system `src/sim/SerpentSystem.ts`). Bot code: `src/ai/NavGrid.ts` (walkability grid + A*), `src/ai/Navigator.ts` (per-bot planning, path following, level ladder), `src/ai/SerpentSense.ts` (serpent perception, dodge, level ladder); hooks in `BotBrain`. Everything is gated on arena data (`arena.heightfield`, `arena.hazards.serpent`), so the colosseum and the jungle are byte-identical (proof below). **No animal stat, no arena data and no serpent number was changed**: the sweeps needed none.

### What changed

| Area | Change | Why |
|---|---|---|
| **Elevation-aware navigation** (`heightfield` arenas only) | A deterministic walkability grid (0.75 m cells, per body radius + per-level margin, cached per arena): a cell is walkable iff `arenaStandable` (wall, cliffs, solids); edges join the 8 neighbours (no corner cutting) and cost their length plus a penalty beside cliffs / solids / ledges, so a path keeps to the middle of a 6 m ramp. **Drop edges** (walking off a 0.45-1.9 m ledge) are generated by marching from every ledge-top cell and are optional; **jump edges** (a 0.6-1.0 m up-step) exist in the grid for arenas that have one (the Ocean has none: its levels are 1.5 m apart and a jump apexes at 1.2 m). A* per bot over a typed-array heap (0.1-1 ms). The brain keeps its normal straight-line steering whenever terrain does not block the straight line; when a cliff (or a ledge it does not want to drop) is in the way it follows the next waypoint: string-pulled (the farthest cell it can walk to in a straight line), re-planned when the goal moves, on a timer, when it strays off the path or stalls. Used for targets, heal / pickup pads, the no-contact drift to the centre and a flight point that does not run into a cliff. | WP-O1a's smoke: bots chased straight at targets on other levels and wedged at cliffs (worst stall 789 frames in the smoke, **8190 frames = 136 s** in the N = 60 sweep at L4, 6623 at L2). |
| Level ladder (`NAV_AI`) | **L1 Cub**: re-plans every 1.1 s, no safety margin (it bumps cliff corners), follows the raw cells 3 ahead, drops off ledges at any health, ignores levels when picking a target. **L2 Fighter**: 0.6 s re-plans, 0.15 m margin, string-pulled, drops above 30 % health, 0.4 x cross-level target penalty. **L3 Veteran**: 0.35 s, 0.3 m margin, drops above 55 %, full penalty. **L4 Apex**: 0.25 s, 0.3 m, drops above 60 %. | "L1 follows paths poorly, L4 uses the levels". |
| Tactics | The target score counts a foe on another level as 7 m farther per level (`crossPenalty`, scaled by the level). A hurt Veteran / Apex does not plan a drop (it goes round by a ramp: "don't chase down a cliff when low"); every level may drop when FLEEING. A foe too far above / below for melee (the seabed-plateau pair; the giraffe reaches 3.0 m) is approached by a ramp however close it stands. Retreat to a heal pad is a path (up the ramps). A **Veteran / Apex eagle** whose walk is more than 1.45 x the straight distance + 4 m starts its soar plan and flies over the cliffs. | The same rules a human plays by (cliffs are real for everybody). |
| **Sea-serpent dodging** | The bot reads `snapshot.serpent` (the public warning strip). Per event it draws a REACTION DELAY (profile reaction time + a decision lag, with a spread), a chance of not noticing at all, a chance of running the wrong way, and (Fighter / Cub) it does not test its exit for cliffs and solids. After the delay it leaves the strip by the SHORTEST WALKABLE route (24 headings scored by the distance to clear the capsule + a walkability test over cliffs, ramps and solids; ledges may be dropped off), drops swings, blocks and special / ultimate STARTS, cancels crate smashing / unsticking, and (Veteran / Apex) never steps back into the strip while the strike is live (`repel`). Soaring eagles (> 3 m up) and the harmless hold / retreat phases are ignored. A fighter caught mid-swing is slowed by the sim's 0.4 x swing speed; Fighter / Cub also add a busy delay. | "Difficult but not impossible": the sim's serpent numbers are untouched, the bots' decision quality is the lever. |
| Tooling | `scripts/balance-sweep.ts`: `SERPENT_EVERY=20` (forced events; `SERPENT_FIRST`, `SERPENT_CHANCE`), a serpent readout (events, fighters exposed in the strip when it appears, hits, dodge %, walked-in hits, serpent deaths split from trap deaths), a stall readout (worst run of frames a fighter wanted to move but stayed within 0.75 m, runs >= 300 frames; always on for the Ocean, `STALLS=1` elsewhere), `NAV_TUNE` / `SERPENT_TUNE` what-ifs. `scripts/serpent-dodge.ts` (+ `scripts/serpentTrial.ts`): isolated dodge trials on the real Ocean. | |

### Serpent dodge table (isolated trials, `npx vite-node scripts/serpent-dodge.ts`, N = 200 per animal = 2000 per level)

One fighter at a random standable point INSIDE the telegraphed strip (uniform over its area), random strike angle, real World physics, the bot's own `SerpentSense` steering, nothing else moving; rate = no serpent damage taken. Reaction = delay from the first warning tick to the first step out.

| Level | Dodge | Target | Mean reaction | Knobs (`SERPENT_AI`) |
|---|---|---|---|---|
| L1 Cub | **33.6 %** | 25-40 % | 815 ms | +250 ms lag, sd 300, 30 % never notices, 25 % wrong way, no exit check |
| L2 Fighter | **60.0 %** | >= 50 % | 607 ms | +200 ms, sd 200, 20 % miss, 20 % wrong way, no exit check |
| L3 Veteran | **83.5 %** | >= 75 % | 407 ms | +150 ms, sd 120, 10 % miss, 8 % wrong way, exit check, never re-enters |
| L4 Apex | **93.8 %** | >= 90 % | 185 ms | +20 ms, sd 60, 4 % miss, 2 % wrong way, exit check, never re-enters |

Per animal (percent, N = 200 each): Cub 29-37, Fighter 56-66, Veteran 81-86, Apex 91-96. Speed barely matters (a Cub lion 37 vs a Cub rhino 29): what decides it is the reaction, the way out and the cliffs, because the strip's edge is near for half the positions. OCEAN-PLAN's table says the slowest animal clears the rim if it starts within 0.52 s: an Apex (mean 0.185 s) always has the time, a Cub (0.8 s) mostly does not. The "Cub 600 +- 250 ms" of the plan is the profile's perception time; the decision lag turns it into 815 ms (that is what takes the Cub from 46 % to 34 %).

**In matches** (10 bots, a forced event every 20 s of live time from t = 10 s, N = 60 per level; "exposed" = standing in the strip when the warning appeared, a mid-fight population: swinging, grabbed, hemmed in):

| Level | Events / match | Exposed / event | Dodge in matches | Hit while exposed | Walked in | Serpent deaths / match (share of deaths) | Legacy bots: dodge, deaths / match |
|---|---|---|---|---|---|---|---|
| L1 | 2.25 | 0.30 | 44 % | 23 / 41 | 6 | 0.13 (1.5 %) | 30 %, 0.17 (1.9 %) |
| L2 | 2.45 | 0.34 | 52 % | 24 / 50 | 12 | 0.22 (2.4 %) | 27 %, 0.28 (3.1 %) |
| L3 | 4.43 | 0.18 | 67 % | 16 / 48 | 8 | 0.13 (1.5 %) | 29 %, 0.30 (3.3 %) |
| L4 | 5.33 | 0.34 | 87 % | 14 / 108 | 12 | 0.08 (0.9 %) | 52 %, 0.17 (1.9 %) |

With the REAL rules (10 % per minute: 0.03-0.13 events per match) the serpent killed one fighter in 480 sweep matches: negligible. With an event every 20 s it is a minority of deaths (<= 2.4 %).

### Ocean results (`ARENA=ocean`, shuffled seats, traps on, real serpent rules)

Win % per level, legacy bots (WP-O1a code: no navigation, no dodge; N = 60) -> WP-O2 bots (N = 60 at L1, N = 120 at L2-L4; the N = 60 L2 sweep had the crocodile at 37 % and the N = 120 one at 29 %, so single cells carry about +-5 points):

| Animal | L1 | L2 | L3 | L4 |
|---|---|---|---|---|
| crocodile | 27 -> **13** | 13 -> **29** | 12 -> **8** | 7 -> **10** |
| eagle | 3 -> **5** | 5 -> **8** | 20 -> **9** | 13 -> **10** |
| giraffe | 3 -> **10** | 10 -> **7** | 12 -> **4** | 13 -> **8** |
| gorilla | 12 -> **7** | 15 -> **4** | 5 -> **9** | 5 -> **13** |
| hippo | 7 -> **13** | 5 -> **7** | 5 -> **8** | 8 -> **8** |
| lion | 13 -> **8** | 7 -> **9** | 8 -> **8** | 10 -> **8** |
| mole | 2 -> **5** | 7 -> **1** | 5 -> **13** | 20 -> **16** |
| panther | 20 -> **17** | 8 -> **11** | 8 -> **13** | 7 -> **8** |
| python | 2 -> **3** | 13 -> **9** | 15 -> **17** | 15 -> **13** |
| rhino | 12 -> **18** | 17 -> **16** | 8 -> **10** | 2 -> **4** |

| | Legacy (N = 60) | After | Colosseum (N = 30) | Target |
|---|---|---|---|---|
| Avg match time L1 / L2 / L3 / L4 | 52 / 74 / 90 / 92 s | **47 / 49 / 92 / 108 s** | 45 / 40 / 89 / 89 s | within +-30 % of the colosseum: +4 / +22 / +3 / +21 % |
| Timeouts | 0 | **0 of 420 matches** | 0 | 0 |
| Worst stall (frames a bot wanted to move but stayed within 0.75 m) | 143 / **6623** / 651 / **8190** | **157 / 127 / 182 / 286** | | < 300 |
| Stall runs >= 300 frames per 60 matches | 0 / **94** / 3 / **40** | **0 / 0 / 0 / 0** | | none |
| Ults per fighter per match | 0.60 / 0.90 / 0.95 / 1.01 | **0.60 / 1.04 / 1.03 / 1.16** | 0.58 / 0.97 / 1.02 / 1.17 | ~ 1 |
| Trap share of damage | | **0.3 / 0.2 / 0.2 / 0.4 %** | 1.1 / 0.3 / 0.2 / 0.2 % | <= 6 % |
| Win-rate spread (max / min animal) | 27 / 2, 17 / 5, 20 / 5, 20 / 2 | **18 / 3, 29 / 1, 17 / 4, 16 / 4** | | L3 / L4 4-18 %, L1 / L2 <= 30 % |

Reading: every band holds. The two weak spots are inherited, not new: the L2 crocodile is the colosseum's L2 crocodile (27 % there, 30 % in the jungle, 29 % here at N = 120) and the L2 mole sits at 1 % (colosseum 7 %, jungle 3 %); both are animal-balance questions this WP may not touch. L4 average match time is 21 % above the colosseum (bloodlust reached in 33 % of the matches vs 10 %): the Apex climbs ramps to heal and kites, which costs time, inside the +-30 % band. The Cub barely changed (it never stalled much); the stall hunt mattered at L2 and L4 (legacy: bots stuck for up to 136 s, 94 / 40 runs of >= 5 s per 60 matches).

### Identity proof (colosseum and jungle unchanged)

`scripts/identity-hash.ts` (a per-tick FNV chain over every snapshot and bot intent, 12 full matches per arena) before the first edit and after the last: **colosseum chain `cd997f25` both times, jungle chain `7ab4f15e` both times**, every per-match hash identical. `npm run balance` (N = 30, four levels) and `ARENA=jungle npm run balance` (N = 30) are line-for-line identical before / after (modulo wall time).

### Not measured / limits

- No jump-up edge is ever planned on the Ocean (levels 1.5 m apart, a jump reaches 1.2 m): the grid builds jump edges and the follower presses jump at their foot, but no arena exercises that path today.
- The eagle's soar is NOT used to escape the strike (it needs about 1.3 s to climb above 3 m, the head reaches the rim at 1.1 s); no bot jumps to dodge (the 3 m hazard height is beyond a 1.2 m jump).
- Bots that are mid-ability (charges, burrow, channelled ultimates) cannot dodge: only the STARTING of one is cancelled.
- In-match dodge rates are lower than the isolated ones because the exposed population is mid-fight; the isolated table is the tuning target.
- Win rates at N = 60-120 carry +-4-6 points of noise per cell; the L4 worst stall (286 frames) is close to the 300-frame line.

## v1.8 jungle (WP-J2): terrain-aware bots, hop rule, jungle balance

Plan: `docs/JUNGLE-PLAN.md`. Arena data in `src/config/arenas.ts` (`JUNGLE_ARENA`), terrain numbers in `src/config/terrain.ts`, the swim attribute in `src/config/animals.ts`, bot terrain code in `src/ai/TerrainSense.ts` (hooks in `BotBrain` / `Perception`). Raw sweeps: `ARENA=jungle npm run balance` (new jungle telemetry: water %, moss %, over-the-pool "hop" %, damage dealt from the water, in-pool damage exchange; new `FROM=` env replays a tail of the seeds).

### What changed

| Area | Change | Why |
|---|---|---|
| **Bots read terrain** (jungle only: `arena.terrain.length > 0`, otherwise every call is a no-op) | `TerrainSense`: **path cost** (the exact shortest path round a disc, taken when `chord x weight x (cost - 1)` beats the detour; the cost is the animal's OWN water multiplier or the moss 0.65, so a crocodile at 1.05 per metre swims straight through and a giraffe at 3.1 walks round); **exit planning** from inside a zone (cheapest rim point toward the goal); **soft wall** (Veteran / Apex do not WALK INTO water, if they are poor swimmers, or moss, whoever they are, to start a fight: they slide along the edge for 2.5 s / 3.5 s of patience, then commit for 6 s; a movement special such as a leap or pounce is held back too); **flight** (L3+: a fast swimmer flees THROUGH the pool away from a slow swimmer, everyone else routes round); **never idle** in slow terrain when hurt or with nothing to fight; **dry rally ring + patrol** for the no-contact wander (the jungle's centre is the pool, so the old "drift to (0,0)" would park bots in the water; a ring without patrol stalled two bots hidden from each other by a trunk, so they walk the ring in opposite directions until somebody is in view); **target bias** (L3+: poor swimmers dislike a target in the pool, fast swimmers like a slow swimmer in it); **bots never press jump in water**. | Bots wandered through terrain blindly: at L4 they spent 13-27 % of their life swimming (giraffe 27 %, gorilla 23 %, mole 21 %, lion 19 %) and 7-16 % on moss. |
| Level ladder (`TERRAIN_AI`) | L1 Cub: ignores terrain (only the dry rally ring). L2 Fighter: half-weight detours, leaves slow terrain when idle or hurt. L3 Veteran: full detours, soft wall 2.5 s, smart flight, target bias 0.25. L4 Apex: weight 1.15, soft wall 3.5 s, bias 0.4. | "L1 mostly ignorant, L4 clever". A giraffe sent across the pool to a target on the far side (9 s window): wet 5.3 / 1.9 / 0.7 / 0.7 s at L1 / L2 / L3 / L4, first hit at 7.9 / 6.0 / 5.0 / 5.1 s. |
| **Sim: anti hop-chain rule** (`TERRAIN.wetJumpMult = 0.55`, `MovementSystem.locomote`) | A jump launched while `terrainSpeedMult < 1` (water, moss or its linger) leaves at 55 % speed: apex 0.37 m, below the 0.6 m grounded line, so the fighter keeps wading through the hop. Dry jumps and the whole colosseum are unchanged. | Held-jump spam bypassed the slow: a normal 1.2 m hop is 70 % above the grounded line, where terrain does nothing (table below: giraffe 6.3 s walking vs 3.2 s spamming Space across the pool). Bots never do it on purpose (0 hops measured), a player can mash the key. After the rule every animal gains at most 2 %. |
| **Sim: orphaned-grab release** (`World.step` 2a, terrain arenas only) | A held fighter whose holder lost its ability to an interruption is released on the next tick. | A rhino staggered in the middle of its Lockdown carry kept its victim `grabbed` for ever (`Fighter.interrupt` only keeps `isGrab` abilities): jungle L3 seed 3396 timed out with a croc frozen at 1183 HP for 260 s (1 timeout in 400). The same bug exists in the colosseum (with the fix ungated the N=20 colosseum sweep changed in a few Cub matches), so the release is gated to terrain arenas to keep the colosseum byte-identical; deleting `this.terrain.active &&` in that loop fixes it there too (architect's call). |
| Tooling | `scripts/identity-hash.ts` (per-tick FNV chain of every snapshot and bot intent, any arena); sweep terrain readout; `FROM=`. | Identity proof below. |

Hop-chain test (`tests/sim/terrain.hop.test.ts`): time to run 16 m along z = 4 (10.2 m of it in the pool), walking vs tapping jump every 0.72 s:

| Animal | walk | spam before | gain | spam after | gain |
|---|---|---|---|---|---|
| lion | 4.10 s | 2.90 s | x1.41 | 4.03 s | x1.02 |
| gorilla | 6.02 s | 3.35 s | x1.80 | 5.98 s | x1.01 |
| crocodile | 3.02 s | 2.97 s | x1.02 | 3.02 s | x1.00 |
| hippo | 3.17 s | 2.97 s | x1.07 | 3.17 s | x1.00 |
| rhino | 6.37 s | 3.82 s | x1.67 | 6.37 s | x1.00 |
| panther | 3.35 s | 2.65 s | x1.26 | 3.30 s | x1.02 |
| python | 3.65 s | 3.22 s | x1.13 | 3.65 s | x1.00 |
| giraffe | 6.32 s | 3.23 s | x1.95 | 6.25 s | x1.01 |
| mole | 4.42 s | 3.25 s | x1.36 | 4.42 s | x1.00 |

The eagle glides and flyers are unaffected by design. Moss: x1.28 before, at most x1.15 after.

### Swim and moss numbers (the J1b starting values: the sweeps needed no retune)

| Animal | `swim` | water multiplier (x own land speed) | Class for the bots |
|---|---|---|---|
| crocodile | 0.93 | 0.95 | good (>= 0.70) |
| hippo | 0.80 | 0.86 | good |
| python | 0.65 | 0.76 | good |
| panther | 0.43 | 0.60 | mid |
| mole | 0.36 | 0.55 | mid |
| lion | 0.29 | 0.50 | mid |
| eagle | 0.21 | 0.45 | poor (< 0.45 is poor; on foot) |
| rhino | 0.14 | 0.40 | poor |
| gorilla | 0.08 | 0.36 | poor |
| giraffe | 0.03 | 0.32 | poor |

Moss: slow 35 % (x0.65), 0.4 s linger, every animal alike. Pool: r 6.5 at (0, 0), depth 0.55 m, shoreline hysteresis 0.15 m. Water multiplier = 0.30 + 0.70 x swim (strict ordering, all inside [0.30, 1.00]). Geometry unchanged (the J1a layout tests are green); `wetJumpMult` 0.55 is the only new number.

Does the pool favour the good swimmers? Duels started IN the pool (1.6 m either side of its centre) versus on dry ground at the same spacing, L4 Apex bots, N = 30 per cell, win % of the row animal, land / pool:

| | giraffe | gorilla | rhino | lion | panther | mole |
|---|---|---|---|---|---|---|
| crocodile | 83 / 100 | 40 / 57 | 50 / 53 | 60 / 70 | 80 / 83 | 100 / 100 |
| hippo | 37 / 100 | 40 / 57 | 13 / 13 | 7 / 13 | 47 / 60 | 10 / 37 |
| python | 97 / 100 | 60 / 73 | 17 / 47 | 47 / 37 | 37 / 60 | 80 / 97 |

The three good swimmers win 49 % (L4) and 54 % (L3) of the nine pairings against the poor swimmers on land, and 67 % and 67 % in the pool: +13 to +18 points, the design intent, and nobody becomes unplayable (the giraffe was already the weakest duelist on land). Bot-vs-bot FFA shows it only mildly because Veteran / Apex bots avoid starting fights in the water: in-pool damage dealt / taken (L4, N = 300) is python 1.49, panther 1.35, lion 1.00, hippo 0.96, crocodile 0.91, gorilla 0.71, rhino 0.63.

### Jungle results (`ARENA=jungle`, shuffled seats, traps on)

**Before** (J1b code, bots blind to terrain), N = 60: win % per level, and the share of life at L4 in the water / on moss:

| Animal | L1 | L2 | L3 | L4 | water L4 | moss L4 |
|---|---|---|---|---|---|---|
| lion | 8 | 5 | 15 | 7 | 19 % | 11 % |
| gorilla | 8 | 15 | 20 | 2 | 23 % | 10 % |
| crocodile | 12 | 20 | 12 | 17 | 13 % | 12 % |
| hippo | 13 | 22 | 7 | 7 | 16 % | 16 % |
| rhino | 12 | 5 | 8 | 7 | 14 % | 14 % |
| eagle | 5 | 8 | 3 | 13 | 17 % | 7 % |
| panther | 23 | 7 | 3 | 10 | 16 % | 9 % |
| python | 10 | 5 | 15 | 15 | 17 % | 12 % |
| giraffe | 7 | 10 | 5 | 7 | 27 % | 11 % |
| mole | 2 | 3 | 12 | 17 | 21 % | 7 % |
| avg match | 41 s | 42 s | 71 s | 90 s | | |
| ults / fighter / match | 0.42 | 0.90 | 0.82 | 1.09 | | |

**After** (final code), N = 60, same seeds (the N = 400 table below is the reliable one):

| Animal | L1 | L2 | L3 | L4 | water L4 | moss L4 |
|---|---|---|---|---|---|---|
| lion | 8 | 2 | 8 | 5 | 10.3 % | 2.7 % |
| gorilla | 10 | 20 | 13 | 3 | 5.1 % | 3.2 % |
| crocodile | 13 | 20 | 7 | 15 | 13.5 % | 3.8 % |
| hippo | 12 | 17 | 10 | 10 | 12.2 % | 7.1 % |
| rhino | 10 | 7 | 3 | 2 | 9.0 % | 7.3 % |
| eagle | 5 | 10 | 8 | 18 | 3.1 % | 1.9 % |
| panther | 22 | 2 | 5 | 12 | 10.5 % | 2.3 % |
| python | 12 | 7 | 15 | 18 | 12.6 % | 2.8 % |
| giraffe | 7 | 13 | 13 | 7 | 7.4 % | 2.9 % |
| mole | 2 | 3 | 17 | 10 | 9.8 % | 1.6 % |
| avg match | 41 s | 42 s | 76 s | 89 s | | |

**Final, N = 400 per level**, win % / average place, 0 timeouts at every level:

| Animal | L1 | L2 | L3 | L4 | water % L1 / L2 / L3 / L4 | moss % L4 |
|---|---|---|---|---|---|---|
| lion | 7 / 6.04 | 6 / 6.14 | 6 / 6.26 | 8 / 5.96 | 2.3 / 6.3 / 6.1 / 9.5 | 3.1 |
| gorilla | 9 / 5.26 | 10 / 5.47 | 9 / 5.43 | 7 / 5.59 | 2.0 / 8.8 / 5.0 / 5.9 | 3.5 |
| crocodile | 21 / 4.45 | 20 / 4.53 | 10 / 5.12 | 13 / 4.72 | 2.3 / 7.4 / 8.7 / 13.4 | 4.2 |
| hippo | 20 / 3.65 | 15 / 4.97 | 11 / 4.87 | 7 / 5.04 | 2.9 / 8.9 / 10.0 / 11.5 | 6.2 |
| rhino | 11 / 4.52 | 11 / 5.24 | 6 / 5.79 | 4 / 6.18 | 2.3 / 8.0 / 5.9 / 7.3 | 6.2 |
| eagle | 5 / 6.97 | 10 / 4.97 | 12 / 4.92 | 14 / 4.36 | 1.0 / 8.2 / 3.6 / 4.0 | 2.2 |
| panther | 13 / 5.41 | 7 / 6.08 | 13 / 5.75 | 12 / 5.74 | 2.0 / 6.8 / 7.3 / 10.3 | 3.3 |
| python | 6 / 6.15 | 11 / 5.72 | 14 / 5.82 | 16 / 5.42 | 1.5 / 7.1 / 8.0 / 11.6 | 3.0 |
| giraffe | 5 / 5.89 | 7 / 5.56 | 9 / 5.67 | 8 / 6.20 | 1.2 / 9.6 / 6.6 / 8.3 | 4.4 |
| mole | 5 / 6.66 | 4 / 6.32 | 11 / 5.37 | 13 / 5.80 | 1.4 / 5.1 / 6.5 / 9.9 | 2.1 |
| **avg match** (colosseum v1.3: 44 / 41 / 89 / 93 s) | 41 s | 43 s | 74 s | 88 s | | |
| **ults / fighter / match** (colosseum 0.57 / 0.99 / 1.04 / 1.17) | 0.42 | 0.90 | 0.84 | 1.13 | | |
| **trap share of damage / trap deaths** | 0.9 % / 0.4 % | 0.3 % / 0.2 % | 0.2 % / 0.1 % | 0.3 % / 0.4 % | | |

COMPARE (same seeds, traps off vs on, N = 100, L3 / L4): traps deal 0.2 % / 0.3 % of all damage and 0.1 % / 0.2 % of deaths; the largest placement shift is 0.60 / 0.79 (about 1.4 paired standard errors at N = 100) and no animal moves consistently.

### Against the targets

- **L3 / L4 win rates 4-18 %:** met at N = 400 (L3 6-14 %, L4 4-16 %). Edges: rhino L4 4 % (the colosseum's L4 rhino is 5-8 %; it is the weakest jungle animal: slow in the water and 6 % of its life on moss) and python L4 16 % (18-19 % in the N = 60 / 200 samples, inside the band at N = 400). The N = 60 table has two cells outside (rhino L3 3 % and L4 2 %) and eagle L4 at the 18 % ceiling: inside the +-4-point noise of that sample size, and inside the band at N = 400.
- **L1 / L2 at most about 30 %:** top cells crocodile 21 % / 20 %, hippo 20 % (L1), panther 13 %.
- **0 timeouts:** 0 in 4 x 400 FFA matches after the orphaned-grab release (1 before: seed 3396, L3). The N = 10 jungle duel matrices count 1-2 "timeouts" per level; those are mutual-KO draws (no winner), and eagle hit-and-run duels cut by a 120 s cap, which the colosseum duel matrix has too (1 at L3).
- **About 1 ultimate per fighter per match:** 0.84 (L3) / 1.13 (L4). L1 0.42 and L2 0.90 are the jungle's own numbers (the blind-bot baseline was identical: 0.42 / 0.90); L1 is below the colosseum's 0.57 because trunks cut the Cubs' line of sight and matches are 7 % shorter.
- **Average match within 30 % of the colosseum:** -7 % / +5 % / -17 % / -5 % against the v1.3 report.
- **Traps at most about 6 % of damage and 3 % of deaths:** 0.2-0.9 % and 0.1-0.4 %.
- **At most about 12 % of life in the water at L4 except crocodile / hippo / python:** lion 9.5, gorilla 5.9, rhino 7.3, eagle 4.0, panther 10.3, giraffe 8.3, mole 9.9 %; crocodile 13.4, hippo 11.5, python 11.6 %. Moss at most 6.2 %.
- **Out of band:** nothing at N = 400. L2 spends 5-10 % of its life in the pool by design (half-weight detours). Duel cells are N = 10 per pair (+-15 points) and were only checked for pathologies.

The level split inherited from v1.1 remains: hippo 20 % at L1 and 7 % at L4, crocodile 21 % and 13 %, python 6 % and 16 %, giraffe 5 % and 8 %.

### Identity proof (the colosseum is byte-identical to before WP-J2)

1. `scripts/identity-hash.ts` (a per-tick FNV-1a chain over `JSON.stringify(world.snapshot())` plus every bot intent; L1-L4 x 3 seeds, 12 full matches): before the WP-J2 edits and after the last one, all 12 per-match hashes and the chain `cd997f25` are identical.
2. `N=20 LEVELS=1,2,3,4 TRACE=1 npm run balance` on the colosseum: identical output before and after, byte for byte (only the wall-time suffix differs).
3. The unchanged AI / sim / online suites. Everything terrain-related is behind `arena.terrain.length > 0`, `TerrainSense.active` or `terrainSpeedMult < 1`; the orphaned-grab release is gated on `terrain.active` for this reason (ungated, it changed a few Cub matches, which is how the colosseum copy of the bug showed up).

### Not verified / notes

- No visual or in-browser check (bots and sim only; renderer and audio belong to WP-J3 / J4). Online BR: `hostDriver` and `SimDriver` already hand `world.arena` to `BotManager`; only the headless path was run.
- The pool "ambush" (a fast swimmer camping in the water to lure a slow one in) is NOT implemented: good swimmers use the pool by pathing straight through it, preferring slow swimmers that stand in it and fleeing through it, but they do not wait in it.
- The soft wall treats moss like water for Veteran / Apex (the same hold for any animal) although moss slows everybody equally; it costs little (moss at most 6 % of life) and keeps L3 / L4 from starting fights on it.
- Duel matrices and the in-pool exchange table are small samples (10 and 30 per cell) and only indicative.

## v1.3: ten redesigned ultimates

All ten ultimates were redesigned in v1.3 (one module, config, bot script, rig pose, VFX and audio file per animal; design notes in `docs/ultimates/<animal>.md`, raw sweeps in `docs/ultimates/<animal>-balance.txt`). Each animal's numbers live only in `src/config/ultimates/<animal>.ts`. Cost stays 100 charge. Targets: L3/L4 win rate about 4–18 %, L1/L2 at most about 30 %, 0 timeouts, about 1 ult per fighter per match.

Win rate % by bot level (L1 Cub, L2 Fighter, L3 Veteran, L4 Apex). Method as in the v1.1 report: `N=60 LEVELS=1,2,3,4 npm run balance`, same seeds, shuffled seats, traps on. An N=60 cell carries roughly ±5 points of noise. The per-animal files were taken while the other animals' ultimates were still changing, so only each animal's own rows are read; the last column gives the larger sample taken for L3/L4.

| Animal | Ultimate (old → new) | Before L1 / L2 / L3 / L4 | After L1 / L2 / L3 / L4 | Larger sample L3 / L4 |
|---|---|---|---|---|
| Lion | King's Roar → **Royal Hunt** | 8 / 10 / 8 / 7 | 12 / 7 / 3 / 7 | 3 / 8 (N=120) |
| Gorilla | Primal Rampage → **Boulder Hurl** | 13 / 3 / 5 / 10 | 13 / 7 / 7 / 12 | 8 / 10 (N=200) |
| Crocodile | Death Roll (v1.2 grab lunge) → **Death Roll** (lock, clamp, 3-revolution roll, toss) | 23 / 12 / 12 / 7 | 17 / 25 / 3 / 5 | 5 / 6 (N=120, from `crocodile.md`) |
| Hippo | Colossal Chomp → **Riverlord's Flood** | 20 / 15 / 12 / 5 | 22 / 17 / 12 / 2 | 10 / 5 (N=300) |
| Rhino | Seismic Stampede (3 s run-through) → **Seismic Stampede** (homing gore, carry, crush) | 13 / 13 / 7 / 2 | 13 / 13 / 8 / 8 | 8 / 5 (N=300) |
| Eagle | Death From Above (aimed dive) → **Death From Above** (lock, reticle, committed stoop) | 3 / 12 / 5 / 8 | 3 / 13 / 20 / 17 | 16 / 12 (N=120) |
| Panther | Night Prowl → **Shadow Execution** | 3 / 7 / 7 / 17 | 13 / 7 / 7 / 7 | 15 / 8 (N=120) |
| Python | Constrictor's Embrace → **Coil Snare** | 5 / 5 / 15 / 7 | 5 / 7 / 12 / 12 | not taken |
| Giraffe | Guillotine Spin → **Timber Fall** | 3 / 10 / 10 / 17 | 3 / 7 / 5 / 22 | 9 / 13 (N=200) |
| Mole | Sinkhole → **Sinkhole Vortex** | 2 / 2 / 13 / 18 | 12 / 3 / 10 / 12 | 12 / 14 (N=120) |

Combined run with all ten new ultimates in the same roster (`N=60 LEVELS=1,2,3,4`, final v1.3 phase 3 sim): win % L1 / L2 / L3 / L4

| Animal | L1 | L2 | L3 | L4 |
|---|---|---|---|---|
| Lion | 10 | 7 | 2 | 7 |
| Gorilla | 13 | 7 | 7 | 12 |
| Crocodile | 15 | 30 | 12 | 13 |
| Hippo | 22 | 17 | 12 | 2 |
| Rhino | 13 | 13 | 8 | 8 |
| Eagle | 3 | 5 | 20 | 7 |
| Panther | 13 | 7 | 10 | 7 |
| Python | 3 | 3 | 8 | 10 |
| Giraffe | 3 | 7 | 5 | 22 |
| Mole | 3 | 5 | 17 | 13 |

0 timeouts at every level; ults per fighter per match 0.57 / 0.99 / 1.04 / 1.17 (L1 to L4). Average match 44 / 41 / 89 / 93 s.

Watch list (cells at or near the edge of the band): lion at L3 (2–3 % at N=60 and 3–4 % at N=120, the lowest cell in the roster; a full sequence also costs the lion about 170 HP from third parties), crocodile at L2 (25–30 % at N=60, at the L1/L2 ceiling) and at L3/L4 (3–5 % at N=60, 5 / 6 % at N=120: Veteran and Apex bots dodge the lock zone), hippo at L4 (5 % at N=300, unchanged from v1.2: Apex bots sidestep the marked flood path), giraffe at L4 (13 % at N=200; the 22 % N=60 cell is seed noise), eagle at L3 (16–20 %, the top of the band). Python has no larger sample (N=60 only: 12 % at L3 and L4 in its own run, 8 % / 10 % in the combined run).

No-effect sim cleanups in phase 3 (the N=60 table above is byte-identical before and after, apart from the wall-time suffix): the knockdown fall/hold/rise clock (`Fighter.knockdownClock` feeding `state.actionT/actionDur`, cosmetic only) and the removal of the dead Night Prowl stealth-crit code path (`stealthCritPending`).

## v1.2 (WP-N): body hitboxes, eagle soar, arena traps

Spec: `docs/UPGRADE-PLAN-v1.2.md` §3 and §5b. The v1.1 report below still describes the method and the v1.1 changes. All v1.2 numbers are in `src/config/animals.ts`, `src/config/traps.ts`, `src/config/balance.ts` (`MOVE.groundHitMaxAltitude`) and `src/config/botProfiles.ts` (`AI_TUNING.soar*`, `trapAwareness`, `soarUse`).

### What changed and why
| Change | Numbers | Why |
|---|---|---|
| **Melee = sector–circle overlap** (`hitbox.meleeArcHit`, same padding in `coneHit`): hit iff `dist − r ≤ range` and angle ≤ arc/2 + asin(min(1, r/dist)); a body over the attacker's centre always counts | — | "What you see is what you hit": any body that pokes into the drawn sector is hit. v1.1 tested only the target's centre, so big bodies were missed while their body was inside the arc, and the arc edge cut through bodies |
| **Basic ranges retuned** (now measured to the target's body) | lion 2.2 → **1.5**, gorilla 2.3 → 1.6, croc 2.4 → 1.9, hippo 2.6 → 2.15, rhino 2.6 → 2.15, eagle 2.0 → 1.3, panther 2.1 → 1.4, python 3.0 → 2.2, giraffe 3.4 → 2.7, **mole 2.0 → 1.3** | Started at old − 0.7, about the mean body radius (0.8), so reach against an average body is unchanged: a lion still reaches a lion-sized body at 2.2 m centre to centre. Big bodies are now bigger targets (reach against a hippo grows 0.5 m), so the big animals kept a little more (croc, hippo, rhino −0.5 to −0.45). Order kept: giraffe > python > hippo = rhino > croc > gorilla > lion > panther > eagle = mole. `statPips.rng` is unchanged (same order) |
| `swingImpact` event at every basic impact tick (exact pos / yaw / range / arc / step; gorilla slam 360° × 2.5 m) | — | The renderer draws the real sector at the impact instant |
| Crate hits use the same sector test (crate = 0.5 m circle) | — | Crates behind a swing are no longer hit |
| **Hippo** | HP 1100 → **1250**, speed 5.4 → **5.7**, River Rush cd 6.5 → **6** s, card HP pip 4 → 5 | The body hitbox hurt the biggest body most: it was at 0–3 % at L4 before this. It is still the level-split animal: strong against Cubs (26 %), 5 % at L4 |
| **Eagle soar** (`perks.glide` + `perks.soar`) | flight 4 s (was a 2.5 s glide); glides at 8 m/s at 1.6 m; starts climbing after 0.15 s at 4 m/s (accel 20) up to **6.5 m**; attack lock **above 3.2 m**; descent ≤ 10 m/s; flight cooldown **8 s from touchdown** (was 6 s from release) | Dodge by altitude, with a real cost: no attack, block, special or ult up high, and the cooldown only starts on landing. The cooldown went from 6.5 to 8 s because at 6.5 s the Apex eagle was the L4 outlier (19–20 % wins, best placement) |
| **Ground reach** | ground AoEs, charges, grab lunges, aim snap and pickups ignore fighters more than **2.5 m** up; melee keeps \|Δy\| ≤ 2.2 m (giraffe 3.2 m) | Nothing on the ground can hit a soaring eagle; a gliding one (1.6 m) can still be hit |
| **Landing slam** | peak ≥ **3.0 m** → `min(40, 20 + 3 × peak)` (29–39.5), radius **3.2 m**, knockback **2 m**, recovery **0.4 s** | The brief asked for "not too much". The cap (40) is below Gale Burst (45) and a sixth of Death From Above (240), and the recovery is a real punish window. This deviates from the plan's 30 + 4/m ≤ 55, which could out-damage Gale Burst |
| **Traps** (`config/traps.ts`) | count 2/3/5/7 (L1–L4); active **8 s**; re-arm after **20 s**; fire r 2.0 m, **7 per 0.5 s** (14/s); spikes r 1.8 m, **25 per 0.8 s**; hazard height 1.0 m (fire) / 0.6 m (spikes) | Started at the plan's 12/s and 20 per stab. The data showed traps at 0.1–0.9 % of damage, so they got a little more bite (fire 12 → 14/s, spikes 20 → 25) and stay flavour |
| **Bots** | Cub ignores traps. Fighter steps out of hazards and sidesteps plates squarely ahead. Veteran routes around plates and hazards. Apex also stops chasing a target into an active hazard. Veteran/Apex eagles soar over long telegraphs (windup ≥ 0.8 s) and when below 35 % HP with a foe within 4 m; Apex also soars out of a 4-foe pile-up. They home onto a foe after 1.2 s, release within 2.2 m of it, and always release at least 0.4 s before the flight limit. Veteran/Apex drop a target that is soaring out of reach. Every "in reach" check now adds the target's body radius | Plates are visible to everyone, so reading `snapshot.traps` is fair. The stuck detector's "not yet in reach" test now uses the same body-radius reach; a leftover v1.1 margin caused one L1 stall in 200 matches until it was fixed |

### Acceptance run: `N=60 LEVELS=1,2,3,4 npm run balance` (traps on, win % / avg place)
| Animal | L1 | L2 | L3 | L4 |
|---|---|---|---|---|
| lion | 8 % / 5.27 | 10 % / 5.40 | 8 % / 5.52 | 7 % / 6.03 |
| gorilla | 13 % / 4.48 | 3 % / 5.75 | 5 % / 5.70 | 10 % / 5.12 |
| crocodile | 23 % / 4.38 | 12 % / 4.23 | 12 % / 5.23 | 7 % / 5.25 |
| hippo | 27 % / 3.87 | 20 % / 5.07 | 17 % / 4.75 | 3 % / 5.78 |
| rhino | 12 % / 4.38 | 20 % / 4.63 | 7 % / 5.73 | 7 % / 6.40 |
| eagle | 3 % / 7.12 | 12 % / 5.12 | 5 % / 5.48 | 8 % / 4.25 |
| panther | 3 % / 5.75 | 7 % / 6.23 | 7 % / 6.28 | 17 % / 5.55 |
| python | 5 % / 6.22 | 5 % / 6.62 | 15 % / 6.05 | 7 % / 5.73 |
| giraffe | 3 % / 6.03 | 10 % / 5.80 | 10 % / 5.17 | 17 % / 5.52 |
| mole | 2 % / 7.50 | 2 % / 6.15 | 13 % / 5.08 | 18 % / 5.37 |
| **timeouts** | 0 | 0 | 0 | 0 |
| **avg match** | 44 s | 42 s | 87 s | 94 s |
| **trap share of damage / trap deaths** | 0.9 % / 0 | 0.3 % / 0 | 0.1 % / 0 | 0.2 % / 0 |
| **eagle slams / match** | 0 | 0.13 | 1.43 | 2.02 |

L3 is 5–17 %, and the L1/L2 top animals are at 27 % / 20 % (target ≤ 30 %). L4 is 7–18 % apart from the hippo at 3 % (2 wins). At N=60 a single cell has a standard error of about ±4 points. The hippo's N=200 rate is 5 % with traps and 8 % without (below), so most of the 3 % is sampling. The hippo is still the weakest L4 animal, as it was in v1.1 (§6). Average match lengths are not inflated (v1.1: 52 / 48 / 93 / 99 s).

### Traps vs no traps (same seeds, N=200 per level, `COMPARE=1 N=200 npm run balance`)
| Level | triggers / match | trap dmg / match | per fighter | share of all damage | trap deaths / match (share) | avg match off → on | largest \|Δplace\| |
|---|---|---|---|---|---|---|---|
| L1 (2 traps) | 1.0 | 99 | 9.9 | 1.0 % | 0.03 (0.3 %) | 45 → 45 s | 0.16 (gorilla) |
| L2 (3) | 1.4 | 38 | 3.8 | 0.3 % | 0.01 (0.1 %) | 41 → 43 s | 0.23 (panther) |
| L3 (5) | 1.1 | 21 | 2.1 | 0.2 % | 0.01 (0.2 %) | 87 → 88 s | 0.28 (python) |
| L4 (7) | 1.4 | 26 | 2.6 | 0.2 % | 0.01 (0.2 %) | 96 → 99 s | 0.62 (giraffe, better with traps); next are mole +0.43 and eagle −0.41 |

Win % / avg place at N=200, traps **on** · **off**:

| Animal | L1 | L2 | L3 | L4 |
|---|---|---|---|---|
| lion | 7/5.66 · 8/5.62 | 13/5.35 · 10/5.18 | 9/5.52 · 14/5.40 | 11/5.35 · 14/5.21 |
| gorilla | 12/4.72 · 11/4.88 | 9/5.40 · 12/5.62 | 8/5.58 · 5/5.82 | 8/5.51 · 5/5.33 |
| crocodile | 22/4.10 · 26/4.02 | 12/4.84 · 14/4.87 | 8/5.38 · 8/5.21 | 8/5.29 · 8/5.16 |
| hippo | 26/3.53 · 23/3.50 | 12/4.95 · 15/4.88 | 14/4.92 · 12/5.07 | 5/5.82 · 8/5.91 |
| rhino | 13/4.39 · 13/4.39 | 17/4.86 · 13/4.83 | 5/5.64 · 11/5.54 | 5/6.28 · 8/6.09 |
| eagle | 5/6.71 · 5/6.68 | 12/5.03 · 8/5.05 | 11/5.00 · 12/4.90 | 13/3.96 · 12/4.37 |
| panther | 6/6.25 · 5/6.29 | 6/6.01 · 6/6.25 | 10/5.99 · 8/6.12 | 13/5.78 · 10/5.79 |
| python | 4/6.36 · 5/6.39 | 7/6.09 · 6/6.11 | 8/6.44 · 8/6.16 | 10/5.78 · 12/5.72 |
| giraffe | 5/6.04 · 5/6.00 | 11/6.07 · 9/5.91 | 10/5.67 · 9/5.88 | 15/5.46 · 11/6.08 |
| mole | 3/7.24 · 2/7.22 | 3/6.41 · 9/6.31 | 19/4.87 · 14/4.92 | 13/5.78 · 15/5.34 |

- **Traps are flavour.** They cause at most 1 % of all damage (at the Cub level, where bots walk into them) and 0.1–0.3 % of deaths. They don't lengthen matches, and 39 of the 40 placement deltas are ≤ 0.43. The one larger delta (giraffe −0.62 at L4) is about 2 standard errors of a paired N=200 difference (≈ 0.3), which one cell in 40 is expected to reach by chance. At L4 traps deal 2.6 damage per fighter per match, far too little to move a placement by 0.6.
- **True rates (N=200, traps on):** L3 5–19 %, L4 5–15 %. The eagle wins 11 % at L3 and 13 % at L4, so it is not the win-rate outlier. It still has the best average L4 placement (3.96) because soaring is a survival tool. The mole's 19 % at L3 is within noise of 18 % (14 % without traps).
- **Human fairness:** `tests/ai/fairness.test.ts` still passes. The fastest Cub needs 16.0 s to kill an idle 760-HP eagle. Dropping the eagle to 720 HP was tried as its nerf, but that broke the guard (14.4 s), so the flight cooldown was nerfed instead.

### Tuning trail (N=100–200, L3/L4)
- Ranges at old − 0.7 across the board left the big bodies weak at L4 (hippo 0–3 %, rhino and croc 3–5 %) and put the eagle at 20 %. The big bodies got −0.45 to −0.5 instead, plus the hippo body buffs above.
- Eagle nerfs compared at L4 (N=200): HP 700 → 11 %, cooldown 8 s → 14 %, no pile-up soar → 14 %, landing recovery 0.6 s → 15 %. Chosen: cooldown 8 s, plus the Apex pile-up trigger raised from 2 to 4 foes. HP stays at 760 for the fairness guard.
- With the soar AI switched off entirely (the eagle still hop-glides), the eagle was at 16 % at L3. Most of its strength comes from the smaller body hitbox and the altitude dodge, not from the bot script.

---

# v1.1 report (WP-J)

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
