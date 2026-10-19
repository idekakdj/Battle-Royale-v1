/**
 * Sea-serpent warning HUD (v1.9 Ocean Dome, WP-O4; v1.10 two lanes, WP-H5): the DOM half of `serpentHudModel.ts`. NOT a Screen —
 * the match controller mounts it into the HUD layer ONLY on arenas with `hazards.serpent`, forwards the `serpentWarning` /
 * `serpentEnd` bus events (with their `tier`) and calls {@link update} once per render frame.
 *
 * Per lane (LOW = the red-orange v1.9 serpent, HIGH = the violet one that hunts the upper platforms; both can run at once):
 *  - a banner "SEA SERPENT! — LOW GROUND" / "— HIGH GROUND" (centred, pulsing; ~1 s hold then fades; spectators see it too), the two
 *    banners stacked in one centred column,
 *  - a chevron on the screen rim pointing toward the strike line's start + a thin line from it toward the screen centre (its length
 *    follows how close the player is to the strip), in the lane's colour (dimmed when the lane cannot hurt the player's band),
 *  - a status chip under the lane's banner during the warning: "MOVE!" (inside the strip, in the lane's band) / "SAFE".
 *
 * Everything is absolutely positioned with transform / class writes only (diffed): nothing moves the rest of the HUD.
 * The alarm sound comes from the audio layer's own `serpentWarning` handler (this class makes none).
 */

import type { SerpentTier, WorldSnapshot } from '../core/types';
import type { ArenaDef } from '../config/arenas';
import { ANIMALS } from '../config/animals';
import { el } from './dom';
import {
  SERPENT_BANNER_TEXT,
  SERPENT_TIERS,
  SerpentHudModel,
  serpentChipText,
  type SerpentBanner,
  type SerpentHudView,
  type SerpentLaneView,
  type SerpentStatus,
} from './serpentHudModel';

/** Distance (px) from the viewport edge to the chevron centre. Larger than the threat arrows' so the two rarely overlap. */
export const SERPENT_EDGE_MARGIN = 78;
/** The HIGH lane's chevron sits this many px further in, so two chevrons pointing the same way do not overlap. */
export const SERPENT_HIGH_INSET = 46;
/** Rim line: shortest / longest visible length as a fraction of the smaller viewport side. */
const LINE_MIN_FRAC = 0.05;
const LINE_MAX_FRAC = 0.34;
/** The line element is this tall (px) and scaled with `scaleY`, so changing its length never reflows anything. */
const LINE_BASE_PX = 400;

/** The per-lane DOM nodes and diff state. */
interface LaneDom {
  tier: SerpentTier;
  /** Full-screen layer of the lane's rim marker + line (carries `data-status`). */
  rim: HTMLElement;
  marker: HTMLElement;
  line: HTMLElement;
  /** Banner + chip card inside the shared centred column (carries `data-status`). */
  card: HTMLElement;
  banner: HTMLElement;
  chip: HTMLElement;
  lastBanner: SerpentBanner;
  lastStatus: SerpentStatus;
  lastMarker: boolean;
  lastOnBand: boolean;
  lastChipText: string;
  lastCard: boolean;
  mx: number;
  my: number;
  ma: number;
  lineK: number;
}

export class SerpentHud {
  readonly model: SerpentHudModel;
  private root: HTMLElement | null = null;
  private lanes: LaneDom[] = [];
  private w = 1280;
  private h = 720;

  constructor(arena: ArenaDef) {
    this.model = new SerpentHudModel(arena);
  }

  mount(layer: HTMLElement): void {
    this.unmount();
    this.lanes = SERPENT_TIERS.map((tier) => this.buildLane(tier));
    const stack = el(
      'div',
      { class: 'gk-serpent__stack' },
      this.lanes.map((l) => l.card),
    );
    this.root = el('div', { class: 'gk-serpent' }, [...this.lanes.map((l) => l.rim), stack]);
    layer.appendChild(this.root);
  }

  private buildLane(tier: SerpentTier): LaneDom {
    const banner = el('div', {
      class: 'gk-serpent__banner gk-display',
      text: SERPENT_BANNER_TEXT[tier],
      attrs: { role: 'alert' },
    });
    const chip = el('div', { class: 'gk-serpent__chip gk-display', attrs: { 'aria-live': 'off' } });
    const card = el('div', { class: 'gk-serpent__card', dataset: { tier, status: 'off' } }, [banner, chip]);
    const line = el('div', { class: 'gk-serpent__line' });
    line.style.height = `${LINE_BASE_PX}px`;
    const marker = el('div', { class: 'gk-serpent__marker', html: chevronSvg() });
    const rim = el('div', { class: 'gk-serpent__lane', dataset: { tier, status: 'off' } }, [line, marker]);
    return {
      tier,
      rim,
      marker,
      line,
      card,
      banner,
      chip,
      lastBanner: 'off',
      lastStatus: 'off',
      lastMarker: false,
      lastOnBand: true,
      lastChipText: '',
      lastCard: false,
      mx: -1e9,
      my: -1e9,
      ma: -1e9,
      lineK: -1,
    };
  }

  unmount(): void {
    this.root?.remove();
    this.root = null;
    this.lanes = [];
    this.model.onEnd();
  }

  /** Viewport size in CSS px (cheap to call per frame). */
  setViewport(w: number, h: number): void {
    this.w = w;
    this.h = h;
  }

  /** A `serpentWarning` event (pass its `tier ?? 'low'`): show that lane's banner (the marker follows from the snapshot blocks). */
  onWarning(nowMs: number, tier: SerpentTier = 'low'): void {
    this.model.onWarning(nowMs, tier);
  }

  /**
   * A `serpentEnd` event (pass its `tier ?? 'low'`): that lane's banner is dropped and the next {@link update} repaints from the
   * snapshot (whose block is gone). With no tier (the match ended mid-event) every lane is cleared at once, painted immediately.
   */
  onEnd(tier?: SerpentTier): void {
    this.model.onEnd(tier);
    if (tier === undefined && this.root !== null) this.apply(this.model.frame(0, {}, { camYaw: 0, player: null }));
  }

  /**
   * One render frame. `spectating` = the local player is dead (banners only). The local fighter is `snapshot.fighters[0]` (the
   * controller's id for "me", also online).
   */
  update(snapshot: WorldSnapshot, camYaw: number, w: number, h: number, nowMs: number, spectating: boolean): void {
    if (this.root === null || !this.model.enabled) return;
    this.w = w;
    this.h = h;
    const f = snapshot.fighters[0];
    const player =
      spectating || f === undefined || !f.alive
        ? null
        : { x: f.pos.x, y: f.pos.y, z: f.pos.z, radius: ANIMALS[f.animal].radius };
    this.apply(this.model.frame(nowMs, snapshot, { camYaw, player }));
  }

  /** Paint a view (diffed; exported through {@link update} / {@link onEnd}). */
  private apply(v: SerpentHudView): void {
    for (const l of this.lanes) this.applyLane(l, l.tier === 'low' ? v.low : v.high, v.labelChips);
  }

  private applyLane(l: LaneDom, v: SerpentLaneView, labelled: boolean): void {
    if (v.banner !== l.lastBanner) {
      l.lastBanner = v.banner;
      l.banner.classList.toggle('is-hold', v.banner === 'hold');
      l.banner.classList.toggle('is-fade', v.banner === 'fade');
    }
    const chipText = serpentChipText(v, labelled);
    if (v.status !== l.lastStatus) {
      l.lastStatus = v.status;
      l.rim.dataset.status = v.status;
      l.card.dataset.status = v.status;
    }
    if (chipText !== l.lastChipText) {
      l.lastChipText = chipText;
      l.chip.textContent = chipText;
      l.chip.classList.toggle('is-on', chipText !== '');
    }
    // The card takes room in the shared column only while its banner or chip shows (a lone lane then sits at the top).
    const card = v.banner !== 'off' || chipText !== '';
    if (card !== l.lastCard) {
      l.lastCard = card;
      l.card.classList.toggle('is-on', card);
    }
    if (v.onBand !== l.lastOnBand) {
      l.lastOnBand = v.onBand;
      l.rim.classList.toggle('is-off-band', !v.onBand);
    }
    if (v.marker !== l.lastMarker) {
      l.lastMarker = v.marker;
      l.marker.classList.toggle('is-on', v.marker);
      l.line.classList.toggle('is-on', v.marker);
    }
    if (!v.marker) return;
    const cx = this.w * 0.5;
    const cy = this.h * 0.5;
    const a = v.markerAngle;
    const inset = SERPENT_EDGE_MARGIN + (l.tier === 'high' ? SERPENT_HIGH_INSET : 0);
    const x = cx + Math.sin(a) * Math.max(0, cx - inset);
    const y = cy - Math.cos(a) * Math.max(0, cy - inset);
    if (Math.abs(x - l.mx) > 0.5 || Math.abs(y - l.my) > 0.5 || Math.abs(a - l.ma) > 0.005) {
      l.mx = x;
      l.my = y;
      l.ma = a;
      const t = `translate3d(${x.toFixed(1)}px,${y.toFixed(1)}px,0) rotate(${a.toFixed(3)}rad)`;
      l.marker.style.transform = t;
      l.line.style.transform = `${t} scaleY(${(this.lineLen(v.lineFrac) / LINE_BASE_PX).toFixed(3)})`;
      l.lineK = v.lineFrac;
      return;
    }
    if (Math.abs(v.lineFrac - l.lineK) > 0.01) {
      l.lineK = v.lineFrac;
      l.line.style.transform = `translate3d(${l.mx.toFixed(1)}px,${l.my.toFixed(1)}px,0) rotate(${l.ma.toFixed(3)}rad) scaleY(${(
        this.lineLen(v.lineFrac) / LINE_BASE_PX
      ).toFixed(3)})`;
    }
  }

  /** Rim line length in px for a danger fraction 0..1. */
  private lineLen(frac: number): number {
    const m = Math.min(this.w, this.h);
    return m * (LINE_MIN_FRAC + (LINE_MAX_FRAC - LINE_MIN_FRAC) * frac);
  }
}

/** Bold chevron pointing UP (outward from the screen centre once rotated to the marker angle). */
function chevronSvg(): string {
  return `<svg class="gk-serpent__svg" viewBox="-24 -24 48 48" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
    <path d="M0 -20 L19 8 L0 -1 L-19 8 Z" fill="currentColor" stroke="rgba(0,0,0,0.75)" stroke-width="2.4" stroke-linejoin="round"/>
    <path d="M0 -4 L12 15 L0 9 L-12 15 Z" fill="currentColor" fill-opacity="0.65" stroke="rgba(0,0,0,0.6)" stroke-width="1.6" stroke-linejoin="round"/>
  </svg>`;
}
