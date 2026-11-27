/**
 * The provider health ledger (F-27): what each verdict records and for how
 * long, where it is recorded, what clears it, and that it outlives a restart.
 */
import { afterEach, describe, expect, it } from 'vitest'
import {
  BILLING_COOL_MS,
  clearProviderState,
  configureProviderHealthLedger,
  MODEL_UNAVAILABLE_MS,
  noteProviderConfigs,
  providerHealthLedgerSettled,
  providerStateOf,
  QUOTA_DAILY_SERVED,
  QUOTA_UNKNOWN_MS,
  RATE_LIMIT_FIRST_MS,
  RATE_LIMIT_MAX_MS,
  RATE_LIMIT_REPEAT_MS,
  recordProviderServed,
  recordProviderVerdict,
  resetProviderHealthLedger,
  retryProviderHealthLedgerLoad,
  TRANSIENT_COOL_MS,
  TRANSIENT_MAX_MS,
  UNCONFIRMED_CREDENTIALS_MS,
  type ProviderHealthStore,
} from '../models/drivers/providerHealthLedger'
import type { ProviderConnectivityIssue } from '../utils/providerConnectivity'

/** 2026-03-10T12:00:00Z: half a day from the next UTC midnight. */
const NOON = Date.UTC(2026, 2, 10, 12, 0, 0)
const NEXT_MIDNIGHT = Date.UTC(2026, 2, 11, 0, 0, 0)
const MIN = 60_000

function verdict(
  kind: ProviderConnectivityIssue['kind'],
  over: Partial<ProviderConnectivityIssue> = {},
): ProviderConnectivityIssue {
  return {
    kind,
    error: 'unknown',
    titleKey: 'x' as ProviderConnectivityIssue['titleKey'],
    summaryKey: 'x' as ProviderConnectivityIssue['summaryKey'],
    retryable: false,
    settingsRecommended: false,
    detail: '',
    scope: 'provider',
    ...over,
  }
}

function memoryStore(initial?: string): ProviderHealthStore & { text: string | undefined; writes: number } {
  const store = {
    text: initial,
    writes: 0,
    read: async () => store.text,
    write: async (text: string) => {
      store.text = text
      store.writes += 1
    },
  }
  return store
}

/** What an instance with no model held reads as. */
const NONE = { models: {} }

/** What is recorded about one model of an instance; `ok` when nothing is. */
function held(instanceId: string, nowMs: number, model = 'm1') {
  return providerStateOf(instanceId, nowMs).models[model] ?? { status: 'ok' as const }
}

afterEach(() => resetProviderHealthLedger())

describe('what a verdict records', () => {
  it('an instance nothing is recorded about holds no model', () => {
    expect(providerStateOf('acme', NOON)).toEqual(NONE)
  })

  it('rate_limit cools until the wait the verdict carries', () => {
    recordProviderVerdict('acme', 'm1', verdict('rate_limit', { retryAfterMs: 7_000 }), NOON)
    expect(held('acme', NOON)).toEqual({ status: 'cooling', until: NOON + 7_000, untilFrom: 'provider', reason: 'rate_limit' })
  })

  it('rate_limit with a reset time and no wait cools until that time', () => {
    recordProviderVerdict('acme', 'm1', verdict('rate_limit', { resetsAt: NOON + 90_000 }), NOON)
    expect(held('acme', NOON).until).toBe(NOON + 90_000)
  })

  it('an end the provider stated says so, and one the platform chose says that', () => {
    recordProviderVerdict('acme', 'stated', verdict('rate_limit', { resetsAt: NOON + 90_000 }), NOON)
    recordProviderVerdict('acme', 'chosen', verdict('rate_limit'), NOON)
    recordProviderVerdict('acme', 'guessed', verdict('quota'), NOON)
    expect(held('acme', NOON, 'stated').untilFrom).toBe('provider')
    expect(held('acme', NOON, 'chosen').untilFrom).toBe('platform')
    expect(held('acme', NOON, 'guessed').untilFrom).toBe('platform')
    recordProviderVerdict('acme', 'off', verdict('credentials', { scope: 'key', status: 401 }), NOON)
    expect(held('acme', NOON, 'off')).toEqual({ status: 'disabled', reason: 'credentials' })
  })

  it('rate_limit with no wait cools 60 s, doubles on a repeat within 10 minutes, and stops at 15 minutes', () => {
    let now = NOON
    const waits: number[] = []
    for (let i = 0; i < 6; i += 1) {
      recordProviderVerdict('acme', 'm1', verdict('rate_limit'), now)
      const until = held('acme', now).until!
      waits.push(until - now)
      // The next one arrives right after this cooldown ended.
      now = until + 1_000
    }
    expect(waits).toEqual([RATE_LIMIT_FIRST_MS, 2 * MIN, 4 * MIN, 8 * MIN, RATE_LIMIT_MAX_MS, RATE_LIMIT_MAX_MS])
  })

  it('a rate limit 10 minutes or more after the last cooldown ended starts at 60 s again', () => {
    recordProviderVerdict('acme', 'm1', verdict('rate_limit'), NOON)
    recordProviderVerdict('acme', 'm1', verdict('rate_limit'), NOON + 2 * MIN)
    expect(held('acme', NOON + 2 * MIN).until).toBe(NOON + 2 * MIN + 2 * MIN)
    const stillRepeat = NOON + 4 * MIN + RATE_LIMIT_REPEAT_MS - 1
    recordProviderVerdict('acme', 'm1', verdict('rate_limit'), stillRepeat)
    expect(held('acme', stillRepeat).until).toBe(stillRepeat + 4 * MIN)
    const later = stillRepeat + 4 * MIN + RATE_LIMIT_REPEAT_MS
    recordProviderVerdict('acme', 'm1', verdict('rate_limit'), later)
    expect(held('acme', later).until).toBe(later + RATE_LIMIT_FIRST_MS)
  })

  it('quota is exhausted until the reset time the verdict carries', () => {
    recordProviderVerdict('acme', 'm1', verdict('quota', { resetsAt: NOON + 5 * 60 * MIN }), NOON)
    expect(held('acme', NOON)).toEqual({ status: 'exhausted', until: NOON + 5 * 60 * MIN, untilFrom: 'provider', reason: 'quota' })
  })

  it('quota with no reset time is one hour when the day served fewer than 10 requests', () => {
    for (let i = 0; i < QUOTA_DAILY_SERVED - 1; i += 1) recordProviderServed('acme', NOON)
    recordProviderVerdict('acme', 'm1', verdict('quota'), NOON)
    expect(held('acme', NOON)).toEqual({ status: 'exhausted', until: NOON + QUOTA_UNKNOWN_MS, untilFrom: 'platform', reason: 'quota' })
  })

  it('quota with no reset time lasts to the next UTC midnight once the day served 10 requests', () => {
    for (let i = 0; i < QUOTA_DAILY_SERVED; i += 1) recordProviderServed('acme', NOON)
    recordProviderVerdict('acme', 'm1', verdict('quota'), NOON)
    expect(held('acme', NOON).until).toBe(NEXT_MIDNIGHT)
  })

  it('requests served on an earlier day do not count toward today', () => {
    for (let i = 0; i < QUOTA_DAILY_SERVED; i += 1) recordProviderServed('acme', NOON - 24 * 60 * MIN)
    recordProviderVerdict('acme', 'm1', verdict('quota'), NOON)
    expect(held('acme', NOON).until).toBe(NOON + QUOTA_UNKNOWN_MS)
  })

  it('billing cools 30 minutes', () => {
    recordProviderVerdict('acme', 'm1', verdict('billing', { scope: 'account' }), NOON)
    expect(held('acme', NOON)).toEqual({ status: 'cooling', until: NOON + BILLING_COOL_MS, untilFrom: 'platform', reason: 'billing' })
  })

  it('credentials disables the model with no end', () => {
    recordProviderVerdict('acme', 'm1', verdict('credentials', { scope: 'key', status: 401 }), NOON)
    expect(held('acme', NOON)).toEqual({ status: 'disabled', reason: 'credentials' })
    expect(held('acme', NOON + 365 * 24 * 60 * MIN)).toEqual({ status: 'disabled', reason: 'credentials' })
  })

  it('credentials no server answered cools the model for ten minutes instead of disabling it', () => {
    recordProviderVerdict('acme', 'm1', verdict('credentials', { scope: 'key' }), NOON)
    expect(held('acme', NOON)).toEqual({
      status: 'cooling',
      until: NOON + UNCONFIRMED_CREDENTIALS_MS,
      untilFrom: 'platform',
      reason: 'credentials',
    })
    expect(held('acme', NOON + UNCONFIRMED_CREDENTIALS_MS)).toEqual({ status: 'ok' })
  })

  it('a server refusal after an unconfirmed credentials verdict disables the model', () => {
    recordProviderVerdict('acme', 'm1', verdict('credentials'), NOON)
    recordProviderVerdict('acme', 'm1', verdict('credentials', { status: 403 }), NOON + MIN)
    expect(held('acme', NOON + 60 * MIN)).toEqual({ status: 'disabled', reason: 'credentials' })
  })

  it('model_unavailable holds that model for one hour', () => {
    recordProviderVerdict('acme', 'm1', verdict('model_unavailable', { scope: 'model' }), NOON)
    expect(providerStateOf('acme', NOON)).toEqual({
      models: { m1: { status: 'cooling', until: NOON + MODEL_UNAVAILABLE_MS, untilFrom: 'platform', reason: 'model_unavailable' } },
    })
  })

  it.each(['service', 'network'] as const)('%s cools 30 s', kind => {
    recordProviderVerdict('acme', 'm1', verdict(kind), NOON)
    expect(held('acme', NOON)).toEqual({ status: 'cooling', until: NOON + TRANSIENT_COOL_MS, untilFrom: 'platform', reason: kind })
  })

  it('a model that keeps failing with service errors waits longer each time, up to 5 min', () => {
    let at = NOON
    const waits: number[] = []
    for (let i = 0; i < 6; i += 1) {
      recordProviderVerdict('acme', 'm1', verdict('service'), at)
      const until = held('acme', at).until!
      waits.push(until - at)
      at = until + 10_000
    }
    expect(waits).toEqual([30_000, 60_000, 120_000, 240_000, TRANSIENT_MAX_MS, TRANSIENT_MAX_MS])
    // Quiet for longer than the repeat window: back to the shortest wait.
    const later = at + 3 * MIN
    recordProviderVerdict('acme', 'm1', verdict('service'), later)
    expect(held('acme', later).until).toBe(later + TRANSIENT_COOL_MS)
    // Another model of the same provider has a series of its own.
    recordProviderVerdict('acme', 'm2', verdict('network'), later)
    expect(providerStateOf('acme', later).models.m2?.until).toBe(later + TRANSIENT_COOL_MS)
  })

  it.each(['configuration', 'provider_policy'] as const)('%s records nothing', kind => {
    recordProviderVerdict('acme', 'm1', verdict(kind), NOON)
    expect(providerStateOf('acme', NOON)).toEqual(NONE)
  })
})

describe('where a verdict is recorded', () => {
  it('scope request records nothing', () => {
    recordProviderVerdict('acme', 'm1', verdict('rate_limit', { scope: 'request' }), NOON)
    recordProviderVerdict('acme', 'm1', verdict('credentials', { scope: 'request' }), NOON)
    expect(providerStateOf('acme', NOON)).toEqual(NONE)
  })

  it('scope model records under that model alone', () => {
    recordProviderVerdict('acme', 'm1', verdict('rate_limit', { scope: 'model', retryAfterMs: 5_000 }), NOON)
    expect(providerStateOf('acme', NOON)).toEqual({
      models: { m1: { status: 'cooling', until: NOON + 5_000, untilFrom: 'provider', reason: 'rate_limit' } },
    })
  })

  it('a verdict with no model named records nothing', () => {
    recordProviderVerdict('acme', '', verdict('rate_limit', { scope: 'model' }), NOON)
    recordProviderVerdict('acme', '', verdict('credentials', { scope: 'key', status: 401 }), NOON)
    expect(providerStateOf('acme', NOON)).toEqual(NONE)
  })

  it.each(['key', 'account', 'provider'] as const)('scope %s records under the model the request named, and no other', scope => {
    recordProviderVerdict('acme', 'm1', verdict('quota', { scope, resetsAt: NOON + MIN }), NOON)
    expect(providerStateOf('acme', NOON)).toEqual({
      models: { m1: { status: 'exhausted', until: NOON + MIN, untilFrom: 'provider', reason: 'quota' } },
    })
  })

  it.each(['rate_limit', 'quota', 'billing', 'credentials', 'model_unavailable', 'service', 'network'] as const)(
    '%s of one model leaves the other models of the instance ok',
    kind => {
      recordProviderVerdict('acme', 'm1', verdict(kind, { scope: 'provider' }), NOON)
      expect(Object.keys(providerStateOf('acme', NOON).models)).toEqual(['m1'])
      expect(held('acme', NOON, 'm2')).toEqual({ status: 'ok' })
    },
  )

  it('each model of an instance holds its own record', () => {
    recordProviderVerdict('acme', 'm1', verdict('service'), NOON)
    recordProviderVerdict('acme', 'm2', verdict('quota', { scope: 'model', resetsAt: NOON + MIN }), NOON)
    expect(providerStateOf('acme', NOON)).toEqual({
      models: {
        m1: { status: 'cooling', until: NOON + TRANSIENT_COOL_MS, untilFrom: 'platform', reason: 'service' },
        m2: { status: 'exhausted', until: NOON + MIN, untilFrom: 'provider', reason: 'quota' },
      },
    })
  })

  it('a rate limit of one model does not lengthen the wait of another', () => {
    recordProviderVerdict('acme', 'm1', verdict('rate_limit'), NOON)
    recordProviderVerdict('acme', 'm1', verdict('rate_limit'), NOON + 2 * MIN)
    recordProviderVerdict('acme', 'm2', verdict('rate_limit'), NOON + 2 * MIN)
    expect(held('acme', NOON + 2 * MIN, 'm1').until).toBe(NOON + 2 * MIN + 2 * MIN)
    expect(held('acme', NOON + 2 * MIN, 'm2').until).toBe(NOON + 2 * MIN + RATE_LIMIT_FIRST_MS)
  })

  it('one instance being frozen says nothing about another', () => {
    recordProviderVerdict('acme', 'm1', verdict('credentials', { scope: 'key', status: 401 }), NOON)
    expect(providerStateOf('other', NOON)).toEqual(NONE)
  })

  it('a shorter record does not replace a longer one, and nothing replaces disabled', () => {
    recordProviderVerdict('acme', 'm1', verdict('quota', { resetsAt: NOON + 60 * MIN }), NOON)
    recordProviderVerdict('acme', 'm1', verdict('network'), NOON + 1_000)
    expect(held('acme', NOON + 1_000).reason).toBe('quota')
    recordProviderVerdict('acme', 'm1', verdict('credentials', { status: 401 }), NOON + 2_000)
    recordProviderVerdict('acme', 'm1', verdict('quota', { resetsAt: NOON + 600 * MIN }), NOON + 3_000)
    expect(held('acme', NOON + 3_000)).toEqual({ status: 'disabled', reason: 'credentials' })
  })

  it('the answer is a copy', () => {
    recordProviderVerdict('acme', 'm1', verdict('quota', { scope: 'model', resetsAt: NOON + MIN }), NOON)
    const first = providerStateOf('acme', NOON)
    first.models.m1!.status = 'ok'
    delete first.models.m1
    expect(held('acme', NOON).status).toBe('exhausted')
  })
})

describe('what ends a record', () => {
  it('a record is there until its end and gone when read at or past it', () => {
    recordProviderVerdict('acme', 'm1', verdict('service'), NOON)
    recordProviderVerdict('acme', 'm2', verdict('model_unavailable', { scope: 'model' }), NOON)
    expect(held('acme', NOON + TRANSIENT_COOL_MS - 1).status).toBe('cooling')
    expect(providerStateOf('acme', NOON + TRANSIENT_COOL_MS)).toEqual({
      models: { m2: { status: 'cooling', until: NOON + MODEL_UNAVAILABLE_MS, untilFrom: 'platform', reason: 'model_unavailable' } },
    })
    expect(providerStateOf('acme', NOON + MODEL_UNAVAILABLE_MS)).toEqual(NONE)
  })

  it('clearing an instance forgets all its models and their rate-limit series', () => {
    recordProviderVerdict('acme', 'm1', verdict('rate_limit'), NOON)
    recordProviderVerdict('acme', 'm2', verdict('quota', { scope: 'model' }), NOON)
    recordProviderVerdict('other', 'm1', verdict('billing'), NOON)
    clearProviderState('acme')
    expect(providerStateOf('acme', NOON)).toEqual(NONE)
    expect(held('other', NOON).status).toBe('cooling')
    // The series is gone too: the next rate limit starts at 60 s, not 2 minutes.
    recordProviderVerdict('acme', 'm1', verdict('rate_limit'), NOON + MIN)
    expect(held('acme', NOON + MIN).until).toBe(NOON + MIN + RATE_LIMIT_FIRST_MS)
  })

  it('clearing one model leaves the other models of the instance', () => {
    recordProviderVerdict('acme', 'm1', verdict('credentials', { scope: 'key', status: 401 }), NOON)
    recordProviderVerdict('acme', 'm2', verdict('credentials', { scope: 'key', status: 401 }), NOON)
    recordProviderVerdict('acme', 'm3', verdict('quota', { scope: 'model', resetsAt: NOON + MIN }), NOON)
    clearProviderState('acme', 'm1')
    expect(providerStateOf('acme', NOON)).toEqual({
      models: {
        m2: { status: 'disabled', reason: 'credentials' },
        m3: { status: 'exhausted', until: NOON + MIN, untilFrom: 'provider', reason: 'quota' },
      },
    })
  })

  it('clearing what was never recorded is not an error', () => {
    expect(() => clearProviderState('nobody')).not.toThrow()
    expect(() => clearProviderState('nobody', 'm1')).not.toThrow()
  })

  it('a changed config clears the billing and credentials records of all that instance\'s models, and nothing else', () => {
    noteProviderConfigs({ a: { hasApiKey: true }, b: { hasApiKey: true }, c: { hasApiKey: true } })
    recordProviderVerdict('a', 'm1', verdict('credentials', { scope: 'key', status: 401 }), NOON)
    recordProviderVerdict('a', 'm3', verdict('billing', { scope: 'account' }), NOON)
    recordProviderVerdict('a', 'm2', verdict('quota', { scope: 'model', resetsAt: NOON + MIN }), NOON)
    recordProviderVerdict('b', 'm1', verdict('billing'), NOON)
    recordProviderVerdict('c', 'm1', verdict('quota', { resetsAt: NOON + MIN }), NOON)
    noteProviderConfigs({ a: { hasApiKey: true, baseUrl: 'https://x.test' }, b: { hasApiKey: true }, c: { hasApiKey: false } })
    expect(providerStateOf('a', NOON)).toEqual({
      models: { m2: { status: 'exhausted', until: NOON + MIN, untilFrom: 'provider', reason: 'quota' } },
    })
    // Unchanged config: kept.
    expect(held('b', NOON).reason).toBe('billing')
    // Changed config, but neither billing nor credentials: kept.
    expect(held('c', NOON).reason).toBe('quota')
  })

  it('the first configs seen clear nothing, and a removed config counts as a change', () => {
    recordProviderVerdict('a', 'm1', verdict('credentials', { status: 401 }), NOON)
    noteProviderConfigs({ a: { hasApiKey: true } })
    expect(held('a', NOON).status).toBe('disabled')
    noteProviderConfigs({})
    expect(providerStateOf('a', NOON)).toEqual(NONE)
  })
})

describe('kept between runs', () => {
  it('a record written by one run is read by the next, and ends when it would have', async () => {
    const store = memoryStore()
    await configureProviderHealthLedger(store)
    recordProviderVerdict('acme', 'm1', verdict('credentials', { scope: 'key', status: 401 }), NOON)
    recordProviderVerdict('acme', 'm2', verdict('quota', { scope: 'model', resetsAt: NOON + 60 * MIN }), NOON)
    recordProviderVerdict('other', 'm1', verdict('rate_limit'), NOON)
    await providerHealthLedgerSettled()
    expect(store.text).toBeTruthy()

    resetProviderHealthLedger()
    expect(providerStateOf('acme', NOON)).toEqual(NONE)
    await configureProviderHealthLedger(store)
    expect(providerStateOf('acme', NOON + MIN)).toEqual({
      models: {
        m1: { status: 'disabled', reason: 'credentials' },
        m2: { status: 'exhausted', until: NOON + 60 * MIN, untilFrom: 'provider', reason: 'quota' },
      },
    })
    expect(providerStateOf('other', NOON + RATE_LIMIT_FIRST_MS)).toEqual(NONE)
    // The series outlived the restart: a repeat inside 10 minutes doubles.
    recordProviderVerdict('other', 'm1', verdict('rate_limit'), NOON + 2 * MIN)
    expect(held('other', NOON + 2 * MIN).until).toBe(NOON + 2 * MIN + 2 * MIN)
  })

  it('a clear and a config change are written too', async () => {
    const store = memoryStore()
    await configureProviderHealthLedger(store)
    noteProviderConfigs({ a: {}, b: {} })
    recordProviderVerdict('a', 'm1', verdict('billing'), NOON)
    recordProviderVerdict('b', 'm1', verdict('billing'), NOON)
    clearProviderState('a')
    noteProviderConfigs({ a: {}, b: { hasApiKey: true } })
    await providerHealthLedgerSettled()

    resetProviderHealthLedger()
    await configureProviderHealthLedger(store)
    expect(providerStateOf('a', NOON)).toEqual(NONE)
    expect(providerStateOf('b', NOON)).toEqual(NONE)
  })

  it('what was recorded before the stored ledger arrived is kept over it', async () => {
    const earlier = memoryStore()
    await configureProviderHealthLedger(earlier)
    recordProviderVerdict('acme', 'm1', verdict('billing'), NOON)
    recordProviderVerdict('other', 'm1', verdict('billing'), NOON)
    await providerHealthLedgerSettled()

    resetProviderHealthLedger()
    const ready = configureProviderHealthLedger(memoryStore(earlier.text))
    recordProviderVerdict('acme', 'm1', verdict('credentials', { status: 401 }), NOON + 1_000)
    await ready
    expect(held('acme', NOON + 1_000).status).toBe('disabled')
    expect(held('other', NOON + 1_000).reason).toBe('billing')
  })

  it.each([
    ['not JSON', '{'],
    ['another version', JSON.stringify({ version: 2, instances: { acme: { models: { m1: { record: { status: 'disabled', reason: 'credentials' } } } } } })],
    ['a record with no end that is not disabled', JSON.stringify({ version: 1, instances: { acme: { models: { m1: { record: { status: 'cooling', reason: 'billing' } } } } } })],
    ['an unknown status', JSON.stringify({ version: 1, instances: { acme: { models: { m1: { record: { status: 'banned', reason: 'billing', until: NOON + MIN } } } } } })],
    ['a record on the instance itself', JSON.stringify({ version: 1, instances: { acme: { record: { status: 'disabled', reason: 'credentials' } } } })],
  ])('a stored ledger that is %s is not taken', async (_name, text) => {
    await configureProviderHealthLedger(memoryStore(text))
    expect(providerStateOf('acme', NOON)).toEqual(NONE)
  })

  it('a stored record with no source of its end, or an unknown one, is taken without it', async () => {
    const record = { status: 'cooling', reason: 'rate_limit', until: NOON + MIN }
    const text = JSON.stringify({
      version: 1,
      instances: { acme: { models: { old: { record }, odd: { record: { ...record, untilFrom: 'someone' } }, kept: { record: { ...record, untilFrom: 'provider' } } } } },
    })
    await configureProviderHealthLedger(memoryStore(text))
    expect(providerStateOf('acme', NOON)).toEqual({
      models: {
        old: { status: 'cooling', until: NOON + MIN, reason: 'rate_limit' },
        odd: { status: 'cooling', until: NOON + MIN, reason: 'rate_limit' },
        kept: { status: 'cooling', until: NOON + MIN, untilFrom: 'provider', reason: 'rate_limit' },
      },
    })
  })

  it('a store that cannot be read or written leaves the ledger working in memory', async () => {
    await configureProviderHealthLedger({
      read: async () => {
        throw new Error('no disk')
      },
      write: async () => {
        throw new Error('no disk')
      },
    })
    recordProviderVerdict('acme', 'm1', verdict('billing'), NOON)
    await providerHealthLedgerSettled()
    expect(held('acme', NOON).reason).toBe('billing')
  })

  it('a store that could not be read at first is read before it is written, so nothing stored is lost', async () => {
    const earlier = memoryStore()
    await configureProviderHealthLedger(earlier)
    recordProviderVerdict('stored', 'm1', verdict('credentials', { status: 401 }), NOON)
    await providerHealthLedgerSettled()

    resetProviderHealthLedger()
    const store = memoryStore(earlier.text)
    let reachable = false
    await configureProviderHealthLedger({
      read: async () => {
        if (!reachable) throw new Error('no settings root yet')
        return store.read()
      },
      write: store.write,
    })
    recordProviderVerdict('fresh', 'm1', verdict('billing'), NOON)
    await providerHealthLedgerSettled()
    expect(store.writes).toBe(0)

    reachable = true
    recordProviderVerdict('fresh', 'm2', verdict('quota', { scope: 'model', resetsAt: NOON + MIN }), NOON)
    await providerHealthLedgerSettled()
    expect(store.writes).toBe(1)
    expect(held('stored', NOON).status).toBe('disabled')
    expect(Object.keys(JSON.parse(store.text!).instances).sort()).toEqual(['fresh', 'stored'])
  })

  it('a store that becomes readable later is taken when asked again, with no change needed', async () => {
    const earlier = memoryStore()
    await configureProviderHealthLedger(earlier)
    recordProviderVerdict('stored', 'm1', verdict('credentials', { status: 401 }), NOON)
    await providerHealthLedgerSettled()

    resetProviderHealthLedger()
    let reachable = false
    await configureProviderHealthLedger({
      read: async () => {
        if (!reachable) throw new Error('no settings root yet')
        return earlier.text
      },
      write: earlier.write,
    })
    expect(providerStateOf('stored', NOON)).toEqual(NONE)
    reachable = true
    await retryProviderHealthLedgerLoad()
    expect(held('stored', NOON).status).toBe('disabled')
  })

  it('a clear made before the stored ledger was taken is not undone by it, and is written', async () => {
    const earlier = memoryStore()
    await configureProviderHealthLedger(earlier)
    recordProviderVerdict('acme', 'm1', verdict('credentials', { status: 401 }), NOON)
    recordProviderVerdict('acme', 'm2', verdict('quota', { scope: 'model', resetsAt: NOON + MIN }), NOON)
    recordProviderVerdict('other', 'm1', verdict('billing'), NOON)
    await providerHealthLedgerSettled()

    resetProviderHealthLedger()
    let reachable = false
    await configureProviderHealthLedger({
      read: async () => {
        if (!reachable) throw new Error('no settings root yet')
        return earlier.text
      },
      write: earlier.write,
    })
    clearProviderState('acme')
    reachable = true
    await retryProviderHealthLedgerLoad()
    await providerHealthLedgerSettled()
    expect(providerStateOf('acme', NOON)).toEqual(NONE)
    expect(held('other', NOON).reason).toBe('billing')
    expect(Object.keys(JSON.parse(earlier.text!).instances)).toEqual(['other'])
  })

  it('a config changed while no run was watching lifts billing and credentials when the next run starts', async () => {
    const store = memoryStore()
    await configureProviderHealthLedger(store)
    noteProviderConfigs({ a: { hasApiKey: true }, b: { hasApiKey: true } })
    recordProviderVerdict('a', 'm1', verdict('credentials', { status: 401 }), NOON)
    recordProviderVerdict('b', 'm1', verdict('credentials', { status: 401 }), NOON)
    await providerHealthLedgerSettled()
    expect(store.text).not.toContain('hasApiKey')

    resetProviderHealthLedger()
    await configureProviderHealthLedger(store)
    noteProviderConfigs({ a: { hasApiKey: true, apiKey: 'replaced' }, b: { hasApiKey: true } })
    expect(providerStateOf('a', NOON)).toEqual(NONE)
    expect(held('b', NOON).status).toBe('disabled')

    resetProviderHealthLedger()
    noteProviderConfigs({ a: { hasApiKey: true, apiKey: 'again' }, b: { hasApiKey: true } })
    await configureProviderHealthLedger(store)
    expect(providerStateOf('a', NOON)).toEqual(NONE)
    expect(held('b', NOON).status).toBe('disabled')
  })

  it('a verdict that records nothing writes nothing', async () => {
    const store = memoryStore()
    await configureProviderHealthLedger(store)
    recordProviderVerdict('acme', 'm1', verdict('configuration'), NOON)
    recordProviderVerdict('acme', 'm1', verdict('billing', { scope: 'request' }), NOON)
    recordProviderServed('acme', NOON)
    await providerHealthLedgerSettled()
    expect(store.writes).toBe(0)
  })
})
