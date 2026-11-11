/**
 * Provider mods (F-27): the runner behind a status view's action. It answers
 * when the scheduler took or refused the run, maps each refusal to an
 * outcome, and reports an accepted run's end once.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { PROVIDER_JOB_MANUAL_GAP_MS, createProviderJobScheduler } from '../mods/provider/providerJobScheduler'
import { providerJobRunnerOf } from '../mods/provider/providerJobRunnerAdapter'
import { runProviderJobNow, setProviderJobRunner } from '../mods/provider/providerJobSeam'

const ID = 'mod.acme.zen'
const START = 1_800_000_000_000

function world(options: { connected?: boolean } = {}) {
  const finishers: Array<() => void> = []
  const scheduler = createProviderJobScheduler({
    providers: () => [{ providerId: ID, jobs: [{ id: 'probe', everyMs: 30 * 60_000 }] }],
    connected: () => options.connected ?? true,
    ready: () => true,
    online: () => true,
    random: () => 0,
    report: () => undefined,
    run: () => new Promise<boolean>(resolve => finishers.push(() => resolve(true))),
  })
  const settled: string[] = []
  const runner = providerJobRunnerOf(scheduler, providerId => settled.push(providerId))
  return { scheduler, runner, settled, finishers }
}

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(START)
})

afterEach(() => {
  setProviderJobRunner(undefined)
  vi.useRealTimers()
})

describe('providerJobRunnerOf', () => {
  it('answers started while the run is still going, and reports its end once', async () => {
    const { runner, settled, finishers, scheduler } = world()
    await expect(runner(ID, 'probe')).resolves.toBe('started')
    expect(finishers).toHaveLength(1)
    expect(settled).toEqual([])
    finishers[0]!()
    await vi.advanceTimersByTimeAsync(0)
    expect(settled).toEqual([ID])
    scheduler.dispose()
  })

  it('answers busy for a job already running and starts nothing more', async () => {
    const { runner, finishers, scheduler } = world()
    await runner(ID, 'probe')
    await expect(runner(ID, 'probe')).resolves.toBe('busy')
    expect(finishers).toHaveLength(1)
    scheduler.dispose()
  })

  it('answers cooldown for a second manual run inside the gap, started after it', async () => {
    const { runner, finishers, scheduler } = world()
    await runner(ID, 'probe')
    finishers[0]!()
    await vi.advanceTimersByTimeAsync(0)
    await expect(runner(ID, 'probe')).resolves.toBe('cooldown')
    await vi.advanceTimersByTimeAsync(PROVIDER_JOB_MANUAL_GAP_MS)
    await expect(runner(ID, 'probe')).resolves.toBe('started')
    scheduler.dispose()
  })

  it('answers unavailable for an undeclared job and for a provider not set up', async () => {
    const declared = world()
    await expect(declared.runner(ID, 'other')).resolves.toBe('unavailable')
    expect(declared.finishers).toHaveLength(0)
    declared.scheduler.dispose()

    const off = world({ connected: false })
    await expect(off.runner(ID, 'probe')).resolves.toBe('unavailable')
    expect(off.settled).toEqual([])
    off.scheduler.dispose()
  })

  it('is what the seam reaches once installed, and the seam is unavailable without it', async () => {
    const { runner, scheduler } = world()
    await expect(runProviderJobNow(ID, 'probe')).resolves.toBe('unavailable')
    setProviderJobRunner(runner)
    await expect(runProviderJobNow(ID, 'probe')).resolves.toBe('started')
    scheduler.dispose()
  })
})
