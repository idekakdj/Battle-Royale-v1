# Champions League — movesets

Generated from `src/brawl/data/animals/*` by `renderMovesDoc()` (`src/brawl/data/movesDoc.ts`) — do not hand-edit numbers; change the data and regenerate.
Budgets and invariants are enforced by `tests/brawl/moveBudget.test.ts`.

## Conventions (for animators, bots and the balance pass)

* Frames are 60 Hz. **S/A/R** = startup / active / recovery, `(n)` = total frames (<= 62). Hitboxes are active in `[startup, startup + active)`.
* Hitbox coordinates are fighter-local metres: origin = feet centre, +x forward, +y up. `reach` = furthest forward extent of the hitbox (m from the feet centre, including its sweep path); `height` = the height of the striking tip at the peak pose.
* `path` keyframes are move-relative frames (the same clock as `from`/`to`), offsets are added to the box position, linearly interpolated, first key at the first active frame. The visible limb/head/tail tip must travel with the box.
* `anim` keys on every body: `look` (this table's last column), `limb` (the striking part: paw, forelimb, claw, talon, jaw, head, horn, beak, tail, neck, wing, body), `side` (L, R, both, front, back, up, down), `reach`, `height`, plus optional `arc` (degrees swung), `travel` (m moved), `spin` (turns), `rise` (m climbed), `ring` (radius of a two-sided burst), `pitch` (body pitch in degrees for dives), `gape`, `depth`.
* `sweet` (sweetspot) is a circle tested against the centre of the victim (sim rule), fighter-local like the box and moving with its `path`; it sits at the far end of the reach, so it rewards spacing (jaw / beak tip / neck tip). Boxes that share a `group` can hit one victim only once per activation; within a body either every box sets a `group` or none does. `multi-hit` boxes re-hit every `multiHitInterval` frames.
* KB column = `baseKb + kbGrowth` of the main hitbox: launch speed (m/s) = `(base + growth x percent/100) x (100 / weight)`. Angle: 0 = forward, 90 = up, 270 = down (mirrored by facing). Damage = total one victim can take from one activation (sweetspot value in brackets).
* lightN is a string: the table shows each link; pressing Light inside the previous link's cancel window continues it (links after the first are `onHitOnly`).
* Every move has an aerial form (see the "Aerials" tables): landing lag when landing before the move ends, and an auto-cancel window of late frames. Spikes (`spike` effect) exist only on the air Heavy Down of lion, gorilla, crocodile, hippo, rhino, eagle and giraffe.
* `underground f{a}-{b}` (v1.6, mole Burrow Strike, ground form only): the fighter is untouchable in that window (hits bypass it: no hit, no hitlag), hitboxes pass through it, the rig is hidden under a dirt mound; `stops at the platform edge` = the tunnel never carries it off the platform it stands on (it surfaces at the edge instead), and it surfaces standing still.
* Heavy Up is the recovery: it travels (`moves ... up` in the notes) and can be used once per airtime; on the ground it is a leaping launcher.

## Roster at a glance

| Animal | Identity | Weight | Run | Recovery score* | Best kill % (w100) | Power index |
|---|---|---|---|---|---|---|
| Lion | All-rounder brawler: balanced reach, speed and a dependable leap recovery. | 104 | 8.6 | 7.7 | 103.5 | 0.496 |
| Gorilla | Heavy bruiser: slow, armored and brutally strong, but a short climb back to the stage. | 107 | 8.1 | 5.3 | 128 | 0.479 |
| Crocodile | Low trapper: long reach along the floor, a crushing lunge, and a death roll that drags victims in. | 129 | 8 | 4.6 | 84.5 | 0.508 |
| Hippo | Wall of meat: armored giant bites and a quaking belly flop, but slow and with the weakest recovery. | 119 | 6.5 | 3.1 | 92 | 0.496 |
| Rhino | Momentum charger: an armored battering-ram rush with kill power, but a poor way back. | 130 | 7.9 | 4.9 | 96 | 0.493 |
| Eagle | Air skirmisher: fast, floaty with four jumps and a glide; unmatched recovery but light and low on kill power. | 76 | 9.4 | 12.2 | 135 | 0.490 |
| Panther | Assassin: blazing combos, a dash that slips through enemies and a vanishing blink-leap recovery. | 84 | 9.2 | 8 | 128 | 0.417 |
| Python | Long-reach controller: pokes and whips from afar, pulls you in and stuns you, with a slow but strong lunge. | 97 | 7.3 | 6.4 | 98 | 0.488 |
| Giraffe | Tall zoner: huge neck reach with tip sweetspots and vertical control, but struggles against low targets. | 100 | 7.2 | 8 | 96.5 | 0.481 |
| Mole | Tiny trickster: hard to hit, quick digging combos, a burrow that tunnels under attacks and erupts upward, and a drilling recovery. | 79 | 9.1 | 8.4 | 121 | 0.573 |

\* height gained + half the horizontal drift of Heavy Up (m), computed by `simulateRecovery`. Kill % is the data-level estimate of `killPercent` (no DI / air control); the balance script measures the real thing.

## Lion

*All-rounder brawler: balanced reach, speed and a dependable leap recovery.*

Weight 104, walk 4.6, run 8.6, air 7.3 (accel 33), jump 14.5 / air jump 13, 2 jumps, gravity x1, fall 18 / fast 26, hurtbox 1.1 x 1.5 m, dodge 14/26 frames.

| Slot | Name | Archetype | S/A/R | Dmg | KB | Angle | Notes | What it looks like |
|---|---|---|---|---|---|---|---|---|
| lightN 1 | Claw Swipe | swipe | 5/2/9 (16) | 3 | 5 + 4 | 62 | - | paw (R); reach 1.5, height 1; Right forepaw slashes diagonally across the body |
| lightN 2 | Claw Backhand | backhand | 4/2/9 (15) | 3 | 5 + 4 | 62 | - | paw (L); reach 1.5, height 1; Left forepaw backhands the opposite way |
| lightN 3 | Claw Rake | rake | 6/3/12 (21) | 4 | 7 + 10 | 50 | swept hitbox | paw (R); reach 1.65, height 1.1; Both-clawed overhead rake, paw drawn down through the target |
| lightS — Light Side | Pounce Swipe | swipe | 7/3/14 (24) | 6 | 6 + 9 | 35 | moves 0.3 m fwd (f4-9); swept hitbox | paw (R); reach 1.7, height 0.95; Short forward pounce with a lunging forepaw swipe |
| lightD — Light Down | Low Rake | rake | 6/3/13 (22) | 6 | 5 + 7 | 68 | swept hitbox | paw (R); reach 1.6, height 0.3; Crouching sweep of one paw along the floor, popping the target up |
| lightU — Light Up | Uppercut Claw | uppercut | 7/3/14 (24) | 7 | 6 + 9 | 85 | swept hitbox | paw (R); reach 1.4, height 1.9; Forepaw scoops upward in an arc over the head |
| heavyN — Heavy Neutral | Roar Wave | roar | 16/4/22 (42) | 11 | 10.8 + 20 | 40 | flinch; two-sided | head (both); reach 2, height 1.8; Rears up and roars; a short two-sided shock ring pushes everything away |
| heavyS — Heavy Side | Maul Bite | bite | 16/4/28 (48) | 16 (18.4 sweet) | 10.8 + 25 | 38 | sweetspot; moves 1.3 m fwd (f14-24) | jaw (front); reach 2, height 1; Leaps forward with the jaws wide and snaps shut on the target |
| heavyD — Heavy Down | Paw Slam | slam | 14/4/26 (44) | 13 | 10 + 20 | 75 | - | paw (both); reach 1.7, height 0.4; Rears up and slams both paws down in front; air: dives paws-first |
| heavyU — Heavy Up (recovery) | Leap Rake | leapUp | 8/14/24 (46) | 9 | 9.5 + 17 | 80 | moves 0.9 m fwd, 2.9 m up (f6-16); swept hitbox | paw (both); reach 1.4, height 2.4; Springs up and forward with claws raking upward through the air |

Aerials:

| Slot | Frames | Landing lag | Auto-cancel | Difference from the ground form |
|---|---|---|---|---|
| lightN | 16 | 6 | f8-16 | same as ground |
| lightS | 24 | 8 | f16-24 | same as ground |
| lightD | 22 | 8 | f14-22 | same as ground |
| lightU | 24 | 8 | f16-24 | same as ground |
| heavyN | 42 | 18 | f34-42 | same as ground |
| heavyS | 48 | 22 | f40-48 | same as ground |
| heavyD | 44 | 22 | f36-44 | renamed "Paw Slam (dive)"; own hitbox: 14 dmg, 10 + 20, angle 270, spike |
| heavyU | 46 | 16 | f38-46 | same as ground |

Longest hitbox reach: 2 m.

## Gorilla

*Heavy bruiser: slow, armored and brutally strong, but a short climb back to the stage.*

Weight 107, walk 4.25, run 8.1, air 5.9 (accel 26.4), jump 13.5 / air jump 12, 2 jumps, gravity x1.1, fall 19 / fast 27, hurtbox 1.5 x 2 m, dodge 14/26 frames.

| Slot | Name | Archetype | S/A/R | Dmg | KB | Angle | Notes | What it looks like |
|---|---|---|---|---|---|---|---|---|
| lightN 1 | Hammer Fist | jab | 7/3/12 (22) | 5 | 6 + 5 | 62 | swept hitbox | forelimb (R); reach 1.95, height 1.2; Right fist hammers forward and down |
| lightN 2 | Hammer Fist 2 | jab | 6/3/13 (22) | 5 | 8 + 10 | 45 | swept hitbox | forelimb (L); reach 2, height 1.1; Left fist follows with a heavier hammer blow |
| lightS — Light Side | Backhand Smash | backhand | 10/4/18 (32) | 9 | 7 + 10 | 35 | swept hitbox | forelimb (R); reach 2.3, height 1.2; Wide backhand arc swung across the front with the whole arm |
| lightD — Light Down | Knuckle Drag | swipe | 8/4/15 (27) | 7 | 6 + 8 | 25 | swept hitbox | forelimb (R); reach 2.2, height 0.25; Drops to the knuckles and drags a fist along the floor |
| lightU — Light Up | Thump Uppercut | uppercut | 9/4/16 (29) | 8 | 7 + 11 | 80 | swept hitbox | forelimb (both); reach 1.5, height 2.7; Both fists thump up from the chest in a launching uppercut |
| heavyN — Heavy Neutral | Chest Drum | roar | 15/4/25 (44) | 12 | 10 + 22 | 45 | two-sided; armor f8-14 | forelimb (both); reach 2.4, height 1.6; Rears up and drums the chest; a shockwave rolls out both ways |
| heavyS — Heavy Side | Silverback Swing | swipe | 20/5/32 (57) | 16 | 11 + 21 | 35 | armor f8-20; swept hitbox | forelimb (both); reach 2.7, height 2.6; Raises both arms overhead and brings one giant overhand swing down and through |
| heavyD — Heavy Down | Double-Fist Slam | slam | 16/4/28 (48) | 13 | 10 + 20 | 75 | - | forelimb (both); reach 2.1, height 0.5; Clasps both fists and slams them into the floor in front |
| heavyU — Heavy Up (recovery) | Vine Leap | leapUp | 10/12/28 (50) | 7 | 9.5 + 17 | 80 | moves 0.6 m fwd, 2.9 m up (f8-20); swept hitbox | forelimb (both); reach 2, height 3.2; A short heavy jump, arms stretched up to grab an imaginary vine |

Aerials:

| Slot | Frames | Landing lag | Auto-cancel | Difference from the ground form |
|---|---|---|---|---|
| lightN | 22 | 8 | f14-22 | same as ground |
| lightS | 32 | 10 | f24-32 | same as ground |
| lightD | 27 | 9 | f19-27 | same as ground |
| lightU | 29 | 10 | f21-29 | same as ground |
| heavyN | 44 | 22 | f36-44 | same as ground |
| heavyS | 57 | 26 | f49-57 | same as ground |
| heavyD | 48 | 24 | f40-48 | renamed "Double-Fist Drop"; own hitbox: 14 dmg, 10 + 20, angle 270, spike |
| heavyU | 50 | 18 | f42-50 | same as ground |

Longest hitbox reach: 2.7 m.

## Crocodile

*Low trapper: long reach along the floor, a crushing lunge, and a death roll that drags victims in.*

Weight 129, walk 4.1, run 8, air 5.5 (accel 24.2), jump 17.6777 / air jump 11.5, 2 jumps, gravity x1.15, fall 21 / fast 28, hurtbox 1.7 x 0.9 m, dodge 14/28 frames.

| Slot | Name | Archetype | S/A/R | Dmg | KB | Angle | Notes | What it looks like |
|---|---|---|---|---|---|---|---|---|
| lightN 1 | Snap | bite | 7/3/11 (21) | 5 | 6 + 5 | 62 | - | jaw (front); reach 2.1, height 0.55; Quick head thrust, jaws snapping shut |
| lightN 2 | Snap Again | bite | 6/3/13 (22) | 5 | 8 + 10 | 45 | - | jaw (front); reach 2.2, height 0.5; Second snap, head dipping slightly lower and further |
| lightS — Light Side | Tail Flick | tailWhip | 9/4/17 (30) | 9 | 6 + 9 | 145 | two-sided | tail (both); reach 2.5, height 0.5; Tail flicks out behind the body, then whips round to the front |
| lightD — Light Down | Low Snap | bite | 7/3/14 (24) | 7 | 5 + 7 | 70 | - | jaw (front); reach 2.2, height 0.25; Head sweeps low along the ground and snaps up at the ankles |
| lightU — Light Up | Head Toss | uppercut | 8/4/15 (27) | 7 | 6 + 9 | 88 | swept hitbox | jaw (front); reach 1.9, height 1.5; Snout dips, then the jaw flips up and tosses the target |
| heavyN — Heavy Neutral | Death Roll | spinAttack | 16/6/26 (48) | 16 | 12 + 24 | 60 | pull; multi-hit | body (both); reach 1.7, height 0.6; Whole body barrel-rolls on the spot; the jaws and tail drag victims in, then fling them |
| heavyS — Heavy Side | Lunge Bite | lunge | 19/4/33 (56) | 19 (21.8 sweet) | 12 + 26 | 35 | sweetspot; moves 1.5 m fwd (f17-27) | jaw (front); reach 2.4, height 0.55; Coils, then lunges the entire body forward with the jaws wide open |
| heavyD — Heavy Down | Tail Slam | tailWhip | 13/4/27 (44) | 12 | 10 + 20 | 70 | swept hitbox | tail (front); reach 2.4, height 0.45; Tail arcs over the back and slams down in front of the head |
| heavyU — Heavy Up (recovery) | Rising Snap | leapUp | 10/10/28 (48) | 8 | 9.5 + 17 | 80 | moves 0.6 m fwd, 2.3 m up (f8-18); swept hitbox | jaw (front); reach 2.2, height 2.4; Short upward lunge, jaws snapping at the top |

Aerials:

| Slot | Frames | Landing lag | Auto-cancel | Difference from the ground form |
|---|---|---|---|---|
| lightN | 21 | 8 | f13-21 | same as ground |
| lightS | 30 | 9 | f22-30 | same as ground |
| lightD | 24 | 8 | f16-24 | same as ground |
| lightU | 27 | 9 | f19-27 | same as ground |
| heavyN | 48 | 20 | f40-48 | same as ground |
| heavyS | 56 | 24 | f48-56 | same as ground |
| heavyD | 44 | 22 | f36-44 | renamed "Tail Slam (spike)"; own hitbox: 14 dmg, 10 + 20, angle 270, spike |
| heavyU | 48 | 16 | f40-48 | same as ground |

Longest hitbox reach: 2.8 m.

## Hippo

*Wall of meat: armored giant bites and a quaking belly flop, but slow and with the weakest recovery.*

Weight 119, walk 3.3, run 6.5, air 5.1 (accel 22), jump 12.5 / air jump 11, 2 jumps, gravity x1.2, fall 22 / fast 29, hurtbox 1.8 x 1.5 m, dodge 14/28 frames.

| Slot | Name | Archetype | S/A/R | Dmg | KB | Angle | Notes | What it looks like |
|---|---|---|---|---|---|---|---|---|
| lightN 1 | Head Bonk | headbutt | 7/3/13 (23) | 5 | 6 + 5 | 62 | - | head (front); reach 1.9, height 1; Heavy head bonks forward |
| lightN 2 | Head Bonk 2 | headbutt | 7/3/14 (24) | 5 | 8 + 10 | 45 | - | head (front); reach 1.95, height 0.95; Second bonk, rocking the whole upper body forward |
| lightS — Light Side | Belly Bump | charge | 9/4/18 (31) | 8 | 7 + 9 | 25 | - | body (front); reach 1.75, height 0.7; Leans in and bumps the belly sideways into the target |
| lightD — Light Down | Stomp Step | stomp | 8/3/16 (27) | 7 | 6 + 7 | 70 | - | forelimb (R); reach 1.7, height 0.2; One huge foot lifts and stamps low in front |
| lightU — Light Up | Tusk Toss | uppercut | 9/4/17 (30) | 8 | 6 + 9 | 88 | swept hitbox | head (front); reach 1.7, height 2.1; Lowers the head and tosses upward with the tusks |
| heavyN — Heavy Neutral | Mighty Yawn | bite | 18/5/30 (53) | 16 | 10 + 31 | 40 | armor f8-18 | jaw (front); reach 2.8, height 1.2; Rears the head back and opens a gigantic maw, snapping it shut on whatever is in front |
| heavyS — Heavy Side | Charging Gape | lunge | 22/4/30 (56) | 18 | 10 + 25 | 38 | armor f10-22; moves 1.2 m fwd (f20-30) | jaw (front); reach 2.4, height 0.9; Charges forward with the maw wide open and clamps down |
| heavyD — Heavy Down | Belly Flop | bellyFlop | 16/4/28 (48) | 13 | 10 + 20 | 75 | two-sided | body (both); reach 2.3, height 0.5; Rears up on the hind legs and drops belly-first; a quake rolls out both sides |
| heavyU — Heavy Up (recovery) | Bubble Surge | leapUp | 12/10/30 (52) | 7 | 9.5 + 17 | 88 | moves 0.4 m fwd, 2 m up (f10-20); swept hitbox | body (both); reach 1.2, height 2; A clumsy hop on a surge of water, splashing a bubble burst overhead |

Aerials:

| Slot | Frames | Landing lag | Auto-cancel | Difference from the ground form |
|---|---|---|---|---|
| lightN | 23 | 9 | f15-23 | same as ground |
| lightS | 31 | 10 | f23-31 | same as ground |
| lightD | 27 | 10 | f19-27 | same as ground |
| lightU | 30 | 10 | f22-30 | same as ground |
| heavyN | 53 | 24 | f45-53 | same as ground |
| heavyS | 56 | 26 | f48-56 | same as ground |
| heavyD | 48 | 26 | f40-48 | renamed "Belly Meteor"; own hitbox: 16 dmg, 10 + 20, angle 270, spike |
| heavyU | 52 | 20 | f44-52 | same as ground |

Longest hitbox reach: 2.8 m.

## Rhino

*Momentum charger: an armored battering-ram rush with kill power, but a poor way back.*

Weight 130, walk 3.75, run 7.9, air 5.5 (accel 24.2), jump 13 / air jump 11.5, 2 jumps, gravity x1.15, fall 21 / fast 28, hurtbox 1.9 x 1.7 m, dodge 14/28 frames.

| Slot | Name | Archetype | S/A/R | Dmg | KB | Angle | Notes | What it looks like |
|---|---|---|---|---|---|---|---|---|
| lightN 1 | Horn Jab | jab | 7/3/12 (22) | 5 | 6 + 5 | 62 | - | horn (front); reach 2.05, height 0.95; Short horn jab straight ahead |
| lightN 2 | Horn Jab 2 | jab | 6/3/13 (22) | 5 | 8 + 10 | 45 | - | horn (front); reach 2.15, height 0.95; A second, deeper horn jab |
| lightS — Light Side | Horn Sweep | headbutt | 9/4/17 (30) | 8 | 7 + 9 | 35 | swept hitbox | horn (front); reach 2.55, height 0.9; Head swings sideways, sweeping the horn across the front |
| lightD — Light Down | Hoof Scrape | stomp | 8/3/15 (26) | 7 | 6 + 7 | 62 | - | forelimb (R); reach 2.05, height 0.2; Paws the ground and scrapes a hoof forward along the floor |
| lightU — Light Up | Horn Toss | hornUp | 9/4/16 (29) | 8 | 7 + 10 | 85 | swept hitbox | horn (front); reach 1.8, height 2.3; Head dips, then the horn flicks up and tosses the target |
| heavyN — Heavy Neutral | Stomp Tremor | stomp | 16/4/26 (46) | 12 | 10 + 18 | 80 | two-sided | forelimb (both); reach 2.6, height 0.4; Rears a foreleg and stamps; a grounded tremor rolls out both ways and pops targets up |
| heavyS — Heavy Side | Rhino Charge | charge | 16/6/34 (56) | 17 | 11 + 28 | 38 | armor f6-18; moves 3.9 m fwd (f14-32) | horn (front); reach 2.4, height 0.95; Lowers the horn and charges across the floor like a battering ram |
| heavyD — Heavy Down | Dive Gore | headbutt | 15/4/25 (44) | 12 | 10 + 20 | 60 | - | horn (front); reach 2.2, height 0.5; Drives the horn forward and down in a diagonal gore; in the air it dives horn-first |
| heavyU — Heavy Up (recovery) | Skyward Gore | hornUp | 10/12/28 (50) | 9 | 9.5 + 17 | 82 | moves 0.6 m fwd, 2.8 m up (f8-20); swept hitbox | horn (front); reach 1.9, height 2.6; Heaves the horn up and forward in a rising thrust, the whole body following |

Aerials:

| Slot | Frames | Landing lag | Auto-cancel | Difference from the ground form |
|---|---|---|---|---|
| lightN | 22 | 8 | f14-22 | same as ground |
| lightS | 30 | 10 | f22-30 | same as ground |
| lightD | 26 | 9 | f18-26 | same as ground |
| lightU | 29 | 10 | f21-29 | same as ground |
| heavyN | 46 | 20 | f38-46 | renamed "Stomp Tremor (air)"; own hitbox: 11 dmg, 10 + 20, angle 60 |
| heavyS | 56 | 26 | f48-56 | same as ground |
| heavyD | 44 | 24 | f36-44 | renamed "Dive Gore (air)"; own hitbox: 14 dmg, 10 + 20, angle 300, spike |
| heavyU | 50 | 20 | f42-50 | same as ground |

Longest hitbox reach: 2.6 m.

## Eagle

*Air skirmisher: fast, floaty with four jumps and a glide; unmatched recovery but light and low on kill power.*

Weight 76, walk 5.2, run 9.4, air 8.8 (accel 39.6), jump 15 / air jump 12.8, 4 jumps, gravity x0.8, fall 14 / fast 24 / glide 6.5, hurtbox 1 x 1.2 m, dodge 14/24 frames.

| Slot | Name | Archetype | S/A/R | Dmg | KB | Angle | Notes | What it looks like |
|---|---|---|---|---|---|---|---|---|
| lightN 1 | Talon Slash | swipe | 4/2/8 (14) | 3 | 5 + 4 | 62 | - | talon (R); reach 1.3, height 0.75; Right talon slashes forward and down |
| lightN 2 | Talon Slash 2 | backhand | 4/2/8 (14) | 3 | 5 + 4 | 62 | - | talon (L); reach 1.35, height 0.8; Left talon slashes back the other way |
| lightN 3 | Talon Rake | rake | 5/2/10 (17) | 3 | 7 + 9 | 50 | swept hitbox | talon (both); reach 1.45, height 0.7; Both talons rake down through the target |
| lightS — Light Side | Wing Buffet | wingBuffet | 6/3/12 (21) | 6 | 8 + 6 | 25 | - | wing (front); reach 1.7, height 0.85; One wing slaps forward across the front |
| lightD — Light Down | Talon Drop | rake | 5/3/11 (19) | 5 | 5 + 6 | 60 | swept hitbox | talon (both); reach 1.3, height 0.2; Talons drop down and rake the ground in front |
| lightU — Light Up | Beak Flick | uppercut | 6/3/12 (21) | 6 | 6 + 8 | 90 | swept hitbox | beak (up); reach 0.8, height 1.75; Head snaps upward in a short beak peck |
| heavyN — Heavy Neutral | Gale Burst | wingBuffet | 12/4/20 (36) | 10 | 9 + 17 | 40 | two-sided | wing (both); reach 2.6, height 0.9; Both wings thrash down in one huge flap; a gust shoves everything around away |
| heavyS — Heavy Side | Piercing Dive | dive | 16/4/23 (43) | 14 (16.8 sweet) | 10.8 + 24 | 50 | sweetspot; moves 1.5 m fwd (f14-24) | beak (front); reach 1.55, height 0.65; Folds the wings back and stoops diagonally forward, beak first; the beak tip is the killing point |
| heavyD — Heavy Down | Stoop | dive | 12/4/20 (36) | 12 | 10 + 20 | 80 | - | talon (down); reach 0.9, height 0.25; Pulls in the wings and drops straight down talons-first; on the ground a talon stamp that pops targets up |
| heavyU — Heavy Up (recovery) | Soaring Updraft | leapUp | 6/20/22 (48) | 7 | 9.5 + 17 | 85 | moves 1.5 m fwd, 6 m up (f4-24); swept hitbox | wing (both); reach 1.5, height 2; Powerful wing beats lift the whole body high and forward on a rising current |

Aerials:

| Slot | Frames | Landing lag | Auto-cancel | Difference from the ground form |
|---|---|---|---|---|
| lightN | 14 | 6 | f7-14 | same as ground |
| lightS | 21 | 7 | f13-21 | same as ground |
| lightD | 19 | 7 | f11-19 | same as ground |
| lightU | 21 | 6 | f13-21 | same as ground |
| heavyN | 36 | 14 | f28-36 | same as ground |
| heavyS | 43 | 18 | f35-43 | renamed "Piercing Dive (stoop)"; own motion |
| heavyD | 36 | 18 | f28-36 | renamed "Stoop (meteor)"; own hitbox: 12 dmg, 10 + 20, angle 270, spike; own motion |
| heavyU | 48 | 14 | f40-48 | same as ground |

Longest hitbox reach: 2.6 m.

## Panther

*Assassin: blazing combos, a dash that slips through enemies and a vanishing blink-leap recovery.*

Weight 84, walk 5, run 9.2, air 8 (accel 44), jump 15 / air jump 13.5, 2 jumps, gravity x0.95, fall 18 / fast 27, hurtbox 1.1 x 1.35 m, dodge 14/24 frames.

| Slot | Name | Archetype | S/A/R | Dmg | KB | Angle | Notes | What it looks like |
|---|---|---|---|---|---|---|---|---|
| lightN 1 | Claw | swipe | 4/2/8 (14) | 3 | 5 + 4 | 62 | - | claw (R); reach 1.5, height 0.95; Quick right-paw claw slash |
| lightN 2 | Claw 2 | backhand | 4/2/8 (14) | 3 | 5 + 4 | 62 | - | claw (L); reach 1.5, height 0.95; Left-paw claw slash back across |
| lightN 3 | Claw Rake | rake | 5/2/10 (17) | 2 | 7 + 10 | 50 | swept hitbox | claw (both); reach 1.6, height 0.9; Double-clawed downward rake that finishes the string |
| lightS — Light Side | Shadow Slash | lunge | 6/3/12 (21) | 5 | 6 + 8 | 35 | moves 0.4 m fwd (f3-8) | claw (R); reach 1.6, height 0.9; Darts forward in a short low lunge with a single claw slash |
| lightD — Light Down | Low Slash | rake | 5/3/11 (19) | 4.5 | 5 + 6 | 60 | - | claw (R); reach 1.65, height 0.3; Drops low and slashes at the shins |
| lightU — Light Up | Rising Claw | uppercut | 6/3/12 (21) | 5 | 6 + 8 | 88 | swept hitbox | claw (R); reach 1.3, height 1.9; Claws sweep upward in a rising arc |
| heavyN — Heavy Neutral | Pounce Spin | spinAttack | 16/4/24 (44) | 9 | 10.8 + 22 | 40 | two-sided | claw (both); reach 1.9, height 0.95; A pouncing spin on the spot, claws out on both sides |
| heavyS — Heavy Side | Shadow Dash | charge | 18/3/26 (47) | 13 | 10.8 + 24 | 42 | two-sided; invulnerable f4-13; moves 2.1 m fwd (f8-18) | claw (both); reach 1.9, height 0.9; Fades into a smoky blur and dashes straight through the target, then rakes as it reappears |
| heavyD — Heavy Down | Dive Claw | rake | 13/4/21 (38) | 10.5 | 10 + 20 | 75 | - | claw (both); reach 2, height 0.4; Crouches and slashes both claws out low and wide; in the air a diagonal downward dive claw |
| heavyU — Heavy Up (recovery) | Shadow Leap | leapUp | 6/12/26 (44) | 6 | 9.5 + 17 | 80 | invulnerable f0-8; moves 1.5 m fwd, 3.1 m up (f4-16); swept hitbox | claw (both); reach 1.5, height 2.2; Vanishes in smoke and leaps up and forward, reappearing with a claw swipe at the top |

Aerials:

| Slot | Frames | Landing lag | Auto-cancel | Difference from the ground form |
|---|---|---|---|---|
| lightN | 14 | 6 | f7-14 | same as ground |
| lightS | 21 | 7 | f13-21 | same as ground |
| lightD | 19 | 7 | f11-19 | same as ground |
| lightU | 21 | 6 | f13-21 | same as ground |
| heavyN | 44 | 16 | f36-44 | same as ground |
| heavyS | 47 | 20 | f39-47 | same as ground |
| heavyD | 38 | 18 | f30-38 | renamed "Dive Claw (air)"; own hitbox: 10.5 dmg, 10 + 20, angle 300 |
| heavyU | 44 | 16 | f36-44 | same as ground |

Longest hitbox reach: 2 m.

## Python

*Long-reach controller: pokes and whips from afar, pulls you in and stuns you, with a slow but strong lunge.*

Weight 97, walk 4.05, run 7.3, air 6.4 (accel 28.6), jump 13.5 / air jump 12.5, 2 jumps, gravity x0.9, fall 16 / fast 24, hurtbox 1.5 x 1 m, dodge 14/26 frames.

| Slot | Name | Archetype | S/A/R | Dmg | KB | Angle | Notes | What it looks like |
|---|---|---|---|---|---|---|---|---|
| lightN 1 | Fang Strike | bite | 6/3/12 (21) | 5 | 6 + 5 | 62 | - | head (front); reach 2.3, height 0.6; Head snaps forward on a stretched neck for a quick fang strike |
| lightN 2 | Fang Strike 2 | bite | 6/3/13 (22) | 5 | 8 + 10 | 45 | - | head (front); reach 2.4, height 0.6; A second, longer strike with the neck fully extended |
| lightS — Light Side | Tail Lash | tailWhip | 9/3/16 (28) | 8 | 8 + 10 | 30 | swept hitbox | tail (front); reach 3.1, height 0.5; The tail whips out long and flat across the front, reaching about three metres |
| lightD — Light Down | Ground Sweep | tailWhip | 7/3/14 (24) | 7 | 5 + 6 | 20 | - | tail (front); reach 2.7, height 0.15; Tail sweeps low along the floor and trips the target |
| lightU — Light Up | Rising Coil | uppercut | 8/3/15 (26) | 7 | 6 + 9 | 88 | swept hitbox | body (up); reach 1.5, height 1.9; The front of the body arcs up in a coil, head rising overhead |
| heavyN — Heavy Neutral | Constrict | spinAttack | 14/6/30 (50) | 13 | 6 + 18 | 50 | pull; stun; multi-hit | body (both); reach 1.5, height 0.6; Coils into a tight spiral around the spot; the body squeezes in a pulsing wrap, then bursts open |
| heavyS — Heavy Side | Venom Lunge | lunge | 19/4/34 (57) | 19 (20.9 sweet) | 12 + 25 | 40 | sweetspot; moves 1.5 m fwd (f17-27) | head (front); reach 2.5, height 0.6; Slowly coils back, then lunges the whole front body forward with fangs bared |
| heavyD — Heavy Down | Coil Drop | bellyFlop | 13/4/27 (44) | 12 | 10 + 20 | 75 | - | body (down); reach 1.6, height 0.5; Rears up and drops the heavy coil of the body on the target below |
| heavyU — Heavy Up (recovery) | Spring Coil | leapUp | 10/14/26 (50) | 9 | 9.5 + 17 | 70 | moves 1.3 m fwd, 3.1 m up (f8-22); swept hitbox | body (both); reach 1.5, height 2; Compresses into a tight coil, then springs up and forward like a released spring |

Aerials:

| Slot | Frames | Landing lag | Auto-cancel | Difference from the ground form |
|---|---|---|---|---|
| lightN | 21 | 7 | f13-21 | same as ground |
| lightS | 28 | 9 | f20-28 | same as ground |
| lightD | 24 | 8 | f16-24 | same as ground |
| lightU | 26 | 8 | f18-26 | same as ground |
| heavyN | 50 | 20 | f42-50 | same as ground |
| heavyS | 57 | 24 | f49-57 | same as ground |
| heavyD | 44 | 22 | f36-44 | renamed "Coil Drop (air)"; own hitbox: 14 dmg, 10 + 20, angle 285 |
| heavyU | 50 | 16 | f42-50 | same as ground |

Longest hitbox reach: 3.1 m.

## Giraffe

*Tall zoner: huge neck reach with tip sweetspots and vertical control, but struggles against low targets.*

Weight 100, walk 3.95, run 7.2, air 6.6 (accel 29.7), jump 14 / air jump 12.5, 2 jumps, gravity x1, fall 18.5 / fast 26, hurtbox 1 x 2.3 m, dodge 14/26 frames.

| Slot | Name | Archetype | S/A/R | Dmg | KB | Angle | Notes | What it looks like |
|---|---|---|---|---|---|---|---|---|
| lightN 1 | Neck Jab | tether | 6/3/12 (21) | 5 | 6 + 5 | 62 | swept hitbox | neck (front); reach 2.4, height 1.5; Neck stretches forward in a quick head poke at head height |
| lightN 2 | Neck Jab 2 | tether | 6/3/13 (22) | 5 | 8 + 10 | 45 | - | neck (front); reach 2.5, height 1.3; A second poke with the neck fully stretched and the head dipping |
| lightS — Light Side | Long Kick | kick | 8/3/16 (27) | 8 | 6 + 9 | 35 | - | forelimb (R); reach 2, height 1; Front leg lashes out in a long kick at hip height |
| lightD — Light Down | Hoof Stomp | stomp | 7/3/14 (24) | 6 | 5 + 7 | 65 | - | forelimb (R); reach 1.4, height 0.2; Lifts a front hoof and stamps it down low in front |
| lightU — Light Up | Neck Lift | neckSwing | 8/4/16 (28) | 8 | 6 + 9 | 88 | swept hitbox | neck (up); reach 1.5, height 3.4; The neck whips upward in a vertical arc, head rising to 3.4 m |
| heavyN — Heavy Neutral | Neck Spin | neckSwing | 14/6/30 (50) | 11 (13.8 sweet) | 10.8 + 21 | 45 | sweetspot; two-sided | neck (both); reach 3, height 1.5; Neck lowers level and spins a full circle around the body; the head tip is the sweetspot |
| heavyS — Heavy Side | Skull Hammer | neckSwing | 19/4/33 (56) | 16 (18.4 sweet) | 11 + 26 | 38 | sweetspot | neck (front); reach 3.4, height 1.2; Neck rears back overhead, then slams the skull down like a hammer on the target in front |
| heavyD — Heavy Down | Axe Kick | kick | 14/4/26 (44) | 12 | 10 + 20 | 70 | - | forelimb (R); reach 1.8, height 0.8; Raises a front leg straight up and chops the hoof down in a heel drop |
| heavyU — Heavy Up (recovery) | Neck Stretch | tether | 8/12/26 (46) | 9 | 9.5 + 17 | 85 | moves 0.4 m fwd, 3.8 m up (f8-20); swept hitbox | head (up); reach 1.3, height 3.8; The neck shoots straight up to full stretch with the whole body rising, ending in a headbutt |

Aerials:

| Slot | Frames | Landing lag | Auto-cancel | Difference from the ground form |
|---|---|---|---|---|
| lightN | 21 | 7 | f13-21 | same as ground |
| lightS | 27 | 8 | f19-27 | same as ground |
| lightD | 24 | 8 | f16-24 | same as ground |
| lightU | 28 | 9 | f20-28 | same as ground |
| heavyN | 50 | 20 | f42-50 | same as ground |
| heavyS | 56 | 24 | f48-56 | same as ground |
| heavyD | 44 | 22 | f36-44 | renamed "Axe Kick (spike)"; own hitbox: 13 dmg, 10 + 20, angle 270, spike |
| heavyU | 46 | 16 | f38-46 | same as ground |

Longest hitbox reach: 3.4 m.

## Mole

*Tiny trickster: hard to hit, quick digging combos, a burrow that tunnels under attacks and erupts upward, and a drilling recovery.*

Weight 79, walk 4.85, run 9.1, air 7 (accel 31.9), jump 14.5 / air jump 12.5, 2 jumps, gravity x0.95, fall 17 / fast 25, hurtbox 0.68 x 0.68 m, dodge 14/24 frames.

| Slot | Name | Archetype | S/A/R | Dmg | KB | Angle | Notes | What it looks like |
|---|---|---|---|---|---|---|---|---|
| lightN 1 | Claw Dig | swipe | 4/2/8 (14) | 4 | 5 + 4 | 62 | - | claw (R); reach 0.95, height 0.4; Right digging claw scoops forward |
| lightN 2 | Claw Dig 2 | backhand | 4/2/8 (14) | 4 | 5 + 4 | 62 | - | claw (L); reach 0.95, height 0.4; Left digging claw scoops back |
| lightN 3 | Claw Dig 3 | rake | 5/2/10 (17) | 5 | 7 + 9 | 50 | swept hitbox | claw (both); reach 1.05, height 0.4; Both claws dig down through the target |
| lightS — Light Side | Dirt Fling | swipe | 6/3/13 (22) | 9 | 5 + 6 | 30 | flinch | claw (both); reach 1.1, height 0.4; Both paws fling a short cone of dirt into the target's face |
| lightD — Light Down | Low Dig | rake | 5/3/11 (19) | 8 | 5 + 6 | 68 | - | claw (both); reach 1.05, height 0.15; Claws scrape low along the ground and kick up the ankles |
| lightU — Light Up | Earth Pop | uppercut | 6/3/12 (21) | 9 | 6 + 8 | 88 | swept hitbox | claw (both); reach 0.9, height 1.3; Claws scoop upward in a small uppercut, popping the target up |
| heavyN — Heavy Neutral | Drill Spin | spinAttack | 12/6/22 (40) | 14 | 10.8 + 23 | 55 | multi-hit | claw (both); reach 0.9, height 0.4; Spins like a drill on the spot, claws buzzing around the body; the last turn flings victims |
| heavyS — Heavy Side | Tunnel Lunge | charge | 14/4/25 (43) | 14 | 11 + 24 | 40 | moves 1.4 m fwd (f12-22) | claw (front); reach 1.2, height 0.4; Tucks into a drill and rockets forward like a boring machine |
| heavyD — Heavy Down | Burrow Strike | burrow | 24/4/20 (48) | 12 | 11 + 16 | 88 | invulnerable f6-24; underground f6-24; moves 3.3 m fwd (f6-24), stops at the platform edge | claw (front); reach 1.45, height 0.9; Digs under the floor, tunnels a short way, and erupts upward under the target |
| heavyU — Heavy Up (recovery) | Drill Ascent | leapUp | 8/16/24 (48) | 11 | 9.5 + 17 | 85 | multi-hit; moves 0.7 m fwd, 4.5 m up (f6-22) | claw (up); reach 0.5, height 1.4; Spins into a vertical drill and bores up through the air |

Aerials:

| Slot | Frames | Landing lag | Auto-cancel | Difference from the ground form |
|---|---|---|---|---|
| lightN | 14 | 6 | f7-14 | same as ground |
| lightS | 22 | 7 | f14-22 | same as ground |
| lightD | 19 | 6 | f11-19 | same as ground |
| lightU | 21 | 6 | f13-21 | same as ground |
| heavyN | 40 | 15 | f32-40 | same as ground |
| heavyS | 43 | 18 | f35-43 | same as ground |
| heavyD | 42 | 18 | f34-42 | renamed "Drill Down"; own hitbox: 13 dmg, 10 + 20, angle 285; no motion; no underground window |
| heavyU | 48 | 14 | f40-48 | same as ground |

Longest hitbox reach: 1.5 m.
