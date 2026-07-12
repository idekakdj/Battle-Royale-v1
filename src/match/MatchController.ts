/**
 * MatchController (WP-I, BLUEPRINT §3/§12/§14) — the playable match Screen.
 *
 * Owns the full per-match object graph: one shared EventBus wired into the
 * World (sim), BotManager (AI), AudioEngine (via attachBus) and the render/HUD
 * event pipes below. Constructed per match, torn down completely on unmount so
 * REMATCH is always a fresh deterministic world with a fresh seed.
 */

import * as THREE from 'three';
import type { Screen } from '../core/ScreenManager';
import { GameLoop } from '../core/GameLoop';
import { EventBus } from '../core/EventBus';
import { wrapAngle, clamp } from '../core/math';
import type {
  AnimalId,
  Difficulty,
  FighterState,
  RosterEntry,
  WorldSnapshot,
} from '../core/types';
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
import { HUD, PauseMenu, type MatchResults } from '../ui';

/** All ten animals, used to fill the bot roster around the player's pick. */
const ALL_ANIMALS: readonly AnimalId[] = [
  'lion',
  'gorilla',
  'crocodile',
  'hippo',
  'rhino',
  'eagle',
  'panther',
  'python',
  'giraffe',
  'mole',
];

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

  constructor(opts: MatchControllerOptions) {
    this.opts = opts;
  }

  // ── Screen lifecycle ────────────────────────────────────────────────────────

  mount(root: HTMLElement): void {
    this.root = root;
    const { canvas, audio, animal, difficulty, seed } = this.opts;

    // Roster: player's pick at index 0, the other nine animals as bots.
    const roster: RosterEntry[] = [
      { animal, isPlayer: true },
      ...ALL_ANIMALS.filter((a) => a !== animal).map(
        (a): RosterEntry => ({ animal: a, isPlayer: false }),
      ),
    ];
    this.rosterAnimals = roster.map((r) => r.animal);

    // One shared bus: sim emits; AI, audio, and the pipes below subscribe.
    this.bus = new EventBus();
    this.world = new World({ roster, difficulty }, seed, this.bus);
    // BotManager MUST share the bus and exist before the first step.
    this.bots = new BotManager(this.bus, difficulty, seed);
    audio.attachBus(this.bus);

    // Render stack.
    this.sceneManager = new SceneManager(canvas);
    this.stadium = new Stadium();
    this.sceneManager.scene.add(this.stadium.root);
    this.effects = new Effects(this.sceneManager.scene);
    this.cameraRig = new CameraRig(this.sceneManager.camera);
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
    this.pauseMenu = new PauseMenu({
      onResume: () => this.resume(),
      onQuitToLobby: () => this.opts.onQuitToLobby(),
      onSettingsChange: (s) => {
        audio.setVolumes({ master: s.master, music: s.music, sfx: s.sfx });
        audio.setMuted(s.muted);
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
    // cycles the spectate target instead of driving the corpse.
    const intent = this.input.getIntent(this.cameraRig.yaw);
    if (!this.playerDead) {
      this.world.setIntent(0, intent);
    } else if (intent.attack) {
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

  // ── Render frame ────────────────────────────────────────────────────────────

  private render(alpha: number, dtRender: number): void {
    const md = this.input.consumeMouseDelta();
    if (md.dx !== 0 || md.dy !== 0) this.cameraRig.applyMouseDelta(md.dx, md.dy);

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

    // Excitement: spikes decay back to the ambient baseline.
    this.excitement +=
      (EXCITEMENT_BASE - this.excitement) * (1 - Math.exp(-dtRender / EXCITEMENT_TAU));
    this.sceneManager.excitement = this.excitement;

    this.effects.update(dtRender);
    this.stadium.update(dtRender, this.excitement);
    this.cameraRig.update(dtRender);
    this.sceneManager.render();

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

  // ── Event pipes (sim → render/HUD/audio glue the bus map can't cover) ──────

  private wireEvents(): void {
    const bus = this.bus;
    const audio = this.opts.audio;

    bus.on('hit', (e) => {
      this.effects.onHit(e.pos, e.damage, { crit: e.heavy });
      if (e.attackerId === 0) this.hud.hitmarker();
      if (e.heavy) this.effects.addShake(0.05);
    });

    bus.on('blocked', (e) => {
      this.effects.onHit(e.pos, e.damage, { blocked: true });
    });

    bus.on('guardBreak', (e) => {
      this.effects.onGuardBreak(e.pos);
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
      if (e.targetId === 0) {
        this.playerPlacement = e.placement;
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

  /** Follow the next alive fighter (LMB cycles); world runs on to matchEnd. */
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
