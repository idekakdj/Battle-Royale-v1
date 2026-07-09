/**
 * Tiny DOM construction helpers (WP-F, UI only).
 *
 * Keeps the screen modules terse without pulling in a framework. All UI is plain
 * DOM/CSS layered over the WebGL canvas (BLUEPRINT §12). No allocation concerns
 * here — screens mount/unmount rarely, not per sim tick.
 */

/** Anything that can be appended as a child; falsy values are skipped. */
export type Child = Node | string | number | null | undefined | false;

export interface ElOptions {
  class?: string;
  id?: string;
  text?: string;
  /** Raw inner HTML (used for trusted inline SVG icons only). */
  html?: string;
  title?: string;
  /** For <button>/<input>: the `type` attribute. */
  type?: string;
  attrs?: Record<string, string | number | boolean>;
  dataset?: Record<string, string>;
}

/** Create an element with options and children in one call. */
export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  opts: ElOptions = {},
  children: readonly Child[] = [],
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (opts.class !== undefined) node.className = opts.class;
  if (opts.id !== undefined) node.id = opts.id;
  if (opts.text !== undefined) node.textContent = opts.text;
  if (opts.html !== undefined) node.innerHTML = opts.html;
  if (opts.title !== undefined) node.title = opts.title;
  if (opts.type !== undefined) node.setAttribute('type', opts.type);
  if (opts.attrs !== undefined) {
    for (const [k, v] of Object.entries(opts.attrs)) node.setAttribute(k, String(v));
  }
  if (opts.dataset !== undefined) {
    for (const [k, v] of Object.entries(opts.dataset)) node.dataset[k] = v;
  }
  append(node, children);
  return node;
}

/** Append a list of children, skipping falsy entries. */
export function append(parent: Node, children: readonly Child[]): void {
  for (const c of children) {
    if (c === null || c === undefined || c === false) continue;
    parent.appendChild(typeof c === 'string' || typeof c === 'number' ? document.createTextNode(String(c)) : c);
  }
}

/** Convenience button factory with a click handler. */
export function button(label: string, className: string, onClick: () => void, extra?: ElOptions): HTMLButtonElement {
  const b = el('button', { ...extra, class: className, type: 'button', text: label });
  b.addEventListener('click', onClick);
  return b;
}

/** Remove every child of `node`. */
export function clear(node: Node): void {
  while (node.firstChild !== null) node.removeChild(node.firstChild);
}
