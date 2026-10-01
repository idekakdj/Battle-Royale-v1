/**
 * Ultimate audio registry (v1.3 WP-T).
 *
 * Auto-discovers `src/audio/ults/<animal>.ts` modules with `import.meta.glob`
 * (eager); a module DEFAULT-exports a plain {@link UltAudio} object. Files that
 * start with `_` (see `_example.ts`), `index.ts`, and any file whose name is not
 * an animal id are ignored — adding an animal's ult sounds never edits a shared
 * file.
 *
 * The {@link AudioEngine} wires the events (`ultimateTarget` / `ultimateStage` /
 * `blink` / `projectileImpact`, and `ultEnd()` from the match's ult tracker) into
 * {@link UltAudioRegistry}, which forwards them to the module of the casting
 * animal with an {@link UltAudioApi} (context, distance attenuation, and the
 * synth helpers every existing sound is built from). Hooks only run while the
 * AudioContext is running; existing ultimate sounds (`ultStinger`, roar) are
 * untouched — modules ADD to them.
 *
 * Recipe (one `<animal>.ts`): build voices with `a.sc.voices.create(a.now)`,
 * envelope with `a.synth.shapeEnv`, scale loudness with `a.gainAt(ev.pos)` and
 * keep every envelope click-free (start/end at `EPS`).
 */

import { ANIMAL_IDS } from '../../config/animals';
import type { AnimalId, GameEventOf, Vec3 } from '../../core/types';
import { EPS, filter, makeLFO, noiseSource, osc, shapeEnv, type SynthCtx } from '../synth';

/** Synth building blocks re-exported for modules (same helpers `sfx.ts` uses). */
export const synth = { EPS, shapeEnv, noiseSource, filter, osc, makeLFO } as const;

export interface UltAudioApi {
  readonly sc: SynthCtx;
  /** `sc.ctx.currentTime`. */
  readonly now: number;
  /** 0..1 distance attenuation for a sound at `pos` relative to the listener. */
  gainAt(pos: Vec3): number;
  /** True when `fighterId` is the fighter the "ears" follow (the player / spectated fighter). */
  isListener(fighterId: number): boolean;
  readonly synth: typeof synth;
}

export interface UltAudio {
  onTarget?(a: UltAudioApi, ev: GameEventOf<'ultimateTarget'>): void;
  onStage?(a: UltAudioApi, ev: GameEventOf<'ultimateStage'>): void;
  onBlink?(a: UltAudioApi, ev: GameEventOf<'blink'>): void;
  /** A projectile owned by a fighter of this animal landed. */
  onImpact?(a: UltAudioApi, ev: GameEventOf<'projectileImpact'>): void;
  /** This fighter's ultimate ended (or it died). */
  onEnd?(a: UltAudioApi, fighterId: number): void;
  dispose?(): void;
}

const found = import.meta.glob<{ default?: UltAudio }>(['./*.ts', '!./index.ts', '!./_*.ts'], { eager: true });

function animalOfPath(path: string): AnimalId | null {
  const m = /([^/]+)\.ts$/.exec(path);
  if (m === null) return null;
  return (ANIMAL_IDS as readonly string[]).includes(m[1]) ? (m[1] as AnimalId) : null;
}

const modules: Partial<Record<AnimalId, UltAudio>> = {};
for (const path of Object.keys(found)) {
  const animal = animalOfPath(path);
  const def = found[path].default;
  if (animal !== null && def !== undefined) modules[animal] = def;
}

/** Animals that ship their own ultimate audio module (debug / tests). */
export function registeredUltAudioAnimals(): AnimalId[] {
  return (Object.keys(modules) as AnimalId[]).sort();
}

const _warned = new Set<string>();

function safe(label: string, fn: () => void): void {
  try {
    fn();
  } catch (err) {
    if (!_warned.has(label)) {
      _warned.add(label);
      console.error(`[ultAudio] ${label} threw`, err);
    }
  }
}

export class UltAudioRegistry {
  /** fighter id → animal of the last ultimate that fighter started (events without an animal field use this). */
  private readonly casters = new Map<number, AnimalId>();

  noteCaster(fighterId: number, animal: AnimalId): void {
    this.casters.set(fighterId, animal);
  }

  target(a: UltAudioApi, ev: GameEventOf<'ultimateTarget'>): void {
    const m = modules[ev.animal];
    if (m?.onTarget !== undefined) safe(`${ev.animal}.onTarget`, () => m.onTarget?.(a, ev));
  }

  stage(a: UltAudioApi, ev: GameEventOf<'ultimateStage'>): void {
    const m = modules[ev.animal];
    if (m?.onStage !== undefined) safe(`${ev.animal}.onStage`, () => m.onStage?.(a, ev));
  }

  blink(a: UltAudioApi, ev: GameEventOf<'blink'>): void {
    const an = this.casters.get(ev.fighterId);
    const m = an === undefined ? undefined : modules[an];
    if (m?.onBlink !== undefined) safe(`${an}.onBlink`, () => m.onBlink?.(a, ev));
  }

  impact(a: UltAudioApi, ev: GameEventOf<'projectileImpact'>): void {
    const an = this.casters.get(ev.ownerId);
    const m = an === undefined ? undefined : modules[an];
    if (m?.onImpact !== undefined) safe(`${an}.onImpact`, () => m.onImpact?.(a, ev));
  }

  end(a: UltAudioApi, fighterId: number): void {
    const an = this.casters.get(fighterId);
    const m = an === undefined ? undefined : modules[an];
    if (m?.onEnd !== undefined) safe(`${an}.onEnd`, () => m.onEnd?.(a, fighterId));
  }

  dispose(): void {
    this.casters.clear();
    for (const m of Object.values(modules)) if (m?.dispose !== undefined) safe('dispose', () => m.dispose?.());
  }
}

/**
 * Short dry "click" for an ultimate pressed with no valid target (nothing spent):
 * a 4 ms high-passed noise tick + a tiny low knock. Click-free, very quiet tail.
 */
export function playDryClick(sc: SynthCtx, gain = 1): void {
  const t0 = sc.ctx.currentTime;
  const v = sc.voices.create(t0);
  v.gain.gain.value = Math.max(EPS, 0.9 * gain);
  const n = noiseSource(sc);
  const hp = filter(sc.ctx, 'highpass', 2400, 0.9);
  const ng = sc.ctx.createGain();
  ng.gain.value = EPS;
  const nEnd = shapeEnv(ng.gain, t0, 0.42, 0.001, 0.004, 0.035);
  n.connect(hp);
  hp.connect(ng);
  ng.connect(v.gain);
  n.start(t0);
  n.stop(nEnd + 0.02);
  sc.voices.add(v, n);

  const o = osc(sc.ctx, 'triangle', 190);
  o.frequency.setValueAtTime(190, t0);
  o.frequency.exponentialRampToValueAtTime(90, t0 + 0.06);
  const og = sc.ctx.createGain();
  og.gain.value = EPS;
  const oEnd = shapeEnv(og.gain, t0, 0.3, 0.002, 0.01, 0.06);
  o.connect(og);
  og.connect(v.gain);
  o.start(t0);
  o.stop(oEnd + 0.02);
  sc.voices.add(v, o, true);
}
