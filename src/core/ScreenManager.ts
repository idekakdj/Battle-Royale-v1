/**
 * Screen stack manager (BLUEPRINT §5).
 *
 * A {@link Screen} owns a slice of the DOM UI. Only one screen is mounted at a
 * time; {@link ScreenManager.transition} unmounts the current one and mounts the
 * next. `update(dt)` is forwarded to the active screen each frame if present.
 */

export interface Screen {
  mount(root: HTMLElement): void;
  unmount(): void;
  update?(dt: number): void;
}

export class ScreenManager {
  private readonly root: HTMLElement;
  private current: Screen | null = null;

  constructor(root: HTMLElement) {
    this.root = root;
  }

  /** The currently mounted screen, or null before the first transition. */
  get active(): Screen | null {
    return this.current;
  }

  /**
   * Unmount the current screen (if any) and mount `next`. The mount receives the
   * shared root element so screens can append their own DOM subtree.
   */
  transition(next: Screen): void {
    if (this.current !== null) {
      this.current.unmount();
      this.current = null;
    }
    this.current = next;
    next.mount(this.root);
  }

  /** Forward a per-frame update to the active screen, if it wants one. */
  update(dt: number): void {
    this.current?.update?.(dt);
  }

  /** Unmount whatever is active and clear the slot. */
  unmount(): void {
    if (this.current !== null) {
      this.current.unmount();
      this.current = null;
    }
  }
}
