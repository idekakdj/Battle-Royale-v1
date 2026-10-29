# Online play with friends (v1.5) - notes

Friends-only online multiplayer for both modes (Champions League and Battle Royale), no server of ours: the free PeerJS cloud
brokers the WebRTC connections, game traffic then flows peer to peer. Binding design: `docs/ONLINE-PLAN.md`.

## How to play

**Host**
1. Lobby -> **Online**. Type your name (it is remembered).
2. Pick the mode (Champions League: 2-4 humans, no bots / Battle Royale: 2-4 humans + bots up to 10 fighters) -> **Create room**.
3. You get a 5-character room code and an invite link. **Copy code** / **Copy link** and send it to your friends.
4. Set the rules in the room (CL: stage, stocks, time limit / BR: bot level, add or remove bots). Everyone needs a different fighter.
5. When every friend shows a green **Ready** tick, press **Start**. After a match everybody lands back in the room; press Start again.

**Friends**
1. Open the invite link (`.../?join=K7P4Q`) - or Lobby -> **Online** -> **Join a room** -> type the code or paste the link.
2. Pick a name (first time only) and a fighter, press **Ready**.

**Leaving.** Esc during a match opens a menu (the match keeps running - there is no pause online) with *Leave match*. A friend leaving
a Champions League match forfeits (the others play on); in Battle Royale their fighter becomes a bot. If the host leaves the *match*
everybody goes back to the room; if the host closes the game the room ends ("The host left the room").

## What everybody needs

* **A compatible version** of the game (the lobby footer shows it, e.g. `v1.5.0`). Compatible means the same online protocol, the same
  data fingerprint **and the same app major.minor**: `1.5.0` and `1.5.2` play together, `1.5.x` and `1.6.0` do not. An incompatible
  version is refused with both full versions named. The web build and the Windows installer interoperate as long as they are compatible.
  * **Rule for releases:** PATCH releases (`1.5.1`, `1.5.2`, ...) must not change simulation or netcode behaviour (anything the
    rollback sim, the Battle Royale host/client code or the wire formats read or do). Menu / UI / visual-only changes are fine. Bump
    **MINOR** whenever a release changes sim or netcode behaviour; bump `ONLINE_PROTOCOL_VERSION` when a wire format changes. The data
    fingerprint (`src/online/room/fingerprint.ts`) catches changed tuning numbers but cannot catch changed sim/netcode *code*, so this
    discipline is what keeps two patch versions in sync.
* An internet connection that can reach the free matchmaking service `0.peerjs.com` (WebSocket over 443) and Google STUN (UDP 19302).
  Some school/work networks block it.
* The host is the only one who must be reachable "enough": see strict-NAT notes below.

## Wire format history (Battle Royale; `ONLINE_PROTOCOL_VERSION` in `src/online/types.ts`)

| Protocol | Release | What changed on the wire |
|---|---|---|
| 1 | v1.5 | Launch (Champions League rollback + Battle Royale host/client). |
| 2 | v1.8 | Jungle: snapshot fighter flags `inWater` / `onMoss`, event `splash` (tag 22). |
| 3 | v1.9 | Ocean Dome: snapshot header flag 64 + a 6-byte sea-serpent block, events `serpentWarning` / `serpentStrike` / `serpentHit` / `serpentEnd` (tags 23-26), a cause byte on `death`. |
| 4 | v1.10 | Ocean Dome heights: a SECOND (high) sea serpent and fall damage (details below). |

**v1.10 / protocol 4** (the host simulates both serpents and the falls; clients only render them, so nothing else is sent):

* Snapshot header flag **128** = the high serpent's block (`WorldSnapshot.serpentHigh`), the same 6 bytes as the low one and written
  right after it (flag 64 = `serpent`, the low serpent). Both flags are independent: neither, one or both can be present (0 / 6 / 12 extra
  bytes, only while an event runs). The client view interpolates / extrapolates and id-swaps `serpentHigh` exactly like `serpent`.
* The four serpent events carry the **tier** in bit 7 of their tag byte (set = the high serpent's event, decoded with `tier: 'high'`;
  clear = the low serpent's, decoded WITHOUT a `tier` key, exactly the v1.9 event). The payloads and sizes are unchanged; every tag stays
  below 128 and the bit on any other event is a corrupt packet.
* New event **`fall`** (tag 27, 12 bytes): fighter id · u16 hp removed (50, or less on the last hit points) · u16 drop in centimetres ·
  position. `death` cause byte **2** = a fall (`cause: 'fall'`, `killerId` -1 as for traps and the serpent). `swapEventIds` remaps
  `fall.fighterId`.
* The BR **data fingerprint** now also hashes the serpent lane tuning (`SERPENT_LANES`: the high serpent's seed salt, margins, sampling step)
  and every arena's `hazards` (`serpentSplitY`, `fallDamage`) on top of the arena registry, so two builds with a different split height,
  fall rule or lane setup refuse each other in the lobby. A v1.9.x build and a v1.10 build do not play together anyway (protocol 3 vs 4, and
  the app major.minor differs).

## Lag spikes, the fast channel and the diagnostics line (v1.10.1)

**The bug (user report: pings of 100-5500 ms).** PeerJS 1.5 opens its "unreliable" `DataConnection` with `ordered: false` but WITHOUT
`maxRetransmits` / `maxPacketLifeTime`, so SCTP still retransmits every lost packet and, after a retransmission timeout, collapses its
congestion window and backs the timer off. Snapshots (host -> client, 30 Hz, ~320-1200 B each, per client), 60 Hz inputs and the 500 ms
ping/pong then QUEUED behind the retransmits; the only guard was "drop when more than 64 KB is buffered", which is 2-6 s of snapshots - exactly
the 5.5 s spikes. A late snapshot or input is worthless in a realtime game; it has to be dropped, not delivered late.

**The fix (transport + client only; no wire format, `ONLINE_PROTOCOL_VERSION`, data fingerprint or sim rule changed).**

* `src/online/transport/fastChannel.ts` + `peerjs.ts`: next to the PeerJS "unreliable" half every link negotiates ONE more data channel on
  the same `RTCPeerConnection`: `createDataChannel('gk-fast', { negotiated: true, id: 100, ordered: false, maxRetransmits: 0 })`,
  `binaryType = 'arraybuffer'`, created by BOTH ends (id 100 cannot clash with PeerJS's own in-band channel, which takes id 0 or 1). The
  unreliable half has its own SCTP association, so retransmissions of the reliable half can never stall it.
* **Handshake.** A negotiated channel has no in-band open message, so data sent before the other end created its channel would vanish. Each
  end sends a 5-byte transport-internal `READY` packet (`0x0f 'gkF1'`) over the RELIABLE channel once its own end is open, and starts
  sending 'unreliable' traffic on the fast channel only after the PEER's READY arrived. Until then, and PERMANENTLY if READY does not arrive
  within 3 s of the link opening or the fast channel errors / closes, the old PeerJS unreliable half carries everything. Incoming data from
  either path is delivered as 'unreliable'. The `Link` / `Transport` / `GameChannel` APIs are unchanged; `READY` never reaches the game
  layers. **Compatibility:** a v1.10.1 build pairs with a v1.10.0 build (the old peer ignores `READY`: its room layer drops non-JSON junk, it
  never creates the channel, the new side gives up after 3 s and keeps using the old half) - but only a link where BOTH ends are 1.10.1 gets
  the fix.
* **Why `maxRetransmits: 0` and not a short packet lifetime.** Every unreliable packet is idempotent or superseded by the next one:
  Battle Royale snapshots (state-complete, keyframe every 2 s), BR intents (free-running press counters), BR_SYNC and room PING/PONG
  (periodic), Champions League `CL_INPUTS` (sent every frame and carrying ALL not-yet-acked inputs, up to 48 frames of redundancy, plus a
  header ack) and `CL_SYNC` (100 ms periodic). A retransmit window would only bring the lateness back.
* **Backlog guard.** An unreliable send is dropped (never queued) when the channel holds more than `MAX_UNRELIABLE_BACKLOG` = **8 KB**
  (about 0.25-0.8 s of snapshots: anything older than half a second is stale for a client that interpolates 70-250 ms behind and extrapolates
  at most 100 ms) or when it is closing/closed. Applies to the fast channel AND the fallback half. Drops are counted per link (`dropped`).
  Honest limit: at an uplink below ~10 KB/s (80 kbit/s) the 8 KB still means ~1 s+ of queueing; such a link cannot carry the stream anyway.
* **Client catch-up (`BrNetClient`).** After a stall (no new snapshot for >= 400 ms) the old snapshots that were queued somewhere and now
  arrive in a burst are dropped, never replayed (`staleSnapshots`): while the recovery window is open a snapshot whose transit time exceeds
  the pre-stall estimate by > 250 ms is skipped (if they are not getting fresher - a permanently slower path - or after 200, the new delay is
  believed). The silence does not age the clock estimate (so the first fresh snapshot lands on the right render time without a hard resync),
  and nothing before the stall is interpolated against what comes after it. Extrapolation stays <= 100 ms, then the picture holds.
* **Ping estimate (`pingEstimator.ts`, used by BR client and host).** One ping that sat in a queue for seconds no longer drags the shown ping
  up for ten seconds: a sample can raise the estimate by at most 3x + 100 ms, up to two consecutive samples above 2 s are ignored on a healthy
  link, and the raw peak of the last 10 s is kept separately (`pingPeakMs` / `rttPeakMs`). The HUD shows ` · SPIKE 1.4 s` when a single sample
  was >= 300 ms and >= 2.5x the smoothed ping within the last 10 s.

### The diagnostics line

The Battle Royale net HUD (top right) shows a second small line under `PING .. ms · LOSS ..%`, refreshed every 2 s:

`path: direct (srflx) · rtt 48 ms · out 120 kbps · dropped 0 · fast-channel on`

| Field | Meaning |
|---|---|
| `path` | How the two machines are connected, from the ICE candidate pair `getStats()` selected. `direct (host)` = same LAN / local addresses, `direct (srflx)` = through each side's public address found with STUN (the normal internet case; the more NAT-traversed end is named), `direct (prflx)` = peer-reflexive address found during the checks, `relay` = through a TURN server (an extra hop; only when YOU configured one, see `gk-ice`), `unknown` = no pair reported yet. |
| `rtt` | ICE round trip of the selected pair (`currentRoundTripTime`, STUN checks): the **network path only**. It does not travel through our data channels, so it can NOT include our own queueing. Compare with the HUD `PING` (BR_SYNC through the game channel): `PING` much higher than `rtt` = the delay is queueing inside the app / browser / SCTP; both high = the network itself (Wi-Fi, a saturated uplink, distance). |
| `out` | Measured send rate of that WebRTC connection over the last 2 s in kbit/s (bytes sent delta). The browser's own estimate (`availableOutgoingBitrate`, often missing for data-only connections) is in the ring as `availOutKbps`. |
| `dropped` | Unreliable packets this machine refused instead of queueing since the link opened (the backlog guard). A handful after a hiccup is normal; a number that keeps growing means the uplink cannot carry the stream (see causes below). |
| `fast-channel` | `on` = the truly unreliable `gk-fast` channel is in use. `opening` / `handshake` = still negotiating (a few hundred ms after the link opens). `off` = the old PeerJS unreliable half is used (the other player runs 1.10.0, or the browser refused the channel; the reason is in `__gkNetDiag()`): the game works, but multi-second spikes are possible again. |
| `worst of N links` | The host has several links; the one with the worst `rtt` is shown. |

**`window.__gkNetDiag()`** (available once an online link exists; web build and desktop devtools `F12`) returns plain JSON: `{ version, takenAt,
userAgent, text, links: [{ peerId, linkId, closed, line, current, ring }] }` where `ring` is the last 60 samples (one per 2 s) with `rttMs`,
`outKbps`, `inKbps`, `availOutKbps`, `bytesSent/Received`, local / remote candidate types, protocol, `fast`, `fastReason`, `dropped`, `buffered`
(bytes waiting in the channel), `sentUnreliable`, `receivedUnreliable`. Ask a player who reports lag to run
`copy(JSON.stringify(__gkNetDiag(), null, 1))` in the console right after a spike and paste it.

### Likely causes of spikes (honest list)

1. **Wi-Fi.** Interference, distance, power saving: bursts of 100-500 ms of delay and loss that no game code can hide. Use a cable if you can. The
   host matters most (it sends every client's snapshots).
2. **Another program saturating your uplink** - OneDrive / Google Drive / iCloud / Dropbox uploading big files, backups, cloud-synced game
   saves, a Steam / launcher update, a stream or video call upload. A full uplink fills the router's queue ("bufferbloat") and EVERY packet,
   ours included, waits seconds. It shows as a high `rtt` and `out` pinned at your line speed. Pause the sync / upload while you play. 1.10.1
   cannot fix a queue that lives in your router; it only stops adding its own queue on top (and drops instead of delivering seconds-old data).
3. **Hosting from a weak PC.** The host runs the whole simulation, the bots, the renderer and the snapshot encoding for every client. When the
   host's frame rate drops (software WebGL, a laptop on battery, a busy background app) snapshots leave late and unevenly and every client sees
   it as jitter, even though `rtt` is fine. Let the strongest, best-connected machine host.
4. **No TURN relay.** Only STUN is configured by default. Two players behind strict / symmetric / carrier-grade NAT or a corporate firewall
   cannot connect at all ("Could not connect to the host"), and a TURN relay you add yourself costs latency (`path: relay`). Nothing in the game
   supplies a relay.
5. **Background throttling and power saving.** A tab that is hidden or minimised stops rendering and sending input; laptops on power-saver
   throttle timers. Keep the game window visible and plugged in.
6. **Distance / ISP routing** between the two players (`rtt` shows it).

### Manual two-tab recipe (the only way to test the real WebRTC behaviour)

1. `node scripts/dev-signal.mjs 9000` and `npm run dev` (any port). Tab A: `http://localhost:5173/?signal=localhost:9000&qa=1` -> Online -> Create
   room. Tab B (second tab, same machine): `...&join=<CODE>` (or Join a room). Use different origins (`localhost` / `127.0.0.1` / `[::1]`) when you
   want separate remembered names.
2. In either tab console: `__gkNetDiag().text` -> `...: path: direct (host) · rtt 1 ms · out 1 kbps · dropped 0 · fast-channel on` (the first poll
   takes up to 2 s; `fast-channel` goes `opening` -> `handshake` -> `on` within about a second of the link opening).
3. To see the channel itself, before the second tab joins run in tab A: `const o = RTCPeerConnection.prototype.createDataChannel; window.__rec = [];
   RTCPeerConnection.prototype.createDataChannel = function(l, i) { const c = o.call(this, l, i); __rec.push({ l, c }); return c; }` and after the
   join read `__rec.map(r => [r.l, r.c.negotiated, r.c.id, r.c.ordered, r.c.maxRetransmits, r.c.readyState])` -> `["gk-fast", true, 100, false, 0, "open"]`.
4. Fallback: in tab B before joining run `const o = RTCPeerConnection.prototype.createDataChannel; RTCPeerConnection.prototype.createDataChannel =
   function(l, i) { if (l === 'gk-fast') throw new Error('off'); return o.call(this, l, i); }` (this is what a 1.10.0 peer looks like), join. Tab A's
   `fast-channel` reads `off` after 3 s with `fastReason: "ready-timeout"`, tab B's reads `off` with `create-failed:...`; the link stays open, the lobby
   keeps updating and `sentUnreliable` / `receivedUnreliable` keep counting (the old half carries the heartbeats).
5. Degrade one tab with `&netsim=latency:80,jitter:30,loss:0.05` (outgoing packets of that tab only; applies on top of either path).

**What was verified how (WP-L1).** Unit tests with fake data channels / connections (`tests/online/fastChannel.test.ts`: handshake, READY timeout,
fallback, guard counters, READY never leaks upward), pure diagnostics (`tests/online/netDiag.test.ts`), and the netcode on the loopback harness
with a real `World` (`tests/online/brNetStall.test.ts`: 3 s freeze + flood, 8 KB-bounded flood, 5 % and 15 % loss with jitter, queueing bound, ping
behaviour; wire model in `tests/online/netPipe.ts`). In the browser pane, two tabs through `scripts/dev-signal.mjs` on one machine: both ends
reached `fast-channel on`, the real channel reads `negotiated: true, id: 100, ordered: false, maxRetransmits: 0`, heartbeats flowed in both
directions over it (45/45 unreliable packets each way), the 3 s give-up fallback worked as in step 4, and the HUD line rendered. **Not verified:**
behaviour under real packet loss / a saturated uplink on a real internet path (the loopback tests use a model of the wire, not SCTP), Firefox /
Safari, TURN paths, a v1.10.0 build as the actual peer (simulated by blocking `createDataChannel`), and a full Battle Royale / Champions League
match over the fast channel (only the room heartbeat traffic was seen on it in the browser).

## Troubleshooting

| Symptom | What to do |
|---|---|
| Windows Firewall prompt on the first online game | Allow *Gladiator Kingdom* on **private** (and public if you play over the internet) networks. Without it other players often cannot connect to the host. |
| "Cannot reach the matchmaking server" | Internet/proxy problem, or the free PeerJS cloud is down. Try again in a minute; or use the local signalling server below. |
| "Could not connect to the host (firewall / NAT?)" | Strict / carrier-grade NAT or a corporate firewall: a TURN relay is needed. Put one in the browser storage of **every** player: `localStorage.setItem('gk-ice', JSON.stringify([{urls:'turn:turn.example.org:3478', username:'u', credential:'p'}]))` (web: browser console; desktop: start the game once with the `--devtools` argument, press F12 and run it in the console). Short form also works: `gk-ice` = `turn:turn.example.org:3478\|user\|pass`. `?ice=` on the URL does the same for one session. |
| "Different game versions" | Everybody updates to the same x.y release (reload the web page / reinstall); a different patch number (1.5.0 vs 1.5.2) is fine. |
| "The room is full" | 4 humans max. |
| Room code not found | The host closed the room, or typo. Codes use `ABCDEFGHJKMNPQRSTUVWXYZ23456789` (no 0/O/1/I/L). Not-found takes ~5-10 s to be reported (the signalling server waits for the host). |
| Choppy match / ping spikes | Read the second HUD line and paste `copy(JSON.stringify(__gkNetDiag(), null, 1))` (see "Lag spikes" above: Wi-Fi, an uploading cloud-sync app, a weak host, no TURN). Add `?netsim=latency:80,jitter:30,loss:0.05` to *your own* URL to reproduce bad conditions (only outgoing packets of that tab are degraded). Battle Royale clients feel their round trip time (no prediction), Champions League hides it with rollback. |

**LAN / offline play (no internet, or you do not trust the cloud):** run `node scripts/dev-signal.mjs 9000` on one machine and open every
player's page with `?signal=<that-machine>:9000` (plain `http://` pages only - browsers block `ws://` from `https://` pages). The packaged
desktop app only allows `localhost` / `127.0.0.1` signalling servers (CSP), so use the web build for LAN games.
Desktop windows have no address bar: `localStorage.setItem('gk-signal','localhost:9000')`, `gk-ice`, `gk-netsim` do the same as the URL parameters.

## Known limits (honest list)

* Not tested over a real internet path (NAT types, regional latency, TURN): QA ran on one machine with simulated latency/jitter/loss
  and, once, through the real PeerJS cloud + Google STUN with two tabs of the same machine.
* The free PeerJS cloud and Google STUN are best-effort (no SLA, possible rate limits).
* **Battle Royale**: host-authoritative, no client-side prediction - a client sees its own actions after one round trip plus ~2 snapshots of
  interpolation delay (~100-250 ms on a decent connection). The host has a small advantage. Bots run on the host.
* **Champions League online** is humans only (2-4), deterministic rollback; all machines must stay in sync (a checksum mismatch ends the
  match with a "desync" dialog). Everyone needs a different fighter in both modes.
* No pause online. If a player's page freezes for more than ~12 s the Champions League match ends for everybody ("connection timed out"
  dialog; shorter freezes - tested with 6-8 s busy loops - are survived). Battle Royale keeps a silent seat for 15 s before giving up on
  the host / 15 s of room-heartbeat silence before dropping a client (-> bot).
* A hidden/minimised game window stops rendering and therefore stops sending input (browsers pause animation frames): CL opponents see
  "waiting for player".
* After a match a client that returns to the room before the host shows "not ready"; its Ready press is applied when the host returns.

## QA recipes used (WP-Q)

Everything was driven through the real UI in the Claude desktop browser pane against a **production build** (`npm run build`,
`npx vite preview --port 4180 --strictPort --host`) and the local signalling server (`node scripts/dev-signal.mjs 9000`):

* One tab per player on different origins so each has its own localStorage: `http://localhost:4180/`, `http://127.0.0.1:4180/`,
  `http://[::1]:4180/` (+ more tabs on the same origins). Always `?signal=localhost:9000&qa=1` (`qa=1` exposes `window.__gkNetBrawl`
  (Champions League) and `window.__gkNetBr` (Battle Royale) in production builds). Public-cloud runs simply omit `signal`.
* Hidden pane tabs get no animation frames: inject a Worker-driven `requestAnimationFrame` shim and drive keys with synthetic
  `KeyboardEvent`s on `window` (WASD/J/K/L/Esc for CL; WASD + `mousedown` + Shift/Q for BR after faking `document.pointerLockElement`).
* Failure paths: wrong code, version mismatch (monkey-patch `JSON.stringify` to change `appVersion` in the outgoing hello), room full
  (5th tab), kick, abrupt tab close (navigate away) in the room and mid-match (host and client), host leave via the Esc menu, a
  6 s busy-loop on a client right when its match screen appears (must not be dropped) and mid-match (must not be dropped).
* Conditions: `?netsim=latency:80,jitter:30,loss:0.05` on one or all tabs.
* Leak checks between consecutive matches without reloading: wrapped `addEventListener`/`removeEventListener` on window/document/canvas,
  pending rAF callbacks, live `AudioScheduledSourceNode`s, WebGL context loss events, DOM node count.

## Q log (WP-Q integration + QA pass)

**Passed in real flows** (production build, Lobby -> Online UI, local `scripts/dev-signal.mjs`; 3-4 tabs on one machine):
Champions League 2P / 3P / 4P (3 consecutive matches without reload, results identical on every machine, checksums compared, no desync);
Battle Royale 2P / 3P / 4P + bots (client actions land in the host world: kills, damage, ultimates; names in HUD / kill feed / results);
back to room + play again (no leaked window/document/canvas listeners, no pending rAF besides the FPS counter, 0 live audio sources
after a match, no WebGL context loss); `?netsim=latency:40..80,jitter:20..40,loss:0.03..0.08` on every tab, both modes, 3P and 4P;
wrong code, version mismatch (both versions named), room full, kick, host leaves in the room, host leaves mid-match (Esc menu and
abrupt tab close), client leaves mid-match (CL forfeit / BR bot takeover, menu and abrupt close), 6-8 s page freeze at match start and
mid-match (nobody dropped), `?join=CODE` deep link with and without a saved name, CL desync dialog (corrupted state injected).
**Public PeerJS cloud + Google STUN (no `?signal`)**: reachable from the pane; Champions League 2P and Battle Royale 2P+bots played
end to end through it (two tabs of one machine - the NAT / TURN path itself is untested).
**Electron**: `runSmokeTest` gained an Online step; `npm run dist:dir` + `npm run desktop:smoke` print `SMOKE OK ... online=mounted
onlineChunks=ok peerCloud=reachable ...` (the Online screen mounts under `app://`, "Create room" against a closed local signalling port
gives the friendly error panel through the lazily loaded PeerJS chunk, and a raw `wss://0.peerjs.com` socket is not blocked by the CSP).

**Bugs found and fixed**
1. *BR: host leaves the match through its menu* (it stays in the room, so the links never drop): clients showed "Reconnecting..." for 15 s
   and then "Lost connection". New reliable message `MSG.BR_BYE` (0x25, additive to `src/online/types.ts`) sent by `BrNetHost.sendBye()`
   from `NetBattleRoyaleScreen.finish()` while the match is undecided; `BrNetClient` turns it into `onHostLeft`, the screen exits with
   "The host left the match." Tests: `tests/online/brNetSessions.test.ts` (2).
2. *Back to room before the host*: the client kept showing a stale "Ready" tick and a Ready press was ignored by the host (still in the
   match) and then wiped by its reset. `OnlineRoom` now shows "not ready" at once and remembers a Ready press (`deferredReady`), re-sent when
   the host reopens the lobby. Test: `tests/online/room.test.ts`.
3. *QA tool*: `ConditionedTransport` could reorder RELIABLE packets (browsers truncate timer delays to whole ms), which showed up as
   `eventGaps`/`duplicateEvents` in the BR client under `?netsim` and would have dropped real events. Reliable sends now go through a FIFO
   queue. Test: `tests/online/room-transport.test.ts`.
4. *Cosmetic*: after a first-frame freeze the lobby ping read 800-1300 ms for ~10 s and the CL session asked for the maximum input delay.
   `smoothRtt` (`src/online/room/rtt.ts`) caps one sample at 3x + 100 ms of the running estimate; used by the room heartbeat and
   `RollbackSession`. Test: `tests/online/room-rtt.test.ts`.
5. QA hook: `window.__gkNetBr` = `{ screen, driver, controller }` for the online Battle Royale screen (dev server, or `?qa=1` in production),
   mirroring `__gkNetBrawl`.

**Observations, not changed**
* A page that freezes for more than ~12 s ends a Champions League match for everybody (timeout dialog) instead of forfeiting only that player.
* "Room not found" takes 5-10 s (the signalling server holds the offer until it expires).
* When 3-4 tabs render at once on one machine (software WebGL) BR clients show `starvedFrames`/`resyncs`; with two tabs the stats are clean
  (0 starved, 0 resyncs, 0 event gaps) - judge BR feel on real machines.
* Hidden browser pane tabs get no animation frames: QA used a Worker-driven rAF shim; the game itself needs a visible window (see limits).
* `127.0.0.2`-style origins cannot be used as extra QA origins in the pane (cross-origin sockets from them are blocked); `localhost`,
  `127.0.0.1` and `[::1]` work (tabs on the same origin only share the remembered name / fighter).

**Acceptance (final run)**: `npx tsc --noEmit` clean; full `npx vitest run` green (103 -> 104 files, 1618 -> 1625 tests); `npm run build`;
`npm run dist:dir` + `npm run desktop:smoke` PASS.

## Host/client loop robustness (v1.10.1)

In Battle Royale the host's sim, bots, snapshot sends and pong replies run inside its render loop, so anything that stalls that loop is a ping spike for everybody. Fixed on the loop side (no wire or sim change): (1) **Ocean Dome fight-start stall** - the bots' navigation grids (`getNavGrid`, ~130 ms each, 8-16 of them) were all built on the first live tick, a 2.7-4.4 s freeze the instant "FIGHT!" started; `match/navWarm.ts` now builds exactly those cached grids in slices during the frozen countdown (flat maps build none); (2) **shader warm-up** - `render/warmup.ts` compiles every program of the map (serpent / fall / water FX, rigs, post passes) before the first frame (first-frame outlier >= 250 ms -> < 100 ms); (3) **hidden / alt-tabbed host** - Electron no longer throttles background windows (`backgroundThrottling: false` + the `disable-renderer-backgrounding` family of switches), and in a browser a hidden online-BR page keeps stepping and sending from a Worker timer without drawing (`core/GameLoop.ts`, `core/WorkerTicker.ts`; offline matches still pause); (4) **auto quality online** - an average frame time above ~22 ms for 3 s lowers the graphics tier one level for the rest of the match (toast, never stored, never raised); (5) **host load shedding** - while the host's own frames average above 30 ms it sends 20 Hz instead of 30 Hz snapshots (`BrNetHost.setSnapshotHz`; clients already measure the snapshot spacing). Still true: room heartbeats and PeerJS timers are main-thread timers, which a hidden *browser* tab throttles (the desktop app does not).
