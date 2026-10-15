import { describe, expect, it } from 'vitest'
import { getCacheRatio } from '../utils/cacheUsage'

describe('cacheUsage', () => {
  describe('getCacheRatio', () => {
    it('is cache_read over the whole prompt (input + cache_read + cache_create)', () => {
      // 313344 / (355962 + 313344 + 0) ≈ 0.4682
      const ratio = getCacheRatio({
        input_tokens: 355_962,
        output_tokens: 3_747,
        cache_read_input_tokens: 313_344,
        cache_creation_input_tokens: 0,
      })
      expect(ratio).toBeCloseTo(313_344 / (355_962 + 313_344), 6)
    })

    it('returns 0 for undefined, empty, or zero-denominator usage', () => {
      expect(getCacheRatio(undefined)).toBe(0)
      expect(getCacheRatio({})).toBe(0)
      expect(getCacheRatio({ input_tokens: 0, cache_read_input_tokens: 0 })).toBe(0)
    })

    it('ignores non-numeric fields', () => {
      expect(
        getCacheRatio({
          input_tokens: 'x',
          cache_read_input_tokens: 100,
          cache_creation_input_tokens: 100,
        }),
      ).toBeCloseTo(0.5, 6)
    })
  })
})
