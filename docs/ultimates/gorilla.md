# Gorilla — Boulder Hurl (v1.3, as built)

The Gorilla drums its chest twice, rips a slab out of the ground, hoists it overhead and **hurls it**: a real arcing
projectile (`spawnProjectile`, kind `boulder`). The first fighter it touches takes 200 and is staggered, everyone near
the landing takes 60 splash, crates it meets are smashed. It is dodgeable: step out of the landing spot (or be in the air
above it) and it misses.

Files: `src/sim/ultimates/gorilla.ts` · `src/config/ultimates/gorilla.ts` (spec + `GORILLA_HURL` timeline/numbers) ·
`src/ai/ultScripts/gorilla.ts` · `src/render/animals/Gorilla.ts` (slab prop, `poseUltimate`) +
`src/render/animals/ultPose/gorilla.ts` (keyframes; its `buildTrack`/`sampleTrack` are reused by the giraffe) ·
`src/render/ultFx/gorilla.ts` · `src/audio/ults/gorilla.ts` · `tests/sim/ultimates/gorilla.test.ts`.

## Mechanic

| Item | Value |
|---|---|
| Targeting | `line`, 18 m, width 1.6, lock-assisted by a 40° cone (`coneDeg`) but **never required** (no `requireTarget`): with nobody in the cone it is thrown down the aim line at full range (clipped at the wall), never fizzles |
| Windup | 1.0 s: two chest beats (0.13, 0.31), the rip at 0.60, the hoist, the cock-back. **Uninterruptible** (`ccImmuneChannel`, the old Primal Rampage "does not flinch" spirit); the immunity drops at the release so the recovery can be punished |
| While heaving | the gorilla keeps turning (7 rad/s) toward the locked foe (or the aim); `ultimateStage` 0 every 0.1 s carries the predicted landing point. A dead / untargetable / out-of-reach (> 21 m) / airborne victim is dropped and the throw falls back to the aim line |
| Release (end of windup) | the landing point freezes (`ultimateStage` 1 with `pos` = landing) with **0.8 × victim velocity × flight time of lead** (a steady runner is clipped, a juker is missed), inside 3–18 m |
| Boulder | spawned 1.0 m ahead, 2.3 m up; horizontal speed 18 m/s on a long throw, flight time never below 0.75 s (a close throw is a slower, higher lob so there is always time to step out), gravity 9 m/s², radius 0.65 m, aimed to arrive at chest height (1.0 m) over the landing point; real ballistic arc solved exactly in the sim |
| First touch | the first targetable fighter whose body circle overlaps (vertical overlap with `bodyHeight`; untargetable and airborne-above fighters are skipped), else a crate (destroyed), obstacle, wall or the ground |
| Direct hit | **200**, blockable + heavy; a blocked hit drains guard (and may guard-break) but gives no stagger; unblocked adds **0.8 s stagger** |
| Splash | **60** (no stagger) to everyone else within 2.5 m + body of the struck fighter (or of the landing point when a crate/ground/wall stopped it); a direct victim gets no splash on top |
| Recovery | 0.6 s, interruptible. Total cast to impact ≈ 1.0 + flight (≤ 1.0 s at 18 m) |
| Stage protocol | 0 = heaving / tracking (`pos` = predicted landing), 1 = released (`pos` = committed landing), 2 = landed (emitted from the projectile impact, possibly after the gorilla's own recovery ended; `pos` = impact) |

Single unblocked victim: 200 direct (+ the free 0.8 s stagger for follow-ups). A victim inside a crowd also costs the neighbours 60 each.

### Why it is dodgeable
- The landing point is fixed at the release. Flight time is 0.75 s (≤ 13.5 m) to 1.0 s (18 m); the boulder touches a body
  ≈ 1.6–2 m before the landing point, so the dodge window is ≈ 0.55–0.85 s after the release.
- Moving sideways out of the landing spot (+ body) dodges the direct hit; the 2.5 m splash still stings a slow walker.
- Flying (soaring eagle, above the boulder's body height) dodges it entirely. Jumping alone (peak 1.2 m) only clears a boulder that
  is already skimming the ground, so it is not a reliable dodge.
- Running straight away is punished by the lead; changing direction after the release is not.

## Bots
- `dodge: { mode: 'commit', activeS: 1.0, commitS: 1.4 }`: the heave is NOT a danger zone; `ultimateStage` 1 commits a zone at the landing
  point (radius from `ultimateTarget.width/2` = 0.8 + the bot's own body) for `commitS`; stage 2 removes it.
  L1 never dodges, L2 lazy, L3 reliable, L4 strict (`docs/ultimates/ai-hooks.md`). A bot that is mid-melee or mid-special
  (e.g. a charging hippo/lion) never dodges, which is why some bot matchups still eat the hit.
- Script (`src/ai/ultScripts/gorilla.ts`): `ranged: true`; L1/L2 fire whenever a target is 2.5–16.5 m away; L3: clusters
  (`enemiesNearTarget8 ≥ 2`) or the ranged window (fleeing / helpless / rooted / committed / crowded / cracking guard);
  Apex (≥ 3.5 m): helpless / rooted / mid-cast, crowds, guards < 50 %, runners. Never at point-blank (hands are better).

## Animation beats (`GorillaRig.poseUltimate`, keyframed from `actionT` in `ultPose/gorilla.ts`, cubic-eased per segment)
1. **Chest beats** (0–0.44): rear up on the hind legs, fists flung high and wide, both fists slam the chest at 0.13 and 0.31 (torso jolt,
   head snap, recoil decaying over 50 ms), the second heavier with the head thrown back in a roar.
2. **Squat and rip** (0.44–0.66): drop into a crouch, fists on the ground in front, body shudders (64 rad/s) as the slab tears loose at 0.60.
3. **Heave** (0.66–0.86): stand with the slab rising up the chest (straining tremor), overhead hold; **cock-back** behind the head (0.86–0.93).
4. **The throw** (0.93–1.00): full-body lunge, arms whip forward-up, opposite leg strides; the boulder leaves at 1.00.
5. **Follow-through** (1.0–1.28): the torso folds over the throw, arms sweep down; **settle** (1.28–1.6): heavy breaths back to idle.
The held slab is a plain mesh on the rig root (added after the bake) placed between the two fists every frame (`update` override:
fist midpoint from the forearm joints), it grows out of the ground at the rip (0.52–0.66), tilts back in the cock-back, and
matches the flying boulder's geometry / colours / size (radius 0.65) so the hand-off at the release is seamless.

## VFX (`src/render/ultFx/gorilla.ts`) and audio (`src/audio/ults/gorilla.ts`)
- Beats: dust + a pale shock ring at the feet and a flash at the chest, small shake. Rip: crack decal, dust ring, stone chips at the slab's
  source; pebbles trickle off the slab while it is hoisted.
- Heave: dashed ballistic **arc** from the hands to the predicted landing point (it follows the locked foe; revealed from 0.42 s as the
  slab is lifted) and a tracking reticle under it (gold for the player, red for others).
- Release: the markers move to a long-lived owner (`1000 + fighterId`) so they survive the gorilla's recovery: the arc turns `committed`,
  a solid landing reticle (r 1.9) fills with the flight time, a dashed 2.5 m splash ring; dust at the feet, a flash and streaks at the hands.
- Impact (`projectileImpact`, on top of the generic boulder crack/dust in Effects): markers fade, stone shards and a wide ring; a body hit
  adds a red-gold impact ring and sparks. The flying boulder is drawn by `ProjectileRenderer`.
- Audio: two chest drums (hollow thump + noise slap) scheduled against the beats, a stone rip (gritty low-passed noise, a low groan, pebbles),
  a hoist grunt; throw grunt + whoosh at the release (heard at the thrower); impact boom (sub thud, crack, rolling dust, debris).
  Tracking cadence silent. Everything attenuated by `gainAt`.

## First-person notes (for the camera pass)
- **Clear view (ultimate only):** while the ultimate runs (`action === 'ultimate'`, every phase / stage) the own rig is screen-space clipped out of the centre 50% x 60% of the screen (`ultClip` in the FP profile, `fp/clip.ts`). The held slab is not drawn in first person (`hideProps: ['boulder-slab']`, its shadow still casts) and both arms are pinned as small fists at the screen edges keyed to the same keyframes (beats high and wide, rip low, hoist up the sides, throw forward-down). The normal first-person look (idle, run, attacks, block, ...) is unchanged. Measure with `await __gkFp.report()` (dev build): 0 safe-zone pixels, <= ~12% of the frame in every stage.
- Beats: two short chest thumps (tiny pitch-down kicks of ≈ 1.5°, 40 ms). The FP viewmodel profile (`fp/gorilla.ts`) pins the arms as a viewmodel for the normal attacks; during the ultimate it pins them as small edge-hugging fists (see above) instead of letting the body pose swing the big arms into the lens.
- Rip: pitch the view DOWN ≈ 25° into the squat (eye drops ≈ 0.35 m), a 60 ms shudder; the slab itself is not drawn in first person (it would fill the view) — the small edge fists and the dust / crack VFX carry the beat.
- Hoist: pitch back up; the fists rise along the screen sides (the slab is not drawn); the dashed arc is the aid to aim.
- Throw: a sharp pitch-forward kick (+3°) and FOV +4 % at the release, then the view follows the boulder's arc for ≈ 0.3 s and settles.
- The yaw keeps following the aim during the heave (the sim turns the body toward the lock / aim), so the camera can stay on the mouse.

## Balance notes
See `docs/ultimates/gorilla-balance.txt`. Bands held (N = 200: L3 8 %, L4 10 %; N = 60: L1 13 %, L2 7 %), ≈ 1.0 ult per
fighter per match at L3/L4, 0 timeouts. The ultimate is worth 7–12 % of the gorilla's hit-event share (most boulders are dodged by L3/L4 bots),
replacing the old hit-less Primal Rampage (0 %).

## Tests (`tests/sim/ultimates/gorilla.test.ts`)
Config, never fizzles (aim line / cone lock / beyond 18 m), windup uninterruptible then 0.6 s interruptible recovery, exactly one boulder, stage events
(cadence, release, impact), arc + speed, 200 once + 0.8 s stagger, splash at 2.85 m / none at 6.5 m, first body in the path, dodge by moving / flying /
untargetable, blocking, crate breaking + splash behind it, lead on a runner vs a reverser, landing point frozen at the release, caster death mid-heave /
mid-flight, victim death mid-heave, bot danger-zone protocol with the real events, real Apex bots (python victim at 15 m: ≤ 1/8 direct hits, Cubs ≥ 5),
audio smoke test with a fake AudioContext, script gates, determinism.
