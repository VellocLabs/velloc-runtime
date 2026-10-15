/**
 * An RFC 4122 v4 UUID that works off a secure context (where
 * `crypto.randomUUID` is absent), built from `crypto.getRandomValues`;
 * `Math.random()` only when there is no `crypto` at all. Client trees may not
 * call `crypto.randomUUID` directly.
 */

const HEX: readonly string[] = Array.from({ length: 256 }, (_, i) => i.toString(16).padStart(2, '0'))

/** Lay 16 bytes out as `xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx` (RFC 4122 section 4.4). */
function formatV4(bytes: Uint8Array): string {
  // version 4 in the high nibble of byte 6; variant 10xx in the top bits of byte 8
  bytes[6] = (bytes[6]! & 0x0f) | 0x40
  bytes[8] = (bytes[8]! & 0x3f) | 0x80
  const h = (i: number): string => HEX[bytes[i]!]!
  return (
    h(0) + h(1) + h(2) + h(3) + '-' +
    h(4) + h(5) + '-' +
    h(6) + h(7) + '-' +
    h(8) + h(9) + '-' +
    h(10) + h(11) + h(12) + h(13) + h(14) + h(15)
  )
}

export function randomUuid(): string {
  const cryptoObj = (globalThis as { crypto?: Crypto }).crypto
  if (typeof cryptoObj?.randomUUID === 'function') {
    try {
      return cryptoObj.randomUUID()
    } catch {
      // A non-secure context can expose the method and still throw; fall through.
    }
  }
  const bytes = new Uint8Array(16)
  if (typeof cryptoObj?.getRandomValues === 'function') {
    cryptoObj.getRandomValues(bytes)
  } else {
    for (let i = 0; i < 16; i += 1) bytes[i] = Math.floor(Math.random() * 256)
  }
  return formatV4(bytes)
}
