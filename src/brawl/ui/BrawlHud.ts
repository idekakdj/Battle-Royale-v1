/**
 * Champions League — DOM HUD (plan §5). NOT a Screen: the controller mounts it over the canvas, calls
 * `update(snapshot)` after every view render and `onEvents(events)` for the events of the frame.
 *
 *  - bottom: one card per fighter (accent badge + name + big percent with the white→yellow→orange→red ramp that
 *    bumps on every hit + stock pips; KO'd fighters grey out; bots carry a level tag),
 *  - top centre: match clock (or ∞), centre: 3-2-1-FIGHT, KO banner ("X was KO'd by Y" / "X fell"),
 *  - world-anchored: a "YOU" marker above the player, small accent chevrons above the bots, and edge arrows
 *    for fighters outside the view (anchors come from `view.project`).
 *
 * Everything is cached: the DOM is only written when a value changed (percent integer, stocks, alive, timer
 * text, countdown step, marker pixel position). The HUD layer never captures the pointer.
 */

import type { AnimalId } from '../../core/types';
import { ANIMALS } from '../../config/animals';
import { el } from '../../ui/dom';
import { animalHeadSvg } from '../../ui/icons';
import { getMoveset } from '../data';
import type { BrawlEvent, BrawlMatchConfig, BrawlSnapshot } from '../types';
import { bumpScale, countdownStep, edgeMarker, formatPercent, formatTimer, koBannerText, percentColor } from './hudMath';
import type { CountdownDisplay } from './hudMath';

export interface BrawlHudOptions {
  config: BrawlMatchConfig;
  /** `view.project` — world metres → CSS pixels. */
  project: (x: number, y: number) => { x: number; y: number; onScreen: boolean };
  /** Viewport size in CSS pixels (default: the window). */
  viewport?: () => { w: number; h: number };
}

interface CardRefs {
  root: HTMLElement;
  pct: HTMLElement;
  pips: HTMLElement[];
  lastPct: number;
  lastStocks: number;
  lastAlive: boolean | null;
  bump: 0 | 1;
}

interface MarkerRefs {
  tag: HTMLElement;
  arrow: HTMLElement;
  arrowTip: HTMLElement;
  tagKey: string;
  arrowKey: string;
  tagOn: boolean;
  arrowOn: boolean;
  height: number;
}

const PAW_SVG =
  '<svg viewBox="0 0 24 24" aria-hidden="true"><ellipse cx="12" cy="16.2" rx="5.2" ry="4.3" fill="currentColor"/>' +
  '<ellipse cx="5.3" cy="10.6" rx="2.2" ry="2.9" fill="currentColor"/><ellipse cx="9.6" cy="6.2" rx="2.2" ry="2.9" fill="currentColor"/>' +
  '<ellipse cx="14.4" cy="6.2" rx="2.2" ry="2.9" fill="currentColor"/><ellipse cx="18.7" cy="10.6" rx="2.2" ry="2.9" fill="currentColor"/></svg>';

const EDGE_MARGIN = 46;
const BOTTOM_INSET = 110;
const HINT_SECONDS = 7;

function nameOf(animal: AnimalId): string {
  return ANIMALS[animal].displayName;
}

export class BrawlHud {
  private readonly opts: BrawlHudOptions;
  private root: HTMLElement | null = null;
  private timerEl: HTMLElement | null = null;
  private countEl: HTMLElement | null = null;
  private bannerEl: HTMLElement | null = null;
  private hintEl: HTMLElement | null = null;
  private readonly cards: CardRefs[] = [];
  private readonly markers: MarkerRefs[] = [];

  private lastTimer = '';
  private lastUrgent = false;
  private lastCount: CountdownDisplay = null;
  private countFlip: 0 | 1 = 0;
  private bannerFlip: 0 | 1 = 0;
  private hintHidden = false;

  constructor(opts: BrawlHudOptions) {
    this.opts = opts;
  }

  get layer(): HTMLElement | null {
    return this.root;
  }

  mount(host: HTMLElement): void {
    if (this.root !== null) return;
    const cfg = this.opts.config;

    this.timerEl = el('div', { class: 'gk-brawl-timer__value gk-display', text: formatTimer(cfg.timeLimitS > 0 ? cfg.timeLimitS : null) });
    const timer = el('div', { class: 'gk-brawl-timer' }, [this.timerEl]);
    this.countEl = el('div', { class: 'gk-brawl-count gk-display', attrs: { 'aria-live': 'polite' } });
    this.bannerEl = el('div', { class: 'gk-brawl-banner gk-display' });
    this.hintEl = el('div', {
      class: 'gk-brawl-hint',
      text: 'A / D move  ·  W / Space jump  ·  J light  ·  K heavy  ·  L dodge  ·  Esc pause',
    });

    const cardsEl = el('div', { class: 'gk-brawl-cards' });
    const worldEl = el('div', { class: 'gk-brawl-world' });
    cfg.roster.forEach((r, id) => {
      const def = ANIMALS[r.animal];
      // card
      const pct = el('span', { class: 'gk-brawl-card__num gk-display', text: '0' });
      const pips: HTMLElement[] = [];
      for (let i = 0; i < cfg.stocks; i++) pips.push(el('span', { class: 'gk-brawl-pip', html: PAW_SVG }));
      const root = el('div', { class: `gk-brawl-card${r.isPlayer ? ' is-player' : ''}`, dataset: { fighter: String(id) } }, [
        el('div', { class: 'gk-brawl-card__badge', html: animalHeadSvg(r.animal, 'gk-brawl-card__head') }),
        el('div', { class: 'gk-brawl-card__body' }, [
          el('div', { class: 'gk-brawl-card__top' }, [
            el('span', { class: 'gk-brawl-card__name gk-display', text: def.displayName }),
            el('span', { class: 'gk-brawl-card__tag', text: r.isPlayer ? 'YOU' : `LV ${cfg.difficulty}` }),
          ]),
          el('div', { class: 'gk-brawl-card__pct' }, [pct, el('span', { class: 'gk-brawl-card__sign', text: '%' })]),
          el('div', { class: 'gk-brawl-card__stocks' }, pips),
        ]),
      ]);
      root.style.setProperty('--accent', def.accent);
      cardsEl.appendChild(root);
      this.cards.push({ root, pct, pips, lastPct: -1, lastStocks: -1, lastAlive: null, bump: 0 });

      // world markers
      const tag = el('div', { class: `gk-brawl-tag${r.isPlayer ? ' is-player' : ''}`, html: '' }, [
        el('span', { class: 'gk-brawl-tag__label', text: r.isPlayer ? 'YOU' : def.displayName }),
        el('span', { class: 'gk-brawl-tag__chev' }),
      ]);
      tag.style.setProperty('--accent', def.accent);
      const arrowTip = el('span', { class: 'gk-brawl-arrow__tip' });
      const arrow = el('div', { class: 'gk-brawl-arrow' }, [
        el('span', { class: 'gk-brawl-arrow__badge', html: animalHeadSvg(r.animal, 'gk-brawl-arrow__head') }),
        arrowTip,
      ]);
      arrow.style.setProperty('--accent', def.accent);
      worldEl.append(tag, arrow);
      this.markers.push({
        tag,
        arrow,
        arrowTip,
        tagKey: '',
        arrowKey: '',
        tagOn: false,
        arrowOn: false,
        height: getMoveset(r.animal).stats.height,
      });
    });

    this.root = el('div', { class: 'gk-brawl-hud' }, [worldEl, timer, this.countEl, this.bannerEl, this.hintEl, cardsEl]);
    host.appendChild(this.root);
  }

  unmount(): void {
    this.root?.remove();
    this.root = null;
    this.timerEl = this.countEl = this.bannerEl = this.hintEl = null;
    this.cards.length = 0;
    this.markers.length = 0;
  }

  /** Per render frame (after `view.render`, so projections use the camera that was just drawn). */
  update(snap: BrawlSnapshot): void {
    if (this.root === null) return;

    // Timer
    const text = formatTimer(snap.timeLeft);
    if (text !== this.lastTimer && this.timerEl !== null) {
      this.lastTimer = text;
      this.timerEl.textContent = text;
    }
    const urgent = snap.timeLeft !== null && snap.timeLeft <= 10 && snap.countdown <= 0;
    if (urgent !== this.lastUrgent && this.timerEl !== null) {
      this.lastUrgent = urgent;
      this.timerEl.classList.toggle('is-urgent', urgent);
    }

    // Countdown 3-2-1-FIGHT
    const step = snap.matchOver ? null : countdownStep(snap.countdown, snap.time);
    if (step !== this.lastCount) {
      this.lastCount = step;
      this.showCount(step === null ? null : String(step), step === 'FIGHT');
    }

    // Controls hint fades after the first seconds of live play.
    if (!this.hintHidden && snap.time > HINT_SECONDS && this.hintEl !== null) {
      this.hintHidden = true;
      this.hintEl.classList.add('is-hidden');
    }

    // Cards
    const fighters = snap.fighters;
    for (let i = 0; i < fighters.length && i < this.cards.length; i++) {
      const f = fighters[i];
      const c = this.cards[i];
      const pctInt = Math.floor(f.percent);
      if (pctInt !== c.lastPct) {
        c.lastPct = pctInt;
        c.pct.textContent = formatPercent(f.percent);
        c.pct.style.color = percentColor(f.percent);
      }
      if (f.stocks !== c.lastStocks) {
        c.lastStocks = f.stocks;
        for (let s = 0; s < c.pips.length; s++) c.pips[s].classList.toggle('is-lost', s >= f.stocks);
        c.root.classList.toggle('is-out', f.stocks <= 0);
      }
      const alive = f.alive;
      if (alive !== c.lastAlive) {
        c.lastAlive = alive;
        c.root.classList.toggle('is-down', !alive && f.stocks > 0);
      }
    }

    this.updateMarkers(snap);
  }

  /** Events of the frame: percent bumps, KO banner, GAME! */
  onEvents(events: readonly BrawlEvent[]): void {
    if (this.root === null) return;
    const roster = this.opts.config.roster;
    for (let i = 0; i < events.length; i++) {
      const e = events[i];
      if (e.type === 'hit') {
        const c = this.cards[e.targetId];
        if (c !== undefined) {
          c.bump = c.bump === 0 ? 1 : 0;
          c.pct.style.setProperty('--bump', bumpScale(e.damage).toFixed(2));
          c.pct.classList.remove('is-bump-a', 'is-bump-b');
          c.pct.classList.add(c.bump === 0 ? 'is-bump-a' : 'is-bump-b');
        }
      } else if (e.type === 'ko') {
        const victim = roster[e.fighterId];
        if (victim === undefined) continue;
        const killer = e.killerId >= 0 && e.killerId !== e.fighterId ? roster[e.killerId] : undefined;
        this.showBanner(
          koBannerText(nameOf(victim.animal), killer !== undefined ? nameOf(killer.animal) : null),
          ANIMALS[victim.animal].accent,
          e.stocksLeft <= 0,
        );
      } else if (e.type === 'matchEnd') {
        this.lastCount = null;
        this.showCount('GAME!', true);
      }
    }
  }

  // ── internals ──────────────────────────────────────────────────────────────

  private showCount(text: string | null, fight: boolean): void {
    const c = this.countEl;
    if (c === null) return;
    if (text === null) return; // let the last pop-up animation finish on its own
    c.textContent = text;
    c.classList.toggle('is-fight', fight);
    this.countFlip = this.countFlip === 0 ? 1 : 0;
    c.classList.remove('is-a', 'is-b');
    c.classList.add(this.countFlip === 0 ? 'is-a' : 'is-b');
  }

  private showBanner(text: string, accent: string, final: boolean): void {
    const b = this.bannerEl;
    if (b === null) return;
    b.textContent = text;
    b.style.setProperty('--accent', accent);
    b.classList.toggle('is-final', final);
    this.bannerFlip = this.bannerFlip === 0 ? 1 : 0;
    b.classList.remove('is-a', 'is-b');
    b.classList.add(this.bannerFlip === 0 ? 'is-a' : 'is-b');
  }

  private viewport(): { w: number; h: number } {
    if (this.opts.viewport !== undefined) return this.opts.viewport();
    return { w: window.innerWidth, h: window.innerHeight };
  }

  private updateMarkers(snap: BrawlSnapshot): void {
    const { w, h } = this.viewport();
    const fighters = snap.fighters;
    const countdown = snap.countdown > 0;
    for (let i = 0; i < fighters.length && i < this.markers.length; i++) {
      const f = fighters[i];
      const m = this.markers[i];
      const visible = f.alive && f.stocks > 0;
      if (!visible) {
        this.setTag(m, false);
        this.setArrow(m, false, 0, 0, 0);
        continue;
      }
      const p = this.opts.project(f.pos.x, f.pos.y + m.height * 0.5);
      const inside = p.onScreen && p.x >= EDGE_MARGIN * 0.5 && p.x <= w - EDGE_MARGIN * 0.5 && p.y >= EDGE_MARGIN * 0.5 && p.y <= h - EDGE_MARGIN * 0.5;
      if (inside) {
        const head = this.opts.project(f.pos.x, f.pos.y + m.height + 0.55);
        this.setTag(m, true, head.x, head.y);
        this.setArrow(m, false, 0, 0, 0);
      } else {
        this.setTag(m, false);
        if (countdown) {
          this.setArrow(m, false, 0, 0, 0);
          continue;
        }
        const e = edgeMarker(p.x, p.y, w, h, EDGE_MARGIN, BOTTOM_INSET);
        this.setArrow(m, true, e.x, e.y, e.angle);
      }
    }
  }

  private setTag(m: MarkerRefs, on: boolean, x = 0, y = 0): void {
    if (on) {
      const key = `${Math.round(x)},${Math.round(y)}`;
      if (key !== m.tagKey) {
        m.tagKey = key;
        m.tag.style.transform = `translate3d(${Math.round(x)}px, ${Math.round(y)}px, 0) translate(-50%, -100%)`;
      }
    }
    if (on !== m.tagOn) {
      m.tagOn = on;
      m.tag.classList.toggle('is-on', on);
    }
  }

  private setArrow(m: MarkerRefs, on: boolean, x: number, y: number, angle: number): void {
    if (on) {
      const key = `${Math.round(x)},${Math.round(y)},${Math.round((angle * 180) / Math.PI / 3)}`;
      if (key !== m.arrowKey) {
        m.arrowKey = key;
        m.arrow.style.transform = `translate3d(${Math.round(x)}px, ${Math.round(y)}px, 0) translate(-50%, -50%)`;
        m.arrowTip.style.transform = `rotate(${angle.toFixed(3)}rad) translateX(34px)`;
      }
    }
    if (on !== m.arrowOn) {
      m.arrowOn = on;
      m.arrow.classList.toggle('is-on', on);
    }
  }
}
