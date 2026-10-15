// `prompting/promptProfile.ts` — the prompt profile axis (F-19). `lean` is opt-in: a model renders the short prompt
// only where its catalog entry declares `promptProfile: 'lean'`; everything else is `standard`. Model-driven,
// never provider-driven.

import { describe, expect, it } from 'vitest'
import { findConfiguredModel } from '../config/nexusModelConfig/findConfiguredModel'
import {
  isPromptProfile,
  PROMPT_PROFILES,
  resolvePromptProfile,
} from '../prompting/promptProfile'

describe('resolvePromptProfile — lean is opt-in, everything else standard', () => {
  it('the catalog is the ONLY source of lean', () => {
    // The lean line is exactly the models Anthropic trained on that prompt.
    for (const id of [
      'claude-fable-5-1',
      'claude-fable-5',
      'claude-opus-5-5',
      'claude-opus-5',
      'claude-opus-4-8',
    ]) {
      expect(findConfiguredModel('anthropic', id)?.promptProfile, id).toBe('lean')
    }
    for (const id of ['claude-sonnet-5', 'claude-haiku-4-5']) {
      expect(findConfiguredModel('anthropic', id)?.promptProfile, id).toBe('standard')
    }
    // No other provider declares a profile at all — so none of their models
    // can resolve to lean.
    for (const [provider, id] of [
      ['openai', 'gpt-6-astra'],
      ['openai', 'gpt-5.6-sol'],
      ['openai', 'gpt-5.6-terra'],
      ['deepseek', 'deepseek-v4'],
      ['kimi', 'kimi-k3'],
      ['qwen', 'qwen3.8-max'],
      ['google', 'gemini-3.1-pro-preview'],
    ] as const) {
      expect(findConfiguredModel(provider, id)?.promptProfile, id).toBeUndefined()
    }
  })

  it.each([
    // The declared lean line, including its dated-snapshot form.
    [{ providerId: 'anthropic', modelId: 'claude-fable-5-1' }, 'lean'],
    [{ providerId: 'anthropic', modelId: 'claude-fable-5-1-20260901' }, 'lean'],
    [{ providerId: 'anthropic', modelId: 'claude-fable-5' }, 'lean'],
    [{ providerId: 'anthropic', modelId: 'claude-opus-5-5' }, 'lean'],
    [{ providerId: 'anthropic', modelId: 'claude-opus-5' }, 'lean'],
    [{ providerId: 'anthropic', modelId: 'claude-opus-4-8' }, 'lean'],
    // Declared standard.
    [{ providerId: 'anthropic', modelId: 'claude-sonnet-5' }, 'standard'],
    [{ providerId: 'anthropic', modelId: 'claude-haiku-4-5' }, 'standard'],
    // Uncatalogued Anthropic ids — older Opus, a future Sonnet, anything.
    // Undeclared means standard: more instruction, not less.
    [{ providerId: 'anthropic', modelId: 'claude-opus-4-7' }, 'standard'],
    [{ providerId: 'anthropic', modelId: 'claude-sonnet-6' }, 'standard'],
    [{ providerId: 'anthropic', modelId: 'claude-mythos-5-1' }, 'standard'],
    // Every other provider's models. These used to be lean by default, which
    // gave them less prose than their own vendors ship for them.
    [{ providerId: 'openai', modelId: 'gpt-6-sol' }, 'standard'],
    [{ providerId: 'openai', modelId: 'gpt-5.6-sol' }, 'standard'],
    [{ providerId: 'openai', modelId: 'gpt-5.4-mini' }, 'standard'],
    [{ providerId: 'chatgpt-pro', modelId: 'gpt-5.6-terra' }, 'standard'],
    [{ providerId: 'qwen', modelId: 'qwen3.8-max' }, 'standard'],
    [{ providerId: 'deepseek', modelId: 'deepseek-v4' }, 'standard'],
    [{ providerId: 'ollama', modelId: 'phi3' }, 'standard'],
    // Relays: the provider never decides, and a `custom-<slug>` id carries no
    // information about the model behind it. A Claude id on a relay is NOT
    // enough to earn lean — the relay is not the catalogued provider.
    [{ providerId: 'custom-anthropic', modelId: 'claude-fable-5-1' }, 'standard'],
    [{ providerId: 'custom-openai', modelId: 'gpt-5.5' }, 'standard'],
    [{ providerId: 'custom-cc-vibe', modelId: 'claude-opus-5' }, 'standard'],
    // Missing halves, and QueryEngine's placeholder when no model is chosen.
    [{ providerId: 'anthropic', modelId: 'inherit' }, 'standard'],
    [{ providerId: 'anthropic' }, 'standard'],
    [{ modelId: 'claude-fable-5-1' }, 'standard'],
    [{}, 'standard'],
  ] as const)('%j → %s', (input, expected) => {
    expect(resolvePromptProfile(input)).toBe(expected)
  })

  it('a first-party lean id does not leak through a relay of the same dialect', () => {
    // `custom-anthropic` is a user endpoint speaking the Anthropic wire. It
    // may host anything under any alias, so its ids carry no guarantee — the
    // catalog lookup is per provider for exactly this reason.
    expect(resolvePromptProfile({ providerId: 'anthropic', modelId: 'claude-opus-5' })).toBe(
      'lean',
    )
    expect(
      resolvePromptProfile({ providerId: 'custom-anthropic', modelId: 'claude-opus-5' }),
    ).toBe('standard')
  })
})

describe('PromptProfile guards', () => {
  it('exactly two profiles exist', () => {
    expect([...PROMPT_PROFILES].sort()).toEqual(['lean', 'standard'])
  })

  it('isPromptProfile accepts only those two', () => {
    expect(isPromptProfile('lean')).toBe(true)
    expect(isPromptProfile('standard')).toBe(true)
    for (const bad of ['anthropic', 'LEAN', '', undefined, null, 1]) {
      expect(isPromptProfile(bad), String(bad)).toBe(false)
    }
  })
})
