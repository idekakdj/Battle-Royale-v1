/**
 * Version History / What's New panel (WP-L, UPGRADE-PLAN §5.4).
 *
 * A modal overlay listing every CHANGELOG.md entry newest-first: version,
 * date, a "Current" badge on the running version, and grouped
 * Added/Changed/Fixed bullets. Scrollable; closes on Esc, the close button or
 * a backdrop click; focus is trapped inside while open and restored after.
 *
 * Opened from the lobby footer ("What's New"), and automatically once after
 * an update (see src/version/whatsNew.ts). Pure DOM — changelog text is only
 * ever assigned via textContent, never parsed as HTML.
 */

import { el, button } from './dom';
import { type ChangelogEntry, entryItemCount, inlineSegments } from '../version';

/** Every past release stays downloadable here (GitHub Releases). */
export const RELEASES_URL = 'https://github.com/idekakdj/Battle-Royale-v1/releases';

export interface VersionPanelOptions {
  /** Changelog entries, newest first (Unreleased, if present, on top). */
  entries: readonly ChangelogEntry[];
  /** The running version (`1.0.0`), badged as "Current". */
  currentVersion: string;
  /** Title variant: true → "What's New" (auto-open after an update). */
  whatsNew?: boolean;
  /** Called once after the panel closes (any route). */
  onClose?: () => void;
}

const FOCUSABLE = 'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])';

function formatDate(iso: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  if (m === null) return iso;
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  try {
    return d.toLocaleDateString(undefined, { timeZone: 'UTC', day: 'numeric', month: 'short', year: 'numeric' });
  } catch {
    return iso;
  }
}

function sectionModifier(title: string): string {
  const t = title.toLowerCase();
  if (t === 'added' || t === 'changed' || t === 'fixed' || t === 'removed' || t === 'security') return ` is-${t}`;
  return '';
}

function itemNode(text: string): HTMLLIElement {
  const li = el('li', { class: 'gk-vp__item' });
  for (const seg of inlineSegments(text)) {
    if (seg.kind === 'strong') li.appendChild(el('strong', { text: seg.text }));
    else if (seg.kind === 'code') li.appendChild(el('code', { text: seg.text }));
    else li.appendChild(document.createTextNode(seg.text));
  }
  return li;
}

export class VersionPanel {
  private readonly opts: VersionPanelOptions;
  private root: HTMLElement | null = null;
  private panel: HTMLElement | null = null;
  private restoreFocus: HTMLElement | null = null;

  constructor(opts: VersionPanelOptions) {
    this.opts = opts;
  }

  get isOpen(): boolean {
    return this.root !== null;
  }

  /** Mount the overlay into `host` (the lobby root) and focus it. */
  open(host: HTMLElement): void {
    if (this.root !== null) return;
    this.restoreFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;

    const titleId = 'gk-vp-title';
    const closeBtn = button('×', 'gk-vp__close', () => this.close(), {
      attrs: { 'aria-label': 'Close version history' },
      title: 'Close (Esc)',
    });

    const list = el('div', { class: 'gk-vp__list', attrs: { tabindex: '0', 'aria-label': 'Releases' } });
    const shown = this.opts.entries.filter((e) => !e.unreleased || entryItemCount(e) > 0);
    if (shown.length === 0) {
      list.appendChild(el('p', { class: 'gk-vp__empty', text: 'No release notes available.' }));
    }
    for (const entry of shown) list.appendChild(this.entryNode(entry));

    const footer = el('footer', { class: 'gk-vp__footer' }, [
      el('span', { class: 'gk-vp__hint', text: 'Esc to close' }),
      el('a', {
        class: 'gk-vp__link',
        text: 'All releases & downloads',
        attrs: { href: RELEASES_URL, target: '_blank', rel: 'noopener noreferrer' },
      }),
    ]);

    this.panel = el('section', { class: 'gk-vp__panel' }, [
      el('header', { class: 'gk-vp__header' }, [
        el('div', { class: 'gk-vp__heading' }, [
          el('h2', {
            class: 'gk-vp__title gk-display',
            id: titleId,
            text: this.opts.whatsNew === true ? "What's New" : 'Version History',
          }),
          el('span', { class: 'gk-vp__subtitle', text: `Gladiator Kingdom · v${this.opts.currentVersion}` }),
        ]),
        closeBtn,
      ]),
      list,
      footer,
    ]);

    const backdrop = el('div', { class: 'gk-vp__backdrop' });
    backdrop.addEventListener('click', () => this.close());

    this.root = el(
      'div',
      { class: 'gk-vp', attrs: { role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': titleId } },
      [backdrop, this.panel],
    );
    host.appendChild(this.root);
    window.addEventListener('keydown', this.onKeyDown, true);
    closeBtn.focus({ preventScroll: true });
  }

  /** Remove the overlay (idempotent). */
  close(): void {
    if (this.root === null) return;
    window.removeEventListener('keydown', this.onKeyDown, true);
    this.root.remove();
    this.root = null;
    this.panel = null;
    const back = this.restoreFocus;
    this.restoreFocus = null;
    if (back !== null && back.isConnected) back.focus({ preventScroll: true });
    this.opts.onClose?.();
  }

  private entryNode(entry: ChangelogEntry): HTMLElement {
    const isCurrent = !entry.unreleased && entry.version === this.opts.currentVersion;
    const head = el('header', { class: 'gk-vp__entry-head' }, [
      el('h3', { class: 'gk-vp__version gk-display', text: entry.unreleased ? 'Unreleased' : `v${entry.version}` }),
      isCurrent ? el('span', { class: 'gk-vp__badge', text: 'Current' }) : null,
      entry.unreleased ? el('span', { class: 'gk-vp__badge gk-vp__badge--upcoming', text: 'In development' }) : null,
      entry.date !== null
        ? el('time', { class: 'gk-vp__date', text: formatDate(entry.date), attrs: { datetime: entry.date } })
        : null,
    ]);
    const sections = entry.sections.map((s) =>
      el('div', { class: 'gk-vp__section' }, [
        el('h4', { class: `gk-vp__section-title${sectionModifier(s.title)}`, text: s.title }),
        el('ul', { class: 'gk-vp__items' }, s.items.map(itemNode)),
      ]),
    );
    return el('article', { class: `gk-vp__entry${isCurrent ? ' is-current' : ''}` }, [head, ...sections]);
  }

  private readonly onKeyDown = (e: KeyboardEvent): void => {
    if (this.root === null) return;
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      this.close();
      return;
    }
    if (e.key === 'Tab' && this.panel !== null) {
      // Keep keyboard focus inside the dialog.
      const items = Array.from(this.panel.querySelectorAll<HTMLElement>(FOCUSABLE));
      if (items.length === 0) return;
      const first = items[0] as HTMLElement;
      const last = items[items.length - 1] as HTMLElement;
      const active = document.activeElement;
      if (e.shiftKey && (active === first || !this.panel.contains(active))) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && (active === last || !this.panel.contains(active))) {
        e.preventDefault();
        first.focus();
      }
    }
  };
}
