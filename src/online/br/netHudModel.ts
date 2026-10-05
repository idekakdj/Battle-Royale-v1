/**
 * Net HUD view-model (WP-N6): turns raw network numbers into what the small overlay shows. Pure (no DOM) so it is unit-tested.
 */

export type LinkQuality = 'good' | 'ok' | 'poor' | 'bad';

export interface NetHudInput {
  role: 'host' | 'client';
  /** Client: round trip to the host. Host: the worst round trip among connected clients (0 = unknown). */
  pingMs: number;
  /** Client only: snapshot loss 0..1 over the last seconds. */
  loss: number;
  /** Client only: ms since anything arrived from the host. */
  hostSilenceMs: number;
  /** Client only: the first host snapshot has been rendered. */
  haveSnapshot: boolean;
  /** Host only: remote players whose match screen has not reported in yet (the countdown waits for them). */
  waitingFor: readonly string[];
}

export interface NetHudState {
  /** One line, e.g. `PING 42 ms · LOSS 1%`. */
  text: string;
  quality: LinkQuality;
  /** Big centred message (waiting / reconnecting) or null. */
  banner: string | null;
}

/** Silence after which the client shows "Reconnecting…". */
export const RECONNECT_BANNER_MS = 1500;
/** Silence after which a client that had a picture gives up on the host. */
export const HOST_TIMEOUT_MS = 15000;
/** A client that never got its first snapshot gives up after this long. */
export const FIRST_SNAPSHOT_TIMEOUT_MS = 25000;

export function qualityOf(pingMs: number, loss: number): LinkQuality {
  if (loss >= 0.15 || pingMs >= 240) return 'bad';
  if (loss >= 0.07 || pingMs >= 140) return 'poor';
  if (loss >= 0.02 || pingMs >= 75) return 'ok';
  return 'good';
}

function joinNames(names: readonly string[]): string {
  if (names.length <= 1) return names[0] ?? '';
  if (names.length === 2) return `${names[0]} and ${names[1]}`;
  return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
}

export function describeLink(i: NetHudInput): NetHudState {
  const ping = i.pingMs > 0 ? `${Math.round(i.pingMs)} ms` : '– ms';
  if (i.role === 'host') {
    return {
      text: i.pingMs > 0 ? `HOST · WORST PING ${ping}` : 'HOST',
      quality: i.pingMs > 0 ? qualityOf(i.pingMs, 0) : 'good',
      banner: i.waitingFor.length > 0 ? `Waiting for ${joinNames(i.waitingFor)}…` : null,
    };
  }
  const lossPct = Math.round(Math.min(1, Math.max(0, i.loss)) * 100);
  let banner: string | null = null;
  let quality = qualityOf(i.pingMs, i.loss);
  if (!i.haveSnapshot) banner = 'Connecting to the host…';
  else if (i.hostSilenceMs >= RECONNECT_BANNER_MS) {
    banner = 'Reconnecting…';
    quality = 'bad';
  }
  return { text: `PING ${ping} · LOSS ${lossPct}%`, quality, banner };
}

/** Should the client give up on the host (→ `onExit({reason:'timeout'})`)? */
export function hostTimedOut(haveSnapshot: boolean, hostSilenceMs: number, sinceStartMs: number): boolean {
  if (haveSnapshot) return hostSilenceMs >= HOST_TIMEOUT_MS;
  return sinceStartMs >= FIRST_SNAPSHOT_TIMEOUT_MS;
}
