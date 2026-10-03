/**
 * Champions League camera (WP-R): framing, clamping, containment guarantee, KO pulse, shake scaling, projection.
 * Pure math (no WebGL).
 */

import { describe, expect, it } from 'vitest';
import { getStage } from '../../src/brawl/data';
import { BrawlCamera, CAM_FOV_DEG, CAM_PAD, makeCamTarget, type CamTarget } from '../../src/brawl/render/BrawlCamera';
import { mulberry32 } from '../../src/core/math';

function targets(n: number): CamTarget[] {
  return Array.from({ length: n }, () => makeCamTarget());
}

function set(t: CamTarget, x: number, y: number, vx = 0, vy = 0, alive = true): void {
  t.alive = alive;
  t.x = x;
  t.y = y;
  t.vx = vx;
  t.vy = vy;
}

function settle(cam: BrawlCamera, ts: CamTarget[], frames = 180): void {
  for (let i = 0; i < frames; i++) cam.update(1 / 60, ts, ts.length);
}

function inside(cam: BrawlCamera, t: CamTarget, margin = 0.5): boolean {
  const r = cam.visibleRect();
  return t.x >= r.l + margin && t.x <= r.r - margin && t.y >= r.b + margin && t.y + 1.2 <= r.t - margin * 0.2;
}

describe('BrawlCamera', () => {
  it('uses a ~28° perspective camera with a 4° downward pitch', () => {
    const cam = new BrawlCamera(getStage('brokenColosseum'));
    expect(CAM_FOV_DEG).toBe(28);
    expect(cam.camera.fov).toBe(28);
    cam.setAspect(16 / 9);
    cam.apply();
    const dir = cam.camera.getWorldDirection(new (cam.camera.position.constructor as new () => typeof cam.camera.position)());
    // Looks toward -z and slightly down (4°).
    expect(dir.z).toBeLessThan(-0.99);
    expect(Math.asin(-dir.y) * (180 / Math.PI)).toBeCloseTo(4, 0);
  });

  it('frames every alive fighter with padding, within the stage zoom clamp', () => {
    for (const id of ['brokenColosseum', 'skyAqueduct'] as const) {
      const st = getStage(id);
      const cam = new BrawlCamera(st);
      cam.setAspect(16 / 9);
      const ts = targets(2);
      set(ts[0], -9, 0);
      set(ts[1], 9, 4.2);
      settle(cam, ts);
      for (const t of ts) expect(inside(cam, t, CAM_PAD * 0.4)).toBe(true);
      expect(cam.halfW).toBeGreaterThanOrEqual(st.camera.minHalfW * 0.9 - 1e-6);
      expect(cam.halfW).toBeLessThanOrEqual(st.camera.maxHalfW + 1e-6);
    }
  });

  it('zooms in toward the minimum when fighters are close and out when they spread', () => {
    const st = getStage('brokenColosseum');
    const cam = new BrawlCamera(st);
    cam.setAspect(16 / 9);
    const ts = targets(2);
    set(ts[0], -1, 0);
    set(ts[1], 1, 0);
    settle(cam, ts, 240);
    const close = cam.halfW;
    set(ts[0], -12, 0);
    set(ts[1], 12, 0);
    settle(cam, ts, 240);
    expect(cam.halfW).toBeGreaterThan(close + 2);
  });

  it('never loses an in-play fighter (random launches, 4 fighters, several aspects)', () => {
    for (const id of ['brokenColosseum', 'skyAqueduct'] as const) {
      for (const aspect of [16 / 9, 4 / 3, 21 / 9]) {
        const st = getStage(id);
        const cam = new BrawlCamera(st);
        cam.setAspect(aspect);
        const rng = mulberry32(1234 + Math.floor(aspect * 100));
        const ts = targets(4);
        for (let i = 0; i < 4; i++) set(ts[i], st.spawns[i].x, st.spawns[i].y);
        cam.snap(ts, 4);
        let misses = 0;
        for (let f = 0; f < 900; f++) {
          for (let i = 0; i < 4; i++) {
            const t = ts[i];
            // random walk with occasional big launches, kept inside the playfield most of the time
            if (rng() < 0.02) {
              t.vx = (rng() - 0.5) * 70;
              t.vy = (rng() - 0.3) * 50;
            }
            t.vx *= 0.985;
            t.vy = t.vy * 0.985 - 0.5;
            t.x += t.vx / 60;
            t.y += t.vy / 60;
            // stay inside the in-play rectangle (the camera only promises on-stage fighters)
            const px = st.platforms.reduce((m, p) => Math.max(m, Math.abs(p.x0), Math.abs(p.x1)), 0) + 2.5;
            if (t.x < -px) t.vx = Math.abs(t.vx);
            if (t.x > px) t.vx = -Math.abs(t.vx);
            if (t.y < -3.5) t.vy = Math.abs(t.vy);
            if (t.y > cam.viewTop + 2.5) t.vy = -Math.abs(t.vy);
          }
          cam.update(1 / 60, ts, 4);
          for (let i = 0; i < 4; i++) if (!inside(cam, ts[i], 0.3)) misses++;
        }
        // Fighters exactly at the playfield rim are allowed to graze the edge, but there must be no systematic loss.
        expect(misses).toBeLessThan(10);
      }
    }
  });

  it('keeps an on-stage fighter in view when another is launched far away', () => {
    const st = getStage('brokenColosseum');
    const cam = new BrawlCamera(st);
    cam.setAspect(16 / 9);
    const ts = targets(2);
    set(ts[0], 2, 0);
    set(ts[1], 2, 0);
    settle(cam, ts);
    // Fighter 1 is blasted toward the right blast zone at 60 m/s.
    for (let f = 0; f < 120; f++) {
      ts[1].x = 2 + f * 0.5;
      ts[1].vx = 30;
      cam.update(1 / 60, ts, 2);
      expect(inside(cam, ts[0], 0.8)).toBe(true);
    }
  });

  it('ignores dead fighters and falls back to the stage focus', () => {
    const st = getStage('skyAqueduct');
    const cam = new BrawlCamera(st);
    cam.setAspect(16 / 9);
    const ts = targets(2);
    set(ts[0], 30, 30, 0, 0, false);
    set(ts[1], 30, 30, 0, 0, false);
    settle(cam, ts, 300);
    expect(Math.abs(cam.x - st.cameraFocus.x)).toBeLessThan(0.5);
    expect(Math.abs(cam.y - st.cameraFocus.y)).toBeLessThan(0.8);
  });

  it('KO pulse zooms in then relaxes; shake scales with launch speed and honours reduce-motion', () => {
    const st = getStage('brokenColosseum');
    const cam = new BrawlCamera(st);
    cam.setAspect(16 / 9);
    const ts = targets(2);
    set(ts[0], -4, 0);
    set(ts[1], 4, 0);
    settle(cam, ts, 240);
    const base = cam.halfW;
    cam.ko(20, 6);
    expect(cam.koPulse).toBe(1);
    let min = base;
    for (let f = 0; f < 30; f++) {
      cam.update(1 / 60, ts, 2);
      min = Math.min(min, cam.halfW);
    }
    expect(min).toBeLessThan(base - 0.2);
    settle(cam, ts, 400);
    expect(cam.koPulse).toBe(0);
    expect(Math.abs(cam.halfW - base)).toBeLessThan(0.4);

    const a = new BrawlCamera(st);
    const b = new BrawlCamera(st);
    a.hit(20);
    b.hit(60);
    expect(b.trauma).toBeGreaterThan(a.trauma);
    const c = new BrawlCamera(st);
    c.reduceMotion = true;
    c.hit(60);
    c.ko(0, 0);
    expect(c.trauma).toBe(0);
  });

  it('projects the focus point to the screen centre and reports on-screen', () => {
    const st = getStage('brokenColosseum');
    const cam = new BrawlCamera(st);
    cam.setAspect(16 / 9);
    const out = { x: 0, y: 0, onScreen: false };
    cam.project(cam.x, cam.y, 1280, 720, out);
    expect(out.x).toBeCloseTo(640, 0);
    expect(out.y).toBeCloseTo(360, 0);
    expect(out.onScreen).toBe(true);
    cam.project(cam.x + cam.halfW * 3, cam.y, 1280, 720, out);
    expect(out.onScreen).toBe(false);
    // Horizontal scale: the visible half-width maps to half the canvas width.
    cam.project(cam.x + cam.halfW, cam.y, 1280, 720, out);
    expect(out.x).toBeCloseTo(1280, -1);
  });
});
