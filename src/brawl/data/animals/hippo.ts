/** Hippo — wall of meat. Heaviest and slowest, armored giant maw/charge, quake belly flop; the worst recovery in the roster. */

import type { MovesetDef } from '../../types';
import { A, air, body, cs, hb, linkTo, moveset, mot, mv } from '../helpers';

const stats = cs({
  weight: 119,
  walkSpeed: 3.3,
  runSpeed: 6.5,
  airSpeed: 5.1,
  airAccel: 22,
  jumpVel: 12.5,
  airJumpVel: 11.0,
  maxJumps: 2,
  gravityMult: 1.2,
  fallSpeed: 22,
  fastFallSpeed: 29,
  width: 1.8,
  height: 1.5,
});

// lightN — Head Bonk (2 hits)
const n1 = body(
  'Head Bonk',
  'headbutt',
  A('Heavy head bonks forward', { limb: 'head', side: 'front', reach: 1.9, height: 1.0 }),
  [7, 3, 13],
  [hb.circle(1.3, 1.0, 0.6, 5, 6, 5, 62, { stun: 3.7 })],
  { cancels: linkTo(10, 23, false), turn: true },
);
const n2 = body(
  'Head Bonk 2',
  'headbutt',
  A('Second bonk, rocking the whole upper body forward', { limb: 'head', side: 'front', reach: 1.95, height: 0.95 }),
  [7, 3, 14],
  [hb.circle(1.35, 0.95, 0.6, 5, 8, 10, 45)],
);

const lightS = body(
  'Belly Bump',
  'charge',
  A('Leans in and bumps the belly sideways into the target', { limb: 'body', side: 'front', reach: 1.75, height: 0.7 }),
  [9, 4, 18],
  [hb.rect(1.0, 0.7, 1.5, 1.2, 8, 7, 9, 25)],
);
const lightD = body(
  'Stomp Step',
  'stomp',
  A('One huge foot lifts and stamps low in front', { limb: 'forelimb', side: 'R', reach: 1.7, height: 0.2 }),
  [8, 3, 16],
  [hb.rect(1.1, 0.2, 1.2, 0.5, 7, 6, 7, 70)],
);
const lightU = body(
  'Tusk Toss',
  'uppercut',
  A('Lowers the head and tosses upward with the tusks', { limb: 'head', side: 'front', reach: 1.7, height: 2.1, arc: 90 }),
  [9, 4, 17],
  [hb.circle(1.1, 1.0, 0.6, 8, 6, 9, 88, { path: [[0, 0, -0.1], [4, -0.2, 1.0]] })],
);

const heavyN = body(
  'Mighty Yawn',
  'bite',
  A('Rears the head back and opens a gigantic maw, snapping it shut on whatever is in front', { limb: 'jaw', side: 'front', reach: 2.8, height: 1.2, gape: 1.6 }),
  [18, 5, 30],
  [hb.rect(1.7, 1.1, 2.2, 1.6, 16, 10, 31, 40, { hitlag: 3 })],
  { armor: { from: 8, to: 18, hits: 1, dmgScale: 0.7 } },
);
const heavyS = body(
  'Charging Gape',
  'lunge',
  A('Charges forward with the maw wide open and clamps down', { limb: 'jaw', side: 'front', reach: 2.4, height: 0.9, travel: 1.2 }),
  [22, 4, 30],
  [hb.circle(1.7, 0.9, 0.7, 18, 10, 25, 38, { hitlag: 3 })],
  { armor: { from: 10, to: 22, hits: 1, dmgScale: 0.7 }, motion: [mot(20, 30, { vx: 7 })] },
);
const heavyD = body(
  'Belly Flop',
  'bellyFlop',
  A('Rears up on the hind legs and drops belly-first; a quake rolls out both sides', { limb: 'body', side: 'both', reach: 2.3, height: 0.5, ring: 2.3 }),
  [16, 4, 28],
  [
    hb.rect(1.1, 0.4, 2.4, 0.8, 13, 10, 20, 75, { group: 1 }),
    hb.rect(-1.1, 0.4, 2.4, 0.8, 13, 10, 20, 105, { group: 1 }),
  ],
);
const heavyU = body(
  'Bubble Surge',
  'leapUp',
  A('A clumsy hop on a surge of water, splashing a bubble burst overhead', { limb: 'body', side: 'both', reach: 1.2, height: 2.0, rise: 2.4 }),
  [12, 10, 30],
  [hb.circle(0.7, 0.8, 1.0, 7, 9.5, 17, 88, { path: [[0, 0, 0], [8, 0, 0.6]] })],
  { motion: [mot(10, 20, { vx: 2.5, vy: 11.9 })] },
);

export const hippo: MovesetDef = moveset('hippo', 'Wall of meat: armored giant bites and a quaking belly flop, but slow and with the weakest recovery.', stats, [
  mv('lightN', n1, air(n1, { lag: 9 }), [n2]),
  mv('lightS', lightS, air(lightS, { lag: 10 })),
  mv('lightD', lightD, air(lightD, { lag: 10 })),
  mv('lightU', lightU, air(lightU, { lag: 10 })),
  mv('heavyN', heavyN, air(heavyN, { lag: 24 })),
  mv('heavyS', heavyS, air(heavyS, { lag: 26 })),
  mv(
    'heavyD',
    heavyD,
    air(heavyD, {
      lag: 26,
      name: 'Belly Meteor',
      hits: [hb.rect(0.1, -0.3, 1.8, 1.2, 16, 10, 20, 270, { fx: 'spike' })],
      anim: A('Tucks and falls belly-down as a falling boulder', { limb: 'body', side: 'down', reach: 0.9, height: -0.4 }),
    }),
  ),
  mv('heavyU', heavyU, air(heavyU, { lag: 20 })),
]);
