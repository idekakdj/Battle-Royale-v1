import { describe, expect, it } from 'vitest';
import { ANIMAL_IDS } from '../../src/config/animals';
import { MSG, ONLINE_PROTOCOL_VERSION } from '../../src/online/types';
import type { Link } from '../../src/online/types';
import { OnlineRoom } from '../../src/online/room/OnlineRoom';
import { ROOM_CODE_ALPHABET } from '../../src/online/room/roomCode';
import { ROOM_LIMITS, RoomError, type RoomErrorCode } from '../../src/online/room/types';
import { frame, jsonPayload } from '../../src/online/wire';
import { Rig } from './roomHarness';

async function rejection(p: Promise<unknown>): Promise<RoomError> {
  try {
    await p;
  } catch (e) {
    expect(e).toBeInstanceOf(RoomError);
    return e as RoomError;
  }
  throw new Error('expected a rejection');
}

const codeOf = (e: RoomError): RoomErrorCode => e.code;

describe('OnlineRoom — creating and joining', () => {
  it('hosts a room with a valid 5-character code and the host as the only slot', async () => {
    const rig = new Rig();
    const host = await rig.host('Ann', 'rhino');
    const s = host.state;
    expect(s.code).toMatch(new RegExp(`^[${ROOM_CODE_ALPHABET}]{5}$`));
    expect(s.role).toBe('host');
    expect(s.phase).toBe('lobby');
    expect(s.mode).toBe('battleRoyale');
    expect(s.slots).toHaveLength(1);
    expect(s.slots[0]).toMatchObject({ kind: 'human', name: 'Ann', animal: 'rhino', isHost: true, isLocal: true, ready: true });
    expect(s.localPeerId).toBe(`gk1-${s.code}`);
    expect(s.canStart).toBe(false);
    expect(s.startBlockers).toEqual(['need-players']);
    expect(s.botFill).toBe(9);
  });

  it('lets friends join by code (case, spaces and invite links are normalised) and everyone sees the same roster', async () => {
    const rig = new Rig({ latencyMs: 20 });
    const host = await rig.host('Ann', 'lion');
    const bob = await rig.join(host.state.code.toLowerCase().split('').join(' '), 'Bob', 'eagle');
    const cat = await rig.join(`https://example.org/play/?join=${host.state.code}`, 'Cat', 'panther');
    await rig.run(200);
    for (const p of [host, bob, cat]) {
      expect(p.state.slots.map((s) => s.name)).toEqual(['Ann', 'Bob', 'Cat']);
      expect(p.state.slots.map((s) => s.animal)).toEqual(['lion', 'eagle', 'panther']);
      expect(p.state.code).toBe(host.state.code);
      expect(p.state.hostPeerId).toBe(host.state.localPeerId);
    }
    expect(bob.state.role).toBe('client');
    expect(bob.state.slots.filter((s) => s.isLocal).map((s) => s.name)).toEqual(['Bob']);
    expect(bob.state.canStart).toBe(false);
    expect(bob.state.startBlockers).toEqual(['not-host']);
    expect(cat.state.slots.map((s) => s.ready)).toEqual([true, false, false]);
  });

  it('rejects malformed codes and rooms nobody hosts', async () => {
    const rig = new Rig();
    expect(codeOf(await rejection(OnlineRoom.join('O0I1L', { name: 'x', transport: rig.net.createTransport() })))).toBe('bad-code');
    expect(codeOf(await rejection(rig.joinRoom('ABCDE', 'Bob')))).toBe('no-such-room');
  });

  it('gives a joiner a free fighter when their choice is taken, and fills the room to 4 humans then says full', async () => {
    const rig = new Rig();
    const host = await rig.host('Ann', 'lion');
    const code = host.state.code;
    const a = await rig.join(code, 'A', 'lion');
    const b = await rig.join(code, 'B', 'lion');
    const c = await rig.join(code, 'C', 'lion');
    await rig.run(100);
    const animals = host.state.slots.map((s) => s.animal);
    expect(new Set(animals).size).toBe(4);
    expect(a.state.slots.find((s) => s.isLocal)?.animal).not.toBe('lion');
    expect(codeOf(await rejection(rig.joinRoom(code, 'D')))).toBe('room-full');
    expect(host.state.slots).toHaveLength(ROOM_LIMITS.maxHumans);
    expect(b.state.slots).toHaveLength(4);
    expect(c.state.slots).toHaveLength(4);
  });

  it('sanitises names and keeps them unique', async () => {
    const rig = new Rig();
    const host = await rig.host('  Ann\u0007   the   Great and Terrible Lion  ', 'lion');
    expect(host.state.slots[0].name.length).toBeLessThanOrEqual(ROOM_LIMITS.maxNameLength);
    expect(host.state.slots[0].name).not.toMatch(/\u0007/);
    const h2 = await rig.host('Dup', 'lion');
    const a = await rig.join(h2.state.code, 'Dup', 'eagle');
    await rig.run(100);
    expect(h2.state.slots.map((s) => s.name)).toEqual(['Dup', 'Dup 2']);
    a.room.setName('Zed');
    await rig.run(100);
    expect(h2.state.slots.map((s) => s.name)).toEqual(['Dup', 'Zed']);
    h2.room.setName('Zed');
    await rig.run(100);
    expect(h2.state.slots.map((s) => s.name)).toEqual(['Zed 2', 'Zed']);
  });
});

describe('OnlineRoom — roster rules', () => {
  it('keeps fighters unique across humans, swaps with bots, and reports a denied pick', async () => {
    const rig = new Rig({ latencyMs: 10 });
    const { host, clients } = await rig.lobby(2);
    const [bob, cat] = clients; // eagle, gorilla; host lion
    expect(host.room.pickAnimal('eagle')).toBe(false);
    expect(host.errors.at(-1)?.code).toBe('animal-taken');
    bob.room.pickAnimal('gorilla');
    await rig.run(100);
    expect(bob.errors.at(-1)?.code).toBe('animal-taken');
    expect(bob.state.slots.find((s) => s.isLocal)?.animal).toBe('eagle');
    // a free fighter is fine
    cat.room.pickAnimal('mole');
    await rig.run(100);
    expect(host.state.slots.map((s) => s.animal)).toEqual(['lion', 'eagle', 'mole']);
    // a bot holding the wanted fighter swaps to the picker's old one
    expect(host.room.addBot('python')).toBe(true);
    expect(host.room.pickAnimal('python')).toBe(true);
    const bot = host.state.slots.find((s) => s.kind === 'bot');
    expect(bot?.animal).toBe('lion');
    expect(new Set(host.state.slots.map((s) => s.animal)).size).toBe(host.state.slots.length);
  });

  it('only the host controls mode, settings, bots and kicking; settings are validated', async () => {
    const rig = new Rig();
    const { host, clients } = await rig.lobby(1);
    const [bob] = clients;
    expect(bob.room.setMode('championsLeague')).toBe(false);
    expect(bob.errors.at(-1)?.code).toBe('not-host');
    expect(bob.room.addBot()).toBe(false);
    expect(bob.room.kick(host.state.localPeerId)).toBe(false);

    expect(host.room.setSettings({ br: { botLevel: 9 as never }, cl: { stocks: 99, timeLimitS: -4, stage: 'nope' as never } })).toBe(true);
    expect(host.state.settings.br.botLevel).toBe(4);
    expect(host.state.settings.cl.stocks).toBe(5);
    expect(host.state.settings.cl.timeLimitS).toBe(0);
    expect(host.state.settings.cl.stage).toBe('brokenColosseum');
    host.room.setSettings({ cl: { stage: 'skyAqueduct', stocks: 2, timeLimitS: 180 }, br: { botLevel: 3, fillBots: false } });
    await rig.run(100);
    expect(bob.state.settings).toEqual({ br: { botLevel: 3, fillBots: false, arena: 'colosseum' }, cl: { stage: 'skyAqueduct', stocks: 2, timeLimitS: 180 } });
    expect(bob.state.botFill).toBe(0);
  });

  it('Battle Royale bots: add/remove, capped at 10 fighters, none in Champions League', async () => {
    const rig = new Rig();
    const { host, clients } = await rig.lobby(1);
    expect(host.room.addBot()).toBe(true);
    expect(host.room.addBot()).toBe(true);
    await rig.run(50);
    expect(clients[0].state.slots.filter((s) => s.kind === 'bot')).toHaveLength(2);
    expect(host.state.botFill).toBe(10 - 2 - 2);
    const first = host.state.slots.find((s) => s.kind === 'bot');
    expect(host.room.removeBot(first?.id)).toBe(true);
    expect(host.state.slots.filter((s) => s.kind === 'bot')).toHaveLength(1);
    while (host.room.addBot()) {
      /* fill */
    }
    expect(host.state.slots).toHaveLength(10);
    expect(new Set(host.state.slots.map((s) => s.animal)).size).toBe(10);
    expect(host.room.addBot()).toBe(false);
    expect(host.state.botFill).toBe(0);
    // switching to Champions League clears the bots and refuses new ones
    host.room.setMode('championsLeague');
    expect(host.state.slots.every((s) => s.kind === 'human')).toBe(true);
    expect(host.room.addBot()).toBe(false);
    expect(host.errors.at(-1)?.code).toBe('wrong-phase');
    expect(host.state.botFill).toBe(0);
  });

  it('mode changes un-ready the clients', async () => {
    const rig = new Rig();
    const { host, clients } = await rig.lobby(2);
    clients.forEach((c) => c.room.setReady(true));
    await rig.run(100);
    expect(host.state.canStart).toBe(true);
    host.room.setMode('championsLeague');
    await rig.run(100);
    expect(host.state.canStart).toBe(false);
    expect(clients[0].state.slots.map((s) => s.ready)).toEqual([true, false, false]);
  });

  it('kick removes the player and tells them', async () => {
    const rig = new Rig({ latencyMs: 15 });
    const { host, clients } = await rig.lobby(2);
    const [bob, cat] = clients;
    expect(host.room.kick(host.state.localPeerId)).toBe(false);
    expect(host.room.kick(bob.state.localPeerId)).toBe(true);
    await rig.run(500);
    expect(bob.ended).toEqual([{ reason: 'kicked', message: expect.any(String) }]);
    expect(bob.state.phase).toBe('closed');
    expect(host.state.slots.map((s) => s.name)).toEqual(['Host', 'P2']);
    expect(cat.state.slots.map((s) => s.name)).toEqual(['Host', 'P2']);
    expect(cat.ended).toEqual([]);
  });
});

describe('OnlineRoom — leaving', () => {
  it('a client leaving updates the roster; the host leaving ends the room for everyone', async () => {
    const rig = new Rig({ latencyMs: 12 });
    const { host, clients } = await rig.lobby(2);
    const [bob, cat] = clients;
    bob.room.leave();
    expect(bob.state.phase).toBe('closed');
    expect(bob.ended).toEqual([]); // the leaver is not "ended on"
    await rig.run(300);
    expect(host.state.slots.map((s) => s.name)).toEqual(['Host', 'P2']);
    expect(cat.state.slots.map((s) => s.name)).toEqual(['Host', 'P2']);
    host.room.leave();
    await rig.run(500);
    expect(cat.ended.map((e) => e.reason)).toEqual(['host-left']);
    expect(cat.state.phase).toBe('closed');
    // idempotent
    host.room.leave();
    cat.room.leave();
  });

  it('a vanished host (transport dropped without a goodbye) ends the room through the link close', async () => {
    const rig = new Rig({ latencyMs: 12 });
    const hostTransport = rig.net.createTransport();
    const host = await rig.host('Ann', 'lion', { transport: hostTransport });
    const bob = await rig.join(host.state.code, 'Bob', 'eagle');
    await rig.run(100);
    hostTransport.dispose(); // crash: no LEAVE message
    await rig.run(100);
    expect(bob.ended.map((e) => e.reason)).toEqual(['host-left']);
    expect(bob.state.phase).toBe('closed');
  });

  it('a vanished client (no goodbye) disappears from the roster', async () => {
    const rig = new Rig({ latencyMs: 12 });
    const bobTransport = rig.net.createTransport();
    const host = await rig.host('Ann');
    await rig.join(host.state.code, 'Bob', 'eagle', { transport: bobTransport });
    await rig.run(100);
    expect(host.state.slots).toHaveLength(2);
    bobTransport.dispose();
    await rig.run(100);
    expect(host.state.slots).toHaveLength(1);
  });
});

describe('OnlineRoom — handshake validation', () => {
  it('rejects a different app version with both versions in the error', async () => {
    const rig = new Rig();
    const host = await rig.host('Ann');
    const err = await rejection(rig.joinRoom(host.state.code, 'Bob', 'eagle', { versions: { appVersion: '0.0.1' } }));
    expect(err.code).toBe('version-mismatch');
    expect(err.details?.mismatch).toContain('appVersion');
    expect(err.details?.host?.appVersion).toBe(host.state.versions.appVersion);
    expect(err.details?.host?.protocol).toBe(host.state.versions.protocol);
    expect(err.details?.local?.appVersion).toBe('0.0.1');
    expect(err.message).toContain('0.0.1');
    expect(err.message).toContain(host.state.versions.appVersion);
    await rig.run(500);
    expect(host.state.slots).toHaveLength(1); // nobody got in
  });

  it('accepts a different PATCH version (same major.minor): 1.5.0 and 1.5.3 play together', async () => {
    const rig = new Rig();
    const host = await rig.host('Ann', 'eagle', { versions: { appVersion: '1.5.0' } });
    const bob = await rig.join(host.state.code, 'Bob', 'lion', { versions: { appVersion: '1.5.3' } });
    await rig.run(300);
    expect(host.state.slots).toHaveLength(2);
    expect(bob.state.slots).toHaveLength(2);
    // each side keeps showing its own full version
    expect(host.state.versions.appVersion).toBe('1.5.0');
    expect(bob.state.versions.appVersion).toBe('1.5.3');
  });

  it('rejects a different MINOR (or major) version with both full versions in the error', async () => {
    const rig = new Rig();
    const host = await rig.host('Ann', 'eagle', { versions: { appVersion: '1.5.2' } });
    const minor = await rejection(rig.joinRoom(host.state.code, 'Bob', 'lion', { versions: { appVersion: '1.6.0' } }));
    expect(minor.code).toBe('version-mismatch');
    expect(minor.details?.mismatch).toEqual(['appVersion']);
    expect(minor.details?.host?.appVersion).toBe('1.5.2');
    expect(minor.details?.local?.appVersion).toBe('1.6.0');
    expect(minor.message).toContain('1.5.2');
    expect(minor.message).toContain('1.6.0');
    const major = await rejection(rig.joinRoom(host.state.code, 'Cy', 'lion', { versions: { appVersion: '2.5.2' } }));
    expect(major.details?.mismatch).toEqual(['appVersion']);
    await rig.run(500);
    expect(host.state.slots).toHaveLength(1);
  });

  it('rejects a different protocol even when the app version is identical, naming both versions', async () => {
    const rig = new Rig();
    const host = await rig.host('Ann', 'eagle', { versions: { appVersion: '1.5.0' } });
    const other = ONLINE_PROTOCOL_VERSION + 1; // (not a literal: the protocol version moves whenever a wire format changes)
    const err = await rejection(rig.joinRoom(host.state.code, 'Bob', 'lion', { versions: { appVersion: '1.5.0', protocol: other } }));
    expect(err.code).toBe('version-mismatch');
    expect(err.details?.mismatch).toEqual(['protocol']);
    expect(err.details?.host?.protocol).toBe(host.state.versions.protocol);
    expect(err.details?.local?.protocol).toBe(other);
    expect(err.message).toContain('1.5.0');
    expect(err.message).toContain(`protocol ${other}`);
  });

  it('rejects a different protocol or data fingerprint', async () => {
    const rig = new Rig();
    const host = await rig.host('Ann');
    const p = await rejection(rig.joinRoom(host.state.code, 'Bob', 'eagle', { versions: { protocol: 99 } }));
    expect(p.code).toBe('version-mismatch');
    expect(p.details?.mismatch).toEqual(['protocol']);
    const f = await rejection(
      rig.joinRoom(host.state.code, 'Bob', 'eagle', {
        versions: { fingerprints: { battleRoyale: host.state.versions.fingerprints.battleRoyale, championsLeague: 'deadbeef' } },
      }),
    );
    expect(f.details?.mismatch).toEqual(['fingerprint:championsLeague']);
    expect(f.details?.host?.fingerprints.championsLeague).toBe(host.state.versions.fingerprints.championsLeague);
    expect(host.state.slots).toHaveLength(1);
  });

  it('refuses newcomers while a match is starting or running', async () => {
    const rig = new Rig({ latencyMs: 5 });
    const { host, clients } = await rig.lobby(1);
    await rig.startAll(host, clients);
    expect(host.state.phase).toBe('inMatch');
    expect(codeOf(await rejection(rig.joinRoom(host.state.code, 'Late')))).toBe('room-busy');
  });

  it('drops garbage without crashing and times out a link that never says hello', async () => {
    const rig = new Rig();
    const host = await rig.host('Ann');
    // a stranger that connects and sends junk, never a HELLO
    const t = rig.net.createTransport();
    await t.open('stranger');
    let closed = false;
    t.setHandlers({ onLink: () => undefined, onData: () => undefined, onClose: () => (closed = true) });
    const link = (await t.connect(host.state.localPeerId)) as Link;
    link.send('reliable', new Uint8Array([MSG.ROOM_STATE, 1, 2, 3]));
    link.send('reliable', frame(MSG.READY, jsonPayload({ t: 'ready', ready: true })));
    link.send('reliable', new Uint8Array(0));
    link.send('unreliable', new Uint8Array([0xff, 0xff]));
    await rig.run(1000);
    expect(host.state.slots).toHaveLength(1);
    expect(closed).toBe(false);
    await rig.run(9000);
    expect(closed).toBe(true); // hello timeout
    expect(host.state.slots).toHaveLength(1);
  });
});

describe('OnlineRoom — heartbeat', () => {
  it('measures the round trip time and publishes it to everybody', async () => {
    const rig = new Rig({ latencyMs: 25 });
    const { host, clients } = await rig.lobby(2);
    await rig.run(3500);
    const hostView = host.state.slots;
    expect(hostView[0].pingMs).toBe(0);
    expect(hostView[1].pingMs).toBe(50);
    expect(hostView[2].pingMs).toBe(50);
    expect(clients[0].state.slots[1].pingMs).toBe(50);
    expect(clients[1].state.slots.find((s) => s.isLocal)?.pingMs).toBe(50);
  });

  it('drops a silent peer after 5 s (host side) and times out the host (client side)', async () => {
    const rig = new Rig({ latencyMs: 10 });
    const host = await rig.host('Host', 'lion', { silenceMs: 60000 });
    const bob = await rig.join(host.state.code, 'P1', 'eagle', { silenceMs: 5000 });
    const cat = await rig.join(host.state.code, 'P2', 'gorilla', { silenceMs: 5000 });
    await rig.run(200);
    expect(host.state.slots).toHaveLength(3);
    rig.net.setConditions({ loss: 1 }); // every heartbeat (unreliable) is lost; idle reliable traffic does not exist
    await rig.run(4200);
    expect(host.state.slots).toHaveLength(3);
    expect(bob.ended).toEqual([]);
    // 5 s of silence, noticed by the 1 Hz heartbeat tick (so within 6 s of the last packet). The first client to give up
    // makes the host publish a new roster (reliable), which counts as a sign of life for the other one — hence the longer wait.
    expect(await rig.waitFor(() => bob.ended.length > 0 && cat.ended.length > 0, 9000)).toBe(true);
    // the clients (default 5 s) gave up on the host first; the host forgot them as soon as their links closed
    expect(bob.ended.map((e) => e.reason)).toEqual(['timeout']);
    expect(cat.ended.map((e) => e.reason)).toEqual(['timeout']);
    expect(bob.state.phase).toBe('closed');
    await rig.run(100);
    expect(host.state.slots.map((s) => s.name)).toEqual(['Host']);
  });

  it('the host drops a silent peer after more than 5 s', async () => {
    const rig = new Rig({ latencyMs: 10 });
    const host = await rig.host('Host', 'lion', { silenceMs: 5000 });
    const bob = await rig.join(host.state.code, 'Bob', 'eagle', { silenceMs: 600000 });
    await rig.run(100);
    expect(host.state.slots).toHaveLength(2);
    rig.net.setConditions({ loss: 1 });
    await rig.run(4200);
    expect(host.state.slots).toHaveLength(2);
    await rig.run(3000);
    expect(host.state.slots.map((s) => s.name)).toEqual(['Host']);
    expect(bob.ended.map((e) => e.reason)).toEqual(['host-left']); // the host closed the link on its side
  });

  it('the default silence timeout tolerates a long page stall (slow first frame) but still drops a dead peer', async () => {
    const rig = new Rig({ latencyMs: 10 });
    const host = await rig.host('Host'); // default silenceMs (15 s)
    const bob = await rig.join(host.state.code, 'Bob', 'eagle', { silenceMs: 600000 });
    await rig.run(100);
    rig.net.setConditions({ loss: 1 });
    await rig.run(10000);
    expect(host.state.slots).toHaveLength(2); // 10 s of silence is survived
    await rig.run(7000);
    expect(host.state.slots.map((s) => s.name)).toEqual(['Host']); // 17 s is not
    expect(bob.ended.map((e) => e.reason)).toEqual(['host-left']);
  });

  it('survives realistic loss and jitter without false timeouts', async () => {
    const rig = new Rig({ latencyMs: 40, jitterMs: 40, loss: 0.2 }, 3);
    const { host, clients } = await rig.lobby(2);
    await rig.run(30000);
    expect(host.state.slots).toHaveLength(3);
    expect(clients.every((c) => c.ended.length === 0)).toBe(true);
  });
});

describe('OnlineRoom — start gating and room codes', () => {
  it('needs two humans, and every client ready', async () => {
    const rig = new Rig({ latencyMs: 8 });
    const host = await rig.host('Ann');
    expect(host.room.startMatch()).toEqual(['need-players']);
    const bob = await rig.join(host.state.code, 'Bob', 'eagle');
    await rig.run(100);
    expect(host.state.startBlockers).toEqual(['not-all-ready']);
    expect(host.room.startMatch()).toEqual(['not-all-ready']);
    expect(host.errors.at(-1)?.code).toBe('cannot-start');
    expect(bob.room.startMatch()).toEqual(['not-host']);
    bob.room.setReady(true);
    await rig.run(100);
    expect(host.state.canStart).toBe(true);
    bob.room.setReady(false);
    await rig.run(100);
    expect(host.state.canStart).toBe(false);
    bob.room.setReady(true);
    await rig.run(100);
    expect(host.room.startMatch()).toEqual([]);
    await rig.run(200);
    expect(host.starts).toHaveLength(1);
    expect(host.room.startMatch()).toEqual(['wrong-phase']);
  });

  it('retries with a fresh code when the room code is already taken, and gives up eventually', async () => {
    const rig = new Rig();
    const seq = [0, 0, 0, 0, 0, /* second code: */ 0.5, 0.5, 0.5, 0.5, 0.5];
    let i = 0;
    const rng = () => seq[i++ % seq.length];
    const a = await rig.host('A', 'lion', { rng });
    i = 0; // same random stream again → the first attempt collides with A's code
    const b = await rig.host('B', 'lion', { rng });
    expect(a.state.code).toBe('AAAAA');
    expect(b.state.code).not.toBe(a.state.code);
    expect(b.state.code).toMatch(/^.{5}$/);
    i = 0;
    const stuck = rig.until(OnlineRoom.host({ transport: rig.net.createTransport(), clock: rig.clock, name: 'C', rng: () => 0, codeAttempts: 3 }));
    expect(codeOf(await rejection(stuck))).toBe('signalling-failed');
  });
});

describe('OnlineRoom — Battle Royale start', () => {
  it('gives every machine the same OnlineStart (own localSlot), fills bots to 10 and keeps a star topology', async () => {
    const rig = new Rig({ latencyMs: 20 });
    const { host, clients } = await rig.lobby(2);
    await rig.startAll(host, clients);
    const all = [host, ...clients];
    const first = host.starts[0].start;
    expect(first.mode).toBe('battleRoyale');
    expect(first.slots).toHaveLength(10);
    expect(first.slots.map((s) => s.slot)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
    expect(first.slots.filter((s) => s.kind === 'human').map((s) => s.name).sort()).toEqual(['Host', 'P1', 'P2']);
    expect(first.slots.filter((s) => s.kind === 'bot')).toHaveLength(7);
    expect(new Set(first.slots.map((s) => s.animal))).toEqual(new Set(ANIMAL_IDS));
    expect(first.slots.every((s) => (s.kind === 'bot') === (s.peerId === null))).toBe(true);
    expect(first.br).toEqual({ difficulty: 2, arena: 'colosseum' });
    expect(first.cl).toBeUndefined();
    expect(first.slots[0].peerId).toBe(host.state.localPeerId); // host keeps slot 0
    for (const p of all) {
      expect(p.starts).toHaveLength(1);
      const { start } = p.starts[0];
      expect({ ...start, localSlot: 0 }).toEqual({ ...first, localSlot: 0 });
      expect(start.slots[start.localSlot].peerId).toBe(p.state.localPeerId);
      expect(start.hostPeerId).toBe(host.state.localPeerId);
      expect(p.state.phase).toBe('inMatch');
    }
    expect(new Set(all.map((p) => p.starts[0].start.localSlot)).size).toBe(3);
    // humans are spread around the ring, not clumped
    const humanSlots = first.slots.filter((s) => s.kind === 'human').map((s) => s.slot);
    expect(humanSlots).toEqual([0, 3, 6]);
    // star: the host talks to both, clients only to the host
    expect([...host.starts[0].channel.peers()].sort()).toEqual(clients.map((c) => c.state.localPeerId).sort());
    for (const c of clients) expect(c.starts[0].channel.peers()).toEqual([host.state.localPeerId]);
    // the channel works both ways
    const got: string[] = [];
    host.starts[0].channel.onMessage((peer, kind, payload) => got.push(`${peer}:${kind}:${payload[0]}`));
    clients[0].starts[0].channel.send(host.state.localPeerId, 'reliable', MSG.BR_INTENT, new Uint8Array([9]));
    await rig.run(100);
    expect(got).toEqual([`${clients[0].state.localPeerId}:${MSG.BR_INTENT}:9`]);
  });

  it('honours fillBots=false, hand-added bots and the bot level', async () => {
    const rig = new Rig();
    const { host, clients } = await rig.lobby(1, { settings: { br: { fillBots: false, botLevel: 4 } } });
    host.room.addBot('mole');
    host.room.addBot('python');
    await rig.startAll(host, clients);
    const s = host.starts[0].start;
    expect(s.slots).toHaveLength(4);
    expect(s.slots.filter((x) => x.kind === 'bot').map((x) => x.animal).sort()).toEqual(['mole', 'python']);
    expect(s.br).toEqual({ difficulty: 4, arena: 'colosseum' });
  });

  it('delivers game packets that overtake the go message to the session that subscribes in its start handler', async () => {
    const rig = new Rig({ latencyMs: 60 });
    const { host, clients } = await rig.lobby(1);
    const bob = clients[0];
    const received: number[] = [];
    bob.room.on('start', (_s, channel) => channel.onMessage((_p, kind, payload) => received.push(kind * 100 + payload[0])));
    host.room.on('start', (_s, channel) => {
      // From now on packets are instant while the (already scheduled) go message is still in flight.
      rig.net.setConditions({ latencyMs: 0 });
      channel.send(bob.state.localPeerId, 'unreliable', MSG.BR_SNAPSHOT, new Uint8Array([7]));
    });
    await rig.startAll(host, clients);
    await rig.run(300);
    expect(received).toEqual([MSG.BR_SNAPSHOT * 100 + 7]);
  });

  it('mid-match: a client leaving shows up as peer-left in the host channel and shrinks the roster', async () => {
    const rig = new Rig({ latencyMs: 10 });
    const { host, clients } = await rig.lobby(2);
    await rig.startAll(host, clients);
    const left: string[] = [];
    host.starts[0].channel.onPeerLeft((p, r) => left.push(`${p}:${r}`));
    const bobId = clients[0].state.localPeerId;
    clients[0].room.leave();
    await rig.run(500);
    expect(left).toHaveLength(1);
    expect(left[0].startsWith(bobId)).toBe(true);
    expect(host.state.slots.filter((s) => s.kind === 'human').map((s) => s.name)).toEqual(['Host', 'P2']);
    expect(host.state.phase).toBe('inMatch');
    expect(host.starts[0].channel.peers()).toEqual([clients[1].state.localPeerId]);
  });

  it('mid-match: the host leaving ends the room and fires peer-left for the clients', async () => {
    const rig = new Rig({ latencyMs: 10 });
    const { host, clients } = await rig.lobby(1);
    await rig.startAll(host, clients);
    const left: string[] = [];
    clients[0].starts[0].channel.onPeerLeft((p) => left.push(p));
    host.room.leave();
    await rig.run(500);
    expect(left).toEqual([host.state.localPeerId]);
    expect(clients[0].ended.map((e) => e.reason)).toEqual(['host-left']);
  });
});

describe('OnlineRoom — Champions League start', () => {
  it('forms a full mesh for 4 humans before anyone starts', async () => {
    const rig = new Rig({ latencyMs: 30, jitterMs: 10 });
    const { host, clients } = await rig.lobby(3, { mode: 'championsLeague', settings: { cl: { stage: 'skyAqueduct', stocks: 4, timeLimitS: 120 } } });
    await rig.startAll(host, clients);
    const all = [host, ...clients];
    const s0 = host.starts[0].start;
    expect(s0.mode).toBe('championsLeague');
    expect(s0.slots).toHaveLength(4);
    expect(s0.slots.every((s) => s.kind === 'human')).toBe(true);
    expect(s0.slots.map((s) => s.peerId)).toEqual(all.map((p) => p.state.localPeerId));
    expect(s0.cl).toEqual({ stage: 'skyAqueduct', stocks: 4, timeLimitS: 120, botLevel: 2 });
    expect(s0.br).toBeUndefined();
    for (const p of all) {
      const ch = p.starts[0].channel;
      const others = all.filter((q) => q !== p).map((q) => q.state.localPeerId);
      expect([...ch.peers()].sort()).toEqual(others.sort());
      expect(p.starts[0].start.seed).toBe(s0.seed);
      expect(p.starts[0].start.slots[p.starts[0].start.localSlot].peerId).toBe(p.state.localPeerId);
    }
    // a client-to-client message works, in both directions of the mesh
    const [a, b, c] = clients;
    const heard: string[] = [];
    c.starts[0].channel.onMessage((peer, kind) => heard.push(`${peer}:${kind}`));
    a.starts[0].channel.send(c.state.localPeerId, 'unreliable', MSG.CL_INPUTS, new Uint8Array([1]));
    b.starts[0].channel.send(c.state.localPeerId, 'reliable', MSG.CL_CHECKSUM, new Uint8Array([2]));
    await rig.run(200);
    expect(heard.sort()).toEqual([`${a.state.localPeerId}:${MSG.CL_INPUTS}`, `${b.state.localPeerId}:${MSG.CL_CHECKSUM}`].sort());
  });

  it('works for two players and survives heavy loss and jitter while linking', async () => {
    const rig = new Rig({ latencyMs: 80, jitterMs: 30, loss: 0.3 }, 11);
    const { host, clients } = await rig.lobby(1, { mode: 'championsLeague' });
    await rig.startAll(host, clients);
    expect(host.starts[0].channel.peers()).toEqual([clients[0].state.localPeerId]);
    expect(clients[0].starts[0].channel.peers()).toEqual([host.state.localPeerId]);
  });

  it('aborts back to the lobby when two clients cannot reach each other', async () => {
    const rig = new Rig({ latencyMs: 10 });
    const host = await rig.host('Host', 'lion', { mode: 'championsLeague' });
    const code = host.state.code;
    const bob = await rig.join(code, 'Bob', 'eagle');
    // Cat's transport cannot dial Bob (NAT stand-in): connects to anyone but the host fail
    const catTransport = rig.net.createTransport();
    const realConnect = catTransport.connect.bind(catTransport);
    catTransport.connect = async (peerId: string, timeoutMs?: number) => {
      if (!peerId.endsWith(code)) throw new Error('timeout');
      return realConnect(peerId, timeoutMs);
    };
    const cat = await rig.join(code, 'Cat', 'gorilla', { transport: catTransport });
    await rig.run(100);
    bob.room.setReady(true);
    cat.room.setReady(true);
    await rig.run(100);
    expect(host.room.startMatch()).toEqual([]);
    await rig.run(1000);
    expect(host.starts).toHaveLength(0);
    expect(host.state.phase).toBe('lobby');
    for (const p of [host, bob, cat]) expect(p.errors.some((e) => e.code === 'mesh-failed')).toBe(true);
    expect(bob.state.phase).toBe('lobby');
    expect(cat.state.phase).toBe('lobby');
    expect(bob.starts).toHaveLength(0);
    // the room is still usable: drop the unlucky player and start with two
    host.room.kick(cat.state.localPeerId);
    await rig.run(300);
    expect(host.room.startMatch()).toEqual([]);
    await rig.run(500);
    expect(host.starts).toHaveLength(1);
    expect(bob.starts).toHaveLength(1);
  });

  it('aborts the start when a player drops while linking', async () => {
    const rig = new Rig({ latencyMs: 50 });
    const { host, clients } = await rig.lobby(2, { mode: 'championsLeague' });
    clients.forEach((c) => c.room.setReady(true));
    await rig.run(300);
    expect(host.room.startMatch()).toEqual([]);
    await rig.run(60);
    clients[1].room.leave();
    await rig.run(1500);
    expect(host.starts).toHaveLength(0);
    expect(host.state.phase).toBe('lobby');
    expect(host.errors.some((e) => e.code === 'cannot-start')).toBe(true);
    expect(clients[0].state.phase).toBe('lobby');
    expect(host.state.slots).toHaveLength(2);
  });
});

describe('OnlineRoom — after the match', () => {
  it('backToRoom returns everyone to the lobby with ready flags cleared, and a second match works', async () => {
    const rig = new Rig({ latencyMs: 15 });
    const { host, clients } = await rig.lobby(2, { mode: 'championsLeague' });
    await rig.startAll(host, clients);
    expect(host.starts[0].channel.peers()).toHaveLength(2);
    const oldChannel = host.starts[0].channel;
    host.room.backToRoom();
    await rig.run(300);
    for (const p of [host, ...clients]) {
      expect(p.state.phase).toBe('lobby');
      expect(p.ended).toEqual([]);
    }
    expect(host.state.slots.map((s) => s.ready)).toEqual([true, false, false]);
    expect(host.state.canStart).toBe(false);
    // a retired channel is silent
    const heard: number[] = [];
    clients[0].room.on('state', () => undefined);
    oldChannel.send(clients[0].state.localPeerId, 'reliable', MSG.CL_CONTROL, new Uint8Array([1]));
    clients[0].starts[0].channel.onMessage((_p, k) => heard.push(k));
    await rig.run(100);
    expect(heard).toEqual([]);
    // idempotent, and a client's backToRoom in the lobby is a no-op
    host.room.backToRoom();
    clients[0].room.backToRoom();
    // rematch with a different mode
    host.room.setMode('battleRoyale');
    await rig.startAll(host, clients);
    expect(host.starts).toHaveLength(2);
    expect(host.starts[1].start.mode).toBe('battleRoyale');
    expect(clients[1].starts[1].start.slots).toHaveLength(10);
  });

  it('a client that returns early leaves the match (the host sees peer-left) but stays in the room', async () => {
    const rig = new Rig({ latencyMs: 15 });
    const { host, clients } = await rig.lobby(2);
    await rig.startAll(host, clients);
    const left: string[] = [];
    host.starts[0].channel.onPeerLeft((p, r) => left.push(`${p}:${r}`));
    clients[0].room.backToRoom();
    expect(clients[0].state.phase).toBe('lobby'); // immediately
    await rig.run(300);
    expect(left).toEqual([`${clients[0].state.localPeerId}:left-match`]);
    expect(host.state.phase).toBe('inMatch');
    expect(host.state.slots.filter((s) => s.kind === 'human')).toHaveLength(3);
    expect(clients[1].state.phase).toBe('inMatch');
    host.room.backToRoom();
    await rig.run(300);
    expect(clients.map((c) => c.state.phase)).toEqual(['lobby', 'lobby']);
    clients[0].room.setReady(true);
    clients[1].room.setReady(true);
    await rig.run(100);
    expect(host.state.canStart).toBe(true);
  });

  it('QA: a client that is back before the host shows "not ready" at once and a Ready pressed meanwhile is applied when the host returns', async () => {
    const rig = new Rig({ latencyMs: 15 });
    const { host, clients } = await rig.lobby(2);
    await rig.startAll(host, clients);
    clients[0].room.backToRoom();
    await rig.run(100);
    // the host would have ignored this READY (it is still in the match) and reset the flag anyway
    expect(clients[0].state.slots.find((s) => s.isLocal)?.ready).toBe(false);
    clients[0].room.setReady(true);
    expect(clients[0].state.slots.find((s) => s.isLocal)?.ready).toBe(true); // shown right away
    expect(host.state.phase).toBe('inMatch');
    host.room.backToRoom();
    await rig.run(300);
    // the host reset every flag; the early client's Ready was re-sent after the reset
    expect(host.state.slots.filter((s) => !s.isHost).map((s) => s.ready)).toEqual([true, false]);
    expect(clients[0].state.slots.find((s) => s.isLocal)?.ready).toBe(true);
    clients[1].room.setReady(true);
    await rig.run(100);
    expect(host.state.canStart).toBe(true);
    // a second pass: toggling back off while waiting is respected too
    await rig.startAll(host, clients);
    clients[1].room.backToRoom();
    clients[1].room.setReady(true);
    clients[1].room.setReady(false);
    host.room.backToRoom();
    await rig.run(300);
    expect(clients[1].state.slots.find((s) => s.isLocal)?.ready).toBe(false);
  });
});
