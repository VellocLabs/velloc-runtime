import { describe, expect, it } from 'vitest'

import type { BrowserLlmModel } from '../browser/bridge/protocol/nexus_llm'
import { applyConfiguredModelRule, createConfiguredProvider } from '../browser/webview/configuredModels'
import { findConfiguredModel } from '../config/nexusModelConfig/findConfiguredModel'
import { NEXUS_MODEL_CONFIG } from '../config/nexusModelConfig'
import type { NexusConfiguredModel } from '../config/nexusModelConfig/types'
import {
  FALLBACK_MAX_OUTPUT_TOKENS,
  resolveModelRequestFields,
} from '../engine/turn/modelRequestFields'

/**
 * The request fields that vary with the model and thinking tier, for every curated picker row × tier (plus no
 * tier); the C++ providers never branch on the model, so the cross product is decided here. The oracle states each
 * vendor's documented effort vocabulary; per-model data comes from the model's own catalog row.
 */

type Row = {
  providerId: string
  model: BrowserLlmModel
  config: NexusConfiguredModel
}

/** Curated picker rows, exactly as the picker builds them from the config
 *  when the host catalog lists nothing extra. Passthrough providers (their
 *  models come from the host) are not enumerable here — the e2e covers them. */
function curatedRows(): Row[] {
  const rows: Row[] = []
  for (const providerConfig of NEXUS_MODEL_CONFIG.providers) {
    const provider = createConfiguredProvider({
      id: providerConfig.providerId,
      label: providerConfig.providerId,
      iconSvg: '',
      enabled: true,
      models: [],
    })
    for (const model of provider.models) {
      const config = providerConfig.models.find(entry =>
        typeof entry.model === 'string'
          ? entry.model === model.id
          : entry.model.test(model.id),
      )
      if (config) rows.push({ providerId: providerConfig.providerId, model, config })
    }
  }
  // The curated rows are each family row's verified and known versions. A
  // version the vendor has NOT shipped must send what its family's row says,
  // with no row of its own — the matrix names a few.
  for (const [providerId, id] of UNSHIPPED_VERSIONS) {
    const config = findConfiguredModel(providerId, id)
    if (!config) throw new Error(`${providerId}/${id}: no family row covers it`)
    const model = applyConfiguredModelRule({ id, label: id, enabled: true, supportsStreaming: true }, config)
    rows.push({ providerId, model, config })
  }
  return rows
}

const UNSHIPPED_VERSIONS: ReadonlyArray<readonly [string, string]> = [
  ['anthropic', 'claude-fable-5-2'],
  ['anthropic', 'claude-haiku-5'],
  ['openai', 'gpt-7-astra'],
  ['qwen', 'qwen3.9-max'],
  ['kimi', 'k4'],
  ['kimi', 'k4-pro'],
  ['deepseek', 'deepseek-v5-pro'],
]

const ROWS = curatedRows()

/** The effort / thinking fragment a vendor documents for a tier, or
 *  undefined when the provider takes no per-request thinking field. */
function expectedExtension(
  providerId: string,
  tier: string,
  maxOutputTokens: number,
): Record<string, unknown> | undefined {
  const xhigh = (t: string) => (t === 'extra-high' ? 'xhigh' : t)
  switch (providerId) {
    case 'anthropic':
      // Adaptive thinking + output_config.effort: low|medium|high|xhigh|max.
      return { thinking: { type: 'adaptive' }, output_config: { effort: xhigh(tier) } }
    case 'openai':
      // reasoning_effort (the C++ Responses path nests it as reasoning.effort).
      return { reasoning_effort: xhigh(tier) }
    case 'chatgpt-pro':
      return tier === 'ultra' ? undefined : { reasoning_effort: xhigh(tier) }
    case 'deepseek':
      // Real levels low|high|max; `none` is the thinking toggle; the top
      // pill means the top level (max), medium folds to high.
      if (tier === 'none') return { thinking: { type: 'disabled' } }
      return {
        reasoning_effort:
          tier === 'medium' ? 'high' : tier === 'extra-high' || tier === 'xhigh' ? 'max' : tier,
      }
    case 'kimi':
      // low | high | max on the wire; `none` is the thinking toggle.
      if (tier === 'none') return { thinking: { type: 'disabled' } }
      return {
        reasoning_effort:
          tier === 'medium'
            ? 'high'
            : tier === 'extra-high' || tier === 'xhigh' || tier === 'ultra'
              ? 'max'
              : tier,
      }
    case 'qwen': {
      // enable_thinking + thinking_budget (low 2048 / medium 8192 / high,max
      // 32768), capped at half the output envelope; `none` disables.
      if (tier === 'none') return { enable_thinking: false }
      const raw = tier === 'low' ? 2048 : tier === 'medium' ? 8192 : 32_768
      const budget = Math.min(raw, Math.floor(maxOutputTokens / 2))
      return budget < 1
        ? { enable_thinking: true }
        : { enable_thinking: true, thinking_budget: budget }
    }
    default:
      return undefined
  }
}

/** Providers whose tiers ride a per-request body field. A curated tier on
 *  one of these that produces NO field would be a silent drop. */
const MAPPED_PROVIDERS = new Set([
  'anthropic', 'openai', 'chatgpt-pro', 'deepseek', 'kimi', 'qwen',
])

/**
 * Known gaps: a curated pill that sends no field, pinned so a change is a deliberate edit here.
 * chatgpt-pro / gpt-5.6-luna / none: the row offers it but the mapper drops `none`, so the model default is sent.
 */
const KNOWN_DROPPED: ReadonlySet<string> = new Set([
  'chatgpt-pro/gpt-5.6-luna/none',
])

describe('provider request fields — every curated model × tier', () => {
  it('enumerates the curated catalog (guards the enumeration itself)', () => {
    const providers = new Set(ROWS.map(r => r.providerId))
    for (const id of ['anthropic', 'openai', 'kimi', 'qwen']) {
      expect(providers.has(id), `${id} has curated picker rows`).toBe(true)
    }
    expect(ROWS.length).toBeGreaterThan(10)
  })

  const cases = ROWS.flatMap(row => [
    { ...row, tier: undefined as string | undefined },
    ...(row.model.availableThinkingTiers ?? []).map(tier => ({ ...row, tier })),
  ])

  it.each(cases.map(c => [
    `${c.providerId}/${c.model.id}/${c.tier ?? 'no-tier'}`,
    c,
  ] as const))('%s', (_label, c) => {
    const fields = resolveModelRequestFields({
      model: c.model.id,
      providerId: c.providerId,
      thinkingTier: c.tier,
    })
    const maxOut = c.config.defaultMaxOutputTokens ?? FALLBACK_MAX_OUTPUT_TOKENS
    expect(fields.maxOutputTokens, 'output cap from the model row').toBe(maxOut)
    expect(fields.thinkingTier, 'an offered tier is sent').toBe(c.tier)
    if (KNOWN_DROPPED.has(_label)) {
      expect(fields.providerBodyExtension, 'known gap — see KNOWN_DROPPED')
        .toBeUndefined()
      return
    }
    const expected = c.tier ? expectedExtension(c.providerId, c.tier, maxOut) : undefined
    expect(fields.providerBodyExtension).toEqual(expected)
    if (c.tier && MAPPED_PROVIDERS.has(c.providerId)) {
      expect(fields.providerBodyExtension, 'an offered tier is never silently dropped')
        .toBeDefined()
    }
  })

  it('a tier the model does not offer is dropped, not sent', () => {
    for (const row of ROWS) {
      const offered = row.model.availableThinkingTiers
      if (!offered) continue
      const foreign = ['minimal', 'none', 'low', 'medium', 'high', 'extra-high', 'max']
        .find(t => !offered.includes(t))
      if (!foreign) continue
      const fields = resolveModelRequestFields({
        model: row.model.id,
        providerId: row.providerId,
        thinkingTier: foreign,
      })
      expect(fields.thinkingTier, `${row.providerId}/${row.model.id} drops ${foreign}`)
        .toBeUndefined()
      expect(fields.providerBodyExtension).toBeUndefined()
    }
  })

  it('an explicit output cap overrides the row and feeds the qwen clamp', () => {
    const qwen = ROWS.find(r => r.providerId === 'qwen'
      && (r.model.availableThinkingTiers ?? []).includes('max'))
    expect(qwen, 'a qwen row offering max').toBeDefined()
    const fields = resolveModelRequestFields({
      model: qwen!.model.id,
      providerId: 'qwen',
      thinkingTier: 'max',
      maxOutputTokensOverride: 1000,
    })
    expect(fields.maxOutputTokens).toBe(1000)
    expect(fields.providerBodyExtension).toEqual({ enable_thinking: true, thinking_budget: 500 })
  })

  it('an uncatalogued model gets the fallback cap and no tier', () => {
    const fields = resolveModelRequestFields({
      model: 'not-a-catalogued-model',
      providerId: 'openai',
      thinkingTier: 'high',
    })
    expect(fields.maxOutputTokens).toBe(FALLBACK_MAX_OUTPUT_TOKENS)
    // A curated provider's unknown model takes no reasoning control: the
    // tier remembered from the previous model is not sent.
    expect(fields.thinkingTier).toBeUndefined()
    expect(fields.providerBodyExtension).toBeUndefined()
  })

  it('a curated row without a tier list sends no tier either', () => {
    // Haiku 4.5's row states no tiers: a stale `max` from Opus must not reach it.
    const fields = resolveModelRequestFields({
      model: 'claude-haiku-4-5',
      providerId: 'anthropic',
      thinkingTier: 'max',
    })
    expect(fields.thinkingTier).toBeUndefined()
    expect(fields.providerBodyExtension).toBeUndefined()
  })

  it('a passthrough provider forwards the tier the user picked', () => {
    const fields = resolveModelRequestFields({
      model: 'some-model',
      providerId: 'openrouter',
      thinkingTier: 'high',
    })
    expect(fields.thinkingTier).toBe('high')
  })

  it('a custom slot takes its dialect vendor for the body shape', () => {
    const fields = resolveModelRequestFields({
      model: 'my-model',
      providerId: 'custom-abc',
      thinkingProviderId: 'anthropic',
      thinkingTier: 'high',
    })
    expect(fields.providerBodyExtension).toEqual({
      thinking: { type: 'adaptive' },
      output_config: { effort: 'high' },
    })
  })
})
