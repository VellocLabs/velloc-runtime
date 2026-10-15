import { afterEach, describe, expect, it, vi } from 'vitest'
import { refreshBrokerProviderBaseUrls } from '../browser/worker/brokerProviderView'
import { NEXUS_MODEL_CONFIG } from '../config/nexusModelConfig'
import {
  isOfficialOpenAiBaseUrl,
  resolveDocumentInputMode,
} from '../config/nexusModelConfig/documentInput'
import type { NexusModelConfig } from '../config/nexusModelConfig/types'
import {
  __resetEndpointTrustForTest,
  publishBrokerProviderBaseUrls,
} from '../models/endpoints/endpointTrust'
import type { NexusProvidersSettings } from '../settings/settingsTypes'

const providers = (
  configs: NexusProvidersSettings['configs'],
): NexusProvidersSettings => ({ configs })

describe('resolveDocumentInputMode — catalog defaults', () => {
  it.each([
    ['anthropic', 'claude-opus-5-5', 'native'],
    // Codex backend: no input_file part.
    ['chatgpt-pro', 'gpt-6-sol', 'rasterize'],
    ['google', 'gemini-3.8-flash', 'native'],
    ['openai', 'gpt-6-sol', 'native'],
    ['kimi', 'k3', 'rasterize'],
    ['deepseek', 'deepseek-flash', 'rasterize'],
    ['qwen', 'qwen3.6-flash', 'rasterize'],
    ['minimax', 'MiniMax-M3', 'rasterize'],
    ['glm', 'glm-5.3-flash', 'rasterize'],
    ['ollama', 'gemma4', 'rasterize'],
  ] as const)('%s / %s → %s', (providerId, modelId, expected) => {
    expect(resolveDocumentInputMode(undefined, providerId, modelId)).toBe(expected)
  })

  it('declares a mode on every catalog provider', () => {
    // A provider added without one would silently take the undeclared
    // fallback; make adding it a conscious choice.
    for (const provider of NEXUS_MODEL_CONFIG.providers) {
      expect(provider.documentInput, provider.providerId).toBeDefined()
    }
  })

  it('turns rasterize into none on a text-only model', () => {
    // Page images are useless to a model that cannot see them.
    expect(resolveDocumentInputMode(undefined, 'deepseek', 'deepseek-v4-pro')).toBe('none')
    expect(resolveDocumentInputMode(undefined, 'minimax', 'MiniMax-M2.7')).toBe('none')
    expect(resolveDocumentInputMode(undefined, 'ollama', 'qwen3-coder')).toBe('none')
  })

  it('rasterizes on host providers the catalog does not carry, and on unknown ids', () => {
    expect(resolveDocumentInputMode(undefined, 'github-copilot', 'gpt-6-sol')).toBe('rasterize')
    expect(resolveDocumentInputMode(undefined, 'qwen-code', 'coder-model')).toBe('rasterize')
    expect(resolveDocumentInputMode(undefined, 'never-heard-of-it', 'x')).toBe('rasterize')
    expect(resolveDocumentInputMode(undefined, undefined, 'x')).toBe('rasterize')
  })
})

describe('resolveDocumentInputMode — overrides', () => {
  const config: NexusModelConfig = {
    providers: [
      {
        providerId: 'kimi',
        documentInput: 'rasterize',
        models: [
          { model: 'k3' },
          { model: 'k9-docs', documentInput: 'native' },
          { model: 'k1-text', supportsImageInput: false },
        ],
      },
    ],
  }

  it('lets a model row override its provider', () => {
    expect(resolveDocumentInputMode(undefined, 'kimi', 'k9-docs', config)).toBe('native')
    expect(resolveDocumentInputMode(undefined, 'kimi', 'k3', config)).toBe('rasterize')
  })

  it('lets a settings.json declaration override the catalog provider', () => {
    const settings = providers({ kimi: { documentInput: 'native' } })
    expect(resolveDocumentInputMode(settings, 'kimi', 'k3', config)).toBe('native')
  })

  it('keeps a model row above a settings declaration', () => {
    const settings = providers({ kimi: { documentInput: 'none' } })
    expect(resolveDocumentInputMode(settings, 'kimi', 'k9-docs', config)).toBe('native')
  })

  it('still drops a declared rasterize to none on a text-only model', () => {
    const settings = providers({ kimi: { documentInput: 'rasterize' } })
    expect(resolveDocumentInputMode(settings, 'kimi', 'k1-text', config)).toBe('none')
  })

  it('ignores an unknown declared value', () => {
    const settings = providers({
      kimi: { documentInput: 'pdf' as unknown as 'native' },
    })
    expect(resolveDocumentInputMode(settings, 'kimi', 'k3', config)).toBe('rasterize')
  })
})

describe('resolveDocumentInputMode — OpenAI wire follows the endpoint', () => {
  it('keeps openai native on its default and official endpoints', () => {
    expect(resolveDocumentInputMode(providers({ openai: {} }), 'openai', 'gpt-6-sol')).toBe('native')
    expect(
      resolveDocumentInputMode(
        providers({ openai: { baseUrl: 'https://api.openai.com/v1' } }),
        'openai',
        'gpt-6-sol',
      ),
    ).toBe('native')
  })

  it('drops openai on a relay to rasterize', () => {
    const settings = providers({ openai: { baseUrl: 'https://relay.example.test/v1' } })
    expect(resolveDocumentInputMode(settings, 'openai', 'gpt-6-sol')).toBe('rasterize')
  })

  // A relay configured through launch prefs / the legacy path lives only in
  // the broker's `nexus.provider_configs` pref; settings.json has no baseUrl
  // (or no openai entry at all). The broker's view decides, as it does for
  // the Models home list.
  describe('with a broker-only base URL', () => {
    afterEach(() => __resetEndpointTrustForTest())

    it('resolves a broker-only relay to rasterize', () => {
      publishBrokerProviderBaseUrls([
        { id: 'openai', baseUrl: 'https://relay.example.test/v1' },
      ])
      expect(resolveDocumentInputMode(undefined, 'openai', 'gpt-6-sol')).toBe('rasterize')
      expect(resolveDocumentInputMode(providers({ openai: {} }), 'openai', 'gpt-6-sol')).toBe(
        'rasterize',
      )
    })

    it('keeps the broker default endpoint native', () => {
      publishBrokerProviderBaseUrls([{ id: 'openai', baseUrl: 'https://api.openai.com/v1' }])
      expect(resolveDocumentInputMode(undefined, 'openai', 'gpt-6-sol')).toBe('native')
    })

    it('takes the broker view from providerAuth.list, keeping it when a read fails', async () => {
      const request = vi.fn(async () => ({
        id: 'r1',
        ok: true,
        result: {
          providers: [{ id: 'openai', name: 'OpenAI', baseUrl: 'https://relay.example.test/v1' }],
        },
      }))
      await refreshBrokerProviderBaseUrls({ request } as never, 'r1')
      expect(request).toHaveBeenCalledWith(
        expect.objectContaining({ route: expect.objectContaining({ capability: 'providerAuth' }) }),
      )
      expect(resolveDocumentInputMode(undefined, 'openai', 'gpt-6-sol')).toBe('rasterize')
      await refreshBrokerProviderBaseUrls(
        { request: vi.fn(async () => { throw new Error('host gone') }) } as never,
        'r2',
      )
      expect(resolveDocumentInputMode(undefined, 'openai', 'gpt-6-sol')).toBe('rasterize')
    })

    it('lets a settings.json baseUrl win over the broker view', () => {
      publishBrokerProviderBaseUrls([
        { id: 'openai', baseUrl: 'https://relay.example.test/v1' },
      ])
      expect(
        resolveDocumentInputMode(
          providers({ openai: { baseUrl: 'https://api.openai.com/v1' } }),
          'openai',
          'gpt-6-sol',
        ),
      ).toBe('native')
    })
  })

  // The host sends no `file` part on chat/completions, so
  // pointing a custom provider at api.openai.com does not make it native.
  it('keeps a custom OpenAI-compatible provider rasterize, even on api.openai.com', () => {
    const settings = providers({
      'custom-direct': {
        isCustomProvider: true,
        apiCompatibility: 'openai',
        baseUrl: 'https://api.openai.com/v1',
      },
      'custom-relay': {
        isCustomProvider: true,
        apiCompatibility: 'openai',
        baseUrl: 'https://relay.example.test/v1',
      },
      'custom-blank': { isCustomProvider: true, apiCompatibility: 'openai' },
    })
    expect(resolveDocumentInputMode(settings, 'custom-direct', 'gpt-6-sol')).toBe('rasterize')
    expect(resolveDocumentInputMode(settings, 'custom-relay', 'gpt-6-sol')).toBe('rasterize')
    expect(resolveDocumentInputMode(settings, 'custom-blank', 'gpt-6-sol')).toBe('rasterize')
  })

  it('treats the legacy custom-openai slot the same way', () => {
    const settings = providers({ 'custom-openai': { baseUrl: 'https://api.openai.com/v1' } })
    expect(resolveDocumentInputMode(settings, 'custom-openai', 'gpt-6-sol')).toBe('rasterize')
  })

  it('still lets the user declare a custom OpenAI-compatible provider native', () => {
    const settings = providers({
      'custom-direct': {
        isCustomProvider: true,
        apiCompatibility: 'openai',
        baseUrl: 'https://relay.example.test/v1',
        documentInput: 'native',
      },
    })
    expect(resolveDocumentInputMode(settings, 'custom-direct', 'gpt-6-sol')).toBe('native')
  })

  it('maps a custom Anthropic-compatible provider to the Anthropic wire', () => {
    const settings = providers({
      'custom-gw': {
        isCustomProvider: true,
        apiCompatibility: 'anthropic',
        baseUrl: 'https://relay.example.test',
      },
    })
    expect(resolveDocumentInputMode(settings, 'custom-gw', 'claude-opus-5-5')).toBe('native')
  })

  it('lets the user override the endpoint rule', () => {
    const settings = providers({
      openai: { baseUrl: 'https://relay.example.test/v1', documentInput: 'native' },
    })
    expect(resolveDocumentInputMode(settings, 'openai', 'gpt-6-sol')).toBe('native')
  })
})

describe('isOfficialOpenAiBaseUrl', () => {
  it.each([
    [undefined, true],
    ['', true],
    ['https://api.openai.com/v1', true],
    ['https://eu.api.openai.com/v1', true],
    ['https://API.OPENAI.COM./v1', true],
    ['https://chatgpt.com/backend-api/codex', false],
    ['https://openai.com.evil.test/v1', false],
    ['https://notopenai.com/v1', false],
    ['http://localhost:8080/v1', false],
    ['not a url', false],
  ] as const)('%s → %s', (url, expected) => {
    expect(isOfficialOpenAiBaseUrl(url)).toBe(expected)
  })
})
