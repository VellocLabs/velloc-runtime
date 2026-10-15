// TaskControlSurface — stopping a background shell reports the kill's OUTCOME.
// BackgroundShellCoordinator.stop is asynchronous and can resolve stop_failed
// (no transport / kill rejected), stop_pending (the process outlived the
// confirm window) or not_found; `stopAndWait` and the drawer's `task.stop`
// reply surface that instead of answering `stopped` at request time.

import { describe, expect, it, vi } from 'vitest'
import { TaskRegistry } from '../browser/worker/TaskRegistry'
import { TaskControlSurface } from '../browser/worker/TaskControlSurface'
import type {
  BackgroundShellRunState,
  BackgroundShellStopStatus,
  FinishedBackgroundShellRecord,
} from '../browser/worker/BackgroundShellCoordinator'
import type {
  NexusFinishedTaskRecord,
  NexusTaskState,
} from '../browser/worker/taskTypes'

function liveShell(shellId: string): BackgroundShellRunState {
  return {
    type: 'local_bash',
    taskId: shellId,
    shellId,
    spawnerSessionId: 'sess-A',
    command: 'sleep 100',
    outputFilePath: null,
    startedAt: 1000,
    lastActivityAt: 1000,
    output: '',
    polls: 0,
    pollFailures: 0,
    lastPollError: '',
    pollHandle: null,
    finalized: false,
  }
}

function setup(stopOutcome: BackgroundShellStopStatus) {
  const registry = new TaskRegistry<NexusTaskState, NexusFinishedTaskRecord>()
  const stop = vi.fn(async (shellId: string): Promise<BackgroundShellStopStatus> => {
    // A failed / pending kill leaves the run live; a confirmed one reaps it.
    if (stopOutcome === 'stopped') {
      const run = registry.getLiveByType(shellId, 'local_bash') as BackgroundShellRunState
      const record: FinishedBackgroundShellRecord = {
        type: 'local_bash',
        taskId: run.taskId,
        shellId: run.shellId,
        spawnerSessionId: run.spawnerSessionId,
        command: run.command,
        outputFilePath: run.outputFilePath,
        status: 'stopped',
        summary: 'killed',
        startedAt: run.startedAt,
        finishedAt: 2000,
      }
      registry.recordFinished(shellId, record)
    }
    return stopOutcome
  })
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const stub = {} as any
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const shells = { stop, stopChildren: vi.fn(), acknowledgeResult: vi.fn() } as any
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const delivery = { dropParent: vi.fn(), acknowledge: vi.fn() } as any
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const routines = { get: () => undefined, has: () => false } as any
  const surface = new TaskControlSurface(
    registry,
    stub,
    shells,
    stub,
    routines,
    delivery,
    { getStorage: () => null, dropSessionRouting: () => {}, scheduleSummary: () => {} },
  )
  registry.registerLive('shell-1', liveShell('shell-1'))
  return { registry, surface, stop }
}

describe('TaskControlSurface.stopAndWait — background shells', () => {
  it('reports a confirmed kill as stopped with the command', async () => {
    const { surface, stop } = setup('stopped')
    await expect(surface.stopAndWait('shell-1')).resolves.toEqual({
      status: 'stopped',
      description: 'sleep 100',
    })
    expect(stop).toHaveBeenCalledWith('shell-1')
  })

  it.each(['stop_failed', 'stop_pending', 'not_found'] as const)(
    'surfaces a %s kill outcome instead of claiming stopped',
    async outcome => {
      const { surface } = setup(outcome)
      await expect(surface.stopAndWait('shell-1')).resolves.toEqual({
        status: outcome,
        description: 'sleep 100',
      })
    },
  )

  it('a finished shell answers already_finished; an unknown id not_found', async () => {
    const { surface, stop } = setup('stopped')
    await surface.stopAndWait('shell-1')
    stop.mockClear()
    await expect(surface.stopAndWait('shell-1')).resolves.toMatchObject({
      status: 'already_finished',
      description: 'sleep 100',
    })
    await expect(surface.stopAndWait('nope')).resolves.toEqual({ status: 'not_found' })
    expect(stop).not.toHaveBeenCalled()
  })

  it('the drawer task.stop ack carries the awaited outcome', async () => {
    const { surface } = setup('stop_failed')
    const posted: unknown[] = []
    const port = { postMessage: (m: unknown) => posted.push(m) } as unknown as MessagePort
    surface.handleDrawerStop(port, {
      type: 'task.stop',
      sessionId: 'shell-1',
      requestId: 'req-1',
    })
    await vi.waitFor(() => expect(posted).toHaveLength(1))
    expect(posted[0]).toEqual({
      type: 'task.stopped',
      payload: { sessionId: 'shell-1', status: 'stop_failed', requestId: 'req-1' },
    })
  })
})
