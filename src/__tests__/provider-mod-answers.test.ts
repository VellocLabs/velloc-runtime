/**
 * Provider mods (PM-4a) — reading what a provider module answers to
 * `provider.models`, `provider.verify` and `provider.usage`: every drop rule.
 */
import { describe, expect, it } from 'vitest'
import {
  USAGE_MAX_AMOUNTS,
  USAGE_MAX_WINDOWS,
  VERIFY_MESSAGE_MAX_LENGTH,
  parseUsageAnswer,
  parseVerifyAnswer,
} from '../mods/provider/providerAnswers'
import {
  MODELS_ANSWER_MAX_ROWS,
  MODEL_FIGURE_MAX,
  MODEL_ID_MAX_LENGTH,
  MODEL_NAME_MAX_LENGTH,
  parseModelsAnswer,
} from '../mods/provider/providerModelsAnswer'

const P = 'mod.acme.zen'
const BASE = 'https://api.acme.example/v1'
const parse = (answer: unknown) => parseModelsAnswer(P, answer, BASE)

describe('provider.models — the answer', () => {
  it('a non-array answer is a failure, not an empty listing', () => {
    for (const bad of [undefined, null, 'models', 3, {}, { models: [] }]) {
      expect(() => parse(bad)).toThrow(/not a list of models/)
    }
  })

  it('an empty array is an empty listing (the caller keeps its cache)', () => {
    expect(parse([])).toEqual({ models: [], dropped: 0, reasons: [] })
  })

  it('keeps a full row as stated', () => {
    const row = {
      id: 'big-pickle',
      name: 'Big Pickle',
      contextWindow: 200_000,
      maxOutputTokens: 32_000,
      supportsTools: true,
      supportsImageInput: true,
      supportsPdfInput: false,
      thinkingTiers: ['low', 'high'],
      defaultThinkingTier: 'low',
      thinkingTierLabels: { low: 'Quick', high: { en: 'Deep', 'zh-CN': '深' } },
      family: 'big-pickle',
      version: '2.5',
      free: true,
      price: { input: 0, output: 0 },
      wire: { format: 'openai-chat', path: '/chat', compat: { developerRole: true } },
    }
    const { models, dropped } = parse([row])
    expect(dropped).toBe(0)
    expect(models).toEqual([row])
  })

  it('drops (and counts) a row with no usable id, a repeated id, or no boolean supportsTools', () => {
    const { models, dropped, reasons } = parse([
      { id: 'a', supportsTools: true },
      { supportsTools: true },
      { id: '   ', supportsTools: true },
      { id: 7, supportsTools: true },
      { id: 'x'.repeat(MODEL_ID_MAX_LENGTH + 1), supportsTools: true },
      { id: 'a', supportsTools: true, name: 'second' },
      { id: 'b' },
      { id: 'c', supportsTools: 'yes' },
      'nope',
      null,
      ['a'],
      { id: 'd', supportsTools: false },
    ])
    expect(models.map(m => m.id)).toEqual(['a', 'd'])
    expect(models[0]).toEqual({ id: 'a', supportsTools: true })
    expect(dropped).toBe(10)
    expect(reasons.length).toBeGreaterThanOrEqual(4)
  })

  it('trims an id and a name', () => {
    expect(parse([{ id: '  m  ', name: '  M  ', supportsTools: true }]).models).toEqual([
      { id: 'm', name: 'M', supportsTools: true },
    ])
  })

  it('caps the rows: the rest are dropped and counted', () => {
    const answer = Array.from({ length: MODELS_ANSWER_MAX_ROWS + 3 }, (_, i) => ({ id: `m${i}`, supportsTools: true }))
    const { models, dropped } = parse(answer)
    expect(models).toHaveLength(MODELS_ANSWER_MAX_ROWS)
    expect(dropped).toBe(3)
  })

  it('leaves out a malformed field and keeps the row', () => {
    const { models, dropped } = parse([
      {
        id: 'm',
        supportsTools: true,
        name: 'n'.repeat(MODEL_NAME_MAX_LENGTH + 1),
        contextWindow: -1,
        maxOutputTokens: 1.5e0 * MODEL_FIGURE_MAX,
        supportsImageInput: 'true',
        supportsPdfInput: 1,
        family: '',
        version: 4,
        free: 'free',
        price: { input: -1, output: 2 },
        wire: 'openai',
      },
    ])
    expect(dropped).toBe(0)
    expect(models).toEqual([{ id: 'm', supportsTools: true }])
  })

  it('reads a figure as a whole number, and ignores NaN, Infinity and zero', () => {
    const { models } = parse([
      { id: 'a', supportsTools: true, contextWindow: 128000.9, maxOutputTokens: 0 },
      { id: 'b', supportsTools: true, contextWindow: Number.NaN, maxOutputTokens: Number.POSITIVE_INFINITY },
    ])
    expect(models[0]).toEqual({ id: 'a', supportsTools: true, contextWindow: 128000 })
    expect(models[1]).toEqual({ id: 'b', supportsTools: true })
  })

  it('keeps only the runtime tier vocabulary, in its order; an unknown tier is dropped', () => {
    const { models } = parse([
      { id: 'm', supportsTools: true, thinkingTiers: ['high', 'xhigh', 'low', 'turbo', 7, 'high', 'extra-high', 'none'], defaultThinkingTier: 'high' },
    ])
    expect(models[0]!.thinkingTiers).toEqual(['none', 'low', 'high', 'extra-high'])
    expect(models[0]!.defaultThinkingTier).toBe('high')
  })

  it('a model with no known tier has no tier fields at all', () => {
    const { models } = parse([
      { id: 'm', supportsTools: true, thinkingTiers: ['xhigh', 'budget'], defaultThinkingTier: 'xhigh', thinkingTierLabels: { xhigh: 'X' } },
      { id: 'n', supportsTools: true, thinkingTiers: 'high', defaultThinkingTier: 'high' },
    ])
    expect(models[0]).toEqual({ id: 'm', supportsTools: true })
    expect(models[1]).toEqual({ id: 'n', supportsTools: true })
  })

  it('a default tier the model does not offer is left out; labels only for offered tiers', () => {
    const { models } = parse([
      {
        id: 'm',
        supportsTools: true,
        thinkingTiers: ['low', 'high'],
        defaultThinkingTier: 'max',
        thinkingTierLabels: { low: 'Quick', max: 'Everything', high: '', medium: 'Mid', bogus: 'B' },
      },
    ])
    expect(models[0]!.defaultThinkingTier).toBeUndefined()
    expect(models[0]!.thinkingTierLabels).toEqual({ low: 'Quick' })
  })

  it('holds a wire to the provider: another origin loses its baseUrl, the rest stays', () => {
    const { models } = parse([
      { id: 'a', supportsTools: true, wire: { format: 'anthropic-messages', baseUrl: 'https://evil.example/v1', path: '/messages' } },
      { id: 'b', supportsTools: true, wire: { baseUrl: 'https://api.acme.example/other' } },
      { id: 'c', supportsTools: true, wire: { path: '../up' } },
    ])
    expect(models[0]!.wire).toEqual({ format: 'anthropic-messages', path: '/messages' })
    expect(models[1]!.wire).toEqual({ baseUrl: 'https://api.acme.example/other' })
    expect(models[2]!.wire).toBeUndefined()
  })

  it('with no provider base URL a wire baseUrl cannot be vouched for', () => {
    const { models } = parseModelsAnswer(P, [{ id: 'a', supportsTools: true, wire: { baseUrl: BASE, path: '/p' } }], undefined)
    expect(models[0]!.wire).toEqual({ path: '/p' })
  })
})

describe('provider.verify — the answer', () => {
  it('reads ok', () => {
    expect(parseVerifyAnswer({ ok: true })).toEqual({ ok: true })
    expect(parseVerifyAnswer({ ok: true, message: 'ignored' })).toEqual({ ok: true })
  })

  it('reads a failure with the host vocabulary', () => {
    expect(parseVerifyAnswer({ ok: false, code: 'auth_forbidden', message: 'no', httpStatus: 403 })).toEqual({
      ok: false,
      code: 'auth_forbidden',
      message: 'no',
      httpStatus: 403,
    })
  })

  it('an unknown code is system_unexpected, a missing message is the code, a bad status is left out', () => {
    expect(parseVerifyAnswer({ ok: false, code: 'weird', httpStatus: 99 })).toEqual({
      ok: false,
      code: 'system_unexpected',
      message: 'system_unexpected',
    })
    expect(parseVerifyAnswer({ ok: false, code: 'network_timeout', message: '  ', httpStatus: 1.5 })).toEqual({
      ok: false,
      code: 'network_timeout',
      message: 'network_timeout',
    })
  })

  it('caps a message', () => {
    const answer = parseVerifyAnswer({ ok: false, message: 'm'.repeat(VERIFY_MESSAGE_MAX_LENGTH + 50) })
    expect(answer).toMatchObject({ ok: false })
    expect((answer as { message: string }).message).toHaveLength(VERIFY_MESSAGE_MAX_LENGTH)
  })

  it('anything that is not a result is undefined', () => {
    for (const bad of [undefined, null, 'ok', true, [], {}, { ok: 'yes' }, { code: 'auth_unauthorized' }]) {
      expect(parseVerifyAnswer(bad)).toBeUndefined()
    }
  })
})

describe('provider.usage — the answer', () => {
  it('reads windows and amounts', () => {
    expect(
      parseUsageAnswer({
        planName: ' Pro ',
        windows: [{ kind: 'five_hour', usedPercent: 40, resetsAt: 1_900_000_000_000, subject: 'free_requests' }],
        amounts: [{ kind: 'balance', amount: 12.5, currency: 'USD' }, { kind: 'spent', amount: 3, currency: 'USD', period: 'month' }],
        balanceNote: 'needs_key',
      }),
    ).toEqual({
      planName: 'Pro',
      windows: [{ kind: 'five_hour', usedPercent: 40, resetsAt: 1_900_000_000_000, subject: 'free_requests' }],
      amounts: [
        { kind: 'balance', amount: 12.5, currency: 'USD' },
        { kind: 'spent', amount: 3, currency: 'USD', period: 'month' },
      ],
      balanceNote: 'needs_key',
    })
  })

  it('clamps a share to 0-100 and drops a malformed window or amount', () => {
    const snapshot = parseUsageAnswer({
      windows: [
        { kind: 'daily', usedPercent: 140 },
        { kind: 'weekly', usedPercent: -5, resetsAt: -1 },
        { kind: 'hourly', usedPercent: 1 },
        { kind: 'monthly', usedPercent: '10' },
        { kind: 'monthly', usedPercent: Number.NaN },
        null,
      ],
      amounts: [
        { kind: 'available', amount: 1, currency: 'USD' },
        { kind: 'balance', amount: 1, currency: 'EUR' },
        { kind: 'balance', amount: Number.POSITIVE_INFINITY, currency: 'USD' },
        { kind: 'limit_remaining', amount: 0, currency: 'USD', period: 'decade' },
      ],
    })
    expect(snapshot).toEqual({
      windows: [
        { kind: 'daily', usedPercent: 100 },
        { kind: 'weekly', usedPercent: 0 },
      ],
      amounts: [{ kind: 'limit_remaining', amount: 0, currency: 'USD' }],
    })
  })

  it('caps the lists and the plan name', () => {
    const windows = Array.from({ length: USAGE_MAX_WINDOWS + 4 }, () => ({ kind: 'daily', usedPercent: 1 }))
    const amounts = Array.from({ length: USAGE_MAX_AMOUNTS + 4 }, () => ({ kind: 'balance', amount: 1, currency: 'USD' }))
    const snapshot = parseUsageAnswer({ planName: 'p'.repeat(500), windows, amounts })!
    expect(snapshot.windows).toHaveLength(USAGE_MAX_WINDOWS)
    expect(snapshot.amounts).toHaveLength(USAGE_MAX_AMOUNTS)
    expect(snapshot.planName).toBeUndefined()
  })

  it('nothing usable, or not an object, is no usage', () => {
    for (const bad of [undefined, null, 'x', [], {}, { windows: [] }, { windows: [{ kind: 'x', usedPercent: 1 }] }, { planName: 'Pro' }]) {
      expect(parseUsageAnswer(bad)).toBeUndefined()
    }
  })

  it('a balance note alone is a snapshot (the page explains the missing balance)', () => {
    expect(parseUsageAnswer({ balanceNote: 'unavailable' })).toEqual({ windows: [], balanceNote: 'unavailable' })
  })
})
