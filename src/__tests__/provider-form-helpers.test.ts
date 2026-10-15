import { describe, expect, it } from 'vitest'

import {
  CUSTOM_PROVIDER_IDS,
  deriveProviderGating,
  isBuiltInProviderAdded,
  isBuiltInProviderConnected,
  isCustomProviderId,
  providerConnectionKind,
  shouldAutoConnect,
} from '../browser/webview/settings/providerFormHelpers'
import type { ProviderAuthProviderInfo } from '../browser/bridge/protocol/providerAuth'

/**
 * Custom-endpoint gating for the Models settings page. The generic "Custom
 * endpoint" provider (backend ids custom-openai / custom-anthropic) shows a
 * user-defined base URL and an OPTIONAL API key, in contrast to built-in
 * cloud providers (key required) and local providers (no key field). These
 * are the pure decision helpers ModelsSection composes.
 */
describe('providerFormHelpers — custom endpoint gating', () => {
  it('isCustomProviderId matches the two backend ids only', () => {
    expect(isCustomProviderId(CUSTOM_PROVIDER_IDS.openai)).toBe(true)
    expect(isCustomProviderId(CUSTOM_PROVIDER_IDS.anthropic)).toBe(true)
    expect(isCustomProviderId('openai')).toBe(false)
    expect(isCustomProviderId('anthropic')).toBe(false)
    expect(isCustomProviderId(undefined)).toBe(false)
  })

  it('forces base-URL + optional-key gating from the id alone (works before the registry lands)', () => {
    expect(deriveProviderGating(undefined, CUSTOM_PROVIDER_IDS.openai)).toEqual({
      isOAuth: false,
      requiresApiKey: false,
      supportsBaseUrl: true,
      supportsApiKey: true,
    })
    expect(
      deriveProviderGating(undefined, CUSTOM_PROVIDER_IDS.anthropic),
    ).toEqual({
      isOAuth: false,
      requiresApiKey: false,
      supportsBaseUrl: true,
      supportsApiKey: true,
    })
  })

  it('leaves built-in cloud / local / oauth gating unchanged (key field shown iff required)', () => {
    const cloud: ProviderAuthProviderInfo = {
      id: 'openai',
      name: 'OpenAI',
      type: 'cloud',
      authMode: 'apiKey',
      hasDefaultBaseUrl: true,
    }
    expect(deriveProviderGating(cloud, 'openai')).toEqual({
      isOAuth: false,
      requiresApiKey: true,
      supportsBaseUrl: true,
      supportsApiKey: true,
    })

    const local: ProviderAuthProviderInfo = {
      id: 'ollama',
      name: 'Ollama',
      type: 'local',
      authMode: 'apiKey',
      hasDefaultBaseUrl: true,
    }
    expect(deriveProviderGating(local, 'ollama')).toEqual({
      isOAuth: false,
      requiresApiKey: false,
      supportsBaseUrl: true,
      supportsApiKey: false,
    })

    const oauth: ProviderAuthProviderInfo = {
      id: 'chatgpt-pro',
      name: 'ChatGPT Pro',
      type: 'cloud',
      authMode: 'oauth',
    }
    expect(deriveProviderGating(oauth, 'chatgpt-pro')).toMatchObject({
      isOAuth: true,
      requiresApiKey: false,
      supportsApiKey: false,
    })
  })

  it('custom auto-connect waits for a non-empty base URL, ignoring the (optional) key', () => {
    const providerId = CUSTOM_PROVIDER_IDS.openai
    // Dirty via the API key but no endpoint yet → do NOT probe (an empty base
    // URL would just error mid-typing).
    expect(
      shouldAutoConnect({
        form: { apiKey: 'sk-x' },
        saved: undefined,
        isOAuth: false,
        requiresApiKey: false,
        providerId,
      }),
    ).toBe(false)
    // Base URL entered (still no key) → probe.
    expect(
      shouldAutoConnect({
        form: { baseUrl: 'http://127.0.0.1:8765/v1' },
        saved: undefined,
        isOAuth: false,
        requiresApiKey: false,
        providerId,
      }),
    ).toBe(true)
  })

  it('a Base URL edit on a cloud provider with a STORED key auto-connects although the key field is empty', () => {
    // The WebUI never holds the stored key (`hasApiKey` only), so the key
    // field of a connected provider is always empty.
    expect(
      shouldAutoConnect({
        form: { hasApiKey: true, baseUrl: 'https://proxy.example/v1' },
        saved: { hasApiKey: true },
        isOAuth: false,
        requiresApiKey: true,
        providerId: 'openai',
      }),
    ).toBe(true)
    // No stored key and an empty field → still waits for a key.
    expect(
      shouldAutoConnect({
        form: { baseUrl: 'https://proxy.example/v1' },
        saved: undefined,
        isOAuth: false,
        requiresApiKey: true,
        providerId: 'openai',
      }),
    ).toBe(false)
  })

  it('non-custom local auto-connect still fires on any dirty edit (unchanged)', () => {
    expect(
      shouldAutoConnect({
        form: { baseUrl: 'http://localhost:1234' },
        saved: undefined,
        isOAuth: false,
        requiresApiKey: false,
        providerId: 'ollama',
      }),
    ).toBe(true)
  })
})

/**
 * The Provider connection home page lists the ADDED providers and offers the
 * rest under "Add provider". A settings.json config is the usual evidence, but
 * a provider configured through the broker pref, or signed in by OAuth, has
 * none — and must still count, or a working provider vanishes from the list.
 */
describe('providerFormHelpers — home-page provider state', () => {
  const info = (extra: Partial<ProviderAuthProviderInfo>): ProviderAuthProviderInfo => ({
    id: 'anthropic',
    name: 'Anthropic',
    ...extra,
  })

  it('counts a provider as added from settings.json or from the broker', () => {
    expect(isBuiltInProviderAdded(undefined, undefined)).toBe(false)
    expect(isBuiltInProviderAdded(undefined, info({}))).toBe(false)
    expect(isBuiltInProviderAdded({ hasApiKey: true }, undefined)).toBe(true)
    expect(isBuiltInProviderAdded(undefined, info({ isVerified: true }))).toBe(true)
    expect(isBuiltInProviderAdded(undefined, info({ hasStoredApiKey: true }))).toBe(true)
    expect(isBuiltInProviderAdded(undefined, info({ connected: true }))).toBe(true)
  })

  it('does not count a config that holds no user setup — the picker would leave it out', () => {
    // Ticking "Official connection" before entering a key writes this alone.
    expect(isBuiltInProviderAdded({ trust: 'trusted' }, undefined)).toBe(false)
    // A verification stamp is reporting, not setup (F-12).
    expect(
      isBuiltInProviderAdded(
        { lastVerification: { providerId: 'openai', verifiedAtMs: 1 } },
        undefined,
      ),
    ).toBe(false)
    // Each piece of evidence the host's HasUserProviderSetup accepts does count.
    for (const config of [
      { baseUrl: 'https://x.test' },
      { defaultModel: 'm' },
      { model: 'm' },
      { enabledModels: ['m'] },
      { isCustomProvider: true },
    ]) {
      expect(isBuiltInProviderAdded(config, undefined)).toBe(true)
    }
    expect(isBuiltInProviderAdded({ enabledModels: [] }, undefined)).toBe(false)
  })

  it('reads connected from verification, or from the live sign-in for OAuth', () => {
    expect(isBuiltInProviderConnected({ hasApiKey: true }, undefined)).toBe(false)
    expect(
      isBuiltInProviderConnected(
        { lastVerification: { providerId: 'openai', verifiedAtMs: 1 } },
        undefined,
      ),
    ).toBe(true)
    expect(isBuiltInProviderConnected(undefined, info({ isVerified: true }))).toBe(true)
    // An OAuth provider is connected only while signed in.
    expect(
      isBuiltInProviderConnected(undefined, info({ authMode: 'oauth', connected: false })),
    ).toBe(false)
    expect(
      isBuiltInProviderConnected(undefined, info({ authMode: 'oauth', connected: true })),
    ).toBe(true)
  })

  it('names how a row connects: subscription sign-in, API key, local, or custom', () => {
    // ChatGPT Plus/Pro and OpenAI share a logo; this line is what tells them apart.
    expect(providerConnectionKind(info({ authMode: 'oauth' }), false)).toBe('subscription')
    expect(providerConnectionKind(info({ authMode: 'apiKey', type: 'cloud' }), false)).toBe('apiKey')
    expect(providerConnectionKind(info({ type: 'local' }), false)).toBe('local')
    // Before the registry lands a built-in reads as an API-key provider.
    expect(providerConnectionKind(undefined, false)).toBe('apiKey')
    // A custom provider is custom whatever the registry says.
    expect(providerConnectionKind(info({ authMode: 'oauth' }), true)).toBe('custom')
  })
})
