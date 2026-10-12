/**
 * Camera vs terrain (v1.9 WP-O3), node-safe:
 *  - on the Ocean Dome the boom stays above the ground under it (ramps, terrace, plateau) and a cliff between the player and the
 *    camera pulls it in; a steeper pitch clears the same cliff (the wall-style squeeze assist handles the lift),
 *  - the camera the rig can reach never leaves the glass dome (ellipsoid radius wall + 2, height 22),
 *  - the colosseum and the jungle get exactly the old numbers (`out.terrain` = the full boom, hard / soft untouched),
 *  - the render-side ground height helper is 0 on the old arenas and the heightfield on the ocean.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { COLOSSEUM_ARENA, JUNGLE_ARENA, OCEAN_ARENA, arenaGroundHeight } from '../../src/config/arenas';
import { mulberry32 } from '../../src/core/math';
import { boomCast } from '../../src/render/CameraRig';
import { renderGroundHeight, setRenderArena } from '../../src/render/arenaContext';
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
    const out: { hard: number; soft: number; terrain?: number } = { hard: 0, soft: 0 };
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
      const d = Math.min(8.5, out.hard, out.terrain ?? 8.5);
      const cx = ox + dx * d;
      const cy = oy + dy * d;
      const cz = oz + dz * d;
      const e = (cx * cx + cz * cz) / (R * R) + (cy * cy) / (DOME_HEIGHT * DOME_HEIGHT);
      if (e > worst) worst = e;
      expect(e, `boom ${i}`).toBeLessThan(0.97);
    }
    expect(worst).toBeGreaterThan(0.3);
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
