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
import type { AnimalId, Difficulty } from '../core/types';
import { el, button } from './dom';
import { animalHeadSvg, laurelSvg } from './icons';
import { ANIMALS } from '../config/animals';
import { BOT_PROFILES } from '../config/botProfiles';

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
}

export interface ResultsOptions {
  results: MatchResults;
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

    const buttons = el('div', { class: 'gk-results__buttons' }, [
      button('Rematch', 'gk-results__btn gk-results__btn--primary gk-display', () => this.opts.onRematch()),
      button('Change Gladiator', 'gk-results__btn gk-display', () => this.opts.onChangeGladiator()),
      button('Lobby', 'gk-results__btn gk-display', () => this.opts.onLobby()),
    ]);

    const card = el('div', { class: 'gk-results__card' }, [crest, headline, stats, buttons]);

    this.root = el('div', { class: `gk-screen gk-results ${r.victory ? 'is-victory' : 'is-defeat'}` }, [card]);
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
