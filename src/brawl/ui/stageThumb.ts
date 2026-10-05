/**
 * Champions League — CSS/SVG thumbnails of the stage layouts, drawn from the REAL StageDef geometry (solid
 * platforms as thick blocks, soft platforms as thin planks, the moving platform with its travel range, spawn dots).
 * v1.6: Clockwork Heights draws layout A (frame 0) plus faint ghosts / a dashed route / an arrow for every platform that follows a `path`;
 * the Crumbling Amphitheatre draws the intact layout with every breakable outlined in gold (and a crack mark) and the `finalOnly` form
 * as dashed gold ghosts. Also the small badge / card view-model shared by the setup screen and the online room.
 * Pure string builders (no DOM) so they are unit-testable.
 */

import { platformAt } from '../data/stages';
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
  clockworkHeights: { top: '#1d1658', bottom: '#6fd0d4', sun: '#ffd0a0', stone: '#6e6990', stoneEdge: '#e0b04c', plank: '#9a94bd' },
  crumblingAmphitheatre: { top: '#0b0e2e', bottom: '#8a5a6a', sun: '#cfdcff', stone: '#8c7b6c', stoneEdge: '#f2c25e', plank: '#b7a48d' },
};

const f = (n: number): string => (Math.round(n * 100) / 100).toString();

/** The small facts a stage card advertises (setup screen and online room). */
export interface StageBadge {
  id: 'moving' | 'breakable';
  label: string;
}

/** Badges derived from the real data: any `moving` / `path` platform, any `breakable` platform. */
export function stageBadges(def: StageDef): StageBadge[] {
  const out: StageBadge[] = [];
  let moving = false;
  let breakable = false;
  for (const p of def.platforms) {
    if (p.path !== undefined) moving = true;
    if (p.breakable !== undefined) breakable = true;
  }
  // the older drifting stages are not advertised (their one moving platform is part of the classic stage); the v1.6 maps are
  if (moving) out.push({ id: 'moving', label: 'Moving platforms' });
  if (breakable) out.push({ id: 'breakable', label: 'Breakable → transforms' });
  return out;
}

/** One stage card's content: id, name, blurb and badges, from the real `StageDef`s in the given order. */
export interface StageCardInfo {
  id: StageDef['id'];
  name: string;
  blurb: string;
  badges: StageBadge[];
}

export function stageCards(ids: readonly StageDef['id'][], defs: Readonly<Record<StageDef['id'], StageDef>>): StageCardInfo[] {
  return ids.map((id) => ({ id, name: defs[id].name, blurb: defs[id].blurb, badges: stageBadges(defs[id]) }));
}

/** HTML for the badge row (`<span class="gk-bs__badges">…`), '' when there are none. */
export function stageBadgesHtml(def: StageDef): string {
  const b = stageBadges(def);
  if (b.length === 0) return '';
  return `<span class="gk-bs__badges">${b.map((x) => `<span class="gk-bs__badge gk-bs__badge--${x.id}">${x.label}</span>`).join('')}</span>`;
}

function rectSvg(p: PlatformDef, x0: number, x1: number, top: number, sky: Sky, extra: string): string {
  const y = -top;
  const w = x1 - x0;
  if (p.kind === 'solid') {
    return (
      `<rect class="bs-solid" x="${f(x0)}" y="${f(y)}" width="${f(w)}" height="${f(p.thickness)}" rx="0.35" fill="${sky.stone}"${extra}/>` +
      `<rect class="bs-solid-top" x="${f(x0)}" y="${f(y)}" width="${f(w)}" height="0.55" rx="0.2" fill="${sky.stoneEdge}"${extra}/>`
    );
  }
  return `<rect class="bs-soft" x="${f(x0)}" y="${f(y)}" width="${f(w)}" height="0.6" rx="0.25" fill="${sky.plank}" stroke="${sky.stoneEdge}" stroke-width="0.1"${extra}/>`;
}

/** Faint outline of a platform at another place (a layout it will glide to / the final form). */
function ghostSvg(p: PlatformDef, x0: number, x1: number, top: number, color: string, opacity: number, cls = 'bs-ghost'): string {
  const h = p.kind === 'solid' ? Math.min(p.thickness, 2.2) : 0.6;
  return `<rect class="${cls}" x="${f(x0)}" y="${f(-top)}" width="${f(x1 - x0)}" height="${f(h)}" rx="0.3" fill="${color}" fill-opacity="${f(opacity * 0.35)}" stroke="${color}" stroke-width="0.14" stroke-opacity="${f(opacity)}" stroke-dasharray="0.45 0.35"/>`;
}

/** The distinct places a path platform visits (its keys), as {x0,x1,y} top rectangles; the first is layout A (the defined position). */
function pathStops(p: PlatformDef): { x0: number; x1: number; y: number }[] {
  const path = p.path;
  if (path === undefined) return [];
  const frames = path.periodS * 60;
  const out: { x0: number; x1: number; y: number }[] = [];
  for (const k of path.keys) {
    const r = platformAt(p, k.t * frames);
    if (!out.some((q) => Math.abs(q.x0 - r.x0) < 0.35 && Math.abs(q.y - r.y) < 0.35)) out.push(r);
  }
  return out;
}

function pathMarkup(p: PlatformDef, sky: Sky): string {
  const stops = pathStops(p);
  if (stops.length < 2) return '';
  let out = '';
  const cx = (s: { x0: number; x1: number }): number => (s.x0 + s.x1) / 2;
  const solid = p.kind === 'solid';
  // ghosts of the other layouts (the solid core: only its two horizontal extremes, the rest would just smear)
  let ghosts = stops.slice(1);
  if (solid) {
    const lo = stops.reduce((a, b) => (b.x0 < a.x0 ? b : a), stops[0]);
    const hi = stops.reduce((a, b) => (b.x0 > a.x0 ? b : a), stops[0]);
    ghosts = lo === hi ? [] : [lo, hi];
  }
  for (const g of ghosts) out += ghostSvg(p, g.x0, g.x1, g.y, sky.stoneEdge, 0.55);
  // dashed route through the centres + an arrow head on the first leg
  const centre = solid ? stops.filter((s) => ghosts.includes(s) || s === stops[0]) : stops;
  const pts = centre.map((s) => `${f(cx(s))},${f(-s.y + (solid ? 1.6 : 0.3))}`).join(' ');
  out += `<polyline class="bs-route" points="${pts}${solid ? '' : ` ${f(cx(centre[0]))},${f(-centre[0].y + 0.3)}`}" fill="none" stroke="${sky.sun}" stroke-width="0.16" stroke-opacity="0.6" stroke-dasharray="0.4 0.4"/>`;
  const a = centre[0];
  const b = centre[1];
  const ax = cx(a);
  const ay = -a.y + (solid ? 1.6 : 0.3);
  const bx = cx(b);
  const by = -b.y + (solid ? 1.6 : 0.3);
  const ang = Math.atan2(by - ay, bx - ax);
  const mx = ax + (bx - ax) * 0.55;
  const my = ay + (by - ay) * 0.55;
  const s = 0.55;
  out += `<polygon class="bs-arrow" points="${f(mx + Math.cos(ang) * s)},${f(my + Math.sin(ang) * s)} ${f(mx + Math.cos(ang + 2.5) * s)},${f(my + Math.sin(ang + 2.5) * s)} ${f(mx + Math.cos(ang - 2.5) * s)},${f(my + Math.sin(ang - 2.5) * s)}" fill="${sky.sun}" fill-opacity="0.85"/>`;
  return out;
}

function platformSvg(p: PlatformDef, sky: Sky): string {
  // v1.6: final-form platforms are only a ghost of what the arena becomes
  if (p.finalOnly === true) {
    return ghostSvg(p, p.x0, p.x1, p.y, sky.stoneEdge, 0.7, p.kind === 'solid' ? 'bs-solid' : 'bs-soft');
  }
  const y = -p.y; // svg y grows downward
  let out = '';
  if (p.path !== undefined) out += pathMarkup(p, sky);
  if (p.moving && p.moving.axis === 'x') {
    const a = p.moving.amplitude;
    out += `<line class="bs-travel" x1="${f(p.x0 - a)}" y1="${f(y + 0.22)}" x2="${f(p.x1 + a)}" y2="${f(y + 0.22)}" stroke="${sky.stoneEdge}" stroke-width="0.18" stroke-dasharray="0.5 0.5" opacity="0.7"/>`;
  }
  if (p.moving && p.moving.axis === 'y') {
    const a = p.moving.amplitude;
    const cx = (p.x0 + p.x1) / 2;
    out += `<line class="bs-travel" x1="${f(cx)}" y1="${f(y - a)}" x2="${f(cx)}" y2="${f(y + a)}" stroke="${sky.stoneEdge}" stroke-width="0.18" stroke-dasharray="0.5 0.5" opacity="0.7"/>`;
  }
  out += rectSvg(p, p.x0, p.x1, p.y, sky, '');
  if (p.breakable !== undefined) {
    // outlined in gold + a small crack mark: "this one breaks"
    const h = p.kind === 'solid' ? Math.min(p.thickness, 2.4) : 0.6;
    out += `<rect class="bs-breakable" x="${f(p.x0 + 0.1)}" y="${f(y - 0.05)}" width="${f(p.x1 - p.x0 - 0.2)}" height="${f(h + 0.1)}" rx="0.3" fill="none" stroke="#ffd36a" stroke-width="0.16" stroke-dasharray="0.5 0.3"/>`;
    const cx = (p.x0 + p.x1) / 2;
    out += `<polyline class="bs-crack" points="${f(cx - 0.6)},${f(y + 0.05)} ${f(cx - 0.1)},${f(y + h * 0.4)} ${f(cx - 0.55)},${f(y + h * 0.55)} ${f(cx + 0.1)},${f(y + h * 0.9)}" fill="none" stroke="#1a1210" stroke-width="0.17" stroke-linejoin="round"/>`;
  }
  return out;
}

/** `<svg>` markup for one stage thumbnail (viewBox 34 × 18.5 world metres). */
export function stageThumbSvg(def: StageDef): string {
  const sky = SKIES[def.id] ?? SKIES.brokenColosseum;
  const vw = VIEW.x1 - VIEW.x0;
  const vh = VIEW.yTop - VIEW.yBottom;
  const gid = `gk-bs-sky-${def.id}`;
  // ghosts first (under everything), then the real platforms in definition order
  const platforms = def.platforms.map((p) => platformSvg(p, sky)).join('');
  const spawns = def.spawns
    .map((s) => `<circle class="bs-spawn" cx="${f(s.x)}" cy="${f(-s.y - 0.55)}" r="0.4" fill="${sky.sun}" opacity="0.9"/>`)
    .join('');
  const sunX = def.id === 'skyAqueduct' ? -9 : def.id === 'crumblingAmphitheatre' ? -11 : def.id === 'clockworkHeights' ? 11 : 8;
  return (
    `<svg class="gk-bs__thumb-svg" viewBox="${VIEW.x0} ${-VIEW.yTop} ${vw} ${vh}" preserveAspectRatio="xMidYMid slice" role="img" aria-label="${def.name} layout">` +
    `<defs><linearGradient id="${gid}" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${sky.top}"/><stop offset="1" stop-color="${sky.bottom}"/></linearGradient></defs>` +
    `<rect x="${VIEW.x0}" y="${-VIEW.yTop}" width="${vw}" height="${vh}" fill="url(#${gid})"/>` +
    `<circle cx="${sunX}" cy="${-8.4}" r="2.1" fill="${sky.sun}" opacity="0.8"/>` +
    platforms +
    spawns +
    `</svg>`
  );
}
