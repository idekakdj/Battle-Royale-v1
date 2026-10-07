/**
 * Shared contracts for Gladiator Kingdom (BLUEPRINT §5.1).
 *
 * These interfaces are the binding cross-package contract. The fields below are
 * implemented VERBATIM from the blueprint — do not rename or alter them. Extra
 * exported helper types (e.g. {@link MatchConfig}) may be added, but the given
 * shapes are frozen so `sim/`, `ai/`, `render/`, `ui/`, and `audio/` can all
 * agree on the same data.
 */

export type AnimalId =
  | 'lion'
  | 'gorilla'
  | 'crocodile'
  | 'hippo'
  | 'rhino'
  | 'eagle'
  | 'panther'
  | 'python'
  | 'giraffe'
  | 'mole';

export interface Vec3 {
  x: number;
  y: number;
  z: number;
}

/**
 * The one interface both the player and every bot brain drive the sim through.
 * The sim cannot tell player intent from bot intent (BLUEPRINT §5).
 */
export interface FighterIntent {
  moveX: number;
  moveZ: number; // desired world-space dir, magnitude ≤ 1
  aimYaw: number; // world yaw (radians) the fighter wants to face when acting
  attack: boolean; // edge-triggered this tick
  block: boolean; // level (held)
  special: boolean; // edge
  ultimate: boolean; // edge
  jump: boolean; // level (eagle glide uses held)
}

export type FighterAction =
  | 'idle'
  | 'run'
  | 'attack1'
  | 'attack2'
  | 'attack3'
  | 'special'
  | 'ultimate'
  | 'block'
  | 'stagger'
  | 'knockdown'
  | 'hit'
  | 'dead'
  | 'burrowed'
  | 'glide'
  | 'grab'
  | 'grabbed'
  | 'feared'
  | 'jump';

export interface BuffState {
  kind:
    | 'speed'
    | 'rage'
    | 'slow'
    | 'bleed'
    | 'root'
    | 'blind'
    | 'dmgTakenUp'
    | 'armorUp'
    | 'atkSpeedUp'
    | 'stealth';
  t: number;
  dur: number;
  mag: number;
}

export interface FighterState {
  id: number;
  animal: AnimalId;
  isPlayer: boolean;
  alive: boolean;
  pos: Vec3;
  vel: Vec3;
  yaw: number;
  hp: number;
  maxHp: number;
  guard: number;
  maxGuard: number;
  guardRegenDelay: number;
  ultCharge: number; // 0..100
  specialCd: number; // seconds remaining
  action: FighterAction;
  actionT: number;
  actionDur: number;
  comboIndex: 0 | 1 | 2;
  comboWindow: number;
  buffs: BuffState[];
  kills: number;
  damageDealt: number;
  damageBlocked: number;
  ultsUsed: number;
  grabTargetId: number;
  grabbedById: number; // -1 when none
  airborne: boolean;
  glideT: number;
  burrowT: number;
  /**
   * v1.3 ultimate progress for the renderer (all optional; absent = not casting an
   * ultimate). `ultPhase` is the runtime phase, `ultStage` counts discrete beats
   * inside the active phase (nth maul strike / slam / blink…, 0-based), and
   * `ultTargetId` is the locked victim (-1 when the ultimate has no single target).
   */
  ultPhase?: 'windup' | 'active' | 'recovery';
  ultStage?: number;
  ultTargetId?: number;
  /**
   * v1.8 terrain flags (Jungle arena; docs/JUNGLE-PLAN.md). Present and `true` ONLY while they hold — absent means false, so
   * colosseum snapshots are unchanged. `inWater`: grounded, centre inside the shallow pool (wading/swimming: swim animation,
   * slosh sound, water speed). `onMoss`: grounded, body overlapping a moss patch (squelch, slow). Computed by the sim's
   * TerrainSystem once per tick; consumers must not recompute terrain.
   */
  inWater?: boolean;
  onMoss?: boolean;
}

export interface PickupState {
  id: number;
  kind: 'heal' | 'speed' | 'rage';
  pos: Vec3;
  active: boolean;
  respawnT: number;
}

/**
 * How an ultimate picks what it hits (v1.3). Config (`ANIMALS[a].ultimate.targeting`)
 * declares it; the sim resolves it at cast time from `aimYaw`; HUD/renderer preview it.
 *  - lock:   one enemy inside `range` and the aim cone (needs a valid target or the cast fizzles)
 *  - line:   a straight path along aimYaw (`range` long, `width` wide), possibly steerable/homing
 *  - ground: a ground point within `range` along aimYaw with an `radius` zone
 *  - self:   no targeting
 */
export type UltTargetKind = 'lock' | 'line' | 'ground' | 'self';

/** A projectile in flight (v1.3: gorilla Boulder Hurl). */
export interface ProjectileState {
  id: number;
  kind: 'boulder';
  pos: Vec3;
  vel: Vec3;
  /** Collision radius (m). */
  radius: number;
  ownerId: number;
}

/** Arena hazard flavours (v1.2). */
export type TrapKind = 'fire' | 'spikes';

/**
 * armed    – hidden-in-plain-sight pressure plate, waiting for a grounded fighter.
 * active   – triggered: hazard is up for its active window and hurts everyone inside.
 * cooldown – spent; re-arms when `timeLeft` reaches 0.
 */
export type TrapPhase = 'armed' | 'active' | 'cooldown';

export interface TrapState {
  id: number;
  kind: TrapKind;
  /** Centre of the trap on the sand (y = 0). */
  pos: Vec3;
  /** Trigger + damage radius (m). */
  radius: number;
  phase: TrapPhase;
  /** Seconds until the next phase change (active: time left up; cooldown: time until re-arm; armed: 0). */
  timeLeft: number;
  /** Fighter id that stepped on the plate, or -1 while armed. */
  triggeredBy: number;
}

export interface WorldSnapshot {
  time: number;
  fighters: FighterState[];
  pickups: PickupState[];
  crates: { id: number; pos: Vec3; hp: number; alive: boolean }[];
  /** Arena traps; empty when the match difficulty places none. */
  traps: TrapState[];
  /** v1.3: projectiles in flight (absent/empty when none). */
  projectiles?: ProjectileState[];
  bloodlustMult: number;
  matchOver: boolean;
  winnerId: number;
}

export type GameEvent =
  | { type: 'hit'; attackerId: number; targetId: number; damage: number; pos: Vec3; heavy: boolean }
  | { type: 'blocked'; attackerId: number; targetId: number; damage: number; pos: Vec3 }
  | { type: 'guardBreak'; targetId: number; pos: Vec3 }
  | { type: 'death'; targetId: number; killerId: number; placement: number }
  | { type: 'ultimate'; fighterId: number; animal: AnimalId }
  | { type: 'special'; fighterId: number; animal: AnimalId }
  | {
      type: 'telegraph';
      fighterId: number;
      kind: 'special' | 'ultimate';
      pos: Vec3;
      radius: number;
      yaw: number;
      arcDeg: number;
      windup: number;
    }
  | { type: 'pickup'; fighterId: number; kind: PickupState['kind']; pos: Vec3 }
  | { type: 'comboFinisher'; fighterId: number }
  | { type: 'crateBreak'; crateId: number; pos: Vec3 }
  /**
   * A basic melee swing's hit test was just evaluated (the impact instant, ~55%
   * of the swing) — emitted for EVERY basic swing, hit or miss. `pos`/`yaw`/
   * `range`/`arcDeg` are exactly the sector the sim tested (attacker-centred,
   * radius `range`, full angle `arcDeg`; 360 for radial slams), so the renderer
   * draws the real hitbox rather than a guess.
   */
  | { type: 'swingImpact'; fighterId: number; pos: Vec3; yaw: number; range: number; arcDeg: number; step: 0 | 1 | 2 }
  /**
   * v1.3: an ultimate resolved its target and is starting. `from`/`to` are the
   * path endpoints (lock: caster → victim; line: start → end; ground: caster →
   * zone centre), `range`/`width` the targeting numbers (width = zone radius×2
   * for ground), `windup` the seconds until it goes active.
   */
  | {
      type: 'ultimateTarget';
      fighterId: number;
      animal: AnimalId;
      kind: UltTargetKind;
      targetId: number;
      from: Vec3;
      to: Vec3;
      range: number;
      width: number;
      windup: number;
    }
  /** v1.3: the ultimate key was pressed with a full bar but no valid target; nothing was spent. */
  | { type: 'ultimateFizzle'; fighterId: number; reason: 'noTarget' }
  /** v1.3: a discrete beat of a multi-stage ultimate (each maul strike, slam, blink…). */
  | { type: 'ultimateStage'; fighterId: number; animal: AnimalId; stage: number; targetId: number; pos: Vec3 }
  /** v1.3: instantaneous relocation (panther shadow-step). Renderers must not interpolate across it. */
  | { type: 'blink'; fighterId: number; from: Vec3; to: Vec3 }
  /** v1.3: a projectile landed (boulder). */
  | { type: 'projectileImpact'; kind: ProjectileState['kind']; pos: Vec3; radius: number; ownerId: number; hitId: number }
  /** A fighter stepped on an armed plate; the hazard is now up. */
  | { type: 'trapTriggered'; trapId: number; kind: TrapKind; pos: Vec3; fighterId: number }
  /** Trap damage to one fighter (aggregated ~2x/s; unblockable, never negated by blocking). */
  | { type: 'trapDamage'; trapId: number; kind: TrapKind; targetId: number; damage: number; pos: Vec3 }
  /** The active window ended; the trap goes on cooldown. */
  | { type: 'trapExpired'; trapId: number; kind: TrapKind; pos: Vec3 }
  /** Eagle came down from height and hit the ground (AoE). radius/damage are what was applied. */
  | { type: 'landingImpact'; fighterId: number; pos: Vec3; radius: number; damage: number; height: number }
  /**
   * v1.8: a grounded fighter crossed the waterline of the jungle pool (`FighterState.inWater` flipped). `entering` true = stepped /
   * landed in, false = left (or jumped out). `pos` = the fighter's XZ with `y` at the water surface; `strength` 0..1 from its
   * horizontal + vertical speed (see `splashStrength` in config/terrain.ts). Cosmetic: splash VFX + sound.
   */
  | { type: 'splash'; fighterId: number; pos: Vec3; entering: boolean; strength: number }
  | { type: 'matchEnd'; winnerId: number };

/** Narrows {@link GameEvent} to a single variant by its `type` tag. */
export type GameEventOf<T extends GameEvent['type']> = Extract<GameEvent, { type: T }>;

/**
 * Difficulty tier index (1 = Cub … 4 = Apex). Carried in {@link MatchConfig}
 * for the AI layer; the sim itself ignores it (BLUEPRINT §5.1).
 */
export type Difficulty = 1 | 2 | 3 | 4;

/** One roster entry: which animal, and whether the local player controls it. */
export interface RosterEntry {
  animal: AnimalId;
  isPlayer: boolean;
}

/**
 * Match configuration handed to `new World(cfg, seed, bus)` (BLUEPRINT §5.1).
 * `difficulty` is carried for the AI; the sim ignores it.
 */
export interface MatchConfig {
  roster: RosterEntry[];
  difficulty: Difficulty;
  /** v1.8: which arena the match is played in (absent = 'colosseum'; the pre-1.8 behaviour). */
  arena?: ArenaId;
}

/** v1.8: Battle Royale arenas. 'colosseum' is the original; 'jungle' adds trees, moss patches and a wading pool (docs/JUNGLE-PLAN.md). */
export type ArenaId = 'colosseum' | 'jungle';
export const ARENA_IDS: readonly ArenaId[] = ['colosseum', 'jungle'];
