/** Eagle — air skirmisher. Fastest and floatiest (4 jumps, glide), best recovery in the roster; light and low on kill power. */

import type { MovesetDef } from '../../types';
import { A, air, body, cs, hb, linkTo, moveset, mot, mv } from '../helpers';

const stats = cs({
  weight: 76,
  walkSpeed: 5.2,
  runSpeed: 9.4,
  airSpeed: 8.8,
  airAccel: 39.6,
  jumpVel: 15.0,
  airJumpVel: 12.8,
  maxJumps: 4,
  gravityMult: 0.8,
  fallSpeed: 14,
  fastFallSpeed: 24,
  glideFall: 6.5,
  width: 1.0,
  height: 1.2,
});

// lightN — Talon Slash (3 quick)
const n1 = body(
  'Talon Slash',
  'swipe',
  A('Right talon slashes forward and down', { limb: 'talon', side: 'R', reach: 1.3, height: 0.75, arc: 60 }),
  [4, 2, 8],
  [hb.circle(0.85, 0.75, 0.45, 3, 5, 4, 62, { stun: 3.7 })],
  { cancels: linkTo(6, 14, false), turn: true },
);
const n2 = body(
  'Talon Slash 2',
  'backhand',
  A('Left talon slashes back the other way', { limb: 'talon', side: 'L', reach: 1.35, height: 0.8, arc: 60 }),
  [4, 2, 8],
  [hb.circle(0.9, 0.8, 0.45, 3, 5, 4, 62, { stun: 3.7 })],
  { cancels: linkTo(6, 14, true) },
);
const n3 = body(
  'Talon Rake',
  'rake',
  A('Both talons rake down through the target', { limb: 'talon', side: 'both', reach: 1.45, height: 0.7, arc: 80 }),
  [5, 2, 10],
  [hb.circle(0.95, 0.7, 0.5, 3, 7, 9, 50, { path: [[0, 0, 0.2], [2, 0.1, -0.3]] })],
);

const lightS = body(
  'Wing Buffet',
  'wingBuffet',
  A('One wing slaps forward across the front', { limb: 'wing', side: 'front', reach: 1.7, height: 0.85, arc: 100 }),
  [6, 3, 12],
  [hb.rect(1.05, 0.85, 1.3, 0.9, 6, 8, 6, 25)],
);
const lightD = body(
  'Talon Drop',
  'rake',
  A('Talons drop down and rake the ground in front', { limb: 'talon', side: 'both', reach: 1.3, height: 0.2, arc: 70 }),
  [5, 3, 11],
  [hb.circle(0.8, 0.2, 0.5, 5, 5, 6, 60, { path: [[0, 0, 0.5], [3, 0.1, -0.3]] })],
);
const lightU = body(
  'Beak Flick',
  'uppercut',
  A('Head snaps upward in a short beak peck', { limb: 'beak', side: 'up', reach: 0.8, height: 1.75 }),
  [6, 3, 12],
  [hb.circle(0.45, 1.35, 0.4, 6, 6, 8, 90, { path: [[0, 0.2, -0.2], [3, -0.1, 0.7]] })],
);

const heavyN = body(
  'Gale Burst',
  'wingBuffet',
  A('Both wings thrash down in one huge flap; a gust shoves everything around away', { limb: 'wing', side: 'both', reach: 2.6, height: 0.9, ring: 2.6 }),
  [12, 4, 20],
  [
    hb.rect(1.4, 0.8, 2.4, 1.5, 10, 9, 17, 40, { group: 1 }),
    hb.rect(-1.4, 0.8, 2.4, 1.5, 10, 9, 17, 140, { group: 1 }),
  ],
);
const heavyS = body(
  'Piercing Dive',
  'dive',
  A('Folds the wings back and stoops diagonally forward, beak first; the beak tip is the killing point', { limb: 'beak', side: 'front', reach: 1.55, height: 0.65, travel: 1.5 }),
  [16, 4, 23],
  [hb.circle(1.0, 0.65, 0.55, 14, 10.8, 24, 50, { hitlag: 3, sweet: [1.5, 0.65, 0.5, 1.2, 1.1] })],
  { motion: [mot(14, 24, { vx: 9 })] },
);
const heavyD = body(
  'Stoop',
  'dive',
  A('Pulls in the wings and drops straight down talons-first; on the ground a talon stamp that pops targets up', { limb: 'talon', side: 'down', reach: 0.9, height: 0.25 }),
  [12, 4, 20],
  [hb.circle(0.5, 0.25, 0.65, 12, 10, 20, 80)],
);
const heavyU = body(
  'Soaring Updraft',
  'leapUp',
  A('Powerful wing beats lift the whole body high and forward on a rising current', { limb: 'wing', side: 'both', reach: 1.5, height: 2.0, rise: 7.5 }),
  [6, 20, 22],
  [hb.rect(0.3, 1.0, 1.8, 1.2, 7, 9.5, 17, 85, { path: [[0, 0, 0], [18, 0.4, 0.8]] })],
  { motion: [mot(4, 24, { vx: 4.4, vy: 18.1 })] },
);

export const eagle: MovesetDef = moveset('eagle', 'Air skirmisher: fast, floaty with four jumps and a glide; unmatched recovery but light and low on kill power.', stats, [
  mv('lightN', n1, air(n1, { lag: 6 }), [n2, n3]),
  mv('lightS', lightS, air(lightS, { lag: 7 })),
  mv('lightD', lightD, air(lightD, { lag: 7 })),
  mv('lightU', lightU, air(lightU, { lag: 6 })),
  mv('heavyN', heavyN, air(heavyN, { lag: 14 })),
  mv(
    'heavyS',
    heavyS,
    air(heavyS, {
      lag: 18,
      name: 'Piercing Dive (stoop)',
      motion: [mot(14, 24, { vx: 9, vy: -7 })],
      anim: A('Diagonal stoop, beak leading, body angled steeply down and forward', { limb: 'beak', side: 'front', reach: 1.55, height: 0.65, travel: 1.5, pitch: -40 }),
    }),
  ),
  mv(
    'heavyD',
    heavyD,
    air(heavyD, {
      lag: 18,
      name: 'Stoop (meteor)',
      hits: [hb.circle(0.35, -0.25, 0.6, 12, 10, 20, 270, { fx: 'spike' })],
      motion: [mot(8, 16, { vy: -9 })],
      anim: A('Tucks the wings and plummets straight down, talons first', { limb: 'talon', side: 'down', reach: 0.4, height: -0.3, pitch: -90 }),
    }),
  ),
  mv('heavyU', heavyU, air(heavyU, { lag: 14 })),
]);
