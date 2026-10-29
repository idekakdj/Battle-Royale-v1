/**
 * v1.10.1 (WP-L2): shader warm-up orchestration with a fake renderer (no GL in node): it must compile for BOTH the canvas and the
 * post-processing render target, run one throwaway frame, wipe the canvas, restore the render target, build the lazily created
 * water FX, and never throw (a failure only costs the old first-frame hitch).
 */

import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { warmUpRenderer } from '../../src/render/warmup';
import type { SceneManager } from '../../src/render/SceneManager';
import type { QualityTier } from '../../src/render/quality';

interface Calls {
  log: string[];
}

function fakeManager(tier: QualityTier, calls: Calls, opts: { failRender?: boolean } = {}): SceneManager {
  let target: THREE.WebGLRenderTarget | null = null;
  const programs: unknown[] = [];
  const renderer = {
    info: { programs },
    getRenderTarget: () => target,
    setRenderTarget: (t: THREE.WebGLRenderTarget | null) => {
      calls.log.push(`target:${t === null ? 'canvas' : 'rt'}`);
      target = t;
    },
    compile: () => {
      calls.log.push(`compile@${target === null ? 'canvas' : 'rt'}`);
      programs.push({});
    },
    clear: () => calls.log.push('clear'),
  };
  return {
    renderer,
    scene: new THREE.Scene(),
    camera: new THREE.PerspectiveCamera(),
    getQualityTier: () => tier,
    render: () => {
      calls.log.push('render');
      if (opts.failRender === true) throw new Error('boom');
    },
  } as unknown as SceneManager;
}

describe('warmUpRenderer', () => {
  it('post-processing tiers: compiles for the canvas AND a render target, renders one throwaway frame, clears the canvas', () => {
    for (const tier of ['medium', 'high'] as const) {
      const calls: Calls = { log: [] };
      const report = warmUpRenderer(fakeManager(tier, calls), {});
      expect(report.ok).toBe(true);
      expect(calls.log).toEqual(['target:canvas', 'compile@canvas', 'target:rt', 'compile@rt', 'target:canvas', 'render', 'target:canvas', 'clear', 'target:canvas']);
      expect(report.programsAfter).toBeGreaterThan(report.programsBefore);
      expect(report.ms).toBeGreaterThanOrEqual(0);
    }
  });

  it('low tier (no composer): one compile for the canvas, no render-target variant', () => {
    const calls: Calls = { log: [] };
    warmUpRenderer(fakeManager('low', calls), {});
    expect(calls.log.filter((c) => c.startsWith('compile'))).toEqual(['compile@canvas']);
    expect(calls.log).toContain('render');
    expect(calls.log).toContain('clear');
  });

  it('builds the lazily created water FX first on maps with water', () => {
    const calls: Calls = { log: [] };
    let built = 0;
    warmUpRenderer(fakeManager('high', calls), { effects: { getWater: () => (built++, {}) as never }, water: true });
    expect(built).toBe(1);
    const noWater: Calls = { log: [] };
    warmUpRenderer(fakeManager('high', noWater), { effects: { getWater: () => (built++, {}) as never }, water: false });
    expect(built).toBe(1);
  });

  it('never throws: a failing throwaway frame is reported and the render target is still restored', () => {
    const calls: Calls = { log: [] };
    const report = warmUpRenderer(fakeManager('high', calls, { failRender: true }), {});
    expect(report.ok).toBe(false);
    expect(report.error).toBe('boom');
    expect(calls.log[calls.log.length - 1]).toBe('target:canvas');
  });
});
