/**
 * HUD status glyphs (v1.2 WP-O, UPGRADE-PLAN-v1.2 §4.3/§4.4): one bold inline
 * SVG per buff/debuff kind, the three pickup kinds (matching the arena pickup
 * medallions: heal cross, speed bolt, power swords) and the arena-trap glyphs
 * for the kill feed. 48×48 grid, drawn in `currentColor` so CSS tints them.
 */

import type { BuffState, PickupState, TrapKind } from '../core/types';

export type BuffKind = BuffState['kind'];
export type PickupKind = PickupState['kind'];

const S = 'fill="none" stroke="currentColor" stroke-width="3.8" stroke-linecap="round" stroke-linejoin="round"';
const S_THIN = 'fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"';
const F = 'fill="currentColor" stroke="none"';

const HEAL = `<path ${F} d="M18 5h12v13h13v12H30v13H18V30H5V18h13z"/>`;
const BOLT = `<path ${F} d="M27 3 L10 27 H22 L18 45 L38 19 H26 L31 3 Z"/>
  <path ${S_THIN} d="M3 16 H9 M2 24 H7 M4 32 H9" opacity="0.8"/>`;
const SWORDS = `<path ${S} d="M9 9 L31 31 M39 9 L17 31"/>
  <path ${S} d="M27 35 L35 27 M13 27 L21 35"/>
  <path ${S} d="M33 33 L41 41 M15 33 L7 41"/>`;

const BUFF_GLYPHS: Record<BuffKind, string> = {
  speed: BOLT,
  rage: SWORDS,
  // Snail: spiral shell on a gliding foot.
  slow: `<path ${S} d="M5 38 H38 Q44 38 44 32"/>
    <path ${S} d="M36 38 V30"/>
    <path ${S} d="M38 22 L41 14 M42 24 L46 18"/>
    <path ${S} d="M22 37 A12 12 0 1 1 33 25 A8 8 0 0 1 17 25 A4 4 0 0 1 25 25"/>`,
  // Blood drop.
  bleed: `<path ${F} d="M24 4 C24 4 10 20 10 30 A14 14 0 0 0 38 30 C38 20 24 4 24 4 Z"/>
    <path fill="none" stroke="rgba(0,0,0,0.35)" stroke-width="3" stroke-linecap="round" d="M17 31 Q18 37 23 38"/>`,
  // Chain links (rooted in place).
  root: `<rect ${S} x="5" y="17" width="22" height="14" rx="7" transform="rotate(-35 16 24)"/>
    <rect ${S} x="21" y="17" width="22" height="14" rx="7" transform="rotate(-35 32 24)"/>
    <path ${S_THIN} d="M6 44 H42"/>`,
  // Eye with a slash.
  blind: `<path ${S} d="M4 24 Q24 6 44 24 Q24 42 4 24 Z"/>
    <circle ${F} cx="24" cy="24" r="5.5"/>
    <path ${S} d="M8 42 L40 6"/>`,
  // Cracked shield (takes more damage).
  dmgTakenUp: `<path ${S} d="M24 4 L41 10 V23 Q41 37 24 44 Q7 37 7 23 V10 Z"/>
    <path ${S} d="M25 6 L20 17 L28 23 L21 31 L25 42"/>`,
  // Shield with a plus.
  armorUp: `<path ${F} d="M24 4 L41 10 V23 Q41 37 24 44 Q7 37 7 23 V10 Z" opacity="0.35"/>
    <path ${S} d="M24 4 L41 10 V23 Q41 37 24 44 Q7 37 7 23 V10 Z"/>
    <path ${S} d="M24 15 V33 M15 24 H33"/>`,
  // Triple fast slashes.
  atkSpeedUp: `<path ${S} d="M10 38 Q20 24 34 8 M18 42 Q28 28 42 12 M5 30 Q12 20 22 9"/>`,
  // Domino mask.
  stealth: `<path ${F} d="M4 18 Q14 12 24 18 Q34 12 44 18 Q44 32 34 32 Q28 32 24 26 Q20 32 14 32 Q4 32 4 18 Z"/>
    <ellipse fill="rgba(0,0,0,0.55)" cx="14" cy="23" rx="4.5" ry="3"/>
    <ellipse fill="rgba(0,0,0,0.55)" cx="34" cy="23" rx="4.5" ry="3"/>`,
};

const PICKUP_GLYPHS: Record<PickupKind, string> = { heal: HEAL, speed: BOLT, rage: SWORDS };

const TRAP_GLYPHS: Record<TrapKind | 'any', string> = {
  fire: `<path ${F} d="M24 3 C28 12 38 17 38 30 A14 14 0 0 1 10 30 C10 22 15 18 17 12 C19 18 21 20 23 20 C22 14 23 8 24 3 Z"/>
    <path fill="rgba(255,236,150,0.9)" d="M24 24 C27 29 30 31 30 35 A6 6 0 0 1 18 35 C18 31 22 29 24 24 Z"/>`,
  spikes: `<path ${F} d="M4 42 L11 14 L18 42 Z M17 42 L24 6 L31 42 Z M30 42 L37 14 L44 42 Z"/>
    <path ${S_THIN} d="M2 44 H46"/>`,
  // Generic arena trap: flame rising out of a spike row.
  any: `<path ${F} d="M24 2 C27 9 34 12 34 21 A10 10 0 0 1 14 21 C14 16 17 13 18 9 C20 13 21 14 23 14 C22 10 23 6 24 2 Z"/>
    <path ${F} d="M4 45 L10 30 L16 45 Z M16 45 L24 26 L32 45 Z M32 45 L38 30 L44 45 Z"/>`,
};

function svg(body: string, cls: string): string {
  return `<svg class="${cls}" viewBox="0 0 48 48" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">${body}</svg>`;
}

export function buffIconSvg(kind: BuffKind, cls = 'gk-hud__buff-svg'): string {
  return svg(BUFF_GLYPHS[kind], cls);
}

export function pickupIconSvg(kind: PickupKind, cls = 'gk-hud__toast-svg'): string {
  return svg(PICKUP_GLYPHS[kind], cls);
}

export function trapGlyphSvg(kind: TrapKind | undefined, cls = 'gk-hud__kf-head'): string {
  return svg(TRAP_GLYPHS[kind ?? 'any'], cls);
}
