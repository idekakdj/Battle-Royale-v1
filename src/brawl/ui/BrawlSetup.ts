/**
 * Champions League — setup screen (plan §8): fighter grid (all ten) with a live rotating preview, the animal's
 * tagline and five mini stat bars (Weight / Speed / Reach / Recovery / Power from the move data), four stage cards
 * (a 4-across row, v1.6) with layout thumbnails drawn from the real stage geometry and badges for the moving / breakable maps, opponents 1–3, bot level 1–4, stocks 1–5, time
 * (none / 3 / 5 / 8 min), START + BACK. Remembers the last choice (`gk-brawl`). Fully keyboard-navigable:
 * ←/→ move inside a group (and select), ↑/↓ move between rows / groups, Enter activates, Esc goes back.
 *
 * The detail panel has two tabs (OVERVIEW | MOVES, M switches): MOVES lists the fighter's eight attack inputs
 * (Light / Heavy x Neutral / Side / Down / Up), the highlighted move's details, the Light string and a few facts, all
 * generated from the move data by `movesView.ts`. It follows the selected fighter, so arrowing through the grid
 * keeps showing each fighter's moves. The chosen tab (and highlighted slot) is remembered for the session.
 */

import type { Screen } from '../../core/ScreenManager';
import type { AnimalId } from '../../core/types';
import { ANIMALS, ANIMAL_IDS } from '../../config/animals';
import { BOT_PROFILES } from '../../config/botProfiles';
import { el, button, clear, append } from '../../ui/dom';
import { animalHeadSvg } from '../../ui/icons';
import { PreviewPane } from '../../ui/PreviewPane';
import { loadBrawlSetup, saveBrawlSetup } from '../../ui/storage';
import { STAGES, getMoveset } from '../data';
import { MOVE_IDS, STAGE_IDS } from '../types';
import type { BrawlDifficulty, MoveId, StageId } from '../types';
import {
  BRAWL_DIFFICULTY_OPTIONS,
  BRAWL_OPPONENT_OPTIONS,
  BRAWL_STOCK_OPTIONS,
  BRAWL_TIME_OPTIONS,
  timeLabel,
  type BrawlOpponents,
  type BrawlSetupChoice,
  type BrawlStocks,
  type BrawlTimeMin,
} from './setup';
import { stageBadgesHtml, stageCards, stageThumbSvg } from './stageThumb';
import { uiRatings, type UiRatings } from './ratingsUi';
import { MOVES_LEGEND, buildMovesView, type MoveEntry, type MovesView } from './movesView';

export interface BrawlSetupOptions {
  /** Pre-selected choice (default: the stored `gk-brawl`, with `gk-animal` as the default fighter). */
  initial?: BrawlSetupChoice;
  /** START → the match. The choice is already persisted. */
  onStart: (setup: BrawlSetupChoice) => void;
  onBack: () => void;
}

interface Group {
  root: HTMLElement;
  items: HTMLButtonElement[];
  /** Columns for ↑/↓ inside the group (1 = rows move to the neighbouring group). */
  cols: number;
  /** Arrow focus also selects (radio groups); false for the action buttons. */
  selects: boolean;
}

const BARS: ReadonlyArray<readonly [keyof UiRatings, string]> = [
  ['weight', 'Weight'],
  ['speed', 'Speed'],
  ['reach', 'Reach'],
  ['recovery', 'Recovery'],
  ['power', 'Power'],
];

type InfoTab = 'overview' | 'moves';

const TAB_LABEL: Record<InfoTab, string> = { overview: 'Overview', moves: 'Moves' };

/** Remembered for the session (module scope outlives the screen): the chosen detail tab and the highlighted attack slot. */
const sessionView: { tab: InfoTab; slot: MoveId } = { tab: 'overview', slot: 'lightN' };

/** A row of key caps (down arrow, J ...), styled like the game's key hints. */
function keycaps(keys: readonly string[], cls: string): HTMLElement {
  return el(
    'span',
    { class: cls },
    keys.map((k) => el('kbd', { class: 'gk-controls__key gk-bs__key', text: k })),
  );
}

export class BrawlSetup implements Screen {
  private readonly opts: BrawlSetupOptions;
  private choice: BrawlSetupChoice;
  private root: HTMLElement | null = null;
  private preview: PreviewPane | null = null;
  private panelEl: HTMLElement | null = null;
  private infoEl: HTMLElement | null = null;
  private headEl: HTMLElement | null = null;
  private tabsEl: HTMLElement | null = null;
  private bodyEl: HTMLElement | null = null;
  private summaryEl: HTMLElement | null = null;
  private readonly tabBtns = new Map<InfoTab, HTMLButtonElement>();
  private readonly viewCache = new Map<AnimalId, MovesView>();
  private readonly moveCells = new Map<MoveId, HTMLButtonElement>();
  private moveDetailEl: HTMLElement | null = null;
  private moveView: MovesView | null = null;
  private readonly fighterBtns = new Map<AnimalId, HTMLButtonElement>();
  private readonly stageBtns = new Map<StageId, HTMLButtonElement>();
  private readonly groups: Group[] = [];
  private readonly segBtns = new Map<string, Map<string, HTMLButtonElement>>();
  private readonly onKey = (e: KeyboardEvent): void => this.handleKey(e);

  constructor(opts: BrawlSetupOptions) {
    this.opts = opts;
    this.choice = { ...(opts.initial ?? loadBrawlSetup()) };
  }

  mount(host: HTMLElement): void {
    const title = el('div', { class: 'gk-bs__header' }, [
      el('h1', { class: 'gk-bs__title gk-display', text: 'Champions League' }),
      el('p', { class: 'gk-bs__sub', text: 'Platform fighter · hit rivals to build their damage, then launch them off the stage' }),
    ]);

    // Fighters
    const grid = el('div', { class: 'gk-bs__grid', attrs: { role: 'radiogroup', 'aria-label': 'Fighter' } });
    const fighterItems: HTMLButtonElement[] = [];
    for (const id of ANIMAL_IDS) {
      const def = ANIMALS[id];
      const b = el('button', { class: 'gk-bs__card', type: 'button', dataset: { animal: id }, attrs: { role: 'radio', 'aria-checked': 'false', tabindex: '-1' } });
      b.style.setProperty('--accent', def.accent);
      b.innerHTML = `<span class="gk-bs__card-icon">${animalHeadSvg(id, 'gk-bs__head')}</span><span class="gk-bs__card-name gk-display">${def.displayName}</span>`;
      b.addEventListener('click', () => this.pickAnimal(id));
      this.fighterBtns.set(id, b);
      fighterItems.push(b);
      grid.appendChild(b);
    }
    this.groups.push({ root: grid, items: fighterItems, cols: 5, selects: true });

    // Stages
    const stages = el('div', { class: 'gk-bs__stages', attrs: { role: 'radiogroup', 'aria-label': 'Stage' } });
    const stageItems: HTMLButtonElement[] = [];
    for (const card of stageCards(STAGE_IDS, STAGES)) {
      const id = card.id;
      const def = STAGES[id];
      const b = el('button', { class: 'gk-bs__stage', type: 'button', dataset: { stage: id }, attrs: { role: 'radio', 'aria-checked': 'false', tabindex: '-1' } });
      b.innerHTML =
        `<span class="gk-bs__thumb">${stageThumbSvg(def)}</span>` +
        `<span class="gk-bs__stage-text"><span class="gk-bs__stage-name gk-display">${card.name}</span>` +
        `${stageBadgesHtml(def)}<span class="gk-bs__stage-blurb">${card.blurb}</span></span>`;
      b.addEventListener('click', () => this.pickStage(id));
      this.stageBtns.set(id, b);
      stageItems.push(b);
      stages.appendChild(b);
    }
    this.groups.push({ root: stages, items: stageItems, cols: 1, selects: true });

    // Options
    const opponents = this.segment('opponents', 'Opponents', BRAWL_OPPONENT_OPTIONS.map((n) => ({ key: String(n), label: String(n) })), () => String(this.choice.opponents), (k) => {
      this.choice.opponents = Number(k) as BrawlOpponents;
    });
    const level = this.segment(
      'difficulty',
      'Bot level',
      BRAWL_DIFFICULTY_OPTIONS.map((n) => ({ key: String(n), label: String(n), sub: BOT_PROFILES[n].label })),
      () => String(this.choice.difficulty),
      (k) => {
        this.choice.difficulty = Number(k) as BrawlDifficulty;
      },
    );
    const stocks = this.segment('stocks', 'Stocks', BRAWL_STOCK_OPTIONS.map((n) => ({ key: String(n), label: String(n) })), () => String(this.choice.stocks), (k) => {
      this.choice.stocks = Number(k) as BrawlStocks;
    });
    const time = this.segment('timeMin', 'Time limit', BRAWL_TIME_OPTIONS.map((n) => ({ key: String(n), label: timeLabel(n) })), () => String(this.choice.timeMin), (k) => {
      this.choice.timeMin = Number(k) as BrawlTimeMin;
    });
    const options = el('div', { class: 'gk-bs__opts' }, [opponents, level, stocks, time]);

    const left = el('div', { class: 'gk-bs__main' }, [
      this.section('Fighter', grid),
      this.section('Stage', stages),
      el('div', { class: 'gk-bs__sec' }, [options]),
    ]);

    // Right panel
    this.preview = new PreviewPane(this.choice.animal, 'gk-preview gk-bs__preview');
    this.headEl = el('div', { class: 'gk-bs__info-head' });
    this.tabsEl = this.buildTabs();
    this.bodyEl = el('div', { class: 'gk-bs__tabbody', attrs: { role: 'tabpanel' } });
    this.infoEl = el('div', { class: 'gk-bs__info' }, [this.headEl, this.tabsEl, this.bodyEl]);
    this.summaryEl = el('div', { class: 'gk-bs__summary' });
    const back = button('Back', 'gk-bs__back gk-display', () => this.opts.onBack());
    const start = button('Start', 'gk-bs__start gk-display', () => this.start());
    const actions = el('div', { class: 'gk-bs__actions' }, [back, start]);
    this.groups.push({ root: actions, items: [back, start], cols: 1, selects: false });
    const panel = el('aside', { class: 'gk-bs__panel' }, [this.preview.root, this.infoEl, this.summaryEl, actions]);
    this.panelEl = panel;

    this.root = el('div', { class: 'gk-screen gk-bs' }, [title, el('div', { class: 'gk-bs__body' }, [left, panel])]);
    host.appendChild(this.root);

    this.syncAll();
    document.addEventListener('keydown', this.onKey, true);
    // keyboard users start on the selected fighter
    this.fighterBtns.get(this.choice.animal)?.focus({ preventScroll: true });
  }

  unmount(): void {
    document.removeEventListener('keydown', this.onKey, true);
    this.preview?.dispose();
    this.preview = null;
    this.fighterBtns.clear();
    this.stageBtns.clear();
    this.segBtns.clear();
    this.tabBtns.clear();
    this.moveCells.clear();
    this.viewCache.clear();
    this.panelEl = this.infoEl = this.headEl = this.tabsEl = this.bodyEl = this.moveDetailEl = null;
    this.moveView = null;
    this.groups.length = 0;
    this.root?.remove();
    this.root = null;
  }

  // ── building blocks ────────────────────────────────────────────────────────

  private section(label: string, body: HTMLElement): HTMLElement {
    return el('section', { class: 'gk-bs__sec' }, [el('h2', { class: 'gk-bs__label gk-display', text: label }), body]);
  }

  private segment(
    id: string,
    label: string,
    items: ReadonlyArray<{ key: string; label: string; sub?: string }>,
    current: () => string,
    set: (key: string) => void,
  ): HTMLElement {
    const btns = new Map<string, HTMLButtonElement>();
    const list: HTMLButtonElement[] = [];
    const track = el('div', { class: 'gk-bs__seg', attrs: { role: 'radiogroup', 'aria-label': label } });
    for (const it of items) {
      const b = el('button', { class: 'gk-bs__segbtn', type: 'button', dataset: { key: it.key }, attrs: { role: 'radio', 'aria-checked': 'false', tabindex: '-1' } });
      b.innerHTML = `<span class="gk-bs__seg-main gk-display">${it.label}</span>${it.sub !== undefined ? `<span class="gk-bs__seg-sub">${it.sub}</span>` : ''}`;
      b.addEventListener('click', () => {
        set(it.key);
        this.syncSegment(id, current());
        this.syncSummary();
      });
      btns.set(it.key, b);
      list.push(b);
      track.appendChild(b);
    }
    this.segBtns.set(id, btns);
    this.groups.push({ root: track, items: list, cols: 1, selects: true });
    return el('div', { class: 'gk-bs__optrow' }, [el('span', { class: 'gk-bs__optlabel', text: label }), track]);
  }

  // ── state sync ─────────────────────────────────────────────────────────────

  private syncAll(): void {
    this.syncFighters();
    this.syncStages();
    this.syncSegment('opponents', String(this.choice.opponents));
    this.syncSegment('difficulty', String(this.choice.difficulty));
    this.syncSegment('stocks', String(this.choice.stocks));
    this.syncSegment('timeMin', String(this.choice.timeMin));
    this.renderInfo();
    this.syncSummary();
  }

  private mark(b: HTMLButtonElement, on: boolean): void {
    b.classList.toggle('is-selected', on);
    b.setAttribute('aria-checked', on ? 'true' : 'false');
    b.tabIndex = on ? 0 : -1;
  }

  private syncFighters(): void {
    for (const [id, b] of this.fighterBtns) this.mark(b, id === this.choice.animal);
  }

  private syncStages(): void {
    for (const [id, b] of this.stageBtns) this.mark(b, id === this.choice.stage);
  }

  private syncSegment(id: string, key: string): void {
    const btns = this.segBtns.get(id);
    if (btns === undefined) return;
    for (const [k, b] of btns) this.mark(b, k === key);
  }

  private pickAnimal(id: AnimalId): void {
    this.choice.animal = id;
    this.syncFighters();
    this.preview?.setAnimal(id);
    this.renderInfo();
    if (this.bodyEl !== null) this.bodyEl.scrollTop = 0;
    this.syncSummary();
  }

  private pickStage(id: StageId): void {
    this.choice.stage = id;
    this.syncStages();
    this.syncSummary();
  }

  // ── detail panel: OVERVIEW | MOVES ─────────────────────────────────────────

  private buildTabs(): HTMLElement {
    const bar = el('div', { class: 'gk-bs__tabs', attrs: { role: 'tablist', 'aria-label': 'Fighter details' } });
    for (const tab of ['overview', 'moves'] as const) {
      const b = el('button', { class: 'gk-bs__tab gk-display', type: 'button', text: TAB_LABEL[tab], dataset: { tab }, attrs: { role: 'tab', 'aria-selected': 'false', tabindex: '-1' } });
      b.addEventListener('click', () => this.setTab(tab));
      this.tabBtns.set(tab, b);
      bar.appendChild(b);
    }
    bar.appendChild(el('span', { class: 'gk-bs__tabs-hint' }, [el('kbd', { class: 'gk-controls__key gk-bs__key', text: 'M' })]));
    bar.addEventListener('keydown', (e) => {
      if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
      e.preventDefault();
      e.stopPropagation();
      const next: InfoTab = e.key === 'ArrowLeft' ? 'overview' : 'moves';
      this.setTab(next);
      this.tabBtns.get(next)?.focus({ preventScroll: true });
    });
    return bar;
  }

  /** Switch the detail tab (remembered for the session). Keeps keyboard focus on something that still exists. */
  private setTab(tab: InfoTab): void {
    if (this.bodyEl === null) return;
    const inBody = this.bodyEl.contains(document.activeElement);
    sessionView.tab = tab;
    this.renderTabBody();
    if (inBody) this.fighterBtns.get(this.choice.animal)?.focus({ preventScroll: true });
  }

  private renderInfo(): void {
    if (this.infoEl === null || this.headEl === null) return;
    const def = ANIMALS[this.choice.animal];
    clear(this.headEl);
    this.infoEl.style.setProperty('--accent', def.accent);
    this.headEl.append(
      el('h2', { class: 'gk-bs__info-name gk-display', text: def.displayName }),
      el('span', { class: 'gk-bs__info-title', text: def.title }),
    );
    this.root?.style.setProperty('--bs-accent', def.accent);
    this.renderTabBody();
  }

  private renderTabBody(): void {
    if (this.bodyEl === null) return;
    const moves = sessionView.tab === 'moves';
    this.panelEl?.classList.toggle('is-moves', moves);
    for (const [tab, b] of this.tabBtns) {
      const on = tab === sessionView.tab;
      b.classList.toggle('is-selected', on);
      b.setAttribute('aria-selected', on ? 'true' : 'false');
      b.tabIndex = on ? 0 : -1;
    }
    clear(this.bodyEl);
    this.moveCells.clear();
    this.moveDetailEl = null;
    if (moves) this.renderMoves(this.bodyEl);
    else this.renderOverview(this.bodyEl);
  }

  private renderOverview(into: HTMLElement): void {
    const set = getMoveset(this.choice.animal);
    const r = uiRatings(set);
    const bars = BARS.map(([key, label]) => {
      const fill = el('span', { class: 'gk-bs__bar-fill' });
      fill.style.width = `${Math.round(r[key] * 100)}%`;
      return el('div', { class: 'gk-bs__bar' }, [
        el('span', { class: 'gk-bs__bar-label', text: label }),
        el('span', { class: 'gk-bs__bar-track' }, [fill]),
      ]);
    });
    into.append(el('p', { class: 'gk-bs__tagline', text: set.tagline }), el('div', { class: 'gk-bs__bars' }, bars));
  }

  private viewFor(animal: AnimalId): MovesView {
    let v = this.viewCache.get(animal);
    if (v === undefined) {
      v = buildMovesView(animal);
      this.viewCache.set(animal, v);
    }
    return v;
  }

  /** The MOVES tab: 2 x 4 input grid, details of the highlighted move, the Light string and a few facts. */
  private renderMoves(into: HTMLElement): void {
    const view = this.viewFor(this.choice.animal);
    this.moveView = view;
    const wrap = el('div', { class: 'gk-bs__moves' });

    const grid = el('div', { class: 'gk-bs__mgrid', attrs: { role: 'radiogroup', 'aria-label': 'Attack inputs' } });
    for (const row of ['light', 'heavy'] as const) {
      const first = view.entries.find((e) => e.row === row);
      grid.appendChild(
        el('div', { class: 'gk-bs__mcap' }, [
          el('span', { class: 'gk-bs__mcap-name gk-display', text: row === 'light' ? 'Light' : 'Heavy' }),
          keycaps([first?.keys[first.keys.length - 1] ?? ''], 'gk-bs__keys'),
        ]),
      );
      for (const e of view.entries.filter((x) => x.row === row)) grid.appendChild(this.moveCell(e));
    }
    grid.addEventListener('keydown', (ev) => this.onMoveKey(ev));

    this.moveDetailEl = el('div', { class: 'gk-bs__mdetail', attrs: { 'aria-live': 'polite' } });

    const legend = el('p', { class: 'gk-bs__mlegend' }, [
      `${MOVES_LEGEND.light} = Light · ${MOVES_LEGEND.heavy} = Heavy · Dodge = ${MOVES_LEGEND.dodge}`,
      el('br'),
      MOVES_LEGEND.directions,
      el('br'),
      'Under each move: speed · damage per hit.',
    ]);

    const ls = view.lightString;
    const string = el('div', { class: 'gk-bs__mstring' }, [
      el('h3', { class: 'gk-bs__mlabel gk-display', text: ls.hits.length > 1 ? `Light string · ${ls.hits.length} hits` : 'Light attack' }),
      el(
        'div',
        { class: 'gk-bs__mchain' },
        ls.hits.flatMap((h, i) => [
          i > 0 ? el('span', { class: 'gk-bs__mchain-arrow', text: '→', attrs: { 'aria-hidden': 'true' } }) : null,
          el('span', { class: 'gk-bs__mchain-hit' }, [h.name, el('b', { text: ` ${Math.round(h.damage * 10) / 10}` })]),
        ]),
      ),
      ls.note !== '' ? el('p', { class: 'gk-bs__mnote', text: ls.note }) : null,
    ]);

    const tips = el('div', { class: 'gk-bs__mtipsbox' }, [
      el('h3', { class: 'gk-bs__mlabel gk-display', text: 'Good to know' }),
      el('ul', { class: 'gk-bs__mtips' }, view.tips.map((t) => el('li', { text: t }))),
    ]);

    wrap.append(grid, this.moveDetailEl, string, tips, legend);
    into.appendChild(wrap);
    this.selectSlot(sessionView.slot, false);
  }

  private moveCell(e: MoveEntry): HTMLButtonElement {
    const b = el('button', {
      class: 'gk-bs__mcell',
      type: 'button',
      dataset: { slot: e.slot },
      attrs: { role: 'radio', 'aria-checked': 'false', tabindex: '-1', 'aria-label': `${e.inputText}: ${e.name}` },
    });
    if (e.tags.some((t) => t.id === 'kill')) b.classList.add('is-kill');
    if (e.tags.some((t) => t.id === 'recovery')) b.classList.add('is-rec');
    b.append(
      keycaps(e.keys, 'gk-bs__keys'),
      el('span', { class: 'gk-bs__mname', text: e.name }),
      el('span', { class: 'gk-bs__mmeta', text: `${e.speed} · ${e.damageShort}` }),
    );
    // hovering or tabbing onto a cell shows its details; a mouse click must not steal the fighter grid's arrow-key focus
    b.addEventListener('mouseenter', () => this.selectSlot(e.slot, false));
    b.addEventListener('focus', () => this.selectSlot(e.slot, false));
    b.addEventListener('mousedown', (ev) => ev.preventDefault());
    b.addEventListener('click', () => this.selectSlot(e.slot, false));
    this.moveCells.set(e.slot, b);
    return b;
  }

  private onMoveKey(ev: KeyboardEvent): void {
    const i = MOVE_IDS.indexOf(sessionView.slot);
    let j = i;
    switch (ev.key) {
      case 'ArrowLeft':
        j = (i + MOVE_IDS.length - 1) % MOVE_IDS.length;
        break;
      case 'ArrowRight':
        j = (i + 1) % MOVE_IDS.length;
        break;
      case 'ArrowUp':
        if (i >= 4) j = i - 4;
        break;
      case 'ArrowDown':
        if (i < 4) j = i + 4;
        break;
      default:
        return;
    }
    ev.preventDefault();
    ev.stopPropagation();
    this.selectSlot(MOVE_IDS[j], true);
  }

  private selectSlot(slot: MoveId, focus: boolean): void {
    sessionView.slot = slot;
    for (const [id, b] of this.moveCells) {
      const on = id === slot;
      b.classList.toggle('is-selected', on);
      b.setAttribute('aria-checked', on ? 'true' : 'false');
      b.tabIndex = on ? 0 : -1;
    }
    if (focus) this.moveCells.get(slot)?.focus({ preventScroll: true });
    const entry = this.moveView?.entries.find((x) => x.slot === slot);
    if (entry !== undefined) this.renderMoveDetail(entry);
  }

  private renderMoveDetail(e: MoveEntry): void {
    const box = this.moveDetailEl;
    if (box === null) return;
    clear(box);
    box.dataset.slot = e.slot;
    append(box, [
      el('div', { class: 'gk-bs__md-head' }, [
        keycaps(e.keys, 'gk-bs__keys gk-bs__keys--big'),
        el('h3', { class: 'gk-bs__md-name gk-display', text: e.name }),
      ]),
      el('div', { class: 'gk-bs__md-stats' }, [
        el('span', { class: 'gk-bs__md-speed', dataset: { speed: e.speed.toLowerCase() }, text: `${e.speed} · ${e.startup}f startup` }),
        el('span', { class: 'gk-bs__md-dmg', text: `Damage ${e.damageLabel}` }),
      ]),
      e.look !== '' ? el('p', { class: 'gk-bs__md-look', text: e.look }) : null,
      e.tags.length > 0
        ? el(
            'div',
            { class: 'gk-bs__pills' },
            e.tags.map((t) => el('span', { class: 'gk-bs__pill', title: t.detail, dataset: { tag: t.id }, text: t.label })),
          )
        : null,
      e.airNote !== null ? el('p', { class: 'gk-bs__md-air', text: e.airNote }) : null,
    ]);
  }

  private syncSummary(): void {
    if (this.summaryEl === null) return;
    const c = this.choice;
    const stage = STAGES[c.stage].name;
    this.summaryEl.textContent = `You + ${c.opponents} bot${c.opponents === 1 ? '' : 's'} · level ${c.difficulty} · ${c.stocks} stock${c.stocks === 1 ? '' : 's'} · ${timeLabel(c.timeMin)} · ${stage}`;
  }

  private start(): void {
    saveBrawlSetup(this.choice);
    this.opts.onStart({ ...this.choice });
  }

  // ── keyboard ───────────────────────────────────────────────────────────────

  private locate(target: EventTarget | null): { g: number; i: number } | null {
    for (let g = 0; g < this.groups.length; g++) {
      const i = this.groups[g].items.indexOf(target as HTMLButtonElement);
      if (i >= 0) return { g, i };
    }
    return null;
  }

  private focusItem(g: number, i: number): void {
    const group = this.groups[g];
    if (group === undefined) return;
    const item = group.items[Math.max(0, Math.min(group.items.length - 1, i))];
    item.focus({ preventScroll: true });
    if (group.selects) item.click();
  }

  /** Focus the selected (or first) item of a group. */
  private enterGroup(g: number): void {
    const group = this.groups[g];
    if (group === undefined) return;
    const sel = group.items.findIndex((b) => b.classList.contains('is-selected'));
    const i = group.selects ? (sel >= 0 ? sel : 0) : group.items.length - 1;
    group.items[i].focus({ preventScroll: true });
  }

  private handleKey(e: KeyboardEvent): void {
    if (this.root === null || e.ctrlKey || e.metaKey || e.altKey) return;
    if (e.key === 'Escape') {
      e.preventDefault();
      this.opts.onBack();
      return;
    }
    if ((e.key === 'm' || e.key === 'M') && !e.repeat) {
      e.preventDefault();
      this.setTab(sessionView.tab === 'moves' ? 'overview' : 'moves');
      return;
    }
    const pos = this.locate(e.target);
    if (pos === null) {
      if (e.key === 'Enter' && (e.target === document.body || e.target === null)) {
        e.preventDefault();
        this.start();
      }
      return;
    }
    const group = this.groups[pos.g];
    const n = group.items.length;
    switch (e.key) {
      case 'ArrowLeft':
        e.preventDefault();
        this.focusItem(pos.g, (pos.i + n - 1) % n);
        break;
      case 'ArrowRight':
        e.preventDefault();
        this.focusItem(pos.g, (pos.i + 1) % n);
        break;
      case 'ArrowDown':
        e.preventDefault();
        if (group.cols > 1 && pos.i + group.cols < n) this.focusItem(pos.g, pos.i + group.cols);
        else if (pos.g + 1 < this.groups.length) this.enterGroup(pos.g + 1);
        break;
      case 'ArrowUp':
        e.preventDefault();
        if (group.cols > 1 && pos.i - group.cols >= 0) this.focusItem(pos.g, pos.i - group.cols);
        else if (pos.g > 0) this.enterGroup(pos.g - 1);
        break;
      default:
        break;
    }
  }
}
