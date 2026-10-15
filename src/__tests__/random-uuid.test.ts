/**
 * `randomUuid()` off a secure context (F-24), where `crypto.randomUUID` is undefined: the fallback is a real
 * RFC 4122 v4 built from `getRandomValues`.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { randomUuid } from '../utils/randomUuid'

const V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/

const realCrypto = globalThis.crypto

function setCrypto(value: unknown): void {
  Object.defineProperty(globalThis, 'crypto', { value, configurable: true, writable: true })
}

afterEach(() => {
  setCrypto(realCrypto)
  vi.restoreAllMocks()
})

describe('randomUuid', () => {
  it('uses crypto.randomUUID when the context allows it', () => {
    const randomUUID = vi.fn(() => '11111111-2222-4333-8444-555555555555')
    setCrypto({ randomUUID, getRandomValues: realCrypto.getRandomValues.bind(realCrypto) })
    expect(randomUuid()).toBe('11111111-2222-4333-8444-555555555555')
    expect(randomUUID).toHaveBeenCalledTimes(1)
  })

  it('falls back to getRandomValues when randomUUID is absent (http:// page)', () => {
    // Exactly the non-secure-context shape: getRandomValues but no randomUUID.
    const getRandomValues = vi.fn((array: Uint8Array) => {
      for (let i = 0; i < array.length; i += 1) array[i] = i * 7 + 3
      return array
    })
    setCrypto({ getRandomValues })
    const id = randomUuid()
    expect(getRandomValues).toHaveBeenCalledTimes(1)
    expect(id).toMatch(V4)
  })

  it('falls back when randomUUID exists but throws', () => {
    setCrypto({
      randomUUID: () => {
        throw new TypeError('crypto.randomUUID is not available in this context')
      },
      getRandomValues: realCrypto.getRandomValues.bind(realCrypto),
    })
    expect(randomUuid()).toMatch(V4)
  })

  it('still returns a v4-shaped id with no crypto at all', () => {
    setCrypto(undefined)
    expect(randomUuid()).toMatch(V4)
  })

  it('does not collide within a millisecond (what the Date.now() fallbacks did)', () => {
    setCrypto({ getRandomValues: realCrypto.getRandomValues.bind(realCrypto) })
    const ids = new Set(Array.from({ length: 2000 }, () => randomUuid()))
    expect(ids.size).toBe(2000)
    for (const id of ids) expect(id).toMatch(V4)
  })
})
