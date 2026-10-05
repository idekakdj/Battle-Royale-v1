/**
 * Champions League ONLINE — the playable match Screen (v1.5, WP-N5). The networked twin of `BrawlMatchController`:
 * the same 3D view, HUD (with the humans' NAMES), keyboard / mouse / gamepad reader and audio, but the simulation is
 * driven by a {@link RollbackSession} over the room's `GameChannel`:
 *
 *   factory (session created at once so no early packet is lost) → mount → "Connecting…" until every peer's first
 *   inputs arrived → the sim's own countdown / fight (frame-synchronised) → [Esc: a menu that does NOT stop the sim —
 *   Resume / Controls / Leave match] → the session agrees on the result → celebration → results ("Back to room").
 *
 * Early ends never leave the player stranded: a desync, a lost connection, the host leaving, … show a dialog with one
 * "Back to room" button. A player that leaves is forfeited on every machine at the same frame (banner "Bob left —
 * forfeited"); the match goes on. `onExit` fires exactly once. `unmount()` / `dispose()` are idempotent and release the
 * session, the view, the input, the HUD layers, the audio loops, the listeners and the animation frame.
 *
 * Leaving the match returns to the ROOM (the room layer's `backToRoom` does the rest: the host sees a forfeit); a host
 * that leaves also announces it with one reliable {@link NET_BRAWL_BYE} message, because the room keeps the links open
 * and the peers would otherwise only notice after the stall timeout.
 */

import type { Screen } from '../../core/ScreenManager';
import type { AudioEngine } from '../../audio/AudioEngine';
import type { OnlineMatchOptions, OnlineMatchResult } from '../../online/matchTypes';
import type { NetEndReason } from '../../online/types';
import { createBrawlView } from '../render/BrawlView';
import { BrawlInput } from '../ui/BrawlInput';
import { BrawlHud } from '../ui/BrawlHud';
import { SESSION_CELEBRATION_S } from '../ui/BrawlSession';
import { BrawlAudio } from '../audio/BrawlAudio';
import type { BrawlAudioLike, BrawlHudLike } from '../BrawlMatchController';
import { IDLE_INTENT } from '../types';
import type { BrawlEvent, BrawlInputApi, BrawlIntent, BrawlMatchConfig, BrawlViewApi } from '../types';
import { RollbackSession } from './RollbackSession';
import type { RollbackDesync, RollbackEnd, RollbackForfeit, RollbackSessionOptions } from './types';
import { NetHud, describeWait, endDialog, forfeitText, formatNetStats } from './netHud';
import type { MenuView, NetHudHooks, NetHudLike, NetHudState, NetPingView, SyncTone } from './netHud';
import { NetResults, buildNetResultsData } from './netResults';
import type { NetResultsData, NetResultsLike } from './netResults';

/** Controller-level message kind (unassigned slot in the Champions League range 0x10–0x1f): "I left the match". */
export const NET_BRAWL_BYE = 0x1e;

/** Seconds a rollback keeps the "ROLLBACK" tag lit. */
const ROLLBACK_FLASH_S = 0.4;
const DEFAULT_STALL_TIMEOUT_MS = 12000;
/** The session waits this long for the first inputs (see RollbackSession.watchStall). */
const FIRST_PROGRESS_TIMEOUT_MS = 30000;

export type NetBrawlPhase = 'playing' | 'celebrating' | 'results' | 'dialog' | 'closed';

export type NetSessionOptions = Partial<Omit<RollbackSessionOptions, 'channel' | 'start' | 'localIntent' | 'onDesync' | 'onEnded' | 'onForfeit'>>;

export interface NetBrawlControllerOptions extends OnlineMatchOptions {
  /** Tuning / test seam for the rollback session (`inputDelay`, `stallTimeoutMs`, `createWorld`, …). */
  sessionOptions?: NetSessionOptions;
  /** Seconds between the agreed end and the results screen (default 2.6, like the local mode). */
  celebrationS?: number;
  /** Test / tooling seams (defaults: the real view, input, HUD, audio, net HUD and results screen). */
  createView?: (canvas: HTMLCanvasElement, config: BrawlMatchConfig) => BrawlViewApi;
  createInput?: (hooks: { onPause: () => void; onToggleDebug: () => void }, canvas: HTMLCanvasElement) => BrawlInputApi;
  createHud?: (config: BrawlMatchConfig, project: BrawlViewApi['project'], names: readonly string[]) => BrawlHudLike;
  createAudio?: (engine: AudioEngine) => BrawlAudioLike;
  createNetHud?: (hooks: NetHudHooks) => NetHudLike;
  createResults?: (data: NetResultsData, hooks: { onBack: () => void }) => NetResultsLike;
}

export class NetBrawlController implements Screen {
  private readonly opts: NetBrawlControllerOptions;

  readonly session: RollbackSession;
  readonly config: BrawlMatchConfig;
  /** Display name of each fighter (index = slot). */
  readonly names: readonly string[];
  view!: BrawlViewApi;

  private input: BrawlInputApi | null = null;
  private hud: BrawlHudLike | null = null;
  private audio: BrawlAudioLike | null = null;
  private netHud: NetHudLike | null = null;
  private results: NetResultsLike | null = null;
  private root: HTMLElement | null = null;

  private raf = 0;
  private lastNow = 0;
  private mounted = false;
  private disposed = false;
  private exited = false;
  private audioStopped = false;
  private torn = false;
  private debugBoxes = false;
  private detailOn = false;
  private menuView: MenuView | null = null;
  private phaseNow: NetBrawlPhase = 'playing';

  // netcode presentation state
  private clock = 0;
  private linked = false;
  private waitSince: number | null = null;
  private lastProgress = 0;
  private lastConfirmed = 0;
  private lastRollbacks = 0;
  private flashUntil = 0;
  private celebrateLeft = 0;
  private readonly stallTimeoutMs: number;
  private readonly unsubBye: () => void;
  private readonly told = new Set<number>();

  // what the session reported (handled at the end of the tick)
  private endInfo: RollbackEnd | null = null;
  private desync: RollbackDesync | null = null;
  private byeFromHost = false;
  private dialogReason: NetEndReason | null = null;
  private dialogMessage = '';
  private finalResults: NetResultsData | null = null;

  private readonly onFrame = (now: number): void => {
    if (this.disposed) return;
    this.raf = requestAnimationFrame(this.onFrame);
    const dt = (now - this.lastNow) / 1000;
    this.lastNow = now;
    this.tick(dt);
  };

  private readonly onResize = (): void => {
    this.view?.resize();
  };

  /** F2 = network statistics (the shared input reader has no F2 hook). */
  private readonly onKey = (e: Event): void => {
    const k = e as KeyboardEvent;
    if (k.code !== 'F2' || k.repeat) return;
    k.preventDefault();
    this.toggleDetail();
  };

  constructor(opts: NetBrawlControllerOptions) {
    this.opts = opts;
    const { start, channel } = opts;
    this.stallTimeoutMs = opts.sessionOptions?.stallTimeoutMs ?? DEFAULT_STALL_TIMEOUT_MS;
    this.names = start.slots.map((s) => s.name);
    // The session subscribes to the channel NOW: packets of faster peers may already be on their way.
    this.session = new RollbackSession({
      ...opts.sessionOptions,
      channel,
      start,
      stallTimeoutMs: this.stallTimeoutMs,
      localIntent: (): BrawlIntent => this.input?.poll() ?? IDLE_INTENT,
      onDesync: (info) => {
        this.desync ??= info;
      },
      onEnded: (info) => {
        this.endInfo = info;
      },
      onForfeit: (info) => this.onForfeit(info),
    });
    this.config = this.session.config;
    this.unsubBye = channel.onMessage((peerId, kind) => {
      if (kind === NET_BRAWL_BYE && peerId === start.hostPeerId && this.phaseNow === 'playing') this.byeFromHost = true;
    });
  }

  get phase(): NetBrawlPhase {
    return this.phaseNow;
  }

  get isDisposed(): boolean {
    return this.disposed;
  }

  get hasExited(): boolean {
    return this.exited;
  }

  get menuOpen(): boolean {
    return this.menuView !== null;
  }

  // ── Screen lifecycle ───────────────────────────────────────────────────────

  mount(root: HTMLElement): void {
    if (this.mounted || this.disposed) return;
    this.mounted = true;
    this.root = root;
    try {
      this.build(root);
    } catch (err) {
      console.error('Online Champions League: could not start the match view', err);
      this.sendBye();
      this.exit({ reason: 'error', message: 'The match could not be started on this machine (is WebGL available?).' });
      this.dispose();
    }
  }

  private build(root: HTMLElement): void {
    const { canvas } = this.opts;
    const config = this.config;
    this.view = (this.opts.createView ?? ((cv, c) => createBrawlView(cv, c)))(canvas, config);
    const hooks = { onPause: () => this.toggleMenu(), onToggleDebug: () => this.toggleDebug() };
    this.input = this.opts.createInput !== undefined ? this.opts.createInput(hooks, canvas) : new BrawlInput({ mouseTarget: canvas, ...hooks });

    const project: BrawlViewApi['project'] = (x, y) => this.view.project(x, y);
    this.hud =
      this.opts.createHud !== undefined
        ? this.opts.createHud(config, project, this.names)
        : new BrawlHud({ config, project, names: this.names, hint: 'A / D move  ·  W / Space jump  ·  J light  ·  K heavy  ·  L dodge  ·  Esc menu' });
    this.hud.mount(root);

    this.netHud = this.opts.createNetHud !== undefined ? this.opts.createNetHud(this.netHooks()) : new NetHud(this.netHooks());
    this.netHud.mount(root);

    this.audio = this.opts.createAudio !== undefined ? this.opts.createAudio(this.opts.audio) : new BrawlAudio(this.opts.audio);
    this.audio.start();

    window.addEventListener('resize', this.onResize);
    window.addEventListener('keydown', this.onKey);
    this.installDevHook();

    const snaps = this.session.snapshots();
    this.view.render(snaps.cur, snaps.cur, 0, [], 0);
    this.hud.update(snaps.cur);
    this.pushNetState();
    this.lastNow = performance.now();
    this.raf = requestAnimationFrame(this.onFrame);
  }

  unmount(): void {
    this.dispose();
  }

  /** Release everything (idempotent). */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    if (this.raf !== 0) cancelAnimationFrame(this.raf);
    this.raf = 0;
    this.unsubBye();
    this.session.dispose();
    if (!this.mounted) return;
    this.teardownGame();
    this.results?.unmount();
    this.results = null;
    this.removeDevHook();
    this.root = null;
  }

  // ── loop ───────────────────────────────────────────────────────────────────

  /** One animation frame (called by the rAF loop; public for tools / tests). */
  tick(dtSeconds: number): void {
    if (this.disposed || !this.mounted) return;
    let dt = Number.isFinite(dtSeconds) ? dtSeconds : 0;
    dt = dt < 0 ? 0 : dt > 0.25 ? 0.25 : dt;
    this.clock += dt;
    switch (this.phaseNow) {
      case 'playing':
        this.tickPlaying(dt);
        break;
      case 'celebrating':
        this.tickStatic(dt);
        this.celebrateLeft -= dt;
        if (this.celebrateLeft <= 0) this.showResults();
        break;
      case 'dialog':
        this.tickStatic(dt);
        break;
      default:
        break;
    }
  }

  private tickPlaying(dt: number): void {
    const s = this.session;
    if (this.byeFromHost) {
      this.finishEarly('host-left');
      return;
    }
    s.update(dt);
    const events = s.drainEvents();
    this.draw(dt, events);
    this.pushNetState();
    this.handleSessionEnd();
  }

  /** Celebration / dialog: the sim is over or frozen — keep the last frame alive (VFX, HUD). */
  private tickStatic(dt: number): void {
    const events = this.session.drainEvents();
    this.draw(dt, events);
    this.pushNetState();
  }

  private draw(dt: number, events: readonly BrawlEvent[]): void {
    if (this.view === undefined || this.hud === null || this.audio === null) return;
    const v = this.session.snapshots();
    this.view.render(v.prev, v.cur, v.alpha, events, dt);
    if (events.length > 0 && !this.audioStopped) this.audio.onEvents(events, v.cur);
    this.hud.onEvents(events);
    this.hud.update(v.cur);
    if (!this.audioStopped) this.audio.update(v.cur);
  }

  /** A desync / early end / agreed result reported by the session during `update`. */
  private handleSessionEnd(): void {
    if (this.desync !== null) {
      this.finishEarly('desync');
      return;
    }
    const end = this.endInfo;
    if (end === null) return;
    if (end.reason === 'finished') {
      this.beginCelebration(end);
    } else {
      this.finishEarly(end.reason);
    }
  }

  private beginCelebration(end: RollbackEnd): void {
    this.phaseNow = 'celebrating';
    this.celebrateLeft = this.opts.celebrationS ?? SESSION_CELEBRATION_S;
    this.closeMenuQuiet();
    this.input?.setEnabled(false);
    const cur = this.session.snapshots().cur;
    this.finalResults = buildNetResultsData({
      start: this.opts.start,
      config: this.config,
      snap: cur,
      winnerId: end.winnerId,
      agreed: end.agreed,
      forfeited: (slot) => this.session.isForfeited(slot),
    });
  }

  // ── early ends ─────────────────────────────────────────────────────────────

  private finishEarly(reason: NetEndReason): void {
    if (this.phaseNow === 'dialog' || this.phaseNow === 'closed' || this.exited) return;
    this.phaseNow = 'dialog';
    this.closeMenuQuiet();
    this.input?.setEnabled(false);
    this.stopAudio();
    const s = this.session;
    const waiting = s.waitingFor.map((slot) => this.names[slot]).filter((n): n is string => typeof n === 'string');
    const host = this.opts.start.slots.find((x) => x.peerId === this.opts.start.hostPeerId);
    const d = endDialog(reason, { hostName: host?.name ?? 'The host', waiting });
    this.dialogReason = reason;
    this.dialogMessage = d.message;
    this.netHud?.showDialog(d);
    // Stop listening to the others; the last frame stays on screen behind the dialog.
    s.dispose();
  }

  private onDialogClose(): void {
    this.exit({ reason: this.dialogReason ?? 'error', message: this.dialogMessage });
  }

  // ── menu / leaving ─────────────────────────────────────────────────────────

  toggleMenu(): void {
    if (this.menuView !== null) this.closeMenu();
    else this.openMenu();
  }

  openMenu(view: MenuView = 'main'): void {
    if (this.disposed || !this.mounted || this.phaseNow !== 'playing' || this.netHud === null) return;
    this.menuView = view;
    this.input?.setEnabled(false);
    this.netHud.openMenu(view);
  }

  closeMenu(): void {
    if (this.menuView === null) return;
    this.closeMenuQuiet();
    if (this.phaseNow === 'playing') this.input?.setEnabled(true);
  }

  private closeMenuQuiet(): void {
    if (this.menuView === null) return;
    this.menuView = null;
    this.netHud?.closeMenu();
  }

  /** The confirmed "Leave match": tell the others, then hand the player back to the room. */
  leave(): void {
    if (this.disposed || this.exited || this.phaseNow !== 'playing') return;
    this.sendBye();
    this.phaseNow = 'closed';
    this.closeMenuQuiet();
    this.stopAudio();
    this.exit({ reason: 'peer-left', message: 'You left the match.' });
  }

  private sendBye(): void {
    try {
      this.opts.channel.broadcast('reliable', NET_BRAWL_BYE, new Uint8Array(0));
    } catch {
      /* the channel may already be gone */
    }
  }

  // ── results ────────────────────────────────────────────────────────────────

  private showResults(): void {
    if (this.phaseNow !== 'celebrating' || this.root === null) return;
    const data = this.finalResults;
    if (data === null) return;
    this.phaseNow = 'results';
    const won = data.localWon;
    this.teardownGame();
    const a = this.opts.audio as Partial<AudioEngine> | undefined;
    try {
      a?.playResultsFanfare?.(won);
    } catch {
      /* audio is best effort */
    }
    const onBack = (): void => this.exit({ reason: 'finished' });
    this.results = this.opts.createResults !== undefined ? this.opts.createResults(data, { onBack }) : new NetResults({ data, onBack });
    this.results.mount(this.root);
  }

  /** Release the in-game layers (view, HUD, input, audio, listeners). Idempotent. */
  private teardownGame(): void {
    if (this.torn) return;
    this.torn = true;
    if (this.raf !== 0 && this.phaseNow === 'results') {
      cancelAnimationFrame(this.raf);
      this.raf = 0;
    }
    window.removeEventListener('resize', this.onResize);
    window.removeEventListener('keydown', this.onKey);
    this.input?.dispose();
    this.netHud?.unmount();
    this.hud?.unmount();
    this.stopAudio();
    this.view?.dispose();
  }

  private stopAudio(): void {
    if (this.audioStopped) return;
    this.audioStopped = true;
    this.audio?.stop();
  }

  // ── presentation state ─────────────────────────────────────────────────────

  private onForfeit(info: RollbackForfeit): void {
    if (this.told.has(info.slot)) return;
    this.told.add(info.slot);
    if (info.slot === this.session.localSlot) return;
    this.netHud?.showForfeit(forfeitText(this.names[info.slot] ?? 'A player'));
  }

  toggleDetail(): void {
    this.detailOn = !this.detailOn;
  }

  /** Compose the net HUD state of this frame (also called directly by tests). */
  buildNetState(): NetHudState {
    const s = this.session;
    const stats = s.stats;
    const stalled = s.stalled;
    if (!this.linked && s.confirmed >= 1) this.linked = true;
    if (stats.rollbacks > this.lastRollbacks) {
      this.lastRollbacks = stats.rollbacks;
      this.flashUntil = this.clock + ROLLBACK_FLASH_S;
    }
    if (s.confirmed !== this.lastConfirmed || !stalled) {
      this.lastConfirmed = s.confirmed;
      this.lastProgress = this.clock;
    }
    const connecting = !this.linked && this.phaseNow === 'playing';
    const waitingNow = connecting || stalled;
    if (waitingNow) this.waitSince ??= this.clock;
    else this.waitSince = null;
    const waitedS = this.waitSince === null ? 0 : this.clock - this.waitSince;

    const waiting: string[] = [];
    if (waitingNow) {
      let slots: readonly number[] = s.waitingFor;
      if (slots.length === 0 && connecting) slots = this.remoteSlots().filter((slot) => !s.isForfeited(slot));
      for (const slot of slots) if (!s.isForfeited(slot)) waiting.push(this.names[slot] ?? `Player ${slot + 1}`);
    }
    const limitMs = this.linked ? this.stallTimeoutMs : Math.max(this.stallTimeoutMs, FIRST_PROGRESS_TIMEOUT_MS);
    const giveUpInS = waitingNow ? limitMs / 1000 - (this.clock - this.lastProgress) : null;

    const pings: NetPingView[] = [];
    for (const slot of this.remoteSlots()) {
      pings.push({ name: this.names[slot] ?? `Player ${slot + 1}`, ms: stats.pingBySlot[slot] ?? 0, gone: s.isForfeited(slot) });
    }
    const sync: SyncTone = stalled ? 'stalled' : this.clock < this.flashUntil ? 'rollback' : 'ok';
    return {
      wait: this.phaseNow === 'playing' ? describeWait({ connecting, stalled, stalledS: waitedS, waiting, giveUpInS }) : null,
      pings,
      sync,
      detail: this.detailOn ? formatNetStats(stats) : null,
    };
  }

  private pushNetState(): void {
    this.netHud?.update(this.buildNetState());
  }

  private remoteSlots(): number[] {
    const out: number[] = [];
    for (let i = 0; i < this.names.length; i++) if (i !== this.session.localSlot) out.push(i);
    return out;
  }

  private netHooks(): NetHudHooks {
    return {
      onResume: () => this.closeMenu(),
      onRequestLeave: () => this.openMenu('confirm'),
      onLeave: () => this.leave(),
      onDialogClose: () => this.onDialogClose(),
    };
  }

  // ── misc ───────────────────────────────────────────────────────────────────

  toggleDebug(): void {
    this.debugBoxes = !this.debugBoxes;
    this.view.setDebugBoxes(this.debugBoxes);
  }

  private exit(result: OnlineMatchResult): void {
    if (this.exited) return;
    this.exited = true;
    if (this.phaseNow !== 'results') this.phaseNow = 'closed';
    this.opts.onExit(result);
  }

  private installDevHook(): void {
    if (typeof window === 'undefined') return;
    let qa = false;
    try {
      qa = new URLSearchParams(window.location.search).get('qa') === '1';
    } catch {
      qa = false;
    }
    if (import.meta.env.DEV || qa) {
      (window as unknown as { __gkNetBrawl?: unknown }).__gkNetBrawl = { controller: this, session: this.session, view: this.view };
    }
  }

  private removeDevHook(): void {
    if (typeof window === 'undefined') return;
    const w = window as unknown as { __gkNetBrawl?: { controller?: unknown } };
    if (w.__gkNetBrawl?.controller === this) delete w.__gkNetBrawl;
  }
}
