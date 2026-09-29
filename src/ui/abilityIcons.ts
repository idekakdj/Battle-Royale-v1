/**
 * Per-animal ability glyphs for the HUD ability cluster (WP-M, §6.1). One bold
 * inline-SVG symbol for every special (SHIFT) and ultimate (Q) — 20 in all —
 * drawn in `currentColor` on a 48×48 grid so CSS drives tint / glow / dimming.
 * Names come live from `ANIMALS[a].special|ultimate.name` (config is the source
 * of truth); the glyphs only depict the ability's idea.
 */

import type { AnimalId } from '../core/types';

export type AbilitySlot = 'special' | 'ultimate';

// Shared stroke preset: everything is stroked unless a path opts into fill.
const S = 'fill="none" stroke="currentColor" stroke-width="3.6" stroke-linecap="round" stroke-linejoin="round"';
const S_BOLD = 'fill="none" stroke="currentColor" stroke-width="5" stroke-linecap="round" stroke-linejoin="round"';
const S_THIN = 'fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"';
const F = 'fill="currentColor" stroke="none"';

/** Glyph bodies (inner SVG markup) keyed by animal → slot. */
const GLYPHS: Record<AnimalId, Record<AbilitySlot, string>> = {
  lion: {
    // Pounce: a leaping arc landing in a three-claw rake.
    special: `
      <path ${S} d="M7 37 Q14 8 33 15"/>
      <path ${S} d="M27 10 L34 15 L28 21"/>
      <path ${S} d="M29 40 L36 27 M35 42 L42 29 M41 43 L45 35"/>`,
    // King's Roar: an open maw with sound rings.
    ultimate: `
      <path ${F} d="M6 17 L20 24 L6 31 Z"/>
      <path ${S} d="M24 16 Q28 24 24 32"/>
      <path ${S} d="M30 11 Q37 24 30 37"/>
      <path ${S} d="M36 6 Q46 24 36 42"/>`,
  },
  gorilla: {
    // Silverback Leap: a high arc slamming into a cracked ground line.
    special: `
      <path ${S} d="M6 30 Q14 2 30 18"/>
      <path ${S} d="M24 18 L31 20 L31 12"/>
      <path ${S} d="M4 42 H44"/>
      <path ${S} d="M33 42 L30 34 M38 42 L41 34 M35.5 30 V26"/>`,
    // Primal Rampage: a clenched fist with impact bursts.
    ultimate: `
      <circle ${F} cx="15" cy="20" r="4.6"/>
      <circle ${F} cx="21.5" cy="18.5" r="4.6"/>
      <circle ${F} cx="28" cy="18.5" r="4.6"/>
      <circle ${F} cx="34.5" cy="20" r="4.6"/>
      <rect ${F} x="10.4" y="20" width="28.7" height="18" rx="6"/>
      <path fill="none" stroke="rgba(0,0,0,0.55)" stroke-width="2.2" stroke-linecap="round" d="M18.2 21 V25 M24.7 20.5 V25 M31.2 21 V25 M12 28 H26 Q29 28 29 32"/>
      <path ${S} d="M24.5 3 V8.5 M10 6 L13 10.5 M39 6 L36 10.5 M3.5 18 H7.5 M41.5 18 H45.5"/>`,
  },
  crocodile: {
    // Ambush Lunge: low jaws snapping forward with speed lines.
    special: `
      <path ${S} d="M4 20 H13 M2 28 H11 M4 36 H13"/>
      <path ${S} d="M17 22 L44 16 L40 24 Z"/>
      <path ${S} d="M17 32 L40 28 L44 35 Z"/>
      <path ${S} d="M24 21 L26 24 M31 19.5 L33 23 M25 30 L27 32.5 M32 29 L34 31.5"/>`,
    // Death Roll: two chasing arrows around a spin axis.
    ultimate: `
      <path ${S} d="M38 16 A15 15 0 0 0 10 20"/>
      <path ${S} d="M10 32 A15 15 0 0 0 38 28"/>
      <path ${S} d="M33 10 L39 16 L32 20"/>
      <path ${S} d="M15 38 L9 32 L16 28"/>
      <circle ${F} cx="24" cy="24" r="4.5"/>`,
  },
  hippo: {
    // River Rush: a charging arrow riding a wave crest.
    special: `
      <path ${S} d="M4 36 Q10 30 16 36 T28 36 T40 36 T46 34"/>
      <path ${S} d="M6 24 H34"/>
      <path ${S} d="M28 16 L37 24 L28 32"/>
      <path ${S} d="M10 16 H20"/>`,
    // Colossal Chomp: a huge gaping mouth with tusks.
    ultimate: `
      <path ${S} d="M5 18 Q24 2 43 18"/>
      <path ${S} d="M5 30 Q24 46 43 30"/>
      <path ${S} d="M5 18 V30 M43 18 V30"/>
      <path ${F} d="M12 14 L15 23 L18 13 Z M30 13 L33 23 L36 14 Z M14 34 L17 26 L20 36 Z M28 36 L31 26 L34 34 Z"/>`,
  },
  rhino: {
    // Lockdown Charge: a curved horn driving forward.
    special: `
      <path ${F} d="M16 38 Q22 18 42 8 Q34 24 30 38 Z"/>
      <path ${S} d="M3 22 H11 M5 30 H13 M3 38 H10"/>`,
    // Seismic Stampede: ground split by a quake with shock arcs.
    ultimate: `
      <path ${S} d="M3 38 H45"/>
      <path ${S} d="M26 4 L19 18 L27 22 L20 38"/>
      <path ${S} d="M9 30 Q4 24 9 18 M39 30 Q44 24 39 18"/>
      <path ${S} d="M14 34 Q11 29 14 24 M34 34 Q37 29 34 24"/>`,
  },
  eagle: {
    // Gale Burst: curling gusts of wind.
    special: `
      <path ${S} d="M4 16 H28 A5 5 0 1 0 23 11"/>
      <path ${S} d="M4 25 H38 A5 5 0 1 1 33 30"/>
      <path ${S} d="M8 34 H22 A4 4 0 1 1 18 38"/>`,
    // Death From Above: a steep dive onto a target ring.
    ultimate: `
      <path ${S} d="M13 3 L28 30"/>
      <path ${S} d="M20 30 H29 V21"/>
      <ellipse ${S} cx="30" cy="39" rx="14" ry="5"/>
      <circle ${F} cx="30" cy="39" r="2.8"/>`,
  },
  panther: {
    // Shadow Dash: a streaking crescent with speed trails.
    special: `
      <path ${F} d="M28 6 A18 18 0 0 0 28 42 A24 24 0 0 1 28 6 Z"/>
      <path ${S} d="M31 16 H45 M34 24 H46 M31 32 H45"/>`,
    // Night Prowl: a slit-pupil eye under a moon.
    ultimate: `
      <path ${S} d="M4 28 Q24 10 44 28 Q24 46 4 28 Z"/>
      <path ${F} d="M24 19 Q28 28 24 37 Q20 28 24 19 Z"/>
      <path ${F} d="M40 3 A7 7 0 1 0 45 13 A5.5 5.5 0 1 1 40 3 Z"/>`,
  },
  python: {
    // Coil Sweep: a tightening spiral.
    special: `
      <path ${S} d="M24 24 m-3 0 a3 3 0 1 1 6 0 a7 7 0 1 1 -14 0 a11 11 0 1 1 22 0 a15 15 0 1 1 -30 0"/>
      <path ${F} d="M6.5 25 L3 18 L10 19 Z"/>`,
    // Constrictor's Embrace: coils wrapping a trapped body.
    ultimate: `
      <circle ${S} cx="24" cy="25" r="11"/>
      <path ${S_BOLD} d="M7 19 Q24 12 41 18"/>
      <path ${S_BOLD} d="M7 29 Q24 22 41 28"/>
      <path ${S_BOLD} d="M8 39 Q24 32 39 37"/>
      <path ${F} d="M39 12 L47 17 L40 22 Z"/>
      <path ${S_THIN} d="M24 43 V47 M17 44 L15 47 M31 44 L33 47"/>`,
  },
  giraffe: {
    // Thunder Kick: a hoof strike with a bolt.
    special: `
      <path ${F} d="M8 34 L22 34 L24 44 L6 44 Z"/>
      <path ${S} d="M15 34 V12 Q15 6 21 6"/>
      <path ${F} d="M34 4 L26 22 H33 L27 40 L42 17 H35 L40 4 Z"/>`,
    // Guillotine Spin: a whirling neck blade.
    ultimate: `
      <path ${S} d="M8 24 H33"/>
      <circle ${F} cx="38" cy="24" r="5.5"/>
      <circle ${F} cx="9" cy="24" r="3"/>
      <path ${S} d="M9 14 A17 17 0 0 1 38 11"/>
      <path ${S} d="M33 7 L39 11 L33.5 15.5"/>
      <path ${S} d="M39 34 A17 17 0 0 1 10 37"/>
      <path ${S} d="M15 41 L9 37 L14.5 32.5"/>`,
  },
  mole: {
    // Burrow: diving into a dirt mound.
    special: `
      <path ${S} d="M24 4 V24"/>
      <path ${S} d="M16 17 L24 25 L32 17"/>
      <path ${S} d="M3 42 Q24 26 45 42"/>
      <path ${F} d="M10 36 l3 -3 l2 3 Z M34 35 l3 -2 l1 4 Z"/>`,
    // Sinkhole: a collapsing vortex in the ground.
    ultimate: `
      <ellipse ${S} cx="24" cy="30" rx="20" ry="9"/>
      <ellipse ${S} cx="24" cy="31" rx="12" ry="5"/>
      <ellipse ${F} cx="24" cy="32" rx="5" ry="2.2"/>
      <path ${S} d="M13 8 L15 15 M24 4 V13 M35 8 L33 15"/>`,
  },
};

/** Complete inline SVG for one animal's ability glyph. */
export function abilityGlyphSvg(animal: AnimalId, slot: AbilitySlot, className = 'gk-hud__glyph'): string {
  return `<svg class="${className}" viewBox="0 0 48 48" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">${GLYPHS[animal][slot]}</svg>`;
}
