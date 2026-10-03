/** Champions League HUD — pure helpers (colour ramp, formatting, countdown step). No DOM. */

export type Rgb = readonly [number, number, number];

/** Percent → colour stops: white 0 → yellow 60 → orange 100 → red 150 → dark red 200+. */
export const PERCENT_STOPS: ReadonlyArray<{ at: number; rgb: Rgb }> = [
  { at: 0, rgb: [255, 255, 255] },
  { at: 60, rgb: [255, 226, 77] },
  { at: 100, rgb: [255, 150, 30] },
  { at: 150, rgb: [255, 59, 47] },
  { at: 200, rgb: [155, 13, 18] },
];

/** Interpolated colour of a damage percent as [r, g, b] (0..255, integers). */
export function percentRgb(pct: number): [number, number, number] {
  const p = Number.isFinite(pct) ? Math.max(0, pct) : 0;
  const stops = PERCENT_STOPS;
  if (p >= stops[stops.length - 1].at) {
    const c = stops[stops.length - 1].rgb;
    return [c[0], c[1], c[2]];
  }
  for (let i = 1; i < stops.length; i++) {
    const b = stops[i];
    if (p <= b.at) {
      const a = stops[i - 1];
      const t = (p - a.at) / (b.at - a.at);
      return [
        Math.round(a.rgb[0] + (b.rgb[0] - a.rgb[0]) * t),
        Math.round(a.rgb[1] + (b.rgb[1] - a.rgb[1]) * t),
        Math.round(a.rgb[2] + (b.rgb[2] - a.rgb[2]) * t),
      ];
    }
  }
  const c = stops[0].rgb;
  return [c[0], c[1], c[2]];
}

/** CSS colour string of a damage percent. */
export function percentColor(pct: number): string {
  const [r, g, b] = percentRgb(pct);
  return `rgb(${r}, ${g}, ${b})`;
}

/** Whole-number percent text (the sim keeps fractions; the HUD shows the floor). */
export function formatPercent(pct: number): string {
  const p = Number.isFinite(pct) ? Math.max(0, Math.min(999, pct)) : 0;
  return String(Math.floor(p));
}

/** m:ss for the match clock; `null` = no time limit. */
export function formatTimer(timeLeft: number | null): string {
  if (timeLeft === null) return '∞';
  const s = Math.max(0, Math.ceil(timeLeft - 1e-9));
  const m = Math.floor(s / 60);
  return `${m}:${String(s % 60).padStart(2, '0')}`;
}

export type CountdownDisplay = 3 | 2 | 1 | 'FIGHT' | null;

/** The 3-2-1 number for `snapshot.countdown` seconds remaining (0 once live → 'FIGHT' until `time` exceeds the hold). */
export function countdownStep(countdown: number, time: number): CountdownDisplay {
  if (countdown > 0) {
    const n = Math.ceil(countdown - 1e-9);
    return n >= 3 ? 3 : n <= 1 ? 1 : 2;
  }
  return time >= 0 && time < 0.8 ? 'FIGHT' : null;
}

/** Animation size multiplier of the percent bump for a hit of `damage`. */
export function bumpScale(damage: number): number {
  const d = Number.isFinite(damage) ? Math.max(0, damage) : 0;
  return 1.12 + Math.min(0.5, d / 24);
}

/** Display name for a KO banner. */
export function koBannerText(victim: string, killer: string | null): string {
  return killer === null ? `${victim} fell` : `${victim} was KO'd by ${killer}`;
}

/**
 * Clamp a point to the rectangle inset by `margin` on every side (extra `bottomInset` at the bottom) and
 * report the arrow angle (radians, 0 = pointing right, CSS rotation) from the rectangle's centre toward the
 * original point.
 */
export function edgeMarker(
  x: number,
  y: number,
  w: number,
  h: number,
  margin: number,
  bottomInset: number,
): { x: number; y: number; angle: number } {
  const cx = w / 2;
  const cy = h / 2;
  const minX = margin;
  const maxX = Math.max(minX, w - margin);
  const minY = margin;
  const maxY = Math.max(minY, h - margin - bottomInset);
  const angle = Math.atan2(y - cy, x - cx);
  return { x: Math.min(maxX, Math.max(minX, x)), y: Math.min(maxY, Math.max(minY, y)), angle };
}
