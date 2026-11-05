import { describe, expect, it } from 'vitest'
import { firstRequestOutputTokens, listedModelRow } from '../config/nexusModelConfig/familyRows'

describe('the first-request output allowance of a listed model', () => {
  it('is 32768 below a million-token window and 131072 from there up', () => {
    expect(firstRequestOutputTokens(1_048_000, 300_000)).toBe(32_768)
    expect(firstRequestOutputTokens(1_048_000, 999_999)).toBe(32_768)
    expect(firstRequestOutputTokens(1_048_000, 1_000_000)).toBe(131_072)
    expect(firstRequestOutputTokens(1_048_000, 1_048_576)).toBe(131_072)
    expect(firstRequestOutputTokens(1_048_000, undefined)).toBe(32_768)
  })
  it('never exceeds the cap the model lists', () => {
    expect(firstRequestOutputTokens(65_536, 1_048_576)).toBe(65_536)
    expect(firstRequestOutputTokens(8_192, 128_000)).toBe(8_192)
  })
  it('is what a listed row carries', () => {
    expect(listedModelRow('vendor/big', { contextWindow: 1_048_000, maxOutputTokens: 1_048_000 }).defaultMaxOutputTokens).toBe(131_072)
    expect(listedModelRow('vendor/mid', { contextWindow: 300_000, maxOutputTokens: 300_000 }).defaultMaxOutputTokens).toBe(32_768)
  })
})
