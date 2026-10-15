import { describe, expect, it } from 'vitest'

import { mergeProviderConfigForSave } from '../browser/webview/settings/providerConfigMerge'
import {
  deriveProviderGating,
  isProviderFormDirty,
  providerBaseUrlPlaceholder,
  shouldAutoConnect,
} from '../browser/webview/settings/providerFormHelpers'
import type { ProviderAuthProviderInfo } from '../browser/bridge/protocol/providerAuth'

// Regression for the ModelsSection "Connected successfully" stale-state bug:
// a carried-over `lastVerification` must not survive an unverified key change,
// or the UI durably reports a never-validated key as connected.

const STALE = { providerId: 'openai', verifiedAtMs: 1000 }

describe('mergeProviderConfigForSave', () => {
  it('stamps a fresh lastVerification when verify succeeded', () => {
    const out = mergeProviderConfigForSave({
      form: { apiKey: 'sk-new' },
      saved: { apiKey: 'sk-old', lastVerification: STALE },
      providerId: 'openai',
      verifiedAtMs: 5000,
    })
    expect(out.lastVerification).toEqual({ providerId: 'openai', verifiedAtMs: 5000 })
    expect(out.apiKey).toBe('sk-new')
  })

  it('drops a stale lastVerification when the key changed but was not verified', () => {
    const out = mergeProviderConfigForSave({
      // form carries the old verification (seeded from the saved config) — the
      // exact shape that produced the bug.
      form: { apiKey: 'sk-CHANGED', lastVerification: STALE },
      saved: { apiKey: 'sk-old', lastVerification: STALE },
      providerId: 'openai',
      verifiedAtMs: undefined,
    })
    expect(out.lastVerification).toBeUndefined()
    expect(out.apiKey).toBe('sk-CHANGED')
  })

  it('keeps the existing verification when the key is unchanged and not re-verified', () => {
    const out = mergeProviderConfigForSave({
      form: { apiKey: 'sk-same', baseUrl: 'https://x', lastVerification: STALE },
      saved: { apiKey: 'sk-same', lastVerification: STALE },
      providerId: 'openai',
      verifiedAtMs: undefined,
    })
    expect(out.lastVerification).toEqual(STALE)
    expect(out.baseUrl).toBe('https://x')
  })

  it('drops verification when a key is first set on a never-verified provider', () => {
    const out = mergeProviderConfigForSave({
      form: { apiKey: 'sk-first', lastVerification: STALE },
      saved: undefined,
      providerId: 'openai',
      verifiedAtMs: undefined,
    })
    // saved.apiKey is "" → keyChanged → no unverified "Connected" carried in.
    expect(out.lastVerification).toBeUndefined()
  })
})

// Auto-connect / placeholder helpers for the ModelsSection refresh: replaces
// the explicit Save button (the form auto-verifies + persists once it settles)
// and shows the right per-provider default Base URL.
describe('shouldAutoConnect', () => {
  const cloud = { isOAuth: false, requiresApiKey: true }

  it('triggers on a non-empty key change for a cloud provider', () => {
    expect(
      shouldAutoConnect({ form: { apiKey: 'sk-new' }, saved: undefined, ...cloud }),
    ).toBe(true)
  })

  it('does NOT trigger while the key field is still empty', () => {
    // Auto-verifying an empty key would surface a spurious "Unauthorized".
    expect(
      shouldAutoConnect({ form: { apiKey: '' }, saved: undefined, ...cloud }),
    ).toBe(false)
    expect(
      shouldAutoConnect({ form: { apiKey: '   ' }, saved: undefined, ...cloud }),
    ).toBe(false)
  })

  it('does NOT trigger when nothing changed (form matches the saved config)', () => {
    expect(
      shouldAutoConnect({
        form: { apiKey: 'sk-1' },
        saved: { apiKey: 'sk-1' },
        ...cloud,
      }),
    ).toBe(false)
  })

  it('never triggers for OAuth providers (they connect by sign-in)', () => {
    expect(
      shouldAutoConnect({
        form: { apiKey: 'sk-x' },
        saved: undefined,
        isOAuth: true,
        requiresApiKey: false,
      }),
    ).toBe(false)
  })

  it('triggers on a base-URL edit for a local (no-key) provider', () => {
    expect(
      shouldAutoConnect({
        form: { baseUrl: 'http://localhost:1234' },
        saved: undefined,
        isOAuth: false,
        requiresApiKey: false,
      }),
    ).toBe(true)
  })
})

describe('isProviderFormDirty', () => {
  it('compares only apiKey + baseUrl, ignoring verification metadata', () => {
    expect(
      isProviderFormDirty(
        { apiKey: 'sk-1', lastVerification: STALE },
        { apiKey: 'sk-1' },
      ),
    ).toBe(false)
    expect(isProviderFormDirty({ apiKey: 'sk-2' }, { apiKey: 'sk-1' })).toBe(true)
    expect(
      isProviderFormDirty({ baseUrl: 'https://b' }, { baseUrl: 'https://a' }),
    ).toBe(true)
  })
})

describe('providerBaseUrlPlaceholder', () => {
  it('uses the registry default base URL', () => {
    expect(providerBaseUrlPlaceholder('https://api.openai.com/v1')).toBe(
      'https://api.openai.com/v1',
    )
    expect(providerBaseUrlPlaceholder('http://localhost:11434')).toBe(
      'http://localhost:11434',
    )
  })

  it('is empty when the registry is unavailable (never a misleading default)', () => {
    expect(providerBaseUrlPlaceholder(undefined)).toBe('')
    expect(providerBaseUrlPlaceholder('   ')).toBe('')
  })

  it('falls back to the catalog default for a provider the registry lacks', () => {
    expect(providerBaseUrlPlaceholder(undefined, 'https://openrouter.ai/api/v1')).toBe(
      'https://openrouter.ai/api/v1',
    )
    expect(providerBaseUrlPlaceholder('http://localhost:11434', 'https://x')).toBe(
      'http://localhost:11434',
    )
  })
})

describe('deriveProviderGating', () => {
  it('defaults to key-required + both fields when the registry is absent', () => {
    expect(deriveProviderGating(undefined)).toEqual({
      isOAuth: false,
      requiresApiKey: true,
      supportsBaseUrl: true,
      supportsApiKey: true,
    })
  })

  it('flags OAuth providers (no key, no base URL)', () => {
    const info = { id: 'p', name: 'P', authMode: 'oauth' } as ProviderAuthProviderInfo
    expect(deriveProviderGating(info)).toEqual({
      isOAuth: true,
      requiresApiKey: false,
      supportsBaseUrl: false,
      supportsApiKey: false,
    })
  })

  it('local providers need no key but keep the base URL field', () => {
    const info = {
      id: 'ollama',
      name: 'Ollama',
      type: 'local',
      hasDefaultBaseUrl: true,
    } as ProviderAuthProviderInfo
    expect(deriveProviderGating(info)).toEqual({
      isOAuth: false,
      requiresApiKey: false,
      supportsBaseUrl: true,
      supportsApiKey: false,
    })
  })

  it('hides the base URL field when the provider ships no default', () => {
    const info = {
      id: 'openai',
      name: 'OpenAI',
      type: 'cloud',
      hasDefaultBaseUrl: false,
    } as ProviderAuthProviderInfo
    expect(deriveProviderGating(info).supportsBaseUrl).toBe(false)
  })
})
