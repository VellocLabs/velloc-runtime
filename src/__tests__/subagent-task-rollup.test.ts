/**
 * A background sub-agent's own work shows in the session that started it
 * (F-2): its background tasks carry the owning session and the sub-agent they
 * came from, and its file changes (with hunks) are kept by the manager and
 * published on the owner's diff topic.
 */
import { describe, expect, it, vi } from 'vitest'

import { TaskRegistry } from '../browser/worker/TaskRegistry'
import { SessionFeedPublisher, type SessionFeedHost } from '../browser/worker/SessionFeedPublisher'
import { SubAgentCoordinator } from '../browser/worker/SubAgentCoordinator'
import { resolveTaskOrigin, type TaskOriginLink } from '../browser/worker/taskProjection'
import { AgentTranscriptService } from '../browser/worker/AgentTranscriptService'
import { classifyManagerMessage } from '../browser/runtimeHub/sessionSurface'
import { filterSubAgentRowsBySession, taskRowOriginName } from '../browser/webview/backgroundSubAgents'
import { pathWithinRoot } from '../components/assistant-ui/TurnDiffSummary'
import type { NexusTaskSummaryRow } from '../browser/bridge/protocol/ui'
import type { TurnFullDiff } from '../utils/turnDiffs'
import type { NexusFinishedTaskRecord, NexusTaskState } from '../browser/worker/taskTypes'
import type { BrowserToolCallDetailRecord } from '../utils/toolCallDetails'

const link = (spawnerSessionId: string, taskId: string, description: string, agentType?: string): TaskOriginLink => ({
  spawnerSessionId,
  taskId,
  description,
  ...(agentType ? { agentType } : {}),
})

describe('resolveTaskOrigin', () => {
  it('is null for a task the session launched itself', () => {
    expect(resolveTaskOrigin('P1', () => undefined)).toBeNull()
  })

  it('names the owning session and the sub-agent that launched the task', () => {
    const links = new Map([['subagent-x', link('P1', 'a1', 'Explore the repo', 'Explore')]])
    expect(resolveTaskOrigin('subagent-x', id => links.get(id))).toEqual({
      ownerSessionId: 'P1',
      viaTaskId: 'a1',
      viaDescription: 'Explore the repo',
      viaAgentType: 'Explore',
    })
  })

  it('walks a nested chain to the user-facing session, naming the direct launcher', () => {
    const links = new Map([
      ['subagent-inner', link('subagent-outer', 'a2', 'inner')],
      ['subagent-outer', link('P1', 'a1', 'outer')],
    ])
    expect(resolveTaskOrigin('subagent-inner', id => links.get(id))).toMatchObject({
      ownerSessionId: 'P1',
      viaTaskId: 'a2',
      viaDescription: 'inner',
    })
  })

  it('is null for a broken or cyclic chain', () => {
    expect(resolveTaskOrigin('subagent-gone', () => undefined)).toBeNull()
    const cycle = new Map([
      ['subagent-a', link('subagent-b', 'a1', 'a')],
      ['subagent-b', link('subagent-a', 'a2', 'b')],
    ])
    expect(resolveTaskOrigin('subagent-a', id => cycle.get(id))).toBeNull()
  })
})

function feedHost(): SessionFeedHost {
  return {
    getSessionEntry: () => undefined,
    sessionEntries: () => new Map().entries(),
    getSubscribersFor: () => [],
    getListSubscribers: () => [],
    isViewed: () => false,
    notifyTurnEnd: () => {},
    getFsSummaries: () => ({ keys: () => [][Symbol.iterator](), peek: () => undefined }),
    routineTasks: () => [],
    recoveredRunJsRows: () => new Map<string, never[]>().entries(),
    recoveredBashRows: () => new Map<string, never[]>().entries(),
    recoveredSuperShellRows: () => new Map<string, never[]>().entries(),
  } as unknown as SessionFeedHost
}

function liveAgent(sessionId: string, spawnerSessionId: string, taskId: string, extra: Record<string, unknown> = {}) {
  return {
    type: 'local_agent',
    taskId,
    spawnerSessionId,
    sessionId,
    agentId: sessionId.slice('subagent-'.length),
    description: `work of ${taskId}`,
    agentType: 'Explore',
    prompt: 'go',
    messages: [],
    completed: false,
    depth: 1,
    startedAt: 1_000,
    lastActivityAt: 1_000,
    ...extra,
  }
}

function liveShell(taskId: string, spawnerSessionId: string) {
  return {
    type: 'local_bash',
    taskId,
    spawnerSessionId,
    command: `run ${taskId}`,
    polls: 0,
    startedAt: 2_000,
    lastActivityAt: 2_000,
  }
}

describe('task rows a sub-agent launched', () => {
  it('carry the owning session and the sub-agent they came from', () => {
    const registry = new TaskRegistry<NexusTaskState, NexusFinishedTaskRecord>()
    registry.registerLive('subagent-x', liveAgent('subagent-x', 'P1', 'a1') as never, 'a1')
    registry.registerLive('b1', liveShell('b1', 'subagent-x') as never)
    registry.registerLive('b2', liveShell('b2', 'P1') as never)
    const rows = new SessionFeedPublisher(registry, feedHost()).buildSummaryPayload().subAgents ?? []
    const byId = Object.fromEntries(rows.map(row => [row.sessionId, row]))
    expect(byId.b1).toMatchObject({
      spawnerSessionId: 'subagent-x',
      ownerSessionId: 'P1',
      viaTaskId: 'a1',
      viaDescription: 'work of a1',
      viaAgentType: 'Explore',
    })
    expect(byId.b2?.ownerSessionId).toBeUndefined()
    expect(byId.a1?.ownerSessionId).toBeUndefined()
  })

  it('are listed in the owning session, not under the sub-agent id', () => {
    const rows: NexusTaskSummaryRow[] = [
      { sessionId: 'b1', spawnerSessionId: 'subagent-x', ownerSessionId: 'P1', viaTaskId: 'a1', viaDescription: 'Explore', status: 'running', type: 'local_bash', description: 'ls' },
      { sessionId: 'b2', spawnerSessionId: 'P1', status: 'running', type: 'local_bash', description: 'pwd' },
      { sessionId: 'b3', spawnerSessionId: 'P2', status: 'running', type: 'local_bash', description: 'dir' },
    ]
    expect(filterSubAgentRowsBySession(rows, 'P1').map(row => row.sessionId)).toEqual(['b1', 'b2'])
    expect(filterSubAgentRowsBySession(rows, 'subagent-x')).toEqual([])
  })

  it('name their origin by description, then agent type; own rows have none', () => {
    expect(taskRowOriginName({ ownerSessionId: 'P1', viaDescription: ' Find it ', viaAgentType: 'Explore' })).toBe('Find it')
    expect(taskRowOriginName({ ownerSessionId: 'P1', viaDescription: '', viaAgentType: 'Explore' })).toBe('Explore')
    expect(taskRowOriginName({ viaDescription: 'Find it' })).toBeNull()
  })
})

const hunk = { oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, lines: ['-a', '+b'] }
const fullTurn = (turnIndex: number, filePath: string): TurnFullDiff => ({
  turnIndex,
  promptPreview: 'go',
  timestamp: new Date(1_000 + turnIndex).toISOString(),
  files: [{ filePath, hunks: [hunk], fileWasCreated: false, plusLines: 1, minusLines: 1 }],
  stats: { touchedFiles: 1, plusLines: 1, minusLines: 1 },
})

function coordinator() {
  const registry = new TaskRegistry<NexusTaskState, NexusFinishedTaskRecord>()
  const changed: string[] = []
  const host = new Proxy({} as Record<string, unknown>, {
    get: (_target, prop) =>
      prop === 'agentChangesChanged'
        ? (owner: string) => changed.push(owner)
        : prop === 'getSnapshot'
          ? () => null
          : () => undefined,
  })
  const coord = new SubAgentCoordinator(registry, host as never)
  return { registry, coord, changed }
}

describe('a sub-agent\'s file changes', () => {
  it('are kept from its worker\'s history and published to the owning session', () => {
    const { registry, coord, changed } = coordinator()
    registry.registerLive('subagent-x', liveAgent('subagent-x', 'P1', 'a1', { workDir: '/repo/.wt/a1' }) as never, 'a1')
    const handled = coord.interceptEmit('subagent-x', {
      type: 'worker.turnDiffHistory',
      payload: { turns: [], full: [fullTurn(1, '/repo/.wt/a1/src/x.ts')] },
    } as never)
    expect(handled).toBe(true)
    expect(changed).toEqual(['P1'])
    const [section] = coord.changeSections('P1')
    expect(section).toMatchObject({ taskId: 'a1', status: 'running', workDir: '/repo/.wt/a1', agentType: 'Explore' })
    expect(section!.turns[0]!.files[0]).toEqual({
      filePath: '/repo/.wt/a1/src/x.ts',
      fileWasCreated: false,
      plusLines: 1,
      minusLines: 1,
    })
    expect(coord.turnDiffFiles('a1', 1)?.[0]?.hunks).toEqual([hunk])
    expect(coord.turnDiffFiles('a1', 2)).toBeNull()
    expect(coord.changeSections('P2')).toEqual([])
  })

  it('ignore a history without hunks, which only a main session sends', () => {
    const { registry, coord, changed } = coordinator()
    registry.registerLive('subagent-x', liveAgent('subagent-x', 'P1', 'a1') as never, 'a1')
    coord.interceptEmit('subagent-x', { type: 'worker.turnDiffHistory', payload: { turns: [] } } as never)
    expect(changed).toEqual([])
    expect(coord.changeSections('P1')).toEqual([])
  })

  it('survive the run finishing, and older finished runs keep counts but not hunks', () => {
    // Every run finishes in the same millisecond: recording order decides.
    const now = vi.spyOn(Date, 'now').mockReturnValue(5_000)
    const { registry, coord } = coordinator()
    const finalize = (id: string) =>
      (coord as unknown as { finalizeSubAgentRun(id: string, s: string, sum: string): void })
        .finalizeSubAgentRun(id, 'success', 'done')
    for (let i = 0; i < 21; i++) {
      const native = `subagent-${i}`
      registry.registerLive(native, liveAgent(native, 'P1', `a${i}`, { startedAt: 1_000 + i }) as never, `a${i}`)
      coord.interceptEmit(native, {
        type: 'worker.turnDiffHistory',
        payload: { turns: [], full: [fullTurn(1, `/repo/f${i}.ts`)] },
      } as never)
      finalize(native)
    }
    const sections = coord.changeSections('P1')
    expect(sections).toHaveLength(21)
    expect(sections[0]).toMatchObject({ taskId: 'a20', status: 'success' })
    expect(coord.turnDiffFiles('a20', 1)?.[0]?.hunks).toEqual([hunk])
    // The oldest is past the cap: its file and counts stay, its hunks go.
    expect(coord.turnDiffFiles('a0', 1)?.[0]).toMatchObject({ filePath: '/repo/f0.ts', plusLines: 1, hunks: [] })
    now.mockRestore()
  })
})

describe('a sub-agent worker\'s diff history', () => {
  it('carries the hunks only when its host asks for them', async () => {
    const run = async (includeHunks: boolean) => {
      const emitted: Array<{ type: string; payload?: { full?: TurnFullDiff[] } }> = []
      const service = new AgentTranscriptService({
        emit: message => emitted.push(message as never),
        includeHunks: () => includeHunks,
      })
      const stored = new Map<string, BrowserToolCallDetailRecord>()
      stored.set('e1', {
        toolCallId: 'e1',
        toolName: 'Edit',
        editDiff: { filePath: 'a.ts', patchHunks: [hunk], fileWasCreated: false, plusLines: 1, minusLines: 1 },
      } as never)
      service.bindRuntime({
        engine: {
          transcriptRows: () => [
            { type: 'user', message: { role: 'user', content: 'edit a' } },
            {
              type: 'assistant',
              message: {
                role: 'assistant',
                content: [{ type: 'tool-call', toolCallId: 'e1', toolName: 'Edit', args: {} }],
              },
            },
          ],
        },
        conversationStore: { getToolCallDetail: async (id: string) => stored.get(id) ?? null },
      } as never)
      await service.emitTurnDiffHistory()
      return emitted.filter(m => m.type === 'worker.turnDiffHistory').at(-1)?.payload
    }
    expect((await run(true))?.full?.[0]?.files[0]?.hunks.length).toBe(1)
    expect((await run(false))?.full).toBeUndefined()
  })
})

describe('the runtime hub', () => {
  it('files sub-agent changes on the owning session\'s diff topic', () => {
    expect(
      classifyManagerMessage({ type: 'worker.agentChanges', sessionId: 'P1', payload: { agents: [] } }),
    ).toMatchObject({ topic: 'session/P1/diff', type: 'worker.agentChanges', payload: { payload: { agents: [] } } })
  })

  it('files a sub-agent turn\'s hunks reply on the tasks topic', () => {
    expect(classifyManagerMessage({ type: 'task.turnDiff', payload: { requestId: 'r' } })?.topic).toBe('tasks')
  })
})

describe('pathWithinRoot', () => {
  it('shows a path relative to the agent\'s work dir, loosely on separators and case', () => {
    expect(pathWithinRoot('C:\\Repo\\.wt\\a1\\src\\x.ts', 'c:/repo/.wt/a1/')).toBe('src/x.ts')
    expect(pathWithinRoot('/repo/other/x.ts', '/repo/.wt/a1')).toBe('/repo/other/x.ts')
    expect(pathWithinRoot('/repo/x.ts', undefined)).toBe('/repo/x.ts')
    expect(pathWithinRoot('/repo2/x.ts', '/repo')).toBe('/repo2/x.ts')
  })
})

describe('the task.turnDiff request', () => {
  it('needs a positive integer turn index', async () => {
    const { PortMessageRouter } = await import('../browser/worker/PortMessageRouter')
    const handleTaskTurnDiff = vi.fn()
    const posted: unknown[] = []
    const router = new PortMessageRouter(new Proxy({ handleTaskTurnDiff } as Record<string, unknown>, {
      get: (target, prop) => target[prop as string] ?? (() => undefined),
    }) as never)
    const port = { postMessage: (m: unknown) => posted.push(m) } as unknown as MessagePort
    const route = (message: unknown) =>
      router.handle(port, { data: message } as MessageEvent)
    route({ type: 'task.turnDiff', sessionId: 'a1', requestId: 'r', turnIndex: 0 })
    route({ type: 'task.turnDiff', sessionId: 'a1', requestId: 'r', turnIndex: 2 })
    expect(handleTaskTurnDiff).toHaveBeenCalledTimes(1)
    expect(handleTaskTurnDiff.mock.calls[0]![1]).toMatchObject({ turnIndex: 2 })
  })
})
