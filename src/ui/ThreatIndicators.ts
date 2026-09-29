/**
 * Off-screen threat arrows + incoming-damage direction wedges (WP-M, §6.2).
 * DOM-only; the match layer supplies screen angles (radians, clockwise from
 * screen-up, 0 = straight ahead of the camera). Pooled, transform/opacity
 * writes only, no DOM reads.
 */

import { el } from './dom';

export const MAX_THREATS = 9;
const MAX_WEDGES = 4;
const WEDGE_MS = 900;
const EDGE_MARGIN = 46; // px from the viewport edge to the arrow center

interface Arrow {
  root: HTMLElement;
  shown: boolean;
  x: number;
  y: number;
  a: number;
}

interface Wedge {
  root: HTMLElement;
  attackerId: number;
  start: number;
  angle: number;
  shown: boolean;
}

export class ThreatIndicators {
  private layer: HTMLElement | null = null;
  private readonly arrows: Arrow[] = [];
  private readonly wedges: Wedge[] = [];
  private w = 1280;
  private h = 720;

  mount(layer: HTMLElement): void {
    this.unmount();
    const root = el('div', { class: 'gk-threat-layer' });
    for (let i = 0; i < MAX_THREATS; i++) {
      const a = el('div', { class: 'gk-threat is-hidden', html: arrowSvg() });
      root.appendChild(a);
      this.arrows.push({ root: a, shown: false, x: -1e9, y: -1e9, a: -1e9 });
    }
    for (let i = 0; i < MAX_WEDGES; i++) {
      const w = el('div', { class: 'gk-dmgdir is-hidden', html: wedgeSvg() });
      root.appendChild(w);
      this.wedges.push({ root: w, attackerId: -1, start: -1e9, angle: 0, shown: false });
    }
    layer.prepend(root);
    this.layer = root;
  }

  unmount(): void {
    this.layer?.remove();
    this.layer = null;
    this.arrows.length = 0;
    this.wedges.length = 0;
  }

  /** Viewport size in CSS px (call when it changes; cheap to call per frame). */
  setViewport(w: number, h: number): void {
    this.w = w;
    this.h = h;
  }

  /** Show arrow `slot` on the screen-edge ellipse at `angle`. */
  placeArrow(slot: number, angle: number): void {
    const ar = this.arrows[slot];
    if (ar === undefined) return;
    if (!ar.shown) {
      ar.shown = true;
      ar.root.classList.remove('is-hidden');
    }
    const cx = this.w * 0.5;
    const cy = this.h * 0.5;
    const x = cx + Math.sin(angle) * (cx - EDGE_MARGIN);
    const y = cy - Math.cos(angle) * (cy - EDGE_MARGIN);
    if (Math.abs(x - ar.x) > 0.5 || Math.abs(y - ar.y) > 0.5 || Math.abs(angle - ar.a) > 0.01) {
      ar.x = x;
      ar.y = y;
      ar.a = angle;
      ar.root.style.transform = `translate3d(${x.toFixed(1)}px,${y.toFixed(1)}px,0) rotate(${angle.toFixed(3)}rad)`;
    }
  }

  hideArrow(slot: number): void {
    const ar = this.arrows[slot];
    if (ar === undefined || !ar.shown) return;
    ar.shown = false;
    ar.root.classList.add('is-hidden');
  }

  hideAllArrows(): void {
    for (let i = 0; i < this.arrows.length; i++) this.hideArrow(i);
  }

  /** The player was hit by `attackerId`: start (or refresh) its wedge. */
  hurt(attackerId: number, angle: number, nowMs: number): void {
    if (this.wedges.length === 0) return;
    let pick: Wedge | null = null;
    let oldest: Wedge = this.wedges[0];
    for (const w of this.wedges) {
      if (w.attackerId === attackerId && nowMs - w.start < WEDGE_MS) pick = w;
      if (w.start < oldest.start) oldest = w;
    }
    const w = pick ?? oldest;
    w.attackerId = attackerId;
    w.start = nowMs;
    w.angle = angle;
  }

  /**
   * Fade/aim live wedges. `angleOf(attackerId)` returns the attacker's current
   * screen angle (or NaN to keep the last one) so the wedge keeps pointing at
   * the source while the camera turns. Pass a pre-bound function (no per-frame
   * closure).
   */
  updateWedges(nowMs: number, angleOf: (attackerId: number) => number): void {
    const cx = this.w * 0.5;
    const cy = this.h * 0.5;
    for (const w of this.wedges) {
      const age = nowMs - w.start;
      if (age >= WEDGE_MS || age < 0) {
        if (w.shown) {
          w.shown = false;
          w.root.classList.add('is-hidden');
        }
        continue;
      }
      const a = angleOf(w.attackerId);
      if (!Number.isNaN(a)) w.angle = a;
      if (!w.shown) {
        w.shown = true;
        w.root.classList.remove('is-hidden');
      }
      const k = age / WEDGE_MS;
      w.root.style.opacity = (k < 0.12 ? 1 : 1 - (k - 0.12) / 0.88).toFixed(2);
      w.root.style.transform = `translate3d(${cx.toFixed(1)}px,${cy.toFixed(1)}px,0) rotate(${w.angle.toFixed(3)}rad)`;
    }
  }

  clearWedges(): void {
    for (const w of this.wedges) {
      w.start = -1e9;
      if (w.shown) {
        w.shown = false;
        w.root.classList.add('is-hidden');
      }
    }
  }
}

function arrowSvg(): string {
  return `<svg class="gk-threat__svg" viewBox="-20 -20 40 40" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
    <path d="M0 -15 L13 9 L0 3 L-13 9 Z" fill="currentColor" stroke="rgba(0,0,0,0.65)" stroke-width="2" stroke-linejoin="round"/>
  </svg>`;
}

/** A red arc segment at the top of a 300 px ring (rotated to the source). */
function wedgeSvg(): string {
  return `<svg class="gk-dmgdir__svg" viewBox="-150 -150 300 300" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
    <path d="M -58 -128 A 140 140 0 0 1 58 -128 L 42 -104 A 112 112 0 0 0 -42 -104 Z" fill="currentColor"/>
  </svg>`;
}
