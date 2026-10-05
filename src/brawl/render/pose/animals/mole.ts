/**
 * MOLE limb-role profile (rig: src/render/animals/Mole.ts) — WP-A3.
 *
 * Joints: body, head, snout, armL/armR (the digging claws: shoulder pivots at x ∓0.27, z 0.18, rest rz ∓0.3; `legs.0/1` are the same
 * joints), legs.2/3 (tiny hind feet), tail. armL (−X) is the NEAR claw when facing +1.
 * Verified against the rig: the claws hang −Y from the shoulder (reach 0.44 m), so `−rx` swings them FORWARD, `+rx` back; the near
 * (−X) claw spreads outward with `−rz`; body `+rx` pitches the nose DOWN, `+rz` rolls the near side down (spin about the long axis
 * after the pitch: the drill); the head has no neck joint (neckPitch is folded into the head).
 *
 * Special DOF mappings: `neckExt` = BURROW DEPTH (metres the whole body sinks straight down — the grounded crouch conversion to a
 * squash would clamp it), `bodyCurl` unused.
 */

import type { AnimalProfile, ArchCtx, ArchFn, ArchSpec } from '../profile';
import { registerProfile } from '../profile';
import { ARCHETYPES } from '../archetypes';
import type { DofName, DofPartial, DofVec } from '../dof';
import { DOF } from '../dof';

const TAU = Math.PI * 2;

/** Copy every near-claw DOF of a partial onto the far claw (both claws strike together). */
function bothClaws(p: DofPartial): DofPartial {
  const o: DofPartial = { ...p };
  for (const k of ['Swing', 'Spread', 'Bend'] as const) {
    const n = `foreNear${k}` as DofName;
    const f = `foreFar${k}` as DofName;
    if (p[n] !== undefined) o[f] = p[n];
  }
  return o;
}

/** Wrap a generic archetype so that both claws follow the strike when the move is a two-claw one (dirt fling, low dig, earth pop). */
function pair(base: ArchFn, extraB: DofPartial = {}, extraA: DofPartial = {}): ArchFn {
  return (c: ArchCtx): ArchSpec => {
    const s = base(c);
    if (c.anim.side !== 'both') return s;
    const B = bothClaws({ ...s.B, ...extraB });
    const a0 = s.A;
    return {
      ...s,
      B,
      free: s.free.map((f) => (f.d === 'foreNearSwing' ? { ...f, tie: ['foreFarSwing'] as DofName[] } : f.d === 'foreNearSpread' ? { ...f, tie: ['foreFarSpread'] as DofName[] } : f)),
      A: (b: DofVec) => bothClaws({ ...a0(b), ...extraA }),
    };
  };
}

/** Heavy Neutral — Drill Spin: claws held out like propeller blades, the body spins on the spot (one fast turn, within the rate budget). */
const drillSpin: ArchFn = (c) => {
  const act = Math.max(1, c.A - 1);
  return {
    tip: 'foreNear',
    B: { foreNearSwing: 0.9, foreFarSwing: 0.9, foreNearSpread: 1.0, foreFarSpread: 1.0, bodyPitch: -0.2, headPitch: -0.25, bodyUp: -0.08 },
    free: [],
    A: () => ({ foreNearSwing: 0.2, foreFarSwing: 0.2, foreNearSpread: 0.2, foreFarSpread: 0.2, bodyUp: -0.14, bodyPitch: 0.05, headPitch: -0.3, bodyYaw: -0.5 }),
    drift: { bodyYaw: Math.min(TAU * 0.7, 0.8 * act) },
    end: { bodyYaw: TAU },
    over: 0,
    ftFrac: 0.5,
    noFit: true,
  };
};

/** Heavy Side — Tunnel Lunge: tucked into a drill (claws together in front, body pitched down a little, rolling about its long axis). */
const tunnelLunge: ArchFn = (c) => {
  const act = Math.max(1, c.A - 1);
  return {
    tip: 'foreNear',
    B: { foreNearSwing: 1.45, foreFarSwing: 1.45, foreNearSpread: -0.05, foreFarSpread: -0.05, bodyPitch: -0.3, headPitch: -0.2, bodyFwd: 0.3, bodyUp: 0 },
    free: [
      { d: 'foreNearSwing', lo: 0.9, hi: 1.7, tie: ['foreFarSwing'] },
      { d: 'bodyFwd', lo: 0, hi: 0.5 },
      { d: 'bodyPitch', lo: -0.6, hi: 0.1 },
    ],
    A: () => ({ foreNearSwing: -0.4, foreFarSwing: -0.4, foreNearSpread: 0.35, foreFarSpread: 0.35, bodyUp: -0.12, bodyPitch: 0.25, bodyFwd: -0.1, headPitch: 0.1 }),
    drift: { bodyRoll: Math.min(TAU * 0.6, 0.8 * act) },
    end: { bodyRoll: TAU },
    over: 0.03,
    // WP-P: the rest of the corkscrew turn is spun down over a long follow-through (a short one broke the per-frame budget).
    ftFrac: 0.6,
  };
};

/** Both claws at the same swing / spread (the digging stroke uses them together). */
const claws = (swing: number, spread = 0.3): DofPartial => ({ foreNearSwing: swing, foreFarSwing: swing, foreNearSpread: spread, foreFarSpread: spread });

/**
 * Heavy Down, ground — Burrow Strike (v1.6, WP-B2). The timeline follows the data's `burrow` window `[from, to)` (default 6-24):
 *   f0 .. from   DIG-IN: rear up, claws raised (f ~1.5), scoop down-and-back while the nose dives and the body sinks (`neckExt` = depth)
 *                until only a bump is left on the floor (f ~5); the rig is hidden from `from` on (BrawlView / BrawlRig, `underground`).
 *   from .. to   TUNNEL (hidden): sunk, nose along the tunnel, then the nose comes up and the claws rise (the view shows the mound).
 *   to           the strike peak on the first active frame: claws overhead, nose up, half out of the hole, bursting upward (drift lifts the
 *                body out through the active window); then the generic overshoot / settle lands it back on the floor.
 */
const burrowDig: ArchFn = (c) => {
  if (c.air) return drillDown(c); // (the data gives the air form the 'dive' archetype; this keeps a stray 'burrow' aerial sane)
  const from = Math.max(2, c.body.burrow?.from ?? 6);
  const to = Math.max(from + 2, c.body.burrow?.to ?? c.S);
  const k = from / 6;
  const rise = Math.min(5, (to - from) * 0.5);
  const raw: NonNullable<ArchSpec['script']> = [
    // dig-in: rear up a touch, claws raised, the nose starts to tip down
    { f: 2.8 * k, v: { bodyPitch: 0.1, ...claws(0.8, 0.4), headPitch: -0.15, neckExt: 0.05 }, ease: 'lin' },
    // scoop: claws rake down-and-back, nose dives, the body sinks
    { f: 4.4 * k, v: { bodyPitch: -0.5, ...claws(0.2, 0.55), headPitch: -0.3, neckExt: 0.34 }, ease: 'lin' },
    // nearly gone: only the back is above the floor
    { f: 5.8 * k, v: { bodyPitch: -0.95, ...claws(-0.35, 0.6), headPitch: -0.35, neckExt: 0.7 }, ease: 'inout' },
    // hidden from here
    { f: from + 1.6, v: { bodyPitch: -1.1, ...claws(-0.4, 0.55), headPitch: -0.3, neckExt: 0.88 }, ease: 'inout' },
    { f: (from + to) / 2, v: { bodyPitch: -0.9, ...claws(0.2, 0.4), headPitch: -0.2, neckExt: 0.9 }, ease: 'inout' },
    { f: to - rise, v: { bodyPitch: -0.6, ...claws(0.7, 0.3), headPitch: 0, neckExt: 0.84, bodyFwd: 0.1 }, ease: 'inout' },
    // the nose comes up, the claws rise ahead of the burst
    { f: to - rise * 0.5, v: { bodyPitch: 0.1, ...claws(1.7, 0.3), headPitch: 0.15, neckExt: 0.5, bodyFwd: 0.28 }, ease: 'lin' },
  ];
  const script = raw.filter((s) => s.f > 0.2 && s.f < to - 0.4);
  return {
    tip: 'foreNear',
    B: { bodyPitch: 0.6, ...claws(2.5, 0.25), headPitch: 0.3, bodyFwd: 0.45, neckExt: 0.16 },
    free: [
      { d: 'foreNearSwing', lo: 1.5, hi: 2.9, tie: ['foreFarSwing'] },
      { d: 'bodyFwd', lo: 0.2, hi: 0.7 },
      { d: 'bodyPitch', lo: 0.2, hi: 1.0 },
      { d: 'bodyUp', lo: 0, hi: 0.5 },
    ],
    A: () => ({ bodyPitch: 0.1, ...claws(1.7, 0.3), headPitch: 0.15, neckExt: 0.5, bodyFwd: 0.28 }),
    script,
    strikeEase: 'out',
    strikePow: 1.3,
    // the burst keeps going through the active window: the body is thrown out of the hole, the claws rise
    drift: { foreNearSwing: 0.4, foreFarSwing: 0.4, bodyPitch: 0.15, neckExt: -0.16, bodyUp: 0.1 },
    over: 0.05,
    ftFrac: 0.1,
    commit: 0,
    // the body drops back onto all fours quickly after the burst, then eases in
    settleEase: 'out',
    settlePow: 1.5,
    windup: false,
  };
};

/** Heavy Down, air — Drill Down (the air form of the move is an `dive`): nose and claws straight down, spinning about the long axis. */
const drillDown: ArchFn = (c) => ({
  tip: 'foreNear',
  B: { bodyPitch: -1.35, foreNearSwing: 1.5, foreFarSwing: 1.5, foreNearSpread: -0.05, foreFarSpread: -0.05, headPitch: -0.1, bodyFwd: 0.1 },
  free: [
    { d: 'bodyPitch', lo: -1.5, hi: -0.6 },
    { d: 'bodyFwd', lo: -0.1, hi: 0.4 },
    { d: 'foreNearSwing', lo: 1.0, hi: 1.8, tie: ['foreFarSwing'] },
  ],
  A: () => ({ bodyPitch: 0.5, foreNearSwing: 2.2, foreFarSwing: 2.2, foreNearSpread: 0.3, foreFarSpread: 0.3, bodyUp: 0.06, headPitch: 0.3 }),
  drift: { bodyRoll: Math.min(TAU * 0.5, 0.8 * Math.max(1, c.A - 1)) },
  end: { bodyRoll: TAU },
  over: 0.04,
  // the rest of the turn is spun down over a long follow-through (a short one broke the per-frame budget)
  ftFrac: 0.55,
});

/** Heavy Up — Drill Ascent: nose straight up, claws stretched above the head, rolling about the long axis like a corkscrew. */
const drillAscent: ArchFn = (c) => {
  const act = Math.max(1, c.A - 1);
  return {
    tip: 'foreNear',
    B: { bodyPitch: 1.4, foreNearSwing: 1.55, foreFarSwing: 1.55, foreNearSpread: -0.05, foreFarSpread: -0.05, headPitch: 0.1, bodyFwd: 0.12 },
    free: [
      { d: 'bodyFwd', lo: 0, hi: 0.35 },
      { d: 'bodyPitch', lo: 0.9, hi: 1.55 },
    ],
    A: () => ({ bodyPitch: -0.45, foreNearSwing: -0.5, foreFarSwing: -0.5, foreNearSpread: 0.3, foreFarSpread: 0.3, bodyUp: -0.14, headPitch: -0.3 }),
    drift: { bodyRoll: Math.min(TAU * 1.0, 0.45 * act) },
    end: { bodyRoll: TAU },
    over: 0,
    ftFrac: 0.4,
  };
};

export const moleProfile: AnimalProfile = {
  animal: 'mole',
  links: {
    bodyPitch: [{ j: 'body', ch: 'rx', k: -1 }],
    bodyYaw: [{ j: 'body', ch: 'ry', k: 1 }],
    bodyRoll: [{ j: 'body', ch: 'rz', k: 1 }],
    bodyFwd: [{ j: 'body', ch: 'pz', k: 1 }],
    bodyUp: [{ j: 'body', ch: 'py', k: 1 }],
    bodyStretch: [{ j: 'body', ch: 's', k: 1 }],
    neckExt: [{ j: 'body', ch: 'py', k: -1 }],
    neckPitch: [{ j: 'head', ch: 'rx', k: -0.5 }],
    neckYaw: [{ j: 'head', ch: 'ry', k: -0.5 }],
    headPitch: [
      { j: 'head', ch: 'rx', k: -1 },
      { j: 'snout', ch: 'rx', k: -0.4 },
    ],
    headYaw: [{ j: 'head', ch: 'ry', k: -1 }],
    headRoll: [{ j: 'head', ch: 'rz', k: 1 }],
    tailPitch: [{ j: 'tail', ch: 'rx', k: 1 }],
    tailYaw: [{ j: 'tail', ch: 'rz', k: -1 }],
    foreNearSwing: [{ j: 'armL', ch: 'rx', k: -1 }],
    foreNearSpread: [{ j: 'armL', ch: 'rz', k: -1 }],
    foreFarSwing: [{ j: 'armR', ch: 'rx', k: -1 }],
    foreFarSpread: [{ j: 'armR', ch: 'rz', k: 1 }],
    hindNearSwing: [{ j: 'legs.2', ch: 'rx', k: -1 }],
    hindNearSpread: [{ j: 'legs.2', ch: 'rz', k: -1 }],
    hindFarSwing: [{ j: 'legs.3', ch: 'rx', k: -1 }],
    hindFarSpread: [{ j: 'legs.3', ch: 'rz', k: 1 }],
  },
  tips: {
    foreNear: { j: 'armL', off: [0, -0.44, 0.04] },
    foreFar: { j: 'armR', off: [0, -0.44, 0.04] },
    hindNear: { j: 'legs.2', off: [0, -0.15, 0.08] },
    hindFar: { j: 'legs.3', off: [0, -0.15, 0.08] },
    head: { j: 'snout', off: [0, 0, 0.3] },
    body: { j: 'body', off: [0, 0.02, 0.4] },
  },
  mirror: [
    ['armL', 'armR'],
    ['legs.2', 'legs.3'],
  ],
  hipDrop: 0.22,
  hipHeight: 0.34,
  hangTilt: 0.9,
  limits: {
    foreNearSwing: [-1.3, 3.1],
    foreFarSwing: [-1.3, 3.1],
    foreNearSpread: [-0.6, 1.4],
    foreFarSpread: [-0.6, 1.4],
    hindNearSwing: [-1.0, 1.2],
    hindFarSwing: [-1.0, 1.2],
    bodyPitch: [-1.55, 1.55],
    neckPitch: [-0.8, 0.8],
    headPitch: [-0.8, 0.8],
  },
  overrides: {
    swipe: pair(ARCHETYPES.swipe),
    rake: pair(ARCHETYPES.rake),
    uppercut: pair(ARCHETYPES.uppercut),
    spinAttack: drillSpin,
    charge: tunnelLunge,
    burrow: burrowDig,
    dive: drillDown,
    leapUp: drillAscent,
  },
  note: 'hand-written (WP-A3)',
};

void DOF;
registerProfile(moleProfile);
