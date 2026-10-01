/**
 * Screen overlay for the first-person ultimate director (v1.3 Phase-3c): an edge-darkening VIGNETTE (shadow melt,
 * blink flick, dirt at the mole's edges) and a short full-screen FLASH (panther execute). Two pointer-less divs
 * in the HUD layer; opacity is only touched when it changes noticeably.
 */

import type { UltCamOut } from './ultCam';

export class UltOverlay {
  private vig: HTMLDivElement | null = null;
  private flash: HTMLDivElement | null = null;
  private lastVig = -1;
  private lastFlash = -1;

  mount(layer: HTMLElement): void {
    if (this.vig !== null) return;
    const vig = document.createElement('div');
    vig.className = 'gk-fp-ultvig';
    vig.setAttribute('aria-hidden', 'true');
    const flash = document.createElement('div');
    flash.className = 'gk-fp-ultflash';
    flash.setAttribute('aria-hidden', 'true');
    layer.appendChild(vig);
    layer.appendChild(flash);
    this.vig = vig;
    this.flash = flash;
  }

  update(out: UltCamOut): void {
    if (this.vig === null || this.flash === null) return;
    const v = out.vignette;
    if (Math.abs(v - this.lastVig) > 0.01 || (v === 0 && this.lastVig !== 0)) {
      this.lastVig = v;
      this.vig.style.opacity = v.toFixed(3);
    }
    const f = out.flash;
    if (Math.abs(f - this.lastFlash) > 0.01 || (f === 0 && this.lastFlash !== 0)) {
      this.lastFlash = f;
      this.flash.style.opacity = f.toFixed(3);
    }
  }

  dispose(): void {
    this.vig?.remove();
    this.flash?.remove();
    this.vig = null;
    this.flash = null;
  }
}
