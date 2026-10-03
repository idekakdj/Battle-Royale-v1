import { describe, expect, it } from 'vitest';
import type { AnimalId } from '../../src/core/types';
import type { ArchetypeId, CharacterStats, MoveBody, MoveId } from '../../src/brawl/types';
import { MOVE_IDS, STAGE_IDS } from '../../src/brawl/types';
import { PHYS } from '../../src/brawl/config';
import {
  MAX_MOVE_FRAMES,
  MOVESETS,
  STAGES,
  bodyKillPercent,
  bodyReach,
  getMoveBody,
  getMoveset,
  getStage,
  groupsOf,
  hitsOf,
  movingOffset,
  platformAt,
  powerIndex,
  ratings,
  simulateRecovery,
  totalFrames,
  victimDamage,
} from '../../src/brawl/data';

const ANIMALS: AnimalId[] = ['lion', 'gorilla', 'crocodile', 'hippo', 'rhino', 'eagle', 'panther', 'python', 'giraffe', 'mole'];

const ARCHETYPES: readonly ArchetypeId[] = [
  'swipe', 'rake', 'jab', 'uppercut', 'backhand', 'bite', 'lunge', 'headbutt', 'hornUp', 'tailWhip', 'spinAttack',
  'stomp', 'slam', 'kick', 'wingBuffet', 'dive', 'leapUp', 'charge', 'burrow', 'roar', 'tether', 'neckSwing', 'bellyFlop',
];

/** Plan §3 slot budgets: [startup, active, recovery] ranges and damage band (per victim, per move / chain hit). */
const BUDGET: Record<MoveId, { su: [number, number]; act: [number, number]; rec: [number, number]; dmg: [number, number]; heavy: boolean }> = {
  lightN: { su: [4, 7], act: [2, 3], rec: [8, 14], dmg: [3, 5], heavy: false },
  lightS: { su: [6, 10], act: [3, 4], rec: [12, 18], dmg: [6, 9], heavy: false },
  lightD: { su: [5, 9], act: [3, 4], rec: [11, 17], dmg: [5, 8], heavy: false },
  lightU: { su: [6, 10], act: [3, 4], rec: [12, 18], dmg: [6, 9], heavy: false },
  heavyN: { su: [12, 22], act: [3, 6], rec: [20, 32], dmg: [10, 16], heavy: true },
  heavyS: { su: [14, 26], act: [3, 6], rec: [22, 34], dmg: [14, 22], heavy: true },
  heavyD: { su: [12, 22], act: [3, 6], rec: [20, 32], dmg: [12, 18], heavy: true },
  heavyU: { su: [6, 14], act: [8, 24], rec: [18, 30], dmg: [7, 12], heavy: true },
};

/** Plan §3.1 roster table (the data may deviate by at most ±15 % after the WP-T balance pass). */
const PLAN: Record<AnimalId, Partial<CharacterStats> & { weight: number }> = {
  lion: { weight: 100, walkSpeed: 4.6, runSpeed: 8.6, airSpeed: 6.6, jumpVel: 14.5, airJumpVel: 13.0, maxJumps: 2, gravityMult: 1.0, fallSpeed: 18, fastFallSpeed: 26, width: 1.1, height: 1.5 },
  gorilla: { weight: 125, walkSpeed: 3.8, runSpeed: 7.2, airSpeed: 5.4, jumpVel: 13.5, airJumpVel: 12.0, maxJumps: 2, gravityMult: 1.1, fallSpeed: 19, fastFallSpeed: 27, width: 1.5, height: 2.0 },
  crocodile: { weight: 115, walkSpeed: 3.6, runSpeed: 7.0, airSpeed: 5.0, jumpVel: 12.5, airJumpVel: 11.5, maxJumps: 2, gravityMult: 1.15, fallSpeed: 21, fastFallSpeed: 28, width: 2.0, height: 1.0 },
  hippo: { weight: 140, walkSpeed: 3.2, runSpeed: 6.2, airSpeed: 4.6, jumpVel: 12.5, airJumpVel: 11.0, maxJumps: 2, gravityMult: 1.2, fallSpeed: 22, fastFallSpeed: 29, width: 1.8, height: 1.5 },
  rhino: { weight: 130, walkSpeed: 3.6, runSpeed: 7.6, airSpeed: 5.0, jumpVel: 13.0, airJumpVel: 11.5, maxJumps: 2, gravityMult: 1.15, fallSpeed: 21, fastFallSpeed: 28, width: 1.9, height: 1.7 },
  eagle: { weight: 78, walkSpeed: 5.2, runSpeed: 9.4, airSpeed: 8.0, jumpVel: 15.0, airJumpVel: 13.5, maxJumps: 4, gravityMult: 0.8, fallSpeed: 14, fastFallSpeed: 24, glideFall: 6.5, width: 1.0, height: 1.2 },
  panther: { weight: 90, walkSpeed: 5.0, runSpeed: 9.8, airSpeed: 7.0, jumpVel: 15.0, airJumpVel: 13.5, maxJumps: 2, gravityMult: 0.95, fallSpeed: 18, fastFallSpeed: 27, width: 1.1, height: 1.3 },
  python: { weight: 85, walkSpeed: 3.9, runSpeed: 7.0, airSpeed: 5.8, jumpVel: 13.5, airJumpVel: 12.5, maxJumps: 2, gravityMult: 0.9, fallSpeed: 16, fastFallSpeed: 24, width: 1.5, height: 1.0 },
  giraffe: { weight: 98, walkSpeed: 4.2, runSpeed: 7.8, airSpeed: 6.0, jumpVel: 14.0, airJumpVel: 12.5, maxJumps: 2, gravityMult: 1.0, fallSpeed: 18.5, fastFallSpeed: 26, width: 1.0, height: 2.6 },
  mole: { weight: 72, walkSpeed: 5.0, runSpeed: 8.8, airSpeed: 6.4, jumpVel: 14.0, airJumpVel: 12.5, maxJumps: 2, gravityMult: 0.95, fallSpeed: 17, fastFallSpeed: 25, width: 0.8, height: 0.8 },
};

const THREE_HIT: AnimalId[] = ['lion', 'eagle', 'panther', 'mole'];
const SPIKE_AIR_HEAVY_D: AnimalId[] = ['lion', 'gorilla', 'crocodile', 'hippo', 'rhino', 'eagle', 'giraffe'];

interface NamedBody {
  animal: AnimalId;
  id: MoveId;
  label: string;
  body: MoveBody;
  kind: 'ground' | 'air' | 'chain';
}

/** Every distinct body the sim can run: ground, merged air form, chain links. */
function allBodies(): NamedBody[] {
  const out: NamedBody[] = [];
  for (const a of ANIMALS) {
    for (const id of MOVE_IDS) {
      out.push({ animal: a, id, label: `${a}.${id}`, body: getMoveBody(a, id, false), kind: 'ground' });
      out.push({ animal: a, id, label: `${a}.${id}(air)`, body: getMoveBody(a, id, true), kind: 'air' });
      const chain = MOVESETS[a].moves[id].chain ?? [];
      chain.forEach((_, i) => out.push({ animal: a, id, label: `${a}.${id}[chain ${i + 1}]`, body: getMoveBody(a, id, false, i + 1), kind: 'chain' }));
    }
  }
  return out;
}

const finite = (v: unknown): boolean => typeof v === 'number' && Number.isFinite(v);

function numbersOf(o: unknown, path = ''): { path: string; value: unknown }[] {
  const out: { path: string; value: unknown }[] = [];
  if (typeof o === 'number') out.push({ path, value: o });
  else if (Array.isArray(o)) o.forEach((v, i) => out.push(...numbersOf(v, `${path}[${i}]`)));
  else if (o && typeof o === 'object') for (const [k, v] of Object.entries(o)) out.push(...numbersOf(v, `${path}.${k}`));
  return out;
}

describe('registry', () => {
  it('has all ten animals, each with all eight moves', () => {
    expect(Object.keys(MOVESETS).sort()).toEqual([...ANIMALS].sort());
    for (const a of ANIMALS) {
      const set = getMoveset(a);
      expect(set).toBe(MOVESETS[a]);
      expect(set.animal).toBe(a);
      expect(set.tagline.length).toBeGreaterThan(20);
      expect(Object.keys(set.moves).sort()).toEqual([...MOVE_IDS].sort());
      for (const id of MOVE_IDS) {
        expect(set.moves[id].id).toBe(id);
        expect(set.moves[id].ground.name.length).toBeGreaterThan(2);
      }
    }
  });

  it('getMoveBody applies the air partial, chain bodies and falls back safely', () => {
    for (const a of ANIMALS) {
      for (const id of MOVE_IDS) {
        const m = MOVESETS[a].moves[id];
        const g = getMoveBody(a, id, false);
        expect(g).toBe(m.ground);
        const ar = getMoveBody(a, id, true);
        expect(ar.hitboxes.length).toBeGreaterThan(0);
        expect(ar.landingLag).toBe(m.air?.landingLag);
        expect(g.landingLag).toBeUndefined();
        for (let c = 1; c <= (m.chain?.length ?? 0); c++) expect(getMoveBody(a, id, false, c)).toBe(m.chain![c - 1]);
        // out-of-range chain index never throws; it degrades to the base body
        expect(getMoveBody(a, id, false, 9)).toBe(m.ground);
      }
    }
  });

  it('every move has the shape the plan demands', () => {
    for (const nb of allBodies()) {
      const b = nb.body;
      expect(ARCHETYPES, nb.label).toContain(b.archetype);
      expect(typeof b.anim?.look, `${nb.label} anim.look`).toBe('string');
      expect(typeof b.anim?.limb, `${nb.label} anim.limb`).toBe('string');
      expect(b.name.length, nb.label).toBeGreaterThan(2);
      expect(b.hitboxes.length, nb.label).toBeGreaterThan(0);
    }
  });
});

describe('frame budgets (plan §3)', () => {
  it('every body respects the slot startup / active / recovery ranges and the 62-frame cap', () => {
    for (const nb of allBodies()) {
      const bud = BUDGET[nb.id];
      const b = nb.body;
      expect(b.startup, `${nb.label} startup`).toBeGreaterThanOrEqual(bud.su[0]);
      expect(b.startup, `${nb.label} startup`).toBeLessThanOrEqual(bud.su[1]);
      expect(b.active, `${nb.label} active`).toBeGreaterThanOrEqual(bud.act[0]);
      expect(b.active, `${nb.label} active`).toBeLessThanOrEqual(bud.act[1]);
      expect(b.recovery, `${nb.label} recovery`).toBeGreaterThanOrEqual(bud.rec[0]);
      expect(b.recovery, `${nb.label} recovery`).toBeLessThanOrEqual(bud.rec[1]);
      expect(totalFrames(b), `${nb.label} total`).toBeLessThanOrEqual(MAX_MOVE_FRAMES);
    }
  });

  it('damage stays inside the slot bands (per victim; chain hits 3-5 and chain totals 9-14)', () => {
    for (const nb of allBodies()) {
      const [lo, hi] = BUDGET[nb.id].dmg;
      const d = victimDamage(nb.body);
      if (nb.id === 'lightN') {
        expect(d.base, nb.label).toBeGreaterThanOrEqual(3);
        expect(d.max, nb.label).toBeLessThanOrEqual(5);
      } else {
        expect(d.base, `${nb.label} base damage`).toBeGreaterThanOrEqual(lo);
        expect(d.max, `${nb.label} max (sweetspot) damage`).toBeLessThanOrEqual(hi);
      }
    }
    for (const a of ANIMALS) {
      const m = MOVESETS[a].moves.lightN;
      const total = [m.ground, ...(m.chain ?? [])].reduce((s, b) => s + victimDamage(b).base, 0);
      expect(total, `${a} lightN chain total`).toBeGreaterThanOrEqual(9);
      expect(total, `${a} lightN chain total`).toBeLessThanOrEqual(14);
    }
  });

  it('knockback numbers stay in the plan ranges (light 5-9 / 4-12, heavy 9-15 / 16-34)', () => {
    for (const nb of allBodies()) {
      const heavy = BUDGET[nb.id].heavy;
      for (const h of nb.body.hitboxes) {
        const special = h.effect === 'pull' || h.effect === 'bury' || h.effect === 'stun' || h.multiHitInterval !== undefined;
        const [bLo, bHi, gLo, gHi] = heavy ? [9, 15, 16, 34] : [5, 9, 4, 12];
        // upper bounds always; lower bounds not for pulling / burying / stunning / multi-hit ticks (their knockback is replaced or tiny)
        expect(h.baseKb, `${nb.label} baseKb`).toBeLessThanOrEqual(bHi);
        expect(h.kbGrowth, `${nb.label} kbGrowth`).toBeLessThanOrEqual(gHi);
        if (!special) {
          expect.soft(h.baseKb, `${nb.label} baseKb`).toBeGreaterThanOrEqual(bLo);
          expect.soft(h.kbGrowth, `${nb.label} kbGrowth`).toBeGreaterThanOrEqual(gLo);
        }
      }
    }
  });

  it('all numbers are finite', () => {
    for (const a of ANIMALS) {
      for (const n of numbersOf(MOVESETS[a])) expect(finite(n.value), `${a}${n.path}`).toBe(true);
    }
  });
});

describe('hitboxes, motion, armor, cancels', () => {
  it('hitboxes live inside the active window and are well formed', () => {
    for (const nb of allBodies()) {
      const b = nb.body;
      const a0 = b.startup;
      const a1 = b.startup + b.active;
      const grouped = b.hitboxes.filter((h) => h.group !== undefined).length;
      expect(grouped === 0 || grouped === b.hitboxes.length, `${nb.label}: group set on all boxes or none`).toBe(true);
      b.hitboxes.forEach((h, i) => {
        const l = `${nb.label} hitbox ${i}`;
        expect(h.from, l).toBeGreaterThanOrEqual(a0);
        expect(h.to, l).toBeLessThanOrEqual(a1);
        expect(h.from, l).toBeLessThan(h.to);
        if (h.shape === 'circle') expect(h.r, l).toBeGreaterThan(0);
        else {
          expect(h.w, l).toBeGreaterThan(0);
          expect(h.h, l).toBeGreaterThan(0);
        }
        expect(h.damage, l).toBeGreaterThan(0);
        expect(h.angle, l).toBeGreaterThanOrEqual(0);
        expect(h.angle, l).toBeLessThan(360);
        if (h.multiHitInterval !== undefined) {
          expect(h.multiHitInterval, l).toBeGreaterThanOrEqual(2);
          expect(hitsOf(h), l).toBeLessThanOrEqual(4);
        }
        if (h.sweet) {
          expect(h.sweet.damageMult, l).toBeGreaterThan(1);
          expect(h.sweet.damageMult, l).toBeLessThanOrEqual(1.5);
          expect(h.sweet.kbMult, l).toBeGreaterThanOrEqual(1);
          expect(h.sweet.kbMult, l).toBeLessThanOrEqual(1.3);
          // the sweetspot is tested against the victim's CENTRE, so it sits within the box expanded by a victim half-width
          const dx = Math.abs(h.sweet.x - h.x);
          const dy = Math.abs(h.sweet.y - h.y);
          if (h.shape === 'circle') expect(Math.hypot(dx, dy), `${l} sweetspot inside`).toBeLessThanOrEqual(h.r + 0.6 + 1e-9);
          else {
            expect(dx, `${l} sweetspot inside`).toBeLessThanOrEqual(h.w / 2 + 0.6 + 1e-9);
            expect(dy, `${l} sweetspot inside`).toBeLessThanOrEqual(h.h / 2 + 0.6 + 1e-9);
          }
        }
        if (h.path) {
          expect(h.path.length, l).toBeGreaterThanOrEqual(2);
          expect(h.path[0].frame, l).toBe(h.from);
          for (let k = 1; k < h.path.length; k++) {
            expect(h.path[k].frame, l).toBeGreaterThan(h.path[k - 1].frame);
            expect(h.path[k].frame, l).toBeLessThanOrEqual(h.to);
          }
        }
      });
    }
  });

  it('motion windows, armor and invulnerability windows are valid', () => {
    for (const nb of allBodies()) {
      const b = nb.body;
      const total = totalFrames(b);
      for (const m of b.motion ?? []) {
        expect(m.from, nb.label).toBeGreaterThanOrEqual(0);
        expect(m.to, nb.label).toBeGreaterThan(m.from);
        expect(m.to, nb.label).toBeLessThanOrEqual(total);
        expect(Math.abs(m.vx ?? 0), nb.label).toBeLessThanOrEqual(20);
        expect(Math.abs(m.vy ?? 0), nb.label).toBeLessThanOrEqual(20);
      }
      if (b.armor) {
        expect(b.armor.from, nb.label).toBeGreaterThanOrEqual(0);
        expect(b.armor.to, nb.label).toBeGreaterThan(b.armor.from);
        expect(b.armor.to, nb.label).toBeLessThanOrEqual(total);
        expect(b.armor.hits, nb.label).toBeGreaterThanOrEqual(1);
        expect(b.armor.dmgScale ?? 1, nb.label).toBeLessThanOrEqual(1);
      }
      if (b.invuln) {
        expect(b.invuln.from, nb.label).toBeGreaterThanOrEqual(0);
        expect(b.invuln.to, nb.label).toBeGreaterThan(b.invuln.from);
        expect(b.invuln.to, nb.label).toBeLessThanOrEqual(total);
      }
    }
  });

  it('armor only on gorilla / hippo / rhino heavies; invulnerability only on the panther (Shadow Dash, Shadow Leap)', () => {
    for (const nb of allBodies()) {
      if (nb.body.armor) {
        expect(['gorilla', 'hippo', 'rhino'], `${nb.label} armor`).toContain(nb.animal);
        expect(BUDGET[nb.id].heavy, `${nb.label} armor on a heavy`).toBe(true);
      }
      if (nb.body.invuln) {
        expect(nb.animal, `${nb.label} invuln`).toBe('panther');
        expect(['heavyS', 'heavyU']).toContain(nb.id);
      }
    }
    for (const a of ['gorilla', 'hippo', 'rhino'] as const) {
      expect(MOVE_IDS.some((id) => MOVESETS[a].moves[id].ground.armor), `${a} has an armored heavy`).toBe(true);
    }
    expect(getMoveBody('gorilla', 'heavyS', false).armor).toBeDefined();
    expect(getMoveBody('hippo', 'heavyN', false).armor).toBeDefined();
    expect(getMoveBody('rhino', 'heavyS', false).armor).toBeDefined();
    expect(getMoveBody('panther', 'heavyS', false).invuln).toBeDefined();
    expect(getMoveBody('panther', 'heavyU', false).invuln).toBeDefined();
  });

  it('light-neutral strings: 3 hits for lion/eagle/panther/mole, 2 for the rest, with valid cancels and true-combo timing', () => {
    for (const a of ANIMALS) {
      const m = MOVESETS[a].moves.lightN;
      const links = m.chain ?? [];
      expect(links.length, `${a} chain length`).toBe(THREE_HIT.includes(a) ? 2 : 1);
      const bodies = [m.ground, ...links];
      bodies.forEach((b, i) => {
        const l = `${a} lightN link ${i}`;
        const last = i === bodies.length - 1;
        const cancels = b.cancels ?? [];
        if (last) {
          expect(cancels.filter((c) => c.into.includes('lightN')), `${l} (last) continues`).toHaveLength(0);
          return;
        }
        const c = cancels.find((x) => x.into.includes('lightN'));
        expect(c, `${l} has a cancel into lightN`).toBeDefined();
        expect(c!.from, l).toBeLessThan(c!.to);
        expect(c!.from, l).toBeGreaterThanOrEqual(b.startup);
        expect(c!.to, l).toBeLessThanOrEqual(totalFrames(b));
        expect(c!.onHitOnly, `${l} onHitOnly`).toBe(i > 0);
        // true combo from 0 % on a mid-weight target: hitstun must outlast (cancel window start + 3 frames of input
        // latency − first active frame) + the next link's startup.
        const hit = b.hitboxes[0];
        const next = bodies[i + 1];
        const gap = c!.from + 3 - hit.from + next.startup;
        const kb = hit.baseKb + (hit.kbGrowth * hit.damage) / 100;
        const stun = Math.max(6, Math.min(60, Math.floor(kb * PHYS.hitstunPerKb * (hit.hitstunScale ?? 1))));
        expect(stun, `${l}: hitstun ${stun} must outlast the follow-up gap ${gap}`).toBeGreaterThan(gap);
        // …and still hold against a heavy (weight 130) target with no input latency
        const stunHeavy = Math.max(6, Math.min(60, Math.floor(kb * (100 / 130) * PHYS.hitstunPerKb * (hit.hitstunScale ?? 1))));
        expect(stunHeavy, `${l}: heavy target`).toBeGreaterThan(c!.from - hit.from + next.startup);
      });
    }
  });

  it('every move has an aerial form with landing lag and a valid auto-cancel window', () => {
    for (const a of ANIMALS) {
      for (const id of MOVE_IDS) {
        const m = MOVESETS[a].moves[id];
        const l = `${a}.${id}`;
        expect(m.air, `${l} has an air form`).not.toBeNull();
        const b = getMoveBody(a, id, true);
        const lag = b.landingLag ?? -1;
        const [lo, hi] = BUDGET[id].heavy ? [14, 26] : [6, 12];
        expect(lag, `${l} landingLag`).toBeGreaterThanOrEqual(lo);
        expect(lag, `${l} landingLag`).toBeLessThanOrEqual(hi);
        expect(b.autoCancel, `${l} autoCancel`).toBeDefined();
        expect(b.autoCancel!.from, l).toBeLessThan(b.autoCancel!.to);
        expect(b.autoCancel!.from, l).toBeGreaterThanOrEqual(b.startup);
        expect(b.autoCancel!.to, l).toBeLessThanOrEqual(totalFrames(b));
      }
    }
  });

  it('required effects: spikes, pulls, bury, flinch, stun', () => {
    const fx = (a: AnimalId, id: MoveId, airForm: boolean) =>
      getMoveBody(a, id, airForm).hitboxes.map((h) => h.effect ?? 'none');
    for (const a of SPIKE_AIR_HEAVY_D) {
      expect(fx(a, 'heavyD', true), `${a} air heavyD spikes`).toContain('spike');
      expect(fx(a, 'heavyD', false), `${a} ground heavyD does not spike`).not.toContain('spike');
      const spike = getMoveBody(a, 'heavyD', true).hitboxes.find((h) => h.effect === 'spike')!;
      expect(spike.angle, `${a} spike angle points down`).toBeGreaterThanOrEqual(250);
      expect(spike.angle).toBeLessThanOrEqual(320);
    }
    expect(fx('crocodile', 'heavyN', false)).toContain('pull');
    expect(fx('python', 'heavyN', false)).toContain('pull');
    expect(fx('python', 'heavyN', false)).toContain('stun');
    expect(fx('mole', 'heavyD', false)).toContain('bury');
    expect(fx('lion', 'heavyN', false)).toContain('flinch');
    // nobody else spikes by accident
    for (const nb of allBodies()) {
      if (nb.body.hitboxes.some((h) => h.effect === 'spike')) {
        expect(nb.id, nb.label).toBe('heavyD');
        expect(nb.kind, nb.label).toBe('air');
        expect(SPIKE_AIR_HEAVY_D, nb.label).toContain(nb.animal);
      }
    }
  });

  it('kill moves carry sweetspots (jaws, beak tip, neck tip)', () => {
    expect(getMoveBody('lion', 'heavyS', false).hitboxes.some((h) => h.sweet)).toBe(true);
    expect(getMoveBody('crocodile', 'heavyS', false).hitboxes.some((h) => h.sweet)).toBe(true);
    expect(getMoveBody('eagle', 'heavyS', false).hitboxes.some((h) => h.sweet)).toBe(true);
    expect(getMoveBody('giraffe', 'heavyS', false).hitboxes.some((h) => h.sweet)).toBe(true);
    expect(getMoveBody('giraffe', 'heavyN', false).hitboxes.some((h) => h.sweet)).toBe(true);
    expect(getMoveBody('python', 'heavyS', false).hitboxes.some((h) => h.sweet)).toBe(true);
  });
});

describe('recovery (heavyU)', () => {
  it('travels upward on every animal', () => {
    for (const a of ANIMALS) {
      const b = getMoveBody(a, 'heavyU', false);
      expect(b.motion?.length ?? 0, `${a} heavyU motion`).toBeGreaterThan(0);
      expect(b.motion!.some((m) => (m.vy ?? 0) > 0), `${a} heavyU rises`).toBe(true);
      const r = simulateRecovery(b, MOVESETS[a].stats);
      expect(r.peak, `${a} peak`).toBeGreaterThan(1.5);
      // net upward travel inside the motion windows (the move's tail end then free-falls)
      const rise = b.motion!.reduce((s, m) => s + ((m.set ? m.vy ?? 0 : 0) * (m.to - m.from)) / 60, 0);
      expect(rise, `${a} net upward travel`).toBeGreaterThan(1.0);
      expect(r.peak, `${a} peak above the start`).toBeGreaterThan(r.dy);
      // usable on the ground too: the air form keeps the same motion
      expect(getMoveBody(a, 'heavyU', true).motion).toEqual(b.motion);
    }
  });

  it('recovery ordering: eagle > panther ~ lion ~ giraffe ~ mole > python > crocodile ~ rhino ~ gorilla > hippo', () => {
    const score = (a: AnimalId): number => simulateRecovery(getMoveBody(a, 'heavyU', false), MOVESETS[a].stats).score;
    const mean = (xs: number[]): number => xs.reduce((s, v) => s + v, 0) / xs.length;
    const top = (['panther', 'lion', 'giraffe', 'mole'] as const).map(score);
    const low = (['crocodile', 'rhino', 'gorilla'] as const).map(score);
    for (const s of top) expect(Math.abs(s / mean(top) - 1)).toBeLessThan(0.12);
    for (const s of low) expect(Math.abs(s / mean(low) - 1)).toBeLessThan(0.12);
    expect(score('eagle')).toBeGreaterThan(Math.max(...top) * 1.25);
    expect(Math.min(...top)).toBeGreaterThan(score('python') * 1.08);
    expect(score('python')).toBeGreaterThan(Math.max(...low) * 1.1);
    expect(Math.min(...low)).toBeGreaterThan(score('hippo') * 1.25);
    // sanity vs the plan text: Lion's Leap Rake rose about 4.5 m; WP-T raised every recovery x1.25 (balance: a launch off the ledge must be survivable), so ~6 m
    const lion = simulateRecovery(getMoveBody('lion', 'heavyU', false), MOVESETS.lion.stats);
    expect(lion.peak).toBeGreaterThan(4.0);
    expect(lion.peak).toBeLessThan(6.6);
  });
});

describe('stats (plan §3.1, ±15 %: WP-T retune)', () => {
  it('match the roster table', () => {
    for (const a of ANIMALS) {
      const s = MOVESETS[a].stats;
      const want = PLAN[a];
      for (const [k, v] of Object.entries(want) as [keyof CharacterStats, number][]) {
        const got = s[k];
        if (k === 'maxJumps') expect(got, `${a}.${k}`).toBe(v);
        else expect(Math.abs((got as number) / v - 1), `${a}.${k}: ${got} vs ${v}`).toBeLessThanOrEqual(0.15 + 1e-9);
      }
      if (a !== 'eagle') expect(s.glideFall, a).toBeUndefined();
      expect(s.dodgeInvuln).toBe(14);
      expect(s.dodgeFrames).toBeGreaterThanOrEqual(24);
      expect(s.dodgeFrames).toBeLessThanOrEqual(28);
      expect(s.airAccel).toBeGreaterThan(10);
      expect(s.fastFallSpeed).toBeGreaterThan(s.fallSpeed);
    }
  });
});

describe('balance', () => {
  it('power index (damage x knockback value per frame) stays within ±15 % of the roster mean', () => {
    const idx = ANIMALS.map((a) => powerIndex(MOVESETS[a]));
    const mean = idx.reduce((s, v) => s + v, 0) / idx.length;
    idx.forEach((v, i) => {
      expect(Math.abs(v / mean - 1), `${ANIMALS[i]} power index ${v.toFixed(3)} vs mean ${mean.toFixed(3)}`).toBeLessThanOrEqual(0.15);
    });
  });

  it('kill power: best move kills a weight-100 target at 80-140 %, the weakest heavy at >= 150 %', () => {
    for (const a of ANIMALS) {
      const kills = (['heavyN', 'heavyS', 'heavyD', 'heavyU'] as const).map((id) => {
        const g = bodyKillPercent(getMoveBody(a, id, false));
        const ar = bodyKillPercent(getMoveBody(a, id, true));
        return Math.min(g, ar);
      });
      const best = Math.min(...kills);
      const weakest = Math.max(...kills);
      expect(best, `${a} best kill %`).toBeGreaterThanOrEqual(80);
      expect(best, `${a} best kill %`).toBeLessThanOrEqual(140);
      expect(weakest, `${a} weakest heavy kill %`).toBeGreaterThanOrEqual(150);
      // light moves are not killers
      for (const id of ['lightN', 'lightS', 'lightD', 'lightU'] as const) {
        expect(bodyKillPercent(getMoveBody(a, id, false)), `${a}.${id}`).toBeGreaterThan(200);
      }
    }
  });

  it('kill-power ordering follows the roster identities', () => {
    const best = (a: AnimalId): number =>
      Math.min(...(['heavyN', 'heavyS'] as const).map((id) => bodyKillPercent(getMoveBody(a, id, false))));
    // WP-T: the gorilla's two-hit armor makes every connect safe, so its raw kill power was deliberately lowered in the balance pass
    // (kill-power buffs made it a 62-67 % animal); hippo and rhino stay the very-high-kill heavies, the gorilla is "high" (docs/CHAMPIONS-LEAGUE-BALANCE.md).
    const strong = Math.max(best('hippo'), best('rhino'));
    const weak = Math.min(best('eagle'), best('panther'), best('mole'));
    expect(strong).toBeLessThan(weak - 15);
    expect(best('gorilla')).toBeLessThanOrEqual(best('lion') + 25);
    expect(best('mole')).toBeGreaterThanOrEqual(best('lion') + 15);
  });

  it('no animal is top-3 in reach, speed and kill power at the same time', () => {
    const rows = ANIMALS.map((a) => {
      const r = ratings(MOVESETS[a]);
      const kill = Math.min(...(['heavyN', 'heavyS'] as const).map((id) => bodyKillPercent(getMoveBody(a, id, false))));
      return { a, reach: r.raw.reach, speed: r.raw.runSpeed, kill };
    });
    const rank = (key: 'reach' | 'speed' | 'kill', a: AnimalId): number => {
      const sorted = [...rows].sort((x, y) => (key === 'kill' ? x.kill - y.kill : y[key] - x[key]));
      return sorted.findIndex((r) => r.a === a);
    };
    for (const a of ANIMALS) {
      const dominant = rank('reach', a) < 3 && rank('speed', a) < 3 && rank('kill', a) < 3;
      expect(dominant, `${a} is top-3 in range, speed and kill power`).toBe(false);
    }
  });

  it('hitbox reach is anatomically honest (per-animal caps) and matches the anim hints', () => {
    const CAP: Record<AnimalId, number> = { lion: 2.2, gorilla: 2.8, crocodile: 2.9, hippo: 2.9, rhino: 2.7, eagle: 2.7, panther: 2.3, python: 3.3, giraffe: 3.6, mole: 1.5 };
    for (const a of ANIMALS) {
      for (const id of MOVE_IDS) {
        for (const nb of allBodies().filter((n) => n.animal === a && n.id === id)) {
          expect(bodyReach(nb.body), `${nb.label} reach`).toBeLessThanOrEqual(CAP[a] + 1e-9);
          const hint = nb.body.anim?.reach;
          if (typeof hint === 'number' && nb.kind !== 'air') {
            expect(Math.abs(hint - bodyReach(nb.body)), `${nb.label} anim.reach ${hint} vs hitbox ${bodyReach(nb.body).toFixed(2)}`).toBeLessThanOrEqual(0.5);
          }
        }
      }
    }
    // the headline anatomy numbers from the brief
    const maxReach = (a: AnimalId): number => Math.max(...MOVE_IDS.map((id) => bodyReach(getMoveBody(a, id, false))));
    expect(maxReach('giraffe')).toBeGreaterThan(3.0);
    expect(maxReach('python')).toBeGreaterThan(2.8);
    expect(maxReach('mole')).toBeLessThan(1.5);
    expect(maxReach('lion')).toBeGreaterThan(1.8);
    expect(maxReach('giraffe')).toBeGreaterThan(maxReach('python'));
  });

  it('every group of hitboxes has a positive per-victim value', () => {
    for (const nb of allBodies()) {
      for (const hs of groupsOf(nb.body).values()) expect(hs.length).toBeGreaterThan(0);
    }
  });
});

describe('stages', () => {
  it('exports both stages with matching ids', () => {
    expect(Object.keys(STAGES).sort()).toEqual([...STAGE_IDS].sort());
    for (const id of STAGE_IDS) {
      expect(getStage(id)).toBe(STAGES[id]);
      expect(STAGES[id].id).toBe(id);
      expect(STAGES[id].name.length).toBeGreaterThan(3);
    }
  });

  it('platform ids are unique; soft / solid / ledge rules hold', () => {
    for (const id of STAGE_IDS) {
      const st = STAGES[id];
      const ids = st.platforms.map((p) => p.id);
      expect(new Set(ids).size, `${id} platform ids unique`).toBe(ids.length);
      expect(st.platforms.some((p) => p.kind === 'solid')).toBe(true);
      for (const p of st.platforms) {
        expect(['solid', 'soft']).toContain(p.kind);
        expect(p.x1, p.id).toBeGreaterThan(p.x0);
        expect(p.thickness, p.id).toBeGreaterThan(0);
        expect(finite(p.y), p.id).toBe(true);
        if (p.kind === 'soft') {
          expect(p.ledgeLeft, `${id}.${p.id} soft platforms have no ledges`).toBeFalsy();
          expect(p.ledgeRight, `${id}.${p.id} soft platforms have no ledges`).toBeFalsy();
        }
        if (p.moving) {
          expect(p.kind, `${p.id} moving platforms are soft`).toBe('soft');
          expect(p.moving.amplitude).toBeGreaterThan(0);
          expect(p.moving.periodS).toBeGreaterThan(0);
          expect(p.moving.phase).toBeGreaterThanOrEqual(0);
          expect(p.moving.phase).toBeLessThan(1);
        }
      }
      // solid platforms: ledges on both ends in both stages
      for (const p of st.platforms.filter((q) => q.kind === 'solid')) {
        expect(p.ledgeLeft && p.ledgeRight, `${id}.${p.id} has both ledges`).toBe(true);
      }
    }
  });

  it('matches the plan geometry exactly', () => {
    const bc = STAGES.brokenColosseum;
    expect(bc.blast).toEqual({ left: -30, right: 30, top: 22, bottom: -16 });
    expect(bc.platforms.find((p) => p.id === 'main')).toMatchObject({ kind: 'solid', x0: -11, x1: 11, y: 0, thickness: 3.5, ledgeLeft: true, ledgeRight: true });
    expect(bc.platforms.find((p) => p.id === 'left')).toMatchObject({ kind: 'soft', x0: -9, x1: -4, y: 4.2 });
    expect(bc.platforms.find((p) => p.id === 'right')).toMatchObject({ kind: 'soft', x0: 4, x1: 9, y: 4.2 });
    expect(bc.platforms.find((p) => p.id === 'top')).toMatchObject({ kind: 'soft', x0: -2.5, x1: 2.5, y: 7.6 });
    expect(bc.spawns.map((s) => s.x)).toEqual([-7, -2.5, 2.5, 7]);
    expect(bc.respawn).toEqual({ x: 0, y: 12 });
    expect(bc.camera).toEqual({ minHalfW: 11, maxHalfW: 19 });

    const sa = STAGES.skyAqueduct;
    expect(sa.blast).toEqual({ left: -30, right: 30, top: 22, bottom: -18 });
    expect(sa.platforms.find((p) => p.id === 'islandL')).toMatchObject({ kind: 'solid', x0: -13, x1: -3, y: 0, thickness: 3, ledgeLeft: true, ledgeRight: true });
    expect(sa.platforms.find((p) => p.id === 'islandR')).toMatchObject({ kind: 'solid', x0: 3, x1: 13, y: 0, thickness: 3, ledgeLeft: true, ledgeRight: true });
    const mover = sa.platforms.find((p) => p.moving)!;
    expect(mover.x1 - mover.x0).toBe(5);
    expect(mover.y).toBe(2.6);
    expect(mover.moving).toEqual({ axis: 'x', amplitude: 3.2, periodS: 9, phase: 0 });
    expect(sa.platforms.filter((p) => p.moving)).toHaveLength(1);
    expect(sa.platforms.find((p) => p.id === 'high')).toMatchObject({ kind: 'soft', x0: -3, x1: 3, y: 7.8 });
    expect(sa.platforms.find((p) => p.id === 'smallL')).toMatchObject({ kind: 'soft', x0: -12, x1: -8, y: 4.6 });
    expect(sa.platforms.find((p) => p.id === 'smallR')).toMatchObject({ kind: 'soft', x0: 8, x1: 12, y: 4.6 });
    expect(sa.spawns.map((s) => s.x)).toEqual([-10, -6, 6, 10]);
    expect(sa.respawn).toEqual({ x: 0, y: 12 });
    expect(sa.camera).toEqual({ minHalfW: 12, maxHalfW: 21 });
  });

  it('spawns stand on solid ground and blast zones enclose everything', () => {
    for (const id of STAGE_IDS) {
      const st = STAGES[id];
      expect(st.spawns).toHaveLength(4);
      expect(new Set(st.spawns.map((s) => s.x)).size).toBe(4);
      for (const s of st.spawns) {
        const under = st.platforms.filter((p) => p.x0 <= s.x && s.x <= p.x1 && p.y <= s.y + 1e-9);
        expect(under.length, `${id} spawn ${s.x} is on/above a platform`).toBeGreaterThan(0);
        const stand = under.reduce((a, b) => (a.y > b.y ? a : b));
        expect(stand.kind, `${id} spawn ${s.x} stands on a solid platform`).toBe('solid');
        expect(s.y - stand.y, `${id} spawn ${s.x} stands on the surface`).toBeLessThan(0.05);
      }
      const { left, right, top, bottom } = st.blast;
      for (const p of st.platforms) {
        const amp = p.moving?.amplitude ?? 0;
        expect(p.x0 - amp, `${id}.${p.id}`).toBeGreaterThan(left);
        expect(p.x1 + amp, `${id}.${p.id}`).toBeLessThan(right);
        expect(p.y, `${id}.${p.id}`).toBeLessThan(top);
        expect(p.y - p.thickness, `${id}.${p.id}`).toBeGreaterThan(bottom);
      }
      for (const pt of [st.respawn, st.cameraFocus, ...st.spawns]) {
        expect(pt.x).toBeGreaterThan(left);
        expect(pt.x).toBeLessThan(right);
        expect(pt.y).toBeGreaterThan(bottom);
        expect(pt.y).toBeLessThan(top);
      }
      expect(st.respawn.y, `${id} respawn is high above the stage`).toBeGreaterThan(Math.max(...st.platforms.map((p) => p.y)));
      expect(st.camera.minHalfW).toBeLessThan(st.camera.maxHalfW);
      // the whole stage fits in the widest camera framing
      const widest = Math.max(...st.platforms.map((p) => Math.max(Math.abs(p.x0), Math.abs(p.x1))));
      expect(st.camera.maxHalfW).toBeGreaterThanOrEqual(widest);
    }
  });

  it('the moving platform is a pure, deterministic function of the frame', () => {
    const p = STAGES.skyAqueduct.platforms.find((q) => q.moving)!;
    expect(movingOffset(p.moving!, 0)).toBeCloseTo(0, 12);
    expect(movingOffset(p.moving!, 135)).toBeCloseTo(3.2, 9); // quarter period (2.25 s)
    expect(movingOffset(p.moving!, 405)).toBeCloseTo(-3.2, 9); // three quarters
    expect(movingOffset(p.moving!, 540)).toBeCloseTo(0, 9); // full period (9 s)
    const a = platformAt(p, 77);
    const b = platformAt(p, 77);
    expect(a).toEqual(b);
    expect(a.x1 - a.x0).toBeCloseTo(5, 12);
    expect(a.y).toBe(2.6);
    // it never leaves the gap region between the outer ledges and stays above the islands' tops
    for (let f = 0; f < 540; f += 5) {
      const r = platformAt(p, f);
      expect(r.x0).toBeGreaterThan(-13);
      expect(r.x1).toBeLessThan(13);
    }
  });
});
