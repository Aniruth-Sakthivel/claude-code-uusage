/**
 * UUIDv7 — time-ordered UUIDs.
 *
 * Implemented here rather than taken as a dependency: it is forty lines of a
 * published, stable specification (RFC 9562 §5.7), and it sits on the write
 * path of every table in the system.
 *
 * Why v7 and not identity integers or v4 — see adr/0009. In short: identity
 * integers leak business volume and block client-generated ids (which
 * optimistic creates need), while v4's randomness destroys B-tree locality on
 * insert. v7 puts a 48-bit millisecond timestamp in the high bits, so recent
 * rows land adjacent in the index, the way an identity integer would.
 *
 * Layout:
 *   ┌─ 48 bits unix_ts_ms ─┬ 4 ver ┬─ 12 rand_a ─┬ 2 var ┬─ 62 rand_b ─┐
 */

const HEX = Array.from({ length: 256 }, (_, i) => i.toString(16).padStart(2, "0"));

/** Monotonic guard: same-millisecond calls must still order correctly. */
let lastMs = -1;
let lastSeq = 0;

export function uuidv7(now: number = Date.now()): string {
  const bytes = new Uint8Array(16);

  // 48-bit big-endian millisecond timestamp.
  const ms = Math.max(now, 0);
  bytes[0] = (ms / 0x10000000000) & 0xff;
  bytes[1] = (ms / 0x100000000) & 0xff;
  bytes[2] = (ms / 0x1000000) & 0xff;
  bytes[3] = (ms / 0x10000) & 0xff;
  bytes[4] = (ms / 0x100) & 0xff;
  bytes[5] = ms & 0xff;

  // Within a single millisecond, a 12-bit counter in rand_a preserves ordering.
  // Without it, two ids minted in the same millisecond sort arbitrarily, which
  // defeats the reason for choosing v7 at all.
  if (ms === lastMs) {
    lastSeq = (lastSeq + 1) & 0x0fff;
  } else {
    lastMs = ms;
    lastSeq = randomInt12();
  }

  bytes[6] = 0x70 | ((lastSeq >>> 8) & 0x0f); // version 7 + high nibble of seq
  bytes[7] = lastSeq & 0xff;

  const rand = randomBytes(8);
  bytes[8] = 0x80 | (rand[0]! & 0x3f); // variant 10
  for (let i = 1; i < 8; i++) bytes[8 + i] = rand[i]!;

  return (
    HEX[bytes[0]!]! + HEX[bytes[1]!]! + HEX[bytes[2]!]! + HEX[bytes[3]!]! + "-" +
    HEX[bytes[4]!]! + HEX[bytes[5]!]! + "-" +
    HEX[bytes[6]!]! + HEX[bytes[7]!]! + "-" +
    HEX[bytes[8]!]! + HEX[bytes[9]!]! + "-" +
    HEX[bytes[10]!]! + HEX[bytes[11]!]! + HEX[bytes[12]!]! +
    HEX[bytes[13]!]! + HEX[bytes[14]!]! + HEX[bytes[15]!]!
  );
}

function randomBytes(n: number): Uint8Array {
  const out = new Uint8Array(n);
  globalThis.crypto.getRandomValues(out);
  return out;
}

function randomInt12(): number {
  const b = randomBytes(2);
  return ((b[0]! << 8) | b[1]!) & 0x0fff;
}

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isUuid(value: unknown): value is string {
  return typeof value === "string" && UUID_RE.test(value);
}

/** Extract the embedded millisecond timestamp. Useful in tests and debugging. */
export function uuidv7Timestamp(id: string): number {
  const hex = id.replace(/-/g, "").slice(0, 12);
  return Number.parseInt(hex, 16);
}
