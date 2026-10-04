// Browser stand-in for `node:crypto`, imported (through the payload's import map) by the in-page game server:
// server/net.js uses randomBytes() for session tokens, server/lobby.js uses randomBytes()/randomInt() for AI ids,
// room codes and the match seed. Only those two functions are provided.
//
// The bytes come from WebCrypto (crypto.getRandomValues); the Math.random fallback only exists for an environment
// without it and is never expected in the packaged WebViews.

const HEX = '0123456789abcdef';

/**
 * `crypto.randomBytes(size)` — a Uint8Array carrying node's `Buffer.toString('hex')` contract (the only encoding
 * the callers use).
 * @param {number} size
 */
export function randomBytes(size) {
  const len = Number(size) >>> 0;
  const buf = new Uint8Array(len);
  if (globalThis.crypto?.getRandomValues) globalThis.crypto.getRandomValues(buf);
  else for (let i = 0; i < len; i++) buf[i] = (Math.random() * 256) | 0;
  buf.toString = function toString(encoding) {
    if (encoding === 'hex') {
      let s = '';
      for (let i = 0; i < this.length; i++) s += HEX[this[i] >> 4] + HEX[this[i] & 15];
      return s;
    }
    return Array.from(this).join(',');
  };
  return buf;
}

/**
 * `crypto.randomInt(max)` (returns [0, max)) or `crypto.randomInt(min, max)` (returns [min, max)).
 * Unbiased: values in the top partial bucket are rejected rather than folded in.
 * @param {...number} args
 */
export function randomInt(...args) {
  let min = 0;
  let max;
  if (args.length === 1) max = args[0];
  else { min = args[0]; max = args[1]; }
  const range = max - min;
  if (!Number.isInteger(range) || range <= 0) throw new RangeError('randomInt: invalid range');
  const limit = Math.floor(0x100000000 / range) * range;
  const u32 = new Uint32Array(1);
  let x;
  do {
    if (globalThis.crypto?.getRandomValues) globalThis.crypto.getRandomValues(u32);
    else u32[0] = (Math.random() * 0x100000000) >>> 0;
    x = u32[0];
  } while (x >= limit);
  return min + (x % range);
}
