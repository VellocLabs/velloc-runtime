import { describe, expect, it } from 'vitest'
import { modelFactsFor, withModelFacts } from '../config/nexusModelConfig/modelFacts'
import { BUILTIN_PROVIDER_DEFINITIONS } from '../config/nexusModelConfig/providers'
import { checkPluginDescriptor } from '../pluginHost/manifestValidator'
import { checkModelFacts, MODEL_FACTS_MAX_ENTRIES } from '../mods/provider/providerModelFacts'

/** A manifest's `modelFacts`: what is accepted, what refuses the provider, what is clamped, which entry answers. */

function check(value: unknown): { facts: ReturnType<typeof checkModelFacts>; problems: string[] } {
  const problems: string[] = []
  const facts = checkModelFacts(value, message => problems.push(message))
  return { facts, problems }
}

function descriptor(modelFacts: unknown): ReturnType<typeof checkPluginDescriptor> {
  return checkPluginDescriptor({
    name: 'acme',
    version: '1.0.0',
    providers: {
      main: {
        providerApi: 1,
        displayName: { en: 'Acme' },
        defaultBaseUrl: 'https://api.acme.example/v1',
        domains: ['api.acme.example'],
        format: BUILTIN_PROVIDER_DEFINITIONS.find(d => d.config.wire)!.config.wire!.format,
        credentials: { methods: ['apiKey'] },
        module: './providers/main.js',
        ...(modelFacts === undefined ? {} : { modelFacts }),
      },
    },
  })
}

describe('modelFacts — what a manifest may state', () => {
  it('keeps every known field, the tiers in the runtime order', () => {
    const { facts, problems } = check({
      'wide-5.3': {
        contextWindow: 300000.9,
        maxOutputTokens: 64000,
        defaultMaxOutputTokens: 48000,
        thinkingTiers: ['high', 'low', 'high'],
        defaultThinkingTier: 'low',
        supportsImageInput: false,
        supportsPdfInput: true,
      },
      'wide-5.*': { contextWindow: 200000 },
      '*': {},
    })
    expect(problems).toEqual([])
    expect(facts).toEqual({
      'wide-5.3': {
        contextWindow: 300000,
        maxOutputTokens: 64000,
        defaultMaxOutputTokens: 48000,
        thinkingTiers: ['low', 'high'],
        defaultThinkingTier: 'low',
        supportsImageInput: false,
        supportsPdfInput: true,
      },
      'wide-5.*': { contextWindow: 200000 },
      '*': {},
    })
  })

  it('reaches the provider manifest, and an absent or empty block leaves no key', () => {
    const stated = descriptor({ 'wide-*': { contextWindow: 200000 } })
    expect(stated.errors).toEqual([])
    expect(stated.manifest!.providers!.main!.modelFacts).toEqual({ 'wide-*': { contextWindow: 200000 } })
    expect('modelFacts' in descriptor(undefined).manifest!.providers!.main!).toBe(false)
    expect('modelFacts' in descriptor({}).manifest!.providers!.main!).toBe(false)
  })

  it('clamps: a window to the platform bound, an output cap to its window, a first-request cap to the output cap', () => {
    const { facts, problems } = check({
      a: { contextWindow: 5e9 },
      b: { contextWindow: 100000, maxOutputTokens: 400000, defaultMaxOutputTokens: 300000 },
      c: { maxOutputTokens: 32000, defaultMaxOutputTokens: 64000 },
      d: { contextWindow: 8000, defaultMaxOutputTokens: 64000 },
    })
    expect(problems).toEqual([])
    expect(facts).toEqual({
      a: { contextWindow: 1_000_000_000 },
      b: { contextWindow: 100000, maxOutputTokens: 100000, defaultMaxOutputTokens: 100000 },
      c: { maxOutputTokens: 32000, defaultMaxOutputTokens: 32000 },
      d: { contextWindow: 8000, defaultMaxOutputTokens: 8000 },
    })
  })
})

describe('modelFacts — what refuses the provider', () => {
  const refused: Array<[name: string, value: unknown, names: string]> = [
    ['a block that is not an object', ['wide'], 'modelFacts: expected an object'],
    ['an entry that is not an object', { wide: 200000 }, 'modelFacts["wide"]: expected an object'],
    ['an unknown field', { wide: { contextWindows: 200000 } }, 'modelFacts["wide"].contextWindows: unknown property'],
    ['supportsTools', { wide: { supportsTools: true } }, 'modelFacts["wide"].supportsTools: cannot be stated here'],
    ['a figure as text', { wide: { contextWindow: '200000' } }, 'modelFacts["wide"].contextWindow: expected a number'],
    ['a zero figure', { wide: { maxOutputTokens: 0 } }, 'modelFacts["wide"].maxOutputTokens: expected a number'],
    ['a NaN figure', { wide: { defaultMaxOutputTokens: Number.NaN } }, 'modelFacts["wide"].defaultMaxOutputTokens: expected a number'],
    ['a flag as text', { wide: { supportsImageInput: 'no' } }, 'modelFacts["wide"].supportsImageInput: expected true or false'],
    ['a flag as a number', { wide: { supportsPdfInput: 1 } }, 'modelFacts["wide"].supportsPdfInput: expected true or false'],
    ['tiers that are not a list', { wide: { thinkingTiers: 'high' } }, 'modelFacts["wide"].thinkingTiers: expected a list'],
    ['an empty tier list', { wide: { thinkingTiers: [] } }, 'modelFacts["wide"].thinkingTiers: expected a list'],
    ['a tier outside the vocabulary', { wide: { thinkingTiers: ['low', 'ultra'] } }, 'modelFacts["wide"].thinkingTiers: "ultra" is not'],
    ['a default tier without tiers', { wide: { defaultThinkingTier: 'low' } }, 'modelFacts["wide"].defaultThinkingTier: needs thinkingTiers'],
    ['a default tier the entry does not offer', { wide: { thinkingTiers: ['low'], defaultThinkingTier: 'high' } }, 'modelFacts["wide"].defaultThinkingTier: "high" is not one of'],
    ['a default tier that is not text', { wide: { thinkingTiers: ['low'], defaultThinkingTier: 1 } }, 'modelFacts["wide"].defaultThinkingTier: expected a tier name'],
    ['a mark inside a key', { 'wide-*-air': {} }, 'modelFacts["wide-*-air"]: "*" may only end a key'],
    ['two marks', { 'wide-**': {} }, 'modelFacts["wide-**"]: "*" may only end a key'],
    ['an empty key', { '': {} }, 'modelFacts[""]: a key must be'],
    ['white space in a key', { 'wide 5': {} }, 'modelFacts["wide 5"]: a key cannot hold white space'],
  ]

  for (const [name, value, names] of refused) {
    it(`${name}: named, and nothing is kept`, () => {
      const { facts, problems } = check(value)
      expect(facts).toBeUndefined()
      expect(problems.some(problem => problem.startsWith(names))).toBe(true)
    })
  }

  it('one bad entry among good ones refuses the whole block', () => {
    const { facts, problems } = check({ good: { contextWindow: 200000 }, bad: { window: 1 } })
    expect(facts).toBeUndefined()
    expect(problems).toHaveLength(1)
  })

  it('more entries than the bound', () => {
    const many = Object.fromEntries(Array.from({ length: MODEL_FACTS_MAX_ENTRIES + 1 }, (_, i) => [`m-${i}`, {}]))
    expect(check(many).facts).toBeUndefined()
  })

  it('the provider is left out of the manifest, and the error carries its path', () => {
    const { manifest, errors } = descriptor({ wide: { contextWindow: 200000, supportsTools: true } })
    expect(manifest?.providers?.main).toBeUndefined()
    expect(errors.some(error => error.includes('providers.main.modelFacts["wide"].supportsTools'))).toBe(true)
  })
})

describe('modelFacts — which entry answers', () => {
  const facts = {
    'wide-*': { contextWindow: 100000 },
    'wide-5.*': { contextWindow: 250000 },
    'wide-5.3': { maxOutputTokens: 64000 },
  }

  it('the exact id, else the longest prefix, else none', () => {
    expect(modelFactsFor(facts, 'wide-5.3')).toBe(facts['wide-5.3'])
    expect(modelFactsFor(facts, 'wide-5.30')).toBe(facts['wide-5.*'])
    expect(modelFactsFor(facts, 'wide-4')).toBe(facts['wide-*'])
    expect(modelFactsFor(facts, 'WIDE-4')).toBeUndefined()
    expect(modelFactsFor(undefined, 'wide-4')).toBeUndefined()
  })

  it('entries are not merged: what the answering entry leaves out is not taken from a prefix', () => {
    const row = withModelFacts({ id: 'wide-5.3', supportsTools: true }, modelFactsFor(facts, 'wide-5.3'))
    expect(row).toEqual({ id: 'wide-5.3', supportsTools: true, maxOutputTokens: 64000 })
  })

  it('a row keeps its own default tier beside its own tiers, and is returned as is when nothing is filled', () => {
    const stated = { id: 'm', supportsTools: true, contextWindow: 1000, thinkingTiers: ['low', 'high'] }
    const entry = { contextWindow: 9000, thinkingTiers: ['medium'], defaultThinkingTier: 'medium' }
    expect(withModelFacts(stated, entry)).toBe(stated)
    expect(withModelFacts({ id: 'm', supportsTools: false }, { supportsPdfInput: true })).toEqual({
      id: 'm',
      supportsTools: false,
      supportsPdfInput: true,
    })
  })
})
