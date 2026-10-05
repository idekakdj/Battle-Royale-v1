/** Mole — tiny trickster. Smallest hurtbox, fast digging claws, an underground burrow that dodges attacks and erupts upward; drill recovery; low kill power. */

import type { MovesetDef } from '../../types';
import { A, air, body, cs, hb, linkTo, moveset, mot, mv } from '../helpers';

const stats = cs({
  weight: 79,
  walkSpeed: 4.85,
  runSpeed: 9.1,
  airSpeed: 7,
  airAccel: 31.9,
  jumpVel: 14.5,
  airJumpVel: 12.5,
  maxJumps: 2,
  gravityMult: 0.95,
  fallSpeed: 17,
  fastFallSpeed: 25,
  width: 0.68,
  height: 0.68,
});

// lightN — Claw Dig (3 quick)
const n1 = body(
  'Claw Dig',
  'swipe',
  A('Right digging claw scoops forward', { limb: 'claw', side: 'R', reach: 0.95, height: 0.4, arc: 60 }),
  [4, 2, 8],
  [hb.circle(0.65, 0.4, 0.3, 4, 5, 4, 62, { stun: 3.7 })],
  { cancels: linkTo(6, 14, false), turn: true },
);
const n2 = body(
  'Claw Dig 2',
  'backhand',
  A('Left digging claw scoops back', { limb: 'claw', side: 'L', reach: 0.95, height: 0.4, arc: 60 }),
  [4, 2, 8],
  [hb.circle(0.65, 0.4, 0.3, 4, 5, 4, 62, { stun: 3.7 })],
  { cancels: linkTo(6, 14, true) },
);
const n3 = body(
  'Claw Dig 3',
  'rake',
  A('Both claws dig down through the target', { limb: 'claw', side: 'both', reach: 1.05, height: 0.4, arc: 80 }),
  [5, 2, 10],
  [hb.circle(0.7, 0.4, 0.33, 5, 7, 9, 50, { path: [[0, 0, 0.15], [2, 0.1, -0.25]] })],
);

const lightS = body(
  'Dirt Fling',
  'swipe',
  A('Both paws fling a short cone of dirt into the target\'s face', { limb: 'claw', side: 'both', reach: 1.1, height: 0.4 }),
  [6, 3, 13],
  [hb.rect(0.65, 0.4, 0.9, 0.7, 9, 5, 6, 30, { fx: 'flinch' })],
);
const lightD = body(
  'Low Dig',
  'rake',
  A('Claws scrape low along the ground and kick up the ankles', { limb: 'claw', side: 'both', reach: 1.05, height: 0.15, arc: 50 }),
  [5, 3, 11],
  [hb.rect(0.65, 0.15, 0.8, 0.35, 8, 5, 6, 68)],
);
const lightU = body(
  'Earth Pop',
  'uppercut',
  A('Claws scoop upward in a small uppercut, popping the target up', { limb: 'claw', side: 'both', reach: 0.9, height: 1.3, arc: 100 }),
  [6, 3, 12],
  [hb.circle(0.6, 0.6, 0.4, 9, 6, 8, 88, { path: [[0, 0, 0], [3, -0.2, 0.7]] })],
);

const heavyN = body(
  'Drill Spin',
  'spinAttack',
  A('Spins like a drill on the spot, claws buzzing around the body; the last turn flings victims', { limb: 'claw', side: 'both', reach: 0.9, height: 0.4, spin: 3 }),
  [12, 6, 22],
  [
    hb.rect(0, 0.4, 1.8, 0.8, 3, 3, 0, 40, { win: [0, 4], multi: 2, group: 1 }),
    hb.rect(0, 0.4, 1.8, 0.8, 8, 10.8, 23, 55, { win: [4, 6], group: 2 }),
  ],
);
const heavyS = body(
  'Tunnel Lunge',
  'charge',
  A('Tucks into a drill and rockets forward like a boring machine', { limb: 'claw', side: 'front', reach: 1.2, height: 0.4, travel: 1.4 }),
  [14, 4, 25],
  [hb.circle(0.8, 0.4, 0.4, 14, 11, 24, 40, { hitlag: 2 })],
  { motion: [mot(12, 22, { vx: 8.5 })] },
);
// v1.6: the GROUND heavyD is now a real burrow — the mole sinks (f0-5), tunnels ~3.3 m underground (f6-23: untouchable, hits
// bypass it, other hitboxes pass through) and erupts upward (f24-27), launching the target straight up. `stopAtEdge` keeps it on
// the platform it stands on (it emerges at the edge instead of tunnelling off). The air form stays the drill-down.
const heavyD = body(
  'Burrow Strike',
  'burrow',
  A('Digs under the floor, tunnels a short way, and erupts upward under the target', { limb: 'claw', side: 'front', reach: 1.45, height: 0.9, depth: 0.6, travel: 3.3 }),
  [24, 4, 20],
  [hb.circle(0.5, 0.7, 0.95, 12, 11, 16, 88, { stun: 1.1 })],
  { invuln: { from: 6, to: 24 }, burrow: { from: 6, to: 24 }, motion: [mot(6, 24, { vx: 11, edge: true })] },
);
const heavyU = body(
  'Drill Ascent',
  'leapUp',
  A('Spins into a vertical drill and bores up through the air', { limb: 'claw', side: 'up', reach: 0.5, height: 1.4, rise: 6.0, spin: 4 }),
  [8, 16, 24],
  [
    hb.rect(0.25, 0.7, 0.9, 1.0, 2, 3, 0, 85, { win: [0, 12], multi: 4, group: 1 }),
    hb.circle(0.3, 1.0, 0.5, 5, 9.5, 17, 85, { win: [12, 16], group: 2 }),
  ],
  { motion: [mot(6, 22, { vx: 2.5, vy: 16.9 })] },
);

export const mole: MovesetDef = moveset('mole', 'Tiny trickster: hard to hit, quick digging combos, a burrow that tunnels under attacks and erupts upward, and a drilling recovery.', stats, [
  mv('lightN', n1, air(n1, { lag: 6 }), [n2, n3]),
  mv('lightS', lightS, air(lightS, { lag: 7 })),
  mv('lightD', lightD, air(lightD, { lag: 6 })),
  mv('lightU', lightU, air(lightU, { lag: 6 })),
  mv('heavyN', heavyN, air(heavyN, { lag: 15 })),
  mv('heavyS', heavyS, air(heavyS, { lag: 18 })),
  mv(
    'heavyD',
    heavyD,
    air(heavyD, {
      lag: 18,
      t: [13, 4, 25],
      clear: ['motion', 'invuln', 'burrow'],
      name: 'Drill Down',
      arch: 'dive',
      hits: [hb.circle(0.25, -0.15, 0.45, 13, 10, 20, 285)],
      anim: A('Points the claws down and drills straight down through the air', { limb: 'claw', side: 'down', reach: 0.3, height: -0.2, pitch: -90 }),
    }),
  ),
  mv('heavyU', heavyU, air(heavyU, { lag: 14 })),
]);
