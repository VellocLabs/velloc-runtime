import { describe, expect, it, vi } from 'vitest'
import { SharedWorkerSessionManager } from '../browser/worker/SharedWorkerSessionManager'
import type {
  BrowserConversationStorageBackend,
  BrowserConversationStoragePayload,
  SessionMetaFile,
} from '../sessions/sessionStore'
import { buildSessionSummaryFromMeta } from '../sessions/sessionStore'

// A person's archive in the runtime: the stop before the flag, the worktree
// settle after it, one settle at a time per session, git in the repository
// root. (F-36)

function createPort() {
  const handlers: Array<(event: MessageEvent) => void> = []
  const port = {
    addEventListener: (type: string, handler: (event: MessageEvent) => void) => {
      if (type === 'message') handlers.push(handler)
    },
    removeEventListener: () => {},
    postMessage: () => {},
    start: () => {},
    close: () => {},
    onmessage: null,
    onmessageerror: null,
    dispatchEvent: () => true,
  } as unknown as MessagePort
  const send = (data: unknown) => {
    for (const handler of handlers) handler({ data, ports: [] } as unknown as MessageEvent)
  }
  return { port, send }
}

const tick = () => new Promise(resolve => setTimeout(resolve, 10))

function setup(options: { closeTerminalsForSession?: (id: string) => void } = {}) {
  const manager = new SharedWorkerSessionManager({
    createWorker: () => {
      throw new Error('no session worker in this test')
    },
    ...options,
  })
  const metas = new Map<string, SessionMetaFile>()
  metas.set('s', { schemaVersion: 1, sessionId: 's', updatedAt: 10, metadata: {} })
  const storage = {
    append: vi.fn(async () => {}),
    readSessionMeta: vi.fn(async (sessionId: string) => metas.get(sessionId) ?? null),
    writeSessionMeta: vi.fn(async (sessionId: string, meta: SessionMetaFile) => {
      metas.set(sessionId, meta)
    }),
    load: vi.fn(async (): Promise<BrowserConversationStoragePayload> => null),
    flush: vi.fn(async () => {}),
    listSessions: vi.fn(async () => [...metas.keys()]),
    loadSessionSummary: vi.fn(async (sessionId: string) => {
      const meta = metas.get(sessionId)
      return meta ? buildSessionSummaryFromMeta(meta) : null
    }),
    loadToolCallDetail: vi.fn(async () => null),
    saveToolCallDetail: vi.fn(async () => {}),
  }
  ;(
    manager as unknown as { storageCoordinator: { storage: BrowserConversationStorageBackend } }
  ).storageCoordinator.storage = storage as unknown as BrowserConversationStorageBackend
  const refreshSummary = (id: string) =>
    (manager as unknown as { summaryRepo: { refreshFsSummary(id: string): Promise<void> } })
      .summaryRepo.refreshFsSummary(id)
  return { manager, metas, refreshSummary }
}

describe('the person archive in the runtime', () => {
  it('an unarchive sent while the archive still removes the checkout waits for it, then restores it', async () => {
    const { manager, metas, refreshSummary } = setup()
    await refreshSummary('s')
    metas.get('s')!.metadata.worktree = { dir: 'D:/repo/.velloc/worktrees/s', branch: 'session/s', repoRoot: 'D:/repo' }
    const commands: string[] = []
    let releaseRemove: () => void = () => {}
    const removeHeld = new Promise<void>(resolve => {
      releaseRemove = resolve
    })
    const transport = {
      request: vi.fn(async (req: { payload: { command: string; cwd: string } }) => {
        commands.push(`${req.payload.cwd} | ${req.payload.command}`)
        if (req.payload.command.includes('worktree remove')) await removeHeld
        return { ok: true, result: '(no output)' }
      }),
    }
    const internalsOf = manager as unknown as {
      bridgeRouter: { getDirectTransport(): unknown }
      stopSessionForArchive(id: string): Promise<void>
    }
    internalsOf.bridgeRouter.getDirectTransport = () => transport
    internalsOf.stopSessionForArchive = async () => {}
    const { port, send } = createPort()
    manager.handleConnect(port)
    send({ type: 'session.archive', sessionId: 's', archived: true, requestId: 'a' })
    await vi.waitFor(() => expect(commands.some(c => c.includes('worktree remove'))).toBe(true))
    send({ type: 'session.archive', sessionId: 's', archived: false, requestId: 'b' })
    await tick()
    expect(commands.some(c => c.includes('worktree add'))).toBe(false)
    releaseRemove()
    await vi.waitFor(() => expect(commands.some(c => c.includes('worktree add'))).toBe(true))
    // Git runs in the repository root, never in the checkout it removes or restores.
    expect(commands.every(c => c.startsWith('D:/repo | '))).toBe(true)
    await vi.waitFor(() => expect(metas.get('s')!.metadata.worktree).toEqual({
      dir: 'D:/repo/.velloc/worktrees/s', branch: 'session/s', repoRoot: 'D:/repo',
    }))
    expect(metas.get('s')!.metadata.archived).toBe(false)
  })

  it('a child with no worktree of its own keeps the parent checkout; one with its own does not', async () => {
    const { manager, metas, refreshSummary } = setup()
    metas.get('s')!.metadata.worktree = { dir: 'D:/repo/.velloc/worktrees/s', branch: 'session/s', repoRoot: 'D:/repo' }
    metas.set('k', { schemaVersion: 1, sessionId: 'k', updatedAt: 11, metadata: {
      spawnedFrom: { sessionId: 's', taskId: 't', kind: 'side_session', initiator: 'model', name: 'k' },
    } })
    await refreshSummary('s')
    await refreshSummary('k')
    const commands: string[] = []
    const internalsOf = manager as unknown as {
      bridgeRouter: { getDirectTransport(): unknown }
      settleArchivedWorktree(id: string, archived: boolean): Promise<void>
    }
    internalsOf.bridgeRouter.getDirectTransport = () => ({
      request: async (req: { payload: { command: string } }) => {
        commands.push(req.payload.command)
        return { ok: true, result: '(no output)' }
      },
    })
    await internalsOf.settleArchivedWorktree('s', true)
    expect(commands).toEqual([])
    metas.get('k')!.metadata.worktree = { dir: 'D:/repo/.velloc/worktrees/k', branch: 'session/k', repoRoot: 'D:/repo' }
    await internalsOf.settleArchivedWorktree('s', true)
    expect(commands.some(c => c.includes('worktree remove'))).toBe(true)
  })

  it('the archive stop interrupts only a running turn, and always stops tasks, teammates and terminals', async () => {
    const closed: string[] = []
    const { manager } = setup({ closeTerminalsForSession: id => closed.push(id) })
    const internalsOf = manager as unknown as {
      sessions: Map<string, unknown>
      stopSessionForArchive(id: string): Promise<void>
      taskControl: { stopRunningForParent(id: string): void }
      teams: { abortTeammatesOf(id: string): Promise<void> }
    }
    const frames = new Map<string, string[]>()
    const fakeWorker = (id: string, busy: boolean) => {
      frames.set(id, [])
      return {
        worker: {
          isBusy: () => busy,
          receiveFrame: async (frame: { type: string }) => {
            frames.get(id)!.push(frame.type)
          },
        },
      }
    }
    internalsOf.sessions.set('busy', fakeWorker('busy', true))
    internalsOf.sessions.set('idle', fakeWorker('idle', false))
    const tasksStopped: string[] = []
    const teammatesStopped: string[] = []
    internalsOf.taskControl.stopRunningForParent = id => { tasksStopped.push(id) }
    internalsOf.teams.abortTeammatesOf = async id => { teammatesStopped.push(id) }
    await internalsOf.stopSessionForArchive('busy')
    await internalsOf.stopSessionForArchive('idle')
    await internalsOf.stopSessionForArchive('never-opened')
    expect(frames.get('busy')).toEqual(['worker.interrupt'])
    expect(frames.get('idle')).toEqual([])
    expect(internalsOf.sessions.has('never-opened')).toBe(false)
    expect(tasksStopped).toEqual(['busy', 'idle', 'never-opened'])
    expect(teammatesStopped).toEqual(['busy', 'idle', 'never-opened'])
    expect(closed).toEqual(['busy', 'idle', 'never-opened'])
  })

  it('the person archive stops the session first, then settles its worktree; a repeat or a refusal does neither', async () => {
    const { manager, metas, refreshSummary } = setup()
    await refreshSummary('s')
    const order: string[] = []
    const hooks = manager as unknown as {
      stopSessionForArchive(id: string): Promise<void>
      settleArchivedWorktree(id: string, archived: boolean): Promise<void>
    }
    hooks.stopSessionForArchive = async id => {
      order.push(`stop:${id}:${String(metas.get(id)!.metadata.archived ?? 'unset')}`)
    }
    hooks.settleArchivedWorktree = async (id, archived) => {
      order.push(`worktree:${id}:${archived}`)
    }
    const { port, send } = createPort()
    manager.handleConnect(port)
    const archive = async (archived: boolean) => {
      send({ type: 'session.archive', sessionId: 's', archived, requestId: `r-${order.length}` })
      await tick()
    }
    await archive(true)
    expect(order).toEqual(['stop:s:unset', 'worktree:s:true'])
    await archive(true)
    expect(order).toHaveLength(2)
    await archive(false)
    expect(order).toEqual(['stop:s:unset', 'worktree:s:true', 'worktree:s:false'])
    const starts = (manager as unknown as { startStates: Map<string, { state: string }> }).startStates
    starts.set('s', { state: 'starting' })
    await archive(true)
    expect(order).toHaveLength(3)
    starts.delete('s')
  })
})
