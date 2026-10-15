/**
 * Contract: TaskDeliveryQueue — background result delivery (idle, not needsAnswer, not suppressed),
 * Stop suppression and the mid-turn drain. Invariants:
 * - Stop suppresses delivery until the next genuine user submit; suppressed results are dropped
 * - results batch into one notification turn (or one mid-turn attachment)
 * - the same taskId is never queued twice for one parent
 */

/** Whether the sink accepted the delivery turn. `parent_gone` (session deleted) drops the batch AND
 *  the parent's suppression state; `temporarily_unavailable` keeps the batch for a later flush. */
export type DeliveryEnqueueResult =
  | 'accepted'
  | 'temporarily_unavailable'
  | 'parent_gone'

export interface TaskDeliveryTurnSink {
  /** Enqueue a formatted delivery turn into the parent's submit queue. */
  enqueueDeliveryTurn(
    spawnerSessionId: string,
    prompt: string,
  ): DeliveryEnqueueResult
}

export interface TaskDeliveryStateReader {
  isBusy(sessionId: string): boolean
  needsAnswer(sessionId: string): boolean
}

export type TaskDeliveryQueueOptions<T> = {
  turnSink: TaskDeliveryTurnSink
  stateReader: TaskDeliveryStateReader
  /** Format a batch of results into a single notification prompt. */
  formatBatch(results: readonly T[]): string
  /** Extract the dedup key from a result. */
  taskIdOf(result: T): string
}

export class TaskDeliveryQueue<T extends object> {
  private readonly pending = new Map<string, T[]>()
  /** When each queued result arrived: orders a mid-turn drain against the
   *  user input injected in the same round. */
  private readonly enqueuedAt = new WeakMap<T, number>()
  /** Suppression is owned here. Set on user Stop, cleared on next user submit. */
  private readonly suppressedParents = new Set<string>()

  constructor(private readonly options: TaskDeliveryQueueOptions<T>) {}

  /** Queue a result for delivery, deduplicating by taskId. Tries to flush. */
  enqueue(spawnerSessionId: string, result: T): void {
    if (!spawnerSessionId) return
    // A suppressed parent DROPS results at the door — queueing
    // them "for later" meant a task finishing during the Stop window was
    // re-injected by the flush after the user's NEXT genuine turn, which is
    // exactly the revival Stop suppression exists to prevent (and what the
    // "suppressed results are dropped (not re-queued)" invariant promises).
    // The task's terminal state stays in the registry — TaskOutput can
    // still read it on demand; it just never auto-injects.
    if (this.suppressedParents.has(spawnerSessionId)) return
    const batch = this.pending.get(spawnerSessionId) ?? []
    const id = this.options.taskIdOf(result)
    if (batch.some(r => this.options.taskIdOf(r) === id)) return
    batch.push(result)
    this.enqueuedAt.set(result, Date.now())
    this.pending.set(spawnerSessionId, batch)
    this.flushIfReady(spawnerSessionId)
  }

  /** Drop all pending results for a parent (session deleted or suppressed). */
  dropParent(spawnerSessionId: string): void {
    this.pending.delete(spawnerSessionId)
    this.suppressedParents.delete(spawnerSessionId)
  }

  /** Suppress delivery for a parent (user hit Stop). Drops pending results. */
  suppressParent(spawnerSessionId: string): void {
    this.suppressedParents.add(spawnerSessionId)
    this.pending.delete(spawnerSessionId)
  }

  /** Resume delivery for a parent (genuine user submit re-arms). */
  resumeParent(spawnerSessionId: string): void {
    this.suppressedParents.delete(spawnerSessionId)
  }

  /** Query suppression state. */
  isSuppressed(spawnerSessionId: string): boolean {
    return this.suppressedParents.has(spawnerSessionId)
  }

  hasPending(spawnerSessionId: string): boolean {
    const batch = this.pending.get(spawnerSessionId)
    return !!batch && batch.length > 0
  }

  /** Expose the internal pending map for test inspection. */
  getPendingMap(): Map<string, T[]> {
    return this.pending
  }

  /**
   * Remove results matching a predicate across all parents.
   * Returns true if anything was removed.
   */
  acknowledge(predicate: (result: T) => boolean): boolean {
    let found = false
    for (const [parentId, batch] of [...this.pending]) {
      const filtered = batch.filter(r => !predicate(r))
      if (filtered.length !== batch.length) {
        found = true
        if (filtered.length === 0) {
          this.pending.delete(parentId)
        } else {
          this.pending.set(parentId, filtered)
        }
      }
    }
    return found
  }

  /**
   * Mid-turn drain (highest priority first, removed as taken). The parent's running query loop takes the pending
   * results matching `predicate` between two tool rounds and injects them as
   * a `queued_command` attachment, so they are REMOVED here and never become
   * the idle re-activation turn. Non-matching results stay queued for the
   * normal idle flush. A suppressed parent has nothing pending (enqueue drops
   * at the door), so this never bypasses Stop suppression.
   */
  drain(spawnerSessionId: string, predicate: (result: T) => boolean): T[] {
    const batch = this.pending.get(spawnerSessionId)
    if (!batch || batch.length === 0) return []
    const taken = batch.filter(predicate)
    if (taken.length === 0) return []
    const kept = batch.filter(r => !predicate(r))
    if (kept.length === 0) {
      this.pending.delete(spawnerSessionId)
    } else {
      this.pending.set(spawnerSessionId, kept)
    }
    return taken
  }

  /** Enqueue time of a result this queue accepted (undefined otherwise). */
  enqueuedAtOf(result: T): number | undefined {
    return this.enqueuedAt.get(result)
  }

  /** Try to flush pending results for a parent if delivery conditions are met. */
  flushIfReady(spawnerSessionId: string): void {
    const batch = this.pending.get(spawnerSessionId)
    if (!batch || batch.length === 0) return
    if (!this.canDeliver(spawnerSessionId)) return

    // Results leave the queue only once the sink ACCEPTED the
    // turn. Deleting up front lost the batch when formatBatch threw or the
    // parent session had just gone away (the old void sink silently
    // returned). A GONE parent's batch is dropped outright —
    // retaining it leaked the record forever when the completion arrived
    // AFTER the parent's delete already ran dropParent (no second sweep
    // ever comes). Only `temporarily_unavailable` retains for a later
    // flush.
    const prompt = this.options.formatBatch(batch)
    const result = this.options.turnSink.enqueueDeliveryTurn(
      spawnerSessionId,
      prompt,
    )
    if (result === 'accepted') {
      this.pending.delete(spawnerSessionId)
    } else if (result === 'parent_gone') {
      this.dropParent(spawnerSessionId)
    }
  }

  /** Flush all parents that are ready (called at idle boundaries). */
  flushAll(): void {
    for (const parentId of [...this.pending.keys()]) {
      this.flushIfReady(parentId)
    }
  }

  private canDeliver(spawnerSessionId: string): boolean {
    if (this.suppressedParents.has(spawnerSessionId)) return false
    const { stateReader } = this.options
    if (stateReader.isBusy(spawnerSessionId)) return false
    if (stateReader.needsAnswer(spawnerSessionId)) return false
    return true
  }
}
