/**
 * Recurring cron routines fire a fixed per-routine delay after each slot:
 * stable for one routine, under half the gap to the following slot, capped at
 * 30 minutes; one-shots fire on the slot. The scheduler, the session timer
 * countdown and the CronCreate reply all report the delayed time (F-15).
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { RuntimeFs } from '../utils/fs/runtimeFs'
import { RoutineRegistry, setRoutineRegistry } from '../routines/RoutineRegistry'
import { RoutineScheduler } from '../routines/RoutineScheduler'
import type { RoutineFireDispatcher } from '../routines/RoutineFireDispatcher'
import type { CronRoutine } from '../routines/routineTypes'
import { listSessionTimers } from '../routines/sessionTimers'
import {
  MAX_RECURRING_FIRE_DELAY_MS,
  computeRoutineFireAt,
  recurringFireDelay,
  routineDelayFraction,
} from '../routines/routineFireTime'

const MINUTE = 60_000
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR

function makeFs(): RuntimeFs {
  const files = new Map<string, string>()
  return {
    readFile: async (path: string) => {
      const c = files.get(path)
      if (c === undefined) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
      return c
    },
    writeFile: async (path: string, content: string) => {
      files.set(path, content)
    },
    mkdir: async () => {},
  } as unknown as RuntimeFs
}

function hourly(over: Partial<CronRoutine> = {}): CronRoutine {
  return {
    kind: 'cron',
    id: 'rt_hourly',
    name: 'loop-hourly',
    schedule: '0 */1 * * *',
    timezone: 'UTC',
    prompt: 'check the queue',
    notifyOn: 'on_error',
    createdAt: Date.UTC(2026, 10, 11, 4, 58),
    createdBySessionId: 'S1',
    delivery: { mode: 'session', sessionId: 'S1' },
    enabled: true,
    ...over,
  }
}

/** First id `rt_<n>` whose delay fraction is at least `min`. */
function idWithFraction(min: number): string {
  for (let n = 0; n < 10_000; n++) {
    const id = `rt_${n}`
    if (routineDelayFraction(id) >= min) return id
  }
  throw new Error('no id found')
}

beforeEach(() => setRoutineRegistry(null))

describe('recurringFireDelay', () => {
  it('is the same for one routine every time and differs between routines', () => {
    const slot = Date.UTC(2026, 10, 11, 5)
    const a = hourly({ id: 'rt_a' })
    expect(recurringFireDelay(a, slot)).toBe(recurringFireDelay({ ...a }, slot))
    const delays = new Set(
      ['rt_a', 'rt_b', 'rt_c', 'rt_d', 'rt_e'].map(id => recurringFireDelay(hourly({ id }), slot)),
    )
    expect(delays.size).toBeGreaterThan(1)
  })

  it('stays under half the gap to the following slot', () => {
    const slot = Date.UTC(2026, 10, 11, 5)
    for (let n = 0; n < 200; n++) {
      const d = recurringFireDelay(hourly({ id: `rt_${n}`, schedule: '*/10 * * * *' }), slot)
      expect(d).toBeGreaterThanOrEqual(0)
      expect(d).toBeLessThan(5 * MINUTE)
    }
  })

  it('never exceeds 30 minutes, however long the period', () => {
    const slot = Date.UTC(2026, 10, 11, 0)
    const id = idWithFraction(0.5)
    const daily = hourly({ id, schedule: '0 0 * * *' })
    expect(routineDelayFraction(id) * 0.5 * DAY).toBeGreaterThan(MAX_RECURRING_FIRE_DELAY_MS)
    expect(recurringFireDelay(daily, slot)).toBe(MAX_RECURRING_FIRE_DELAY_MS)
  })

  it('is zero for a one-shot', () => {
    const id = idWithFraction(0.5)
    const once = hourly({ id, oneShot: true })
    const anchor = Date.UTC(2026, 10, 11, 4, 58)
    expect(computeRoutineFireAt(once, anchor)).toBe(Date.UTC(2026, 10, 11, 5))
  })
})

describe('an hourly loop registered just before the hour', () => {
  const id = idWithFraction(0.4)
  const routine = hourly({ id })
  const slot = Date.UTC(2026, 10, 11, 5)
  const delay = recurringFireDelay(routine, slot)

  it('has a delay of several minutes for this id', () => {
    expect(delay).toBeGreaterThanOrEqual(12 * MINUTE)
    expect(delay).toBeLessThanOrEqual(MAX_RECURRING_FIRE_DELAY_MS)
  })

  it('does not fire on the hour, and fires once the delay has passed', async () => {
    const reg = await RoutineRegistry.load(makeFs(), '/base')
    setRoutineRegistry(reg)
    await reg.create(routine)
    const fire = vi.fn()
    const dispatcher = { prepare: () => 'fire' as const, fire } as RoutineFireDispatcher

    await new RoutineScheduler(dispatcher, { now: () => slot + MINUTE }).tick()
    expect(fire).not.toHaveBeenCalled()

    await new RoutineScheduler(dispatcher, { now: () => slot + delay }).tick()
    expect(fire).toHaveBeenCalledTimes(1)
  })

  it('keeps the same delay after the next hour', () => {
    const lastRunAt = slot + delay
    const next = computeRoutineFireAt(routine, lastRunAt)
    expect(next).toBe(slot + HOUR + delay)
  })

  it('shows the delayed time in the session timer countdown', () => {
    const [timer] = listSessionTimers([routine])
    expect(timer!.nextFireAt).toBe(slot + delay)
  })
})
