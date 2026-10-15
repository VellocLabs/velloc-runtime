import { afterEach, describe, expect, it } from 'vitest'
import {
  clearPinFailures,
  getPinFailureHealth,
  recordPinCandidateFailure,
  resetPinFailureLog,
} from '../models/pinFailureLog'
import {
  resetSessionModelSettingsSnapshot,
  setSessionModelSettingsSnapshot,
} from '../models/tierSettingsSnapshot'

/**
 * Pin health — the runtime failure log behind the Settings page's "this
 * pinned model has been failing" note. Attribution is by candidate-match
 * against the CURRENT settings snapshot: only user-named pins are marked,
 * never ladder/census models.
 */

afterEach(() => {
  resetPinFailureLog()
  resetSessionModelSettingsSnapshot()
})

describe('recordPinCandidateFailure', () => {
  it('marks every pin naming the failed pair — dictionary slots AND specific policies', () => {
    setSessionModelSettingsSnapshot({
      modelTiers: {
        fast: { providerId: 'deepseek', modelId: 'ds-flash' },
        best: { providerId: 'anthropic', modelId: 'claude-fable-5' },
      },
      sessionModelPolicy: {
        compact: { mode: 'specific', providerId: 'deepseek', modelId: 'ds-flash' },
        session_title: { mode: 'tier', tier: 'fast' }, // tier mode: never marked
      },
    })
    const marked = recordPinCandidateFailure(
      { providerId: 'deepseek', modelId: 'ds-flash' },
      'invalid api key',
      1_000,
    )
    // The broken thing is the MODEL — every pin pointing at it is marked.
    expect(marked).toBe(2)
    const health = getPinFailureHealth()
    expect(health.modelTiers.fast).toMatchObject({
      count: 1,
      lastAt: 1_000,
      lastError: 'invalid api key',
      providerId: 'deepseek',
      modelId: 'ds-flash',
    })
    expect(health.sessionModelPolicy.compact).toMatchObject({ count: 1 })
    // Unrelated pins untouched.
    expect(health.modelTiers.best).toBeUndefined()
    expect(health.sessionModelPolicy.session_title).toBeUndefined()
  })

  it('records nothing for ladder/census models the user never pinned', () => {
    setSessionModelSettingsSnapshot({
      modelTiers: { fast: { providerId: 'deepseek', modelId: 'ds-flash' } },
    })
    const marked = recordPinCandidateFailure(
      { providerId: 'anthropic', modelId: 'claude-haiku-4-5' }, // the LADDER fast model
      'overloaded',
    )
    expect(marked).toBe(0)
    expect(getPinFailureHealth()).toEqual({
      modelTiers: {},
      sessionModelPolicy: {},
    })
  })

  it('accumulates counts, keeps the LATEST error, and truncates long messages', () => {
    setSessionModelSettingsSnapshot({
      modelTiers: { balanced: { providerId: 'openai', modelId: 'gpt-tiny' } },
    })
    recordPinCandidateFailure(
      { providerId: 'openai', modelId: 'gpt-tiny' },
      'first failure',
      1,
    )
    recordPinCandidateFailure(
      { providerId: 'openai', modelId: 'gpt-tiny' },
      'x'.repeat(500),
      2,
    )
    const rec = getPinFailureHealth().modelTiers.balanced
    expect(rec?.count).toBe(2)
    expect(rec?.lastAt).toBe(2)
    expect(rec?.lastError.length).toBeLessThanOrEqual(301) // 300 + ellipsis
    expect(rec?.lastError.startsWith('xxx')).toBe(true)
  })
})

describe('clearPinFailures', () => {
  it('clears exactly the given keys (the adapter passes every patched key)', () => {
    setSessionModelSettingsSnapshot({
      modelTiers: {
        fast: { providerId: 'a', modelId: 'm1' },
        best: { providerId: 'a', modelId: 'm2' },
      },
      sessionModelPolicy: {
        compact: { mode: 'specific', providerId: 'a', modelId: 'm1' },
      },
    })
    recordPinCandidateFailure({ providerId: 'a', modelId: 'm1' }, 'e')
    recordPinCandidateFailure({ providerId: 'a', modelId: 'm2' }, 'e')
    clearPinFailures({ modelTiers: ['fast'], sessionModelPolicy: ['compact'] })
    const health = getPinFailureHealth()
    expect(health.modelTiers.fast).toBeUndefined()
    expect(health.sessionModelPolicy.compact).toBeUndefined()
    expect(health.modelTiers.best).toMatchObject({ count: 1 }) // untouched
  })
})
