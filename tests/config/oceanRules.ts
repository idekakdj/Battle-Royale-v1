/**
 * Ocean Dome layout rules as reusable checks (v1.10, docs/OCEAN-HEIGHTS-PLAN.md): each rule returns the list of VIOLATIONS (empty = the
 * layout obeys it). `tests/config/ocean.layout.test.ts` asserts every list is empty; `scripts/ocean-layout.ts` prints them so a layout can
 * be iterated on quickly. Pure functions over an {@link ArenaDef}; nothing here touches the sim.
 */

import type { ArenaDef, ElevationPiece } from '../../src/config/arenas';
import {
  OCEAN_FALL_MIN_DROP,
  OCEAN_UPPER_HEIGHT,
  OCEAN_UPPER_LANDING_Y,
  arenaCliffDistance,
  arenaGroundHeight,
  arenaIsLevel,
  arenaSlopeAt,
} from '../../src/config/arenas';
import { PICKUPS } from '../../src/config/balance';
import { serpentLaneBins } from '../../src/config/serpentLanes';
import { surfaceDist, walkSpace } from './arenaGeom';

export type Ramp = Extract<ElevationPiece, { kind: 'ramp' }>;

export const FIGHTER_R = 1.2; // the largest animal radius (hippo)
export const DEG = Math.PI / 180;

export function rampsOf(arena: ArenaDef): Ramp[] {
  return (arena.heightfield ?? []).filter((p): p is Ramp => p.kind === 'ramp');
}

/** Distance from (x,z) to a ramp's rectangle (0 inside). */
export function rampDist(r: Ramp, x: number, z: number): number {
  const a = r.dirDeg * DEG;
  const c = Math.cos(a);
  const s = Math.sin(a);
  const along = (x - r.x) * c + (z - r.z) * s;
  const lat = -(x - r.x) * s + (z - r.z) * c;
  return Math.hypot(Math.max(0, Math.abs(along) - r.length / 2), Math.max(0, Math.abs(lat) - r.width / 2));
}

export function minRampDist(arena: ArenaDef, x: number, z: number): number {
  let best = Infinity;
  for (const r of rampsOf(arena)) best = Math.min(best, rampDist(r, x, z));
  return best;
}

/**
 * Ramp category by the heights it joins: 'outer' seabed → terrace, 'inner' terrace → plateau, and the two pieces of an upper-tier ramp:
 * 'causeway' / 'chord' (the long LOWER piece from the plateau / the terrace up to the landing height) and 'top' (the short gentle piece up to the tower top).
 */
export type RampRole = 'outer' | 'inner' | 'causeway' | 'chord' | 'top' | 'other';
export function rampRole(r: Ramp): RampRole {
  if (r.h0 === 0 && r.h1 === 1.5) return 'outer';
  if (r.h0 === 1.5 && r.h1 === 3) return 'inner';
  // the lower pieces overlap the top piece by 3 cm along their own plane, so their high end is a hair above the landing height
  if (r.h0 === 3 && Math.abs(r.h1 - OCEAN_UPPER_LANDING_Y) < 0.02) return 'causeway';
  if (r.h0 === 1.5 && Math.abs(r.h1 - OCEAN_UPPER_LANDING_Y) < 0.02) return 'chord';
  if (r.h0 === OCEAN_UPPER_LANDING_Y && r.h1 === OCEAN_UPPER_HEIGHT) return 'top';
  return 'other';
}

/** A sea-stack (upper platform): a plateau piece higher than 6 m. */
export interface StackInfo {
  x: number;
  z: number;
  radius: number;
  height: number;
}
export function stacksOf(arena: ArenaDef): StackInfo[] {
  const out: StackInfo[] = [];
  for (const p of arena.heightfield ?? []) if (p.kind === 'plateau' && p.height > 6) out.push({ x: p.x, z: p.z, radius: p.radius, height: p.height });
  return out;
}

/** The (high end, low end) points of a ramp's axis. */
export function rampEnds(r: Ramp): { high: { x: number; z: number }; low: { x: number; z: number } } {
  const a = r.dirDeg * DEG;
  const c = Math.cos(a);
  const s = Math.sin(a);
  return {
    high: { x: r.x + (c * r.length) / 2, z: r.z + (s * r.length) / 2 },
    low: { x: r.x - (c * r.length) / 2, z: r.z - (s * r.length) / 2 },
  };
}

/** One way up to a stack: the gentle top piece, the long lower piece below it (same axis) and the tower they climb. */
export interface UpperRoute {
  stack: StackInfo;
  top: Ramp;
  lower: Ramp;
  /** The foot (low end of the lower piece) and the level it sits on. */
  foot: { x: number; z: number };
  baseHeight: number;
  /** Distance from the tower's centre to the top piece's high end, i.e. radius − tuck. */
  endDist: number;
  /** Direction (degrees) of the climb, low → high. */
  dirDeg: number;
}

/** Every route to the upper tier: the top pieces (5.9 → 6.5) with their lower piece, matched to the stack they climb. */
export function upperRoutes(arena: ArenaDef): UpperRoute[] {
  const stacks = stacksOf(arena);
  const ramps = rampsOf(arena);
  const out: UpperRoute[] = [];
  for (const top of ramps.filter((r) => rampRole(r) === 'top')) {
    const e = rampEnds(top);
    let best: StackInfo | undefined;
    let bd = Infinity;
    for (const st of stacks) {
      const d = Math.hypot(e.high.x - st.x, e.high.z - st.z);
      if (d < bd) {
        bd = d;
        best = st;
      }
    }
    const lower = ramps.find((r) => ['causeway', 'chord'].includes(rampRole(r)) && r.dirDeg === top.dirDeg && Math.hypot(rampEnds(r).high.x - e.low.x, rampEnds(r).high.z - e.low.z) < 0.05);
    if (best === undefined || lower === undefined) continue;
    out.push({ stack: best, top, lower, foot: rampEnds(lower).low, baseHeight: lower.h0, endDist: bd, dirDeg: top.dirDeg });
  }
  return out;
}

/** True when every sample of the disc of `radius` around (x, z) stands at the same ground height as its centre. */
export function flatDisc(arena: ArenaDef, x: number, z: number, radius: number): boolean {
  const g0 = arenaGroundHeight(arena, x, z);
  for (let k = 1; k <= 3; k++) {
    const rr = (radius * k) / 3;
    for (let i = 0; i < 24; i++) {
      const a = (i / 24) * Math.PI * 2;
      if (Math.abs(arenaGroundHeight(arena, x + Math.cos(a) * rr, z + Math.sin(a) * rr) - g0) > 1e-9) return false;
    }
  }
  return true;
}

/** Distance from the centre of the arena at which a solid's farthest point lies. */
export function solidReach(s: ArenaDef['solids'][number]): number {
  return s.shape === 'circle'
    ? Math.hypot(s.x, s.z) + s.radius
    : s.shape === 'segment'
      ? Math.max(Math.hypot(s.ax, s.az), Math.hypot(s.bx, s.bz)) + s.thickness / 2
      : Math.hypot(s.x, s.z) + s.halfX * Math.SQRT2;
}

/** Surface-to-ramp distance of a solid (axis points sampled). */
export function solidRampGap(arena: ArenaDef, s: ArenaDef['solids'][number]): number {
  const pts: [number, number][] =
    s.shape === 'circle' ? [[s.x, s.z]] : s.shape === 'segment' ? [[s.ax, s.az], [s.bx, s.bz], [(s.ax + s.bx) / 2, (s.az + s.bz) / 2]] : [[s.x, s.z]];
  const extent = s.shape === 'circle' ? s.radius : s.shape === 'segment' ? s.thickness / 2 : s.halfX * Math.SQRT2;
  let best = Infinity;
  for (const [x, z] of pts) best = Math.min(best, minRampDist(arena, x, z) - extent);
  return best;
}

export type Rule = (arena: ArenaDef) => string[];

/** Every solid has baseY = the ground under it, on flat ground with 1 m to spare. */
export const ruleSolidsSeated: Rule = (arena) => {
  const bad: string[] = [];
  arena.solids.forEach((s, i) => {
    if (s.shape === 'circle') {
      if (s.baseY !== arenaGroundHeight(arena, s.x, s.z)) bad.push(`solid ${i} (${s.kind}) baseY ${s.baseY}`);
      if (!flatDisc(arena, s.x, s.z, s.radius + 1)) bad.push(`solid ${i} (${s.kind}) not on flat ground (r+1)`);
      if (!arenaIsLevel(arena, s.x, s.z, s.radius + 1)) bad.push(`solid ${i} (${s.kind}) arenaIsLevel(r+1)`);
    } else if (s.shape === 'segment') {
      for (let k = 0; k <= 8; k++) {
        const x = s.ax + ((s.bx - s.ax) * k) / 8;
        const z = s.az + ((s.bz - s.az) * k) / 8;
        if (arenaGroundHeight(arena, x, z) !== s.baseY) bad.push(`solid ${i} (${s.kind}) baseY at sample ${k}`);
        if (!arenaIsLevel(arena, x, z, s.thickness / 2 + 1)) bad.push(`solid ${i} (${s.kind}) arenaIsLevel at sample ${k}`);
        if (!flatDisc(arena, x, z, s.thickness / 2 + 1)) bad.push(`solid ${i} (${s.kind}) flat at sample ${k}`);
      }
    } else {
      if (s.baseY !== arenaGroundHeight(arena, s.x, s.z)) bad.push(`crate ${i} baseY ${s.baseY}`);
      if (!arenaIsLevel(arena, s.x, s.z, 2.2)) bad.push(`crate ${i} arenaIsLevel(2.2)`);
      if (!flatDisc(arena, s.x, s.z, 2.2)) bad.push(`crate ${i} not flat (2.2)`);
    }
  });
  return bad;
};

/** Every solid stays at most r = wall - 2.5 (no body-sized pocket behind it). */
export const ruleSolidsInside: Rule = (arena) => {
  const bad: string[] = [];
  arena.solids.forEach((s, i) => {
    if (solidReach(s) > arena.wallRadius - 2.5) bad.push(`solid ${i} (${s.kind}) reaches r ${solidReach(s).toFixed(2)}`);
  });
  return bad;
};

/** No solid on or near a ramp (>= 1.8 m from the ramp rectangle to the solid surface). */
export const ruleSolidsOffRamps: Rule = (arena) => {
  const bad: string[] = [];
  arena.solids.forEach((s, i) => {
    const g = solidRampGap(arena, s);
    if (g < 1.8) bad.push(`solid ${i} (${s.kind}) ${g.toFixed(2)}`);
  });
  return bad;
};

/**
 * No round cover within 1 m of a level edge (the ground is flat for its footprint plus 1 m, see ruleSolidsSeated) AND a body of the largest radius
 * can walk between a pillar and a cliff wall that is higher than the ground it stands on: the cliff distance from its centre is at least radius + 2.4 m
 * (a hippo's diameter), so cover never plugs the foot of a wall into a dead strip fighters get pinned in.
 */
export const ruleSolidsAwayFromCliffs: Rule = (arena) => {
  const bad: string[] = [];
  arena.solids.forEach((s, i) => {
    if (s.shape !== 'circle') return;
    const d = arenaCliffDistance(arena, s.x, s.z);
    if (d < s.radius + 2.4 - 1e-9) bad.push(`solid ${i} (${s.kind}) cliff ${d.toFixed(2)} < ${(s.radius + 2.4).toFixed(2)}`);
  });
  return bad;
};

/** Spawn seats: on the seabed, flat, clear of every solid (>= 3.5), of every ramp (>= 3) and of every cliff / tower (>= 3). */
export const ruleSeats: Rule = (arena) => {
  const bad: string[] = [];
  arena.spawns.forEach((sp, si) => {
    if (arenaGroundHeight(arena, sp.x, sp.z) !== 0) bad.push(`seat ${si} not on the seabed`);
    if (!arenaIsLevel(arena, sp.x, sp.z, 2)) bad.push(`seat ${si} not level (2 m)`);
    if (!flatDisc(arena, sp.x, sp.z, 3)) bad.push(`seat ${si} not flat (3 m)`);
    arena.solids.forEach((s, i) => {
      const d = surfaceDist(s, sp.x, sp.z);
      if (d < 3.5) bad.push(`seat ${si} - solid ${i} (${s.kind}) ${d.toFixed(2)}`);
    });
    const rd = minRampDist(arena, sp.x, sp.z);
    if (rd < 3) bad.push(`seat ${si} - ramp ${rd.toFixed(2)}`);
    const cd = arenaCliffDistance(arena, sp.x, sp.z);
    if (cd < 3) bad.push(`seat ${si} - cliff ${cd.toFixed(2)}`);
  });
  return bad;
};

/**
 * Approaches: the 4 m in front of every ramp's low end (and 1 m past its high end) is clear for the biggest body walking straight in: no solid
 * within 1.2 m of the axis (centre line and 1 m either side), so a ramp is never hidden behind cover.
 */
export const ruleApproaches: Rule = (arena) => {
  const bad: string[] = [];
  const cover = arena.solids;
  const clear = (x: number, z: number): number => {
    let best = Infinity;
    for (const o of cover) best = Math.min(best, surfaceDist(o, x, z));
    return best;
  };
  rampsOf(arena).forEach((r, i) => {
    if (rampRole(r) === 'top') return; // (the top piece continues its lower piece)
    const a = r.dirDeg * DEG;
    const c = Math.cos(a);
    const sn = Math.sin(a);
    const role = rampRole(r);
    const tMin = -r.length / 2 - 4;
    const tMax = role === 'causeway' || role === 'chord' ? r.length / 2 : r.length / 2 + 1; // the upper routes end under a tower: only the foot side is open
    for (let t = tMin; t <= tMax; t += 0.5) {
      for (const lat of [-1, 0, 1]) {
        const x = r.x + c * t - sn * lat;
        const z = r.z + sn * t + c * lat;
        const d = clear(x, z);
        if (d < FIGHTER_R) bad.push(`${role} ramp ${i}: solid ${d.toFixed(2)} m from the axis at t ${t.toFixed(1)}, lat ${lat}`);
      }
    }
  });
  return bad;
};

/** Pads: on one flat level (disc of pad + 1.5 m), off every ramp (>= 2.5) and clear of every solid (>= 2.5). */
export const rulePads: Rule = (arena) => {
  const bad: string[] = [];
  for (const p of arena.pickupPads) {
    if (!flatDisc(arena, p.x, p.z, PICKUPS.radius + 1.5)) bad.push(`pad ${p.id} not flat`);
    if (minRampDist(arena, p.x, p.z) < 2.5) bad.push(`pad ${p.id} ramp ${minRampDist(arena, p.x, p.z).toFixed(2)}`);
    if (Math.hypot(p.x, p.z) + PICKUPS.radius >= arena.wallRadius - 2) bad.push(`pad ${p.id} too near the wall`);
    arena.solids.forEach((s, i) => {
      const d = surfaceDist(s, p.x, p.z);
      if (d < 2.5) bad.push(`pad ${p.id} - solid ${i} (${s.kind}) ${d.toFixed(2)}`);
    });
  }
  return bad;
};

/** Cover pieces keep >= 2.4 m from one another, crates >= 1.8 m from cover, crate piles >= 2.4 m from each other. */
export const ruleCoverGaps: Rule = (arena) => {
  const bad: string[] = [];
  const cover = [...arena.circles, ...arena.segments];
  const sample = (o: (typeof cover)[number]): [number, number][] =>
    o.shape === 'circle' ? [[o.x, o.z]] : [[o.ax, o.az], [(o.ax + o.bx) / 2, (o.az + o.bz) / 2], [o.bx, o.bz]];
  const ext = (o: (typeof cover)[number]): number => (o.shape === 'circle' ? o.radius : o.thickness / 2);
  const name = (o: (typeof cover)[number]): string => `${o.kind}@${o.shape === 'circle' ? `${o.x},${o.z}` : `${o.ax},${o.az}`}`;
  for (let i = 0; i < cover.length; i++) {
    for (let k = i + 1; k < cover.length; k++) {
      const a = cover[i];
      const b = cover[k];
      let gap = Infinity;
      for (const [x, z] of sample(b)) gap = Math.min(gap, surfaceDist(a, x, z) - ext(b));
      for (const [x, z] of sample(a)) gap = Math.min(gap, surfaceDist(b, x, z) - ext(a));
      if (gap < 2.4) bad.push(`${name(a)} - ${name(b)} gap ${gap.toFixed(2)}`);
    }
  }
  arena.crates.forEach((c, ci) => {
    for (const s of cover) if (surfaceDist(s, c.x, c.z) - 0.5 < 1.8) bad.push(`crate ${ci} - ${name(s)} ${(surfaceDist(s, c.x, c.z) - 0.5).toFixed(2)}`);
  });
  for (let i = 0; i < arena.crates.length; i++) {
    for (let k = i + 1; k < arena.crates.length; k++) {
      if (Math.floor(i / 3) === Math.floor(k / 3)) continue;
      const a = arena.crates[i];
      const b = arena.crates[k];
      const sep = Math.max(Math.abs(a.x - b.x) - 1, Math.abs(a.z - b.z) - 1);
      if (sep < 2.4) bad.push(`crate ${i} - crate ${k} ${sep.toFixed(2)}`);
    }
  }
  return bad;
};

/**
 * The upper tier (docs/OCEAN-HEIGHTS-PLAN.md, WP-H1): 3 or 4 round stacks (radius 2.8-3.6, top 6.5) with a pad each; every stack reached by
 * a route (grade <= 0.40, width >= 3.6, the top piece's high end 0.4-0.6 m under the rim, its corners inside the tower, the foot flush on
 * the terrace or the plateau, the two pieces joined end to end); >= 2 stacks have two routes (from different directions and different
 * levels); the outer edge is a real cliff (a drop of at least the fall-damage minimum on the cliff side).
 */
export const ruleUpperTier: Rule = (arena) => {
  const bad: string[] = [];
  const stacks = stacksOf(arena);
  if (stacks.length < 3 || stacks.length > 4) bad.push(`${stacks.length} stacks (need 3 or 4)`);
  const routes = upperRoutes(arena);
  const minDrop = arena.hazards?.fallDamage?.minDrop ?? OCEAN_FALL_MIN_DROP;
  stacks.forEach((st, si) => {
    if (st.radius < 2.8 - 1e-9 || st.radius > 3.6 + 1e-9) bad.push(`stack ${si} radius ${st.radius}`);
    if (st.height !== OCEAN_UPPER_HEIGHT) bad.push(`stack ${si} height ${st.height}`);
    const mine = routes.filter((r) => r.stack.x === st.x && r.stack.z === st.z);
    if (mine.length === 0) bad.push(`stack ${si} has no route`);
    if (mine.length >= 2) {
      const gap = (a: number, b: number): number => Math.min(Math.abs(a - b) % 360, 360 - (Math.abs(a - b) % 360));
      for (let i = 0; i < mine.length; i++) {
        for (let k = i + 1; k < mine.length; k++) {
          if (gap(mine[i].dirDeg, mine[k].dirDeg) < 30) bad.push(`stack ${si}: routes ${i}/${k} come from the same direction`);
          if (mine[i].baseHeight === mine[k].baseHeight) bad.push(`stack ${si}: routes ${i}/${k} start on the same level`);
        }
      }
    }
    // a pad on the top (inside the tower, on its flat top)
    const pads = arena.pickupPads.filter((p) => Math.hypot(p.x - st.x, p.z - st.z) <= st.radius - 2.7 + 1e-9);
    if (pads.length === 0) bad.push(`stack ${si} has no pad on its top`);
    for (const p of pads) if (arenaGroundHeight(arena, p.x, p.z) !== st.height) bad.push(`stack ${si} pad ${p.id} not at the top height`);
    // real cliffs: every rim sample that is not on a ramp drops at least `minDrop`; most of the rim is cliff
    let cliff = 0;
    for (let i = 0; i < 72; i++) {
      const a = (i / 72) * Math.PI * 2;
      const x = st.x + Math.cos(a) * (st.radius + 0.6);
      const z = st.z + Math.sin(a) * (st.radius + 0.6);
      if (arenaSlopeAt(arena, x, z) > 0) continue;
      const drop = st.height - arenaGroundHeight(arena, x, z);
      if (drop < minDrop) bad.push(`stack ${si} rim sample ${i}: drop ${drop.toFixed(2)} < ${minDrop}`);
      else cliff++;
    }
    if (cliff < 44) bad.push(`stack ${si}: only ${cliff}/72 of the rim is cliff`);
  });
  if (stacks.filter((st) => routes.filter((r) => r.stack.x === st.x && r.stack.z === st.z).length >= 2).length < 2) bad.push('fewer than 2 stacks have two routes');
  routes.forEach((r, i) => {
    const tuck = r.stack.radius - r.endDist;
    if (tuck < 0.4 - 1e-9 || tuck > 0.6 + 1e-9) bad.push(`route ${i}: tuck ${tuck.toFixed(3)} not in 0.4-0.6`);
    // the top piece's two high-end corners lie inside the tower disc (no notch at the sides)
    const a = r.top.dirDeg * DEG;
    const e = rampEnds(r.top).high;
    for (const sgn of [-1, 1]) {
      const cx = e.x - Math.sin(a) * sgn * (r.top.width / 2);
      const cz = e.z + Math.cos(a) * sgn * (r.top.width / 2);
      if (Math.hypot(cx - r.stack.x, cz - r.stack.z) > r.stack.radius + 0.05) bad.push(`route ${i}: corner outside the tower by ${(Math.hypot(cx - r.stack.x, cz - r.stack.z) - r.stack.radius).toFixed(3)}`);
    }
    for (const piece of [r.top, r.lower]) {
      const grade = Math.abs(piece.h1 - piece.h0) / piece.length;
      if (grade > 0.4 + 1e-9) bad.push(`route ${i}: grade ${grade.toFixed(3)} > 0.40`);
      if (piece.width < 3.6 - 1e-9) bad.push(`route ${i}: width ${piece.width}`);
    }
    // the gentle top: the final 0.6 m of rise is spread so that a body of the largest radius still clears the rim (see config/arenas.ts)
    if (r.top.h0 !== OCEAN_UPPER_LANDING_Y || r.top.h1 !== OCEAN_UPPER_HEIGHT) bad.push(`route ${i}: top piece ${r.top.h0} -> ${r.top.h1}`);
    if (r.baseHeight !== 1.5 && r.baseHeight !== 3) bad.push(`route ${i}: starts at ${r.baseHeight}`);
    // the foot sits flush on the level below: 0.3 m past the low end the ground is the base level
    const lowEnd = rampEnds(r.lower).low;
    const b = r.lower.dirDeg * DEG;
    const gx = lowEnd.x - Math.cos(b) * 0.3;
    const gz = lowEnd.z - Math.sin(b) * 0.3;
    if (Math.abs(arenaGroundHeight(arena, gx, gz) - r.baseHeight) > 1e-6) bad.push(`route ${i}: foot not flush (${arenaGroundHeight(arena, gx, gz)} vs ${r.baseHeight})`);
    // the foot of a route that starts on the terrace is inside the ring, one that starts on the plateau is inside the plateau (corners too)
    for (const sgn of [-1, 1]) {
      const cx = lowEnd.x - Math.sin(b) * sgn * (r.lower.width / 2);
      const cz = lowEnd.z + Math.cos(b) * sgn * (r.lower.width / 2);
      const rr = Math.hypot(cx, cz);
      if (r.baseHeight === 1.5 && (rr > 19 - 0.2 || rr < 8.5)) bad.push(`route ${i}: foot corner at r ${rr.toFixed(2)} outside the terrace`);
      if (r.baseHeight === 3 && rr > 8 - 0.2) bad.push(`route ${i}: foot corner at r ${rr.toFixed(2)} outside the plateau`);
    }
  });
  const bins = serpentLaneBins(arena);
  if (bins.low.length < 150) bad.push(`only ${bins.low.length} low lane bins`);
  if (bins.high.length < 80) bad.push(`only ${bins.high.length} high lane bins`);
  return bad;
};

/** All the geometric rules together, name → violations. */
export const OCEAN_RULES: Readonly<Record<string, Rule>> = {
  solidsSeated: ruleSolidsSeated,
  solidsInside: ruleSolidsInside,
  solidsOffRamps: ruleSolidsOffRamps,
  solidsAwayFromCliffs: ruleSolidsAwayFromCliffs,
  seats: ruleSeats,
  pads: rulePads,
  coverGaps: ruleCoverGaps,
  approaches: ruleApproaches,
  upperTier: ruleUpperTier,
};

// ── reachability ─────────────────────────────────────────────────────────────

export interface ReachReport {
  /** Human-readable misses, `spawn i -> target`. */
  missing: string[];
  /** Walking distance (m) from each spawn to the centre pad (id 0). */
  toCentre: number[];
  /** Per-spawn walking distance to every pad. */
  toPads: number[][];
  /** Fraction of walkable cells reachable from spawn 0. */
  reachedFraction: number;
}

/** Cells within 1 m of (x,z): best (smallest) walking distance in `dist`. */
export function nearDist(ws: ReturnType<typeof walkSpace>, dist: Float64Array, x: number, z: number, cells = 2): number {
  const c = ws.cell(x, z);
  const i0 = Math.floor(c / ws.n);
  const j0 = c % ws.n;
  let best = Infinity;
  for (let di = -cells; di <= cells; di++) for (let dj = -cells; dj <= cells; dj++) best = Math.min(best, dist[(i0 + di) * ws.n + (j0 + dj)] ?? Infinity);
  return best;
}

/**
 * Walk-graph reachability (0.5 m grid, body radius 1.2, the sim's step + cliff rule, ramps only): from EVERY spawn seat, every other seat,
 * every pad (all levels, stack tops included), every stack-top centre (plateau pieces higher than 6 m), every crate pile (a body can stand
 * 1.7 m off one side) and the centre.
 */
export function reachability(arena: ArenaDef, step = 0.5): ReachReport {
  const ws = walkSpace(arena, FIGHTER_R, step);
  const missing: string[] = [];
  const toCentre: number[] = [];
  const toPads: number[][] = [];
  const tops = (arena.heightfield ?? []).filter((p) => p.kind === 'plateau' && p.height > 6);
  arena.spawns.forEach((sp, si) => {
    const dist = ws.distFrom(sp.x, sp.z);
    for (const o of arena.spawns) if (!Number.isFinite(nearDist(ws, dist, o.x, o.z))) missing.push(`spawn ${si} -> spawn at ${o.x},${o.z}`);
    const row: number[] = [];
    for (const p of arena.pickupPads) {
      const d = nearDist(ws, dist, p.x, p.z);
      row.push(d);
      if (!Number.isFinite(d)) missing.push(`spawn ${si} -> pad ${p.id}`);
      if (p.id === 0) toCentre.push(d);
    }
    toPads.push(row);
    tops.forEach((t, ti) => {
      if (t.kind === 'plateau' && !Number.isFinite(nearDist(ws, dist, t.x, t.z))) missing.push(`spawn ${si} -> stack top ${ti}`);
    });
    for (let c = 0; c < arena.crates.length; c += 3) {
      const cr = arena.crates[c];
      const sides: [number, number][] = [
        [cr.x + 2.3, cr.z + 0.5],
        [cr.x - 1.7, cr.z + 0.5],
        [cr.x + 0.5, cr.z + 2.3],
        [cr.x + 0.5, cr.z - 1.7],
      ];
      if (!sides.some(([x, z]) => Number.isFinite(nearDist(ws, dist, x, z)))) missing.push(`spawn ${si} -> crate pile ${c / 3}`);
    }
  });
  const d0 = ws.distFrom(arena.spawns[0].x, arena.spawns[0].z);
  let free = 0;
  let reached = 0;
  for (let c = 0; c < ws.free.length; c++) {
    if (!ws.free[c]) continue;
    free++;
    if (Number.isFinite(d0[c])) reached++;
  }
  return { missing, toCentre, toPads, reachedFraction: reached / free };
}

/** Grades etc. of one ramp, for the script. */
export function describeRamp(arena: ArenaDef, r: Ramp): string {
  const grade = Math.abs(r.h1 - r.h0) / r.length;
  const slope = arenaSlopeAt(arena, r.x, r.z);
  return `${rampRole(r).padEnd(8)} (${r.x.toFixed(2)}, ${r.z.toFixed(2)}) dir ${r.dirDeg.toFixed(1)} len ${r.length} w ${r.width} ${r.h0} -> ${r.h1} grade ${grade.toFixed(3)} (${slope.toFixed(3)})`;
}
