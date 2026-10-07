/**
 * Water FX tests (v1.8 WP-J3), node-safe: the pooled ripple field / droplet bursts / wake throttle / contact halos stay bounded,
 * scale with strength, and the live `Effects` implements the `FxSink.splash` / `FxSink.wake` hooks the swim animations call.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { JUNGLE_ARENA } from '../../src/config/arenas';
import {
  RIPPLE_CAPACITY,
  RippleField,
  SPLASH_MAX_DROPLETS,
  WATER_CONTACT_SLOTS,
  WaterFx,
  waterContacts,
  type WaterParticles,
} from '../../src/render/waterFx';
import { Effects } from '../../src/render/Effects';
import { setRenderArena, waterActivity } from '../../src/render/arenaContext';
import { setQualitySetting } from '../../src/render/quality';

class Sink implements WaterParticles {
  puffs = 0;
  sparks = 0;
  maxY = -Infinity;
  puff(_x: number, y: number): void {
    this.puffs++;
    this.maxY = Math.max(this.maxY, y);
  }
  spark(): void {
    this.sparks++;
  }
}

beforeEach(() => {
  setRenderArena(JUNGLE_ARENA);
  setQualitySetting('high');
});
afterEach(() => {
  setRenderArena();
  setQualitySetting('high');
});

describe('RippleField', () => {
  it('is one fixed-size instanced draw: spawning never grows it, live rings stay ≤ capacity and expire', () => {
    const rf = new RippleField();
    const geo = rf.mesh.geometry as THREE.InstancedBufferGeometry;
    expect(geo.instanceCount).toBe(RIPPLE_CAPACITY);
    for (let i = 0; i < 500; i++) rf.spawn(i * 0.01, 0, 1.5, 0.8, 0.5, 0.1, -0.04);
    rf.update(0.01);
    expect(rf.liveCount()).toBeLessThanOrEqual(RIPPLE_CAPACITY);
    expect(geo.instanceCount).toBe(RIPPLE_CAPACITY);
    rf.update(2);
    expect(rf.liveCount()).toBe(0);
    rf.dispose();
  });
});

describe('WaterFx', () => {
  it('splash: pooled droplets are bounded and scale with strength; rings spawn', () => {
    const sink = new Sink();
    const fx = new WaterFx(sink);
    fx.splash(0, 0, 1.2, 0.1);
    const weak = fx.lastDroplets;
    const weakPuffs = sink.puffs;
    fx.splash(0, 0, 3.5, 1);
    const strong = fx.lastDroplets;
    expect(strong).toBeGreaterThan(weak);
    expect(strong).toBeLessThanOrEqual(SPLASH_MAX_DROPLETS);
    expect(sink.puffs - weakPuffs).toBeLessThanOrEqual(SPLASH_MAX_DROPLETS + 6); // droplets + a few mist puffs
    fx.update(0.016);
    expect(fx.ripples.liveCount()).toBeGreaterThanOrEqual(3);
    // Droplets spawn at the water surface (just below the rim), never underground or flying.
    expect(sink.maxY).toBeLessThan(0.3);
    fx.dispose();
  });

  it('lower quality tiers spawn fewer droplets', () => {
    const sink = new Sink();
    const fx = new WaterFx(sink);
    fx.splash(0, 0, 2, 0.8);
    const high = fx.lastDroplets;
    setQualitySetting('low');
    fx.splash(0, 0, 2, 0.8);
    expect(fx.lastDroplets).toBeLessThan(high);
    fx.dispose();
  });

  it('handleSplashEvent maps the sim event to a splash; leaving is softer than entering', () => {
    const sink = new Sink();
    const fx = new WaterFx(sink);
    fx.handleSplashEvent({ type: 'splash', fighterId: 3, pos: { x: 1, y: 0, z: 2 }, entering: true, strength: 0.9 });
    const enter = fx.lastDroplets;
    fx.handleSplashEvent({ type: 'splash', fighterId: 3, pos: { x: 1, y: 0, z: 2 }, entering: false, strength: 0.9 });
    expect(fx.lastDroplets).toBeLessThanOrEqual(enter);
    fx.handleSplashEvent({ type: 'splash', fighterId: 3, pos: { x: 1, y: 0, z: 2 }, entering: true, strength: 5 }); // out-of-range strength is clamped
    expect(fx.lastDroplets).toBeLessThanOrEqual(SPLASH_MAX_DROPLETS);
    fx.dispose();
  });

  it('wake: throttled per source (a V of rings behind it), contact halo follows the rig and fades when it stops', () => {
    const sink = new Sink();
    const fx = new WaterFx(sink);
    const rig = new THREE.Object3D();
    rig.position.set(2, 0, 1);
    const scene = new THREE.Scene();
    scene.add(rig);
    for (let i = 0; i < 50; i++) fx.wake(rig, 2, 1, 4, 1);
    fx.update(0.001);
    expect(fx.ripples.spawned).toBeLessThanOrEqual(3); // one V per throttle window, however often it is called
    const c0 = waterContacts.filter((v) => v.w > 0).length;
    expect(c0).toBe(1);
    fx.update(0.5);
    for (let i = 0; i < 5; i++) fx.wake(rig, 2, 1, 4, 1);
    expect(fx.ripples.spawned).toBeGreaterThan(3);
    // Halo position tracks the rig between reports.
    rig.position.set(3, 0, 1.5);
    fx.update(0.016);
    const v = waterContacts.find((c) => c.w > 0)!;
    expect(v.x).toBeCloseTo(3, 5);
    expect(v.y).toBeCloseTo(1.5, 5);
    // No more reports: the halo fades out.
    for (let i = 0; i < 60; i++) fx.update(0.016);
    expect(waterContacts.filter((c) => c.w > 0.01).length).toBe(0);
    fx.dispose();
  });

  it('contact slots are bounded (many swimmers reuse the oldest) and the audio board never overflows', () => {
    const sink = new Sink();
    const fx = new WaterFx(sink);
    const scene = new THREE.Scene();
    const rigs: THREE.Object3D[] = [];
    for (let i = 0; i < 30; i++) {
      const r = new THREE.Object3D();
      r.position.set(i * 0.1, 0, 0);
      scene.add(r);
      rigs.push(r);
    }
    for (const r of rigs) {
      fx.wake(r, r.position.x, 0, 3, 1);
      fx.update(0.001);
    }
    expect(waterContacts.length).toBe(WATER_CONTACT_SLOTS);
    expect(waterContacts.filter((c) => c.w > 0).length).toBeLessThanOrEqual(WATER_CONTACT_SLOTS);
    fx.update(0.016);
    expect(waterActivity.count).toBeLessThanOrEqual(WATER_CONTACT_SLOTS);
    fx.dispose();
    expect(waterContacts.filter((c) => c.w > 0).length).toBe(0);
  });

  it('a stationary swimmer reports a halo but drops no wake rings', () => {
    const sink = new Sink();
    const fx = new WaterFx(sink);
    const rig = new THREE.Object3D();
    new THREE.Scene().add(rig);
    fx.wake(rig, 0, 0, 0.1, 1);
    expect(fx.ripples.spawned).toBe(0);
    expect(waterContacts.some((c) => c.w > 0)).toBe(true);
    fx.dispose();
  });
});

describe('Effects implements the water FxSink hooks', () => {
  it('splash / wake / handleSplashEvent exist on the live Effects (the swim rigs call them with optional chaining)', () => {
    expect(typeof Effects.prototype.splash).toBe('function');
    expect(typeof Effects.prototype.wake).toBe('function');
    expect(typeof Effects.prototype.handleSplashEvent).toBe('function');
    expect(typeof Effects.prototype.getWater).toBe('function');
  });
});
