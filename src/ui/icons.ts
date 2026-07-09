/**
 * Inline SVG icon set (WP-F). No external assets (BLUEPRINT §2/§12): the logo,
 * the ten stylized animal head icons for character select, laurels and confetti
 * for results, and the mute speaker glyphs are all hand-built vector markup.
 *
 * Each animal head is a distinctive silhouette drawn in `currentColor` (so a
 * parent can tint it with the animal's accent) plus fixed dark/light detail
 * shades. `viewBox` is a uniform 0 0 64 64 so any render size works.
 */

import type { AnimalId } from '../core/types';

/** Star / spiked-ring path generator (used for the lion mane). */
function starPath(cx: number, cy: number, spikes: number, outer: number, inner: number): string {
  let d = '';
  const step = Math.PI / spikes;
  for (let i = 0; i < spikes * 2; i++) {
    const r = i % 2 === 0 ? outer : inner;
    const a = -Math.PI / 2 + i * step;
    const x = cx + Math.cos(a) * r;
    const y = cy + Math.sin(a) * r;
    d += (i === 0 ? 'M' : 'L') + x.toFixed(1) + ',' + y.toFixed(1);
  }
  return d + 'Z';
}

// Shared detail shades for the animal heads.
const DARK = 'rgba(15,12,8,0.55)'; // recessed / shadowed accent tone
const INK = '#14110d'; // eyes, nostrils, mouth lines
const LITE = 'rgba(255,255,255,0.82)'; // teeth / highlights
const TONGUE = '#b23a2f'; // snake tongue / mole snout

const HEADS: Record<AnimalId, string> = {
  lion: `
    <path fill="currentColor" d="${starPath(32, 31, 12, 27, 18)}"/>
    <circle cx="32" cy="32" r="15" fill="${DARK}"/>
    <circle cx="21" cy="20" r="4" fill="currentColor"/><circle cx="43" cy="20" r="4" fill="currentColor"/>
    <circle cx="26" cy="30" r="2.1" fill="${INK}"/><circle cx="38" cy="30" r="2.1" fill="${INK}"/>
    <path d="M32 34 l4 4 h-8 z" fill="${INK}"/>
    <path d="M32 38 q-5 5 -9 2 M32 38 q5 5 9 2" stroke="${INK}" stroke-width="1.6" fill="none" stroke-linecap="round"/>`,

  gorilla: `
    <ellipse cx="32" cy="30" rx="21" ry="20" fill="currentColor"/>
    <circle cx="10" cy="30" r="5" fill="currentColor"/><circle cx="54" cy="30" r="5" fill="currentColor"/>
    <ellipse cx="32" cy="40" rx="14" ry="13" fill="${DARK}"/>
    <path d="M19 23 q13 -7 26 0" stroke="${INK}" stroke-width="3.4" fill="none" stroke-linecap="round"/>
    <circle cx="25" cy="30" r="2.2" fill="${INK}"/><circle cx="39" cy="30" r="2.2" fill="${INK}"/>
    <path d="M28 40 h8 M27 44 q5 3 10 0" stroke="${INK}" stroke-width="1.8" fill="none" stroke-linecap="round"/>`,

  // Crocodile — long profile snout facing right, jagged teeth.
  crocodile: `
    <path fill="currentColor" d="M6 22 q10 -6 22 -4 l30 6 q4 1 4 4 l-4 2 -30 3 q-14 1 -22 -5 z"/>
    <path fill="${DARK}" d="M28 30 l30 3 q4 1 4 4 l-4 2 -30 2 q-8 0 -10 -6 z"/>
    <path d="M30 26 L58 30 M30 26 l2 4 M37 27 l1.5 4 M44 28 l1.5 4 M51 29 l1.5 4" stroke="${LITE}" stroke-width="1.5" fill="none"/>
    <circle cx="18" cy="19" r="5" fill="currentColor"/><circle cx="18" cy="19" r="2" fill="${INK}"/>`,

  hippo: `
    <rect x="12" y="12" width="40" height="34" rx="13" fill="currentColor"/>
    <circle cx="15" cy="15" r="5" fill="currentColor"/><circle cx="49" cy="15" r="5" fill="currentColor"/>
    <circle cx="15" cy="15" r="2" fill="${DARK}"/><circle cx="49" cy="15" r="2" fill="${DARK}"/>
    <rect x="16" y="30" width="32" height="22" rx="11" fill="${DARK}"/>
    <ellipse cx="24" cy="35" rx="3" ry="4" fill="${INK}"/><ellipse cx="40" cy="35" rx="3" ry="4" fill="${INK}"/>
    <circle cx="24" cy="24" r="2" fill="${INK}"/><circle cx="40" cy="24" r="2" fill="${INK}"/>`,

  // Rhino — profile facing right, prominent nose horn + brow horn.
  rhino: `
    <path fill="currentColor" d="M14 24 q0 -14 16 -14 q22 0 26 16 q2 10 -8 16 q-8 4 -18 2 q-16 -3 -16 -20 z"/>
    <path fill="${INK}" d="M50 22 q10 -1 12 -12 q-9 3 -14 8 z"/>
    <path fill="${LITE}" d="M44 15 q4 -6 3 -11 q-5 3 -7 9 z"/>
    <circle cx="34" cy="26" r="2.4" fill="${INK}"/>
    <path d="M18 20 q6 -6 13 -5" stroke="${DARK}" stroke-width="2" fill="none"/>
    <path fill="${DARK}" d="M16 22 q-6 2 -6 8 q4 -1 7 -4 z"/>`,

  // Eagle — profile facing right, hooked beak + brow.
  eagle: `
    <path fill="currentColor" d="M12 26 q-2 -16 16 -18 q18 -2 22 12 q2 8 -4 14 q-10 8 -22 4 q-10 -3 -12 -12 z"/>
    <path fill="${LITE}" d="M48 24 q12 0 14 6 q-3 3 -9 3 q3 3 -1 5 q-6 -1 -8 -7 q-1 -4 4 -7 z"/>
    <path fill="${INK}" d="M18 16 q10 -8 24 -3 q-11 -1 -22 6 z"/>
    <circle cx="34" cy="24" r="3.4" fill="${INK}"/><circle cx="35" cy="23" r="1" fill="#fff"/>`,

  // Panther — front cat face, pointed ears, narrowed eyes, fangs.
  panther: `
    <path fill="currentColor" d="M12 14 l8 10 q12 -6 24 0 l8 -10 -2 16 q6 8 -2 18 q-8 8 -16 8 q-8 0 -16 -8 q-8 -10 -2 -18 z"/>
    <path fill="${DARK}" d="M16 18 l4 6 6 -3 z M48 18 l-4 6 -6 -3 z"/>
    <path d="M22 30 l7 2 -6 3 z" fill="${INK}"/><path d="M42 30 l-7 2 6 3 z" fill="${INK}"/>
    <path d="M32 36 l3 4 h-6 z" fill="${INK}"/>
    <path d="M30 46 l1 4 M34 46 l-1 4" stroke="${LITE}" stroke-width="1.6" fill="none" stroke-linecap="round"/>
    <path d="M12 38 h8 M12 42 h8 M44 38 h8 M44 42 h8" stroke="${INK}" stroke-width="1" opacity="0.5"/>`,

  // Python — coiled body with a raised diamond head + forked tongue.
  python: `
    <path fill="none" stroke="currentColor" stroke-width="7" stroke-linecap="round"
      d="M8 50 q10 -10 22 -6 q12 4 8 -8 q-3 -8 6 -10"/>
    <path fill="currentColor" d="M44 8 q10 -2 12 8 q1 8 -8 10 q-9 1 -11 -8 q-1 -8 7 -10 z"/>
    <path d="M52 26 l0 8 M50 30 l4 4 M54 30 l-4 4" stroke="${TONGUE}" stroke-width="1.6" fill="none" stroke-linecap="round"/>
    <ellipse cx="48" cy="15" rx="2.4" ry="3" fill="${INK}"/>
    <circle cx="30" cy="24" r="1.6" fill="${DARK}"/><circle cx="20" cy="40" r="1.6" fill="${DARK}"/>`,

  // Giraffe — long face, ossicones, ears, dappled spots.
  giraffe: `
    <path d="M22 6 v10 M42 6 v10" stroke="currentColor" stroke-width="4" stroke-linecap="round"/>
    <circle cx="22" cy="6" r="4" fill="currentColor"/><circle cx="42" cy="6" r="4" fill="currentColor"/>
    <path fill="currentColor" d="M10 20 q4 -8 12 -8 h20 q8 0 12 8 l-4 30 q-2 8 -12 10 q-6 1 -12 0 q-10 -2 -12 -10 z"/>
    <ellipse cx="8" cy="22" rx="5" ry="3.5" fill="currentColor"/><ellipse cx="56" cy="22" rx="5" ry="3.5" fill="currentColor"/>
    <circle cx="24" cy="26" r="2.1" fill="${INK}"/><circle cx="40" cy="26" r="2.1" fill="${INK}"/>
    <ellipse cx="27" cy="52" rx="3" ry="4" fill="${INK}"/><ellipse cx="37" cy="52" rx="3" ry="4" fill="${INK}"/>
    <circle cx="18" cy="34" r="3.5" fill="${DARK}"/><circle cx="46" cy="34" r="3.5" fill="${DARK}"/><circle cx="32" cy="40" r="3.5" fill="${DARK}"/>`,

  // Mole — round head, tiny near-blind eyes, pink star-snout, digging claws.
  mole: `
    <circle cx="32" cy="28" r="20" fill="currentColor"/>
    <ellipse cx="32" cy="44" rx="9" ry="7" fill="${TONGUE}"/>
    <path d="M32 44 l0 -4 M28 42 l-3 -2 M36 42 l3 -2 M28 46 l-3 2 M36 46 l3 2 M32 48 l0 4"
      stroke="${TONGUE}" stroke-width="2.4" stroke-linecap="round"/>
    <circle cx="26" cy="26" r="1.4" fill="${INK}"/><circle cx="38" cy="26" r="1.4" fill="${INK}"/>
    <path fill="${LITE}" d="M8 40 l10 4 -3 6 -8 -4 z"/><path fill="${LITE}" d="M56 40 l-10 4 3 6 8 -4 z"/>
    <path d="M9 42 l8 3 M11 46 l6 2 M55 42 l-8 3 M53 46 l-6 2" stroke="${DARK}" stroke-width="0.9"/>`,
};

/** Inner markup for one animal head (no <svg> wrapper). */
export function animalHeadInner(id: AnimalId): string {
  return HEADS[id];
}

/** A full <svg> element for an animal head; tint via CSS `color` on the node. */
export function animalHeadSvg(id: AnimalId, className = 'gk-head'): string {
  return `<svg class="${className}" viewBox="0 0 64 64" xmlns="http://www.w3.org/2000/svg" aria-hidden="true" focusable="false">${HEADS[id]}</svg>`;
}

/** Crossed-swords sigil for the game logo. */
export function crossedSwordsSvg(className = 'gk-logo-swords'): string {
  return `<svg class="${className}" viewBox="0 0 48 48" xmlns="http://www.w3.org/2000/svg" aria-hidden="true" focusable="false">
    <g stroke-linecap="round" stroke-linejoin="round">
      <path d="M9 39 l24 -28 4 0 0 4 -28 24 z" fill="var(--gk-stone-200)" stroke="var(--gk-gold)" stroke-width="1.4"/>
      <path d="M39 39 L15 11 h-4 v4 l28 24 z" fill="var(--gk-stone-200)" stroke="var(--gk-gold)" stroke-width="1.4"/>
      <path d="M7 37 l4 4 -3 3 -4 -4 z" fill="var(--gk-gold)"/>
      <path d="M41 37 l-4 4 3 3 4 -4 z" fill="var(--gk-gold)"/>
    </g>
  </svg>`;
}

/** A laurel-branch half; `flip` mirrors it for the opposite side. */
export function laurelSvg(flip: boolean, className = 'gk-laurel'): string {
  const t = flip ? 'scale(-1,1) translate(-64,0)' : '';
  return `<svg class="${className}" viewBox="0 0 64 96" xmlns="http://www.w3.org/2000/svg" aria-hidden="true" focusable="false">
    <g transform="${t}" fill="none" stroke="var(--gk-gold)" stroke-width="2.4" stroke-linecap="round">
      <path d="M52 92 q-30 -18 -26 -60 q0 -14 8 -26"/>
      <g fill="var(--gk-gold-bright)" stroke="none">
        <path d="M44 84 q-9 -1 -12 -9 q8 -2 12 3 z"/>
        <path d="M40 70 q-9 -1 -12 -9 q8 -2 12 3 z"/>
        <path d="M37 56 q-9 -2 -11 -10 q8 -1 12 4 z"/>
        <path d="M35 42 q-8 -3 -9 -11 q8 0 11 5 z"/>
        <path d="M35 28 q-7 -4 -7 -12 q7 1 10 6 z"/>
        <path d="M37 16 q-5 -5 -4 -12 q6 2 8 8 z"/>
      </g>
    </g>
  </svg>`;
}

/** Speaker icon; `muted` swaps sound waves for an ✕. */
export function speakerSvg(muted: boolean, className = 'gk-speaker'): string {
  const waves = muted
    ? `<path d="M23 13 l8 8 M31 13 l-8 8" stroke="var(--gk-blood-bright)" stroke-width="2.2" stroke-linecap="round"/>`
    : `<path d="M22 11 q4 5 0 10 M26 8 q7 8 0 16" stroke="currentColor" stroke-width="2" fill="none" stroke-linecap="round"/>`;
  return `<svg class="${className}" viewBox="0 0 34 24" xmlns="http://www.w3.org/2000/svg" aria-hidden="true" focusable="false">
    <path d="M4 9 h4 l6 -5 v16 l-6 -5 h-4 z" fill="currentColor"/>${waves}
  </svg>`;
}
