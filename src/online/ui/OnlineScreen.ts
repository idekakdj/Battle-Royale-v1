/**
 * Online UI (WP-N4) — the "Online" screen reached from the lobby: a persisted player name and two tabs.
 *
 *   HOST   pick Champions League or Battle Royale -> "Create room" -> the Room screen with a fresh 5-character code.
 *   JOIN   type / paste a code or invite link -> "Join room" (progress + Cancel + friendly errors).
 *
 * A `?join=CODE` link opens the Join tab prefilled and, when a name is already saved, joins right away; otherwise the
 * name field gets the focus and Enter joins. Esc cancels a running attempt, otherwise goes back.
 */

import type { Screen } from '../../core/ScreenManager';
import { el, button, clear, append } from '../../ui/dom';
import {
  loadArena,
  loadBrawlSetup,
  loadDifficulty,
  loadOnlineAnimal,
  loadOnlineMode,
  loadOnlineName,
  ONLINE_NAME_MAX,
  parseOnlineName,
  saveOnlineMode,
  saveOnlineName,
  type OnlineModeSetting,
} from '../../ui/storage';
import { APP_VERSION_LABEL } from '../../version';
import { OnlineRoom } from '../room/OnlineRoom';
import type { HostOptions, JoinOptions } from '../room/types';
import { describeRoomError, type ErrorText, type RoomErrorLike } from './errors';
import { collapseJoinInput, parseJoinInput } from './helpers';
import type { OnlineNotice, RoomFactoryApi, RoomLike } from './types';
import { MODE_BLURB, MODE_LABEL } from './viewModel';
import { spinner } from './widgets';

export type OnlineTab = 'host' | 'join';

export interface OnlineScreenOptions {
  initialTab?: OnlineTab;
  /** Prefilled room code (deep link). */
  initialCode?: string | null;
  /** Deep link: join as soon as the screen is up when a name is already saved. */
  autoJoin?: boolean;
  /** Banner above the forms (e.g. "The host left"). */
  notice?: OnlineNotice | null;
  /** Test seam; defaults to the real `OnlineRoom`. */
  api?: RoomFactoryApi;
  /** A room was created / joined: hand it to the Room screen. */
  onRoom: (room: RoomLike) => void;
  onBack: () => void;
}

const REAL_API: RoomFactoryApi = {
  host: (o: HostOptions) => OnlineRoom.host(o),
  join: (code: string, o: JoinOptions) => OnlineRoom.join(code, o),
};

const MODES: readonly OnlineModeSetting[] = ['championsLeague', 'battleRoyale'];
const MODE_CHIPS: Record<OnlineModeSetting, readonly string[]> = {
  championsLeague: ['2–4 players', 'No bots', 'Rollback netcode'],
  battleRoyale: ['2–4 players', 'Bots up to 10', 'Host runs the arena'],
};

type Busy = { kind: 'host' | 'join'; code?: string } | null;

function asErrorLike(e: unknown): RoomErrorLike {
  if (typeof e === 'object' && e !== null && 'code' in e) return e as RoomErrorLike;
  return { code: 'internal', message: e instanceof Error ? e.message : String(e) };
}

export class OnlineScreen implements Screen {
  private readonly opts: OnlineScreenOptions;
  private readonly api: RoomFactoryApi;
  private root: HTMLElement | null = null;
  private tab: OnlineTab;
  private mode: OnlineModeSetting = loadOnlineMode();
  private busy: Busy = null;
  private token = 0;
  private slowTimer: number | null = null;

  private nameInput: HTMLInputElement | null = null;
  private codeInput: HTMLInputElement | null = null;
  private tabBtns = new Map<OnlineTab, HTMLButtonElement>();
  private panels = new Map<OnlineTab, HTMLElement>();
  private modeBtns = new Map<OnlineModeSetting, HTMLButtonElement>();
  private actionBtns: HTMLButtonElement[] = [];
  private alertEl: HTMLElement | null = null;
  private progressEl: HTMLElement | null = null;
  private progressText: HTMLElement | null = null;
  private cardEl: HTMLElement | null = null;
  private readonly onKey = (e: KeyboardEvent): void => this.handleKey(e);

  constructor(opts: OnlineScreenOptions) {
    this.opts = opts;
    this.api = opts.api ?? REAL_API;
    this.tab = opts.initialTab ?? (opts.initialCode != null ? 'join' : 'host');
  }

  mount(host: HTMLElement): void {
    this.nameInput = el('input', {
      class: 'gk-on-input',
      id: 'gk-on-name',
      type: 'text',
      attrs: { maxlength: ONLINE_NAME_MAX, autocomplete: 'off', spellcheck: 'false', placeholder: 'Your name', 'aria-label': 'Your name' },
    });
    this.nameInput.value = loadOnlineName();
    this.nameInput.addEventListener('change', () => this.persistName());
    this.nameInput.addEventListener('input', () => this.clearAlert());

    // tabs
    const tabs = el('div', { class: 'gk-on-tabs', attrs: { role: 'tablist', 'aria-label': 'Host or join' } });
    for (const t of ['host', 'join'] as const) {
      const b = el('button', {
        class: 'gk-on-tab gk-display',
        type: 'button',
        text: t === 'host' ? 'Host a room' : 'Join a room',
        dataset: { tab: t },
        attrs: { role: 'tab', 'aria-selected': 'false', tabindex: '-1' },
      });
      b.addEventListener('click', () => this.setTab(t));
      this.tabBtns.set(t, b);
      tabs.appendChild(b);
    }
    tabs.addEventListener('keydown', (e) => {
      if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
      e.preventDefault();
      e.stopPropagation();
      const next: OnlineTab = e.key === 'ArrowLeft' ? 'host' : 'join';
      this.setTab(next);
      this.tabBtns.get(next)?.focus({ preventScroll: true });
    });

    this.alertEl = el('div', { class: 'gk-on-alert is-hidden', attrs: { role: 'alert' } });
    this.progressText = el('span', { class: 'gk-on-progress__text' });
    this.progressEl = el('div', { class: 'gk-on-progress is-hidden', attrs: { role: 'status', 'aria-live': 'polite' } }, [
      spinner(),
      this.progressText,
      button('Cancel', 'gk-bs__back gk-display gk-on-btn gk-on-btn--small', () => this.cancel()),
    ]);

    this.cardEl = el('div', { class: 'gk-on-card' }, [
      this.opts.notice != null ? this.noticeEl(this.opts.notice) : null,
      el('label', { class: 'gk-on-field', attrs: { for: 'gk-on-name' } }, [el('span', { class: 'gk-on-field__label', text: 'Your name' }), this.nameInput]),
      tabs,
      this.hostPanel(),
      this.joinPanel(),
      this.alertEl,
      this.progressEl,
    ]);

    const header = el('div', { class: 'gk-on-head' }, [
      el('h1', { class: 'gk-on-title gk-display', text: 'Play Online' }),
      el('p', { class: 'gk-on-sub', text: 'Play with friends · up to 4 players · no account needed · everyone needs the same version' }),
    ]);
    const footer = el('div', { class: 'gk-on-foot' }, [
      button('Back', 'gk-bs__back gk-display gk-on-btn', () => this.opts.onBack()),
      el('span', { class: 'gk-on-foot__note', text: `Gladiator Kingdom ${APP_VERSION_LABEL}` }),
    ]);

    this.root = el('div', { class: 'gk-screen gk-on gk-on-online' }, [header, el('div', { class: 'gk-on-center' }, [this.cardEl]), footer]);
    host.appendChild(this.root);
    document.addEventListener('keydown', this.onKey, true);

    if (this.opts.initialCode != null && this.codeInput !== null) this.codeInput.value = this.opts.initialCode;
    this.syncTab();
    this.syncMode();
    this.focusStart();

    const code = this.opts.initialCode != null ? parseJoinInput(this.opts.initialCode) : null;
    if (this.opts.autoJoin === true && code !== null && code.kind === 'ok' && parseOnlineName(this.nameInput.value).length > 0) {
      window.setTimeout(() => {
        if (this.root !== null && this.busy === null) this.startJoin();
      }, 0);
    }
  }

  unmount(): void {
    this.token++; // any attempt still in flight becomes a no-op (a late room is left again)
    this.clearSlowTimer();
    document.removeEventListener('keydown', this.onKey, true);
    this.root?.remove();
    this.root = null;
    this.tabBtns.clear();
    this.panels.clear();
    this.modeBtns.clear();
    this.actionBtns = [];
    this.nameInput = this.codeInput = this.alertEl = this.progressEl = this.progressText = this.cardEl = null;
  }

  // ── panels ──────────────────────────────────────────────────────────────────

  private noticeEl(n: OnlineNotice): HTMLElement {
    return el('div', { class: `gk-on-alert is-${n.kind}`, attrs: { role: 'status' } }, [
      el('strong', { class: 'gk-on-alert__title', text: n.title }),
      el('span', { class: 'gk-on-alert__msg', text: n.message }),
      n.hint !== undefined ? el('span', { class: 'gk-on-alert__hint', text: n.hint }) : null,
    ]);
  }

  private hostPanel(): HTMLElement {
    const cards = el('div', { class: 'gk-on-modes', attrs: { role: 'radiogroup', 'aria-label': 'Game mode' } });
    for (const m of MODES) {
      const b = el('button', { class: 'gk-on-mode', type: 'button', dataset: { mode: m }, attrs: { role: 'radio', 'aria-checked': 'false', tabindex: '-1' } }, [
        el('span', { class: 'gk-on-mode__name gk-display', text: MODE_LABEL[m] }),
        el('span', { class: 'gk-on-mode__blurb', text: MODE_BLURB[m] }),
        el('span', { class: 'gk-on-chips' }, MODE_CHIPS[m].map((c) => el('span', { class: 'gk-on-chip', text: c }))),
      ]);
      b.addEventListener('click', () => this.setMode(m));
      this.modeBtns.set(m, b);
      cards.appendChild(b);
    }
    cards.addEventListener('keydown', (e) => {
      if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
      e.preventDefault();
      e.stopPropagation();
      const next: OnlineModeSetting = e.key === 'ArrowLeft' ? 'championsLeague' : 'battleRoyale';
      this.setMode(next);
      this.modeBtns.get(next)?.focus({ preventScroll: true });
    });
    const create = button('Create room', 'gk-bs__start gk-display gk-on-btn gk-on-btn--gold gk-on-go', () => this.startHost());
    this.actionBtns.push(create);
    const panel = el('div', { class: 'gk-on-panel', dataset: { panel: 'host' }, attrs: { role: 'tabpanel' } }, [
      el('p', { class: 'gk-on-hint', text: 'Pick a mode, create the room, then send the room code or link to your friends.' }),
      cards,
      create,
    ]);
    this.panels.set('host', panel);
    return panel;
  }

  private joinPanel(): HTMLElement {
    this.codeInput = el('input', {
      class: 'gk-on-input gk-on-codeinput',
      id: 'gk-on-code',
      type: 'text',
      attrs: { autocomplete: 'off', spellcheck: 'false', autocapitalize: 'characters', placeholder: 'K7P4Q', 'aria-label': 'Room code or invite link' },
    });
    this.codeInput.addEventListener('input', () => {
      this.clearAlert();
      if (this.codeInput === null) return;
      const v = collapseJoinInput(this.codeInput.value);
      if (v !== this.codeInput.value) this.codeInput.value = v;
    });
    const join = button('Join room', 'gk-bs__start gk-display gk-on-btn gk-on-btn--gold gk-on-go', () => this.startJoin());
    this.actionBtns.push(join);
    const panel = el('div', { class: 'gk-on-panel', dataset: { panel: 'join' }, attrs: { role: 'tabpanel' } }, [
      el('p', { class: 'gk-on-hint', text: 'Ask the host for the 5-character room code, or paste the invite link.' }),
      el('label', { class: 'gk-on-field', attrs: { for: 'gk-on-code' } }, [el('span', { class: 'gk-on-field__label', text: 'Room code or link' }), this.codeInput]),
      join,
    ]);
    this.panels.set('join', panel);
    return panel;
  }

  // ── state ───────────────────────────────────────────────────────────────────

  private setTab(tab: OnlineTab): void {
    if (this.busy !== null) return;
    this.tab = tab;
    this.clearAlert();
    this.syncTab();
  }

  private syncTab(): void {
    for (const [t, b] of this.tabBtns) {
      const on = t === this.tab;
      b.classList.toggle('is-selected', on);
      b.setAttribute('aria-selected', on ? 'true' : 'false');
      b.tabIndex = on ? 0 : -1;
    }
    for (const [t, p] of this.panels) p.classList.toggle('is-hidden', t !== this.tab);
  }

  private setMode(mode: OnlineModeSetting): void {
    if (this.busy !== null) return;
    this.mode = mode;
    saveOnlineMode(mode);
    this.syncMode();
  }

  private syncMode(): void {
    for (const [m, b] of this.modeBtns) {
      const on = m === this.mode;
      b.classList.toggle('is-selected', on);
      b.setAttribute('aria-checked', on ? 'true' : 'false');
      b.tabIndex = on ? 0 : -1;
    }
  }

  private focusStart(): void {
    if (this.nameInput === null) return;
    if (parseOnlineName(this.nameInput.value).length === 0) this.nameInput.focus({ preventScroll: true });
    else if (this.tab === 'join') this.codeInput?.focus({ preventScroll: true });
    else this.modeBtns.get(this.mode)?.focus({ preventScroll: true });
  }

  private persistName(): string {
    const name = parseOnlineName(this.nameInput?.value ?? '');
    if (this.nameInput !== null && name !== this.nameInput.value) this.nameInput.value = name;
    if (name.length > 0) saveOnlineName(name);
    return name;
  }

  // ── alerts / progress ───────────────────────────────────────────────────────

  private showAlert(t: ErrorText): void {
    const a = this.alertEl;
    if (a === null) return;
    clear(a);
    a.classList.remove('is-hidden');
    append(a, [
      el('strong', { class: 'gk-on-alert__title', text: t.title }),
      el('span', { class: 'gk-on-alert__msg', text: t.message }),
      t.hint !== undefined ? el('span', { class: 'gk-on-alert__hint', text: t.hint }) : null,
    ]);
  }

  private clearAlert(): void {
    if (this.alertEl === null) return;
    this.alertEl.classList.add('is-hidden');
    clear(this.alertEl);
  }

  private setBusy(busy: Busy, text = ''): void {
    this.busy = busy;
    const on = busy !== null;
    this.progressEl?.classList.toggle('is-hidden', !on);
    if (this.progressText !== null) this.progressText.textContent = text;
    this.root?.classList.toggle('is-busy', on);
    for (const b of this.actionBtns) b.disabled = on;
    for (const b of this.tabBtns.values()) b.disabled = on;
    for (const b of this.modeBtns.values()) b.disabled = on;
    if (this.nameInput !== null) this.nameInput.disabled = on;
    if (this.codeInput !== null) this.codeInput.disabled = on;
    this.clearSlowTimer();
    if (on) {
      this.slowTimer = window.setTimeout(() => {
        if (this.progressText !== null && this.busy !== null) this.progressText.textContent = `${text} Still trying – this can take up to 20 seconds.`;
      }, 5000);
    }
  }

  private clearSlowTimer(): void {
    if (this.slowTimer !== null) window.clearTimeout(this.slowTimer);
    this.slowTimer = null;
  }

  // ── actions ─────────────────────────────────────────────────────────────────

  /** Validate the name; shows an alert and focuses the field when it is empty. */
  private requireName(): string | null {
    const name = this.persistName();
    if (name.length > 0) return name;
    this.showAlert({ title: 'Pick a name first', message: 'Your friends will see this name in the room.' });
    this.nameInput?.focus({ preventScroll: true });
    return null;
  }

  private startHost(): void {
    if (this.busy !== null) return;
    this.clearAlert();
    const name = this.requireName();
    if (name === null) return;
    const brawl = loadBrawlSetup();
    const opts: HostOptions = {
      name,
      animal: loadOnlineAnimal(),
      mode: this.mode,
      settings: {
        br: { botLevel: loadDifficulty(), arena: loadArena() },
        cl: { stage: brawl.stage, stocks: brawl.stocks, timeLimitS: brawl.timeMin * 60 },
      },
    };
    saveOnlineMode(this.mode);
    void this.run({ kind: 'host' }, 'Creating your room…', () => this.api.host(opts));
  }

  private startJoin(): void {
    if (this.busy !== null) return;
    this.clearAlert();
    const name = this.requireName();
    if (name === null) return;
    const parsed = parseJoinInput(this.codeInput?.value ?? '');
    if (parsed.kind !== 'ok') {
      this.showAlert(
        parsed.kind === 'empty'
          ? { title: 'Enter a room code', message: 'Ask the host for the 5-character code, or paste the invite link.' }
          : describeRoomError({ code: 'bad-code' }),
      );
      this.codeInput?.focus({ preventScroll: true });
      return;
    }
    if (this.codeInput !== null) this.codeInput.value = parsed.code;
    const opts: JoinOptions = { name, animal: loadOnlineAnimal() };
    void this.run({ kind: 'join', code: parsed.code }, `Joining room ${parsed.code}…`, () => this.api.join(parsed.code, opts));
  }

  private async run(busy: NonNullable<Busy>, text: string, task: () => Promise<RoomLike>): Promise<void> {
    const token = ++this.token;
    this.setBusy(busy, text);
    try {
      const room = await task();
      if (token !== this.token || this.root === null) {
        // cancelled (or the screen is gone) while the attempt was in flight: do not keep a room nobody sees
        room.leave();
        return;
      }
      this.setBusy(null);
      this.opts.onRoom(room);
    } catch (e) {
      if (token !== this.token || this.root === null) return;
      this.setBusy(null);
      this.showAlert(describeRoomError(asErrorLike(e)));
      if (busy.kind === 'join') this.codeInput?.focus({ preventScroll: true });
      else this.modeBtns.get(this.mode)?.focus({ preventScroll: true });
    }
  }

  private cancel(): void {
    if (this.busy === null) return;
    this.token++; // the in-flight attempt is ignored; a room that still arrives is left again
    this.setBusy(null);
    this.focusStart();
  }

  // ── keyboard ────────────────────────────────────────────────────────────────

  private handleKey(e: KeyboardEvent): void {
    if (this.root === null || e.ctrlKey || e.metaKey || e.altKey) return;
    if (e.key === 'Escape') {
      e.preventDefault();
      if (this.busy !== null) this.cancel();
      else this.opts.onBack();
      return;
    }
    if (e.key !== 'Enter' || this.busy !== null) return;
    const t = e.target;
    if (t === this.nameInput || t === this.codeInput || t === document.body || t === null) {
      e.preventDefault();
      if (this.tab === 'host') this.startHost();
      else this.startJoin();
    }
  }
}
