/**
 * First-person profile format (v1.3 WP-Q, docs/UPGRADE-PLAN-v1.3.md §5).
 *
 * One {@link FpProfile} per animal lives in `src/render/animals/fp/<animal>.ts`
 * and is looked up through `fp/index.ts`. It describes, for the LOCAL player's
 * own rig only:
 *
 *  - where the camera's eye sits (`eye`, rig-local metres),
 *  - which parts of the baked body are hidden (`hide` / `keepFront`),
 *  - the near plane, run bob and how much the eye follows the head's motion,
 *  - optional per-action eye offsets (`eyeAction`) and FP-only pose
 *    adjustments (`pose`) that never touch the shared third-person poses.
 *
 * NAMES: a "joint name" is the property name the animal's rig class uses for
 * that joint (`head`, `neck`, `jaw`, `mane`, `wingLIn`, `tail2`, …). Arrays of
 * joints are addressed by index: `legs.0` (FL), `legs.1` (FR), `legs.2` (BL),
 * `legs.3` (BR), `primL.2`, … `_root` is the rig's un-jointed bone (parts that
 * sit directly under the body root). `BaseRig.describeJoints()` lists every
 * name with its triangle count and rest-pose bounding box (use it, e.g. via
 * `window.__gkFp.joints('lion')`, when authoring or adjusting a profile).
 *
 * COORDINATES: rig-local rest space — +z forward, +y up, +x = the animal's
 * LEFT (three.js right-handed, facing +z). Camera-side conventions used by
 * poses: a positive `rx` swings a limb forward/down-to-forward (a leg that
 * hangs along −y ends up pointing +z), see the shared poses for examples.
 */

import type { AnimalId, FighterAction, FighterState } from '../../../core/types';
import type { Joint } from '../Animator';

/** Eye point in rig-local rest space (metres). `side` is local +x (animal's left). */
export interface FpEye {
  forward: number;
  up: number;
  side: number;
}

/**
 * A limb "viewmodel" placement (FPS-style): the limb joint is pinned to the
 * CAMERA instead of the body, so paws / claws / wings appear at fixed spots on
 * screen whatever the body does (rolls, rears, spins). Eye-space axes:
 * x = right, y = up, z = forward (metres, from the camera). The limb's shaft is
 * the joint's local −Y (legs / arms hang along −Y; toes/fists face local +Z).
 * The joint pivot (shoulder / hip) is placed at (x, y, z); the shaft points
 * `down` radians below the view horizon and `out` radians to the right of
 * straight ahead; `roll` twists the paw about the shaft. `w` (0..1) fades the
 * pin in/out (default 1); the placement is also blended in with the
 * third→first-person camera transition.
 */
export interface FpLimb {
  x: number;
  y: number;
  z: number;
  down: number;
  out: number;
  roll?: number;
  w?: number;
  /**
   * Which local axis is the shaft: `'-y'` (default) for hanging limbs, `'+x'` / `'-x'` for wings that
   * extend along local +X / −X (the joint's local +Y stays as close to the view's up as possible).
   */
  axis?: '-y' | '+x' | '-x';
}

/** Everything a profile's FP-only pose hook may read / write. */
export interface FpPoseCtx {
  action: FighterAction;
  /** Action progress 0..1 (actionT / actionDur; 0 when the action has no duration). */
  u: number;
  state: FighterState;
  /** Horizontal speed (m/s). */
  speed: number;
  /** Running clock (s) for ambient sway. */
  t: number;
  /** Gait phase (rad) — advances with distance travelled. */
  gait: number;
  /** Look-pitch of the camera (rad, + = up) so poses can react to where the player looks. */
  look: number;
  /** Run intensity 0..1 (horizontal speed / the animal's top speed). */
  run: number;
  /** Joint by name (see file header). Undefined when the rig has no such joint. */
  j(name: string): Joint | undefined;
  /** Joint by name, guaranteed (an inert dummy joint when missing) — for terse pose code. */
  J(name: string): Joint;
  /**
   * Pin a limb joint to the camera for this frame (viewmodel placement, see
   * {@link FpLimb}). Call every frame the limb should be pinned; unmentioned
   * limbs stay on the body.
   */
  limb(name: string, spec: FpLimb): void;
}

/**
 * What the CameraRig asks the local player's rig for each frame (all world
 * space). The rig fills it in `BaseRig.sampleFpEye`; the camera smooths `rel*`
 * lightly (never the root position, so there is no translation lag) and adds
 * the un-smoothed bob on top.
 */
export interface FpEyeSample {
  /** Rig root (feet) world position. */
  rootX: number;
  rootY: number;
  rootZ: number;
  /** Eye offset from the root, world axes (rig yaw already applied). */
  relX: number;
  relY: number;
  relZ: number;
  /** Un-smoothed run bob (m, vertical) and sway (m, along camera-right). */
  bobY: number;
  bobSide: number;
  /** Small run roll (rad) — level otherwise. */
  roll: number;
  /** Near plane requested by the active profile. */
  near: number;
}

/**
 * Screen-space "safe zone" (centre of the screen, fractions of the screen WIDTH / HEIGHT) in which NO fragment of the own
 * rig is ever drawn in first person — where the crosshair and the aim live. See `fp/clip.ts`.
 */
export interface FpClip {
  /** Width of the safe zone as a fraction of the screen width (0..1), centred. */
  w: number;
  /** Height of the safe zone as a fraction of the screen height (0..1), centred. */
  h: number;
}

export interface FpProfile {
  animal: AnimalId;
  /** Camera eye in rig-local rest space. */
  eye: FpEye;
  /**
   * Joint names whose OWN triangles are hidden for the local player (head, neck, mane, ears, beak, jaw …). A triangle is hidden
   * when ANY of its vertices is skinned to a hidden bone (so no half-drawn head part can survive), in the body, glow and
   * outline-hull meshes alike.
   */
  hide: string[];
  /**
   * Partial hide: for a joint listed in `hide`, triangles whose rest-pose
   * forward coordinate is ≥ this value stay visible (snout tips, beaks, jaws
   * that should appear at the bottom of the view). Key = joint name.
   * NOT used by the animals with an enforced clear view (crocodile, hippo, rhino, eagle): a cut through a head mesh leaves
   * fragmentary geometry.
   */
  keepFront?: Record<string, number>;
  /**
   * Generic screen-space clear zone: every own-rig fragment (body, glow, outline hull) inside it is discarded in first
   * person, whatever the pose / camera. Enabled for the animals whose own model used to get in the way (crocodile, hippo,
   * rhino, eagle); absent = no clipping, the rig renders as before.
   */
  clip?: FpClip;
  /** Camera near plane (m) — small enough that visible limbs never clip. */
  nearPlane: number;
  /** Joint whose motion the eye follows (default `head`). */
  track?: string;
  /**
   * 0..1: how much of the tracked joint's translation (relative to rest) the
   * eye picks up. 0 = rigid on the root, 1 = glued to the head. Default 0.6.
   */
  follow?: number;
  /** Run bob amplitude in metres (vertical). 0 disables. Default 0.02. */
  bob?: number;
  /** Strength of the small camera dip when the player's own swing lands (default 1; headless / limbless animals want more). */
  attackKick?: number;
  /** How much of the camera's look-pitch pinned limbs follow (0..1, default 0.7). */
  viewPitch?: number;
  /** Idle breathing sway amplitude in metres. Default 0.006. */
  idleSway?: number;
  /** Eye offsets (added to `eye`) while an action runs; eased on the rig side. */
  eyeAction?: Partial<Record<FighterAction, Partial<FpEye>>>;
  /**
   * FP-only pose adjustments, run after the shared pose has written the joint
   * targets. Write the same channels the shared poses use (`rx/ry/rz`,
   * `px/py/pz`, `s`); the rig blends them in/out with the FP weight so a mode
   * switch never pops. Called every frame while first-person is active.
   */
  pose?: (ctx: FpPoseCtx) => void;
}
