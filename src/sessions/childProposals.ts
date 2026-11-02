/**
 * Proposals for child sessions (F-36): a card in the transcript that starts a
 * child only when a person, or the model on the person's word, says so. Pure:
 * the record, its state machine (`applyProposalEvent`), expiry, the
 * start-as-proposed rule, and the texts the proposal tools answer the model
 * with.
 */

import type { SpawnSessionInput } from './childSessionSpec'

export const PROPOSE_SESSION_TOOL_NAME = 'ProposeSession'
export const WITHDRAW_PROPOSAL_TOOL_NAME = 'WithdrawProposal'
export const HAND_OFF_SESSION_TOOL_NAME = 'HandOffSession'

/** `suggest`: a card the person may start or dismiss. `offer`: a card asking
 *  the person, before anything starts, whether to use a new session. */
export type ProposalMode = 'suggest' | 'offer'

export type ProposalState =
  | 'proposed'
  | 'accepted_awaiting_brief'
  | 'starting'
  | 'started'
  | 'dismissed'
  | 'expired'
  | 'superseded'

export const PROPOSAL_STATES: readonly ProposalState[] = [
  'proposed',
  'accepted_awaiting_brief',
  'starting',
  'started',
  'dismissed',
  'expired',
  'superseded',
]

/** How long a `suggest` card waits for the person. */
export const PROPOSAL_TTL_MS = 7 * 24 * 60 * 60 * 1000

/** Most proposals a session keeps; the oldest closed ones go first. */
export const PROPOSALS_PER_SESSION_MAX = 50

/** The request fields a proposal fixes, as the model wrote them (`""` for
 *  none). The same fields `SpawnSession` takes, without `initiation` and
 *  `proposalId`. */
export type ProposedRequest = Required<Omit<SpawnSessionInput, 'initiation' | 'proposalId'>>

export const PROPOSED_REQUEST_FIELDS: readonly (keyof ProposedRequest)[] = [
  'title',
  'task',
  'briefing',
  'from',
  'name',
  'isolation',
  'model',
  'effort',
  'permissionMode',
  'cwd',
  'baseBranch',
  'branchName',
]

/** The fields an accepted offer's brief supplies after the person said yes. */
const BRIEF_FIELDS: readonly (keyof ProposedRequest)[] = ['task', 'briefing']

/** One proposal, as the proposing session's metadata stores it. */
export type ChildProposal = {
  taskId: string
  mode: ProposalMode
  state: ProposalState
  request: ProposedRequest
  /** The tool call that made it, so the transcript card finds its record. */
  toolCallId?: string
  createdAt: number
  updatedAt: number
  /** For `suggest`: when the card stops accepting a start. */
  expiresAt?: number
  /** While `starting`: the claim the start holds and the state it came from. */
  claim?: string
  claimedFrom?: 'proposed' | 'accepted_awaiting_brief'
  /** Once `started`: the child. */
  childSessionId?: string
  childName?: string
  /** Set on an offer the person chose to keep in this session. */
  keptHere?: boolean
  /** Why the last start did not happen. */
  failure?: string
}

/** What the transcript card reads: the state, never the brief. */
export type ProposalView = {
  taskId: string
  mode: ProposalMode
  state: ProposalState
  title: string
  toolCallId?: string
  expiresAt?: number
  childSessionId?: string
  childName?: string
  keptHere?: boolean
  failure?: string
}

export function proposalView(p: ChildProposal): ProposalView {
  return {
    taskId: p.taskId,
    mode: p.mode,
    state: p.state,
    title: p.request.title,
    ...(p.toolCallId ? { toolCallId: p.toolCallId } : {}),
    ...(p.expiresAt !== undefined ? { expiresAt: p.expiresAt } : {}),
    ...(p.childSessionId ? { childSessionId: p.childSessionId } : {}),
    ...(p.childName ? { childName: p.childName } : {}),
    ...(p.keptHere ? { keptHere: true } : {}),
    ...(p.failure ? { failure: p.failure } : {}),
  }
}

const TASK_ID_PATTERN = /^task_[a-z0-9]{8}$/
const TASK_ID_ALPHABET = 'abcdefghijklmnopqrstuvwxyz0123456789'

export function isProposalTaskId(value: unknown): value is string {
  return typeof value === 'string' && TASK_ID_PATTERN.test(value)
}

/** `task_` and eight lowercase alphanumerics, not one of `taken`. */
export function newProposalTaskId(
  taken: ReadonlySet<string> = new Set(),
  random: (n: number) => Uint8Array = randomBytes,
): string {
  for (;;) {
    const bytes = random(8)
    let id = 'task_'
    for (let i = 0; i < 8; i++) id += TASK_ID_ALPHABET[bytes[i]! % TASK_ID_ALPHABET.length]
    if (!taken.has(id)) return id
  }
}

function randomBytes(n: number): Uint8Array {
  const bytes = new Uint8Array(n)
  const crypto = globalThis.crypto
  if (crypto?.getRandomValues) return crypto.getRandomValues(bytes)
  for (let i = 0; i < n; i++) bytes[i] = Math.floor(Math.random() * 256)
  return bytes
}

/** A new record. `suggest` expires `PROPOSAL_TTL_MS` after `now`. */
export function createProposal(args: {
  taskId: string
  mode: ProposalMode
  request: ProposedRequest
  now: number
  toolCallId?: string
}): ChildProposal {
  return {
    taskId: args.taskId,
    mode: args.mode,
    state: 'proposed',
    request: { ...args.request },
    ...(args.toolCallId ? { toolCallId: args.toolCallId } : {}),
    createdAt: args.now,
    updatedAt: args.now,
    ...(args.mode === 'suggest' ? { expiresAt: args.now + PROPOSAL_TTL_MS } : {}),
  }
}

/** Whether the person or the model can still act on it. */
export function isOpenProposal(p: ChildProposal): boolean {
  return p.state === 'proposed' || p.state === 'accepted_awaiting_brief'
}

/** `p` with its expiry applied at `now`: a `suggest` card still `proposed`
 *  past its deadline is `expired`. Returns `p` itself when nothing changed. */
export function withExpiry(p: ChildProposal, now: number): ChildProposal {
  if (p.mode !== 'suggest' || p.state !== 'proposed') return p
  if (p.expiresAt === undefined || now < p.expiresAt) return p
  return { ...p, state: 'expired', updatedAt: now }
}

export type ProposalEvent =
  | { type: 'claim'; claim: string }
  | { type: 'settle'; claim: string; childSessionId: string; childName: string }
  | { type: 'release'; claim: string; reason: string }
  | { type: 'dismiss' }
  | { type: 'choose'; choice: 'new' | 'here' }
  | { type: 'supersede' }
  | { type: 'fail'; reason: string }

export type ProposalTransition =
  | { ok: true; proposal: ChildProposal }
  | { ok: false; state: ProposalState }

/**
 * The next record for `event`, after expiry at `now`; refused with the real
 * state when the event does not apply. A settle or release that does not hold
 * the current claim changes nothing (`ok: true`, same record), so a failed
 * start can never overwrite a success.
 */
export function applyProposalEvent(
  current: ChildProposal,
  event: ProposalEvent,
  now: number,
): ProposalTransition {
  const p = withExpiry(current, now)
  const next = (patch: Partial<ChildProposal>): ProposalTransition => ({
    ok: true,
    proposal: { ...p, ...patch, updatedAt: now },
  })
  const refuse = (): ProposalTransition => ({ ok: false, state: p.state })
  switch (event.type) {
    case 'claim': {
      const startable =
        (p.mode === 'suggest' && p.state === 'proposed') ||
        (p.mode === 'offer' && p.state === 'accepted_awaiting_brief')
      if (!startable) return refuse()
      return next({
        state: 'starting',
        claim: event.claim,
        claimedFrom: p.state as 'proposed' | 'accepted_awaiting_brief',
        failure: undefined,
      })
    }
    case 'settle':
      if (p.state !== 'starting' || p.claim !== event.claim) return { ok: true, proposal: p }
      return next({
        state: 'started',
        claim: undefined,
        claimedFrom: undefined,
        childSessionId: event.childSessionId,
        childName: event.childName,
        failure: undefined,
      })
    case 'release':
      if (p.state !== 'starting' || p.claim !== event.claim) return { ok: true, proposal: p }
      return next({
        state: p.claimedFrom ?? 'proposed',
        claim: undefined,
        claimedFrom: undefined,
        failure: event.reason,
      })
    case 'dismiss':
      if (!isOpenProposal(p)) return refuse()
      return next({ state: 'dismissed' })
    case 'choose':
      if (p.mode !== 'offer' || p.state !== 'proposed') return refuse()
      return event.choice === 'here'
        ? next({ state: 'dismissed', keptHere: true })
        : next({ state: 'accepted_awaiting_brief' })
    case 'supersede':
      if (p.mode !== 'offer' || !isOpenProposal(p)) return refuse()
      return next({ state: 'superseded' })
    case 'fail':
      if (!isOpenProposal(p)) return refuse()
      return next({ failure: event.reason })
  }
}

/**
 * A record read back from storage, or null when malformed. A start that was
 * in flight when the runtime went away goes back to where it came from, and
 * an offer still waiting for its answer is closed: the call that waited for
 * it did not survive.
 */
export function proposalFromStorage(value: unknown, now: number): ChildProposal | null {
  if (typeof value !== 'object' || value === null) return null
  const v = value as Record<string, unknown>
  if (!isProposalTaskId(v.taskId)) return null
  if (v.mode !== 'suggest' && v.mode !== 'offer') return null
  if (!(PROPOSAL_STATES as readonly unknown[]).includes(v.state)) return null
  if (typeof v.createdAt !== 'number' || typeof v.updatedAt !== 'number') return null
  const request = v.request as Record<string, unknown> | undefined
  if (!request || typeof request !== 'object') return null
  for (const field of PROPOSED_REQUEST_FIELDS) {
    if (typeof request[field] !== 'string') return null
  }
  let p = v as unknown as ChildProposal
  if (p.state === 'starting') {
    p = {
      ...p,
      state: p.claimedFrom ?? 'proposed',
      claim: undefined,
      claimedFrom: undefined,
      failure: 'the runtime restarted while it was starting; start it again.',
      updatedAt: now,
    }
  }
  if (p.mode === 'offer' && p.state === 'proposed') {
    p = { ...p, state: 'expired', updatedAt: now }
  }
  return withExpiry(p, now)
}

/** At most `PROPOSALS_PER_SESSION_MAX`, dropping the oldest closed ones. */
export function trimProposals(list: readonly ChildProposal[]): ChildProposal[] {
  if (list.length <= PROPOSALS_PER_SESSION_MAX) return [...list]
  let excess = list.length - PROPOSALS_PER_SESSION_MAX
  const dropped = new Set<string>()
  const byAge = [...list].sort((a, b) => a.updatedAt - b.updatedAt)
  for (const p of byAge) {
    if (excess === 0) break
    if (isOpenProposal(p) || p.state === 'starting') continue
    dropped.add(p.taskId)
    excess -= 1
  }
  return list.filter(p => !dropped.has(p.taskId))
}

/**
 * Why a start of `proposal` with `input` is not "as proposed", or null. Every
 * supplied request field must be empty or equal the proposed value. The one exception is
 * the brief of an accepted offer: its task and briefing come now.
 */
export function proposalStartMismatch(
  proposal: ChildProposal,
  input: Partial<SpawnSessionInput>,
): string | null {
  const briefNow = proposal.mode === 'offer'
  for (const field of PROPOSED_REQUEST_FIELDS) {
    if (briefNow && BRIEF_FIELDS.includes(field)) continue
    const given = typeof input[field] === 'string' ? (input[field] as string).trim() : ''
    if (given && given !== proposal.request[field].trim()) {
      return `${field} differs from what proposal ${proposal.taskId} proposed; a proposal starts exactly as proposed. Omit ${field}, or propose a new one.`
    }
  }
  return null
}

/** The request a start runs: the proposal's, with an accepted offer's brief. */
export function proposedStartInput(
  proposal: ChildProposal,
  input: Partial<SpawnSessionInput>,
): SpawnSessionInput {
  const brief = (field: 'task' | 'briefing'): string => {
    const given = typeof input[field] === 'string' ? (input[field] as string).trim() : ''
    return proposal.mode === 'offer' && given ? given : proposal.request[field]
  }
  return {
    ...proposal.request,
    task: brief('task'),
    briefing: brief('briefing'),
    initiation: 'asked',
    proposalId: '',
  }
}

/** The model-facing words for a state it cannot act from. */
export function proposalStateWords(p: Pick<ChildProposal, 'state' | 'childSessionId' | 'keptHere'>): string {
  switch (p.state) {
    case 'proposed':
      return 'waiting for the user'
    case 'accepted_awaiting_brief':
      return 'accepted by the user and waiting for your brief'
    case 'starting':
      return 'starting right now'
    case 'started':
      return p.childSessionId ? `already started as session ${p.childSessionId}` : 'already started'
    case 'dismissed':
      return p.keptHere ? 'closed: the user chose to do it in this session' : 'dismissed'
    case 'expired':
      return 'expired'
    case 'superseded':
      return 'closed: the user sent a new message before choosing'
  }
}

export function suggestionRecordedText(p: ChildProposal): string {
  return (
    `Proposed "${p.request.title}" as task ${p.taskId}. Nothing has started: the user sees a card ` +
    'to start or dismiss it, and it expires in 7 days. Do not describe it as running. If the user ' +
    `tells you to start it, call SpawnSession with proposalId "${p.taskId}" and no other fields.`
  )
}

export function offerKeptHereText(p: ChildProposal): string {
  return `The user chose to do "${p.request.title}" here. No session was created: carry on with the task in this session.`
}

export function offerAcceptedText(p: ChildProposal): string {
  return (
    `The user chose a new session for "${p.request.title}" (task ${p.taskId}). Nothing has started yet: ` +
    `call SpawnSession now with proposalId "${p.taskId}", a task, and a briefing written for a reader who ` +
    'has not seen this conversation; omit the other fields to keep what you proposed.'
  )
}

export function offerSupersededText(p: ChildProposal): string {
  return `The user sent a new message before choosing, so the offer for "${p.request.title}" is closed. Nothing was started; follow their new message.`
}

export function offerStoppedText(p: ChildProposal): string {
  return `The offer for "${p.request.title}" was closed without a choice because the turn was stopped. Nothing was started.`
}

/** The parent's words after a hand-off: stop the moved task, answer the user. */
export function handOffRegisteredText(args: { sessionId: string; name: string; title: string }): string {
  return (
    `Handed off "${args.title}" to child session "${args.name}" (session ${args.sessionId}): a copy of this ` +
    'conversation whose first message is the remaining plan. Registered means it is starting, not that its ' +
    'model has read the plan. Stop working on that task here and do not repeat its steps in this session; ' +
    'this session keeps running, so answer the user\'s latest message.'
  )
}
