// `local_plugin` tasks (`$.task`, F-25): PluginTaskCoordinator and what
// TaskOutput / TaskStop / the drawer reach through TaskControlSurface, against
// the real TaskRegistry and notification formatter.

import { afterEach, describe, expect, it, vi } from 'vitest'
import { TaskRegistry } from '../browser/worker/TaskRegistry'
import { TaskControlSurface } from '../browser/worker/TaskControlSurface'
import {
  PLUGIN_TASK_DATA_MAX,
  PLUGIN_TASK_ITEMS_MAX,
  PLUGIN_TASK_STOP_GRACE_MS,
  PLUGIN_TASK_TEXT_MAX,
  PluginTaskCoordinator,
  pluginTaskRecordFromFile,
  type PluginTaskStopEvent,
} from '../browser/worker/PluginTaskCoordinator'
import { formatTaskNotifications } from '../browser/worker/taskProjection'
import type { NexusFinishedTaskRecord, NexusTaskDeliveryResult, NexusTaskState } from '../browser/worker/taskTypes'
import { categorizeSubAgentRow } from '../browser/webview/backgroundSubAgents'
import { taskKindFromId } from '../backgroundTasks/taskId'

afterEach(() => {
  vi.useRealTimers()
})

type PersistFn = (parent: string, taskId: string, json: string) => Promise<void> | void

function setup(persistOverride?: PersistFn) {
  const registry = new TaskRegistry<NexusTaskState, NexusFinishedTaskRecord>()
  const delivered: Array<{ parent: string; result: NexusTaskDeliveryResult }> = []
  const files: Array<{ parent: string; taskId: string; json: string }> = []
  const stops: Array<{ parent: string; e: PluginTaskStopEvent }> = []
  const stoppedAgents: string[] = []
  let seq = 0
  const coordinator = new PluginTaskCoordinator(registry, {
    scheduleSummary: () => {},
    mintTaskHandle: () => `p${++seq}`,
    deliverResult: (parent, result) => delivered.push({ parent, result }),
    dropPendingResult: () => {},
    evictFinishedOverCap: (kind, cap) => registry.evictFinishedOverCap(kind, cap),
    persist: (parent, taskId, json) => {
      files.push({ parent, taskId, json })
      return persistOverride?.(parent, taskId, json)
    },
    raiseStop: (parent, e) => stops.push({ parent, e }),
    stopAgent: agentId => stoppedAgents.push(agentId),
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
    [coordinator],
  )
  const start = (overrides: Record<string, unknown> = {}) =>
    coordinator.start({ spawnerSessionId: 'sess-A', plugin: 'flow', kind: 'workflow', title: 'Review the diff', ...overrides })
  return { registry, coordinator, surface, delivered, files, stops, stoppedAgents, start }
}

describe('PluginTaskCoordinator', () => {
  it('a task is a p… row that TaskOutput reads while running and after it finishes, delivered once', async () => {
    const { coordinator, surface, delivered, start } = setup()
    const taskId = start()
    expect(taskKindFromId(taskId)).toBe('local_plugin')
    coordinator.progress('sess-A', 'flow', taskId, {
      text: 'step 2 of 3',
      items: [{ id: 'a', label: 'lint', status: 'done', phase: 'check' }],
      data: { found: 2 },
    })
    expect(surface.getSnapshot(taskId)).toMatchObject({ status: 'running', taskType: 'local_plugin' })
    expect(surface.getSnapshot(taskId)!.output).toBe('step 2 of 3\n\n[done] check: lint\n\n{\n  "found": 2\n}')

    const waiting = surface.waitForCompletion(taskId, 10_000)
    coordinator.finish('sess-A', 'flow', taskId, { result: 'two findings', data: { found: 2 } })
    expect(await waiting).toMatchObject({ status: 'success', output: 'two findings\n\n{\n  "found": 2\n}' })
    expect(delivered).toHaveLength(1)
    expect(delivered[0]!.parent).toBe('sess-A')
    const text = formatTaskNotifications([delivered[0]!.result])
    expect(text).toContain('<task-type>local_plugin</task-type>')
    expect(text).toContain('<status>completed</status>')
    expect(text).toContain('Review the diff (flow): two findings')
    expect(categorizeSubAgentRow({ sessionId: taskId, spawnerSessionId: 'sess-A', status: 'success', type: 'local_plugin', description: 'x' })).toBe('plugin')
  })

  it('a result the model read with TaskOutput while running is not delivered again; an error is delivered as failed', () => {
    const { coordinator, surface, delivered, start } = setup()
    const read = start()
    surface.acknowledgeResult(read)
    coordinator.finish('sess-A', 'flow', read, { result: 'done' })
    expect(delivered).toHaveLength(0)
    const failing = start()
    coordinator.finish('sess-A', 'flow', failing, { result: 'boom', isError: true })
    expect(formatTaskNotifications([delivered[0]!.result])).toContain('<status>failed</status>')
  })

  it('only the plugin and session that started a task may touch it', () => {
    const { coordinator, start } = setup()
    const taskId = start()
    expect(() => coordinator.progress('sess-A', 'other', taskId, { text: 'x' })).toThrow(expect.objectContaining({ name: 'NotFoundError' }))
    expect(() => coordinator.finish('sess-B', 'flow', taskId, { result: 'x' })).toThrow(expect.objectContaining({ name: 'NotFoundError' }))
    coordinator.finish('sess-A', 'flow', taskId, { result: 'x' })
    expect(() => coordinator.finish('sess-A', 'flow', taskId, { result: 'again' })).toThrow(expect.objectContaining({ name: 'InvalidStateError' }))
  })

  it('caps progress: text and items are cut and marked, data over its cap is refused', () => {
    const { coordinator, surface, start } = setup()
    const taskId = start()
    coordinator.progress('sess-A', 'flow', taskId, {
      text: 'x'.repeat(PLUGIN_TASK_TEXT_MAX + 10),
      items: Array.from({ length: PLUGIN_TASK_ITEMS_MAX + 5 }, (_, i) => ({ id: `${i}`, label: 'l', status: 's' })),
    })
    const output = surface.getSnapshot(taskId)!.output
    expect(output.endsWith('(progress truncated)')).toBe(true)
    expect(output.split('\n').filter(line => line === '[s] l')).toHaveLength(PLUGIN_TASK_ITEMS_MAX)
    expect(() => coordinator.progress('sess-A', 'flow', taskId, { data: 'y'.repeat(PLUGIN_TASK_DATA_MAX) })).toThrow(
      expect.objectContaining({ name: 'RangeError' }),
    )
  })

  it('TaskStop raises task.stop, stops adopted subagents, and records the task stopped if the plugin does not finish it in time; nothing is delivered', () => {
    vi.useFakeTimers()
    const { coordinator, surface, delivered, stops, stoppedAgents, start } = setup()
    const taskId = start()
    coordinator.adoptChild('sess-A', 'flow', taskId, 'a1')
    coordinator.progress('sess-A', 'flow', taskId, { text: 'half way' })
    expect(surface.stop(taskId)).toEqual({ status: 'stopped', description: 'Review the diff' })
    expect(stops).toEqual([{ parent: 'sess-A', e: { taskId, plugin: 'flow', kind: 'workflow' } }])
    expect(stoppedAgents).toEqual(['a1'])
    surface.stop(taskId)
    expect(stops).toHaveLength(1)
    vi.advanceTimersByTime(PLUGIN_TASK_STOP_GRACE_MS)
    expect(surface.getSnapshot(taskId)).toMatchObject({ status: 'stopped', output: 'half way' })
    expect(delivered).toHaveLength(0)
  })

  it("a task that finishes after a stop was asked is recorded stopped with its own result; children: 'abandon' leaves its subagents", () => {
    vi.useFakeTimers()
    const { coordinator, surface, delivered, stoppedAgents, start } = setup()
    const taskId = start({ children: 'abandon' })
    coordinator.adoptChild('sess-A', 'flow', taskId, 'a1')
    surface.stop(taskId)
    coordinator.finish('sess-A', 'flow', taskId, { result: 'cancelled after 2 of 5' })
    vi.advanceTimersByTime(PLUGIN_TASK_STOP_GRACE_MS)
    expect(surface.getSnapshot(taskId)).toMatchObject({ status: 'stopped', output: 'cancelled after 2 of 5' })
    expect(stoppedAgents).toEqual([])
    expect(delivered).toHaveLength(0)
  })

  it('a subagent that finishes launching after its task was stopped is stopped too; after a normal end it runs on', () => {
    vi.useFakeTimers()
    const { coordinator, surface, stoppedAgents, start } = setup()
    const stopping = start()
    surface.stop(stopping)
    coordinator.adoptChild('sess-A', 'flow', stopping, 'a1')
    expect(stoppedAgents).toEqual(['a1'])
    vi.advanceTimersByTime(PLUGIN_TASK_STOP_GRACE_MS)
    coordinator.adoptChild('sess-A', 'flow', stopping, 'a2')
    expect(stoppedAgents).toEqual(['a1', 'a2'])

    const done = start()
    coordinator.finish('sess-A', 'flow', done, { result: 'ok' })
    coordinator.adoptChild('sess-A', 'flow', done, 'a3')
    const abandoning = start({ children: 'abandon' })
    surface.stop(abandoning)
    coordinator.adoptChild('sess-A', 'flow', abandoning, 'a4')
    expect(stoppedAgents).toEqual(['a1', 'a2'])
    expect(() => coordinator.adoptChild('sess-A', 'other', done, 'a5')).toThrow(expect.objectContaining({ name: 'NotFoundError' }))
  })

  it('the session Stop cascade asks every running task of that session to stop', () => {
    const { surface, stops, start } = setup()
    const mine = start()
    start({ spawnerSessionId: 'sess-B' })
    surface.stopRunningForParent('sess-A')
    expect(stops.map(s => s.e.taskId)).toEqual([mine])
  })

  it('the record is written at start and at finish; a file left running comes back stopped and interrupted', async () => {
    const { coordinator, delivered, files, start } = setup()
    const taskId = start({ toolUseId: 'call-1' })
    expect(JSON.parse(files[0]!.json)).toMatchObject({ schemaVersion: 1, taskId, toolCallId: 'call-1', status: 'running', plugin: 'flow' })
    coordinator.finish('sess-A', 'flow', taskId, { result: 'ok' })
    expect(delivered).toHaveLength(1)
    await vi.waitFor(() => expect(files).toHaveLength(2))
    expect(JSON.parse(files[1]!.json)).toMatchObject({ status: 'success', resultText: 'ok' })

    const restored = pluginTaskRecordFromFile(files[0]!.json, 99)
    expect(restored).toMatchObject({ taskId, status: 'stopped', interrupted: true, finishedAt: 99, toolCallId: 'call-1' })
    expect(pluginTaskRecordFromFile(files.at(-1)!.json, 99)).toMatchObject({ status: 'success', resultText: 'ok' })
    expect(pluginTaskRecordFromFile('{"schemaVersion":2}', 99)).toBeNull()
    expect(pluginTaskRecordFromFile('not json', 99)).toBeNull()
  })

  it('one task file is written one write at a time, so the terminal record lands last however slowly writes settle', async () => {
    // A disk where a write lands only when its request settles, settled here
    // newest-first: concurrent writes would leave the running record on disk.
    const pending: Array<{ taskId: string; json: string; settle: (ok: boolean) => void }> = []
    const disk = new Map<string, string>()
    const { coordinator, delivered, files, start } = setup(
      (_parent, taskId, json) =>
        new Promise<void>((resolve, reject) => {
          pending.push({
            taskId,
            json,
            settle: ok => {
              if (!ok) return reject(new Error('sharing violation'))
              disk.set(taskId, json)
              resolve()
            },
          })
        }),
    )
    const flush = async () => {
      for (let i = 0; i < 5; i++) await Promise.resolve()
    }
    const settleNewestFirst = async () => {
      while (pending.length) {
        pending.pop()!.settle(true)
        await flush()
      }
    }

    const quick = start()
    coordinator.finish('sess-A', 'flow', quick, { result: 'done fast' })
    // The finish is delivered at once, but its write waits for the start write.
    expect(delivered).toHaveLength(1)
    expect(files.map(f => JSON.parse(f.json).status)).toEqual(['running'])
    await settleNewestFirst()
    expect(files.map(f => JSON.parse(f.json).status)).toEqual(['running', 'success'])
    expect(JSON.parse(disk.get(quick)!)).toMatchObject({ status: 'success', resultText: 'done fast' })

    // A failed start write still lets the terminal write through.
    const failing = start()
    coordinator.finish('sess-A', 'flow', failing, { result: 'oops', isError: true })
    expect(pending).toHaveLength(1)
    pending.pop()!.settle(false)
    await flush()
    expect(pending.map(p => JSON.parse(p.json).status)).toEqual(['error'])
    await settleNewestFirst()
    expect(JSON.parse(disk.get(failing)!)).toMatchObject({ status: 'error' })

    // Two tasks do not wait on each other.
    const a = start()
    const b = start()
    expect(pending.map(p => p.taskId)).toEqual([a, b])
    await settleNewestFirst()
  })

  it('a persist host that throws breaks neither start nor finish, and the finish write is still tried', async () => {
    const { coordinator, delivered, files, start } = setup(() => {
      throw new Error('no storage')
    })
    const taskId = start()
    expect(() => coordinator.finish('sess-A', 'flow', taskId, { result: 'ok' })).not.toThrow()
    expect(delivered).toHaveLength(1)
    await vi.waitFor(() => expect(files.map(f => JSON.parse(f.json).status)).toEqual(['running', 'success']))
  })

  it('list answers the plugin its own tasks of the session, restored ones included', () => {
    const { coordinator, start } = setup()
    const running = start()
    start({ plugin: 'other' })
    const done = start()
    coordinator.finish('sess-A', 'flow', done, { result: 'ok' })
    const restored = pluginTaskRecordFromFile(
      JSON.stringify({ schemaVersion: 1, taskId: 'p-old', spawnerSessionId: 'sess-A', plugin: 'flow', kind: 'workflow', description: 'Old run', status: 'running', startedAt: 1 }),
      5,
    )!
    expect(coordinator.seedRestored(restored)).toBe(true)
    expect(coordinator.seedRestored(restored)).toBe(false)
    expect(coordinator.list('sess-A', 'flow')).toEqual([
      expect.objectContaining({ taskId: running, status: 'running' }),
      expect.objectContaining({ taskId: done, status: 'completed' }),
      expect.objectContaining({ taskId: 'p-old', status: 'killed', interrupted: true, title: 'Old run' }),
    ])
  })
})
