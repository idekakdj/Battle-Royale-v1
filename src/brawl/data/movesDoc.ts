/**
 * Champions League — renders `docs/CHAMPIONS-LEAGUE-MOVES.md` from the move data (pure; no fs).
 * Regenerate after changing numbers: write the string returned by `renderMovesDoc()` to that file.
 */

import type { AnimalId } from '../../core/types';
import type { HitboxDef, MoveBody, MoveId } from '../types';
import { MOVE_IDS } from '../types';
import { MOVESETS, getMoveBody } from './index';
import { bodyKillPercent, bodyReach, powerIndex, simulateRecovery, totalFrames, victimDamage } from './analysis';

const ORDER: AnimalId[] = ['lion', 'gorilla', 'crocodile', 'hippo', 'rhino', 'eagle', 'panther', 'python', 'giraffe', 'mole'];
const SLOT_NAME: Record<MoveId, string> = {
  lightN: 'Light Neutral',
  lightS: 'Light Side',
  lightD: 'Light Down',
  lightU: 'Light Up',
  heavyN: 'Heavy Neutral',
  heavyS: 'Heavy Side',
  heavyD: 'Heavy Down',
  heavyU: 'Heavy Up (recovery)',
};

const f1 = (v: number): string => (Math.round(v * 10) / 10).toString();
const cap = (s: string): string => s.charAt(0).toUpperCase() + s.slice(1);

/** The hitbox that defines the move for display: highest damage, then highest growth. */
function mainBox(b: MoveBody): HitboxDef {
  return [...b.hitboxes].sort((x, y) => y.damage - x.damage || y.kbGrowth - x.kbGrowth)[0];
}

function dmgText(b: MoveBody): string {
  const d = victimDamage(b);
  return d.max > d.base ? `${f1(d.base)} (${f1(d.max)} sweet)` : f1(d.base);
}

function notes(b: MoveBody): string {
  const n: string[] = [];
  const fx = new Set(b.hitboxes.map((h) => h.effect).filter((e): e is NonNullable<HitboxDef['effect']> => !!e && e !== 'none'));
  for (const e of fx) n.push(e);
  if (b.hitboxes.some((h) => h.sweet)) n.push('sweetspot');
  if (b.hitboxes.some((h) => h.multiHitInterval)) n.push('multi-hit');
  if (new Set(b.hitboxes.map((h) => (h.x < 0 ? 'back' : 'front'))).size > 1) n.push('two-sided');
  if (b.armor) n.push(`armor f${b.armor.from}-${b.armor.to}`);
  if (b.invuln) n.push(`invulnerable f${b.invuln.from}-${b.invuln.to}`);
  if (b.burrow) n.push(`underground f${b.burrow.from}-${b.burrow.to}`);
  for (const m of b.motion ?? []) {
    const fr = m.to - m.from;
    const dx = ((m.vx ?? 0) * fr) / 60;
    const dy = ((m.vy ?? 0) * fr) / 60;
    const parts: string[] = [];
    if (dx) parts.push(`${f1(dx)} m fwd`);
    if (dy) parts.push(`${f1(dy)} m ${dy > 0 ? 'up' : 'down'}`);
    if (parts.length) n.push(`moves ${parts.join(', ')} (f${m.from}-${m.to})${m.stopAtEdge ? ', stops at the platform edge' : ''}`);
  }
  if (b.hitboxes.some((h) => h.path)) n.push('swept hitbox');
  return n.join('; ') || '-';
}

function row(label: string, b: MoveBody): string {
  const h = mainBox(b);
  const kb = `${h.baseKb} + ${h.kbGrowth}`;
  const stats = `${b.startup}/${b.active}/${b.recovery} (${totalFrames(b)})`;
  const look = String(b.anim?.look ?? '');
  const reach = typeof b.anim?.reach === 'number' ? `${b.anim.reach}` : '-';
  const height = typeof b.anim?.height === 'number' ? `${b.anim.height}` : '-';
  const limb = `${b.anim?.limb ?? ''}${b.anim?.side ? ` (${b.anim.side})` : ''}`;
  return `| ${label} | ${b.name} | ${b.archetype} | ${stats} | ${dmgText(b)} | ${kb} | ${h.angle} | ${notes(b)} | ${limb}; reach ${reach}, height ${height}; ${look} |`;
}

function airRows(a: AnimalId): string[] {
  const out: string[] = [];
  for (const id of MOVE_IDS) {
    const g = getMoveBody(a, id, false);
    const ar = getMoveBody(a, id, true);
    const diff: string[] = [];
    if (ar.name !== g.name) diff.push(`renamed "${ar.name}"`);
    if (ar.hitboxes !== g.hitboxes) {
      const h = mainBox(ar);
      diff.push(`own hitbox: ${f1(h.damage)} dmg, ${h.baseKb} + ${h.kbGrowth}, angle ${h.angle}${h.effect && h.effect !== 'none' ? `, ${h.effect}` : ''}`);
    }
    if (ar.motion !== g.motion) diff.push(g.motion && !ar.motion ? 'no motion' : 'own motion');
    if (g.burrow && !ar.burrow) diff.push('no underground window');
    out.push(`| ${id} | ${totalFrames(ar)} | ${ar.landingLag} | ${ar.autoCancel ? `f${ar.autoCancel.from}-${ar.autoCancel.to}` : '-'} | ${diff.join('; ') || 'same as ground'} |`);
  }
  return out;
}

export function renderMovesDoc(): string {
  const L: string[] = [];
  L.push('# Champions League — movesets');
  L.push('');
  L.push('Generated from `src/brawl/data/animals/*` by `renderMovesDoc()` (`src/brawl/data/movesDoc.ts`) — do not hand-edit numbers; change the data and regenerate.');
  L.push('Budgets and invariants are enforced by `tests/brawl/moveBudget.test.ts`.');
  L.push('');
  L.push('## Conventions (for animators, bots and the balance pass)');
  L.push('');
  L.push('* Frames are 60 Hz. **S/A/R** = startup / active / recovery, `(n)` = total frames (<= 62). Hitboxes are active in `[startup, startup + active)`.');
  L.push('* Hitbox coordinates are fighter-local metres: origin = feet centre, +x forward, +y up. `reach` = furthest forward extent of the hitbox (m from the feet centre, including its sweep path); `height` = the height of the striking tip at the peak pose.');
  L.push('* `path` keyframes are move-relative frames (the same clock as `from`/`to`), offsets are added to the box position, linearly interpolated, first key at the first active frame. The visible limb/head/tail tip must travel with the box.');
  L.push('* `anim` keys on every body: `look` (this table\'s last column), `limb` (the striking part: paw, forelimb, claw, talon, jaw, head, horn, beak, tail, neck, wing, body), `side` (L, R, both, front, back, up, down), `reach`, `height`, plus optional `arc` (degrees swung), `travel` (m moved), `spin` (turns), `rise` (m climbed), `ring` (radius of a two-sided burst), `pitch` (body pitch in degrees for dives), `gape`, `depth`.');
  L.push('* `sweet` (sweetspot) is a circle tested against the centre of the victim (sim rule), fighter-local like the box and moving with its `path`; it sits at the far end of the reach, so it rewards spacing (jaw / beak tip / neck tip). Boxes that share a `group` can hit one victim only once per activation; within a body either every box sets a `group` or none does. `multi-hit` boxes re-hit every `multiHitInterval` frames.');
  L.push('* KB column = `baseKb + kbGrowth` of the main hitbox: launch speed (m/s) = `(base + growth x percent/100) x (100 / weight)`. Angle: 0 = forward, 90 = up, 270 = down (mirrored by facing). Damage = total one victim can take from one activation (sweetspot value in brackets).');
  L.push('* lightN is a string: the table shows each link; pressing Light inside the previous link\'s cancel window continues it (links after the first are `onHitOnly`).');
  L.push('* Every move has an aerial form (see the "Aerials" tables): landing lag when landing before the move ends, and an auto-cancel window of late frames. Spikes (`spike` effect) exist only on the air Heavy Down of lion, gorilla, crocodile, hippo, rhino, eagle and giraffe.');
  L.push('* `underground f{a}-{b}` (v1.6, mole Burrow Strike, ground form only): the fighter is untouchable in that window (hits bypass it: no hit, no hitlag), hitboxes pass through it, the rig is hidden under a dirt mound; `stops at the platform edge` = the tunnel never carries it off the platform it stands on (it surfaces at the edge instead), and it surfaces standing still.');
  L.push('* Heavy Up is the recovery: it travels (`moves ... up` in the notes) and can be used once per airtime; on the ground it is a leaping launcher.');
  L.push('');
  L.push('## Roster at a glance');
  L.push('');
  L.push('| Animal | Identity | Weight | Run | Recovery score* | Best kill % (w100) | Power index |');
  L.push('|---|---|---|---|---|---|---|');
  for (const a of ORDER) {
    const s = MOVESETS[a];
    const rec = simulateRecovery(getMoveBody(a, 'heavyU', false), s.stats).score;
    const kills = (['heavyN', 'heavyS', 'heavyD', 'heavyU'] as const).map((id) =>
      Math.min(bodyKillPercent(getMoveBody(a, id, false)), bodyKillPercent(getMoveBody(a, id, true))),
    );
    L.push(`| ${cap(a)} | ${s.tagline} | ${s.stats.weight} | ${s.stats.runSpeed} | ${f1(rec)} | ${Math.min(...kills)} | ${powerIndex(s).toFixed(3)} |`);
  }
  L.push('');
  L.push('\\* height gained + half the horizontal drift of Heavy Up (m), computed by `simulateRecovery`. Kill % is the data-level estimate of `killPercent` (no DI / air control); the balance script measures the real thing.');
  for (const a of ORDER) {
    const s = MOVESETS[a];
    const st = s.stats;
    L.push('');
    L.push(`## ${cap(a)}`);
    L.push('');
    L.push(`*${s.tagline}*`);
    L.push('');
    L.push(
      `Weight ${st.weight}, walk ${st.walkSpeed}, run ${st.runSpeed}, air ${st.airSpeed} (accel ${st.airAccel}), jump ${st.jumpVel} / air jump ${st.airJumpVel}, ${st.maxJumps} jumps, gravity x${st.gravityMult}, fall ${st.fallSpeed} / fast ${st.fastFallSpeed}${st.glideFall ? ` / glide ${st.glideFall}` : ''}, hurtbox ${st.width} x ${st.height} m, dodge ${st.dodgeInvuln}/${st.dodgeFrames} frames.`,
    );
    L.push('');
    L.push('| Slot | Name | Archetype | S/A/R | Dmg | KB | Angle | Notes | What it looks like |');
    L.push('|---|---|---|---|---|---|---|---|---|');
    for (const id of MOVE_IDS) {
      const m = s.moves[id];
      if (id === 'lightN') {
        L.push(row('lightN 1', m.ground));
        (m.chain ?? []).forEach((c, i) => L.push(row(`lightN ${i + 2}`, c)));
      } else L.push(row(`${id} — ${SLOT_NAME[id]}`, m.ground));
    }
    L.push('');
    L.push('Aerials:');
    L.push('');
    L.push('| Slot | Frames | Landing lag | Auto-cancel | Difference from the ground form |');
    L.push('|---|---|---|---|---|');
    L.push(...airRows(a));
    const reach = Math.max(...MOVE_IDS.map((id) => bodyReach(getMoveBody(a, id, false))));
    L.push('');
    L.push(`Longest hitbox reach: ${f1(reach)} m.`);
  }
  L.push('');
  return L.join('\n');
}
