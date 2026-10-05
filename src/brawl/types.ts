/**
 * Champions League (platform fighter) — shared contracts (v1.4). Architect-owned: other
 * agents may extend ADDITIVELY and must say so in their report.
 *
 * World model: a 2D side-view simulation (X right, Y up, metres), fixed 60 Hz,
 * frame-based move data. Fighters are rendered with the existing 3D animal rigs
 * placed at z = 0 and turned to face ±X. The simulation is headless and
 * deterministic (seeded RNG only, no DOM/three).
 */

import type { AnimalId } from '../core/types';

export const BRAWL_FPS = 60;
export const BRAWL_DT = 1 / BRAWL_FPS;

export interface V2 {
  x: number;
  y: number;
}

/** +1 = facing +X (right), −1 = facing −X (left). */
export type Facing = -1 | 1;

export type StageId = 'brokenColosseum' | 'skyAqueduct' | 'clockworkHeights' | 'crumblingAmphitheatre';
export const STAGE_IDS: readonly StageId[] = ['brokenColosseum', 'skyAqueduct', 'clockworkHeights', 'crumblingAmphitheatre'];

// ── Input ────────────────────────────────────────────────────────────────────

/**
 * One fighter's input for one tick. Players and bots produce exactly this.
 * Attack direction comes from `moveX/moveY` at the moment the attack edge fires:
 * neutral (no direction), side (|moveX| dominant), down (moveY < −0.5), up (moveY > 0.5).
 */
export interface BrawlIntent {
  /** −1..1 held horizontal (A/D, arrows). */
  moveX: number;
  /** −1..1 held vertical: +1 up (W/↑), −1 down (S/↓). Down = fast-fall / drop through soft platforms. */
  moveY: number;
  /** Edge: jump pressed this tick (ground jump, air jump, ledge jump). */
  jump: boolean;
  /** Level: jump held (full-height vs short hop, long glides for the Eagle). */
  jumpHeld: boolean;
  /** Edge: light attack pressed this tick. */
  light: boolean;
  /** Edge: heavy attack pressed this tick. */
  heavy: boolean;
  /** Edge: dodge pressed this tick (spot dodge / roll / air dodge / ledge release). */
  dodge: boolean;
}

// ── Stage ────────────────────────────────────────────────────────────────────

export interface MovingSpec {
  axis: 'x' | 'y';
  /** Peak displacement from the defined position (m). */
  amplitude: number;
  /** Seconds per full cycle. */
  periodS: number;
  /** Phase offset in cycles (0..1). */
  phase: number;
}

/**
 * v1.6: keyframed LOOPING motion. The platform's position at frame f is its defined position plus the offset interpolated
 * (cosine-eased) between `keys` at cycle position `((f/60)/periodS + phase) mod 1`. `keys[0].t` must be 0, `t` strictly increasing
 * in [0,1); the last key eases back to the first (closed loop). A pure function of the frame (rollback-safe). Adds to `moving`.
 */
export interface PathSpec {
  periodS: number;
  /** Phase offset in cycles (0..1). */
  phase: number;
  keys: { t: number; x: number; y: number }[];
}

export interface PlatformDef {
  id: string;
  /** solid: blocks from all sides; soft: pass through from below / drop through with Down. */
  kind: 'solid' | 'soft';
  x0: number;
  x1: number;
  /** Y of the top surface (m). */
  y: number;
  /** Visual/collision thickness below the top surface (solid only collides on all sides). */
  thickness: number;
  moving?: MovingSpec;
  /** v1.6: looping keyframed motion (several platforms can share a `periodS` to re-form layouts together). */
  path?: PathSpec;
  /**
   * v1.6: destroyed after `hits` damaging attack activations overlap it (one count per attacker per move activation, with a short
   * per-attacker cooldown). A destroyed platform has no collision, grabbable ledges vanish, fighters on it fall.
   */
  breakable?: { hits: number };
  /** v1.6: exists ONLY in the stage's FINAL form (reached when every `breakable` platform is destroyed); inactive (no collision, hidden or ghosted) before. */
  finalOnly?: boolean;
  /** Grabbable ledge at the left / right end (solid platforms). */
  ledgeLeft?: boolean;
  ledgeRight?: boolean;
}

export interface StageDef {
  id: StageId;
  name: string;
  blurb: string;
  /** Blast zones: leaving any of these loses a stock (coordinates in stage space, m). */
  blast: { left: number; right: number; top: number; bottom: number };
  platforms: PlatformDef[];
  /** Start positions for up to four fighters (slot 0 = player). */
  spawns: V2[];
  /** Where a respawning fighter materialises (high, above the stage). */
  respawn: V2;
  /** Camera focus when nothing else dictates (usually stage centre). */
  cameraFocus: V2;
  /** Camera half-width (m of visible half-width at the focus plane) clamp for the dynamic zoom. */
  camera: { minHalfW: number; maxHalfW: number };
}

// ── Fighter state ────────────────────────────────────────────────────────────

export type BrawlAction =
  | 'idle'
  | 'walk'
  | 'run'
  | 'jumpSquat'
  | 'rise'
  | 'fall'
  | 'fastFall'
  | 'landing'
  | 'crouch'
  | 'attack'
  | 'dodgeSpot'
  | 'dodgeRoll'
  | 'dodgeAir'
  | 'hitstun'
  | 'tumble'
  | 'knockdown'
  | 'getup'
  | 'ledgeHang'
  | 'ledgeClimb'
  | 'respawn'
  | 'ko';

export type MovePhase = 'startup' | 'active' | 'recovery';

export interface BrawlFighterState {
  id: number;
  animal: AnimalId;
  isPlayer: boolean;
  /** False between losing a stock and respawning, and after the last stock. */
  alive: boolean;
  /** Feet-centre position (m). */
  pos: V2;
  vel: V2;
  facing: Facing;
  grounded: boolean;
  /** Platform currently stood on / hung from (null in the air). */
  platformId: string | null;
  action: BrawlAction;
  /** Frames spent in the current action and its total length (0 = open-ended, e.g. idle/fall). */
  actionFrame: number;
  actionFrames: number;
  /** Current move (only while action === 'attack'). */
  moveId: MoveId | null;
  /** 0 = the base move; 1, 2 = follow-up bodies of a `MoveData.chain` (light-neutral strings). */
  moveChain: number;
  /** True while the current move is the air form (aerial). */
  moveAir: boolean;
  moveFrame: number;
  moveFrames: number;
  movePhase: MovePhase | null;
  /** Frames until the next dodge may start (anti-spam cooldown). */
  dodgeCd: number;
  /** Total length of the hitstun the last hit inflicted (for tumble/recovery animation curves). */
  hitstunTotal: number;
  /** Id of the fighter that last damaged this one (KO credit), −1 if none. */
  lastHitBy: number;
  /** Damage percent (0..999). */
  percent: number;
  stocks: number;
  /** Jumps remaining in the air (resets on landing / ledge grab). */
  jumpsLeft: number;
  /** Remaining hitstun / hitlag (freeze) / invulnerability, in frames. */
  hitstun: number;
  hitlag: number;
  invuln: number;
  /** Last launch (absolute angle in degrees, speed in m/s) — drives tumble visuals. */
  lastLaunch: { angle: number; speed: number } | null;
  // Match stats
  kos: number;
  falls: number;
  damageDealt: number;
  /**
   * WP-S additions (optional, additive; always set by the simulation): sim state the bots may
   * need because the snapshot is all they see.
   *  - recoveryUsed: Heavy-Up already spent this airtime (resets on landing, ledge grab, being hit, respawn).
   *  - airDodgeUsed: the one air dodge of this airtime is spent (resets on landing, ledge grab, respawn).
   *  - freeFall: helpless after an air dodge — no jump / attack / dodge until landing, ledge grab or a hit.
   *  - ledgeCd: frames until a ledge may be grabbed again (30 after releasing one).
   */
  recoveryUsed?: boolean;
  airDodgeUsed?: boolean;
  freeFall?: boolean;
  ledgeCd?: number;
  /** v1.6: true while the fighter is inside a move's `burrow` window (underground: untouchable; the view hides the rig and shows a dirt mound). */
  underground?: boolean;
}

export interface HitboxView {
  fighterId: number;
  moveId: MoveId;
  shape: 'circle' | 'rect';
  /** World-space centre (m). */
  x: number;
  y: number;
  r: number;
  w: number;
  h: number;
}

export interface PlatformState {
  id: string;
  x0: number;
  x1: number;
  /** Current (possibly moving) top-surface Y. */
  y: number;
  /**
   * v1.6 dynamic stages. `active` = currently exists / collides (false for a destroyed breakable and for a `finalOnly` platform
   * before the final form; undefined = true). `hp`/`maxHp` only for breakables (hits remaining / total). Draw cracks from them.
   */
  active?: boolean;
  hp?: number;
  maxHp?: number;
}

export interface BrawlSnapshot {
  frame: number;
  /** Seconds since the match went live (negative during the countdown). */
  time: number;
  /** Seconds of countdown remaining, 0 once live. */
  countdown: number;
  /** Seconds left on the clock, or null for no time limit. */
  timeLeft: number | null;
  fighters: BrawlFighterState[];
  platforms: PlatformState[];
  /** Active hitboxes this frame (debug overlay + VFX). */
  hitboxes: HitboxView[];
  matchOver: boolean;
  /** Winner id, or −1 while undecided / on a draw. */
  winnerId: number;
}

// ── Events ───────────────────────────────────────────────────────────────────

export type BrawlEvent =
  | { type: 'moveStart'; fighterId: number; moveId: MoveId; chain: number; air: boolean }
  | {
      type: 'hit';
      attackerId: number;
      targetId: number;
      moveId: MoveId;
      damage: number;
      percentAfter: number;
      /** Launch speed (m/s) and absolute direction (degrees; 0 = +X, 90 = up). */
      kbSpeed: number;
      angle: number;
      pos: V2;
      sweetspot: boolean;
      hitlag: number;
    }
  | { type: 'jump'; fighterId: number; air: boolean; pos: V2 }
  | { type: 'land'; fighterId: number; pos: V2; hard: boolean }
  | { type: 'dodge'; fighterId: number; kind: 'spot' | 'roll' | 'air'; pos: V2 }
  | { type: 'ledgeGrab'; fighterId: number; pos: V2 }
  | { type: 'ko'; fighterId: number; killerId: number; side: 'left' | 'right' | 'top' | 'bottom'; pos: V2; stocksLeft: number }
  | { type: 'respawn'; fighterId: number; pos: V2 }
  /** v1.6: a breakable platform took a counted hit (`hpLeft` hits remain). */
  | { type: 'platformHit'; platformId: string; attackerId: number; hpLeft: number; maxHp: number; pos: V2 }
  /** v1.6: a breakable platform was destroyed (`x0..x1` = its span at the moment it broke). */
  | { type: 'platformBreak'; platformId: string; pos: V2; x0: number; x1: number; y: number }
  /** v1.6: every breakable is gone — the stage switched to its final form (`finalOnly` platforms are now active). */
  | { type: 'stageFinal' }
  | { type: 'matchEnd'; winnerId: number };

// ── Match config ─────────────────────────────────────────────────────────────

export type BrawlDifficulty = 1 | 2 | 3 | 4;

export interface BrawlRosterEntry {
  animal: AnimalId;
  isPlayer: boolean;
}

export interface BrawlMatchConfig {
  stage: StageId;
  /** 2–4 fighters; slot 0 is the player when present. */
  roster: BrawlRosterEntry[];
  difficulty: BrawlDifficulty;
  /** Stocks per fighter (1–5, default 3). */
  stocks: number;
  /** Time limit in seconds (0 = none, default 300). */
  timeLimitS: number;
}

// ── Moves ────────────────────────────────────────────────────────────────────

/**
 * Attack slots. Light/heavy × direction (N = neutral, S = side, D = down, U = up).
 * Each has a ground form and an optional air form (aerials). Heavy-U is the
 * RECOVERY move (travels upward; usable on the ground as a launcher).
 */
export type MoveId = 'lightN' | 'lightS' | 'lightD' | 'lightU' | 'heavyN' | 'heavyS' | 'heavyD' | 'heavyU';
export const MOVE_IDS: readonly MoveId[] = ['lightN', 'lightS', 'lightD', 'lightU', 'heavyN', 'heavyS', 'heavyD', 'heavyU'];

/**
 * Pose-generator archetypes used by the animation system (B3). A move names one
 * archetype plus parameters; each animal binds archetypes to its own limbs.
 */
export type ArchetypeId =
  | 'swipe' // forepaw slash across the body
  | 'rake' // downward/diagonal claw rake
  | 'jab' // fast straight forelimb thrust
  | 'uppercut' // upward forelimb / head swing
  | 'backhand' // reverse swipe
  | 'bite' // head lunge with jaw snap
  | 'lunge' // full-body forward pounce
  | 'headbutt' // head / horn thrust
  | 'hornUp' // upward horn toss
  | 'tailWhip' // tail sweep
  | 'spinAttack' // body spin
  | 'stomp' // raise a foreleg, stamp down
  | 'slam' // rear up, bring both forelimbs down
  | 'kick' // hind-leg kick
  | 'wingBuffet' // wing flap strike
  | 'dive' // aerial dive / stoop
  | 'leapUp' // upward leaping strike (recoveries)
  | 'charge' // running thrust
  | 'burrow' // dig down / tunnel
  | 'roar' // rear back and roar (shockwave)
  | 'tether' // body/neck stretches for long reach
  | 'neckSwing' // giraffe neck arc
  | 'bellyFlop'; // body drop

/**
 * One hitbox. Coordinates are LOCAL to the fighter: origin at the feet centre,
 * +x = forward (the way it faces), +y = up; mirrored automatically by facing.
 * Frame numbers are move-relative (0 = first startup frame), active in [from, to).
 */
export interface HitboxDef {
  shape: 'circle' | 'rect';
  x: number;
  y: number;
  /** Circle radius (m). */
  r: number;
  /** Rect width / height (m), centred on (x, y). */
  w: number;
  h: number;
  from: number;
  to: number;
  damage: number;
  /** Base knockback speed (m/s) and growth per damage-percent (see BRAWL-PLAN §3). */
  baseKb: number;
  kbGrowth: number;
  /** Launch angle in degrees: 0 = forward, 90 = up, 180 = back, 270 = down (mirrored by facing). */
  angle: number;
  /** Extra hitlag frames and hitstun multiplier (defaults 0 and 1). */
  hitlag?: number;
  hitstunScale?: number;
  /** Optional sweetspot inside the hitbox: bonus damage/knockback when the victim's centre is inside. */
  sweet?: { x: number; y: number; r: number; damageMult: number; kbMult: number };
  /** Keyframed offset added to (x, y) over the active window (travelling hitboxes). */
  path?: { frame: number; x: number; y: number }[];
  /** If set the same victim can be re-hit every `interval` frames within the active window. */
  multiHitInterval?: number;
  effect?: 'none' | 'spike' | 'pull' | 'bury' | 'stun' | 'flinch';
  /** Hits in the same group cannot both hit one victim in one move (default: own group). */
  group?: number;
}

export interface MoveMotion {
  from: number;
  to: number;
  /** Velocity set/added (m/s; vx forward-relative). */
  vx?: number;
  vy?: number;
  /** true = set the velocity, false/undefined = add to it each frame. */
  set?: boolean;
  /** Gravity multiplier during the window (0 = float). */
  gravity?: number;
  /**
   * v1.6: while this window runs the fighter never leaves the platform it stands on — the travel stops (vx = 0, position
   * clamped) at the platform edge even if the planned distance is longer (burrow dashes must not carry the mole off a ledge).
   */
  stopAtEdge?: boolean;
}

export interface MoveBody {
  name: string;
  archetype: ArchetypeId;
  /** Free-form animation parameters for the archetype (reach, height, side…). */
  anim?: Record<string, number | string>;
  startup: number;
  active: number;
  recovery: number;
  hitboxes: HitboxDef[];
  motion?: MoveMotion[];
  /** Aerials: extra frames of landing lag when landing during recovery; autocancel window [from,to). */
  landingLag?: number;
  autoCancel?: { from: number; to: number };
  /** Armor: absorb `hits` hits (taking damage × dmgScale, no knockback/hitstun) during [from, to). */
  armor?: { from: number; to: number; hits: number; dmgScale?: number };
  /**
   * WP-D addition (additive): the fighter cannot be hit during the move frames [from, to)
   * (same rule as dodge invulnerability: hitboxes skip the victim, no flash/knockback). Used by
   * the Panther's Shadow Dash (startup) and Shadow Leap (rising vanish) only.
   */
  invuln?: { from: number; to: number };
  /**
   * v1.6: underground window (move-relative frames [from, to)). While it runs the fighter is invulnerable (hits "bypass" it),
   * `BrawlFighterState.underground` is true, and `motion` entries with `stopAtEdge` keep it on its platform. The view hides the
   * rig and draws a travelling dirt mound; the pose layer sinks/emerges the body at the window boundaries. Ground form only.
   */
  burrow?: { from: number; to: number };
  /** Cancel windows into other moves. */
  cancels?: { into: MoveId[]; from: number; to: number; onHitOnly: boolean }[];
  /** Whether holding left/right at the start turns the fighter around. */
  turnOnStart?: boolean;
}

export interface MoveData {
  id: MoveId;
  ground: MoveBody;
  /** Air form: partial overrides of `ground`; null = identical to ground. */
  air: Partial<MoveBody> | null;
  /**
   * Follow-up bodies for repeated presses of the same button inside the previous body's
   * `cancels` window (only `lightN` uses this: chain[0] = 2nd hit, chain[1] = 3rd hit).
   * Ground only; each chain body must have a `cancels` entry into the same MoveId to continue.
   */
  chain?: MoveBody[];
  groundOnly?: boolean;
  airOnly?: boolean;
}

// ── Characters ───────────────────────────────────────────────────────────────

export interface CharacterStats {
  /** Knockback resistance: heavier = launched less far. ~75 (light) … 150 (heavy). */
  weight: number;
  walkSpeed: number;
  runSpeed: number;
  /** Max horizontal air speed and air acceleration. */
  airSpeed: number;
  airAccel: number;
  /** Ground jump / air jump launch speeds (m/s) and total jumps (ground + air). */
  jumpVel: number;
  airJumpVel: number;
  maxJumps: number;
  /** Gravity multiplier, max fall speed and fast-fall speed (m/s). */
  gravityMult: number;
  fallSpeed: number;
  fastFallSpeed: number;
  /** Eagle-style glide: max fall speed (m/s) while jump is held in the air (not attacking, not in hitstun). Omit = no glide. */
  glideFall?: number;
  /** Hurtbox size (m): width and height. */
  width: number;
  height: number;
  /** Dodge: invulnerable frames and total frames for spot/roll/air dodges. */
  dodgeInvuln: number;
  dodgeFrames: number;
}

export interface MovesetDef {
  animal: AnimalId;
  /** One-line identity shown in the mode's character select. */
  tagline: string;
  stats: CharacterStats;
  moves: Record<MoveId, MoveData>;
}

// ── Cross-module helper types ────────────────────────────────────────────────

/**
 * Contract of the headless world (`src/brawl/sim/BrawlWorld.ts`:
 * `new BrawlWorld(config: BrawlMatchConfig, seed: number)`).
 * Fighter ids are the roster indices (slot 0 = the player when present).
 */
export interface BrawlWorldApi {
  readonly config: BrawlMatchConfig;
  /** Latest intent for fighter `id`; held until replaced. Edge fields (jump/light/heavy/dodge) are consumed by the next step. */
  setIntent(id: number, intent: BrawlIntent): void;
  /** Advance exactly one 60 Hz frame. */
  step(): void;
  /** A fresh, independent snapshot object each call (the renderer keeps prev + cur for interpolation). */
  snapshot(): BrawlSnapshot;
  /** Events emitted since the last drain, in order. */
  drainEvents(): BrawlEvent[];
}

/** Contract of one bot (`src/brawl/ai/BrawlBot.ts`: `new BrawlBot(selfId, difficulty, seed)`). */
export interface BrawlBotApi {
  /** Called once per sim frame with the latest snapshot; returns the intent for `selfId`. Pure function of (snapshot, own memory, rng). */
  update(snapshot: BrawlSnapshot): BrawlIntent;
}

/**
 * Contract of the 3D view (`src/brawl/render/BrawlView.ts`:
 * `createBrawlView(canvas, config: BrawlMatchConfig, opts?) => BrawlViewApi`).
 * Owns scene, camera, fighter rigs, stage visuals and VFX; reads snapshots only.
 */
export interface BrawlViewApi {
  /** Draw one frame. `alpha` ∈ [0,1] interpolates between `prev` and `cur`; `events` = events since the previous render call. */
  render(prev: BrawlSnapshot, cur: BrawlSnapshot, alpha: number, events: readonly BrawlEvent[], dtRender: number): void;
  resize(): void;
  /** Debug overlay for hit/hurtboxes (also toggled by the F3 key in the controller). */
  setDebugBoxes(on: boolean): void;
  /** World→screen helper for HUD anchors (percent bubbles, offscreen arrows), in CSS pixels. */
  project(x: number, y: number): { x: number; y: number; onScreen: boolean };
  dispose(): void;
}

/** Contract of the keyboard/mouse input reader (`src/brawl/ui/BrawlInput.ts`). */
export interface BrawlInputApi {
  /** Current intent; edge fields are true for exactly one poll after the key goes down. */
  poll(): BrawlIntent;
  setEnabled(enabled: boolean): void;
  dispose(): void;
}

/** A neutral intent (nothing pressed). Use `idleIntent()` when you need a mutable copy. */
export const IDLE_INTENT: Readonly<BrawlIntent> = Object.freeze({
  moveX: 0,
  moveY: 0,
  jump: false,
  jumpHeld: false,
  light: false,
  heavy: false,
  dodge: false,
});

export function idleIntent(): BrawlIntent {
  return { moveX: 0, moveY: 0, jump: false, jumpHeld: false, light: false, heavy: false, dodge: false };
}
