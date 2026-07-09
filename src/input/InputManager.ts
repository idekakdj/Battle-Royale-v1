/**
 * Player input → raw input state → {@link FighterIntent} (BLUEPRINT §4 / §5).
 *
 * Responsibilities:
 *  - Request pointer lock when the canvas is clicked; track lock state.
 *  - Track the §4 control mapping (WASD, Shift, Space, Q, Esc, LMB, RMB).
 *  - Produce a camera-relative {@link FighterIntent} for a given camera yaw:
 *    WASD is rotated into world space; `aimYaw` is the camera yaw; attack /
 *    special / ultimate are EDGE-triggered and consumed once per sim tick;
 *    block / jump are LEVEL (held).
 *  - Expose accumulated mouse delta for the camera rig (consume-and-reset).
 *  - enable() / disable() so menus can suspend gameplay input.
 *
 * This module owns raw input only — no gameplay logic. The sim decides what an
 * intent means.
 */

import type { FighterIntent } from '../core/types';

export interface InputManagerOptions {
  /**
   * Called when the player asks to pause: Esc pressed, or pointer lock lost
   * unexpectedly while gameplay input was active. WP-I wires this to the pause
   * menu.
   */
  onPause?: () => void;
}

/** Snapshot of accumulated pointer movement since the last consume. */
export interface MouseDelta {
  dx: number;
  dy: number;
}

const NEUTRAL_INTENT: Readonly<FighterIntent> = {
  moveX: 0,
  moveZ: 0,
  aimYaw: 0,
  attack: false,
  block: false,
  special: false,
  ultimate: false,
  jump: false,
};

export class InputManager {
  private readonly onPause: (() => void) | undefined;

  private canvas: HTMLCanvasElement | null = null;
  private enabled = false;
  private pointerLocked = false;

  // Held key state (physical keys via KeyboardEvent.code).
  private keyW = false;
  private keyA = false;
  private keyS = false;
  private keyD = false;
  private keyJump = false; // Space (held → glide for eagle)

  // Mouse button held state (RMB block is level/held; LMB attack is edge-only).
  private mouseRight = false; // block (held)

  // Edge flags: set on keydown/mousedown, consumed by getIntent() / consumePause().
  private attackEdge = false;
  private specialEdge = false; // Shift
  private ultimateEdge = false; // Q
  private pauseEdge = false; // Esc

  // Accumulated pointer movement while locked; consumed by the camera rig.
  private mouseDX = 0;
  private mouseDY = 0;

  // Reused so getIntent() allocates nothing per tick.
  private readonly intent: FighterIntent = { ...NEUTRAL_INTENT };
  private readonly mouseDeltaOut: MouseDelta = { dx: 0, dy: 0 };

  constructor(options: InputManagerOptions = {}) {
    this.onPause = options.onPause;
  }

  // ── Lifecycle ──────────────────────────────────────────────────────────────

  /** Attach global listeners and bind pointer-lock to `canvas` clicks. */
  attach(canvas: HTMLCanvasElement): void {
    this.canvas = canvas;
    canvas.addEventListener('click', this.onCanvasClick);
    window.addEventListener('keydown', this.onKeyDown);
    window.addEventListener('keyup', this.onKeyUp);
    window.addEventListener('mousedown', this.onMouseDown);
    window.addEventListener('mouseup', this.onMouseUp);
    window.addEventListener('mousemove', this.onMouseMove);
    window.addEventListener('blur', this.onWindowBlur);
    document.addEventListener('pointerlockchange', this.onPointerLockChange);
  }

  /** Remove all listeners and release pointer lock. */
  detach(): void {
    const canvas = this.canvas;
    if (canvas !== null) canvas.removeEventListener('click', this.onCanvasClick);
    window.removeEventListener('keydown', this.onKeyDown);
    window.removeEventListener('keyup', this.onKeyUp);
    window.removeEventListener('mousedown', this.onMouseDown);
    window.removeEventListener('mouseup', this.onMouseUp);
    window.removeEventListener('mousemove', this.onMouseMove);
    window.removeEventListener('blur', this.onWindowBlur);
    document.removeEventListener('pointerlockchange', this.onPointerLockChange);
    this.exitPointerLock();
    this.canvas = null;
  }

  /** Enable gameplay input (called when a match starts / resumes). */
  enable(): void {
    this.enabled = true;
  }

  /** Disable gameplay input and clear held/edge state (called for menus/pause). */
  disable(): void {
    this.enabled = false;
    this.resetState();
    this.exitPointerLock();
  }

  get isEnabled(): boolean {
    return this.enabled;
  }

  get isPointerLocked(): boolean {
    return this.pointerLocked;
  }

  /** Programmatically request pointer lock on the attached canvas. */
  requestPointerLock(): void {
    if (this.canvas !== null && this.enabled) this.canvas.requestPointerLock();
  }

  // ── Intent production ────────────────────────────────────────────────────────

  /**
   * Build the fighter's intent for this sim tick, given the current camera yaw.
   * WASD is interpreted camera-relative and rotated into world space; the result
   * has magnitude ≤ 1. Edge actions (attack/special/ultimate) are returned true
   * at most once per press and cleared here so they fire exactly once per tick.
   *
   * The returned object is reused between calls — read it before the next call.
   */
  getIntent(cameraYaw: number): FighterIntent {
    const out = this.intent;
    out.aimYaw = cameraYaw;

    if (!this.enabled) {
      out.moveX = 0;
      out.moveZ = 0;
      out.attack = false;
      out.block = false;
      out.special = false;
      out.ultimate = false;
      out.jump = false;
      return out;
    }

    // Camera-relative movement basis on the XZ plane.
    // forward = (sin yaw, cos yaw); right = (cos yaw, −sin yaw).
    const inputForward = (this.keyW ? 1 : 0) - (this.keyS ? 1 : 0);
    const inputRight = (this.keyD ? 1 : 0) - (this.keyA ? 1 : 0);
    const sin = Math.sin(cameraYaw);
    const cos = Math.cos(cameraYaw);
    let mx = sin * inputForward + cos * inputRight;
    let mz = cos * inputForward - sin * inputRight;
    const lenSq = mx * mx + mz * mz;
    if (lenSq > 1) {
      const inv = 1 / Math.sqrt(lenSq);
      mx *= inv;
      mz *= inv;
    }
    out.moveX = mx;
    out.moveZ = mz;

    out.block = this.mouseRight;
    out.jump = this.keyJump;

    // Consume edges: true this tick, then reset so they don't repeat.
    out.attack = this.attackEdge;
    out.special = this.specialEdge;
    out.ultimate = this.ultimateEdge;
    this.attackEdge = false;
    this.specialEdge = false;
    this.ultimateEdge = false;

    return out;
  }

  /**
   * Consume and return accumulated pointer movement since the last call (in raw
   * pixels). The camera rig calls this once per rendered frame. Reuses one
   * object — read it before the next call.
   */
  consumeMouseDelta(): MouseDelta {
    this.mouseDeltaOut.dx = this.mouseDX;
    this.mouseDeltaOut.dy = this.mouseDY;
    this.mouseDX = 0;
    this.mouseDY = 0;
    return this.mouseDeltaOut;
  }

  /** Consume the pending pause (Esc) edge; true at most once per press. */
  consumePause(): boolean {
    const p = this.pauseEdge;
    this.pauseEdge = false;
    return p;
  }

  // ── Internal handlers (arrow fns so `this` binds and they detach cleanly) ─────

  private readonly onCanvasClick = (): void => {
    if (this.enabled && !this.pointerLocked) this.requestPointerLock();
  };

  private readonly onKeyDown = (e: KeyboardEvent): void => {
    if (e.code === 'Escape') {
      // Esc always requests pause, even from menus; edge + callback.
      this.pauseEdge = true;
      this.onPause?.();
      return;
    }
    if (!this.enabled) return;
    switch (e.code) {
      case 'KeyW':
        this.keyW = true;
        break;
      case 'KeyA':
        this.keyA = true;
        break;
      case 'KeyS':
        this.keyS = true;
        break;
      case 'KeyD':
        this.keyD = true;
        break;
      case 'Space':
        this.keyJump = true;
        e.preventDefault();
        break;
      case 'ShiftLeft':
      case 'ShiftRight':
        if (!e.repeat) this.specialEdge = true;
        break;
      case 'KeyQ':
        if (!e.repeat) this.ultimateEdge = true;
        break;
      default:
        break;
    }
  };

  private readonly onKeyUp = (e: KeyboardEvent): void => {
    switch (e.code) {
      case 'KeyW':
        this.keyW = false;
        break;
      case 'KeyA':
        this.keyA = false;
        break;
      case 'KeyS':
        this.keyS = false;
        break;
      case 'KeyD':
        this.keyD = false;
        break;
      case 'Space':
        this.keyJump = false;
        break;
      default:
        break;
    }
  };

  private readonly onMouseDown = (e: MouseEvent): void => {
    if (!this.enabled) return;
    if (e.button === 0) {
      this.attackEdge = true; // LMB → basic attack (edge)
    } else if (e.button === 2) {
      this.mouseRight = true; // RMB → block (held)
    }
  };

  private readonly onMouseUp = (e: MouseEvent): void => {
    if (e.button === 2) this.mouseRight = false;
  };

  private readonly onMouseMove = (e: MouseEvent): void => {
    if (!this.pointerLocked) return;
    this.mouseDX += e.movementX;
    this.mouseDY += e.movementY;
  };

  private readonly onWindowBlur = (): void => {
    // Losing focus should never leave keys "stuck" down.
    this.resetState();
  };

  private readonly onPointerLockChange = (): void => {
    const locked = document.pointerLockElement === this.canvas;
    const wasLocked = this.pointerLocked;
    this.pointerLocked = locked;
    if (wasLocked && !locked && this.enabled) {
      // Lock lost (typically Esc) while playing → treat as a pause request.
      this.pauseEdge = true;
      this.onPause?.();
    }
  };

  private exitPointerLock(): void {
    if (document.pointerLockElement === this.canvas && this.canvas !== null) {
      document.exitPointerLock();
    }
    this.pointerLocked = false;
  }

  private resetState(): void {
    this.keyW = this.keyA = this.keyS = this.keyD = false;
    this.keyJump = false;
    this.mouseRight = false;
    this.attackEdge = this.specialEdge = this.ultimateEdge = false;
    this.mouseDX = 0;
    this.mouseDY = 0;
  }
}
