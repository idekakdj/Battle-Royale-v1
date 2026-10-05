# Champions League — two dynamic maps (v1.6)

Binding plan. Contracts (already in `src/brawl/types.ts`): `StageId` gains `clockworkHeights` and `crumblingAmphitheatre`; `PathSpec`;
`PlatformDef.path / breakable / finalOnly`; `PlatformState.active / hp / maxHp`; events `platformHit / platformBreak / stageFinal`.

## Map 3 — Clockwork Heights (`clockworkHeights`): the layout never stands still

A floating brass-and-stone clockwork: a wide **core slab that drifts around** and **satellite platforms that glide between three layouts**
on a shared 36 s loop (so the arrangement is always changing, but always fair and readable).

* `core` — solid, x ∈ [−6.5, 6.5], y 0, thickness 3.2, ledges on both ends, `path` periodS 40 (gentle loop: ≈ ±3.5 m sideways, ≈ −1 … +2.2 m vertically, max speed ≤ 2.5 m/s).
  It is the only solid platform and it MOVES: riders are carried; fighters beside/under it are pushed out (no tunnelling, nobody can be stuck inside).
* Four soft satellites (width ≈ 4.5, thickness 0.5) share `periodS 36` and `keys` that hold each of three layouts for ≈ 6 s and glide between them for ≈ 6 s with cosine easing:
  A "cross" (two high wings + two upper-centre planks), B "stair" (a diagonal staircase from low-left to high-right + a floating bridge), C "orbit" (planks circling the core).
  Hard design rules (tests enforce): at ANY frame at least two satellites are within jump reach of the core top (≤ 4.6 m above and ≤ 5 m sideways of a ledge/centre); satellites never overlap each other
  (≥ 0.6 m clear); every position over the whole loop is inside the blast zones; max platform speed ≤ 3.5 m/s.
* Blast: left −32, right 32, top 24, bottom −18. Camera half-width 12–22. Spawns on the core at frame 0 (x −5, −1.7, 1.7, 5). Respawn (0, 12).
* Look: dusk-teal/violet sky, giant slowly turning cogs and an astrolabe ring in the background, brass trim + glowing runes on the platforms, thin rails/chains hinting at the paths,
  soft glow trails on the moving satellites, cog-tick audio optional.

## Map 4 — Crumbling Amphitheatre (`crumblingAmphitheatre`): break it, and it becomes something else

Starts as an intact ruined amphitheatre. Six **breakable** pieces take counted hits from fighters' attacks; when the LAST one falls the arena flips to its **final form**
(new `finalOnly` platforms rise, lighting and sky change). Counting rule: every damaging attack activation (one per attacker per move, ≥ 20 frames between counts from the same
attacker) whose hitbox overlaps the platform rect counts as one hit; multi-hit boxes count once per activation. A destroyed platform stops colliding, its ledges vanish, fighters standing on it fall.
* Unbreakable: `floorL` solid x ∈ [−13, −8.5], `floorR` solid x ∈ [8.5, 13] (y 0, thickness 3.5; their OUTER ledges are always grabbable; the INNER ledges are grabbable only while the corner is exposed —
  i.e. not covered by an active adjacent platform at that height).
* Breakable (intact layout): `tileL` solid x ∈ [−8.5, −3], `tileC` solid x ∈ [−3, 3], `tileR` solid x ∈ [3, 8.5] (y 0, thickness 3.5, 6 hits each — breaking them opens pits to the bottom blast zone);
  `archL` soft [−10, −5.5] and `archR` soft [5.5, 10] at y 4.4 (4 hits each); `crown` soft [−2.5, 2.5] at y 7.8 (4 hits).
* Final form (`finalOnly`): `sunL` soft [−11, −6] y 3.0, `sunR` soft [6, 11] y 3.0, `core` solid [−3, 3] y 1.4 thickness 2 with both ledges, `halo` soft [−2.5, 2.5] y 6.4 — plus the two unbreakable outer floors.
  The final form must be playable on its own (two ledged islands + a ledged centre + three soft platforms). Tuning target: with L3 bots in duels the final form arrives around 60–130 s (not before 30 s, and in most matches before the clock ends);
  adjust hit counts if the sweeps say otherwise.
* Blast: left −30, right 30, top 22, bottom −17. Camera half-width 11–19. Spawns x −7, −2.5, 2.5, 7 on the intact tiles. Respawn (0, 12).
* Look: torch-lit interior of a ruined arena: tiers of seats and arches behind, braziers, a broken colossus; breakables show 3 crack stages from `hp/maxHp`, shed dust on every counted hit, break into falling chunks with a dust burst + shake;
  the FINAL FORM moment is a set piece: rumble, white-gold shockwave, new golden platforms rising with a glow, torches turning blue/white, sky cracking open to a dawn.

## Work packages (Sonnet 5.5 agents; disjoint files)

| WP | owns | notes |
|---|---|---|
| **M1 sim + data** | `src/brawl/sim/**`, `src/brawl/data/stages.ts` (+ helpers), `src/brawl/config.ts` (new constants), `tests/brawl/sim*`, `src/online/room/fingerprint.ts` if stages must enter the fingerprint | path motion; solid moving platform carry + push-out; breakables; final form; events; state/checksum; both stage definitions; tests; rollback matrix on the new stages |
| **M2 bots + balance** | `src/brawl/ai/**`, `scripts/brawl-balance.ts`, `docs/CHAMPIONS-LEAGUE-BALANCE.md` | dynamic-platform awareness from `snapshot.platforms`; recoveries onto moving/disappearing platforms; per-stage sweeps; stall/timeout/SD checks |
| **M3 render + UI** | `src/brawl/render/**` (stages, vfx, camera extents, debug), `src/brawl/ui/{BrawlSetup,stageThumb}.ts`, `src/online/ui/**` stage pickers, `src/styles/*` | two stage scenes; dynamic platform meshes from the snapshot; break/final FX; stage cards (2×2) with thumbnails + "moving"/"breakable" badges; online room stage picker |

Rollback/online: dynamic stage state (breakable hp, destroyed flags, final flag, per-attacker hit cooldowns) is part of `saveState/loadState/checksum`; the data fingerprint must change when stage data changes;
this is a SIM change so the release bumps the MINOR version (1.6.0).
