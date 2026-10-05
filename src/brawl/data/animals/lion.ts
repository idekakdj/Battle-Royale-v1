/** Lion — all-rounder brawler. Good at everything, best at nothing: mid reach, mid speed, mid kill, good recovery. */

import type { MovesetDef } from '../../types';
import { A, air, body, cs, hb, linkTo, moveset, mot, mv } from '../helpers';

const stats = cs({
  weight: 104,
  walkSpeed: 4.6,
  runSpeed: 8.6,
  airSpeed: 7.3,
  airAccel: 33,
  jumpVel: 14.5,
  airJumpVel: 13.0,
  maxJumps: 2,
  gravityMult: 1.0,
  fallSpeed: 18,
  fastFallSpeed: 26,
  width: 1.1,
  height: 1.5,
});

// lightN — Claw Flurry: swipe, backhand, rake (true combo from 0 %)
const n1 = body(
  'Claw Swipe',
  'swipe',
  A('Right forepaw slashes diagonally across the body', { limb: 'paw', side: 'R', reach: 1.5, height: 1.0, arc: 70 }),
  [5, 2, 9],
  [hb.circle(1.0, 1.0, 0.5, 3, 5, 4, 62, { stun: 3.3 })],
  { cancels: linkTo(7, 16, false), turn: true },
);
const n2 = body(
  'Claw Backhand',
  'backhand',
  A('Left forepaw backhands the opposite way', { limb: 'paw', side: 'L', reach: 1.5, height: 1.0, arc: 70 }),
  [4, 2, 9],
  [hb.circle(1.0, 1.05, 0.5, 3, 5, 4, 62, { stun: 3.3 })],
  { cancels: linkTo(6, 15, true) },
);
const n3 = body(
  'Claw Rake',
  'rake',
  A('Both-clawed overhead rake, paw drawn down through the target', { limb: 'paw', side: 'R', reach: 1.65, height: 1.1, arc: 80 }),
  [6, 3, 12],
  [hb.circle(1.1, 1.15, 0.55, 4, 7, 10, 50, { path: [[0, 0, 0.2], [3, 0.15, -0.5]] })],
);

const lightS = body(
  'Pounce Swipe',
  'swipe',
  A('Short forward pounce with a lunging forepaw swipe', { limb: 'paw', side: 'R', reach: 1.7, height: 0.95, travel: 0.5 }),
  [7, 3, 14],
  [hb.rect(1.15, 0.95, 1.1, 0.8, 6, 6, 9, 35, { path: [[0, 0, 0.1], [3, 0.2, -0.1]] })],
  { motion: [mot(4, 9, { vx: 3.5 })] },
);
const lightD = body(
  'Low Rake',
  'rake',
  A('Crouching sweep of one paw along the floor, popping the target up', { limb: 'paw', side: 'R', reach: 1.6, height: 0.3, arc: 60 }),
  [6, 3, 13],
  [hb.rect(1.1, 0.3, 1.0, 0.5, 6, 5, 7, 68, { path: [[0, -0.2, 0], [3, 0.3, 0]] })],
);
const lightU = body(
  'Uppercut Claw',
  'uppercut',
  A('Forepaw scoops upward in an arc over the head', { limb: 'paw', side: 'R', reach: 1.4, height: 1.9, arc: 110 }),
  [7, 3, 14],
  [hb.circle(0.95, 1.0, 0.55, 7, 6, 9, 85, { path: [[0, 0, 0], [3, -0.5, 1.0]] })],
);

const heavyN = body(
  'Roar Wave',
  'roar',
  A('Rears up and roars; a short two-sided shock ring pushes everything away', { limb: 'head', side: 'both', reach: 2.0, height: 1.8, ring: 2.0 }),
  [16, 4, 22],
  [
    hb.rect(1.0, 1.0, 2.0, 1.6, 11, 10.8, 20, 40, { fx: 'flinch', group: 1 }),
    hb.rect(-1.0, 1.0, 2.0, 1.6, 11, 10.8, 20, 140, { fx: 'flinch', group: 1 }),
  ],
);
const heavyS = body(
  'Maul Bite',
  'bite',
  A('Leaps forward with the jaws wide and snaps shut on the target', { limb: 'jaw', side: 'front', reach: 2.0, height: 1.0, travel: 1.3 }),
  [16, 4, 28],
  [hb.circle(1.5, 1.0, 0.5, 16, 10.8, 25, 38, { hitlag: 3, sweet: [2.0, 0.9, 0.5, 1.15, 1.08] })],
  { motion: [mot(14, 24, { vx: 8 })] },
);
const heavyD = body(
  'Paw Slam',
  'slam',
  A('Rears up and slams both paws down in front; air: dives paws-first', { limb: 'paw', side: 'both', reach: 1.7, height: 0.4 }),
  [14, 4, 26],
  [hb.rect(0.9, 0.4, 1.6, 0.8, 13, 10, 20, 75)],
);
const heavyU = body(
  'Leap Rake',
  'leapUp',
  A('Springs up and forward with claws raking upward through the air', { limb: 'paw', side: 'both', reach: 1.4, height: 2.4, rise: 4.5 }),
  [8, 14, 24],
  [hb.circle(0.9, 1.2, 0.65, 9, 9.5, 17, 80, { path: [[0, 0, -0.3], [10, 0.2, 0.7]] })],
  { motion: [mot(6, 16, { vx: 5.6, vy: 17.5 })] },
);

export const lion: MovesetDef = moveset('lion', 'All-rounder brawler: balanced reach, speed and a dependable leap recovery.', stats, [
  mv('lightN', n1, air(n1, { lag: 6 }), [n2, n3]),
  mv('lightS', lightS, air(lightS, { lag: 8 })),
  mv('lightD', lightD, air(lightD, { lag: 8 })),
  mv('lightU', lightU, air(lightU, { lag: 8 })),
  mv('heavyN', heavyN, air(heavyN, { lag: 18 })),
  mv('heavyS', heavyS, air(heavyS, { lag: 22 })),
  mv(
    'heavyD',
    heavyD,
    air(heavyD, {
      lag: 22,
      name: 'Paw Slam (dive)',
      hits: [hb.circle(0.55, -0.15, 0.6, 14, 10, 20, 270, { fx: 'spike' })],
      anim: A('Tucks, then drives both paws straight down in a meteor strike', { limb: 'paw', side: 'both', reach: 0.6, height: -0.3 }),
    }),
  ),
  mv('heavyU', heavyU, air(heavyU, { lag: 16 })),
]);
