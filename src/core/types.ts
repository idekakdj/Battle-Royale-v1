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
}

export interface PickupState {
  id: number;
  kind: 'heal' | 'speed' | 'rage';
  pos: Vec3;
  active: boolean;
  respawnT: number;
}

export interface WorldSnapshot {
  time: number;
  fighters: FighterState[];
  pickups: PickupState[];
  crates: { id: number; pos: Vec3; hp: number; alive: boolean }[];
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
}
