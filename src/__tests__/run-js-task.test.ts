/**
 * RunJsWorker (local_js) task surfacing — the SideTaskCoordinator registers a
 * run_js execution and the TaskControlSurface projects it into the drawer's
 * detail (params + JS source + result). The conversation-card + inline rendering
 * is covered in run-js-tool.test.ts (sink emission) and the drawer render test.
 */
import { describe, it, expect } from 'vitest'
import { TaskRegistry } from '../browser/worker/TaskRegistry'
import { SideTaskCoordinator } from '../browser/worker/SideTaskCoordinator'
import { TaskControlSurface } from '../browser/worker/TaskControlSurface'
import type {
  NexusFinishedTaskRecord,
  NexusTaskState,
} from '../browser/worker/taskTypes'

function makeRegistry() {
  return new TaskRegistry<NexusTaskState, NexusFinishedTaskRecord>()
}

function makeCoordinator(
  registry: TaskRegistry<NexusTaskState, NexusFinishedTaskRecord>,
) {
  return new SideTaskCoordinator(registry, {
    scheduleSummary: () => {},
    mintTaskHandle: (prefix) => `${prefix}-x`,
    forkDisplayLabel: () => 'fork',
    fastCallDisplayLabel: () => 'fast',
    runJsDisplayLabel: () => 'Super Edit',
    extractFinalAssistantText: () => '',
    projectSubAgentTranscript: () => [],
    evictFinishedOverCap: (kind, cap) => registry.evictFinishedOverCap(kind, cap),
  })
}

function makeControlSurface(
  registry: TaskRegistry<NexusTaskState, NexusFinishedTaskRecord>,
) {
  // Only the registry (and, for local_js, none of the other coordinators) is
  // touched for a run_js task — pass minimal stubs.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const stub = {} as any
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const routines = { get: () => undefined, has: () => false } as any
  return new TaskControlSurface(registry, stub, stub, stub, routines, stub, {
    getStorage: () => null,
    dropSessionRouting: () => {},
    scheduleSummary: () => {},
  })
}

const START = {
  callId: 'toolu_1',
  spawnerSessionId: 'sess-A',
  description: 'Rename files',
  code: 'return 1 + 1',
  timeoutSec: 30,
  inlineCode: true,
  startedAt: 1000,
}

describe('SideTaskCoordinator — run_js lifecycle', () => {
  it('registers a live local_js task keyed by (and public-indexed as) the call id', () => {
    const registry = makeRegistry()
    makeCoordinator(registry).registerRunJs(START)
    const run = registry.getLiveByType('toolu_1', 'local_js')
    expect(run).toBeDefined()
    // The public task id equals the tool call id (no minted id to correlate).
    expect(run!.taskId).toBe('toolu_1')
    expect(registry.resolveNative('toolu_1')).toBe('toolu_1')
    expect(run!.code).toBe('return 1 + 1')
    expect(run!.description).toBe('Rename files')
  })

  it('falls back to the "Super Edit" label when the model gave no description', () => {
    const registry = makeRegistry()
    makeCoordinator(registry).registerRunJs({ ...START, description: undefined })
    expect(registry.getLiveByType('toolu_1', 'local_js')!.description).toBe('Super Edit')
  })

  it('finishes into a retained record carrying the result text', () => {
    const registry = makeRegistry()
    const coord = makeCoordinator(registry)
    coord.registerRunJs(START)
    coord.finishRunJs({
      callId: 'toolu_1',
      status: 'success',
      resultText: '2\n\n--- console (0) ---',
      finishedAt: 2000,
    })
    expect(registry.getLiveByType('toolu_1', 'local_js')).toBeUndefined()
    const rec = registry.getFinishedByType('toolu_1', 'local_js')
    expect(rec).toMatchObject({ status: 'success', code: 'return 1 + 1' })
    expect(rec!.resultText).toContain('2')
  })
})

describe('TaskControlSurface — run_js detail', () => {
  it('projects a running run_js as params + JS source, no result yet', () => {
    const registry = makeRegistry()
    makeCoordinator(registry).registerRunJs(START)
    const surface = makeControlSurface(registry)
    const info = surface.loadInfo('toolu_1')
    expect(info).toMatchObject({
      type: 'local_js',
      jsSource: 'return 1 + 1',
      jsParams: { description: 'Rename files', timeoutSec: 30, inlineCode: true },
    })
    expect(info!.outputText).toBeUndefined()
  })

  it('projects a finished run_js with its result as outputText', () => {
    const registry = makeRegistry()
    const coord = makeCoordinator(registry)
    coord.registerRunJs(START)
    coord.finishRunJs({
      callId: 'toolu_1',
      status: 'success',
      resultText: 'THE-RESULT',
      finishedAt: 2000,
    })
    const info = makeControlSurface(registry).loadInfo('toolu_1')
    expect(info).toMatchObject({ type: 'local_js', jsSource: 'return 1 + 1' })
    expect(info!.outputText).toBe('THE-RESULT')
  })

  it('recovers a reloaded run_js from the persisted sidecar when the registry is empty', async () => {
    // A reloaded session has an EMPTY registry (the live/finished records only
    // hold runs from the current worker lifetime), so loadInfo is null and the
    // drawer would open empty. loadInfoWithOutput must fall back to the persisted
    // tool-detail sidecar (keyed by the tool call id == the public task id).
    const registry = makeRegistry() // no registerRunJs → simulates a reload
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const stub = {} as any
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const routines = { get: () => undefined, has: () => false } as any
    const surface = new TaskControlSurface(
      registry,
      stub,
      stub,
      stub,
      routines,
      stub,
      {
        getStorage: () => null,
        dropSessionRouting: () => {},
        scheduleSummary: () => {},
        loadRunJsSidecar: async (toolCallId) =>
          toolCallId === 'toolu_reload'
            ? {
                code: 'RELOADED_SOURCE',
                description: 'Old run',
                path: undefined,
                timeoutSec: 45,
                inlineCode: true,
                resultText: 'OLD-RESULT',
              }
            : null,
      },
    )
    // No registry record → the synchronous projection is empty (drawer empty).
    expect(surface.loadInfo('toolu_reload')).toBeNull()
    // The async load recovers it from the sidecar.
    const info = await surface.loadInfoWithOutput('toolu_reload')
    expect(info).toMatchObject({
      type: 'local_js',
      jsSource: 'RELOADED_SOURCE',
      jsParams: { description: 'Old run', timeoutSec: 45, inlineCode: true },
      outputText: 'OLD-RESULT',
    })
    // An id with no run_js sidecar stays null — no phantom detail.
    expect(await surface.loadInfoWithOutput('toolu_missing')).toBeNull()
  })

  it('recovers a reloaded background shell whose transcript kept only {shell_id,status}, from its sidecar', async () => {
    // The real foreground-shell shape persists an inline `{ shell_id, status }`
    // handle with NO output_file — the output lives in the tool-detail sidecar,
    // keyed by the tool-call id (the recovered row's `detailId`). loadRecoveredShell
    // gives the command + detailId; loadRecoveredShellDetail resolves the output.
    const registry = makeRegistry() // reload → empty registry
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const stub = {} as any
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const routines = { get: () => undefined, has: () => false } as any
    const surface = new TaskControlSurface(
      registry,
      stub,
      stub,
      stub,
      routines,
      stub,
      {
        getStorage: () => null,
        dropSessionRouting: () => {},
        scheduleSummary: () => {},
        loadRecoveredShell: (taskId) =>
          taskId === 'bshell1'
            ? { command: 'git status', detailId: 'call_sh', outputFilePath: undefined }
            : null,
        loadRecoveredShellDetail: async (toolCallId) =>
          toolCallId === 'call_sh'
            ? { outputFilePath: undefined, outputText: 'On branch main\nnothing to commit' }
            : null,
      },
    )
    // No registry record → the synchronous projection is empty (drawer empty).
    expect(surface.loadInfo('bshell1')).toBeNull()
    // The async load rebuilds the row's detail + reads its output from the sidecar.
    const info = await surface.loadInfoWithOutput('bshell1')
    expect(info).toMatchObject({
      type: 'local_bash',
      task: 'git status',
      outputText: 'On branch main\nnothing to commit',
    })
    // A recovered shell whose sidecar is gone still yields the row (no output).
    const gone = new TaskControlSurface(registry, stub, stub, stub, routines, stub, {
      getStorage: () => null,
      dropSessionRouting: () => {},
      scheduleSummary: () => {},
      loadRecoveredShell: () => ({ command: 'echo hi', detailId: 'call_missing' }),
      loadRecoveredShellDetail: async () => null,
    })
    const info2 = await gone.loadInfoWithOutput('whatever')
    expect(info2).toMatchObject({ type: 'local_bash', task: 'echo hi' })
    expect(info2?.outputText).toBeUndefined()
  })

  it('has no transcript (the detail is params/source/result, not turns)', async () => {
    const registry = makeRegistry()
    makeCoordinator(registry).registerRunJs(START)
    expect(await makeControlSurface(registry).loadTranscript('toolu_1')).toEqual([])
  })

  it('reports a run_js task as already-finished for a drawer Stop (nothing to stop)', () => {
    const registry = makeRegistry()
    makeCoordinator(registry).registerRunJs(START)
    const surface = makeControlSurface(registry)
    const replies: Array<{ status: string }> = []
    const port = {
      postMessage: (m: { payload: { status: string } }) =>
        replies.push({ status: m.payload.status }),
    } as unknown as MessagePort
    surface.handleDrawerStop(port, {
      type: 'task.stop',
      sessionId: 'toolu_1',
      requestId: 'r1',
    } as never)
    expect(replies[0]!.status).toBe('already_finished')
  })
})
