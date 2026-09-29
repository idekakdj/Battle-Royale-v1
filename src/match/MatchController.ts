/**
 * MatchController (WP-I, BLUEPRINT §3/§12/§14) — the playable match Screen.
 *
 * Owns the full per-match object graph: one shared EventBus wired into the
 * World (sim), BotManager (AI), AudioEngine (via attachBus) and the render/HUD
 * event pipes below. Constructed per match, torn down completely on unmount so
 * REMATCH is always a fresh deterministic world with a fresh seed.
 *
 * WP-M (v1.1) additions, all player-side and outside the sim contract:
 *  - seeded bot seating (`seating.ts`) so neighbours differ per match;
 *  - lock-on (E / MMB toggle, Tab cycle): the camera yaw eases toward the
 *    target (mouse input adds a decaying bias instead of being fought; flicking
 *    far away breaks the lock) and `aimYaw` faces it;
 *  - soft aim assist (`aimAssist.ts`) while an attack/special/ult starts or
 *    runs, applied to the player's intent right before `setIntent`;
 *  - world-anchored overlay: enemy nameplates, lock reticle, off-screen threat
 *    arrows, damage-direction wedges (`CombatOverlay.ts`);
 *  - mouse sensitivity from `gk-settings.sensitivity` (live from the pause menu).
 */

import * as THREE from 'three';
import type { Screen } from '../core/ScreenManager';
import { GameLoop } from '../core/GameLoop';
import { EventBus } from '../core/EventBus';
import { wrapAngle, clamp } from '../core/math';
import type {
  AnimalId,
  Difficulty,
  FighterAction,
  FighterIntent,
  FighterState,
  WorldSnapshot,
} from '../core/types';
import { ANIMALS } from '../config/animals';
import { World } from '../sim/World';
import { BotManager } from '../ai/BotManager';
import { SceneManager } from '../render/SceneManager';
import { Stadium } from '../render/Stadium';
import { CameraRig } from '../render/CameraRig';
import { Effects } from '../render/Effects';
import { AnimalFactory } from '../render/animals/AnimalFactory';
import type { BaseRig } from '../render/animals/Animator';
import type { AudioEngine } from '../audio/AudioEngine';
import { InputManager } from '../input/InputManager';
import { HUD, PauseMenu, loadSettings, type MatchResults } from '../ui';
import { seatRoster } from './seating';
import {
  LOCK_ON,
  assistAimYaw,
  cycleLockTarget,
  pickLockTarget,
  yawTo,
  type AimTarget,
} from './aimAssist';
import { CombatOverlay, isHidden } from './CombatOverlay';

/** Camera pivot height above the fighter's feet, per animal (§11.5 ~1.2–2.6). */
const HEAD_HEIGHT: Record<AnimalId, number> = {
  lion: 1.6,
  gorilla: 1.9,
  crocodile: 1.2,
  hippo: 1.9,
  rhino: 1.9,
  eagle: 1.7,
  panther: 1.4,
  python: 1.3,
  giraffe: 2.6,
  mole: 1.2,
};

// Cosmetic swing-ribbon defaults (the real hit math lives in the sim).
const SWING_RANGE = 2.4;
const SWING_ARC_DEG = 110;

const RESULTS_DELAY_MS = 2500;
const EXCITEMENT_BASE = 0.2;
const EXCITEMENT_TAU = 3.0; // seconds, decay back toward baseline

// Lock-on camera feel (render side).
const LOCK_YAW_RATE = 5; // 1/s — exponential ease of camera yaw toward the target
const LOCK_BIAS_TAU = 0.9; // s — mouse-look bias decays back to 0 (camera returns)
const LOCK_BREAK_BIAS = 1.75; // rad (~100°) — flicking this far off releases the lock
/** Specials' assist reach is their own range, capped (leaps/dashes are long). */
const SPECIAL_ASSIST_RANGE_CAP = 8;

const _size = new THREE.Vector2();
const _box = new THREE.Box3();

function isAttackAction(a: FighterAction): boolean {
  return a === 'attack1' || a === 'attack2' || a === 'attack3' || a === 'special' || a === 'ultimate';
}

export interface MatchControllerOptions {
  canvas: HTMLCanvasElement;
  audio: AudioEngine;
  animal: AnimalId;
  difficulty: Difficulty;
  seed: number;
  /** Fired once, ~2.5 s after matchEnd, with the assembled results. */
  onMatchEnd: (results: MatchResults) => void;
  /** Pause menu → QUIT TO LOBBY. */
  onQuitToLobby: () => void;
}

export class MatchController implements Screen {
  private readonly opts: MatchControllerOptions;

  // Per-match object graph (created in mount, destroyed in unmount).
  private bus!: EventBus;
  private world!: World;
  private bots!: BotManager;
  private sceneManager!: SceneManager;
  private stadium!: Stadium;
  private cameraRig!: CameraRig;
  private effects!: Effects;
  private rigs: BaseRig[] = [];
  private input!: InputManager;
  private hud!: HUD;
  private pauseMenu!: PauseMenu;
  private overlay!: CombatOverlay;
  private loop!: GameLoop;
  private root: HTMLElement | null = null;

  private snap!: WorldSnapshot;
  private rosterAnimals: AnimalId[] = [];

  // Interpolation buffers: previous/current sim transform per fighter.
  private posPrev!: Float32Array; // xyz per fighter
  private posCurr!: Float32Array;
  private yawPrev!: Float32Array;
  private yawCurr!: Float32Array;
  private prevActions: string[] = [];

  // Match-flow state.
  private paused = false;
  private fightShown = false;
  private lastCountdown = 0;
  private lastBloodlust = 1;
  private excitement = EXCITEMENT_BASE;
  private playerDead = false;
  private playerPlacement = 1;
  private spectateId = 0;
  private matchOverAt = -1;
  private finished = false;
  private pickupActive: boolean[] = [];

  // Mouse sensitivity: the rig is built with `rigSensitivity`; later changes
  // (pause menu) scale the raw delta by sensitivity / rigSensitivity.
  private rigSensitivity = 0.0024;
  private sensitivity = 0.0024;

  // Lock-on + aim assist (player only).
  private lockId = -1;
  private lockBias = 0;
  private aimTargets: AimTarget[] = [];

  constructor(opts: MatchControllerOptions) {
    this.opts = opts;
  }

  // ── Screen lifecycle ────────────────────────────────────────────────────────

  mount(root: HTMLElement): void {
    this.root = root;
    const { canvas, audio, animal, difficulty, seed } = this.opts;

    // Roster: player's pick at index 0, the other nine seated by a seeded
    // shuffle (fresh neighbours every match / REMATCH).
    const roster = seatRoster(animal, seed);
    this.rosterAnimals = roster.map((r) => r.animal);

    // One shared bus: sim emits; AI, audio, and the pipes below subscribe.
    this.bus = new EventBus();
    this.world = new World({ roster, difficulty }, seed, this.bus);
    // BotManager MUST share the bus and exist before the first step.
    this.bots = new BotManager(this.bus, difficulty, seed);
    audio.attachBus(this.bus);

    // Render stack.
    const settings = loadSettings();
    this.rigSensitivity = settings.sensitivity;
    this.sensitivity = settings.sensitivity;
    this.sceneManager = new SceneManager(canvas);
    this.stadium = new Stadium();
    this.sceneManager.scene.add(this.stadium.root);
    this.effects = new Effects(this.sceneManager.scene);
    this.cameraRig = new CameraRig(this.sceneManager.camera, { sensitivity: this.rigSensitivity });
    this.cameraRig.shakeSource = () => this.effects.getShakeOffset();

    // Fighter rigs; roster order = fighter id.
    this.rigs = roster.map((r) => AnimalFactory.createRig(r.animal));
    for (const rig of this.rigs) this.sceneManager.scene.add(rig.root);

    // Interp buffers seeded from the initial snapshot (spawn poses).
    const n = roster.length;
    this.posPrev = new Float32Array(n * 3);
    this.posCurr = new Float32Array(n * 3);
    this.yawPrev = new Float32Array(n);
    this.yawCurr = new Float32Array(n);
    this.snap = this.world.snapshot();
    this.captureTransforms();
    this.posPrev.set(this.posCurr);
    this.yawPrev.set(this.yawCurr);
    this.prevActions = this.snap.fighters.map((f) => f.action);
    this.pickupActive = this.snap.pickups.map(() => false);
    this.syncPickups();
    this.aimTargets = roster.map((_, id): AimTarget => ({ id, x: 0, z: 0, valid: false }));
    this.lockId = -1;
    this.lockBias = 0;

    // Camera follows the player until spectate.
    this.spectateId = 0;
    this.cameraRig.follow(this.makeFollow(0), HEAD_HEIGHT[animal]);
    this.cameraRig.snap();

    // Input + overlays.
    this.input = new InputManager({ onPause: () => this.requestPause() });
    this.input.attach(canvas);
    this.input.enable();
    this.hud = new HUD();
    this.hud.mount(root);
    this.overlay = new CombatOverlay();
    const layer = this.hud.layer;
    if (layer !== null) {
      this.overlay.mount(
        layer,
        this.rosterAnimals,
        this.rigs.map((r) => r.root.position),
        this.measurePlateHeights(),
        0,
      );
    }
    this.pauseMenu = new PauseMenu({
      onResume: () => this.resume(),
      onQuitToLobby: () => this.opts.onQuitToLobby(),
      onSettingsChange: (s) => {
        audio.setVolumes({ master: s.master, music: s.music, sfx: s.sfx });
        audio.setMuted(s.muted);
        this.sensitivity = s.sensitivity;
      },
    });

    this.wireEvents();

    // Crowd baseline.
    audio.startCrowd();
    audio.setExcitement(EXCITEMENT_BASE);

    this.loop = new GameLoop({
      step: (dt) => this.step(dt),
      render: (alpha, dtRender) => this.render(alpha, dtRender),
    });
    this.loop.start();
  }

  unmount(): void {
    this.loop.stop();
    this.input.disable();
    this.input.detach();
    this.opts.audio.detachBus();
    this.opts.audio.stopCrowd();
    this.overlay.unmount();
    this.hud.unmount();
    this.pauseMenu.unmount();
    this.bus.clear();
    for (const rig of this.rigs) {
      this.sceneManager.scene.remove(rig.root);
      rig.dispose();
    }
    this.rigs = [];
    this.effects.dispose();
    this.stadium.dispose();
    this.sceneManager.dispose();
    this.root = null;
  }

  // ── Fixed-timestep sim step ─────────────────────────────────────────────────

  private step(dt: number): void {
    // Player intent (camera-relative). While dead, the consumed attack edge
    // (or Tab) cycles the spectate target instead of driving the corpse.
    const intent = this.input.getIntent(this.cameraRig.yaw);
    const lockToggle = this.input.consumeLockToggle();
    const lockCycle = this.input.consumeLockCycle();
    if (!this.playerDead) {
      this.refreshAimTargets();
      this.updateLock(lockToggle, lockCycle);
      this.applyAim(intent);
      this.world.setIntent(0, intent);
    } else if (intent.attack || lockCycle) {
      this.cycleSpectate();
    }

    // Bots read the last completed snapshot, then hand intents to the sim.
    this.bots.update(this.snap, dt);
    for (let id = 1; id < this.rosterAnimals.length; id++) {
      this.world.setIntent(id, this.bots.getIntent(id));
    }

    // Advance, roll interpolation buffers.
    this.posPrev.set(this.posCurr);
    this.yawPrev.set(this.yawCurr);
    this.world.step(dt);
    this.snap = this.world.snapshot();
    this.captureTransforms();

    this.checkCountdown();
    this.checkBloodlust();
    this.checkSwings();
  }

  /** Countdown HUD: snapshot.time is −seconds during the frozen 3-2-1. */
  private checkCountdown(): void {
    const t = this.snap.time;
    if (t < 0) {
      const step = Math.ceil(-t);
      if ((step === 3 || step === 2 || step === 1) && step !== this.lastCountdown) {
        this.lastCountdown = step;
        this.hud.countdown(step);
      }
    } else if (!this.fightShown) {
      this.fightShown = true;
      this.hud.countdown('FIGHT');
      this.opts.audio.roar(this.opts.animal);
    }
  }

  /** Bloodlust ramps (§6) have no GameEvent — watch the multiplier rise. */
  private checkBloodlust(): void {
    const mult = this.snap.bloodlustMult;
    if (mult > this.lastBloodlust + 1e-6) {
      this.lastBloodlust = mult;
      this.hud.bloodlust(mult);
      this.opts.audio.crowdCheer(true);
      this.spike(0.2);
    }
  }

  /** Action transitions into attack1/2/3 → swing whoosh + arc ribbon. */
  private checkSwings(): void {
    const fighters = this.snap.fighters;
    for (let i = 0; i < fighters.length; i++) {
      const f = fighters[i];
      const was = this.prevActions[i];
      if (
        f.action !== was &&
        (f.action === 'attack1' || f.action === 'attack2' || f.action === 'attack3')
      ) {
        this.opts.audio.swing(f.animal);
        this.effects.onSwing(f.pos, f.yaw, SWING_RANGE, SWING_ARC_DEG, i === 0);
      }
      this.prevActions[i] = f.action;
    }
  }

  // ── Lock-on + aim assist (player only; sim contract untouched) ─────────────

  /** Mirror the last snapshot into the reused aim-target array. */
  private refreshAimTargets(): void {
    const fighters = this.snap.fighters;
    for (let i = 0; i < this.aimTargets.length; i++) {
      const t = this.aimTargets[i];
      const f = fighters[i];
      t.x = f.pos.x;
      t.z = f.pos.z;
      t.valid = i !== 0 && f.alive && !isHidden(f);
    }
  }

  /** Validate / toggle / cycle the lock (targets must be fresh). */
  private updateLock(toggle: boolean, cycle: boolean): void {
    const p = this.snap.fighters[0];
    const px = p.pos.x;
    const pz = p.pos.z;
    const n = this.aimTargets.length;
    if (this.lockId >= 0) {
      const t = this.aimTargets[this.lockId];
      const dx = t.x - px;
      const dz = t.z - pz;
      if (!t.valid || dx * dx + dz * dz > LOCK_ON.maxDist * LOCK_ON.maxDist) this.releaseLock();
    }
    if (toggle) {
      if (this.lockId >= 0) this.releaseLock();
      else this.setLock(pickLockTarget(this.cameraRig.yaw, px, pz, this.aimTargets, n));
    }
    if (cycle) {
      this.setLock(
        this.lockId >= 0
          ? cycleLockTarget(this.lockId, px, pz, this.aimTargets, n)
          : pickLockTarget(this.cameraRig.yaw, px, pz, this.aimTargets, n),
      );
    }
  }

  private setLock(id: number): void {
    if (id !== this.lockId) this.lockBias = 0;
    this.lockId = id;
  }

  private releaseLock(): void {
    this.lockId = -1;
    this.lockBias = 0;
  }

  /** Locked: face the target. Otherwise soft-assist attack/special/ult aim. */
  private applyAim(intent: FighterIntent): void {
    const p = this.snap.fighters[0];
    if (!p.alive) return;
    if (this.lockId >= 0) {
      const t = this.aimTargets[this.lockId];
      const dx = t.x - p.pos.x;
      const dz = t.z - p.pos.z;
      if (dx * dx + dz * dz > 1e-4) intent.aimYaw = yawTo(p.pos.x, p.pos.z, t.x, t.z);
      return;
    }
    const acting = isAttackAction(p.action);
    if (!(intent.attack || intent.special || intent.ultimate || acting)) return;
    const def = ANIMALS[p.animal];
    const special = intent.special || p.action === 'special';
    const range = special
      ? Math.min(SPECIAL_ASSIST_RANGE_CAP, Math.max(def.range, def.special.range ?? def.range))
      : def.range;
    intent.aimYaw = assistAimYaw(intent.aimYaw, p.pos.x, p.pos.z, this.aimTargets, this.aimTargets.length, range);
  }

  /** Render-side lock camera: ease yaw toward the target plus a decaying mouse bias. */
  private updateLockCamera(mouseDx: number, dtRender: number): void {
    if (this.lockId < 0 || this.playerDead) return;
    this.lockBias -= mouseDx * this.sensitivity;
    if (Math.abs(this.lockBias) > LOCK_BREAK_BIAS) {
      this.releaseLock(); // the player deliberately looked away
      return;
    }
    this.lockBias *= Math.exp(-dtRender / LOCK_BIAS_TAU);
    const pp = this.rigs[0].root.position;
    const tp = this.rigs[this.lockId].root.position;
    const dx = tp.x - pp.x;
    const dz = tp.z - pp.z;
    if (dx * dx + dz * dz < 0.64) return; // on top of each other: yaw is unstable
    const desired = Math.atan2(dx, dz) + this.lockBias;
    const yaw = this.cameraRig.yaw;
    this.cameraRig.yaw = wrapAngle(yaw + wrapAngle(desired - yaw) * (1 - Math.exp(-dtRender * LOCK_YAW_RATE)));
  }

  // ── Render frame ────────────────────────────────────────────────────────────

  private render(alpha: number, dtRender: number): void {
    const md = this.input.consumeMouseDelta();
    const mdx = md.dx;
    if (md.dx !== 0 || md.dy !== 0) {
      const k = this.sensitivity / this.rigSensitivity;
      this.cameraRig.applyMouseDelta(md.dx * k, md.dy * k);
    }

    // Fighter roots from interpolated sim transforms; rigs pose from state.
    const fighters = this.snap.fighters;
    for (let i = 0; i < fighters.length; i++) {
      const rig = this.rigs[i];
      const i3 = i * 3;
      rig.root.position.set(
        this.posPrev[i3] + (this.posCurr[i3] - this.posPrev[i3]) * alpha,
        this.posPrev[i3 + 1] + (this.posCurr[i3 + 1] - this.posPrev[i3 + 1]) * alpha,
        this.posPrev[i3 + 2] + (this.posCurr[i3 + 2] - this.posPrev[i3 + 2]) * alpha,
      );
      const y0 = this.yawPrev[i];
      rig.root.rotation.y = y0 + wrapAngle(this.yawCurr[i] - y0) * alpha;
      rig.update(fighters[i], dtRender);
    }
    this.updateLockCamera(mdx, dtRender);

    // Excitement: spikes decay back to the ambient baseline.
    this.excitement +=
      (EXCITEMENT_BASE - this.excitement) * (1 - Math.exp(-dtRender / EXCITEMENT_TAU));
    this.sceneManager.excitement = this.excitement;

    this.effects.update(dtRender);
    this.stadium.update(dtRender, this.excitement);
    this.cameraRig.update(dtRender);
    this.sceneManager.render();

    this.sceneManager.renderer.getSize(_size);
    this.overlay.update(
      this.snap,
      this.sceneManager.camera,
      this.cameraRig.yaw,
      _size.x,
      _size.y,
      this.playerDead ? this.spectateId : 0,
      this.playerDead ? -1 : this.lockId,
      !this.playerDead && this.matchOverAt < 0,
      performance.now(),
    );
    this.hud.update(this.snap, 0);
    this.syncPickups();

    // Results hand-off ~2.5 s after the sim declares the match over.
    if (this.matchOverAt >= 0 && !this.finished && performance.now() - this.matchOverAt >= RESULTS_DELAY_MS) {
      this.finished = true;
      this.opts.onMatchEnd(this.buildResults());
    }
  }

  /** Mirror snapshot pickup availability onto the stadium pad icons. */
  private syncPickups(): void {
    const pickups = this.snap.pickups;
    for (let i = 0; i < pickups.length; i++) {
      const p = pickups[i];
      if (this.pickupActive[i] !== p.active) {
        this.pickupActive[i] = p.active;
        this.stadium.setPickupVisible(p.id, p.kind, p.active);
      }
    }
  }

  private captureTransforms(): void {
    const fighters = this.snap.fighters;
    for (let i = 0; i < fighters.length; i++) {
      const f = fighters[i];
      const i3 = i * 3;
      this.posCurr[i3] = f.pos.x;
      this.posCurr[i3 + 1] = f.pos.y;
      this.posCurr[i3 + 2] = f.pos.z;
      this.yawCurr[i] = f.yaw;
    }
  }

  /**
   * Nameplate anchor height per fighter id: the rest-pose model top (measured
   * once at mount), falling back to the camera head height.
   */
  private measurePlateHeights(): number[] {
    return this.rigs.map((rig, id) => {
      const fallback = HEAD_HEIGHT[this.rosterAnimals[id]];
      rig.root.updateMatrixWorld(true);
      _box.setFromObject(rig.root);
      if (_box.isEmpty()) return fallback;
      const h = _box.max.y - rig.root.position.y;
      return Number.isFinite(h) && h > 0.5 ? Math.min(h, 5.5) : fallback;
    });
  }

  // ── Event pipes (sim → render/HUD/audio glue the bus map can't cover) ──────

  private wireEvents(): void {
    const bus = this.bus;
    const audio = this.opts.audio;

    bus.on('hit', (e) => {
      this.effects.onHit(e.pos, e.damage, { crit: e.heavy });
      if (e.attackerId === 0) this.hud.hitmarker();
      if (e.targetId === 0 && e.attackerId !== 0) this.overlay.onPlayerHit(e.attackerId, performance.now());
      if (e.heavy) this.effects.addShake(0.05);
    });

    bus.on('blocked', (e) => {
      this.effects.onHit(e.pos, e.damage, { blocked: true });
    });

    bus.on('guardBreak', (e) => {
      this.effects.onGuardBreak(e.pos);
      this.overlay.onGuardBreak(e.targetId, performance.now());
      this.spike(0.08);
    });

    bus.on('telegraph', (e) => {
      const animal = this.rosterAnimals[e.fighterId];
      const kind =
        e.arcDeg >= 360 ? 'ring' : animal === 'rhino' || animal === 'hippo' ? 'rect' : 'arc';
      this.effects.telegraph(kind, e.pos, e.radius, e.yaw, e.arcDeg, e.windup, e.fighterId === 0);
    });

    bus.on('ultimate', (e) => {
      const f = this.fighter(e.fighterId);
      if (f !== null) this.effects.onUltimate(f.pos, e.animal);
      this.spike(0.25);
    });

    bus.on('death', (e) => {
      const victim = this.fighter(e.targetId);
      if (victim !== null) this.effects.onDeath(victim.pos, this.rigs[e.targetId].accent);
      const killerAnimal =
        e.killerId >= 0 ? this.rosterAnimals[e.killerId] : this.rosterAnimals[e.targetId];
      this.hud.killFeed({
        killerAnimal,
        victimAnimal: this.rosterAnimals[e.targetId],
        killerIsPlayer: e.killerId === 0,
        victimIsPlayer: e.targetId === 0,
      });
      if (e.killerId >= 0) audio.roar(killerAnimal);
      audio.spikeExcitement(0.4);
      this.spike(0.35);
      if (e.targetId === this.lockId) this.releaseLock();
      if (e.targetId === 0) {
        this.playerPlacement = e.placement;
        this.releaseLock();
        this.enterSpectate();
      } else if (this.playerDead && e.targetId === this.spectateId) {
        this.cycleSpectate();
      }
    });

    bus.on('crateBreak', (e) => {
      this.stadium.breakCrate(e.crateId);
      this.effects.onDust(e.pos, 1.6);
    });

    bus.on('matchEnd', () => {
      this.matchOverAt = performance.now();
      this.releaseLock();
      this.spike(0.6);
    });
  }

  private fighter(id: number): FighterState | null {
    return id >= 0 && id < this.snap.fighters.length ? this.snap.fighters[id] : null;
  }

  private spike(amount: number): void {
    this.excitement = clamp(this.excitement + amount, 0, 1);
  }

  // ── Spectate ────────────────────────────────────────────────────────────────

  /** Follow fn per target id; a NEW closure per switch triggers the 0.5 s blend. */
  private makeFollow(id: number): (out: THREE.Vector3) => void {
    return (out: THREE.Vector3) => {
      const i3 = id * 3;
      // Latest sim transform (interp smoothing is handled by the rig blend).
      out.set(this.posCurr[i3], this.posCurr[i3 + 1], this.posCurr[i3 + 2]);
    };
  }

  private enterSpectate(): void {
    this.playerDead = true;
    this.cameraRig.setSpectate(true);
    this.cycleSpectate();
  }

  /** Follow the next alive fighter (LMB / Tab cycles); world runs on to matchEnd. */
  private cycleSpectate(): void {
    const fighters = this.snap.fighters;
    const n = fighters.length;
    let next = -1;
    for (let k = 1; k <= n; k++) {
      const id = (this.spectateId + k) % n;
      if (id !== 0 && fighters[id].alive) {
        next = id;
        break;
      }
    }
    if (next === -1) return;
    this.spectateId = next;
    const animal = this.rosterAnimals[next];
    this.cameraRig.follow(this.makeFollow(next), HEAD_HEIGHT[animal]);
    this.hud.setSpectate({ name: `${animal.toUpperCase()} (BOT)`, animal });
  }

  // ── Pause ───────────────────────────────────────────────────────────────────

  private requestPause(): void {
    if (this.paused || this.finished || this.root === null) return;
    if (this.matchOverAt >= 0) return; // match already decided — let it play out
    this.paused = true;
    this.loop.pause();
    this.input.disable(); // also exits pointer lock
    this.pauseMenu.mount(this.root);
  }

  private resume(): void {
    if (!this.paused) return;
    this.paused = false;
    this.pauseMenu.unmount();
    this.input.enable();
    this.input.requestPointerLock();
    this.loop.resume();
  }

  // ── Results ─────────────────────────────────────────────────────────────────

  private buildResults(): MatchResults {
    const s = this.snap;
    const p = s.fighters[0];
    const victory = s.winnerId === 0;
    return {
      victory,
      placement: victory ? 1 : this.playerDead ? this.playerPlacement : 2,
      animal: this.opts.animal,
      kills: p.kills,
      damageDealt: Math.round(p.damageDealt),
      damageBlocked: Math.round(p.damageBlocked),
      ultsUsed: p.ultsUsed,
      matchTimeS: Math.max(0, s.time),
      difficulty: this.opts.difficulty,
    };
  }
}
