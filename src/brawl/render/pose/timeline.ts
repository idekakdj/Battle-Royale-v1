/**
 * DOF-space key timeline of one move (pure function of the continuous move frame).
 *
 * Plan §6.2: anticipation eases OUT over the first ≈55 % of the startup, the strike eases IN and reaches its peak pose
 * exactly on the first active frame, the peak holds through the active window, the follow-through overshoots and the
 * recovery settles with an ease-in-out. The timeline only stores keys; `evalAt` is allocation-free.
 */

import { DOF_N, type DofVec } from './dof';

export type Ease = 'in' | 'out' | 'inout' | 'lin';

export interface Key {
  /** Move frame (float) at which the pose is reached. */
  f: number;
  v: DofVec;
  /** Easing of the segment ARRIVING at this key. */
  ease: Ease;
  /** Exponent of the `in` / `out` ease (defaults 1.45 / 1.7; 1 = linear). */
  pow?: number;
}

export function applyEase(e: Ease, t: number, pow?: number): number {
  const x = t < 0 ? 0 : t > 1 ? 1 : t;
  switch (e) {
    case 'in':
      return Math.pow(x, pow ?? 1.45);
    case 'out':
      return 1 - Math.pow(1 - x, pow ?? 1.7);
    case 'inout':
      return x * x * (3 - 2 * x);
    default:
      return x;
  }
}

export class Timeline {
  readonly keys: Key[];
  /** Per-DOF time lag in frames (secondary motion: tail / tail tip trail the body). */
  readonly lag: Float64Array;
  private readonly lagLevels: number[];
  private readonly tmp: DofVec = new Float64Array(DOF_N);

  constructor(keys: Key[], lag?: Float64Array) {
    this.keys = keys;
    this.lag = lag ?? new Float64Array(DOF_N);
    const lv = new Set<number>();
    for (let i = 0; i < DOF_N; i++) if (this.lag[i] > 0) lv.add(this.lag[i]);
    this.lagLevels = [...lv];
  }

  get end(): number {
    return this.keys[this.keys.length - 1].f;
  }

  private evalRaw(f: number, out: DofVec): void {
    const ks = this.keys;
    const n = ks.length;
    if (f <= ks[0].f) {
      out.set(ks[0].v);
      return;
    }
    if (f >= ks[n - 1].f) {
      out.set(ks[n - 1].v);
      return;
    }
    let i = 0;
    while (i < n - 2 && f >= ks[i + 1].f) i++;
    const a = ks[i];
    const b = ks[i + 1];
    const span = b.f - a.f;
    const t = span > 1e-9 ? (f - a.f) / span : 1;
    const e = applyEase(b.ease, t, b.pow);
    for (let d = 0; d < DOF_N; d++) out[d] = a.v[d] + (b.v[d] - a.v[d]) * e;
  }

  /** Pose at continuous move frame `f` (writes all DOFs of `out`). */
  evalAt(f: number, out: DofVec): DofVec {
    this.evalRaw(f, out);
    for (let li = 0; li < this.lagLevels.length; li++) {
      const lag = this.lagLevels[li];
      this.evalRaw(f - lag, this.tmp);
      for (let d = 0; d < DOF_N; d++) if (this.lag[d] === lag) out[d] = this.tmp[d];
    }
    return out;
  }
}
