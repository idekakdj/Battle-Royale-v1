/**
 * The Ocean Dome's glass shape as pure numbers (no three, no DOM): the camera rig clamps the boom to it (`boomCast`), the dome mesh,
 * the serpent breach and the tests read the same constants. The glass is a half-ellipsoid: horizontal radius = wall + DOME_MARGIN,
 * height DOME_HEIGHT.
 */

/** The glass dome's horizontal radius is the arena wall + this many metres. */
export const DOME_MARGIN = 2;
/** Dome height (m) above the seabed (an ellipsoidal half-dome, radius = wall + 2). */
export const DOME_HEIGHT = 22;

/** Horizontal radius (m) of the glass at ground level for an arena wall radius. */
export function domeRadiusFor(wallRadius: number): number {
  return wallRadius + DOME_MARGIN;
}

/** Horizontal radius (m) of the glass at height `y` (0 above the apex). */
export function glassRadiusAt(wallRadius: number, y: number): number {
  const k = y / DOME_HEIGHT;
  return k >= 1 ? 0 : domeRadiusFor(wallRadius) * Math.sqrt(1 - Math.max(0, k) * Math.max(0, k));
}

/** The camera never leaves this fraction of the glass ellipsoid (so its near plane never pokes through the glass / frame). */
export const DOME_CAMERA_FRACTION = 0.94;

/**
 * Largest t >= 0 so that the point (ox, oy, oz) + t (dx, dy, dz) is still inside `fraction` of the dome ellipsoid
 * (x^2 + z^2) / (fR)^2 + y^2 / (fH)^2 <= 1. Returns 0 when the origin is already outside, `maxDist` when the whole boom fits.
 */
export function domeExitDistance(wallRadius: number, ox: number, oy: number, oz: number, dx: number, dy: number, dz: number, maxDist: number, fraction = DOME_CAMERA_FRACTION): number {
  const R = domeRadiusFor(wallRadius) * fraction;
  const H = DOME_HEIGHT * fraction;
  const ir2 = 1 / (R * R);
  const ih2 = 1 / (H * H);
  const c = (ox * ox + oz * oz) * ir2 + oy * oy * ih2 - 1;
  if (c >= 0) return 0;
  const a = (dx * dx + dz * dz) * ir2 + dy * dy * ih2;
  if (a < 1e-12) return maxDist;
  const b = 2 * ((ox * dx + oz * dz) * ir2 + oy * dy * ih2);
  const disc = b * b - 4 * a * c;
  if (disc <= 0) return 0;
  const t = (-b + Math.sqrt(disc)) / (2 * a);
  return t < maxDist ? Math.max(0, t) : maxDist;
}
