/**
 * Jungle camera / trunk-fade / arena-context tests (v1.8 WP-J3), all node-safe (no GL):
 *  - the trunk fade maths (occlusion fades, no occlusion = solid, third-person only, smoothing never pops),
 *  - the arena-aware camera boom (`boomCast`) gives EXACTLY the v1.7 result on the colosseum, never pulls the boom in for a
 *    trunk between pivot and camera, but eases it back when the camera end would sit inside a trunk,
 *  - the first-person eye clamp is the colosseum's with the colosseum arena and keeps the eye out of trunks in the jungle,
 *  - the pool profile helpers (floor / depth / surface).
 */

import { afterEach, describe, expect, it } from 'vitest';
import { PILLARS, PILLAR_HEIGHT, WALL_RADIUS } from '../../src/config/arena';
import { COLOSSEUM_ARENA, JUNGLE_ARENA } from '../../src/config/arenas';
import { mulberry32 } from '../../src/core/math';
import { boomCast } from '../../src/render/CameraRig';
import { clampEyeToArena } from '../../src/render/animals/fp/math';
import {
  POOL_BANK_WIDTH,
  POOL_SURFACE_Y,
  getRenderArena,
  mossZoneAt,
  poolDepthFraction,
  poolFloorHeight,
  setRenderArena,
  waterSurfaceAt,
  waterZoneAt,
} from '../../src/render/arenaContext';
import {
  FADE_IN_TAU,
  FADE_OUT_TAU,
  TRUNK_FADE_MIN,
  stepFade,
  trunkFadeTarget,
} from '../../src/render/jungle/treeFade';

afterEach(() => setRenderArena());

// ── Reference: the v1.7 collide() body, verbatim, on the colosseum constants ──
const CAM_PAD = 0.35;
const WALL_DECOR = 0.6;
const GROUND_MIN_Y = 0.28;
function exitCircle(ox: number, oz: number, dx: number, dz: number, a: number, r: number): number {
  const b = 2 * (ox * dx + oz * dz);
  const c = ox * ox + oz * oz - r * r;
  if (c >= 0) return 0;
  const disc = b * b - 4 * a * c;
  if (disc <= 0) return -1;
  return (-b + Math.sqrt(disc)) / (2 * a);
}
function referenceCollide(ox: number, oy: number, oz: number, dx: number, dy: number, dz: number, maxDist: number): { hard: number; soft: number } {
  let hard = maxDist;
  let soft = maxDist;
  const a = dx * dx + dz * dz;
  if (a > 1e-8) {
    const pr = Math.hypot(ox, oz) + 0.05;
    let rw = WALL_RADIUS - CAM_PAD - WALL_DECOR;
    if (pr > rw) rw = pr < WALL_RADIUS - CAM_PAD ? pr : WALL_RADIUS - CAM_PAD;
    const tw = exitCircle(ox, oz, dx, dz, a, rw);
    if (tw >= 0 && tw < hard) hard = tw;
    for (let i = 0; i < PILLARS.length; i++) {
      const p = PILLARS[i];
      const ocx = ox - p.x;
      const ocz = oz - p.z;
      const rr = p.radius + CAM_PAD;
      const cc = ocx * ocx + ocz * ocz - rr * rr;
      if (cc <= 0) continue;
      const bb = 2 * (ocx * dx + ocz * dz);
      const disc2 = bb * bb - 4 * a * cc;
      if (disc2 <= 0) continue;
      const t0 = (-bb - Math.sqrt(disc2)) / (2 * a);
      if (t0 > 0 && t0 < soft && oy + dy * t0 <= PILLAR_HEIGHT + CAM_PAD + 0.35) soft = t0;
    }
  }
  if (dy < -1e-6) {
    const tg = (GROUND_MIN_Y - oy) / dy;
    if (tg > 0 && tg < hard) hard = tg;
  }
  return { hard, soft: soft < hard ? soft : hard };
}

describe('arena-aware camera boom', () => {
  it('colosseum: identical to the v1.7 pull-in for 6000 random booms', () => {
    const rng = mulberry32(0xcafe);
    const out = { hard: 0, soft: 0 };
    for (let i = 0; i < 6000; i++) {
      const ang = rng() * Math.PI * 2;
      const r = Math.sqrt(rng()) * 29.5;
      const ox = Math.cos(ang) * r;
      const oz = Math.sin(ang) * r;
      const oy = 0.3 + rng() * 6;
      const yaw = rng() * Math.PI * 2;
      const pitch = (rng() - 0.35) * 1.4;
      const cp = Math.cos(pitch);
      const dx = -Math.sin(yaw) * cp;
      const dy = Math.sin(pitch);
      const dz = -Math.cos(yaw) * cp;
      const max = 6.5 + rng() * 2;
      boomCast(COLOSSEUM_ARENA, ox, oy, oz, dx, dy, dz, max, out);
      const ref = referenceCollide(ox, oy, oz, dx, dy, dz, max);
      expect(out.hard).toBe(ref.hard);
      expect(out.soft).toBe(ref.soft);
    }
  });

  it('colosseum arena data matches the constants the camera used before', () => {
    expect(COLOSSEUM_ARENA.wallRadius).toBe(WALL_RADIUS);
    expect(COLOSSEUM_ARENA.circles.length).toBe(PILLARS.length);
    for (const c of COLOSSEUM_ARENA.circles) expect(c.height).toBe(PILLAR_HEIGHT);
    expect(getRenderArena()).toBe(COLOSSEUM_ARENA); // the default render arena
  });

  it('jungle: a trunk between the pivot and the camera does not pull the boom in', () => {
    const tree = JUNGLE_ARENA.circles.find((c) => c.kind === 'tree' && c.x < -9 && c.x > -10)!; // (-9.5, -0.3, r 1.5)
    const out = { hard: 0, soft: 0 };
    // Pivot 3 m west of the trunk, boom pointing east through it, camera well past it.
    boomCast(JUNGLE_ARENA, tree.x - 3, 1.6, tree.z, 1, 0, 0, 9, out);
    expect(out.soft).toBe(out.hard); // no soft pull-in
    expect(out.hard).toBeGreaterThan(8.5);
  });

  it('jungle: a camera end that would sit INSIDE a trunk is eased back to the trunk surface', () => {
    const tree = JUNGLE_ARENA.circles.find((c) => c.kind === 'tree' && c.x < -9 && c.x > -10)!;
    const out = { hard: 0, soft: 0 };
    boomCast(JUNGLE_ARENA, tree.x - 6.5, 1.6, tree.z, 1, 0, 0, 6.5, out);
    expect(out.soft).toBeLessThan(6.5);
    expect(out.soft).toBeCloseTo(6.5 - tree.radius - 0.35, 3);
  });

  it('the colosseum pillar still pulls the boom in (not a tree)', () => {
    const p = COLOSSEUM_ARENA.circles[0];
    const out = { hard: 0, soft: 0 };
    boomCast(COLOSSEUM_ARENA, p.x - 4, 1.6, p.z, 1, 0, 0, 9, out);
    expect(out.soft).toBeLessThan(9);
  });
});

describe('first-person eye clamp follows the arena', () => {
  it('colosseum: pulls the eye out of a pillar exactly like v1.7', () => {
    const p = PILLARS[0];
    const off = { x: -0.4, z: 0 };
    clampEyeToArena(p.x + p.radius + 0.5, p.z, off); // eye would be inside the pillar
    expect(Math.hypot(p.x + p.radius + 0.5 + off.x - p.x, p.z + off.z - p.z)).toBeGreaterThanOrEqual(p.radius + 0.22 - 1e-9);
  });

  it('jungle: keeps the eye out of a tree trunk and inside the (same-radius) wall', () => {
    setRenderArena(JUNGLE_ARENA);
    const t = JUNGLE_ARENA.circles.find((c) => c.kind === 'tree')!;
    const off = { x: -0.9, z: 0 };
    clampEyeToArena(t.x + t.radius + 0.6, t.z, off);
    expect(Math.hypot(t.x + t.radius + 0.6 + off.x - t.x, t.z + off.z - t.z)).toBeGreaterThanOrEqual(t.radius + 0.22 - 1e-9);
    const off2 = { x: 3, z: 0 };
    clampEyeToArena(29.5, 0, off2);
    expect(29.5 + off2.x).toBeLessThanOrEqual(JUNGLE_ARENA.wallRadius - 0.22 + 1e-9);
  });
});

describe('trunk fade maths', () => {
  const tx = 0;
  const tz = 0;
  const radius = 1.2;
  const height = 16;

  it('a trunk squarely between the camera and the focus fades to the minimum', () => {
    // camera at x = +6, focus at x = -6: the trunk at the origin is dead centre of the sight line
    const f = trunkFadeTarget(6, 3, 0, -6, 1.3, 0, tx, tz, radius, height);
    expect(f).toBeCloseTo(TRUNK_FADE_MIN, 3);
  });

  it('a trunk off to the side or behind the focus stays solid', () => {
    expect(trunkFadeTarget(6, 3, 0, -6, 1.3, 0, 0, 7, radius, height)).toBe(1); // 7 m beside the line
    expect(trunkFadeTarget(6, 3, 0, -6, 1.3, 0, -12, 0, radius, height)).toBe(1); // beyond the focus
    expect(trunkFadeTarget(6, 3, 0, -6, 1.3, 0, 12, 0, radius, height)).toBe(1); // behind the camera, far
  });

  it('fade is continuous across the sight line (no popping): small steps change it a little', () => {
    let prev = trunkFadeTarget(6, 3, 0, -6, 1.3, 0, tx, -4, radius, height);
    let maxJump = 0;
    for (let z = -4; z <= 4; z += 0.02) {
      const f = trunkFadeTarget(6, 3, 0, -6, 1.3, 0, tx, z, radius, height);
      maxJump = Math.max(maxJump, Math.abs(f - prev));
      prev = f;
    }
    expect(maxJump).toBeLessThan(0.06);
  });

  it('first person (camera at the focus) never fades anything', () => {
    expect(trunkFadeTarget(0.5, 1.3, 0.2, 0.5, 1.3, 0.5, 1, 1, radius, height)).toBe(1);
    expect(trunkFadeTarget(2, 1.3, 0, 2.3, 1.3, 0, 3, 0, radius, height)).toBe(1);
  });

  it('a third-person camera right next to a trunk fades it (the near plane never clips a trunk)', () => {
    const f = trunkFadeTarget(0, 3, 1.5, 0, 1.3, 9, tx, tz, radius, height);
    expect(f).toBeLessThan(0.5);
  });

  it('the sight line passing above the trunk top does not fade it', () => {
    expect(trunkFadeTarget(6, 30, 0, -6, 28, 0, tx, tz, radius, height)).toBe(1);
  });

  it('stepFade: fades out fast, in slower, never overshoots or pops', () => {
    let v = 1;
    const out: number[] = [];
    for (let i = 0; i < 40; i++) {
      v = stepFade(v, TRUNK_FADE_MIN, 1 / 60);
      out.push(v);
    }
    for (let i = 1; i < out.length; i++) expect(out[i]).toBeLessThanOrEqual(out[i - 1]);
    expect(out[out.length - 1]).toBeGreaterThanOrEqual(TRUNK_FADE_MIN);
    expect(out[0]).toBeGreaterThan(0.8); // one frame never jumps to the end
    // back up, monotonic and bounded
    let u = TRUNK_FADE_MIN;
    for (let i = 0; i < 400; i++) {
      const n = stepFade(u, 1, 1 / 60);
      expect(n).toBeGreaterThanOrEqual(u);
      expect(n).toBeLessThanOrEqual(1);
      u = n;
    }
    expect(u).toBe(1);
    expect(FADE_OUT_TAU).toBeLessThan(FADE_IN_TAU);
    // dt = 0 is a no-op
    expect(stepFade(0.5, 1, 0)).toBe(0.5);
  });
});

describe('pool profile + zone helpers', () => {
  const R = 6.5;
  const D = 0.55;

  it('floor is flat at the shoreline, full depth inside the bank, monotonic between', () => {
    expect(poolFloorHeight(R, R, D)).toBeCloseTo(0, 6);
    expect(poolFloorHeight(R + 1, R, D)).toBeCloseTo(0, 6);
    expect(poolFloorHeight(R - POOL_BANK_WIDTH, R, D)).toBeCloseTo(-D, 6);
    expect(poolFloorHeight(0, R, D)).toBeCloseTo(-D, 6);
    let prev = 0;
    for (let d = R; d >= R - POOL_BANK_WIDTH; d -= 0.02) {
      const f = poolFloorHeight(d, R, D);
      expect(f).toBeLessThanOrEqual(prev + 1e-9);
      prev = f;
    }
    expect(poolDepthFraction(R, R)).toBeCloseTo(0, 6);
    expect(poolDepthFraction(0, R)).toBeCloseTo(1, 6);
  });

  it('water surface sits a hair below the rim inside the pool and is 0 elsewhere', () => {
    setRenderArena(JUNGLE_ARENA);
    expect(waterSurfaceAt(0, 0)).toBe(POOL_SURFACE_Y);
    expect(POOL_SURFACE_Y).toBeLessThan(0);
    expect(POOL_SURFACE_Y).toBeGreaterThan(-0.1);
    expect(waterSurfaceAt(15, 15)).toBe(0);
    expect(waterZoneAt(0, 0)).not.toBeNull();
    expect(waterZoneAt(7.5, 0)).toBeNull();
    expect(mossZoneAt(5.1, 8.6)).not.toBeNull();
    expect(mossZoneAt(0, 0)).toBeNull();
  });

  it('the colosseum has no terrain zones', () => {
    setRenderArena(COLOSSEUM_ARENA);
    expect(waterZoneAt(0, 0)).toBeNull();
    expect(mossZoneAt(0, 0)).toBeNull();
    expect(waterSurfaceAt(0, 0)).toBe(0);
  });
});
