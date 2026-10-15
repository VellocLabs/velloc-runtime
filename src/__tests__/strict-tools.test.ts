import { describe, expect, it } from 'vitest'
import { modelSupportsStrictTools } from '../utils/strictTools'
import {
  normalizeBrowserHostManifest,
  type HostedToolDefinition,
} from '../browser/bridge/protocol/manifest'

describe('modelSupportsStrictTools (catalog-driven gate)', () => {
  it('returns true for Anthropic models marked supportsStrictTools', () => {
    expect(modelSupportsStrictTools('claude-fable-5', 'anthropic')).toBe(true)
    expect(modelSupportsStrictTools('claude-fable-5-1', 'anthropic')).toBe(true)
    expect(modelSupportsStrictTools('claude-sonnet-5', 'anthropic')).toBe(
      true,
    )
    expect(
      modelSupportsStrictTools('claude-haiku-4-5-20251001', 'anthropic'),
    ).toBe(true)
  })

  it('returns true for OpenAI models marked supportsStrictTools', () => {
    expect(modelSupportsStrictTools('gpt-6-astra', 'openai')).toBe(true)
    expect(modelSupportsStrictTools('gpt-6-sol', 'openai')).toBe(true)
    expect(modelSupportsStrictTools('gpt-6-luna', 'openai')).toBe(true)
    expect(modelSupportsStrictTools('gpt-5.6-terra', 'openai')).toBe(true)
    expect(modelSupportsStrictTools('gpt-5.5-pro', 'openai')).toBe(true)
    expect(modelSupportsStrictTools('gpt-5.6-luna', 'openai')).toBe(true)
    // gpt-5.4-mini came back to the OpenAI lineup as the
    // `gpt-*-mini` family row (a 2026 API model); it stays off chatgpt-pro
    // (see the ChatGPT Pro case below).
    expect(modelSupportsStrictTools('gpt-5.4-mini', 'openai')).toBe(true)
    expect(modelSupportsStrictTools('gpt-5.5', 'openai')).toBe(true)
  })

  it('returns true for ChatGPT Pro models marked supportsStrictTools', () => {
    expect(modelSupportsStrictTools('gpt-6-astra', 'chatgpt-pro')).toBe(true)
    expect(modelSupportsStrictTools('gpt-6-sol', 'chatgpt-pro')).toBe(true)
    expect(modelSupportsStrictTools('gpt-5.6-terra', 'chatgpt-pro')).toBe(true)
    expect(modelSupportsStrictTools('gpt-5.6-sol', 'chatgpt-pro')).toBe(true)
    // Retired from this lineup too — no row, so no strict flag.
    expect(modelSupportsStrictTools('gpt-5.4-mini', 'chatgpt-pro')).toBe(false)
    // Luna was once removed from this lineup after live verification said the
    // Codex backend would not serve it to ChatGPT accounts. That finding was
    // superseded: luna is back in the Codex lineup and carries
    // the strict flag.
    expect(modelSupportsStrictTools('gpt-5.6-luna', 'chatgpt-pro')).toBe(true)
    expect(modelSupportsStrictTools('gpt-5.5-pro', 'chatgpt-pro')).toBe(false)
  })

  it('returns true for GLM-4.6 (Z.AI strict tool use)', () => {
    expect(modelSupportsStrictTools('glm-4.6', 'glm')).toBe(true)
  })

  it('returns false for catalog entries that omit the flag', () => {
    expect(
      modelSupportsStrictTools('gemini-3.1-pro-preview', 'google'),
    ).toBe(false)
    expect(modelSupportsStrictTools('qwen3-max', 'qwen')).toBe(false)
    expect(modelSupportsStrictTools('k3', 'kimi')).toBe(
      false,
    )
    expect(modelSupportsStrictTools('MiniMax-M2', 'minimax')).toBe(false)
    // GLM legacy 4.x — only 4.6 has the flag.
    expect(modelSupportsStrictTools('glm-4-plus', 'glm')).toBe(false)
  })

  it('returns false for uncatalogued models', () => {
    expect(
      modelSupportsStrictTools('definitely-not-a-real-model', 'anthropic'),
    ).toBe(false)
  })

  it('returns false for missing inputs', () => {
    expect(modelSupportsStrictTools(undefined, 'anthropic')).toBe(false)
    expect(modelSupportsStrictTools('claude-opus-4-7', undefined)).toBe(false)
  })
})

describe('manifest normalizer round-trips parametersStrict', () => {
  // The native side ships a hand-crafted strict schema variant on the
  // host manifest's `hostedTools[].parametersStrict`. The normalizer
  // is the JS guest's first touch point — it MUST preserve the field
  // for downstream serializeToolsForModel to use it.
  const STRICT_SCHEMA: HostedToolDefinition['parameters'] = {
    type: 'object',
    properties: {
      actions: {
        type: 'array',
        items: {
          type: 'object',
          properties: { type: { type: 'string' } },
          required: ['type'],
          additionalProperties: false,
        },
      },
    },
    required: ['actions'],
    additionalProperties: false,
  }

  it('preserves parametersStrict when present', () => {
    const manifest = normalizeBrowserHostManifest({
      capabilities: ['browser'],
      commandNames: [],
      hostedTools: [
        {
          type: 'function',
          name: 'browser_actions',
          description: 'do things',
          parameters: { type: 'object', properties: {} },
          parametersStrict: STRICT_SCHEMA,
        },
      ],
      toolNames: ['browser_actions'],
    })
    expect(manifest).not.toBeNull()
    expect(manifest!.hostedTools).toHaveLength(1)
    expect(manifest!.hostedTools[0]!.parametersStrict).toEqual(STRICT_SCHEMA)
  })

  it('omits parametersStrict when the native side did not ship one', () => {
    const manifest = normalizeBrowserHostManifest({
      capabilities: ['browser'],
      commandNames: [],
      hostedTools: [
        {
          type: 'function',
          name: 'browser_actions',
          description: 'do things',
          parameters: { type: 'object', properties: {} },
        },
      ],
      toolNames: ['browser_actions'],
    })
    expect(manifest!.hostedTools[0]!.parametersStrict).toBeUndefined()
  })

  it('rejects malformed parametersStrict (not an object schema) without crashing', () => {
    const manifest = normalizeBrowserHostManifest({
      capabilities: ['browser'],
      commandNames: [],
      hostedTools: [
        {
          type: 'function',
          name: 'browser_actions',
          description: 'do things',
          parameters: { type: 'object', properties: {} },
          parametersStrict: 'not a schema',
        },
      ],
      toolNames: ['browser_actions'],
    })
    expect(manifest!.hostedTools[0]!.parametersStrict).toBeUndefined()
  })

  it('rejects parametersStrict whose type is not "object"', () => {
    const manifest = normalizeBrowserHostManifest({
      capabilities: ['browser'],
      commandNames: [],
      hostedTools: [
        {
          type: 'function',
          name: 'browser_actions',
          description: 'do things',
          parameters: { type: 'object', properties: {} },
          parametersStrict: { type: 'array' },
        },
      ],
      toolNames: ['browser_actions'],
    })
    expect(manifest!.hostedTools[0]!.parametersStrict).toBeUndefined()
  })
})
