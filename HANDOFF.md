# GLADIATOR KINGDOM — Handoff Document

> ## v1.1.0 BUILT & VERIFIED (2026-09-29) — NOT YET COMMITTED/TAGGED/PUSHED (waiting on the user's go-ahead)
> **Current state:** all four workstreams done and architect-verified: `npx tsc --noEmit` 0 · `npx vitest run` 146/146 · `npm run build` OK · `npm run dist` produced `release/Gladiator-Kingdom-Setup-1.1.0.exe` (98.2 MB) + `Gladiator-Kingdom-1.1.0-win-x64.zip` (134.8 MB) (1.0.0 artifacts sit beside them; `release/` is git-ignored) · packaged-app `npm run desktop:smoke` PASS (version=1.1.0, match starts). package.json is at **1.1.0**, CHANGELOG.md has a dated `[1.1.0] - 2026-09-29` section + empty `[Unreleased]`. Installers are UNSIGNED (SmartScreen "Run anyway"). **Remaining steps, only after the user says go:** commit everything (`git add -A`; nothing has been committed for v1.1) → push `main` (redeploys the Pages web build) → `git tag v1.1.0` → `git push origin v1.1.0` (release.yml builds + publishes the GitHub Release; repo must be public for the in-app update check to see it; repo Settings → Pages Source = "GitHub Actions" once). Ideas not done: a human playtest of mouse-look/lock-on/aim-assist feel and F11 (pointer lock can't be granted in agent tooling), code-signing certificate, mid-match hit-stop, hippo is a soft 5% at L4 (see docs/BALANCE.md).
> Known tooling quirks: Browser-pane `requestAnimationFrame` is throttled to 0 — shim it with setTimeout before testing live matches; screenshots sometimes crop to the top-left quarter (verify HUD via DOM rects/computed styles instead).
> **WP-M (HUD/UX/controls) DONE:** ability icons (20 SVG glyphs) + cooldown/ult ring, enemy nameplates, threat arrows + damage wedge, lock-on (E/MMB, Tab cycle) + soft aim assist (`src/match/aimAssist.ts`, pure + tested), settings (graphics quality Auto/Low/Medium/High, mouse sensitivity), seeded bot seating (`src/match/seating.ts`). Architect verified in-browser: nameplates on all rivals, spectate HUD, results screen, live quality switching low/high, zero game console errors; fixed ability caption legibility (11px, brighter).
>
> ### (History) v1.1 plan — `docs/UPGRADE-PLAN-v1.1.md`
> The user asked for: a review + gameplay improvements + graphics improvements + a downloadable Windows desktop app/installer with version history. The plan doc holds the review findings (balance sweep table, visual review, UI gaps) and a full spec per workstream:
> - **WP-J Gameplay & Balance** (sim/ai/config/tests) — **DONE & architect-verified** (tsc 0, 126/126 tests, `N=60 LEVELS=3,4 npm run balance`: every animal 5–17% wins at L3, 5–13% at L4, 0 timeouts, ~1.1 ults/fighter/match, L3/L4 matches ~95 s instead of ~160 s). Full details + per-animal old→new numbers in `docs/BALANCE.md`. Key changes: giraffe nerfed (reach 4.0→3.4, arc 140→100, HP 1050→930), croc/panther/mole/eagle buffed, ult charge also from damage taken, aimed abilities snap to the aimed enemy, 4 AI stall bugs fixed, Cub bots hesitate between swings. NOTE sweep now shuffles spawn seats (SEATS=fixed = old method).
> - **WP-K Graphics** (src/render/**) — **DONE & architect-verified visually** (tsc 0, build OK, zero console errors; measured 71–95 draw calls / ~110k tris; quality tiers low/medium/high via `src/render/quality.ts` `setQualitySetting()`, localStorage `gk-quality`; all 10 animals rebuilt as baked skinned meshes; torches/braziers/bloom/colour grade; camera wall fix; damage numbers scaled). Known: Browser-pane rAF is throttled to 0 fps in agent tooling (shim `requestAnimationFrame` with setTimeout to test live matches).
> - **WP-L Desktop app / installer / version history** (electron/, package.json, CHANGELOG.md, release workflow) — **DONE & architect-verified** (tsc 0, 104 tests, packaged-exe `npm run desktop:smoke` PASS; `npm run dist` → `release/Gladiator-Kingdom-Setup-1.0.0.exe` 98 MB + portable zip 135 MB). Notes: Node 22 in both workflows (deploy.yml bumped by architect); OneDrive EPERM workaround in `scripts/dist.mjs`; installers unsigned (SmartScreen); `three` moved to devDependencies. Releasing: edit CHANGELOG → `npm version X.Y.Z --no-git-tag-version` → commit → tag `vX.Y.Z` → push tag (see docs/RELEASING.md). Update check will 404 until the first public GitHub Release exists.
> - **WP-M HUD/UX/controls** — DONE (see above).
> - Wave 3 (architect) — DONE except commit/tag/push (user consent pending).
> Check `git status` + which files exist per workstream before re-launching anything; agents write files continuously so partial work survives cutoffs. Use lean write-first prompts pointing at the plan doc sections (see memory: opus-subagent-write-first-pattern). Screenshots WORK in the Browser pane after `resize_window 1280x720`. Tool: `npm run balance` (headless roster sweep).

---


**Purpose:** if the supervising architect session is cut off, a fresh agent session must be able to finish the project from this file alone. Read this fully, then read `docs/BLUEPRINT.md` (the binding spec) and `docs/INTEGRATION-NOTES.md` (per-module APIs and wiring duties) before writing any code.

**Last updated:** 2026-07-11, after WP-C sources+tests landed on disk (verification pending).

---

## 1. What this project is

A browser PvE battle royale: 10 real-animal gladiators (player picks 1, bots play the other 9) fight FFA in a 3D colosseum. Three.js, TypeScript strict, Vite, zero runtime deps beyond `three`, all assets procedural (models, audio, icons). Deploy target: GitHub Pages static site. Full design — stats, damage pipeline, bot difficulty 1–4, arena, UI, audio — is pinned in `docs/BLUEPRINT.md` (§ numbers below refer to it).

## 2. Build status

| WP | Module | Status |
|---|---|---|
| A | Foundation (scaffold, core loop, types, input, ALL config data) | ✅ complete, verified |
| B | Simulation `src/sim` + `tests/sim` | ✅ complete, 59/59 vitest green (independently re-run), tsc clean |
| D | Stadium/Camera/Effects `src/render/*.ts` | ✅ complete, browser-verified, 11–14 draw calls / 39.2k tris |
| E | Animal rigs/anim `src/render/animals`, `src/render/preview.ts` | ✅ complete, impact timing u=0.550 exact, 512–846 tris each |
| F | UI `src/ui`, `src/styles/ui.css` | ✅ complete, browser-verified all screens |
| G | Audio `src/audio` | ✅ complete, browser-verified (74 sounds, zero errors) |
| C | Bot AI `src/ai` + `tests/ai` | ✅ complete, 65/65 vitest green repo-wide (verified independently), L4-vs-L1 100% |
| I | Integration `src/match/MatchController.ts`, main.ts wiring, deploy workflow, README | ✅ complete — 4 full matches played through in-browser, zero console errors; architect re-verified tsc 0 / 65-65 / build OK |

**PROJECT BUILD COMPLETE (2026-07-13).** Remaining: human playtest (audio mix, pointer-lock feel, player-landed hitmarker, LMB spectate cycle), then — only with the user's explicit go-ahead — commit + push to publish via GitHub Pages (repo Settings → Pages → Source = "GitHub Actions" must be set once).

**Post-completion fixes (2026-07-13, architect):**
- User-reported A/D strafe inversion fixed in `src/input/InputManager.ts` — camera-right basis was negated; correct right = forward × up = (−cos yaw, sin yaw). W/S were already correct.
- Same wrong basis fixed in `src/render/CameraRig.ts` shoulder offset (was left-shoulder framing; now right-shoulder per Fortnite-style intent).
- `vite.config.ts`: manualChunks splits three.js into its own cacheable chunk (game code 228 kB / three 500 kB); build verified.
- All re-verified: tsc 0, game boots clean. Strafe FEEL confirmation pending from the user (pointer lock unavailable in the agent environment). If the user reports mouse-look or other mirroring, audit the same yaw-basis convention at the reported site.

**Architect QA sweep (2026-07-13), two gameplay bugs found & fixed:**
1. `src/styles/ui.css` — the full-screen `.gk-hud` (direct child of #app) was forced to `pointer-events:auto` by base.css's higher-specificity `#app > *` rule, eating every click → pointer lock could never be (re)acquired mid-match. Fixed with an id-qualified `#app > .gk-hud` selector. Verified live: HUD computes `none`, `elementFromPoint(center)` = #gk-canvas, pause menu still clickable (Esc→Resume cycle works).
2. `src/input/InputManager.ts` onMouseDown — the pointer-lock-acquiring click also fired an attack edge; mouse buttons are now ignored while unlocked (LMB's job unlocked = capture). Spectate LMB-cycling unaffected (lock persists through death).
Also swept & found sound: rematch teardown (no bus/rig/WebGL leaks), resize (SceneManager self-subscribes), countdown/spectate/pause edge cases, results plumbing, main.ts flow/seeding/music. Post-sweep: tsc 0, 65/65 tests, build OK, zero console errors through lobby→match→pause→resume.

Whole-repo checks last run by the architect (before WP-C files landed): `npx tsc --noEmit` exit 0, `npm run build` OK, `npx vitest run tests/sim` 59/59.

## 3. Immediate next steps (in order)

1. **Finish WP-C verification**: `npx tsc --noEmit` and `npx vitest run tests/ai` (also confirm `tests/sim` still green). Fix failures — debug the AI, not the sim (sim is spec-verified; if a sim change seems needed, re-check against §7/§8 first). Acceptance (§14 WP-C): L1 and L4 10-bot matches reach `matchEnd` < 240 s sim-time without errors; L4-driven fighters beat L1-driven in ≥80% of 20 seeded mixed matches; reaction-delay honored; deterministic per seed. Public API intended: `BotManager(bus, difficulty, seed)` + `update(snapshot, dt)` + `getIntent(fighterId)` — confirm exact surface by reading `src/ai/index.ts`/`BotManager.ts`.
2. **WP-I Integration** — build `src/match/MatchController.ts` and wire `src/main.ts`. Complete duty list in `docs/INTEGRATION-NOTES.md` (READ IT — every module's exact signatures + the cross-module obligations, e.g. kill-roars, bloodlust cheers, crate-break piping, preview factory hookup, countdown = negative `snapshot().time`). Screen flow per §3: Lobby → CharacterSelect → DifficultySelect → Match (3-2-1 countdown → fight → spectate-on-death via LMB cycle) → Results (REMATCH / CHANGE GLADIATOR / LOBBY). Match loop shape: `GameLoop.step`: InputManager.getIntent(cameraRig.yaw) → world.setIntent(0, …); botManager.update(snapshot, dt) → setIntent per bot; world.step(dt). `GameLoop.render`: interpolate last two snapshots → rig.update per fighter → effects/stadium/camera update → HUD.update. EventBus: single bus shared by World, BotManager, AudioEngine.attachBus, and the effects/HUD piping listed in the notes. Pause (Esc): pause GameLoop, show PauseMenu, exit pointer lock.
3. **Deploy**: `.github/workflows/deploy.yml` (checkout → setup-node → npm ci → npm run build → upload dist → deploy-pages; `vite.config.ts` already has `base:'./'`). Write `README.md` (what it is, controls §4, roster summary, dev commands, deploy note). **Do not `git push` without the user's confirmation** — pushing publishes via Pages. The user has been making local commits themselves; don't rewrite history.
4. **Final QA**: `npm run build` + `npm run preview`; play a full match at difficulty 1 and 4; all four demos (`?demo=arena|animals|ui|audio`) still load clean; 60 fps with 10 fighters; no console errors. Fix, re-verify, report to user with the localhost URL and (only after user confirms push) the Pages URL.

## 4. How the work has been run (and why)

- Coding is delegated to **Opus subagents** (user requirement); the architect supervises, verifies claims independently, and corrects. One package = one agent = exclusive file ownership (§14 table).
- **Session-limit pattern:** long agent transcripts die repeatedly to 5 h usage-limit cutoffs and waste each new window re-loading their own history. Lesson learned (twice): spawn a FRESH agent with a lean, self-contained, write-first prompt (all key numbers inlined, minimal reading list, "write files in survivable order, verify only at the end"). WP-B succeeded this way in one window after 4 failed resume rounds; WP-C likewise after its first stall. If continuing WP-C/WP-I with a fresh agent, follow that pattern.
- Parallel agents share one working tree with disjoint paths — safe. Only WP-A ever touched package.json / ran npm install.
- Browser verification: dev server via the `dev` config in `.claude/launch.json` (also `dev-audio`, `dev-arena` on other ports). NOTE: screenshot capture times out on these pages in the preview browser — verify via `get_page_text`, console messages, and server logs instead.

## 5. Repo facts a fresh session needs

- Windows 11, repo at `C:\Users\paulc\OneDrive\Documents\GitHub\Battle-Royale-v1`, git repo, branch `main`, user commits sporadically (messages like "e").
- Commands: `npm run dev` / `build` / `preview` / `test` (vitest) / `typecheck`.
- Demos: `?demo=arena|animals|ui|audio` (auto-discovered `*.demo.ts` via `registerDemo`; no main.ts edits needed).
- Coding standards (§15): TS strict, no `any` in exports, no per-frame allocations in hot paths, every tunable in `src/config/`, sim/ imports no three/DOM, determinism via `mulberry32` only inside sim/ and ai/.
- Balance intent (§8 table is authoritative): tanks hippo/rhino/croc ~1150–1300 HP low DPS, assassins eagle/panther 700–750 HP ~120 DPS; ults cost 100 charge earned only by landed basics (+8/+8/+14, halved if blocked).
- Deviations already approved: telegraph windups 0.35/0.5 s defaults in config; stealth opacity 0.22; grab ults as continuous drain; aimed ground abilities land at max range along aimYaw; sim movers' speeds in `src/sim/simTuning.ts`.

## 6. Definition of done

Lobby-to-results loop playable with all 10 animals present, chosen difficulty 1–4 driving visibly different bot skill, block/ult/special/pickup mechanics live, spectate on death, results stats accurate, 60 fps, zero console errors, `tsc` clean, all vitest suites green, production build served statically works, deploy workflow present, README written. Then ask the user before pushing/publishing.
