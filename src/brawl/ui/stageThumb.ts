/**
 * Champions League — CSS/SVG thumbnails of the stage layouts, drawn from the REAL StageDef geometry (solid
 * platforms as thick blocks, soft platforms as thin planks, the moving platform with its travel range, spawn dots).
 * Pure string builder (no DOM) so it is unit-testable.
 */

import type { PlatformDef, StageDef } from '../types';

const VIEW = { x0: -17, x1: 17, yTop: 11.5, yBottom: -7 };

interface Sky {
  top: string;
  bottom: string;
  sun: string;
  stone: string;
  stoneEdge: string;
  plank: string;
}

const SKIES: Record<string, Sky> = {
  brokenColosseum: { top: '#3b2418', bottom: '#e79b4d', sun: '#ffd48a', stone: '#6b5a44', stoneEdge: '#d9a441', plank: '#b98a4e' },
  skyAqueduct: { top: '#2a4a73', bottom: '#b8dcf0', sun: '#ffffff', stone: '#7d8794', stoneEdge: '#cfe6f5', plank: '#a3b5c4' },
};

const f = (n: number): string => (Math.round(n * 100) / 100).toString();

function platformSvg(p: PlatformDef, sky: Sky): string {
  const y = -p.y; // svg y grows downward
  const w = p.x1 - p.x0;
  if (p.kind === 'solid') {
    return (
      `<rect class="bs-solid" x="${f(p.x0)}" y="${f(y)}" width="${f(w)}" height="${f(p.thickness)}" rx="0.35" fill="${sky.stone}"/>` +
      `<rect class="bs-solid-top" x="${f(p.x0)}" y="${f(y)}" width="${f(w)}" height="0.55" rx="0.2" fill="${sky.stoneEdge}"/>`
    );
  }
  let out = '';
  if (p.moving && p.moving.axis === 'x') {
    const a = p.moving.amplitude;
    out += `<line class="bs-travel" x1="${f(p.x0 - a)}" y1="${f(y + 0.22)}" x2="${f(p.x1 + a)}" y2="${f(y + 0.22)}" stroke="${sky.stoneEdge}" stroke-width="0.18" stroke-dasharray="0.5 0.5" opacity="0.7"/>`;
  }
  if (p.moving && p.moving.axis === 'y') {
    const a = p.moving.amplitude;
    const cx = (p.x0 + p.x1) / 2;
    out += `<line class="bs-travel" x1="${f(cx)}" y1="${f(y - a)}" x2="${f(cx)}" y2="${f(y + a)}" stroke="${sky.stoneEdge}" stroke-width="0.18" stroke-dasharray="0.5 0.5" opacity="0.7"/>`;
  }
  out += `<rect class="bs-soft" x="${f(p.x0)}" y="${f(y)}" width="${f(w)}" height="0.6" rx="0.25" fill="${sky.plank}" stroke="${sky.stoneEdge}" stroke-width="0.1"/>`;
  return out;
}

/** `<svg>` markup for one stage thumbnail (viewBox 34 × 18.5 world metres). */
export function stageThumbSvg(def: StageDef): string {
  const sky = SKIES[def.id] ?? SKIES.brokenColosseum;
  const vw = VIEW.x1 - VIEW.x0;
  const vh = VIEW.yTop - VIEW.yBottom;
  const gid = `gk-bs-sky-${def.id}`;
  const platforms = def.platforms.map((p) => platformSvg(p, sky)).join('');
  const spawns = def.spawns
    .map((s) => `<circle class="bs-spawn" cx="${f(s.x)}" cy="${f(-s.y - 0.55)}" r="0.4" fill="${sky.sun}" opacity="0.9"/>`)
    .join('');
  return (
    `<svg class="gk-bs__thumb-svg" viewBox="${VIEW.x0} ${-VIEW.yTop} ${vw} ${vh}" preserveAspectRatio="xMidYMid slice" role="img" aria-label="${def.name} layout">` +
    `<defs><linearGradient id="${gid}" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${sky.top}"/><stop offset="1" stop-color="${sky.bottom}"/></linearGradient></defs>` +
    `<rect x="${VIEW.x0}" y="${-VIEW.yTop}" width="${vw}" height="${vh}" fill="url(#${gid})"/>` +
    `<circle cx="${def.id === 'skyAqueduct' ? -9 : 8}" cy="${-8.4}" r="2.1" fill="${sky.sun}" opacity="0.8"/>` +
    platforms +
    spawns +
    `</svg>`
  );
}
