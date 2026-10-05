/**
 * Champions League online — the netcode HUD (v1.5, WP-N5): a DOM overlay mounted over the normal `BrawlHud`.
 *
 *   - top right: one chip per opponent with a ping dot (green / amber / red) + a sync indicator that flashes on a
 *     rollback and goes red while the sim waits; F2 adds a small netstats block,
 *   - centre: the "Connecting…" / "Waiting for <name>…" panel (with a Leave button once the wait gets long),
 *   - top: forfeit banners ("Bob left — forfeited"),
 *   - the Esc match menu (Resume / Controls / Leave match + confirmation) — it does NOT stop the sim,
 *   - a modal dialog for the early ends (desync, host left, connection lost…) with one "Back to room" button.
 *
 * The DOM class is deliberately dumb (it only shows what `NetHudState` says); every decision lives in
 * {@link NetBrawlController} and in the pure helpers below, which are unit-tested without a DOM.
 */

import { el, button } from '../../ui/dom';
import { BRAWL_CONTROLS } from '../ui/controlsRef';
import type { NetEndReason } from '../../online/types';
import type { RollbackStats } from './types';

// ── pure helpers (no DOM) ────────────────────────────────────────────────────

export type PingTone = 'good' | 'ok' | 'bad' | 'unknown';

/** Colour class of a round-trip time: green below 70 ms, amber below 130 ms, red above; 0 = not measured yet. */
export function pingTone(ms: number): PingTone {
  if (!Number.isFinite(ms) || ms <= 0) return 'unknown';
  if (ms < 70) return 'good';
  if (ms < 130) return 'ok';
  return 'bad';
}

export function formatPing(ms: number): string {
  return !Number.isFinite(ms) || ms <= 0 ? '– ms' : `${Math.round(ms)} ms`;
}

/** "Ann", "Ann and Bob", "Ann, Bob and Cy". */
export function joinNames(names: readonly string[]): string {
  if (names.length === 0) return '';
  if (names.length === 1) return names[0];
  return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
}

export interface NetWaitView {
  kind: 'connecting' | 'stalled';
  title: string;
  sub: string;
  /** Show the "Leave match" button (the wait has become long). */
  canLeave: boolean;
}

/** Stalls shorter than this are not worth an overlay. */
export const WAIT_OVERLAY_DELAY_S = 0.45;
/** The Leave button appears after this long. */
export const WAIT_LEAVE_AFTER_S = 3;

/**
 * The overlay for the current netcode state, or null when the match is simply running.
 * `connecting` = the very first inputs of the other players have not arrived yet.
 */
export function describeWait(args: {
  connecting: boolean;
  stalled: boolean;
  stalledS: number;
  waiting: readonly string[];
  giveUpInS: number | null;
}): NetWaitView | null {
  const { connecting, stalled, stalledS, waiting, giveUpInS } = args;
  if (connecting) {
    const who = waiting.length > 0 ? joinNames(waiting) : 'the other players';
    return {
      kind: 'connecting',
      title: 'Connecting…',
      sub: `Waiting for ${who} to be ready`,
      canLeave: stalledS >= WAIT_LEAVE_AFTER_S,
    };
  }
  if (!stalled || stalledS < WAIT_OVERLAY_DELAY_S) return null;
  const who = waiting.length > 0 ? joinNames(waiting) : 'the other players';
  const sub =
    giveUpInS !== null && stalledS >= WAIT_LEAVE_AFTER_S
      ? `No news from them — the match ends in ${Math.max(0, Math.ceil(giveUpInS))} s if this does not recover`
      : 'The match continues as soon as they catch up';
  return { kind: 'stalled', title: `Waiting for ${who}…`, sub, canLeave: stalledS >= WAIT_LEAVE_AFTER_S };
}

export function forfeitText(name: string): string {
  return `${name} left — forfeited`;
}

export interface NetDialog {
  title: string;
  message: string;
  hint?: string;
  button: string;
}

/** Friendly dialog text for a match that was cut short. `waiting` = who the match was waiting for (timeouts). */
export function endDialog(reason: NetEndReason, ctx: { hostName: string; waiting?: readonly string[]; peerName?: string }): NetDialog {
  const back = 'Back to room';
  switch (reason) {
    case 'host-left':
      return { title: 'The host left', message: `${ctx.hostName} (the host) left the match, so it is over.`, button: back };
    case 'peer-left':
      return { title: 'A player left', message: `${ctx.peerName ?? 'Another player'} left the match.`, button: back };
    case 'desync':
      return {
        title: 'Game out of sync — match ended',
        message: 'Your game and another player’s game disagreed about what happened, so the match was stopped to keep it fair.',
        hint: 'Go back to the room and start again. If it keeps happening, make sure everybody runs exactly the same version.',
        button: back,
      };
    case 'timeout': {
      const who = ctx.waiting !== undefined && ctx.waiting.length > 0 ? joinNames(ctx.waiting) : 'the other players';
      return {
        title: 'Connection lost',
        message: `The match stopped because ${who} stopped responding.`,
        hint: 'Check your internet connection; a firewall or VPN can also interfere.',
        button: back,
      };
    }
    case 'version-mismatch':
      return { title: 'Different game versions', message: 'The players run different versions of the game.', hint: 'Everybody needs the same version.', button: back };
    default:
      return { title: 'The match stopped', message: 'Something went wrong with the connection, so the match was stopped.', button: back };
  }
}

/** The F2 block: a few lines of rollback / bandwidth numbers. */
export function formatNetStats(st: RollbackStats): string {
  return [
    `frame ${st.simFrame}   confirmed ${st.confirmedFrame}   (+${Math.max(0, st.simFrame - st.confirmedFrame)})`,
    `input delay ${st.inputDelay} f   clock x${st.timeScale.toFixed(3)}   ahead ${st.remoteAdvantage.toFixed(1)} f`,
    `rollbacks ${st.rollbacks}   max depth ${st.maxRollbackDepth} f   re-simulated ${st.resimulatedFrames} f`,
    `stalls ${st.stalls}   stalled frames ${st.stalledFrames}`,
    `sent ${(st.bytesSent / 1024).toFixed(1)} KB   packets ${st.packetsSent} out / ${st.packetsReceived} in   checks ${st.checksumsCompared}`,
  ].join('\n');
}

export interface NetPingView {
  name: string;
  ms: number;
  /** The player has left (forfeited). */
  gone: boolean;
}

export type SyncTone = 'ok' | 'rollback' | 'stalled';

export interface NetHudState {
  wait: NetWaitView | null;
  pings: readonly NetPingView[];
  sync: SyncTone;
  /** F2 netstats text (null = panel hidden). */
  detail: string | null;
}

export interface NetHudHooks {
  /** Resume button / menu closed from the panel. */
  onResume: () => void;
  /** The Leave button of the wait panel (the controller opens the menu on the confirmation). */
  onRequestLeave: () => void;
  /** The confirmed "Leave match". */
  onLeave: () => void;
  /** The dialog's button. */
  onDialogClose: () => void;
}

export type MenuView = 'main' | 'confirm';

/** What the controller needs from its net HUD (the real class satisfies it; tests inject a fake). */
export interface NetHudLike {
  mount(host: HTMLElement): void;
  unmount(): void;
  update(state: NetHudState): void;
  showForfeit(text: string): void;
  openMenu(view?: MenuView): void;
  closeMenu(): void;
  showDialog(dialog: NetDialog): void;
}

// ── styles (injected once; uses the game's CSS variables) ────────────────────

const STYLE_ID = 'gk-nethud-style';

const CSS = `
#app > .gk-nethud, .gk-nethud { position: absolute; inset: 0; overflow: hidden; pointer-events: none; user-select: none; }
.gk-nethud__net { position: absolute; top: 10px; right: 14px; display: flex; flex-direction: column; align-items: flex-end; gap: 6px; font-size: 0.78rem; }
.gk-nethud__chips { display: flex; flex-wrap: wrap; justify-content: flex-end; gap: 6px; }
.gk-nethud__chip { display: inline-flex; align-items: center; gap: 6px; padding: 3px 10px; border-radius: 999px; background: rgba(20, 17, 13, 0.72); border: 1px solid var(--gk-panel-border); color: var(--gk-text); letter-spacing: 0.03em; white-space: nowrap; }
.gk-nethud__chip::before { content: ''; width: 8px; height: 8px; border-radius: 50%; background: var(--tone, #7b7466); box-shadow: 0 0 6px var(--tone, transparent); }
.gk-nethud__chip[data-tone='good'] { --tone: #5fd068; }
.gk-nethud__chip[data-tone='ok'] { --tone: #e6c34a; }
.gk-nethud__chip[data-tone='bad'] { --tone: #e5533d; }
.gk-nethud__chip.is-gone { opacity: 0.45; text-decoration: line-through; }
.gk-nethud__sync { padding: 2px 9px; border-radius: 999px; background: rgba(20, 17, 13, 0.72); border: 1px solid var(--gk-panel-border); letter-spacing: 0.1em; font-size: 0.68rem; color: var(--gk-text-dim); }
.gk-nethud__sync[data-tone='ok'] { color: #8fd69a; }
.gk-nethud__sync[data-tone='rollback'] { color: var(--gk-torch); border-color: var(--gk-torch); }
.gk-nethud__sync[data-tone='stalled'] { color: #ff8b78; border-color: var(--gk-blood-bright); }
.gk-nethud__detail { display: none; padding: 6px 10px; background: rgba(20, 17, 13, 0.82); border: 1px solid var(--gk-panel-border); border-radius: 6px; font: 11px/1.45 ui-monospace, Consolas, monospace; color: var(--gk-text-dim); white-space: pre; text-align: left; }
.gk-nethud__detail.is-on { display: block; }
.gk-nethud__toasts { position: absolute; left: 50%; top: clamp(96px, 15vh, 150px); transform: translateX(-50%); display: flex; flex-direction: column; align-items: center; gap: 6px; }
.gk-nethud__toast { padding: 0.45rem 2.2rem; color: #ffd9d3; letter-spacing: 0.12em; font-size: 0.98rem; white-space: nowrap; background: linear-gradient(90deg, transparent, rgba(20, 10, 8, 0.88) 14%, rgba(20, 10, 8, 0.88) 86%, transparent); border-top: 2px solid var(--gk-blood-bright); animation: gk-nethud-toast 5s ease forwards; }
@keyframes gk-nethud-toast { 0% { opacity: 0; transform: translateY(-8px); } 6% { opacity: 1; transform: none; } 88% { opacity: 1; } 100% { opacity: 0; } }
.gk-nethud__wait { position: absolute; left: 50%; top: 40%; transform: translate(-50%, -50%); display: none; flex-direction: column; align-items: center; gap: 0.5rem; padding: 1.4rem 2.6rem; max-width: min(520px, 88vw); text-align: center; background: rgba(14, 11, 8, 0.84); border: 1px solid var(--gk-panel-border); border-radius: 10px; box-shadow: 0 12px 40px rgba(0, 0, 0, 0.55); pointer-events: auto; }
.gk-nethud__wait.is-on { display: flex; }
.gk-nethud__spin { width: 30px; height: 30px; border-radius: 50%; border: 3px solid rgba(217, 164, 65, 0.25); border-top-color: var(--gk-gold); animation: gk-nethud-spin 0.9s linear infinite; }
@keyframes gk-nethud-spin { to { transform: rotate(360deg); } }
.gk-nethud__wait-title { font-size: 1.2rem; letter-spacing: 0.14em; }
.gk-nethud__wait-sub { font-size: 0.85rem; color: var(--gk-text-dim); }
.gk-nethud__wait-btn { margin-top: 0.4rem; display: none; }
.gk-nethud__wait-btn.is-on { display: inline-block; }
.gk-nethud__menu, .gk-nethud__dialog { position: absolute; inset: 0; display: none; align-items: center; justify-content: center; pointer-events: auto; }
.gk-nethud__menu.is-on, .gk-nethud__dialog.is-on { display: flex; }
.gk-nethud__menu { background: rgba(10, 8, 6, 0.32); }
.gk-nethud__dialog { background: rgba(10, 8, 6, 0.74); backdrop-filter: blur(3px); }
.gk-nethud__panel { min-width: min(300px, 88vw); max-width: min(520px, 90vw); padding: 1.5rem 2.2rem; gap: 0.7rem; }
.gk-nethud__panel.is-hidden { display: none; }
.gk-nethud__note { text-align: center; font-size: 0.82rem; color: var(--gk-text-dim); line-height: 1.45; }
.gk-nethud__msg { text-align: center; font-size: 0.98rem; color: var(--gk-text); line-height: 1.5; }
.gk-nethud__panel .gk-controls { grid-template-columns: 1fr; gap: 0.4rem; }
`;

function ensureStyle(): void {
  if (typeof document === 'undefined' || document.getElementById(STYLE_ID) !== null) return;
  const s = document.createElement('style');
  s.id = STYLE_ID;
  s.textContent = CSS;
  document.head.appendChild(s);
}

// ── the DOM overlay ──────────────────────────────────────────────────────────

const TOAST_MS = 5200;

export class NetHud implements NetHudLike {
  private readonly hooks: NetHudHooks;
  private root: HTMLElement | null = null;
  private chipsEl: HTMLElement | null = null;
  private syncEl: HTMLElement | null = null;
  private detailEl: HTMLElement | null = null;
  private toastsEl: HTMLElement | null = null;
  private waitEl: HTMLElement | null = null;
  private waitTitle: HTMLElement | null = null;
  private waitSub: HTMLElement | null = null;
  private waitBtn: HTMLElement | null = null;
  private spinEl: HTMLElement | null = null;
  private menuEl: HTMLElement | null = null;
  private mainPanel: HTMLElement | null = null;
  private controlsPanel: HTMLElement | null = null;
  private confirmPanel: HTMLElement | null = null;
  private resumeBtn: HTMLElement | null = null;
  private dialogEl: HTMLElement | null = null;
  private dialogBody: HTMLElement | null = null;
  private readonly timers = new Set<ReturnType<typeof setTimeout>>();

  private chipKey = '';
  private syncKey = '';
  private detailKey: string | null = '';
  private waitKey = '';

  constructor(hooks: NetHudHooks) {
    this.hooks = hooks;
  }

  get layer(): HTMLElement | null {
    return this.root;
  }

  mount(host: HTMLElement): void {
    if (this.root !== null) return;
    ensureStyle();

    this.chipsEl = el('div', { class: 'gk-nethud__chips' });
    this.syncEl = el('div', { class: 'gk-nethud__sync', text: 'NET', dataset: { tone: 'ok' } });
    this.detailEl = el('div', { class: 'gk-nethud__detail' });
    const net = el('div', { class: 'gk-nethud__net' }, [this.chipsEl, this.syncEl, this.detailEl]);

    this.toastsEl = el('div', { class: 'gk-nethud__toasts', attrs: { 'aria-live': 'polite' } });

    this.spinEl = el('div', { class: 'gk-nethud__spin' });
    this.waitTitle = el('div', { class: 'gk-nethud__wait-title gk-display' });
    this.waitSub = el('div', { class: 'gk-nethud__wait-sub' });
    this.waitBtn = button('Leave match', 'gk-pause__btn gk-display gk-nethud__wait-btn', () => this.hooks.onRequestLeave());
    this.waitEl = el('div', { class: 'gk-nethud__wait', attrs: { role: 'status', 'aria-live': 'polite' } }, [this.spinEl, this.waitTitle, this.waitSub, this.waitBtn]);

    // Esc menu
    this.resumeBtn = button('Resume', 'gk-pause__btn gk-pause__btn--primary gk-display', () => this.hooks.onResume());
    this.mainPanel = el('div', { class: 'gk-pause__menu gk-nethud__panel' }, [
      el('h2', { class: 'gk-pause__title gk-display', text: 'Match menu' }),
      el('div', { class: 'gk-nethud__note', text: 'The match keeps running while this menu is open.' }),
      this.resumeBtn,
      button('Controls', 'gk-pause__btn gk-display', () => this.showPanel('controls')),
      button('Leave match', 'gk-pause__btn gk-display', () => this.showPanel('confirm')),
    ]);
    const rows = BRAWL_CONTROLS.filter(([keys]) => keys !== 'Esc').map(([keys, action]) =>
      el('div', { class: 'gk-controls__row' }, [el('kbd', { class: 'gk-controls__key', text: keys }), el('span', { class: 'gk-controls__action', text: action })]),
    );
    rows.push(el('div', { class: 'gk-controls__row' }, [el('kbd', { class: 'gk-controls__key', text: 'Esc' }), el('span', { class: 'gk-controls__action', text: 'Match menu (the match does not pause)' })]));
    rows.push(el('div', { class: 'gk-controls__row' }, [el('kbd', { class: 'gk-controls__key', text: 'F2' }), el('span', { class: 'gk-controls__action', text: 'Network statistics' })]));
    this.controlsPanel = el('div', { class: 'gk-pause__menu gk-nethud__panel is-hidden' }, [
      el('h2', { class: 'gk-pause__title gk-display', text: 'Controls' }),
      el('div', { class: 'gk-controls' }, rows),
      button('Back', 'gk-pause__btn gk-display', () => this.showPanel('main')),
    ]);
    this.confirmPanel = el('div', { class: 'gk-pause__menu gk-nethud__panel is-hidden' }, [
      el('h2', { class: 'gk-pause__title gk-display', text: 'Leave the match?' }),
      el('div', { class: 'gk-nethud__msg', text: 'Your fighter forfeits and the others play on. You go back to the room.' }),
      button('Leave match', 'gk-pause__btn gk-display', () => this.hooks.onLeave(), { dataset: { act: 'leave' } }),
      button('Stay in the match', 'gk-pause__btn gk-pause__btn--primary gk-display', () => this.hooks.onResume()),
    ]);
    this.menuEl = el('div', { class: 'gk-nethud__menu' }, [this.mainPanel, this.controlsPanel, this.confirmPanel]);

    this.dialogBody = el('div', { class: 'gk-pause__menu gk-nethud__panel' });
    this.dialogEl = el('div', { class: 'gk-nethud__dialog', attrs: { role: 'alertdialog' } }, [this.dialogBody]);

    this.root = el('div', { class: 'gk-nethud' }, [net, this.toastsEl, this.waitEl, this.menuEl, this.dialogEl]);
    host.appendChild(this.root);
  }

  unmount(): void {
    for (const t of this.timers) clearTimeout(t);
    this.timers.clear();
    this.root?.remove();
    this.root = null;
    this.chipsEl = this.syncEl = this.detailEl = this.toastsEl = null;
    this.waitEl = this.waitTitle = this.waitSub = this.waitBtn = this.spinEl = null;
    this.menuEl = this.mainPanel = this.controlsPanel = this.confirmPanel = this.resumeBtn = null;
    this.dialogEl = this.dialogBody = null;
  }

  update(s: NetHudState): void {
    if (this.root === null) return;

    // ping chips
    const ck = s.pings.map((p) => `${p.name}|${Math.round(p.ms)}|${p.gone ? 1 : 0}`).join(';');
    if (ck !== this.chipKey && this.chipsEl !== null) {
      this.chipKey = ck;
      this.chipsEl.textContent = '';
      for (const p of s.pings) {
        const chip = el('span', { class: `gk-nethud__chip${p.gone ? ' is-gone' : ''}`, text: `${p.name}  ${p.gone ? 'left' : formatPing(p.ms)}`, dataset: { tone: p.gone ? 'unknown' : pingTone(p.ms) } });
        this.chipsEl.appendChild(chip);
      }
    }

    // sync indicator
    if (s.sync !== this.syncKey && this.syncEl !== null) {
      this.syncKey = s.sync;
      this.syncEl.dataset.tone = s.sync;
      this.syncEl.textContent = s.sync === 'ok' ? 'IN SYNC' : s.sync === 'rollback' ? 'ROLLBACK' : 'WAITING';
    }

    // F2 stats
    if (s.detail !== this.detailKey && this.detailEl !== null) {
      this.detailKey = s.detail;
      this.detailEl.classList.toggle('is-on', s.detail !== null);
      if (s.detail !== null) this.detailEl.textContent = s.detail;
    }

    // wait panel
    const w = s.wait;
    const wk = w === null ? '' : `${w.kind}|${w.title}|${w.sub}|${w.canLeave ? 1 : 0}`;
    if (wk !== this.waitKey && this.waitEl !== null) {
      this.waitKey = wk;
      this.waitEl.classList.toggle('is-on', w !== null);
      if (w !== null) {
        if (this.waitTitle !== null) this.waitTitle.textContent = w.title;
        if (this.waitSub !== null) this.waitSub.textContent = w.sub;
        this.waitBtn?.classList.toggle('is-on', w.canLeave);
      }
    }
  }

  showForfeit(text: string): void {
    const host = this.toastsEl;
    if (host === null) return;
    const t = el('div', { class: 'gk-nethud__toast gk-display', text });
    host.appendChild(t);
    while (host.children.length > 4) host.firstElementChild?.remove();
    const id = setTimeout(() => {
      this.timers.delete(id);
      t.remove();
    }, TOAST_MS);
    this.timers.add(id);
  }

  openMenu(view: MenuView = 'main'): void {
    if (this.menuEl === null) return;
    this.menuEl.classList.add('is-on');
    this.showPanel(view);
  }

  closeMenu(): void {
    if (this.menuEl === null) return;
    this.menuEl.classList.remove('is-on');
    const active = typeof document !== 'undefined' ? (document.activeElement as HTMLElement | null) : null;
    if (active !== null && this.root?.contains(active) === true) active.blur();
  }

  showDialog(d: NetDialog): void {
    if (this.dialogEl === null || this.dialogBody === null) return;
    this.closeMenu();
    this.waitEl?.classList.remove('is-on');
    this.waitKey = '';
    const body = this.dialogBody;
    body.textContent = '';
    const ok = button(d.button, 'gk-pause__btn gk-pause__btn--primary gk-display', () => this.hooks.onDialogClose());
    body.append(
      el('h2', { class: 'gk-pause__title gk-display', text: d.title }),
      el('div', { class: 'gk-nethud__msg', text: d.message }),
      ...(d.hint !== undefined ? [el('div', { class: 'gk-nethud__note', text: d.hint })] : []),
      ok,
    );
    this.dialogEl.classList.add('is-on');
    ok.focus({ preventScroll: true });
  }

  private showPanel(which: 'main' | 'controls' | 'confirm'): void {
    this.mainPanel?.classList.toggle('is-hidden', which !== 'main');
    this.controlsPanel?.classList.toggle('is-hidden', which !== 'controls');
    this.confirmPanel?.classList.toggle('is-hidden', which !== 'confirm');
    const target = which === 'main' ? this.resumeBtn : which === 'confirm' ? (this.confirmPanel?.querySelector('.gk-pause__btn--primary') as HTMLElement | null) : null;
    target?.focus({ preventScroll: true });
  }
}
