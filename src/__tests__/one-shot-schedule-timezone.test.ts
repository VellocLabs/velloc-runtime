import { afterEach, describe, expect, it } from 'vitest'
import { ONE_SHOT_TIMEZONE, parseOneShotAt } from '../routines/oneShotSchedule'
import { computeNextFireAt } from '../routines/cronExpression'
import { setRoutineRegistry, type RoutineRegistry } from '../routines/RoutineRegistry'
import { ScheduleCronTool } from '../toolkit/builtin/scheduleCron'
import type { ToolCallContext } from '../toolkit/toolCallContext'

/**
 * A one-shot `at` time is written as a cron expression in UTC fields, so the
 * routine must be evaluated in UTC: matched in the host's local zone the run
 * would land off by the local UTC offset. The target instant is what the
 * matcher must produce, on any host zone.
 */
describe('one-shot schedules fire at the target instant', () => {
  it('a relative offset fires exactly at now + offset when evaluated in the one-shot zone', () => {
    const now = Date.UTC(2026, 9, 8, 22, 30, 0)
    const parsed = parseOneShotAt('in 2h', now)
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) return
    const target = Date.UTC(2026, 9, 9, 0, 30, 0)
    expect(parsed.target.getTime()).toBe(target)
    expect(computeNextFireAt(parsed.schedule, ONE_SHOT_TIMEZONE, now)).toBe(target)
  })

  it('an absolute ISO time with an offset fires at that instant', () => {
    const now = Date.UTC(2026, 9, 8, 1, 0, 0)
    const parsed = parseOneShotAt('2026-10-08T09:15:00+08:00', now)
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) return
    const target = Date.UTC(2026, 9, 8, 1, 15, 0)
    expect(parsed.target.getTime()).toBe(target)
    expect(computeNextFireAt(parsed.schedule, ONE_SHOT_TIMEZONE, now)).toBe(target)
  })

  it('the one-shot zone is UTC, the zone the expression is written in', () => {
    expect(ONE_SHOT_TIMEZONE).toBe('UTC')
  })

  it('the ScheduleCron tool stamps the one-shot routine with the one-shot zone', async () => {
    const created: Array<Record<string, unknown>> = []
    setRoutineRegistry({
      create: async (routine: unknown) => {
        created.push(routine as Record<string, unknown>)
      },
    } as unknown as RoutineRegistry)
    const context = { options: { sessionId: 'session-one-shot' } } as unknown as ToolCallContext
    await ScheduleCronTool.call({ at: 'in 2h', prompt: 'ping' } as never, context, async () => ({ behavior: 'allow' }) as never, undefined as never)
    expect(created).toHaveLength(1)
    expect(created[0]?.oneShot).toBe(true)
    expect(created[0]?.timezone).toBe(ONE_SHOT_TIMEZONE)
  })

  it('the same fields read in a zone east of UTC would fire early', () => {
    // Read the fields in an explicit east-of-UTC zone rather than mutating
    // process.env.TZ: vitest worker threads ignore a runtime TZ change, so on
    // a UTC host the "no zone" case would equal the UTC one.
    const now = Date.UTC(2026, 9, 8, 1, 0, 0)
    const parsed = parseOneShotAt('in 2h', now)
    if (!parsed.ok) throw new Error(parsed.message)
    const target = now + 2 * 60 * 60 * 1000
    expect(computeNextFireAt(parsed.schedule, ONE_SHOT_TIMEZONE, now)).toBe(target)
    expect(computeNextFireAt(parsed.schedule, 'Asia/Shanghai', now)).not.toBe(target)
  })
})

afterEach(() => {
  setRoutineRegistry(null)
})
