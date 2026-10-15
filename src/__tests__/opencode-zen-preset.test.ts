import { describe, expect, it } from 'vitest'

import {
  canSubmitCustomProvider,
  configFromDraft,
  isCustomDraftDirty,
  isModelComplete,
} from '../browser/webview/settings/customProviderHelpers'
import {
  OPENCODE_ZEN_BASE_URL,
  OPENCODE_ZEN_DEFAULT_MODEL,
  OPENCODE_ZEN_FREE_MODELS,
  isOpencodeZenBaseUrl,
  opencodeZenDraft,
} from '../browser/webview/settings/opencodeZenPreset'

/**
 * The OpenCode Zen preset is a pre-filled custom-provider draft: it must be
 * savable as-is (bar the user's own key), and must not look like unsaved
 * work before the user touches it.
 */
describe('opencodeZenDraft', () => {
  it('pre-fills an OpenAI-compatible draft pointing at the Zen root', () => {
    const draft = opencodeZenDraft()
    expect(draft.apiCompatibility).toBe('openai')
    expect(draft.baseUrl).toBe(OPENCODE_ZEN_BASE_URL)
    expect(draft.apiKey).toBe('')
    // A gateway in front of other vendors is never their official endpoint.
    expect(draft.trust).toBe('untrusted')
  })

  it('seeds only complete models, with the default among them', () => {
    const draft = opencodeZenDraft()
    expect(draft.models.length).toBe(OPENCODE_ZEN_FREE_MODELS.length)
    expect(draft.models.every(isModelComplete)).toBe(true)
    expect(draft.models.map(m => m.modelId)).toContain(OPENCODE_ZEN_DEFAULT_MODEL)
    expect(draft.defaultModel).toBe(OPENCODE_ZEN_DEFAULT_MODEL)
  })

  it('passes the submit gate without an API key', () => {
    const draft = opencodeZenDraft()
    expect(
      canSubmitCustomProvider({
        displayName: draft.displayName,
        nameTaken: false,
        baseUrl: draft.baseUrl,
        models: draft.models,
        defaultModelId: draft.defaultModel,
      }),
    ).toBe(true)
  })

  it('persists as a custom provider with every seeded model enabled', () => {
    const config = configFromDraft(
      { ...opencodeZenDraft(), apiKey: 'zen-key' },
      'custom-opencode-zen',
    )
    expect(config.isCustomProvider).toBe(true)
    expect(config.baseUrl).toBe(OPENCODE_ZEN_BASE_URL)
    expect(config.apiKey).toBe('zen-key')
    expect(config.enabledModels).toEqual(
      OPENCODE_ZEN_FREE_MODELS.map(m => m.modelId),
    )
  })

  it('returns a fresh copy each call, so edits never leak into the preset', () => {
    const a = opencodeZenDraft()
    a.models[0].capabilities!.vision = true
    a.models.pop()
    const b = opencodeZenDraft()
    expect(b.models.length).toBe(OPENCODE_ZEN_FREE_MODELS.length)
    expect(b.models[0].capabilities?.vision).toBeUndefined()
  })
})

describe('isCustomDraftDirty with a preset base', () => {
  it('treats an untouched preset as clean and an edited one as dirty', () => {
    const base = opencodeZenDraft()
    expect(isCustomDraftDirty(opencodeZenDraft(), undefined, base)).toBe(false)
    expect(
      isCustomDraftDirty({ ...opencodeZenDraft(), apiKey: 'k' }, undefined, base),
    ).toBe(true)
  })

  it('still compares a blank create form against the empty draft', () => {
    expect(isCustomDraftDirty(opencodeZenDraft(), undefined)).toBe(true)
  })
})

describe('isOpencodeZenBaseUrl', () => {
  it('matches the Zen root regardless of trailing slash or case', () => {
    expect(isOpencodeZenBaseUrl('https://opencode.ai/zen/v1')).toBe(true)
    expect(isOpencodeZenBaseUrl(' https://OpenCode.ai/zen/v1/ ')).toBe(true)
    expect(isOpencodeZenBaseUrl('https://opencode.ai/zen/go/v1')).toBe(false)
    expect(isOpencodeZenBaseUrl('')).toBe(false)
  })
})
