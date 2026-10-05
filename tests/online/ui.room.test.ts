/**
 * The Online UI's view-model against REAL rooms on the in-memory loopback network (no mocks of the room layer).
 */
import { describe, expect, it } from 'vitest';
import { describeRoomError } from '../../src/online/ui/errors';
import { buildRoomView, describeStartBlockers, fighterAvailability } from '../../src/online/ui/viewModel';
import { parseJoinInput } from '../../src/online/ui/helpers';
import { Rig } from './roomHarness';

describe('room view-model on real rooms', () => {
  it('walks a host through waiting / ready / starting with the right texts', async () => {
    const rig = new Rig();
    const host = await rig.host('Ann', 'lion');
    expect(describeStartBlockers(host.state)).toEqual(['Need at least 2 players']);
    expect(buildRoomView(host.state).emptySlots).toBe(3);

    const bob = await rig.join(host.state.code, 'Bob', 'eagle');
    const cy = await rig.join(host.state.code, 'Cy', 'hippo');
    await rig.run(200);
    expect(describeStartBlockers(host.state)).toEqual(['Waiting for Bob and Cy to ready up']);
    expect(buildRoomView(host.state).canStart).toBe(false);

    bob.room.setReady(true);
    await rig.run(200);
    expect(describeStartBlockers(host.state)).toEqual(['Waiting for Cy to ready up']);
    cy.room.setReady(true);
    await rig.run(200);
    const vm = buildRoomView(host.state);
    expect(vm.canStart).toBe(true);
    expect(vm.blockers).toEqual([]);
    expect(vm.status).toMatch(/Press Start/);
    expect(vm.humans.filter((c) => c.ready)).toHaveLength(3);

    // the client sees the same roster and "waiting for the host"
    const cvm = buildRoomView(bob.state);
    expect(cvm.isHost).toBe(false);
    expect(cvm.status).toBe('Waiting for the host to start');
    expect(cvm.humans.map((c) => c.name)).toEqual(['Ann', 'Bob', 'Cy']);
    expect(cvm.local?.name).toBe('Bob');
  });

  it('marks the fighters taken by other humans and refuses a taken pick like the UI expects', async () => {
    const rig = new Rig();
    const host = await rig.host('Ann', 'lion');
    const bob = await rig.join(host.state.code, 'Bob', 'eagle');
    await rig.run(200);
    const av = fighterAvailability(bob.state);
    expect(av.find((a) => a.animal === 'lion')?.taken).toBe(true);
    expect(av.find((a) => a.animal === 'lion')?.takenBy).toBe('Ann');
    expect(av.find((a) => a.animal === 'eagle')?.mine).toBe(true);

    bob.room.pickAnimal('lion'); // the UI does not offer this, but the host still refuses
    await rig.run(300);
    expect(bob.errors.map((e) => e.code)).toContain('animal-taken');
    expect(describeRoomError(bob.errors[0]).title).toMatch(/taken/i);
    expect(fighterAvailability(bob.state).find((a) => a.animal === 'eagle')?.mine).toBe(true);
  });

  it('Battle Royale: bots appear as chips, counts include the fill', async () => {
    const rig = new Rig();
    const host = await rig.host('Ann', 'lion', { mode: 'battleRoyale' });
    await rig.join(host.state.code, 'Bob', 'eagle');
    await rig.run(200);
    host.room.addBot();
    host.room.addBot();
    await rig.run(100);
    const vm = buildRoomView(host.state);
    expect(vm.bots).toHaveLength(2);
    expect(vm.counts.humans).toBe(2);
    expect(vm.counts.bots).toBe(2);
    expect(vm.counts.total).toBe(10);
    expect(vm.bots.every((b) => b.canRemoveBot)).toBe(true);
    host.room.setMode('championsLeague'); // CL is humans only: the bots go away
    await rig.run(100);
    const cl = buildRoomView(host.state);
    expect(cl.bots).toHaveLength(0);
    expect(cl.counts.total).toBe(2);
    expect(cl.constraint).toMatch(/no bots/i);
  });

  it('turns real join failures into friendly text', async () => {
    const rig = new Rig();
    const host = await rig.host('Ann', 'lion');
    const bad = await rig.joinRoom('nope!', 'Bob').catch((e: unknown) => e);
    expect(describeRoomError(bad as { code: string }).title).toMatch(/not a room code/i);
    const missing = await rig.joinRoom('ZZZZZ', 'Bob').catch((e: unknown) => e);
    expect(describeRoomError(missing as { code: string }).title).toMatch(/not found/i);

    const mismatch = await rig
      .joinRoom(host.state.code, 'Bob', 'eagle', { versions: { appVersion: '0.0.1' } })
      .catch((e: unknown) => e);
    const t = describeRoomError(mismatch as { code: string; message: string; details?: never });
    expect(t.title).toMatch(/versions/i);
    expect(t.message).toMatch(/^The host runs v.+, you run v0\.0\.1\.$/);
    // pasting the invite link a friend would send works for joining too
    expect(parseJoinInput(`https://example.com/?join=${host.state.code}`)).toEqual({ kind: 'ok', code: host.state.code });
  });
});
