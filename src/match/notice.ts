/**
 * A small, unobtrusive one-line notice in the HUD layer (v1.10.1, WP-L2) - used for "Lowered graphics to keep the game smooth".
 * Inline-styled on purpose (no stylesheet edit), `pointer-events: none`, fades in/out, removes itself, replaced by the next one.
 */

export const NOTICE_CLASS = 'gk-match-notice';
export const NOTICE_MS = 5000;

export interface NoticeHandle {
  /** Remove it now. */
  dismiss(): void;
}

export function showMatchNotice(layer: HTMLElement, text: string, ms: number = NOTICE_MS): NoticeHandle {
  for (const old of Array.from(layer.querySelectorAll(`.${NOTICE_CLASS}`))) old.remove();
  const el = document.createElement('div');
  el.className = NOTICE_CLASS;
  el.setAttribute('role', 'status');
  el.setAttribute('aria-live', 'polite');
  el.textContent = text;
  const s = el.style;
  s.position = 'absolute';
  s.left = '50%';
  s.bottom = '18%';
  s.transform = 'translateX(-50%)';
  s.maxWidth = '80%';
  s.padding = '6px 14px';
  s.borderRadius = '6px';
  s.background = 'rgba(20, 17, 13, 0.78)';
  s.border = '1px solid rgba(240, 208, 130, 0.35)';
  s.color = '#f0e6d2';
  s.font = '600 13px/1.3 system-ui, sans-serif';
  s.letterSpacing = '0.02em';
  s.pointerEvents = 'none';
  s.opacity = '0';
  s.transition = 'opacity 0.35s ease';
  s.zIndex = '30';
  layer.appendChild(el);
  // Next frame so the fade-in transition runs.
  const raf = typeof requestAnimationFrame === 'function' ? requestAnimationFrame : (cb: () => void): number => window.setTimeout(cb, 16);
  raf(() => {
    s.opacity = '1';
  });
  let hideTimer: number | null = window.setTimeout(() => {
    s.opacity = '0';
    hideTimer = window.setTimeout(() => el.remove(), 450);
  }, ms);
  return {
    dismiss(): void {
      if (hideTimer !== null) window.clearTimeout(hideTimer);
      hideTimer = null;
      el.remove();
    },
  };
}
