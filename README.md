# Gladiator Kingdom

A browser battle royale in a Roman colosseum: you and nine animal gladiators
enter the arena, one leaves. Third-person melee combat, procedural everything —
no downloaded assets, no textures, no audio files. Built with TypeScript,
Three.js, and the Web Audio API.

## The Gladiators

| Animal    | Style                                                        |
| --------- | ------------------------------------------------------------ |
| Lion      | Balanced brawler — the classic all-rounder                    |
| Gorilla   | Heavy bruiser with bone-rattling slams                        |
| Crocodile | Ambusher whose death-roll grab shreds anything it catches     |
| Hippo     | Deceptively fast tank that charges through the line           |
| Rhino     | Armored freight train — get out of the charge lane            |
| Eagle     | Aerial skirmisher; takes to the sky and dives untargetable    |
| Panther   | Stealth assassin that vanishes and strikes from behind        |
| Python    | Constrictor whose coil-crush grab drains the life out slowly  |
| Giraffe   | Long-reach kickboxer controlling space from above             |
| Mole      | Tunnels underground, untargetable, and erupts beneath you     |

Every fighter has a 3-hit combo, a special (Shift), a block/guard system, and
an ultimate (Q) that charges from dealing and taking damage. Pickups (heal /
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
| Esc          | Pause                                     |

While spectating after death: LMB cycles the fighter you're watching.

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

## Deployment

Pushes to `main` build and publish `dist/` to **GitHub Pages** automatically
via `.github/workflows/deploy.yml` (Node 20, `npm ci && npm run build`,
`actions/deploy-pages`). Enable Pages → "GitHub Actions" as the source in the
repository settings once.
