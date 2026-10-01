# Phase-3 TODO (architect; collected from agent reports, 2026-09-30)

Do after all ten Phase-2 animals have landed and the suite is green.

## Must-do before release
1. **Full-suite + full balance pass** with all ten new ultimates: `N=60 LEVELS=1,2,3,4 npm run balance` (and N=200 L3/L4). Bands: L3/L4 ≈ 4–18% win rate, L1/L2 ≤ ≈ 30%, 0 timeouts, ~1 ult/fighter/match. Watch: lion L3 (3–4%), crocodile L3/L4 (3–6%), giraffe L4 (13–22% noise), hippo at L4 (historically weak), eagle L3 (12–20%). Retune the animal's own config only (`src/config/ultimates/<animal>.ts`).
2. **HUD ability icons** (`src/ui/abilityIcons.ts`): still draws the OLD Primal Rampage fist (~line 41) and Guillotine blade (~line 136) and other old ultimates — redraw/relabel the 10 ultimate glyphs for the new designs (Royal Hunt, Boulder Hurl, Death Roll, Riverlord's Flood, Stampede, Death From Above, Shadow Execution, Coil Snare, Timber Fall, Sinkhole Vortex). Names/descriptions themselves come live from config.
3. **First-person ultimate pass** (see `docs/ultimates/fp-notes.md`): per-ult camera/viewmodel behaviour in `src/render/animals/fp/<animal>.ts` (low/zero `follow` for `ultimate` when the head heaves; look-at easing; view kicks; own-VFX near-fade for column/sphere effects).
4. **Generic `Effects.onUltimate` light column/flash** whitewashes close framings for ~1 s (Gorilla agent): tone down or disable now that every animal has its own ultimate VFX; keep a subtle accent pulse.
5. **Knockdown clock bug** (Lion agent): `World` never advances `actionT/actionDur` for a knocked-down fighter, so the knockdown fall/rise pose never animates for any victim. Give `knockdown` a real clock in `World` (and verify the lion pin workaround still behaves, and the FP knockdown view).
6. **Dead code/stale tests:** stealth-crit code path in `CombatSystem` (Night Prowl removed; `stealthCritPending` never set) and the trivially-passing "Night Prowl crit" test in `tests/sim/v11-fixes.test.ts` — remove/replace.
7. **Text/UX check:** character-select move list shows each new ultimate's name/description — verify they fit; update README/BLUEPRINT §8 ult table + `docs/BALANCE.md` (v1.3 section) from `docs/ultimates/<animal>.md`.
8. **Real-match QA** at all 4 difficulties with every animal (incl. spectate, pause, rematch, first person on/off), zero console errors at all quality tiers, bots never stuck casting; CHANGELOG 1.3.0; version bump; `npm run dist`; install over the user's copy; commit + push (no tags).

## Nice-to-have
- Bots mid-melee/mid-special never dodge committed zones (existing behaviour) — so hippo/lion bots often eat the boulder; consider letting L3/L4 interrupt a melee swing to dodge.
- L1 gorilla casts only ~0.5 ult/match (2.5–10 m window rarely met by Cub bots).
