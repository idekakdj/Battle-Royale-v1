/**
 * Champions League online — results (v1.5, WP-N5): the standings of the agreed final state with the HUMAN names, and a
 * single "Back to room" button. `buildNetResultsData` is pure (unit-tested); {@link NetResults} only renders it with the
 * same chrome as the local results screen (`gk-results`, `gk-brawl-results__*`).
 */

import { ANIMALS } from '../../config/animals';
import type { AnimalId } from '../../core/types';
import type { OnlineStart } from '../../online/types';
import { el, button } from '../../ui/dom';
import { animalHeadSvg, laurelSvg } from '../../ui/icons';
import { getStage } from '../data';
import { formatMatchTime } from '../ui/BrawlResults';
import type { BrawlMatchConfig, BrawlSnapshot } from '../types';

export interface NetFighterResult {
  slot: number;
  name: string;
  animal: AnimalId;
  isLocal: boolean;
  /** 1 = winner. */
  place: number;
  stocksLeft: number;
  kos: number;
  falls: number;
  damageDealt: number;
  percent: number;
  /** The player left mid-match. */
  forfeited: boolean;
}

export interface NetResultsData {
  stageName: string;
  /** −1 on a draw. */
  winnerSlot: number;
  winnerName: string | null;
  draw: boolean;
  localWon: boolean;
  localPlace: number;
  /** The clock ran out. */
  timeUp: boolean;
  matchTimeS: number;
  stocks: number;
  /** Sorted by place. */
  fighters: NetFighterResult[];
  /** Every connected player reported the same winner and final state. */
  agreed: boolean;
}

/** Final standings from the last snapshot: winner first, then stocks desc, KOs desc, falls asc, damage desc. */
export function buildNetResultsData(args: {
  start: OnlineStart;
  config: BrawlMatchConfig;
  snap: BrawlSnapshot;
  /** The agreed winner (RollbackSession.result.winnerId); −1 = draw. */
  winnerId: number;
  agreed: boolean;
  forfeited?: (slot: number) => boolean;
}): NetResultsData {
  const { start, config, snap, winnerId } = args;
  const rows: NetFighterResult[] = snap.fighters.map((f) => ({
    slot: f.id,
    name: start.slots[f.id]?.name ?? ANIMALS[f.animal].displayName,
    animal: f.animal,
    isLocal: f.id === start.localSlot,
    place: 0,
    stocksLeft: Math.max(0, f.stocks),
    kos: f.kos,
    falls: f.falls,
    damageDealt: Math.round(f.damageDealt),
    percent: Math.floor(f.percent),
    forfeited: args.forfeited?.(f.id) === true,
  }));
  rows.sort((a, b) => {
    if (a.slot === winnerId) return -1;
    if (b.slot === winnerId) return 1;
    return b.stocksLeft - a.stocksLeft || b.kos - a.kos || a.falls - b.falls || b.damageDealt - a.damageDealt || a.slot - b.slot;
  });
  rows.forEach((r, i) => {
    r.place = i + 1;
  });
  const local = rows.find((r) => r.isLocal);
  const winner = rows.find((r) => r.slot === winnerId);
  return {
    stageName: getStage(config.stage).name,
    winnerSlot: winnerId,
    winnerName: winner?.name ?? null,
    draw: winnerId < 0 || winner === undefined,
    localWon: winnerId >= 0 && winnerId === start.localSlot,
    localPlace: local?.place ?? rows.length,
    timeUp: snap.timeLeft !== null && snap.timeLeft <= 0,
    matchTimeS: Math.max(0, snap.time),
    stocks: config.stocks,
    fighters: rows,
    agreed: args.agreed,
  };
}

export interface NetResultsOptions {
  data: NetResultsData;
  /** The only way out: the controller reports `{ reason: 'finished' }`. */
  onBack: () => void;
}

const CONFETTI_COUNT = 56;

/** The results screen of an online match (a plain DOM block the controller mounts itself). */
export class NetResults {
  private readonly opts: NetResultsOptions;
  private root: HTMLElement | null = null;

  constructor(opts: NetResultsOptions) {
    this.opts = opts;
  }

  mount(host: HTMLElement): void {
    if (this.root !== null) return;
    const r = this.opts.data;
    const winnerRow = r.fighters.find((f) => f.slot === r.winnerSlot);
    const focusRow = r.fighters.find((f) => f.isLocal) ?? r.fighters[0];
    const showRow = r.draw ? focusRow : (winnerRow ?? focusRow);
    const accent = ANIMALS[showRow.animal].accent;

    let headline: string;
    let sub: string;
    if (r.draw) {
      headline = 'A Draw';
      sub = r.timeUp ? 'Time ran out with nothing between you' : 'Nobody left standing';
    } else if (r.localWon) {
      headline = 'Champion of the League';
      sub = r.timeUp ? 'Victory on the clock' : 'Last one standing';
    } else {
      headline = `${r.winnerName ?? 'Someone'} wins`;
      sub = `You placed #${r.localPlace}${r.timeUp ? ' — decided on the clock' : ''}`;
    }
    if (!r.agreed) sub += ' · not every player confirmed the result';

    const crest = el('div', { class: 'gk-results__crest' }, [
      el('span', { class: 'gk-results__laurel', html: laurelSvg(false) }),
      el('span', { class: 'gk-results__head', html: animalHeadSvg(showRow.animal, 'gk-results__head-svg'), attrs: { style: `color:${accent}` } }),
      el('span', { class: 'gk-results__laurel', html: laurelSvg(true) }),
    ]);

    const head = el('div', { class: 'gk-brawl-results__row gk-brawl-results__row--head' }, [
      el('span', { text: '#' }),
      el('span', { text: 'Fighter' }),
      el('span', { text: 'KOs' }),
      el('span', { text: 'Falls' }),
      el('span', { text: 'Damage' }),
      el('span', { text: 'Stocks' }),
    ]);
    const rows = r.fighters.map((f) => {
      const def = ANIMALS[f.animal];
      const label = `${f.name}${f.isLocal ? ' (You)' : ''}${f.forfeited ? ' — left' : ''}`;
      const row = el('div', { class: `gk-brawl-results__row${f.isLocal ? ' is-player' : ''}${f.slot === r.winnerSlot ? ' is-winner' : ''}` }, [
        el('span', { class: 'gk-brawl-results__place gk-display', text: String(f.place) }),
        el('span', { class: 'gk-brawl-results__who' }, [
          el('span', { class: 'gk-brawl-results__icon', html: animalHeadSvg(f.animal, 'gk-brawl-results__head') }),
          el('span', { class: 'gk-brawl-results__name', text: label, title: def.displayName }),
        ]),
        el('span', { text: String(f.kos) }),
        el('span', { text: String(f.falls) }),
        el('span', { text: String(f.damageDealt) }),
        el('span', { text: String(f.stocksLeft) }),
      ]);
      row.style.setProperty('--accent', def.accent);
      return row;
    });
    const table = el('div', { class: 'gk-brawl-results__table' }, [head, ...rows]);

    const meta = el('div', { class: 'gk-brawl-results__meta' }, [
      el('span', { text: r.stageName }),
      el('span', { text: `Match time ${formatMatchTime(r.matchTimeS)}` }),
      el('span', { text: `${r.stocks} stock${r.stocks === 1 ? '' : 's'}` }),
      el('span', { text: `${r.fighters.length} players online` }),
    ]);

    const buttons = el('div', { class: 'gk-results__buttons' }, [button('Back to room', 'gk-results__btn gk-results__btn--primary gk-display', () => this.opts.onBack())]);

    const card = el('div', { class: 'gk-results__card gk-brawl-results__card' }, [
      crest,
      el('h1', { class: `gk-results__headline gk-display${r.localWon ? '' : ' gk-results__headline--defeat'}`, text: headline }),
      el('div', { class: 'gk-brawl-results__sub', text: sub }),
      table,
      meta,
      buttons,
    ]);

    this.root = el('div', { class: `gk-screen gk-results gk-brawl-results ${r.localWon ? 'is-victory' : 'is-defeat'}` }, [card]);
    this.root.style.setProperty('--result-accent', accent);
    if (r.localWon) this.root.appendChild(this.confetti());
    host.appendChild(this.root);
    (buttons.firstElementChild as HTMLElement | null)?.focus({ preventScroll: true });
  }

  unmount(): void {
    this.root?.remove();
    this.root = null;
  }

  private confetti(): HTMLElement {
    const host = el('div', { class: 'gk-results__confetti', attrs: { 'aria-hidden': 'true' } });
    const colors = ['var(--gk-gold)', 'var(--gk-gold-bright)', 'var(--gk-sand)', 'var(--result-accent)'];
    for (let i = 0; i < CONFETTI_COUNT; i++) {
      const piece = el('span', { class: 'gk-results__confetto' });
      piece.style.left = `${Math.random() * 100}%`;
      piece.style.background = colors[i % colors.length];
      piece.style.animationDelay = `${Math.random() * 4}s`;
      piece.style.animationDuration = `${3.2 + Math.random() * 2.4}s`;
      piece.style.setProperty('--drift', `${(Math.random() * 2 - 1) * 8}vw`);
      piece.style.setProperty('--spin', `${Math.round(Math.random() * 540 + 180)}deg`);
      host.appendChild(piece);
    }
    return host;
  }
}

export interface NetResultsLike {
  mount(host: HTMLElement): void;
  unmount(): void;
}
