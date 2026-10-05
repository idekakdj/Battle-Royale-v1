/**
 * Champions League — audio glue between the match and the shared {@link AudioEngine}: translates sim events and
 * snapshots into procedural cues (hit weight by damage, stone crack / crash / final-form rumble for the v1.6 stages, whoosh on moveStart, jump / land / dodge / ledge, armor
 * clink, KO boom + crowd swell, respawn chime, 3-2-1-FIGHT ticks) and runs the battle music loop (from FIGHT
 * until `stop()`). Safe before the AudioContext is running (the engine gates it; music starts on the first live
 * frame after the context resumes) and respects the master / music / sfx / mute settings via the engine's buses.
 */

import type { AudioEngine } from '../../audio/AudioEngine';
import type { BrawlEvent, BrawlSnapshot } from '../types';
import { countdownStep } from '../ui/hudMath';
import { BrawlMusic } from './BrawlMusic';
import { BrawlSfx } from './BrawlSfx';
import type { SynthCtx } from '../../audio/synth';

const PAN_RANGE_M = 22;
const CROWD_BASELINE = 0.12;

export class BrawlAudio {
  private sc: SynthCtx | null = null;
  private sfx: BrawlSfx | null = null;
  private music: BrawlMusic | null = null;
  private lastStep: 3 | 2 | 1 | 'FIGHT' | null | undefined = undefined;
  private fightSeen = false;
  private crowdOn = false;
  private stopped = false;
  private paused = false;
  /** Fighter x by id (from the latest snapshot), for panning. */
  private readonly xs: number[] = [];

  constructor(private readonly engine: AudioEngine) {}

  /** Match mounted: nothing audible yet (the countdown ticks and the music start from `update`). */
  start(): void {
    this.stopped = false;
  }

  setPaused(paused: boolean): void {
    this.paused = paused;
    this.music?.setPaused(paused);
  }

  /** Sim events of one step (called right after the step so cues line up with the action). */
  onEvents(events: readonly BrawlEvent[], cur: BrawlSnapshot): void {
    if (this.stopped || this.paused) return;
    this.rememberPositions(cur);
    const sfx = this.ensure();
    if (sfx === null) return;
    for (let i = 0; i < events.length; i++) {
      const e = events[i];
      switch (e.type) {
        case 'hit': {
          const pan = this.pan(e.pos.x);
          if (e.kbSpeed <= 0.01 && e.damage > 0) sfx.armorClink(pan);
          else sfx.hit(e.damage, e.kbSpeed, e.sweetspot, pan);
          break;
        }
        case 'moveStart':
          sfx.whoosh(e.moveId.startsWith('heavy'), e.air, this.pan(this.xs[e.fighterId] ?? 0));
          break;
        case 'jump':
          sfx.jump(e.air, this.pan(e.pos.x));
          break;
        case 'land':
          sfx.land(e.hard, this.pan(e.pos.x));
          break;
        case 'dodge':
          sfx.dodge(e.kind, this.pan(e.pos.x));
          break;
        case 'ledgeGrab':
          sfx.ledgeGrab(this.pan(e.pos.x));
          break;
        case 'ko':
          sfx.ko(e.side, this.pan(e.pos.x));
          this.engine.crowdCheer(true);
          this.engine.spikeExcitement(0.55);
          break;
        case 'respawn':
          sfx.respawn(this.pan(e.pos.x));
          break;
        case 'platformHit':
          sfx.stoneCrack(this.pan(e.pos.x));
          break;
        case 'platformBreak':
          sfx.stoneCrash(this.pan(e.pos.x));
          this.engine.spikeExcitement(0.3);
          break;
        case 'stageFinal':
          sfx.stageFinal();
          this.engine.spikeExcitement(0.7);
          this.engine.crowdCheer(true);
          break;
        case 'matchEnd':
          this.engine.matchEndSfx();
          break;
        default:
          break;
      }
    }
  }

  /** Per render frame: countdown ticks / FIGHT, music start + intensity. */
  update(cur: BrawlSnapshot): void {
    if (this.stopped) return;
    const sfx = this.ensure();
    if (sfx === null || this.sc === null) return;
    if (!this.crowdOn) {
      this.crowdOn = true;
      this.engine.startCrowd();
      this.engine.setExcitement(CROWD_BASELINE);
    }
    const step = cur.matchOver ? null : countdownStep(cur.countdown, cur.time);
    if (step !== this.lastStep) {
      const first = this.lastStep === undefined;
      this.lastStep = step;
      if (!this.paused) {
        if (step === 3 || step === 2 || step === 1) sfx.countdownTick();
        else if (step === 'FIGHT') {
          sfx.fight();
          this.fightSeen = true;
        }
      }
      // Joined mid-match (shortcut boot / context resumed late): treat the fight as already started.
      if (first && cur.countdown <= 0) this.fightSeen = true;
    }
    if (cur.countdown <= 0 && !cur.matchOver) this.fightSeen = true;
    if (this.fightSeen && !cur.matchOver) {
      if (this.music === null) this.music = new BrawlMusic(this.sc);
      if (!this.music.isRunning) this.music.start();
      this.music.setIntensity(this.heat(cur));
    }
    if (cur.matchOver && this.music?.isRunning === true) this.music.stop();
  }

  /** Stop the music loop and the crowd bed (idempotent). */
  stop(): void {
    if (this.stopped) return;
    this.stopped = true;
    this.music?.stop();
    this.music = null;
    if (this.crowdOn) this.engine.stopCrowd();
    this.crowdOn = false;
  }

  // ── internals ──────────────────────────────────────────────────────────────

  /** Lazily bind to the engine's synth graph once its context is running. */
  private ensure(): BrawlSfx | null {
    const sc = this.engine.synthContext();
    if (sc === null) return null;
    if (this.sc !== sc) {
      this.sc = sc;
      this.sfx = new BrawlSfx(sc);
      this.music?.stop();
      this.music = null;
    }
    return this.sfx;
  }

  private pan(x: number): number {
    return Math.max(-1, Math.min(1, x / PAN_RANGE_M));
  }

  private rememberPositions(cur: BrawlSnapshot): void {
    const f = cur.fighters;
    for (let i = 0; i < f.length; i++) this.xs[i] = f[i].pos.x;
  }

  /** 0..1 from how deep into their stocks the fighters are and how high the percents run. */
  private heat(cur: BrawlSnapshot): number {
    let maxPct = 0;
    let lowStocks = Infinity;
    for (const f of cur.fighters) {
      if (f.stocks <= 0) continue;
      maxPct = Math.max(maxPct, f.percent);
      lowStocks = Math.min(lowStocks, f.stocks);
    }
    const stockHeat = lowStocks === Infinity ? 0 : lowStocks <= 1 ? 0.5 : lowStocks === 2 ? 0.25 : 0.05;
    return Math.min(1, 0.3 + stockHeat + Math.min(0.3, maxPct / 500));
  }
}
