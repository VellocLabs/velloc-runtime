/**
 * (F-24): the text blob encoding
 * (blobText.ts) and the pure-JS pair proof (pairProof.ts). Cross-checked
 * against the independent Python vectors in vectors/v1-remote.json (generated
 * by scripts/gen_runtime_protocol_vectors_remote.py with hmac/hashlib/base64)
 * and against RFC 4231's HMAC-SHA256 test cases.
 */
import { createHmac } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { base64Decode, base64Encode } from '../browser/runtimeProtocol/blobText'
import { constantTimeEqual, pairProof } from '../browser/runtimeProtocol/pairProof'
import { decodeBlobChunk, encodeBlobChunk } from '../browser/runtimeProtocol'

const VECTORS = JSON.parse(readFileSync(
  join(__dirname, '..', 'browser', 'runtimeProtocol', 'vectors', 'v1-remote.json'), 'utf8',
)) as {
  blobText: Array<{ name: string; header: { id: string; index: number; last: boolean }; bytesHex: string; encodedTextB64: string }>
  pairProofs: Array<{ name: string; pairSecret: string; nonce: string; clientId: string; proof: string }>
}

function hexToBytes(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2)
  for (let i = 0; i < out.length; i += 1) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16)
  return out
}

describe('blobText base64 (blobText.ts)', () => {
  it('round-trips arbitrary bytes', () => {
    for (const len of [0, 1, 2, 3, 4, 5, 255, 256, 1024]) {
      const bytes = new Uint8Array(len)
      for (let i = 0; i < len; i += 1) bytes[i] = (i * 2654435761) & 0xff
      const decoded = base64Decode(base64Encode(bytes))
      expect(decoded, `len ${len}`).toEqual(bytes)
    }
  })

  it('rejects malformed input (bad char, bad length, bad padding)', () => {
    expect(base64Decode('A!==')).toBeNull()
    expect(base64Decode('ABC')).toBeNull()        // not a multiple of 4
    expect(base64Decode('AB=C')).toBeNull()        // '=' mid-string
    expect(base64Decode('====')).toBeNull()
  })

  it('matches the Python vectors byte-for-byte (the text on-wire form)', () => {
    // 'B' + base64(encodeBlobChunk(header, bytes)) — the same bytes v1.json pins
    // as encodedHex, in the text form the text-only C++ listener carries.
    for (const v of VECTORS.blobText) {
      const wire = 'B' + base64Encode(encodeBlobChunk(v.header, hexToBytes(v.bytesHex)))
      expect(wire, v.name).toBe(v.encodedTextB64)
      // And it decodes back to the same header + bytes.
      const decoded = decodeBlobChunk(base64Decode(v.encodedTextB64.slice(1))!)
      expect(decoded, v.name).not.toBeNull()
      expect(decoded!.header).toEqual(v.header)
      expect(Array.from(decoded!.bytes)).toEqual(Array.from(hexToBytes(v.bytesHex)))
    }
  })
})

describe('pairProof (pairProof.ts)', () => {
  it('matches the Python vectors', () => {
    for (const v of VECTORS.pairProofs) {
      expect(pairProof(v.pairSecret, v.nonce, v.clientId), v.name).toBe(v.proof)
    }
  })

  it('returns empty for a malformed secret', () => {
    expect(pairProof('not valid b64u !!!', 'n', 'c')).toBe('')
  })

  // RFC 4231 HMAC-SHA256 test cases 1–4, 6, 7 — the pure-JS HMAC graded against
  // node:crypto over the published inputs. pairProof composes
  // base64urlDecode(secret) + HMAC-SHA256 + base64urlEncode over
  // utf8(nonce + '\n' + clientId), so driving it with the RFC key (as base64url)
  // and message (as the nonce, empty clientId) must equal node:crypto's HMAC of
  // the same key and the same hashed text (message + '\n').
  const RFC4231: Array<{ keyHex: string; msgText: string }> = [
    // Case 1
    { keyHex: '0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b', msgText: 'Hi There' },
    // Case 2
    { keyHex: '4a656665', msgText: 'what do ya want for nothing?' },
    // Case 3 (0xaa x20 key, 0xdd x50 data — data as latin1 bytes)
    { keyHex: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      msgText: Buffer.alloc(50, 0xdd).toString('latin1') },
    // Case 4
    { keyHex: '0102030405060708090a0b0c0d0e0f10111213141516171819',
      msgText: Buffer.alloc(50, 0xcd).toString('latin1') },
    // Case 6 (131-byte key — longer than the 64-byte block, exercises key hashing)
    { keyHex: 'aa'.repeat(131),
      msgText: 'Test Using Larger Than Block-Size Key - Hash Key First' },
    // Case 7 (131-byte key, large data)
    { keyHex: 'aa'.repeat(131),
      msgText: 'This is a test using a larger than block-size key and a larger than block-size data. The key needs to be hashed before being used by the HMAC algorithm.' },
  ]

  it('HMAC-SHA256 agrees with node:crypto over the RFC 4231 inputs', () => {
    for (const { keyHex, msgText } of RFC4231) {
      const keyB64u = Buffer.from(keyHex, 'hex').toString('base64url')
      const jsProof = pairProof(keyB64u, msgText, '')
      // Hash the EXACT bytes pairProof hashes: utf8(nonce + '\n' + clientId),
      // here nonce=msgText, clientId=''. Using utf8 (not latin1) matches
      // pairProof's TextEncoder byte-for-byte, which is the whole point of the
      // oracle — a byte-level mismatch would prove nothing about the HMAC.
      const nodeProof = createHmac('sha256', Buffer.from(keyHex, 'hex'))
        .update(Buffer.from(msgText + '\n', 'utf8'))
        .digest('base64url')
      expect(jsProof).toBe(nodeProof)
    }
  })
})

describe('constantTimeEqual', () => {
  it('is true for equal strings and false otherwise', () => {
    expect(constantTimeEqual('abc', 'abc')).toBe(true)
    expect(constantTimeEqual('abc', 'abd')).toBe(false)
    expect(constantTimeEqual('abc', 'abcd')).toBe(false) // length differs (not secret)
    expect(constantTimeEqual('', '')).toBe(true)
  })
})
