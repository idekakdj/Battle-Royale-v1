import { describe, it, expect } from 'vitest';
import { tryStartSwing, updateSwing } from '../../src/sim/CombatSystem';
import { makeFighter, makeSim, DT } from './helpers';
import type { GameEvent } from '../../src/core/types';

describe('combo & ult charge (§7.2)', () => {
  it('grants +8 charge on a landed unblocked hit1', () => {
    const a = makeFighter(0, 'lion', 0, 0, 0);
    const t = makeFighter(1, 'gorilla', 0, 1.5, 0);
    const sim = makeSim([a, t]);
    a.intent.aimYaw = 0;
    tryStartSwing(a);
    for (let i = 0; i < 200 && a.swinging; i++) updateSwing(sim, a, DT);
    expect(a.state.ultCharge).toBe(8);
  });

  it('halves charge when the hit was blocked', () => {
    const a = makeFighter(0, 'lion', 0, 0, 0);
    const t = makeFighter(1, 'gorilla', 0, 1.5, Math.PI); // faces −Z toward attacker
    const sim = makeSim([a, t]);
    t.blocking = true;
    a.intent.aimYaw = 0;
    tryStartSwing(a);
    for (let i = 0; i < 200 && a.swinging; i++) updateSwing(sim, a, DT);
    expect(a.state.ultCharge).toBe(4);
  });

  it('chains hit1 → hit2 → finisher and emits comboFinisher', () => {
    const events: GameEvent[] = [];
    const a = makeFighter(0, 'lion', 0, 0, 0);
    const t = makeFighter(1, 'gorilla', 0, 1.5, 0);
    const sim = makeSim([a, t], events);
    a.intent.aimYaw = 0;
    tryStartSwing(a);
    let maxIdx = 0;
    for (let i = 0; i < 600 && (a.swinging || a.sinceSwingEnd <= 0.5); i++) {
      if (a.swinging && a.state.actionT >= a.state.actionDur * 0.6) tryStartSwing(a);
      updateSwing(sim, a, DT);
      if (a.state.comboIndex > maxIdx) maxIdx = a.state.comboIndex;
    }
    expect(maxIdx).toBe(2);
    expect(events.filter((e) => e.type === 'comboFinisher').length).toBeGreaterThanOrEqual(1);
    // Charge = 8 + 8 + 14.
    expect(a.state.ultCharge).toBe(30);
  });

  it('resets the combo to hit1 after the reset window elapses', () => {
    const a = makeFighter(0, 'lion', 0, 0, 0);
    const t = makeFighter(1, 'gorilla', 0, 1.5, 0);
    const sim = makeSim([a, t]);
    a.intent.aimYaw = 0;
    tryStartSwing(a); // attack1
    for (let i = 0; i < 200 && a.swinging; i++) updateSwing(sim, a, DT);
    // Idle for > resetTime (1.2 s) without swinging.
    for (let i = 0; i < 90; i++) updateSwing(sim, a, DT);
    expect(a.nextComboStep).toBe(0);
    tryStartSwing(a);
    expect(a.state.comboIndex).toBe(0);
  });
});
