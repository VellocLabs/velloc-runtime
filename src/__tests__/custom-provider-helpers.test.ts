import { describe, expect, it } from 'vitest'

import {
  canSubmitCustomProvider,
  configFromDraft,
  draftFromRecord,
  emptyCustomProviderDraft,
  formatTokenCount,
  isCustomDraftDirty,
  isProviderNameTaken,
  isValidBaseUrl,
  modelCapabilityBadges,
  normaliseBaseUrl,
} from '../browser/webview/settings/customProviderHelpers'
import type { CustomModelDef, NexusProviderConfig } from '../settings/settingsTypes'

/**
 * Form rules for the custom-provider page — the gate that
 * decides whether a provider can be saved, and the shape that gets persisted.
 */

const COMPLETE: CustomModelDef = {
  modelId: 'abc-coder-v2',
  displayName: 'ABC Coder',
  contextWindow: 262_144,
  maxOutputTokens: 65_536,
  capabilities: { toolCalling: true, reasoning: true },
}
const INCOMPLETE: CustomModelDef = { modelId: 'abc-embed', incomplete: true }

function draft(overrides: Partial<ReturnType<typeof emptyCustomProviderDraft>> = {}) {
  return {
    ...emptyCustomProviderDraft(),
    displayName: 'ABC Provider',
    baseUrl: 'https://api.abc.example/v1',
    models: [COMPLETE],
    defaultModel: COMPLETE.modelId,
    ...overrides,
  }
}

describe('base URL handling', () => {
  it('strips trailing slashes so the user need not know the join rules', () => {
    expect(normaliseBaseUrl('  https://api.example.com/v1///  ')).toBe(
      'https://api.example.com/v1',
    )
  })

  it('accepts only absolute http(s) URLs', () => {
    expect(isValidBaseUrl('https://api.example.com/v1')).toBe(true)
    expect(isValidBaseUrl('http://127.0.0.1:8765/v1')).toBe(true)
    expect(isValidBaseUrl('api.example.com')).toBe(false)
    expect(isValidBaseUrl('ftp://api.example.com')).toBe(false)
    expect(isValidBaseUrl('')).toBe(false)
  })
})

describe('token formatting', () => {
  it('renders power-of-two limits the way vendors quote them', () => {
    expect(formatTokenCount(262_144)).toBe('256K')
    expect(formatTokenCount(65_536)).toBe('64K')
    expect(formatTokenCount(200_000)).toBe('200K')
    expect(formatTokenCount(1_000_000)).toBe('1M')
    expect(formatTokenCount(512)).toBe('512')
    expect(formatTokenCount(undefined)).toBe('—')
  })
})

describe('capability badges', () => {
  it('lists only the enabled capabilities, in spec order', () => {
    expect(
      modelCapabilityBadges(
        {
          modelId: 'x',
          capabilities: { vision: true, toolCalling: true, structuredOutput: true },
        },
        {
          tools: 'Tools',
          reasoning: 'Reasoning',
          vision: 'Vision',
          imageGen: 'Image',
          structured: 'Structured',
        },
      ),
    ).toEqual(['Tools', 'Vision', 'Structured'])
  })
})

describe('provider-name uniqueness', () => {
  const builtIns = new Map([
    ['openai', 'OpenAI'],
    ['anthropic', 'Anthropic'],
  ])
  const configs: Record<string, NexusProviderConfig> = {
    'custom-abc-provider': { isCustomProvider: true, displayName: 'ABC Provider' },
  }

  it('rejects a built-in label and another custom name, case-insensitively', () => {
    expect(isProviderNameTaken('openai', configs, builtIns)).toBe(true)
    expect(isProviderNameTaken('  ABC provider ', configs, builtIns)).toBe(true)
    expect(isProviderNameTaken('OpenAI Proxy', configs, builtIns)).toBe(false)
  })

  it('lets the provider being edited keep its own name', () => {
    expect(
      isProviderNameTaken('ABC Provider', configs, builtIns, 'custom-abc-provider'),
    ).toBe(false)
  })
})

describe('submit gate', () => {
  it('enables submit for a named provider with a valid URL and a complete default model', () => {
    expect(
      canSubmitCustomProvider({
        displayName: 'ABC Provider',
        nameTaken: false,
        baseUrl: 'https://api.abc.example/v1',
        models: [COMPLETE, INCOMPLETE],
        defaultModelId: COMPLETE.modelId,
      }),
    ).toBe(true)
  })

  it.each([
    ['blank name', { displayName: '  ' }],
    ['duplicate name', { nameTaken: true }],
    ['malformed base URL', { baseUrl: 'api.abc.example' }],
    ['no models', { models: [] as CustomModelDef[], defaultModelId: '' }],
    ['no default model', { defaultModelId: '' }],
    ['incomplete default model', { defaultModelId: INCOMPLETE.modelId }],
  ])('blocks submit on %s', (_label, patch) => {
    expect(
      canSubmitCustomProvider({
        displayName: 'ABC Provider',
        nameTaken: false,
        baseUrl: 'https://api.abc.example/v1',
        models: [COMPLETE, INCOMPLETE],
        defaultModelId: COMPLETE.modelId,
        ...patch,
      }),
    ).toBe(false)
  })

  it('does NOT require an API key or a passing connection test', () => {
    // Keyless gateways and network-restricted enterprise endpoints must save.
    expect(
      canSubmitCustomProvider({
        displayName: 'Internal AI Gateway',
        nameTaken: false,
        baseUrl: 'http://gateway.internal/v1',
        models: [COMPLETE],
        defaultModelId: COMPLETE.modelId,
      }),
    ).toBe(true)
  })
})

describe('persisted shape', () => {
  it('writes the custom marker, normalised URL, enabled models, and stamp', () => {
    const config = configFromDraft(
      draft({ apiKey: 'sk-abc', models: [COMPLETE, INCOMPLETE], baseUrl: 'https://api.abc.example/v1/' }),
      'custom-abc-provider',
      1234,
    )
    expect(config).toMatchObject({
      isCustomProvider: true,
      displayName: 'ABC Provider',
      apiCompatibility: 'openai',
      baseUrl: 'https://api.abc.example/v1',
      defaultModel: 'abc-coder-v2',
      model: 'abc-coder-v2',
      apiKey: 'sk-abc',
      // Only the COMPLETE model is advertised as enabled…
      enabledModels: ['abc-coder-v2'],
      lastVerification: { providerId: 'custom-abc-provider', verifiedAtMs: 1234 },
    })
    // …but the incomplete one is still persisted so the user can finish it.
    expect(config.customModels).toHaveLength(2)
  })

  it('omits an empty api key and the verification stamp when untested', () => {
    const config = configFromDraft(draft(), 'custom-abc-provider')
    expect('apiKey' in config).toBe(false)
    expect(config.lastVerification).toBeUndefined()
  })
})

describe('unsaved-changes detection', () => {
  const record = {
    id: 'custom-abc-provider',
    displayName: 'ABC Provider',
    providerIcon: 'generic',
    apiCompatibility: 'openai' as const,
    baseUrl: 'https://api.abc.example/v1',
    apiKey: '',
    defaultModel: COMPLETE.modelId,
    models: [COMPLETE],
  }

  it('is clean for an untouched round-trip', () => {
    expect(isCustomDraftDirty(draftFromRecord(record), record)).toBe(false)
  })

  it.each([
    ['name', { displayName: 'ABC Proxy' }],
    ['icon', { providerIcon: 'openai' }],
    ['dialect', { apiCompatibility: 'anthropic' as const }],
    ['key', { apiKey: 'sk-new' }],
    ['models', { models: [COMPLETE, INCOMPLETE] }],
  ])('detects a changed %s', (_label, patch) => {
    expect(
      isCustomDraftDirty({ ...draftFromRecord(record), ...patch }, record),
    ).toBe(true)
  })

  it('ignores a trailing slash the normaliser would strip anyway', () => {
    expect(
      isCustomDraftDirty(
        { ...draftFromRecord(record), baseUrl: 'https://api.abc.example/v1/' },
        record,
      ),
    ).toBe(false)
  })
})
