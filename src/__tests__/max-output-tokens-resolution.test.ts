import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  contextWindowOf,
  getDefaultMaxOutputTokensForModel,
  outputBudgetOf,
} from '../engine/contextWindow'
import { installBuiltinCatalogFigures } from './_helpers/builtinCatalogFigures'
import { resetCatalogFigures } from '../config/nexusModelConfig/catalogFigures'

// Built-in rows read the context window / output cap / image input they
// leave unset from the model catalog: install the runtime's figures, as
// after its first catalog read (catalog/builtinCatalogFill.ts).
beforeAll(installBuiltinCatalogFigures)
afterAll(resetCatalogFigures)

describe('per-model output-token resolution', () => {
  describe('getDefaultMaxOutputTokensForModel — initial-request reservation', () => {
    it('returns 32_000 for Claude Haiku 4.5', () => {
      expect(
        getDefaultMaxOutputTokensForModel('claude-haiku-4-5', 'anthropic'),
      ).toBe(32_000)
    })

    it('returns 32_000 for Claude Sonnet 5', () => {
      expect(
        getDefaultMaxOutputTokensForModel('claude-sonnet-5', 'anthropic'),
      ).toBe(32_000)
    })

    it('returns 64_000 for Claude Fable 5 (Opus-tier default)', () => {
      expect(
        getDefaultMaxOutputTokensForModel('claude-fable-5', 'anthropic'),
      ).toBe(64_000)
    })

    it('returns 64_000 for Claude Fable 5.1 (same tier as Fable 5)', () => {
      expect(
        getDefaultMaxOutputTokensForModel('claude-fable-5-1', 'anthropic'),
      ).toBe(64_000)
    })

    it('returns 32_000 for Gemini 3.1 Pro', () => {
      expect(
        getDefaultMaxOutputTokensForModel('gemini-3.1-pro-preview', 'google'),
      ).toBe(32_000)
    })

    it('returns 32_000 for GPT-5.6 family', () => {
      expect(
        getDefaultMaxOutputTokensForModel('gpt-6-astra', 'openai'),
      ).toBe(32_000)
      expect(
        getDefaultMaxOutputTokensForModel('gpt-5.6-terra', 'openai'),
      ).toBe(32_000)
    })

    it('returns 32_000 for GPT-5.6 Luna', () => {
      // Luna is the OpenAI lineup's `fastModel`, the slot
      // gpt-5.4-mini used to hold.
      expect(
        getDefaultMaxOutputTokensForModel('gpt-5.6-luna', 'openai'),
      ).toBe(32_000)
    })

    it('GPT-5.4 Mini: back on the OpenAI lineup, still off chatgpt-pro', () => {
      // gpt-5.4-mini left the OpenAI lineup and the chatgpt-pro
      // lineup; it came back to the OpenAI lineup
      // only, as the `gpt-*-mini` family row. Under chatgpt-pro it still
      // resolves to nothing. Asserted rather than merely dropped, so a
      // silent re-add cannot go unnoticed — a half-retired model (curated
      // under one provider, not the other) is what left sessions pinned to an
      // id the composer send gate then refused to send.
      expect(
        getDefaultMaxOutputTokensForModel('gpt-5.4-mini', 'chatgpt-pro'),
      ).toBeUndefined()
      expect(
        getDefaultMaxOutputTokensForModel('gpt-5.4-mini', 'openai'),
      ).toBe(32_000)
    })

    it('returns 64_000 for Kimi K3 (top-tier default, thinking always on)', () => {
      // K3 is the kimi provider's balanced tier and always thinks with
      // `reasoning_effort: max`, so reasoning is billed out of the same
      // output envelope — it tracks the 64K Opus-tier default rather than
      // the 32K one. See providers/kimi/config.ts.
      expect(getDefaultMaxOutputTokensForModel('k3', 'kimi')).toBe(64_000)
    })

    it('returns 64_000 for the Kimi K3.1 Pro rows (thinking cannot be turned off)', () => {
      expect(getDefaultMaxOutputTokensForModel('k3.1-pro', 'kimi')).toBe(64_000)
      expect(getDefaultMaxOutputTokensForModel('k3.1-pro-highspeed', 'kimi')).toBe(64_000)
    })

    it('leaves the K2.7 Code rows at 32_000 — no published ceiling', () => {
      // The Kimi Code docs publish output ceilings for neither K2.7 row, so
      // the 131_072 figure taken from the K3 platform quickstart must NOT
      // have leaked onto them.
      expect(
        getDefaultMaxOutputTokensForModel('kimi-for-coding', 'kimi'),
      ).toBe(32_000)
      expect(
        getDefaultMaxOutputTokensForModel('kimi-for-coding-highspeed', 'kimi'),
      ).toBe(32_000)
    })

    it('returns undefined for an uncatalogued model so callers can fall back', () => {
      expect(
        getDefaultMaxOutputTokensForModel('definitely-not-a-real-model'),
      ).toBeUndefined()
    })

    it('returns undefined when modelId is undefined', () => {
      expect(getDefaultMaxOutputTokensForModel(undefined)).toBeUndefined()
    })
  })

  describe('getMaxOutputTokensForModel — recovery escalation target', () => {
    it('returns 64_000 for Claude Haiku 4.5 (vendor max)', () => {
      expect(outputBudgetOf('claude-haiku-4-5', 'anthropic')).toBe(
        64_000,
      )
    })

    it('returns 128_000 for Claude Sonnet 5 (vendor max)', () => {
      expect(outputBudgetOf('claude-sonnet-5', 'anthropic')).toBe(
        128_000,
      )
    })

    it('returns 128_000 for Claude Fable 5', () => {
      expect(outputBudgetOf('claude-fable-5', 'anthropic')).toBe(
        128_000,
      )
    })

    it('returns 128_000 for Claude Fable 5.1', () => {
      expect(outputBudgetOf('claude-fable-5-1', 'anthropic')).toBe(
        128_000,
      )
    })

    it('returns 65_536 for Gemini 3.1 Pro (corrected from 65_535)', () => {
      expect(
        outputBudgetOf('gemini-3.1-pro-preview', 'google'),
      ).toBe(65_536)
    })

    it('returns 131_072 for Kimi K3 (platform quickstart default ceiling)', () => {
      // https://platform.kimi.ai/docs/guide/kimi-k3-quickstart, verified
      // "`max_completion_tokens` defaults to 131072 and can be
      // set up to 1048576". We escalate to the vendor DEFAULT, not the hard
      // maximum — see the rationale block in providers/kimi/config.ts.
      expect(outputBudgetOf('k3', 'kimi')).toBe(131_072)
    })

    it('reads the same 131_072 ceiling for the K3.1 Pro rows from the catalog', () => {
      expect(outputBudgetOf('k3.1-pro', 'kimi')).toBe(131_072)
      expect(outputBudgetOf('k3.1-pro-highspeed', 'kimi')).toBe(131_072)
    })

    it('keeps the K3 ceiling well under its own context window', () => {
      // The documented 1,048,576 hard max is exactly K3's context window, so
      // escalating there would reserve the entire window for output and
      // leave nothing for the prompt. Guards against a later "just use the
      // vendor max" edit.
      const ceiling = outputBudgetOf('k3', 'kimi')
      const window = contextWindowOf('k3', 'kimi')
      expect(ceiling).toBeDefined()
      expect(ceiling!).toBeLessThan(window / 2)
    })

    it('leaves the K2.7 Code ceilings at 32_000 — no published ceiling', () => {
      expect(outputBudgetOf('kimi-for-coding', 'kimi')).toBe(
        32_000,
      )
      expect(
        outputBudgetOf('kimi-for-coding-highspeed', 'kimi'),
      ).toBe(32_000)
    })
  })

  describe('default ≤ upperLimit invariant', () => {
    // Any model that has BOTH defaults must keep default ≤ upperLimit, or the
    // recovery branch in engine/turnLoop.ts would never have somewhere to escalate to.
    const PAIRS: Array<[string, string]> = [
      ['anthropic', 'claude-fable-5-1'],
      ['anthropic', 'claude-fable-5'],
      ['anthropic', 'claude-sonnet-5'],
      ['anthropic', 'claude-haiku-4-5'],
      ['openai', 'gpt-6-astra'],
      ['openai', 'gpt-6-luna'],
      ['openai', 'gpt-5.6-terra'],
      ['openai', 'gpt-5.6-luna'],
      ['chatgpt-pro', 'gpt-6-astra'],
      ['chatgpt-pro', 'gpt-5.6-terra'],
      ['google', 'gemini-3.1-pro-preview'],
      ['qwen', 'qwen3.8-max'],
      ['qwen', 'qwen3.6-flash'],
      ['kimi', 'k3'],
      ['kimi', 'k3.1-pro'],
      ['kimi', 'k3.1-pro-highspeed'],
      ['kimi', 'kimi-for-coding'],
      ['kimi', 'kimi-for-coding-highspeed'],
      ['glm', 'glm-4.6'],
      ['ollama', 'gpt-oss'],
    ]
    for (const [providerId, modelId] of PAIRS) {
      it(`${providerId}/${modelId}: default ≤ upperLimit`, () => {
        const def = getDefaultMaxOutputTokensForModel(modelId, providerId)
        const upper = outputBudgetOf(modelId, providerId)
        expect(def).toBeDefined()
        expect(upper).toBeDefined()
        expect(def!).toBeLessThanOrEqual(upper!)
      })
    }
  })
})
