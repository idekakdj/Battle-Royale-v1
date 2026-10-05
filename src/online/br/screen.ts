/**
 * Online Battle Royale match screen (WP-N6) — `createNetBattleRoyaleScreen: OnlineMatchFactory`, mounted by the Online UI
 * (src/online/ui/launch.ts) once the room hands over `(OnlineStart, GameChannel)`.
 *
 * It is the normal {@link MatchController} (same HUD, camera, first person, lock-on, ultimates, spectate, audio) running on a
 * networked {@link SimDriver}:
 *
 *   host    `HostSimDriver`   World + BotManager + BrNetHost; remote humans' intents, bot takeover when a peer leaves
 *   client  `ClientSimDriver` no sim; sends the local intent, renders the host's interpolated snapshots + events
 *
 * Online rules implemented here and in the controller hooks: no pause (Esc opens a menu, the match keeps running), human players
 * show their chosen NAMES (nameplates, kill feed, spectate bar, results), a ping/loss chip + "waiting / reconnecting" banner,
 * the host leaving / a dead connection ends the match via `onExit({reason:'host-left' | 'timeout'})`, and the host's final
 * standings (`BR_RESULTS`) feed the existing Results screen, whose three buttons are replaced by "Back to room"
 * (`onExit({reason:'finished'})`).
 *
 * Leaving through the Esc menu calls `onExit({reason:'finished', message:'You left the match.'})`; the Online UI then runs its
 * usual `room.backToRoom()` (a client's `leaveMatch` is what turns its slot into a bot on the host).
 */

import type { Screen } from '../../core/ScreenManager';
import type { Difficulty } from '../../core/types';
import { MatchController } from '../../match/MatchController';
import { Results, type MatchResults } from '../../ui';
import type { OnlineMatchFactory, OnlineMatchOptions, OnlineMatchResult } from '../matchTypes';
import { ClientSimDriver } from './clientDriver';
import { HostSimDriver } from './hostDriver';
import { NetHud } from './netHud';
import { describeLink, hostTimedOut } from './netHudModel';
import { brResultsToMatchResults, orderedSlots } from './netRoster';

const POLL_MS = 250;

export class NetBattleRoyaleScreen implements Screen {
  private readonly opts: OnlineMatchOptions;
  private readonly hud = new NetHud();
  private root: HTMLElement | null = null;
  private driver: HostSimDriver | ClientSimDriver | null = null;
  private controller: MatchController | null = null;
  private results: Results | null = null;
  private pollTimer: number | null = null;
  private readonly unsubs: Array<() => void> = [];
  private exited = false;
  private hostGone = false;
  private startedAt = 0;

  constructor(opts: OnlineMatchOptions) {
    this.opts = opts;
  }

  /** QA / tests: the live controller + driver. */
  get debug(): { driver: HostSimDriver | ClientSimDriver | null; controller: MatchController | null } {
    return { driver: this.driver, controller: this.controller };
  }

  mount(root: HTMLElement): void {
    this.root = root;
    const { start, channel, audio, canvas } = this.opts;
    const isHost = start.hostPeerId === channel.localPeerId;
    const difficulty: Difficulty = start.br?.difficulty ?? 3;
    const me = orderedSlots(start)[start.localSlot];
    if (me === undefined) {
      this.fail('error', 'This match has no seat for you.');
      return;
    }
    this.startedAt = performance.now();
    try {
      const driver = isHost ? new HostSimDriver({ start, channel }) : new ClientSimDriver({ start, channel });
      this.driver = driver;
      audio.stopMusic();
      const controller = new MatchController({
        canvas,
        audio,
        animal: me.animal,
        difficulty,
        seed: start.seed,
        sim: driver,
        onMatchEnd: (r) => this.showResults(r, difficulty),
        onQuitToLobby: () => this.finish({ reason: 'finished', message: 'You left the match.' }),
      });
      this.controller = controller;
      controller.mount(root);
      this.hud.mount(root);
    } catch (err) {
      console.error('[online] could not start the Battle Royale match', err);
      this.teardown();
      this.fail('error', 'Could not start the match (graphics unavailable?).');
      return;
    }

    // The host's link dropping ends the match for a client (or just annotates the results screen once it is up).
    if (!isHost) {
      this.unsubs.push(
        channel.onPeerLeft((peer) => {
          if (peer === start.hostPeerId) this.onHostGone();
        }),
      );
      // The host left the match through its menu (it stays in the room, so the link never drops): BR_BYE says so at once.
      if (this.driver instanceof ClientSimDriver) this.unsubs.push(this.driver.onHostLeft(() => this.onHostGone()));
    }
    if (this.driver instanceof HostSimDriver) {
      this.unsubs.push(this.driver.onPeerLeft((info) => this.hud.toast(`${info.name} left — a bot takes over`)));
    }
    this.pollTimer = window.setInterval(() => this.poll(), POLL_MS);
    this.poll();
    this.installDevHook();
  }

  unmount(): void {
    this.teardown();
  }

  /** QA only (dev server, or `?qa=1` on a production build): `window.__gkNetBr` = { screen, driver, controller }. */
  private installDevHook(): void {
    let qa = false;
    try {
      qa = new URLSearchParams(window.location.search).get('qa') === '1';
    } catch {
      qa = false;
    }
    if (import.meta.env.DEV || qa) (window as unknown as { __gkNetBr?: unknown }).__gkNetBr = { screen: this, driver: this.driver, controller: this.controller };
  }

  private removeDevHook(): void {
    const w = window as unknown as { __gkNetBr?: { screen?: unknown } };
    if (w.__gkNetBr?.screen === this) delete w.__gkNetBr;
  }

  // ── Net status ──────────────────────────────────────────────────────────────

  private poll(): void {
    const driver = this.driver;
    if (driver === null || this.results !== null) return;
    if (driver instanceof HostSimDriver) {
      let worst = 0;
      for (const c of driver.clientStats()) if (c.connected && c.rttMs > worst) worst = c.rttMs;
      this.hud.update(
        describeLink({ role: 'host', pingMs: worst, loss: 0, hostSilenceMs: 0, haveSnapshot: true, waitingFor: driver.waiting ? driver.waitingFor() : [] }),
      );
      return;
    }
    const s = driver.stats();
    // Once the match is decided the host stops streaming after a moment: silence is expected, not a lost connection.
    const over = driver.matchOver;
    const silence = over ? 0 : s.hostSilenceMs;
    this.hud.update(
      describeLink({ role: 'client', pingMs: s.pingMs, loss: s.loss, hostSilenceMs: silence, haveSnapshot: driver.connected, waitingFor: [] }),
    );
    if (!over && hostTimedOut(driver.connected, silence, performance.now() - this.startedAt)) {
      this.finish({ reason: 'timeout', message: 'Lost connection to the host.' });
    }
  }

  private onHostGone(): void {
    if (this.hostGone) return;
    this.hostGone = true;
    if (this.results !== null) {
      // The results are already on screen: let the player read them, and say why the room is gone.
      this.mountResults(this.lastResults, 'The host left the room.');
      return;
    }
    this.finish({ reason: 'host-left', message: 'The host left the match.' });
  }

  // ── Results ─────────────────────────────────────────────────────────────────

  private lastResults: MatchResults | null = null;

  private showResults(own: MatchResults, difficulty: Difficulty): void {
    const driver = this.driver;
    if (driver === null || this.root === null || this.exited) return;
    const br = driver.results();
    const r = br !== null ? brResultsToMatchResults(br, this.opts.start, this.opts.start.localSlot, difficulty, own) : own;
    this.lastResults = r;
    // Tear the match down (its unmount also releases the sim driver's network listeners); the Results screen takes over.
    this.controller?.unmount();
    this.controller = null;
    this.hud.dispose();
    if (this.pollTimer !== null) {
      window.clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
    this.opts.audio.playResultsFanfare(r.victory);
    this.mountResults(r, this.hostGone ? 'The host left the room.' : undefined);
  }

  private mountResults(r: MatchResults | null, note?: string): void {
    if (r === null || this.root === null) return;
    this.results?.unmount();
    const back = (): void =>
      this.finish(this.hostGone ? { reason: 'host-left', message: 'The host left the room.' } : { reason: 'finished' });
    this.results = new Results({
      results: r,
      onBackToRoom: back,
      note,
      onRematch: back,
      onChangeGladiator: back,
      onLobby: back,
    });
    this.results.mount(this.root);
  }

  // ── Exit / teardown ─────────────────────────────────────────────────────────

  private finish(result: OnlineMatchResult): void {
    if (this.exited) return;
    this.exited = true;
    // A host leaving before the match is decided tells the clients now (the room's own "back to room" would only retire the channel).
    if (this.driver instanceof HostSimDriver) this.driver.net.sendBye();
    this.opts.onExit(result);
  }

  /** A start-up failure: report it after `mount` has returned (the UI is still in the middle of a screen transition). */
  private fail(reason: OnlineMatchResult['reason'], message: string): void {
    window.setTimeout(() => this.finish({ reason, message }), 0);
  }

  private teardown(): void {
    this.removeDevHook();
    if (this.pollTimer !== null) {
      window.clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
    for (const u of this.unsubs) u();
    this.unsubs.length = 0;
    try {
      this.controller?.unmount();
    } catch (err) {
      console.error('[online] controller unmount failed', err); // e.g. a mount that died half-way (no WebGL)
    }
    this.controller = null;
    this.results?.unmount();
    this.results = null;
    this.hud.dispose();
    this.driver?.dispose();
    this.driver = null;
    this.root = null;
  }
}

export const createNetBattleRoyaleScreen: OnlineMatchFactory = (opts) => new NetBattleRoyaleScreen(opts);
