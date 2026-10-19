# Ocean Dome v1.10 — upper platforms, a second (high) serpent, fall damage

**User request (2026-10-19):** "for the new map the terrain isn't interesting enough, can you add some depth to make it more challenging
like making more platforms to be accessed through ramps go much higher and allow for combat at another altitude in the arena. also add a
second serpent triggered in the same timeframe with the same spawn chance that targets upper platform height and ensure the first one
targets lower platform heights and does not conflict with upper platform placement. add a fall damage mechanic as well from falling off
the higher platform to the bottom platform instead of taking the ramp. it should be a fixed damage of 50. update the version afterwards."

Binding for every work package. Builds on `docs/OCEAN-PLAN.md` (v1.9/v1.9.1: terrace 1.5 m, plateau 3 m, 9 ramps, one serpent rolling
50 % every 20 s). Release number: **v1.10.0** (sim rules + wire format change → MINOR; protocol 3 → **4**).

## 1. Decisions (architect)

1. **The height field stays single-valued** (`arenaGroundHeight(x, z)`; 50 call sites in sim/AI/render must keep working). So the new
   upper "platforms" are **solid sea-stacks (towers)** that rise out of the lower levels, tops at **`OCEAN_UPPER_HEIGHT = 6.5 m`**
   (the terrace is 1.5, the plateau 3.0). You cannot walk *under* them. They are `plateau` pieces (round tops) reached by `ramp` pieces.
   Dome is 22 m high: no clearance problem.
2. **Two serpents, independent lanes** ("same timeframe, same spawn chance"): at every roll time (`SERPENT.intervalS`, 20 s of live time)
   the LOW serpent and the HIGH serpent each roll `SERPENT.chance` (50 %) **independently** (own RNG stream each; both can come at once,
   25 % of rolls; neither, 25 %). Event timeline/damage are the same as v1.9.1 (warn 1.1 s → strike 0.44 s → hold 0.35 → retreat 0.8;
   strip half-width 1.8 m; 300 true damage once per event per fighter).
3. **Bands by GROUND height under the fighter** (not its own y): `arenaSerpentBand(arena, x, z)` = `'high'` iff
   `arenaGroundHeight >= hazards.serpentSplitY` (**4.5 m**), else `'low'`. The LOW serpent hurts fighters over low ground, the HIGH serpent
   fighters over high ground (upper platform tops + the upper part of their ramps). The v1.9 altitude rule stays: only fighters whose
   altitude above the LOCAL ground is ≤ `SERPENT.hazardHeight` (3 m) are hit (a soaring eagle is untouched).
4. **No conflict with upper platforms (lanes):** `src/config/serpentLanes.ts` (already written, pure): the LOW serpent's strike angle is
   drawn only from bins whose whole padded strip stays on LOW ground (never runs over/through/alongside an upper platform or the high part
   of its ramp); the HIGH serpent's only from bins whose centre line runs ≥ 2 m over HIGH ground (every high event threatens the upper
   platforms). The layout must leave **≥ 150 low bins and ≥ 80 high bins** (of 360).
5. **Fall damage:** `hazards.fallDamage = { minDrop: 3.4, damage: 50 }` (Ocean only). A fighter that lands after dropping ≥ 3.4 m from the
   height where it last stood (`lastGroundY`), takes **exactly 50 TRUE damage** once per landing (no block/guard/armour/buff change, no
   credit, no ult charge, like traps and the serpent; death = `killerId −1, cause 'fall'`). Any fall counts (walking off, knockback, pounce).
   Exempt: flyers (the eagle), burrowed/untargetable fighters. Heights: upper top 6.5 → plateau 3.0 is 3.5 m (**damage**), plateau →
   seabed is 3.0 m (no damage), terrace anywhere no damage. Taking the ramp never damages.
6. **Visual identity:** low serpent unchanged (red-orange strip); the high serpent is clearly different (cool violet/magenta strip + model
   tint) and its head sweeps at ~`OCEAN_UPPER_HEIGHT + 2` m, i.e. over the upper platforms; its warning strip is drawn only on HIGH ground
   (plus a faint overhead ribbon wall → centre). The low strip is never drawn on high ground (guaranteed by the lanes).

## 2. Contract (already in the tree — code against it)

- `core/types.ts`: `SerpentTier = 'low'|'high'`; `WorldSnapshot.serpentHigh?: SerpentState` (the LOW serpent stays `serpent`);
  `serpentWarning/Strike/Hit/End` gained optional `tier?: SerpentTier` (**absent = low**; the sim emits `tier` only for the high
  serpent); new event `{ type:'fall'; fighterId; damage; drop; pos }`; `death.cause?: 'serpent' | 'fall'`.
- `config/arenas.ts`: `ArenaHazards { serpent?; serpentSplitY?; fallDamage? }`, `arenaHasHighSerpent(arena)`, `arenaSerpentBand(arena,x,z)`.
- `config/serpentLanes.ts`: `SERPENT_LANES`, `serpentLaneBins(arena)`, `pickLaneAngle(arena, tier, rng)` (exactly two RNG draws; −1 when
  the lane has no bin), `stripMaxGround`, `stripHighLength`.
- Constants to add in `config/arenas.ts` by WP-H1: `OCEAN_UPPER_HEIGHT = 6.5`, `OCEAN_SERPENT_SPLIT_Y = 4.5`,
  `OCEAN_FALL_MIN_DROP = 3.4`, `OCEAN_FALL_DAMAGE = 50`, and `OCEAN_ARENA.hazards = { serpent: true, serpentSplitY: 4.5, fallDamage: {…} }`.
- `tsc` currently fails ONLY in the net codecs/tables (exhaustive `fall` event maps) — WP-H2 fixes that.

## 3. Work packages (all Sonnet 5.5; disjoint file ownership)

**Wave 1 (parallel):**
- **WP-H1 layout** (`src/config/arenas.ts` ocean section, `tests/config/**`, `tests/sim/ocean.*` as needed, `scripts/ocean-layout.ts`):
  design and implement the upper tier. Rules: keep terrace/plateau/seabed levels and radii; add **3 or 4 upper platforms** (round tops,
  radius 2.8–3.6, top `OCEAN_UPPER_HEIGHT`) rising from the terrace/plateau area; every platform reached by ≥ 1 ramp (grade ≤ 0.40, width
  ≥ 3.6 m, longest allowed rise = the ramp's own; a ramp's high end tucks 0.4–0.6 m under the platform edge, its low end sits flush on the
  level below); ≥ 2 platforms with TWO ramps (flanking routes); a ramp to the upper tier must not block the existing level ramps (move/
  trim the existing 9 ramps, cover, pads and crates where needed; every level stays reachable by ramps from every spawn); ≥ 1 pickup pad on
  each upper platform (more pads overall is fine; pad ids are the array index); cover (coral/rock) on upper platforms is welcome but never
  on a ramp or within 1 m of an edge; platform outer edges must be real cliffs (a drop ≥ 3.4 m to the level below on the cliff side). Set
  `hazards` as in §2. Validate with tests: reachability for the largest body (radius 1.2) from all 10 spawns to every pad and every platform
  top via `arenaCanWalk`/ramps; no ramp > grade 0.4; low/high lane bins ≥ 150 / ≥ 80; trap placement still gives the full count for every
  difficulty over many seeds (stacks can host traps only if the site is wholly level — fine either way); solids' `baseY` correct; spawn
  seats ≥ 3 m from any cliff. `scripts/ocean-layout.ts`: ASCII height map (1 m cells, one character per height band, ramps marked) + the
  bin counts, for QA. Update existing ocean layout tests to the new layout (don't weaken them).
- **WP-H2 sim + net** (`src/sim/**`, `src/online/**`, `src/core/**` only for fixes, `tests/sim/**`, `tests/online/**`, `docs/ONLINE-NOTES.md`):
  (a) `SerpentSystem` becomes two lanes (low keeps `SERPENT.seedSalt`, high uses `SERPENT_LANES.highSeedSalt`; both roll at the same
  times with the same `chance`; angles via `pickLaneAngle`; a lane with no bins or an arena without `serpentSplitY` has no high lane;
  hit test per lane = fighter band matches the lane's tier + altitude ≤ hazardHeight above local ground; snapshot `serpent` + `serpentHigh`;
  events with `tier` for the high lane only; options `chance/intervalS/firstAtS` apply to both lanes plus `lanes?: readonly SerpentTier[]`;
  `debugTriggerSerpent(angleDeg, tier = 'low')`); (b) FALL DAMAGE per §1.5 (`Fighter.lastGroundY`, landing detection in MovementSystem, env
  damage through the same callback as traps/serpent, `fall` event, death cause); (c) net: snapshot codec carries `serpentHigh`, the four
  serpent events carry the tier, `fall` event + death cause byte, id-swap tables, `data fingerprint` covers lanes/fall/splitY/hazards,
  **`ONLINE_PROTOCOL_VERSION` 4**, update `docs/ONLINE-NOTES.md`. Tests must not depend on WP-H1's real layout (use a synthetic arena: flat
  ocean-like heightfield with one 6.5 m round platform + ramp, `hazards` set) — plus one integration test against `OCEAN_ARENA` that is
  skipped until its `hazards.serpentSplitY` is defined, then runs. The colosseum and jungle must stay byte-identical (identity-hash chains:
  `scripts/identity-hash.ts`, expected chains cd997f25 colosseum / 7ab4f15e jungle).

**Wave 2 (after wave 1, parallel):**
- **WP-H3 bots** (`src/ai/**`, `scripts/balance-sweep.ts`, `docs/BALANCE.md`): NavGrid/Navigator on the new tier (steeper ramps), fall-damage
  awareness (never plan or take a drop ≥ minDrop except L1-L2 noise or when fleeing at high HP; steering must not walk off a high platform
  edge by accident), `SerpentSense` for TWO lanes (react only to the lane of the bot's own band, plus the lane of the band it is about to
  enter), some pull toward upper pads, sweeps (`ARENA=ocean N=60`) incl. per-lane serpent readout and fall-damage readout (falls/match,
  share of deaths), no stalls ≥ 300 frames, no timeouts.
- **WP-H4 render + audio** (`src/render/**`, `src/audio/**`): upper platforms/cliffs/ramps in `terrain.ts` (+ props: coral crowns), high
  serpent FX (second `SerpentFx` driven by `snapshot.serpentHigh` + events with `tier:'high'`, violet identity, high-level path, strip only
  on high ground, overhead ribbon), fall FX (impact dust/bubble burst, shake for the local player) + audio (high-serpent klaxon variant,
  fall thud), camera vs the taller terrain, `?demo=ocean` presets for the upper tier and both serpents, perf check.
- **WP-H5 UI** (`src/ui/**`, `src/match/**`, `src/online/ui/**`, `src/styles/**`): serpent HUD for two lanes (banner text per lane, rim
  chevron colour per lane, MOVE!/SAFE evaluated against the lane of the player's own band; spectator: both banners), kill feed text for
  `cause:'fall'` ("fell from the heights"), a fall-damage flash/number for the local player, `MatchController` forwards `fall` + tiered
  serpent events to the arena scene, map blurb/thumbnail (`mapThumb`) shows the upper platforms, QA shortcut `?br=1&arena=ocean&serpent=1|low|high|both…`.

## 4. Verification (architect)
tsc 0 · full vitest · build · identity chains unchanged · ocean balance sweeps all levels (0 timeouts, stalls < 300) · browser pane:
upper platforms, ramps, both serpents' warning/strike, fall damage popup · release 1.10.0 (CHANGELOG, HANDOFF, installer, smoke, push).
