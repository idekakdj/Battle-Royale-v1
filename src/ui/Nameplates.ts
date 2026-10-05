/**
 * Enemy nameplates + lock-on reticle (WP-M, §6.2). DOM-only and dumb: the
 * match layer projects world positions and calls {@link Nameplates.place} /
 * {@link Nameplates.hide} per slot each frame. Cheap by construction:
 *  - a fixed pool (max 9 plates) built once in `mount`, never re-created;
 *  - every per-frame change is a `transform` / `opacity` write, and only when
 *    the value actually moved (sub-pixel jitter is ignored);
 *  - no DOM reads at all (the caller passes screen coordinates in CSS px).
 */

import type { AnimalId } from '../core/types';
import { ANIMALS } from '../config/animals';
import { el } from './dom';

export const MAX_PLATES = 9;
const GUARD_FLASH_MS = 450;

interface Plate {
  root: HTMLElement;
  fill: HTMLElement;
  chip: HTMLElement;
  name: HTMLElement;
  shown: boolean;
  x: number;
  y: number;
  s: number;
  o: number;
  hp: number;
  locked: boolean;
  gbUntil: number;
  gbOn: boolean;
}

export class Nameplates {
  private layer: HTMLElement | null = null;
  private readonly plates: Plate[] = [];
  private reticle: HTMLElement | null = null;
  private reticleShown = false;
  private rx = -1;
  private ry = -1;
  private rs = -1;

  /** Build the pool inside the HUD layer (pointer-transparent). */
  mount(layer: HTMLElement): void {
    this.unmount();
    const root = el('div', { class: 'gk-np-layer' });
    for (let i = 0; i < MAX_PLATES; i++) {
      const name = el('span', { class: 'gk-np__name gk-display' });
      const chip = el('span', { class: 'gk-np__chip' });
      const fill = el('span', { class: 'gk-np__fill' });
      const plateRoot = el('div', { class: 'gk-np is-hidden' }, [
        el('div', { class: 'gk-np__inner' }, [name, el('span', { class: 'gk-np__bar' }, [chip, fill])]),
      ]);
      root.appendChild(plateRoot);
      this.plates.push({
        root: plateRoot,
        fill,
        chip,
        name,
        shown: false,
        x: -1e9,
        y: -1e9,
        s: -1e9,
        o: -1e9,
        hp: -1,
        locked: false,
        gbUntil: 0,
        gbOn: false,
      });
    }
    this.reticle = el('div', { class: 'gk-reticle is-hidden', html: reticleSvg() });
    root.appendChild(this.reticle);
    this.reticleShown = false;
    layer.prepend(root);
    this.layer = root;
  }

  unmount(): void {
    this.layer?.remove();
    this.layer = null;
    this.plates.length = 0;
    this.reticle = null;
  }

  /** Label a slot with its fighter's animal (call once per match per slot). */
  setAnimal(slot: number, animal: AnimalId): void {
    const p = this.plates[slot];
    if (p === undefined) return;
    const def = ANIMALS[animal];
    p.name.textContent = def.displayName;
    p.root.style.setProperty('--np-accent', def.accent);
  }

  /** v1.5 online: label a slot with a human player's chosen name instead of the animal's (call after {@link setAnimal}). */
  setName(slot: number, name: string): void {
    const p = this.plates[slot];
    if (p !== undefined) p.name.textContent = name;
  }

  /** Brief guard-break flash on a slot's plate. */
  flashGuardBreak(slot: number, nowMs: number): void {
    const p = this.plates[slot];
    if (p !== undefined) p.gbUntil = nowMs + GUARD_FLASH_MS;
  }

  /**
   * Position a plate with its bottom-center at (x, y) CSS px. `scale` shrinks
   * distant plates, `opacity` fades them, `hpFrac` is 0..1.
   */
  place(slot: number, x: number, y: number, scale: number, opacity: number, hpFrac: number, locked: boolean, nowMs: number): void {
    const p = this.plates[slot];
    if (p === undefined) return;
    if (!p.shown) {
      p.shown = true;
      p.root.classList.remove('is-hidden');
    }
    if (Math.abs(x - p.x) > 0.25 || Math.abs(y - p.y) > 0.25 || Math.abs(scale - p.s) > 0.004) {
      p.x = x;
      p.y = y;
      p.s = scale;
      p.root.style.transform = `translate3d(${x.toFixed(1)}px,${y.toFixed(1)}px,0) scale(${scale.toFixed(3)})`;
    }
    if (Math.abs(opacity - p.o) > 0.02) {
      p.o = opacity;
      p.root.style.opacity = opacity.toFixed(2);
    }
    const hp = Math.round(hpFrac * 200) / 200;
    if (hp !== p.hp) {
      p.hp = hp;
      p.fill.style.transform = `scaleX(${hp})`;
      p.chip.style.transform = `scaleX(${hp})`;
      p.root.classList.toggle('is-low', hp < 0.3);
    }
    if (locked !== p.locked) {
      p.locked = locked;
      p.root.classList.toggle('is-locked', locked);
    }
    const gb = nowMs < p.gbUntil;
    if (gb !== p.gbOn) {
      p.gbOn = gb;
      p.root.classList.toggle('is-guardbreak', gb);
    }
  }

  hide(slot: number): void {
    const p = this.plates[slot];
    if (p === undefined || !p.shown) return;
    p.shown = false;
    p.root.classList.add('is-hidden');
    if (p.locked) {
      p.locked = false;
      p.root.classList.remove('is-locked');
    }
  }

  /** Lock-on reticle centered at (x, y) CSS px. */
  placeReticle(x: number, y: number, scale: number): void {
    const r = this.reticle;
    if (r === null) return;
    if (!this.reticleShown) {
      this.reticleShown = true;
      r.classList.remove('is-hidden');
    }
    if (Math.abs(x - this.rx) > 0.25 || Math.abs(y - this.ry) > 0.25 || Math.abs(scale - this.rs) > 0.004) {
      this.rx = x;
      this.ry = y;
      this.rs = scale;
      r.style.transform = `translate3d(${x.toFixed(1)}px,${y.toFixed(1)}px,0) scale(${scale.toFixed(3)})`;
    }
  }

  hideReticle(): void {
    if (this.reticle === null || !this.reticleShown) return;
    this.reticleShown = false;
    this.reticle.classList.add('is-hidden');
  }
}

function reticleSvg(): string {
  return `<svg class="gk-reticle__svg" viewBox="-30 -30 60 60" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
    <circle r="17" fill="none" stroke="currentColor" stroke-width="1.6" stroke-dasharray="6 4.7" opacity="0.85"/>
    <path d="M0 -27 V-20 M0 27 V20 M-27 0 H-20 M27 0 H20" stroke="currentColor" stroke-width="2.6" stroke-linecap="round"/>
    <circle r="2.2" fill="currentColor"/>
  </svg>`;
}
