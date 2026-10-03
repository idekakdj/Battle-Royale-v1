# Changelog

All notable changes to Gladiator Kingdom are documented in this file. The
in-game **Version History** panel and the GitHub Release notes are generated
from it, so every player-facing change belongs here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).
Use the sections `Added`, `Changed` and `Fixed` (plus `Removed` when needed),
newest version first.

## [Unreleased]

<!--
  Add bullets for the next release under ### Added / ### Changed / ### Fixed.
  When cutting a release, rename this heading to `## [x.y.z] - YYYY-MM-DD`
  and start a fresh empty `## [Unreleased]` block above it (docs/RELEASING.md).
-->

## [1.4.1] - 2026-10-03

### Added
- **Moves overview on the Champions League fighter-select screen.** Pick a fighter and switch the right-hand panel to **MOVES** (or press M) to see every button combination and what it does: Light and Heavy with nothing held, Side, Down and Up (for example Down + Light, Up + Heavy). Each move shows its name, a one-line description, how fast it is, how much damage it does and tags such as Kill move, Recovery, Armor, Spike, Multi-hit and Launcher, plus a note when the move behaves differently in the air. Below the grid you get the three-hit light string and a few facts about that fighter (best knockout move, recovery rank, jumps, weight). It updates as you move between fighters.

## [1.4.0] - 2026-10-03

### Added
- **Champions League, a brand-new platform-fighter mode** (Lobby → Champions League). Fight 1–3 rivals in a side-view brawl like Brawlhalla or Smash: every hit raises the victim's damage percent, and the higher it is, the farther the next hit launches them. Get knocked past the edge of the map and you lose a stock; the last fighter standing wins. Pick your gladiator, a map, how many opponents (1–3), bot level (Cub to Apex), stocks (1–5) and a time limit.
- **All ten animals have a reworked moveset for the mode:** light and heavy attacks in four directions (neutral, side, down, up), aerial versions of every move, a three-hit light string, double jumps (the Eagle flaps three times and can glide), dodges (spot, roll and air), ledge grabs and a recovery move. Each animal plays differently: the Gorilla and Hippo have armoured, slow, huge-knockback heavies; the Eagle is light with the best recovery; the Panther dashes through foes; the Giraffe and Python out-range everyone; the Mole drills and burrows.
- **Two new maps:** *Broken Colosseum* (a floating slab of colosseum floor with three broken-beam tiers at golden hour) and *Sky Aqueduct* (two floating aqueduct islands over open sky, a drifting platform across the gap and waterfalls spilling into the clouds). Both have a dynamic camera that zooms to keep every fighter in view.
- **New graphics for the mode:** hit sparks sized by damage, launch trails, KO blasts at the edge of the map, respawn laurel rings, a damage-percent HUD with stock pips, KO banners, a 3-2-1-FIGHT countdown, off-screen arrows, and an F3 hitbox overlay.
- **Smooth, readable attack animations:** every move has a visible wind-up, a strike that lands exactly when the hitbox becomes active, and a follow-through, built for each animal's body (jaws, claws, horns, tails, wings, necks and coils).
- **Four bot levels for the new mode**, from button-mashing Cubs who often fall off the edge to Apex fighters that punish mistakes, edge-guard and recover reliably.
- Controls: A/D move, W/Space jump, S down (fast fall, drop through platforms), J or left click light attack, K or right click heavy attack, L or Shift dodge, Esc pause.

### Changed
- The Settings controls list now includes the Champions League controls.

## [1.3.2] - 2026-10-01

### Fixed
- **First-person ultimates no longer fill your screen** for the Lion, Gorilla, Giraffe, Mole, Python and Panther. While one of their ultimates runs, nothing of your own body is drawn in the middle of the screen, the limbs that remain are small and kept at the edges, the Gorilla's held boulder is no longer drawn in front of your face, and the Panther's ghost body no longer hides the target. Their normal first-person view is unchanged.

## [1.3.1] - 2026-10-01

### Added
- **FPS counter:** an optional readout at the top-right showing your frame rate and frame time, coloured green, amber or red. Turn it on in Settings → View → "Show FPS counter". It works in the lobby, menus and matches.

### Fixed
- **First person is no longer blocked by your own model** for the Crocodile, Hippo, Rhino and Eagle. Their head, snout, jaws, tusks, horn and beak are fully hidden (no more half-drawn jaws), the middle of the screen is always clear of your own body in every pose including jumping, attacking and ultimates, and the limbs and wings that remain are smaller and tucked into the screen edges. The Eagle now shows only its wingtips at the sides.

## [1.3.0] - 2026-10-01

### Added
- **First-person mode:** press V in a match to switch to a camera at your fighter's eyes (Settings has a view choice, a field-of-view slider and a crosshair toggle). You see what your animal would see: claws, jaws, beaks, wings and hooves swing into view while your own head and mane are hidden. The view stays level and steady however the body moves, and dying returns you to the normal spectator view.
- **Ten brand-new ultimates, each unique to its animal** (full multi-stage animations, effects and sounds):
  - **Lion, Royal Hunt:** lock on, pounce and pin a foe, maul them four times, then roar to mark them for extra damage.
  - **Panther, Shadow Execution:** melt into shadow and shadow-step around a foe for five slashes, then finish from behind. Extra execute damage under 35% health.
  - **Crocodile, Death Roll:** a low lunge, then clamp, drag and thrash the victim through three full death rolls before tossing them.
  - **Python, Coil Snare:** lash a coil tether that yanks the first foe it touches to you, then squeeze them.
  - **Giraffe, Timber Fall:** a circle tracks your target, then locks. The neck-hammer slam stuns, and anyone who leaves the circle dodges it.
  - **Eagle, Death From Above:** spiral out of sight while a red circle tracks a foe, then locks. Leave it in time and the stoop misses.
  - **Gorilla, Boulder Hurl:** rip a slab from the ground and throw it. It arcs through the air and can be dodged.
  - **Hippo, Riverlord's Flood:** a wave surges down a marked path and leaves a mud pool that slows everyone but the hippo.
  - **Rhino, Seismic Stampede:** a charge that homes on a locked foe, gores them and carries them on its horn, then crushes them against a wall.
  - **Mole, Sinkhole Vortex:** a tremor crack races across the ground and collapses into a vortex pit that drags grounded foes in.
- **Ultimate targeting:** with a full ultimate bar you see its range ring or path, and a gold LOCK bracket on the foe it would hit. Pressing Q with nothing in range now does nothing, shows "NO TARGET IN RANGE" and keeps your charge. It can be switched off in Settings (Ultimate targeting preview).
- **First-person camera for every ultimate:** the view tilts, kicks and settles with each ultimate's beats, never rolls or spins with the body, and effects around your eyes fade out instead of washing out the screen.

### Changed
- **Ultimate icons and names:** all ten ultimate icons were redrawn for the new designs, the HUD ability names no longer run into each other, and the character-select screen shows the icons next to each move.
- **Bots handle the new ultimates:** they only cast when a target is in range, and Fighter, Veteran and Apex bots sidestep the committed circles, paths and landing spots of enemy ultimates.
- **Knockdown, stagger, flinch and fear animations** now play for every victim, instead of freezing in place.
- The old shared ultimate flash was toned down to a subtle ring at the caster's feet.
- Panther's old stealth critical hit is gone, replaced by Shadow Execution.

### Fixed
- A black ellipse no longer covers the rotating gladiator in the lobby and character-select previews.

## [1.2.0] - 2026-09-29

### Added
- **Eagle flight:** hold Space in the air to glide, and keep holding to soar up to 6.5 m, out of reach of ground attacks. You can't attack while high up, and your flight recharges 8 seconds after you land.
- **Landing slam:** come down from a high flight to hit nearby foes for up to 40 damage and knock them back, but you are briefly off balance when you land.
- **Arena traps:** fire pits and spike plates are hidden around the arena: 2 on Cub, 3 on Fighter, 5 on Veteran and 7 on Apex. Step on one and it stays active for 8 seconds, burning or stabbing everyone inside, including whoever set it off. Blocking won't save you, and it re-arms after a cooldown.
- **Trap visuals and sound:** glowing rune rings and smouldering spike plates mark each trap, a red danger ring warns for the whole time it is active and blinks faster just before it ends, with roaring flames, clanking spikes and small orange damage numbers. Trap deaths show a flame or spike icon in the kill feed.
- **Attack range indicator:** an optional faint wedge on the ground shows your fighter's real reach (Settings → Combat).
- **Pickup messages:** grabbing a power-up flashes a quick "+250 HP / SPEED / POWER" message.

### Changed
- **Power-ups are unmistakable:** a green cross for Heal, a lightning bolt for Speed and crossed swords for Power, each with its own coloured light column, glowing pad ring and a name label as you approach.
- **Buffs and debuffs on the HUD** are clear icons with a countdown ring instead of text abbreviations.
- **What you see is what you hit:** basic attacks now connect with any body that overlaps your swing, and the swing trail shows exactly the zone that was tested, at the moment damage lands. Reach numbers are now measured to the enemy's body (Lion 1.5 m, Mole 1.3 m) and feel the same against a normal-sized foe.
- **Bots notice the traps:** Cubs blunder in, Fighters step out, and Veterans and Apex route around the plates. Apex will happily let you chase them into the fire. Veteran and Apex eagles now use the new flight to dodge.
- **Hippo** has more health and speed and a faster River Rush.
- Character cards label the attack range as "reach".

### Fixed
- **The eagle's glide** now spreads its wings fully with fanned feathers and tucked talons, and every flight stage is animated: climb flaps, a wide hover, a folded dive and a flared landing.
- Lion and Mole attacks no longer miss inside the drawn swing: the old trail was the same size for every animal and did not match the real hit zone.

## [1.1.0] - 2026-09-29

### Added
- **Windows desktop app.** Install Gladiator Kingdom and play it offline, or grab the portable zip. It has fullscreen (F11), remembers your window size and position, and can tell you when a new version is out.
- **Version History** panel in the lobby (What's New) listing every release; it opens by itself once after you update.
- **Graphics quality** setting (Auto / Low / Medium / High). Auto steps down a level if your frame rate stays low.
- **Cinematic look:** soft bloom on fire, sparks and ultimates, a warm colour grade and vignette, drifting clouds and a golden-hour sky.
- **A living arena:** flickering torches and braziers with real firelight, sunbeams, drifting dust, waving banners and flags, a detailed sand floor with an inlaid stone ring, and a stone wall built from blocks.
- **All ten gladiators remodelled** with real faces, solid legs, claws, horns and tusks, species markings and a crisp outline that keeps them readable against the sand. Fighters now cast shadows.
- **Heavier impacts:** ground cracks and dust rings on slams, footstep and landing dust, a blooming light column for ultimates and a subtle camera kick.
- **Comeback ultimates:** you now also build ultimate charge when you take hits (blocking doesn't reduce it), so a losing fighter still gets a big moment.
- **Enemy nameplates:** every rival shows their animal and a health bar above their head, fading with distance and flashing when their guard breaks.
- **Lock-on:** press E or middle mouse to lock onto a rival; the camera and your attacks follow them, Tab switches to the next nearest enemy, and a hard look away breaks the lock.
- **Aim assist:** your swings and specials are gently nudged toward an enemy right in front of you.
- **Threat cues:** red arrows at the screen edge warn of nearby enemies attacking from off screen, and a red arc shows which way a hit came from.
- **New settings:** graphics quality (changeable mid-match from the pause menu) and a mouse sensitivity slider.

### Changed
- **The Giraffe no longer rules the arena.** Slower, narrower neck swings, shorter (still the longest) reach and less health. It was winning over half of all bot matches.
- **Crocodile, Panther, Mole and Eagle were strengthened**, and Hippo, Rhino and Gorilla were retuned, so every animal now wins a fair share of matches at every difficulty.
- **Ultimates come around about three times as often** thanks to faster charging and the comeback charge.
- **Aimed abilities land where you aim:** Pounce, Silverback Leap, Death From Above and Sinkhole now drop onto the enemy you are aiming at instead of always flying to full range.
- **Cub bots are gentler:** they pause between swings and hesitate before using a full ultimate, giving new players breathing room.
- **Damage numbers** are sized to the hit, spread out and stack neatly instead of piling up in the middle of the screen.
- **Camera:** no more collapsing into your fighter next to the arena wall, and a higher, wider spectator view.
- Matches at the two hardest difficulties now finish in about a minute and a half instead of running to the time limit.
- **Bots take random seats** around the arena each match, so a rematch brings new neighbours.

### Fixed
- **Ability icons are back:** every gladiator's special (Shift) and ultimate (Q) now shows its own symbol, a cooldown countdown, a glow when ready, and the ultimate's charge percentage with a pulsing "Q READY".
- The Crocodile's Ambush Lunge now stops at its target, so the boosted bite connects.
- The Mole's +25% damage against rooted enemies now actually applies.
- The Panther's stealth crit no longer stays armed long after Night Prowl ends.
- Bots no longer get stuck on fallen columns or crate piles, stand idle, or kite forever.

## [1.0.0] - 2026-07-14

### Added
- Initial release: a ten-fighter battle royale in a Roman colosseum — you and nine bot gladiators enter the arena, one leaves.
- Ten animal gladiators, each with a 3-hit combo, a special ability (Shift) and a charged ultimate (Q): Lion, Gorilla, Crocodile, Hippo, Rhino, Eagle, Panther, Python, Giraffe and Mole.
- Blocking and guard system (hold RMB), plus an ultimate that charges as you land hits.
- Four bot difficulty tiers, from **1 — Cub** (slow reactions, forgiving) to **4 — Apex** (kiting, near-instant punishes); your last pick is remembered.
- Procedural colosseum arena with a stadium crowd, breakable crates and pickup pads for heal, speed and rage boosts.
- Bloodlust damage multiplier that ramps up as a match drags on, so nobody can hide forever.
- Spectate mode after you are knocked out (LMB cycles the fighter you are watching) and a results screen with rematch, change-gladiator and lobby options.
- Fortnite-style lobby with a 3D gladiator preview, character and difficulty select, pause menu and settings with master/music/SFX volume and mute.
- Fully synthesized Web Audio soundtrack and sound effects — roars, swings, impacts, crowd and music, with no audio files.
- Deterministic 60 Hz simulation with seeded RNG, and a shared intent interface that drives players and bots alike.
- Browser build deployed automatically to GitHub Pages on every push to `main`.

[Unreleased]: https://github.com/idekakdj/Battle-Royale-v1/compare/v1.4.1...HEAD
[1.4.1]: https://github.com/idekakdj/Battle-Royale-v1/compare/v1.4.0...v1.4.1
[1.4.0]: https://github.com/idekakdj/Battle-Royale-v1/compare/v1.3.2...v1.4.0
[1.3.2]: https://github.com/idekakdj/Battle-Royale-v1/compare/v1.3.1...v1.3.2
[1.3.1]: https://github.com/idekakdj/Battle-Royale-v1/compare/v1.3.0...v1.3.1
[1.3.0]: https://github.com/idekakdj/Battle-Royale-v1/compare/v1.2.0...v1.3.0
[1.2.0]: https://github.com/idekakdj/Battle-Royale-v1/compare/v1.1.0...v1.2.0
[1.1.0]: https://github.com/idekakdj/Battle-Royale-v1/compare/v1.0.0...v1.1.0
[1.0.0]: https://github.com/idekakdj/Battle-Royale-v1/releases/tag/v1.0.0
