/**
 * Tree-trunk fade maths (WP-J3): a trunk that sits between the third-person camera and the followed fighter (or that the camera
 * is about to touch) fades to a dithered ghost instead of hiding the action; the target opacity is computed here, smoothed over
 * time with {@link stepFade} (fast out, slower in) so it never pops. Pure functions, node-testable.
 *
 * The camera pull-in in `CameraRig` deliberately ignores tree trunks (only a camera END inside a trunk is eased back), so this
 * fade is what keeps the view readable. First person (camera ≈ focus) never fades anything: the eye is already clear of trunks.
 */

/** The most transparent a trunk gets (a faint dithered silhouette stays so the clearing still reads as a forest). */
export const TRUNK_FADE_MIN = 0.12;
/** Beyond this camera↔focus distance the camera counts as third person (proximity fade allowed). */
export const THIRD_PERSON_MIN_DIST = 2.5;

function sstep(a: number, b: number, x: number): number {
  const t = (x - a) / (b - a);
  const c = t < 0 ? 0 : t > 1 ? 1 : t;
  return c * c * (3 - 2 * c);
}

/**
 * Target opacity (`TRUNK_FADE_MIN`..1) of the trunk `(tx, tz, radius, height)` for a camera at `(cx, cy, cz)` looking at the
 * focus point `(fx, fy, fz)` (the followed fighter's head).
 *
 *  - occlusion: the camera→focus segment passes within `radius + margin` of the trunk axis (in XZ) while the segment is still
 *    below the trunk's height and the closest point lies strictly between the two ends → faded;
 *  - proximity: a third-person camera closer than ~2 m to the trunk surface fades it too (the near plane never clips a trunk).
 */
export function trunkFadeTarget(
  cx: number, cy: number, cz: number,
  fx: number, fy: number, fz: number,
  tx: number, tz: number, radius: number, height: number,
): number {
  const abx = fx - cx;
  const abz = fz - cz;
  const len2 = abx * abx + abz * abz;
  const dy = fy - cy;
  const dist3 = Math.sqrt(len2 + dy * dy);
  let target = 1;

  if (len2 > 1e-4 && dist3 > THIRD_PERSON_MIN_DIST) {
    const tRaw = ((tx - cx) * abx + (tz - cz) * abz) / len2;
    const t = tRaw < 0 ? 0 : tRaw > 1 ? 1 : tRaw;
    const qx = cx + abx * t - tx;
    const qz = cz + abz * t - tz;
    const d = Math.sqrt(qx * qx + qz * qz);
    // Height of the sight line above the trunk's base at its closest approach.
    const yAt = cy + dy * t;
    const below = 1 - sstep(height - 1.5, height + 0.5, yAt);
    const between = sstep(0.0, 0.07, tRaw) * (1 - sstep(0.93, 1.0, tRaw));
    const occl = (1 - sstep(radius + 0.1, radius + 1.0, d)) * between * below;
    target = 1 - occl * (1 - TRUNK_FADE_MIN);

    // Third-person proximity (camera near the trunk surface, below the canopy).
    const dcx = cx - tx;
    const dcz = cz - tz;
    const dc = Math.sqrt(dcx * dcx + dcz * dcz) - radius;
    const prox = sstep(0.3, 2.1, dc);
    const camBelow = 1 - sstep(height - 1.5, height + 0.5, cy);
    const proxTarget = 1 - (1 - prox) * camBelow * (1 - 0.2);
    if (proxTarget < target) target = proxTarget;
  }
  return target < TRUNK_FADE_MIN ? TRUNK_FADE_MIN : target > 1 ? 1 : target;
}

/** Fade-out time constant (s): quick so the view clears; fade-in is slower so trunks never flicker back. */
export const FADE_OUT_TAU = 0.1;
export const FADE_IN_TAU = 0.28;

/** One smoothing step of a trunk's current opacity toward its target (continuous in `dt`, never overshoots). */
export function stepFade(current: number, target: number, dt: number): number {
  const tau = target < current ? FADE_OUT_TAU : FADE_IN_TAU;
  const k = 1 - Math.exp(-Math.max(0, dt) / tau);
  const next = current + (target - current) * k;
  return Math.abs(next - target) < 0.002 ? target : next;
}
