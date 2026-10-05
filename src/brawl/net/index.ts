/** Champions League online — rollback netcode (WP-N2). See RollbackSession.ts for the design. */
export { RollbackSession } from './RollbackSession';
export type {
  RollbackDesync,
  RollbackEnd,
  RollbackForfeit,
  RollbackSessionOptions,
  RollbackStats,
  RollbackView,
  RollbackWorld,
} from './types';
export { packIntent, unpackIntent, quantizeIntent, quantizeAxis, clearEdges, IDLE_PACKED, INPUT_BYTES } from './inputCodec';
export type { PackedInput } from './inputCodec';
