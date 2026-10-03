/**
 * Champions League — setup screen (plan §8): fighter grid (all ten) with a live rotating preview, the animal's
 * tagline and five mini stat bars (Weight / Speed / Reach / Recovery / Power from the move data), two stage cards
 * with layout thumbnails drawn from the real stage geometry, opponents 1–3, bot level 1–4, stocks 1–5, time
 * (none / 3 / 5 / 8 min), START + BACK. Remembers the last choice (`gk-brawl`). Fully keyboard-navigable:
 * ←/→ move inside a group (and select), ↑/↓ move between rows / groups, Enter activates, Esc goes back.
 */

import type { Screen } from '../../core/ScreenManager';
import type { AnimalId } from '../../core/types';
import { ANIMALS, ANIMAL_IDS } from '../../config/animals';
import { BOT_PROFILES } from '../../config/botProfiles';
import { el, button, clear } from '../../ui/dom';
import { animalHeadSvg } from '../../ui/icons';
import { PreviewPane } from '../../ui/PreviewPane';
import { loadBrawlSetup, saveBrawlSetup } from '../../ui/storage';
import { STAGES, getMoveset } from '../data';
import { STAGE_IDS } from '../types';
import type { BrawlDifficulty, StageId } from '../types';
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
import { stageThumbSvg } from './stageThumb';
import { uiRatings, type UiRatings } from './ratingsUi';

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

export class BrawlSetup implements Screen {
  private readonly opts: BrawlSetupOptions;
  private choice: BrawlSetupChoice;
  private root: HTMLElement | null = null;
  private preview: PreviewPane | null = null;
  private infoEl: HTMLElement | null = null;
  private summaryEl: HTMLElement | null = null;
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
    for (const id of STAGE_IDS) {
      const def = STAGES[id];
      const b = el('button', { class: 'gk-bs__stage', type: 'button', dataset: { stage: id }, attrs: { role: 'radio', 'aria-checked': 'false', tabindex: '-1' } });
      b.innerHTML =
        `<span class="gk-bs__thumb">${stageThumbSvg(def)}</span>` +
        `<span class="gk-bs__stage-text"><span class="gk-bs__stage-name gk-display">${def.name}</span>` +
        `<span class="gk-bs__stage-blurb">${def.blurb}</span></span>`;
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
    this.infoEl = el('div', { class: 'gk-bs__info' });
    this.summaryEl = el('div', { class: 'gk-bs__summary' });
    const back = button('Back', 'gk-bs__back gk-display', () => this.opts.onBack());
    const start = button('Start', 'gk-bs__start gk-display', () => this.start());
    const actions = el('div', { class: 'gk-bs__actions' }, [back, start]);
    this.groups.push({ root: actions, items: [back, start], cols: 1, selects: false });
    const panel = el('aside', { class: 'gk-bs__panel' }, [this.preview.root, this.infoEl, this.summaryEl, actions]);

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
    this.syncSummary();
  }

  private pickStage(id: StageId): void {
    this.choice.stage = id;
    this.syncStages();
    this.syncSummary();
  }

  private renderInfo(): void {
    if (this.infoEl === null) return;
    const animal = this.choice.animal;
    const def = ANIMALS[animal];
    const set = getMoveset(animal);
    const r = uiRatings(set);
    clear(this.infoEl);
    this.infoEl.style.setProperty('--accent', def.accent);
    const bars = BARS.map(([key, label]) => {
      const fill = el('span', { class: 'gk-bs__bar-fill' });
      fill.style.width = `${Math.round(r[key] * 100)}%`;
      return el('div', { class: 'gk-bs__bar' }, [
        el('span', { class: 'gk-bs__bar-label', text: label }),
        el('span', { class: 'gk-bs__bar-track' }, [fill]),
      ]);
    });
    this.infoEl.append(
      el('div', { class: 'gk-bs__info-head' }, [
        el('h2', { class: 'gk-bs__info-name gk-display', text: def.displayName }),
        el('span', { class: 'gk-bs__info-title', text: def.title }),
      ]),
      el('p', { class: 'gk-bs__tagline', text: set.tagline }),
      el('div', { class: 'gk-bs__bars' }, bars),
    );
    this.root?.style.setProperty('--bs-accent', def.accent);
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
