/**
 * AudioEngine — public entry for WP-G (BLUEPRINT §13). 100% Web Audio synthesis:
 * no files, no external assets. Everything is envelope shaped (no clicks/pops)
 * and transient voices are capped by a polyphony guard (~24, oldest stolen).
 *
 * Graph:  voices → sfxBus ─┐
 *         crowd  → sfxBus ─┼→ masterGain → destination
 *         music  → musicBus┘
 *
 * - The AudioContext is created lazily and resume()d on the first user gesture
 *   (a one-time pointerdown/keydown listener installed at construction).
 * - Volume/mute settings are read from localStorage `gk-settings`
 *   ({ master, music, sfx: 0..1, muted: boolean }); the UI persists that key and
 *   calls {@link setVolumes} / {@link setMuted} — the engine itself never writes
 *   localStorage.
 * - {@link attachBus} subscribes to the typed {@link EventBus} and maps every
 *   gameplay event to its §13 sound.
 */

import type { AnimalId, PickupState } from '../core/types';
import type { EventBus } from '../core/EventBus';
import { makeWhiteNoise, VoiceManager, type SynthCtx } from './synth';
import { Sfx } from './sfx';
import { Roars } from './roars';
import { Crowd } from './crowd';
import { Music } from './music';

/** Shape of the persisted `gk-settings` localStorage value (UI owns writes). */
export interface AudioSettings {
  master: number; // 0..1
  music: number; // 0..1
  sfx: number; // 0..1
  muted: boolean;
}

const SETTINGS_KEY = 'gk-settings';
const DEFAULT_SETTINGS: AudioSettings = { master: 0.8, music: 0.6, sfx: 0.8, muted: false };
/** Ramp constant (s) for click-free volume changes. */
const VOL_RAMP = 0.03;
/** Excitement spike sizes (decay ~5 s handled by Crowd). */
const SPIKE_KILL = 0.5;
const SPIKE_ULT = 0.35;

function clamp01(x: number): number {
  return Math.min(1, Math.max(0, x));
}

/** Parse persisted settings defensively (missing/corrupt → defaults). */
function readSettings(): AudioSettings {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    if (raw === null) return { ...DEFAULT_SETTINGS };
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null) return { ...DEFAULT_SETTINGS };
    const p = parsed as Record<string, unknown>;
    return {
      master: typeof p.master === 'number' ? clamp01(p.master) : DEFAULT_SETTINGS.master,
      music: typeof p.music === 'number' ? clamp01(p.music) : DEFAULT_SETTINGS.music,
      sfx: typeof p.sfx === 'number' ? clamp01(p.sfx) : DEFAULT_SETTINGS.sfx,
      muted: typeof p.muted === 'boolean' ? p.muted : DEFAULT_SETTINGS.muted,
    };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

export class AudioEngine {
  private settings: AudioSettings = readSettings();

  // Lazily-created audio graph (first gesture / first play call).
  private ctx: AudioContext | null = null;
  private masterGain: GainNode | null = null;
  private sfxBus: GainNode | null = null;
  private musicBus: GainNode | null = null;
  private sc: SynthCtx | null = null;

  private sfxMod: Sfx | null = null;
  private roarsMod: Roars | null = null;
  private crowdMod: Crowd | null = null;
  private musicMod: Music | null = null;

  private busUnsubs: Array<() => void> = [];
  private readonly gestureHandler: () => void;
  private disposed = false;

  constructor() {
    // One-time user-gesture hook: create + resume the context so subsequent
    // event-driven sounds are audible (autoplay policy).
    this.gestureHandler = () => {
      this.removeGestureListeners();
      void this.resume();
    };
    window.addEventListener('pointerdown', this.gestureHandler, { passive: true });
    window.addEventListener('keydown', this.gestureHandler, { passive: true });
  }

  // ── lifecycle ─────────────────────────────────────────────────────────────

  /** Create (if needed) and resume the AudioContext. Safe to call any time. */
  async resume(): Promise<void> {
    if (this.disposed) return;
    const sc = this.ensureGraph();
    if (sc.ctx.state !== 'running') {
      try {
        await sc.ctx.resume();
      } catch {
        /* browser refused (no gesture yet) — the gesture listener retries */
      }
    }
  }

  /** Tear down everything (match teardown / hot reload). */
  dispose(): void {
    this.disposed = true;
    this.detachBus();
    this.removeGestureListeners();
    this.musicMod?.stop();
    this.crowdMod?.stop();
    if (this.ctx !== null) void this.ctx.close();
    this.ctx = null;
    this.sc = null;
    this.masterGain = null;
    this.sfxBus = null;
    this.musicBus = null;
    this.sfxMod = null;
    this.roarsMod = null;
    this.crowdMod = null;
    this.musicMod = null;
  }

  // ── settings (UI calls these; UI persists `gk-settings`) ─────────────────

  /** Current effective settings. */
  getSettings(): AudioSettings {
    return { ...this.settings };
  }

  /** Re-read `gk-settings` from localStorage and apply it. */
  reloadSettings(): void {
    this.settings = readSettings();
    this.applyVolumes();
  }

  /** Set any of the three volume channels (0..1). Click-free ramped. */
  setVolumes(v: { master?: number; music?: number; sfx?: number }): void {
    if (v.master !== undefined) this.settings.master = clamp01(v.master);
    if (v.music !== undefined) this.settings.music = clamp01(v.music);
    if (v.sfx !== undefined) this.settings.sfx = clamp01(v.sfx);
    this.applyVolumes();
  }

  /** Mute/unmute the master output (ramped, no click). */
  setMuted(muted: boolean): void {
    this.settings.muted = muted;
    this.applyVolumes();
  }

  // ── EventBus wiring (BLUEPRINT §5.1 GameEvent → §13 sound map) ───────────

  /** Subscribe to gameplay events. Call {@link detachBus} on match teardown. */
  attachBus(bus: EventBus): void {
    this.detachBus();
    this.busUnsubs = [
      bus.on('hit', (ev) => this.hit(ev.heavy)),
      bus.on('blocked', () => this.blocked()),
      bus.on('guardBreak', () => this.guardBreak()),
      bus.on('death', () => this.deathSfx()),
      bus.on('ultimate', (ev) => this.ultimate(ev.animal)),
      bus.on('special', (ev) => this.special(ev.animal)),
      bus.on('pickup', (ev) => this.pickupChime(ev.kind)),
      bus.on('telegraph', () => this.telegraphTick()),
      bus.on('comboFinisher', () => this.finisher()),
      bus.on('crateBreak', () => this.crateBreak()),
      bus.on('matchEnd', () => this.matchEndSfx()),
    ];
  }

  /** Remove all EventBus subscriptions installed by {@link attachBus}. */
  detachBus(): void {
    for (const off of this.busUnsubs) off();
    this.busUnsubs = [];
  }

  // ── direct-call SFX (UI + render layers) ──────────────────────────────────

  /** UI button click. */
  uiClick(): void {
    this.withSfx((s) => s.uiClick());
  }

  /** UI hover blip (very quiet). */
  uiHover(): void {
    this.withSfx((s) => s.uiHover());
  }

  /** Swing whoosh; pitch scales with the animal's collider radius (§13). */
  swing(animal: AnimalId): void {
    this.withSfx((s) => s.swing(animal));
  }

  /** Hit thud; `heavy` adds the finisher weight layer. */
  hit(heavy = false): void {
    this.withSfx((s) => s.hit(heavy));
  }

  /** Heavier layered thud (combo finisher). */
  finisher(): void {
    this.withSfx((s) => s.finisher());
  }

  /** Metallic block ping. */
  blocked(): void {
    this.withSfx((s) => s.blocked());
  }

  /** Guard break: crack + low boom. */
  guardBreak(): void {
    this.withSfx((s) => s.guardBreak());
  }

  /** Telegraph warning tick. */
  telegraphTick(): void {
    this.withSfx((s) => s.telegraph());
  }

  /** Pickup chime per kind (heal/speed/rage). */
  pickupChime(kind: PickupState['kind']): void {
    this.withSfx((s) => s.pickup(kind));
  }

  /** Special-ability whoosh variant for the given animal. */
  special(animal: AnimalId): void {
    this.withSfx((s) => s.special(animal));
  }

  /** Crate splinter. */
  crateBreak(): void {
    this.withSfx((s) => s.crateBreak());
  }

  /** Per-animal roar voice (§13 recipes). Match start / ult / kill flourish. */
  roar(animal: AnimalId): void {
    const sc = this.ready();
    if (sc === null || this.roarsMod === null) return;
    this.roarsMod.roar(animal);
  }

  /** Ultimate: per-animal stinger + roar, and the crowd surges. */
  ultimate(animal: AnimalId): void {
    this.withSfx((s) => s.ultStinger(animal));
    this.roar(animal);
    this.crowdMod?.spike(SPIKE_ULT);
  }

  /** Death: heavy thud + crowd gasp, then a cheer swell (audio-clock delayed). */
  deathSfx(): void {
    this.withSfx((s) => s.deathThud());
    const crowd = this.crowdMod;
    if (crowd !== null && this.ready() !== null) {
      crowd.gasp();
      crowd.cheer(false, 0.45);
      crowd.spike(SPIKE_KILL);
    }
  }

  /** Match end: full crowd eruption. */
  matchEndSfx(): void {
    const crowd = this.crowdMod;
    if (crowd !== null && this.ready() !== null) {
      crowd.cheer(true);
      crowd.spike(1);
    }
  }

  // ── crowd ─────────────────────────────────────────────────────────────────

  /** Start the looping crowd bed (match start). Idempotent. */
  startCrowd(): void {
    const sc = this.ready();
    if (sc === null) return;
    this.crowdMod?.start();
  }

  /** Fade out and stop the crowd bed (match teardown). */
  stopCrowd(): void {
    this.crowdMod?.stop();
  }

  /** Set the baseline crowd excitement (0..1); event spikes stack on top. */
  setExcitement(x: number): void {
    this.crowdMod?.setExcitement(x);
  }

  /** Manually add a decaying excitement spike (0..1). */
  spikeExcitement(amount: number): void {
    this.crowdMod?.spike(amount);
  }

  /** Cheer swell — `big` for bloodlust steps / victory moments. */
  crowdCheer(big = false): void {
    if (this.ready() === null) return;
    this.crowdMod?.cheer(big);
  }

  // ── music ─────────────────────────────────────────────────────────────────

  /** Start the lobby loop (~92 BPM, Am–F–C–G). Idempotent. No music mid-match. */
  playLobbyMusic(): void {
    if (this.disposed) return;
    this.ensureGraph();
    this.musicMod?.playLobby();
  }

  /** Stop any music (lobby loop or fanfare tail). */
  stopMusic(): void {
    this.musicMod?.stop();
  }

  /** Results fanfare: victory = brass-ish rise, defeat = minor descent. */
  playResultsFanfare(victory: boolean): void {
    if (this.ready() === null) return;
    this.musicMod?.playResultsFanfare(victory);
  }

  // ── internals ─────────────────────────────────────────────────────────────

  private removeGestureListeners(): void {
    window.removeEventListener('pointerdown', this.gestureHandler);
    window.removeEventListener('keydown', this.gestureHandler);
  }

  /** Build the AudioContext + gain graph once. */
  private ensureGraph(): SynthCtx {
    if (this.sc !== null) return this.sc;
    const ctx = new AudioContext();
    const master = ctx.createGain();
    const sfxBus = ctx.createGain();
    const musicBus = ctx.createGain();
    sfxBus.connect(master);
    musicBus.connect(master);
    master.connect(ctx.destination);

    const voices = new VoiceManager(ctx, sfxBus, 24);
    const sc: SynthCtx = { ctx, sfxBus, musicBus, voices, noise: makeWhiteNoise(ctx) };

    this.ctx = ctx;
    this.masterGain = master;
    this.sfxBus = sfxBus;
    this.musicBus = musicBus;
    this.sc = sc;
    this.sfxMod = new Sfx(sc);
    this.roarsMod = new Roars(sc);
    this.crowdMod = new Crowd(sc);
    this.musicMod = new Music(sc);
    this.applyVolumes();
    return sc;
  }

  /**
   * Graph if it exists AND the context is running; otherwise `null` (transient
   * SFX are skipped rather than queued up while suspended, so resuming never
   * releases a burst of stale sounds). Never *creates* the context — that only
   * happens on the first user gesture or an explicit resume/music call, so
   * event-driven sounds can never trigger an autoplay-policy warning.
   */
  private ready(): SynthCtx | null {
    if (this.disposed) return null;
    const sc = this.sc;
    if (sc === null) return null;
    return sc.ctx.state === 'running' ? sc : null;
  }

  /** Run `fn` against the Sfx module iff the context is running. */
  private withSfx(fn: (s: Sfx) => void): void {
    const sc = this.ready();
    if (sc === null || this.sfxMod === null) return;
    fn(this.sfxMod);
  }

  /** Push current settings into the three gain nodes (ramped, click-free). */
  private applyVolumes(): void {
    const ctx = this.ctx;
    if (ctx === null) return;
    const t = ctx.currentTime;
    const s = this.settings;
    this.masterGain?.gain.setTargetAtTime(s.muted ? 0 : s.master, t, VOL_RAMP);
    this.sfxBus?.gain.setTargetAtTime(s.sfx, t, VOL_RAMP);
    this.musicBus?.gain.setTargetAtTime(s.music, t, VOL_RAMP);
  }
}
