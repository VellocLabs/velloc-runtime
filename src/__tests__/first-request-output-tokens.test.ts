import { describe, expect, it } from 'vitest'
import { listedModelRow } from '../config/nexusModelConfig/familyRows'
import { firstRequestOutputTokens, firstRequestOutputTokensForWindow } from '../config/nexusModelConfig/firstRequestOutput'
import { getDefaultMaxOutputTokensForModel } from '../engine/contextWindow'
import type { NexusModelConfig } from '../config/nexusModelConfig/types'

describe('the first-request output allowance', () => {
  it('is half the output cap', () => {
    expect(firstRequestOutputTokens(128_000)).toBe(64_000)
    expect(firstRequestOutputTokens(65_536)).toBe(32_768)
  })
  it('is at most 131072', () => {
    expect(firstRequestOutputTokens(393_216)).toBe(131_072)
    expect(firstRequestOutputTokens(1_048_576)).toBe(131_072)
  })
  it('is at least 32768, and never above the cap', () => {
    expect(firstRequestOutputTokens(50_000)).toBe(32_768)
    expect(firstRequestOutputTokens(32_768)).toBe(32_768)
    expect(firstRequestOutputTokens(16_384)).toBe(16_384)
    expect(firstRequestOutputTokens(1_024)).toBe(1_024)
  })
  it('is what a listed row carries', () => {
    expect(listedModelRow('vendor/big', { contextWindow: 1_048_000, maxOutputTokens: 1_048_000 }).defaultMaxOutputTokens).toBe(131_072)
    expect(listedModelRow('vendor/mid', { contextWindow: 300_000, maxOutputTokens: 100_000 }).defaultMaxOutputTokens).toBe(50_000)
  })
  it('follows the window when a model states no cap', () => {
    expect(firstRequestOutputTokensForWindow(1_000_000)).toBe(128_000)
    expect(firstRequestOutputTokensForWindow(900_001)).toBe(128_000)
    expect(firstRequestOutputTokensForWindow(900_000)).toBe(32_768)
    expect(firstRequestOutputTokensForWindow(272_000)).toBe(32_768)
    expect(firstRequestOutputTokensForWindow(200_000)).toBe(8_192)
    expect(firstRequestOutputTokensForWindow(8_192)).toBe(8_192)
  })
})

describe('the allowance a model resolves to', () => {
  const config: NexusModelConfig = {
    providers: [{
      providerId: 'acme',
      filterMode: 'passthrough',
      models: [
        { model: /^stated$/, contextWindow: 1_000_000, maxOutputTokens: 100_000, defaultMaxOutputTokens: 20_000 },
        { model: /^capped$/, contextWindow: 1_000_000, maxOutputTokens: 100_000 },
        { model: /^wide$/, contextWindow: 1_000_000 },
        { model: /^mid$/, contextWindow: 300_000 },
        { model: /^small$/, contextWindow: 64_000 },
      ],
    }],
  }
  it.each([
    ['stated', 20_000],
    ['capped', 50_000],
    ['wide', 128_000],
    ['mid', 32_768],
    ['small', 8_192],
  ])('%s -> %i', (model, expected) => {
    expect(getDefaultMaxOutputTokensForModel(model, 'acme', config)).toBe(expected)
  })
})
