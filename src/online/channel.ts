/**
 * `LinkChannel`: implements {@link GameChannel} over a set of {@link Link}s (one per remote peer). Frames and
 * unframes messages, drops malformed packets, fans out `onMessage` / `onPeerLeft`. Architect-owned shared code.
 *
 * Usage: the room layer (or a test) creates one `LinkChannel` per machine, calls `addLink(link)` for every open link and
 * routes `Transport` handler callbacks into `handleData` / `handleClose`.
 */

import type { Channel, GameChannel, Link } from './types';
import { frame, unframe } from './wire';

type MessageCb = (peerId: string, kind: number, payload: Uint8Array, channel: Channel) => void;
type LeftCb = (peerId: string, reason: string) => void;

export class LinkChannel implements GameChannel {
  private readonly links = new Map<string, Link>();
  private readonly messageCbs = new Set<MessageCb>();
  private readonly leftCbs = new Set<LeftCb>();

  constructor(readonly localPeerId: string) {}

  addLink(link: Link): void {
    this.links.set(link.peerId, link);
  }

  getLink(peerId: string): Link | undefined {
    return this.links.get(peerId);
  }

  peers(): readonly string[] {
    const out: string[] = [];
    for (const [id, l] of this.links) if (l.open) out.push(id);
    return out;
  }

  rttMs(peerId: string): number {
    return this.links.get(peerId)?.rttMs ?? 0;
  }

  send(peerId: string, channel: Channel, kind: number, payload: Uint8Array): void {
    const l = this.links.get(peerId);
    if (l !== undefined && l.open) l.send(channel, frame(kind, payload));
  }

  broadcast(channel: Channel, kind: number, payload: Uint8Array): void {
    const data = frame(kind, payload);
    for (const l of this.links.values()) if (l.open) l.send(channel, data);
  }

  onMessage(cb: MessageCb): () => void {
    this.messageCbs.add(cb);
    return () => this.messageCbs.delete(cb);
  }

  onPeerLeft(cb: LeftCb): () => void {
    this.leftCbs.add(cb);
    return () => this.leftCbs.delete(cb);
  }

  /** Feed a raw packet received on `link`. Malformed packets are dropped silently. */
  handleData(link: Link, channel: Channel, data: Uint8Array): void {
    let msg: { kind: number; payload: Uint8Array };
    try {
      msg = unframe(data);
    } catch {
      return;
    }
    for (const cb of [...this.messageCbs]) {
      try {
        cb(link.peerId, msg.kind, msg.payload, channel);
      } catch (err) {
        // A faulty handler must never take the connection (or other handlers) down.
        console.error('[online] message handler threw', err);
      }
    }
  }

  handleClose(link: Link, reason: string): void {
    if (this.links.get(link.peerId) !== link) return;
    this.links.delete(link.peerId);
    for (const cb of [...this.leftCbs]) {
      try {
        cb(link.peerId, reason);
      } catch (err) {
        console.error('[online] peer-left handler threw', err);
      }
    }
  }

  /** Close every link (no `onPeerLeft` callbacks for our own teardown). */
  close(): void {
    const all = [...this.links.values()];
    this.links.clear();
    this.messageCbs.clear();
    this.leftCbs.clear();
    for (const l of all) l.close();
  }
}
