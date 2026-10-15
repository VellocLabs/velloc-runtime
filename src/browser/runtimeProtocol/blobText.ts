/**
 * Text encoding for a blob chunk on a WebSocket (F-24): the C++ listener speaks TEXT
 * frames only, so a chunk travels base64-encoded prefixed with 'B' (a JSON frame
 * starts with '{'). No `btoa` or `crypto`: the remote page is a non-secure context.
 */

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'

/** base64-encode bytes (standard alphabet, with padding). */
export function base64Encode(bytes: Uint8Array): string {
  let out = ''
  let i = 0
  const n = bytes.byteLength
  // 3 bytes -> 4 sextets.
  for (; i + 3 <= n; i += 3) {
    const v = (bytes[i] << 16) | (bytes[i + 1] << 8) | bytes[i + 2]
    out += ALPHABET[(v >> 18) & 63] + ALPHABET[(v >> 12) & 63] + ALPHABET[(v >> 6) & 63] + ALPHABET[v & 63]
  }
  if (i < n) {
    const a = bytes[i]
    const b = i + 1 < n ? bytes[i + 1] : 0
    out += ALPHABET[(a >> 2) & 63] + ALPHABET[((a & 3) << 4 | (b >> 4)) & 63]
    out += i + 1 < n ? ALPHABET[(b & 15) << 2] + '=' : '=='
  }
  return out
}

const REV = (() => {
  const table = new Int16Array(128).fill(-1)
  for (let i = 0; i < 64; i += 1) table[ALPHABET.charCodeAt(i)] = i
  return table
})()

/** base64-decode; null for anything malformed (bad char, bad padding, bad length). */
export function base64Decode(text: string): Uint8Array | null {
  const n = text.length
  if (n === 0) return new Uint8Array(0)
  if (n % 4 !== 0) return null
  let padding = 0
  if (text.charCodeAt(n - 1) === 61 /* = */) padding += 1
  if (n >= 2 && text.charCodeAt(n - 2) === 61) padding += 1
  const byteLength = (n / 4) * 3 - padding
  const out = new Uint8Array(byteLength)
  let o = 0
  for (let i = 0; i < n; i += 4) {
    const last = i + 4 === n
    const quad = [0, 1, 2, 3].map(k => {
      const code = text.charCodeAt(i + k)
      if (code === 61) return last && k >= 4 - padding ? 0 : -1 // '=' only as trailing padding
      return code < 128 ? REV[code] : -1
    })
    if (quad[0] < 0 || quad[1] < 0 || quad[2] < 0 || quad[3] < 0) return null
    const v = (quad[0] << 18) | (quad[1] << 12) | (quad[2] << 6) | quad[3]
    if (o < byteLength) out[o++] = (v >> 16) & 0xff
    if (o < byteLength) out[o++] = (v >> 8) & 0xff
    if (o < byteLength) out[o++] = v & 0xff
  }
  return out
}
