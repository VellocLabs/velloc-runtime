/**
 * `RoutineScheduler.tick()` decides a routine is due and writes `lastRunAt` before firing, the only schedule advance
 * for session-delivered routines, so a dropped or skipped fire misses its slot instead of retrying.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { RuntimeFs } from '../utils/fs/runtimeFs'
import {
  RoutineRegistry,
  setRoutineRegistry,
} from '../routines/RoutineRegistry'
import { RoutineScheduler } from '../routines/RoutineScheduler'
import type { RoutineFireDispatcher } from '../routines/RoutineFireDispatcher'
import type { CronRoutine } from '../routines/routineTypes'

function makeFs(): RuntimeFs {
  const files = new Map<string, string>()
  return {
    readFile: async (path: string) => {
      const c = files.get(path)
      if (c === undefined) {
        throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
      }
      return c
    },
    writeFile: async (path: string, content: string) => {
      files.set(path, content)
    },
    mkdir: async () => {},
  } as unknown as RuntimeFs
}

async function freshRegistry(): Promise<RoutineRegistry> {
  const reg = await RoutineRegistry.load(makeFs(), '/base')
  setRoutineRegistry(reg)
  return reg
}

const MINUTE = 60_000

function everyMinute(over: Partial<CronRoutine> = {}): CronRoutine {
  return {
    kind: 'cron',
    id: 'rt_tick_1',
    name: 'tick-routine',
    schedule: '* * * * *',
    prompt: 'tick',
    notifyOn: 'on_error',
    createdAt: 0,
    createdBySessionId: 'sess-A',
    enabled: true,
    ...over,
  }
}

function spyDispatcher(): {
  dispatcher: RoutineFireDispatcher
  fire: ReturnType<typeof vi.fn>
} {
  const fire = vi.fn()
  return {
    dispatcher: { prepare: () => 'fire' as const, fire } as RoutineFireDispatcher,
    fire,
  }
}

beforeEach(() => {
  setRoutineRegistry(null)
})

describe('RoutineScheduler.tick', () => {
  it('fires a routine whose next slot has passed', async () => {
    const reg = await freshRegistry()
    await reg.create(everyMinute())
    const { dispatcher, fire } = spyDispatcher()

    await new RoutineScheduler(dispatcher, { now: () => 5 * MINUTE }).tick()

    expect(fire).toHaveBeenCalledTimes(1)
    expect(fire.mock.calls[0]![0].id).toBe('rt_tick_1')
  })

  it('does NOT fire before the first slot', async () => {
    const reg = await freshRegistry()
    await reg.create(everyMinute({ createdAt: 0 }))
    const { dispatcher, fire } = spyDispatcher()

    // Half a minute in: the every-minute slot has not arrived yet.
    await new RoutineScheduler(dispatcher, { now: () => 30_000 }).tick()

    expect(fire).not.toHaveBeenCalled()
  })

  it('anchors on lastRunAt when present, not createdAt', async () => {
    const reg = await freshRegistry()
    await reg.create(everyMinute({ createdAt: 0 }))
    // Ran at 4:30; the next every-minute slot is 5:00, and it is only 4:50.
    // Anchoring on createdAt (0) instead would make the next slot 0:01 —
    // long past — and fire. That difference is the whole assertion.
    await reg.update('rt_tick_1', { lastRunAt: 4.5 * MINUTE })
    const { dispatcher, fire } = spyDispatcher()

    await new RoutineScheduler(dispatcher, {
      now: () => 4.5 * MINUTE + 20_000,
    }).tick()

    expect(fire).not.toHaveBeenCalled()
  })

  it('writes lastRunAt BEFORE dispatching', async () => {
    const reg = await freshRegistry()
    await reg.create(everyMinute())
    let lastRunAtAtFireTime: number | undefined = -1
    const dispatcher: RoutineFireDispatcher = {
      prepare: () => 'fire',
      fire: () => {
        lastRunAtAtFireTime = reg.get('rt_tick_1')?.lastRunAt
      },
    }

    await new RoutineScheduler(dispatcher, { now: () => 5 * MINUTE }).tick()

    expect(lastRunAtAtFireTime).toBe(5 * MINUTE)
  })

  it('does not double-fire on a back-to-back tick', async () => {
    const reg = await freshRegistry()
    await reg.create(everyMinute())
    const { dispatcher, fire } = spyDispatcher()
    const scheduler = new RoutineScheduler(dispatcher, {
      now: () => 5 * MINUTE,
    })

    await scheduler.tick()
    await scheduler.tick()

    expect(fire).toHaveBeenCalledTimes(1)
  })

  it('skips the fire when the lastRunAt write fails', async () => {
    const reg = await freshRegistry()
    await reg.create(everyMinute())
    vi.spyOn(reg, 'update').mockRejectedValueOnce(new Error('disk full'))
    const { dispatcher, fire } = spyDispatcher()
    const logEvent = vi.fn()

    await new RoutineScheduler(dispatcher, {
      now: () => 5 * MINUTE,
      logEvent,
    }).tick()

    // Firing without the write would re-fire on every subsequent tick.
    expect(fire).not.toHaveBeenCalled()
    expect(logEvent).toHaveBeenCalledWith(
      'nexus_routine_scheduler_persist_failed',
      expect.objectContaining({ routineId: 'rt_tick_1' }),
    )
  })

  it('a skipped prepare leaves the slot UNCONSUMED — fires do not accumulate', async () => {
    // A busy target means the tick does nothing at all, so N missed slots
    // collapse into ONE fire once the session frees up. Enqueueing on every
    // due tick instead would stack a 5-minute loop into six identical
    // hidden turns across a 30-minute turn.
    const reg = await freshRegistry()
    await reg.create(everyMinute())
    const fire = vi.fn()
    let ready = false
    const dispatcher: RoutineFireDispatcher = {
      prepare: () => (ready ? 'fire' : 'skip'),
      fire,
    }

    let now = 5 * MINUTE
    const scheduler = new RoutineScheduler(dispatcher, { now: () => now })

    // Six ticks while the session is busy.
    for (let i = 0; i < 6; i++) {
      await scheduler.tick()
      now += 30_000
    }
    expect(fire).not.toHaveBeenCalled()
    // Crucially the slot was never consumed, so the routine is still due.
    expect(reg.get('rt_tick_1')?.lastRunAt).toBeUndefined()

    // Session goes idle: exactly ONE fire, not six.
    ready = true
    await scheduler.tick()
    expect(fire).toHaveBeenCalledTimes(1)
    expect(reg.get('rt_tick_1')?.lastRunAt).toBe(now)
  })

  it('ignores disabled routines', async () => {
    const reg = await freshRegistry()
    await reg.create(everyMinute({ enabled: false }))
    const { dispatcher, fire } = spyDispatcher()

    await new RoutineScheduler(dispatcher, { now: () => 5 * MINUTE }).tick()

    expect(fire).not.toHaveBeenCalled()
  })

  it('is a no-op when the registry has not booted', async () => {
    setRoutineRegistry(null)
    const { dispatcher, fire } = spyDispatcher()

    await expect(
      new RoutineScheduler(dispatcher, { now: () => 5 * MINUTE }).tick(),
    ).resolves.toBeUndefined()
    expect(fire).not.toHaveBeenCalled()
  })
})
