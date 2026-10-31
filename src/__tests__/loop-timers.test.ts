/**
 * Loop timers (F-15): a recurring session-delivered routine is published as a
 * running `local_timer` row of the session it fires into, re-published on every
 * registry change, and described with a schedule in words, a countdown, and the
 * message its stop button sends.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import type { RuntimeFs } from '../utils/fs/runtimeFs'
import type { NexusTaskSummaryRow } from '../browser/bridge/protocol/ui'
import { RoutineRegistry, setRoutineRegistry } from '../routines/RoutineRegistry'
import { computeNextFireAt } from '../routines/cronExpression'
import { listSessionTimers } from '../routines/sessionTimers'
import type { CronRoutine, Routine } from '../routines/routineTypes'
import { SharedWorkerSessionManager } from '../browser/worker/SharedWorkerSessionManager'
import type { AgentRuntimeWorkerHandle } from '../browser/worker/SharedWorkerSessionManager'
import {
  countRunning,
  countRunningWork,
  filterSubAgentRowsBySession,
  groupSubAgentsByCategory,
} from '../browser/webview/backgroundSubAgents'
import {
  loopTimerCancelPrompt,
  loopTimerCountdown,
  loopTimerScheduleText,
  loopTimerStopRequest,
} from '../browser/webview/loopTimers'
import { createTranslate } from '../browser/webview/i18n/translate'
import { TASK_ID_PATTERN } from '../backgroundTasks/taskId'

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

function cron(over: Partial<CronRoutine> = {}): CronRoutine {
  return {
    kind: 'cron',
    id: 'rt_loop_1',
    name: 'loop-check-deploy',
    schedule: '* * * * *',
    timezone: 'UTC',
    prompt: 'check the deploy',
    notifyOn: 'on_error',
    createdAt: Date.UTC(2026, 9, 31, 12, 0, 10),
    createdBySessionId: 'S1',
    delivery: { mode: 'session', sessionId: 'S1' },
    enabled: true,
    ...over,
  }
}

const t = createTranslate('en')

beforeEach(() => setRoutineRegistry(null))
afterEach(() => setRoutineRegistry(null))

describe('listSessionTimers', () => {
  it('lists enabled recurring session-delivered cron routines with their next fire', () => {
    const loop = cron()
    const timers = listSessionTimers([
      loop,
      cron({ id: 'rt_headless', name: 'nightly', delivery: undefined }),
      cron({ id: 'rt_explicit_headless', name: 'h2', delivery: { mode: 'headless' } }),
      cron({ id: 'rt_off', name: 'off', enabled: false }),
      cron({ id: 'rt_once', name: 'once', oneShot: true }),
    ] as Routine[])
    expect(timers).toEqual([
      {
        id: 'rt_loop_1',
        name: 'loop-check-deploy',
        sessionId: 'S1',
        schedule: '* * * * *',
        nextFireAt: Date.UTC(2026, 9, 31, 12, 1, 0),
      },
    ])
  })

  it('counts from the last run, so a held-back fire stays in the past', () => {
    const lastRunAt = Date.UTC(2026, 9, 31, 12, 5, 0)
    const [timer] = listSessionTimers([cron({ schedule: '*/5 * * * *', lastRunAt })])
    expect(timer!.nextFireAt).toBe(computeNextFireAt('*/5 * * * *', 'UTC', lastRunAt))
    expect(timer!.nextFireAt).toBe(Date.UTC(2026, 9, 31, 12, 10, 0))
  })
})

describe('RoutineRegistry.onChange', () => {
  it('fires after create, update and delete, and stops after unsubscribe', async () => {
    const reg = await RoutineRegistry.load(makeFs(), '/base')
    const seen: number[] = []
    const off = reg.onChange(() => seen.push(reg.list().length))
    await reg.create(cron())
    await reg.update('rt_loop_1', { lastRunAt: 5 })
    await reg.delete('rt_loop_1')
    expect(seen).toEqual([1, 1, 0])
    off()
    await reg.create(cron({ id: 'rt_2', name: 'other' }))
    expect(seen).toEqual([1, 1, 0])
  })

  it('a throwing listener does not fail the mutation', async () => {
    const reg = await RoutineRegistry.load(makeFs(), '/base')
    reg.onChange(() => {
      throw new Error('boom')
    })
    await expect(reg.create(cron())).resolves.toBeUndefined()
    expect(reg.get('rt_loop_1')).toBeDefined()
  })
})

function makeWorker(): AgentRuntimeWorkerHandle {
  return {
    async receiveFrame() {},
    getSnapshot: () => ({ initialized: true }),
    enqueueSubmit() {},
    consumePendingAsNextSubmit() {},
    pumpSubmits() {},
    isBusy: () => false,
    isStopping: () => false,
    getPhase: () => ({ kind: 'idle' }),
  } as unknown as AgentRuntimeWorkerHandle
}

type FeedInternals = {
  feed: { buildSummaryPayload(): { subAgents?: NexusTaskSummaryRow[] } }
}

describe('session summary feed', () => {
  it('publishes each loop timer as a running row of the session it fires into', async () => {
    const reg = await RoutineRegistry.load(makeFs(), '/base')
    setRoutineRegistry(reg)
    await reg.create(cron())
    await reg.create(cron({ id: 'rt_headless', name: 'nightly', delivery: undefined }))
    const m = new SharedWorkerSessionManager({ createWorker: makeWorker })
    const rows = (m as unknown as FeedInternals).feed.buildSummaryPayload().subAgents ?? []
    const timers = rows.filter(r => r.type === 'local_timer')
    expect(timers).toEqual([
      {
        sessionId: 'rt_loop_1',
        spawnerSessionId: 'S1',
        status: 'running',
        type: 'local_timer',
        description: 'loop-check-deploy',
        schedule: '* * * * *',
        nextFireAt: Date.UTC(2026, 9, 31, 12, 1, 0),
      },
    ])
    // Scoped to its own session, never shown in another one.
    expect(filterSubAgentRowsBySession(rows, 'S1').map(r => r.sessionId)).toContain('rt_loop_1')
    expect(filterSubAgentRowsBySession(rows, 'S2').map(r => r.sessionId)).not.toContain('rt_loop_1')

    await reg.delete('rt_loop_1')
    const after = (m as unknown as FeedInternals).feed.buildSummaryPayload().subAgents ?? []
    expect(after.some(r => r.type === 'local_timer')).toBe(false)
  })
})

describe('webview helpers', () => {
  const timerRow: NexusTaskSummaryRow = {
    sessionId: 'rt_loop_1',
    spawnerSessionId: 'S1',
    status: 'running',
    type: 'local_timer',
    description: 'loop-check-deploy',
  }

  it('files a timer under Running, counts it as running but not as work', () => {
    const shell: NexusTaskSummaryRow = { ...timerRow, sessionId: 'b1', type: 'local_bash' }
    expect(groupSubAgentsByCategory([timerRow]).map(g => g.category)).toEqual(['running'])
    expect(countRunning([timerRow, shell])).toBe(2)
    expect(countRunningWork([timerRow, shell])).toBe(1)
    expect(countRunningWork([timerRow])).toBe(0)
  })

  it('stop asks the session to delete the routine by id', () => {
    expect(loopTimerCancelPrompt('rt_loop_1')).toBe(
      'Cancel the recurring loop with job ID rt_loop_1 by calling CronDelete, then confirm',
    )
  })

  it("a stop of a timer goes to its session as a prompt; any other task is the runtime's", () => {
    const shell: NexusTaskSummaryRow = { ...timerRow, sessionId: 'b1', type: 'local_bash' }
    expect(loopTimerStopRequest([shell, timerRow], 'rt_loop_1')).toEqual({
      sessionId: 'S1',
      prompt: loopTimerCancelPrompt('rt_loop_1'),
    })
    expect(loopTimerStopRequest([shell, timerRow], 'b1')).toBeNull()
    expect(loopTimerStopRequest([shell], 'gone')).toBeNull()
  })

  it('timer ids never match the minted task-id pattern', () => {
    expect(new RegExp(`^${TASK_ID_PATTERN}$`).test('t1234abcd')).toBe(false)
  })

  it.each([
    ['* * * * *', 'Every minute'],
    ['*/1 * * * *', 'Every minute'],
    ['*/5 * * * *', 'Every 5 minutes'],
    ['0 * * * *', 'Every hour'],
    ['15 */1 * * *', 'Every hour'],
    ['0 */2 * * *', 'Every 2 hours'],
    ['0 9 * * *', 'Every day at 09:00'],
    ['30 17 * * *', 'Every day at 17:30'],
    ['0 9 * * 1-5', '0 9 * * 1-5'],
    ['0 0 0 * * *', '0 0 0 * * *'],
    ['5,35 * * * *', '5,35 * * * *'],
  ])('schedule %s reads "%s"', (schedule, text) => {
    expect(loopTimerScheduleText(schedule, t)).toBe(text)
  })

  it('counts down to the next fire, then reads Due', () => {
    const now = 1_000_000
    expect(loopTimerCountdown(now + 46_000, now, t)).toBe('Next 46s')
    expect(loopTimerCountdown(now + 45_200, now, t)).toBe('Next 46s')
    expect(loopTimerCountdown(now + 71_000, now, t)).toBe('Next 1m 11s')
    expect(loopTimerCountdown(now + 3 * 3_600_000 + 5_000, now, t)).toBe('Next 3h')
    expect(loopTimerCountdown(now, now, t)).toBe('Due')
    expect(loopTimerCountdown(now - 20_000, now, t)).toBe('Due')
    expect(loopTimerCountdown(undefined, now, t)).toBeNull()
  })
})
