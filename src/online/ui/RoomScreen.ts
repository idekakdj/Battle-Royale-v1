/**
 * Online UI (WP-N4) — the room lobby. Shows the room code (+ copy code / copy link), the roster as player cards (name,
 * fighter, ready tick, ping, HOST / YOU tags, host-only Kick), the rules (host edits, everyone else sees them), your
 * fighter picker with a live preview, the Ready toggle (clients) / Start button (host) with human-readable blockers and Leave.
 *
 * The screen only renders `RoomState` and sends commands; the room layer owns all rules. `start` and the match itself are
 * handled by the flow (flow.ts) so they survive this screen being unmounted. Keys: Esc = leave (asks first), Enter = Ready /
 * Start when nothing is focused, arrows move inside the fighter grid and segmented controls, Enter / Space pick.
 */

import type { Screen } from '../../core/ScreenManager';
import type { AnimalId } from '../../core/types';
import { ANIMALS, ANIMAL_IDS } from '../../config/animals';
import { BOT_PROFILES } from '../../config/botProfiles';
import { STAGES } from '../../brawl/data';
import { STAGE_IDS } from '../../brawl/types';
import { stageThumbSvg } from '../../brawl/ui/stageThumb';
import { el, button, clear, append } from '../../ui/dom';
import { animalHeadSvg } from '../../ui/icons';
import { PreviewPane } from '../../ui/PreviewPane';
import { ONLINE_NAME_MAX, parseOnlineName, saveOnlineAnimal, saveOnlineName } from '../../ui/storage';
import type { OnlineMode } from '../types';
import { ROOM_LIMITS, type RoomEndReason, type RoomError, type RoomState } from '../room/types';
import { describeEndReason, describeRoomError } from './errors';
import { buildInviteLink, copyText, timeLimitLabel, type LocationLike } from './helpers';
import type { RoomLike } from './types';
import { buildRoomView, MODE_LABEL, settingsKey, type PlayerCardVM, type RoomVM } from './viewModel';
import { confirmDialog, pingEl, segmented, spinner, ToastStack, type ConfirmHandle } from './widgets';

export interface RoomScreenOptions {
  room: RoomLike;
  /** A toast shown when the screen appears (why the last match was cut short, ...). */
  notice?: string | null;
  /** The room had already ended while another screen was up: show the panel straight away. */
  ended?: { reason: RoomEndReason; message: string } | null;
  /** Leave confirmed (the room was left already) or "Back" on the ended panel. */
  onLeave: () => void;
  /** Test seam for invite links (default: `window.location`). */
  location?: LocationLike;
}

const TIME_OPTIONS_S: readonly number[] = [0, 180, 300, 480];
const STOCK_OPTIONS: readonly number[] = [1, 2, 3, 4, 5];
const LEVELS: readonly (1 | 2 | 3 | 4)[] = [1, 2, 3, 4];
const MODES: readonly OnlineMode[] = ['championsLeague', 'battleRoyale'];

function headSvg(animal: AnimalId, cls: string): HTMLElement {
  return el('span', { class: 'gk-on-head-icon', html: animalHeadSvg(animal, cls) });
}

export class RoomScreen implements Screen {
  private readonly opts: RoomScreenOptions;
  private readonly room: RoomLike;
  private root: HTMLElement | null = null;
  private state: RoomState;
  private vm: RoomVM | null = null;
  private preview: PreviewPane | null = null;
  private readonly toasts = new ToastStack();
  private dialog: ConfirmHandle | null = null;
  private unsubs: Array<() => void> = [];
  private lastSettingsKey = '';
  private optimistic: AnimalId | null = null;
  private optimisticTimer: number | null = null;
  private endedShown = false;
  private copyTimer: number | null = null;

  // elements
  private codeEl: HTMLElement | null = null;
  private modeBadge: HTMLElement | null = null;
  private copyCodeBtn: HTMLButtonElement | null = null;
  private copyLinkBtn: HTMLButtonElement | null = null;
  private fallbackEl: HTMLElement | null = null;
  private playersEl: HTMLElement | null = null;
  private botsEl: HTMLElement | null = null;
  private countsEl: HTMLElement | null = null;
  private constraintEl: HTMLElement | null = null;
  private rulesEl: HTMLElement | null = null;
  private panelEl: HTMLElement | null = null;
  private pickNameEl: HTMLElement | null = null;
  private pickTitleEl: HTMLElement | null = null;
  private gridEl: HTMLElement | null = null;
  private readonly fighterBtns = new Map<AnimalId, HTMLButtonElement>();
  private nameInput: HTMLInputElement | null = null;
  private statusEl: HTMLElement | null = null;
  private actionBtn: HTMLButtonElement | null = null;
  private startingEl: HTMLElement | null = null;
  private endedEl: HTMLElement | null = null;
  private readonly onKey = (e: KeyboardEvent): void => this.handleKey(e);

  constructor(opts: RoomScreenOptions) {
    this.opts = opts;
    this.room = opts.room;
    this.state = opts.room.state;
  }

  // ── lifecycle ───────────────────────────────────────────────────────────────

  mount(host: HTMLElement): void {
    this.state = this.room.state;
    this.vm = buildRoomView(this.state);
    const local = this.vm.local;

    // header: code + sharing + mode
    this.codeEl = el('span', { class: 'gk-on-code gk-display', attrs: { 'aria-live': 'polite' } });
    this.copyCodeBtn = button('Copy code', 'gk-bs__back gk-display gk-on-btn gk-on-btn--small', () => void this.copy('code'));
    this.copyLinkBtn = button('Copy link', 'gk-bs__back gk-display gk-on-btn gk-on-btn--small', () => void this.copy('link'));
    this.modeBadge = el('span', { class: 'gk-on-modebadge gk-display' });
    this.fallbackEl = el('div', { class: 'gk-on-copyfallback is-hidden' });
    const head = el('header', { class: 'gk-on-room__head' }, [
      el('div', { class: 'gk-on-room__codeblock' }, [el('span', { class: 'gk-on-label', text: 'Room code' }), this.codeEl]),
      el('div', { class: 'gk-on-room__share' }, [this.copyCodeBtn, this.copyLinkBtn]),
      el('div', { class: 'gk-on-room__meta' }, [this.modeBadge, el('span', { class: 'gk-on-role', text: this.state.role === 'host' ? 'You are the host' : 'Joined a room' })]),
    ]);

    // main column: players + rules
    this.playersEl = el('ul', { class: 'gk-on-players', attrs: { 'aria-label': 'Players' } });
    this.botsEl = el('div', { class: 'gk-on-bots' });
    this.countsEl = el('p', { class: 'gk-on-counts' });
    this.constraintEl = el('p', { class: 'gk-on-constraint' });
    this.rulesEl = el('div', { class: 'gk-on-rules' });
    const main = el('div', { class: 'gk-on-room__main' }, [
      el('section', { class: 'gk-on-sec gk-on-sec--players' }, [
        el('h2', { class: 'gk-bs__label gk-display', text: 'Players' }),
        this.playersEl,
        this.botsEl,
        this.countsEl,
        this.constraintEl,
      ]),
      el('section', { class: 'gk-on-sec gk-on-sec--rules' }, [el('h2', { class: 'gk-bs__label gk-display', text: 'Rules' }), this.rulesEl]),
    ]);

    // side panel: my fighter
    this.preview = new PreviewPane(local?.animal ?? 'lion', 'gk-preview gk-bs__preview gk-on-preview');
    this.pickNameEl = el('h2', { class: 'gk-on-pick__name gk-display' });
    this.pickTitleEl = el('span', { class: 'gk-on-pick__title' });
    this.gridEl = el('div', { class: 'gk-bs__grid gk-on-grid', attrs: { role: 'radiogroup', 'aria-label': 'Your fighter' } });
    for (const id of ANIMAL_IDS) {
      const def = ANIMALS[id];
      const b = el('button', { class: 'gk-bs__card gk-on-fcard', type: 'button', dataset: { animal: id }, attrs: { role: 'radio', 'aria-checked': 'false', tabindex: '-1' } });
      b.style.setProperty('--accent', def.accent);
      b.innerHTML = `<span class="gk-bs__card-icon">${animalHeadSvg(id, 'gk-bs__head')}</span><span class="gk-bs__card-name gk-display">${def.displayName}</span><span class="gk-on-fcard__by"></span>`;
      b.addEventListener('click', () => this.pick(id));
      this.fighterBtns.set(id, b);
      this.gridEl.appendChild(b);
    }
    this.gridEl.addEventListener('keydown', (e) => this.onGridKey(e));
    this.nameInput = el('input', {
      class: 'gk-on-input gk-on-input--small',
      id: 'gk-on-room-name',
      type: 'text',
      attrs: { maxlength: ONLINE_NAME_MAX, autocomplete: 'off', spellcheck: 'false', 'aria-label': 'Your name' },
    });
    this.nameInput.addEventListener('change', () => this.rename());
    this.nameInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        e.stopPropagation();
        this.rename();
        this.nameInput?.blur();
      }
    });
    this.statusEl = el('p', { class: 'gk-on-status', attrs: { 'aria-live': 'polite' } });
    this.actionBtn = button('', 'gk-bs__start gk-display gk-on-btn gk-on-btn--gold gk-on-action', () => this.onAction());
    const leaveBtn = button('Leave', 'gk-bs__back gk-display gk-on-btn', () => this.askLeave());
    this.panelEl = el('aside', { class: 'gk-bs__panel gk-on-room__panel' }, [
      el('h2', { class: 'gk-bs__label gk-display', text: 'Your fighter' }),
      this.preview.root,
      el('div', { class: 'gk-on-pick' }, [this.pickNameEl, this.pickTitleEl]),
      this.gridEl,
      el('label', { class: 'gk-on-field gk-on-field--row', attrs: { for: 'gk-on-room-name' } }, [el('span', { class: 'gk-on-field__label', text: 'Name' }), this.nameInput]),
      this.statusEl,
      el('div', { class: 'gk-bs__actions gk-on-actions' }, [leaveBtn, this.actionBtn]),
    ]);

    this.startingEl = el('div', { class: 'gk-on-overlay is-hidden', attrs: { role: 'status' } }, [
      el('div', { class: 'gk-on-overlay__box' }, [
        spinner(),
        el('strong', { class: 'gk-on-overlay__title gk-display', text: 'Starting…' }),
        el('span', { class: 'gk-on-overlay__sub', text: 'Connecting the players to each other' }),
      ]),
    ]);

    this.root = el('div', { class: 'gk-screen gk-on gk-on-room' }, [
      head,
      this.fallbackEl,
      el('div', { class: 'gk-on-room__body' }, [main, this.panelEl]),
      this.startingEl,
      this.toasts.root,
    ]);
    host.appendChild(this.root);

    this.unsubs.push(
      this.room.on('state', (s) => this.apply(s)),
      this.room.on('error', (e) => this.onRoomError(e)),
      this.room.on('ended', (r, m) => this.showEnded(r, m)),
    );
    document.addEventListener('keydown', this.onKey, true);

    this.apply(this.state, true);
    if (this.opts.notice != null && this.opts.notice.length > 0) this.toasts.push(this.opts.notice, 'info', 9000);
    if (this.opts.ended != null) this.showEnded(this.opts.ended.reason, this.opts.ended.message);
    else if (this.state.phase === 'closed') this.showEnded('left', 'The room is closed.');
    else (this.vm.local !== null ? this.fighterBtns.get(this.vm.local.animal) : null)?.focus({ preventScroll: true });
  }

  unmount(): void {
    for (const u of this.unsubs) u();
    this.unsubs = [];
    document.removeEventListener('keydown', this.onKey, true);
    this.dialog?.close();
    this.dialog = null;
    this.toasts.clear();
    if (this.copyTimer !== null) window.clearTimeout(this.copyTimer);
    if (this.optimisticTimer !== null) window.clearTimeout(this.optimisticTimer);
    this.copyTimer = this.optimisticTimer = null;
    this.preview?.dispose();
    this.preview = null;
    this.fighterBtns.clear();
    this.root?.remove();
    this.root = null;
    this.codeEl = this.modeBadge = this.copyCodeBtn = this.copyLinkBtn = this.fallbackEl = null;
    this.playersEl = this.botsEl = this.countsEl = this.constraintEl = this.rulesEl = this.panelEl = null;
    this.pickNameEl = this.pickTitleEl = this.gridEl = this.nameInput = this.statusEl = this.actionBtn = null;
    this.startingEl = this.endedEl = null;
    this.lastSettingsKey = '';
  }

  // ── rendering ───────────────────────────────────────────────────────────────

  private apply(state: RoomState, force = false): void {
    if (this.root === null) return;
    this.state = state;
    const vm = buildRoomView(state);
    this.vm = vm;
    if (this.optimistic !== null && vm.local !== null && vm.local.animal === this.optimistic) this.clearOptimistic();

    if (this.codeEl !== null) {
      this.codeEl.textContent = vm.code;
      this.codeEl.setAttribute('aria-label', `Room code ${vm.code.split('').join(' ')}`);
    }
    if (this.modeBadge !== null) this.modeBadge.textContent = vm.modeLabel;
    if (this.copyLinkBtn !== null) this.copyLinkBtn.hidden = this.inviteLink() === null;

    this.renderPlayers(vm);
    const key = settingsKey(state);
    if (force || key !== this.lastSettingsKey) {
      this.lastSettingsKey = key;
      this.renderRules(state, vm);
    }
    this.renderPanel(state, vm);
    const starting = state.phase === 'starting';
    this.startingEl?.classList.toggle('is-hidden', !starting);
    this.root.classList.toggle('is-locked', vm.locked);
  }

  private playerCard(c: PlayerCardVM): HTMLElement {
    const li = el('li', { class: 'gk-on-pcard', dataset: { id: c.id } });
    li.style.setProperty('--accent', c.accent);
    li.classList.toggle('is-ready', c.ready);
    li.classList.toggle('is-local', c.isLocal);
    li.classList.toggle('is-host', c.isHost);
    const badges = el('span', { class: 'gk-on-badges' }, [
      c.isHost ? el('b', { class: 'gk-on-badge gk-on-badge--host', text: 'HOST' }) : null,
      c.isLocal ? el('b', { class: 'gk-on-badge gk-on-badge--you', text: 'YOU' }) : null,
    ]);
    const kick = c.canKick ? button('Kick', 'gk-on-kick', () => this.askKick(c), { attrs: { 'aria-label': `Remove ${c.name} from the room` } }) : null;
    append(li, [
      headSvg(c.animal, 'gk-on-pcard__head'),
      el('span', { class: 'gk-on-pcard__text' }, [el('span', { class: 'gk-on-pcard__name', text: c.name }), el('span', { class: 'gk-on-pcard__sub', text: c.animalName })]),
      badges,
      el('span', { class: `gk-on-ready${c.ready ? ' is-on' : ''}`, text: c.ready ? '✓ Ready' : 'Not ready', title: c.ready ? 'Ready' : 'Not ready yet' }),
      c.isHost ? el('span', { class: 'gk-on-ping gk-on-ping--host', text: 'host' }) : pingEl(c.ping),
      kick,
    ]);
    return li;
  }

  private renderPlayers(vm: RoomVM): void {
    if (this.playersEl === null || this.botsEl === null || this.countsEl === null || this.constraintEl === null) return;
    clear(this.playersEl);
    for (const c of vm.humans) this.playersEl.appendChild(this.playerCard(c));
    if (!vm.locked) {
      for (let i = 0; i < vm.emptySlots; i++) {
        this.playersEl.appendChild(
          el('li', { class: 'gk-on-pcard is-empty' }, [el('span', { class: 'gk-on-pcard__text' }, [el('span', { class: 'gk-on-pcard__name', text: i === 0 ? 'Waiting for a friend…' : 'Open slot' })])]),
        );
      }
    }

    clear(this.botsEl);
    const br = vm.mode === 'battleRoyale';
    this.botsEl.classList.toggle('is-hidden', !br);
    if (br) {
      for (const b of vm.bots) {
        const chip = el('span', { class: 'gk-on-botchip' }, [headSvg(b.animal, 'gk-on-botchip__head'), el('span', { text: b.name })]);
        chip.style.setProperty('--accent', b.accent);
        if (b.canRemoveBot) chip.appendChild(button('×', 'gk-on-botchip__x', () => this.room.removeBot(b.id), { attrs: { 'aria-label': `Remove bot ${b.name}` } }));
        this.botsEl.appendChild(chip);
      }
      if (vm.bots.length === 0) this.botsEl.appendChild(el('span', { class: 'gk-on-muted', text: vm.counts.fill > 0 ? 'No bots added yet – the arena fills up automatically' : 'No bots' }));
    }

    const c = vm.counts;
    this.countsEl.textContent = br
      ? `${c.humans} player${c.humans === 1 ? '' : 's'} + ${c.bots} bot${c.bots === 1 ? '' : 's'}${c.fill > 0 ? ` + ${c.fill} auto-fill` : ''} = ${c.total} fighter${c.total === 1 ? '' : 's'}`
      : `${c.humans} of ${ROOM_LIMITS.maxHumans} players`;
    this.constraintEl.textContent = vm.constraint;
  }

  private renderRules(state: RoomState, vm: RoomVM): void {
    const rules = this.rulesEl;
    if (rules === null) return;
    const active = document.activeElement;
    const ctl = active instanceof HTMLElement && rules.contains(active) ? active.dataset.ctl : undefined;
    clear(rules);
    const edit = vm.isHost && state.phase === 'lobby';
    const row = (label: string, body: HTMLElement): HTMLElement => el('div', { class: 'gk-bs__optrow gk-on-optrow' }, [el('span', { class: 'gk-bs__optlabel', text: label }), body]);

    const mode = segmented({
      id: 'mode',
      label: 'Mode',
      items: MODES.map((m) => ({ key: m, label: MODE_LABEL[m] })),
      value: state.mode,
      disabled: !edit,
      onPick: (k) => this.room.setMode(k as OnlineMode),
    });
    rules.appendChild(row('Mode', mode.root));

    if (state.mode === 'championsLeague') {
      const cl = state.settings.cl;
      const stages = el('div', { class: 'gk-bs__stages gk-on-stages', attrs: { role: 'radiogroup', 'aria-label': 'Stage' } });
      for (const id of STAGE_IDS) {
        const def = STAGES[id];
        const b = el('button', {
          class: `gk-bs__stage gk-on-stage${id === cl.stage ? ' is-selected' : ''}`,
          type: 'button',
          dataset: { stage: id, ctl: `stage:${id}` },
          attrs: { role: 'radio', 'aria-checked': id === cl.stage ? 'true' : 'false', tabindex: id === cl.stage ? '0' : '-1' },
        });
        b.innerHTML = `<span class="gk-bs__thumb">${stageThumbSvg(def)}</span><span class="gk-bs__stage-text"><span class="gk-bs__stage-name gk-display"></span></span>`;
        (b.querySelector('.gk-bs__stage-name') as HTMLElement).textContent = def.name;
        b.disabled = !edit;
        b.addEventListener('click', () => this.room.setSettings({ cl: { stage: id } }));
        stages.appendChild(b);
      }
      const times = [...new Set([...TIME_OPTIONS_S, cl.timeLimitS])].sort((a, b) => a - b);
      const stocks = segmented({ id: 'stocks', label: 'Stocks', items: STOCK_OPTIONS.map((n) => ({ key: String(n), label: String(n) })), value: String(cl.stocks), disabled: !edit, onPick: (k) => this.room.setSettings({ cl: { stocks: Number(k) } }) });
      const time = segmented({ id: 'time', label: 'Time limit', items: times.map((s) => ({ key: String(s), label: timeLimitLabel(s) })), value: String(cl.timeLimitS), disabled: !edit, onPick: (k) => this.room.setSettings({ cl: { timeLimitS: Number(k) } }) });
      rules.append(row('Stage', stages), el('div', { class: 'gk-on-rules__pair' }, [row('Stocks', stocks.root), row('Time limit', time.root)]));
    } else {
      const br = state.settings.br;
      const level = segmented({
        id: 'level',
        label: 'Bot level',
        items: LEVELS.map((n) => ({ key: String(n), label: String(n), sub: BOT_PROFILES[n].label })),
        value: String(br.botLevel),
        disabled: !edit,
        onPick: (k) => this.room.setSettings({ br: { botLevel: Number(k) as 1 | 2 | 3 | 4 } }),
      });
      const fill = segmented({ id: 'fill', label: 'Fill with bots', items: [{ key: 'on', label: 'On' }, { key: 'off', label: 'Off' }], value: br.fillBots ? 'on' : 'off', disabled: !edit, onPick: (k) => this.room.setSettings({ br: { fillBots: k === 'on' } }) });
      const full = vm.counts.humans + vm.counts.bots >= ROOM_LIMITS.maxFighters;
      const add = button('+ Add bot', 'gk-bs__back gk-display gk-on-btn gk-on-btn--small', () => this.room.addBot(), { dataset: { ctl: 'addbot' } });
      add.disabled = !edit || full;
      const rem = button('− Remove bot', 'gk-bs__back gk-display gk-on-btn gk-on-btn--small', () => this.room.removeBot(), { dataset: { ctl: 'rembot' } });
      rem.disabled = !edit || vm.counts.bots === 0;
      rules.append(
        el('div', { class: 'gk-on-rules__pair' }, [row('Bot level', level.root), row('Fill the arena with bots', fill.root)]),
        row('Bots', el('div', { class: 'gk-on-botctl' }, [add, rem, el('span', { class: 'gk-on-muted', text: `${vm.counts.total} of ${ROOM_LIMITS.maxFighters} fighters at start` })])),
      );
    }
    if (!vm.isHost) rules.appendChild(el('p', { class: 'gk-on-muted gk-on-rules__note', text: 'Only the host can change the rules.' }));
    if (ctl !== undefined) rules.querySelector<HTMLElement>(`[data-ctl="${ctl}"]`)?.focus({ preventScroll: true });
  }

  private renderPanel(state: RoomState, vm: RoomVM): void {
    const local = vm.local;
    const shown: AnimalId = this.optimistic ?? local?.animal ?? 'lion';
    const def = ANIMALS[shown];
    this.panelEl?.style.setProperty('--accent', def.accent);
    this.preview?.setAnimal(shown);
    if (this.pickNameEl !== null) this.pickNameEl.textContent = def.displayName;
    if (this.pickTitleEl !== null) this.pickTitleEl.textContent = def.title;

    const enabledFirst = vm.fighters.find((f) => !f.taken)?.animal;
    for (const f of vm.fighters) {
      const b = this.fighterBtns.get(f.animal);
      if (b === undefined) continue;
      const mine = f.animal === shown;
      b.classList.toggle('is-selected', mine);
      b.classList.toggle('is-taken', f.taken);
      b.classList.toggle('has-bot', f.heldByBot);
      b.setAttribute('aria-checked', mine ? 'true' : 'false');
      b.disabled = f.taken || vm.locked;
      b.tabIndex = mine || (local === null && f.animal === enabledFirst) ? 0 : -1;
      b.title = f.taken ? `${ANIMALS[f.animal].displayName} – taken by ${f.takenBy ?? 'another player'}` : ANIMALS[f.animal].displayName;
      const by = b.querySelector('.gk-on-fcard__by');
      if (by !== null) by.textContent = f.taken ? (f.takenBy ?? '') : '';
    }

    if (this.nameInput !== null && local !== null && document.activeElement !== this.nameInput) this.nameInput.value = local.name;
    if (this.nameInput !== null) this.nameInput.disabled = vm.locked;

    if (this.statusEl !== null) {
      this.statusEl.textContent = vm.status;
      this.statusEl.classList.toggle('is-go', vm.isHost && vm.canStart);
    }
    const btn = this.actionBtn;
    if (btn !== null) {
      if (vm.isHost) {
        btn.textContent = 'Start';
        btn.disabled = !state.canStart;
        btn.removeAttribute('aria-pressed');
        btn.classList.remove('is-on');
      } else {
        const ready = local?.ready === true;
        btn.textContent = ready ? 'Ready ✓' : 'Ready';
        btn.disabled = vm.locked;
        btn.setAttribute('aria-pressed', ready ? 'true' : 'false');
        btn.classList.toggle('is-on', ready);
      }
    }
  }

  // ── actions ─────────────────────────────────────────────────────────────────

  private pick(animal: AnimalId): void {
    if (this.vm === null || this.vm.locked) return;
    const f = this.vm.fighters.find((x) => x.animal === animal);
    if (f === undefined || f.taken) return;
    this.optimistic = animal;
    if (this.optimisticTimer !== null) window.clearTimeout(this.optimisticTimer);
    this.optimisticTimer = window.setTimeout(() => {
      this.clearOptimistic();
      if (this.vm !== null) this.renderPanel(this.state, this.vm);
    }, 2000);
    if (this.room.pickAnimal(animal)) saveOnlineAnimal(animal);
    else this.clearOptimistic();
    if (this.vm !== null) this.renderPanel(this.state, this.vm);
  }

  private clearOptimistic(): void {
    this.optimistic = null;
    if (this.optimisticTimer !== null) window.clearTimeout(this.optimisticTimer);
    this.optimisticTimer = null;
  }

  private onAction(): void {
    const s = this.state;
    if (s.role === 'host') {
      if (s.canStart) this.room.startMatch();
      return;
    }
    const local = this.vm?.local;
    if (local !== null && local !== undefined && this.vm !== null && !this.vm.locked) this.room.setReady(!local.ready);
  }

  private rename(): void {
    if (this.nameInput === null) return;
    const name = parseOnlineName(this.nameInput.value);
    if (name.length === 0) {
      this.nameInput.value = this.vm?.local?.name ?? '';
      return;
    }
    this.nameInput.value = name;
    saveOnlineName(name);
    if (name !== this.vm?.local?.name) this.room.setName(name);
  }

  private askKick(c: PlayerCardVM): void {
    if (this.dialog !== null || c.peerId === null) return;
    const peerId = c.peerId;
    this.dialog = confirmDialog(this.root as HTMLElement, {
      title: 'Remove player?',
      message: `${c.name} will be removed from the room.`,
      confirmLabel: 'Remove',
      cancelLabel: 'Keep',
      danger: true,
      onConfirm: () => {
        this.dialog = null;
        this.room.kick(peerId);
      },
      onCancel: () => {
        this.dialog = null;
      },
    });
  }

  private askLeave(): void {
    if (this.dialog !== null || this.root === null) return;
    const host = this.state.role === 'host';
    const others = this.state.slots.filter((s) => s.kind === 'human' && !s.isLocal).length;
    this.dialog = confirmDialog(this.root, {
      title: host ? 'Close the room?' : 'Leave the room?',
      message: host
        ? others > 0
          ? 'You are the host: leaving closes the room for everyone.'
          : 'The room will be closed.'
        : 'You can join again later with the room code.',
      confirmLabel: host ? 'Close room' : 'Leave',
      cancelLabel: 'Stay',
      danger: true,
      onConfirm: () => {
        this.dialog = null;
        this.room.leave();
        this.opts.onLeave();
      },
      onCancel: () => {
        this.dialog = null;
      },
    });
  }

  // ── sharing ─────────────────────────────────────────────────────────────────

  private inviteLink(): string | null {
    const loc: LocationLike = this.opts.location ?? window.location;
    return buildInviteLink(this.state.code, loc);
  }

  private async copy(what: 'code' | 'link'): Promise<void> {
    const text = what === 'code' ? this.state.code : this.inviteLink();
    const btn = what === 'code' ? this.copyCodeBtn : this.copyLinkBtn;
    if (text === null || btn === null) return;
    const ok = await copyText(text);
    if (this.root === null) return;
    if (ok) {
      const label = what === 'code' ? 'Copy code' : 'Copy link';
      btn.textContent = 'Copied!';
      btn.classList.add('is-done');
      this.fallbackEl?.classList.add('is-hidden');
      if (this.copyTimer !== null) window.clearTimeout(this.copyTimer);
      this.copyTimer = window.setTimeout(() => {
        btn.textContent = label;
        btn.classList.remove('is-done');
      }, 1600);
      return;
    }
    // clipboard unavailable: show the text selected so Ctrl+C works
    const f = this.fallbackEl;
    if (f === null) return;
    clear(f);
    const input = el('input', { class: 'gk-on-input gk-on-input--small', type: 'text', attrs: { readonly: '', 'aria-label': what === 'code' ? 'Room code' : 'Invite link' } });
    input.value = text;
    append(f, [el('span', { class: 'gk-on-muted', text: 'Copy is blocked here – press Ctrl+C:' }), input]);
    f.classList.remove('is-hidden');
    input.focus();
    input.select();
  }

  // ── events ──────────────────────────────────────────────────────────────────

  private onRoomError(e: RoomError): void {
    if (this.root === null) return;
    const t = describeRoomError(e);
    if (e.code === 'animal-taken') {
      this.clearOptimistic();
      if (this.vm !== null) this.renderPanel(this.state, this.vm);
    }
    const hint = e.code === 'mesh-failed' && t.hint !== undefined ? ` ${t.hint}` : '';
    this.toasts.push(`${t.title}. ${t.message}${hint}`, 'error', e.code === 'mesh-failed' ? 14000 : 6500);
  }

  private showEnded(reason: RoomEndReason, message: string): void {
    if (this.root === null || this.endedShown) return;
    this.endedShown = true;
    this.dialog?.close();
    this.dialog = null;
    const t = describeEndReason(reason, message);
    const back = button('Back to Online', 'gk-bs__start gk-display gk-on-btn gk-on-btn--gold', () => this.opts.onLeave());
    this.endedEl = el('div', { class: 'gk-on-modal', attrs: { role: 'alertdialog', 'aria-modal': 'true', 'aria-label': t.title } }, [
      el('div', { class: 'gk-on-dialog' }, [
        el('h2', { class: 'gk-on-dialog__title gk-display', text: t.title }),
        el('p', { class: 'gk-on-dialog__msg', text: t.message }),
        t.hint !== undefined ? el('p', { class: 'gk-on-dialog__hint', text: t.hint }) : null,
        el('div', { class: 'gk-on-dialog__actions' }, [back]),
      ]),
    ]);
    this.root.appendChild(this.endedEl);
    this.startingEl?.classList.add('is-hidden');
    back.focus({ preventScroll: true });
  }

  // ── keyboard ────────────────────────────────────────────────────────────────

  private onGridKey(e: KeyboardEvent): void {
    const keys = ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'];
    if (!keys.includes(e.key)) return;
    const list = ANIMAL_IDS.map((id) => this.fighterBtns.get(id)).filter((b): b is HTMLButtonElement => b !== undefined && !b.disabled);
    const i = list.indexOf(e.target as HTMLButtonElement);
    if (i < 0) return;
    e.preventDefault();
    e.stopPropagation();
    const all = ANIMAL_IDS.map((id) => this.fighterBtns.get(id) as HTMLButtonElement);
    const at = all.indexOf(e.target as HTMLButtonElement);
    const cols = 5;
    const step = e.key === 'ArrowLeft' ? -1 : e.key === 'ArrowRight' ? 1 : e.key === 'ArrowUp' ? -cols : cols;
    // walk in the direction until an enabled card is found
    let j = at;
    for (let n = 0; n < all.length; n++) {
      j += step;
      if (j < 0 || j >= all.length) break;
      if (!all[j].disabled) {
        all[j].focus({ preventScroll: true });
        return;
      }
    }
  }

  private handleKey(e: KeyboardEvent): void {
    if (this.root === null || e.ctrlKey || e.metaKey || e.altKey) return;
    if (this.endedEl !== null) {
      if (e.key === 'Escape') {
        e.preventDefault();
        this.opts.onLeave();
      }
      return;
    }
    if (e.key === 'Escape') {
      e.preventDefault();
      if (this.dialog !== null) this.dialog.cancel();
      else this.askLeave();
      return;
    }
    if (this.dialog !== null) return;
    if (e.key === 'Enter' && (e.target === document.body || e.target === null) && this.state.phase === 'lobby') {
      e.preventDefault();
      this.onAction();
    }
  }
}
