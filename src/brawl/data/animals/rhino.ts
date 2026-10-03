/** Rhino — momentum charger. Armored first half of a long charge for a high-kill rush; tremor stomp; poor recovery. */

import type { MovesetDef } from '../../types';
import { A, air, body, cs, hb, linkTo, moveset, mot, mv } from '../helpers';

const stats = cs({
  weight: 130,
  walkSpeed: 3.75,
  runSpeed: 7.9,
  airSpeed: 5.5,
  airAccel: 24.2,
  jumpVel: 13.0,
  airJumpVel: 11.5,
  maxJumps: 2,
  gravityMult: 1.15,
  fallSpeed: 21,
  fastFallSpeed: 28,
  width: 1.9,
  height: 1.7,
});

// lightN — Horn Jabs (2 hits)
const n1 = body(
  'Horn Jab',
  'jab',
  A('Short horn jab straight ahead', { limb: 'horn', side: 'front', reach: 2.05, height: 0.95 }),
  [7, 3, 12],
  [hb.rect(1.55, 0.95, 1.0, 0.5, 5, 6, 5, 62, { stun: 3.3 })],
  { cancels: linkTo(10, 22, false), turn: true },
);
const n2 = body(
  'Horn Jab 2',
  'jab',
  A('A second, deeper horn jab', { limb: 'horn', side: 'front', reach: 2.15, height: 0.95 }),
  [6, 3, 13],
  [hb.rect(1.6, 0.95, 1.1, 0.5, 5, 8, 10, 45)],
);

const lightS = body(
  'Horn Sweep',
  'headbutt',
  A('Head swings sideways, sweeping the horn across the front', { limb: 'horn', side: 'front', reach: 2.55, height: 0.9, arc: 90 }),
  [9, 4, 17],
  [hb.rect(1.4, 0.9, 1.5, 0.7, 8, 7, 9, 35, { path: [[0, -0.5, -0.1], [4, 0.4, 0.1]] })],
);
const lightD = body(
  'Hoof Scrape',
  'stomp',
  A('Paws the ground and scrapes a hoof forward along the floor', { limb: 'forelimb', side: 'R', reach: 2.05, height: 0.2 }),
  [8, 3, 15],
  [hb.rect(1.4, 0.2, 1.3, 0.5, 7, 6, 7, 62)],
);
const lightU = body(
  'Horn Toss',
  'hornUp',
  A('Head dips, then the horn flicks up and tosses the target', { limb: 'horn', side: 'front', reach: 1.8, height: 2.3, arc: 90 }),
  [9, 4, 16],
  [hb.circle(1.3, 1.4, 0.6, 8, 7, 10, 85, { path: [[0, 0, -0.5], [4, 0.2, 0.9]] })],
);

const heavyN = body(
  'Stomp Tremor',
  'stomp',
  A('Rears a foreleg and stamps; a grounded tremor rolls out both ways and pops targets up', { limb: 'forelimb', side: 'both', reach: 2.6, height: 0.4, ring: 2.6 }),
  [16, 4, 26],
  [
    hb.rect(1.4, 0.35, 2.4, 0.7, 12, 10, 18, 80, { group: 1 }),
    hb.rect(-1.4, 0.35, 2.4, 0.7, 12, 10, 18, 100, { group: 1 }),
  ],
);
const heavyS = body(
  'Rhino Charge',
  'charge',
  A('Lowers the horn and charges across the floor like a battering ram', { limb: 'horn', side: 'front', reach: 2.4, height: 0.95, travel: 3.9 }),
  [16, 6, 34],
  [hb.rect(1.55, 0.95, 1.7, 1.1, 17, 11, 28, 38, { hitlag: 4 })],
  { armor: { from: 6, to: 18, hits: 1, dmgScale: 0.6 }, motion: [mot(14, 32, { vx: 13 })] },
);
const heavyD = body(
  'Dive Gore',
  'headbutt',
  A('Drives the horn forward and down in a diagonal gore; in the air it dives horn-first', { limb: 'horn', side: 'front', reach: 2.2, height: 0.5 }),
  [15, 4, 25],
  [hb.rect(1.6, 0.5, 1.2, 0.8, 12, 10, 20, 60)],
);
const heavyU = body(
  'Skyward Gore',
  'hornUp',
  A('Heaves the horn up and forward in a rising thrust, the whole body following', { limb: 'horn', side: 'front', reach: 1.9, height: 2.6, rise: 3.4 }),
  [10, 12, 28],
  [hb.circle(1.3, 1.4, 0.65, 9, 9.5, 17, 82, { path: [[0, 0, -0.2], [10, 0.3, 0.8]] })],
  { motion: [mot(8, 20, { vx: 3.1, vy: 13.8 })] },
);

export const rhino: MovesetDef = moveset('rhino', 'Momentum charger: an armored battering-ram rush with kill power, but a poor way back.', stats, [
  mv('lightN', n1, air(n1, { lag: 8 }), [n2]),
  mv('lightS', lightS, air(lightS, { lag: 10 })),
  mv('lightD', lightD, air(lightD, { lag: 9 })),
  mv('lightU', lightU, air(lightU, { lag: 10 })),
  mv(
    'heavyN',
    heavyN,
    air(heavyN, {
      lag: 20,
      name: 'Stomp Tremor (air)',
      hits: [hb.rect(0.4, -0.1, 2.8, 0.9, 11, 10, 20, 60)],
      anim: A('Tucked stomp with the forelegs, shock disc under the body', { limb: 'forelimb', side: 'down', reach: 1.8, height: -0.1 }),
    }),
  ),
  mv('heavyS', heavyS, air(heavyS, { lag: 26 })),
  mv(
    'heavyD',
    heavyD,
    air(heavyD, {
      lag: 24,
      name: 'Dive Gore (air)',
      hits: [hb.circle(1.5, 0.2, 0.65, 14, 10, 20, 300, { fx: 'spike' })],
      anim: A('Dives diagonally down and forward, horn first', { limb: 'horn', side: 'front', reach: 2.1, height: 0.0 }),
    }),
  ),
  mv('heavyU', heavyU, air(heavyU, { lag: 20 })),
]);
