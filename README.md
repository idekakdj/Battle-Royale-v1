# Gladiator Kingdom

A browser battle royale in a Roman colosseum: you and nine animal gladiators
enter the arena, one leaves. Third-person melee combat, procedural everything —
no downloaded assets, no textures, no audio files. Built with TypeScript,
Three.js, and the Web Audio API.

## The Gladiators

| Animal    | Style                                                        | Ultimate (Q)                                                                                                     |
| --------- | ------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------- |
| Lion      | Balanced brawler, the classic all-rounder                    | **Royal Hunt**: lock on, pounce and pin, four guard-piercing mauls, then a roar that marks the victim            |
| Gorilla   | Heavy bruiser with bone-rattling slams                       | **Boulder Hurl**: rip up a slab and throw it in a dodgeable arc for a heavy hit and splash                       |
| Crocodile | Ambusher whose death-roll grab shreds anything it catches    | **Death Roll**: lunge, clamp the locked foe and spin it through a three-revolution roll                          |
| Hippo     | Deceptively fast tank that charges through the line          | **Riverlord's Flood**: a wave surges down a marked line, then leaves slowing mud                                 |
| Rhino     | Armored freight train, get out of the charge lane            | **Seismic Stampede**: a homing charge that gores, carries and crushes its target against a wall                  |
| Eagle     | Aerial skirmisher; takes to the sky and dives untargetable   | **Death From Above**: climb out of sight, track and commit on a locked foe, then stoop onto the marked circle    |
| Panther   | Stealth assassin that vanishes and strikes from behind       | **Shadow Execution**: melt into shadow, five shadow-step strikes, then an executing finisher from behind        |
| Python    | Constrictor whose coil-crush grab drains the life out slowly | **Coil Snare**: a tether yanks the locked foe in for a binding squeeze and a crush                               |
| Giraffe   | Long-reach kickboxer controlling space from above            | **Timber Fall**: a tracking circle commits under the foe, then the neck comes down like a felled tree            |
| Mole      | Tunnels underground, untargetable, and erupts beneath you    | **Sinkhole Vortex**: tunnel to a pit that drags fighters to the centre, grinds them, then collapses and roots   |

Every fighter has a 3-hit combo, a special (Shift), a block/guard system, and
an ultimate (Q) that charges from dealing and taking damage (lock-on ultimates
need a foe in range and spend nothing otherwise). Pickups (heal /
speed / rage) spawn on pads; crates break for cover chaos; a bloodlust
multiplier ramps damage as the match drags on so nobody can hide forever.

## Controls

| Input        | Action                                    |
| ------------ | ----------------------------------------- |
| WASD         | Move (camera-relative)                    |
| Mouse        | Camera (click the arena for pointer lock) |
| LMB          | Attack (chains into combos)               |
| RMB (hold)   | Block                                     |
| Shift        | Special ability                           |
| Q            | Ultimate (when charged)                   |
| Space (hold) | Jump / glide (eagle soars)                |
| E / MMB      | Lock on to a rival (toggle)               |
| Tab          | Switch to the next nearest target         |
| Esc          | Pause                                     |
| F11          | Fullscreen (desktop app)                  |

Gentle aim assist nudges swings and specials toward an enemy right in front of
you. Graphics quality (Auto / Low / Medium / High) and mouse sensitivity are in
**Settings** (lobby or pause menu).

While spectating after death: LMB or Tab cycles the fighter you're watching.

## Difficulty

Four tiers, from **1 — Cub** (forgiving bots with slow reactions) up to
**4 — Apex** (ruthless kiting, near-instant punishes). Your last pick is
remembered between sessions.

## Development

```bash
npm ci          # install
npm run dev     # Vite dev server (http://localhost:5173)
npm run build   # production build → dist/
npx vitest run  # simulation + AI test suite
npx tsc --noEmit # typecheck
```

### Module demos

Each work package ships a standalone demo, auto-discovered from `*.demo.ts`
files — append `?demo=<name>` to the dev URL:

| Flag            | Shows                                             |
| --------------- | ------------------------------------------------- |
| `?demo=arena`   | Stadium, crowd, camera rig, and effects sandbox   |
| `?demo=animals` | All ten procedural rigs and their animation poses |
| `?demo=ui`      | Every menu/HUD screen with mock data              |
| `?demo=audio`   | Synthesized SFX, roars, crowd, and music board    |

## Tech notes

- **All procedural.** Animal bodies are articulated Three.js primitives
  (~512–846 tris each); the stadium is merged flat-shaded geometry with an
  instanced crowd; every sound — roars, swings, crowd, music — is synthesized
  at runtime with the Web Audio API.
- **Deterministic simulation.** The match sim runs on a fixed 60 Hz timestep
  with a seeded `mulberry32` RNG; the same seed and inputs replay the same
  match. Rendering interpolates between sim ticks.
- **One intent interface.** Player input and bot brains drive fighters through
  the same `FighterIntent` — the sim can't tell who is human.
- **Event-driven glue.** Sim gameplay events flow over one typed EventBus into
  the renderer's effects, the HUD, the bot perception layer, and the audio
  engine.

## Desktop app

Gladiator Kingdom also ships as an installable **Windows desktop app** (Electron), built from the
same `dist/`.

**Players:** download the latest `Gladiator-Kingdom-Setup-<version>.exe` (installer) or
`Gladiator-Kingdom-<version>-win-x64.zip` (portable) from
[Releases](https://github.com/idekakdj/Battle-Royale-v1/releases) — every past version stays
available there. The installer is per-user (no admin prompt), lets you pick the folder, and adds
Desktop + Start Menu shortcuts; uninstall via Windows Settings → Apps. The builds are unsigned, so
SmartScreen may warn on first run: **More info → Run anyway**. In the app, F11 toggles fullscreen,
Esc pauses as usual, and the lobby's **What's New** button shows the full version history (it also
opens once automatically after an update). The app can notify you when a newer release exists —
it never downloads anything by itself; turn it off in Settings → Desktop.

**Developers:**

```bash
npm run desktop        # build, then run the app in Electron (loads dist/)
npm run desktop:dev    # Vite dev server + Electron with hot reload (F12 = DevTools)
npm run dist:dir       # unpacked app → release/win-unpacked/ (fast)
npm run dist           # NSIS installer + portable zip → release/
npm run desktop:smoke  # boot release/win-unpacked with --smoke-test (prints SMOKE OK)
npm run release:notes  # changelog section for the current version (GitHub Release body)
npm run icons          # regenerate build/icon.png + build/icon.ico procedurally
```

The version lives only in `package.json`; the history lives only in [`CHANGELOG.md`](CHANGELOG.md).
Pushing a `vX.Y.Z` tag builds and publishes a release via `.github/workflows/release.yml` — see
[`docs/RELEASING.md`](docs/RELEASING.md) for the full checklist, signing, and troubleshooting.

## Deployment

Pushes to `main` build and publish `dist/` to **GitHub Pages** automatically
via `.github/workflows/deploy.yml` (Node 20, `npm ci && npm run build`,
`actions/deploy-pages`). Enable Pages → "GitHub Actions" as the source in the
repository settings once.
