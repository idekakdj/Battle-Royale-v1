/**
 * A tiny fake DOM for UI screen tests (the project runs vitest in plain Node, no jsdom). It implements only what
 * `src/ui/dom.ts` and the simple menu screens touch: elements with children / class list / dataset / attributes, event
 * listeners (click, focus, keydown), focus tracking and a `document` with keydown listeners.
 */

type Listener = (e: FakeEvent) => void;

export interface FakeEvent {
  type: string;
  key?: string;
  repeat?: boolean;
  ctrlKey?: boolean;
  metaKey?: boolean;
  altKey?: boolean;
  target: unknown;
  defaultPrevented: boolean;
  preventDefault(): void;
}

class FakeClassList {
  constructor(private readonly owner: FakeElement) {}
  private names(): string[] {
    return this.owner.className.split(/\s+/).filter((n) => n.length > 0);
  }
  contains(name: string): boolean {
    return this.names().includes(name);
  }
  toggle(name: string, force?: boolean): boolean {
    const has = this.contains(name);
    const on = force ?? !has;
    if (on && !has) this.owner.className = [...this.names(), name].join(' ');
    else if (!on && has) this.owner.className = this.names().filter((n) => n !== name).join(' ');
    return on;
  }
}

export class FakeElement {
  className = '';
  id = '';
  title = '';
  textContent = '';
  innerHTML = '';
  tabIndex = 0;
  readonly children: FakeElement[] = [];
  readonly dataset: Record<string, string> = {};
  readonly attributes = new Map<string, string>();
  readonly style = { setProperty: (_k: string, _v: string): void => undefined };
  readonly classList = new FakeClassList(this);
  parent: FakeElement | null = null;
  private readonly listeners = new Map<string, Listener[]>();

  constructor(
    readonly tagName: string,
    private readonly doc: FakeDocument,
  ) {}

  get firstChild(): FakeElement | null {
    return this.children[0] ?? null;
  }
  appendChild(child: FakeElement): FakeElement {
    child.parent = this;
    this.children.push(child);
    return child;
  }
  removeChild(child: FakeElement): FakeElement {
    const i = this.children.indexOf(child);
    if (i >= 0) this.children.splice(i, 1);
    child.parent = null;
    return child;
  }
  remove(): void {
    this.parent?.removeChild(this);
  }
  setAttribute(name: string, value: string): void {
    this.attributes.set(name, value);
  }
  addEventListener(type: string, fn: Listener): void {
    const list = this.listeners.get(type) ?? [];
    list.push(fn);
    this.listeners.set(type, list);
  }
  dispatch(type: string, init: Partial<FakeEvent> = {}): FakeEvent {
    const ev: FakeEvent = {
      type,
      target: this,
      defaultPrevented: false,
      preventDefault() {
        this.defaultPrevented = true;
      },
      ...init,
    };
    for (const fn of this.listeners.get(type) ?? []) fn(ev);
    return ev;
  }
  click(): void {
    this.dispatch('click');
  }
  focus(_opts?: unknown): void {
    if (this.doc.activeElement === this) return;
    this.doc.activeElement = this;
    this.dispatch('focus');
  }
  /** All descendants (depth first) matching a predicate. */
  find(pred: (e: FakeElement) => boolean): FakeElement[] {
    const out: FakeElement[] = [];
    const walk = (e: FakeElement): void => {
      for (const c of e.children) {
        if (pred(c)) out.push(c);
        walk(c);
      }
    };
    walk(this);
    return out;
  }
}

export class FakeDocument {
  activeElement: FakeElement | null = null;
  readonly body: FakeElement = new FakeElement('body', this);
  private readonly listeners = new Map<string, Listener[]>();

  createElement(tag: string): FakeElement {
    return new FakeElement(tag, this);
  }
  createTextNode(text: string): FakeElement {
    const n = new FakeElement('#text', this);
    n.textContent = text;
    return n;
  }
  addEventListener(type: string, fn: Listener, _capture?: boolean): void {
    const list = this.listeners.get(type) ?? [];
    list.push(fn);
    this.listeners.set(type, list);
  }
  removeEventListener(type: string, fn: Listener, _capture?: boolean): void {
    this.listeners.set(
      type,
      (this.listeners.get(type) ?? []).filter((l) => l !== fn),
    );
  }
  listenerCount(type: string): number {
    return (this.listeners.get(type) ?? []).length;
  }
  /** Fire a document-level key event as if the browser dispatched it at `target` (default: the focused element, else body). */
  key(key: string, init: Partial<FakeEvent> = {}): FakeEvent {
    const ev: FakeEvent = {
      type: 'keydown',
      key,
      target: this.activeElement ?? this.body,
      defaultPrevented: false,
      preventDefault() {
        this.defaultPrevented = true;
      },
      ...init,
    };
    for (const fn of this.listeners.get('keydown') ?? []) fn(ev);
    return ev;
  }
}
