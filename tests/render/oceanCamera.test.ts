/**
 * Camera vs terrain (v1.9 WP-O3), node-safe:
 *  - on the Ocean Dome the boom stays above the ground under it (ramps, terrace, plateau) and a cliff between the player and the
 *    camera pulls it in; a steeper pitch clears the same cliff (the wall-style squeeze assist handles the lift),
 *  - the camera the rig can reach never leaves the glass dome (ellipsoid radius wall + 2, height 22): since v1.10 `boomCast` clamps the
 *    boom to 94 % of the ellipsoid (`out.dome`), because a pivot on a 6.5 m tower pitched up reached 0.996 of it,
 *  - towers (v1.10): a tower between the player and the camera pulls the boom in, the boom clears the tower top, the first-person eye floor
 *    follows the tower top,
 *  - the colosseum and the jungle get exactly the old numbers (`out.terrain` = the full boom, hard / soft untouched),
 *  - the render-side ground height helper is 0 on the old arenas and the heightfield on the ocean.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { COLOSSEUM_ARENA, JUNGLE_ARENA, OCEAN_ARENA, OCEAN_STACKS, OCEAN_UPPER_HEIGHT, arenaGroundHeight } from '../../src/config/arenas';
import { mulberry32 } from '../../src/core/math';
import { boomCast } from '../../src/render/CameraRig';
import { renderGroundHeight, setRenderArena } from '../../src/render/arenaContext';
import { DOME_CAMERA_FRACTION, domeExitDistance } from '../../src/render/ocean/domeShape';
import { DOME_HEIGHT, domeRadius } from '../../src/render/ocean/terrain';

afterEach(() => setRenderArena());

const MARGIN = 0.35 + 0.14;

describe('boom vs terrain (Ocean Dome)', () => {
  it('the boom end is always above the ground under it, for 4000 random booms from random pivots', () => {
    const rng = mulberry32(0x0ce);
    const out: { hard: number; soft: number; terrain?: number } = { hard: 0, soft: 0 };
    let pulled = 0;
    for (let i = 0; i < 4000; i++) {
      const ang = rng() * Math.PI * 2;
      const r = Math.sqrt(rng()) * 29;
      const ox = Math.cos(ang) * r;
      const oz = Math.sin(ang) * r;
      const feet = arenaGroundHeight(OCEAN_ARENA, ox, oz);
      const oy = feet + 1.6;
      const yaw = rng() * Math.PI * 2;
      const pitch = (rng() - 0.35) * 1.4;
      const cp = Math.cos(pitch);
      const dx = -Math.sin(yaw) * cp;
      const dy = Math.sin(pitch);
      const dz = -Math.cos(yaw) * cp;
      const max = 6.5;
      boomCast(OCEAN_ARENA, ox, oy, oz, dx, dy, dz, max, out);
      const d = Math.min(max, out.terrain ?? max);
      if (d < max - 1e-6) pulled++;
      // sample the boom up to the allowed distance: never below the terrain margin
      for (let t = 0.3; t <= d; t += 0.25) {
        const g = arenaGroundHeight(OCEAN_ARENA, ox + dx * t, oz + dz * t);
        expect(oy + dy * t, `boom ${i} at t=${t.toFixed(2)}`).toBeGreaterThanOrEqual(g + MARGIN - 0.06);
      }
    }
    expect(pulled).toBeGreaterThan(100); // the terrain really does pull the boom in sometimes
  });

  it('a cliff between the player and the camera pulls the boom in; a steeper pitch clears it', () => {
    // On the seabed 1.2 m in front of the terrace cliff (r = 19), camera behind the player toward the terrace (pointing away from the centre = +r).
    const px = 20.2;
    const oy = 1.6;
    const out: { hard: number; soft: number; terrain?: number } = { hard: 0, soft: 0 };
    // direction toward the cliff (decreasing x), low pitch: the boom runs into the 1.5 m terrace wall
    boomCast(OCEAN_ARENA, px, oy, 4.0, -Math.cos(0.2), Math.sin(0.2), 0, 6.5, out);
    expect(out.terrain!).toBeLessThan(2.5);
    // the same boom with a 55 degree pitch rises over the edge
    boomCast(OCEAN_ARENA, px, oy, 4.0, -Math.cos(0.96), Math.sin(0.96), 0, 6.5, out);
    expect(out.terrain!).toBeGreaterThan(4.5);
    // away from the cliff nothing pulls in
    boomCast(OCEAN_ARENA, px, oy, 4.0, Math.cos(0.2), Math.sin(0.2), 0, 6.5, out);
    expect(out.terrain!).toBe(6.5);
  });

  it('a plateau between the player and the camera pulls the boom in (player on the terrace, camera pointing over the plateau)', () => {
    const out: { hard: number; soft: number; terrain?: number } = { hard: 0, soft: 0 };
    // player on the terrace at r = 10 (ground 1.5), pivot 3.1; boom pointing toward the centre at a low pitch: the plateau top (3.0 + margin) is above it
    boomCast(OCEAN_ARENA, 10, 3.1, 0.2, -Math.cos(0.1), Math.sin(0.1), 0, 6.5, out);
    expect(out.terrain!).toBeLessThan(2.6);
  });

  it('every camera position the rig can reach is inside the glass dome', () => {
    const R = domeRadius(OCEAN_ARENA);
    const rng = mulberry32(0xd03e);
    const out: { hard: number; soft: number; terrain?: number; dome?: number } = { hard: 0, soft: 0 };
    let worst = 0;
    for (let i = 0; i < 6000; i++) {
      const ang = rng() * Math.PI * 2;
      const r = Math.sqrt(rng()) * (OCEAN_ARENA.wallRadius - 0.6);
      const ox = Math.cos(ang) * r;
      const oz = Math.sin(ang) * r;
      const oy = arenaGroundHeight(OCEAN_ARENA, ox, oz) + 1.6 + 0.6 * 0.5; // head height + the wall-squeeze lift
      const yaw = rng() * Math.PI * 2;
      const pitch = rng() * (67 * Math.PI) / 180 - 0.3; // up to PITCH_MAX + the squeeze pitch (55 + 12 deg)
      const cp = Math.cos(pitch);
      const dx = -Math.sin(yaw) * cp;
      const dy = Math.sin(pitch);
      const dz = -Math.cos(yaw) * cp;
      boomCast(OCEAN_ARENA, ox, oy, oz, dx, dy, dz, 8.5, out); // 8.5 = the spectate boom
      const d = Math.min(8.5, out.hard, out.terrain ?? 8.5, out.dome ?? 8.5);
      const cx = ox + dx * d;
      const cy = oy + dy * d;
      const cz = oz + dz * d;
      const e = (cx * cx + cz * cz) / (R * R) + (cy * cy) / (DOME_HEIGHT * DOME_HEIGHT);
      if (e > worst) worst = e;
      // the dome clamp keeps the boom end inside DOME_CAMERA_FRACTION of the ellipsoid (0.94 -> e <= 0.8836)
      expect(e, `boom ${i}`).toBeLessThanOrEqual(DOME_CAMERA_FRACTION * DOME_CAMERA_FRACTION + 1e-6);
    }
    expect(worst).toBeGreaterThan(0.3);
  });

  it('on the tower tops (6.5 m) a boom pitched up stays inside the dome too: unclamped it reached the glass (e > 1), clamped it never does', () => {
    const R = domeRadius(OCEAN_ARENA);
    const rng = mulberry32(0x70e);
    const out: { hard: number; soft: number; terrain?: number; dome?: number } = { hard: 0, soft: 0 };
    let unclamped = 0;
    let clamped = 0;
    let worst = 0;
    for (let i = 0; i < 3000; i++) {
      const s = OCEAN_STACKS[i % OCEAN_STACKS.length];
      const a = rng() * Math.PI * 2;
      const r = Math.sqrt(rng()) * (s.radius - 0.3);
      const ox = s.x + Math.cos(a) * r;
      const oz = s.z + Math.sin(a) * r;
      const oy = OCEAN_UPPER_HEIGHT + 1.9;
      const yaw = rng() * Math.PI * 2;
      const pitch = rng() * (67 * Math.PI) / 180;
      const cp = Math.cos(pitch);
      const dx = -Math.sin(yaw) * cp;
      const dy = Math.sin(pitch);
      const dz = -Math.cos(yaw) * cp;
      boomCast(OCEAN_ARENA, ox, oy, oz, dx, dy, dz, 8.5, out);
      const d0 = Math.min(8.5, out.hard, out.terrain ?? 8.5);
      const d1 = Math.min(d0, out.dome ?? 8.5);
      const ell = (d: number): number => {
        const cx = ox + dx * d;
        const cy = oy + dy * d;
        const cz = oz + dz * d;
        return (cx * cx + cz * cz) / (R * R) + (cy * cy) / (DOME_HEIGHT * DOME_HEIGHT);
      };
      if (ell(d0) > 1) unclamped++;
      if (ell(d1) > 1) clamped++;
      worst = Math.max(worst, ell(d1));
    }
    expect(unclamped).toBeGreaterThan(0); // the problem was real
    expect(clamped).toBe(0);
    expect(worst).toBeLessThanOrEqual(DOME_CAMERA_FRACTION * DOME_CAMERA_FRACTION + 1e-6);
  });

  it('domeExitDistance: the full boom when it fits, 0 from outside, and the exact exit point otherwise', () => {
    expect(domeExitDistance(30, 0, 1, 0, 1, 0, 0, 6)).toBe(6);
    expect(domeExitDistance(30, 31, 1, 0, 1, 0, 0, 6)).toBe(0);
    const t = domeExitDistance(30, 0, 1, 0, 1, 0, 0, 80);
    const Rf = 32 * DOME_CAMERA_FRACTION;
    const Hf = DOME_HEIGHT * DOME_CAMERA_FRACTION;
    expect(t).toBeCloseTo(Rf * Math.sqrt(1 - (1 / Hf) * (1 / Hf)), 6); // the ellipse at y = 1
    const tu = domeExitDistance(30, 0, 1, 0, 0, 1, 0, 80);
    expect(tu + 1).toBeCloseTo(DOME_HEIGHT * DOME_CAMERA_FRACTION, 6);
  });
});

describe('boom vs the towers (Ocean Dome, v1.10)', () => {
  const T = OCEAN_STACKS[1]; // 180 deg: centre (-19, 0), radius 3.6, top 6.5

  it('a tower between the player on the seabed and the camera pulls the boom in; a steep pitch rises over it', () => {
    const out: { hard: number; soft: number; terrain?: number } = { hard: 0, soft: 0 };
    // the player stands 2.4 m from the cliff on the OUTER side (seabed); the camera boom points at the tower (+x)
    const px = T.x - T.radius - 2.4;
    boomCast(OCEAN_ARENA, px, 1.6, T.z, Math.cos(0.2), Math.sin(0.2), 0, 6.5, out);
    expect(out.terrain!).toBeLessThan(2.6);
    // pointing away from it nothing pulls in
    boomCast(OCEAN_ARENA, px, 1.6, T.z, -Math.cos(0.2), Math.sin(0.2), 0, 6.5, out);
    expect(out.terrain!).toBe(6.5);
  });

  it('the boom end never sinks into a tower or its ramps: 6000 booms from pivots around and on the towers keep the terrain margin', () => {
    const rng = mulberry32(0x7a77);
    const out: { hard: number; soft: number; terrain?: number } = { hard: 0, soft: 0 };
    let pulled = 0;
    for (let i = 0; i < 6000; i++) {
      const s = OCEAN_STACKS[i % OCEAN_STACKS.length];
      const a = rng() * Math.PI * 2;
      const r = rng() * (s.radius + 7);
      const ox = s.x + Math.cos(a) * r;
      const oz = s.z + Math.sin(a) * r;
      const oy = arenaGroundHeight(OCEAN_ARENA, ox, oz) + 1.6;
      const yaw = rng() * Math.PI * 2;
      const pitch = (rng() - 0.3) * 1.3;
      const cp = Math.cos(pitch);
      const dx = -Math.sin(yaw) * cp;
      const dy = Math.sin(pitch);
      const dz = -Math.cos(yaw) * cp;
      boomCast(OCEAN_ARENA, ox, oy, oz, dx, dy, dz, 6.5, out);
      const d = Math.min(6.5, out.terrain ?? 6.5);
      if (d < 6.5 - 1e-6) pulled++;
      for (let t = 0.3; t <= d; t += 0.25) expect(oy + dy * t, `boom ${i} t=${t.toFixed(2)}`).toBeGreaterThanOrEqual(arenaGroundHeight(OCEAN_ARENA, ox + dx * t, oz + dz * t) + MARGIN - 0.06);
    }
    expect(pulled).toBeGreaterThan(300);
  });

  it('the first-person eye floor on a tower top is the tower top (ground 6.5, eye floor 6.64 via renderGroundHeight)', () => {
    setRenderArena(OCEAN_ARENA);
    for (const s of OCEAN_STACKS) {
      expect(renderGroundHeight(s.x, s.z)).toBe(OCEAN_UPPER_HEIGHT);
      expect(renderGroundHeight(s.x + 2, s.z - 1)).toBe(OCEAN_UPPER_HEIGHT);
      // standing there the eye (1.6 m up) is far above the floor, and the glass is far above the eye
      const eyeY = OCEAN_UPPER_HEIGHT + 1.6;
      const R = domeRadius(OCEAN_ARENA);
      expect((s.x * s.x + s.z * s.z) / (R * R) + (eyeY * eyeY) / (DOME_HEIGHT * DOME_HEIGHT)).toBeLessThan(0.8);
    }
  });
});

describe('the old arenas are untouched', () => {
  it('colosseum + jungle: boomCast gives hard / soft exactly as before and terrain = the full boom (no pull-in)', () => {
    const rng = mulberry32(0xcafe);
    const out: { hard: number; soft: number; terrain?: number } = { hard: 0, soft: 0 };
    for (const arena of [COLOSSEUM_ARENA, JUNGLE_ARENA]) {
      for (let i = 0; i < 1500; i++) {
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
        boomCast(arena, ox, oy, oz, dx, dy, dz, max, out);
        expect(out.terrain).toBe(max);
        const plain: { hard: number; soft: number } = { hard: 0, soft: 0 };
        boomCast(arena, ox, oy, oz, dx, dy, dz, max, plain);
        expect(plain.hard).toBe(out.hard);
        expect(plain.soft).toBe(out.soft);
      }
    }
  });

  it('renderGroundHeight: 0 on the colosseum (even over the dais) and the jungle, the heightfield on the ocean', () => {
    setRenderArena(COLOSSEUM_ARENA);
    expect(renderGroundHeight(0, 0)).toBe(0);
    expect(renderGroundHeight(3, 2)).toBe(0);
    setRenderArena(JUNGLE_ARENA);
    expect(renderGroundHeight(5, 5)).toBe(0);
    setRenderArena(OCEAN_ARENA);
    expect(renderGroundHeight(0, 0)).toBe(3);
    expect(renderGroundHeight(14, 0)).toBe(1.5);
    expect(renderGroundHeight(27, 0)).toBe(0);
    for (const [x, z] of [[21.5, 0], [-3, 9], [11.2, 7.7]]) expect(renderGroundHeight(x, z)).toBe(arenaGroundHeight(OCEAN_ARENA, x, z));
  });
});
