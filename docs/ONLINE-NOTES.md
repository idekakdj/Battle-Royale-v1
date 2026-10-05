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

## Troubleshooting

| Symptom | What to do |
|---|---|
| Windows Firewall prompt on the first online game | Allow *Gladiator Kingdom* on **private** (and public if you play over the internet) networks. Without it other players often cannot connect to the host. |
| "Cannot reach the matchmaking server" | Internet/proxy problem, or the free PeerJS cloud is down. Try again in a minute; or use the local signalling server below. |
| "Could not connect to the host (firewall / NAT?)" | Strict / carrier-grade NAT or a corporate firewall: a TURN relay is needed. Put one in the browser storage of **every** player: `localStorage.setItem('gk-ice', JSON.stringify([{urls:'turn:turn.example.org:3478', username:'u', credential:'p'}]))` (web: browser console; desktop: start the game once with the `--devtools` argument, press F12 and run it in the console). Short form also works: `gk-ice` = `turn:turn.example.org:3478\|user\|pass`. `?ice=` on the URL does the same for one session. |
| "Different game versions" | Everybody updates to the same x.y release (reload the web page / reinstall); a different patch number (1.5.0 vs 1.5.2) is fine. |
| "The room is full" | 4 humans max. |
| Room code not found | The host closed the room, or typo. Codes use `ABCDEFGHJKMNPQRSTUVWXYZ23456789` (no 0/O/1/I/L). Not-found takes ~5-10 s to be reported (the signalling server waits for the host). |
| Choppy match | Add `?netsim=latency:80,jitter:30,loss:0.05` to *your own* URL to reproduce bad conditions (only outgoing packets of that tab are degraded). Battle Royale clients feel their round trip time (no prediction), Champions League hides it with rollback. |

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
