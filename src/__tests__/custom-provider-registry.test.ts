import { afterEach, describe, expect, it } from 'vitest'

import { NEXUS_MODEL_CONFIG } from '../config/nexusModelConfig'
import {
  appendCustomProvidersToCatalog,
  generateCustomProviderId,
  getCustomProviderRecord,
  isCustomModelComplete,
  listCustomProviderRecords,
  resetCustomProviderRecords,
  resolveCustomProviderRequest,
  setCustomProviderRecords,
  synthesizeCustomProviderCatalogEntries,
  vendorFiguresForCustomModel,
} from '../config/customProviderRegistry'
import { findConfiguredModel } from '../config/nexusModelConfig/findConfiguredModel'
import { resolveModelRequestFields } from '../engine/turn/modelRequestFields'
import {
  getAvailableThinkingTiersForModel,
  contextWindowOf,
  getDefaultMaxOutputTokensForModel,
} from '../engine/contextWindow'
import { modelSupportsStrictTools } from '../utils/strictTools'
import {
  __resetEndpointTrustForTest,
  publishBrokerProviderBaseUrls,
  publishProviderBaseUrlsFromConfigs,
} from '../models/endpoints/endpointTrust'
import '../models/drivers/builtinDrivers'
import { createModelProvider } from '../models/drivers/modelProvider'
import { resolveProviderSpec } from '../models/drivers/driverRegistry'
import { assembleTurnDependencies } from '../engine/turn/turnDependencies'
import {
  DefaultRuntimeConfig,
  NoopPlatformCapabilities,
  createEmptyAppState,
  createNoopToolUseContext,
} from '../runtime/testing/noopAdapters'
import type { BrowserLlmCatalog } from '../browser/bridge/protocol/nexus_llm'
import type { NexusProviderConfig } from '../settings/settingsTypes'

/**
 * The runtime half of the custom-provider feature: settings.json records →
 * model metadata + catalog rows + request routing.
 *
 * Every assertion here fails without `customProviderRegistry`: a custom model
 * would fall back to the 200K default window, never appear in the catalog, and
 * ride its (host-unknown) provider id onto the wire.
 */

const ABC: NexusProviderConfig = {
  isCustomProvider: true,
  displayName: 'ABC Provider',
  providerIcon: 'generic',
  apiCompatibility: 'openai',
  baseUrl: 'https://api.abc.example/v1',
  apiKey: 'sk-abc',
  defaultModel: 'abc-coder-v2',
  customModels: [
    {
      modelId: 'abc-coder-v2',
      displayName: 'ABC Coder',
      contextWindow: 262_144,
      maxOutputTokens: 65_536,
      capabilities: { toolCalling: true, reasoning: true, structuredOutput: true },
    },
    // Discovered but not completed — must never reach the catalog or become
    // the default model.
    { modelId: 'abc-embed', incomplete: true },
  ],
}

const hostCatalog: BrowserLlmCatalog = {
  providers: [
    {
      id: 'openai',
      label: 'OpenAI',
      iconSvg: '<svg id="openai-mark"></svg>',
      enabled: true,
      models: [{ id: 'gpt-x', label: 'GPT X', enabled: true }],
    },
  ],
}

/** A host catalog that already lists a custom provider id. */
const listedHostCatalog: BrowserLlmCatalog = {
  providers: [
    ...hostCatalog.providers,
    {
      id: 'custom-abc-provider',
      label: 'ABC Provider',
      iconSvg: '',
      enabled: true,
      models: [],
    },
  ],
}

afterEach(() => {
  resetCustomProviderRecords()
  __resetEndpointTrustForTest()
})

describe('custom provider records', () => {
  it('reads only custom entries, sorted by display name', () => {
    const records = listCustomProviderRecords({
      openai: { apiKey: 'sk-builtin' },
      'custom-zeta': { ...ABC, displayName: 'Zeta Gateway' },
      'custom-abc-provider': ABC,
    })
    expect(records.map(r => r.displayName)).toEqual([
      'ABC Provider',
      'Zeta Gateway',
    ])
  })

  it('ignores a built-in provider config and an unconfigured backend slot', () => {
    expect(
      listCustomProviderRecords({
        openai: { apiKey: 'sk-x', baseUrl: 'https://api.openai.com/v1' },
        'custom-openai': { baseUrl: 'https://proxy.example' },
      }),
    ).toEqual([])
  })

  it('generates collision-free ids that can never hijack a backend slot', () => {
    // "OpenAI" slugs to `custom-openai`, which IS the OpenAI dialect slot.
    expect(generateCustomProviderId('OpenAI')).toBe('custom-openai-2')
    expect(generateCustomProviderId('ABC Provider')).toBe('custom-abc-provider')
    expect(
      generateCustomProviderId('ABC Provider', ['custom-abc-provider']),
    ).toBe('custom-abc-provider-2')
  })

  it('treats a model without both limits as incomplete', () => {
    expect(isCustomModelComplete({ modelId: 'a', contextWindow: 100 })).toBe(false)
    expect(
      isCustomModelComplete({
        modelId: 'a',
        contextWindow: 100,
        maxOutputTokens: 200,
      }),
      'max output above the context window is not a usable model',
    ).toBe(false)
    expect(
      isCustomModelComplete({
        modelId: 'a',
        contextWindow: 100,
        maxOutputTokens: 50,
      }),
    ).toBe(true)
  })
})

describe('NEXUS_MODEL_CONFIG overlay', () => {
  it('resolves window / output / tiers / strict-tools for a custom model', () => {
    setCustomProviderRecords({ 'custom-abc-provider': ABC })

    expect(contextWindowOf('abc-coder-v2', 'custom-abc-provider')).toBe(
      262_144,
    )
    expect(
      getDefaultMaxOutputTokensForModel('abc-coder-v2', 'custom-abc-provider'),
    ).toBe(65_536)
    expect(
      getAvailableThinkingTiersForModel('abc-coder-v2', 'custom-abc-provider'),
    ).toEqual(['low', 'medium', 'high'])
    expect(
      modelSupportsStrictTools('abc-coder-v2', 'custom-abc-provider'),
    ).toBe(true)
  })

  it('restores the shipped catalog when a provider is removed', () => {
    const before = NEXUS_MODEL_CONFIG.providers.length
    setCustomProviderRecords({ 'custom-abc-provider': ABC })
    expect(NEXUS_MODEL_CONFIG.providers.length).toBe(before + 1)
    setCustomProviderRecords({})
    expect(NEXUS_MODEL_CONFIG.providers.length).toBe(before)
    expect(contextWindowOf('abc-coder-v2', 'custom-abc-provider')).toBe(
      200_000,
    )
  })

  it('never duplicates a provider id already in the shipped catalog', () => {
    const before = NEXUS_MODEL_CONFIG.providers.length
    setCustomProviderRecords({
      'custom-openai': {
        ...ABC,
        customModels: [
          { modelId: 'proxy-1', contextWindow: 8_192, maxOutputTokens: 4_096 },
        ],
      },
    })
    expect(NEXUS_MODEL_CONFIG.providers.length).toBe(before)
    expect(
      NEXUS_MODEL_CONFIG.providers.filter(p => p.providerId === 'custom-openai'),
    ).toHaveLength(1)
    expect(contextWindowOf('proxy-1', 'custom-openai')).toBe(8_192)
  })
})

describe('catalog synthesis', () => {
  it('appends an enabled provider row carrying only the complete models', () => {
    setCustomProviderRecords({ 'custom-abc-provider': ABC })
    const merged = appendCustomProvidersToCatalog(hostCatalog)!
    const custom = merged.providers.find(p => p.id === 'custom-abc-provider')!
    expect(custom.label).toBe('ABC Provider')
    expect(custom.enabled).toBe(true)
    expect(custom.defaultModelId).toBe('abc-coder-v2')
    expect(custom.models.map(m => m.id)).toEqual(['abc-coder-v2'])
    expect(custom.models[0]).toMatchObject({
      label: 'ABC Coder',
      contextWindow: 262_144,
      maxOutputTokens: 65_536,
      supportsTools: true,
    })
    // The host's own providers survive untouched.
    expect(merged.providers.find(p => p.id === 'openai')).toBeTruthy()
  })

  it('leaves a provider disabled until it has a base URL and a complete model', () => {
    setCustomProviderRecords({
      'custom-draft': {
        isCustomProvider: true,
        displayName: 'Draft',
        customModels: [{ modelId: 'x', incomplete: true }],
      },
    })
    const merged = appendCustomProvidersToCatalog(hostCatalog)!
    expect(merged.providers.find(p => p.id === 'custom-draft')?.enabled).toBe(
      false,
    )
  })

  it('reuses the host brand SVG when the icon key names a built-in provider', () => {
    setCustomProviderRecords({
      'custom-abc-provider': { ...ABC, providerIcon: 'openai' },
    })
    const merged = appendCustomProvidersToCatalog(hostCatalog)!
    expect(
      merged.providers.find(p => p.id === 'custom-abc-provider')?.iconSvg,
    ).toBe('<svg id="openai-mark"></svg>')
  })
})

describe("a custom model the dialect vendor's catalog covers", () => {
  // A relay serving `claude-opus-5-5` over the Anthropic wire serves
  // Anthropic's model: with `reasoning` ticked it offers Anthropic's effort
  // levels, not the generic three. Without the vendor lookup, `extra-high`
  // was not a tier of the model and was dropped before the wire.
  const relay = (apiCompatibility: 'openai' | 'anthropic', modelId: string, reasoning = true): NexusProviderConfig => ({
    ...ABC,
    apiCompatibility,
    defaultModel: modelId,
    customModels: [{
      modelId, contextWindow: 200_000, maxOutputTokens: 16_000,
      capabilities: { toolCalling: true, reasoning, structuredOutput: false },
    }],
  })

  it("offers the vendor's effort levels — in the model config and in the catalog row", () => {
    setCustomProviderRecords({ 'custom-relay': relay('anthropic', 'claude-opus-5-5') })
    const vendorTiers = findConfiguredModel('anthropic', 'claude-opus-5-5')!.availableThinkingTiers
    expect(vendorTiers).toContain('extra-high')
    expect(getAvailableThinkingTiersForModel('claude-opus-5-5', 'custom-relay')).toEqual(vendorTiers)
    const [row] = synthesizeCustomProviderCatalogEntries([getCustomProviderRecord('custom-relay')!], null)
    expect(row!.models[0]!.availableThinkingTiers).toEqual(vendorTiers)
    // Still no default: nothing is sent until the user picks a tier.
    expect(findConfiguredModel('custom-relay', 'claude-opus-5-5')!.defaultThinkingTier).toBeUndefined()
  })

  it("a vendor tier reaches the wire in the vendor's own body shape", () => {
    setCustomProviderRecords({ 'custom-relay': relay('anthropic', 'claude-opus-5-5') })
    const routing = resolveCustomProviderRequest('custom-relay')!
    const fields = resolveModelRequestFields({
      model: 'claude-opus-5-5',
      providerId: 'custom-relay',
      thinkingProviderId: routing.thinkingProviderId,
      thinkingTier: 'extra-high',
    })
    expect(fields.thinkingTier).toBe('extra-high')
    expect(fields.providerBodyExtension).toEqual(
      resolveModelRequestFields({ model: 'claude-opus-5-5', providerId: 'anthropic', thinkingTier: 'extra-high' }).providerBodyExtension,
    )
  })

  it('the OpenAI dialect reads the OpenAI catalog, `none` included', () => {
    setCustomProviderRecords({ 'custom-relay': relay('openai', 'gpt-6-sol') })
    expect(getAvailableThinkingTiersForModel('gpt-6-sol', 'custom-relay'))
      .toEqual(findConfiguredModel('openai', 'gpt-6-sol')!.availableThinkingTiers)
  })

  it("keeps the user's own figures and flags: only the tiers come from the vendor", () => {
    setCustomProviderRecords({ 'custom-relay': relay('anthropic', 'claude-opus-5-5') })
    expect(contextWindowOf('claude-opus-5-5', 'custom-relay')).toBe(200_000)
    expect(getDefaultMaxOutputTokensForModel('claude-opus-5-5', 'custom-relay')).toBe(16_000)
    expect(modelSupportsStrictTools('claude-opus-5-5', 'custom-relay')).toBe(false)
    const row = findConfiguredModel('custom-relay', 'claude-opus-5-5')!
    expect(row.promptProfile).toBeUndefined()
    expect(row.todoTools).toBeUndefined()
  })

  it('no reasoning, no tiers; an id no vendor row covers keeps the generic three', () => {
    setCustomProviderRecords({
      'custom-relay': relay('anthropic', 'claude-opus-5-5', false),
      'custom-abc-provider': ABC,
    })
    expect(getAvailableThinkingTiersForModel('claude-opus-5-5', 'custom-relay')).toBeUndefined()
    expect(getAvailableThinkingTiersForModel('abc-coder-v2', 'custom-abc-provider')).toEqual(['low', 'medium', 'high'])
  })

  it('vendorFiguresForCustomModel: figures only, from the shipped catalog, per dialect', () => {
    const vendor = findConfiguredModel('anthropic', 'claude-opus-5-5')!
    expect(vendorFiguresForCustomModel('anthropic', ' claude-opus-5-5 ')).toEqual({
      vendorId: 'anthropic',
      name: vendor.name,
      contextWindow: vendor.contextWindow,
      defaultMaxOutputTokens: vendor.defaultMaxOutputTokens,
      availableThinkingTiers: vendor.availableThinkingTiers,
    })
    // The dialect picks the vendor: a Claude id over the OpenAI wire is not looked up.
    expect(vendorFiguresForCustomModel('openai', 'claude-opus-5-5')).toBeUndefined()
    expect(vendorFiguresForCustomModel('anthropic', 'abc-coder-v2')).toBeUndefined()
    expect(vendorFiguresForCustomModel('anthropic', '')).toBeUndefined()
    // A custom record never feeds the lookup, even one under a vendor id.
    setCustomProviderRecords({ 'custom-relay': relay('anthropic', 'claude-opus-5-5') })
    expect(vendorFiguresForCustomModel('anthropic', 'claude-opus-5-5')).toEqual(
      vendorFiguresForCustomModel('anthropic', 'claude-opus-5-5'),
    )
  })
})

describe('request routing', () => {
  it('a custom provider rides its OWN id, with its dialect for the thinking body', () => {
    setCustomProviderRecords({
      'custom-abc-provider': ABC,
      'custom-gw': { ...ABC, apiCompatibility: 'anthropic' },
    })
    expect(resolveCustomProviderRequest('custom-abc-provider')).toEqual({
      providerId: 'custom-abc-provider',
      thinkingProviderId: 'openai',
    })
    expect(resolveCustomProviderRequest('custom-gw')).toEqual({
      providerId: 'custom-gw',
      thinkingProviderId: 'anthropic',
    })
  })

  it('leaves built-in providers alone', () => {
    setCustomProviderRecords({ 'custom-abc-provider': ABC })
    expect(resolveCustomProviderRequest('openai')).toBeUndefined()
    expect(resolveCustomProviderRequest(undefined)).toBeUndefined()
    expect(getCustomProviderRecord('openai')).toBeUndefined()
  })

  it('replaces a custom id the host catalog already lists rather than duplicating it', () => {
    setCustomProviderRecords({ 'custom-abc-provider': ABC })
    const merged = appendCustomProvidersToCatalog(listedHostCatalog)!
    expect(merged.providers.filter(p => p.id === 'custom-abc-provider')).toHaveLength(1)
  })
})

describe('custom providers run on a ModelProvider', () => {
  const env = (value?: string) => ({ getEnv: (name: string) => (name === 'providerDrivers' ? value : undefined) }) as never
  const payload = { messages: [{ role: 'user', content: [{ type: 'text', text: 'q' }] }] } as never
  const KEYLESS: NexusProviderConfig = { ...ABC, apiKey: undefined, baseUrl: 'http://gw.internal/v1' }

  it('a record speaks the codec of the host class its dialect builds, the key optional', () => {
    setCustomProviderRecords({
      'custom-abc-provider': ABC,
      'custom-gw': { ...ABC, apiCompatibility: 'anthropic' },
    })
    expect(resolveProviderSpec('custom-abc-provider')).toEqual({
      id: 'custom-abc-provider', format: 'openai-chat', apiKeyOptional: true,
    })
    expect(resolveProviderSpec('custom-gw')).toEqual({
      id: 'custom-gw', format: 'anthropic-messages', apiKeyOptional: true,
    })
    // So do the two compiled-in custom endpoints.
    expect(resolveProviderSpec('custom-openai')).toEqual({ id: 'custom-openai', format: 'openai-chat', apiKeyOptional: true })
    expect(resolveProviderSpec('custom-anthropic')).toEqual({ id: 'custom-anthropic', format: 'anthropic-messages', apiKeyOptional: true })
    // A record without a complete model is not in the catalog: nothing to serve.
    resetCustomProviderRecords()
    setCustomProviderRecords({ 'custom-empty': { ...ABC, customModels: [] } })
    expect(resolveProviderSpec('custom-empty')).toBeUndefined()
  })

  it('a custom provider rides its OWN id on its dialect codec', () => {
    setCustomProviderRecords({ 'custom-abc-provider': ABC })
    const routing = resolveCustomProviderRequest('custom-abc-provider')!
    expect(routing).toEqual({ providerId: 'custom-abc-provider', thinkingProviderId: 'openai' })
    expect(resolveProviderSpec('custom-abc-provider')).toMatchObject({ format: 'openai-chat' })
  })

  it('with a stored key the request carries the host-substituted template; base URL from the record', () => {
    setCustomProviderRecords({ 'custom-abc-provider': ABC })
    publishProviderBaseUrlsFromConfigs({ 'custom-abc-provider': ABC })
    const request = createModelProvider(resolveProviderSpec('custom-abc-provider')!).buildRequest(payload, 'abc-coder-v2')
    expect(request.url).toBe('https://api.abc.example/v1/chat/completions')
    expect(request.headers.authorization).toBe('Bearer {{secret:api_key}}')
  })

  it('keyless: the empty credential the host class sends (Bearer "" / x-api-key ""), never a template the host refuses', () => {
    const configs: Record<string, NexusProviderConfig> = {
      'custom-gateway': KEYLESS,
      'custom-anth': { ...KEYLESS, apiCompatibility: 'anthropic' },
    }
    setCustomProviderRecords(configs)
    publishProviderBaseUrlsFromConfigs(configs)
    const chat = createModelProvider(resolveProviderSpec('custom-gateway')!).buildRequest(payload, 'abc-coder-v2')
    expect(chat.url).toBe('http://gw.internal/v1/chat/completions')
    // OpenAiProvider: "Bearer " + api_key_ (empty).
    expect(chat.headers.authorization).toBe('Bearer ')
    const anth = createModelProvider(resolveProviderSpec('custom-anth')!).buildRequest(payload, 'abc-coder-v2')
    // AnthropicProvider: x-api-key: api_key_ (empty), anthropic-version kept.
    expect(anth.headers['x-api-key']).toBe('')
    expect(anth.headers['anthropic-version']).toBe('2023-06-01')
    expect(JSON.stringify([chat, anth])).not.toContain('{{secret:')
  })

  it('a key the broker holds (launch prefs) counts as stored, and is read per request', () => {
    setCustomProviderRecords({ 'custom-gateway': KEYLESS })
    publishProviderBaseUrlsFromConfigs({ 'custom-gateway': KEYLESS })
    const provider = createModelProvider(resolveProviderSpec('custom-gateway')!)
    expect(provider.buildRequest(payload, 'm').headers.authorization).toBe('Bearer ')
    publishBrokerProviderBaseUrls([{ id: 'custom-gateway', hasStoredApiKey: true }])
    expect(provider.buildRequest(payload, 'm').headers.authorization).toBe('Bearer {{secret:api_key}}')
  })

  it('a provider whose key is required keeps the template even with none stored', () => {
    expect(createModelProvider(resolveProviderSpec('deepseek')!).buildRequest(payload, 'm').headers.authorization)
      .toBe('Bearer {{secret:api_key}}')
  })
})

describe('a turn on a custom provider (engine/turn/turnDependencies.ts)', () => {
  async function runTurn() {
    const actions: Array<{ action: string; payload: any }> = []
    const sse = 'data: ' + JSON.stringify({ choices: [{ index: 0, delta: { content: 'hi' }, finish_reason: 'stop' }] }) + '\n\n'
    const transport = {
      async request(req: any) {
        actions.push({ action: `${req.route.capability}.${req.route.action}`, payload: req.payload })
        const ok = (result: unknown) => ({ id: req.id, route: req.route, ok: true as const, result })
        switch (req.route.action) {
          case 'rawStreamOpen':
            return ok({ streamId: req.payload.streamId ?? 'raw-1', status: 200, statusText: 'OK', finalUrl: req.payload.url, headers: {} })
          case 'rawStreamRead':
            return ok({ done: true, chunk: new TextEncoder().encode(sse) })
          default:
            return ok({})
        }
      },
    }
    const runtimeConfig = new DefaultRuntimeConfig()
    const deps = assembleTurnDependencies(runtimeConfig, {}, { bridgeTransport: transport as never, runtimeConfig })
    const toolUseContext = createNoopToolUseContext({
      tools: [],
      platformCapabilities: new NoopPlatformCapabilities(),
      appState: createEmptyAppState(),
      setAppState: () => {},
    })
    const gen = deps.callModel({
      messages: [{ type: 'user', uuid: 'u1', message: { role: 'user', content: 'hello' } }],
      baseInstructions: 'test',
      userContext: {},
      systemAmbient: {},
      callContext: toolUseContext,
      querySource: 'test',
      providerId: 'custom-abc-provider',
      model: 'abc-coder-v2',
    } as never) as AsyncGenerator<unknown>
    for await (const _ of gen) { /* drain */ }
    return actions
  }

  it('is served in the runtime under its own id: no slot publish, no host model.streamStart', async () => {
    setCustomProviderRecords({ 'custom-abc-provider': ABC })
    // What the worker publishes from settings.json at boot and on every write.
    publishProviderBaseUrlsFromConfigs({ 'custom-abc-provider': ABC })
    const actions = await runTurn()
    const opens = actions.filter(a => a.action === 'model.rawStreamOpen')
    expect(opens).toHaveLength(1)
    expect(opens[0]!.payload).toMatchObject({
      providerId: 'custom-abc-provider',
      url: 'https://api.abc.example/v1/chat/completions',
      headers: { authorization: 'Bearer {{secret:api_key}}' },
    })
    expect(actions.map(a => a.action)).not.toContain('model.publishProviderConfigs')
    expect(actions.map(a => a.action)).not.toContain('model.streamStart')
  })
})
