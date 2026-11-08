// Crockford base32, lowercase: no i, l, o, u, so IDs are easy to read and type.
const ALPHABET = '0123456789abcdefghjkmnpqrstvwxyz';
export const ID_PATTERN = /^[0-9a-hjkmnp-tv-z]{6}$/;

/** Source of random bytes; injectable so tests and pinned runs stay deterministic. */
export type RandomBytes = (n: number) => Uint8Array;

export const cryptoRandomBytes: RandomBytes = (n) => crypto.getRandomValues(new Uint8Array(n));

/** Deterministic byte source (xorshift32), for tests and reproducible fixtures. */
export function seededRandomBytes(seed: number): RandomBytes {
  let state = seed >>> 0 || 0x9e3779b9;
  return (n) => {
    const out = new Uint8Array(n);
    for (let i = 0; i < n; i++) {
      state ^= state << 13;
      state ^= state >>> 17;
      state ^= state << 5;
      state >>>= 0;
      out[i] = state & 0xff;
    }
    return out;
  };
}

/** A new 6-character lowercase base32 ID not contained in `taken` (spec §4). */
export function newId(taken: ReadonlySet<string>, random: RandomBytes = cryptoRandomBytes): string {
  for (;;) {
    const bytes = random(6);
    let id = '';
    for (const b of bytes) id += ALPHABET[b & 31];
    if (!taken.has(id)) return id;
  }
}
