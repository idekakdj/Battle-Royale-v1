/**
 * Battle Royale online (WP-N3): codecs, host/client sessions, interpolation and the local-id swap.
 *
 * ── README for WP-N6 (BR net controller) ───────────────────────────────────────────────────────────────────────────────
 *
 * Architecture: host-authoritative star. The host machine runs the ONE `World` + `BotManager`; clients never simulate. Each
 * client sends its intent at 60 Hz (unreliable) and renders interpolated snapshots (~2 snapshot intervals behind).
 * `OnlineStart.slots[i]` ⇒ fighter id `i`; `slot.peerId` ⇒ which machine drives it.
 *
 * HOST (inside the controller's fixed 60 Hz sim step)
 *
 *   // World roster: isPlayer=false for every slot that may ever be bot-driven (BotManager only builds brains for
 *   // isPlayer=false entries, at its first update) — i.e. all REMOTE humans and bots. Only the host's own seat is isPlayer=true.
 *   const host = new BrNetHost({ channel, start, snapshotHz: 30 });        // snapshotHz ∈ {20,30,60}; default 30
 *   host.onPeerLeft((slot, reason) => { … });                              // optional: toast "X left – bot takes over"
 *
 *   // each tick, BEFORE world.step (the controller keeps its existing order: local intent → bots → step):
 *   bots.update(this.snap, dt);
 *   for (let id = 0; id < n; id++) {
 *     if (id === hostSlot) world.setIntent(id, localPlayerIntent);
 *     else world.setIntent(id, host.remoteIntent(id) ?? bots.getIntent(id)); // null ⇒ bot / left player
 *   }
 *   const events: GameEvent[] = [];                                         // collected via bus.onAny during THIS step
 *   world.step(dt);
 *   this.snap = world.snapshot();
 *   host.afterStep(this.snap, events);                                      // sends snapshots (30 Hz), events, results
 *
 *   • `remoteIntent(slot)` consumes queued attack/special/ultimate edges: call it EXACTLY ONCE per slot per tick. The object it
 *     returns is reused by the next call (World.setIntent copies it — do not keep it).
 *   • `afterStep` every tick (60 Hz), even when `events` is empty. When `snapshot.matchOver` first appears it sends a final
 *     keyframe + the reliable BR_RESULTS (placements from `death` events); `host.results()` returns the same object for the
 *     host's own results screen. Afterwards the final snapshot is repeated 8× (100 ms apart), then silence.
 *   • Stats for a debug HUD: `host.clientStats(slot)` / `host.allStats()` (rtt, bytes, kB/s, snapshots, acks, edge counters).
 *   • `host.dispose()` when the match screen unmounts. If the host's own slot is not 0, the controller must apply
 *     `swapIds(snapshot, 0, hostSlot)` / `swapEventIds(e, 0, hostSlot)` to what it feeds its HUD/renderer (and swap intents back).
 *
 * CLIENT (the controller's `world` is replaced by this; no World, no BotManager, no sim step)
 *
 *   const net = new BrNetClient({ channel, start });                        // start.localSlot = this machine's fighter id
 *   net.onResults((r) => …);  net.onHostLeft((reason) => …);                // host left ⇒ end the match ("host left")
 *
 *   // each client sim tick (60 Hz): read input exactly like the local match does, then
 *   net.sendIntent(input.getIntent(cameraYaw));                             // lock-on/aim-assist modifies the intent first
 *
 *   // each render frame:
 *   const s = net.sample();                                                 // null until the first keyframe arrives (< 0.3 s)
 *   if (s) {
 *     const m = swapSample(s, 0, net.localSlot);                            // local player becomes fighter 0 for MatchController
 *     // m.view   : WorldSnapshot to DRAW and to feed HUD/overlay/bots-free logic (interpolated, discrete fields from the earlier snap)
 *     // m.prev/m.cur/m.alpha : the same as a lerp pair if the existing posPrev/posCurr path is reused (blink-safe)
 *     // m.events : GameEvents now due (already de-duplicated, in order) → feed the SAME handlers the local bus drives
 *     //            (audio.attachBus equivalent, Effects, HUD kill-feed, UltFx …). Timestamped to render time, so sounds/VFX
 *     //            line up with the interpolated state. `blink` events arrive here too: snap that rig (the view already
 *     //            does not slide it).
 *     // m.starved / m.extrapolatedMs / m.finished : diagnostics; `finished` ⇒ the final matchOver snapshot is on screen.
 *   }
 *   net.stats()   // pingMs, jitterMs, bufferDepthMs, loss, kBpsIn/Out, interpDelayMs, … for the netcode HUD
 *   net.latest()  // newest raw (un-interpolated, un-swapped) snapshot, for e.g. the results screen
 *   net.dispose()
 *
 *   • Ids: the whole BR MatchController assumes the local player is fighter 0 ⇒ ALWAYS pass samples through
 *     `swapSample(s, 0, net.localSlot)` (= `swapIds` on prev/cur/view + `swapEventIds` on events). Results messages:
 *     `swapResults(r, 0, localSlot)`. Everything id-carrying is remapped; nothing else is touched; swapping twice restores.
 *   • The client has no input prediction: its own actions show ≈ RTT + interpolation delay later (documented limit).
 *   • `view.time` is HOST sim time (negative during the 3-2-1 countdown, exactly like the local `snapshot.time`).
 *   • Fighters' `isPlayer` come from the host's roster; the client should mark "you" by id (0 after the swap), not by that flag.
 *
 * WIRE FACTS (for QA): kinds BR_INTENT (12 B, 60 Hz), BR_SNAPSHOT (avg ≈ 320 B, max ≈ 700 B for 10 fighters incl. keyframes and
 * the 4-byte wrapper), BR_EVENTS (reliable, seq-numbered, deduplicated), BR_RESULTS (reliable), BR_SYNC (500 ms ping/pong).
 * Any change to a wire format ⇒ bump ONLINE_PROTOCOL_VERSION in ../types.ts (the room handshake enforces equality).
 */
export * from './tables';
export * from './snapshotCodec';
export * from './eventCodec';
export * from './intentCodec';
export * from './miscCodec';
export * from './idSwap';
export * from './interp';
export { BrNetHost, type BrNetHostOptions, type BrHostClientStats } from './BrNetHost';
export { BrNetClient, swapSample, type BrNetClientOptions, type BrSample, type BrClientStats } from './BrNetClient';
