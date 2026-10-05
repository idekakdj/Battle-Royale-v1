import { describe, expect, it } from 'vitest';
import { ANIMAL_IDS } from '../../src/config/animals';
import { MOVESETS, victimDamage } from '../../src/brawl/data';
import type { MoveId, MovesetDef } from '../../src/brawl/types';
import { MOVE_IDS } from '../../src/brawl/types';
import { MOVES_LEGEND, buildMovesView, slotKeys, speedLabel } from '../../src/brawl/ui/movesView';

const KEYS: Record<MoveId, string[]> = {
  lightN: ['J'],
  lightS: ['→', 'J'],
  lightD: ['↓', 'J'],
  lightU: ['↑', 'J'],
  heavyN: ['K'],
  heavyS: ['→', 'K'],
  heavyD: ['↓', 'K'],
  heavyU: ['↑', 'K'],
};

const clone = (animal: (typeof ANIMAL_IDS)[number]): MovesetDef => structuredClone(MOVESETS[animal]);

describe('MOVES view-model: every animal', () => {
  it('has 8 entries in order Light N/S/D/U then Heavy N/S/D/U with the right key caps', () => {
    for (const a of ANIMAL_IDS) {
      const v = buildMovesView(a);
      expect(v.animal).toBe(a);
      expect(v.entries.map((e) => e.slot)).toEqual([...MOVE_IDS]);
      expect(v.entries.map((e) => e.row)).toEqual(['light', 'light', 'light', 'light', 'heavy', 'heavy', 'heavy', 'heavy']);
      expect(v.entries.map((e) => e.column)).toEqual(['neutral', 'side', 'down', 'up', 'neutral', 'side', 'down', 'up']);
      for (const e of v.entries) {
        expect(e.keys).toEqual(KEYS[e.slot]);
        expect(e.inputText).toBe(KEYS[e.slot].join(' + '));
      }
    }
    expect(slotKeys('heavyD')).toEqual(['↓', 'K']);
  });

  it('reads names, descriptions, startup and damage straight from the data (finite, non-empty)', () => {
    for (const a of ANIMAL_IDS) {
      const set = MOVESETS[a];
      for (const e of buildMovesView(a).entries) {
        const g = set.moves[e.slot].ground;
        expect(e.name).toBe(g.name);
        expect(e.name.trim()).not.toBe('');
        expect(e.look).toBe(String(g.anim?.look));
        expect(e.look.trim()).not.toBe('');
        expect(e.startup).toBe(g.startup);
        expect(Number.isFinite(e.damage)).toBe(true);
        expect(e.damage).toBeGreaterThan(0);
        expect(e.damage).toBe(victimDamage(g).base);
        expect(e.damageSweet).toBeGreaterThanOrEqual(e.damage);
        expect(e.damageShort.trim()).not.toBe('');
        expect(e.damageLabel.trim()).not.toBe('');
        expect(e.hits).toBeGreaterThanOrEqual(1);
      }
    }
  });

  it('speed labels follow the startup bands (Fast <= 8, Medium <= 14, Slow > 14)', () => {
    expect([speedLabel(3), speedLabel(8), speedLabel(9), speedLabel(14), speedLabel(15), speedLabel(30)]).toEqual([
      'Fast',
      'Fast',
      'Medium',
      'Medium',
      'Slow',
      'Slow',
    ]);
    for (const a of ANIMAL_IDS) for (const e of buildMovesView(a).entries) expect(e.speed).toBe(speedLabel(e.startup));
  });

  it('puts the Recovery tag on heavyU only, on every animal', () => {
    for (const a of ANIMAL_IDS) {
      for (const e of buildMovesView(a).entries) {
        const has = e.tags.some((t) => t.id === 'recovery');
        expect(has).toBe(e.slot === 'heavyU');
      }
    }
  });

  it('marks exactly one heavy as the Kill move (the lowest kill percent), never a light', () => {
    for (const a of ANIMAL_IDS) {
      const v = buildMovesView(a);
      const kills = v.entries.filter((e) => e.tags.some((t) => t.id === 'kill'));
      expect(kills).toHaveLength(1);
      expect(kills[0].row).toBe('heavy');
      const heavies = v.entries.filter((e) => e.row === 'heavy' && e.killPercent !== null);
      const lowest = Math.min(...heavies.map((e) => e.killPercent as number));
      expect(kills[0].killPercent).toBe(lowest);
    }
  });

  it('tags come from the data: armor / invulnerable / multi-hit / sweetspot / spike / pull / stun / flinch / bury', () => {
    for (const a of ANIMAL_IDS) {
      const set = MOVESETS[a];
      for (const e of buildMovesView(a).entries) {
        const m = set.moves[e.slot];
        const ids = new Set(e.tags.map((t) => t.id));
        const fx = new Set([...m.ground.hitboxes, ...(m.air?.hitboxes ?? [])].map((h) => h.effect));
        expect(ids.has('armor')).toBe(m.ground.armor !== undefined);
        expect(ids.has('invuln')).toBe(m.ground.invuln !== undefined);
        expect(ids.has('sweet')).toBe(m.ground.hitboxes.some((h) => h.sweet !== undefined));
        expect(ids.has('multi')).toBe(e.hits > 1 || m.ground.hitboxes.some((h) => (h.multiHitInterval ?? 0) > 0));
        expect(ids.has('spike')).toBe(fx.has('spike'));
        expect(ids.has('pull')).toBe(fx.has('pull'));
        expect(ids.has('stun')).toBe(fx.has('stun'));
        expect(ids.has('flinch')).toBe(fx.has('flinch'));
        expect(ids.has('bury')).toBe(fx.has('bury'));
        for (const t of e.tags) {
          expect(t.label.trim()).not.toBe('');
          expect(t.detail.trim()).not.toBe('');
        }
      }
    }
    const gorilla = buildMovesView('gorilla').entries;
    expect(gorilla.find((e) => e.slot === 'heavyS')?.tags.map((t) => t.id)).toContain('armor');
    const panther = buildMovesView('panther').entries;
    expect(panther.find((e) => e.slot === 'heavyS')?.tags.find((t) => t.id === 'invuln')?.label).toBe('Invulnerable start');
    const croc = buildMovesView('crocodile').entries.find((e) => e.slot === 'heavyN');
    expect(croc?.hits).toBeGreaterThan(1);
    expect(croc?.damageLabel).toContain('×');
  });

  it('gives an AIR note when the aerial form spikes, and never for an identical aerial form', () => {
    const lion = buildMovesView('lion').entries;
    expect(lion.find((e) => e.slot === 'heavyD')?.airNote).toMatch(/^In the air: .*spikes downward.*landing lag \d+/);
    expect(lion.find((e) => e.slot === 'lightN')?.airNote).toBeNull();
    for (const a of ANIMAL_IDS) {
      for (const e of buildMovesView(a).entries) {
        const m = MOVESETS[a].moves[e.slot];
        if (m.air === null) expect(e.airNote).toBeNull();
        if (e.tags.some((t) => t.id === 'spike')) expect(e.airNote).toContain('spikes downward');
      }
    }
  });
});

describe('MOVES view-model: Light string', () => {
  it('lists 2-3 hits (name + damage) for every animal that has chain bodies, with the continue note', () => {
    for (const a of ANIMAL_IDS) {
      const set = MOVESETS[a];
      const chain = set.moves.lightN.chain ?? [];
      const ls = buildMovesView(a).lightString;
      if (chain.length > 0) {
        expect(ls.hits.length).toBe(1 + chain.length);
        expect(ls.hits.length).toBeGreaterThanOrEqual(2);
        expect(ls.hits.length).toBeLessThanOrEqual(3);
        expect(ls.note).toContain('Press Light again');
      }
      expect(ls.hits.map((h) => h.name)).toEqual([set.moves.lightN.ground, ...chain].map((b) => b.name));
      expect(ls.text).toBe(ls.hits.map((h) => h.name).join(' → '));
      expect(ls.total).toBeCloseTo(ls.hits.reduce((s, h) => s + h.damage, 0), 6);
      for (const h of ls.hits) expect(h.damage).toBeGreaterThan(0);
    }
    expect(buildMovesView('lion').lightString.text).toBe('Claw Swipe → Claw Backhand → Claw Rake');
    expect(buildMovesView('eagle').lightString.hits).toHaveLength(3);
  });
});

describe('MOVES view-model: good-to-know bullets', () => {
  it('2-4 non-empty bullets for every animal', () => {
    for (const a of ANIMAL_IDS) {
      const tips = buildMovesView(a).tips;
      expect(tips.length).toBeGreaterThanOrEqual(2);
      expect(tips.length).toBeLessThanOrEqual(4);
      for (const t of tips) expect(t.trim().length).toBeGreaterThan(10);
      expect(new Set(tips).size).toBe(tips.length);
    }
  });

  it('the eagle mentions its air jumps and the glide', () => {
    const tips = buildMovesView('eagle').tips.join(' ');
    expect(tips).toMatch(/4 jumps/);
    expect(tips).toMatch(/3 in the air/);
    expect(tips).toMatch(/glide/i);
  });

  it('armored animals mention their armor window; the kill and recovery facts name the real moves', () => {
    expect(buildMovesView('gorilla').tips.join(' ')).toMatch(/Armor: .*Silverback Swing/);
    expect(buildMovesView('panther').tips.join(' ')).toMatch(/cannot be hit/);
    for (const a of ANIMAL_IDS) {
      const v = buildMovesView(a);
      const kill = v.entries.find((e) => e.tags.some((t) => t.id === 'kill'));
      const text = v.tips.join(' ');
      expect(text).toContain(`Kills earliest with ${kill?.name}`);
      expect(text).toContain(v.entries[7].name);
      expect(text).toMatch(/\d+(st|nd|rd|th) of 10/);
      expect(text).toMatch(/weight \d+/);
    }
  });

  it('the eagle ranks first in recovery and the hippo last', () => {
    expect(buildMovesView('eagle').tips.join(' ')).toContain('1st of 10');
    expect(buildMovesView('hippo').tips.join(' ')).toContain('10th of 10');
  });
});

describe('MOVES view-model follows the data (fixture MovesetDef)', () => {
  it('renaming, retiming and re-tuning moves changes the entries', () => {
    const base = buildMovesView('lion');
    const f = clone('lion');
    f.moves.lightS.ground.name = 'Fixture Slash';
    f.moves.lightS.ground.anim = { ...f.moves.lightS.ground.anim, look: 'A made-up description' };
    f.moves.lightS.ground.startup = 20;
    f.moves.lightS.ground.hitboxes[0].damage = 12;
    const v = buildMovesView('lion', f);
    const e = v.entries[1];
    expect(e.name).toBe('Fixture Slash');
    expect(e.look).toBe('A made-up description');
    expect(e.speed).toBe('Slow');
    expect(e.damage).toBe(12);
    expect(base.entries[1].name).toBe('Pounce Swipe');
    expect(base.entries[1].speed).not.toBe('Slow');
    // the registry itself was not touched
    expect(MOVESETS.lion.moves.lightS.ground.name).toBe('Pounce Swipe');
  });

  it('adding armor adds the tag and the armor bullet; removing the aerial form removes the air note', () => {
    const f = clone('lion');
    expect(buildMovesView('lion').entries[4].tags.some((t) => t.id === 'armor')).toBe(false);
    f.moves.heavyN.ground.armor = { from: 4, to: 12, hits: 3 };
    f.moves.heavyD.air = null;
    const v = buildMovesView('lion', f);
    const roar = v.entries[4];
    expect(roar.tags.find((t) => t.id === 'armor')?.detail).toContain('3 hits');
    expect(v.tips.join(' ')).toMatch(/Armor: Roar Wave \(K\) shrugs off 3 hits \(frames 4-12\)/);
    expect(v.entries[6].airNote).toBeNull();
    expect(v.entries[6].tags.some((t) => t.id === 'spike')).toBe(false);
    expect(buildMovesView('lion').entries[6].airNote).not.toBeNull();
  });

  it('dropping the chain bodies shrinks the Light string to one hit with no continue note', () => {
    const f = clone('lion');
    delete f.moves.lightN.chain;
    const ls = buildMovesView('lion', f).lightString;
    expect(ls.hits).toHaveLength(1);
    expect(ls.text).toBe('Claw Swipe');
    expect(ls.note).toBe('');
    expect(buildMovesView('lion').lightString.hits).toHaveLength(3);
  });

  it('stats drive the jump / weight bullets and a change of the strongest heavy moves the Kill move', () => {
    const f = clone('lion');
    f.stats.maxJumps = 5;
    f.stats.glideFall = 4;
    f.stats.weight = 140;
    const before = buildMovesView('lion');
    const after = buildMovesView('lion', f);
    expect(before.tips.join(' ')).not.toMatch(/glide/);
    expect(after.tips.join(' ')).toMatch(/5 jumps in all \(4 in the air\).*glide.*4 m\/s/);
    expect(after.tips.join(' ')).toMatch(/Heavyweight \(weight 140\)/);

    // make heavyN (Roar Wave) the hardest hitter: it takes over the Kill move tag from Maul Bite
    const g = clone('lion');
    for (const h of g.moves.heavyN.ground.hitboxes) {
      h.damage = 30;
      h.baseKb = 30;
      h.kbGrowth = 40;
      h.angle = 40;
    }
    const v = buildMovesView('lion', g);
    const killSlots = v.entries.filter((e) => e.tags.some((t) => t.id === 'kill')).map((e) => e.slot);
    expect(killSlots).toEqual(['heavyN']);
    expect(before.entries.filter((e) => e.tags.some((t) => t.id === 'kill')).map((e) => e.slot)).toEqual(['heavyS']);
  });

  it('exposes the controls legend used under the grid', () => {
    expect(MOVES_LEGEND.light).toBe('J / Left click');
    expect(MOVES_LEGEND.heavy).toBe('K / Right click');
    expect(MOVES_LEGEND.dodge).toBe('L / Shift');
  });
});

describe('MOVES view-model: v1.6 Underground tag (mole Burrow Strike)', () => {
  it('shows a dedicated Underground tag (with its tooltip) computed from `body.burrow`, only on burrow moves', () => {
    for (const a of ANIMAL_IDS) {
      const set = MOVESETS[a];
      for (const e of buildMovesView(a).entries) {
        const has = e.tags.some((t) => t.id === 'underground');
        expect(has, `${a} ${e.slot}`).toBe(set.moves[e.slot].ground.burrow !== undefined);
      }
    }
    const heavyD = buildMovesView('mole').entries.find((e) => e.slot === 'heavyD');
    const tag = heavyD?.tags.find((t) => t.id === 'underground');
    expect(tag?.label).toBe('Underground');
    expect(tag?.detail).toBe('Untouchable while tunnelling; erupts upward and launches enemies');
    expect(heavyD?.name).toBe('Burrow Strike');
    // it is listed before the generic invulnerability pill, which no longer says "start" for a burrow
    const ids = heavyD?.tags.map((t) => t.id) ?? [];
    expect(ids.indexOf('underground')).toBeLessThan(ids.indexOf('invuln'));
    expect(heavyD?.tags.find((t) => t.id === 'invuln')?.label).toBe('Invulnerable');
    expect(heavyD?.tags.find((t) => t.id === 'travel')?.label).toBe('Tunnels');
    expect(heavyD?.tags.find((t) => t.id === 'travel')?.detail).toMatch(/3\.3 m.*platform/);
    expect(heavyD?.look.toLowerCase()).toContain('tunnels');
    // the tag follows the data: remove the window and it disappears (the plain invulnerability tag remains)
    const m = clone('mole');
    delete m.moves.heavyD.ground.burrow;
    const plain = buildMovesView('mole', m).entries.find((e) => e.slot === 'heavyD');
    expect(plain?.tags.some((t) => t.id === 'underground')).toBe(false);
    expect(plain?.tags.find((t) => t.id === 'invuln')?.label).toBe('Invulnerable start');
  });

  it('the good-to-know bullets explain the burrow instead of "cannot be hit"', () => {
    const tips = buildMovesView('mole').tips.join(' ');
    expect(tips).toMatch(/Burrow Strike \(↓ \+ K\) goes underground on frames 6-24/);
    expect(tips).toMatch(/erupts upward/);
  });

  it('the AIR form is described as the drill-down and does not carry the underground tag', () => {
    const heavyD = buildMovesView('mole').entries.find((e) => e.slot === 'heavyD');
    expect(heavyD?.airNote).toMatch(/Drill Down/);
  });
});
