// `local_supershell` tasks: SuperShellTaskCoordinator + its TaskControlSurface
// dispatch (what TaskOutput / TaskStop / the drawer / the session Stop cascade
// reach), against the real TaskRegistry and the real notification formatter.

import { describe, expect, it, vi } from 'vitest'
import { TaskRegistry } from '../browser/worker/TaskRegistry'
import { TaskControlSurface } from '../browser/worker/TaskControlSurface'
import {
  SUPER_SHELL_DELIVERY_SUMMARY_MAX,
  SuperShellTaskCoordinator,
} from '../browser/worker/SuperShellTaskCoordinator'
import {
  formatTaskNotifications,
  isNextPriorityTaskResult,
} from '../browser/worker/taskProjection'
import type {
  NexusFinishedTaskRecord,
  NexusTaskDeliveryResult,
  NexusTaskState,
} from '../browser/worker/taskTypes'
import { categorizeSubAgentRow } from '../browser/webview/backgroundSubAgents'

function setup() {
  const registry = new TaskRegistry<NexusTaskState, NexusFinishedTaskRecord>()
  const delivered: Array<{ parent: string; result: NexusTaskDeliveryResult }> = []
  const dropPredicates: Array<(r: NexusTaskDeliveryResult) => boolean> = []
  let seq = 0
  const coordinator = new SuperShellTaskCoordinator(registry, {
    scheduleSummary: () => {},
    mintTaskHandle: () => `s${++seq}`,
    deliverResult: (parent, result) => delivered.push({ parent, result }),
    dropPendingResult: pred => dropPredicates.push(pred),
    evictFinishedOverCap: (kind, cap) => registry.evictFinishedOverCap(kind, cap),
  })
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const stub = {} as any
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const shells = { stopChildren: vi.fn(), acknowledgeResult: vi.fn() } as any
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
    coordinator,
  )
  return { registry, coordinator, surface, delivered, dropPredicates }
}

function start(overrides: Record<string, unknown> = {}) {
  return {
    spawnerSessionId: 'sess-A',
    description: 'Typecheck and test',
    code: 'await bash("npx tsc --noEmit")',
    inputs: { wt: 'nexus_web' },
    startedAt: 1000,
    progress: vi.fn(() => 'Steps:\n✓ git add a.ts  exit 0  0.2s\n\nRunning now:\n  ▶ npx vitest run'),
    stop: vi.fn(),
    ...overrides,
  }
}

describe('SuperShellTaskCoordinator — TaskOutput / TaskStop surface', () => {
  it('a running invocation reads as a running snapshot whose output is its progress', () => {
    const { coordinator, surface } = setup()
    const taskId = coordinator.register(start())
    expect(taskId).toBe('s1')
    expect(surface.getSnapshot('s1')).toMatchObject({
      sessionId: 's1',
      status: 'running',
      taskType: 'local_supershell',
      description: 'Typecheck and test',
    })
    expect(surface.getSnapshot('s1')!.output).toContain('▶ npx vitest run')
    expect(surface.list('sess-A')).toMatchObject([{ sessionId: 's1', status: 'running' }])
    expect(surface.list('sess-B')).toEqual([])
  })

  it('finishing reads as the terminal result; TaskStop then reports already_finished', () => {
    const { coordinator, surface } = setup()
    coordinator.register(start())
    coordinator.finish({ taskId: 's1', status: 'success', resultText: 'RESULT', finishedAt: 2000, deliver: false })
    expect(surface.getSnapshot('s1')).toMatchObject({ status: 'success', output: 'RESULT' })
    expect(surface.stop('s1').status).toBe('already_finished')
  })

  it('TaskStop on a running invocation calls its stop callback', () => {
    const { coordinator, surface } = setup()
    const s = start()
    coordinator.register(s)
    expect(surface.stop('s1')).toEqual({ status: 'stopped', description: 'Typecheck and test' })
    expect(s.stop).toHaveBeenCalledTimes(1)
  })

  it('a blocking wait resolves when the invocation finishes, and times out while it runs', async () => {
    const { coordinator, surface } = setup()
    coordinator.register(start())
    const timedOut = await surface.waitForCompletion('s1', 1)
    expect(timedOut?.status).toBe('running')

    const waiting = surface.waitForCompletion('s1', 60_000)
    coordinator.finish({ taskId: 's1', status: 'error', resultText: 'boom', finishedAt: 2000, deliver: true })
    await expect(waiting).resolves.toMatchObject({ status: 'error', output: 'boom' })
  })

  it('an aborted wait stops the invocation', async () => {
    const { coordinator, surface } = setup()
    const s = start()
    coordinator.register(s)
    const abort = new AbortController()
    const waiting = surface.waitForCompletion('s1', 60_000, abort.signal)
    abort.abort()
    await waiting
    expect(s.stop).toHaveBeenCalled()
  })

  it('the session Stop cascade stops only that session’s invocations; the drawer can stop one', () => {
    const { coordinator, surface } = setup()
    const a = start()
    const b = start({ spawnerSessionId: 'sess-B' })
    coordinator.register(a)
    coordinator.register(b)
    surface.stopRunningForParent('sess-A')
    expect(a.stop).toHaveBeenCalledTimes(1)
    expect(b.stop).not.toHaveBeenCalled()

    const replies: unknown[] = []
    const port = { postMessage: (m: unknown) => replies.push(m) } as unknown as MessagePort
    surface.handleDrawerStop(port, { type: 'task.stop', sessionId: 's2', requestId: 'r1' } as never)
    expect(b.stop).toHaveBeenCalledTimes(1)
    expect(replies).toMatchObject([{ type: 'task.stopped', payload: { sessionId: 's2', status: 'stopped' } }])
  })

  it('the drawer detail shows the script, its inputs, and progress then result', () => {
    const { coordinator, surface } = setup()
    coordinator.register(start())
    expect(surface.loadInfo('s1')).toMatchObject({
      type: 'local_supershell',
      jsSource: 'await bash("npx tsc --noEmit")',
      jsParams: { description: 'Typecheck and test', inputs: { wt: 'nexus_web' } },
    })
    coordinator.finish({ taskId: 's1', status: 'success', resultText: 'RESULT', finishedAt: 2000, deliver: false })
    expect(surface.loadInfo('s1')!.outputText).toBe('RESULT')
  })

  it('settled rows file under the Super Shell section; their settled steps under nothing', () => {
    expect(categorizeSubAgentRow({ sessionId: 's1', spawnerSessionId: 'p', status: 'success', type: 'local_supershell', description: 'x' })).toBe('supershell')
    expect(categorizeSubAgentRow({ sessionId: 's1', spawnerSessionId: 'p', status: 'running', type: 'local_supershell', description: 'x' })).toBe('running')
    expect(categorizeSubAgentRow({ sessionId: 'b1', spawnerSessionId: 'p', status: 'success', type: 'local_bash', description: 'make', command: 'make', superShellTaskId: 's1' })).toBeNull()
    expect(categorizeSubAgentRow({ sessionId: 'b1', spawnerSessionId: 'p', status: 'running', type: 'local_bash', description: 'make', command: 'make', superShellTaskId: 's1' })).toBe('running')
    expect(categorizeSubAgentRow({ sessionId: 'b2', spawnerSessionId: 'p', status: 'success', type: 'local_bash', description: 'make', command: 'make' })).toBe('shell')
  })
})

describe('SuperShellTaskCoordinator — the drawer addresses a run by its tool call id', () => {
  it('detail, transcript and Stop accept the tool call id; the model-facing id keeps working', async () => {
    const { coordinator, surface } = setup()
    const s = start({ toolCallId: 'toolu_ss1' })
    const taskId = coordinator.register(s)
    expect(taskId).toBe('s1')

    expect(surface.loadInfo('toolu_ss1')).toMatchObject({
      type: 'local_supershell',
      jsSource: 'await bash("npx tsc --noEmit")',
      jsParams: { description: 'Typecheck and test' },
    })
    // No conversation transcript — the detail is script / inputs / result.
    expect(await surface.loadTranscript('toolu_ss1')).toEqual([])
    expect(surface.getSnapshot('s1')).toMatchObject({ sessionId: 's1', status: 'running' })

    const replies: unknown[] = []
    const port = { postMessage: (m: unknown) => replies.push(m) } as unknown as MessagePort
    surface.handleDrawerStop(port, { type: 'task.stop', sessionId: 'toolu_ss1', requestId: 'r1' } as never)
    expect(s.stop).toHaveBeenCalledTimes(1)
    expect(replies).toMatchObject([{ type: 'task.stopped', payload: { sessionId: 'toolu_ss1', status: 'stopped' } }])

    coordinator.finish({ taskId, status: 'stopped', resultText: 'STOPPED', finishedAt: 2000, deliver: false })
    // The terminal record keeps the handle.
    expect(surface.loadInfo('toolu_ss1')!.outputText).toBe('STOPPED')
    expect(surface.stop('toolu_ss1').status).toBe('already_finished')
    expect(coordinator.finished('toolu_ss1')).toMatchObject({ taskId: 's1', toolCallId: 'toolu_ss1' })
  })

  it('a wait or acknowledgement through the tool call id binds to the run itself', async () => {
    const { coordinator, surface, delivered } = setup()
    const taskId = coordinator.register(start({ toolCallId: 'toolu_ss2' }))
    const waiting = surface.waitForCompletion('toolu_ss2', 60_000)
    surface.acknowledgeResult('toolu_ss2')
    coordinator.finish({ taskId, status: 'success', resultText: 'DONE', finishedAt: 2000, deliver: true })
    // Woken by the finish (keyed by the public id), not by the 60 s timeout.
    await expect(waiting).resolves.toMatchObject({ sessionId: 's1', status: 'success', output: 'DONE' })
    // Acknowledged while live → never delivered.
    expect(delivered).toEqual([])
  })

  it('an unknown id resolves to nothing — never another run', () => {
    const { coordinator, surface } = setup()
    coordinator.register(start({ toolCallId: 'toolu_ss3' }))
    coordinator.register(start())
    expect(surface.loadInfo('toolu_other')).toBeNull()
    expect(coordinator.owns('toolu_other')).toBe(false)
    expect(coordinator.live('s2')!.toolCallId).toBeUndefined()
  })

  it('a reloaded run (registry empty) recovers its detail from the SuperShell sidecar by tool call id', async () => {
    const registry = new TaskRegistry<NexusTaskState, NexusFinishedTaskRecord>()
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const stub = {} as any
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const routines = { get: () => undefined, has: () => false } as any
    const surface = new TaskControlSurface(registry, stub, stub, stub, routines, stub, {
      getStorage: () => null,
      dropSessionRouting: () => {},
      scheduleSummary: () => {},
      loadRunJsSidecar: async () => null,
      loadSuperShellSidecar: async toolCallId =>
        toolCallId === 'toolu_reloaded'
          ? { code: 'await bash("make")', description: 'Old build', inputs: { t: 1 }, resultText: 'OLD_STEPS' }
          : null,
    })
    expect(surface.loadInfo('toolu_reloaded')).toBeNull()
    await expect(surface.loadInfoWithOutput('toolu_reloaded')).resolves.toEqual({
      type: 'local_supershell',
      jsSource: 'await bash("make")',
      jsParams: { description: 'Old build', inlineCode: true, inputs: { t: 1 } },
      outputText: 'OLD_STEPS',
    })
    await expect(surface.loadInfoWithOutput('toolu_missing')).resolves.toBeNull()
  })
})

describe('SuperShellTaskCoordinator — delivery exactly once', () => {
  it('delivers a background (deliver: true) result as a SuperShell task-notification', () => {
    const { coordinator, delivered } = setup()
    coordinator.register(start())
    coordinator.finish({ taskId: 's1', status: 'success', resultText: '{"done":true}', finishedAt: 2000, deliver: true })
    expect(delivered).toHaveLength(1)
    expect(delivered[0]!.parent).toBe('sess-A')
    const xml = formatTaskNotifications([delivered[0]!.result])
    expect(xml).toContain('<task-id>s1</task-id>')
    expect(xml).toContain('<task-type>local_supershell</task-type>')
    expect(xml).toContain('<status>completed</status>')
    expect(xml).toContain('SuperShell script &quot;Typecheck and test&quot; completed'.replace(/&quot;/g, '"'))
    expect(xml).toContain('{"done":true}')
  })

  it('drains mid-turn like a background shell (next priority), unlike a sub-agent', () => {
    expect(isNextPriorityTaskResult({ type: 'local_supershell', taskId: 'h1', description: 'd', status: 'success', summary: '' })).toBe(true)
    expect(isNextPriorityTaskResult({ type: 'local_bash', taskId: 'b1', shellId: 'x', command: 'c', status: 'success', summary: '' } as NexusTaskDeliveryResult)).toBe(true)
    expect(isNextPriorityTaskResult({ type: 'local_agent', taskId: 'a1', agentId: 'x', description: 'd', status: 'success', summary: '' } as NexusTaskDeliveryResult)).toBe(false)
  })

  it('an inline result (deliver: false) is never delivered', () => {
    const { coordinator, delivered } = setup()
    coordinator.register(start())
    coordinator.finish({ taskId: 's1', status: 'success', resultText: 'x', finishedAt: 2000, deliver: false })
    expect(delivered).toEqual([])
  })

  it('a stopped invocation is never delivered', () => {
    const { coordinator, delivered } = setup()
    coordinator.register(start())
    coordinator.finish({ taskId: 's1', status: 'stopped', resultText: 'stopped', finishedAt: 2000, deliver: true })
    expect(delivered).toEqual([])
  })

  it('a result the model already read (acknowledged while live) is not delivered', () => {
    const { coordinator, surface, delivered } = setup()
    coordinator.register(start())
    surface.acknowledgeResult('s1')
    coordinator.finish({ taskId: 's1', status: 'success', resultText: 'x', finishedAt: 2000, deliver: true })
    expect(delivered).toEqual([])
  })

  it('acknowledging after finish drops the pending delivery for that task only', () => {
    const { coordinator, surface, dropPredicates } = setup()
    coordinator.register(start())
    coordinator.finish({ taskId: 's1', status: 'success', resultText: 'x', finishedAt: 2000, deliver: true })
    surface.acknowledgeResult('s1')
    expect(dropPredicates).toHaveLength(1)
    const pred = dropPredicates[0]!
    expect(pred({ type: 'local_supershell', taskId: 's1', description: 'd', status: 'success', summary: '' })).toBe(true)
    expect(pred({ type: 'local_supershell', taskId: 's9', description: 'd', status: 'success', summary: '' })).toBe(false)
  })

  it('a very long result is truncated in the notification, pointing at TaskOutput', () => {
    const { coordinator, delivered } = setup()
    coordinator.register(start())
    coordinator.finish({
      taskId: 's1',
      status: 'success',
      resultText: 'x'.repeat(SUPER_SHELL_DELIVERY_SUMMARY_MAX + 500),
      finishedAt: 2000,
      deliver: true,
    })
    const summary = (delivered[0]!.result as { summary: string }).summary
    expect(summary.length).toBeLessThan(SUPER_SHELL_DELIVERY_SUMMARY_MAX + 200)
    expect(summary).toContain('TaskOutput s1')
  })
})
