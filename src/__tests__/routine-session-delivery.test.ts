/**
 * Session-delivered routines, the dispatcher / runner half: a fire is a fresh headless agent (default) or a hidden
 * turn in an existing session (`RoutineDelivery.mode === 'session'`). Pins the routing, the three delivery verdicts,
 * and that the headless path is unchanged.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { RuntimeFs } from '../utils/fs/runtimeFs'
import {
  RoutineRegistry,
  setRoutineRegistry,
} from '../routines/RoutineRegistry'
import { createRoutineFireDispatcher } from '../routines/RoutineFireDispatcher'
import type { HeadlessRunner } from '../routines/HeadlessRunner'
import {
  SessionDeliveryRunner,
  type DeliverRoutineToSession,
  type SessionDeliverySeam,
} from '../routines/SessionDeliveryRunner'
import { ensureNightlyTidyCron } from '../routines/nightlyTidyCron'
import type { CronRoutine, Routine } from '../routines/routineTypes'

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

function cronRoutine(over: Partial<CronRoutine> = {}): CronRoutine {
  return {
    kind: 'cron',
    id: 'rt_test_1',
    name: 'test-routine',
    schedule: '*/5 * * * *',
    prompt: 'check the deploy',
    notifyOn: 'on_error',
    createdAt: 1000,
    createdBySessionId: 'sess-A',
    enabled: true,
    ...over,
  }
}

/** Minimal HeadlessRunner stand-in — only `enqueue` is ever reached. */
function headlessSpy() {
  const enqueue = vi.fn()
  return { runner: { enqueue } as unknown as HeadlessRunner, enqueue }
}

beforeEach(() => {
  setRoutineRegistry(null)
})

describe('RoutineFireDispatcher — routing by delivery mode', () => {
  it('routes a routine with NO delivery field to the headless runner', () => {
    const { runner, enqueue } = headlessSpy()
    const deliver = vi.fn<DeliverRoutineToSession>()
    const dispatcher = createRoutineFireDispatcher({
      headless: runner,
      session: new SessionDeliveryRunner(deliver, () => 'ready'),
    })

    const routine = cronRoutine()
    dispatcher.fire(routine)

    expect(enqueue).toHaveBeenCalledWith(routine)
    expect(deliver).not.toHaveBeenCalled()
  })

  it('routes an explicit headless routine to the headless runner', () => {
    const { runner, enqueue } = headlessSpy()
    const deliver = vi.fn<DeliverRoutineToSession>()
    const dispatcher = createRoutineFireDispatcher({
      headless: runner,
      session: new SessionDeliveryRunner(deliver, () => 'ready'),
    })

    dispatcher.fire(cronRoutine({ delivery: { mode: 'headless' } }))

    expect(enqueue).toHaveBeenCalledTimes(1)
    expect(deliver).not.toHaveBeenCalled()
  })

  it('REGRESSION: the daily-log nightly tidy cron still goes headless', async () => {
    // The whole point of making `delivery` optional. If this ever routes to
    // the session seam, every pre-existing routine broke.
    const reg = await freshRegistry()
    await ensureNightlyTidyCron({ registry: reg })
    const tidy = reg.list({ kind: 'cron' })[0]!
    expect(tidy.delivery).toBeUndefined()

    const { runner, enqueue } = headlessSpy()
    const deliver = vi.fn<DeliverRoutineToSession>()
    createRoutineFireDispatcher({
      headless: runner,
      session: new SessionDeliveryRunner(deliver, () => 'ready'),
    }).fire(tidy)

    expect(enqueue).toHaveBeenCalledTimes(1)
    expect(deliver).not.toHaveBeenCalled()
  })

  it('routes a session routine to the session seam with its exact target id', () => {
    const { runner, enqueue } = headlessSpy()
    const deliver = vi.fn<DeliverRoutineToSession>(() => 'accepted')
    const dispatcher = createRoutineFireDispatcher({
      headless: runner,
      session: new SessionDeliveryRunner(deliver, () => 'ready'),
    })

    const routine = cronRoutine({
      // Deliberately different from createdBySessionId ('sess-A') so a
      // regression that reads provenance instead of the delivery target
      // fails loudly here.
      delivery: { mode: 'session', sessionId: 'sess-TARGET' },
    })
    dispatcher.fire(routine)

    expect(deliver).toHaveBeenCalledWith({
      sessionId: 'sess-TARGET',
      routine,
    })
    expect(enqueue).not.toHaveBeenCalled()
  })

  it('DEFERS a session fire when no session seam is wired — never falls back to headless', () => {
    const { runner, enqueue } = headlessSpy()
    const logEvent = vi.fn()
    const dispatcher = createRoutineFireDispatcher({
      headless: runner,
      session: null,
      logEvent,
    })
    const routine = cronRoutine({
      delivery: { mode: 'session', sessionId: 's1' },
    })

    // Drive the REAL path the scheduler takes — prepare() first. (An earlier
    // version of this test called fire() directly and so proved nothing
    // about what actually happens on a tick.)
    expect(dispatcher.prepare(routine)).toBe('skip')

    // Not headless: a session-delivered prompt is written to be read next to
    // its conversation, so running it cold would produce a confidently
    // useless answer rather than an obvious failure.
    expect(enqueue).not.toHaveBeenCalled()
    expect(logEvent).toHaveBeenCalledWith(
      'nexus_routine_session_delivery_unavailable',
      expect.objectContaining({ sessionId: 's1' }),
    )
  })

  it('warns ONCE about a missing seam, not on every 30s tick', () => {
    const { runner } = headlessSpy()
    const logEvent = vi.fn()
    const dispatcher = createRoutineFireDispatcher({
      headless: runner,
      session: null,
      logEvent,
    })
    const routine = cronRoutine({
      delivery: { mode: 'session', sessionId: 's1' },
    })

    for (let i = 0; i < 5; i++) expect(dispatcher.prepare(routine)).toBe('skip')

    const warnings = logEvent.mock.calls.filter(
      c => c[0] === 'nexus_routine_session_delivery_unavailable',
    )
    expect(warnings).toHaveLength(1)
  })

  it('a deferred no-seam routine is NOT deleted — another host can still run it', async () => {
    const reg = await freshRegistry()
    const routine = cronRoutine({
      delivery: { mode: 'session', sessionId: 's1' },
    })
    await reg.create(routine)
    const { runner } = headlessSpy()

    createRoutineFireDispatcher({ headless: runner, session: null }).prepare(
      routine,
    )
    await Promise.resolve()

    // The registry is shared across hosts: the browser app will deliver this
    // fine. Destroying a user's routine over a local capability gap would be
    // the wrong call — contrast `session_gone`, where the target is provably
    // deleted and the routine can never run again.
    expect(reg.get(routine.id)).toBeDefined()
    expect(reg.get(routine.id)?.enabled).toBe(true)
  })
})

describe('SessionDeliveryRunner.prepare — the anti-accumulation gate', () => {
  it('ready → fire', () => {
    const runner = new SessionDeliveryRunner(
      () => 'accepted',
      () => 'ready',
    )
    expect(
      runner.prepare(
        cronRoutine({ delivery: { mode: 'session', sessionId: 's1' } }),
      ),
    ).toBe('fire')
  })

  it('busy → skip, so the scheduler leaves the slot unconsumed', () => {
    const logEvent = vi.fn()
    const runner = new SessionDeliveryRunner(
      () => 'accepted',
      () => 'busy',
      { logEvent },
    )
    expect(
      runner.prepare(
        cronRoutine({ delivery: { mode: 'session', sessionId: 's1' } }),
      ),
    ).toBe('skip')
    expect(logEvent).toHaveBeenCalledWith(
      'nexus_routine_session_delivery_deferred',
      expect.objectContaining({ sessionId: 's1' }),
    )
  })

  it('session_gone → skip AND reap, so a dead target is not skipped forever', async () => {
    const reg = await freshRegistry()
    const routine = cronRoutine({
      delivery: { mode: 'session', sessionId: 'sess-DEAD' },
    })
    await reg.create(routine)

    const runner = new SessionDeliveryRunner(
      () => 'accepted',
      () => 'session_gone',
    )
    expect(runner.prepare(routine)).toBe('skip')
    await vi.waitFor(() => expect(reg.get(routine.id)).toBeUndefined())
  })

  it('headless routines always fire — the gate is session-only', () => {
    const runner = new SessionDeliveryRunner(
      () => 'accepted',
      () => 'busy',
    )
    expect(runner.prepare(cronRoutine())).toBe('fire')
    expect(runner.prepare(cronRoutine({ delivery: { mode: 'headless' } }))).toBe(
      'fire',
    )
  })

  it('the probe is REQUIRED — the seam cannot be half-wired', () => {
    // Regression guard for a fail-open default. `canDeliver` once defaulted
    // to `() => 'ready'`, so a host that supplied `deliver` alone got
    // prepare() === 'fire' on every due tick; since deliver deliberately
    // does not check isBusy, fires then piled up on the turn queue — the
    // exact accumulation this class exists to prevent, silently.
    const deps: SessionDeliverySeam = {
      deliver: () => 'accepted',
      canDeliver: () => 'busy',
    }
    // Typed as one object, so `deliver` without `canDeliver` is a compile
    // error rather than a runtime surprise. Behaviourally: the probe is
    // honoured, not bypassed.
    const runner = new SessionDeliveryRunner(deps.deliver, deps.canDeliver)
    expect(
      runner.prepare(
        cronRoutine({ delivery: { mode: 'session', sessionId: 's1' } }),
      ),
    ).toBe('skip')
  })

  it('a throwing probe skips rather than consuming the slot', () => {
    const runner = new SessionDeliveryRunner(
      () => 'accepted',
      () => {
        throw new Error('probe blew up')
      },
    )
    expect(
      runner.prepare(
        cronRoutine({ delivery: { mode: 'session', sessionId: 's1' } }),
      ),
    ).toBe('skip')
  })
})

describe('SessionDeliveryRunner — verdict handling', () => {
  it('accepted: routine survives and records lastRunSessionId', async () => {
    const reg = await freshRegistry()
    const routine = cronRoutine({
      delivery: { mode: 'session', sessionId: 'sess-A' },
    })
    await reg.create(routine)

    new SessionDeliveryRunner(() => 'accepted', () => 'ready').enqueue(
      routine,
    )
    await vi.waitFor(() =>
      expect(reg.get(routine.id)?.lastRunSessionId).toBe('sess-A'),
    )
    expect(reg.get(routine.id)).toBeDefined()
    // Deliberately NOT written: the turn's outcome is never observed, so
    // claiming a status would be a lie.
    expect(reg.get(routine.id)?.lastRunStatus).toBeUndefined()
  })

  it('accepted + oneShot: auto-disables, matching the headless runner', async () => {
    const reg = await freshRegistry()
    const routine = cronRoutine({
      oneShot: true,
      delivery: { mode: 'session', sessionId: 'sess-A' },
    })
    await reg.create(routine)

    new SessionDeliveryRunner(() => 'accepted', () => 'ready').enqueue(
      routine,
    )
    await vi.waitFor(() => expect(reg.get(routine.id)?.enabled).toBe(false))
  })

  it('session_gone: DELETES the routine (not merely disables it)', async () => {
    const reg = await freshRegistry()
    const routine = cronRoutine({
      delivery: { mode: 'session', sessionId: 'sess-DEAD' },
    })
    await reg.create(routine)

    new SessionDeliveryRunner(() => 'session_gone', () => 'ready').enqueue(
      routine,
    )

    // Delete, not disable: a disabled routine with a dead target is
    // un-resumable — re-enabling it would just re-fail on the next tick.
    await vi.waitFor(() => expect(reg.get(routine.id)).toBeUndefined())
    expect(reg.list({ kind: 'cron' })).toHaveLength(0)
  })

  it('busy_ask: skips the slot without deleting or writing a status', async () => {
    const reg = await freshRegistry()
    const routine = cronRoutine({
      delivery: { mode: 'session', sessionId: 'sess-A' },
    })
    await reg.create(routine)

    new SessionDeliveryRunner(() => 'busy_ask', () => 'ready').enqueue(routine)
    await Promise.resolve()

    // The session is parked on a permission prompt. Retry at the next cron
    // slot rather than queueing a backlog of identical stale prompts.
    expect(reg.get(routine.id)).toBeDefined()
    expect(reg.get(routine.id)?.lastRunSessionId).toBeUndefined()
    expect(reg.get(routine.id)?.enabled).toBe(true)
  })

  it('a throwing seam is contained — the routine is left intact', async () => {
    const reg = await freshRegistry()
    const routine = cronRoutine({
      delivery: { mode: 'session', sessionId: 'sess-A' },
    })
    await reg.create(routine)
    const logEvent = vi.fn()

    expect(() =>
      new SessionDeliveryRunner(
        () => {
          throw new Error('boom')
        },
        () => 'ready',
        { logEvent },
      ).enqueue(routine),
    ).not.toThrow()

    expect(reg.get(routine.id)).toBeDefined()
    expect(logEvent).toHaveBeenCalledWith(
      'nexus_routine_session_delivery_failed',
      expect.objectContaining({ error: 'boom' }),
    )
  })

  it('ignores a routine that is not session-delivered (defensive)', () => {
    const deliver = vi.fn<DeliverRoutineToSession>()
    new SessionDeliveryRunner(deliver, () => 'ready').enqueue(
      cronRoutine() as Routine,
    )
    expect(deliver).not.toHaveBeenCalled()
  })
})
