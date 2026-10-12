/**
 * v1.9 sea serpent — DODGEABILITY (WP-O1b): scripted fighters of every animal start a full-speed sidestep (perpendicular to the strike
 * line) a given time after the warning begins; the table of which ones escape is the tuning evidence of docs/OCEAN-PLAN.md
 * ("Serpent tuning"). Real World physics (acceleration, body radius) on the flat test dome, the fighter standing ON the line at
 * distance r0 from the centre (the worst spot: dead centre of the strip).
 *
 * Targets ("difficult but not impossible", config/serpent.ts):
 *   (a) starting the instant the warning begins: everyone escapes, everywhere;
 *   (b) the slowest animal escapes when it starts within 0.5 s of the warning, wherever it stands;
 *   (c) starting 0.7 s after the warning: only the fast animals escape from the rim (the slow ones never);
 *   (d) starting 1.1 s after the warning or later: nobody escapes, wherever they stand;
 *   (e) a stationary fighter on the line is always hit.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { ANIMAL_IDS, ANIMALS } from '../../src/config/animals';
import { SERPENT } from '../../src/config/serpent';
import type { AnimalId } from '../../src/core/types';
import { DT, FLAT_ARENA, installOcean, neutralIntent, oceanWorld, ofType, place } from './serpentHelpers';

beforeAll(() => installOcean(FLAT_ARENA));

/** Distances from the centre (m) the fighter stands at: the rim (spawn ring), the outer ring, mid-field, the centre plateau. */
const POSITIONS = [26, 20, 12, 4] as const;

/**
 * Does `animal` standing on the strike line at distance `r0` from the centre escape when it starts sidestepping `delayS` seconds
 * after the WARNING begins (null = never moves)? `sign` picks the side.
 */
function escapes(animal: AnimalId, r0: number, delayS: number | null, sign: 1 | -1 = 1): boolean {
  const { world, events } = oceanWorld([animal, 'lion'], 21);
  place(world, 0, r0, 0);
  place(world, 1, 0, -26); // parked off the line (a lion that does nothing)
  world.debugTriggerSerpent(0);
  // tick 0 is the tick the warning is emitted; the fighter can only react to it from the next tick on
  const delayTicks = delayS === null ? null : Math.round(delayS / DT);
  for (let t = 0; t < 300 && world.serpent?.active; t++) {
    const go = delayTicks !== null && t >= delayTicks + 1;
    world.setIntent(0, { ...neutralIntent(), moveZ: go ? sign : 0, aimYaw: 0 });
    world.step(DT);
  }
  return ofType(events, 'serpentHit').every((h) => h.fighterId !== 0);
}

/** Latest reaction delay (s after the warning begins, 1/60 s steps) at which `animal` still escapes from `r0`; -1 = never. */
function latestEscape(animal: AnimalId, r0: number): number {
  let best = -1;
  for (let k = 0; k <= 130; k++) {
    if (escapes(animal, r0, k * DT)) best = k;
    else if (best >= 0) break; // monotone: once it fails, later starts fail too
  }
  return best < 0 ? -1 : best * DT;
}

const table = new Map<AnimalId, number[]>();
beforeAll(() => {
  for (const a of ANIMAL_IDS) table.set(a, POSITIONS.map((r0) => latestEscape(a, r0)));
});

const slowest = (): AnimalId => [...ANIMAL_IDS].sort((a, b) => ANIMALS[a].speed - ANIMALS[b].speed)[0];

describe('dodging the strike line', () => {
  it('prints the dodge table (latest escaping reaction delay by animal and distance from the centre)', () => {
    const rows: string[] = [];
    rows.push(`warnS ${SERPENT.warnS}  strikeS ${SERPENT.strikeS}  half-width ${SERPENT.stripHalfWidth}  head ${(30 / SERPENT.strikeS).toFixed(1)} m/s`);
    rows.push(`animal     speed radius | latest escaping start (s after the warning) at r0 = ${POSITIONS.join(' / ')} m`);
    for (const a of ANIMAL_IDS) {
      const cells = (table.get(a) as number[]).map((v) => v.toFixed(2).padStart(5));
      rows.push(`${a.padEnd(10)} ${ANIMALS[a].speed.toFixed(1).padStart(5)} ${ANIMALS[a].radius.toFixed(2)}   | ${cells.join('  ')}`);
    }
    for (const delay of [0, 0.4, 0.7, 1.0]) {
      const cells = POSITIONS.map((_, i) => `${ANIMAL_IDS.filter((a) => (table.get(a) as number[])[i] >= delay - 1e-9).length}/10`);
      rows.push(`escape if starting at +${delay.toFixed(1)} s: ${cells.join('  ')}`);
    }
    console.log('\n' + rows.join('\n'));
    expect(rows.length).toBeGreaterThan(14);
  });

  it('(a) starting the instant the warning begins (or 0.2 s later) everybody escapes, on either side, everywhere', () => {
    for (const a of ANIMAL_IDS) {
      for (const r0 of POSITIONS) {
        for (const sign of [1, -1] as const) {
          expect(escapes(a, r0, 0, sign), `${a} r0=${r0} sign=${sign}`).toBe(true);
          expect(escapes(a, r0, 0.2, sign), `${a} r0=${r0} sign=${sign} +0.2`).toBe(true);
        }
      }
    }
  });

  it('(b) the slowest animal still escapes when it starts within 0.5 s, wherever it stands', () => {
    const a = slowest();
    expect(a).toBe('rhino');
    for (let i = 0; i < POSITIONS.length; i++) {
      expect((table.get(a) as number[])[i], `${a} at ${POSITIONS[i]} m`).toBeGreaterThanOrEqual(0.5);
    }
    for (const x of ANIMAL_IDS) for (const v of table.get(x) as number[]) expect(v).toBeGreaterThanOrEqual(0.5);
  });

  it('(c) starting 0.7 s after the warning, only the fast animals escape from the rim; the slow ones are caught', () => {
    const rim = (animal: AnimalId): number => (table.get(animal) as number[])[0];
    const escaping = ANIMAL_IDS.filter((a) => rim(a) >= 0.7);
    expect(escaping.length).toBeGreaterThanOrEqual(1);
    expect(escaping.length).toBeLessThanOrEqual(4);
    for (const slow of ['rhino', 'hippo', 'crocodile', 'python'] as const) expect(escaping).not.toContain(slow);
    // ... and it is the fast ones that escape
    const minSpeed = Math.min(...escaping.map((a) => ANIMALS[a].speed));
    const maxSlowEscape = Math.max(...ANIMAL_IDS.filter((a) => !escaping.includes(a)).map((a) => ANIMALS[a].speed));
    expect(minSpeed).toBeGreaterThanOrEqual(6.0);
    expect(maxSlowEscape).toBeLessThanOrEqual(6.5);
    // sanity: a real sidestep at +0.7 s from the rim: the eagle makes it, the rhino does not
    expect(escapes('eagle', 26, 0.7)).toBe(true);
    expect(escapes('rhino', 26, 0.7)).toBe(false);
  });

  it('(d) starting 1.1 s after the warning or later, nobody escapes, wherever they stand', () => {
    for (const a of ANIMAL_IDS) {
      for (const v of table.get(a) as number[]) expect(v, a).toBeLessThan(1.1);
      for (let i = 0; i < POSITIONS.length; i++) {
        expect(escapes(a, POSITIONS[i], 1.1), `${a} at ${POSITIONS[i]} m`).toBe(false);
        expect(escapes(a, POSITIONS[i], 1.5), `${a} at ${POSITIONS[i]} m`).toBe(false);
      }
    }
  });

  it('(e) a stationary fighter on the line is always hit, for every animal and every distance', () => {
    for (const a of ANIMAL_IDS) {
      for (const r0 of [28, 26, 20, 12, 4, 0.5]) expect(escapes(a, r0, null), `${a} at ${r0} m`).toBe(false);
    }
  });

  it('later starts only get harder: the latest escaping delay shrinks toward the rim for every animal', () => {
    for (const a of ANIMAL_IDS) {
      const v = table.get(a) as number[];
      for (let i = 1; i < v.length; i++) expect(v[i]).toBeGreaterThan(v[i - 1]); // POSITIONS go from the rim to the centre
    }
  });
});
