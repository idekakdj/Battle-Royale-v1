# GLADIATOR KINGDOM — Master Blueprint v1.0

Lead architect: Claude (Fable). Implementation: Opus work-package agents.
This document is the **single source of truth**. Every number, interface, and file boundary here is binding. Deviations require architect sign-off (noted in the agent's report).

---

## §1 Vision & Pillars

A browser-based, PvE, 10-fighter battle royale set in a Roman-style gladiator colosseum. The player picks 1 of 10 real-animal gladiators; the 9 bots play the remaining 9 animals (all 10 animals appear in every match). Last one standing wins.

**Pillars (in priority order):**
1. **Precise combat** — deterministic fixed-timestep sim, exact arc/sphere hitboxes, readable telegraphs, flawless animation-to-hitbox sync.
2. **Bots that play like players** — bots act only through the same `FighterIntent` interface the player uses, with human-like reaction latency. No stat cheats at any difficulty.
3. **Real-animal fantasy** — every stat and ability traceable to a real characteristic.
4. **Performance** — smooth 60 fps on mid-range hardware; quality via style, not polycount.

**Non-goals (v1):** PvP/networking, accounts, progression/unlocks, mobile controls.

---

## §2 Tech Stack & Repository Layout

- **TypeScript (strict)** + **Vite** + **three** (npm `three`, current stable). No other runtime deps.
- **vitest** for headless sim tests. No physics engine — custom collision (§7.8).
- Static site; deployed to GitHub Pages via GitHub Actions. `vite.config.ts` uses `base: './'`.
- No external assets: all models procedural, all audio synthesized, all icons inline SVG.

```
/ (repo root)
├── index.html                  ← single page, #app root
├── package.json / tsconfig.json / vite.config.ts / .gitignore
├── docs/BLUEPRINT.md           ← this file
├── .github/workflows/deploy.yml (WP-I)
└── src/
    ├── main.ts                 ← boot + screen flow shell        (WP-A)
    ├── core/                   ← GameLoop, EventBus, ScreenManager, types, math (WP-A)
    ├── config/                 ← animals.ts, balance.ts, arena.ts, botProfiles.ts (WP-A, data from §8–§10)
    ├── input/InputManager.ts   ← (WP-A)
    ├── sim/                    ← headless simulation (WP-B) — MUST NOT import three or DOM
    ├── ai/                     ← bot brains (WP-C) — emits FighterIntent only
    ├── render/                 ← SceneManager, Stadium, CameraRig, Effects (WP-D)
    ├── render/animals/         ← 10 model builders + AnimalFactory + Animator (WP-E)
    ├── render/preview.ts       ← small standalone animal preview renderer for UI (WP-E)
    ├── ui/                     ← Lobby, CharacterSelect, DifficultySelect, HUD, Results, PauseMenu (WP-F)
    ├── audio/AudioEngine.ts    ← (WP-G)
    ├── match/MatchController.ts← final wiring (WP-I)
    └── styles/                 ← base.css (WP-A), ui.css (WP-F)
tests/sim/*.test.ts             ← (WP-B)
```

**Hard boundaries:** `sim/` never imports `three`, `render/`, `ui/`, or DOM APIs. `render/` reads sim snapshots, never mutates sim state. All tunables live in `config/` — no magic numbers in systems.

---

## §3 Game Flow

```
LOBBY ──PLAY──▶ CHARACTER SELECT ──CONFIRM──▶ DIFFICULTY SELECT ──START──▶ MATCH
  ▲                                                                          │
  └───────────────── RESULTS ◀── (win, or death → SPECTATE → match end) ─────┘
```
Results offers: REMATCH (same animal+difficulty), CHANGE GLADIATOR (→ select), LOBBY.
ESC in match → pause menu (sim pauses; PvE so this is fair): Resume / Quit to Lobby.

---

## §4 Controls (player)

| Input | Action |
|---|---|
| WASD | Move (camera-relative) |
| Mouse (pointer lock) | Orbit camera; attacks/block snap fighter yaw to camera yaw |
| LMB | Basic attack (3-hit combo, §7.2) |
| RMB (hold) | Block (§7.4) |
| Shift | Special ability (per animal, cooldown) |
| Q | Ultimate (when charge = 100) |
| Space | Jump (v=7 m/s, g=20 → apex ≈1.2 m). **Eagle:** hold in air = glide (§8) |
| Esc | Pause menu |

Movement is camera-relative; the fighter faces its movement direction while running, and snaps to camera yaw the moment an attack/block/special/ult starts.

---

## §5 Core Architecture

- **Fixed-timestep sim at 60 Hz** (`dt = 1/60`), accumulator pattern; render at rAF with interpolation between the last two sim states (position/yaw lerp).
- **Determinism:** sim uses its own seeded RNG (mulberry32 in `core/math.ts`); no `Math.random()` inside `sim/` or `ai/`.
- **EventBus** (typed): sim emits `hit`, `blocked`, `guardBreak`, `death`, `ultimate`, `special`, `pickup`, `matchEnd`, `telegraph`, `crateBreak`, `comboFinisher`. Render effects, HUD, and audio subscribe. AI receives events only through its perception layer with reaction delay (§10).
- **Screens** implement `interface Screen { mount(root: HTMLElement): void; unmount(): void; update?(dt:number): void }` managed by `ScreenManager`.
- **Everyone is a Fighter.** Player input → `FighterIntent`; each bot brain → `FighterIntent`. The sim cannot tell them apart.

### §5.1 Shared contracts (`src/core/types.ts` — WP-A implements verbatim; extend, don't alter)

```ts
export type AnimalId = 'lion'|'gorilla'|'crocodile'|'hippo'|'rhino'
                     | 'eagle'|'panther'|'python'|'giraffe'|'mole';

export interface Vec3 { x: number; y: number; z: number }

export interface FighterIntent {
  moveX: number; moveZ: number;   // desired world-space dir, magnitude ≤ 1
  aimYaw: number;                 // world yaw (radians) the fighter wants to face when acting
  attack: boolean;                // edge-triggered this tick
  block: boolean;                 // level (held)
  special: boolean;               // edge
  ultimate: boolean;              // edge
  jump: boolean;                  // level (eagle glide uses held)
}

export type FighterAction =
  'idle'|'run'|'attack1'|'attack2'|'attack3'|'special'|'ultimate'
  |'block'|'stagger'|'knockdown'|'hit'|'dead'
  |'burrowed'|'glide'|'grab'|'grabbed'|'feared'|'jump';

export interface BuffState { kind:'speed'|'rage'|'slow'|'bleed'|'root'|'blind'
  |'dmgTakenUp'|'armorUp'|'atkSpeedUp'|'stealth'; t: number; dur: number; mag: number }

export interface FighterState {
  id: number; animal: AnimalId; isPlayer: boolean; alive: boolean;
  pos: Vec3; vel: Vec3; yaw: number;
  hp: number; maxHp: number;
  guard: number; maxGuard: number; guardRegenDelay: number;
  ultCharge: number;                 // 0..100
  specialCd: number;                 // seconds remaining
  action: FighterAction; actionT: number; actionDur: number;
  comboIndex: 0|1|2; comboWindow: number;
  buffs: BuffState[];
  kills: number; damageDealt: number; damageBlocked: number; ultsUsed: number;
  grabTargetId: number; grabbedById: number;   // -1 when none
  airborne: boolean; glideT: number; burrowT: number;
}

export interface PickupState { id:number; kind:'heal'|'speed'|'rage';
  pos:Vec3; active:boolean; respawnT:number }

export interface WorldSnapshot {
  time: number; fighters: FighterState[]; pickups: PickupState[];
  crates: { id:number; pos:Vec3; hp:number; alive:boolean }[];
  bloodlustMult: number; matchOver: boolean; winnerId: number;
}

export type GameEvent =
  | { type:'hit'; attackerId:number; targetId:number; damage:number; pos:Vec3; heavy:boolean }
  | { type:'blocked'; attackerId:number; targetId:number; damage:number; pos:Vec3 }
  | { type:'guardBreak'; targetId:number; pos:Vec3 }
  | { type:'death'; targetId:number; killerId:number; placement:number }
  | { type:'ultimate'; fighterId:number; animal:AnimalId }
  | { type:'special';  fighterId:number; animal:AnimalId }
  | { type:'telegraph'; fighterId:number; kind:'special'|'ultimate'; pos:Vec3; radius:number; yaw:number; arcDeg:number; windup:number }
  | { type:'pickup'; fighterId:number; kind:PickupState['kind']; pos:Vec3 }
  | { type:'comboFinisher'; fighterId:number }
  | { type:'crateBreak'; crateId:number; pos:Vec3 }
  | { type:'matchEnd'; winnerId:number };
```

Sim API: `class World { constructor(cfg: MatchConfig, seed: number, bus: EventBus); setIntent(id:number, intent:FighterIntent): void; step(dt:number): void; snapshot(): WorldSnapshot }` where `MatchConfig = { roster: {animal:AnimalId; isPlayer:boolean}[]; difficulty:1|2|3|4 }` (difficulty is carried for AI; sim ignores it).

Render animal contract (WP-E): `AnimalFactory.create(animal: AnimalId): AnimalRig`;
`interface AnimalRig { root: THREE.Group; update(state: FighterState, dtRender: number): void; accent: number }` — `update` drives all procedural animation from the state alone (action + actionT/actionDur + velocity), guaranteeing animation always matches sim timing (hit frames land exactly at impact fraction, §7.3).

---

## §6 Match Rules

- Roster: player's pick + the other 9 animals, one bot each. Bot display names: “<Animal> (Bot)”.
- Spawns: ring r=24 m, every 36°, facing center; player at index 0 (south). 3‑2‑1 countdown (sim frozen), then FIGHT.
- **No shrinking zone.** Anti-stall: **Crowd’s Bloodlust** — at t=120 s all damage ×1.25, +0.25 every 30 s, cap ×2.0. HUD banner + crowd roar on each step.
- Death: fighter → `dead`, ragdoll-lite collapse; killer credited; placement recorded (10th = first death). Player death → spectate (follow killer; LMB cycles alive fighters) until `matchEnd`.
- Win: last alive. Results screen stats: placement, kills, damage dealt, damage blocked, ults used, match time.

---

## §7 Combat System (binding rules)

### §7.1 Damage pipeline (single implementation in `CombatSystem`)
```
final = base
      × attackerRage (1.25 if rage buff)
      × backstab (panther only: 1.25 if attacker within 75° behind target's yaw)
      × stealthCrit / animal-specific multipliers (per §8)
      × bloodlustMult
      × targetVuln (1.25 while target staggered; 1.20 if feared-vuln per lion ult)
      × armorUp (×0.7 if target has armorUp)
if blocked (target blocking AND attacker within target's frontal 150° arc AND guard > 0):
      dealt = final × (1 − blockReduction[animal]); guardDrain = final × 0.45
else: dealt = final
```
Bleed/DoT ticks ignore block. Round damage to integers for display only.

### §7.2 Basic attacks — 3-hit combo (LMB)
- Each animal: hit1, hit2, finisher (dmg per §8). Swing duration = `1 / attackRate` seconds, uniform per animal.
- Chain: pressing attack during the last 40% of a swing or ≤0.5 s after it queues the next combo step. Combo resets after 1.2 s without a swing, on stagger/knockdown, or on special/ult use.
- While swinging: move speed ×0.4; yaw turn rate capped at 240°/s (attacks are committed).
- **Ult charge on landed basics only:** hit1/hit2 = +8, finisher = +14; halved if the hit was blocked. Specials/ults/DoTs grant 0. Cap 100; persists until cast.

### §7.3 Hit detection (melee arc query)
- The swing damages at its **impact instant** = 55% through the swing duration (single tick).
- Target is hit iff: horizontal distance(centers) ≤ range, AND angle from attacker yaw ≤ arcHalfAngle, AND |Δy| ≤ 2.2 m (giraffe 3.2), AND target not `burrowed`/DFA-airborne. One damage application per target per swing.
- Flinch: hit1/hit2 put victims in `hit` (0.15 s) only if victim is in idle/run/jump. Finishers and specials cause `stagger` 0.4 s that interrupts swings (unless CC-immune). Blocking prevents flinch/stagger.

### §7.4 Block (RMB hold)
- Frontal 150° arc. Reduces damage by `blockReduction` (§8); drains guard by `final × 0.45`.
- Guard: per-animal max; regen 15/s after 1.0 s without blocking a hit; **guard break** at 0 → `stagger` 1.5 s, +25% damage taken, guard refills to 50% after stagger ends.
- Move speed ×0.5 while blocking (eagle ×1.2 special case). Cannot attack while blocking.
- Animal block perks (§8): gorilla parry-shove, panther perfect-block counter, rhino thorns, python tension, mole mound.

### §7.5 Specials (Shift) — per §8; cooldown starts when the ability ends. Telegraph event emitted at windup start (ground decal, §11.4).

### §7.6 Ultimates (Q) — require charge 100, consume all charge. 0.5–1.0 s windup with telegraph unless noted. CC-immunity only where §8 says so.

### §7.7 Status effects
slow (move ×(1−mag)), root (no move; can act), fear (forced run away from source, no actions), blind (bots: aimError ×3 for dur; player: dirt overlay), bleed (mag dmg/s, unblockable), stealth (85% transparent; bots lose target lock, §10), stun/stagger (no actions), knockdown (0.8 s down + 0.3 s rise, can't act; not damage-immune). Same kind refreshes (no stack); different kinds stack.

### §7.8 Movement & collision
- Accel 40 m/s², decel 30 m/s²; per-animal max speed §8; gravity 20; ground y=0 (dais y=0.6).
- Colliders: fighters = vertical cylinders (radius §8). Fighter↔fighter: soft push-out (no overlap). Fighter↔obstacle: circle vs circle/AABB/segment push-out. Arena wall: circle r=30 clamp.
- Knockback: impulse applied over 0.15 s, wall/obstacle stops it; **rhino Lockdown Charge** adds slam bonus when it stops early against geometry (§8).
- Jump clears low walls (0.9 m). Mole `burrowed` ignores obstacle collision (not arena wall) and is untargetable. Eagle `glide` flies at y≈1.6, crosses low walls/crates, still targetable.

---

## §8 The Roster — 10 Animals (binding data → `config/animals.ts`)

Global: ult cost 100. “rate” = swings/sec. Ranges in meters from fighter center; arc = full angle. All numbers are v1 balance; keep them **data-driven** for tuning.

| # | Animal | HP | Speed | Radius | Combo dmg (1/2/F) | Rate | Range/Arc | Block % / Guard | ~DPS |
|---|--------|----|-------|--------|-------------------|------|-----------|-----------------|------|
| 1 | Lion | 1000 | 6.5 | 0.70 | 70/70/95 | 1.40 | 2.2 / 120° | 60 / 100 | 110 |
| 2 | Gorilla | 1100 | 5.8 | 0.80 | 80/80/110 | 1.20 | 2.3 / 110° | 70 / 130 | 108 |
| 3 | Crocodile | 1150 | 5.2 | 0.90 | 75/75/120(+bleed) | 1.10 | 2.4 / 90° | 72 / 120 | 111 |
| 4 | Hippo | 1300 | 4.8 | 1.20 | 85/85/120 | 1.00 | 2.6 / 130° | 75 / 140 | 97 |
| 5 | Rhino | 1250 | 5.0 | 1.15 | 80/80/115 | 1.05 | 2.6 / 100° | 70 / 130 | 96 |
| 6 | Eagle | 700 | 7.2 | 0.55 | 65/65/85 | 1.70 | 2.0 / 100° | 45 / 80 | 122 |
| 7 | Panther | 750 | 7.0 | 0.65 | 60/60/80 | 1.80 | 2.1 / 110° | 50 / 90 | 120 |
| 8 | Python | 850 | 5.4 | 0.70 | 75/75/95 | 1.25 | 3.2 / 50° | 55 / 100 | 102 |
| 9 | Giraffe | 1050 | 6.2 | 0.90 | 85/85/110 | 0.95 | 4.0 / 140° | 55 / 110 | 89 |
| 10 | Mole | 800 | 5.6 | 0.50 | 60/60/75 | 1.60 | 1.7 / 120° | 50 / 95 | 104 |

Per-animal details (specials cd in s; all telegraphed):

1. **LION — “The King”** (real: apex pride hunter, 8 km roar). Finisher *Maul Bite*: +15% slow 1.5 s. **Special: Pounce (7s)** — leap up to 8 m to aim point, 60 dmg + knockdown 0.5 s on landing hit (1.5 m radius). **Ult: King’s Roar** — instant, 8 m AoE: 100 dmg, fear 2 s, feared targets take +20% dmg 5 s; lion +20% speed 5 s. Card: HP3 ATK4 DEF3 SPD4 RNG3 · Easy.
2. **GORILLA — “The Silverback”** (real: ~10× human strength). Finisher *Double-Fist Slam*: 2.5 m AoE, mini-stagger 0.4 s. **Special: Silverback Leap (8s)** — jump-slam at aim ≤7 m: 75 AoE dmg (2.5 m) + 4 m knockback. **Block perk:** releasing block ≤0.25 s after blocking a hit auto-Shoves (30 dmg, 4 m knockback). **Ult: Primal Rampage** — 6 s: +40% attack speed, +25% dmg, basic hits knock back 2 m, immune to flinch/stagger. Card: HP4 ATK4 DEF4 SPD3 RNG2 · Medium.
3. **CROCODILE — “The Ambusher”** (real: 3,700 psi bite, armored scutes, death roll). Finisher *Jaw Crush*: +bleed 30 over 3 s. **Special: Ambush Lunge (7s)** — low dash 7 m; next Snap within 1 s deals +60%. **Ult: Death Roll** — lunge 4 m; on hit: grab+roll 2.5 s, 260 dmg over duration, target stunned; croc takes 50% reduced damage during; on miss 1 s recovery. Card: HP4 ATK4 DEF4 SPD2 RNG2 · Medium.
4. **HIPPO — “The Riverlord”** (real: deadliest large land mammal, 30 km/h sprint, thick hide). **Special: River Rush (8s)** — charge 11 m/s up to 1.2 s; impact 80 dmg + 4 m knockback. **Ult: Colossal Chomp** — 1.0 s windup, 4 m/130° cone, 250 dmg + 30% slow 2 s. Card: HP5 ATK4 DEF5 SPD1 RNG2 · Easy.
5. **RHINO — “The Battering Ram”** (real: 50 km/h charge, keratin horn, plate-like skin). Finisher *Horn Fling*: launches 3 m. **Special: Lockdown Charge (9s)** — 12 m/s up to 12 m, 100 dmg + carry; if the carried target is stopped by wall/obstacle: +60 dmg + stun 1 s. **Block perk:** melee attackers hitting the block take 15 thorn dmg. **Ult: Seismic Stampede** — 3 s steerable charge (turn ≤90°/s), CC-immune, runs through: 180 dmg + knockdown each (once per target), breaks crates. Card: HP5 ATK3 DEF5 SPD2 RNG2 · Easy.
6. **EAGLE — “The Sky Terror”** (real: 240+ km/h stoop, crushing talons). Finisher *Beak Pierce*: ignores 50% of block reduction. Hold Space in air: **glide** 2.5 s at 8 m/s (5 s cd), crosses low obstacles. **Special: Gale Burst (7s)** — 5 m/90° cone: 45 dmg + 5 m pushback + 0.5 s disarm. **Block quirk:** move ×1.2 while blocking. **Ult: Death From Above** — soar untargetable 1.5 s, then dive at aim point: 240 dmg direct (1.2 m) + 60 splash (3 m); 1 s recovery on whiff. Card: HP1 ATK5 DEF1 SPD5 RNG2 · Hard.
7. **PANTHER — “The Shadow”** (real: melanistic ambush predator). Passive: +25% dmg from behind (75° rear arc). **Special: Shadow Dash (6s)** — dash 7 m through enemies, 50 dmg pass-through, resets combo to hit1. **Block perk:** perfect block (≤0.2 s after block starts) auto-counters 60 dmg. **Ult: Night Prowl** — 5 s stealth (+30% speed); first attack from stealth deals 200 bonus-dmg crit and breaks stealth. Card: HP2 ATK5 DEF2 SPD5 RNG2 · Hard.
8. **PYTHON — “The Constrictor”** (real: ambush constriction, long strike reach). Long thin jabs (3.2 m/50°). **Special: Coil Sweep (7s)** — 360°, 3 m: 60 dmg + 30% slow 2 s. **Block perk:** each blocked hit stores tension: next strike +30% (one stack). **Ult: Constrictor’s Embrace** — grab lunge 5 m: wrap 3 s, 240 dmg over duration, target stunned; python takes −30% dmg while constricting. Card: HP2 ATK4 DEF3 SPD3 RNG4 · Medium.
9. **GIRAFFE — “The High Tower”** (real: necking duels; kick can kill a lion). Longest reach (4.0 m). Finisher *Skull Hammer*. **Special: Thunder Kick (8s)** — 120 dmg, 6 m knockback, 2.5 m/60° (fires toward aim; usable as peel). **Ult: Guillotine Spin** — two 360° neck sweeps over 2 s (4.5 m): 90 dmg each, second sweep knocks down. Card: HP4 ATK3 DEF3 SPD3 RNG5 · Medium.
10. **MOLE — “The Undertaker”** (real: digs 18 m/h, powerful forelimbs, near-blind). Finisher *Dirt Slinger*: 3 m cone blind 1 s. **Special: Burrow (9s)** — underground ≤3 s (untargetable, 8.5 m/s, passes under obstacles); emerge (re-press or timeout) = *Uppercut Eruption* 80 dmg + knock-up/down 0.8 s (1.5 m). **Block perk:** blocking while stationary: +15% extra reduction. **Ult: Sinkhole** — 4 m zone at aim ≤10 m, 1 s telegraph, then 150 dmg + root 2 s; mole deals +25% to rooted. Card: HP2 ATK3 DEF2 SPD4 RNG1 · Hard.

**Accent colors** (UI + model tint): lion `#D9A441`, gorilla `#6B7280`, crocodile `#4F7942`, hippo `#9C7B8D`, rhino `#8A8D91`, eagle `#B45309`, panther `#35294A`, python `#557C3E`, giraffe `#E0B04B`, mole `#7B5B3F`.

---

## §9 Arena (→ `config/arena.ts`)

Circular sand floor r=30 m; stone wall h=5 m at r=30; stands (crowd) r=31→44 rising; Emperor's box at north (cosmetic); 4 barred gates at N/E/S/W wall (cosmetic).

Obstacles (solid unless noted):
- **6 stone pillars**: r=1.2 m, h=4 m, at radius 15 m, every 60° starting at 0°.
- **2 fallen columns** (low walls, jumpable h=0.9 m): segments (−8,0)→(−2,4) and (3,−6)→(9,−3), thickness 1.0 m.
- **4 crate clusters** (destructible, 150 HP each crate, 3 crates of 1 m³ per cluster) near (±7, ±7) offsets.
- **Central dais**: stone disc r=4 m, h=0.6 m, walkable (step-up, no jump needed).

Pickups: 6 pads at radius 10 m, every 60° offset 30° from pillars. On spawn choose kind: heal 50% / speed 25% / rage 25%. Effects: **heal** +250 HP instant; **speed** +30% move 8 s; **rage** +25% dmg 8 s. Pickup radius 1.2 m; respawn 20 s after taken. Icons: haunch of meat / winged sandal-esque feather / red war-drum.

---

## §10 Bot AI (→ `ai/`, profiles in `config/botProfiles.ts`)

**Architecture (all difficulties share it — only parameters and unlocked behaviors differ):**
1. **Perception** — reads `WorldSnapshot` + telegraph/attack events, each buffered by `reactionMs` before the brain may respond. LOS = ray vs pillars/walls (crates/low walls don't block sight). Loses stealthed panthers (re-acquires on its attack).
2. **Decision (utility scores, evaluated at 10 Hz)** — candidate goals: EngageTarget, Retreat, SeekPickup(kind), Reposition(strafe/flank), UseSpecial, UseUltimate, DefendBlock. Hysteresis: current goal gets +15% score; target switching only when a new target scores ≥25% higher (prevents flip-flopping).
3. **Executor** — steering (seek/flee/strafe orbit/obstacle avoidance via feeler rays; local avoidance of other fighters) and combat micro (spacing to attack range, combo timing, block windows, aim with `aimErrorDeg` gaussian noise). Output: `FighterIntent` only.

**Difficulty profiles** (`config/botProfiles.ts`):

| Param | 1 · Cub | 2 · Fighter | 3 · Veteran | 4 · Apex |
|---|---|---|---|---|
| reactionMs | 600 | 400 | 250 | 150 |
| aimErrorDeg (σ) | 25 | 15 | 8 | 3 |
| blockOnTelegraph % | 5 | 25 | 55 | 80 |
| perfectBlockTry | no | no | no | yes (panther etc.) |
| comboDepth | 1 | 2 | 3 | 3 + feints (start swing, hold, punish whiff) |
| special use | 10% when off cd, random | gap-closer only | gap-close + escape + peel | full per-animal scripts (below) |
| ultimate use | on charge if enemy ≤10 m | when target in ult range | after landing finisher, or ≥2 enemies in AoE | optimal: on staggered/guard-broken/rooted targets; saves vs bad trades |
| retreat/kite | never | heal-seek < 40% HP | kite < 35% HP, disengage via mobility | + retreat-heal-reengage loops, avoids 2v1s, LOS-breaks behind pillars |
| pickups | ignores | if within 8 m | proactive when safe | contests & denies (grabs heal when enemy low) |
| target choice | nearest | nearest | lowest-HP in 14 m, else nearest | weighted: low HP, isolated, staggered; avoids clusters |
| strafeSkill 0–1 | 0.0 | 0.3 | 0.7 | 1.0 (orbits at victim's max range, spacing tricks) |
| whiffPunish | no | no | yes | yes + baits blocks to drain guard |

**Apex (L4) per-animal combo scripts** (Veteran uses simplified versions):
lion Pounce→full combo→Roar when ≥2 in 8 m · gorilla Leap-slam→combo, parry-shove reads, Rampage when target guard <35% · croc Ambush Lunge→boosted Snap→finisher, Death Roll on staggered/low targets · hippo River Rush close→combo, Colossal Chomp on guard-break · rhino aims Lockdown Charge to slam targets into pillars/walls; Stampede through clusters · eagle hit-and-run (combo→Gale Burst→glide out), Death From Above on isolated/low targets · panther Night Prowl approach→backstab crit→flurry→Shadow Dash out · python max-range jabs, Coil Sweep on approach, Constrict punishes committed specials · giraffe max-range pokes, Thunder Kick pursuers off, Guillotine when surrounded · mole burrow approach→Uppercut→flurry→Dirt Slinger→re-burrow, Sinkhole on kiters.

Bots also fight each other (full FFA target selection). **No cheating at any level:** same intents, same cooldowns, same vision rules; only reaction/accuracy/decision quality scale.

---

## §11 Rendering (WP-D stadium/effects, WP-E animals)

### §11.1 Look
Low-poly flat-shaded (`flatShading: true`, MeshStandardMaterial roughness≈0.9 or Lambert), warm gradient vertex-color sand, hemisphere light (sky #ffe8c0 / ground #6b5a3e) + one directional sun with a single 2048 shadow map covering the arena. Fog subtle. Color-graded warm. Sky: gradient dome + low sun.

### §11.2 Stadium (WP-D)
Procedural: sand disc (radial vertex-color gradient), tiered stands with **InstancedMesh crowd** (≥1200 low-poly torsos, per-instance color variety, coarse 10 Hz bob/wave animation, cheer amplitude driven by an `excitement` value the match sets on kills/ults), wall ring with gates + banners, Emperor's box, pillars/columns/crates/dais per §9, pickup pads with floating rotating icons.

### §11.3 Animals & animation (WP-E)
- Each animal = articulated group of primitive meshes (boxes/cylinders/spheres, flat-shaded, accent-tinted palette + darker/lighter shades; distinctive silhouettes: giraffe neck!, hippo bulk, eagle wings...). Target 300–900 tris each.
- `AnimalRig.update(state, dt)` drives **procedural animation** entirely from `FighterState`: walk/run cycles (leg/wing frequency ∝ speed), idle breathing, attack swings keyed so the visual strike lands exactly at the 55% impact instant (§7.3), block pose, stagger wobble, knockdown, burrow (sink + dirt mound), glide, grab/grabbed poses, ult performances, death collapse (fall to side, settle, slow fade after 3 s to 40% opacity, stays as corpse). Poses = keyframe tables + cubic easing + pose blending (0.1 s cross-fade). No animation clips/assets.
- `render/preview.ts`: `createPreview(canvas, animal)` — small self-contained scene (pedestal, key light, slow turntable, idle anim) for lobby/select. Must be cheap (own rAF, pauses when hidden).

### §11.4 Effects (WP-D)
Pooled, allocation-free after init: swing arc trails (ribbon), hit sparks + radial burst, blocked spark (blue-white) vs hit (red-orange), guard-break shatter, dust puffs (footsteps/landing/burrow), **telegraph decals** (ground ring/arc/rect, red for enemy, gold for player, fill animates over windup), damage numbers (billboard sprites, pooled 64, crit style for finishers/ults), death burst + crowd streamers on kills, ult activation flash + per-animal tint, low-HP screen vignette (UI), light screenshake (≤0.15 m, on heavy hits/ults). Budgets: ≤500 live particles, ≤150 draw calls total, ≤120k tris scene-wide.

### §11.5 Camera (WP-D)
Third-person: pointer-lock orbit, yaw free, pitch clamp [−30°, +55°], distance 6.5 m (spring smoothing, 0.12 s), pivot at fighter head-height (per-animal ~1.2–2.6 m), shoulder offset 0.6 m, collision: sphere-cast pulls camera in front of obstacles/walls. Spectate mode: same rig targeting any fighter + free slow orbit; smooth 0.5 s transitions.

---

## §12 UI (WP-F) — Fortnite-inspired lobby

Aesthetic: dark stone + gold trim, torchlight glow, laurel motifs; font stack `'Cinzel', 'Trajan Pro', serif` headers via system fallback (no webfont files — use `serif` stack with letter-spacing) + clean sans body. All screens DOM/CSS (no canvas UI) overlaying the WebGL canvas.

- **Lobby**: full-bleed; left vertical nav (PLAY ▸ GLADIATORS ▸ SETTINGS), top-left logo “GLADIATOR KINGDOM” with crossed-swords SVG, center-right large 3D preview (render/preview.ts) of currently-selected animal on a pedestal, bottom-right huge gold PLAY button, bottom bar: version + mute toggle. SETTINGS panel: master/music/SFX sliders (persist localStorage `gk-settings`), controls reference.
- **Character Select**: “CHOOSE YOUR GLADIATOR”; 5×2 card grid (stylized inline-SVG head icon per animal, accent-colored frame, name + title); hover = lift + glow; selected = gold frame. Right panel: 3D turntable preview, stat pips (HP/ATK/DEF/SPD/RNG, 1–5) with animated fill, difficulty tag, and the full move list **with real numbers from config** (combo dmg + rate, special + cd, block % + guard, ult description), one-line real-animal lore. CONFIRM → difficulty. Selection persists (localStorage) as lobby default.
- **Difficulty Select**: 4 large cards — 1 CUB “Learns to walk” / 2 FIGHTER “Blocks and chases” / 3 VETERAN “Combos, kites, times ultimates” / 4 APEX “Reads you. Punishes everything.” — each lists concrete behaviors (from §10). START MATCH button. Persists last choice.
- **HUD**: bottom-left HP bar (animal accent, white damage-chip trail) + guard bar beneath; bottom-center buff icons; bottom-right ability cluster: special icon with radial cooldown, ult ring filling 0–100 (pulse + “Q READY” at full); top-right “⚔ N ALIVE”; top-left kill feed (icon ▸ icon, 4 s fade); floating damage numbers are render-side; center subtle hitmarker on landing hits; bloodlust banner top-center; first-10 s controls hint; low-HP vignette <30%. Spectate bar: “SPECTATING — LION (BOT) · LMB next · N alive”.
- **Results**: VICTORY → “CHAMPION OF THE ARENA” gold laurels + confetti; defeat → “FELLED IN BATTLE — PLACED #N”. Stat rows (kills, dmg dealt, dmg blocked, ults, time, difficulty). Buttons: REMATCH / CHANGE GLADIATOR / LOBBY.
- **Pause** (Esc): dim overlay, Resume / Settings / Quit to Lobby.

---

## §13 Audio (WP-G) — all Web Audio synthesis, no files

`AudioEngine` with master/music/sfx `GainNode`s; settings from localStorage; resumes AudioContext on first user gesture; subscribes to EventBus.
- **SFX**: swing whoosh (bandpassed noise sweep, pitch per animal size), hit thud (noise burst + 80→40 Hz sine drop), blocked (metallic ping, 1.2 kHz + harmonics), guard break (crack + low boom), finisher (heavier layered thud), pickup chime (heal=warm triad, speed=quick arpeggio up, rage=drum hit), telegraph warning tick, ult stingers per animal, death (thud + crowd gasp→cheer), footsteps optional at low gain.
- **Roars**: per-animal voice = oscillator stack + formant-ish bandpass + AM growl; params (base freq, growl rate, length) per animal: lion 90 Hz long roar, gorilla chest-beat pattern (8 woodblock-ish hits), croc hiss-growl 70 Hz, hippo bellow 65 Hz, rhino snort-charge, eagle screech 1.8 kHz descending, panther low 120 Hz snarl, python hiss (filtered noise), giraffe (mostly silent IRL → deep hum + hoof stomp), mole chitter (fast 300 Hz pulses). Played on match start, ult, and kill.
- **Crowd**: looping filtered-noise bed whose intensity follows match `excitement` (kills/ults spike it, decays over 5 s); cheer swells (voicy sawtooth clusters + noise) on kill/bloodlust/victory.
- **Music**: lobby loop ~92 BPM, 8-bar chord progression (Am–F–C–G), plucked-triangle melody + soft bass + light percussion, low-pass warmth; results fanfare (victory: brass-ish triad rises; defeat: minor descent). No music mid-match (crowd + combat carry it).

---

## §14 Work Packages & Delegation

Order: **A** (sync, first) → **B, D, E, F, G** (parallel) → **C** (after B) → **I** (integration, last). Each agent owns ONLY its listed paths. Nobody edits `package.json` except A. Nobody runs `npm install` except A. Every agent must finish with `npx tsc --noEmit` clean for its files and report: files created, deviations from blueprint, integration notes.

| WP | Scope (owns) | Acceptance criteria |
|---|---|---|
| **A Foundation** | scaffold (package.json incl. `three`+`vitest`+types, vite/tsconfig/index.html/.gitignore), `src/main.ts` (screen-flow shell w/ placeholder screens), `core/*` (GameLoop fixed-step+interp, EventBus typed, ScreenManager, types.ts §5.1 verbatim, math.ts incl. mulberry32/angle utils), `input/InputManager.ts` (pointer lock, §4 mapping → raw input state), `config/*` (ALL §8/§9/§10 data, typed), `styles/base.css` | `npm run dev` serves shell; `npm run build` succeeds; `tsc --noEmit` clean; config values match §8–§10 tables exactly |
| **B Simulation** | `src/sim/*` (World, Fighter, CombatSystem, MovementSystem, PickupSystem, StatusEffects, hitbox, grabs), `tests/sim/*` | Headless; no three/DOM imports; vitest green covering: damage pipeline & block math, guard break, combo chaining+ult charge, arc hit detection incl. facing/blocked-arc cases, knockback vs wall, each animal's special+ult logic smoke test, pickups, bloodlust ramp, win detection; deterministic (same seed ⇒ same snapshot hash after 3600 steps) |
| **C Bot AI** | `src/ai/*` (Perception, Utility brain, Steering, CombatMicro, per-animal scripts) | Emits only FighterIntent; honors reactionMs buffering; headless test: 10 bots (L1 and L4) fight to matchEnd < 240 s sim-time without errors; L4 win-rate vs L1 ≥ 80% over 20 seeded sims |
| **D Stadium & FX** | `src/render/{SceneManager,Stadium,CameraRig,Effects}.ts` | Demo flag `?demo=arena` renders stadium at 60 fps; camera rig follows a dummy mover with collision; all §11.4 effects triggerable via debug keys; budgets met |
| **E Animals & Anim** | `src/render/animals/*` (10 builders), `AnimalFactory.ts`, `Animator.ts` helpers, `render/preview.ts` | Demo flag `?demo=animals` shows all 10 rigs in a row cycling actions (keys 1–0 select, QWE… trigger actions); silhouettes readable; impact poses hit at 55% timing; preview.ts works standalone on a bare canvas |
| **F UI** | `src/ui/*`, `styles/ui.css`, animal head SVG icons | Demo flag `?demo=ui` cycles all screens with mock data; stats panel renders live values imported from `config/animals.ts` (never hard-coded); localStorage persistence; keyboard/mouse nav; responsive ≥1280×720 |
| **G Audio** | `src/audio/AudioEngine.ts` (+ internal modules ok) | Demo flag `?demo=audio` = button board triggering every sound; no files; obeys settings; no clicks/pops (envelopes on everything) |
| **I Integration** | `src/match/MatchController.ts`, edits to `main.ts` wiring, `.github/workflows/deploy.yml`, `README.md`; may touch any file to FIX cross-module mismatches (must log each) | Full loop: lobby→select→difficulty→match(all 10 animals, chosen difficulty)→spectate→results→rematch; 60 fps with 10 fighters; no console errors; `npm run build` output runs from `file`-less static host (`vite preview`) |

**Shared demo-flag convention:** `main.ts` (WP-A) reads `location.search`; `?demo=<name>` bypasses the lobby and calls `runDemo(name)` — each WP registers its demo in its own module; A provides the registry `core/demos.ts: registerDemo(name, fn)` so packages never edit `main.ts`.

## §15 Coding Standards

TypeScript strict, no `any` in exported signatures. ES modules only. No per-frame heap allocation in sim step, animal update, or effects (preallocate, reuse scratch vectors). Every tunable in `config/`. Comments only for non-obvious constraints. Keep functions focused; files < ~400 lines where feasible (animal builders may exceed). Do not add dependencies. Do not touch files outside your WP. Verify with `npx tsc --noEmit` (and `npx vitest run` for B/C) before reporting done.
