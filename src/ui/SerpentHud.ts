/**
 * Sea-serpent warning HUD (v1.9 Ocean Dome, WP-O4): the DOM half of `serpentHudModel.ts`. NOT a Screen — the match controller
 * mounts it into the HUD layer ONLY on arenas with `hazards.serpent`, forwards the `serpentWarning` / `serpentEnd` bus events and
 * calls {@link update} once per render frame.
 *
 *  - banner "SEA SERPENT!" (centred, red/orange, pulsing; ~1 s hold then fades; spectators see it too),
 *  - a chevron on the screen rim pointing toward the strike line's start + a thin line from it toward the screen centre (its length
 *    follows how close the player is to the strip), tinted by status,
 *  - a status chip under the banner: "MOVE!" (inside the strip) / "SAFE" (clear) during the warning.
 *
 * Everything is absolutely positioned with transform / class writes only (diffed): nothing moves the rest of the HUD.
 * The alarm sound comes from the audio layer's own `serpentWarning` handler (this class makes none).
 */

import type { WorldSnapshot } from '../core/types';
import type { ArenaDef } from '../config/arenas';
import { ANIMALS } from '../config/animals';
import { el } from './dom';
import { SerpentHudModel, type SerpentBanner, type SerpentHudView, type SerpentStatus } from './serpentHudModel';

/** Distance (px) from the viewport edge to the chevron centre. Larger than the threat arrows' so the two rarely overlap. */
export const SERPENT_EDGE_MARGIN = 78;
/** Rim line: shortest / longest visible length as a fraction of the smaller viewport side. */
const LINE_MIN_FRAC = 0.05;
const LINE_MAX_FRAC = 0.34;
/** The line element is this tall (px) and scaled with `scaleY`, so changing its length never reflows anything. */
const LINE_BASE_PX = 400;

const CHIP_TEXT: Record<SerpentStatus, string> = { off: '', move: 'MOVE!', safe: 'SAFE', strike: '', after: '' };

export class SerpentHud {
  readonly model: SerpentHudModel;
  private root: HTMLElement | null = null;
  private banner!: HTMLElement;
  private marker!: HTMLElement;
  private line!: HTMLElement;
  private chip!: HTMLElement;
  private w = 1280;
  private h = 720;

  // Diff state.
  private lastBanner: SerpentBanner = 'off';
  private lastStatus: SerpentStatus = 'off';
  private lastMarker = false;
  private mx = -1e9;
  private my = -1e9;
  private ma = -1e9;
  private lineK = -1;

  constructor(arena: ArenaDef) {
    this.model = new SerpentHudModel(arena);
  }

  mount(layer: HTMLElement): void {
    this.unmount();
    this.banner = el('div', {
      class: 'gk-serpent__banner gk-display',
      text: 'SEA SERPENT!',
      attrs: { role: 'alert' },
    });
    this.chip = el('div', { class: 'gk-serpent__chip gk-display', attrs: { 'aria-live': 'off' } });
    this.line = el('div', { class: 'gk-serpent__line' });
    this.line.style.height = `${LINE_BASE_PX}px`;
    this.marker = el('div', { class: 'gk-serpent__marker', html: chevronSvg() });
    this.root = el('div', { class: 'gk-serpent', dataset: { status: 'off' } }, [this.line, this.marker, this.banner, this.chip]);
    layer.appendChild(this.root);
    this.lastBanner = 'off';
    this.lastStatus = 'off';
    this.lastMarker = false;
    this.mx = this.my = this.ma = this.lineK = -1e9;
  }

  unmount(): void {
    this.root?.remove();
    this.root = null;
    this.model.onEnd();
  }

  /** Viewport size in CSS px (cheap to call per frame). */
  setViewport(w: number, h: number): void {
    this.w = w;
    this.h = h;
  }

  /** The `serpentWarning` event: show the banner (the marker follows from the snapshot's `serpent` block). */
  onWarning(nowMs: number): void {
    this.model.onWarning(nowMs);
  }

  /** The `serpentEnd` event (also fired when the match ends mid-event): clear everything. */
  onEnd(): void {
    this.model.onEnd();
    if (this.root !== null) this.apply(this.model.frame(0, undefined, { camYaw: 0, player: null }));
  }

  /**
   * One render frame. `spectating` = the local player is dead (banner only). The local fighter is `snapshot.fighters[0]` (the
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
    this.apply(this.model.frame(nowMs, snapshot.serpent, { camYaw, player }));
  }

  /** Paint a view (diffed; exported through {@link update} / {@link onEnd}). */
  private apply(v: SerpentHudView): void {
    if (v.banner !== this.lastBanner) {
      this.lastBanner = v.banner;
      this.banner.classList.toggle('is-hold', v.banner === 'hold');
      this.banner.classList.toggle('is-fade', v.banner === 'fade');
    }
    if (v.status !== this.lastStatus) {
      this.lastStatus = v.status;
      if (this.root !== null) this.root.dataset.status = v.status;
      this.chip.textContent = CHIP_TEXT[v.status];
      this.chip.classList.toggle('is-on', CHIP_TEXT[v.status] !== '');
    }
    if (v.marker !== this.lastMarker) {
      this.lastMarker = v.marker;
      this.marker.classList.toggle('is-on', v.marker);
      this.line.classList.toggle('is-on', v.marker);
    }
    if (!v.marker) return;
    const cx = this.w * 0.5;
    const cy = this.h * 0.5;
    const a = v.markerAngle;
    const x = cx + Math.sin(a) * Math.max(0, cx - SERPENT_EDGE_MARGIN);
    const y = cy - Math.cos(a) * Math.max(0, cy - SERPENT_EDGE_MARGIN);
    if (Math.abs(x - this.mx) > 0.5 || Math.abs(y - this.my) > 0.5 || Math.abs(a - this.ma) > 0.005) {
      this.mx = x;
      this.my = y;
      this.ma = a;
      const t = `translate3d(${x.toFixed(1)}px,${y.toFixed(1)}px,0) rotate(${a.toFixed(3)}rad)`;
      this.marker.style.transform = t;
      this.line.style.transform = `${t} scaleY(${(this.lineLen(v.lineFrac) / LINE_BASE_PX).toFixed(3)})`;
      this.lineK = v.lineFrac;
      return;
    }
    if (Math.abs(v.lineFrac - this.lineK) > 0.01) {
      this.lineK = v.lineFrac;
      this.line.style.transform = `translate3d(${this.mx.toFixed(1)}px,${this.my.toFixed(1)}px,0) rotate(${this.ma.toFixed(3)}rad) scaleY(${(
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
