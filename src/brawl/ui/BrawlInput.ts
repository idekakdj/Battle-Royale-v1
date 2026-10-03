/**
 * Champions League — keyboard / mouse (+ optional gamepad) reader (plan §8). Implements
 * {@link BrawlInputApi}: `poll()` returns the current {@link BrawlIntent}; the edge fields
 * (jump / light / heavy / dodge) are true for exactly one poll after the button goes down (a tap that is
 * pressed and released between two polls still registers).
 *
 *   move  A / D / ← / →        jump  W / ↑ / Space (edge + held)   down  S / ↓
 *   light J or left mouse      heavy K or right mouse               dodge L or Shift
 *   pause Esc (callback)       debug boxes F3 (callback)
 *
 * No pointer lock in this mode. Held state is released on window blur / tab hide; the context menu is
 * suppressed so the right mouse button is a normal heavy attack.
 *
 * The raw entry points (`keyDown`, `keyUp`, `mouseDown`, `mouseUp`, `releaseAll`) are public so tests (and the
 * DOM listeners below) drive exactly the same code without a DOM.
 */

import type { BrawlInputApi, BrawlIntent } from '../types';

type Action = 'left' | 'right' | 'up' | 'down' | 'jump' | 'light' | 'heavy' | 'dodge';

/** Physical key (`KeyboardEvent.code`) / pseudo mouse code → actions it triggers. */
const BINDINGS: Readonly<Record<string, readonly Action[]>> = {
  KeyA: ['left'],
  ArrowLeft: ['left'],
  KeyD: ['right'],
  ArrowRight: ['right'],
  KeyW: ['up', 'jump'],
  ArrowUp: ['up', 'jump'],
  Space: ['jump'],
  KeyS: ['down'],
  ArrowDown: ['down'],
  KeyJ: ['light'],
  Mouse0: ['light'],
  KeyK: ['heavy'],
  Mouse2: ['heavy'],
  KeyL: ['dodge'],
  ShiftLeft: ['dodge'],
  ShiftRight: ['dodge'],
};

/** Keys the game consumes (preventDefault while enabled so Space/arrows never scroll or click a focused button). */
const GAME_CODES = new Set(Object.keys(BINDINGS).filter((c) => !c.startsWith('Mouse')));

/** Minimal structural view of a Gamepad (standard mapping) so tests need no DOM. */
export interface GamepadLike {
  connected: boolean;
  axes: readonly number[];
  buttons: readonly { pressed: boolean }[];
  mapping?: string;
}

export interface PadState {
  moveX: number;
  moveY: number;
  jump: boolean;
  light: boolean;
  heavy: boolean;
  dodge: boolean;
  pause: boolean;
}

const PAD_DEADZONE = 0.28;

/** Standard-mapping gamepad → one frame of intent (A/Y/↑ jump, X light, B heavy, bumpers/triggers dodge, Start pause). */
export function readPad(pad: GamepadLike | null | undefined): PadState | null {
  if (pad === null || pad === undefined || !pad.connected) return null;
  const b = (i: number): boolean => pad.buttons[i]?.pressed === true;
  let x = pad.axes[0] ?? 0;
  let y = -(pad.axes[1] ?? 0);
  if (Math.abs(x) < PAD_DEADZONE) x = 0;
  if (Math.abs(y) < PAD_DEADZONE) y = 0;
  if (b(14)) x = -1;
  if (b(15)) x = 1;
  if (b(12)) y = 1;
  if (b(13)) y = -1;
  return {
    moveX: Math.max(-1, Math.min(1, x)),
    moveY: Math.max(-1, Math.min(1, y)),
    jump: b(0) || b(3),
    light: b(2),
    heavy: b(1),
    dodge: b(4) || b(5) || b(6) || b(7),
    pause: b(9),
  };
}

export interface BrawlInputOptions {
  /** Esc (or gamepad Start) pressed. Fires even while the gameplay input is disabled (toggles the pause menu). */
  onPause?: () => void;
  /** F3 pressed. */
  onToggleDebug?: () => void;
  /** Where key events come from (default: `window`). Pass `null` for none (tests). */
  keyTarget?: EventTarget | null;
  /** Where mouse-down events come from (the game canvas). `null` = no mouse input. */
  mouseTarget?: EventTarget | null;
  /** Gamepad source (default: `navigator.getGamepads`). Pass `null` to disable gamepads. */
  gamepads?: (() => ArrayLike<GamepadLike | null>) | null;
}

export class BrawlInput implements BrawlInputApi {
  private readonly onPause: (() => void) | undefined;
  private readonly onToggleDebug: (() => void) | undefined;
  private readonly keyTarget: EventTarget | null;
  private readonly mouseTarget: EventTarget | null;
  private readonly gamepads: (() => ArrayLike<GamepadLike | null>) | null;

  private enabled = true;
  private disposed = false;
  /** Held codes (keys + Mouse0 / Mouse2). */
  private readonly held = new Set<string>();
  private pendJump = false;
  private pendLight = false;
  private pendHeavy = false;
  private pendDodge = false;
  private prevPad: PadState | null = null;

  private readonly listeners: Array<[EventTarget, string, EventListener, boolean | undefined]> = [];

  constructor(opts: BrawlInputOptions = {}) {
    this.onPause = opts.onPause;
    this.onToggleDebug = opts.onToggleDebug;
    this.keyTarget = opts.keyTarget === undefined ? (typeof window !== 'undefined' ? window : null) : opts.keyTarget;
    this.mouseTarget = opts.mouseTarget ?? null;
    this.gamepads =
      opts.gamepads === undefined
        ? typeof navigator !== 'undefined' && typeof navigator.getGamepads === 'function'
          ? () => navigator.getGamepads()
          : null
        : opts.gamepads;

    if (this.keyTarget !== null) {
      this.listen(this.keyTarget, 'keydown', (e) => this.onKeyDown(e as KeyboardEvent));
      this.listen(this.keyTarget, 'keyup', (e) => this.keyUp((e as KeyboardEvent).code));
      this.listen(this.keyTarget, 'blur', () => this.releaseAll());
      this.listen(this.keyTarget, 'contextmenu', (e) => {
        if (this.enabled) e.preventDefault();
      });
      // Releasing the mouse outside the canvas must still release the attack.
      this.listen(this.keyTarget, 'mouseup', (e) => this.mouseUp((e as MouseEvent).button));
    }
    if (this.mouseTarget !== null) {
      this.listen(this.mouseTarget, 'mousedown', (e) => {
        const me = e as MouseEvent;
        if (this.mouseDown(me.button)) e.preventDefault();
      });
      this.listen(this.mouseTarget, 'contextmenu', (e) => e.preventDefault());
    }
    if (typeof document !== 'undefined') {
      this.listen(document, 'visibilitychange', () => {
        if (document.hidden) this.releaseAll();
      });
    }
  }

  // ── BrawlInputApi ──────────────────────────────────────────────────────────

  poll(): BrawlIntent {
    const prev = this.prevPad;
    const pad = this.enabled ? this.readGamepad() : null;
    let moveX = 0;
    let moveY = 0;
    let jump = this.pendJump;
    let light = this.pendLight;
    let heavy = this.pendHeavy;
    let dodge = this.pendDodge;
    this.pendJump = this.pendLight = this.pendHeavy = this.pendDodge = false;

    if (!this.enabled) return { moveX: 0, moveY: 0, jump: false, jumpHeld: false, light: false, heavy: false, dodge: false };

    if (this.isHeld('right')) moveX += 1;
    if (this.isHeld('left')) moveX -= 1;
    if (this.isHeld('up')) moveY += 1;
    if (this.isHeld('down')) moveY -= 1;
    let jumpHeld = this.isHeld('jump');

    if (pad !== null) {
      if (moveX === 0) moveX = pad.moveX;
      if (moveY === 0) moveY = pad.moveY;
      if (pad.jump) jumpHeld = true;
      if (pad.jump && !(prev?.jump ?? false)) jump = true;
      if (pad.light && !(prev?.light ?? false)) light = true;
      if (pad.heavy && !(prev?.heavy ?? false)) heavy = true;
      if (pad.dodge && !(prev?.dodge ?? false)) dodge = true;
    }
    // A press that was released before this poll still counts as held on the press tick (short-hop rules).
    if (jump) jumpHeld = true;

    return { moveX, moveY, jump, jumpHeld, light, heavy, dodge };
  }

  setEnabled(enabled: boolean): void {
    if (this.enabled === enabled) return;
    this.enabled = enabled;
    if (!enabled) this.releaseAll();
  }

  get isEnabled(): boolean {
    return this.enabled;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const [t, type, fn, cap] of this.listeners) t.removeEventListener(type, fn, cap);
    this.listeners.length = 0;
    this.releaseAll();
  }

  // ── raw entry points (used by the DOM listeners and by tests) ──────────────

  /** Key went down. Returns true if the game consumed it (caller should preventDefault). */
  keyDown(code: string, repeat = false): boolean {
    if (code === 'Escape') {
      if (!repeat) this.onPause?.();
      return true;
    }
    if (code === 'F3') {
      if (!repeat) this.onToggleDebug?.();
      return true;
    }
    if (!this.enabled) return false;
    const actions = BINDINGS[code];
    if (actions === undefined) return false;
    const wasHeld = this.held.has(code);
    this.held.add(code);
    if (!wasHeld) this.edge(actions);
    return true;
  }

  keyUp(code: string): void {
    this.held.delete(code);
  }

  /** Mouse button down (0 = left = light, 2 = right = heavy). Returns true if consumed. */
  mouseDown(button: number): boolean {
    if (!this.enabled) return false;
    const code = `Mouse${button}`;
    const actions = BINDINGS[code];
    if (actions === undefined) return false;
    const wasHeld = this.held.has(code);
    this.held.add(code);
    if (!wasHeld) this.edge(actions);
    return true;
  }

  mouseUp(button: number): void {
    this.held.delete(`Mouse${button}`);
  }

  /** Drop every held key / button and any un-polled edge (blur, hidden tab, menus). */
  releaseAll(): void {
    this.held.clear();
    this.pendJump = this.pendLight = this.pendHeavy = this.pendDodge = false;
    this.prevPad = null;
  }

  // ── internals ──────────────────────────────────────────────────────────────

  private edge(actions: readonly Action[]): void {
    for (const a of actions) {
      if (a === 'jump') this.pendJump = true;
      else if (a === 'light') this.pendLight = true;
      else if (a === 'heavy') this.pendHeavy = true;
      else if (a === 'dodge') this.pendDodge = true;
    }
  }

  private isHeld(action: Action): boolean {
    for (const code of this.held) {
      const acts = BINDINGS[code];
      if (acts !== undefined && acts.includes(action)) return true;
    }
    return false;
  }

  private readGamepad(): PadState | null {
    if (this.gamepads === null) return null;
    let pad: PadState | null = null;
    try {
      const list = this.gamepads();
      for (let i = 0; i < list.length; i++) {
        const p = readPad(list[i]);
        if (p !== null) {
          pad = p;
          break;
        }
      }
    } catch {
      pad = null;
    }
    if (pad !== null && pad.pause && !(this.prevPad?.pause ?? false)) this.onPause?.();
    this.prevPad = pad;
    return pad;
  }

  private onKeyDown(e: KeyboardEvent): void {
    if (e.ctrlKey || e.metaKey || e.altKey) return; // leave browser / OS shortcuts alone
    const target = e.target as { tagName?: string } | null;
    const tag = target?.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
    if (this.keyDown(e.code, e.repeat) && (e.code === 'F3' || e.code === 'Escape' || GAME_CODES.has(e.code))) {
      e.preventDefault();
    }
  }

  private listen(target: EventTarget, type: string, fn: EventListener, capture?: boolean): void {
    target.addEventListener(type, fn, capture);
    this.listeners.push([target, type, fn, capture]);
  }
}
