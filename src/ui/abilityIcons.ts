/**
 * Per-animal ability glyphs for the HUD ability cluster (WP-M, §6.1). One bold
 * inline-SVG symbol for every special (SHIFT) and ultimate (Q) — 20 in all —
 * drawn in `currentColor` on a 48×48 grid so CSS drives tint / glow / dimming.
 * Names come live from `ANIMALS[a].special|ultimate.name` (config is the source
 * of truth); the glyphs only depict the ability's idea.
 *
 * v1.3: the ten ULTIMATE glyphs were redrawn for the new ultimates (Royal Hunt,
 * Boulder Hurl, Death Roll, Riverlord's Flood, Seismic Stampede, Death From Above,
 * Shadow Execution, Coil Snare, Timber Fall, Sinkhole Vortex).
 */

import type { AnimalId } from '../core/types';

export type AbilitySlot = 'special' | 'ultimate';

// Shared stroke preset: everything is stroked unless a path opts into fill.
const S = 'fill="none" stroke="currentColor" stroke-width="3.6" stroke-linecap="round" stroke-linejoin="round"';
const S_BOLD = 'fill="none" stroke="currentColor" stroke-width="5" stroke-linecap="round" stroke-linejoin="round"';
const F = 'fill="currentColor" stroke="none"';
/** Dark carve-lines cut into a filled shape (readable on both gold and sand tints). */
const CUT = 'fill="none" stroke="rgba(0,0,0,0.6)" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"';

/** Glyph bodies (inner SVG markup) keyed by animal → slot. */
const GLYPHS: Record<AnimalId, Record<AbilitySlot, string>> = {
  lion: {
    // Pounce: a leaping arc landing in a three-claw rake.
    special: `
      <path ${S} d="M7 37 Q14 8 33 15"/>
      <path ${S} d="M27 10 L34 15 L28 21"/>
      <path ${S} d="M29 40 L36 27 M35 42 L42 29 M41 43 L45 35"/>`,
    // Royal Hunt: a leaping arc landing on a locked crosshair.
    ultimate: `
      <circle ${S_BOLD} cx="31" cy="32" r="9.5"/>
      <path ${S_BOLD} d="M15 32 H19.5 M42.5 32 H47 M31 44 V47"/>
      <circle ${F} cx="31" cy="32" r="3.6"/>
      <path ${S} d="M3 36 Q8 2 31 16.5"/>
      <path ${S} d="M27 8.5 L31.5 16.8 L22.5 17"/>`,
  },
  gorilla: {
    // Silverback Leap: a high arc slamming into a cracked ground line.
    special: `
      <path ${S} d="M6 30 Q14 2 30 18"/>
      <path ${S} d="M24 18 L31 20 L31 12"/>
      <path ${S} d="M4 42 H44"/>
      <path ${S} d="M33 42 L30 34 M38 42 L41 34 M35.5 30 V26"/>`,
    // Boulder Hurl: a hoisted boulder flying along an arc trail.
    ultimate: `
      <path ${F} d="M25 13 L32 4 L43 6 L47 16 L43 27 L33 31 L24 25 Z"/>
      <path ${CUT} d="M32 4 L34 15 L43 27 M34 15 L25 13 M34 15 L33 31"/>
      <path ${S_BOLD} d="M3 44 Q3 24 17 20"/>
      <path ${S} d="M11 45 Q11 35 18 33"/>
      <path ${S} d="M3 31 Q3 27 7 25"/>`,
  },
  crocodile: {
    // Ambush Lunge: low jaws snapping forward with speed lines.
    special: `
      <path ${S} d="M4 20 H13 M2 28 H11 M4 36 H13"/>
      <path ${S} d="M17 22 L44 16 L40 24 Z"/>
      <path ${S} d="M17 32 L40 28 L44 35 Z"/>
      <path ${S} d="M24 21 L26 24 M31 19.5 L33 23 M25 30 L27 32.5 M32 29 L34 31.5"/>`,
    // Death Roll: clamped jaws inside a spiral roll arrow.
    ultimate: `
      <g transform="rotate(-24 24 24)">
        <path ${F} d="M9 14 H39 V19 H9 Z M12 19 L15 26 L18 19 Z M21 19 L24 26 L27 19 Z M30 19 L33 26 L36 19 Z"/>
        <path ${F} d="M9 29 H39 V34 H9 Z M16.5 29 L19.5 22.5 L22.5 29 Z M25.5 29 L28.5 22.5 L31.5 29 Z"/>
      </g>
      <path ${S_BOLD} d="M42.6 34.8 A21.5 21.5 0 1 1 40.5 10.2"/>
      <path ${S_BOLD} d="M39 2.8 L40.8 10.4 L33.2 8"/>`,
  },
  hippo: {
    // River Rush: a charging arrow riding a wave crest.
    special: `
      <path ${S} d="M4 36 Q10 30 16 36 T28 36 T40 36 T46 34"/>
      <path ${S} d="M6 24 H34"/>
      <path ${S} d="M28 16 L37 24 L28 32"/>
      <path ${S} d="M10 16 H20"/>`,
    // Riverlord's Flood: a breaking wave surging along a straight channel.
    ultimate: `
      <path ${F} d="M3 36 Q9 36 14 28 Q19 14 32 10 Q43 8 46 17 Q40 12 33 17 Q31 24 38 28 Q42 31 46 31 L46 36 Z"/>
      <path ${CUT} d="M16 28 Q22 20 31 21"/>
      <path ${S_BOLD} d="M3 42 H15 M22 42 H33 M40 42 H45"/>`,
  },
  rhino: {
    // Lockdown Charge: a curved horn driving forward.
    special: `
      <path ${F} d="M16 38 Q22 18 42 8 Q34 24 30 38 Z"/>
      <path ${S} d="M3 22 H11 M5 30 H13 M3 38 H10"/>`,
    // Seismic Stampede: a horn-tipped charge bending onto its locked target, dust behind.
    ultimate: `
      <circle ${F} cx="4.5" cy="41" r="3.2"/>
      <circle ${F} cx="9" cy="45" r="2.4"/>
      <circle ${S} cx="38" cy="12" r="8.5"/>
      <circle ${F} cx="38" cy="12" r="2.6"/>
      <path ${F} d="M10 45 C6 28 16 20 31 16.5 C23 24 23 35 24 45 Z"/>
      <path ${S_BOLD} d="M3 29 C3 21 7 17 12 15"/>`,
  },
  eagle: {
    // Gale Burst: curling gusts of wind.
    special: `
      <path ${S} d="M4 16 H28 A5 5 0 1 0 23 11"/>
      <path ${S} d="M4 25 H38 A5 5 0 1 1 33 30"/>
      <path ${S} d="M8 34 H22 A4 4 0 1 1 18 38"/>`,
    // Death From Above: a stooping eagle (wings swept back, hooked beak) diving onto a target ring.
    ultimate: `
      <path ${F} d="M24 31 L19 27 Q8 22 2 7 Q13 12 20 15 L21.5 4 L24 8.5 L26.5 4 L28 15 Q35 12 46 7 Q40 22 29 27 Z"/>
      <circle ${F} cx="24" cy="32.5" r="5"/>
      <path ${F} d="M20.5 35 Q24 38 27.5 35 L24 42 Z"/>
      <ellipse ${S} cx="24" cy="44" rx="17" ry="3.6"/>`,
  },
  panther: {
    // Shadow Dash: a streaking crescent with speed trails.
    special: `
      <path ${F} d="M28 6 A18 18 0 0 0 28 42 A24 24 0 0 1 28 6 Z"/>
      <path ${S} d="M31 16 H45 M34 24 H46 M31 32 H45"/>`,
    // Shadow Execution: crossed crescent slashes through the victim.
    ultimate: `
      <circle ${S} cx="24" cy="24" r="9.5"/>
      <path ${F} d="M4 5 Q27 16 44 44 Q23 24 4 5 Z"/>
      <path ${F} d="M44 5 Q21 16 4 44 Q25 24 44 5 Z"/>
      <circle ${F} cx="24" cy="24" r="3"/>`,
  },
  python: {
    // Coil Sweep: a tightening spiral.
    special: `
      <path ${S} d="M24 24 m-3 0 a3 3 0 1 1 6 0 a7 7 0 1 1 -14 0 a11 11 0 1 1 22 0 a15 15 0 1 1 -30 0"/>
      <path ${F} d="M6.5 25 L3 18 L10 19 Z"/>`,
    // Coil Snare: a coiled tether lashing out and hooking the target.
    ultimate: `
      <path ${S_BOLD} d="M3 11 Q8 3 13 11 T23 11 T29 9"/>
      <circle ${S} cx="32" cy="9" r="3.6"/>
      <path ${S_BOLD} d="M32 13 V30 C32 45 14 44 14 27"/>
      <path ${F} d="M7 28 L14 18 L21 28 Z"/>`,
  },
  giraffe: {
    // Thunder Kick: a hoof strike with a bolt.
    special: `
      <path ${F} d="M8 34 L22 34 L24 44 L6 44 Z"/>
      <path ${S} d="M15 34 V12 Q15 6 21 6"/>
      <path ${F} d="M34 4 L26 22 H33 L27 40 L42 17 H35 L40 4 Z"/>`,
    // Timber Fall: a long neck swinging down like a hammer onto a ring.
    ultimate: `
      <path ${S_BOLD} d="M7 45 C2 18 8 5 21 5 C34 5 40 12 40 20"/>
      <ellipse ${F} cx="40" cy="26" rx="6.4" ry="9"/>
      <path ${S_BOLD} d="M37 17 L35.5 12 M43 17 L44.5 12"/>
      <ellipse ${S} cx="40" cy="43" rx="8.5" ry="3"/>
      <path ${S} d="M27 40 L22 36 M25 45 L19 45 M44 37 L47 33"/>`,
  },
  mole: {
    // Burrow: diving into a dirt mound.
    special: `
      <path ${S} d="M24 4 V24"/>
      <path ${S} d="M16 17 L24 25 L32 17"/>
      <path ${S} d="M3 42 Q24 26 45 42"/>
      <path ${F} d="M10 36 l3 -3 l2 3 Z M34 35 l3 -2 l1 4 Z"/>`,
    // Sinkhole Vortex: a spiralling pit with arrows pulling inward.
    ultimate: `
      <ellipse ${S} cx="24" cy="32" rx="21" ry="10.5"/>
      <path ${S} d="M24 32 A3 1.6 0 0 1 30 32 A6 3.2 0 0 1 18 32 A8.5 4.6 0 0 1 35 32"/>
      <path ${S_BOLD} d="M24 3 V12 M18.5 7.5 L24 13 L29.5 7.5"/>
      <path ${S_BOLD} d="M5 8 L11 15 M5.5 15 L11.5 15.5 L11 9.5"/>
      <path ${S_BOLD} d="M43 8 L37 15 M42.5 15 L36.5 15.5 L37 9.5"/>`,
  },
};

/** Complete inline SVG for one animal's ability glyph. */
export function abilityGlyphSvg(animal: AnimalId, slot: AbilitySlot, className = 'gk-hud__glyph'): string {
  return `<svg class="${className}" viewBox="0 0 48 48" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">${GLYPHS[animal][slot]}</svg>`;
}
