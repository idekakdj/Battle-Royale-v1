# Champions League — platform-fighter mode (v1.4.0)

Binding plan + contract for the new game mode. Read this fully before touching code. The shared types are
`src/brawl/types.ts` (architect-owned; extend additively and report it). Everything for the mode lives under
`src/brawl/**` (plus the few integration points in §11). The Battle Royale mode must keep working unchanged.

## 1. What it is

A Brawlhalla / Smash-style platform fighter starring the same 10 animals:

* **Side view, 2.5D.** The simulation is 2D (X right, Y up, metres, fixed 60 Hz); the picture is the existing 3D
  procedural animal rigs on 3D stages, seen by a side camera. Fighters live on the plane z = 0.
* **Damage percent + knockback.** Hits add percent; the higher your percent, the farther the next hit launches you.
  Leave a **blast zone** (left/right/top/bottom) and you lose a **stock**. Last fighter with stocks wins.
* **2–4 fighters**, free-for-all: you vs 1–3 bots (difficulty 1–4). Default 3 stocks, 5 min limit.
* **Two new maps:** *Broken Colosseum* (classic three-tier ruin) and *Sky Aqueduct* (two floating aqueduct islands,
  a gap, and a moving platform).
* Reworked **movesets**: each animal has 8 attacks (light/heavy × neutral/side/down/up), each with a ground form and an
  aerial form, plus dodge, double jump(s), ledge grab. Heavy-Up is the animal's **recovery** move.
* **Name in the UI: "Champions League"** (lobby nav entry, setup screen, results, changelog). Code namespace: `brawl`.

Non-goals: online play, local multi-controller input, items/pickups, supers (the Battle Royale ultimates are not used).

## 2. Simulation model (`src/brawl/sim/**`, constants in `src/brawl/config.ts`)

Deterministic, headless, seeded mulberry32 only; no DOM/three/Date/Math.random. `new BrawlWorld(config, seed)`
implements `BrawlWorldApi`. Frame = 1/60 s. All times below are frames unless marked.

### 2.1 Movement (starting values; the balance pass may tune `config.ts`/data, not the rules)

* Gravity 38 m/s² × `gravityMult`. Max fall `fallSpeed`; **fast fall** (hold Down while descending, after the apex)
  reaches `fastFallSpeed`. Eagle: holding jump while falling caps fall at `glideFall`.
* Ground: instant-ish acceleration (reach `walkSpeed`/`runSpeed` in ≤ 6 frames, stop in ≤ 4); walk when |moveX| < 0.6.
  Facing = last horizontal input (turn takes effect immediately; attacks fix facing for the move unless `turnOnStart`).
* **Jump:** `jumpSquat` 4 frames, then `jumpVel`; short hop if `jumpHeld` released within 6 frames of takeoff
  (cuts vy to 60%). Air jumps: `airJumpVel`, total jumps `maxJumps` (ground jump counts as 1); jumps reset only on
  landing, ledge grab and respawn (not when hit).
* Air control: accelerate toward `airSpeed` with `airAccel`; no drag when |moveX| = 0 beyond 2%/frame.
* **Platforms:** `solid` blocks from all sides (head-bonk stops upward motion, side contact stops horizontal);
  `soft` is land-from-above only; holding Down while standing on a soft platform drops through (≈ 12 frames of
  pass-through). Moving platforms (`moving`) carry riders (inherit platform velocity while grounded on it; no slingshot).
* **Ledges:** solid platform ends with `ledgeLeft/Right`. Grab when airborne, vy ≤ 0.5, inside a 0.9 × 1.4 m grab box at
  the corner, not holding Down, and the ledge is free. Hang: invulnerable for 40 frames (reduced by 8 per grab within
  the last 4 s, floor 0 — anti-stall), max hang 180 frames then auto-release; options: jump (Jump, full height),
  climb (Up/Left-Right toward the stage, 22 frames), drop (Down), roll-up (Dodge, 28 frames, invulnerable). No regrab
  for 30 frames after leaving.
* **Dodge:** one button. On the ground with no direction = spot dodge; with direction = roll; in the air = air dodge
  (one per airtime, cannot be done in hitstun). Invulnerable for `dodgeInvuln` frames, total `dodgeFrames`, then
  `dodgeCd` = 60 frames before the next dodge (anti-spam). Air dodge leaves the fighter in free-fall (`fall` action
  without jump) until landing — a deliberate recovery risk.
* **Respawn:** after a KO the fighter is out for 90 frames, then appears at `stage.respawn` on a hovering respawn
  platform: invulnerable up to 180 frames, ends early (after ≥ 40) on any attack/jump/dodge or after dropping off.

### 2.2 Combat

* Hurtbox = rect `width × height` standing at `pos` (feet centre). In dodge/respawn/ledge-grace invulnerability
  frames hits skip the victim. Crouch/ground states use the same box (`crouch` may use 0.6 × height).
* Hitboxes (`HitboxDef`) are authored in fighter-local space (forward = +x, mirrored by facing), active in
  `[from, to)` of the move frame counter. A hit is circle-vs-rect or rect-vs-rect overlap with the victim hurtbox.
  One hit per victim per hitbox `group` per move activation (default group = hitbox index) unless
  `multiHitInterval` is set. Two hitboxes of the same move hitting in the same frame: the highest `damage` wins.
  `path` offsets hitboxes over time (sweeping limbs). Clashes: both fighters hit each other (a trade); no
  clash-cancel.
* **Damage & knockback** (all in `config.ts`, applied in `resolveHit`):
  ```
  dmg        = hb.damage × sweet.damageMult? × staleMult           (staleMult: −3% per use of this MoveId in the attacker's last 6 moves, max −15%)
  pctAfter   = victim.percent + dmg                                  (clamped ≤ 999)
  kb (m/s)   = (hb.baseKb + hb.kbGrowth × pctAfter / 100) × sweet.kbMult? × staleMult × (100 / victim.weight)
  kb         = min(kb, 62)
  angle      = hb.angle (mirrored by attacker facing); 'spike' = downward angles allowed to meteor in the air, grounded victims are bounced up instead
  hitlag     = clamp(round(dmg × 0.4) + 4 + hb.hitlag, 4, 16)       attacker AND victim frozen (victim visually shakes)
  hitstun    = clamp(floor(kb × 0.6 × hb.hitstunScale), 6, 60) frames after the hitlag; victim is 'hitstun' (no actions) then 'tumble' if kb > 20
  ```
  Launch velocity = kb along `angle`; during hitstun horizontal speed decays ×0.985/frame, gravity ×0.85.
  **Directional influence (DI):** holding a direction during hitstun rotates the remaining launch vector by up to ±12°
  toward it (bots at L3+ use it).
* **Armor:** `armor` windows absorb `hits` hits (damage × `dmgScale`, no knockback/hitstun) — gorilla/hippo/rhino heavies only.
* **Aerials:** the air form of a move may override fields (`air` partial). Landing during startup/active/recovery adds
  `landingLag`; the `autoCancel` window (late frames) lands with no lag. Heavy-Up (recovery) can be used **once per
  airtime** (reset on landing, ledge grab, being hit, respawn) and may be used on the ground.
* **Light-neutral string:** `chain` bodies = 2nd/3rd hit; pressing Light inside the previous body's `cancels` window
  (onHitOnly = false for the first link so whiffing strings are possible, but the later links are `onHitOnly`) continues.
  Each chain hit uses a high `hitstunScale` so the string is a true combo from 0%.
* **KO:** pos outside `stage.blast` (any side) → `ko` event with `side`, stock −1, killer = `lastHitBy` if the last hit was
  within 4 s; falls/damage stats; `percent` resets to 0. 0 stocks → `ko` state and remains out.
* **Match end:** one fighter left with stocks, or time up → most stocks, then lowest percent, then draw (`winnerId` −1).
  Countdown 3.0 s before control. Pause is handled by the controller (sim just stops stepping).

### 2.3 Directions

Attack direction at the button edge: `moveY > 0.5` → U, `moveY < −0.5` → D, else if `|moveX| > 0.3` → S (and the
fighter turns toward moveX unless the move is armor-locked), else N. In the air Down+Heavy is the dive/meteor slot.

## 3. Move data (`src/brawl/data/**`)

`MovesetDef` per animal (`stats` + 8 `MoveData`). Budgets (frames at 60 Hz; checked by `tests/brawl/moveBudget.test.ts`):

| slot | startup | active | recovery | damage / hit | notes |
|---|---|---|---|---|---|
| lightN (per chain hit) | 4–7 | 2–3 | 8–14 | 3–5 (chain total 9–14) | 3-hit string; low kb; true combo |
| lightS | 6–10 | 3–4 | 12–18 | 6–9 | mid range, moderate kb |
| lightD | 5–9 | 3–4 | 11–17 | 5–8 | low/trip or low popup angle |
| lightU | 6–10 | 3–4 | 12–18 | 6–9 | anti-air / juggle starter (angle 70–100°) |
| heavyN | 12–22 | 3–6 | 20–32 | 10–16 | wide/both-sides or burst; mid-high kb |
| heavyS | 14–26 | 3–6 | 22–34 | 14–22 | the animal's KO move |
| heavyD | 12–22 | 3–6 | 20–32 | 12–18 | ground: area/launcher; air: spike/meteor |
| heavyU | 6–14 | 8–24 | 18–30 | 7–12 | **recovery**: travels (motion), hits on the way |

Aerial `landingLag`: light 6–12, heavy 14–26. Total frames of any move ≤ 62. Heavy attacks have kill power at
**≈ 85–135 %** on a mid-weight target for the animal's best move and ≥ 150 % for its weakest kill move.

### 3.1 Roster (identity, balance levers)

Balance is a rock-paper-scissors of **weight (survivability) × speed × reach × recovery × kill power**. Nobody
tops more than two axes. Starting stats (D may adjust ±10 % to satisfy budgets):

| animal | role | weight | walk | run | air | jump / air-jump | jumps | grav× | fall / fast / glide | hurtbox w×h | recovery | kill power |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| lion | all-rounder brawler | 100 | 4.6 | 8.6 | 6.6 | 14.5 / 13.0 | 2 | 1.0 | 18 / 26 / – | 1.1×1.5 | good | mid |
| gorilla | heavy bruiser | 125 | 3.8 | 7.2 | 5.4 | 13.5 / 12.0 | 2 | 1.1 | 19 / 27 / – | 1.5×2.0 | poor | very high (armor) |
| crocodile | low trapper | 115 | 3.6 | 7.0 | 5.0 | 12.5 / 11.5 | 2 | 1.15 | 21 / 28 / – | 2.0×1.0 | poor | high |
| hippo | wall / big hits | 140 | 3.2 | 6.2 | 4.6 | 12.5 / 11.0 | 2 | 1.2 | 22 / 29 / – | 1.8×1.5 | worst | very high (armor) |
| rhino | momentum charger | 130 | 3.6 | 7.6 | 5.0 | 13.0 / 11.5 | 2 | 1.15 | 21 / 28 / – | 1.9×1.7 | poor | high |
| eagle | air skirmisher | 78 | 5.2 | 9.4 | 8.0 | 15.0 / 13.5 | 4 | 0.8 | 14 / 24 / 6.5 | 1.0×1.2 | best | low |
| panther | assassin / combo | 90 | 5.0 | 9.8 | 7.0 | 15.0 / 13.5 | 2 | 0.95 | 18 / 27 / – | 1.1×1.3 | good (blink-leap) | low–mid |
| python | long-reach controller | 85 | 3.9 | 7.0 | 5.8 | 13.5 / 12.5 | 2 | 0.9 | 16 / 24 / – | 1.5×1.0 | mid | mid |
| giraffe | tall zoner | 98 | 4.2 | 7.8 | 6.0 | 14.0 / 12.5 | 2 | 1.0 | 18.5 / 26 / – | 1.0×2.6 | good | mid–high (tip) |
| mole | tiny trickster | 72 | 5.0 | 8.8 | 6.4 | 14.0 / 12.5 | 2 | 0.95 | 17 / 25 / – | 0.8×0.8 | good (drill) | low |

Dodge for all: invulnerable 14 frames, total 26 (heavier animals +2 total, lighter −2).

### 3.2 Movesets (names + intent; exact numbers are D's, within §3 budgets)

Each lists lightN (3-hit string unless noted) / lightS / lightD / lightU / heavyN / heavyS / heavyD / heavyU(recovery).

* **Lion** — Claw Flurry (swipe, backhand, rake) / Pounce Swipe (lunging swipe, small forward step) / Low Rake (sweeping paw, low pop-up) /
  Uppercut Claw (arc, juggle starter) / Roar Wave (rear up and roar: short-range two-sided burst, flinch + push) /
  Maul Bite (forward leap-bite; jaw sweetspot = kill) / Paw Slam (both paws down; air = spike) / Leap Rake (rising leap, 4.5 m up, hits on the way).
* **Gorilla** — Hammer Fists (2 hits) / Backhand Smash (wide arc) / Knuckle Drag (low sweep) / Thump Uppercut (launcher) /
  Chest Drum (armored start, two-sided shockwave) / Silverback Swing (huge overhand, armor, KO move) /
  Double-Fist Slam (ground stagger, air spike) / Vine Leap (short climbing leap — weak recovery).
* **Crocodile** — Snap-Snap (2 bites) / Tail Flick (tail sweeps behind then front) / Low Snap / Head Toss (jaw flips up) /
  Death Roll (spin, multi-hit, pulls victims in) / Lunge Bite (long lunge, big damage, high risk) / Tail Slam (spike in air) / Rising Snap (short upward lunge).
* **Hippo** — Head Bonk (2 hits) / Belly Bump (wide, pushes) / Stomp Step (low) / Tusk Toss (up) / Mighty Yawn (armored huge frontal maw, KO) /
  Charging Gape (forward lunge-bite, armor) / Belly Flop (ground quake; air = meteor with large landing lag) / Bubble Surge (hop with splash — worst recovery).
* **Rhino** — Horn Jabs (2 hits) / Horn Sweep / Hoof Scrape (low) / Horn Toss (up launcher) / Stomp Tremor (grounded two-sided shockwave, pops up) /
  Rhino Charge (dash, armored first half, long travel, KO) / Dive Gore (diagonal downward spike) / Skyward Gore (rising horn thrust — poor recovery).
* **Eagle** — Talon Slash (3 quick) / Wing Buffet (slap + push) / Talon Drop (downward claw) / Beak Flick (up peck) /
  Gale Burst (flap shockwave, low damage, big push) / Piercing Dive (diagonal stoop; beak-tip sweetspot = KO) / Stoop (straight-down meteor) /
  Soaring Updraft (largest vertical + drift, best recovery). 4 jumps (3 air flaps) and glide.
* **Panther** — Claw Triple (3 fast) / Shadow Slash (lunging) / Low Slash / Rising Claw / Pounce Spin (claw spin, both sides) /
  Shadow Dash (dash THROUGH the opponent, invulnerable startup, hit at the end — KO) / Dive Claw (diagonal down aerial) / Shadow Leap (vanishing upward leap with brief invulnerability).
* **Python** — Fang Strike (2, long poke) / Tail Lash (long horizontal whip) / Ground Sweep (low tail) / Rising Coil (body arcs up) /
  Constrict (self-coil burst: pull-in multi-hit, stun) / Venom Lunge (long lunge, slow, strong) / Coil Drop (body slam, small area) / Spring Coil (compress, launch up/forward).
* **Giraffe** — Neck Jab (2, long poke) / Long Kick (front leg) / Hoof Stomp (low) / Neck Lift (neck whipped upward, anti-air) /
  Neck Spin (360° whip; head-tip sweetspot) / Skull Hammer (overhead neck slam, KO) / Axe Kick (downward; air = spike) / Neck Stretch (fast vertical stretch ending in a headbutt).
* **Mole** — Claw Dig (3 quick) / Dirt Fling (short flinching cone) / Low Dig / Earth Pop (uppercut) /
  Drill Spin (spin drill, multi-hit) / Tunnel Lunge (drill dash) / Burrow Strike (ground: dive under, erupt; effect `bury`; air: drill down) / Drill Ascent (vertical drill, multi-hit).

## 4. Stages (`src/brawl/data/stages.ts` for geometry; visuals in `src/brawl/render/stages/**`)

Coordinates in metres, y = 0 is the top of the main platform(s).

**Broken Colosseum** (`brokenColosseum`): solid main platform x ∈ [−11, 11], y 0, thickness 3.5, both ledges. Soft platforms:
left x ∈ [−9, −4] y 4.2, right x ∈ [4, 9] y 4.2, top x ∈ [−2.5, 2.5] y 7.6. Blast: left −30, right 30, top 22, bottom −16.
Spawns x = −7, −2.5, 2.5, 7 (y 0). Respawn (0, 12). Camera half-width 11–19. Look: a floating slab of colosseum floor in
a golden-hour sky; broken arches and fallen columns as background silhouettes, crowd tiers far back, banners, brazier glow, drifting
embers; the soft platforms are broken stone beams with wooden planks.

**Sky Aqueduct** (`skyAqueduct`): two solid islands (aqueduct arches) x ∈ [−13, −3] and x ∈ [3, 13], y 0, thickness 3, ledges on all four
inner/outer ends; a moving soft platform in the gap (width 5, y 2.6, x amplitude 3.2 m, period 9 s, phase 0); a high soft platform
x ∈ [−3, 3] y 7.8; two small soft platforms x ∈ [−12, −8] y 4.6 and x ∈ [8, 12] y 4.6. Blast: left −30, right 30, top 22, bottom −18.
Spawns x = −10, −6, 6, 10. Respawn (0, 12). Camera half-width 12–21. Look: cool dawn sky, cloud layers (parallax), waterfalls
spilling off the island edges into clouds, floating ruin pieces, birds, god-rays; the gap shows open sky (falling in = KO).

Both stages: no hazards (pure platforming), deterministic moving platform (a pure function of frame).

**v1.6 dynamic stages** (`clockworkHeights`, `crumblingAmphitheatre`; binding design + counting rules in `docs/CL-MAPS-PLAN.md`): `StageDef` platforms
gain `path` (a looping, cosine-eased keyframe `PathSpec`; evaluated by `pathOffsetAt` in `sim/geometry.ts` and shared with the view / bots as
`platformAt` / `pathOffset` from `data/index.ts`), `breakable: { hits }` and `finalOnly`. Clockwork Heights: a solid `core` slab that drifts around
(riders are carried, bystanders are pushed out along the axis of minimal penetration, its ledges and the ledge-assist zone move with it) and four soft
satellites that glide between three layouts on a shared 36 s loop. Crumbling Amphitheatre: six breakable pieces (one count per attacker per attack
activation, ≥ 20 frames between counts per attacker and platform) — a destroyed piece stops colliding, riders fall, hangers drop, and when the last one
falls the stage flips (`stageFinal`) to its final form (`finalOnly` platforms). A ledge is grabbable only while its corner is not covered by another active
platform at the same height (`PHYS.ledgeCover*`). All of it (hp, destroyed / final flags, per-attacker count cooldowns) is part of
`saveState` / `loadState` / `checksum`; the stage data enters the online data fingerprint; the release bumps the MINOR version.

## 5. Graphics & view (`src/brawl/render/**`)

* `createBrawlView(canvas, config, opts)` → `BrawlViewApi` (types.ts). It builds on the existing `SceneManager`
  (renderer, bloom/ACES pipeline, quality tiers) if it can be reused cleanly, else a sibling with the same pipeline; it must
  honor `gk-quality`. ≤ 150 draw calls, 60 fps target.
* **Camera:** perspective, fov ≈ 28°, side-on with a slight 4° downward pitch; dynamic: frames all alive fighters + 3 m padding,
  clamped to `stage.camera`; critically-damped follow with lookahead on velocity; zooms in on a KO / ledge duels; subtle shake on
  big hits (scaled by launch speed, respects a reduce-motion flag if present). Never lets a fighter leave the view while on-stage.
* **Fighters:** the existing rigs, via the pose layer (§6). Yaw = ±(90° − 22°) so they read side-on but with depth; the root
  turns over ~4 frames. Soft blob shadow on the platform below. Percent feedback: at ≥ 100 % a growing red rim/steam; ≥ 150 % ember
  sparks; flicker while invulnerable (respawn gold ring, dodge ghost trail).
* **VFX (cheap, pooled):** hit sparks sized by damage and oriented along the launch angle, hit-stop (the frozen fighters shake),
  speed-line streak and trail when launched > 25 m/s, tumble dust, jump/air-jump rings, land dust, run dust, ledge-grab flash,
  KO explosion at the blast line (beam + shockwave + screen flash + slow-mo ≈ 0.25 s), respawn laurel ring, shield-less dodge afterimage,
  armor flash (gold). Debug overlay (F3): hurtboxes (green), hitboxes (red), ledge boxes, blast zones.
* **HUD** (DOM, `src/brawl/ui/BrawlHud.ts`): per-fighter card along the bottom — animal colour badge + name, big percent number with
  colour ramp (white 0 → yellow 60 → orange 100 → red 150 → dark red 200+) that bumps on every hit, stock pips (paw/laurel icons);
  top-centre timer; 3-2-1-FIGHT countdown; KO banner "NAME KO'd BY NAME"; off-screen arrows for fighters above/outside the view; local
  player marker; pause menu (reuse `PauseMenu` style); results.

## 6. Animation (`src/brawl/render/pose/**`)

Reuses the existing rigs (`AnimalFactory.createRig`) through an additive hook in `BaseRig` (the only edit allowed outside
`src/brawl/**`; keep the Battle Royale path byte-for-byte unchanged). A `BrawlRig` wraps one rig and exposes
`update(cur, prev, alpha, dtRender)`; it owns the root transform (position, facing yaw, tumble rotation about the hurtbox centre, squash/stretch).

**Smoothness rules (all enforced by tests where marked ✔):**
1. Pose is a pure function of (move body, move frame + subframe `alpha`) — never of wall-clock — so interpolation is smooth at any refresh rate.
2. Every move has **anticipation → strike → hold → follow-through → settle**: anticipation eases out over the first ≈ 55 % of startup
   (the wind-up is visible even on a 5-frame move: at least 2 frames), the strike accelerates (ease-in) and **reaches its peak pose exactly on
   the first active frame**, the peak holds through the active window, the follow-through overshoots and settles with ease-in-out over recovery. ✔ (peak-pose-at-first-active test)
3. The **striking limb/head/tail tip sits inside (or touches) the hitbox during the active frames** — what you see is what hits. ✔ (tip-in-hitbox test, tolerance 0.5 m)
4. Continuous: no joint rotates more than 0.5 rad between consecutive 60 Hz frames outside the strike frame, and ≤ 0.9 rad on the strike itself;
   entry/exit blend ≥ 2–3 frames from/to the neighbouring state (idle/run/jump/fall/hitstun…). ✔ (max angular step test, all animals × all moves × both forms)
5. Anatomy-correct: bite = head/jaw, claws/paws = forelimbs, kicks = hind/fore legs as the animal's body allows, tail whips = tail, wings = wings,
   neck = giraffe neck, python = body arcs, mole = digging claws. No limb passes through the body or twists > 160° from rest. Aerials tuck/extend legs.
6. Body follows `MoveMotion` (lean into lunges, rise with leaps); recovery moves look like recoveries (the whole body rises).
7. Generic states (all animals): idle, walk/run, jumpSquat, rise, fall, fast-fall, land (squash), crouch, dodge-spot (shrink+flicker), roll (forward roll), air-dodge (spin),
   hitstun (flinch away from the hit), tumble (body rotates about the centre with speed ∝ launch speed, limbs flail), knockdown + get-up, ledge hang (front limbs hold
   the edge; limbless animals hang by the head/body), ledge climb, respawn, and facing flips.

Archetype library: parametric generators (`swipe`, `rake`, `jab`, `uppercut`, `bite`, `lunge`, `headbutt`, `tailWhip`, `spinAttack`, `stomp`, `slam`, `kick`, `wingBuffet`, `dive`, `leapUp`,
`charge`, `burrow`, `roar`, `neckSwing`, `tether`, `bellyFlop`, `hornUp`, `backhand`, `charge`) × per-animal **limb-role profile** (role → joint name, swing axis/sign, reach scale), with per-animal
overrides for odd anatomies. Each `MoveBody` names its archetype + `anim` params (types.ts).

## 7. Bots (`src/brawl/ai/**`)

`new BrawlBot(selfId, difficulty, seed)` implements `BrawlBotApi`; emits only `BrawlIntent`; sees only the snapshot (no cheating).

| level | reaction (frames) | behaviour |
|---|---|---|
| 1 | 24–32 | wanders toward foes, mashes Light when close, jumps randomly, **often fails to recover** (drifts), never dodges, no DI |
| 2 | 14–20 | spaces somewhat, mixes light/heavy, recovers to the ledge most of the time, occasional dodge, tends to run off stage when chasing |
| 3 | 8–12 | reads move range/startup from move data, punishes whiffs, uses chain + aerials, edge-guards, DI, dodges kill moves, picks the animal's kill move when percent is high |
| 4 | 4–6 | frame-aware punishes, combos into the best KO move at kill percent, ledge traps, recovery mix-ups (sweetspot ledge vs high return), tech-chases dodges, plays the stage (soft platforms, moving platform), never SDs |

All randomness through a seeded rng; deterministic given (snapshot stream, seed). Per-animal tactics tables
(`src/brawl/ai/profiles.ts`): preferred range, kill move, approach tool, recovery pattern, safe-vs-risky move picks.

## 8. UI flow & controls

Lobby nav gets **Champions League** (between Play and Gladiators). → `BrawlSetup` screen: fighter grid with a live preview
(`PreviewPane`) + tagline + 5 mini-stat bars (Weight, Speed, Reach, Recovery, Power — derived from data), stage cards (two), opponents 1–3,
difficulty 1–4, stocks 1–5, time (none/3/5/8 min). Start → countdown → match → results (winner, per-fighter KOs / falls / damage dealt,
Rematch / Change setup / Lobby). Settings panel's controls reference gains a Champions League section.

| action | keys |
|---|---|
| move | A / D or ← / → |
| jump (and air jumps) | W / ↑ / Space |
| down (fast fall, drop through soft platforms, down attacks) | S / ↓ |
| light attack | J or left mouse |
| heavy attack | K or right mouse |
| dodge | L or Shift |
| pause | Esc |
| debug boxes (dev only) | F3 |

Last setup stored under `gk-brawl` (storage.ts, same defensive parsing as other keys).

## 9. Balance method

`npm run brawl:balance` (`scripts/brawl-balance.ts`, vite-node, headless, no DOM). Env: `N` (games per pairing, default 40),
`STAGE` (one or both), `LEVEL` (bot level, default 4), `MODE` (`duel` | `ffa`), `TRACE=1` (one move log).
Reports per animal: win rate, KO %, average KO percent, average stocks lost to self-destruct, average match time; the 10×10 matchup matrix; move usage;
dominant-move warning (a move > 45 % of an animal's damage), timeout rate.

Acceptance bands (L4 duels, both stages, N ≥ 60 per ordered pairing):
* every animal's overall win rate **42–58 %**; worst matchup **≥ 30 %**;
* mean KO percent **80–150 %**; timeouts **< 5 %**; matches 70–220 s; self-destructs **< 15 %** of stocks lost;
* L1 vs L4 → L4 wins ≥ 90 %; L2 vs L4 ≥ 75 %; L3 vs L4 ≥ 55 % for L4;
* 4-fighter FFA, mirrored seats: every animal 18–32 %.
Levers (in order): damage/kb numbers → frame data → stats (weight/speed/jumps) → hurtbox → bot profile. Rules (§2) are not tuned.

## 10. Work packages (file ownership; Sonnet 5.5 agents only; lean, write-first)

| WP | wave | owner files | depends on |
|---|---|---|---|
| **S** sim | 1 | `src/brawl/sim/**`, `src/brawl/config.ts`, `tests/brawl/sim*.test.ts` | types.ts (a fixture moveset until D lands) |
| **D** data | 1 | `src/brawl/data/**`, `tests/brawl/moveBudget.test.ts`, `docs/CHAMPIONS-LEAGUE-MOVES.md` | types.ts, §3 |
| **A1** pose core | 1 | `src/brawl/render/pose/**` (core + lion + gorilla), `src/render/animals/Animator.ts` (additive hook only), `tests/brawl/pose*.test.ts`, `?demo=brawl-moves` | types.ts, D's registry signature |
| **R** view | 2 | `src/brawl/render/**` except `pose/`, `src/brawl/render/stages/**` | S, D, A1 |
| **U** ui+controller | 2 | `src/brawl/ui/**`, `src/brawl/BrawlMatchController.ts`, `src/brawl/index.ts`, `src/audio/brawl/**` (or `src/brawl/audio/**`), edits in `main.ts`, `Lobby.ts`, `storage.ts`, `SettingsPanel.ts`, `styles/*.css` | S, types.ts (stubs the view until R lands) |
| **B** bots + balance script | 2 | `src/brawl/ai/**`, `scripts/brawl-balance.ts`, `tests/brawl/bot*.test.ts` | S, D |
| **A2** poses | 3 | `src/brawl/render/pose/animals/{crocodile,hippo,rhino,panther}.ts` | A1 |
| **A3** poses | 3 | `src/brawl/render/pose/animals/{eagle,python,giraffe,mole}.ts` | A1 |
| **T** tuning | 4 | `src/brawl/data/**`, `src/brawl/config.ts` numbers only | all |

Registry contract (D): `src/brawl/data/index.ts` exports `MOVESETS: Record<AnimalId, MovesetDef>`, `getMoveset(animal)`,
`getMoveBody(animal, moveId, air, chain = 0): MoveBody` (applies the `air` partial, `chain` bodies), `STAGES: Record<StageId, StageDef>`, `getStage(id)`.
Sim contract (S): `src/brawl/sim/BrawlWorld.ts` exports `class BrawlWorld implements BrawlWorldApi`, `src/brawl/config.ts` exports `PHYS`.
Pose contract (A1): `src/brawl/render/pose/index.ts` exports `createBrawlRig(animal: AnimalId): BrawlRig` with
`root: THREE.Group; update(cur: BrawlFighterState, prev: BrawlFighterState | null, alpha: number, dtRender: number): void; tipWorld(role: string): THREE.Vector3 | null; dispose(): void`.

Verification each package must report: `tsc --noEmit` clean, `vitest run` green (existing 665 tests stay green), its own new tests, and
what it could not verify. Browser checks use the agent's **own** tab/port (see launch.json), a rAF shim, and `resize_window` 1280×720 first.

## 11. Integration points outside `src/brawl/**` (U/A1 only, minimal)

* `src/main.ts`: Champions League flow (setup → match → results) next to the existing flow; shares the one `AudioEngine`.
* `src/ui/Lobby.ts` nav entry; `src/ui/storage.ts` `gk-brawl`; `src/ui/SettingsPanel.ts` controls reference; `src/styles/*.css` additions under `.gk-brawl-*`.
* `src/render/animals/Animator.ts`: the additive brawl hook (BaseRig). `src/render/animals/AnimalFactory.ts` unchanged.
* `package.json`: version 1.4.0 + `brawl:balance` script; `CHANGELOG.md` 1.4.0 entry; `HANDOFF.md`; `docs/`.

## 12. Release (architect)

1. All acceptance bands green; `tsc`, `vitest`, `vite build` green; both stages played in the browser pane (dev + prod build).
2. Version 1.4.0, CHANGELOG, HANDOFF, `npm run dist`, silent install over the user's copy (authorized), desktop smoke test.
3. Commit + push to `main` (authorized once all checks pass). **No tags, no GitHub Releases.**
