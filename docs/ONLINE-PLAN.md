# Online multiplayer for friends (v1.5.0)

Binding plan + contracts. Read fully before touching code. Shared contracts: `src/online/types.ts` (+ `wire.ts`, `channel.ts`,
`transport/loopback.ts`, all architect-written and tested — extend ADDITIVELY and say so in your report).
Scope: **friends-only** online play for BOTH modes, free infrastructure only, web + Electron builds interoperate.

## 1. Product behaviour

* Lobby gets an **Online** entry. **Host** creates a room → gets a 5-character **room code** (and a link `…/?join=CODE`).
  **Friends** type the code (or open the link), choose a name + fighter, press Ready. The host picks the mode and rules and starts.
* **Champions League online:** 2–4 **humans only** (no bots in v1 — bots hold unserialisable state), unique animal per human,
  deterministic **rollback netcode** (inputs only), full-mesh WebRTC.
* **Battle Royale online:** 2–4 humans + bots up to the usual 10 fighters, **host-authoritative**: the host's machine runs the one
  `World` (+ BotManager) and streams snapshots; clients send inputs and render interpolated snapshots. Unique animal per human.
* A host leaving ends the room. A client leaving mid-match: Champions League → their fighter forfeits (host-announced frame);
  Battle Royale → the slot becomes a bot. No pause online. After a match everyone returns to the room.
* Both peers must run the **same version**: handshake compares `ONLINE_PROTOCOL_VERSION`, `APP_VERSION` and a data **fingerprint**
  (hash of the mode's tuning data: CL = movesets + `PHYS`; BR = animals/balance/ultimate configs). Mismatch → clear message.
* Free infrastructure: PeerJS public broker for signalling (room codes = peer ids), public STUN, optional TURN list from config;
  `scripts/dev-signal.mjs` (local PeerServer) for QA/LAN. No server of ours.

## 2. Work packages (disjoint file ownership; Sonnet 5.5 agents; lean, write-first)

| WP | wave | owns | depends on |
|---|---|---|---|
| **N1 room + PeerJS transport** | 1 | `src/online/room/**`, `src/online/transport/{peerjs,conditioned,iceConfig}.ts`, `scripts/dev-signal.mjs`, CSP edits (`electron/main.cjs`, `index.html`), `package.json` deps (`peerjs`; dev `peer`), `tests/online/room*.test.ts` | contracts |
| **N2 CL determinism + rollback** | 1 | `src/brawl/sim/**` (additive: `dmath.ts`, serialisable RNG, `saveState/loadState/checksum/forfeit`), `src/brawl/net/**` (`RollbackSession.ts`, input codec), `tests/brawl/net*.test.ts` | contracts, loopback |
| **N3 BR codec + host/client** | 1 | `src/online/br/**` (snapshot/event/intent codecs, `BrNetHost`, `BrNetClient`, id-swap, interpolation buffer), `tests/online/br*.test.ts` | contracts, loopback |
| **N4 Online UI** | 2 | `src/online/ui/**`, `src/styles/online.css`, edits in `Lobby.ts`, `main.ts`, `storage.ts`, `SettingsPanel.ts` | N1 |
| **N5 CL online controller** | 2 | `src/brawl/net/NetBrawlController.ts` (+HUD/overlay glue), `tests/brawl/netcontroller*.test.ts` | N1, N2 |
| **N6 BR online controller** | 2 | `src/match/**` additive hooks (`MatchController` option `sim?: SimDriver`, remote-intent hook, after-step hook; default path byte-for-byte unchanged), `src/online/br/NetMatchController` glue | N1, N3 |
| **Q QA/integration** | 3 | everything touched; two-window tests, network-conditioner runs, fixes | all |

## 3. N1 — room layer + transport (details)

* **Room codes:** 5 chars from `ABCDEFGHJKMNPQRSTUVWXYZ23456789`. Host peer id `gk1-<CODE>` (retry with a new code on `id-taken`);
  joiners register `gk1-<CODE>-<random6>`.
* **Public API** (`src/online/room/OnlineRoom.ts`): `OnlineRoom.host(opts)`, `OnlineRoom.join(code, opts)`; opts carry `Transport`
  (default = `PeerJsTransport`), name, animal. Events: `state(RoomState)`, `start(OnlineStart, GameChannel)`, `ended(NetEndReason)`,
  `error`. Methods: `setName`, `pickAnimal` (unique across humans; host assigns bot animals), `setReady`, `setMode`/`setSettings`
  (host), `addBot/removeBot` (BR only; fills to 10 at start), `kick`, `startMatch` (host; ≥ 2 humans, all ready), `leave`,
  `backToRoom` (after a match). Export `RoomState` (code, mode, settings, slots with name/animal/ready/ping/isHost, phase, versions) from `room/types.ts`.
* **Protocol:** reliable JSON lobby messages (`MSG.HELLO…`): HELLO {protocol, appVersion, fingerprint, name} → host validates →
  ROOM_STATE broadcasts on every change; reject with reason + both versions; heartbeats (PING/PONG on the unreliable channel, ≥ 1 Hz) give
  `rttMs` and a 5 s silence timeout → `peer-left`; `PEER_LIST` on START so CL joiners open links to each other (full mesh; BR stays a star).
  `start` hands each machine the same `OnlineStart` (own `localSlot`) and a `GameChannel` (`LinkChannel`) already connected to every peer the mode needs.
* **Fingerprint:** `computeFingerprint(mode)` — stable-stringify → 32-bit FNV-1a (hex) of the tuning data + `APP_VERSION` + protocol.
* **PeerJsTransport:** one `Link` = two PeerJS `DataConnection`s to the same peer (ordered `reliable:true` + `reliable:false`), `serialization:'raw'`
  (binary); the link opens when both are open; 12 s connect timeout; `rttMs` from heartbeats. ICE servers from `iceConfig.ts`
  (public Google STUN by default; extra STUN/TURN from `localStorage['gk-ice']` JSON or `?ice=` URL param); signalling server from `?signal=host:port`
  (default PeerJS cloud). `ConditionedTransport` wraps any Transport and injects latency/jitter/loss with real timers, enabled by
  `?netsim=latency:80,jitter:20,loss:0.05` (for QA in two tabs).
* **CSP:** allow the PeerJS cloud (`wss://0.peerjs.com https://0.peerjs.com`) and `ws://localhost:* http://localhost:*` in `connect-src`
  of the Electron CSP and any web CSP meta; WebRTC itself is not CSP-gated. Add `peerjs` as a runtime dependency (MIT) and `peer` as a dev dependency.
* **Tests:** with `LoopbackNetwork`: join/leave, version & fingerprint mismatch, unique animals, ready/start gating, kick, host-left, ping
  measurement, mesh formation, bot fill (BR), room-code collisions; `PeerJsTransport` only compile-checked + a manual two-tab recipe in the report.

## 4. N2 — Champions League determinism + rollback (details)

* **Determinism (hard rule):** the CL sim may use only `+ − × ÷`, comparisons, `Math.sqrt/abs/min/max/floor/ceil/round/trunc/sign`, `Math.imul`. Replace every
  `Math.sin/cos/tan/atan/atan2/asin/acos/pow/exp/log/hypot/cbrt` (8 uses in `combat.ts`, `geometry.ts`, `BrawlWorld.ts`) with `dmath.ts`
  (range-reduced polynomial/CORDIC; max error < 1e-9 vs `Math.*` so gameplay is unchanged — balance tests must stay green) and add a test that
  scans `src/brawl/sim/**` (+ `src/brawl/data/**` helpers used at runtime) for banned tokens. The RNG becomes a serialisable class.
* **State:** `BrawlWorld.saveState(): BrawlSavedState` (plain data; pooled buffers; ≤ ~50 µs), `loadState`, `checksum(): number` (32-bit over all gameplay state in
  canonical order via integer mixing of float bit patterns; identical on every machine), `forfeit(id)` (idempotent, sim-visible), and everything the existing
  `BrawlWorldApi` does stays as is. A rollback of N frames = `loadState` + N × (`setIntent` for every fighter + `step`).
* **Input codec:** `BrawlIntent` ↔ 3 bytes (moveX/moveY quantised to int8 steps of 1/16, flags jump/jumpHeld/light/heavy/dodge). The LOCAL player's intent is quantised
  BEFORE being fed to the local sim so every machine simulates identical values.
* **`RollbackSession`** (transport-agnostic, uses `GameChannel`): GGPO-style. `inputDelay` default 2 frames (auto 1–4 from RTT), `maxRollback` 8 (beyond → stall
  "waiting for player"), ring buffer of saved states, per-peer input history, repeat-last-input prediction (edge flags cleared in predictions), redundant input
  packets (`CL_INPUTS`: last ≤ 16 frames + ack), frame-advantage sync (`CL_SYNC`) that slightly slows/speeds the local clock (±5 %) so peers stay level,
  checksum exchange every 30 confirmed frames (`CL_CHECKSUM`) → `onDesync`, host-authored frame-stamped `CL_CONTROL` events (forfeit on leave), confirmed-frame result
  agreement at match end. Public: `update(dtSeconds)`; `snapshots(): {prev, cur}` for the view; `drainEvents()` with (frame,type,ids) **de-duplication** so rollbacks never
  replay sounds/VFX twice; `stats` (rollbacks, max depth, ping, stalls). No bots in online CL.
* **Tests (the acceptance bar):** random-input matches of 3000+ frames on `LoopbackNetwork` with (a) perfect, (b) 80 ms ± 30 jitter, 5 % loss, (c) 150 ms, 10 % loss,
  for 2, 3 and 4 peers: every peer's confirmed-state checksums are identical and equal to a single reference sim fed the true input log; stall/recover; forfeit on
  disconnect; desync detection with an injected corrupted state; 8 simulated frames of rollback per tick costs < 2 ms.

## 5. N3 — Battle Royale host/client (details)

* **Codecs** (`src/online/br/`): schema-driven binary `WorldSnapshot` encoder/decoder covering EVERY field of `WorldSnapshot`/`FighterState`/`PickupState`/crates/`TrapState`/
  `ProjectileState` (read `src/core/types.ts` — optional fields such as `ultPhase/ultStage/ultTargetId`, `projectiles` included), quantised (e.g. int16 positions at 1/100 m,
  angles as u16), static per-fighter data (animal, maxHp…) sent once + in a keyframe every 2 s. **Budget: ≤ 1.2 KB average, ≤ 8 KB max per snapshot** for 10 fighters in a typical fight
  (measure and test). `GameEvent` codec for all variants (reliable `BR_EVENTS`, with sequence ids; the client de-duplicates). `FighterIntent` codec (~12 B) sent at 60 Hz
  unreliable with a sequence number; edge flags (`attack/special/ultimate`) stay latched in every packet until the host acks that sequence and the host consumes each edge exactly once.
* **`BrNetHost`:** `onClientIntent(peer→slot)`, `remoteIntent(slot)`, `afterStep(snapshot, events)` → sends snapshots (default 30 Hz; configurable 20/30/60) + events; tracks acks, RTT, per-client bytes;
  `peerLeft(slot)` hook (controller turns the slot into a bot).
* **`BrNetClient`:** `sendIntent(intent)`, ingest → jitter buffer; `sample(nowMs)` returns `{ prev, cur, alpha?, events[] }` interpolated at (latest − interpDelay ≈ 2 snapshots), extrapolates ≤ 100 ms when starved,
  smooth host-time sync, no interpolation across blinks/teleports (distance jump or `blink` event), angles wrap, discrete fields from the earlier snapshot.
* **Local-id swap:** the BR `MatchController` assumes the local player is fighter 0. Provide `swapIds(snapshot|event, a, b)` that remaps EVERY id-carrying field
  (fighter ids, `grabTargetId`, `grabbedById`, `ultTargetId`, event `attackerId/targetId/killerId/fighterId/ownerId…`, trap `triggeredBy`, projectile owner/target, `winnerId`, placement lists…) —
  an exhaustive test builds a snapshot/event set with distinct ids in each such field and checks the swap is its own inverse.
* **Tests:** codec round-trips + fuzz + budgets; with `LoopbackNetwork` (60 ms ± 20, 5 % loss): client positions track the host within bounds, no edge flag is ever lost or doubled,
  bandwidth within budget, interpolation is smooth (no snapping except blinks).

## 6. Wave 2 (after wave 1)

* **N4 UI:** lobby nav "Online"; Host/Join screens (code box, link paste, name field persisted under `gk-online-name`), Room screen (player cards with animal pick, ready ticks, ping, kick;
  host controls: mode, BR bot level, CL stage/stocks/time, Start; copy code/link), clear error panels (version mismatch shows both versions; host gone; connection failed → hint about
  firewalls/TURN), `?join=CODE` deep link auto-opens Join, "back to room" after results, mode-specific constraints (CL needs 2–4 humans, unique animals).
* **N5 CL controller:** `NetBrawlController` (Screen): `BrawlView`, `BrawlHud`, `BrawlInput`, audio exactly like the local controller but driven by `RollbackSession`; netcode HUD (ping, rollback
  indicator, "waiting for player" overlay), no pause (Esc opens a menu that does not stop the sim), disconnect/forfeit banners, desync dialog, results → back to room.
* **N6 BR controller:** minimal additive refactor of `MatchController` (an optional `sim: SimDriver` replacing the four direct `World` uses, a remote-intent hook for human slots, an after-step hook); host
  path = `World` + `BotManager` + `BrNetHost`; client path = `BrNetClient` as the sim source with local-id swap; HUD/FP/lock-on/audio keep working from snapshots; spectate-after-death works; no pause;
  client leaves → slot becomes a bot. Single-player BR must be byte-for-byte unchanged in behaviour (all existing tests green).

## 7. Wave 3 — Q (integration + QA)

Two Electron windows / two browser tabs against a local `scripts/dev-signal.mjs`, with `?netsim=` conditions: full CL 2P/3P/4P matches and BR 2P/3P matches; leave/kick/host-left; version mismatch; fix everything found;
docs (`docs/ONLINE-NOTES.md`: how to host, firewall/TURN tips, known limits); then architect: version 1.5.0, CHANGELOG, HANDOFF, `npm run dist`, install, smoke test, commit + push (no tags).

## 8. Honest limits (documented in the release)

Agents cannot test real internet paths (NAT, regional latency) — only simulated conditions; free STUN/PeerJS cloud are best-effort (no SLA) and some strict NATs need a TURN server
(configure via `gk-ice`); BR clients feel round-trip latency on their own actions (no client-side prediction in v1); CL online is humans-only; the host has a small advantage in BR;
animals must be unique per room; both sides must be on the identical version.
