/**
 * A cron routine's next fire is anchored on the scheduler's fire time, not on
 * when a queued headless run got to start, so a run that waited behind busy
 * runs does not swallow the following slot (F-15).
 */

import { beforeEach, describe, expect, it } from 'vitest'
import type { RuntimeFs } from '../utils/fs/runtimeFs'
import { RoutineRegistry, setRoutineRegistry } from '../routines/RoutineRegistry'
import { HeadlessRunner, type HeadlessRunResult } from '../routines/HeadlessRunner'
import { computeRoutineFireAt } from '../routines/routineFireTime'
import type { CronRoutine, Routine } from '../routines/routineTypes'

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

function routine(id: string, over: Partial<CronRoutine> = {}): CronRoutine {
  return {
    kind: 'cron',
    id,
    name: id,
    schedule: '*/10 * * * *',
    prompt: 'check',
    notifyOn: 'on_error',
    createdAt: Date.UTC(2026, 10, 11, 4, 55),
    createdBySessionId: 'S1',
    enabled: true,
    timezone: 'UTC',
    ...over,
  }
}

function settled(): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, 0))
}

beforeEach(() => setRoutineRegistry(null))

describe('a queued headless cron run', () => {
  it('keeps the scheduler fire time as the anchor, so the following slot still fires', async () => {
    const reg = await RoutineRegistry.load(makeFs(), '/base')
    setRoutineRegistry(reg)
    const target = routine('rt_target')
    await reg.create(target)
    const firedAt = Date.UTC(2026, 10, 11, 5, 4)
    await reg.update(target.id, { lastRunAt: firedAt })

    const finish: Array<(r: HeadlessRunResult) => void> = []
    const runner = new HeadlessRunner(
      ({ sessionId }) =>
        new Promise<HeadlessRunResult>(resolve =>
          finish.push(() => resolve({ sessionId, status: 'success', summary: '' })),
        ),
      { maxConcurrency: 1 },
    )
    const busy: Routine = routine('rt_busy')
    await reg.create(busy)
    runner.enqueue(busy)
    runner.enqueue(reg.get(target.id)!)

    // The queued run starts at the following slot, after the busy one ends.
    const realNow = Date.now
    Date.now = () => Date.UTC(2026, 10, 11, 5, 10, 30)
    try {
      finish[0]!({ sessionId: '', status: 'success', summary: '' })
      await settled()
      finish[1]!({ sessionId: '', status: 'success', summary: '' })
      await settled()
    } finally {
      Date.now = realNow
    }

    const after = reg.get(target.id) as CronRoutine
    expect(after.lastRunStatus).toBe('success')
    expect(after.lastRunAt).toBe(firedAt)
    const next = computeRoutineFireAt(after, after.lastRunAt!)!
    expect(next).toBeGreaterThanOrEqual(Date.UTC(2026, 10, 11, 5, 10))
    expect(next).toBeLessThan(Date.UTC(2026, 10, 11, 5, 20))
  })

  it('still records a remote trigger run at its start time', async () => {
    const reg = await RoutineRegistry.load(makeFs(), '/base')
    setRoutineRegistry(reg)
    const trigger = {
      kind: 'remote_trigger',
      id: 'rt_hook',
      name: 'rt_hook',
      prompt: 'check',
      notifyOn: 'on_error',
      createdAt: 1000,
      createdBySessionId: 'S1',
      enabled: true,
      trigger: { type: 'manual' },
    } as unknown as Routine
    await reg.create(trigger)
    const runner = new HeadlessRunner(async ({ sessionId }) => ({
      sessionId,
      status: 'success',
      summary: '',
    }))
    const before = Date.now()
    runner.enqueue(trigger)
    await settled()
    expect(reg.get('rt_hook')!.lastRunAt).toBeGreaterThanOrEqual(before)
  })
})
