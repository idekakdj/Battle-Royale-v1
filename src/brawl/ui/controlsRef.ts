/** Champions League controls reference (plan §8) — shared by the Settings panel and the in-match pause menu. */

export const BRAWL_CONTROLS: readonly (readonly [string, string])[] = [
  ['A / D  \u00B7  \u2190 / \u2192', 'Move'],
  ['W / \u2191 / Space', 'Jump (again in the air to air-jump; hold for full height)'],
  ['S / \u2193', 'Down: fast-fall, drop through soft platforms, down attacks'],
  ['J / Left mouse', 'Light attack (hold a direction for side / up / down)'],
  ['K / Right mouse', 'Heavy attack (Heavy + Up is your recovery move)'],
  ['L / Shift', 'Dodge (roll with a direction, air dodge in the air)'],
  ['Esc', 'Pause'],
  ['F3', 'Show hit and hurt boxes (debug)'],
];
