/**
 * v1.3 WP-T: ultimate FX infrastructure — indicator pool bookkeeping and the
 * auto-discovery registries (no WebGL needed: only scene-graph objects + shader
 * materials are constructed).
 */

import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { UltIndicators } from '../../src/render/ultFx/primitives';
import { registeredUltFxAnimals } from '../../src/render/ultFx';
import { registeredUltAudioAnimals } from '../../src/audio/ults';
import { ANIMAL_IDS } from '../../src/config/animals';

describe('UltIndicators pools', () => {
  it('reserves, shows, fades and releases handles; steals the oldest when a pool runs dry', () => {
    const scene = new THREE.Scene();
    const ind = new UltIndicators(scene);
    expect(ind.activeCount).toBe(0);

    const ring = ind.ring(3);
    ring.show(0, 0, 0, 5, 0.1, 'friendly');
    const ribbon = ind.ribbon(3);
    ribbon.show(0, 0, 0, 0, 0, 8, 1.6, 'hostile');
    const ret = ind.reticle(4);
    ret.show(1, 0, 1, 1.5, 'lock');
    const arc = ind.arc(4);
    arc.show(0, 1, 0, 6, 1, 6, 2, 0.26, 'hostile');
    const zone = ind.zone(5);
    zone.show(2, 0, 2, 4, 'hostile');
    expect(ind.activeCount).toBe(5);
    expect(ring.held(3)).toBe(true);
    expect(ring.held(4)).toBe(false);

    // Owner release fades (still active until the fade completes), then frees.
    ind.releaseOwner(3, 0.1);
    for (let i = 0; i < 60; i++) ind.update(1 / 60);
    expect(ring.active).toBe(false);
    expect(ribbon.active).toBe(false);
    expect(ret.active).toBe(true);
    expect(ind.activeCount).toBe(3);

    // Exhaust the ring pool: the oldest reservation is stolen (by another owner), never an error.
    const first = ind.ring(9);
    first.show(0, 0, 0, 2);
    for (let i = 0; i < 12; i++) ind.ring(10).show(0, 0, 0, 2);
    expect(first.held(9)).toBe(false);

    ind.hideAll(0);
    expect(ind.activeCount).toBe(0);
    ind.dispose();
  });
});

describe('ult registries', () => {
  it('only register modules named after an animal id', () => {
    for (const a of registeredUltFxAnimals()) expect(ANIMAL_IDS).toContain(a);
    for (const a of registeredUltAudioAnimals()) expect(ANIMAL_IDS).toContain(a);
  });
});
