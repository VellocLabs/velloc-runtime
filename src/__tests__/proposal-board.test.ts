import { describe, expect, it, vi } from 'vitest'
import { PROPOSAL_TTL_MS, type ChildProposal, type ProposedRequest } from '../sessions/childProposals'
import { ProposalBoard, type ProposalLaunch, type ProposalLauncher } from '../sessions/proposalBoard'
import type { SpawnSessionInput } from '../sessions/childSessionSpec'

// The runtime's proposal board (F-36): the claim that makes concurrent
// starts launch once (P04), the supersede rule (P03), an offer's wait, expiry
// on an injected clock, and the metadata round trip.

function request(overrides: Partial<ProposedRequest> = {}): ProposedRequest {
  return {
    title: 'Tidy the importer',
    task: 'Remove the dead branches in the importer.',
    briefing: 'B'.repeat(90),
    from: 'fresh',
    name: '',
    isolation: '',
    model: '',
    effort: '',
    permissionMode: '',
    cwd: '',
    baseBranch: '',
    branchName: '',
    ...overrides,
  }
}

function rig(initial: Record<string, unknown> = {}) {
  let now = 1_000_000
  const stored = new Map<string, unknown>(Object.entries(initial))
  const writes: Array<{ sessionId: string; proposals: ChildProposal[] }> = []
  const changes: string[] = []
  const board = new ProposalBoard({
    storage: {
      read: async sessionId => stored.get(sessionId),
      write: async (sessionId, proposals) => {
        writes.push({ sessionId, proposals })
        stored.set(sessionId, proposals)
      },
    },
    now: () => now,
    onChange: sessionId => changes.push(sessionId),
  })
  return {
    board,
    stored,
    writes,
    changes,
    advance: (ms: number) => {
      now += ms
    },
  }
}

/** A launcher whose launches the test settles by hand. */
function gatedLauncher() {
  const calls: Array<{ input: SpawnSessionInput; taskId: string; settle: (launch: ProposalLaunch) => void }> = []
  const launcher: ProposalLauncher = (input, taskId) =>
    new Promise<ProposalLaunch>(resolve => {
      calls.push({ input, taskId, settle: resolve })
    })
  return { launcher, calls }
}

const okLaunch = (sessionId: string): ProposalLaunch => ({ ok: true, sessionId, name: 'tidy', text: `Registered ${sessionId}` })

describe('ProposalBoard — starts (P04)', () => {
  it('two concurrent starts of one proposal launch exactly one child; the second reads the real state', async () => {
    const { board } = rig()
    const p = await board.propose('parent', { mode: 'suggest', request: request() })
    const { launcher, calls } = gatedLauncher()
    const first = board.start('parent', p.taskId, launcher)
    const second = board.start('parent', p.taskId, launcher)
    await vi.waitFor(() => expect(calls).toHaveLength(1))
    expect(await second).toEqual({ ok: false, reason: expect.stringContaining('cannot be started now'), state: 'starting' })
    expect(calls[0]!.taskId).toBe(p.taskId)
    expect(calls[0]!.input).toMatchObject({ initiation: 'asked', title: 'Tidy the importer', proposalId: '' })
    calls[0]!.settle(okLaunch('child-1'))
    const done = await first
    expect(done).toMatchObject({ ok: true, proposal: { state: 'started', childSessionId: 'child-1', childName: 'tidy' } })
    // A third start (a late double-click) neither launches nor changes the record.
    expect(await board.start('parent', p.taskId, launcher)).toMatchObject({ ok: false, state: 'started' })
    expect(calls).toHaveLength(1)
  })

  it('a person\'s start and the model\'s start race: one child', async () => {
    const { board } = rig()
    const p = await board.propose('parent', { mode: 'suggest', request: request() })
    const { launcher, calls } = gatedLauncher()
    board.setLauncher('parent', launcher)
    const byPerson = board.startByPerson('parent', p.taskId)
    const byModel = board.start('parent', p.taskId, launcher)
    await vi.waitFor(() => expect(calls).toHaveLength(1))
    calls[0]!.settle(okLaunch('child-1'))
    const results = await Promise.all([byPerson, byModel])
    expect(results.filter(r => r.ok)).toHaveLength(1)
    expect(calls).toHaveLength(1)
  })

  it('a failed launch releases the claim with the reason, and a later start can succeed', async () => {
    const { board } = rig()
    const p = await board.propose('parent', { mode: 'suggest', request: request() })
    const failing: ProposalLauncher = async () => ({ ok: false, reason: 'no spawner', text: 'Refused: no spawner' })
    expect(await board.start('parent', p.taskId, failing)).toMatchObject({ ok: false, reason: 'no spawner', state: 'proposed' })
    expect(await board.get('parent', p.taskId)).toMatchObject({ state: 'proposed', failure: 'no spawner' })
    const throwing: ProposalLauncher = async () => {
      throw new Error('boom')
    }
    expect(await board.start('parent', p.taskId, throwing)).toMatchObject({ ok: false, reason: 'boom', state: 'proposed' })
    expect(await board.start('parent', p.taskId, async () => okLaunch('child-9'))).toMatchObject({ ok: true })
    expect(await board.get('parent', p.taskId)).toMatchObject({ state: 'started', childSessionId: 'child-9' })
    expect((await board.get('parent', p.taskId))!.failure).toBeUndefined()
  })

  it('a person\'s Start without a live turn to start through notes why and starts nothing', async () => {
    const { board } = rig()
    const p = await board.propose('parent', { mode: 'suggest', request: request() })
    const result = await board.startByPerson('parent', p.taskId)
    expect(result).toMatchObject({ ok: false, reason: expect.stringContaining('not running') })
    expect(await board.get('parent', p.taskId)).toMatchObject({ state: 'proposed', failure: expect.stringContaining('not running') })
  })

  it('a started or starting proposal cannot be dismissed as not started', async () => {
    const { board } = rig()
    const p = await board.propose('parent', { mode: 'suggest', request: request() })
    const { launcher, calls } = gatedLauncher()
    const starting = board.start('parent', p.taskId, launcher)
    await vi.waitFor(() => expect(calls).toHaveLength(1))
    expect(await board.dismiss('parent', p.taskId)).toEqual({ ok: false, state: 'starting' })
    calls[0]!.settle(okLaunch('child-1'))
    await starting
    expect(await board.dismiss('parent', p.taskId)).toEqual({ ok: false, state: 'started' })
    expect(await board.dismiss('parent', 'task_zzzzzzzz')).toBeNull()
  })
})

describe('ProposalBoard — offers', () => {
  it('the wait ends with the person\'s choice; "here" creates nothing', async () => {
    const { board } = rig()
    const p = await board.propose('parent', { mode: 'offer', request: request({ task: '', briefing: '' }) })
    const waiting = board.awaitOffer('parent', p.taskId)
    expect(await board.choose('parent', p.taskId, 'here')).toMatchObject({ ok: true, proposal: { state: 'dismissed', keptHere: true } })
    expect(await waiting).toBe('here')
    const q = await board.propose('parent', { mode: 'offer', request: request({ task: '', briefing: '' }) })
    const waitingNew = board.awaitOffer('parent', q.taskId)
    await board.choose('parent', q.taskId, 'new')
    expect(await waitingNew).toBe('new')
    expect(await board.get('parent', q.taskId)).toMatchObject({ state: 'accepted_awaiting_brief' })
  })

  it('a person\'s new message supersedes every open offer and ends its wait (P03)', async () => {
    const { board } = rig()
    const waitingOffer = await board.propose('parent', { mode: 'offer', request: request({ title: 'A' }) })
    const acceptedOffer = await board.propose('parent', { mode: 'offer', request: request({ title: 'B' }) })
    const suggestion = await board.propose('parent', { mode: 'suggest', request: request({ title: 'C' }) })
    await board.choose('parent', acceptedOffer.taskId, 'new')
    const waiting = board.awaitOffer('parent', waitingOffer.taskId)
    await Promise.resolve()
    board.supersedeOpenOffers('parent')
    expect(await waiting).toBe('superseded')
    expect((await board.get('parent', waitingOffer.taskId))!.state).toBe('superseded')
    expect((await board.get('parent', acceptedOffer.taskId))!.state).toBe('superseded')
    // A suggestion is not an offer: the person's message leaves it be.
    expect((await board.get('parent', suggestion.taskId))!.state).toBe('proposed')
    // The model's late brief for the superseded offer is refused.
    const { launcher, calls } = gatedLauncher()
    expect(await board.start('parent', acceptedOffer.taskId, launcher)).toMatchObject({ ok: false, state: 'superseded' })
    expect(calls).toHaveLength(0)
  })

  it('a message to another session leaves this session\'s offers open', async () => {
    const { board } = rig()
    const p = await board.propose('parent', { mode: 'offer', request: request() })
    board.supersedeOpenOffers('other')
    await new Promise(resolve => setTimeout(resolve, 0))
    expect((await board.get('parent', p.taskId))!.state).toBe('proposed')
  })

  it('a Stop of the waiting turn closes the offer unanswered', async () => {
    const { board } = rig()
    const p = await board.propose('parent', { mode: 'offer', request: request() })
    const abort = new AbortController()
    const waiting = board.awaitOffer('parent', p.taskId, abort.signal)
    await Promise.resolve()
    abort.abort()
    expect(await waiting).toBe('stopped')
    expect((await board.get('parent', p.taskId))!.state).toBe('dismissed')
  })
})

describe('ProposalBoard — expiry and storage', () => {
  it('a suggestion expires on the injected clock, is published and written, and cannot start', async () => {
    const { board, advance, changes, stored } = rig()
    const p = await board.propose('parent', { mode: 'suggest', request: request() })
    changes.length = 0
    advance(PROPOSAL_TTL_MS)
    expect((await board.views('parent'))[0]).toMatchObject({ taskId: p.taskId, state: 'expired' })
    expect(changes).toEqual(['parent'])
    await board.flush('parent')
    expect((stored.get('parent') as ChildProposal[])[0]!.state).toBe('expired')
    const { launcher, calls } = gatedLauncher()
    expect(await board.start('parent', p.taskId, launcher)).toMatchObject({ ok: false, state: 'expired' })
    expect(calls).toHaveLength(0)
  })

  it('loads a session\'s stored records once, drops malformed rows, and writes every change in order', async () => {
    const first = rig()
    const kept = await first.board.propose('parent', { mode: 'suggest', request: request() })
    await first.board.dismiss('parent', kept.taskId)
    await first.board.flush('parent')
    expect(first.writes.map(w => w.proposals[0]!.state)).toEqual(['proposed', 'dismissed'])

    const second = rig({ parent: [first.stored.get('parent') as ChildProposal[]][0]!.concat([{ junk: true } as never]) })
    const read = vi.spyOn(second.board as unknown as { load: (id: string) => Promise<unknown> }, 'load')
    const views = await second.board.views('parent')
    await second.board.views('parent')
    expect(views).toEqual([expect.objectContaining({ taskId: kept.taskId, state: 'dismissed' })])
    expect(read).toHaveBeenCalledTimes(1)
  })
})
