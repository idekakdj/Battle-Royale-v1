/**
 * Archetype library: parametric move-pose generators (plan §6 / types.ts `ArchetypeId`).
 *
 * Each generator is a pure function (move context → {@link ArchSpec}) written in canonical DOFs for the facing +1 frame
 * with the striking limb on the NEAR side. A strike TEMPLATE (`B`) names the free DOFs; the builder (build.ts) solves
 * those for the move's hitbox through forward kinematics of the real rig, so the striking tip always lands in the hitbox
 * ("what you see is what hits"). The anticipation (`A`), pre-strike keys, drift and overshoot give the move its shape.
 *
 * The anatomy lives in the profile: a generator asks for a role FAMILY (fore limb, head/jaw, tail, wing, hind, body) and
 * falls back through the available tips when the animal lacks one (`resolveRole`).
 */

import type { ArchetypeId, MoveBody } from '../../types';
import type { DofName, DofPartial, DofVec } from './dof';
import { DOF } from './dof';
import type { AnimalProfile, ArchCtx, ArchFn, ArchSpec, FreeVar, TipRole } from './profile';

// ── Role resolution ────────────────────────────────────────────────────────────

export type Family = 'fore' | 'hind' | 'head' | 'jaw' | 'tail' | 'wing' | 'body';

/** Map the data's `anim.limb` word (and the archetype's default) to a role family. */
export function familyOf(limb: string | undefined, arch: ArchetypeId): Family {
  const l = (limb ?? '').toLowerCase();
  if (l === 'paw' || l === 'claw' || l === 'talon' || l === 'forelimb' || l === 'foreleg' || l === 'arm' || l === 'fist' || l === 'hand' || l === 'knuckle') return 'fore';
  if (l === 'hindleg' || l === 'hind' || l === 'leg' || l === 'foot' || l === 'hoof') return 'hind';
  if (l === 'jaw' || l === 'mouth' || l === 'fang') return 'jaw';
  if (l === 'head' || l === 'horn' || l === 'beak' || l === 'snout' || l === 'tusk' || l === 'neck') return 'head';
  if (l === 'tail') return 'tail';
  if (l === 'wing') return 'wing';
  if (l === 'body' || l === 'belly') return 'body';
  switch (arch) {
    case 'swipe':
    case 'rake':
    case 'jab':
    case 'uppercut':
    case 'backhand':
    case 'stomp':
    case 'slam':
    case 'spinAttack':
    case 'lunge':
    case 'leapUp':
    case 'burrow':
      return 'fore';
    case 'kick':
      return 'hind';
    case 'bite':
    case 'roar':
      return 'jaw';
    case 'headbutt':
    case 'hornUp':
    case 'charge':
    case 'neckSwing':
    case 'tether':
    case 'dive':
      return 'head';
    case 'tailWhip':
      return 'tail';
    case 'wingBuffet':
      return 'wing';
    default:
      return 'body';
  }
}

/** Resolve the tip role actually used (profile may lack the family). Order = anatomical fall-back chain. */
export function resolveRole(prof: { tips: Partial<Record<TipRole, unknown>> }, fam: Family, side: 'Near' | 'Far'): TipRole {
  const has = (r: TipRole): boolean => prof.tips[r] !== undefined;
  const sided = (base: 'fore' | 'hind' | 'wing'): TipRole => `${base}${side}` as TipRole;
  const chains: Record<Family, TipRole[]> = {
    fore: [sided('fore'), 'foreNear', 'foreFar', sided('wing'), 'head', 'body'],
    hind: [sided('hind'), 'hindNear', 'hindFar', sided('fore'), 'foreNear', 'head', 'body'],
    head: ['head', 'jaw', 'body'],
    jaw: ['jaw', 'head', 'body'],
    tail: ['tail', 'body'],
    wing: [sided('wing'), 'wingNear', 'wingFar', sided('fore'), 'foreNear', 'head', 'body'],
    body: ['body', 'head'],
  };
  for (const r of chains[fam]) if (has(r)) return r;
  return 'body';
}

/** The role family a resolved role belongs to. */
export function famOfRole(r: TipRole): Family {
  if (r === 'foreNear' || r === 'foreFar') return 'fore';
  if (r === 'hindNear' || r === 'hindFar') return 'hind';
  if (r === 'wingNear' || r === 'wingFar') return 'wing';
  if (r === 'head') return 'head';
  if (r === 'jaw') return 'jaw';
  if (r === 'tail') return 'tail';
  return 'body';
}

// ── Building blocks ────────────────────────────────────────────────────────────

function limbDof(base: 'fore' | 'hind' | 'wing', kind: 'Swing' | 'Spread' | 'Bend', near = true): DofName {
  if (base === 'wing') return (near ? 'wingNear' : 'wingFar') + (kind === 'Swing' ? 'Flap' : kind === 'Spread' ? 'Fold' : 'Fold') as DofName;
  return `${base}${near ? 'Near' : 'Far'}${kind}` as DofName;
}

/** The dominant forward-ness sign of the move: flip forward-ish template values when the target is behind. */
function flip(c: ArchCtx, v: number): number {
  return c.dir === 1 ? v : -v;
}

/** Template parameters of a fore-limb strike. Angles in rad, offsets in metres (striker = near limb). */
interface ForeP {
  swing: number;
  spread: number;
  bend: number;
  yaw: number;
  fwd: number;
  up: number;
  pitch: number;
  headP: number;
  aSwing: number;
  aSpread: number;
  aBend: number;
  aYaw: number;
  aFwd: number;
  aUp: number;
  aPitch: number;
  aHeadP: number;
  /** Both fore limbs strike together (the far limb mirrors the near one). */
  both?: boolean;
  swingRange?: readonly [number, number];
  /** Extra DOFs in the strike / anticipation pose (counter-balance, hind legs, tail…). */
  extraB?: DofPartial;
  extraA?: DofPartial;
  /** Free variable ranges. */
  fwdRange?: readonly [number, number];
  upRange?: readonly [number, number];
  pitchRange?: readonly [number, number];
  over?: number;
  drift?: DofPartial;
  ftFrac?: number;
  end?: DofPartial;
}

const P0: ForeP = {
  swing: 1,
  spread: 0,
  bend: 0.3,
  yaw: 0,
  fwd: 0.08,
  up: 0,
  pitch: 0,
  headP: 0,
  aSwing: -0.4,
  aSpread: 0,
  aBend: 0.6,
  aYaw: 0,
  aFwd: 0,
  aUp: 0,
  aPitch: 0,
  aHeadP: 0,
};

function foreSpec(c: ArchCtx, p: ForeP): ArchSpec {
  const near = c.side === 'Near';
  // Templates are written for the near limb; a far-limb strike is side-swapped afterwards.
  const sw = flip(c, p.swing);
  const aSw = flip(c, p.aSwing);
  const B: DofPartial = {
    foreNearSwing: sw,
    foreNearSpread: p.spread,
    foreNearBend: p.bend,
    bodyYaw: p.yaw,
    bodyFwd: flip(c, p.fwd),
    bodyUp: p.up,
    bodyPitch: p.pitch,
    headPitch: p.headP,
    ...p.extraB,
  };
  if (p.both) {
    B.foreFarSwing = sw;
    B.foreFarSpread = p.spread;
    B.foreFarBend = p.bend;
  }
  const rng = p.swingRange ?? [-0.8, 2.7];
  const swR: readonly [number, number] = c.dir === 1 ? rng : [-rng[1], -rng[0]];
  const free: FreeVar[] = [
    { d: 'foreNearSwing', lo: swR[0], hi: swR[1], tie: p.both ? ['foreFarSwing'] : undefined },
    { d: 'foreNearBend', lo: -0.3, hi: 1.5, tie: p.both ? ['foreFarBend'] : undefined },
    { d: 'bodyFwd', lo: c.dir === 1 ? (p.fwdRange?.[0] ?? 0) : -(p.fwdRange?.[1] ?? 0.5), hi: c.dir === 1 ? (p.fwdRange?.[1] ?? 0.5) : -(p.fwdRange?.[0] ?? 0) },
    { d: 'bodyUp', lo: p.upRange?.[0] ?? -0.4, hi: p.upRange?.[1] ?? 0.2 },
    { d: 'bodyPitch', lo: p.pitchRange?.[0] ?? -0.5, hi: p.pitchRange?.[1] ?? 0.6 },
  ];
  const spec: ArchSpec = {
    tip: 'foreNear',
    B,
    free,
    swap: !near,
    A: () => {
      const a: DofPartial = {
        foreNearSwing: aSw,
        foreNearSpread: p.aSpread,
        foreNearBend: p.aBend,
        bodyYaw: p.aYaw,
        bodyFwd: flip(c, p.aFwd),
        bodyUp: p.aUp,
        bodyPitch: p.aPitch,
        headPitch: p.aHeadP,
        tailPitch: 0.2,
        ...p.extraA,
      };
      if (p.both) {
        a.foreFarSwing = aSw;
        a.foreFarSpread = p.aSpread;
        a.foreFarBend = p.aBend;
      }
      return a;
    },
    over: p.over,
    drift: p.drift,
    ftFrac: p.ftFrac,
    end: p.end,
  };
  return spec;
}

/** Head / jaw strike template parameters (striker = the head's tip or the jaw tip). */
interface HeadP {
  neck: number;
  head: number;
  jaw: number;
  fwd: number;
  up: number;
  pitch: number;
  aNeck: number;
  aHead: number;
  aJaw: number;
  aFwd: number;
  aUp: number;
  aPitch: number;
  /** Jaw stays at `preJaw` until `preBefore` frames before the strike, then snaps shut (bite). */
  preJaw?: number;
  preBefore?: number;
  extraB?: DofPartial;
  extraA?: DofPartial;
  neckRange?: readonly [number, number];
  headRange?: readonly [number, number];
  fwdRange?: readonly [number, number];
  upRange?: readonly [number, number];
  pitchRange?: readonly [number, number];
  over?: number;
  drift?: DofPartial;
  ftFrac?: number;
}

const H0: HeadP = { neck: -0.2, head: -0.1, jaw: 0, fwd: 0.25, up: 0, pitch: -0.1, aNeck: 0.3, aHead: 0.2, aJaw: 0, aFwd: -0.1, aUp: 0, aPitch: 0.1 };

function headSpec(c: ArchCtx, p: HeadP, role: TipRole): ArchSpec {
  const fwdR = p.fwdRange ?? [0, 0.6];
  const B: DofPartial = {
    neckPitch: flip(c, p.neck),
    headPitch: p.head,
    jaw: p.jaw,
    bodyFwd: flip(c, p.fwd),
    bodyUp: p.up,
    bodyPitch: p.pitch,
    ...p.extraB,
  };
  const free: FreeVar[] = [
    { d: 'neckPitch', lo: p.neckRange?.[0] ?? -1.1, hi: p.neckRange?.[1] ?? 1.1 },
    { d: 'headPitch', lo: p.headRange?.[0] ?? -0.8, hi: p.headRange?.[1] ?? 0.9 },
    { d: 'bodyFwd', lo: c.dir === 1 ? fwdR[0] : -fwdR[1], hi: c.dir === 1 ? fwdR[1] : -fwdR[0] },
    { d: 'bodyUp', lo: p.upRange?.[0] ?? -0.4, hi: p.upRange?.[1] ?? 0.25 },
    { d: 'bodyPitch', lo: p.pitchRange?.[0] ?? -0.7, hi: p.pitchRange?.[1] ?? 0.7 },
    { d: 'neckExt', lo: 0, hi: 0.9 },
  ];
  const spec: ArchSpec = {
    tip: role,
    B,
    free,
    A: () => ({
      neckPitch: flip(c, p.aNeck),
      headPitch: p.aHead,
      jaw: p.aJaw,
      bodyFwd: flip(c, p.aFwd),
      bodyUp: p.aUp,
      bodyPitch: p.aPitch,
      tailPitch: 0.15,
      ...p.extraA,
    }),
    over: p.over,
    drift: p.drift,
    ftFrac: p.ftFrac,
  };
  if (p.preJaw !== undefined) {
    // The jaw stays open until the last frame(s) before the strike, then snaps shut on the first active frame.
    const before = p.preBefore ?? 1.0;
    spec.pre = [{ before, v: (b: DofVec) => ({ ...vecToPartial(b), jaw: p.preJaw as number }) }];
    // The anticipation holds the jaw open too.
    const baseA = spec.A;
    spec.A = (b) => ({ ...baseA(b), jaw: p.preJaw as number });
  }
  return spec;
}

function vecToPartial(v: DofVec): DofPartial {
  const o: DofPartial = {};
  for (const k in DOF) {
    const x = v[DOF[k as DofName]];
    if (x !== 0) o[k as DofName] = x;
  }
  return o;
}

/** Tail strike. */
function tailSpec(c: ArchCtx, extra: DofPartial = {}): ArchSpec {
  return {
    tip: 'tail',
    B: { tailPitch: 0.9, tail2Pitch: 0.7, tailYaw: 0.5, bodyYaw: -0.15, bodyUp: 0, ...extra },
    free: [
      { d: 'tailPitch', lo: -1.6, hi: 1.9 },
      { d: 'tail2Pitch', lo: -1.2, hi: 1.4 },
      { d: 'tailYaw', lo: -1.3, hi: 1.3 },
      { d: 'bodyPitch', lo: -0.3, hi: 0.4 },
    ],
    A: () => ({ tailPitch: flip(c, -0.7), tail2Pitch: flip(c, -0.4), tailYaw: -0.5, bodyYaw: 0.25, bodyPitch: 0.06 }),
    over: 0.12,
  };
}

/** Wing strike. */
function wingSpec(c: ArchCtx, flapB: number, foldB: number, flapA: number, foldA: number): ArchSpec {
  const near = c.side === 'Near';
  return {
    tip: 'wingNear',
    swap: !near,
    B: { wingNearFlap: flapB, wingNearFold: foldB, wingFarFlap: flapB * 0.7, wingFarFold: foldB * 0.7, bodyPitch: -0.05, bodyFwd: 0.1 },
    free: [
      { d: 'wingNearFlap', lo: -1.6, hi: 1.8 },
      { d: 'wingNearFold', lo: -1.4, hi: 1.6 },
      { d: 'bodyFwd', lo: 0, hi: 0.4 },
      { d: 'bodyPitch', lo: -0.5, hi: 0.5 },
    ],
    A: () => ({ wingNearFlap: flapA, wingNearFold: foldA, wingFarFlap: flapA * 0.7, wingFarFold: foldA * 0.7, bodyPitch: 0.08 }),
  };
}

/** Whole-body strike (belly flop, tackles): the 'body' tip. */
function bodySpec(c: ArchCtx, B: DofPartial, A: DofPartial, free: FreeVar[], extra: Partial<ArchSpec> = {}): ArchSpec {
  void c;
  return { tip: 'body', B, free, A: () => A, ...extra };
}

// ── The library ────────────────────────────────────────────────────────────────

const F = (c: ArchCtx, p: Partial<ForeP>): ArchSpec => foreSpec(c, { ...P0, ...p });
const HD = (c: ArchCtx, role: TipRole, p: Partial<HeadP>): ArchSpec => headSpec(c, { ...H0, ...p }, role);

/** Fallback for any archetype when its natural family is missing: strike with whatever tip exists. */
function genericFallback(c: ArchCtx, fam: Family): ArchSpec | null {
  const r = c.role;
  if (fam === 'head' || fam === 'jaw') {
    return HD(c, r, { neck: -0.3, head: -0.15, fwd: 0.3, aNeck: 0.35, aHead: 0.2, aFwd: -0.1 });
  }
  return null;
}

const swipe: ArchFn = (c) => {
  const fam = famOfRole(c.role);
  if (fam === 'fore' || fam === 'hind') {
    // A sweeping box that chops DOWN (overhand swing) winds up with the limb raised overhead, not pulled back.
    const chop = c.sweepDy < -0.4;
    return F(c, {
      swing: 1.0,
      spread: -0.3,
      bend: 0.5,
      yaw: 0.3,
      fwd: 0.1,
      headP: -0.05,
      aSwing: chop ? 2.2 : -0.55,
      aSpread: chop ? 0.15 : 0.4,
      aBend: chop ? 0.7 : 0.9,
      aYaw: -0.28,
      aFwd: -0.04,
      aPitch: chop ? 0.3 : 0.05,
      extraB: { foreFarSwing: -0.25 },
      extraA: { foreFarSwing: chop ? 0.9 : 0.2 },
      pitchRange: chop ? [-0.7, 0.5] : undefined,
    });
  }
  return genericFallback(c, fam) ?? foreSpec(c, P0);
};

const backhand: ArchFn = (c) => {
  const fam = famOfRole(c.role);
  if (fam === 'fore' || fam === 'hind') {
    return F(c, {
      swing: 1.0,
      spread: 0.45,
      bend: 0.45,
      yaw: 0.3,
      fwd: 0.1,
      aSwing: 0.55,
      aSpread: -0.55,
      aBend: 0.8,
      aYaw: -0.3,
      aFwd: -0.03,
      aPitch: 0.04,
      extraB: { foreFarSwing: -0.2 },
    });
  }
  return genericFallback(c, fam) ?? foreSpec(c, P0);
};

const rake: ArchFn = (c) => {
  const fam = famOfRole(c.role);
  if (fam === 'fore' || fam === 'hind') {
    return F(c, {
      swing: 0.7,
      spread: -0.25,
      bend: 0.4,
      yaw: 0.2,
      fwd: 0.18,
      pitch: -0.12,
      headP: -0.12,
      up: -0.05,
      aSwing: 1.9,
      aSpread: 0.15,
      aBend: 0.7,
      aYaw: -0.15,
      aPitch: 0.3,
      aUp: 0.03,
      extraB: { foreFarSwing: 0.3 },
      extraA: { foreFarSwing: 0.7 },
      pitchRange: [-0.7, 0.4],
    });
  }
  return genericFallback(c, fam) ?? foreSpec(c, P0);
};

const jab: ArchFn = (c) => {
  const fam = famOfRole(c.role);
  if (fam === 'fore' || fam === 'hind') {
    return F(c, {
      swing: 1.35,
      spread: -0.05,
      bend: 0.05,
      yaw: 0.22,
      fwd: 0.14,
      aSwing: 0.35,
      aSpread: 0.1,
      aBend: 1.0,
      aYaw: -0.18,
      aFwd: -0.06,
      extraB: { foreFarSwing: -0.2 },
      extraA: { foreFarSwing: 0.15 },
      over: 0.06,
    });
  }
  return genericFallback(c, fam) ?? foreSpec(c, P0);
};

const uppercut: ArchFn = (c) => {
  const fam = famOfRole(c.role);
  if (fam === 'fore' || fam === 'hind') {
    return F(c, {
      swing: 2.0,
      spread: -0.1,
      bend: 0.25,
      yaw: 0.12,
      fwd: 0.1,
      up: 0.05,
      pitch: 0.18,
      headP: 0.18,
      aSwing: -0.45,
      aSpread: 0.15,
      aBend: 0.7,
      aYaw: -0.15,
      aUp: -0.14,
      aPitch: -0.12,
      aHeadP: -0.1,
      swingRange: [0.2, 3.0],
      extraB: { foreFarSwing: -0.2, tailPitch: -0.3 },
      over: 0.12,
    });
  }
  if (fam === 'head' || fam === 'jaw') {
    return HD(c, c.role, { neck: 0.45, head: 0.5, fwd: 0.15, up: 0.1, pitch: 0.15, aNeck: -0.5, aHead: -0.5, aUp: -0.14, aPitch: -0.12, jaw: 0.1 });
  }
  return foreSpec(c, P0);
};

const bite: ArchFn = (c) => {
  const role = c.role;
  const fam = famOfRole(role);
  if (fam === 'head' || fam === 'jaw') {
    return HD(c, role, {
      neck: -0.25,
      head: -0.15,
      jaw: 0.08,
      fwd: 0.28,
      pitch: -0.1,
      up: 0,
      aNeck: 0.35,
      aHead: 0.3,
      aJaw: 0.85,
      aFwd: -0.12,
      aPitch: 0.1,
      aUp: -0.05,
      preJaw: 0.85,
      preBefore: 1.0,
      extraB: { foreNearSwing: 0.6, foreFarSwing: 0.6 },
      extraA: { foreNearSwing: -0.3, foreFarSwing: -0.3 },
      over: 0.08,
    });
  }
  return foreSpec(c, P0);
};

const headbutt: ArchFn = (c) => {
  const role = c.role;
  const fam = famOfRole(role);
  if (fam === 'head' || fam === 'jaw' || fam === 'body') {
    return HD(c, fam === 'body' ? 'head' : role, {
      neck: -0.18,
      head: -0.1,
      fwd: 0.32,
      pitch: -0.1,
      aNeck: 0.35,
      aHead: 0.3,
      aFwd: -0.14,
      aPitch: 0.1,
      aUp: -0.04,
      extraB: { hindNearSwing: -0.35, hindFarSwing: -0.25 },
      over: 0.1,
    });
  }
  return foreSpec(c, P0);
};

const hornUp: ArchFn = (c) => {
  const role = c.role;
  const fam = famOfRole(role);
  if (fam === 'head' || fam === 'jaw' || fam === 'body') {
    return HD(c, fam === 'body' ? 'head' : role, {
      neck: 0.5,
      head: 0.65,
      fwd: 0.2,
      up: 0.06,
      pitch: 0.28,
      aNeck: -0.55,
      aHead: -0.75,
      aFwd: 0.05,
      aUp: -0.14,
      aPitch: -0.2,
      extraB: { foreNearSwing: 0.5, foreFarSwing: 0.4 },
      neckRange: [-0.3, 1.4],
      headRange: [-0.2, 1.3],
      over: 0.12,
    });
  }
  return foreSpec(c, P0);
};

const lunge: ArchFn = (c) => {
  const fam = famOfRole(c.role);
  if (fam === 'head' || fam === 'jaw') {
    return HD(c, c.role, {
      neck: -0.25,
      head: -0.12,
      jaw: c.role === 'jaw' ? 0.1 : 0.0,
      fwd: 0.42,
      pitch: -0.14,
      up: 0.04,
      aNeck: 0.3,
      aHead: 0.2,
      aJaw: c.role === 'jaw' ? 0.6 : 0,
      aFwd: -0.14,
      aUp: -0.2,
      aPitch: 0.1,
      extraB: { foreNearSwing: 1.1, foreFarSwing: 1.0, hindNearSwing: -0.9, hindFarSwing: -0.7, tailPitch: 0.3 },
      extraA: { foreNearSwing: -0.35, foreFarSwing: -0.35, hindNearSwing: 0.55, hindFarSwing: 0.5 },
      fwdRange: [0, 0.7],
    });
  }
  return F(c, {
    swing: 1.3,
    spread: -0.15,
    bend: 0.25,
    yaw: 0.2,
    fwd: 0.38,
    pitch: -0.14,
    up: 0.04,
    headP: -0.1,
    aSwing: -0.5,
    aBend: 0.9,
    aYaw: -0.15,
    aFwd: -0.12,
    aUp: -0.22,
    aPitch: 0.1,
    both: true,
    extraB: { hindNearSwing: -0.9, hindFarSwing: -0.7, tailPitch: 0.3 },
    extraA: { hindNearSwing: 0.55, hindFarSwing: 0.5 },
    fwdRange: [0, 0.7],
  });
};

const charge: ArchFn = (c) => {
  const role = c.role;
  const fam = famOfRole(role);
  const gallop: DofPartial = { foreNearSwing: 0.9, foreFarSwing: -0.7, hindNearSwing: -0.9, hindFarSwing: 0.7, tailPitch: 0.3 };
  if (fam === 'head' || fam === 'jaw' || fam === 'body') {
    return HD(c, fam === 'body' ? 'head' : role, {
      neck: -0.22,
      head: -0.2,
      fwd: 0.3,
      pitch: -0.13,
      up: -0.04,
      aNeck: 0.1,
      aHead: 0.1,
      aFwd: -0.1,
      aUp: -0.18,
      aPitch: 0.08,
      extraB: gallop,
      extraA: { foreNearSwing: -0.4, foreFarSwing: -0.4, hindNearSwing: 0.6, hindFarSwing: 0.6 },
      over: 0.05,
    });
  }
  return F(c, { swing: 1.0, fwd: 0.3, pitch: -0.12, up: -0.04, aUp: -0.18, aSwing: -0.4, both: true, extraB: gallop });
};

const roar: ArchFn = (c) => {
  const role = c.role;
  const fam = famOfRole(role);
  if (fam === 'head' || fam === 'jaw') {
    return HD(c, role, {
      neck: 0.4,
      head: 0.55,
      jaw: 1.0,
      fwd: 0.0,
      up: 0.1,
      pitch: 0.8,
      aNeck: -0.2,
      aHead: -0.3,
      aJaw: 0,
      aFwd: -0.05,
      aUp: -0.12,
      aPitch: -0.1,
      extraB: { foreNearSwing: 0.7, foreFarSwing: 0.7, foreNearSpread: 0.3, foreFarSpread: 0.3, tailPitch: 0.2 },
      extraA: { foreNearSwing: -0.3, foreFarSwing: -0.3 },
      neckRange: [-0.1, 1.0],
      headRange: [0.1, 1.0],
      pitchRange: [0.35, 1.05],
      fwdRange: [-0.15, 0.2],
      over: 0.1,
    });
  }
  return foreSpec(c, P0);
};

const tether: ArchFn = (c) => {
  const role = c.role;
  const fam = famOfRole(role);
  if (fam === 'head' || fam === 'jaw' || fam === 'body') {
    return HD(c, fam === 'body' ? 'head' : role, {
      neck: -0.45,
      head: -0.2,
      fwd: 0.45,
      pitch: -0.18,
      aNeck: 0.3,
      aHead: 0.2,
      aFwd: -0.15,
      aPitch: 0.1,
      fwdRange: [0, 0.9],
      over: 0.06,
    });
  }
  return foreSpec(c, P0);
};

const neckSwing: ArchFn = (c) => {
  const role = c.role;
  const fam = famOfRole(role);
  if (fam === 'head' || fam === 'jaw' || fam === 'body') {
    return HD(c, fam === 'body' ? 'head' : role, {
      neck: -0.9,
      head: -0.35,
      fwd: 0.15,
      pitch: -0.12,
      aNeck: 0.9,
      aHead: 0.5,
      aFwd: -0.1,
      aPitch: 0.12,
      neckRange: [-1.6, 1.6],
      over: 0.1,
    });
  }
  return foreSpec(c, P0);
};

const dive: ArchFn = (c) => {
  const role = c.role;
  const fam = famOfRole(role);
  const tuck: DofPartial = { foreNearSwing: -0.9, foreFarSwing: -0.9, hindNearSwing: -0.6, hindFarSwing: -0.6, wingNearFold: -1.0, wingFarFold: -1.0, tailPitch: 0.4 };
  const spec = HD(c, fam === 'head' || fam === 'jaw' ? role : 'head', {
    neck: -0.2,
    head: -0.15,
    fwd: 0.25,
    pitch: -0.95,
    up: -0.05,
    aNeck: 0.15,
    aHead: 0.1,
    aFwd: -0.1,
    aUp: 0.1,
    aPitch: 0.45,
    pitchRange: [-1.7, 0.3],
    fwdRange: [0, 0.6],
    extraB: tuck,
    extraA: { foreNearSwing: 0.6, foreFarSwing: 0.6, hindNearSwing: 0.4, hindFarSwing: 0.4, wingNearFlap: 0.8, wingFarFlap: 0.8 },
    over: 0.05,
  });
  return spec;
};

const stomp: ArchFn = (c) => {
  const fam = famOfRole(c.role);
  if (fam === 'fore' || fam === 'hind') {
    const hind = fam === 'hind';
    const dofS = limbDof(hind ? 'hind' : 'fore', 'Swing');
    const s = F(c, {
      swing: 0.35,
      spread: 0,
      bend: 0.1,
      yaw: 0.05,
      fwd: 0.1,
      up: -0.05,
      pitch: -0.05,
      aSwing: 1.35,
      aBend: 0.9,
      aPitch: 0.12,
      aUp: 0.04,
      swingRange: [-0.6, 1.8],
      over: 0.1,
    });
    if (hind) {
      s.tip = 'hindNear';
      s.B = { ...s.B, hindNearSwing: s.B.foreNearSwing ?? 0.35, foreNearSwing: 0, foreNearBend: 0, foreNearSpread: 0 };
      s.free = [{ d: dofS, lo: -0.8, hi: 1.8 }, ...s.free.filter((v) => v.d !== 'foreNearSwing' && v.d !== 'foreNearBend')];
      const a0 = s.A;
      s.A = (b) => {
        const a = a0(b);
        return { ...a, hindNearSwing: a.foreNearSwing ?? 1.3, foreNearSwing: 0, foreNearBend: 0 };
      };
    }
    return s;
  }
  return genericFallback(c, fam) ?? foreSpec(c, P0);
};

const slam: ArchFn = (c) => {
  const fam = famOfRole(c.role);
  if (fam === 'fore' || fam === 'hind') {
    return F(c, {
      swing: 0.45,
      spread: 0,
      bend: 0.1,
      yaw: 0,
      fwd: 0.2,
      up: -0.14,
      pitch: -0.3,
      headP: -0.15,
      aSwing: 2.1,
      aBend: 0.5,
      aUp: 0.12,
      aPitch: 0.5,
      aHeadP: 0.15,
      both: true,
      swingRange: [-0.4, 2.2],
      pitchRange: [-0.8, 0.2],
      extraB: { tailPitch: 0.4 },
      over: 0.1,
    });
  }
  if (fam === 'head' || fam === 'jaw') {
    return HD(c, c.role, { neck: -0.4, head: -0.25, fwd: 0.2, up: -0.1, pitch: -0.35, aNeck: 0.5, aHead: 0.3, aUp: 0.12, aPitch: 0.5, pitchRange: [-0.9, 0.2] });
  }
  return foreSpec(c, P0);
};

const kick: ArchFn = (c) => {
  const fam = famOfRole(c.role);
  if (fam === 'hind' || fam === 'fore') {
    const hind = fam === 'hind';
    const s = F(c, {
      swing: 1.4,
      spread: 0,
      bend: 0.1,
      yaw: -0.05,
      fwd: 0.06,
      up: 0.02,
      pitch: 0.08,
      aSwing: -0.75,
      aBend: 0.9,
      aPitch: -0.1,
      aYaw: 0.05,
      swingRange: [-0.8, 2.4],
      over: 0.08,
    });
    if (hind) {
      s.tip = 'hindNear';
      s.B = { ...s.B, hindNearSwing: s.B.foreNearSwing ?? 1.4, foreNearSwing: 0, foreNearBend: 0, foreNearSpread: 0, foreFarSwing: 0.3 };
      s.free = [{ d: 'hindNearSwing', lo: -1.0, hi: 2.5 }, { d: 'hindNearBend', lo: -0.3, hi: 1.4 }, ...s.free.filter((v) => v.d !== 'foreNearSwing' && v.d !== 'foreNearBend')];
      const a0 = s.A;
      s.A = (b) => {
        const a = a0(b);
        return { ...a, hindNearSwing: a.foreNearSwing ?? -0.75, hindNearBend: a.foreNearBend ?? 0.8, foreNearSwing: 0, foreNearBend: 0, foreFarSwing: -0.2 };
      };
    }
    return s;
  }
  return genericFallback(c, fam) ?? foreSpec(c, P0);
};

const spinAttack: ArchFn = (c) => {
  const turns = typeof c.anim.spin === 'number' ? (c.anim.spin as number) : 1;
  const total = Math.max(0.5, Math.min(2, turns)) * Math.PI * 2;
  const act = Math.max(1, c.A - 1);
  // Per-frame rate cap inside the active window; the rest of the turn is completed in the follow-through.
  const inAct = Math.min(total * 0.7, 0.8 * act);
  const fam = famOfRole(c.role);
  let base: ArchSpec;
  if (fam === 'tail') base = tailSpec(c);
  else if (fam === 'head' || fam === 'jaw') base = HD(c, c.role, { neck: -0.15, head: -0.1, fwd: 0.12, pitch: -0.05, aNeck: 0.2, aHead: 0.1, aFwd: -0.05 });
  else
    base = F(c, {
      swing: 0.7,
      spread: 1.0,
      bend: 0.3,
      yaw: 0,
      fwd: 0.05,
      aSwing: 0.4,
      aSpread: 0.5,
      aBend: 0.6,
      aYaw: -0.5,
      extraB: { foreFarSwing: 0.7, foreFarSpread: 1.0, tailYaw: 0.5 },
      extraA: { foreFarSwing: 0.4 },
    });
  base.drift = { ...(base.drift ?? {}), bodyYaw: inAct };
  base.end = { bodyYaw: total };
  base.over = 0;
  base.ftFrac = 0.5;
  return base;
};

const leapUp: ArchFn = (c) => {
  const fam = famOfRole(c.role);
  if (fam === 'fore' || fam === 'hind') {
    return F(c, {
      swing: 2.0,
      spread: -0.1,
      bend: 0.2,
      yaw: 0.1,
      fwd: 0.1,
      up: 0.14,
      pitch: 0.42,
      headP: 0.25,
      aSwing: -0.45,
      aBend: 0.8,
      aUp: -0.28,
      aPitch: -0.12,
      aHeadP: -0.1,
      both: true,
      swingRange: [0.2, 3.0],
      pitchRange: [-0.1, 1.0],
      upRange: [-0.3, 0.45],
      extraB: { hindNearSwing: -0.55, hindFarSwing: -0.45, tailPitch: -0.3 },
      extraA: { hindNearSwing: 0.7, hindFarSwing: 0.65 },
      over: 0.1,
    });
  }
  if (fam === 'head' || fam === 'jaw' || fam === 'body') {
    return HD(c, fam === 'body' ? 'head' : c.role, {
      neck: 0.45,
      head: 0.5,
      fwd: 0.12,
      up: 0.16,
      pitch: 0.45,
      aNeck: -0.3,
      aHead: -0.3,
      aUp: -0.28,
      aPitch: -0.12,
      pitchRange: [0, 1.0],
      upRange: [-0.3, 0.45],
      extraB: { foreNearSwing: 0.6, foreFarSwing: 0.5, hindNearSwing: -0.55, hindFarSwing: -0.45 },
      extraA: { hindNearSwing: 0.6, hindFarSwing: 0.55 },
    });
  }
  return foreSpec(c, P0);
};

const burrow: ArchFn = (c) => {
  const fam = famOfRole(c.role);
  if (fam === 'fore') {
    return F(c, {
      swing: 1.0,
      spread: 0.2,
      bend: 0.4,
      yaw: 0,
      fwd: 0.14,
      up: -0.26,
      pitch: -0.75,
      headP: -0.2,
      aSwing: 1.5,
      aBend: 0.8,
      aPitch: 0.3,
      aUp: 0.05,
      both: true,
      pitchRange: [-1.3, 0.3],
      upRange: [-0.5, 0.2],
      over: 0.05,
    });
  }
  return HD(c, fam === 'body' ? 'head' : c.role, { neck: -0.3, head: -0.25, fwd: 0.2, up: -0.26, pitch: -0.8, aNeck: 0.3, aHead: 0.3, aPitch: 0.3, aUp: 0.05, pitchRange: [-1.3, 0.3] });
};

const wingBuffet: ArchFn = (c) => {
  const fam = famOfRole(c.role);
  if (fam === 'wing') return wingSpec(c, -0.7, 0.9, 0.9, -0.6);
  if (fam === 'fore' || fam === 'hind') {
    return F(c, { swing: 1.1, spread: 0.4, bend: 0.3, yaw: 0.15, fwd: 0.1, aSwing: -0.4, aSpread: 0.5, aBend: 0.8, aYaw: -0.15, both: true });
  }
  return genericFallback(c, fam) ?? foreSpec(c, P0);
};

const bellyFlop: ArchFn = (c) => {
  return bodySpec(
    c,
    {
      bodyUp: -0.3,
      bodyPitch: -0.15,
      bodyFwd: 0.15,
      foreNearSwing: 0.9,
      foreFarSwing: 0.9,
      foreNearSpread: 0.3,
      foreFarSpread: 0.3,
      hindNearSwing: -0.7,
      hindFarSwing: -0.7,
      headPitch: -0.2,
      neckPitch: -0.2,
    },
    {
      bodyUp: 0.3,
      bodyPitch: 0.4,
      bodyFwd: -0.05,
      foreNearSwing: -0.6,
      foreFarSwing: -0.6,
      hindNearSwing: 0.6,
      hindFarSwing: 0.6,
      headPitch: 0.2,
    },
    [
      { d: 'bodyUp', lo: -0.5, hi: 0.2 },
      { d: 'bodyFwd', lo: -0.2, hi: 0.6 },
      { d: 'bodyPitch', lo: -0.7, hi: 0.4 },
    ],
    { over: 0.08 },
  );
};

const tailWhip: ArchFn = (c) => {
  const fam = famOfRole(c.role);
  if (fam === 'tail') return tailSpec(c);
  if (fam === 'body') return bodySpec(c, { bodyYaw: 0.5, bodyFwd: 0.1 }, { bodyYaw: -0.5 }, [{ d: 'bodyFwd', lo: 0, hi: 0.5 }]);
  return genericFallback(c, fam) ?? tailSpec(c);
};

export const ARCHETYPES: Readonly<Record<ArchetypeId, ArchFn>> = {
  swipe,
  rake,
  jab,
  uppercut,
  backhand,
  bite,
  lunge,
  headbutt,
  hornUp,
  tailWhip,
  spinAttack,
  stomp,
  slam,
  kick,
  wingBuffet,
  dive,
  leapUp,
  charge,
  burrow,
  roar,
  tether,
  neckSwing,
  bellyFlop,
};

/** Constant overlay added to every key of an AERIAL: hind legs tucked, far fore limb drawn in. */
export const AIR_TUCK: DofPartial = { hindNearSwing: 0.5, hindFarSwing: 0.4, foreFarSwing: 0.25, tailPitch: 0.1 };

/** Build the generator context for one move body. */
export function makeCtx(prof: AnimalProfile, body: MoveBody, air: boolean, chain: number, has: (r: TipRole) => boolean, tgt: { x: number; y: number }): ArchCtx {
  const anim = body.anim ?? {};
  const limb = typeof anim.limb === 'string' ? anim.limb : undefined;
  const sideRaw = typeof anim.side === 'string' ? anim.side : 'R';
  const side: 'Near' | 'Far' = sideRaw === 'L' ? 'Far' : 'Near';
  const fam = familyOf(limb, body.archetype);
  const role = resolveRole({ tips: Object.fromEntries((['foreNear', 'foreFar', 'hindNear', 'hindFar', 'head', 'jaw', 'tail', 'wingNear', 'wingFar', 'body'] as TipRole[]).filter(has).map((r) => [r, 1])) }, fam, side);
  let main = body.hitboxes[0];
  for (const h of body.hitboxes) if (main === undefined || h.damage > main.damage) main = h;
  const lastKey = main?.path !== undefined && main.path.length > 0 ? main.path[main.path.length - 1] : undefined;
  return {
    prof,
    body,
    air,
    sweepDx: lastKey?.x ?? 0,
    sweepDy: lastKey?.y ?? 0,
    chain,
    S: body.startup,
    A: body.active,
    R: body.recovery,
    anim,
    role,
    side,
    dir: tgt.x < -0.2 ? -1 : 1,
    tx: tgt.x,
    ty: tgt.y,
    has,
  };
}

