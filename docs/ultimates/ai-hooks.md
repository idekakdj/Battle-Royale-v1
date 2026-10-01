# Ultimate AI hooks (v1.3, WP-R0 follow-up)

Shared bot plumbing every Phase-2 ultimate can rely on, so no agent needs to touch `BotBrain.ts`, `Perception.ts` or `Steering.ts`.
Everything below is inert for the placeholder ultimates: nothing changes until a spec opts in.

Files: `src/ai/dangerZones.ts` (zones, exits, feelers), `src/ai/Perception.ts` (`perception.zones`), `src/ai/BotBrain.ts` (`dodgeZones`, `ultCastValid`), `src/ai/scripts.ts` (`Situation.ultTargetValid`), `src/config/animals.ts` (`UltTargeting.dodge`, `UltDodge`), `src/config/botProfiles.ts` (`BotProfile.ultDodge`).

## 1. Never press Q into a fizzle (`ultTargetValid`)

- A spec with `targeting.requireTarget: true` makes the brain check target validity with the same pure selection the sim runs at cast: `previewUltTarget(def.ultimate, self, fighters, { aimYaw })`.
- Two checks: at decision time (10 Hz, delayed view; sets `Situation.ultTargetValid`, which `decideUltimate` honours: `false` blocks the wish) and again at press time with the LIVE snapshot and the wish's aim. The block-overlay no longer overrides the aim of an ultimate press for such specs.
- Specs without `requireTarget` skip all of it (`ultTargetValid` is `undefined`, behaviour identical to v1.2).
- Your `UltScript.gate` still decides *whether the situation is worth it* (range, windows); validity only vetoes a cast that would fizzle.

## 2. Danger zones (enemy-ultimate avoidance)

### Opting in (config)
```ts
targeting: { kind: 'ground', range: 10, radius: 4.5,
  dodge: { mode: 'fixed', activeS: 2.0 } }        // UltDodge
```
`UltDodge = { mode: 'fixed' | 'commit'; activeS?: number; commitS?: number; radius?: number }`

| Field | Meaning | Default |
|---|---|---|
| `mode: 'fixed'` | zone is fixed from the `ultimateTarget` event; dodged immediately | - |
| `mode: 'commit'` | tracking reticle (see 2.3): not dodged until the commit beat | - |
| `activeS` | seconds the hazard persists AFTER `windup` (fixed); cap for the tracking phase (commit) | 0.3 (fixed), 3 (commit) |
| `commitS` | seconds a committed reticle stays dangerous | 0.6 |
| `radius` | lock kinds: circle radius around the victim | 1.6 |

### What the sim must emit
Only the events that already exist. `ultimateTarget` at cast start is enough for `fixed`. The event's `windup` must be the lead time until the hit; the zone lives `windup + activeS` from the EMISSION time (release time minus the bot's reaction latency), so a bot with reaction R has `windup - R` seconds to leave.

| `ultimateTarget.kind` | Zone |
|---|---|
| `ground` | circle at `to`, radius `width / 2` |
| `line` | capsule `from` -> `to`, half-width `width / 2` (round ends) |
| `lock` | circle at `to` (the victim at cast), radius `dodge.radius ?? 1.6` |
| `self` | circle at `from`, radius `width / 2` |

A `telegraph` (kind `ultimate`) of an opted-in caster creates a provisional circle keyed by the caster; the `ultimateTarget` that follows in the same tick replaces it. Special telegraphs never create zones. A caster has ONE zone (key = fighter id); a new event replaces it; `death` removes it.

### 2.3 Tracking -> committed reticle (eagle Death From Above, giraffe Timber Fall)
Use `mode: 'commit'` and drive it with `ultimateStage` beats from the ult module (`emitUltimateStage(sim, f, rt, stage, pos)`):

| `ultimateStage.stage` | Meaning | Zone |
|---|---|---|
| (`ultimateTarget`, lock) | reticle appears | circle at the victim, NOT dodged yet |
| `0` | still tracking | centre follows `pos` (emit it as often as you like, e.g. every 0.1 s, `pos` = the lagging reticle centre) |
| `1` | committed | centre FIXED at `pos`; dodged now; dangerous for `commitS` |
| `>= 2` | over | zone removed |

Commit-mode ultimates must therefore not reuse stages 0/1/2 for other purposes while the reticle exists. Set `commitS` to the committed warning time (eagle 0.5 + impact) and make sure the impact happens no later than the zone's expiry.

### 2.4 Difficulty policy (`BotProfile.ultDodge`)
| Level | `ultDodge` | Behaviour |
|---|---|---|
| L1 Cub | `never` | never dodges |
| L2 Fighter | `lazy` | dodges only once the zone has been known for one MORE reaction time and an exit is < 2 m away (`LAZY_MAX_EXIT_M`) |
| L3 Veteran | `reliable` | leaves any live zone it stands in as soon as it perceives it (reaction-delayed event) |
| L4 Apex | `strict` | as L3, plus `avoidDangerZones` bends its path so it never walks into a live zone |

Only committed, unexpired zones count. Dodging only runs while grounded and not soaring. It replaces the move direction (like the trap escape does) BEFORE `avoidTraps`, the obstacle feelers and separation run, so those still bend the dodge heading around traps, pillars and other fighters. Bots mid-cast, stunned or grabbed do not dodge (existing state machine).

### 2.5 API (`src/ai/dangerZones.ts`)
```ts
class DangerZones {                       // one per bot: perception.zones
  readonly list: DangerZone[]; get count(): number
  registerZone(init: DangerZoneInit): DangerZone      // same key replaces
  removeZone(key), removeBySource(id), find(key), prune(now)
  isLive(z, now): boolean                             // committed && now < expiresAt
  zonesAt(x, z, now, pad = 0): DangerZone[]           // live zones overlapping a body of radius pad (allocates)
  insideAny(x, z, pad, now): boolean
  earliestKnown(x, z, pad, now): number               // knownAt of the earliest containing live zone
  nearestExit(x, z, pad, now, out: ZoneExit, traps?): boolean
  ingest(ev, now, reactionS, selfId, animalOf): void  // Perception calls this for every released event
}
nearestExit   // 16 headings, bisection-refined crossing; landing must be clear of ALL live zones (+0.2 m),
              // inside the arena, off pillars and off armed/active traps (spent plates are fine);
              // falls back to the shortest zone-free landing if every clean one is blocked
avoidDangerZones(move, sx, sz, selfRadius, zones, now): boolean   // Apex feelers
zoneDist(zone, x, z): number                                        // signed distance, < 0 inside
makeExit(): ZoneExit    // { dx, dz, dist, x, z }
```
Constants: `LOCK_ZONE_RADIUS = 1.6`, `DEFAULT_ACTIVE_S = 0.3`, `DEFAULT_COMMIT_S = 0.6`, `DEFAULT_TRACK_CAP_S = 3`, `LAZY_MAX_EXIT_M = 2`.

### 2.6 Adding a hand-made zone
Ult modules cannot reach the bots directly (bots only read events). To make something dodgeable that no event describes, emit an `ultimateTarget`/`ultimateStage` pair as above. `registerZone` exists for tests and for future perception sources (e.g. hippo mud / mole vortex leftovers: emit one `ultimateTarget` at the moment the pool is created with `windup: 0` and a spec `activeS` covering its lifetime).

## 3. Tests
`tests/ai/dangerZones.test.ts`: opt-in gating (no placeholder creates a zone), shapes and lifetimes, commit protocol, exits (capsule, other zones, armed/active traps, wall), Apex feelers, per-difficulty brain integration against a control bot (L1 identical, L3/L4 dodge after the reaction delay, L2 lazy rules, no change without opt-in) and `ultTargetValid` (script veto + a brain that only presses Q when the lock would succeed).
