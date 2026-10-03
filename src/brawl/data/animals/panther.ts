/** Panther — assassin / combo fighter. Fast with a 3-hit string and a dash straight through enemies; blink-leap recovery with brief invulnerability; low-mid kill power. */

import type { MovesetDef } from '../../types';
import { A, air, body, cs, hb, linkTo, moveset, mot, mv } from '../helpers';

const stats = cs({
  weight: 78,
  walkSpeed: 5.0,
  runSpeed: 9.2,
  airSpeed: 7.7,
  airAccel: 35.2,
  jumpVel: 15.0,
  airJumpVel: 13.5,
  maxJumps: 2,
  gravityMult: 0.95,
  fallSpeed: 18,
  fastFallSpeed: 27,
  width: 1.1,
  height: 1.35,
});

// lightN — Claw Triple (3 fast)
const n1 = body(
  'Claw',
  'swipe',
  A('Quick right-paw claw slash', { limb: 'claw', side: 'R', reach: 1.5, height: 0.95, arc: 60 }),
  [4, 2, 8],
  [hb.circle(1.0, 0.95, 0.5, 3, 5, 4, 62, { stun: 3.7 })],
  { cancels: linkTo(6, 14, false), turn: true },
);
const n2 = body(
  'Claw 2',
  'backhand',
  A('Left-paw claw slash back across', { limb: 'claw', side: 'L', reach: 1.5, height: 0.95, arc: 60 }),
  [4, 2, 8],
  [hb.circle(1.0, 0.95, 0.5, 3, 5, 4, 62, { stun: 3.7 })],
  { cancels: linkTo(6, 14, true) },
);
const n3 = body(
  'Claw Rake',
  'rake',
  A('Double-clawed downward rake that finishes the string', { limb: 'claw', side: 'both', reach: 1.6, height: 0.9, arc: 80 }),
  [5, 2, 10],
  [hb.circle(1.1, 1.0, 0.5, 3, 7, 10, 50, { path: [[0, 0, 0.2], [2, 0.1, -0.4]] })],
);

const lightS = body(
  'Shadow Slash',
  'lunge',
  A('Darts forward in a low lunge with a single claw slash', { limb: 'claw', side: 'R', reach: 1.8, height: 0.9, travel: 0.8 }),
  [6, 3, 12],
  [hb.rect(1.2, 0.9, 1.2, 0.8, 6, 6, 8, 35)],
  { motion: [mot(3, 8, { vx: 5 })] },
);
const lightD = body(
  'Low Slash',
  'rake',
  A('Drops low and slashes at the shins', { limb: 'claw', side: 'R', reach: 1.65, height: 0.3, arc: 50 }),
  [5, 3, 11],
  [hb.rect(1.1, 0.3, 1.1, 0.5, 5, 5, 6, 60)],
);
const lightU = body(
  'Rising Claw',
  'uppercut',
  A('Claws sweep upward in a rising arc', { limb: 'claw', side: 'R', reach: 1.3, height: 1.9, arc: 110 }),
  [6, 3, 12],
  [hb.circle(0.9, 1.0, 0.5, 6, 6, 8, 88, { path: [[0, 0, 0], [3, -0.4, 0.9]] })],
);

const heavyN = body(
  'Pounce Spin',
  'spinAttack',
  A('A pouncing spin on the spot, claws out on both sides', { limb: 'claw', side: 'both', reach: 1.9, height: 0.95, spin: 1 }),
  [16, 4, 24],
  [
    hb.rect(1.0, 0.95, 1.8, 1.1, 10, 10.8, 22, 40, { group: 1 }),
    hb.rect(-1.0, 0.95, 1.8, 1.1, 10, 10.8, 22, 140, { group: 1 }),
  ],
);
const heavyS = body(
  'Shadow Dash',
  'charge',
  A('Fades into a smoky blur and dashes straight through the target, then rakes as it reappears', { limb: 'claw', side: 'both', reach: 2.1, height: 0.9, travel: 2.5 }),
  [18, 3, 26],
  [
    hb.rect(1.35, 0.9, 1.5, 1.0, 15, 10.8, 24, 42, { group: 1, hitlag: 2 }),
    hb.rect(-0.5, 0.9, 1.4, 1.0, 15, 10.8, 24, 42, { group: 1, hitlag: 2 }),
  ],
  { invuln: { from: 4, to: 13 }, motion: [mot(8, 18, { vx: 15 })] },
);
const heavyD = body(
  'Dive Claw',
  'rake',
  A('Crouches and slashes both claws out low and wide; in the air a diagonal downward dive claw', { limb: 'claw', side: 'both', reach: 2.0, height: 0.4, arc: 90 }),
  [13, 4, 21],
  [hb.rect(1.1, 0.4, 1.8, 0.8, 12, 10, 20, 75)],
);
const heavyU = body(
  'Shadow Leap',
  'leapUp',
  A('Vanishes in smoke and leaps up and forward, reappearing with a claw swipe at the top', { limb: 'claw', side: 'both', reach: 1.5, height: 2.2, rise: 4.1 }),
  [6, 12, 26],
  [hb.circle(0.9, 1.2, 0.6, 7, 9.5, 17, 80, { path: [[0, 0, 0], [10, 0.3, 0.6]] })],
  { invuln: { from: 0, to: 8 }, motion: [mot(4, 16, { vx: 7.5, vy: 15.6 })] },
);

export const panther: MovesetDef = moveset('panther', 'Assassin: blazing combos, a dash that slips through enemies and a vanishing blink-leap recovery.', stats, [
  mv('lightN', n1, air(n1, { lag: 6 }), [n2, n3]),
  mv('lightS', lightS, air(lightS, { lag: 7 })),
  mv('lightD', lightD, air(lightD, { lag: 7 })),
  mv('lightU', lightU, air(lightU, { lag: 6 })),
  mv('heavyN', heavyN, air(heavyN, { lag: 16 })),
  mv('heavyS', heavyS, air(heavyS, { lag: 20 })),
  mv(
    'heavyD',
    heavyD,
    air(heavyD, {
      lag: 18,
      name: 'Dive Claw (air)',
      hits: [hb.rect(1.0, 0.2, 1.4, 1.2, 12, 10, 20, 300)],
      anim: A('Tucked dive angled forward and down, claws leading', { limb: 'claw', side: 'front', reach: 1.7, height: 0.0, pitch: -45 }),
    }),
  ),
  mv('heavyU', heavyU, air(heavyU, { lag: 16 })),
]);
