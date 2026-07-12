# GLADIATOR KINGDOM — Handoff Document

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

**PROJECT BUILD COMPLETE (2026-07-13).** Remaining: human playtest (audio mix, pointer-lock feel, player-landed hitmarker, LMB spectate cycle), then — only with the user's explicit go-ahead — commit + push to publish via GitHub Pages (repo Settings → Pages → Source = "GitHub Actions" must be set once). Optional polish: vite manualChunks to split the 729 kB three.js chunk.

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
