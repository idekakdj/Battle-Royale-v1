/**
 * v1.9 height field (docs/OCEAN-PLAN.md): `arenaGroundHeight` over plateau / ring / ramp pieces, the max-combination, the dais
 * (unchanged), arenaSlopeAt, arenaWalkableStep, arenaStepLimit, the cliff geometry (arenaNearestCliff / arenaCliffPush /
 * arenaCliffDistance) and arenaIsLevel.
 */

import { describe, it, expect } from 'vitest';
import type { ArenaDef, ElevationPiece } from '../../src/config/arenas';
import {
  ARENA_AIR_CLEARANCE,
  ARENA_MAX_RAMP_SLOPE,
  ARENA_SNAP_DOWN,
  ARENA_STEP_UP,
  COLOSSEUM_ARENA,
  JUNGLE_ARENA,
  OCEAN_ARENA,
  OCEAN_STACKS,
  arenaCanWalk,
  arenaCliffDistance,
  arenaCliffPush,
  arenaGroundHeight,
  arenaIsLevel,
  arenaNearestCliff,
  arenaSlopeAt,
  arenaSolidDistance,
  arenaStandable,
  arenaStepLimit,
  arenaWalkableStep,
  elevationPieceHeight,
} from '../../src/config/arenas';

/** A bare test arena (no solids) with the given pieces. */
function bare(pieces: readonly ElevationPiece[] | undefined): ArenaDef {
  return { ...OCEAN_ARENA, solids: [], circles: [], segments: [], crates: [], heightfield: pieces };
}

/**
 * A point on the Ocean Dome's plain ray (angle 308 degrees: no ramp and no tower from the centre to the wall; the v1.9 tests used the west
 * axis, which is a tower now): r = 20 is the seabed 1 m from the terrace rim (r = 19), r = 12 is the terrace, r = 0 the plateau.
 */
const oceanAt = (r: number): { x: number; z: number } => ({ x: r * Math.cos((308 * Math.PI) / 180), z: r * Math.sin((308 * Math.PI) / 180) });

describe('elevation: constants', () => {
  it('step-up 0.6 m (the dais), air clearance 0.05, snap-down 0.2, ramps <= 25 degrees', () => {
    expect(ARENA_STEP_UP).toBe(0.6);
    expect(COLOSSEUM_ARENA.dais?.height).toBe(ARENA_STEP_UP);
    expect(ARENA_AIR_CLEARANCE).toBe(0.05);
    expect(ARENA_SNAP_DOWN).toBe(0.2);
    expect(ARENA_MAX_RAMP_SLOPE).toBeCloseTo(Math.tan((25 * Math.PI) / 180), 12);
  });
});

describe('elevation: arenaGroundHeight', () => {
  it('arenas without a heightfield keep the v1.8 behaviour exactly (flat 0, the colosseum dais)', () => {
    expect(arenaGroundHeight(JUNGLE_ARENA, 5, 5)).toBe(0);
    expect(arenaGroundHeight(COLOSSEUM_ARENA, 0, 0)).toBe(0.6);
    expect(arenaGroundHeight(COLOSSEUM_ARENA, 3.99, 0)).toBe(0.6);
    expect(arenaGroundHeight(COLOSSEUM_ARENA, 4.01, 0)).toBe(0);
    expect(arenaGroundHeight(bare(undefined), 3, 4)).toBe(0);
    expect(arenaGroundHeight(bare([]), 3, 4)).toBe(0);
  });

  it('plateau: a disc at its height, inclusive at the rim, 0 outside', () => {
    const a = bare([{ kind: 'plateau', x: 2, z: -3, radius: 4, height: 1.25 }]);
    expect(arenaGroundHeight(a, 2, -3)).toBe(1.25);
    expect(arenaGroundHeight(a, 6, -3)).toBe(1.25); // exactly on the rim
    expect(arenaGroundHeight(a, 6.001, -3)).toBe(0);
    expect(arenaGroundHeight(a, 2, 1.1)).toBe(0);
    expect(arenaGroundHeight(a, 2, 0.9)).toBe(1.25);
  });

  it('ring: an annulus [rInner, rOuter] (both inclusive), 0 in the hole and outside', () => {
    const a = bare([{ kind: 'ring', x: 0, z: 0, rInner: 5, rOuter: 9, height: 2 }]);
    expect(arenaGroundHeight(a, 4.9, 0)).toBe(0);
    expect(arenaGroundHeight(a, 5, 0)).toBe(2);
    expect(arenaGroundHeight(a, 0, 7)).toBe(2);
    expect(arenaGroundHeight(a, -9, 0)).toBe(2);
    expect(arenaGroundHeight(a, 9.01, 0)).toBe(0);
  });

  it('ramp: oriented rectangle centred on (x,z), linear h0 -> h1 along (cos,sin)(dirDeg), nothing outside', () => {
    const a = bare([{ kind: 'ramp', x: 10, z: 20, dirDeg: 0, length: 8, width: 4, h0: 0, h1: 2 }]);
    expect(arenaGroundHeight(a, 6, 20)).toBeCloseTo(0, 9); // low end (centre - dir*4)
    expect(arenaGroundHeight(a, 10, 20)).toBeCloseTo(1, 9); // middle
    expect(arenaGroundHeight(a, 14, 20)).toBeCloseTo(2, 9); // high end
    expect(arenaGroundHeight(a, 12, 20)).toBeCloseTo(1.5, 9);
    expect(arenaGroundHeight(a, 12, 21.9)).toBeCloseTo(1.5, 9); // constant across the width
    expect(arenaGroundHeight(a, 12, 22.1)).toBe(0); // beyond the width
    expect(arenaGroundHeight(a, 14.1, 20)).toBe(0); // beyond the high end: nothing
    expect(arenaGroundHeight(a, 5.9, 20)).toBe(0); // beyond the low end
    // rotated 90 degrees: (cos,sin) = (0,1): rises toward +z
    const b = bare([{ kind: 'ramp', x: 0, z: 0, dirDeg: 90, length: 6, width: 2, h0: 1, h1: 4 }]);
    expect(arenaGroundHeight(b, 0, -3)).toBeCloseTo(1, 9);
    expect(arenaGroundHeight(b, 0, 0)).toBeCloseTo(2.5, 9);
    expect(arenaGroundHeight(b, 0.9, 3)).toBeCloseTo(4, 9);
    expect(arenaGroundHeight(b, 1.1, 0)).toBe(0);
    // a descending ramp (h0 > h1)
    const c = bare([{ kind: 'ramp', x: 0, z: 0, dirDeg: 180, length: 4, width: 2, h0: 2, h1: 0 }]);
    expect(arenaGroundHeight(c, 2, 0)).toBeCloseTo(2, 9); // the low end sits at centre - dir*2 = +x side
    expect(arenaGroundHeight(c, -2, 0)).toBeCloseTo(0, 9);
  });

  it('ramps keep the line of travel continuous: sampling along an axis never jumps by more than the grade allows', () => {
    const a = bare([{ kind: 'ramp', x: 0, z: 0, dirDeg: 37, length: 6, width: 6, h0: 0, h1: 1.5 }]);
    const c = Math.cos((37 * Math.PI) / 180);
    const s = Math.sin((37 * Math.PI) / 180);
    let prev = arenaGroundHeight(a, -c * 3, -s * 3);
    for (let t = -2.99; t <= 3; t += 0.01) {
      const h = arenaGroundHeight(a, c * t, s * t);
      expect(Math.abs(h - prev)).toBeLessThanOrEqual(0.25 * 0.01 + 1e-9);
      prev = h;
    }
  });

  it('the height is the MAX over the pieces (a ramp tucked under a plateau never lowers it) and combines with the dais', () => {
    const pieces: ElevationPiece[] = [
      { kind: 'plateau', x: 0, z: 0, radius: 6, height: 3 },
      { kind: 'ring', x: 0, z: 0, rInner: 4, rOuter: 12, height: 1.5 },
      { kind: 'ramp', x: 9, z: 0, dirDeg: 180, length: 6, width: 4, h0: 0, h1: 3 },
    ];
    const a = bare(pieces);
    expect(arenaGroundHeight(a, 0, 0)).toBe(3);
    expect(arenaGroundHeight(a, 5, 0)).toBe(3); // plateau beats ring
    expect(arenaGroundHeight(a, 7, 0)).toBeCloseTo(2.5, 9); // the ramp (3*(12-7)/6) beats the ring (1.5) here ...
    expect(arenaGroundHeight(a, 11, 0)).toBe(1.5); // ... and the ring beats the ramp's low part (0.5) there
    // order does not matter
    const rev = bare([...pieces].reverse());
    for (const [x, z] of [[0, 0], [5, 0], [7, 0], [10, 1], [11.9, 0], [20, 0], [-8, 3]]) {
      expect(arenaGroundHeight(a, x, z)).toBe(arenaGroundHeight(rev, x, z));
    }
    // dais + heightfield: the max of both
    const dais = { ...COLOSSEUM_ARENA, heightfield: [{ kind: 'plateau', x: 0, z: 0, radius: 2, height: 0.3 }] as ElevationPiece[] };
    expect(arenaGroundHeight(dais, 0, 0)).toBe(0.6);
    expect(arenaGroundHeight(dais, 3, 0)).toBe(0.6);
  });

  it('elevationPieceHeight is -Infinity outside a piece', () => {
    expect(elevationPieceHeight({ kind: 'plateau', x: 0, z: 0, radius: 1, height: 2 }, 5, 5)).toBe(-Infinity);
    expect(elevationPieceHeight({ kind: 'ring', x: 0, z: 0, rInner: 1, rOuter: 2, height: 2 }, 0, 0)).toBe(-Infinity);
    expect(elevationPieceHeight({ kind: 'ramp', x: 0, z: 0, dirDeg: 0, length: 2, width: 2, h0: 0, h1: 1 }, 0, 5)).toBe(-Infinity);
  });
});

describe('elevation: slope, walkable step, step limit', () => {
  const a = bare([
    { kind: 'plateau', x: 20, z: 0, radius: 6, height: 1.5 },
    { kind: 'ramp', x: 11, z: 0, dirDeg: 0, length: 6, width: 4, h0: 0, h1: 1.5 },
  ]);

  it('arenaSlopeAt: the ramp grade on a ramp, 0 on flat ground, on the plateau and outside', () => {
    expect(arenaSlopeAt(a, 11, 0)).toBeCloseTo(0.25, 9);
    expect(arenaSlopeAt(a, 20, 0)).toBe(0);
    expect(arenaSlopeAt(a, -5, 0)).toBe(0);
    expect(arenaSlopeAt(COLOSSEUM_ARENA, 0, 0)).toBe(0);
  });

  it('arenaWalkableStep: free on a ramp, free walking down, blocked at a cliff, blocked across a ridge', () => {
    expect(arenaWalkableStep(a, 6, 0, 17, 0)).toBe(true); // up the ramp onto the plateau
    expect(arenaWalkableStep(a, 17, 0, 6, 0)).toBe(true); // and back down
    expect(arenaWalkableStep(a, 30, 0, 14, 0)).toBe(false); // from outside straight at the plateau cliff (x 14..17 is plateau edge)
    expect(arenaWalkableStep(a, 14, 5, 16, 5)).toBe(true); // flat ground off the plateau (disc edge at x=14 only on z = 0)
    // a ridge in between two flat areas: both ends 0 but the line crosses a 1.5 cliff
    const ridge = bare([{ kind: 'ring', x: 0, z: 0, rInner: 4, rOuter: 5, height: 1.5 }]);
    expect(arenaWalkableStep(ridge, -8, 0, 8, 0)).toBe(false);
    // a low step (0.5 <= 0.6) is fine, 0.7 is not
    const low = bare([{ kind: 'plateau', x: 0, z: 0, radius: 3, height: 0.5 }]);
    const high = bare([{ kind: 'plateau', x: 0, z: 0, radius: 3, height: 0.7 }]);
    expect(arenaWalkableStep(low, -6, 0, 0, 0)).toBe(true);
    expect(arenaWalkableStep(high, -6, 0, 0, 0)).toBe(false);
    // fromHeight overrides the ground at A (a fighter whose feet are already 0.2 up): a 0.7 step is then +0.5
    expect(arenaWalkableStep(high, -3.1, 0, -2.9, 0)).toBe(false);
    expect(arenaWalkableStep(high, -3.1, 0, -2.9, 0, 0.2)).toBe(true);
  });

  it('arenaStepLimit: grounded = feet + 0.6; airborne never below feet + 0.05 nor below ground-under + 0.6', () => {
    expect(arenaStepLimit(0, 0)).toBeCloseTo(0.6, 12);
    expect(arenaStepLimit(1.5, 1.5)).toBeCloseTo(2.1, 12);
    // mid-jump 0.5 above the ground: ground + 0.6 (>= feet + 0.05)
    expect(arenaStepLimit(0.5, 0)).toBeCloseTo(0.6, 12);
    // at the apex of a 1.2 m jump: feet + 0.05
    expect(arenaStepLimit(1.2, 0)).toBeCloseTo(1.25, 12);
    // a stale y far below the ground now under the fighter (it was moved onto higher ground): feet + 0.6
    expect(arenaStepLimit(0, 3)).toBeCloseTo(0.6, 12);
  });

  it('arenaIsLevel: true only when the whole disc is on one height', () => {
    const o = OCEAN_ARENA;
    expect(arenaIsLevel(o, 0, 0, 2)).toBe(true); // plateau centre
    expect(arenaIsLevel(o, 0, 0, 6.5)).toBe(true);
    expect(arenaIsLevel(o, 0, 0, 7.6)).toBe(false); // reaches the ramps tucked under the plateau rim (conservative)
    expect(arenaIsLevel(o, 0, 0, 8.3)).toBe(false); // reaches the terrace
    expect(arenaIsLevel(o, oceanAt(14).x, oceanAt(14).z, 2)).toBe(true); // terrace
    expect(arenaIsLevel(o, oceanAt(18.5).x, oceanAt(18.5).z, 2)).toBe(false); // touches the terrace edge
    const top = OCEAN_STACKS[0];
    expect(arenaIsLevel(o, top.x, top.z, 1)).toBe(false); // (conservative: the terrace ring's outer edge, r = 19, runs through a tower's top)
    expect(arenaGroundHeight(o, top.x, top.z)).toBe(6.5); // ... although the top really is one flat level
    expect(arenaIsLevel(o, top.x, top.z, top.radius + 0.5)).toBe(false); // reaches past the rim
    const ramp = o.heightfield?.find((p) => p.kind === 'ramp') as Extract<ElevationPiece, { kind: 'ramp' }>;
    expect(arenaIsLevel(o, ramp.x, ramp.z, 1)).toBe(false); // on a ramp
    expect(arenaIsLevel(COLOSSEUM_ARENA, 0, 0, 3.5)).toBe(true);
    expect(arenaIsLevel(COLOSSEUM_ARENA, 0, 0, 4.5)).toBe(false); // dais edge
  });
});

describe('elevation: walkability helpers for the bots (arenaStandable / arenaCanWalk / arenaSolidDistance)', () => {
  const o = OCEAN_ARENA;
  it('arenaStandable: the dome floor yes; inside a cliff, a solid or the wall no', () => {
    const terracePad = o.pickupPads.find((p) => arenaGroundHeight(o, p.x, p.z) === 1.5) as { x: number; z: number };
    expect(arenaStandable(o, terracePad.x, terracePad.z, 1.2)).toBe(true); // terrace (a pad: cleared of cover)
    expect(arenaStandable(o, 0, 0, 1.2)).toBe(true); // plateau centre
    expect(arenaStandable(o, oceanAt(19.3).x, oceanAt(19.3).z, 1.2)).toBe(false); // seabed, 0.3 m from the terrace rim
    expect(arenaStandable(o, oceanAt(21).x, oceanAt(21).z, 1.2)).toBe(true);
    expect(arenaStandable(o, oceanAt(29.5).x, oceanAt(29.5).z, 1.2)).toBe(false); // wall
    expect(arenaStandable(o, OCEAN_STACKS[1].x, OCEAN_STACKS[1].z, 1.2)).toBe(true); // a tower top
    const rock = o.circles.find((c) => c.kind === 'rock') as (typeof o.circles)[number];
    expect(arenaStandable(o, rock.x, rock.z, 0.5)).toBe(false);
    expect(arenaStandable(o, rock.x, rock.z, 0.5, false)).toBe(true); // (cliff / wall only)
    expect(arenaSolidDistance(o, rock.x + rock.radius + 3, rock.z)).toBeLessThanOrEqual(3 + 1e-9);
  });
  it('arenaCanWalk: a ramp is walkable end to end, a straight line into the cliff is not, and walking down off the rim is', () => {
    const ramp = (o.heightfield as readonly ElevationPiece[]).find((p) => p.kind === 'ramp') as Extract<ElevationPiece, { kind: 'ramp' }>;
    const a = (ramp.dirDeg * Math.PI) / 180;
    const lowX = ramp.x - Math.cos(a) * (ramp.length / 2 + 2);
    const lowZ = ramp.z - Math.sin(a) * (ramp.length / 2 + 2);
    const topX = ramp.x + Math.cos(a) * (ramp.length / 2 + 2);
    const topZ = ramp.z + Math.sin(a) * (ramp.length / 2 + 2);
    expect(arenaCanWalk(o, lowX, lowZ, topX, topZ, 1.2)).toBe(true);
    expect(arenaCanWalk(o, topX, topZ, lowX, lowZ, 1.2)).toBe(true);
    const a22 = oceanAt(22);
    const a15 = oceanAt(15);
    expect(arenaCanWalk(o, a22.x, a22.z, a15.x, a15.z, 1.2)).toBe(false); // straight at the rim on the plain ray: no ramp
    expect(arenaWalkableStep(o, oceanAt(18.5).x, oceanAt(18.5).z, oceanAt(21).x, oceanAt(21).z)).toBe(true); // stepping DOWN off the rim is free ...
    expect(arenaCanWalk(o, oceanAt(21).x, oceanAt(21).z, oceanAt(25).x, oceanAt(25).z, 1.2)).toBe(true); // ... (the 1.2 m band at the cliff foot is not standable: you land there and are pushed clear)
    expect(arenaCanWalk(o, oceanAt(19.3).x, oceanAt(19.3).z, oceanAt(21).x, oceanAt(21).z, 1.2)).toBe(false); // (that band)
    expect(arenaCanWalk(o, 0, 0, 1.5, 0, 1.2)).toBe(true); // across the flat plateau
    // and nobody walks straight up a tower from the seabed or the terrace
    const tower = OCEAN_STACKS[2];
    expect(arenaCanWalk(o, oceanAt(26).x, oceanAt(26).z, tower.x, tower.z, 1.2, false)).toBe(false);
    expect(arenaCanWalk(COLOSSEUM_ARENA, -20, 0, 20, 8, 1.2, false)).toBe(true); // flat arena: just the wall
  });
});

describe('elevation: cliff geometry (arenaNearestCliff / arenaCliffPush / arenaCliffDistance)', () => {
  const hit = { d: 0, nx: 0, nz: 0 };

  it('plateau: signed distance to the edge, outward normal; nothing when the piece is not above the limit', () => {
    const a = bare([{ kind: 'plateau', x: 0, z: 0, radius: 5, height: 2 }]);
    expect(arenaNearestCliff(a, 8, 0, 0.6, hit)).toBe(true);
    expect(hit.d).toBeCloseTo(3, 9);
    expect(hit.nx).toBeCloseTo(1, 9);
    expect(hit.nz).toBeCloseTo(0, 9);
    expect(arenaNearestCliff(a, 1, 0, 0.6, hit)).toBe(true);
    expect(hit.d).toBeCloseTo(-4, 9); // inside
    expect(arenaNearestCliff(a, 8, 0, 2, hit)).toBe(false); // limit = the top: nothing is higher
    expect(arenaNearestCliff(bare(undefined), 8, 0, 0.6, hit)).toBe(false);
  });

  it('ring: outer edge, and the hole counts as outside (inner edge normal points to the centre)', () => {
    const a = bare([{ kind: 'ring', x: 0, z: 0, rInner: 4, rOuter: 8, height: 2 }]);
    arenaNearestCliff(a, 10, 0, 0, hit);
    expect(hit.d).toBeCloseTo(2, 9);
    expect(hit.nx).toBeCloseTo(1, 9);
    arenaNearestCliff(a, 2, 0, 0, hit);
    expect(hit.d).toBeCloseTo(2, 9); // 4 - 2
    expect(hit.nx).toBeCloseTo(-1, 9);
    arenaNearestCliff(a, 6.5, 0, 0, hit); // inside the body, nearer the outer edge
    expect(hit.d).toBeCloseTo(-1.5, 9);
    expect(hit.nx).toBeCloseTo(1, 9);
  });

  it('ramp: only the part ABOVE the limit counts (a fighter climbing a ramp sees 0.6 m of rise ahead, never a wall)', () => {
    const a = bare([{ kind: 'ramp', x: 0, z: 0, dirDeg: 0, length: 6, width: 4, h0: 0, h1: 1.5 }]);
    // limit 0.6: the region starts where the ramp is 0.6 high: t = 2.4 from the low end = x = -0.6
    arenaNearestCliff(a, -3, 0, 0.6, hit);
    expect(hit.d).toBeCloseTo(2.4, 9);
    expect(hit.nx).toBeCloseTo(-1, 9);
    // a fighter climbing the ramp always sees the 0.6 m of rise 2.4 m ahead (0.6 / grade 0.25), as long as the ramp top is still above its limit
    for (const x of [-3, -2.5, -1, 0, 0.5]) expect(arenaCliffDistance(a, x, 0)).toBeCloseTo(2.4, 9);
    expect(arenaCliffDistance(a, 0.7, 0)).toBe(Infinity); // the last 0.6 m of rise: nothing higher
    expect(arenaCliffDistance(a, -2, 0)).toBeCloseTo(2.4, 9); // feet 0.25, region from height 0.85 => t = 3.4 => x = 0.4 => d = 2.4
    expect(arenaCliffDistance(a, 0, 0)).toBeCloseTo(2.4, 9); // feet 0.75 => limit 1.35 => t = 5.4 => x = 2.4
    // sides: a point beside the ramp at the seabed sees the wall of the upper part (region starts at t = 2.4, width 4)
    arenaNearestCliff(a, 1, 4, 0.6, hit);
    expect(hit.d).toBeCloseTo(2, 9); // 4 - 2 (half width)
    expect(hit.nz).toBeCloseTo(1, 9);
  });

  it('arenaCliffPush: leaves a clear body alone; pushes a touching body out along the normal; two settling passes', () => {
    const a = bare([{ kind: 'plateau', x: 0, z: 0, radius: 5, height: 2 }]);
    const out = { x: 0, z: 0 };
    expect(arenaCliffPush(a, 9, 0, 1.2, 0.6, out)).toBe(false);
    expect(out).toEqual({ x: 9, z: 0 });
    expect(arenaCliffPush(a, 5.5, 0, 1.2, 0.6, out)).toBe(true);
    expect(out.x).toBeCloseTo(6.2, 9);
    expect(out.z).toBeCloseTo(0, 9);
    // diagonal: the push is along the radius, so a body sliding at 45 degrees keeps its tangential part
    expect(arenaCliffPush(a, 4, 4, 1, 0.6, out)).toBe(true);
    expect(Math.hypot(out.x, out.z)).toBeCloseTo(6, 9);
    expect(out.x).toBeCloseTo(out.z, 9);
    // a limit above the plateau: no push at all
    expect(arenaCliffPush(a, 4, 4, 1, 2.1, out)).toBe(false);
  });

  it('arenaCliffDistance default feet = the ground at the point', () => {
    const o = OCEAN_ARENA;
    const p20 = oceanAt(20);
    const p12 = oceanAt(12);
    expect(arenaCliffDistance(o, p20.x, p20.z)).toBeCloseTo(1, 6); // seabed, 1 m from the terrace rim at r = 19
    expect(arenaCliffDistance(o, p12.x, p12.z)).toBeLessThanOrEqual(4 + 1e-6); // terrace: the plateau (r 8, 4 m away) or a ramp flank is the next cliff
    expect(arenaCliffDistance(o, p12.x, p12.z)).toBeGreaterThan(1.5);
    expect(arenaCliffDistance(o, 0, 0)).toBeGreaterThan(5); // plateau: only the towers' causeways (3+ m higher, 6+ m away) are higher
    expect(arenaCliffDistance(o, OCEAN_STACKS[0].x, OCEAN_STACKS[0].z)).toBe(Infinity); // a tower top: nothing higher
    // feet at 3.0 on the terrace: the plateau top is within the step limit, so only the causeways / towers still count (farther away)
    expect(arenaCliffDistance(o, p12.x, p12.z, 3)).toBeGreaterThanOrEqual(arenaCliffDistance(o, p12.x, p12.z));
  });
});
