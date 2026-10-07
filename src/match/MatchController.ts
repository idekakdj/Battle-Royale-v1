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
 *
 * WP-P (v1.2) additions:
 *  - arena traps: a {@link TrapRenderer} mirrors `snapshot.traps` every render
 *    frame (nothing is drawn while the list is empty) and reacts to
 *    `trapTriggered` / `trapExpired`; `trapDamage` → small orange numbers;
 *  - eagle `landingImpact` → crack/dust/shockwave, shake scaled by proximity;
 *  - world-positioned audio: the listener follows the player (or spectated
 *    fighter) and a fire-crackle bed swells near burning fire pits;
 *  - kill feed `cause: 'trap'` for environment deaths (`killerId === -1`);
 *  - `hud.pickupToast(kind)` for the player's own pickups.
 *
 * v1.8 jungle (WP-J5): the match's MAP (`opts.arena`, or the online driver's `sim.arena`) builds the matching scenery through
 * `createArenaScene` (render/arenaScene.ts; the colosseum stays the unchanged `Stadium`), the `splash` event feeds the water FX, a
 * HUD chip shows the local player's terrain speed ("Swimming · 62 % speed" / "Mossy ground · 65 % speed"), and the QA shortcut
 * (`?br=1&…`) exposes `window.__gkBr = { world, controller }` with a manual `tick` / `renderFrame`.
 *
 * WP-T (v1.3) additions (ultimate targeting UI + render/audio infra):
 *  - `UltIndicators` (pooled ring / ribbon / reticle / arc / zone) + the
 *    `UltFxDispatcher` that routes `ultimateTarget` / `ultimateStage` / `blink` /
 *    `projectileImpact` to per-animal ult VFX modules (`render/ultFx/<animal>.ts`);
 *  - `blink` snaps the fighter's interpolation (no slide across the teleport);
 *  - `snapshot.projectiles` drawn by `ProjectileRenderer` (boulder + trail);
 *  - READY-state preview (`UltPreview`): range ring / path / zone + a LOCK bracket
 *    and HUD tag on the would-be target; "NO TARGET" on the icon; a brief
 *    "NO TARGET IN RANGE" hint on `ultimateFizzle` (Settings: Ultimate targeting
 *    preview, `gk-settings.ultPreview`).
 *  - §5b hitbox fidelity: swing ribbons are drawn from `swingImpact` (the
 *    exact sector the sim tested, at the impact instant) and the player gets
 *    a faint attack-range wedge (Settings → Combat → Attack range indicator).
 */

import * as THREE from 'three';
import type { Screen } from '../core/ScreenManager';
import { GameLoop, FIXED_DT } from '../core/GameLoop';
import type { EventBus } from '../core/EventBus';
import { wrapAngle, clamp } from '../core/math';
import type {
  AnimalId,
  ArenaId,
  Difficulty,
  FighterAction,
  FighterIntent,
  FighterState,
  ProjectileState,
  TrapKind,
  TrapState,
  Vec3,
  WorldSnapshot,
} from '../core/types';
import { ANIMALS } from '../config/animals';
import { SceneManager } from '../render/SceneManager';
import { createArenaScene, type ArenaScene } from '../render/arenaScene';
import { getArena } from '../config/arenas';
import { terrainTagText } from '../ui/terrainTag';
import { CameraRig } from '../render/CameraRig';
import { Effects } from '../render/Effects';
import { TrapRenderer } from '../render/traps/TrapRenderer';
import { RangeIndicator } from '../render/RangeIndicator';
import { UltIndicators } from '../render/ultFx/primitives';
import { UltFxDispatcher } from '../render/ultFx';
import { UltPreview } from '../render/ultFx/preview/UltPreview';
import { ProjectileRenderer } from '../render/ultFx/projectiles/ProjectileRenderer';
import { AnimalFactory } from '../render/animals/AnimalFactory';
import type { BaseRig } from '../render/animals/Animator';
import type { AudioEngine } from '../audio/AudioEngine';
import { InputManager } from '../input/InputManager';
import { HUD, PauseMenu, loadSettings, saveSettings, type MatchResults } from '../ui';
// v1.3 WP-Q: first-person mode.
import { getFpProfile } from '../render/animals/fp';
import type { FpEyeSample } from '../render/animals/fp/types';
import { angleDiff, easeAngle } from '../render/animals/fp/math';
import { NearCameraFade } from '../render/fpFade';
// v1.3 FP ult: first-person ultimate camera director (per-animal view directives + vignette / flash overlay).
import { UltCamera, type UltEnv } from '../render/animals/fp/ultCam';
import { getUltDirector } from '../render/animals/fp/ult';
import { UltOverlay } from '../render/animals/fp/ultOverlay';
import { LocalSimDriver, type SimDriver } from './SimDriver';
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

// v1.2 §5b: swing ribbons are drawn from the sim's `swingImpact` sector (exact
// range / arc / yaw at the impact instant). Until the first such event arrives
// (older sim), a fallback ribbon at swing start uses the animal's config sector.
/** Range indicator shows while a rival's body is within this × the player's reach. */
const RANGE_INDICATOR_NEAR = 1.6;
/** Above this altitude melee can't reach the ground; hide the indicator. */
const RANGE_INDICATOR_MAX_Y = 2.6;

const RESULTS_DELAY_MS = 2500;
const EXCITEMENT_BASE = 0.2;
const EXCITEMENT_TAU = 3.0; // seconds, decay back toward baseline

// Lock-on camera feel (render side).
const LOCK_YAW_RATE = 5; // 1/s — exponential ease of camera yaw toward the target
const LOCK_BIAS_TAU = 0.9; // s — mouse-look bias decays back to 0 (camera returns)
const LOCK_BREAK_BIAS = 1.75; // rad (~100°) — flicking this far off releases the lock
/** Specials' assist reach is their own range, capped (leaps/dashes are long). */
const SPECIAL_ASSIST_RANGE_CAP = 8;
/** Mean fighter body radius (m): basic `def.range` is measured to the body since v1.2. */
const ASSIST_BODY_PAD = 0.7;

// v1.2 traps / landing slam (render side).
const NO_TRAPS: readonly TrapState[] = [];
/** Landing-slam shake reaches this far past the slam radius (m). */
const LANDING_SHAKE_PAD = 6;

const NO_PROJECTILES: readonly ProjectileState[] = [];

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
  /** v1.8: the Battle Royale map (absent = 'colosseum'). Online, the driver's `arena` wins. */
  arena?: ArenaId;
  /** v1.8 QA shortcut (`?br=1&qa=1`): expose `window.__gkBr` in production builds too (dev builds always do). */
  qa?: boolean;
  /** Fired once, ~2.5 s after matchEnd, with the assembled results. */
  onMatchEnd: (results: MatchResults) => void;
  /** Pause menu → QUIT TO LOBBY. */
  onQuitToLobby: () => void;
  /**
   * v1.5 online: where the simulation lives (see `SimDriver.ts`). Omitted = the offline World + BotManager path, which
   * behaves exactly as before. An online driver also decides names, pausability and (for clients) pulls snapshots.
   */
  sim?: SimDriver;
}

export class MatchController implements Screen {
  private readonly opts: MatchControllerOptions;

  // Per-match object graph (created in mount, destroyed in unmount).
  private bus!: EventBus;
  private sim!: SimDriver; // v1.5: World+BotManager (offline), + network host, or a snapshot-pulling client
  /** Display name per fighter id (`null` = animal name). All null offline. */
  private names: readonly (string | null)[] = [];
  private sceneManager!: SceneManager;
  private stadium!: ArenaScene;
  /** The map this match is played on (drives the scene, the HUD terrain chip and the results). */
  private arenaId: ArenaId = 'colosseum';
  /** QA only (`window.__gkBr.controller.qaIntent = {moveX: 1}`): fields merged over the player's real input each sim tick. */
  qaIntent: Partial<FighterIntent> | null = null;
  private cameraRig!: CameraRig;
  private effects!: Effects;
  private fpFade!: NearCameraFade; // v1.3 WP-Q: own effects fade out around the first-person camera
  private traps!: TrapRenderer;
  private rangeIndicator!: RangeIndicator;
  // v1.3 ultimate targeting UI / VFX (WP-T).
  private indicators!: UltIndicators;
  private ultFx!: UltFxDispatcher;
  private ultPreview!: UltPreview;
  private projectiles!: ProjectileRenderer;
  private ultPreviewOn = true;
  /** Fighters that blinked during the last sim step (snap interpolation, no slide). */
  private blinkSnap: boolean[] = [];
  private accentHex: number[] = [];
  private tagHeights: number[] = [];
  private readonly projMerge: ProjectileState[] = [];
  /** QA / demo hook (set by `match.demo.ts`): extra projectiles drawn on top of `snapshot.projectiles`. */
  debugProjectiles: ProjectileState[] | null = null;
  private readonly tagV = new THREE.Vector3();
  private readonly targetPosFn = (id: number, out: number[]): void => {
    const r = this.rigs[id].root.position;
    out[0] = r.x;
    out[1] = r.z;
  };
  /** Set once the sim emits `swingImpact` (then the start-of-swing fallback ribbon stops). */
  private swingImpactSeen = false;
  /** Kind of the last trap that hurt each fighter (kill-feed glyph for trap deaths). */
  private lastTrapKind: (TrapKind | undefined)[] = [];
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

  // v1.3 WP-Q: first-person mode (view toggle `V`, `gk-settings.view`).
  private fpWanted = false;
  /** True while the own rig's head/neck/… are hidden (camera close to the eye). */
  private fpHidden = false;
  /** Own rig's visual yaw in first person (eases toward the camera yaw). */
  private fpVisYaw = 0;
  private fpVisYawInit = false;
  private crosshairEl: HTMLElement | null = null;
  private crosshairOn = true;
  // v1.3 FP ult: the director writes into `cameraRig.ult`; the overlay paints its vignette / flash.
  private ultCam!: UltCamera;
  private readonly ultOverlay = new UltOverlay();
  private readonly ultEnv: UltEnv = {
    yaw: 0,
    pitch: 0,
    eye: { x: 0, y: 0, z: 0 },
    eyeForward: 0,
    victim: (id) => (id >= 0 && id < this.rigs.length ? this.rigs[id].root.position : null),
    setYaw: (y) => {
      this.cameraRig.yaw = y;
    },
  };

  constructor(opts: MatchControllerOptions) {
    this.opts = opts;
  }

  // ── Screen lifecycle ────────────────────────────────────────────────────────

  mount(root: HTMLElement): void {
    this.root = root;
    const { canvas, audio, animal, difficulty, seed } = this.opts;

    // Roster: player's pick at index 0, the other nine seated by a seeded
    // shuffle (fresh neighbours every match / REMATCH). Online, the driver
    // supplies the fixed room roster with the local player remapped to id 0.
    // One shared bus: sim emits; AI, audio, and the pipes below subscribe.
    this.sim = this.opts.sim ?? new LocalSimDriver({ animal, difficulty, seed, arena: this.opts.arena });
    this.arenaId = this.sim.arena ?? this.opts.arena ?? 'colosseum';
    const roster = this.sim.roster;
    this.rosterAnimals = roster.map((r) => r.animal);
    this.names = this.sim.names;
    this.bus = this.sim.bus;
    audio.attachBus(this.bus);

    // Render stack.
    const settings = loadSettings();
    this.rigSensitivity = settings.sensitivity;
    this.sensitivity = settings.sensitivity;
    this.sceneManager = new SceneManager(canvas);
    // v1.8: styles the light rig / fog / sky for the arena, builds its scenery (colosseum = the unchanged Stadium) and adds it.
    this.stadium = createArenaScene(this.sceneManager, getArena(this.arenaId));
    const fxBefore = new Set(this.sceneManager.scene.children); // v1.3 WP-Q
    this.effects = new Effects(this.sceneManager.scene);
    this.fpFade = new NearCameraFade(this.sceneManager.scene, fxBefore);
    this.traps = new TrapRenderer(this.sceneManager.scene, this.effects);
    this.rangeIndicator = new RangeIndicator(this.sceneManager.scene);
    this.rangeIndicator.setEnabled(settings.rangeIndicator);
    this.indicators = new UltIndicators(this.sceneManager.scene);
    this.ultPreview = new UltPreview(this.indicators);
    this.ultPreviewOn = settings.ultPreview;
    this.projectiles = new ProjectileRenderer(this.sceneManager.scene, this.effects);
    this.swingImpactSeen = false;
    this.lastTrapKind = roster.map(() => undefined);
    this.cameraRig = new CameraRig(this.sceneManager.camera, { sensitivity: this.rigSensitivity });
    this.cameraRig.shakeSource = () => this.effects.getShakeOffset();
    this.ultCam = new UltCamera(getUltDirector, this.cameraRig.ult); // v1.3 FP ult

    // Fighter rigs; roster order = fighter id.
    this.rigs = roster.map((r) => AnimalFactory.createRig(r.animal));
    for (const rig of this.rigs) this.sceneManager.scene.add(rig.root);

    // Interp buffers seeded from the initial snapshot (spawn poses).
    const n = roster.length;
    this.posPrev = new Float32Array(n * 3);
    this.posCurr = new Float32Array(n * 3);
    this.yawPrev = new Float32Array(n);
    this.yawCurr = new Float32Array(n);
    this.snap = this.sim.snapshot();
    this.captureTransforms();
    this.posPrev.set(this.posCurr);
    this.yawPrev.set(this.yawCurr);
    this.prevActions = this.snap.fighters.map((f) => f.action);
    this.pickupActive = this.snap.pickups.map(() => false);
    this.syncPickups();
    this.aimTargets = roster.map((_, id): AimTarget => ({ id, x: 0, z: 0, valid: false }));
    this.lockId = -1;
    this.lockBias = 0;

    // v1.3 ult VFX dispatcher (needs the rigs + first snapshot).
    this.blinkSnap = roster.map(() => false);
    this.accentHex = roster.map((r) => new THREE.Color(ANIMALS[r.animal].accent).getHex());
    this.tagHeights = this.measurePlateHeights();
    this.ultFx = new UltFxDispatcher({
      scene: this.sceneManager.scene,
      effects: this.effects,
      indicators: this.indicators,
      camera: this.sceneManager.camera,
      snapshot: () => this.snap,
      root: (id) => this.rigs[id].root,
      focusId: () => this.focusId(),
      playerId: 0,
      onUltEnd: (id) => this.opts.audio.ultEnd(id),
    });

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
    if (this.names[0] != null) this.hud.setPlayerName(this.names[0]); // v1.5 online: own chosen name on the vitals plate
    this.overlay = new CombatOverlay();
    const layer = this.hud.layer;
    if (layer !== null) {
      this.overlay.mount(
        layer,
        this.rosterAnimals,
        this.rigs.map((r) => r.root.position),
        this.measurePlateHeights(),
        0,
        this.names,
      );
    }
    this.pauseMenu = new PauseMenu({
      onResume: () => this.resume(),
      onQuitToLobby: () => this.opts.onQuitToLobby(),
      // v1.5 online: no pause — the menu says so and quitting is "leave match".
      ...(this.sim.pausable
        ? {}
        : { title: 'Menu', quitLabel: 'Leave Match', note: 'The match keeps running while this menu is open.' }),
      onSettingsChange: (s) => {
        audio.setVolumes({ master: s.master, music: s.music, sfx: s.sfx });
        audio.setMuted(s.muted);
        this.sensitivity = s.sensitivity;
        this.rangeIndicator.setEnabled(s.rangeIndicator);
        this.ultPreviewOn = s.ultPreview;
        if (!s.ultPreview) this.ultPreview.hide(true);
        this.applyViewSettings(s.view, s.fpFov, s.crosshair); // v1.3 WP-Q
      },
    });

    // v1.3 WP-Q: first-person set-up from the persisted settings (crosshair
    // element lives in the HUD layer; the camera samples the own rig's eye).
    this.cameraRig.setFpAnchor((s) => this.sampleFpEye(s));
    this.mountCrosshair();
    if (this.hud.layer !== null) this.ultOverlay.mount(this.hud.layer); // v1.3 FP ult
    this.applyViewSettings(settings.view, settings.fpFov, settings.crosshair, true);

    this.wireEvents();

    // Crowd baseline.
    audio.startCrowd();
    audio.setExcitement(EXCITEMENT_BASE);

    this.loop = new GameLoop({
      step: (dt) => this.step(dt),
      render: (alpha, dtRender) => this.render(alpha, dtRender),
    });
    this.loop.start();
    this.installQaHook();
  }

  unmount(): void {
    this.removeQaHook();
    this.loop.stop();
    this.input.disable();
    this.input.detach();
    this.opts.audio.detachBus();
    this.opts.audio.stopCrowd();
    this.opts.audio.stopFireBed();
    this.overlay.unmount();
    if (this.crosshairEl !== null) this.crosshairEl.remove(); // v1.3 WP-Q
    this.ultOverlay.dispose(); // v1.3 FP ult
    this.crosshairEl = null;
    this.hud.unmount();
    this.pauseMenu.unmount();
    this.bus.clear();
    this.sim.dispose(); // v1.5: online drivers drop their network listeners
    for (const rig of this.rigs) {
      this.sceneManager.scene.remove(rig.root);
      rig.dispose();
    }
    this.rigs = [];
    this.traps.dispose();
    this.rangeIndicator.dispose();
    this.ultFx.dispose();
    this.ultPreview.hide(true);
    this.projectiles.dispose();
    this.indicators.dispose();
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
    if (this.qaIntent !== null) Object.assign(intent, this.qaIntent);
    const lockToggle = this.input.consumeLockToggle();
    const lockCycle = this.input.consumeLockCycle();
    // v1.3 WP-Q: V toggles first/third person (ignored while dead / spectating).
    if (this.input.consumeViewToggle() && !this.playerDead) this.toggleView();
    let playerIntent: FighterIntent | null = null;
    if (!this.playerDead) {
      this.refreshAimTargets();
      this.updateLock(lockToggle, lockCycle);
      this.applyAim(intent);
      playerIntent = intent;
    } else if (intent.attack || lockCycle) {
      this.cycleSpectate();
    }

    // Advance (player intent → bots read the last completed snapshot → sim step), rolling the interpolation buffers.
    // v1.5: the SimDriver does this (World+BotManager offline; + network host; or just "send the intent" for a client).
    this.posPrev.set(this.posCurr);
    this.yawPrev.set(this.yawCurr);
    this.sim.tick(dt, playerIntent);
    if (!this.sim.stepsSim) return; // online client: snapshots arrive via pullSim() once per render frame
    this.snap = this.sim.snapshot();
    this.captureTransforms();
    this.applyBlinkSnaps();

    this.checkCountdown();
    this.checkBloodlust();
    this.checkSwings();
  }

  /**
   * v1.5 online client: install the freshest host state. The driver's view is already interpolated (and blink-safe), so both
   * interpolation buffers get it and the render `alpha` is moot; the events that are now due go out on the same bus the
   * local World would have used, so audio / hit VFX / kill feed / ultimate FX work unchanged.
   */
  private pullSim(): void {
    const pulled = this.sim.pull?.() ?? null;
    if (pulled === null) return;
    this.snap = pulled.snapshot;
    this.captureTransforms();
    this.posPrev.set(this.posCurr);
    this.yawPrev.set(this.yawCurr);
    for (let i = 0; i < pulled.events.length; i++) this.bus.emit(pulled.events[i]);
    this.applyBlinkSnaps();
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

  /**
   * Action transitions into attack1/2/3 → swing whoosh. The arc ribbon comes
   * from `swingImpact` (exact sector, impact instant); only while the sim has
   * not emitted one yet does a config-accurate fallback ribbon play here.
   */
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
        if (!this.swingImpactSeen) {
          const def = ANIMALS[f.animal];
          this.effects.onSwing(f.pos, f.yaw, def.range, def.arcDeg, i === 0);
          if (i === 0) this.rangeIndicator.pulse(0.5);
        }
      }
      this.prevActions[i] = f.action;
    }
  }

  /**
   * Player's attack-range wedge: real `range`/`arcDeg` from config (read live —
   * the numbers are tuned per build), interpolated transform; visible while a
   * rival's body is within {@link RANGE_INDICATOR_NEAR}× reach or a swing runs.
   */
  private updateRangeIndicator(dtRender: number): void {
    const fighters = this.snap.fighters;
    const p = fighters[0];
    const def = ANIMALS[p.animal];
    let show = false;
    if (!this.playerDead && p.alive && this.matchOverAt < 0 && this.snap.time >= 0 && p.pos.y < RANGE_INDICATOR_MAX_Y) {
      if (p.action === 'attack1' || p.action === 'attack2' || p.action === 'attack3') show = true;
      else {
        const reach = def.range * RANGE_INDICATOR_NEAR;
        for (let i = 1; i < fighters.length; i++) {
          const f = fighters[i];
          if (!f.alive || isHidden(f)) continue;
          const d = Math.hypot(f.pos.x - p.pos.x, f.pos.z - p.pos.z) - ANIMALS[f.animal].radius;
          if (d <= reach) {
            show = true;
            break;
          }
        }
      }
    }
    const root = this.rigs[0].root;
    this.rangeIndicator.update(
      dtRender,
      root.position.x, root.position.y, root.position.z, root.rotation.y,
      def.range, def.arcDeg, show,
    );
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
    // `def.range` is measured to the target's body (v1.2); assist compares
    // against target centres, so add the average body radius back.
    const meleeReach = def.range + ASSIST_BODY_PAD;
    const range = special
      ? Math.min(SPECIAL_ASSIST_RANGE_CAP, Math.max(meleeReach, def.special.range ?? meleeReach))
      : meleeReach;
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

  private render(loopAlpha: number, dtRender: number): void {
    // v1.5 online client: the view is already interpolated, so render at alpha = 1 after pulling the freshest state.
    let alpha = loopAlpha;
    if (!this.sim.stepsSim) {
      this.pullSim();
      alpha = 1;
    }
    const md = this.input.consumeMouseDelta();
    const mdx = md.dx * this.cameraRig.ult.mouseYaw; // v1.3 FP ult: a directive may briefly lock the yaw look
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
      if (i === 0 && this.fpWanted && !this.playerDead) {
        // v1.3 WP-Q: in first person the own body faces where the player looks.
        rig.root.rotation.y = this.fpBodyYaw(fighters[0], rig.root.rotation.y, dtRender);
        rig.fpxLook = this.cameraRig.fpPitch;
      }
      rig.update(fighters[i], dtRender);
    }
    this.updateLockCamera(mdx, dtRender);
    this.updateFpView(dtRender); // v1.3 WP-Q: grabbed → look at the attacker; hide/show own head

    // Excitement: spikes decay back to the ambient baseline.
    this.excitement +=
      (EXCITEMENT_BASE - this.excitement) * (1 - Math.exp(-dtRender / EXCITEMENT_TAU));
    this.sceneManager.excitement = this.excitement;

    // Arena traps + world-positioned audio follow the camera's fighter.
    const focusId = this.focusId();
    const focus = this.rigs[focusId].root.position;
    this.traps.setFocus(focus.x, focus.z);
    this.stadium.setPickupFocus(focus.x, focus.z);
    this.traps.update(this.snap.traps ?? NO_TRAPS, dtRender);
    this.opts.audio.setListener(focus.x, focus.z, focusId);
    this.opts.audio.setFireBed(this.traps.fireProximity(focus.x, focus.z));
    this.updateRangeIndicator(dtRender);
    this.updateUltSystems(alpha, dtRender);

    this.effects.update(dtRender);
    this.stadium.update(dtRender, this.excitement);
    this.updateFpUlt(dtRender); // v1.3 FP ult: first-person ultimate camera director
    this.cameraRig.update(dtRender);
    this.fpClipOutlines(); // v1.3 FP ult: no black screen when the eye is inside another fighter
    this.syncFpRig(); // v1.3 WP-Q: own head hidden once the camera is close to the eye
    this.fpFade.setEnabled(this.cameraRig.fpAmount > 0.2);
    this.fpFade.apply(this.sceneManager.camera);
    this.ultFx.nearFade(this.sceneManager.camera, this.cameraRig.fpAmount > 0.2); // v1.3 FP ult: own ult VFX fade near the eye
    if (this.rigs[0].fpxActive) {
      const cp = this.sceneManager.camera.position;
      this.rigs[0].fpxAnchorPass(cp.x, cp.y, cp.z, this.cameraRig.yaw, this.cameraRig.fpPitch, this.cameraRig.fpAmount);
    }
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
    this.hud.setTerrainTag(this.playerDead ? null : terrainTagText(this.snap.fighters[0], this.arenaId));
    this.updateUltHud();
    this.syncPickups();

    // Results hand-off ~2.5 s after the sim declares the match over.
    if (this.matchOverAt >= 0 && !this.finished && performance.now() - this.matchOverAt >= RESULTS_DELAY_MS) {
      this.finished = true;
      this.opts.onMatchEnd(this.buildResults());
    }
  }

  // ── v1.3 ultimate targeting UI / VFX (WP-T) ─────────────────────────────────

  /** `blink`: the sim teleported a fighter, so draw it at the destination with no slide. */
  private applyBlinkSnaps(): void {
    const flags = this.blinkSnap;
    for (let i = 0; i < flags.length; i++) {
      if (!flags[i]) continue;
      flags[i] = false;
      const i3 = i * 3;
      this.posPrev[i3] = this.posCurr[i3];
      this.posPrev[i3 + 1] = this.posCurr[i3 + 1];
      this.posPrev[i3 + 2] = this.posCurr[i3 + 2];
    }
  }

  /** Per render frame: ult VFX modules, READY preview, boulders, then the indicator fades. */
  private updateUltSystems(alpha: number, dtRender: number): void {
    this.ultFx.update(dtRender);
    this.updateUltPreview(dtRender);
    let list: readonly ProjectileState[] = this.snap.projectiles ?? NO_PROJECTILES;
    const dbg = this.debugProjectiles;
    if (dbg !== null && dbg.length > 0) {
      const merged = this.projMerge;
      merged.length = 0;
      for (let i = 0; i < list.length; i++) merged.push(list[i]);
      for (let i = 0; i < dbg.length; i++) merged.push(dbg[i]);
      list = merged;
    }
    this.projectiles.update(list, dtRender, (1 - alpha) * FIXED_DT);
    this.indicators.update(dtRender);
  }

  /**
   * READY-state preview (plan section 4): only with a full ultimate bar, alive, in
   * the match, not casting, not paused. The aim is the one the sim will use
   * (locked target direction, else camera yaw).
   */
  private updateUltPreview(dtRender: number): void {
    const p = this.snap.fighters[0];
    const enabled =
      this.ultPreviewOn &&
      !this.paused &&
      !this.playerDead &&
      p.alive &&
      this.matchOverAt < 0 &&
      this.snap.time >= 0 &&
      p.ultCharge >= 100 &&
      p.ultPhase === undefined &&
      p.action !== 'ultimate' &&
      p.action !== 'dead';
    let aimYaw = this.cameraRig.yaw;
    if (this.lockId >= 0) {
      const t = this.aimTargets[this.lockId];
      if (t.valid && (t.x - p.pos.x) ** 2 + (t.z - p.pos.z) ** 2 > 1e-4) aimYaw = yawTo(p.pos.x, p.pos.z, t.x, t.z);
    }
    const root = this.rigs[0].root.position;
    this.ultPreview.update(
      dtRender,
      { enabled, player: p, fighters: this.snap.fighters, aimYaw, px: root.x, py: root.y, pz: root.z },
      this.targetPosFn,
    );
  }

  /** HUD side of the preview: NO TARGET on the ult icon + the LOCK tag over the would-be target. */
  private updateUltHud(): void {
    this.hud.setUltPreview(this.ultPreview.status);
    const id = this.ultPreview.targetId;
    if (id < 0) {
      this.hud.setLockTag(false);
      return;
    }
    const pos = this.rigs[id].root.position;
    const v = this.tagV.set(pos.x, pos.y + (this.tagHeights[id] ?? 2) + 0.35, pos.z).project(this.sceneManager.camera);
    if (v.z >= 1 || Math.abs(v.x) > 1.2 || Math.abs(v.y) > 1.2) {
      this.hud.setLockTag(false);
      return;
    }
    this.sceneManager.renderer.getSize(_size);
    this.hud.setLockTag(true, (v.x * 0.5 + 0.5) * _size.x, (-v.y * 0.5 + 0.5) * _size.y);
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
      if (e.targetId === 0) this.fpHitKick(e.attackerId, e.damage / 22, e.heavy ? 1.5 : 1); // v1.3 WP-Q
    });

    bus.on('blocked', (e) => {
      this.effects.onHit(e.pos, e.damage, { blocked: true });
      if (e.targetId === 0) this.fpHitKick(e.attackerId, e.damage / 40, 0.6); // v1.3 WP-Q
    });

    bus.on('guardBreak', (e) => {
      this.effects.onGuardBreak(e.pos);
      this.overlay.onGuardBreak(e.targetId, performance.now());
      this.spike(0.08);
      if (e.targetId === 0) this.fpHitKick(-1, 1, 2); // v1.3 WP-Q
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
      // killerId −1 = the arena (trap): no credit, trap glyph in the feed.
      const killerName = e.killerId >= 0 ? (this.names[e.killerId] ?? null) : null; // v1.5 online names
      const victimName = this.names[e.targetId] ?? null;
      this.hud.killFeed({
        killerAnimal,
        victimAnimal: this.rosterAnimals[e.targetId],
        killerIsPlayer: e.killerId === 0,
        victimIsPlayer: e.targetId === 0,
        ...(killerName !== null ? { killerName } : {}),
        ...(victimName !== null ? { victimName } : {}),
        ...(e.killerId === -1 ? { cause: 'trap' as const } : {}),
        ...(e.killerId === -1 && this.lastTrapKind[e.targetId] !== undefined
          ? { trapKind: this.lastTrapKind[e.targetId] }
          : {}),
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

    // ── v1.3 ultimates: targeting events, blink, boulders, fizzle ────────────
    bus.on('ultimateTarget', (e) => {
      if (e.fighterId === 0) this.ultCam.onTarget(e.to); // v1.3 FP ult
      this.ultFx.target(e);
    });

    bus.on('ultimateStage', (e) => {
      if (e.fighterId === 0) this.ultCam.onStage(e.stage, e.pos); // v1.3 FP ult
      this.ultFx.stage(e);
    });

    bus.on('blink', (e) => {
      if (e.fighterId >= 0 && e.fighterId < this.blinkSnap.length) this.blinkSnap[e.fighterId] = true;
      this.effects.onBlink(e.from, e.to, this.accentHex[e.fighterId] ?? 0x8a5cff);
      if (e.fighterId === 0 && this.fpWanted) this.ultCam.onBlink(e.from, e.to); // v1.3 FP ult
      this.ultFx.blink(e);
    });

    bus.on('projectileImpact', (e) => {
      const near = this.nearness(e.pos, e.radius + 8);
      this.effects.onBoulderImpact(e.pos, e.radius, near);
      this.ultFx.impact(e);
      if (near > 0.3) this.spike(0.08);
    });

    bus.on('ultimateFizzle', (e) => {
      if (e.fighterId === 0) this.hud.ultFizzle();
    });

    // ── v1.2 §5b: the swing ribbon IS the tested sector, at the impact instant.
    bus.on('swingImpact', (e) => {
      this.swingImpactSeen = true;
      this.effects.onSwing(e.pos, e.yaw, e.range, e.arcDeg, e.fighterId === 0);
      if (e.fighterId === 0) this.rangeIndicator.pulse(1);
      if (e.fighterId === 0) this.fpAttackKick(); // v1.3 WP-Q
    });

    // ── v1.2: arena traps, eagle landing slam, pickup toast ─────────────────
    bus.on('trapTriggered', (e) => {
      this.traps.onTriggered(e);
      if (e.fighterId === 0 || this.nearness(e.pos, 8) > 0.5) this.spike(0.06);
    });

    bus.on('trapDamage', (e) => {
      this.lastTrapKind[e.targetId] = e.kind; // kill-feed glyph if this tick is fatal
      // Numbers ride on the victim's current position (the event pos is where
      // the tick was aggregated).
      const victim = this.fighter(e.targetId);
      this.effects.onTrapDamage(victim !== null ? victim.pos : e.pos, e.damage, e.kind);
    });

    bus.on('trapExpired', (e) => {
      this.traps.onExpired(e);
    });

    bus.on('landingImpact', (e) => {
      const near = this.nearness(e.pos, e.radius + LANDING_SHAKE_PAD);
      this.effects.onLandingImpact(e.pos, e.radius, e.damage, near);
      if (e.fighterId === 0 || near > 0.4) this.spike(0.1);
    });

    bus.on('pickup', (e) => {
      if (e.fighterId === 0) this.hud.pickupToast(e.kind);
    });

    // v1.8 jungle: a fighter crossed the pool's waterline → splash rings + droplets (the audio engine hears it through the same bus).
    bus.on('splash', (e) => this.effects.handleSplashEvent(e));
  }

  /** Fighter the camera follows: the player, or the spectated bot once dead. */
  private focusId(): number {
    return this.playerDead ? this.spectateId : 0;
  }

  /** 0..1: how close `pos` is to the camera's fighter (1 = on top, 0 = ≥ range). */
  private nearness(pos: Vec3, range: number): number {
    const p = this.rigs[this.focusId()].root.position;
    const d = Math.hypot(pos.x - p.x, pos.z - p.z);
    return clamp(1 - d / range, 0, 1);
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
    this.ultPreview.hide(true);
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
    this.hud.setSpectate({ name: this.names[next] ?? `${animal.toUpperCase()} (BOT)`, animal });
  }

  // ── v1.3 WP-Q: first-person mode ────────────────────────────────────────────
  // The view mode is a pure render/camera concern: the sim, intents and aim
  // (aimYaw = camera yaw) are untouched. Spectating / the death cam always use
  // the third-person camera (CameraRig.setSpectate forces it).

  /** Apply persisted / live view settings (pause menu, mount). */
  private applyViewSettings(view: 'third' | 'first', fpFov: number, crosshair: boolean, initial = false): void {
    this.cameraRig.setFpFov(fpFov);
    this.crosshairOn = crosshair;
    const wantFirst = view === 'first';
    if (wantFirst !== this.fpWanted) this.setViewMode(wantFirst, initial);
    else this.refreshCrosshair();
  }

  /** V key: flip the mode and persist it as `gk-settings.view`. */
  private toggleView(): void {
    const next = !this.fpWanted;
    this.setViewMode(next, false);
    saveSettings({ ...loadSettings(), view: next ? 'first' : 'third' });
  }

  private setViewMode(first: boolean, immediate: boolean): void {
    this.fpWanted = first;
    this.fpVisYawInit = false;
    if (!this.playerDead) {
      this.cameraRig.setFirstPerson(first, immediate);
      if (first) this.rigs[0].setFirstPerson(getFpProfile(this.opts.animal), immediate);
    }
    this.refreshCrosshair();
  }

  private mountCrosshair(): void {
    const layer = this.hud.layer;
    if (layer === null) return;
    const el = document.createElement('div');
    el.className = 'gk-crosshair';
    el.setAttribute('aria-hidden', 'true');
    layer.appendChild(el);
    this.crosshairEl = el;
  }

  private refreshCrosshair(): void {
    if (this.crosshairEl === null) return;
    this.crosshairEl.classList.toggle('is-on', this.fpWanted && this.crosshairOn && !this.playerDead);
  }

  /** The camera's eye sample for the own rig. */
  private sampleFpEye(out: FpEyeSample): void {
    this.rigs[0].sampleFpEye(out);
  }

  /** Own body yaw in first person: follows the camera unless the sim is moving the body (fall / hold / flee). */
  private fpBodyYaw(f: FighterState, simYaw: number, dt: number): number {
    if (!this.fpVisYawInit) {
      this.fpVisYaw = simYaw;
      this.fpVisYawInit = true;
    }
    const a = f.action;
    const simDriven = a === 'knockdown' || a === 'dead' || a === 'grabbed' || a === 'feared';
    const target = simDriven ? simYaw : this.cameraRig.yaw;
    this.fpVisYaw = wrapAngle(easeAngle(this.fpVisYaw, target, simDriven ? 10 : 24, dt));
    return this.fpVisYaw;
  }

  /** Per-frame first-person behaviour: while held, look at the grabber (steady camera, no body spin). */
  private updateFpView(dt: number): void {
    if (!this.fpWanted || this.playerDead) return;
    const f = this.snap.fighters[0];
    if (f.action === 'grabbed' && f.grabbedById >= 0 && f.grabbedById < this.rigs.length) {
      const g = this.rigs[f.grabbedById].root.position;
      const p = this.rigs[0].root.position;
      const dx = g.x - p.x;
      const dz = g.z - p.z;
      if (dx * dx + dz * dz > 0.36) {
        const yaw = this.cameraRig.yaw;
        this.cameraRig.yaw = wrapAngle(yaw + angleDiff(yaw, Math.atan2(dx, dz)) * (1 - Math.exp(-dt * 3.5)));
      }
    }
  }

  /**
   * v1.3 FP ult: run the first-person ULTIMATE camera director for the local player (first person + alive only; otherwise
   * it relaxes to neutral), mirror its head-follow scale onto the own rig and paint the vignette / flash overlay.
   */
  private updateFpUlt(dt: number): void {
    const cr = this.cameraRig;
    const env = this.ultEnv;
    const on = this.fpWanted && !this.playerDead && cr.fpAmount > 0.5;
    env.yaw = cr.yaw;
    env.pitch = cr.fpPitch;
    const cp = this.sceneManager.camera.position;
    env.eye.x = cp.x;
    env.eye.y = cp.y;
    env.eye.z = cp.z;
    env.eyeForward = getFpProfile(this.opts.animal).eye.forward;
    this.ultCam.update(dt, on ? this.snap.fighters[0] : null, env);
    this.rigs[0].fpxFollowScale = cr.ult.follow;
    this.ultOverlay.update(cr.ult);
  }

  /**
   * v1.3 FP ult: grapple-style ultimates (lion pin, python bind, croc roll, rhino carry …) put the eye inside / against
   * another fighter's body, and the inverted-hull outline seen from inside fills the view with black. While the first-person
   * camera is inside a fighter's (cylinder) body its outline hull is hidden, so the view stays clear (the body mesh itself is
   * back-face culled from inside).
   */
  private fpClipOutlines(): void {
    const on = this.fpWanted && !this.playerDead && this.cameraRig.fpAmount > 0.5;
    const cam = this.sceneManager.camera.position;
    for (let i = 1; i < this.rigs.length; i++) {
      const p = this.rigs[i].root.position;
      let inside = false;
      if (on) {
        const r = ANIMALS[this.rosterAnimals[i]].radius * 1.35 + 0.15; // generous: bodies are longer than they are wide
        const dx = cam.x - p.x;
        const dz = cam.z - p.z;
        inside = dx * dx + dz * dz < r * r && cam.y > p.y - 0.1 && cam.y < p.y + (this.tagHeights[i] ?? 2) * 0.85;
      }
      this.rigs[i].setOutlineClip(inside);
    }
  }

  /** Own head/neck/… hidden once the camera is near the eye; restored on the way out and on death. */
  private syncFpRig(): void {
    const rig = this.rigs[0];
    const cr = this.cameraRig;
    const amt = cr.fpAmount;
    if (cr.isFirstPerson && !this.playerDead) {
      if (!rig.fpxActive) rig.setFirstPerson(getFpProfile(this.opts.animal), false);
      const hide = this.fpHidden ? amt > 0.55 : amt > 0.4;
      if (hide !== this.fpHidden) {
        this.fpHidden = hide;
        rig.setFpHidden(hide);
      }
    } else {
      if (this.fpHidden && (this.playerDead || amt < 0.65)) {
        this.fpHidden = false;
        rig.setFpHidden(false);
      }
      if (rig.fpxActive && (this.playerDead || amt <= 0)) rig.setFirstPerson(null);
    }
    this.refreshCrosshair();
  }

  /** The player's own swing lands: a small dip (and side tilt on the alternating swipes) so limbless / headless strikes still read. */
  private fpAttackKick(): void {
    if (!this.fpWanted || this.playerDead) return;
    const mult = getFpProfile(this.opts.animal).attackKick ?? 1;
    const a = this.snap.fighters[0].action;
    const roll = a === 'attack1' ? 0.008 : a === 'attack2' ? -0.008 : 0;
    this.cameraRig.addKick(-0.011 * mult * (a === 'attack3' ? 1.6 : 1), roll * mult);
  }

  /** Small camera jolt instead of body motion when the player is hit (first person only). */
  private fpHitKick(attackerId: number, strength: number, mult: number): void {
    if (!this.fpWanted || this.playerDead) return;
    const mag = Math.min(0.05, (0.012 + 0.014 * Math.min(2.5, strength)) * mult);
    let roll = (Math.random() - 0.5) * mag;
    if (attackerId >= 0 && attackerId < this.rigs.length) {
      const a = this.rigs[attackerId].root.position;
      const p = this.rigs[0].root.position;
      const rel = angleDiff(this.cameraRig.yaw, Math.atan2(a.x - p.x, a.z - p.z));
      roll = -Math.sin(rel) * mag;
    }
    this.cameraRig.addKick(mag, roll);
  }

  // ── Pause ───────────────────────────────────────────────────────────────────

  private requestPause(): void {
    if (this.paused || this.finished || this.root === null) return;
    if (this.matchOverAt >= 0) return; // match already decided — let it play out
    this.paused = true;
    this.ultPreview.hide(true);
    this.hud.setUltPreview('off');
    this.hud.setLockTag(false);
    if (this.sim.pausable) {
      this.sceneManager.render(); // refresh the frozen frame without the preview markers
      this.loop.pause();
    } // v1.5 online: the menu opens but the match keeps running (no pause)
    this.input.disable(); // also exits pointer lock
    this.pauseMenu.mount(this.root);
  }

  private resume(): void {
    if (!this.paused) return;
    this.paused = false;
    this.pauseMenu.unmount();
    this.input.enable();
    this.input.requestPointerLock();
    if (this.sim.pausable) this.loop.resume();
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
      arena: this.arenaId,
    };
  }

  // ── v1.8 QA hook (`?br=1&qa=1` or a dev build): window.__gkBr = { world, controller } ─────────────────────────────

  /**
   * QA: advance exactly one fixed sim step (default 1/60 s) — the same code the loop runs. With the loop frozen
   * (`window.requestAnimationFrame = () => 0`) `tick` + {@link renderFrame} step the match by hand.
   */
  tick(dt: number = FIXED_DT): void {
    this.step(dt);
  }

  /** QA: draw one frame at interpolation `alpha` (default 1 = the latest sim state). */
  renderFrame(alpha = 1, dtRender: number = FIXED_DT): void {
    this.render(alpha, dtRender);
  }

  /** The latest simulation snapshot (QA / tests). */
  get snapshot(): WorldSnapshot {
    return this.snap;
  }

  private installQaHook(): void {
    if (typeof window === 'undefined') return;
    if (!(import.meta.env.DEV || this.opts.qa === true)) return;
    (window as unknown as { __gkBr?: unknown }).__gkBr = {
      world: (this.sim as unknown as { world?: unknown }).world ?? null,
      sim: this.sim,
      controller: this,
    };
  }

  private removeQaHook(): void {
    if (typeof window === 'undefined') return;
    const w = window as unknown as { __gkBr?: { controller?: unknown } };
    if (w.__gkBr?.controller === this) delete w.__gkBr;
  }
}
