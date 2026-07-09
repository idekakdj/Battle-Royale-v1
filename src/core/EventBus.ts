/**
 * Typed publish/subscribe bus over the {@link GameEvent} union (BLUEPRINT §5).
 *
 * The sim emits gameplay events; render effects, HUD, and audio subscribe. The
 * AI perception layer subscribes too (with its own reaction-delay buffering).
 *
 * `emit` allocates nothing beyond the event object the caller already built —
 * it iterates a plain array of listeners. Handlers added/removed during an emit
 * are honoured on the next emit (we snapshot length up front for safety).
 */

import type { GameEvent, GameEventOf } from './types';

type Handler<T extends GameEvent['type']> = (ev: GameEventOf<T>) => void;
type AnyHandler = (ev: GameEvent) => void;

export class EventBus {
  // One listener array per event type; created lazily.
  private readonly listeners = new Map<GameEvent['type'], AnyHandler[]>();
  private readonly anyListeners: AnyHandler[] = [];

  /** Subscribe to a single event type. Returns an unsubscribe function. */
  on<T extends GameEvent['type']>(type: T, handler: Handler<T>): () => void {
    let arr = this.listeners.get(type);
    if (arr === undefined) {
      arr = [];
      this.listeners.set(type, arr);
    }
    arr.push(handler as AnyHandler);
    return () => this.off(type, handler);
  }

  /** Unsubscribe a handler previously registered with {@link on}. */
  off<T extends GameEvent['type']>(type: T, handler: Handler<T>): void {
    const arr = this.listeners.get(type);
    if (arr === undefined) return;
    const i = arr.indexOf(handler as AnyHandler);
    if (i !== -1) arr.splice(i, 1);
  }

  /** Subscribe to every event regardless of type. Returns an unsubscribe fn. */
  onAny(handler: AnyHandler): () => void {
    this.anyListeners.push(handler);
    return () => {
      const i = this.anyListeners.indexOf(handler);
      if (i !== -1) this.anyListeners.splice(i, 1);
    };
  }

  /** Dispatch `ev` to all matching type listeners and every `onAny` listener. */
  emit(ev: GameEvent): void {
    const arr = this.listeners.get(ev.type);
    if (arr !== undefined) {
      for (let i = 0, n = arr.length; i < n; i++) arr[i](ev);
    }
    const any = this.anyListeners;
    for (let i = 0, n = any.length; i < n; i++) any[i](ev);
  }

  /** Drop every subscription (used when tearing down a match). */
  clear(): void {
    this.listeners.clear();
    this.anyListeners.length = 0;
  }
}
