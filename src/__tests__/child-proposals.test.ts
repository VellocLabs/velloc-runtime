import { describe, expect, it } from 'vitest'
import {
  PROPOSAL_TTL_MS,
  PROPOSALS_PER_SESSION_MAX,
  applyProposalEvent,
  createProposal,
  isProposalTaskId,
  newProposalTaskId,
  proposalFromStorage,
  proposalStartMismatch,
  proposalView,
  proposedStartInput,
  trimProposals,
  withExpiry,
  type ChildProposal,
  type ProposedRequest,
} from '../sessions/childProposals'

// The proposal record and its state machine (F-36): every transition, the
// refusals with the real state, the claim that a stale release cannot undo,
// expiry on an injected clock, and the start-as-proposed rule.

const T0 = 1_000_000

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

function suggest(overrides: Partial<ChildProposal> = {}): ChildProposal {
  return { ...createProposal({ taskId: 'task_abcd1234', mode: 'suggest', request: request(), now: T0 }), ...overrides }
}

function offer(overrides: Partial<ChildProposal> = {}): ChildProposal {
  return {
    ...createProposal({ taskId: 'task_offer001', mode: 'offer', request: request({ task: '', briefing: '' }), now: T0 }),
    ...overrides,
  }
}

function step(p: ChildProposal, event: Parameters<typeof applyProposalEvent>[1], now = T0 + 1): ChildProposal {
  const result = applyProposalEvent(p, event, now)
  if (!result.ok) throw new Error(`refused in ${result.state}`)
  return result.proposal
}

describe('child proposals — ids', () => {
  it('a task id is task_ and eight lowercase alphanumerics, never one already taken', () => {
    const id = newProposalTaskId()
    expect(id).toMatch(/^task_[a-z0-9]{8}$/)
    expect(isProposalTaskId(id)).toBe(true)
    expect(isProposalTaskId('task_ABCD1234')).toBe(false)
    expect(isProposalTaskId('task_abc')).toBe(false)
    let calls = 0
    const fixed = (n: number) => {
      calls += 1
      return new Uint8Array(n).fill(calls === 1 ? 0 : 1)
    }
    expect(newProposalTaskId(new Set(['task_aaaaaaaa']), fixed)).toBe('task_bbbbbbbb')
  })
})

describe('child proposals — the state machine', () => {
  it('a suggestion is proposed, expires a week later, and carries no brief in its view', () => {
    const p = suggest()
    expect(p.state).toBe('proposed')
    expect(p.expiresAt).toBe(T0 + PROPOSAL_TTL_MS)
    expect(proposalView(p)).toEqual({ taskId: p.taskId, mode: 'suggest', state: 'proposed', title: 'Tidy the importer', expiresAt: T0 + PROPOSAL_TTL_MS })
    expect(withExpiry(p, T0 + PROPOSAL_TTL_MS - 1)).toBe(p)
    expect(withExpiry(p, T0 + PROPOSAL_TTL_MS).state).toBe('expired')
  })

  it('an offer never expires on the clock', () => {
    const p = offer()
    expect(p.expiresAt).toBeUndefined()
    expect(withExpiry(p, T0 + 10 * PROPOSAL_TTL_MS)).toBe(p)
  })

  it('claim, then settle: started with the child; a second claim is refused with the real state', () => {
    const claimed = step(suggest(), { type: 'claim', claim: 'c1' })
    expect(claimed).toMatchObject({ state: 'starting', claim: 'c1', claimedFrom: 'proposed' })
    expect(applyProposalEvent(claimed, { type: 'claim', claim: 'c2' }, T0 + 2)).toEqual({ ok: false, state: 'starting' })
    const started = step(claimed, { type: 'settle', claim: 'c1', childSessionId: 'child-1', childName: 'tidy' })
    expect(started).toMatchObject({ state: 'started', childSessionId: 'child-1', childName: 'tidy' })
    expect(started.claim).toBeUndefined()
    expect(applyProposalEvent(started, { type: 'claim', claim: 'c3' }, T0 + 3)).toEqual({ ok: false, state: 'started' })
  })

  it('a release returns the claim with the reason; a stale release or settle changes nothing', () => {
    const claimed = step(suggest(), { type: 'claim', claim: 'c1' })
    const released = step(claimed, { type: 'release', claim: 'c1', reason: 'worktree failed' })
    expect(released).toMatchObject({ state: 'proposed', failure: 'worktree failed' })
    const started = step(step(released, { type: 'claim', claim: 'c2' }), {
      type: 'settle',
      claim: 'c2',
      childSessionId: 'child-2',
      childName: 'tidy',
    })
    // The first start's late release must not overwrite the second's success.
    const late = applyProposalEvent(started, { type: 'release', claim: 'c1', reason: 'late' }, T0 + 5)
    expect(late).toEqual({ ok: true, proposal: started })
    const lateSettle = applyProposalEvent(started, { type: 'settle', claim: 'c1', childSessionId: 'x', childName: 'x' }, T0 + 5)
    expect(lateSettle).toEqual({ ok: true, proposal: started })
  })

  it('dismiss closes an open card and is refused once starting or started', () => {
    expect(step(suggest(), { type: 'dismiss' }).state).toBe('dismissed')
    const claimed = step(suggest(), { type: 'claim', claim: 'c1' })
    expect(applyProposalEvent(claimed, { type: 'dismiss' }, T0 + 2)).toEqual({ ok: false, state: 'starting' })
    const started = step(claimed, { type: 'settle', claim: 'c1', childSessionId: 's', childName: 'n' })
    expect(applyProposalEvent(started, { type: 'dismiss' }, T0 + 3)).toEqual({ ok: false, state: 'started' })
  })

  it('an expired suggestion refuses a start and a dismiss as expired', () => {
    const late = T0 + PROPOSAL_TTL_MS + 1
    expect(applyProposalEvent(suggest(), { type: 'claim', claim: 'c' }, late)).toEqual({ ok: false, state: 'expired' })
    expect(applyProposalEvent(suggest(), { type: 'dismiss' }, late)).toEqual({ ok: false, state: 'expired' })
  })

  it('an offer: "here" closes it kept here, "new" waits for the brief, and only then can it be claimed', () => {
    expect(applyProposalEvent(offer(), { type: 'claim', claim: 'c' }, T0)).toEqual({ ok: false, state: 'proposed' })
    expect(step(offer(), { type: 'choose', choice: 'here' })).toMatchObject({ state: 'dismissed', keptHere: true })
    const accepted = step(offer(), { type: 'choose', choice: 'new' })
    expect(accepted.state).toBe('accepted_awaiting_brief')
    expect(applyProposalEvent(accepted, { type: 'choose', choice: 'here' }, T0 + 2)).toEqual({ ok: false, state: 'accepted_awaiting_brief' })
    const claimed = step(accepted, { type: 'claim', claim: 'c1' })
    expect(claimed).toMatchObject({ state: 'starting', claimedFrom: 'accepted_awaiting_brief' })
    expect(step(claimed, { type: 'release', claim: 'c1', reason: 'r' }).state).toBe('accepted_awaiting_brief')
    expect(applyProposalEvent(suggest(), { type: 'choose', choice: 'new' }, T0)).toEqual({ ok: false, state: 'proposed' })
  })

  it('supersede closes an open offer, waiting or accepted, and nothing else', () => {
    expect(step(offer(), { type: 'supersede' }).state).toBe('superseded')
    expect(step(step(offer(), { type: 'choose', choice: 'new' }), { type: 'supersede' }).state).toBe('superseded')
    expect(applyProposalEvent(suggest(), { type: 'supersede' }, T0)).toEqual({ ok: false, state: 'proposed' })
    const superseded = step(offer(), { type: 'supersede' })
    expect(applyProposalEvent(superseded, { type: 'choose', choice: 'new' }, T0 + 2)).toEqual({ ok: false, state: 'superseded' })
  })
})

describe('child proposals — storage', () => {
  it('reads a record back, drops a malformed one, and closes what could not survive a restart', () => {
    expect(proposalFromStorage(suggest(), T0)).toEqual(suggest())
    expect(proposalFromStorage({ ...suggest(), taskId: 'nope' }, T0)).toBeNull()
    expect(proposalFromStorage({ ...suggest(), request: { title: 'x' } }, T0)).toBeNull()
    expect(proposalFromStorage(null, T0)).toBeNull()
    const inFlight = proposalFromStorage({ ...suggest(), state: 'starting', claim: 'c', claimedFrom: 'proposed' }, T0 + 1)!
    expect(inFlight).toMatchObject({ state: 'proposed' })
    expect(inFlight.failure).toMatch(/restarted/)
    // An offer's waiting call does not survive the runtime; its card closes.
    expect(proposalFromStorage(offer(), T0 + 1)!.state).toBe('expired')
    expect(proposalFromStorage(suggest(), T0 + PROPOSAL_TTL_MS)!.state).toBe('expired')
  })

  it('keeps at most the cap, dropping the oldest closed records first', () => {
    const list: ChildProposal[] = []
    for (let i = 0; i < PROPOSALS_PER_SESSION_MAX + 2; i++) {
      list.push({ ...suggest(), taskId: `task_${String(i).padStart(8, '0')}`, updatedAt: i, state: i < 3 ? 'dismissed' : 'proposed' })
    }
    const kept = trimProposals(list)
    expect(kept).toHaveLength(PROPOSALS_PER_SESSION_MAX)
    expect(kept.map(p => p.taskId)).not.toContain('task_00000000')
    expect(kept.map(p => p.taskId)).not.toContain('task_00000001')
    expect(kept.map(p => p.taskId)).toContain('task_00000002')
  })
})

describe('child proposals — starting exactly as proposed (P05)', () => {
  it('a suggestion refuses any changed field, naming it; "" and the same value pass', () => {
    const p = suggest()
    expect(proposalStartMismatch(p, { task: '', briefing: '', from: '' })).toBeNull()
    expect(proposalStartMismatch(p, { task: p.request.task, title: p.request.title })).toBeNull()
    expect(proposalStartMismatch(p, { task: 'Do something else.' })).toMatch(/^task differs/)
    expect(proposalStartMismatch(p, { briefing: 'C'.repeat(90) })).toMatch(/^briefing differs/)
    expect(proposalStartMismatch(p, { from: 'fork' })).toMatch(/^from differs/)
    expect(proposalStartMismatch(p, { cwd: '/elsewhere' })).toMatch(/^cwd differs/)
    expect(proposalStartMismatch(p, { isolation: 'worktree' })).toMatch(/^isolation differs/)
    expect(proposalStartMismatch(p, { branchName: 'other' })).toMatch(/^branchName differs/)
  })

  it('an accepted offer takes its task and briefing now, but not a new target', () => {
    const p = step(offer(), { type: 'choose', choice: 'new' })
    expect(proposalStartMismatch(p, { task: 'Now the task.', briefing: 'D'.repeat(90) })).toBeNull()
    expect(proposalStartMismatch(p, { from: 'fork' })).toMatch(/^from differs/)
    expect(proposalStartMismatch(p, { cwd: '/elsewhere' })).toMatch(/^cwd differs/)
    expect(proposedStartInput(p, { task: 'Now the task.', briefing: 'D'.repeat(90) })).toMatchObject({
      initiation: 'asked',
      proposalId: '',
      title: 'Tidy the importer',
      task: 'Now the task.',
      briefing: 'D'.repeat(90),
      from: 'fresh',
    })
  })

  it('a suggestion starts with its own brief whatever the start passes', () => {
    const p = suggest()
    expect(proposedStartInput(p, {})).toMatchObject({ task: p.request.task, briefing: p.request.briefing, proposalId: '' })
  })
})
