import { describe, it, expect } from 'vitest';
import { meleeArcHit, isBehind, inFrontArc } from '../../src/sim/hitbox';
import { makeFighter } from './helpers';

describe('melee arc hit detection (§7.3)', () => {
  const range = 2.2;
  const arc = 120;
  const H = 2.2;

  it('hits a target within range and arc', () => {
    const a = makeFighter(0, 'lion', 0, 0, 0);
    const t = makeFighter(1, 'gorilla', 0, 2, 0);
    expect(meleeArcHit(a, t, range, arc, H)).toBe(true);
  });

  it('misses a target beyond range', () => {
    const a = makeFighter(0, 'lion', 0, 0, 0);
    const t = makeFighter(1, 'gorilla', 0, 3, 0);
    expect(meleeArcHit(a, t, range, arc, H)).toBe(false);
  });

  it('misses a target outside the arc half-angle', () => {
    const a = makeFighter(0, 'lion', 0, 0, 0);
    const t = makeFighter(1, 'gorilla', 2, 0, 0); // 90° to the side, arc/2 = 60°
    expect(meleeArcHit(a, t, range, arc, H)).toBe(false);
  });

  it('misses a target outside the vertical tolerance, giraffe reaches higher', () => {
    const a = makeFighter(0, 'lion', 0, 0, 0);
    const g = makeFighter(2, 'giraffe', 0, 0, 0);
    const t = makeFighter(1, 'gorilla', 0, 2, 0);
    t.state.pos.y = 3; // |Δy| = 3
    expect(meleeArcHit(a, t, range, arc, 2.2)).toBe(false);
    expect(meleeArcHit(g, t, 4.0, 140, 3.2)).toBe(true);
  });

  it('does not hit an untargetable (burrowed) target', () => {
    const a = makeFighter(0, 'lion', 0, 0, 0);
    const t = makeFighter(1, 'mole', 0, 2, 0);
    t.untargetable = true;
    expect(meleeArcHit(a, t, range, arc, H)).toBe(false);
  });

  it('facing helpers agree on front vs rear', () => {
    const t = makeFighter(1, 'gorilla', 0, 0, 0); // faces +Z
    expect(inFrontArc(t, 0, 2, 150)).toBe(true);
    expect(isBehind(t, 0, -2, 75)).toBe(true);
    expect(isBehind(t, 0, 2, 75)).toBe(false);
  });
});
