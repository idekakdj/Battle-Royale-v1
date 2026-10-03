/**
 * Champions League — results screen (plan §8): winner banner, per-fighter KOs / falls / damage dealt / stocks,
 * and Rematch (fresh seed) / Change setup / Lobby. `buildResultsData` turns the final snapshot into plain data
 * (pure, unit-tested); the Screen only renders it. Reuses the Battle Royale results chrome (`gk-results`).
 */

import type { Screen } from '../../core/ScreenManager';
import { ANIMALS } from '../../config/animals';
import { el, button } from '../../ui/dom';
import { animalHeadSvg, laurelSvg } from '../../ui/icons';
import { getStage } from '../data';
import type { AnimalId } from '../../core/types';
import type { BrawlMatchConfig, BrawlSnapshot } from '../types';
import type { BrawlSetupChoice } from './setup';

export interface BrawlFighterResult {
  id: number;
  animal: AnimalId;
  isPlayer: boolean;
  /** 1 = winner. */
  place: number;
  stocksLeft: number;
  kos: number;
  falls: number;
  damageDealt: number;
  percent: number;
}

export interface BrawlResultsData {
  setup: BrawlSetupChoice;
  stageName: string;
  /** −1 on a draw. */
  winnerId: number;
  draw: boolean;
  playerWon: boolean;
  /** The clock ran out (rather than a last-fighter-standing finish). */
  timeUp: boolean;
  matchTimeS: number;
  /** Sorted by place. */
  fighters: BrawlFighterResult[];
  playerPlace: number;
}

/** Final standings from the last snapshot: winner first, then stocks desc, KOs desc, falls asc, damage desc. */
export function buildResultsData(setup: BrawlSetupChoice, config: BrawlMatchConfig, snap: BrawlSnapshot): BrawlResultsData {
  const rows: BrawlFighterResult[] = snap.fighters.map((f) => ({
    id: f.id,
    animal: f.animal,
    isPlayer: f.isPlayer,
    place: 0,
    stocksLeft: Math.max(0, f.stocks),
    kos: f.kos,
    falls: f.falls,
    damageDealt: Math.round(f.damageDealt),
    percent: Math.floor(f.percent),
  }));
  const winner = snap.winnerId;
  rows.sort((a, b) => {
    if (a.id === winner) return -1;
    if (b.id === winner) return 1;
    return (
      b.stocksLeft - a.stocksLeft ||
      b.kos - a.kos ||
      a.falls - b.falls ||
      b.damageDealt - a.damageDealt ||
      a.id - b.id
    );
  });
  rows.forEach((r, i) => {
    r.place = i + 1;
  });
  const player = rows.find((r) => r.isPlayer);
  return {
    setup,
    stageName: getStage(config.stage).name,
    winnerId: winner,
    draw: winner < 0,
    playerWon: winner >= 0 && snap.fighters[winner]?.isPlayer === true,
    timeUp: snap.timeLeft !== null && snap.timeLeft <= 0,
    matchTimeS: Math.max(0, snap.time),
    fighters: rows,
    playerPlace: player?.place ?? rows.length,
  };
}

export function formatMatchTime(seconds: number): string {
  const s = Math.max(0, Math.round(seconds));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

export interface BrawlResultsOptions {
  results: BrawlResultsData;
  onRematch: () => void;
  onChangeSetup: () => void;
  onLobby: () => void;
}

const CONFETTI_COUNT = 56;

export class BrawlResults implements Screen {
  private readonly opts: BrawlResultsOptions;
  private root: HTMLElement | null = null;

  constructor(opts: BrawlResultsOptions) {
    this.opts = opts;
  }

  mount(host: HTMLElement): void {
    const r = this.opts.results;
    const winnerRow = r.fighters.find((f) => f.id === r.winnerId);
    const focusRow = r.fighters.find((f) => f.isPlayer) ?? r.fighters[0];
    const accent = ANIMALS[(r.draw ? focusRow : (winnerRow ?? focusRow)).animal].accent;

    let headline: string;
    let sub: string;
    if (r.draw) {
      headline = 'A Draw';
      sub = r.timeUp ? 'Time ran out with nothing between you' : 'Nobody left standing';
    } else if (r.playerWon) {
      headline = 'Champion of the League';
      sub = r.timeUp ? 'Victory on the clock' : 'Last one standing';
    } else {
      headline = `Defeated — Placed #${r.playerPlace}`;
      sub = `${ANIMALS[winnerRow?.animal ?? 'lion'].displayName} takes the League`;
    }

    const crestAnimal = (r.draw ? focusRow : (winnerRow ?? focusRow)).animal;
    const crest = el('div', { class: 'gk-results__crest' }, [
      el('span', { class: 'gk-results__laurel', html: laurelSvg(false) }),
      el('span', {
        class: 'gk-results__head',
        html: animalHeadSvg(crestAnimal, 'gk-results__head-svg'),
        attrs: { style: `color:${accent}` },
      }),
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
      const row = el(
        'div',
        { class: `gk-brawl-results__row${f.isPlayer ? ' is-player' : ''}${f.id === r.winnerId ? ' is-winner' : ''}` },
        [
          el('span', { class: 'gk-brawl-results__place gk-display', text: String(f.place) }),
          el('span', { class: 'gk-brawl-results__who' }, [
            el('span', { class: 'gk-brawl-results__icon', html: animalHeadSvg(f.animal, 'gk-brawl-results__head') }),
            el('span', { class: 'gk-brawl-results__name', text: f.isPlayer ? `${def.displayName} (You)` : def.displayName }),
          ]),
          el('span', { text: String(f.kos) }),
          el('span', { text: String(f.falls) }),
          el('span', { text: String(f.damageDealt) }),
          el('span', { text: String(f.stocksLeft) }),
        ],
      );
      row.style.setProperty('--accent', def.accent);
      return row;
    });
    const table = el('div', { class: 'gk-brawl-results__table' }, [head, ...rows]);

    const meta = el('div', { class: 'gk-brawl-results__meta' }, [
      el('span', { text: r.stageName }),
      el('span', { text: `Match time ${formatMatchTime(r.matchTimeS)}` }),
      el('span', { text: `${r.setup.stocks} stock${r.setup.stocks === 1 ? '' : 's'}` }),
      el('span', { text: `Bot level ${r.setup.difficulty}` }),
    ]);

    const buttons = el('div', { class: 'gk-results__buttons' }, [
      button('Rematch', 'gk-results__btn gk-results__btn--primary gk-display', () => this.opts.onRematch()),
      button('Change Setup', 'gk-results__btn gk-display', () => this.opts.onChangeSetup()),
      button('Lobby', 'gk-results__btn gk-display', () => this.opts.onLobby()),
    ]);

    const card = el('div', { class: 'gk-results__card gk-brawl-results__card' }, [
      crest,
      el('h1', {
        class: `gk-results__headline gk-display${r.playerWon ? '' : ' gk-results__headline--defeat'}`,
        text: headline,
      }),
      el('div', { class: 'gk-brawl-results__sub', text: sub }),
      table,
      meta,
      buttons,
    ]);

    this.root = el('div', { class: `gk-screen gk-results gk-brawl-results ${r.playerWon ? 'is-victory' : 'is-defeat'}` }, [card]);
    this.root.style.setProperty('--result-accent', accent);
    if (r.playerWon) this.root.appendChild(this.confetti());
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
