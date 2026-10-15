/**
 * Pure-JS, synchronous HMAC-SHA256 for the pair handshake (F-24): the remote page is
 * a non-secure context, so `crypto.subtle` is unavailable. Both ends share this file.
 * Proof: `base64url(HMAC-SHA256(pairSecret, nonce + '\n' + clientId))`.
 */

// ---- base64url -------------------------------------------------------------

const B64U = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_'

function base64urlEncode(bytes: Uint8Array): string {
  let out = ''
  let i = 0
  const n = bytes.byteLength
  for (; i + 3 <= n; i += 3) {
    const v = (bytes[i] << 16) | (bytes[i + 1] << 8) | bytes[i + 2]
    out += B64U[(v >> 18) & 63] + B64U[(v >> 12) & 63] + B64U[(v >> 6) & 63] + B64U[v & 63]
  }
  if (i < n) {
    const a = bytes[i]
    const b = i + 1 < n ? bytes[i + 1] : 0
    out += B64U[(a >> 2) & 63] + B64U[((a & 3) << 4 | (b >> 4)) & 63]
    if (i + 1 < n) out += B64U[(b & 15) << 2]
  }
  return out
}

function base64urlDecode(text: string): Uint8Array | null {
  const rev = new Int16Array(128).fill(-1)
  for (let i = 0; i < 64; i += 1) rev[B64U.charCodeAt(i)] = i
  const clean = text.replace(/=+$/, '')
  const out: number[] = []
  let acc = 0
  let bits = 0
  for (const ch of clean) {
    const code = ch.charCodeAt(0)
    const v = code < 128 ? rev[code] : -1
    if (v < 0) return null
    acc = (acc << 6) | v
    bits += 6
    if (bits >= 8) {
      bits -= 8
      out.push((acc >> bits) & 0xff)
    }
  }
  return new Uint8Array(out)
}

// ---- SHA-256 ---------------------------------------------------------------

const K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
])

function rotr(x: number, n: number): number {
  return (x >>> n) | (x << (32 - n))
}

function sha256(message: Uint8Array): Uint8Array {
  const bitLen = message.byteLength * 8
  // Padded length: message + 0x80 + zeros + 8-byte big-endian length, to a 64 multiple.
  const withOne = message.byteLength + 1
  const paddedLen = Math.ceil((withOne + 8) / 64) * 64
  const buf = new Uint8Array(paddedLen)
  buf.set(message)
  buf[message.byteLength] = 0x80
  const view = new DataView(buf.buffer)
  // bitLen fits in 53 bits for any realistic input; write high then low 32.
  view.setUint32(paddedLen - 8, Math.floor(bitLen / 0x100000000), false)
  view.setUint32(paddedLen - 4, bitLen >>> 0, false)

  const h = new Uint32Array([0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19])
  const w = new Uint32Array(64)
  for (let block = 0; block < paddedLen; block += 64) {
    for (let t = 0; t < 16; t += 1) w[t] = view.getUint32(block + t * 4, false)
    for (let t = 16; t < 64; t += 1) {
      const s0 = rotr(w[t - 15], 7) ^ rotr(w[t - 15], 18) ^ (w[t - 15] >>> 3)
      const s1 = rotr(w[t - 2], 17) ^ rotr(w[t - 2], 19) ^ (w[t - 2] >>> 10)
      w[t] = (w[t - 16] + s0 + w[t - 7] + s1) | 0
    }
    let [a, b, c, d, e, f, g, hh] = h
    for (let t = 0; t < 64; t += 1) {
      const S1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25)
      const ch = (e & f) ^ (~e & g)
      const temp1 = (hh + S1 + ch + K[t] + w[t]) | 0
      const S0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22)
      const maj = (a & b) ^ (a & c) ^ (b & c)
      const temp2 = (S0 + maj) | 0
      hh = g; g = f; f = e; e = (d + temp1) | 0
      d = c; c = b; b = a; a = (temp1 + temp2) | 0
    }
    h[0] = (h[0] + a) | 0; h[1] = (h[1] + b) | 0; h[2] = (h[2] + c) | 0; h[3] = (h[3] + d) | 0
    h[4] = (h[4] + e) | 0; h[5] = (h[5] + f) | 0; h[6] = (h[6] + g) | 0; h[7] = (h[7] + hh) | 0
  }
  const out = new Uint8Array(32)
  const ov = new DataView(out.buffer)
  for (let i = 0; i < 8; i += 1) ov.setUint32(i * 4, h[i], false)
  return out
}

// ---- HMAC-SHA256 -----------------------------------------------------------

function hmacSha256(key: Uint8Array, message: Uint8Array): Uint8Array {
  const blockSize = 64
  let k = key
  if (k.byteLength > blockSize) k = sha256(k)
  const ipad = new Uint8Array(blockSize)
  const opad = new Uint8Array(blockSize)
  for (let i = 0; i < blockSize; i += 1) {
    const b = i < k.byteLength ? k[i] : 0
    ipad[i] = b ^ 0x36
    opad[i] = b ^ 0x5c
  }
  const inner = new Uint8Array(blockSize + message.byteLength)
  inner.set(ipad)
  inner.set(message, blockSize)
  const innerHash = sha256(inner)
  const outer = new Uint8Array(blockSize + 32)
  outer.set(opad)
  outer.set(innerHash, blockSize)
  return sha256(outer)
}

// ---- the pair proof --------------------------------------------------------

const encoder = new TextEncoder()

/**
 * `base64url(HMAC-SHA256(base64urlDecode(pairSecret), utf8(nonce + '\n' + clientId)))`
 * — the frozen proof of frames.ts:111. Returns '' for a malformed secret.
 */
export function pairProof(pairSecretB64u: string, nonce: string, clientId: string): string {
  const secret = base64urlDecode(pairSecretB64u)
  if (!secret) return ''
  const message = encoder.encode(nonce + '\n' + clientId)
  return base64urlEncode(hmacSha256(secret, message))
}

/**
 * Constant-time string equality over equal-length base64url strings — a timing
 * oracle on the proof would leak it byte by byte. Length inequality is not
 * secret (proofs are fixed-length), so it returns early there.
 */
export function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i += 1) diff |= a.charCodeAt(i) ^ b.charCodeAt(i)
  return diff === 0
}
