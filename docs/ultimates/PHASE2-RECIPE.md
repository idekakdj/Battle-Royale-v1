# Phase-2 recipe: building one animal's new ultimate end to end

Read `docs/UPGRADE-PLAN-v1.3.md` §3 (your animal's design row), §2 (targeting rules), §6 (ownership). Everything below already exists — you fill in YOUR animals' files. All agents are Sonnet 5.5; write-first; no git; no npm install; personal-use project.

## 1. Files you own (per animal; do not touch other animals' files or shared infra)
| Layer | File |
|---|---|
| Sim rules | `src/sim/ultimates/<animal>.ts` (exports `<animal>Ultimate: UltimateImpl`, already registered in `src/sim/ultimates/index.ts`) |
| Config numbers + targeting | `src/config/ultimates/<animal>.ts` (exports `<ANIMAL>_ULTIMATE: AbilitySpec`; replace the placeholder `targeting` block with the real one; set `requireTarget: true` for lock kinds) |
| Bot logic | `src/ai/ultScripts/<animal>.ts` (exports `<animal>UltScript: UltScript`) |
| Rig animation | `src/render/animals/<Animal>.ts` (ultimate poses driven from `state.ultPhase`, `state.ultStage`, `state.ultTargetId`, `actionT/actionDur`, `pos`, `vel`). **Do not edit `Animator.ts`** (first-person agent owns it); put helpers in your animal file or a new `src/render/animals/ultPose/<animal>.ts` |
| VFX | `src/render/ultFx/<animal>.ts` (auto-discovered by the registry; default export implements `UltFx`) |
| Audio | `src/audio/ults/<animal>.ts` (auto-discovered; hooks onTarget/onStage/onImpact/onEnd) |
| Tests | `tests/sim/ultimates/<animal>.test.ts` (+ `tests/ai/…` if needed) |
| Design notes | `docs/ultimates/<animal>.md` (as built: mechanic, numbers, indicators, animation beats, balance notes, first-person notes) |

## 2. Sim: the `UltimateImpl` interface (`src/sim/ultimates/types.ts`)
Hooks: `start(sim, f, rt, target: UltPreview)`, `windupTick?(sim,f,rt,dt)`, `windupDuration?(rt)`, `activate(sim,f,rt)`, `activeTick?(sim,f,rt,dt)`, `recoveryDuration?(rt)`, `abort?(sim,f,rt)` (called from `World.kill` if the caster dies mid-ult).
- `start` MUST call `emitCastEvents(...)` (or `emitDefaultUltTelegraph`) then `emitUltimateTarget(sim, f, rt, target, windup, to?)`.
- Defaults: windup = `spec.windup`; recovery = `didHit ? LAND_RECOVER : spec.recovery ?? LAND_RECOVER`; with no `activeTick` the ult drops straight into recovery.
- `startUlt(sim, f): boolean` returns false when the cast **fizzles** (`spec.targeting.requireTarget` and no valid target): nothing is spent, `ultimateFizzle` is emitted.
- Interrupts: `Fighter.interrupt()` nulls the runtime directly, so ults that must not be interruptible set `f.ccImmuneChannel = true` (as the rhino does) for the protected phases. Clean up (`endAbility`) on every exit path.
- `AbilityRuntime` extras: `lockId` (locked victim id or -1) and `stage` (0-based beat). Emit beats with `emitUltimateStage(sim, f, rt, stage, pos?)` (also sets `rt.stage`); the snapshot exposes `ultPhase/ultStage/ultTargetId` automatically through `fillUltSnapshot`.
- Helpers (`src/sim/ultimates/common.ts`): `aimX, aimZ, aimPointDist, beginAbility, emitCastEvents, endAbility, toRecovery, hitArea(+AreaCfg), AOE_HEIGHT, ultOpts, emitDefaultUltTelegraph, emitUltimateTarget, emitUltimateStage, currentTargetId, blink(sim, f, x, z, {yaw?}), fillUltSnapshot`.
- **Damage:** use the existing pipeline (`dealDamage` with `DamageOpts`, `hitArea`), respect `withinGroundReach`/`isGroundTargetable` (v1.2 altitude filter), `untargetable` states (burrowed mole, soaring eagle), traps' immunities where relevant. Use `blockIgnore`/`blockable: false` deliberately per the design row.
- **Blink:** `blink(...)` relocates + pushes out of pillars/crates, keeps inside the wall, emits `blink {fighterId, from, to}` (renderers snap interpolation).
- **Projectiles** (`src/sim/projectiles.ts`): `spawnProjectile(sim, {kind:'boulder', ownerId, pos, vel, radius, gravity?, maxLife?, impactRadius?, breaksCrates?, onImpact?(sim, p, hit)})`; the system deals no damage — `onImpact` applies damage/splash, then `projectileImpact` is emitted; stops at fighter/crate/obstacle/wall/ground/expiry, skips the owner and untargetable fighters, missed by fighters above flight height (jump/fly dodges).
- Targeting helpers (`src/sim/ultimates/targeting.ts`): `selectLockTarget(attacker, fighters, tg, opts)`, `previewUltTarget(spec, attacker, fighters, opts): UltPreview`, `resolveGroundPoint`, `lineEndPoint`, `clipRayToArena`, `bodyInLine`, `resolveUltTarget(sim, f, spec)` (sim-side, real flags). `UltTargeting = {kind, range, coneDeg?, width?, radius?, requireTarget?, hitsAir?}` (declared in `config/animals.ts`).

## 3. AI (`src/ai/ultScripts/<animal>.ts`)
`UltScript = { gate(s), cluster?(s), ranged?, rangedWindow?(s), apex(s, out) }` — `apex` sets `out.ult`. Difficulty modes come from `BOT_PROFILES` (`ultimateUse`). Bots must only cast when a valid target exists (shared `ultTargetValid` on `Situation`), and (from the AI hooks work) sidestep other fighters' committed ult zones at L2+ — see `docs/ultimates/ai-hooks.md` for the danger-zone API and how tracking→committed reticles are represented (`ultimateStage`: 0 = tracking, 1 = committed).

## 4. Render + audio
See the WP-T report section appended below (primitives, `UltFx`, audio hooks, how to add an animal's VFX/audio). Rig animation: poses must be **multi-phase and smooth** (anticipation → travel/impact → follow-through → recovery), blend from the previous action (the Animator cross-fades 0.1 s), and stay stable if the fighter's root is teleported (`blink`) or knocked. Use easing (cubic in/out), not linear ramps.
- Testing handles: `?demo=match&animal=<a>&difficulty=1&seed=1` → `window.__gkMatch`; force a cast: `__gkMatch.world.fighters[0].state.ultCharge = 100` then press `Q` (dispatch `KeyboardEvent` code `KeyQ` on `window`) or set intent; stage enemies by setting `world.fighters[i].state.pos`. Bots: keep them idle by parking them far away. `?demo=animals` → `window.__gkAnimals` for pose checks.

## 5. Balance
`N=60 LEVELS=1,2,3,4 npm run balance` before and after (save the "before" in `docs/ultimates/<animal>-balance.txt`). Targets: single-target ult ≈ 250–320 total damage on an unblocked victim, line/AoE ≈ 130–200 per victim; all animals stay in the v1.2 bands (L3/L4 ≈ 4–18%, L1/L2 ≤ ≈ 30%), 0 timeouts, ~1 ult per fighter per match; never break determinism (`mulberry32` only). Small numeric retunes of YOUR animal only.

## 6. Gates
`npx tsc --noEmit` clean (ignore other agents' in-progress files, note them), `npx vitest run` green, `npm run build` OK, zero console errors at all quality tiers, visual verification of every phase of your ultimates (screenshots described in your report).

---

## 4b. Render + audio infrastructure (WP-T, as built — exact APIs)
**Primitives** (`src/render/ultFx/primitives.ts`; import from `./primitives`, the registry does not re-export them):
```ts
type IndicatorStyle = 'friendly'|'hostile'|'lock'|'tracking'|'committed'|'invalid'
class UltIndicators { ring(owner?), ribbon(owner?), reticle(owner?), arc(owner?), zone(owner?), update(dt), releaseOwner(owner, fadeOut=0.2), hideAll(fadeOut=0), dispose() }
// every handle: held(owner): boolean (check before updating long-lived handles: a dry pool steals the oldest), hide(fadeOut=0.16), setStyle(style), setColor(hex|-1), setAlpha(a)
RingHandle:   show(x,y,z,radius,thickness=0.14,style) update(...) setDash(count,spinRate) setFill(a) setGlow(g)
ZoneHandle:   show(x,y,z,radius,style='hostile') update(...) setProgress(0..1)   // warning fill grows to the edge
ReticleHandle:show(x,y,z,radius,style='lock') update(x,y,z,radius) setCommit(0..1) // 'tracking' (wide red brackets) -> setStyle('committed') (solid ring + crosshair + warning fill)
RibbonHandle: show(fx,fy,fz,tx,ty,tz,width,style) update(...) setReveal(0..1) setHead(0..1) setFlow(speed,period) // ground line with marching chevrons
ArcHandle:    show(fx,fy,fz,tx,ty,tz,height,width=0.26,style) update(...) setReveal(0..1) setDash(lengthM,speed) // dashed ballistic arc in the air
```
Pools: ring 8, ribbon 8, reticle 6, arc 4, zone 6. Nothing allocates per frame; quality tiers handled inside.

**Per-animal VFX** — `src/render/ultFx/<animal>.ts` (auto-discovered; file name = animal id; default export is an `UltFx` object or a factory `(ctx) => UltFx`):
```ts
interface UltFx { onTarget?(ctx, ev: ultimateTarget) onStage?(ctx, ev: ultimateStage) onBlink?(ctx, ev: blink) onImpact?(ctx, ev: projectileImpact) onFrame?(ctx, snapshot, dt) /* every frame, early-out when idle */ onEnd?(ctx, fighterId) dispose?() }
// ctx: scene, effects, indicators, camera, time, snapshot, fighterPos(id,out), fighterYaw(id), fighterObject(id), isPlayer(id), styleFor(id), nearness(pos,range)
```
Animals without a module fall back to `_default.ts` (ribbon / tracking→committed reticle / zone with warning fill); a module may `import { defaultUltFx } from './_default'` and delegate. The dispatcher detects the end of an ult (ultPhase gone / action left 'ultimate' / death) and calls `onEnd`, `indicators.releaseOwner(id)`, `audio.ultEnd(id)`.
`Effects.ts` additive helpers: `spark, puff, burst, flash, shockRing, impactRing, crack, groundDust, onBlink, onBoulderImpact, boulderTrail`.

**Per-animal audio** — `src/audio/ults/<animal>.ts` (auto-discovered, plain object): `{ onTarget?, onStage?, onBlink?, onImpact?, onEnd?, dispose? }`; each hook receives `UltAudioApi`: `sc (SynthCtx), now, gainAt(pos), isListener(id), synth {EPS, shapeEnv, noiseSource, filter, osc, makeLFO}`. Copy `src/audio/ults/_example.ts`. Envelope-shape every voice (no clicks).

**Recipe:** (1) copy `_example.ts` → `<animal>.ts` in ultFx and audio/ults; (2) in `onTarget` reserve markers via `ctx.indicators.<kind>(ev.fighterId)` and `show(...)`, keep handles in per-fighter slots; (3) in `onFrame` follow moving parts (`ctx.fighterPos`, `setCommit/setProgress/setReveal`, check `handle.held(id)`); (4) in `onStage/onBlink/onImpact` use `ctx.effects`; (5) in `onEnd` clear slots (markers owned by that fighter fade automatically).

**Ready-state preview / HUD** (already built, keyed off `spec.targeting`): when charge = 100 the player sees the range ring (lock/ground), path ribbon (line) and a gold LOCK bracket + tag on the would-be target; invalid = dim red + 'NO TARGET' on the icon; pressing Q with no target → sim fizzle → 'NO TARGET IN RANGE' hint + dry click. Setting `gk-settings.ultPreview`. Projectiles (boulder) are rendered from `snapshot.projectiles` by `ProjectileRenderer` (nothing to do per animal except impact VFX via `onImpact`).

**Test hooks:** `?demo=match&animal=<a>&difficulty=1&seed=1` → `window.__gkMatch` and `window.__gkMatchTest` (`boulder`, `blink`, `fizzle`, `emit`, `place`, `animals` = live config table).

**Browser hygiene (IMPORTANT, shared pane):** open your OWN tab (`tabs_create`) and always pass your tabId; use your own dev port (`npm run dev -- --port <yours> --strictPort`); never navigate/act in another agent's tab; Vite full-reloads your page whenever ANY agent saves a file, wiping the rAF shim — re-apply it and restart the loop (`__gkMatch.loop.stop(); __gkMatch.loop.start()`) before each check.

---

## 3b. Bot hooks (as built by WP-R0 — read `docs/ultimates/ai-hooks.md` for detail)
- `Situation.ultTargetValid` is filled automatically for specs with `targeting.requireTarget` (bots never press Q into a fizzle; checked at decision and press time with the same `previewUltTarget`).
- **Danger zones (opt-in per ultimate)**: add `dodge: { mode: 'fixed' | 'commit'; activeS?; commitS?; radius? }` inside your ultimate's `targeting` block to make other bots sidestep it (`fixed`: zone from `ultimateTarget` lives `windup + activeS`; `commit`: for tracked→committed reticles). Zone shapes come from `ultimateTarget.kind`: `ground` circle at `to` (radius `width/2`), `line` capsule `from→to` (half-width `width/2`), `lock` circle at `to` (radius `dodge.radius ?? 1.6`), `self` circle at `from`. **Commit protocol (eagle/giraffe tracking→committed reticle):** `ultimateTarget` creates a tracking zone that is NOT dodged; `ultimateStage` stage 0 moves its centre to `pos`; stage 1 commits it fixed at `pos` (dodged for `commitS`); stage ≥2 removes it. While a commit-mode reticle exists do not reuse stages 0–2 for other beats.
- Difficulty policy is in `BotProfile.ultDodge`: L1 never dodges, L2 lazy (late + only if an exit < 2 m), L3 reliable, L4 strict (never walks into a live zone). Your `apex()` script should still decide WHEN to cast (Apex: staggered/guard-broken/isolated/low-HP targets; avoid fights against 3+ enemies unless the design says otherwise).
- **Balance caveat while agents work in parallel:** other animals' ultimates are being replaced at the same time, so the sweep moves under you. Judge only YOUR animals' rows (win %, avg place, ult/match, dmg) and keep a before/after of your own rows; the architect does the final full-roster balance pass.
- **Shared files you must NOT edit** (ask the architect via your report instead): `Animator.ts`, `CameraRig.ts`, `MatchController.ts`, `HUD.ts`, `Effects.ts`, `botProfiles.ts`, `config/animals.ts`, other animals' files. Need a helper from `Effects`? Build it inside your own `ultFx/<animal>.ts` with THREE directly.
