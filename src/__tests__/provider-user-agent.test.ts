import { afterEach, describe, expect, it } from 'vitest'

import { NEXUS_MODEL_CONFIG } from '../config/nexusModelConfig'
import {
  customProviderUserAgent,
  resolveProviderUserAgent,
  withProviderUserAgents,
} from '../config/providerUserAgent'
import {
  resolveCustomProviderRequest,
  setCustomProviderRecords,
} from '../config/customProviderRegistry'
import {
  OPENCODE_ZEN_BASE_URL,
  OPENCODE_ZEN_USER_AGENT,
  opencodeZenSeedConfig,
} from '../browser/webview/settings/opencodeZenPreset'

/**
 * Preset User-Agents ride on every provider publish: the preset value where
 * one exists, `''` (host default) everywhere else — never omitted, because
 * the host merges publishes key by key.
 */
describe('provider User-Agent presets', () => {
  afterEach(() => {
    setCustomProviderRecords({})
  })

  it('gives a Zen custom provider the OpenCode User-Agent', () => {
    expect(OPENCODE_ZEN_USER_AGENT).toMatch(/^opencode\/\d+\.\d+\.\d+$/)
    expect(
      resolveProviderUserAgent('custom-opencode-zen', opencodeZenSeedConfig()),
    ).toBe(OPENCODE_ZEN_USER_AGENT)
  })

  it('leaves other providers on the host default', () => {
    expect(resolveProviderUserAgent('openai', {})).toBeUndefined()
    expect(
      resolveProviderUserAgent('custom-x', {
        isCustomProvider: true,
        baseUrl: 'https://api.example.com/v1',
      }),
    ).toBeUndefined()
    // The Zen URL alone does not make a BUILT-IN provider's UA.
    expect(
      resolveProviderUserAgent('openai', { baseUrl: OPENCODE_ZEN_BASE_URL }),
    ).toBeUndefined()
  })

  it('uses a built-in catalog entry\'s userAgent when one is set', () => {
    const entry = NEXUS_MODEL_CONFIG.providers.find(p => p.providerId === 'deepseek')!
    const before = entry.userAgent
    entry.userAgent = 'velloc-test/1'
    try {
      expect(resolveProviderUserAgent('deepseek', {})).toBe('velloc-test/1')
    } finally {
      entry.userAgent = before
    }
  })

  it('stamps every published config, clearing a stale value with ""', () => {
    const out = withProviderUserAgents({
      'custom-opencode-zen': opencodeZenSeedConfig(),
      openai: { apiKey: 'sk', userAgent: 'stale/1' },
    })
    expect(out['custom-opencode-zen'].userAgent).toBe(OPENCODE_ZEN_USER_AGENT)
    expect(out.openai).toEqual({ apiKey: 'sk', userAgent: '' })
  })

  it('keys a draft connection probe on its base URL alone', () => {
    // The settings form probes a draft through the shared backend slot, so it
    // must name its own User-Agent — trailing slash and case as the form
    // normalises them.
    expect(customProviderUserAgent(`${OPENCODE_ZEN_BASE_URL}/`)).toBe(
      OPENCODE_ZEN_USER_AGENT,
    )
    expect(customProviderUserAgent(' HTTPS://OPENCODE.AI/ZEN/V1 ')).toBe(
      OPENCODE_ZEN_USER_AGENT,
    )
    expect(customProviderUserAgent('https://api.example.com/v1')).toBeUndefined()
  })
})
