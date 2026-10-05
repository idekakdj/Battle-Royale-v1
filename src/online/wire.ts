/**
 * Online multiplayer — binary wire helpers (v1.5). Architect-owned shared utility.
 *
 * Every message on a {@link Link} is `[kind: u8][payload…]` (see `MSG` in types.ts). Payloads are written with
 * {@link ByteWriter} / read with {@link ByteReader}: little-endian, bounds-checked (a short or corrupt packet throws
 * `RangeError`, which callers must catch and drop — never trust the network).
 */

const enc = new TextEncoder();
const dec = new TextDecoder();

export class ByteWriter {
  private buf: Uint8Array;
  private view: DataView;
  private pos = 0;

  constructor(capacity = 256) {
    this.buf = new Uint8Array(Math.max(16, capacity));
    this.view = new DataView(this.buf.buffer);
  }

  get length(): number {
    return this.pos;
  }

  private ensure(n: number): void {
    const need = this.pos + n;
    if (need <= this.buf.length) return;
    let cap = this.buf.length * 2;
    while (cap < need) cap *= 2;
    const next = new Uint8Array(cap);
    next.set(this.buf.subarray(0, this.pos));
    this.buf = next;
    this.view = new DataView(next.buffer);
  }

  u8(v: number): this {
    this.ensure(1);
    this.view.setUint8(this.pos, v & 0xff);
    this.pos += 1;
    return this;
  }
  i8(v: number): this {
    this.ensure(1);
    this.view.setInt8(this.pos, v);
    this.pos += 1;
    return this;
  }
  u16(v: number): this {
    this.ensure(2);
    this.view.setUint16(this.pos, v & 0xffff, true);
    this.pos += 2;
    return this;
  }
  i16(v: number): this {
    this.ensure(2);
    this.view.setInt16(this.pos, v, true);
    this.pos += 2;
    return this;
  }
  u32(v: number): this {
    this.ensure(4);
    this.view.setUint32(this.pos, v >>> 0, true);
    this.pos += 4;
    return this;
  }
  i32(v: number): this {
    this.ensure(4);
    this.view.setInt32(this.pos, v | 0, true);
    this.pos += 4;
    return this;
  }
  f32(v: number): this {
    this.ensure(4);
    this.view.setFloat32(this.pos, v, true);
    this.pos += 4;
    return this;
  }
  f64(v: number): this {
    this.ensure(8);
    this.view.setFloat64(this.pos, v, true);
    this.pos += 8;
    return this;
  }
  /** Unsigned LEB128 (values 0 … 2^32−1). */
  varu(v: number): this {
    let x = v >>> 0;
    while (x >= 0x80) {
      this.u8((x & 0x7f) | 0x80);
      x >>>= 7;
    }
    return this.u8(x);
  }
  bytes(b: Uint8Array): this {
    this.ensure(b.length);
    this.buf.set(b, this.pos);
    this.pos += b.length;
    return this;
  }
  /** Length-prefixed UTF-8 string. */
  str(s: string): this {
    const b = enc.encode(s);
    this.varu(b.length);
    return this.bytes(b);
  }
  /** A copy of what has been written so far. */
  finish(): Uint8Array {
    return this.buf.slice(0, this.pos);
  }
}

export class ByteReader {
  private readonly view: DataView;
  pos = 0;

  constructor(private readonly data: Uint8Array) {
    this.view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  }

  get remaining(): number {
    return this.data.length - this.pos;
  }

  private take(n: number): number {
    if (n < 0 || this.pos + n > this.data.length) throw new RangeError('ByteReader: out of bounds');
    const at = this.pos;
    this.pos += n;
    return at;
  }

  u8(): number {
    return this.view.getUint8(this.take(1));
  }
  i8(): number {
    return this.view.getInt8(this.take(1));
  }
  u16(): number {
    return this.view.getUint16(this.take(2), true);
  }
  i16(): number {
    return this.view.getInt16(this.take(2), true);
  }
  u32(): number {
    return this.view.getUint32(this.take(4), true);
  }
  i32(): number {
    return this.view.getInt32(this.take(4), true);
  }
  f32(): number {
    return this.view.getFloat32(this.take(4), true);
  }
  f64(): number {
    return this.view.getFloat64(this.take(8), true);
  }
  varu(): number {
    let result = 0;
    let shift = 0;
    for (let i = 0; i < 5; i++) {
      const b = this.u8();
      result += (b & 0x7f) * 2 ** shift;
      if ((b & 0x80) === 0) return result;
      shift += 7;
    }
    throw new RangeError('ByteReader: varint too long');
  }
  /** A view (no copy) of the next `n` bytes. */
  bytes(n: number): Uint8Array {
    const at = this.take(n);
    return this.data.subarray(at, at + n);
  }
  str(): string {
    const n = this.varu();
    return dec.decode(this.bytes(n));
  }
}

/** `[kind][payload]`. */
export function frame(kind: number, payload?: Uint8Array): Uint8Array {
  const len = payload === undefined ? 0 : payload.length;
  const out = new Uint8Array(1 + len);
  out[0] = kind & 0xff;
  if (payload !== undefined) out.set(payload, 1);
  return out;
}

/** Splits a framed message; throws `RangeError` on an empty packet. The payload is a view into `data`. */
export function unframe(data: Uint8Array): { kind: number; payload: Uint8Array } {
  if (data.length < 1) throw new RangeError('unframe: empty packet');
  return { kind: data[0], payload: data.subarray(1) };
}

export function utf8(s: string): Uint8Array {
  return enc.encode(s);
}

export function fromUtf8(b: Uint8Array): string {
  return dec.decode(b);
}

/** JSON payload helpers for low-rate reliable lobby messages. */
export function jsonPayload(obj: unknown): Uint8Array {
  return enc.encode(JSON.stringify(obj));
}

export function parseJsonPayload<T>(payload: Uint8Array): T {
  return JSON.parse(dec.decode(payload)) as T;
}
