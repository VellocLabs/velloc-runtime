/**
 * Recurring cron routines fire a per-routine delay after each slot: stable
 * for one routine on an even schedule, leaving at least one scheduler tick
 * before the following slot, capped at 30 minutes; one-shots fire on the
 * slot. No slot is skipped or fired twice, across month ends, DST shifts and
 * explicit zones. The scheduler, the session timer countdown and the
 * CronCreate reply all report the delayed time (F-15).
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { RuntimeFs } from '../utils/fs/runtimeFs'
import { RoutineRegistry, setRoutineRegistry } from '../routines/RoutineRegistry'
import { RoutineScheduler } from '../routines/RoutineScheduler'
import type { RoutineFireDispatcher } from '../routines/RoutineFireDispatcher'
import type { CronRoutine } from '../routines/routineTypes'
import { listSessionTimers } from '../routines/sessionTimers'
import { computeNextFireAt } from '../routines/cronExpression'
import {
  MAX_RECURRING_FIRE_DELAY_MS,
  ROUTINE_SCHEDULER_TICK_MS,
  computeRoutineFireAt,
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

/** How long after `slot` the routine fires, read the way the scheduler reads it. */
function delayAt(routine: CronRoutine, slot: number): number {
  return computeRoutineFireAt(routine, slot - 1)! - slot
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

describe('the fire delay', () => {
  it('is the same for one routine every time and differs between routines', () => {
    const slot = Date.UTC(2026, 10, 11, 5)
    const a = hourly({ id: 'rt_a' })
    expect(delayAt(a, slot)).toBe(delayAt({ ...a }, slot))
    const delays = new Set(
      ['rt_a', 'rt_b', 'rt_c', 'rt_d', 'rt_e'].map(id => delayAt(hourly({ id }), slot)),
    )
    expect(delays.size).toBeGreaterThan(1)
  })

  it('stays under half the gap to the following slot', () => {
    const slot = Date.UTC(2026, 10, 11, 5)
    for (let n = 0; n < 200; n++) {
      const d = delayAt(hourly({ id: `rt_${n}`, schedule: '*/10 * * * *' }), slot)
      expect(d).toBeGreaterThanOrEqual(0)
      expect(d).toBeLessThan(5 * MINUTE - ROUTINE_SCHEDULER_TICK_MS)
    }
  })

  it('never exceeds 30 minutes, however long the period', () => {
    const slot = Date.UTC(2026, 10, 11, 0)
    const daily = hourly({ id: 'rt_20', schedule: '0 0 * * *' })
    expect(delayAt(daily, slot)).toBe(MAX_RECURRING_FIRE_DELAY_MS)
  })

  it('is a share of each slot gap, so uneven schedules get a different delay per slot', () => {
    const routine = hourly({ id: 'rt_20', schedule: '0,10 * * * *' })
    expect(delayAt(routine, Date.UTC(2026, 10, 11, 5, 0))).toBe(168_650)
    expect(delayAt(routine, Date.UTC(2026, 10, 11, 5, 10))).toBe(918_205)
  })

  it('is zero when the gap is a minute or less', () => {
    const id = idWithFraction(0.999)
    const slot = Date.UTC(2026, 10, 11, 5)
    expect(delayAt(hourly({ id, schedule: '* * * * *' }), slot)).toBe(0)
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
  const delay = delayAt(routine, slot)

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

/**
 * Walks `count` fires from `from`, anchoring each on a fire that lagged its due
 * time by a full tick plus jitter, and checks every slot is fired exactly once, in order.
 */
const TICK_JITTER_MS = 1_000

function expectEverySlotFiredOnce(routine: CronRoutine, from: number, count: number): void {
  let anchor = from
  let slot = computeNextFireAt(routine.schedule, routine.timezone, anchor)!
  for (let i = 0; i < count; i++) {
    const following = computeNextFireAt(routine.schedule, routine.timezone, slot)!
    const fireAt = computeRoutineFireAt(routine, anchor)!
    expect(fireAt).toBeGreaterThanOrEqual(slot)
    const laggedRun = fireAt + ROUTINE_SCHEDULER_TICK_MS + TICK_JITTER_MS
    expect(laggedRun).toBeLessThan(following)
    // Right after the fire the same slot is no longer due.
    expect(computeNextFireAt(routine.schedule, routine.timezone, fireAt)).toBe(following)
    expect(computeNextFireAt(routine.schedule, routine.timezone, laggedRun)).toBe(following)
    anchor = laggedRun
    slot = following
  }
}

describe('no slot is skipped or fired twice', () => {
  const late = idWithFraction(0.999)

  it.each([
    ['every minute', '* * * * *'],
    ['every two minutes', '*/2 * * * *'],
    ['every five minutes', '*/5 * * * *'],
    ['uneven minutes', '0,10 * * * *'],
    ['hourly', '0 */1 * * *'],
  ])('%s, with the latest delay and a tick of lag', (_label, schedule) => {
    expectEverySlotFiredOnce(hourly({ id: late, schedule }), Date.UTC(2026, 10, 11, 4, 58), 50)
  })

  it('across month ends of different lengths', () => {
    const routine = hourly({ id: late, schedule: '0 0 */10 * *' })
    expectEverySlotFiredOnce(routine, Date.UTC(2026, 0, 1), 15)
  })

  it('across both DST shifts in an explicit zone', () => {
    const routine = hourly({ id: late, schedule: '0 */1 * * *', timezone: 'America/New_York' })
    expectEverySlotFiredOnce(routine, Date.UTC(2026, 2, 8, 4), 6)
    expectEverySlotFiredOnce(routine, Date.UTC(2026, 10, 1, 4), 6)
  })

  it('delays a daily slot read in its explicit zone', () => {
    const routine = hourly({ id: 'rt_20', schedule: '0 9 * * *', timezone: 'Asia/Shanghai' })
    expect(computeRoutineFireAt(routine, Date.UTC(2026, 10, 10, 12))).toBe(
      Date.UTC(2026, 10, 11, 1, 30),
    )
  })

  it('fires once through the scheduler, not again on the next tick', async () => {
    const reg = await RoutineRegistry.load(makeFs(), '/base')
    setRoutineRegistry(reg)
    const routine = hourly({ id: late, schedule: '*/2 * * * *' })
    await reg.create(routine)
    const fire = vi.fn()
    const dispatcher = { prepare: () => 'fire' as const, fire } as RoutineFireDispatcher
    const fireAt = computeRoutineFireAt(routine, routine.createdAt)!

    await new RoutineScheduler(dispatcher, { now: () => fireAt }).tick()
    await new RoutineScheduler(dispatcher, { now: () => fireAt + ROUTINE_SCHEDULER_TICK_MS }).tick()
    expect(fire).toHaveBeenCalledTimes(1)
  })
})
