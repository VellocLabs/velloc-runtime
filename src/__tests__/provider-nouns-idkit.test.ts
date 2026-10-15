/**
 * Provider mods — deriveId / encryptId / decryptId (PM-8): fixed vectors
 * (computed outside this code, with node:crypto over the documented framing),
 * unambiguous framing, formats and lengths, and the deterministic
 * authenticated encryption's round trip, tamper and scope behaviour.
 */
import { createHmac } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { decryptId, deriveId, encryptId, frame, fromBase64Url, toBase64Url } from '../mods/provider/nouns/idKit'

const KEY_BYTES = new Uint8Array(32).fill(0x0b)

async function hmacKey(bytes = KEY_BYTES): Promise<CryptoKey> {
  return crypto.subtle.importKey('raw', bytes as BufferSource, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
}

describe('deriveId', () => {
  it('matches fixed vectors', async () => {
    const key = await hmacKey()
    expect(await deriveId(key, 'user', 'alice')).toBe('eef74892d941819f023afc70cdb94bc88315faaedc72a11ae6297e437d30faac')
    expect(await deriveId(key, 'user', 'alice', { format: 'base64url' })).toBe('7vdIktlBgZ8COvxwzblLyIMV-q7ccqEa5il-Q30w-qw')
    expect(await deriveId(key, 'user', 'alice', { format: 'base62' })).toBe('ufIp1zhS1jNZTIasEMf0Dl56czHsjwO5tY5BJjZ3fsy')
    expect(await deriveId(key, 'device', 'é')).toBe('456af7f1b675210cf75ed84325a6da736b0b51fca5c0e6c97f62eabcf2be2777')
  })

  it('is HMAC-SHA-256 over the length-prefixed frame', async () => {
    const key = await hmacKey()
    const expected = createHmac('sha256', Buffer.from(KEY_BYTES))
      .update(frame('velloc.provider.deriveId.v1', new TextEncoder().encode('s'), new TextEncoder().encode('i')))
      .digest('hex')
    expect(await deriveId(key, 's', 'i')).toBe(expected)
  })

  it('frames unambiguously: (a, bc) and (ab, c) differ', async () => {
    const key = await hmacKey()
    expect(await deriveId(key, 'a', 'bc')).toBe('ea301c4cf9606ca516103ac1ee0386bb73a1cd4b31227ab8641e26dd49d7cfc5')
    expect(await deriveId(key, 'ab', 'c')).toBe('f06c56c1f0ac29630998568f322d9b491c44ebdbcffc0287dfd1d851b5971d6c')
  })

  it('is deterministic and depends on the key', async () => {
    const key = await hmacKey()
    expect(await deriveId(key, 'user', 'alice')).toBe(await deriveId(key, 'user', 'alice'))
    const other = await hmacKey(new Uint8Array(32).fill(0x0c))
    expect(await deriveId(other, 'user', 'alice')).not.toBe(await deriveId(key, 'user', 'alice'))
  })

  it('cuts to a length, in each format', async () => {
    const key = await hmacKey()
    expect(await deriveId(key, 'user', 'alice', { length: 8 })).toBe('eef74892')
    expect(await deriveId(key, 'user', 'alice', { format: 'base62', length: 10 })).toBe('ufIp1zhS1j')
    expect(await deriveId(key, 'user', 'alice', { format: 'base64url', length: 5 })).toBe('7vdIk')
    expect(await deriveId(key, 'user', 'alice', { format: 'base62' })).toHaveLength(43)
  })

  it('refuses a bad length, format, scope or input', async () => {
    const key = await hmacKey()
    await expect(deriveId(key, 'u', 'i', { length: 0 })).rejects.toThrow(RangeError)
    await expect(deriveId(key, 'u', 'i', { length: 65 })).rejects.toThrow(RangeError)
    await expect(deriveId(key, 'u', 'i', { format: 'base64url', length: 44 })).rejects.toThrow(RangeError)
    await expect(deriveId(key, 'u', 'i', { length: 1.5 })).rejects.toThrow(RangeError)
    await expect(deriveId(key, 'u', 'i', { format: 'base32' as 'hex' })).rejects.toThrow(TypeError)
    await expect(deriveId(key, '', 'i')).rejects.toThrow(TypeError)
    await expect(deriveId(key, 5, 'i')).rejects.toThrow(TypeError)
    await expect(deriveId(key, 'u', { not: 'bytes' })).rejects.toThrow(TypeError)
  })

  it('takes bytes as an input, the same as their text', async () => {
    const key = await hmacKey()
    expect(await deriveId(key, 'u', new TextEncoder().encode('alice'))).toBe(await deriveId(key, 'u', 'alice'))
  })
})

describe('encryptId / decryptId', () => {
  it('round-trips, and the same input gives the same token', async () => {
    const key = await hmacKey()
    const token = await encryptId(key, 'conversation', 'conv-12345')
    expect(token).toMatch(/^[A-Za-z0-9_-]+$/)
    expect(await encryptId(key, 'conversation', 'conv-12345')).toBe(token)
    expect(await decryptId(key, 'conversation', token)).toBe('conv-12345')
  })

  it('round-trips an empty string and non-ASCII text', async () => {
    const key = await hmacKey()
    expect(await decryptId(key, 's', await encryptId(key, 's', ''))).toBe('')
    expect(await decryptId(key, 's', await encryptId(key, 's', 'héllo 世界'))).toBe('héllo 世界')
  })

  it('different inputs or scopes give different tokens', async () => {
    const key = await hmacKey()
    const base = await encryptId(key, 'a', 'bc')
    expect(await encryptId(key, 'a', 'bd')).not.toBe(base)
    expect(await encryptId(key, 'ab', 'c')).not.toBe(base)
  })

  it('a token from another scope is refused', async () => {
    const key = await hmacKey()
    const token = await encryptId(key, 'conversation', 'x')
    await expect(decryptId(key, 'message', token)).rejects.toThrow('not valid for this scope')
  })

  it('a token from another key is refused', async () => {
    const token = await encryptId(await hmacKey(), 's', 'x')
    await expect(decryptId(await hmacKey(new Uint8Array(32).fill(1)), 's', token)).rejects.toThrow('not valid')
  })

  it('a tampered token is refused, at every position', async () => {
    const key = await hmacKey()
    const raw = fromBase64Url(await encryptId(key, 's', 'some input'))
    for (let i = 0; i < raw.length; i++) {
      const copy = raw.slice()
      copy[i] = copy[i]! ^ 1
      await expect(decryptId(key, 's', toBase64Url(copy))).rejects.toThrow('not valid')
    }
    await expect(decryptId(key, 's', toBase64Url(raw.slice(0, raw.length - 1)))).rejects.toThrow('not valid')
    await expect(decryptId(key, 's', toBase64Url(raw.slice(0, 10)))).rejects.toThrow('not valid')
  })

  it('refuses a token that is not base64url, and bad arguments', async () => {
    const key = await hmacKey()
    await expect(decryptId(key, 's', 'not base64!')).rejects.toThrow(TypeError)
    await expect(decryptId(key, 's', '')).rejects.toThrow(TypeError)
    await expect(decryptId(key, 's', 5)).rejects.toThrow(TypeError)
    await expect(encryptId(key, 's', 5)).rejects.toThrow(TypeError)
    await expect(encryptId(key, '', 'x')).rejects.toThrow(TypeError)
    await expect(encryptId(key, 's', 'x'.repeat(5000))).rejects.toThrow(RangeError)
  })

  it('the token reveals no plaintext', async () => {
    const key = await hmacKey()
    const token = await encryptId(key, 's', 'secret-conversation-id')
    expect(Buffer.from(fromBase64Url(token)).toString('latin1')).not.toContain('secret-conversation-id')
  })
})
