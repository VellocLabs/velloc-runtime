import type { AgentRuntimeWorkerInitPayload } from '../worker/workerProtocol'
import type { BrowserToolCallDetailRecord } from '../../utils/toolCallDetails'
import type { BundledSkillBodyResult } from '../../skillLibrary/builtinSkillBody'
import type { TurnFileChange } from '../../utils/turnDiffs'
import type { BrowserWorkerClientTransport } from './sharedWorkerTransport'

/** What the detail requests read on their client: the live transport, the
 *  init payload's session id, and the client's lazy start. */
export interface DetailRequestsHost {
  readonly transport: BrowserWorkerClientTransport | null
  readonly initPayload: AgentRuntimeWorkerInitPayload
  startOnce(): Promise<void>
}

/**
 * Contract: a session client's on-demand detail requests — a tool call's full
 * detail, one turn's diff hunks, a bundled skill's body — and their pending
 * replies. Loaded on the first request; the client routes the matching worker
 * replies here and releases the pending ones on dispose.
 */
export class RuntimeClientDetailRequests {
  /**
   * Outer bound for a tool-detail subscribe that never resolves — e.g. the
   * tool call was interrupted or the server restarted before persisting.
   * Short enough that a stuck click doesn't sit forever, long enough that
   * genuinely slow tools still land.
   */
  private static readonly TOOL_DETAIL_TIMEOUT_MS = 15_000
  private readonly toolCallDetailWaiters = new Map<
    string,
    Array<(detail: BrowserToolCallDetailRecord | null) => void>
  >()
  private readonly turnDiffDetailWaiters = new Map<
    number,
    Array<(files: TurnFileChange[] | null) => void>
  >()
  /** Pending `worker.getSkillBody` requests, keyed by bundled-skill name. */
  private readonly skillBodyWaiters = new Map<
    string,
    Array<(result: BundledSkillBodyResult | null) => void>
  >()
  /** Per-turn hunks, cached after first fetch; cleared on each history push. */
  private readonly turnDiffDetailCache = new Map<
    number,
    TurnFileChange[] | null
  >()

  constructor(private readonly host: DetailRequestsHost) {}

  async loadToolCallDetail(
    toolCallId: string,
  ): Promise<BrowserToolCallDetailRecord | null> {
    await this.host.startOnce()

    const transport = this.host.transport
    if (!transport?.postManagerMessage || !transport.addManagerListener) {
      // Transport doesn't expose manager-level channels (e.g. test doubles)
      // — fall back to the legacy point-to-point request so callers keep
      // working. Still no retry loop; the worker returns whatever it has
      // after one round-trip.
      return this.legacyRequestToolCallDetail(toolCallId)
    }

    return new Promise<BrowserToolCallDetailRecord | null>(resolve => {
      let settled = false
      const settle = (detail: BrowserToolCallDetailRecord | null) => {
        if (settled) return
        settled = true
        clearTimeout(timeoutId)
        unsubscribe()
        transport.postManagerMessage?.({
          type: 'toolDetail.unsubscribe',
          toolCallIds: [toolCallId],
        })
        resolve(detail)
      }

      const unsubscribe = transport.addManagerListener!(data => {
        const msg = data as { type?: string; payload?: unknown } | null
        if (msg?.type !== 'toolDetail.ready') return
        const payload = msg.payload as {
          toolCallId?: string
          detail?: BrowserToolCallDetailRecord | null
        }
        if (payload?.toolCallId !== toolCallId) return
        settle(payload.detail ?? null)
      })

      const timeoutId = setTimeout(() => {
        settle(null)
      }, RuntimeClientDetailRequests.TOOL_DETAIL_TIMEOUT_MS)

      transport.postManagerMessage!({
        type: 'toolDetail.subscribe',
        toolCallIds: [toolCallId],
        sessionId: this.host.initPayload.sessionId,
      })
    })
  }

  /**
   * Fetch one turn's hunks from the worker history cache, on expand. Cached
   * client-side after the first fetch (cleared whenever a new history pushes).
   * Point-to-point request/response (`worker.getTurnDiffDetail` →
   * `worker.turnDiffDetail`) — the worker serves it from memory.
   */
  async loadTurnDiffDetail(
    turnIndex: number,
  ): Promise<TurnFileChange[] | null> {
    await this.host.startOnce()
    const cached = this.turnDiffDetailCache.get(turnIndex)
    if (cached !== undefined) return cached

    const promise = new Promise<TurnFileChange[] | null>(resolve => {
      const waiters = this.turnDiffDetailWaiters.get(turnIndex) ?? []
      waiters.push(resolve)
      this.turnDiffDetailWaiters.set(turnIndex, waiters)
    })
    await this.host.transport?.postMessage({
      type: 'worker.getTurnDiffDetail',
      payload: { turnIndex },
    })
    return promise
  }

  resolveTurnDiffDetailWaiters(
    turnIndex: number,
    files: TurnFileChange[] | null,
  ): void {
    this.turnDiffDetailCache.set(turnIndex, files)
    const waiters = this.turnDiffDetailWaiters.get(turnIndex) ?? []
    this.turnDiffDetailWaiters.delete(turnIndex)
    for (const waiter of waiters) {
      waiter(files)
    }
  }

  /**
   * Resolve a BUNDLED skill's body for the Skills tab (`bundled:<name>` has no file on disk):
   * `worker.getSkillBody` → `worker.skillBody`, uncached. Resolves `null` on dispose.
   */
  async loadBundledSkillBody(
    name: string,
  ): Promise<BundledSkillBodyResult | null> {
    await this.host.startOnce()
    const promise = new Promise<BundledSkillBodyResult | null>(resolve => {
      const waiters = this.skillBodyWaiters.get(name) ?? []
      waiters.push(resolve)
      this.skillBodyWaiters.set(name, waiters)
    })
    await this.host.transport?.postMessage({
      type: 'worker.getSkillBody',
      payload: { name },
    })
    return promise
  }

  resolveSkillBodyWaiters(
    name: string,
    result: BundledSkillBodyResult | null,
  ): void {
    const waiters = this.skillBodyWaiters.get(name) ?? []
    this.skillBodyWaiters.delete(name)
    for (const waiter of waiters) {
      waiter(result)
    }
  }

  private async legacyRequestToolCallDetail(
    toolCallId: string,
  ): Promise<BrowserToolCallDetailRecord | null> {
    const promise = new Promise<BrowserToolCallDetailRecord | null>(resolve => {
      const waiters = this.toolCallDetailWaiters.get(toolCallId) ?? []
      waiters.push(resolve)
      this.toolCallDetailWaiters.set(toolCallId, waiters)
    })
    await this.host.transport?.postMessage({
      type: 'worker.getToolCallDetail',
      payload: { toolCallId },
    })
    return promise
  }

  resolveToolCallDetailWaiters(
    toolCallId: string,
    detail: BrowserToolCallDetailRecord | null,
  ): void {
    const waiters = this.toolCallDetailWaiters.get(toolCallId) ?? []
    this.toolCallDetailWaiters.delete(toolCallId)
    for (const waiter of waiters) {
      waiter(detail)
    }
  }

  /** A new turn-diff history may change any turn's hunks. */
  clearTurnDiffDetailCache(): void {
    this.turnDiffDetailCache.clear()
  }

  /** Resolve every pending tool-detail and skill-body request with `null`. */
  releaseWaiters(): void {
    for (const [toolCallId, waiters] of this.toolCallDetailWaiters) {
      this.toolCallDetailWaiters.delete(toolCallId)
      for (const waiter of waiters) {
        waiter(null)
      }
    }
    for (const [name, waiters] of this.skillBodyWaiters) {
      this.skillBodyWaiters.delete(name)
      for (const waiter of waiters) {
        waiter(null)
      }
    }
  }
}
