import { describe, expect, it } from 'vitest'
import { SharedWorkerSessionManager } from '../browser/worker/SharedWorkerSessionManager'
import type { FinishedSubAgentRecord, SubAgentRunState } from '../browser/worker/taskTypes'
import {
  RESTART_INTERRUPTED_SUMMARY,
  SUBAGENT_TASK_FILE_NAME,
  finishedRecordFromSessionMeta,
  finishedRecordFromTaskFile,
  parseSubAgentTaskFile,
  taskFileFromFinishedRecord,
  taskFileFromRunState,
} from '../browser/worker/subAgentTaskFile'

// The task registry is in-memory on the SharedWorker: a webview reload
// survives, an app restart does not — the Background Tasks drawer came up
// empty after every restart. `task.json` inside each sub-agent's session dir
// is the restore seed: written `running` at launch, rewritten terminal at
// finalize/stop, read back on the parent's next init.

const RUN_STATE: SubAgentRunState = {
  type: 'local_agent',
  taskId: 'a12345678',
  spawnerSessionId: 'parent-1',
  sessionId: 'subagent-Explore_x_y',
  agentId: 'Explore_x_y',
  description: 'Trace the crash',
  agentType: 'Explore',
  prompt: 'Find the root cause.',
  messages: [],
  completed: false,
  depth: 1,
  startedAt: 1000,
  lastActivityAt: 1000,
  systemPrompt: 'You are an explorer.',
  model: 'model-x',
  modelProviderId: 'prov-1',
  effectiveModel: 'model-x',
  effort: 'medium',
  allowTools: ['Read'],
  projectRoot: 'C:/proj',
}

const FINISHED: FinishedSubAgentRecord = {
  type: 'local_agent',
  taskId: 'a12345678',
  sessionId: 'subagent-Explore_x_y',
  agentId: 'Explore_x_y',
  spawnerSessionId: 'parent-1',
  description: 'Trace the crash',
  agentType: 'Explore',
  status: 'success',
  summary: 'Found it.',
  prompt: 'Find the root cause.',
  startedAt: 1000,
  finishedAt: 2000,
  depth: 1,
  systemPrompt: 'You are an explorer.',
  model: 'model-x',
  modelProviderId: 'prov-1',
  allowTools: ['Read'],
  projectRoot: 'C:/proj',
}

describe('subAgentTaskFile round-trips', () => {
  it('run-state file → restored record: a running file restores as stopped/interrupted', () => {
    const file = parseSubAgentTaskFile(JSON.stringify(taskFileFromRunState(RUN_STATE)))
    expect(file).not.toBeNull()
    expect(file!.status).toBe('running')
    const record = finishedRecordFromTaskFile(file!, 5000)
    expect(record).toMatchObject({
      type: 'local_agent',
      taskId: 'a12345678',
      sessionId: 'subagent-Explore_x_y',
      spawnerSessionId: 'parent-1',
      status: 'stopped',
      summary: RESTART_INTERRUPTED_SUMMARY,
      finishedAt: 5000,
      depth: 1,
      systemPrompt: 'You are an explorer.',
      model: 'model-x',
      modelProviderId: 'prov-1',
      allowTools: ['Read'],
      projectRoot: 'C:/proj',
    })
  })

  it('finished-record file round-trips losslessly (transcript stays on disk, not in the file)', () => {
    const json = JSON.stringify(taskFileFromFinishedRecord(FINISHED))
    expect(json).not.toContain('transcript')
    const record = finishedRecordFromTaskFile(parseSubAgentTaskFile(json)!, 9999)
    expect(record).toEqual(FINISHED)
  })

  it('rejects malformed files', () => {
    expect(parseSubAgentTaskFile('not json')).toBeNull()
    expect(parseSubAgentTaskFile('{}')).toBeNull()
    expect(
      parseSubAgentTaskFile(JSON.stringify({ ...taskFileFromRunState(RUN_STATE), status: 'weird' })),
    ).toBeNull()
  })

  it('meta.json fallback derives status from lastTerminalReason', () => {
    const ok = finishedRecordFromSessionMeta({
      sessionId: 'subagent-a',
      spawnerSessionId: 'p',
      taskId: 'a1',
      firstPrompt: 'do x',
      previewText: 'did x',
      lastTerminalReason: 'completed',
      updatedAt: 42,
      now: 100,
    })
    expect(ok).toMatchObject({ status: 'success', summary: 'did x', prompt: 'do x', finishedAt: 42 })
    const dead = finishedRecordFromSessionMeta({
      sessionId: 'subagent-b',
      spawnerSessionId: 'p',
      taskId: 'a2',
      now: 100,
    })
    expect(dead).toMatchObject({ status: 'stopped', description: 'subagent-b', finishedAt: 100 })
  })
})

// --- Manager-level restore ---

type Internals = {
  taskRegistry: {
    getFinished(id: string): unknown
    hasFinished(id: string): boolean
    resolveNative(id: string): string
    registerLive(id: string, state: unknown, taskId?: string): void
  }
  storageCoordinator: {
    listSubAgentSessionDirs(parent: string): Promise<string[]>
    readSubAgentFile(parent: string, sub: string, file: string): Promise<string | null>
    registerSubAgentRouting(parent: string, sub: string): void
  }
  restoreFinishedSubAgentsFromDisk(parent: string): Promise<void>
  restoredSubAgentParents: Set<string>
}

function makeManager(
  files: Record<string, Record<string, string>>,
  // Sub-agent meta now lives as a ROW in the single sqlite store, read via
  // `storage.readSessionMeta(subId)` — not a `subagents/<id>/meta.json` file.
  metas: Record<string, unknown> = {},
): {
  manager: SharedWorkerSessionManager
  internals: Internals
  routed: string[]
} {
  const manager = new SharedWorkerSessionManager({
    createWorker: () => {
      throw new Error('not needed')
    },
  })
  const internals = manager as unknown as Internals
  const routed: string[] = []
  internals.storageCoordinator.listSubAgentSessionDirs = async () =>
    Object.keys(files)
  internals.storageCoordinator.readSubAgentFile = async (_p, sub, file) =>
    files[sub]?.[file] ?? null
  ;(
    internals.storageCoordinator as unknown as { getStorage: () => unknown }
  ).getStorage = () => ({
    readSessionMeta: async (id: string) => metas[id] ?? null,
  })
  internals.storageCoordinator.registerSubAgentRouting = (_p, sub) => {
    routed.push(sub)
  }
  return { manager, internals, routed }
}

describe('restoreFinishedSubAgentsFromDisk', () => {
  it('seeds finished records from task.json, registers routing, resolves the public id', async () => {
    const { internals, routed } = makeManager({
      'subagent-Explore_x_y': {
        [SUBAGENT_TASK_FILE_NAME]: JSON.stringify(taskFileFromFinishedRecord(FINISHED)),
      },
    })
    await internals.restoreFinishedSubAgentsFromDisk('parent-1')
    expect(internals.taskRegistry.hasFinished('subagent-Explore_x_y')).toBe(true)
    expect(internals.taskRegistry.getFinished('subagent-Explore_x_y')).toMatchObject({
      status: 'success',
      summary: 'Found it.',
      taskId: 'a12345678',
    })
    // AgentResume/TaskOutput address by the public `a…` id — the restore must
    // re-index it.
    expect(internals.taskRegistry.resolveNative('a12345678')).toBe('subagent-Explore_x_y')
    expect(routed).toEqual(['subagent-Explore_x_y'])
  })

  it('a run still `running` on disk restores as stopped/interrupted', async () => {
    const { internals } = makeManager({
      'subagent-Explore_x_y': {
        [SUBAGENT_TASK_FILE_NAME]: JSON.stringify(taskFileFromRunState(RUN_STATE)),
      },
    })
    await internals.restoreFinishedSubAgentsFromDisk('parent-1')
    expect(internals.taskRegistry.getFinished('subagent-Explore_x_y')).toMatchObject({
      status: 'stopped',
      summary: RESTART_INTERRUPTED_SUMMARY,
    })
  })

  it('falls back to the meta store for a dir without a task.json', async () => {
    // The dir exists (so it enumerates) but has no task.json; the sub-agent's
    // meta is read from the sqlite store by session id.
    const { internals } = makeManager(
      { 'subagent-old_1': {} },
      {
        'subagent-old_1': {
          schemaVersion: 1,
          sessionId: 'subagent-old_1',
          updatedAt: 777,
          metadata: {
            firstPrompt: 'investigate',
            previewText: 'done',
            lastTerminalReason: 'completed',
          },
        },
      },
    )
    await internals.restoreFinishedSubAgentsFromDisk('parent-1')
    expect(internals.taskRegistry.getFinished('subagent-old_1')).toMatchObject({
      status: 'success',
      summary: 'done',
      prompt: 'investigate',
      finishedAt: 777,
    })
  })

  it('never overwrites a session already in the registry, and runs once per parent', async () => {
    const { internals, routed } = makeManager({
      'subagent-Explore_x_y': {
        [SUBAGENT_TASK_FILE_NAME]: JSON.stringify(taskFileFromFinishedRecord(FINISHED)),
      },
    })
    internals.taskRegistry.registerLive(
      'subagent-Explore_x_y',
      { ...RUN_STATE },
      RUN_STATE.taskId,
    )
    await internals.restoreFinishedSubAgentsFromDisk('parent-1')
    expect(internals.taskRegistry.hasFinished('subagent-Explore_x_y')).toBe(false)
    expect(routed).toEqual([])
    // Second call is a guarded no-op (Set) — even after the live run is gone.
    expect(internals.restoredSubAgentParents.has('parent-1')).toBe(true)
  })

  it('skips sub-agent parents and unreadable dirs without seeding', async () => {
    const { internals } = makeManager({ 'subagent-broken': {} })
    await internals.restoreFinishedSubAgentsFromDisk('subagent-someone')
    expect(internals.restoredSubAgentParents.has('subagent-someone')).toBe(false)
    await internals.restoreFinishedSubAgentsFromDisk('parent-1')
    expect(internals.taskRegistry.hasFinished('subagent-broken')).toBe(false)
  })

  it('releases the once-guard when listing throws, so a later init retries', async () => {
    const { internals } = makeManager({})
    internals.storageCoordinator.listSubAgentSessionDirs = async () => {
      throw new Error('storage not up')
    }
    await internals.restoreFinishedSubAgentsFromDisk('parent-1')
    expect(internals.restoredSubAgentParents.has('parent-1')).toBe(false)
  })
})
