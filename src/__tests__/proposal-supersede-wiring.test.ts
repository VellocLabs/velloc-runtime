import { afterEach, describe, expect, it } from 'vitest'
import { SharedWorkerSessionManager } from '../browser/worker/SharedWorkerSessionManager'
import type { AgentRuntimeWorkerHandle } from '../browser/worker/AgentRuntimeWorkerHandle'
import { getProposalBoard, setProposalBoard } from '../sessions/proposalBoard'
import type { ProposedRequest } from '../sessions/childProposals'
import { getSessionDirectory, setSessionDirectory } from '../sessions/sessionDirectory'
import { buildSessionSummaryFromMetadata } from '../sessions/sessionStore'

// The manager's half of the supersede rule (F-36, P03): a person's message to
// a session closes that session's open offers before its runtime takes it.

function makeWorker(): AgentRuntimeWorkerHandle {
  return {
    async receiveFrame() {},
    getSnapshot: () => ({ initialized: true }),
    enqueueSubmit() {},
    consumePendingAsNextSubmit() {},
    pumpSubmits() {},
    isBusy: () => true,
    isStopping: () => false,
    getPhase: () => ({ kind: 'idle' }),
  } as unknown as AgentRuntimeWorkerHandle
}

const request: ProposedRequest = {
  title: 'Split the parser',
  task: '',
  briefing: '',
  from: 'fresh',
  name: '',
  isolation: '',
  model: '',
  effort: '',
  permissionMode: '',
  cwd: '',
  baseBranch: '',
  branchName: '',
}

/** An idle worker that records every frame it is handed. */
function makeIdleWorker(frames: unknown[]): AgentRuntimeWorkerHandle {
  return {
    ...makeWorker(),
    async receiveFrame(frame: unknown) {
      frames.push(frame)
    },
    isBusy: () => false,
  } as unknown as AgentRuntimeWorkerHandle
}

type Internals = {
  taskDelivery: { getPendingMap(): Map<string, unknown[]> }
  fsSummaries: Map<string, unknown>
  sessions: Map<string, unknown>
  handleSessionMessage(port: MessagePort, message: unknown): void
  listMutations: { handleSessionDelete(port: MessagePort, sessionId: string): Promise<void> }
}

afterEach(() => {
  setProposalBoard(null)
  setSessionDirectory(null)
})

describe('SharedWorkerSessionManager — proposals', () => {
  it('registers the realm\'s board, and a person\'s message supersedes that session\'s open offer only', async () => {
    const manager = new SharedWorkerSessionManager({ createWorker: makeWorker })
    const board = getProposalBoard()!
    expect(board).not.toBeNull()
    const internals = manager as unknown as Internals
    internals.sessions.set('S1', { worker: makeWorker() })
    internals.sessions.set('S2', { worker: makeWorker() })
    const mine = await board.propose('S1', { mode: 'offer', request })
    const theirs = await board.propose('S2', { mode: 'offer', request })
    const waiting = board.awaitOffer('S1', mine.taskId)
    await Promise.resolve()
    const port = { postMessage() {} } as unknown as MessagePort
    internals.handleSessionMessage(port, { type: 'worker.submitMessage', sessionId: 'S1', payload: { prompt: 'Actually, do X first.' } })
    expect(await waiting).toBe('superseded')
    expect((await board.get('S1', mine.taskId))!.state).toBe('superseded')
    expect((await board.get('S2', theirs.taskId))!.state).toBe('proposed')
  })

  it('a clear the parent\'s model starts takes the person\'s submit path: the built-in /clear reaches the worker and the cleared session\'s open offers close', async () => {
    const manager = new SharedWorkerSessionManager({ createWorker: makeWorker })
    const board = getProposalBoard()!
    const internals = manager as unknown as Internals
    const childFrames: unknown[] = []
    internals.sessions.set('P', { worker: makeIdleWorker([]) })
    internals.sessions.set('C', { worker: makeIdleWorker(childFrames) })
    internals.fsSummaries.set('P', buildSessionSummaryFromMetadata('P', 1, {}))
    internals.fsSummaries.set('C', buildSessionSummaryFromMetadata('C', 2, {
      spawnedFrom: { sessionId: 'P', taskId: 't', kind: 'side_session', initiator: 'model' },
    }))
    const childOffer = await board.propose('C', { mode: 'offer', request })
    const parentOffer = await board.propose('P', { mode: 'suggest', request })
    const waiting = board.awaitOffer('C', childOffer.taskId)
    await Promise.resolve()

    expect(await getSessionDirectory()!.clear('P', 'C')).toEqual({ ok: true })

    expect(childFrames).toEqual([{ type: 'worker.submitMessage', sessionId: 'C', payload: { prompt: '/clear' } }])
    expect((await board.get('C', childOffer.taskId))!.state).toBe('superseded')
    expect((await board.get('P', parentOffer.taskId))!.state).toBe('proposed')
    expect(await waiting).toBe('superseded')
  })

  it('a task result queued for the session holds a model-started clear, and nothing reaches its worker', async () => {
    const manager = new SharedWorkerSessionManager({ createWorker: makeWorker })
    const internals = manager as unknown as Internals
    const childFrames: unknown[] = []
    internals.sessions.set('P', { worker: makeIdleWorker([]) })
    internals.sessions.set('C', { worker: makeIdleWorker(childFrames) })
    internals.fsSummaries.set('P', buildSessionSummaryFromMetadata('P', 1, {}))
    internals.fsSummaries.set('C', buildSessionSummaryFromMetadata('C', 2, {
      spawnedFrom: { sessionId: 'P', taskId: 't', kind: 'side_session', initiator: 'model' },
    }))
    internals.taskDelivery.getPendingMap().set('C', [{ taskId: 'bg-1' }])

    expect(await getSessionDirectory()!.clear('P', 'C')).toMatchObject({ ok: false, code: 'messages_queued' })
    expect(childFrames).toEqual([])
  })

  it('the proposals of a deleted session go with it: its records are forgotten and a waiting offer ends', async () => {
    const manager = new SharedWorkerSessionManager({ createWorker: makeWorker })
    const board = getProposalBoard()!
    const internals = manager as unknown as Internals
    const gone = await board.propose('S1', { mode: 'suggest', request })
    const offer = await board.propose('S1', { mode: 'offer', request })
    const kept = await board.propose('S2', { mode: 'suggest', request })
    const waiting = board.awaitOffer('S1', offer.taskId)
    const port = { postMessage() {} } as unknown as MessagePort
    await internals.listMutations.handleSessionDelete(port, 'S1').catch(() => {})
    expect(await board.get('S1', gone.taskId)).toBeUndefined()
    expect(await waiting).toBe('stopped')
    expect(await board.get('S2', kept.taskId)).toBeDefined()
  })
})
