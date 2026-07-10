# Integration notes for WP-I (accumulated from agent reports)

Maintained by the architect as work packages complete. WP-I must read this file.

## From WP-A (Foundation) — COMPLETE
- Contracts in `src/core/types.ts` (FighterIntent, FighterState, WorldSnapshot, GameEvent, MatchConfig, Difficulty). Sim/AI RNG: `mulberry32` from `core/math.ts` only.
- `InputManager.getIntent(cameraYaw)` returns a reused FighterIntent (edges consumed once/tick); `consumeMouseDelta()` feeds the camera rig; `onPause` fires on Esc or pointer-lock loss.
- Demos auto-discovered via `*.demo.ts` + `registerDemo`; `?demo=<name>`; no main.ts edits needed for demos.
- `GameLoop` drives `step(FIXED_DT)` + `render(alpha, dtRender)`.
- Telegraph windups (not in §8 for most abilities) live in animals.ts: SPECIAL_WINDUP=0.35, ULT_WINDUP=0.5 — single retune point.
- Ability magnitudes are structured fields (EffectSpec/AbilitySpec/etc.) — read numbers, never parse description strings.

## From WP-G (Audio) — COMPLETE, verified in browser (zero console errors)
- `new AudioEngine()` installs its own one-time gesture unlock; `attachBus(bus)` maps all GameEvents automatically (hit/blocked/guardBreak/death/ultimate/special/pickup/telegraph/comboFinisher/crateBreak/matchEnd).
- WP-I responsibilities the event map can NOT cover:
  1. On kill: call `audio.roar(killerAnimal)` (death event lacks the killer's animal).
  2. On each bloodlust step: call `audio.crowdCheer(true)` (no GameEvent for it).
  3. Match start: `startCrowd()` + optional per-fighter `roar()`; teardown: `stopCrowd()`.
  4. Crowd intensity: `setExcitement(x)` baseline / `spikeExcitement(a)`; kills/ults auto-spike via bus.
- Music: `playLobbyMusic()/stopMusic()` (lobby only, none mid-match), `playResultsFanfare(victory)`.
- Settings: engine READS localStorage `gk-settings` ({master,music,sfx:0..1,muted}) but never writes; UI owns persistence; call `reloadSettings()` or the setters when UI changes them.
- `.claude/launch.json` has `dev` / `dev-audio` preview configs added by WP-G.

## From WP-F (UI) — COMPLETE, verified in browser (zero console errors)
- Import everything from the barrel `src/ui/index.ts` (it also imports ui.css; index.html/main.ts untouched).
- Boot wiring: call `setPreviewFactory(createPreview)` once (from `src/render/preview.ts`) — UI never imports render/ itself; without it a styled SVG fallback shows.
- Screen constructors (all take callback options, all implement core `Screen`):
  - `new Lobby({ onPlay, onGladiators?, getSelectedAnimal, onSettingsChange? })`
  - `new CharacterSelect({ initialAnimal?, onConfirm(animal), onBack?, onSelectionChange? })`
  - `new DifficultySelect({ initialDifficulty?, onStart(difficulty), onBack? })`
  - `new Results({ results: MatchResults, onRematch, onChangeGladiator, onLobby })` where `MatchResults = { victory, placement, animal, kills, damageDealt, damageBlocked, ultsUsed, matchTimeS, difficulty }`
- HUD (not a Screen): `mount(root)/unmount()`, `update(snapshot, playerId)` each render frame, plus WP-I-called: `killFeed({killerAnimal, victimAnimal, killerIsPlayer?, victimIsPlayer?})`, `bloodlust(mult)`, `hitmarker()`, `countdown(3|2|1|'FIGHT')`, `setSpectate({name, animal} | null)`.
- PauseMenu (not a Screen): `new PauseMenu({ onResume, onQuitToLobby, onSettingsChange? })`, `mount/unmount`, `.open`.
- `onSettingsChange(s)` fires from settings panels → forward to `audio.setVolumes/setMuted` (UI persists `gk-settings` itself).
- localStorage: `gk-settings`, `gk-animal` (validated, default lion), `gk-difficulty` ("1"–"4", default 2).
- HUD controls-hint uses sim time (snapshot.time > 10), pause-safe. Buff kinds render as labeled chips.

## From WP-D (Stadium & FX) — COMPLETE, verified in browser (zero console errors; 11–14 draw calls, 39.2k tris, 1330 crowd)
- `new SceneManager(canvas)`: `.scene/.camera/.renderer`, `.excitement` (0–1 settable), `.render()`, `.resize()`, `.getStats()`, `.dispose()`.
- `new Stadium()`: add `.root` to scene; `.update(dt, excitement)` each frame; `.breakCrate(id)` (id = config CRATES order) + `.isCrateAlive/.resetCrates`; `.setPickupVisible(padIndex, kind, visible)`.
- `new CameraRig(camera, opts?)`: `.yaw` (public — feed to InputManager.getIntent), `.applyMouseDelta(dx,dy)` from InputManager.consumeMouseDelta(), `.follow(getTargetPos(out), headHeight)` (new fn ⇒ 0.5 s blend — use for spectate switching), `.setSpectate(on)`, `.shakeSource = () => effects.getShakeOffset()`, `.update(dt)`, `.snap()`.
- `new Effects(scene)`: `onSwing(pos,yaw,range,arcDeg,friendly?)`, `onHit(pos,damage,{blocked?,crit?})`, `onGuardBreak`, `onDust`, `onDeath(pos,accent?)`, `onUltimate(pos,animal)`, `telegraph(kind,pos,radius,yaw,arcDeg,windup,friendly,width?)`, `addShake`, `update(dt)`.
- Event piping: hit→onHit(e.pos,e.damage,{crit:e.heavy}) · blocked→onHit(...,{blocked:true}) · telegraph→telegraph(...) · ultimate→onUltimate · crateBreak→stadium.breakCrate(e.crateId)+onDust.
- Rect telegraphs: event radius = forward length, width param default 2.6 — map rhino/hippo charge telegraphs to kind 'rect'.
- Camera collision ignores ≤1 m obstacles (floor-clamped anyway). `.claude/launch.json` gained `dev-arena` (port 5301).

## From WP-E (Animals & Animation) — COMPLETE, verified (tsc clean repo-wide; impact at u=0.550 exact; 512–846 tris/animal)
- `AnimalFactory.create(animal): AnimalRig` (§5.1 contract) — or `AnimalFactory.createRig(animal): BaseRig` when you need `.dispose()`.
- `rig.update(state: FighterState, dtRender)` derives everything from state; caller sets root pos/yaw from interpolated sim state.
- `createPreview(canvas, animal)` from `src/render/preview.ts` → pass to UI's `setPreviewFactory()` at boot (signatures already match).
- Stealth opacity constant STEALTH_OPACITY=0.22 (readability deviation, approved). Mole underground = `burrowed` action; emerge pose = `special` with burrowT>0.
- Demo `?demo=animals`; keys 1..0 select, Q/W/E/R/T/Y/U/I/O/P actions, A auto-cycle.

## From WP-B (Simulation) — pending
## From WP-C (Bot AI) — pending
## From WP-D (Stadium & FX) — pending
## From WP-E (Animals & Animation) — pending
## From WP-F (UI) — pending
