/**
 * Preview pane (WP-F). Wraps a <canvas> for the 3D gladiator turntable and, when
 * no {@link PreviewFactory} is registered (demo / pre-wiring), swaps in a styled
 * inline-SVG silhouette on a pedestal so the lobby and select screens always show
 * something. See {@link previewHook} for the seam.
 */

import { el } from './dom';
import { animalHeadSvg } from './icons';
import { getPreviewFactory, type PreviewHandle } from './previewHook';
import { ANIMALS } from '../config/animals';
import type { AnimalId } from '../core/types';

export class PreviewPane {
  readonly root: HTMLElement;
  private readonly canvas: HTMLCanvasElement;
  private readonly fallback: HTMLElement;
  private handle: PreviewHandle | null = null;
  private animal: AnimalId;

  constructor(animal: AnimalId, className = 'gk-preview') {
    this.animal = animal;
    this.canvas = el('canvas', { class: 'gk-preview__canvas' });
    this.fallback = el('div', { class: 'gk-preview__fallback' });
    this.root = el('div', { class: className }, [
      this.canvas,
      this.fallback,
      el('div', { class: 'gk-preview__pedestal' }),
    ]);
    this.renderFallback();

    const factory = getPreviewFactory();
    if (factory !== null) {
      try {
        this.handle = factory(this.canvas, animal);
        this.root.classList.add('is-live');
      } catch {
        this.handle = null;
      }
    }
  }

  /** Swap the previewed gladiator (drives the live scene or the SVG fallback). */
  setAnimal(animal: AnimalId): void {
    if (animal === this.animal) return;
    this.animal = animal;
    if (this.handle !== null) this.handle.setAnimal(animal);
    else this.renderFallback();
  }

  /** Release the live scene (no-op for the fallback). */
  dispose(): void {
    this.handle?.dispose();
    this.handle = null;
  }

  private renderFallback(): void {
    const def = ANIMALS[this.animal];
    this.fallback.style.setProperty('--accent', def.accent);
    this.fallback.innerHTML = `
      <div class="gk-preview__glow"></div>
      <div class="gk-preview__silhouette">${animalHeadSvg(this.animal, 'gk-preview__head')}</div>
      <div class="gk-preview__name gk-display">${def.displayName}</div>
      <div class="gk-preview__title">${def.title}</div>`;
  }
}
