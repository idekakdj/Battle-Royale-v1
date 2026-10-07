/**
 * Battle Royale map thumbnails (v1.8): a small top-down SVG of an {@link ArenaDef}, generated FROM THE ARENA DATA (the real tree /
 * pillar / log / crate / pool / moss positions), so the picture can never drift from the arena the sim plays on. Pure string
 * art — no three / DOM — so the offline menu and the online room screen share it and tests can run it in Node.
 *
 * World XZ metres map to the viewBox as (x, z) -> (x, z); the player's seat (due south, +z) is at the bottom, like the in-match
 * default camera. The viewBox is 2·(wall radius + 2) wide, so both arenas fill the same square.
 */

import type { ArenaDef } from '../config/arenas';

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

function r1(v: number): string {
  return String(Math.round(v * 10) / 10);
}

/**
 * The thumbnail SVG markup for `arena` (a `<svg>` element string, `aria-hidden`, no external references). `className` is added to
 * the root so the host can size it with CSS.
 */
export function arenaThumbSvg(arena: ArenaDef, className = 'gk-mapthumb'): string {
  const p = arena.id === 'jungle' ? JUNGLE_PALETTE : COLOSSEUM_PALETTE;
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
    parts.push(
      `<circle cx="${r1(c.x)}" cy="${r1(c.z)}" r="${r1(Math.max(0.8, c.radius))}" fill="${p.solid}" stroke="${p.solidEdge}" stroke-width="0.4"/>`,
    );
  }
  return (
    `<svg class="${className}" viewBox="${r1(-half)} ${r1(-half)} ${r1(half * 2)} ${r1(half * 2)}" ` +
    `xmlns="http://www.w3.org/2000/svg" aria-hidden="true" focusable="false">${parts.join('')}</svg>`
  );
}
