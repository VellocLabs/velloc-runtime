/**
 * Contract: ProposalBoard — the runtime's record of every session's child
 * proposals (F-36). It owns the state; the page reads it published and acts
 * through protocol actions, the model through the proposal tools.
 * - one record list per session, loaded once from the session's metadata and
 *   written back after every change, in order
 * - a start is a claim, a launch and a settle or release; the claim is taken
 *   synchronously on the loaded list, so two concurrent starts of one proposal
 *   launch once, and a release never overwrites a settle
 * - an offer's tool call waits here for the person's choice; a person's new
 *   message, a Stop, or the choice itself ends the wait
 * Runs in the SharedWorker; the clock is injected for expiry.
 */

import type { SpawnSessionInput } from './childSessionSpec'
import {
  applyProposalEvent,
  createProposal,
  newProposalTaskId,
  proposalFromStorage,
  proposalView,
  proposedStartInput,
  trimProposals,
  withExpiry,
  type ChildProposal,
  type ProposalEvent,
  type ProposalMode,
  type ProposalState,
  type ProposalTransition,
  type ProposalView,
  type ProposedRequest,
} from './childProposals'

/** Where a session's proposals are kept: its metadata. */
export type ProposalStorage = {
  /** The stored list (anything; malformed rows are dropped), or undefined. */
  read(sessionId: string): Promise<unknown>
  write(sessionId: string, proposals: ChildProposal[]): Promise<void>
}

/** The outcome of one launch: a child on record, or nothing created. */
export type ProposalLaunch =
  | { ok: true; sessionId: string; name: string; text: string }
  | { ok: false; reason: string; text: string }

/** Starts a child for a proposal's request, recording `taskId` as its
 *  origin; bound to a turn of the session that proposed it, whose checks and
 *  capabilities the start runs under. */
export type ProposalLauncher = (input: SpawnSessionInput, taskId: string) => Promise<ProposalLaunch>

export type ProposalStartResult =
  | { ok: true; proposal: ChildProposal; launch: Extract<ProposalLaunch, { ok: true }> }
  | { ok: false; reason: string; state?: ProposalState; text?: string }

/** How an offer's wait ended. */
export type OfferOutcome = 'new' | 'here' | 'superseded' | 'stopped'

type Waiter = (outcome: OfferOutcome) => void

export class ProposalBoard {
  private readonly lists = new Map<string, ChildProposal[]>()
  private readonly loading = new Map<string, Promise<ChildProposal[]>>()
  private readonly writes = new Map<string, Promise<void>>()
  private readonly waiters = new Map<string, Waiter>()
  private readonly launchers = new Map<string, ProposalLauncher>()
  private claims = 0

  constructor(
    private readonly options: {
      storage: ProposalStorage
      now?: () => number
      onChange?: (sessionId: string) => void
    },
  ) {}

  private now(): number {
    return this.options.now?.() ?? Date.now()
  }

  /** The session's records, loaded once; expiry applied. */
  private async ensure(sessionId: string): Promise<ChildProposal[]> {
    const loaded = this.lists.get(sessionId)
    if (loaded) return this.expire(sessionId, loaded)
    let pending = this.loading.get(sessionId)
    if (!pending) {
      pending = this.load(sessionId)
      this.loading.set(sessionId, pending)
    }
    const list = await pending
    return this.expire(sessionId, this.lists.get(sessionId) ?? list)
  }

  private async load(sessionId: string): Promise<ChildProposal[]> {
    let stored: unknown
    try {
      stored = await this.options.storage.read(sessionId)
    } catch {
      stored = undefined
    }
    const now = this.now()
    const rows = Array.isArray(stored) ? stored : []
    const list: ChildProposal[] = []
    let changed = false
    for (const row of rows) {
      const p = proposalFromStorage(row, now)
      if (!p) {
        changed = true
        continue
      }
      if (p !== row) changed = true
      list.push(p)
    }
    // A record created while the read was in flight stays; it is newer.
    const meanwhile = this.lists.get(sessionId) ?? []
    const merged = [...list.filter(p => !meanwhile.some(m => m.taskId === p.taskId)), ...meanwhile]
    this.lists.set(sessionId, merged)
    this.loading.delete(sessionId)
    if (changed) this.persist(sessionId)
    return merged
  }

  private expire(sessionId: string, list: ChildProposal[]): ChildProposal[] {
    const now = this.now()
    let changed = false
    const next = list.map(p => {
      const q = withExpiry(p, now)
      if (q !== p) changed = true
      return q
    })
    if (!changed) return list
    this.lists.set(sessionId, next)
    this.persist(sessionId)
    this.options.onChange?.(sessionId)
    return next
  }

  private persist(sessionId: string): void {
    const previous = this.writes.get(sessionId) ?? Promise.resolve()
    const write = previous
      .then(() => this.options.storage.write(sessionId, [...(this.lists.get(sessionId) ?? [])]))
      .catch(() => {
        // The in-memory record still drives the card; the next change rewrites it.
      })
    this.writes.set(sessionId, write)
  }

  /** Test seam and shutdown aid: resolves once every queued write landed. */
  async flush(sessionId: string): Promise<void> {
    await (this.writes.get(sessionId) ?? Promise.resolve())
  }

  /** Apply `event` to one loaded record, synchronously. Null when the
   *  session holds no such proposal. */
  private applyLoaded(sessionId: string, taskId: string, event: ProposalEvent): ProposalTransition | null {
    const list = this.lists.get(sessionId)
    const index = list?.findIndex(p => p.taskId === taskId) ?? -1
    if (!list || index < 0) return null
    const current = list[index]!
    const result = applyProposalEvent(current, event, this.now())
    if (result.ok && result.proposal !== current) {
      const next = [...list]
      next[index] = result.proposal
      this.lists.set(sessionId, next)
      this.persist(sessionId)
      this.options.onChange?.(sessionId)
    }
    return result
  }

  /** The loaded records as they are now; read after an await, never a
   *  list captured before it. */
  private current(sessionId: string): ChildProposal[] {
    return this.lists.get(sessionId) ?? []
  }

  async list(sessionId: string): Promise<ChildProposal[]> {
    await this.ensure(sessionId)
    return [...this.current(sessionId)]
  }

  async views(sessionId: string): Promise<ProposalView[]> {
    await this.ensure(sessionId)
    return this.current(sessionId).map(proposalView)
  }

  async get(sessionId: string, taskId: string): Promise<ChildProposal | undefined> {
    await this.ensure(sessionId)
    return this.current(sessionId).find(p => p.taskId === taskId)
  }

  /** Record a new proposal; nothing runs. */
  async propose(
    sessionId: string,
    args: { mode: ProposalMode; request: ProposedRequest; toolCallId?: string },
  ): Promise<ChildProposal> {
    await this.ensure(sessionId)
    const list = this.current(sessionId)
    const taken = new Set(list.map(p => p.taskId))
    const proposal = createProposal({
      taskId: newProposalTaskId(taken),
      mode: args.mode,
      request: args.request,
      now: this.now(),
      ...(args.toolCallId ? { toolCallId: args.toolCallId } : {}),
    })
    this.lists.set(sessionId, trimProposals([...list, proposal]))
    this.persist(sessionId)
    this.options.onChange?.(sessionId)
    return proposal
  }

  /** The launcher a person's Start runs through: the latest turn of the
   *  session that proposed, set by its proposal tools. */
  setLauncher(sessionId: string, launcher: ProposalLauncher | null): void {
    if (launcher) this.launchers.set(sessionId, launcher)
    else this.launchers.delete(sessionId)
  }

  /**
   * Wait for the person's answer to an open offer. A Stop of the turn
   * (`signal`) closes the offer unanswered.
   */
  async awaitOffer(sessionId: string, taskId: string, signal?: AbortSignal): Promise<OfferOutcome> {
    await this.ensure(sessionId)
    // Read and register in one synchronous step, so a choice cannot land
    // between them unseen.
    const p = this.current(sessionId).find(q => q.taskId === taskId)
    if (!p) return 'stopped'
    if (p.state !== 'proposed') return outcomeOfClosedOffer(p)
    const key = waiterKey(sessionId, taskId)
    return new Promise<OfferOutcome>(resolve => {
      const onAbort = () => {
        if (this.waiters.get(key) !== settle) return
        this.applyLoaded(sessionId, taskId, { type: 'dismiss' })
        settle('stopped')
      }
      const settle: Waiter = outcome => {
        if (this.waiters.get(key) === settle) this.waiters.delete(key)
        signal?.removeEventListener('abort', onAbort)
        resolve(outcome)
      }
      this.waiters.set(key, settle)
      if (signal?.aborted) onAbort()
      else signal?.addEventListener('abort', onAbort, { once: true })
    })
  }

  private wake(sessionId: string, taskId: string, outcome: OfferOutcome): void {
    this.waiters.get(waiterKey(sessionId, taskId))?.(outcome)
  }

  /** The person's answer to an offer. */
  async choose(sessionId: string, taskId: string, choice: 'new' | 'here'): Promise<ProposalTransition | null> {
    await this.ensure(sessionId)
    const result = this.applyLoaded(sessionId, taskId, { type: 'choose', choice })
    if (result?.ok) this.wake(sessionId, taskId, choice)
    return result
  }

  /** Dismiss (the person) or withdraw (the model) an open proposal. A start
   *  in flight or done is refused with its real state. */
  async dismiss(sessionId: string, taskId: string): Promise<ProposalTransition | null> {
    await this.ensure(sessionId)
    const result = this.applyLoaded(sessionId, taskId, { type: 'dismiss' })
    if (result?.ok) this.wake(sessionId, taskId, 'stopped')
    return result
  }

  /** A person's new message: every open offer of the session is closed, and
   *  a call waiting on one is told so. */
  supersedeOpenOffers(sessionId: string): void {
    const run = () => {
      for (const p of this.lists.get(sessionId) ?? []) {
        if (p.mode !== 'offer') continue
        if (p.state !== 'proposed' && p.state !== 'accepted_awaiting_brief') continue
        const result = this.applyLoaded(sessionId, p.taskId, { type: 'supersede' })
        if (result?.ok) this.wake(sessionId, p.taskId, 'superseded')
      }
    }
    if (this.lists.has(sessionId)) run()
    else void this.ensure(sessionId).then(run, () => {})
  }

  /**
   * Start a proposal as proposed: claim, launch, settle or release. `input`
   * carries an accepted offer's brief; the caller has already checked that it
   * changes nothing else.
   */
  async start(
    sessionId: string,
    taskId: string,
    launcher: ProposalLauncher,
    input: Partial<SpawnSessionInput> = {},
  ): Promise<ProposalStartResult> {
    await this.ensure(sessionId)
    const claim = `claim-${++this.claims}`
    const claimed = this.applyLoaded(sessionId, taskId, { type: 'claim', claim })
    if (!claimed) return { ok: false, reason: `this session has no proposal ${taskId}.` }
    if (!claimed.ok) return { ok: false, reason: `proposal ${taskId} cannot be started now.`, state: claimed.state }
    let launch: ProposalLaunch
    try {
      launch = await launcher(proposedStartInput(claimed.proposal, input), taskId)
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error)
      launch = { ok: false, reason, text: `Refused: ${reason}` }
    }
    if (!launch.ok) {
      this.applyLoaded(sessionId, taskId, { type: 'release', claim, reason: launch.reason })
      const state = (await this.get(sessionId, taskId))?.state
      return { ok: false, reason: launch.reason, text: launch.text, ...(state ? { state } : {}) }
    }
    const settled = this.applyLoaded(sessionId, taskId, {
      type: 'settle',
      claim,
      childSessionId: launch.sessionId,
      childName: launch.name,
    })
    const proposal = settled?.ok ? settled.proposal : claimed.proposal
    return { ok: true, proposal, launch }
  }

  /** A person's Start click. Without a live turn to start it through, the
   *  card says why and nothing changes state. */
  async startByPerson(sessionId: string, taskId: string): Promise<ProposalStartResult> {
    const launcher = this.launchers.get(sessionId)
    if (!launcher) {
      await this.ensure(sessionId)
      const reason = 'the session that proposed it is not running; open it, or ask its model to start it.'
      const noted = this.applyLoaded(sessionId, taskId, { type: 'fail', reason })
      if (!noted) return { ok: false, reason: `this session has no proposal ${taskId}.` }
      return noted.ok ? { ok: false, reason } : { ok: false, reason, state: noted.state }
    }
    return this.start(sessionId, taskId, launcher)
  }

  /** Forget a deleted session's records and waits. */
  forget(sessionId: string): void {
    this.lists.delete(sessionId)
    this.launchers.delete(sessionId)
    for (const key of Array.from(this.waiters.keys())) {
      if (key.startsWith(`${sessionId}\u0000`)) this.waiters.get(key)?.('stopped')
    }
  }
}

function waiterKey(sessionId: string, taskId: string): string {
  return `${sessionId}\u0000${taskId}`
}

function outcomeOfClosedOffer(p: ChildProposal): OfferOutcome {
  if (p.state === 'accepted_awaiting_brief' || p.state === 'starting' || p.state === 'started') return 'new'
  if (p.state === 'superseded') return 'superseded'
  if (p.keptHere) return 'here'
  return 'stopped'
}

let board: ProposalBoard | null = null
const changeListeners = new Set<(sessionId: string) => void>()

/** The manager registers the realm's board at boot; tools and the protocol
 *  capability read it. Null before then. */
export function setProposalBoard(next: ProposalBoard | null): void {
  board = next
}

export function getProposalBoard(): ProposalBoard | null {
  return board
}

/** The board's change feed, for the protocol topic. */
export function onProposalsChanged(listener: (sessionId: string) => void): () => void {
  changeListeners.add(listener)
  return () => {
    changeListeners.delete(listener)
  }
}

export function notifyProposalsChanged(sessionId: string): void {
  for (const listener of Array.from(changeListeners)) listener(sessionId)
}
