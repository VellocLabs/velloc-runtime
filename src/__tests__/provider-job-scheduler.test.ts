/**
 * Provider mods (F-27): the job scheduler. When a declared job is raised and
 * when it is not, one run at a time, the queue across providers, back-off
 * after a failure, the wall-clock bound, and the run-now entry point.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  PROVIDER_JOB_MANUAL_GAP_MS,
  PROVIDER_JOB_WALL_MS,
  createProviderJobScheduler,
  providerJobStates,
  runProviderJobNow,
  setProviderJobScheduler,
  type ProviderJobEvent,
  type ProviderJobSource,
} from '../mods/provider/providerJobScheduler'
import type { ProviderJobDecl } from '../mods/provider/providerJobsManifest'
import { followProviderRegistrations, raiseProviderJob } from '../mods/provider/providerModRuntimeFactory'
import { disposeProviderModBoot } from '../mods/provider/providerModBoot'

const MIN = 60_000
const START = 1_800_000_000_000

type Call = {
  providerId: string
  e: ProviderJobEvent
  budgetMs: number
  signal: AbortSignal
  finish: (raised?: boolean) => void
  fail: (message: string) => void
}

function world(
  initial: Record<string, ProviderJobDecl[]>,
  options: { connected?: string[]; hold?: boolean; wallMs?: number } = {},
) {
  const sources = new Map<string, ProviderJobDecl[]>(Object.entries(initial))
  const connected = new Set(options.connected ?? Object.keys(initial))
  const calls: Call[] = []
  const reports: string[] = []
  const state = { ready: true, online: true, hold: options.hold ?? false, outcome: 'ran' as 'ran' | 'fail' | 'no-hook' }
  const scheduler = createProviderJobScheduler({
    providers: (): ProviderJobSource[] => [...sources].map(([providerId, jobs]) => ({ providerId, jobs })),
    connected: id => connected.has(id),
    ready: () => state.ready,
    online: () => state.online,
    random: () => 0,
    report: line => reports.push(line),
    ...(options.wallMs !== undefined ? { wallMs: options.wallMs } : {}),
    run: (providerId, e, { budgetMs, signal }) =>
      new Promise<boolean>((resolve, reject) => {
        const call: Call = {
          providerId,
          e,
          budgetMs,
          signal,
          finish: (raised = true) => resolve(raised),
          fail: message => reject(new Error(message)),
        }
        calls.push(call)
        if (state.hold) return
        if (state.outcome === 'fail') call.fail('boom')
        else call.finish(state.outcome === 'ran')
      }),
  })
  return { scheduler, sources, connected, calls, reports, state }
}

const names = (calls: Call[]): string[] => calls.map(c => `${c.providerId}/${c.e.job}/${c.e.reason}`)
const flush = (): Promise<unknown> => vi.advanceTimersByTimeAsync(0)

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(START)
})
afterEach(() => {
  setProviderJobScheduler(undefined)
  vi.useRealTimers()
})

describe('the provider job scheduler', () => {
  it('raises a job when its interval has passed, and not before', async () => {
    const { scheduler, calls } = world({ 'mod.acme.zen': [{ id: 'probe', everyMs: 30 * MIN, budgetMs: 15_000 }] })
    scheduler.sync()
    await flush()
    // A provider that was already set up waits for its period.
    expect(calls).toHaveLength(0)
    await vi.advanceTimersByTimeAsync(30 * MIN - 1)
    expect(calls).toHaveLength(0)
    await vi.advanceTimersByTimeAsync(1)
    expect(names(calls)).toEqual(['mod.acme.zen/probe/schedule'])
    expect(calls[0]!.e).toEqual({ job: 'probe', reason: 'schedule', scheduledAt: START + 30 * MIN })
    expect(calls[0]!.budgetMs).toBe(15_000)
    await vi.advanceTimersByTimeAsync(30 * MIN)
    expect(calls).toHaveLength(2)
    expect(calls[1]!.e.lastRunAt).toBe(START + 30 * MIN)
  })

  it('spreads each period by up to a tenth', async () => {
    const ran: number[] = []
    const scheduler = createProviderJobScheduler({
      providers: () => [{ providerId: 'mod.acme.zen', jobs: [{ id: 'probe', everyMs: 10 * MIN }] }],
      connected: () => true,
      random: () => 0.999,
      report: () => {},
      run: async () => {
        ran.push(Date.now() - START)
        return true
      },
    })
    scheduler.sync()
    await vi.advanceTimersByTimeAsync(10 * MIN)
    expect(ran).toEqual([])
    await vi.advanceTimersByTimeAsync(MIN)
    expect(ran).toHaveLength(1)
    expect(ran[0]).toBeGreaterThan(10 * MIN)
    expect(ran[0]).toBeLessThanOrEqual(11 * MIN)
    scheduler.dispose()
  })

  it('holds a declared interval and budget to the range and says so once', async () => {
    const { scheduler, calls, reports } = world({ 'mod.acme.zen': [{ id: 'eager', everyMs: 1_000, budgetMs: 600_000 }] })
    scheduler.sync()
    scheduler.sync()
    await vi.advanceTimersByTimeAsync(5 * MIN - 1)
    expect(calls).toHaveLength(0)
    await vi.advanceTimersByTimeAsync(1)
    expect(calls).toHaveLength(1)
    expect(calls[0]!.budgetMs).toBe(60_000)
    expect(reports.filter(line => line.includes('outside the platform'))).toHaveLength(1)
  })

  it('never runs a job twice at once: a run still going skips the next one', async () => {
    const { scheduler, calls, reports } = world(
      { 'mod.acme.zen': [{ id: 'probe', everyMs: 5 * MIN }] },
      { hold: true, wallMs: 60 * MIN },
    )
    scheduler.sync()
    await vi.advanceTimersByTimeAsync(5 * MIN)
    expect(calls).toHaveLength(1)
    await vi.advanceTimersByTimeAsync(5 * MIN)
    expect(calls).toHaveLength(1)
    expect(reports).toContain('mod.acme.zen: job "probe" is still running; this run is skipped')
    await expect(scheduler.runNow('mod.acme.zen', 'probe')).resolves.toEqual({ status: 'refused', reason: 'busy' })
    calls[0]!.finish()
    await vi.advanceTimersByTimeAsync(5 * MIN)
    expect(calls).toHaveLength(2)
  })

  it('runs one job at a time in a provider and two providers at once', async () => {
    const two = [
      { id: 'a', everyMs: 5 * MIN },
      { id: 'b', everyMs: 5 * MIN },
    ]
    const { scheduler, calls } = world(
      {
        'mod.acme.one': two,
        'mod.acme.two': [{ id: 'a', everyMs: 5 * MIN }],
        'mod.acme.three': [{ id: 'a', everyMs: 5 * MIN }],
      },
      { hold: true },
    )
    scheduler.sync()
    await vi.advanceTimersByTimeAsync(5 * MIN)
    expect(names(calls)).toEqual(['mod.acme.one/a/schedule', 'mod.acme.two/a/schedule'])
    calls[0]!.finish()
    await flush()
    // The freed slot goes to the first job in line whose provider is not running one.
    expect(names(calls).slice(2)).toEqual(['mod.acme.one/b/schedule'])
    calls[1]!.finish()
    await flush()
    expect(names(calls).slice(3)).toEqual(['mod.acme.three/a/schedule'])
  })

  it('runs nothing for a provider that is not set up, removed, or before the set-up state is known', async () => {
    const { scheduler, calls, connected, sources, state } = world(
      { 'mod.acme.zen': [{ id: 'probe', everyMs: 5 * MIN }], 'mod.acme.off': [{ id: 'probe', everyMs: 5 * MIN }] },
      { connected: ['mod.acme.zen'] },
    )
    state.ready = false
    scheduler.sync()
    await vi.advanceTimersByTimeAsync(20 * MIN)
    expect(calls).toHaveLength(0)
    state.ready = true
    scheduler.sync()
    await vi.advanceTimersByTimeAsync(5 * MIN)
    expect(names(calls)).toEqual(['mod.acme.zen/probe/schedule'])
    await expect(scheduler.runNow('mod.acme.off', 'probe')).resolves.toEqual({ status: 'refused', reason: 'not_connected' })

    // Signed out without a sync in between: the due run is dropped.
    connected.delete('mod.acme.zen')
    await vi.advanceTimersByTimeAsync(20 * MIN)
    expect(calls).toHaveLength(1)
    connected.add('mod.acme.zen')
    scheduler.sync()
    await vi.advanceTimersByTimeAsync(5 * MIN)
    expect(calls).toHaveLength(2)

    // Disabled or uninstalled: the registration is gone.
    sources.delete('mod.acme.zen')
    scheduler.sync()
    await vi.advanceTimersByTimeAsync(60 * MIN)
    expect(calls).toHaveLength(2)
    expect(scheduler.states('mod.acme.zen')).toEqual([])
    await expect(scheduler.runNow('mod.acme.zen', 'probe')).resolves.toEqual({ status: 'refused', reason: 'unknown_job' })
  })

  it('runs a connect job once when the provider becomes set up, not at start and not for other jobs', async () => {
    const jobs: ProviderJobDecl[] = [
      { id: 'probe', everyMs: 30 * MIN, runOn: ['connect'] },
      { id: 'sweep', everyMs: 30 * MIN },
    ]
    const { scheduler, calls, connected } = world({ 'mod.acme.zen': jobs, 'mod.acme.old': jobs }, { connected: ['mod.acme.old'] })
    scheduler.sync()
    await flush()
    expect(calls).toHaveLength(0)
    connected.add('mod.acme.zen')
    scheduler.sync()
    scheduler.sync()
    await flush()
    expect(names(calls)).toEqual(['mod.acme.zen/probe/connect'])
    expect(calls[0]!.e.scheduledAt).toBe(START)
  })

  it('a job that needs the network waits for it', async () => {
    const { scheduler, calls, state } = world({ 'mod.acme.zen': [{ id: 'probe', everyMs: 5 * MIN, requires: ['online'] }] })
    state.online = false
    scheduler.sync()
    await vi.advanceTimersByTimeAsync(5 * MIN)
    expect(calls).toHaveLength(0)
    await expect(scheduler.runNow('mod.acme.zen', 'probe')).resolves.toEqual({ status: 'refused', reason: 'offline' })
    state.online = true
    await vi.advanceTimersByTimeAsync(MIN)
    expect(names(calls)).toEqual(['mod.acme.zen/probe/schedule'])
    expect(calls[0]!.e.scheduledAt).toBe(START + 5 * MIN)
    expect(scheduler.states('mod.acme.zen')[0]).toMatchObject({ nextRunAt: START + 11 * MIN })
  })

  it('a failed run is reported and pushes the next one back; a good run restores the interval', async () => {
    const { scheduler, calls, reports, state } = world({ 'mod.acme.zen': [{ id: 'probe', everyMs: 10 * MIN }] })
    state.outcome = 'fail'
    scheduler.sync()
    await vi.advanceTimersByTimeAsync(10 * MIN)
    expect(calls).toHaveLength(1)
    expect(reports).toContain('mod.acme.zen: job "probe" failed (1 in a row): boom')
    expect(scheduler.states('mod.acme.zen')[0]).toMatchObject({ lastResult: 'failed', nextRunAt: START + 30 * MIN })
    await vi.advanceTimersByTimeAsync(19 * MIN)
    expect(calls).toHaveLength(1)
    state.outcome = 'ran'
    await vi.advanceTimersByTimeAsync(MIN)
    expect(calls).toHaveLength(2)
    expect(scheduler.states('mod.acme.zen')[0]).toMatchObject({ lastResult: 'ran', nextRunAt: START + 40 * MIN })
  })

  it('gives up a run at the wall-clock bound and frees the job', async () => {
    const { scheduler, calls, reports } = world({ 'mod.acme.zen': [{ id: 'probe', everyMs: 30 * MIN }] }, { hold: true })
    scheduler.sync()
    await vi.advanceTimersByTimeAsync(30 * MIN)
    expect(calls).toHaveLength(1)
    expect(calls[0]!.signal.aborted).toBe(false)
    await vi.advanceTimersByTimeAsync(PROVIDER_JOB_WALL_MS)
    expect(calls[0]!.signal.aborted).toBe(true)
    expect(reports).toContain(`mod.acme.zen: job "probe" failed (1 in a row): not finished within ${PROVIDER_JOB_WALL_MS} ms`)
    expect(scheduler.states('mod.acme.zen')[0]).toMatchObject({ busy: false, lastResult: 'failed' })
  })

  it('stops waking a module that does not hook the event', async () => {
    const { scheduler, calls, reports, state } = world({
      'mod.acme.zen': [
        { id: 'a', everyMs: 5 * MIN },
        { id: 'b', everyMs: 7 * MIN },
      ],
    })
    state.outcome = 'no-hook'
    scheduler.sync()
    await vi.advanceTimersByTimeAsync(60 * MIN)
    expect(calls).toHaveLength(1)
    expect(reports.filter(line => line.includes('does not hook provider.job'))).toHaveLength(1)
    await expect(scheduler.runNow('mod.acme.zen', 'b')).resolves.toEqual({ status: 'refused', reason: 'no_hook' })
  })

  it('run now: raises the job as manual, leaves the schedule alone, and holds a gap between two', async () => {
    const { scheduler, calls } = world({ 'mod.acme.zen': [{ id: 'probe', everyMs: 30 * MIN, budgetMs: 5_000 }] })
    setProviderJobScheduler(scheduler)
    // The entry point syncs for a provider it has not looked at yet.
    await expect(runProviderJobNow('mod.acme.zen', 'probe')).resolves.toEqual({ status: 'ran' })
    expect(calls[0]!.e).toEqual({ job: 'probe', reason: 'manual', scheduledAt: START })
    expect(calls[0]!.budgetMs).toBe(5_000)
    expect(providerJobStates('mod.acme.zen')).toEqual([
      {
        id: 'probe',
        busy: false,
        lastRunAt: START,
        lastResult: 'ran',
        nextRunAt: START + 30 * MIN,
        manualFrom: START + PROVIDER_JOB_MANUAL_GAP_MS,
      },
    ])
    await vi.advanceTimersByTimeAsync(PROVIDER_JOB_MANUAL_GAP_MS - 1)
    await expect(runProviderJobNow('mod.acme.zen', 'probe')).resolves.toEqual({ status: 'refused', reason: 'too_soon' })
    await vi.advanceTimersByTimeAsync(1)
    await expect(runProviderJobNow('mod.acme.zen', 'probe')).resolves.toEqual({ status: 'ran' })
    await expect(runProviderJobNow('mod.acme.zen', 'nope')).resolves.toEqual({ status: 'refused', reason: 'unknown_job' })
    expect(calls).toHaveLength(2)
    await vi.advanceTimersByTimeAsync(30 * MIN)
    expect(names(calls).slice(2)).toEqual(['mod.acme.zen/probe/schedule'])
  })

  it('run now: a failure is the result, never a rejection; without a scheduler every job is unknown', async () => {
    const { scheduler, state } = world({ 'mod.acme.zen': [{ id: 'probe', everyMs: 30 * MIN }] })
    state.outcome = 'fail'
    await expect(scheduler.runNow('mod.acme.zen', 'probe')).resolves.toEqual({ status: 'failed', message: 'boom' })
    scheduler.dispose()
    await expect(scheduler.runNow('mod.acme.zen', 'probe')).resolves.toEqual({ status: 'refused', reason: 'unknown_job' })
    setProviderJobScheduler(undefined)
    await expect(runProviderJobNow('mod.acme.zen', 'probe')).resolves.toEqual({ status: 'refused', reason: 'unknown_job' })
    expect(providerJobStates('mod.acme.zen')).toEqual([])
  })

  it('a provider registered again keeps its jobs\' state, and a module found without the hook is tried again', async () => {
    const decl: ProviderJobDecl = { id: 'probe', everyMs: 10 * MIN }
    const { scheduler, sources, calls, state } = world({ 'mod.acme.zen': [decl] })
    state.outcome = 'fail'
    scheduler.sync()
    await vi.advanceTimersByTimeAsync(10 * MIN)
    expect(calls).toHaveLength(1)
    const before = scheduler.states('mod.acme.zen')[0]
    expect(before).toMatchObject({ lastResult: 'failed', nextRunAt: START + 30 * MIN })
    sources.set('mod.acme.zen', [{ ...decl }])
    scheduler.sync()
    expect(scheduler.states('mod.acme.zen')[0]).toEqual(before)

    state.outcome = 'no-hook'
    await expect(scheduler.runNow('mod.acme.zen', 'probe')).resolves.toEqual({ status: 'refused', reason: 'no_hook' })
    await vi.advanceTimersByTimeAsync(PROVIDER_JOB_MANUAL_GAP_MS)
    await expect(scheduler.runNow('mod.acme.zen', 'probe')).resolves.toEqual({ status: 'refused', reason: 'no_hook' })
    expect(calls).toHaveLength(2)
    sources.set('mod.acme.zen', [{ ...decl }])
    scheduler.sync()
    state.outcome = 'ran'
    await expect(scheduler.runNow('mod.acme.zen', 'probe')).resolves.toEqual({ status: 'ran' })
  })

  it('a job whose declaration changes while it runs stays busy until that run ends', async () => {
    const { scheduler, sources, calls } = world({ 'mod.acme.zen': [{ id: 'probe', everyMs: 10 * MIN }] }, { hold: true })
    scheduler.sync()
    await vi.advanceTimersByTimeAsync(10 * MIN)
    expect(calls).toHaveLength(1)
    sources.set('mod.acme.zen', [{ id: 'probe', everyMs: 20 * MIN }])
    scheduler.sync()
    await expect(scheduler.runNow('mod.acme.zen', 'probe')).resolves.toEqual({ status: 'refused', reason: 'busy' })
    calls[0]!.finish()
    await flush()
    expect(scheduler.states('mod.acme.zen')[0]).toMatchObject({ busy: false, lastResult: 'ran' })
    expect(calls).toHaveLength(1)
  })

  it('disposing abandons a run that is still going', async () => {
    const { scheduler, calls } = world({ 'mod.acme.zen': [{ id: 'probe', everyMs: 5 * MIN }] }, { hold: true })
    scheduler.sync()
    await vi.advanceTimersByTimeAsync(5 * MIN)
    expect(calls[0]!.signal.aborted).toBe(false)
    scheduler.dispose()
    expect(calls[0]!.signal.aborted).toBe(true)
  })

  it('a plugin swapped in place keeps its jobs\' state; a removed one loses its jobs', async () => {
    const decl: ProviderJobDecl = { id: 'probe', everyMs: 10 * MIN }
    const { scheduler, sources, state } = world({ 'mod.acme.zen': [decl] })
    let listener: (() => () => void) | undefined
    followProviderRegistrations(scheduler, l => {
      listener = l
      return () => undefined
    })
    let cleanup = listener!()
    state.outcome = 'fail'
    await vi.advanceTimersByTimeAsync(10 * MIN)
    const before = scheduler.states('mod.acme.zen')[0]
    expect(before).toMatchObject({ lastResult: 'failed' })
    // As the host swaps a plugin: detach, then attach, with no await between.
    sources.delete('mod.acme.zen')
    cleanup()
    sources.set('mod.acme.zen', [{ ...decl }])
    cleanup = listener!()
    await flush()
    expect(scheduler.states('mod.acme.zen')[0]).toEqual(before)
    sources.delete('mod.acme.zen')
    cleanup()
    await flush()
    expect(scheduler.states('mod.acme.zen')).toEqual([])
  })

  it('the boot going away disposes the installed scheduler', async () => {
    const { scheduler, calls } = world({ 'mod.acme.zen': [{ id: 'probe', everyMs: 5 * MIN }] })
    setProviderJobScheduler(scheduler)
    scheduler.sync()
    disposeProviderModBoot()
    await vi.advanceTimersByTimeAsync(60 * MIN)
    expect(calls).toHaveLength(0)
    await expect(runProviderJobNow('mod.acme.zen', 'probe')).resolves.toEqual({ status: 'refused', reason: 'unknown_job' })
  })

  it('a disposed scheduler raises nothing more', async () => {
    const { scheduler, calls } = world({ 'mod.acme.zen': [{ id: 'probe', everyMs: 5 * MIN }] })
    scheduler.sync()
    scheduler.dispose()
    scheduler.sync()
    await vi.advanceTimersByTimeAsync(60 * MIN)
    expect(calls).toHaveLength(0)
  })
})

describe('raiseProviderJob', () => {
  const e: ProviderJobEvent = { job: 'probe', reason: 'schedule', scheduledAt: START }
  const options = { budgetMs: 5_000, signal: new AbortController().signal }

  it('passes the job, its budget and the signal to the module call', async () => {
    const seen: unknown[] = []
    const runtime = {
      call: async (...args: unknown[]) => {
        seen.push(args)
        return { raised: true as const, value: undefined }
      },
    }
    await expect(raiseProviderJob(runtime as never, 'mod.acme.zen', e, options)).resolves.toBe(true)
    expect(seen).toEqual([
      ['mod.acme.zen', 'provider.job', e, { signal: options.signal, budgetMs: 5_000, core: expect.any(Function) }],
    ])
  })

  it('answers false for a module without the hook and rejects when the hook gave no answer', async () => {
    const none = { call: async () => ({ raised: false as const }) }
    await expect(raiseProviderJob(none as never, 'mod.acme.zen', e, options)).resolves.toBe(false)
    const failing = {
      call: async (_id: string, _event: string, _e: unknown, o: { core: () => void }) => {
        o.core()
        return { raised: true as const, value: undefined }
      },
    }
    await expect(raiseProviderJob(failing as never, 'mod.acme.zen', e, options)).rejects.toThrow(
      'provider.job hook failed or ran out of time',
    )
  })
})
