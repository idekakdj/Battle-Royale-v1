/**
 * Champions League — simulation constants (plan §2). Every tunable number of the headless
 * simulation lives here; the balance pass may change VALUES, never the rules in `sim/**`.
 *
 * Units: metres, seconds (m/s, m/s²) for physics; "frames" are 60 Hz sim frames.
 */

export const PHYS = {
  // ── time ────────────────────────────────────────────────────────────────
  /** Fixed step (seconds). */
  dt: 1 / 60,
  /** 3-2-1-FIGHT countdown before control (3.0 s). */
  countdownFrames: 180,

  // ── ground movement ─────────────────────────────────────────────────────
  gravity: 38,
  /** |moveX| below this is "no input" for movement. */
  moveDeadzone: 0.1,
  /** |moveX| above this turns the fighter / selects the side attack direction. */
  turnThreshold: 0.3,
  /** |moveX| < this walks, otherwise runs. */
  walkThreshold: 0.6,
  /** Frames to reach run speed from rest (≤ 6) and to stop from run speed (≤ 4). */
  groundAccelFrames: 5,
  groundStopFrames: 3,
  /** Ground friction multiplier per frame while sliding in hitstun / after a lunge. */
  groundSlideFriction: 0.9,
  attackGroundFriction: 0.8,
  /** Fraction of the ground controls available for walking while in the respawn hover. */
  respawnWalkMult: 0.7,

  // ── air movement ────────────────────────────────────────────────────────
  /** Horizontal speed multiplier per frame with no input in the air, or above airSpeed in the stick's direction (2 % drag). */
  airDrag: 0.98,
  /** Air-drift strength during aerials (fraction of airAccel). */
  airAttackDrift: 0.5,
  /** |moveX| that turns the fighter around in the air. */
  airFacingThreshold: 0.5,
  /** moveY below −this = Down held (fast fall, drop through, crouch). */
  downThreshold: 0.5,
  /** Hard ceiling on any speed component (m/s) — guards against runaway motion data. */
  maxSpeed: 80,
  /** Per-frame fraction toward the fall-speed cap when a launch left us faster than allowed. */
  fallCapEase: 0.25,

  // ── jumps ───────────────────────────────────────────────────────────────
  jumpSquat: 4,
  /** Release inside this many frames after takeoff cuts a ground jump (short hop). */
  shortHopWindow: 6,
  shortHopCut: 0.6,
  /** Horizontal push toward the stage on a ledge jump (m/s). */
  ledgeJumpDrift: 2.5,

  // ── platforms ───────────────────────────────────────────────────────────
  /** Soft-platform pass-through duration after pressing Down (frames) and the downward kick (m/s). */
  dropThroughFrames: 12,
  dropThroughVy: -3,
  /** Frames a fighter must have stood on a soft platform before Down drops them through. */
  dropMinStandFrames: 3,
  /** Feet half-width used for support (cap) and the extra tolerance fraction. */
  footHalfMax: 0.6,
  supportTolFrac: 0.5,
  /** Gentle horizontal push-out speed (m/frame) when a falling body is embedded in a platform side. */
  pushOutRate: 0.15,
  /** Contact epsilon (m). */
  eps: 1e-4,
  /** Landing impact speed (m/s) above which the `land` event is `hard`. */
  hardLandVy: 14,

  // ── dodge ───────────────────────────────────────────────────────────────
  /** Cooldown frames after a dodge ends before the next. */
  dodgeCd: 60,
  rollSpeed: 7.5,
  /** Last N frames of a roll are the stop. */
  rollStopFrames: 5,
  airDodgeSpeed: 7,
  airDodgeDecay: 0.88,
  /** |move| above this makes a dodge directional (roll / air dodge direction). */
  dodgeDirThreshold: 0.3,

  // ── input buffer ────────────────────────────────────────────────────────
  /** A press is remembered for this many frames (0 = only the pressed frame). */
  inputBuffer: 5,

  // ── combat: damage & knockback (resolveHit) ─────────────────────────────
  percentCap: 999,
  kbCap: 62,
  /** Staling: −3 % per use of the same MoveId among the last 6 connected moves, max −15 %. */
  staleStep: 0.03,
  staleMax: 0.15,
  staleQueue: 6,
  /** hitlag = clamp(round(dmg × 0.4) + 4 + hb.hitlag, 4, 16). */
  hitlagDmgFactor: 0.4,
  hitlagBase: 4,
  hitlagMin: 4,
  hitlagMax: 16,
  /** hitstun = clamp(floor(kb × 0.9 × scale), 6, 60). (WP-T: 0.6 → 0.9 so a strong launch keeps the victim out of air control long enough to reach the side blast zones.) */
  hitstunPerKb: 0.9,
  hitstunMin: 6,
  hitstunMax: 60,
  /** kb above this tumbles. */
  tumbleKb: 20,
  /** During hitstun: horizontal speed ×0.99/frame (WP-T: was 0.985), gravity ×0.85. */
  hitstunDecayX: 0.99,
  hitstunGravityMult: 0.85,
  /** Grounded victim bounced up by a downward launch keeps this fraction of the vertical speed. */
  bounceKeep: 0.8,
  /** A grounded victim whose launch has |vy| below this slides instead of lifting off (m/s). */
  slideVy: 0.5,
  /** Effects. */
  pullSpeedMax: 7,
  stunBonusFrames: 12,
  flinchHitstunMax: 16,
  buryFrames: 30,
  buryKbMax: 24,
  /** Armor default damage scale when `dmgScale` is omitted. */
  armorDmgScale: 1,
  /** Directional influence: total ±deg, per-frame step at full perpendicular input, stick deadzone. */
  diMaxDeg: 12,
  diStepDeg: 2.4,
  diDeadzone: 0.3,

  // ── downed ──────────────────────────────────────────────────────────────
  knockdownFrames: 22,
  getupFrames: 14,
  getupInvuln: 10,
  /** Tumble landing: horizontal speed kept on impact. */
  knockdownSlide: 0.4,

  // ── aerial landing lag defaults (when a body omits `landingLag`) ────────
  landingLagLight: 8,
  landingLagHeavy: 18,

  // ── ledges ──────────────────────────────────────────────────────────────
  /** Grab box (plan §2.1 started at 0.9 × 1.4 m; WP-T widened it to 1.2 × 1.8 m so a fair share of off-stage launches can still be recovered): the body edge nearest the corner may be `Out` outside / `In` inside it; the hand `Up` above to `Down` below it. */
  ledgeBoxOut: 1.1,
  ledgeBoxIn: 0.1,
  ledgeBoxUp: 0.5,
  ledgeBoxDown: 1.3,
  /** Hand/head height as a fraction of the hurtbox height (grab point and hang anchor). */
  ledgeHandFrac: 0.95,
  /** Highest upward speed that can still grab (m/s). */
  ledgeGrabMaxVy: 0.5,
  /**
   * v1.6 LEDGE AUTO-GRAB ASSIST (all animals). The original grab box above is strict, so an airborne fighter that is UNDER or BESIDE a
   * ledge also grabs it automatically when its hand point is inside this larger zone and it is moving toward / holding toward the
   * stage — even while still RISING (jumping up from underneath). `Out` = how far the body edge nearest the corner may be outside the
   * platform end, `Down` / `Up` = hand point below / above the corner height; the inner side is `ledgeBoxIn`. `MinVx` = the
   * horizontal speed toward the stage (m/s) that counts as "moving toward it" (holding the stick toward the stage beyond
   * `turnThreshold` counts too). `RegrabCd` = frames after releasing a ledge during which the ASSIST (not the original box) cannot
   * re-grab (anti-stall on top of `ledgeRegrabCd`, the per-grab invulnerability decay and the max hang time).
   */
  ledgeAssistOut: 2.0,
  ledgeAssistDown: 2.4,
  ledgeAssistUp: 0.3,
  ledgeAssistMinVx: 0.5,
  ledgeAssistRegrabCd: 75,
  /** Hang invulnerability: base frames, minus `Penalty` per grab inside `Window` frames, floor 0. */
  ledgeInvuln: 40,
  ledgeInvulnPenalty: 8,
  ledgeInvulnWindow: 240,
  ledgeMaxHang: 180,
  /** Frames after grabbing before any ledge option is accepted. */
  ledgeMinHang: 6,
  ledgeRegrabCd: 30,
  ledgeClimbFrames: 22,
  ledgeClimbInvuln: 12,
  ledgeRollFrames: 28,
  /** Distance past the corner the roll-up ends at (m, added to the half width). */
  ledgeRollDist: 1.6,
  /** Standing offset past the corner after a climb (m, added to the half width). */
  ledgeClimbOffset: 0.1,
  /** Hang anchor offset outward from the corner (m, added to the half width). */
  ledgeHangOffset: 0.05,

  // ── respawn / KO ────────────────────────────────────────────────────────
  koOutFrames: 90,
  respawnInvuln: 180,
  respawnMinFrames: 40,
  /** Half width of the hovering respawn platform (m). */
  respawnPlatformHalf: 1.4,
  /** A hit counts as the KO killer if it happened within this many frames (4 s). */
  koCreditFrames: 240,

  // ── hurtbox ─────────────────────────────────────────────────────────────
  crouchHeightMult: 0.6,

  // ── v1.6 dynamic stages (Clockwork Heights, Crumbling Amphitheatre; docs/CL-MAPS-PLAN.md) ──
  /**
   * Breakable platforms: an attacker's damaging hitbox counts as a hit on a breakable platform when it overlaps the platform rect expanded
   * by `platHitPad` (m); one count per attacker per move activation and per platform, and at least `platHitCooldown` frames between counts
   * from the same attacker on the same platform (armor / absorbed / whiffed-on-fighters attacks count as well — it is attack based).
   */
  platHitPad: 0.15,
  platHitCooldown: 20,
  /**
   * Ledge EXPOSURE rule: a ledge can only be grabbed while its corner is not covered by another ACTIVE platform at the same height
   * (|Δy| ≤ `ledgeCoverDy`) whose span, widened by `ledgeCoverTol`, contains the corner x (the inner ledges of the unbreakable floors sit flush
   * against breakable tiles).
   */
  ledgeCoverDy: 0.05,
  ledgeCoverTol: 0.05,
  /**
   * Design limits the stage tests enforce on every `path` platform over its whole loop (m/s, m): the Clockwork core peaks below
   * `dynCoreMaxSpeed`, every other moving platform below `dynMaxSpeed`; at any frame at least two satellites are within jump reach of the core
   * top (`dynReachUp` above it, `dynReachSide` sideways of its span); satellites keep `dynSatGap` clear of each other and `dynCoreClear` of the
   * core body.
   */
  dynMaxSpeed: 3.5,
  dynCoreMaxSpeed: 2.5,
  dynReachUp: 4.6,
  dynReachSide: 5,
  dynSatGap: 0.6,
  dynCoreClear: 0.3,
} as const satisfies Record<string, number>;

export type PhysKey = keyof typeof PHYS;
