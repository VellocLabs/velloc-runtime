import { describe, expect, it } from 'vitest'
import type { Message } from '../runtime/RuntimeTypes'
import {
  accumulateSessionUsage,
  formatCostReport,
  getModelPricing,
} from '../engine/usageCost'
import { renderPartsEnglish } from '../input/systemMessageParts'

function assistant(
  model: string,
  usage: Record<string, number>,
): Message {
  return {
    type: 'assistant',
    uuid: `a-${model}-${Math.round(usage.output_tokens ?? 0)}`,
    message: { role: 'assistant', content: [], model, usage },
  } as unknown as Message
}

function user(text: string): Message {
  return {
    type: 'user',
    uuid: `u-${text}`,
    message: { role: 'user', content: text },
  } as unknown as Message
}

describe('cost / usage reporting', () => {
  describe('accumulateSessionUsage', () => {
    it('sums per-model token usage from assistant messages, ignoring others', () => {
      const messages = [
        user('hi'),
        assistant('claude-opus-4-5', {
          input_tokens: 100,
          output_tokens: 50,
          cache_read_input_tokens: 10,
          cache_creation_input_tokens: 5,
        }),
        assistant('claude-sonnet-4-6', {
          input_tokens: 200,
          output_tokens: 100,
        }),
        assistant('claude-opus-4-5', {
          input_tokens: 50,
          output_tokens: 25,
          cache_read_input_tokens: 5,
        }),
      ]
      const byModel = accumulateSessionUsage(messages)
      expect(byModel.get('claude-opus-4-5')).toEqual({
        input: 150,
        output: 75,
        cacheRead: 15,
        cacheCreate: 5,
      })
      expect(byModel.get('claude-sonnet-4-6')).toEqual({
        input: 200,
        output: 100,
        cacheRead: 0,
        cacheCreate: 0,
      })
    })

    it('buckets usage with no model under "unknown" and skips messages without usage', () => {
      const byModel = accumulateSessionUsage([
        assistant('', { input_tokens: 10, output_tokens: 5 }),
        { type: 'assistant', uuid: 'x', message: { role: 'assistant', content: [] } } as unknown as Message,
      ])
      expect(byModel.get('unknown')).toEqual({ input: 10, output: 5, cacheRead: 0, cacheCreate: 0 })
      expect(byModel.size).toBe(1)
    })
  })

  describe('getModelPricing (Anthropic tiers; no guessing for others)', () => {
    // Published list rates, per Mtok:
    // https://platform.claude.com/docs/en/about-claude/pricing
    const OPUS_5_25 = { input: 5, output: 25, cacheRead: 0.5, cacheCreate: 6.25 }
    const OPUS_15_75 = { input: 15, output: 75, cacheRead: 1.5, cacheCreate: 18.75 }
    const SONNET_3_15 = { input: 3, output: 15, cacheRead: 0.3, cacheCreate: 3.75 }
    const HAIKU_1_5 = { input: 1, output: 5, cacheRead: 0.1, cacheCreate: 1.25 }

    it('prices Opus 5.5 at $4/$20 with the 0.05x cache read', () => {
      // Fails before the fix: `opus-5-5` matched neither the anchored Opus 5
      // regex nor the 4.x branch, so the model Anthropic now recommends first
      // fell through to `return null` and /cost rendered "(pricing
      // unavailable)". Its cache read is 5% of input, not the usual 10%.
      const OPUS_55 = { input: 4, output: 20, cacheRead: 0.2, cacheCreate: 5 }
      expect(getModelPricing('claude-opus-5-5')).toEqual(OPUS_55)
      expect(getModelPricing('claude-opus-5-5-20260922')).toEqual(OPUS_55)
    })

    it('prices Opus 5 at $5/$25', () => {
      // Fails before the fix: the Opus branch only matched Opus 4-era ids, so
      // `claude-opus-5` fell through to `return null` and /cost rendered
      // "(pricing unavailable)" for the model most sessions actually run on.
      expect(getModelPricing('claude-opus-5')).toEqual(OPUS_5_25)
      expect(getModelPricing('claude-opus-5-20260101')).toEqual(OPUS_5_25)
    })

    it('prices Haiku 4.5 at $1/$5', () => {
      // Also fell through to null before the fix — the Haiku figures are just
      // as citable as the Opus ones, so there was nothing to abstain from.
      expect(getModelPricing('claude-haiku-4-5')).toEqual(HAIKU_1_5)
      expect(getModelPricing('claude-haiku-4-5-20251001')).toEqual(HAIKU_1_5)
    })

    it('prices each Opus generation on its own tier', () => {
      expect(getModelPricing('claude-opus-4-8')).toEqual(OPUS_5_25)
      expect(getModelPricing('claude-opus-4-7')).toEqual(OPUS_5_25)
      expect(getModelPricing('claude-opus-4-6')).toEqual(OPUS_5_25)
      expect(getModelPricing('claude-opus-4-5')).toEqual(OPUS_5_25)
      expect(getModelPricing('claude-opus-4-1')).toEqual(OPUS_15_75)
      expect(getModelPricing('claude-opus-4')).toEqual(OPUS_15_75)
    })

    it('prices every released Sonnet on the $3/$15 tier', () => {
      // Sonnet 5 carries an introductory $2/$10 for a limited period; we report
      // the standard list rate rather than a price that lapses on a date.
      expect(getModelPricing('claude-sonnet-5')).toEqual(SONNET_3_15)
      expect(getModelPricing('claude-sonnet-4-6')).toEqual(SONNET_3_15)
      expect(getModelPricing('claude-sonnet-4-5')).toEqual(SONNET_3_15)
    })

    it('abstains rather than guessing an unreleased Opus/Haiku minor', () => {
      // The point of the guard: a minor has repriced before (Opus 4 → 4.5), so
      // an id we have no figure for must stay unpriced, not inherit a
      // neighbour's tier.
      expect(getModelPricing('claude-opus-5-1')).toBeNull()
      expect(getModelPricing('claude-opus-5-6')).toBeNull()
      expect(getModelPricing('claude-opus-6')).toBeNull()
      expect(getModelPricing('claude-haiku-5')).toBeNull()
      // Haiku 3 / 3.5 are $0.25/$1.25 and $0.80/$4 — not the 4.5 tier.
      expect(getModelPricing('claude-3-5-haiku-20241022')).toBeNull()
      expect(getModelPricing('claude-3-haiku-20240307')).toBeNull()
    })

    it('returns null for other providers and unknown ids', () => {
      expect(getModelPricing('deepseek-chat')).toBeNull()
      expect(getModelPricing('gemini-2.5-pro')).toBeNull()
      expect(getModelPricing('unknown')).toBeNull()
    })
  })

  describe('formatCostReport', () => {
    it('renders token totals + USD for priced models and a caveat for unpriced', () => {
      const byModel = accumulateSessionUsage([
        assistant('claude-sonnet-4-6', { input_tokens: 1_000_000, output_tokens: 1_000_000 }),
        assistant('deepseek-chat', { input_tokens: 500, output_tokens: 250 }),
      ])
      const report = renderPartsEnglish(formatCostReport(byModel))
      expect(report).toContain('claude-sonnet-4-6')
      expect(report).toContain('deepseek-chat')
      expect(report).toContain('1,000,000 in')
      expect(report).toContain('$18.00') // 1M in * $3 + 1M out * $15 = $18
      expect(report).toContain('pricing unavailable') // deepseek caveat
      expect(report).toContain('Total:')
    })

    it('counts the flagship toward the estimated total, with no caveat', () => {
      // The user-visible half of the bug: before the fix this row rendered
      // "(pricing unavailable)", the estimate line was suppressed entirely
      // (totUsd stayed 0), and the unpriced caveat appeared for a session
      // whose only model has a published price.
      const byModel = accumulateSessionUsage([
        assistant('claude-opus-5', { input_tokens: 1_000_000, output_tokens: 1_000_000 }),
      ])
      const report = renderPartsEnglish(formatCostReport(byModel))
      expect(report).toContain('$30.00') // 1M in * $5 + 1M out * $25
      expect(report).toContain('Estimated cost (priced models): $30.00')
      expect(report).not.toContain('pricing unavailable')
    })

    it('handles an empty session', () => {
      expect(renderPartsEnglish(formatCostReport(new Map()))).toBe(
        'No model usage recorded in this session yet.',
      )
    })

    it('returns translatable parts, not a pre-rendered string', () => {
      // Guards against a builder silently reverting to a plain English
      // string — every assertion above would still pass (renderPartsEnglish
      // renders either shape identically), but the webview would then show
      // English in every locale.
      const byModel = accumulateSessionUsage([
        assistant('claude-sonnet-4-6', { input_tokens: 100, output_tokens: 50 }),
      ])
      const parts = formatCostReport(byModel)
      expect(Array.isArray(parts)).toBe(true)
      expect(parts.some(part => 'key' in part && part.key === 'slash.out.cost.header')).toBe(true)
      expect(formatCostReport(new Map()).some(part => 'key' in part)).toBe(true)
    })
  })
})
