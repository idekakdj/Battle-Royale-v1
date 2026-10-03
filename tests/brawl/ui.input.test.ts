import { describe, expect, it, vi } from 'vitest';
import { BrawlInput, readPad, type GamepadLike } from '../../src/brawl/ui/BrawlInput';

function make(opts: ConstructorParameters<typeof BrawlInput>[0] = {}): BrawlInput {
  return new BrawlInput({ keyTarget: null, mouseTarget: null, gamepads: null, ...opts });
}

const NEUTRAL = { moveX: 0, moveY: 0, jump: false, jumpHeld: false, light: false, heavy: false, dodge: false };

describe('BrawlInput mapping', () => {
  it('starts neutral', () => {
    expect(make().poll()).toEqual(NEUTRAL);
  });

  it('A / D and the arrow keys move; opposing keys cancel', () => {
    const i = make();
    i.keyDown('KeyD');
    expect(i.poll().moveX).toBe(1);
    i.keyDown('KeyA');
    expect(i.poll().moveX).toBe(0);
    i.keyUp('KeyD');
    expect(i.poll().moveX).toBe(-1);
    i.keyUp('KeyA');
    i.keyDown('ArrowRight');
    expect(i.poll().moveX).toBe(1);
    i.keyUp('ArrowRight');
    i.keyDown('ArrowLeft');
    expect(i.poll().moveX).toBe(-1);
  });

  it('W / Up give moveY +1 and jump; Space jumps without moveY; S / Down is moveY -1', () => {
    const i = make();
    i.keyDown('KeyW');
    let p = i.poll();
    expect(p.moveY).toBe(1);
    expect(p.jump).toBe(true);
    expect(p.jumpHeld).toBe(true);
    i.keyUp('KeyW');
    i.poll();
    i.keyDown('Space');
    p = i.poll();
    expect(p.moveY).toBe(0);
    expect(p.jump).toBe(true);
    i.keyUp('Space');
    i.keyDown('ArrowUp');
    expect(i.poll().moveY).toBe(1);
    i.keyUp('ArrowUp');
    i.keyDown('KeyS');
    expect(i.poll().moveY).toBe(-1);
    i.keyUp('KeyS');
    i.keyDown('ArrowDown');
    expect(i.poll().moveY).toBe(-1);
  });

  it('J / K / L / Shift and the mouse buttons fire light / heavy / dodge edges', () => {
    const i = make();
    i.keyDown('KeyJ');
    expect(i.poll()).toMatchObject({ light: true, heavy: false, dodge: false });
    i.keyUp('KeyJ');
    i.keyDown('KeyK');
    expect(i.poll()).toMatchObject({ light: false, heavy: true });
    i.keyUp('KeyK');
    i.keyDown('KeyL');
    expect(i.poll().dodge).toBe(true);
    i.keyUp('KeyL');
    i.keyDown('ShiftLeft');
    expect(i.poll().dodge).toBe(true);
    i.keyUp('ShiftLeft');
    i.keyDown('ShiftRight');
    expect(i.poll().dodge).toBe(true);
    i.keyUp('ShiftRight');
    expect(i.mouseDown(0)).toBe(true);
    expect(i.poll().light).toBe(true);
    i.mouseUp(0);
    expect(i.mouseDown(2)).toBe(true);
    expect(i.poll().heavy).toBe(true);
    expect(i.mouseDown(1)).toBe(false); // the middle button is not bound
  });
});

describe('BrawlInput edge semantics', () => {
  it('edges are true for exactly one poll; held stays; auto-repeat does not re-fire', () => {
    const i = make();
    i.keyDown('KeyJ');
    expect(i.poll().light).toBe(true);
    expect(i.poll().light).toBe(false);
    i.keyDown('KeyJ', true);
    i.keyDown('KeyJ'); // already held -> no new edge
    expect(i.poll().light).toBe(false);
    i.keyUp('KeyJ');
    i.keyDown('KeyJ');
    expect(i.poll().light).toBe(true);
  });

  it('jumpHeld is a level, jump an edge', () => {
    const i = make();
    i.keyDown('Space');
    expect(i.poll()).toMatchObject({ jump: true, jumpHeld: true });
    expect(i.poll()).toMatchObject({ jump: false, jumpHeld: true });
    i.keyUp('Space');
    expect(i.poll()).toMatchObject({ jump: false, jumpHeld: false });
  });

  it('a tap pressed and released between two polls still registers (and counts as held on that poll)', () => {
    const i = make();
    i.keyDown('Space');
    i.keyUp('Space');
    expect(i.poll()).toMatchObject({ jump: true, jumpHeld: true });
    expect(i.poll()).toMatchObject({ jump: false, jumpHeld: false });
  });

  it('a second source of the same action pressed later is a fresh edge', () => {
    const i = make();
    i.keyDown('KeyJ');
    i.poll();
    i.mouseDown(0);
    expect(i.poll().light).toBe(true);
  });

  it('setEnabled(false) yields neutral polls, drops held keys and edges, and ignores presses until re-enabled', () => {
    const i = make();
    i.keyDown('KeyD');
    i.keyDown('KeyJ');
    i.setEnabled(false);
    expect(i.poll()).toEqual(NEUTRAL);
    expect(i.keyDown('KeyA')).toBe(false);
    i.setEnabled(true);
    expect(i.poll()).toEqual(NEUTRAL);
    i.keyDown('KeyA');
    expect(i.poll().moveX).toBe(-1);
  });

  it('releaseAll clears held keys and un-polled edges', () => {
    const i = make();
    i.keyDown('KeyD');
    i.keyDown('KeyK');
    i.releaseAll();
    expect(i.poll()).toMatchObject({ moveX: 0, heavy: false });
  });

  it('Escape and F3 fire their callbacks (Escape even while disabled); repeats are ignored', () => {
    const onPause = vi.fn();
    const onToggleDebug = vi.fn();
    const i = make({ onPause, onToggleDebug });
    i.keyDown('Escape');
    i.keyDown('Escape', true);
    i.setEnabled(false);
    i.keyDown('Escape');
    i.keyDown('F3');
    i.keyDown('F3', true);
    expect(onPause).toHaveBeenCalledTimes(2);
    expect(onToggleDebug).toHaveBeenCalledTimes(1);
  });
});

describe('BrawlInput DOM listeners', () => {
  const ev = (type: string, props: Record<string, unknown> = {}): Event => Object.assign(new Event(type, { cancelable: true }), props);
  const key = (code: string, extra: Record<string, unknown> = {}): Event =>
    ev('keydown', { code, repeat: false, ctrlKey: false, metaKey: false, altKey: false, ...extra });

  it('keydown / keyup drive the state, game keys are preventDefault-ed, ctrl combos are left alone', () => {
    const target = new EventTarget();
    const i = new BrawlInput({ keyTarget: target, gamepads: null });
    const down = key('Space');
    target.dispatchEvent(down);
    expect(down.defaultPrevented).toBe(true);
    expect(i.poll().jump).toBe(true);
    target.dispatchEvent(ev('keyup', { code: 'Space' }));
    expect(i.poll().jumpHeld).toBe(false);

    const ctrl = key('KeyL', { ctrlKey: true });
    target.dispatchEvent(ctrl);
    expect(ctrl.defaultPrevented).toBe(false);
    expect(i.poll().dodge).toBe(false);

    const other = key('KeyQ');
    target.dispatchEvent(other);
    expect(other.defaultPrevented).toBe(false);
    i.dispose();
  });

  it('blur releases every held key; the context menu is suppressed while enabled', () => {
    const target = new EventTarget();
    const i = new BrawlInput({ keyTarget: target, gamepads: null });
    target.dispatchEvent(key('KeyD'));
    expect(i.poll().moveX).toBe(1);
    target.dispatchEvent(ev('blur'));
    expect(i.poll().moveX).toBe(0);
    const cm = ev('contextmenu');
    target.dispatchEvent(cm);
    expect(cm.defaultPrevented).toBe(true);
    i.dispose();
  });

  it('mouse on the canvas: left = light, right = heavy, mouseup anywhere releases', () => {
    const keys = new EventTarget();
    const canvas = new EventTarget();
    const i = new BrawlInput({ keyTarget: keys, mouseTarget: canvas, gamepads: null });
    const left = ev('mousedown', { button: 0 });
    canvas.dispatchEvent(left);
    expect(left.defaultPrevented).toBe(true);
    expect(i.poll().light).toBe(true);
    canvas.dispatchEvent(ev('mousedown', { button: 2 }));
    expect(i.poll().heavy).toBe(true);
    keys.dispatchEvent(ev('mouseup', { button: 2 }));
    canvas.dispatchEvent(ev('mousedown', { button: 2 }));
    expect(i.poll().heavy).toBe(true);
    const cm = ev('contextmenu');
    canvas.dispatchEvent(cm);
    expect(cm.defaultPrevented).toBe(true);
    i.dispose();
  });

  it('dispose removes the listeners and is idempotent', () => {
    const target = new EventTarget();
    const onPause = vi.fn();
    const i = new BrawlInput({ keyTarget: target, gamepads: null, onPause });
    i.dispose();
    i.dispose();
    target.dispatchEvent(key('Escape'));
    expect(onPause).not.toHaveBeenCalled();
  });
});

describe('gamepad (standard mapping)', () => {
  const pad = (pressed: number[] = [], axes: number[] = [0, 0, 0, 0]): GamepadLike => ({
    connected: true,
    mapping: 'standard',
    axes,
    buttons: Array.from({ length: 17 }, (_, i) => ({ pressed: pressed.includes(i) })),
  });

  it('maps the stick (deadzone, up = +1), d-pad, buttons', () => {
    expect(readPad(null)).toBeNull();
    expect(readPad({ ...pad(), connected: false })).toBeNull();
    expect(readPad(pad([], [0.1, -0.1, 0, 0]))).toMatchObject({ moveX: 0, moveY: 0 });
    expect(readPad(pad([], [0.9, -0.8, 0, 0]))).toMatchObject({ moveX: 0.9, moveY: 0.8 });
    expect(readPad(pad([14]))?.moveX).toBe(-1);
    expect(readPad(pad([15, 13]))).toMatchObject({ moveX: 1, moveY: -1 });
    expect(readPad(pad([0, 2, 1, 5, 9]))).toMatchObject({ jump: true, light: true, heavy: true, dodge: true, pause: true });
  });

  it('feeds the same intent: edges on the press, held jump, Start pauses once', () => {
    let current = pad();
    const onPause = vi.fn();
    const i = new BrawlInput({ keyTarget: null, mouseTarget: null, gamepads: () => [current], onPause });
    expect(i.poll().light).toBe(false);
    current = pad([2, 0, 9], [-1, 0, 0, 0]);
    let p = i.poll();
    expect(p).toMatchObject({ light: true, jump: true, jumpHeld: true, moveX: -1 });
    p = i.poll();
    expect(p).toMatchObject({ light: false, jump: false, jumpHeld: true });
    expect(onPause).toHaveBeenCalledTimes(1);
  });
});
