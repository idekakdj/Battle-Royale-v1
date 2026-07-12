/**
 * WP-C barrel — bot AI public surface (BLUEPRINT §10 / §14).
 *
 * WP-I needs only {@link BotManager}: construct it with the SAME EventBus the
 * World emits on, call `update(world.snapshot(), dt)` once per tick, then
 * `world.setIntent(id, bots.getIntent(id))` for each bot fighter.
 */

export { BotManager } from './BotManager';
export { BotBrain } from './BotBrain';
export { Perception, hasLineOfSight, type TrackedEnemy } from './Perception';
