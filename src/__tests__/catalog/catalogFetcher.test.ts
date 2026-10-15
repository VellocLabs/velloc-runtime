import { describe, expect, it } from 'vitest'
import { fetchSlimmed, MAX_DOCUMENT_BYTES, utf8ByteLength } from '../../catalog/catalogFetcher'

describe('utf8ByteLength', () => {
  it('counts UTF-8 bytes, not UTF-16 units', () => {
    expect(utf8ByteLength('')).toBe(0)
    expect(utf8ByteLength('abc')).toBe(3)
    expect(utf8ByteLength('é')).toBe(2)
    expect(utf8ByteLength('€')).toBe(3)
    expect(utf8ByteLength('😀')).toBe(4)
    expect(utf8ByteLength('\ud800')).toBe(3)
    const mixed = 'a€é😀\udc00z'
    expect(utf8ByteLength(mixed)).toBe(new TextEncoder().encode(mixed).length)
  })
})

describe('fetchSlimmed size cap', () => {
  it('rejects a body over the cap in bytes even when its length is under it', async () => {
    // 3 bytes per char: length is about a third of the cap, bytes exceed it.
    const body = '€'.repeat(Math.ceil((MAX_DOCUMENT_BYTES + 1) / 3))
    expect(body.length).toBeLessThan(MAX_DOCUMENT_BYTES)
    await expect(
      fetchSlimmed({
        http: async () => ({ status: 200, body }),
        url: 'http://x',
        cachedModelCount: 0,
        parse: () => {
          throw new Error('must not parse an over-cap body')
        },
      }),
    ).rejects.toThrow(/8 MiB/)
  })
})
