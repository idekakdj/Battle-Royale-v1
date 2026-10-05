/**
 * Online UI (WP-N4) — small DOM building blocks shared by the Online and Room screens: segmented controls (reusing the
 * Champions League setup look), a confirm dialog, toasts, ping bars and a spinner.
 */

import { el, clear, button } from '../../ui/dom';
import type { PingInfo } from './helpers';

// ── segmented control ─────────────────────────────────────────────────────────

export interface SegItem {
  key: string;
  label: string;
  sub?: string;
}

export interface Segment {
  root: HTMLElement;
  buttons: Map<string, HTMLButtonElement>;
  set(key: string): void;
}

export interface SegmentOptions {
  /** Used for aria-label and the `data-ctl` ids (`<id>:<key>`) that let a screen restore focus after a rebuild. */
  id: string;
  label: string;
  items: readonly SegItem[];
  value: string;
  disabled?: boolean;
  onPick: (key: string) => void;
}

/** A radio-style row of buttons (`gk-bs__seg`): roving tabindex, Left/Right moves and picks, disabled when read-only. */
export function segmented(opts: SegmentOptions): Segment {
  const track = el('div', { class: 'gk-bs__seg gk-on-seg', attrs: { role: 'radiogroup', 'aria-label': opts.label } });
  const buttons = new Map<string, HTMLButtonElement>();
  const list: HTMLButtonElement[] = [];
  for (const it of opts.items) {
    const b = el('button', {
      class: 'gk-bs__segbtn',
      type: 'button',
      dataset: { key: it.key, ctl: `${opts.id}:${it.key}` },
      attrs: { role: 'radio', 'aria-checked': 'false', tabindex: '-1' },
    });
    b.innerHTML = `<span class="gk-bs__seg-main gk-display"></span>${it.sub !== undefined ? '<span class="gk-bs__seg-sub"></span>' : ''}`;
    (b.querySelector('.gk-bs__seg-main') as HTMLElement).textContent = it.label;
    if (it.sub !== undefined) (b.querySelector('.gk-bs__seg-sub') as HTMLElement).textContent = it.sub;
    b.disabled = opts.disabled === true;
    b.addEventListener('click', () => {
      if (b.disabled) return;
      opts.onPick(it.key);
    });
    buttons.set(it.key, b);
    list.push(b);
    track.appendChild(b);
  }
  track.addEventListener('keydown', (e) => {
    if (opts.disabled === true || (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight')) return;
    const i = list.indexOf(e.target as HTMLButtonElement);
    if (i < 0) return;
    e.preventDefault();
    e.stopPropagation();
    const n = list.length;
    const j = e.key === 'ArrowLeft' ? (i + n - 1) % n : (i + 1) % n;
    list[j].focus({ preventScroll: true });
    list[j].click();
  });
  const set = (key: string): void => {
    let any = false;
    for (const [k, b] of buttons) {
      const on = k === key;
      any = any || on;
      b.classList.toggle('is-selected', on);
      b.setAttribute('aria-checked', on ? 'true' : 'false');
      b.tabIndex = on ? 0 : -1;
    }
    if (!any && list.length > 0) list[0].tabIndex = 0;
  };
  set(opts.value);
  return { root: track, buttons, set };
}

// ── ping bars / spinner ───────────────────────────────────────────────────────

/** Four signal bars (lit count + colour from the ping quality) with the milliseconds beside them. */
export function pingEl(info: PingInfo, showText = true): HTMLElement {
  const bars = el('span', { class: 'gk-on-bars', attrs: { 'aria-hidden': 'true' } });
  for (let i = 1; i <= 4; i++) bars.appendChild(el('i', { class: i <= info.bars ? 'is-on' : '' }));
  return el(
    'span',
    { class: 'gk-on-ping', dataset: { quality: info.quality }, title: info.quality === 'unknown' ? 'Ping not measured yet' : `Round trip to the host: ${info.text}`, attrs: { 'aria-label': `Ping ${info.text}` } },
    [bars, showText ? el('span', { class: 'gk-on-ping__ms', text: info.text }) : null],
  );
}

export function spinner(): HTMLElement {
  return el('span', { class: 'gk-on-spinner', attrs: { 'aria-hidden': 'true' } });
}

// ── confirm dialog ────────────────────────────────────────────────────────────

export interface ConfirmOptions {
  title: string;
  message: string;
  confirmLabel: string;
  cancelLabel?: string;
  /** Red confirm button (leaving / removing). */
  danger?: boolean;
  onConfirm: () => void;
  onCancel?: () => void;
}

export interface ConfirmHandle {
  close(): void;
  /** Esc: same as pressing the cancel button. */
  cancel(): void;
}

/** A small modal inside `host`: focus starts on "cancel" (the safe choice), Tab stays inside, Esc cancels (via {@link ConfirmHandle.cancel}). */
export function confirmDialog(host: HTMLElement, opts: ConfirmOptions): ConfirmHandle {
  const previous = document.activeElement as HTMLElement | null;
  let closed = false;
  const close = (): void => {
    if (closed) return;
    closed = true;
    overlay.remove();
    if (previous !== null && previous.isConnected) previous.focus({ preventScroll: true });
  };
  const cancelBtn = button(opts.cancelLabel ?? 'Stay', 'gk-bs__back gk-display gk-on-btn', () => {
    close();
    opts.onCancel?.();
  });
  const okBtn = button(opts.confirmLabel, `gk-bs__back gk-display gk-on-btn${opts.danger === true ? ' gk-on-btn--danger' : ' gk-on-btn--gold'}`, () => {
    close();
    opts.onConfirm();
  });
  const panel = el('div', { class: 'gk-on-dialog', attrs: { role: 'alertdialog', 'aria-modal': 'true', 'aria-label': opts.title } }, [
    el('h2', { class: 'gk-on-dialog__title gk-display', text: opts.title }),
    el('p', { class: 'gk-on-dialog__msg', text: opts.message }),
    el('div', { class: 'gk-on-dialog__actions' }, [cancelBtn, okBtn]),
  ]);
  const overlay = el('div', { class: 'gk-on-modal' }, [panel]);
  panel.addEventListener('keydown', (e) => {
    if (e.key !== 'Tab') return;
    const first = cancelBtn;
    const last = okBtn;
    if (e.shiftKey && document.activeElement === first) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault();
      first.focus();
    }
  });
  host.appendChild(overlay);
  cancelBtn.focus({ preventScroll: true });
  return {
    close,
    cancel: () => {
      close();
      opts.onCancel?.();
    },
  };
}

// ── toasts ────────────────────────────────────────────────────────────────────

export type ToastKind = 'info' | 'error' | 'ok';

/** A stack of short-lived messages at the top of a screen (`aria-live`). */
export class ToastStack {
  readonly root: HTMLElement;
  private readonly timers = new Set<number>();

  constructor() {
    this.root = el('div', { class: 'gk-on-toasts', attrs: { 'aria-live': 'polite', role: 'status' } });
  }

  push(text: string, kind: ToastKind = 'info', ms = 6500): void {
    while (this.root.childElementCount >= 3) this.root.firstElementChild?.remove();
    const t = el('div', { class: `gk-on-toast is-${kind}`, text });
    this.root.appendChild(t);
    const id = window.setTimeout(() => {
      this.timers.delete(id);
      t.remove();
    }, ms);
    this.timers.add(id);
  }

  clear(): void {
    for (const id of this.timers) window.clearTimeout(id);
    this.timers.clear();
    clear(this.root);
  }
}
