/**
 * v1.10.1 (WP-L2): host load shedding rule (30 Hz -> 20 Hz snapshots while the host's own frames are slow) - pure - and the
 * additive `BrNetHost.setSnapshotHz` it drives, checked through the real loopback netcode harness (the client must keep up with the
 * new spacing by MEASURING it).
 */

import { describe, expect, it } from 'vitest';
import {
  HostLoadShedder,
  NORMAL_SNAPSHOT_HZ,
  RESTORE_AFTER_S,
  SHED_AFTER_S,
  SHED_SNAPSHOT_HZ,
} from '../../src/match/loadShed';
import { runSession } from '../online/brNetHarness';

// Exact-in-floating-point frame times so each 1 s bucket closes on a known frame count.
const FAST = 1 / 64; // 15.6 ms
const SLOW = 1 / 16; // 62.5 ms (16 fps)
const MID = 1 / 32; // 31.25 ms (just above the 30 ms shed line)

function feed(s: HostLoadShedder, seconds: number, dtS: number): Array<number | null> {
  const out: Array<number | null> = [];
  const n = Math.round(seconds / dtS);
  for (let i = 0; i < n; i++) {
    const r = s.sample(dtS);
    if (r !== null) out.push(r);
  }
  return out;
}

describe('HostLoadShedder', () => {
  it('starts at the normal rate and stays there for a healthy host', () => {
    const s = new HostLoadShedder();
    expect(s.hz).toBe(NORMAL_SNAPSHOT_HZ);
    expect(feed(s, 60, FAST)).toEqual([]);
    expect(s.shedding).toBe(false);
  });

  it('sheds to 20 Hz after 2 s of frames averaging above 30 ms (once the warm-up has passed)', () => {
    const s = new HostLoadShedder();
    feed(s, 2, FAST); // warm-up buckets
    const changes = feed(s, SHED_AFTER_S, MID);
    expect(changes).toEqual([SHED_SNAPSHOT_HZ]);
    expect(s.hz).toBe(20);
    expect(s.shedding).toBe(true);
  });

  it('does not shed during the match start-up warm-up, nor for a single slow second', () => {
    const s = new HostLoadShedder();
    expect(feed(s, 2, SLOW)).toEqual([]); // two warm-up buckets: ignored
    expect(feed(s, 1, SLOW)).toEqual([]); // one slow bucket is not enough
    expect(feed(s, 1, FAST)).toEqual([]); // and a fast second clears the streak
    expect(feed(s, 1, SLOW)).toEqual([]);
    expect(s.hz).toBe(30);
  });

  it('restores 30 Hz only after a long comfortable stretch (hysteresis: no flapping around the threshold)', () => {
    const s = new HostLoadShedder();
    feed(s, 2, FAST);
    feed(s, 2, SLOW);
    expect(s.hz).toBe(20);
    // 25 ms frames: below the shed line (30) but not "comfortably fast" (22): stays shed
    expect(feed(s, 20, 1 / 40)).toEqual([]);
    expect(s.hz).toBe(20);
    s.reset(); // drop the partial bucket so the exact-frame phases below close on whole seconds
    // a stretch of fast frames shorter than the restore window does not restore...
    expect(feed(s, RESTORE_AFTER_S - 1, FAST)).toEqual([]);
    // ...a slow second in between restarts the count...
    feed(s, 1, SLOW);
    expect(feed(s, RESTORE_AFTER_S - 1, FAST)).toEqual([]);
    // ...and a full window restores it
    expect(feed(s, 2, FAST)).toEqual([NORMAL_SNAPSHOT_HZ]);
    expect(s.shedding).toBe(false);
  });

  it('ignores stalls (>= 0.5 s: alt-tab, debugger) - those are not sustained load', () => {
    const s = new HostLoadShedder();
    feed(s, 2, FAST);
    for (let i = 0; i < 50; i++) expect(s.sample(1.2)).toBeNull();
    expect(s.sample(0)).toBeNull();
    expect(s.sample(Number.NaN)).toBeNull();
    expect(s.hz).toBe(30);
  });

  it('can be configured (thresholds / rates) and reset', () => {
    const s = new HostLoadShedder({ shedAboveMs: 40, shedAfterS: 1, warmupBuckets: 0, shedHz: 15, normalHz: 30 });
    expect(feed(s, 1, MID)).toEqual([]); // 31 ms is under this host's 40 ms line
    expect(feed(s, 1, SLOW)).toEqual([15]);
    s.reset();
    expect(s.hz).toBe(15); // reset forgets streaks, not the current rate
  });
});

describe('BrNetHost.setSnapshotHz (the host API load shedding uses)', () => {
  it('rounds to whole sim ticks and clamps to 10..60 Hz', async () => {
    const s = await runSession({ seconds: 0.2, clients: 1 });
    expect(s.host.snapshotHz).toBeCloseTo(30, 5);
    s.host.setSnapshotHz(20);
    expect(s.host.snapshotHz).toBeCloseTo(20, 5);
    s.host.setSnapshotHz(1000);
    expect(s.host.snapshotHz).toBeCloseTo(60, 5);
    s.host.setSnapshotHz(1);
    expect(s.host.snapshotHz).toBeCloseTo(10, 5);
  });

  it('a mid-match 30 -> 20 Hz switch: the client MEASURES the new spacing, loses nothing and keeps rendering smoothly', async () => {
    const s = await runSession({
      seconds: 24,
      clients: 1,
      onTick: (tick, sess) => {
        if (tick === 60 * 8) sess.host.setSnapshotHz(20);
      },
    });
    const log = s.statsLog[0];
    const before = log[6]; // ~7 s: 30 Hz
    const after = log[log.length - 2]; // ~22 s: well after the switch
    expect(before.snapshotsPerSec).toBeGreaterThan(26);
    expect(after.snapshotsPerSec).toBeGreaterThan(17);
    expect(after.snapshotsPerSec).toBeLessThan(23);
    // the client derives its interval from the stream, not from an assumed 30 Hz
    expect(before.snapshotIntervalMs).toBeGreaterThan(30);
    expect(before.snapshotIntervalMs).toBeLessThan(37);
    expect(after.snapshotIntervalMs).toBeGreaterThan(46);
    expect(after.snapshotIntervalMs).toBeLessThan(54);
    // and the interpolation delay followed the wider spacing
    expect(after.interpDelayMs).toBeGreaterThan(before.interpDelayMs);
    // nothing broke: no event gaps, no hard resyncs, no bad packets
    const final = s.clients[0].stats();
    expect(final.eventGaps).toBe(0);
    expect(final.badPackets).toBe(0);
    expect(final.resyncs).toBe(0);
  });
});
