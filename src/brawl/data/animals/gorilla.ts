/** Gorilla — heavy bruiser. Slow and big; armored heavies with the strongest kill power, but a poor recovery. */

import type { MovesetDef } from '../../types';
import { A, air, body, cs, hb, linkTo, moveset, mot, mv } from '../helpers';

const stats = cs({
  weight: 107,
  walkSpeed: 4.25,
  runSpeed: 8.1,
  airSpeed: 5.9,
  airAccel: 26.4,
  jumpVel: 13.5,
  airJumpVel: 12.0,
  maxJumps: 2,
  gravityMult: 1.1,
  fallSpeed: 19,
  fastFallSpeed: 27,
  width: 1.5,
  height: 2.0,
});

// lightN — Hammer Fists (2 hits)
const n1 = body(
  'Hammer Fist',
  'jab',
  A('Right fist hammers forward and down', { limb: 'forelimb', side: 'R', reach: 1.95, height: 1.2, arc: 50 }),
  [7, 3, 12],
  [hb.circle(1.35, 1.2, 0.6, 5, 6, 5, 62, { stun: 3.3, path: [[0, 0, 0.3], [3, 0.1, -0.4]] })],
  { cancels: linkTo(10, 22, false), turn: true },
);
const n2 = body(
  'Hammer Fist 2',
  'jab',
  A('Left fist follows with a heavier hammer blow', { limb: 'forelimb', side: 'L', reach: 2.0, height: 1.1, arc: 50 }),
  [6, 3, 13],
  [hb.circle(1.4, 1.1, 0.6, 5, 8, 10, 45, { path: [[0, 0, 0.3], [3, 0.1, -0.4]] })],
);

const lightS = body(
  'Backhand Smash',
  'backhand',
  A('Wide backhand arc swung across the front with the whole arm', { limb: 'forelimb', side: 'R', reach: 2.3, height: 1.2, arc: 120 }),
  [10, 4, 18],
  [hb.rect(1.25, 1.2, 1.5, 0.9, 9, 7, 10, 35, { path: [[0, -0.3, 0.2], [4, 0.3, -0.1]] })],
);
const lightD = body(
  'Knuckle Drag',
  'swipe',
  A('Drops to the knuckles and drags a fist along the floor', { limb: 'forelimb', side: 'R', reach: 2.2, height: 0.25, arc: 60 }),
  [8, 4, 15],
  [hb.rect(1.2, 0.25, 1.5, 0.5, 7, 6, 8, 25, { path: [[0, -0.3, 0], [4, 0.3, 0]] })],
);
const lightU = body(
  'Thump Uppercut',
  'uppercut',
  A('Both fists thump up from the chest in a launching uppercut', { limb: 'forelimb', side: 'both', reach: 1.5, height: 2.7, arc: 110 }),
  [9, 4, 16],
  [hb.circle(1.0, 1.2, 0.65, 8, 7, 11, 80, { path: [[0, 0, -0.3], [4, 0.2, 1.2]] })],
);

const heavyN = body(
  'Chest Drum',
  'roar',
  A('Rears up and drums the chest; a shockwave rolls out both ways', { limb: 'forelimb', side: 'both', reach: 2.4, height: 1.6, ring: 2.4 }),
  [15, 4, 25],
  [
    hb.rect(1.3, 1.1, 2.2, 1.8, 12, 10, 22, 45, { group: 1 }),
    hb.rect(-1.3, 1.1, 2.2, 1.8, 12, 10, 22, 135, { group: 1 }),
  ],
  { armor: { from: 8, to: 14, hits: 1, dmgScale: 0.7 } },
);
const heavyS = body(
  'Silverback Swing',
  'swipe',
  A('Raises both arms overhead and brings one giant overhand swing down and through', { limb: 'forelimb', side: 'both', reach: 2.7, height: 2.6, arc: 160 }),
  [20, 5, 32],
  [hb.circle(1.55, 1.3, 0.85, 16, 11, 21, 35, { hitlag: 4, path: [[0, -0.6, 0.8], [5, 0.3, -0.8]] })],
  { armor: { from: 8, to: 20, hits: 2, dmgScale: 1 } },
);
const heavyD = body(
  'Double-Fist Slam',
  'slam',
  A('Clasps both fists and slams them into the floor in front', { limb: 'forelimb', side: 'both', reach: 2.1, height: 0.5 }),
  [16, 4, 28],
  [hb.rect(1.2, 0.5, 1.8, 1.0, 13, 10, 20, 75, { stun: 1.4 })],
);
const heavyU = body(
  'Vine Leap',
  'leapUp',
  A('A short heavy jump, arms stretched up to grab an imaginary vine', { limb: 'forelimb', side: 'both', reach: 2.0, height: 3.2, rise: 3.3 }),
  [10, 12, 28],
  [hb.circle(1.0, 1.6, 0.8, 7, 9.5, 17, 80, { path: [[0, 0, 0], [10, 0.2, 0.8]] })],
  { motion: [mot(8, 20, { vx: 3.1, vy: 14.4 })] },
);

export const gorilla: MovesetDef = moveset('gorilla', 'Heavy bruiser: slow, armored and brutally strong, but a short climb back to the stage.', stats, [
  mv('lightN', n1, air(n1, { lag: 8 }), [n2]),
  mv('lightS', lightS, air(lightS, { lag: 10 })),
  mv('lightD', lightD, air(lightD, { lag: 9 })),
  mv('lightU', lightU, air(lightU, { lag: 10 })),
  mv('heavyN', heavyN, air(heavyN, { lag: 22 })),
  mv('heavyS', heavyS, air(heavyS, { lag: 26 })),
  mv(
    'heavyD',
    heavyD,
    air(heavyD, {
      lag: 24,
      name: 'Double-Fist Drop',
      hits: [hb.circle(0.7, -0.2, 0.7, 14, 10, 20, 270, { fx: 'spike' })],
      anim: A('Clasped fists driven straight down below the body', { limb: 'forelimb', side: 'both', reach: 0.7, height: -0.3 }),
    }),
  ),
  mv('heavyU', heavyU, air(heavyU, { lag: 18 })),
]);
