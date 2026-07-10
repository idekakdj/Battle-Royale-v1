/**
 * Pickup pads (BLUEPRINT §9): 6 pads at radius 10, kinds weighted heal 0.5 /
 * speed 0.25 / rage 0.25, trigger radius 1.2, respawn 20 s. heal = +250 hp
 * instant; speed = +30% move 8 s; rage = +25% dmg 8 s. Kind selection uses the
 * sim RNG only (deterministic).
 */

import type { PickupState } from '../core/types';
import type { Fighter, Sim } from './Fighter';
import type { Rng } from '../core/math';
import { PICKUPS } from '../config/balance';
import { PICKUP_PADS } from '../config/arena';
import { addBuff } from './StatusEffects';

function chooseKind(rng: Rng): PickupState['kind'] {
  const r = rng();
  if (r < PICKUPS.weights.heal) return 'heal';
  if (r < PICKUPS.weights.heal + PICKUPS.weights.speed) return 'speed';
  return 'rage';
}

/** Build the 6 pad pickups, each with an initial randomly-weighted kind. */
export function createPickups(rng: Rng): PickupState[] {
  return PICKUP_PADS.map((p) => ({
    id: p.id,
    kind: chooseKind(rng),
    pos: { x: p.x, y: 0, z: p.z },
    active: true,
    respawnT: 0,
  }));
}

function grant(f: Fighter, kind: PickupState['kind']): void {
  switch (kind) {
    case 'heal':
      f.state.hp = Math.min(f.state.maxHp, f.state.hp + PICKUPS.healAmount);
      break;
    case 'speed':
      addBuff(f, 'speed', PICKUPS.speedBonus, PICKUPS.speedDur);
      break;
    case 'rage':
      addBuff(f, 'rage', PICKUPS.rageBonus, PICKUPS.rageDur);
      break;
  }
}

/** Per-tick pickup collection + respawn (§9). */
export function updatePickups(sim: Sim, pickups: PickupState[], dt: number): void {
  for (let i = 0; i < pickups.length; i++) {
    const p = pickups[i];
    if (!p.active) {
      p.respawnT -= dt;
      if (p.respawnT <= 0) {
        p.kind = chooseKind(sim.rng);
        p.active = true;
        p.respawnT = 0;
      }
      continue;
    }
    for (let j = 0; j < sim.fighters.length; j++) {
      const f = sim.fighters[j];
      if (!f.state.alive) continue;
      const dx = f.state.pos.x - p.pos.x;
      const dz = f.state.pos.z - p.pos.z;
      if (Math.sqrt(dx * dx + dz * dz) <= PICKUPS.radius + f.def.radius) {
        grant(f, p.kind);
        sim.emit({ type: 'pickup', fighterId: f.id, kind: p.kind, pos: { x: p.pos.x, y: p.pos.y, z: p.pos.z } });
        p.active = false;
        p.respawnT = PICKUPS.respawn;
        break;
      }
    }
  }
}
