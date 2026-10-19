/**
 * Battle Royale map thumbnails (v1.8): a small top-down SVG of an {@link ArenaDef}, generated FROM THE ARENA DATA (the real tree /
 * pillar / log / crate / pool / moss positions), so the picture can never drift from the arena the sim plays on. Pure string
 * art — no three / DOM — so the offline menu and the online room screen share it and tests can run it in Node.
 *
 * World XZ metres map to the viewBox as (x, z) -> (x, z); the player's seat (due south, +z) is at the bottom, like the in-match
 * default camera. The viewBox is 2·(wall radius + 2) wide, so every arena fills the same square.
 *
 * v1.9 Ocean Dome: the arena's `heightfield` is drawn level by level (the terrace ring and the plateau shaded lighter with height,
 * every ramp as a short stepped wedge that blends from its low end's shade to its high end's), and an arena with a sea-serpent
 * hazard gets a faint red strip hint (the telegraphed strike line) with a small head chevron outside the dome.
 *
 * v1.10 upper tier: the sea-stack towers (flat pieces at or above {@link UPPER_FROM_M}) get their own pale-violet tone with a dark
 * cliff edge, and the ramps that climb to them blend from the plateau's shade into that tone (the pad dot on each top is the usual
 * pad). An arena with the second (high) serpent shows a violet strip hint too, along a lane the high serpent really uses, next to
 * the red one along a lane the low serpent really uses (both picked from `serpentLaneBins`, so the picture never lies).
 */

import type { ArenaDef, ElevationPiece } from '../config/arenas';
import { arenaHasHighSerpent } from '../config/arenas';
import { serpentLaneBins } from '../config/serpentLanes';

/** Per-arena palette (CSS colours). Unknown arena ids use the colosseum's. */
interface ThumbPalette {
  ground: string;
  groundEdge: string;
  ring: string;
  ringEdge: string;
  solid: string;
  solidEdge: string;
  segment: string;
  crate: string;
  pad: string;
  water: string;
  waterEdge: string;
  moss: string;
  /** Optional per-kind overrides of `solid` for the round blockers (ocean: coral pillars / rock outcrops). */
  coral?: string;
  rock?: string;
  /** Ground shade of the highest level: raised levels blend from `ground` (height 0) toward it (heightfield arenas). */
  top?: string;
  /** The faint strike-strip hint colour (arenas with a sea-serpent hazard). */
  hazard?: string;
  /** Tone of the upper tier (flat pieces at or above {@link UPPER_FROM_M}) and its cliff edge. */
  upper?: string;
  upperEdge?: string;
  /** The faint strike-strip hint colour of the HIGH serpent (arenas with the second serpent). */
  hazardHigh?: string;
}

const COLOSSEUM_PALETTE: ThumbPalette = {
  ground: '#c9a15a',
  groundEdge: '#8a6a33',
  ring: '#5b5249',
  ringEdge: '#2f2a25',
  solid: '#d8d0c0',
  solidEdge: '#7a7164',
  segment: '#b8ad98',
  crate: '#8d5a2b',
  pad: '#ffd36b',
  water: '#4aa8c8',
  waterEdge: '#bfe9f5',
  moss: '#5fa83a',
};

const JUNGLE_PALETTE: ThumbPalette = {
  ground: '#3d6b2e',
  groundEdge: '#244a1c',
  ring: '#12301a',
  ringEdge: '#0a1c10',
  solid: '#26521f',
  solidEdge: '#0f2a0c',
  segment: '#7a5a34',
  crate: '#b08a4c',
  pad: '#ffe27a',
  water: '#2f9fc4',
  waterEdge: '#aee8f5',
  moss: '#8fd04a',
};

const OCEAN_PALETTE: ThumbPalette = {
  ground: '#3f8796',
  groundEdge: '#a8ecff',
  ring: '#0a3350',
  ringEdge: '#05192a',
  solid: '#7b8794',
  solidEdge: '#1d3a4a',
  segment: '#d77a96',
  crate: '#a8742f',
  pad: '#ffe27a',
  water: '#2f9fc4',
  waterEdge: '#aee8f5',
  moss: '#5fa83a',
  coral: '#ff7a9a',
  rock: '#8a98a6',
  top: '#c4f1e6',
  hazard: '#ff4a3a',
  upper: '#cfa8ff',
  upperEdge: '#3b1d73',
  hazardHigh: '#c36bff',
};

/** Flat pieces at least this high (metres) are the upper tier (the sea-stack towers, 6.5 m): drawn in the `upper` tone. */
export const UPPER_FROM_M = 6;

function r1(v: number): string {
  return String(Math.round(v * 10) / 10);
}

function hexToRgb(hex: string): [number, number, number] {
  const h = hex.replace('#', '');
  return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
}

/** Linear blend of two `#rrggbb` colours (`t` clamped to 0..1). */
export function mixHex(a: string, b: string, t: number): string {
  const k = t < 0 ? 0 : t > 1 ? 1 : t;
  const ca = hexToRgb(a);
  const cb = hexToRgb(b);
  const c = ca.map((v, i) => Math.round(v + (cb[i] - v) * k));
  return `#${c.map((v) => v.toString(16).padStart(2, '0')).join('')}`;
}

/** Highest surface of a heightfield (0 when none), so shades can be normalised. */
function maxLevel(hf: readonly ElevationPiece[]): number {
  let m = 0;
  for (const p of hf) m = Math.max(m, p.kind === 'ramp' ? Math.max(p.h0, p.h1) : p.height);
  return m;
}

/** Highest FLAT level below {@link UPPER_FROM_M} (the plateau, 3 m): the lightest of the ordinary mint shades. */
function maxLowLevel(hf: readonly ElevationPiece[]): number {
  let m = 0;
  for (const p of hf) if (p.kind !== 'ramp' && p.height < UPPER_FROM_M) m = Math.max(m, p.height);
  return m;
}

/** SVG path of a full circle (so an annulus can use `fill-rule: evenodd`). */
function circlePath(x: number, z: number, r: number): string {
  return `M${r1(x - r)} ${r1(z)}a${r1(r)} ${r1(r)} 0 1 0 ${r1(r * 2)} 0a${r1(r)} ${r1(r)} 0 1 0 ${r1(-r * 2)} 0`;
}

const RAMP_SLICES = 4;

/** The elevation pieces, flat discs/rings first (lowest first) then the ramps on top. */
function elevationMarkup(arena: ArenaDef, p: ThumbPalette): string[] {
  const hf = arena.heightfield;
  if (hf === undefined || hf.length === 0) return [];
  const top = p.top ?? '#ffffff';
  const hAll = Math.max(0.001, maxLevel(hf));
  const hLow = maxLowLevel(hf);
  const upper = p.upper ?? top;
  // Ordinary levels: ground -> mint (the plateau is the lightest). Above the plateau (the towers' ramps and tops): mint -> `upper`.
  const hMax = Math.max(0.001, hLow > 0 && hAll > hLow ? hLow : hAll);
  const shade = (h: number): string =>
    h <= hMax || hAll <= hMax
      ? mixHex(p.ground, top, (Math.min(h, hMax) / hMax) * 0.85)
      : mixHex(mixHex(p.ground, top, 0.85), upper, (h - hMax) / (hAll - hMax));
  const parts: string[] = [];
  const flats = hf
    .filter((e): e is Exclude<ElevationPiece, { kind: 'ramp' }> => e.kind !== 'ramp')
    .sort((a, b) => a.height - b.height);
  for (const e of flats) {
    const isUpper = p.upper !== undefined && e.height >= UPPER_FROM_M;
    const fill = isUpper ? upper : shade(e.height);
    if (e.kind === 'plateau') {
      parts.push(
        isUpper
          ? `<circle cx="${r1(e.x)}" cy="${r1(e.z)}" r="${r1(e.radius)}" fill="${fill}" stroke="${p.upperEdge ?? p.groundEdge}" stroke-width="0.9" data-tier="upper"/>`
          : `<circle cx="${r1(e.x)}" cy="${r1(e.z)}" r="${r1(e.radius)}" fill="${fill}" stroke="${p.groundEdge}" stroke-width="0.5" stroke-opacity="0.8"/>`,
      );
    } else {
      parts.push(
        `<path d="${circlePath(e.x, e.z, e.rOuter)}${circlePath(e.x, e.z, e.rInner)}" fill="${fill}" fill-rule="evenodd" stroke="${p.groundEdge}" stroke-width="0.5" stroke-opacity="0.8"/>`,
      );
    }
  }
  for (const e of hf) {
    if (e.kind !== 'ramp') continue;
    const sliceLen = e.length / RAMP_SLICES;
    const slices: string[] = [];
    for (let i = 0; i < RAMP_SLICES; i++) {
      const h = e.h0 + ((e.h1 - e.h0) * (i + 0.5)) / RAMP_SLICES;
      slices.push(
        `<rect x="${r1(-e.length / 2 + i * sliceLen)}" y="${r1(-e.width / 2)}" width="${r1(sliceLen + 0.1)}" height="${r1(e.width)}" fill="${shade(h)}"/>`,
      );
    }
    slices.push(
      `<rect x="${r1(-e.length / 2)}" y="${r1(-e.width / 2)}" width="${r1(e.length)}" height="${r1(e.width)}" fill="none" stroke="${p.groundEdge}" stroke-width="0.4" stroke-opacity="0.9"/>`,
    );
    parts.push(`<g transform="translate(${r1(e.x)} ${r1(e.z)}) rotate(${r1(e.dirDeg)})">${slices.join('')}</g>`);
  }
  return parts;
}

/** Strike angle of the faint serpent hint (degrees, direction (cos, sin) in (x, z)): up-right, clear of the player's seat at the bottom. */
export const THUMB_SERPENT_DEG = 305;
/** The HIGH serpent's hint points toward the left-hand tower (180 degrees), away from the low hint. */
export const THUMB_SERPENT_HIGH_DEG = 180;

/** The allowed 1-degree bin nearest to `deg` (circular), as the angle of the bin's middle; `deg` itself when there are no bins. */
function nearestBinMiddle(bins: readonly number[], deg: number): number {
  let best = deg;
  let bestD = Infinity;
  for (const b of bins) {
    const d = Math.abs((((b + 0.5 - deg) % 360) + 540) % 360 - 180);
    if (d < bestD) {
      bestD = d;
      best = b + 0.5;
    }
  }
  return best;
}

/** One faint telegraphed strip (a translucent bar centre -> edge at `deg`) plus a small head chevron just outside the wall. */
function stripMarkup(arena: ArenaDef, colour: string, deg: number, tier: 'low' | 'high'): string {
  const R = arena.wallRadius;
  const len = R + 2;
  const half = 1.8;
  const chev = `M${r1(R + 1.6)} 0 L${r1(R + 5)} ${r1(-2.4)} L${r1(R + 3.6)} 0 L${r1(R + 5)} ${r1(2.4)} Z`;
  return (
    `<g transform="rotate(${r1(deg)})" data-hint="serpent" data-tier="${tier}">` +
    `<rect x="0" y="${r1(-half)}" width="${r1(len)}" height="${r1(half * 2)}" fill="${colour}" fill-opacity="0.26"/>` +
    `<path d="${chev}" fill="${colour}" fill-opacity="0.85"/></g>`
  );
}

/**
 * The faint telegraphed-strip hints: a red one for the low serpent and (v1.10, arenas with the high lane) a violet one for the high
 * serpent, each along an angle its lane really uses (nearest allowed bin to the nominal hint angle).
 */
function hazardMarkup(arena: ArenaDef, p: ThumbPalette): string[] {
  if (arena.hazards?.serpent !== true) return [];
  if (!arenaHasHighSerpent(arena)) return [stripMarkup(arena, p.hazard ?? '#ff4a3a', THUMB_SERPENT_DEG, 'low')];
  const bins = serpentLaneBins(arena);
  return [
    stripMarkup(arena, p.hazard ?? '#ff4a3a', nearestBinMiddle(bins.low, THUMB_SERPENT_DEG), 'low'),
    stripMarkup(arena, p.hazardHigh ?? '#c36bff', nearestBinMiddle(bins.high, THUMB_SERPENT_HIGH_DEG), 'high'),
  ];
}

/**
 * The thumbnail SVG markup for `arena` (a `<svg>` element string, `aria-hidden`, no external references). `className` is added to
 * the root so the host can size it with CSS.
 */
export function arenaThumbSvg(arena: ArenaDef, className = 'gk-mapthumb'): string {
  const p = arena.id === 'ocean' ? OCEAN_PALETTE : arena.id === 'jungle' ? JUNGLE_PALETTE : COLOSSEUM_PALETTE;
  const half = arena.wallRadius + 2;
  const parts: string[] = [];
  // Outer ring (stands / foliage) then the walkable ground disc.
  parts.push(`<circle cx="0" cy="0" r="${r1(half)}" fill="${p.ring}" stroke="${p.ringEdge}" stroke-width="0.6"/>`);
  parts.push(`<circle cx="0" cy="0" r="${r1(arena.wallRadius)}" fill="${p.ground}" stroke="${p.groundEdge}" stroke-width="0.8"/>`);
  // Terrain zones (moss under the pool so the shoreline reads).
  for (const z of arena.terrain) {
    if (z.kind === 'moss') parts.push(`<circle cx="${r1(z.x)}" cy="${r1(z.z)}" r="${r1(z.radius)}" fill="${p.moss}" opacity="0.8"/>`);
  }
  for (const z of arena.terrain) {
    if (z.kind === 'water') {
      parts.push(
        `<circle cx="${r1(z.x)}" cy="${r1(z.z)}" r="${r1(z.radius)}" fill="${p.water}" stroke="${p.waterEdge}" stroke-width="0.7"/>`,
      );
    }
  }
  // v1.9 ocean: the raised levels (terrace ring, plateau) and the ramps joining them, shaded by height.
  parts.push(...elevationMarkup(arena, p));
  // The colosseum's raised dais (walkable disc).
  if (arena.dais !== undefined) {
    parts.push(
      `<circle cx="${r1(arena.dais.x)}" cy="${r1(arena.dais.z)}" r="${r1(arena.dais.radius)}" fill="none" stroke="${p.solidEdge}" stroke-width="0.7" stroke-dasharray="1.6 1.2"/>`,
    );
  }
  // Pickup pads.
  for (const pad of arena.pickupPads) {
    parts.push(`<circle cx="${r1(pad.x)}" cy="${r1(pad.z)}" r="0.9" fill="${p.pad}" opacity="0.9"/>`);
  }
  // Logs / fallen columns, crates, then the tall blockers (trees / pillars) on top.
  for (const s of arena.segments) {
    parts.push(
      `<line x1="${r1(s.ax)}" y1="${r1(s.az)}" x2="${r1(s.bx)}" y2="${r1(s.bz)}" stroke="${p.segment}" stroke-width="${r1(Math.max(1, s.thickness))}" stroke-linecap="round"/>`,
    );
  }
  for (const c of arena.crates) {
    parts.push(
      `<rect x="${r1(c.x - c.halfX)}" y="${r1(c.z - c.halfZ)}" width="${r1(c.halfX * 2)}" height="${r1(c.halfZ * 2)}" fill="${p.crate}"/>`,
    );
  }
  for (const c of arena.circles) {
    const fill = c.kind === 'coral' ? (p.coral ?? p.solid) : c.kind === 'rock' ? (p.rock ?? p.solid) : p.solid;
    parts.push(
      `<circle cx="${r1(c.x)}" cy="${r1(c.z)}" r="${r1(Math.max(0.8, c.radius))}" fill="${fill}" stroke="${p.solidEdge}" stroke-width="0.4"/>`,
    );
  }
  parts.push(...hazardMarkup(arena, p));
  return (
    `<svg class="${className}" viewBox="${r1(-half)} ${r1(-half)} ${r1(half * 2)} ${r1(half * 2)}" ` +
    `xmlns="http://www.w3.org/2000/svg" aria-hidden="true" focusable="false">${parts.join('')}</svg>`
  );
}
