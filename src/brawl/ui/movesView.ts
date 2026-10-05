/**
 * Champions League — view-model of the setup screen's MOVES tab ("what does Down + Light do for this fighter?").
 *
 * Pure function of the move data (`MovesetDef`): nothing is hard-coded per animal, so when a move is renamed,
 * retimed or re-tuned the panel changes with it. `buildMovesView(animal)` returns
 *   - `entries`  the 8 attack slots in display order (Light N/S/D/U, then Heavy N/S/D/U) with the input in player
 *                terms, name, one-line description, speed label, damage, tags and an optional aerial note,
 *   - `lightString` the Light-neutral combo string (hit names + damage) with the "press Light again" note,
 *   - `tips`     2-4 short "good to know" bullets computed from stats / hitboxes / the kill-percent and recovery models.
 * No DOM here (see `BrawlSetup` for the renderer); tests: `tests/brawl/ui.moves.test.ts`.
 */

import type { AnimalId } from '../../core/types';
import type { HitboxDef, MoveBody, MoveData, MoveId, MovesetDef } from '../types';
import { BRAWL_FPS, MOVE_IDS } from '../types';
import { MOVESETS, bodyKillPercent, getMoveset, hitsOf, simulateRecovery, victimDamage } from '../data';

export type MoveRow = 'light' | 'heavy';
export type MoveColumn = 'neutral' | 'side' | 'down' | 'up';
export type SpeedLabel = 'Fast' | 'Medium' | 'Slow';
export type MoveTagId =
  | 'kill'
  | 'recovery'
  | 'armor'
  | 'invuln'
  | 'underground'
  | 'multi'
  | 'sweet'
  | 'spike'
  | 'pull'
  | 'stun'
  | 'flinch'
  | 'bury'
  | 'launcher'
  | 'travel';

export interface MoveTag {
  id: MoveTagId;
  /** Short pill text. */
  label: string;
  /** One-sentence explanation (tooltip / detail line). */
  detail: string;
}

export interface MoveEntry {
  slot: MoveId;
  row: MoveRow;
  column: MoveColumn;
  /** Key caps to show, e.g. ['↓', 'J'] (down + light) or ['K'] (heavy neutral). */
  keys: string[];
  /** The same as text, e.g. "↓ + J". */
  inputText: string;
  name: string;
  /** `anim.look` of the ground form ("" if the data has none). */
  look: string;
  startup: number;
  speed: SpeedLabel;
  /** Damage one victim takes from one activation (no sweetspot bonus). Always finite. */
  damage: number;
  /** Damage with the sweetspot bonus (equals `damage` when the move has none). */
  damageSweet: number;
  /** Hits of the main hitbox on one victim (1 unless it re-hits on an interval). */
  hits: number;
  /** Compact damage for the grid cell: "16" or "3×3" for multi-hit moves. */
  damageShort: string;
  /** Damage line for the detail card: "16", "16 (18.4 sweetspot)", "3 × 3 (13 total)". */
  damageLabel: string;
  /** Lowest victim percent (mid-weight) at which this slot launches off-stage in the data model, or null. */
  killPercent: number | null;
  tags: MoveTag[];
  /** "In the air: ..." when the aerial form differs materially from the ground form, else null. */
  airNote: string | null;
}

export interface LightStringHit {
  name: string;
  damage: number;
}

export interface LightString {
  hits: LightStringHit[];
  total: number;
  /** "Claw Swipe → Claw Backhand → Claw Rake". */
  text: string;
  /** How to continue it (empty when the string is a single hit). */
  note: string;
}

export interface MovesView {
  animal: AnimalId;
  /** Light N/S/D/U then Heavy N/S/D/U. */
  entries: MoveEntry[];
  lightString: LightString;
  /** 2-4 data-derived bullets. */
  tips: string[];
}

/** Legend shown under the grid (controls from plan section 8). */
export const MOVES_LEGEND = {
  light: 'J / Left click',
  heavy: 'K / Right click',
  dodge: 'L / Shift',
  /** What the direction key caps mean. */
  directions: '→ = hold left or right · ↑ = W or ↑ · ↓ = S or ↓',
} as const;

const ARROW: Record<'side' | 'down' | 'up', string> = { side: '→', down: '↓', up: '↑' };
const ROW_KEY: Record<MoveRow, string> = { light: 'J', heavy: 'K' };
const COLUMN_OF: Record<string, MoveColumn> = { N: 'neutral', S: 'side', D: 'down', U: 'up' };

/** Speed bands from the startup frames. */
export function speedLabel(startup: number): SpeedLabel {
  if (startup <= 8) return 'Fast';
  if (startup <= 14) return 'Medium';
  return 'Slow';
}

/** Input caps for a slot id: lightD -> ['↓', 'J'], heavyN -> ['K']. */
export function slotKeys(slot: MoveId): string[] {
  const row: MoveRow = slot.startsWith('light') ? 'light' : 'heavy';
  const column = COLUMN_OF[slot.charAt(slot.length - 1)];
  const key = ROW_KEY[row];
  if (column === 'side') return [ARROW.side, key];
  if (column === 'down') return [ARROW.down, key];
  if (column === 'up') return [ARROW.up, key];
  return [key];
}

const f1 = (v: number): string => String(Math.round(v * 10) / 10);
const plural = (n: number, one: string, many = `${one}s`): string => (n === 1 ? one : many);

function ordinal(n: number): string {
  const r100 = n % 100;
  if (r100 >= 11 && r100 <= 13) return `${n}th`;
  const r10 = n % 10;
  return `${n}${r10 === 1 ? 'st' : r10 === 2 ? 'nd' : r10 === 3 ? 'rd' : 'th'}`;
}

/** The aerial form of a slot: `ground` with the `air` partial spread over it (same rule as `getMoveBody`). */
function airBody(m: MoveData): MoveBody {
  return m.air !== null && !m.groundOnly ? { ...m.ground, ...m.air } : m.ground;
}

/** The hitbox that defines the move: most damage over all its hits, then growth. */
function primaryBox(b: MoveBody): HitboxDef {
  return [...b.hitboxes].sort((x, y) => y.damage * hitsOf(y) - x.damage * hitsOf(x) || y.kbGrowth - x.kbGrowth)[0];
}

function effectsOf(b: MoveBody): Set<string> {
  const out = new Set<string>();
  for (const h of b.hitboxes) if (h.effect !== undefined && h.effect !== 'none') out.add(h.effect);
  return out;
}

/** Net travel of the move's motion windows (m, forward / up). */
function travelOf(b: MoveBody): { dx: number; dy: number } {
  let dx = 0;
  let dy = 0;
  for (const m of b.motion ?? []) {
    const s = (m.to - m.from) / BRAWL_FPS;
    dx += (m.vx ?? 0) * s;
    dy += (m.vy ?? 0) * s;
  }
  return { dx, dy };
}

const isDownward = (angle: number): boolean => Math.sin((angle * Math.PI) / 180) < -0.5;

/** Best kill percent of a slot over its ground and aerial forms (Infinity when neither launches off-stage). */
function slotKillPercent(m: MoveData): number {
  return Math.min(bodyKillPercent(m.ground), bodyKillPercent(airBody(m)));
}

function keysText(keys: string[]): string {
  return keys.join(' + ');
}

/** Aerial note: only when the air form differs materially (effect, damage, timing, downward drive, dive). */
function buildAirNote(m: MoveData): string | null {
  if (m.air === null || m.groundOnly) return null;
  const g = m.ground;
  const a = airBody(m);
  const parts: string[] = [];
  const gFx = effectsOf(g);
  const aFx = effectsOf(a);
  const spikes = aFx.has('spike') && !gFx.has('spike');
  if (spikes) parts.push('spikes downward');
  for (const e of aFx) if (!gFx.has(e) && e !== 'spike') parts.push(`adds ${e}`);
  for (const e of gFx) if (!aFx.has(e)) parts.push(`no ${e}`);
  const gMain = primaryBox(g);
  const aMain = primaryBox(a);
  if (!spikes && isDownward(aMain.angle) && !isDownward(gMain.angle)) parts.push('drives the target downward');
  if (a.startup !== g.startup) parts.push(`startup ${a.startup}f`);
  const gDmg = victimDamage(g).base;
  const aDmg = victimDamage(a).base;
  if (Math.abs(aDmg - gDmg) >= 1) parts.push(`${f1(aDmg)} damage`);
  if (!spikes && travelOf(a).dy <= travelOf(g).dy - 1) parts.push('dives downward');
  if (parts.length === 0) return null;
  if (a.name !== g.name) parts.unshift(a.name);
  if (a.landingLag !== undefined) parts.push(`landing lag ${a.landingLag}`);
  return `In the air: ${parts.join(' · ')}`;
}

function buildTags(slot: MoveId, m: MoveData, isKill: boolean, killPct: number | null): MoveTag[] {
  const g = m.ground;
  const a = airBody(m);
  const main = primaryBox(g);
  const tags: MoveTag[] = [];
  if (isKill && killPct !== null) {
    tags.push({
      id: 'kill',
      label: 'Kill move',
      detail: `Your earliest knockout: can launch a mid-weight rival off the stage from about ${Math.round(killPct / 5) * 5}% near an edge (more in the middle).`,
    });
  }
  if (slot === 'heavyU') {
    tags.push({
      id: 'recovery',
      label: 'Recovery',
      detail: 'Your way back to the stage: travels upward, usable once per airtime. On the ground it is a launcher.',
    });
  }
  if (g.armor !== undefined) {
    tags.push({
      id: 'armor',
      label: 'Armor',
      detail: `Absorbs ${g.armor.hits} ${plural(g.armor.hits, 'hit')} without flinching from frame ${g.armor.from} to ${g.armor.to}.`,
    });
  }
  // v1.6: a burrow (the mole's Burrow Strike) is its own thing — untouchable underground, then an eruption that launches upward.
  if (g.burrow !== undefined) {
    tags.push({
      id: 'underground',
      label: 'Underground',
      detail: 'Untouchable while tunnelling; erupts upward and launches enemies',
    });
  }
  if (g.invuln !== undefined) {
    tags.push({
      id: 'invuln',
      label: g.invuln.from < g.startup && g.burrow === undefined ? 'Invulnerable start' : 'Invulnerable',
      detail: `Cannot be hit from frame ${g.invuln.from} to ${g.invuln.to}${g.burrow !== undefined ? ' (attacks pass straight through you)' : ''}.`,
    });
  }
  const multi = g.hitboxes.reduce((n, h) => Math.max(n, hitsOf(h)), 1);
  if (multi > 1) tags.push({ id: 'multi', label: 'Multi-hit', detail: `Hits up to ${multi} times in one use.` });
  const sweet = g.hitboxes.find((h) => h.sweet !== undefined);
  if (sweet?.sweet !== undefined) {
    tags.push({
      id: 'sweet',
      label: 'Sweetspot',
      detail: `Hitting with the tip does x${f1(sweet.sweet.damageMult)} damage and x${f1(sweet.sweet.kbMult)} knockback.`,
    });
  }
  const gFx = effectsOf(g);
  const aFx = effectsOf(a);
  if (aFx.has('spike') || gFx.has('spike')) {
    tags.push({
      id: 'spike',
      label: gFx.has('spike') ? 'Spike' : 'Spike (air)',
      detail: 'Meteor smash: sends an airborne target straight down. A grounded target is bounced up instead.',
    });
  }
  if (gFx.has('pull') || aFx.has('pull')) tags.push({ id: 'pull', label: 'Pull', detail: 'Drags the target toward you.' });
  if (gFx.has('stun') || aFx.has('stun')) tags.push({ id: 'stun', label: 'Stun', detail: 'Adds extra hitstun to the target.' });
  if (gFx.has('flinch') || aFx.has('flinch')) tags.push({ id: 'flinch', label: 'Flinch', detail: 'Interrupts the target with a short flinch instead of a tumble.' });
  if (gFx.has('bury') || aFx.has('bury')) tags.push({ id: 'bury', label: 'Bury', detail: 'Buries a grounded target in the floor.' });
  if (slot !== 'heavyU' && !gFx.has('spike') && main.angle >= 70 && main.angle <= 110) {
    tags.push({ id: 'launcher', label: 'Launcher', detail: 'Sends the target upward: a juggle starter.' });
  }
  if (slot !== 'heavyU') {
    const t = travelOf(g);
    if (g.burrow !== undefined && t.dx >= 0.8) tags.push({ id: 'travel', label: 'Tunnels', detail: `Tunnels about ${f1(t.dx)} m forward underground; it stops at the edge of the platform you stand on.` });
    else if (t.dx >= 0.8) tags.push({ id: 'travel', label: 'Lunges', detail: `Moves about ${f1(t.dx)} m forward during the attack.` });
    else if (t.dy >= 1.5) tags.push({ id: 'travel', label: 'Rises', detail: `Climbs about ${f1(t.dy)} m during the attack.` });
    else if (t.dy <= -1.5) tags.push({ id: 'travel', label: 'Drops', detail: `Falls about ${f1(-t.dy)} m during the attack.` });
  }
  return tags;
}

function buildEntry(slot: MoveId, m: MoveData, killSlot: MoveId | null, killPct: number | null): MoveEntry {
  const g = m.ground;
  const row: MoveRow = slot.startsWith('light') ? 'light' : 'heavy';
  const column = COLUMN_OF[slot.charAt(slot.length - 1)];
  const keys = slotKeys(slot);
  const dmg = victimDamage(g);
  const main = primaryBox(g);
  const hits = hitsOf(main);
  const perHit = f1(main.damage);
  const slotKill = slotKillPercent(m);
  const total = f1(dmg.base);
  let damageLabel = total;
  if (hits > 1) damageLabel = `${perHit} × ${hits} (${total} total)`;
  else if (dmg.max > dmg.base) damageLabel = `${total} (${f1(dmg.max)} sweetspot)`;
  return {
    slot,
    row,
    column,
    keys,
    inputText: keysText(keys),
    name: g.name,
    look: String(g.anim?.look ?? ''),
    startup: g.startup,
    speed: speedLabel(g.startup),
    damage: dmg.base,
    damageSweet: dmg.max,
    hits,
    damageShort: hits > 1 ? `${perHit}×${hits}` : total,
    damageLabel,
    killPercent: Number.isFinite(slotKill) ? slotKill : null,
    tags: buildTags(slot, m, slot === killSlot, killPct),
    airNote: buildAirNote(m),
  };
}

function buildLightString(set: MovesetDef): LightString {
  const first = set.moves.lightN;
  const bodies = [first.ground, ...(first.chain ?? [])];
  const hits = bodies.map((b) => ({ name: b.name, damage: victimDamage(b).base }));
  const total = hits.reduce((s, h) => s + h.damage, 0);
  let note = '';
  if (bodies.length > 1) {
    note = 'Press Light again during the string to continue it.';
    const hitOnly = bodies.slice(0, -1).some((b) => b.cancels?.some((c) => c.into.includes('lightN') && c.onHitOnly));
    if (hitOnly) note += ' Later hits only follow if the one before connects.';
  }
  return { hits, total, text: hits.map((h) => h.name).join(' → '), note };
}

// ── "Good to know" bullets ───────────────────────────────────────────────────

function recoveryScore(set: MovesetDef): number {
  return simulateRecovery(set.moves.heavyU.ground, set.stats).score;
}

/** Rank (1 = best) of this moveset's recovery among the ten (itself replaced by `set` if it is a fixture). */
function recoveryRank(set: MovesetDef): { rank: number; of: number } {
  const mine = recoveryScore(set);
  let better = 0;
  let of = 0;
  for (const id of Object.keys(MOVESETS) as AnimalId[]) {
    of++;
    if (id === set.animal) continue;
    if (recoveryScore(MOVESETS[id]) > mine) better++;
  }
  return { rank: better + 1, of };
}

function recoveryWord(rank: number, of: number): string {
  const q = rank / of;
  if (q <= 0.2) return 'among the best';
  if (q <= 0.5) return 'above average';
  if (q <= 0.8) return 'below average';
  return 'among the weakest';
}

function weightClass(weight: number): string {
  if (weight <= 85) return 'Lightweight';
  if (weight <= 110) return 'Middleweight';
  return 'Heavyweight';
}

interface Tip {
  text: string;
  /** Higher = dropped first when there are more than four. */
  drop: number;
}

function buildTips(set: MovesetDef, entries: MoveEntry[]): string[] {
  const s = set.stats;
  const tips: Tip[] = [];
  const ent = (id: MoveId): MoveEntry => entries[MOVE_IDS.indexOf(id)];
  const label = (e: MoveEntry): string => `${e.name} (${e.inputText})`;

  // jumps / glide
  if (s.maxJumps !== 2 || s.glideFall !== undefined) {
    const air = s.maxJumps - 1;
    let text = `${s.maxJumps} jumps in all (${air} in the air)`;
    if (s.glideFall !== undefined) text += `, and holding Jump while falling glides down at only ${f1(s.glideFall)} m/s`;
    tips.push({ text: `${text}.`, drop: 2 });
  }

  // armor
  const armored = entries.filter((e) => set.moves[e.slot].ground.armor !== undefined);
  if (armored.length > 0) {
    const list = armored
      .map((e) => {
        const a = set.moves[e.slot].ground.armor!;
        return `${label(e)} shrugs off ${a.hits} ${plural(a.hits, 'hit')} (frames ${a.from}-${a.to})`;
      })
      .join('; ');
    tips.push({ text: `Armor: ${list}.`, drop: 3 });
  }

  // invulnerable frames
  const ghosts = entries.filter((e) => set.moves[e.slot].ground.invuln !== undefined);
  if (ghosts.length > 0) {
    const list = ghosts
      .map((e) => {
        const g = set.moves[e.slot].ground;
        const v = g.invuln!;
        if (g.burrow !== undefined) return `${label(e)} goes underground on frames ${g.burrow.from}-${g.burrow.to} (nothing can touch you), then erupts upward`;
        return `${label(e)} cannot be hit on frames ${v.from}-${v.to}`;
      })
      .join('; ');
    tips.push({ text: `Slippery: ${list}.`, drop: 4 });
  }

  // earliest kill
  let kill: MoveEntry | null = null;
  for (const id of MOVE_IDS) {
    if (!id.startsWith('heavy')) continue;
    const e = ent(id);
    if (e.killPercent !== null && (kill === null || e.killPercent < (kill.killPercent as number))) kill = e;
  }
  if (kill !== null) {
    tips.push({
      text: `Kills earliest with ${label(kill)}: can finish a mid-weight rival from about ${Math.round((kill.killPercent as number) / 5) * 5}% near an edge; expect more in the middle of the stage.`,
      drop: 0,
    });
  }

  // recovery
  const rec = ent('heavyU');
  const { rank, of } = recoveryRank(set);
  const peak = simulateRecovery(set.moves.heavyU.ground, s).peak;
  tips.push({
    text: `Recovery ${recoveryWord(rank, of)} (${ordinal(rank)} of ${of}): ${label(rec)} climbs about ${f1(peak)} m, once per airtime.`,
    drop: 1,
  });

  // weight
  const pct = Math.round(Math.abs(100 / s.weight - 1) * 100);
  const kb = pct === 0 ? 'standard knockback' : `about ${pct}% ${s.weight < 100 ? 'more' : 'less'} knockback than a 100-weight fighter`;
  tips.push({ text: `${weightClass(s.weight)} (weight ${s.weight}): takes ${kb}.`, drop: 5 });

  const kept = new Set(tips);
  while (kept.size > 4) {
    let worst: Tip | null = null;
    for (const t of kept) if (worst === null || t.drop > worst.drop) worst = t;
    kept.delete(worst as Tip);
  }
  return tips.filter((t) => kept.has(t)).map((t) => t.text);
}

/**
 * Build the MOVES-tab view-model for `animal`. `set` defaults to the registered moveset; tests pass a fixture to
 * prove the panel follows the data.
 */
export function buildMovesView(animal: AnimalId, set: MovesetDef = getMoveset(animal)): MovesView {
  // the lowest-kill-percent heavy is the "Kill move" (ties: first in display order)
  let killSlot: MoveId | null = null;
  let killPct: number | null = null;
  for (const id of MOVE_IDS) {
    if (!id.startsWith('heavy')) continue;
    const p = slotKillPercent(set.moves[id]);
    if (Number.isFinite(p) && (killPct === null || p < killPct)) {
      killPct = p;
      killSlot = id;
    }
  }
  const entries = MOVE_IDS.map((id) => buildEntry(id, set.moves[id], killSlot, killPct));
  return { animal, entries, lightString: buildLightString(set), tips: buildTips(set, entries) };
}
