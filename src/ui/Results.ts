/**
 * Results screen (WP-F, BLUEPRINT §12).
 *
 * Victory: gold laurels + CSS confetti, "CHAMPION OF THE ARENA".
 * Defeat: "FELLED IN BATTLE — PLACED #N".
 * Stat rows (kills, damage dealt, damage blocked, ults used, match time,
 * difficulty) and REMATCH / CHANGE GLADIATOR / LOBBY buttons (BLUEPRINT §3).
 * Takes a plain results object built by WP-I from the final snapshot.
 */

import type { Screen } from '../core/ScreenManager';
import type { AnimalId, ArenaId, Difficulty } from '../core/types';
import { el, button } from './dom';
import { animalHeadSvg, laurelSvg } from './icons';
import { ANIMALS } from '../config/animals';
import { BOT_PROFILES } from '../config/botProfiles';

/** v1.5 online: one line of the final standings table. */
export interface ResultsStanding {
  /** 1 = champion. */
  placement: number;
  animal: AnimalId;
  /** The player's chosen name (or the animal's name for a bot). */
  name: string;
  kills: number;
  /** This row is the local player. */
  isYou: boolean;
  /** A bot (never a human, even one who left and was replaced). */
  isBot: boolean;
}

/** Everything the results screen shows; assembled by the match controller. */
export interface MatchResults {
  victory: boolean;
  /** Final placement, 1 = champion, 10 = first death (BLUEPRINT §6). */
  placement: number;
  /** The player's gladiator (for the accent + head icon). */
  animal: AnimalId;
  kills: number;
  damageDealt: number;
  damageBlocked: number;
  ultsUsed: number;
  /** Match duration in seconds of sim time. */
  matchTimeS: number;
  difficulty: Difficulty;
  /** v1.8: the map the match was played on (absent = colosseum). REMATCH keeps it. */
  arena?: ArenaId;
  /** v1.5 online: the whole room's final standings (shown as a table under the stats). */
  standings?: ResultsStanding[];
}

export interface ResultsOptions {
  results: MatchResults;
  /**
   * v1.5 online: when set, Rematch / Change Gladiator / Lobby are replaced by a single "Back to room" button that calls this.
   * `note` is shown under the buttons (e.g. "The host left the room.").
   */
  onBackToRoom?: () => void;
  note?: string;
  /** Same animal + difficulty, straight into a new match. */
  onRematch: () => void;
  /** Back to character select. */
  onChangeGladiator: () => void;
  /** Back to the lobby. */
  onLobby: () => void;
}

const CONFETTI_COUNT = 60;

export class Results implements Screen {
  private readonly opts: ResultsOptions;
  private root: HTMLElement | null = null;

  constructor(opts: ResultsOptions) {
    this.opts = opts;
  }

  mount(root: HTMLElement): void {
    const r = this.opts.results;
    const accent = ANIMALS[r.animal].accent;

    const headline = r.victory
      ? el('h1', { class: 'gk-results__headline gk-display', text: 'Champion of the Arena' })
      : el('h1', {
          class: 'gk-results__headline gk-results__headline--defeat gk-display',
          text: `Felled in Battle — Placed #${r.placement}`,
        });

    const crest = el('div', { class: 'gk-results__crest' }, [
      el('span', { class: 'gk-results__laurel', html: laurelSvg(false) }),
      el('span', {
        class: 'gk-results__head',
        html: animalHeadSvg(r.animal, 'gk-results__head-svg'),
        attrs: { style: `color:${accent}` },
      }),
      el('span', { class: 'gk-results__laurel', html: laurelSvg(true) }),
    ]);

    const stats = el('div', { class: 'gk-results__stats' }, [
      statRow('Kills', String(r.kills)),
      statRow('Damage Dealt', String(Math.round(r.damageDealt))),
      statRow('Damage Blocked', String(Math.round(r.damageBlocked))),
      statRow('Ultimates Used', String(r.ultsUsed)),
      statRow('Match Time', formatTime(r.matchTimeS)),
      statRow('Difficulty', `${BOT_PROFILES[r.difficulty].label} (${r.difficulty})`),
    ]);

    const backToRoom = this.opts.onBackToRoom;
    const buttons = el(
      'div',
      { class: 'gk-results__buttons' },
      backToRoom !== undefined
        ? [button('Back to room', 'gk-results__btn gk-results__btn--primary gk-display', () => backToRoom())]
        : [
            button('Rematch', 'gk-results__btn gk-results__btn--primary gk-display', () => this.opts.onRematch()),
            button('Change Gladiator', 'gk-results__btn gk-display', () => this.opts.onChangeGladiator()),
            button('Lobby', 'gk-results__btn gk-display', () => this.opts.onLobby()),
          ],
    );

    const card = el('div', { class: 'gk-results__card' }, [crest, headline, stats]);
    if (r.standings !== undefined && r.standings.length > 0) card.appendChild(standingsTable(r.standings));
    card.appendChild(buttons);
    if (this.opts.note !== undefined) card.appendChild(el('p', { class: 'gk-results__note', text: this.opts.note }));

    const online = r.standings !== undefined && r.standings.length > 0;
    this.root = el('div', { class: `gk-screen gk-results ${r.victory ? 'is-victory' : 'is-defeat'}${online ? ' gk-results--online' : ''}` }, [card]);
    this.root.style.setProperty('--result-accent', accent);
    if (r.victory) this.root.appendChild(this.buildConfetti());
    root.appendChild(this.root);
  }

  unmount(): void {
    this.root?.remove();
    this.root = null;
  }

  /** CSS-only confetti: staggered falling flecks in gold/accent tones. */
  private buildConfetti(): HTMLElement {
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

/** v1.5 online: final standings, best first (names via textContent — they are other players' input). */
function standingsTable(rows: readonly ResultsStanding[]): HTMLElement {
  const sorted = [...rows].sort((a, b) => (a.placement || 99) - (b.placement || 99));
  const list = el('div', { class: 'gk-results__standings', attrs: { role: 'table', 'aria-label': 'Final standings' } });
  for (const r of sorted) {
    list.appendChild(
      el('div', { class: `gk-results__stand${r.isYou ? ' is-you' : ''}${r.isBot ? ' is-bot' : ''}`, attrs: { role: 'row' } }, [
        el('span', { class: 'gk-results__stand-place gk-display', text: r.placement > 0 ? `#${r.placement}` : '–' }),
        el('span', {
          class: 'gk-results__stand-icon',
          html: animalHeadSvg(r.animal, 'gk-hud__kf-head'),
          attrs: { style: `color:${ANIMALS[r.animal].accent}` },
        }),
        el('span', { class: 'gk-results__stand-name', text: r.name }),
        el('span', { class: 'gk-results__stand-kills', text: `${r.kills} ${r.kills === 1 ? 'kill' : 'kills'}` }),
      ]),
    );
  }
  return list;
}

function statRow(label: string, value: string): HTMLElement {
  return el('div', { class: 'gk-results__row' }, [
    el('span', { class: 'gk-results__row-label', text: label }),
    el('span', { class: 'gk-results__row-value', text: value }),
  ]);
}

function formatTime(seconds: number): string {
  const s = Math.max(0, Math.round(seconds));
  const m = Math.floor(s / 60);
  return `${m}:${String(s % 60).padStart(2, '0')}`;
}
