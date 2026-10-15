import { describe, expect, it } from 'vitest'
import {
  describePlanUsageReset,
  parsePlanUsage,
  type PlanUsageMapping,
} from '../models/usage/planUsage'
import { kimiUsage } from '../config/nexusModelConfig/providers/kimi/usage'
import {
  FOLD_HEADROOM_TOKENS,
  foldTriggerTokens,
} from '../context/compaction/triggerThreshold'
import { __testInternals } from '../context/compaction/autoTrigger'
import { createTranslate } from '../browser/webview/i18n/translate'

const RESET_ISO = '2026-10-01T07:00:00Z'
const RESET_MS = Date.parse(RESET_ISO)

describe('parsePlanUsage', () => {
  it('reads usedPercent directly and clamps it to 0–100', () => {
    const config: PlanUsageMapping = {
      path: '/u',
      planName: 'plan.name',
      windows: [
        { kind: 'five_hour', usedPercent: 'a.pct', resetsAt: 'a.reset' },
        { kind: 'weekly', usedPercent: 'b.pct' },
      ],
    }
    expect(
      parsePlanUsage(config, {
        plan: { name: ' Max (5x) ' },
        a: { pct: 37, reset: RESET_ISO },
        b: { pct: 140 },
      }),
    ).toEqual({
      planName: 'Max (5x)',
      windows: [
        { kind: 'five_hour', usedPercent: 37, resetsAt: RESET_MS },
        { kind: 'weekly', usedPercent: 100 },
      ],
    })
  })

  it('derives the share from used/limit, then from limit − remaining', () => {
    const config: PlanUsageMapping = {
      path: '/u',
      windows: [
        { kind: 'five_hour', used: 'x.used', limit: 'x.limit' },
        { kind: 'weekly', remaining: 'y.remaining', limit: 'y.limit' },
      ],
    }
    const snap = parsePlanUsage(config, {
      x: { used: 25, limit: 100 },
      // String-typed numbers are accepted — vendors send both.
      y: { remaining: '94', limit: '100' },
    })
    expect(snap?.windows.map((w) => w.usedPercent)).toEqual([25, 6])
    expect(snap?.planName).toBeUndefined()
  })

  it('accepts reset times as epoch seconds, epoch ms or ISO strings', () => {
    const config: PlanUsageMapping = {
      path: '/u',
      windows: [
        { kind: 'daily', usedPercent: 'p', resetsAt: 's' },
        { kind: 'weekly', usedPercent: 'p', resetsAt: 'ms' },
        { kind: 'monthly', usedPercent: 'p', resetsAt: 'str' },
      ],
    }
    const snap = parsePlanUsage(config, {
      p: 1,
      s: RESET_MS / 1000,
      ms: RESET_MS,
      str: String(RESET_MS / 1000),
    })
    expect(snap?.windows.map((w) => w.resetsAt)).toEqual([RESET_MS, RESET_MS, RESET_MS])
  })

  it('drops windows that do not resolve, and yields undefined when none do', () => {
    const config: PlanUsageMapping = {
      path: '/u',
      windows: [
        { kind: 'five_hour', usedPercent: 'missing.path' },
        { kind: 'weekly', used: 'w.used', limit: 'w.limit' },
      ],
    }
    // limit 0 must not divide into Infinity/NaN.
    expect(parsePlanUsage(config, { w: { used: 5, limit: 0 } })).toBeUndefined()
    expect(parsePlanUsage(config, null)).toBeUndefined()
    expect(parsePlanUsage(config, 'not json')).toBeUndefined()
    expect(
      parsePlanUsage(config, { w: { used: 5, limit: 10 } })?.windows,
    ).toEqual([{ kind: 'weekly', usedPercent: 50 }])
  })

  it("maps Kimi's /usages document through its usage source", () => {
    expect(kimiUsage.path).toBe('/usages')
    const snap = kimiUsage.parse({
      usage: { limit: '100', remaining: '94', resetTime: RESET_ISO },
      limits: [
        {
          window: { duration: 300, timeUnit: 'TIME_UNIT_MINUTE' },
          detail: { limit: '100', remaining: '63', resetTime: RESET_ISO },
        },
      ],
    }, 0)
    expect(snap?.windows).toEqual([
      { kind: 'five_hour', usedPercent: 37, resetsAt: RESET_MS },
      { kind: 'weekly', usedPercent: 6, resetsAt: RESET_MS },
    ])
  })

  // Live shapes as published (MoonshotAI/kimi-code issue 3951, oh-my-pi issue 12790,
  // CodexBar docs/kimi.md): the `usages` pools carry the MONTHLY quota the
  // old mapping never read — such an account showed the 5-hour window alone.
  it('Kimi: the usages pools — 5h, 7d and the monthly total — read first, newest-account shape', () => {
    const snap = kimiUsage.parse({
      limits: [
        {
          window: { duration: 300, timeUnit: 'TIME_UNIT_MINUTE' },
          detail: { limit: '100', used: '100', resetTime: '2026-09-22T12:22:15.593402Z' },
        },
      ],
      usages: {
        limit_5h: { used_ratio: 0.25, reset_time: '2026-09-22T12:22:15Z' },
        limit_month_code: { used_ratio: 0.5, reset_time: '2026-10-22T00:00:00Z' },
        limit_month_total: { used_ratio: 0.0795, reset_time: '2026-10-22T00:00:00Z' },
      },
    }, 0)
    expect(snap?.windows).toEqual([
      // The pool wins over the count window for the same period.
      { kind: 'five_hour', usedPercent: 25, resetsAt: Date.parse('2026-09-22T12:22:15Z') },
      // The total, not the code sub-pool, is the month.
      { kind: 'monthly', usedPercent: 7.95, resetsAt: Date.parse('2026-10-22T00:00:00Z') },
    ])
  })

  it('Kimi: a weekly pool, and a summary that states `used` (no `remaining`) — nanosecond resets', () => {
    const snap = kimiUsage.parse({
      usage: { limit: '100', used: '40', resetTime: '2026-09-24T02:09:07.465054300Z' },
      limits: [
        {
          window: { duration: 300, timeUnit: 'TIME_UNIT_MINUTE' },
          detail: { limit: '200', remaining: '150', resetTime: '2026-09-21T01:09:07.465054Z' },
        },
      ],
    }, 0)
    expect(snap?.windows).toEqual([
      { kind: 'five_hour', usedPercent: 25, resetsAt: Date.parse('2026-09-21T01:09:07.465Z') },
      { kind: 'weekly', usedPercent: 40, resetsAt: Date.parse('2026-09-24T02:09:07.465Z') },
    ])
    expect(kimiUsage.parse({ usages: { limit_7d: { used_ratio: 0.1 } } }, 0)?.windows)
      .toEqual([{ kind: 'weekly', usedPercent: 10 }])
  })

  // A live document, read from a Kimi Code account (via the
  // runtime's own fetch; response only). This plan reports a 5-hour and a
  // weekly window and NO monthly pool. All three shapes at once — each period
  // must come out once, from the pool.
  it('Kimi: a live document — 5h and weekly, each once, from the pools', () => {
    const snap = kimiUsage.parse({
      usage: { limit: '100', used: '18', remaining: '82', resetTime: '2026-10-05T03:31:30.719973Z' },
      limits: [{
        window: { duration: 300, timeUnit: 'TIME_UNIT_MINUTE' },
        detail: { limit: '100', remaining: '100', resetTime: '2026-10-02T04:31:30.719973Z' },
      }],
      usages: {
        limit_5h: { used_ratio: 0, reset_time: '2026-10-02T04:31:30Z' },
        limit_7d: { used_ratio: 0.179657, reset_time: '2026-10-05T03:31:30Z' },
      },
    }, 0)
    expect(snap?.windows).toEqual([
      { kind: 'five_hour', usedPercent: 0, resetsAt: Date.parse('2026-10-02T04:31:30Z') },
      { kind: 'weekly', usedPercent: expect.closeTo(17.9657, 6), resetsAt: Date.parse('2026-10-05T03:31:30Z') },
    ])
  })

  it('Kimi: nothing readable is no snapshot; an unknown pool or window length is skipped', () => {
    expect(kimiUsage.parse({}, 0)).toBeUndefined()
    expect(kimiUsage.parse('nope', 0)).toBeUndefined()
    expect(kimiUsage.parse({
      usages: { limit_42m: { used_ratio: 0.5 } },
      limits: [{ window: { duration: 7, timeUnit: 'TIME_UNIT_MINUTE' }, detail: { limit: '1', used: '1' } }],
    }, 0)).toBeUndefined()
  })
})

describe('describePlanUsageReset', () => {
  const now = Date.parse('2026-09-30T12:00:00Z')

  it('is relative under a day, rounding minutes up', () => {
    expect(describePlanUsageReset(now + (2 * 60 + 55) * 60_000 + 1, now)).toEqual({
      kind: 'relative',
      hours: 2,
      minutes: 56,
    })
    expect(describePlanUsageReset(now + 5 * 60_000, now)).toEqual({
      kind: 'relative',
      hours: 0,
      minutes: 5,
    })
    // A reset already past reads as "0 min", never negative.
    expect(describePlanUsageReset(now - 1000, now)).toEqual({
      kind: 'relative',
      hours: 0,
      minutes: 0,
    })
  })

  it('is absolute a day or more away', () => {
    const at = now + 3 * 24 * 60 * 60_000
    expect(describePlanUsageReset(at, now)).toEqual({ kind: 'absolute', at })
  })

  it('is absolute when the rounded-up minutes reach a full day', () => {
    // 23h59m30s rounds up to 1440 min; "24 hr 0 min" is never shown.
    const at = now + 24 * 60 * 60_000 - 30_000
    expect(describePlanUsageReset(at, now)).toEqual({ kind: 'absolute', at })
  })
})

describe('autoCompactThreshold module', () => {
  it('is the same function the compaction runtime uses', () => {
    expect(__testInternals.foldTriggerTokens).toBe(foldTriggerTokens)
    expect(foldTriggerTokens(undefined)).toBe(180_000 - FOLD_HEADROOM_TOKENS)
  })
})

describe('plan-usage catalog strings', () => {
  it('has a label for every window kind in every locale', () => {
    const kinds = ['five_hour', 'daily', 'weekly', 'monthly']
    for (const locale of ['en', 'zh', 'ja', 'ko', 'es', 'fr', 'de'] as const) {
      const t = createTranslate(locale)
      for (const kind of kinds) {
        for (const key of [`tokenUsage.window.${kind}`, `tokenUsage.windowShort.${kind}`]) {
          expect(t(key as Parameters<typeof t>[0]), `${locale} ${key}`).not.toBe(key)
        }
      }
    }
  })

  it('renders the English summary lines of the design', () => {
    const t = createTranslate('en')
    expect(
      t('tokenUsage.contextSummary', { used: '275.3k', window: '1M', pct: '28' }),
    ).toBe('Context 275.3k / 1M (28%)')
    expect(
      [
        t('tokenUsage.planSummary', {
          pct: '37',
          window: t('tokenUsage.windowShort.five_hour'),
        }),
        t('tokenUsage.resetsIn', {
          duration: t('tokenUsage.durationHrMin', { hours: '2', minutes: '55' }),
        }),
      ].join(' · '),
    ).toBe('37% of 5-hour limit · Resets in 2 hr 55 min')
  })
})
