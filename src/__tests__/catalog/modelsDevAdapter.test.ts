import { describe, expect, it } from 'vitest'
import { adaptDocument, adaptModel, adaptReasoningEfforts } from '../../catalog/modelsDevAdapter'
import sample from './fixtures/models-dev-sample.json'

describe('modelsDevAdapter', () => {
  describe('regression sample (trimmed from the real document)', () => {
    const out = adaptDocument(sample)!

    it('keeps the providers and drops nothing usable', () => {
      expect(Object.keys(out).sort()).toEqual(['anthropic', 'deepseek', 'opencode', 'opencode-go', 'xiaomi', 'zai'])
      expect(Object.keys(out.opencode).length).toBe(Object.keys(sample.opencode.models).length)
    })

    it('marks a zero-priced model free and keeps its limits', () => {
      const m = out.opencode['ling-3.0-flash-fin-free']
      expect(m.free).toBe(true)
      expect(m.contextWindow).toBe(262144)
      expect(m.maxOutput).toBe(32768)
      expect(m.cost).toEqual({ input: 0, output: 0, cacheRead: 0 })
    })

    it('does not call a priced model free and drops tiered prices', () => {
      const m = out.opencode['gpt-5.4']
      expect(m.free).toBe(false)
      expect(m.cost).toEqual({ input: 2.5, output: 15, cacheRead: 0.25 })
      expect(m.maxInput).toBe(922000)
      expect(JSON.stringify(m)).not.toContain('tiers')
    })

    it('carries status, the reasoning field and the per-model api marker', () => {
      expect(out.opencode['qwen3.6-plus-free']).toMatchObject({
        status: 'deprecated',
        free: true,
        npm: '@ai-sdk/anthropic',
      })
      expect(out.opencode['mimo-v2-pro-free'].interleavedField).toBe('reasoning_content')
      // No marker on the model: the provider's marker applies.
      expect(out.opencode['ling-3.0-flash-fin-free'].npm).toBe('@ai-sdk/openai-compatible')
    })

    it('reads the opencode-go provider too', () => {
      expect(out['opencode-go']['longcat-2.5-preview-free'].free).toBe(true)
      expect(out['opencode-go']['mimo-v2.6-pro'].free).toBe(false)
    })
  })

  describe('reasoningEfforts', () => {
    const out = adaptDocument(sample)!

    it('reads the real option-object spelling', () => {
      expect(out.opencode['gpt-5.4'].reasoningEfforts).toEqual(['none', 'low', 'medium', 'high', 'xhigh'])
      expect(out.deepseek['deepseek-flash'].reasoningEfforts).toEqual(['low', 'high', 'max'])
    })

    it('leaves toggles and token budgets out', () => {
      expect(out.opencode['ling-3.0-flash-fin-free'].reasoningEfforts).toBeUndefined()
      expect(out.opencode['claude-haiku-4-5'].reasoningEfforts).toBeUndefined()
      expect(out.opencode['qwen3.6-plus-free'].reasoningEfforts).toBeUndefined()
    })

    it('reads a plain list, lower-cased, in source order', () => {
      expect(adaptReasoningEfforts(['Low', 'HIGH', ' medium '])).toEqual(['low', 'high', 'medium'])
    })

    it('reads objects holding efforts/levels/values/options/effort lists', () => {
      for (const key of ['efforts', 'levels', 'values', 'options', 'effort']) {
        expect(adaptReasoningEfforts({ [key]: ['low', 'high'] })).toEqual(['low', 'high'])
      }
    })

    it('reads items that are objects with effort/id/value/name', () => {
      expect(
        adaptReasoningEfforts([{ effort: 'Low' }, { id: 'mid' }, { value: 'high' }, { name: 'MAX' }]),
      ).toEqual(['low', 'mid', 'high', 'max'])
      expect(adaptReasoningEfforts({ options: [{ effort: 'low' }, { effort: 'high' }] })).toEqual(['low', 'high'])
    })

    it('is absent for an unknown shape', () => {
      for (const bad of [undefined, null, 5, true, {}, [], [{ type: 'toggle' }], { foo: 'bar' }, [1, 2]]) {
        expect(adaptReasoningEfforts(bad)).toBeUndefined()
      }
      expect(adaptModel('x', { reasoning_options: { a: 1 } })!).not.toHaveProperty('reasoningEfforts')
    })
  })

  describe('missing fields', () => {
    it('leaves absent fields absent and never defaults them', () => {
      expect(adaptModel('x', {})).toEqual({ name: 'x', inputModalities: [], free: false })
    })

    it('ignores wrongly typed or non-positive values', () => {
      const m = adaptModel('x', {
        name: 7,
        limit: { context: '1000', output: -5, input: 0 },
        tool_call: 'yes',
        reasoning: 1,
        modalities: { input: ['text', 3, ''] },
        status: '',
      })
      expect(m).toEqual({ name: 'x', inputModalities: ['text'], free: false })
    })

    it('is not free without a cost, or with only part of one', () => {
      expect(adaptModel('x', { cost: {} })!.free).toBe(false)
      expect(adaptModel('x', { cost: { input: 0 } })!.free).toBe(false)
      expect(adaptModel('x', { cost: { input: 0, output: 0.1 } })!.free).toBe(false)
      expect(adaptModel('x', { cost: { input: 0, output: 0 } })!.free).toBe(true)
    })

    it('rejects a model entry that is not an object', () => {
      expect(adaptModel('x', null)).toBeUndefined()
      expect(adaptModel('x', 'nope')).toBeUndefined()
      expect(adaptModel('x', [])).toBeUndefined()
    })
  })

  describe('bad documents', () => {
    it('answers undefined for something that is not an object', () => {
      for (const bad of [null, 5, 'x', [], undefined]) expect(adaptDocument(bad)).toBeUndefined()
    })

    it('skips providers without usable models', () => {
      const out = adaptDocument({
        a: { models: {} },
        b: 'nope',
        c: { models: 'nope' },
        d: { models: { m: null } },
        e: { models: { m: { name: 'M' } } },
      })
      expect(Object.keys(out!)).toEqual(['e'])
    })

    it('does not reference the input', () => {
      const doc = { p: { models: { m: { modalities: { input: ['text'] } } } } }
      const out = adaptDocument(doc)!
      expect(out.p.m.inputModalities).not.toBe(doc.p.models.m.modalities.input)
    })
  })
})
