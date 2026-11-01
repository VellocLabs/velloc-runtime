import { afterEach, describe, expect, it } from 'vitest'
import { SharedWorkerSessionManager } from '../browser/worker/SharedWorkerSessionManager'
import type { AgentRuntimeWorkerHandle } from '../browser/worker/AgentRuntimeWorkerHandle'
import { getProposalBoard, setProposalBoard } from '../sessions/proposalBoard'
import type { ProposedRequest } from '../sessions/childProposals'

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

type Internals = {
  sessions: Map<string, unknown>
  handleSessionMessage(port: MessagePort, message: unknown): void
}

afterEach(() => {
  setProposalBoard(null)
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
})
