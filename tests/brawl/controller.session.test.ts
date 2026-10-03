import { describe, expect, it, vi } from 'vitest';
import { BrawlSession, SESSION_CELEBRATION_S } from '../../src/brawl/ui/BrawlSession';
import { BrawlWorld } from '../../src/brawl/sim/BrawlWorld';
import { idleIntent } from '../../src/brawl/types';
import type {
  BrawlBotApi,
  BrawlEvent,
  BrawlIntent,
  BrawlMatchConfig,
  BrawlSnapshot,
  BrawlWorldApi,
} from '../../src/brawl/types';

const DT = 1 / 60;

class FakeWorld implements BrawlWorldApi {
  readonly config = { stage: 'brokenColosseum', roster: [], difficulty: 1, stocks: 3, timeLimitS: 0 } as BrawlMatchConfig;
  steps = 0;
  over = false;
  intents: Array<[number, BrawlIntent]> = [];
  queued: BrawlEvent[] = [];
  /** Step number at which the match ends (0 = never). */
  endAt = 0;
  setIntent(id: number, intent: BrawlIntent): void {
    this.intents.push([id, { ...intent }]);
  }
  step(): void {
    if (this.over) return;
    this.steps++;
    if (this.endAt > 0 && this.steps >= this.endAt) {
      this.over = true;
      this.queued.push({ type: 'matchEnd', winnerId: 0 });
    }
  }
  snapshot(): BrawlSnapshot {
    return {
      frame: this.steps,
      time: this.steps / 60,
      countdown: 0,
      timeLeft: null,
      fighters: [],
      platforms: [],
      hitboxes: [],
      matchOver: this.over,
      winnerId: this.over ? 0 : -1,
    };
  }
  drainEvents(): BrawlEvent[] {
    const out = this.queued;
    this.queued = [];
    return out;
  }
}

function harness(opts: { endAt?: number; maxSteps?: number; celebrationS?: number } = {}) {
  const world = new FakeWorld();
  world.endAt = opts.endAt ?? 0;
  const renders: Array<{ prev: BrawlSnapshot; cur: BrawlSnapshot; alpha: number; events: readonly BrawlEvent[]; dt: number }> = [];
  const view = { render: vi.fn((prev, cur, alpha, events, dt) => renders.push({ prev, cur, alpha, events, dt })) };
  const input = { poll: vi.fn((): BrawlIntent => ({ ...idleIntent(), moveX: 1 })) };
  const seen: BrawlSnapshot[] = [];
  const bot: BrawlBotApi = { update: vi.fn((s: BrawlSnapshot): BrawlIntent => (seen.push(s), { ...idleIntent(), light: true })) };
  const onEvents = vi.fn();
  const onMatchOver = vi.fn();
  const onResults = vi.fn();
  const session = new BrawlSession({
    world,
    view,
    input,
    bots: [{ id: 1, bot }],
    onEvents,
    onMatchOver,
    onResults,
    celebrationS: opts.celebrationS,
    maxSteps: opts.maxSteps,
  });
  return { world, view, input, bot, seen, renders, session, onEvents, onMatchOver, onResults };
}

describe('BrawlSession fixed step', () => {
  it('runs exactly 60 steps for 60 frames at 60 Hz, one render per frame', () => {
    const h = harness();
    for (let i = 0; i < 60; i++) h.session.advance(DT);
    expect(h.world.steps).toBe(60);
    expect(h.renders).toHaveLength(60);
  });

  it('accumulates correctly at 120 Hz and 30 Hz and interpolates between the last two snapshots', () => {
    const fast = harness();
    for (let i = 0; i < 120; i++) fast.session.advance(1 / 120);
    expect(fast.world.steps).toBe(60);
    const alphas = fast.renders.map((r) => r.alpha);
    expect(alphas.every((a) => a >= 0 && a <= 1)).toBe(true);
    expect(alphas.some((a) => a > 0.3 && a < 0.7)).toBe(true);

    const slow = harness();
    for (let i = 0; i < 30; i++) slow.session.advance(1 / 30);
    expect(slow.world.steps).toBe(60);
    // prev and cur are consecutive sim frames
    const last = slow.renders[slow.renders.length - 1];
    expect(last.cur.frame - last.prev.frame).toBe(1);
  });

  it('a long stall is clamped (0.25 s) and capped at 5 catch-up steps: no spiral of death', () => {
    const h = harness();
    h.session.advance(10); // a tab that was hidden for 10 s
    expect(h.world.steps).toBe(5);
    h.session.advance(DT);
    expect(h.world.steps).toBe(6); // the backlog was dropped, normal pace resumes
    const small = harness({ maxSteps: 2 });
    small.session.advance(0.2);
    expect(small.world.steps).toBe(2);
  });

  it('ignores negative / NaN frame times', () => {
    const h = harness();
    h.session.advance(-1);
    h.session.advance(Number.NaN);
    expect(h.world.steps).toBe(0);
    expect(h.renders).toHaveLength(2);
  });

  it('polls the player once per step, feeds bots the latest snapshot, and sets intents for everyone', () => {
    const h = harness();
    for (let i = 0; i < 5; i++) h.session.advance(DT);
    expect(h.input.poll).toHaveBeenCalledTimes(5);
    expect(h.seen).toHaveLength(5);
    expect(h.seen.map((s) => s.frame)).toEqual([0, 1, 2, 3, 4]);
    const player = h.world.intents.filter(([id]) => id === 0);
    const bot = h.world.intents.filter(([id]) => id === 1);
    expect(player).toHaveLength(5);
    expect(bot).toHaveLength(5);
    expect(player[0][1].moveX).toBe(1);
    expect(bot[0][1].light).toBe(true);
  });

  it('events of the frame reach the view once and onEvents per step', () => {
    const h = harness();
    h.world.queued.push({ type: 'jump', fighterId: 0, air: false, pos: { x: 0, y: 0 } });
    h.session.advance(DT);
    expect(h.renders[0].events).toHaveLength(1);
    expect(h.onEvents).toHaveBeenCalledTimes(1);
    h.session.advance(DT);
    expect(h.renders[1].events).toHaveLength(0);
  });
});

describe('BrawlSession pause', () => {
  it('stops the sim, keeps rendering a static frame, and resumes without a catch-up burst', () => {
    const h = harness();
    for (let i = 0; i < 10; i++) h.session.advance(DT);
    h.session.setPaused(true);
    expect(h.session.isPaused).toBe(true);
    const before = h.world.steps;
    const polls = h.input.poll.mock.calls.length;
    for (let i = 0; i < 20; i++) h.session.advance(DT);
    expect(h.world.steps).toBe(before);
    expect(h.input.poll.mock.calls.length).toBe(polls);
    const r = h.renders[h.renders.length - 1];
    expect(r.prev).toBe(r.cur);
    expect(r.alpha).toBe(1);
    expect(r.events).toHaveLength(0);
    expect(r.dt).toBe(0);
    h.session.setPaused(false);
    h.session.advance(DT);
    expect(h.world.steps).toBe(before + 1);
  });
});

describe('BrawlSession match end', () => {
  it('fires onMatchOver once, then onResults exactly once after the celebration; stepping stops', () => {
    const h = harness({ endAt: 10, celebrationS: 1 });
    for (let i = 0; i < 10; i++) h.session.advance(DT);
    expect(h.session.matchOver).toBe(true);
    expect(h.onMatchOver).toHaveBeenCalledTimes(1);
    expect(h.onResults).not.toHaveBeenCalled();
    const steps = h.world.steps;
    for (let i = 0; i < 70; i++) h.session.advance(DT);
    expect(h.world.steps).toBe(steps);
    expect(h.onResults).toHaveBeenCalledTimes(1);
    expect(h.session.resultsDelivered).toBe(true);
    for (let i = 0; i < 200; i++) h.session.advance(DT);
    expect(h.onResults).toHaveBeenCalledTimes(1);
    expect(h.onMatchOver).toHaveBeenCalledTimes(1);
    expect(h.onResults.mock.calls[0][0].matchOver).toBe(true);
  });

  it('uses the default celebration length', () => {
    const h = harness({ endAt: 1 });
    h.session.advance(DT);
    for (let t = 0; t < SESSION_CELEBRATION_S - 0.2; t += DT) h.session.advance(DT);
    expect(h.onResults).not.toHaveBeenCalled();
    for (let t = 0; t < 0.5; t += DT) h.session.advance(DT);
    expect(h.onResults).toHaveBeenCalledTimes(1);
  });

  it('dispose is idempotent and silences the session', () => {
    const h = harness();
    h.session.advance(DT);
    h.session.dispose();
    h.session.dispose();
    const n = h.view.render.mock.calls.length;
    h.session.advance(DT);
    expect(h.view.render.mock.calls.length).toBe(n);
    expect(h.world.steps).toBe(1);
  });
});

describe('BrawlSession with the real BrawlWorld', () => {
  it('plays a short timed match to the end: the countdown, a time-up finish and one results callback', () => {
    const config: BrawlMatchConfig = {
      stage: 'brokenColosseum',
      roster: [
        { animal: 'lion', isPlayer: true },
        { animal: 'gorilla', isPlayer: false },
      ],
      difficulty: 1,
      stocks: 3,
      timeLimitS: 2,
    };
    const world = new BrawlWorld(config, 7);
    const render = vi.fn();
    const onResults = vi.fn();
    const onMatchOver = vi.fn();
    const events: BrawlEvent[] = [];
    const idleBot: BrawlBotApi = { update: () => idleIntent() };
    const session = new BrawlSession({
      world,
      view: { render },
      input: { poll: () => idleIntent() },
      bots: [{ id: 1, bot: idleBot }],
      onEvents: (e) => events.push(...e),
      onMatchOver,
      onResults,
      celebrationS: 0.5,
    });
    let sawCountdown = false;
    for (let f = 0; f < 60 * 8 && !session.resultsDelivered; f++) {
      session.advance(DT);
      if (session.snapshot.countdown > 0) sawCountdown = true;
    }
    expect(sawCountdown).toBe(true);
    expect(onMatchOver).toHaveBeenCalledTimes(1);
    expect(onResults).toHaveBeenCalledTimes(1);
    const final = onResults.mock.calls[0][0] as BrawlSnapshot;
    expect(final.matchOver).toBe(true);
    expect(final.timeLeft).toBe(0);
    expect(events.some((e) => e.type === 'matchEnd')).toBe(true);
    // the sim only advanced in whole frames: 180 countdown + 120 live
    expect(final.frame).toBe(300);
  });
});
