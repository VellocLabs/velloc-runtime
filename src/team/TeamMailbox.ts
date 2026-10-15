/**
 * Per-session inter-agent mailbox. `enqueue` resolves a parked waiter (idle
 * recipient: the message becomes its next turn's prompt) or queues it (taken
 * between tool rounds or at the next turn). A parked waiter is the idle bit.
 * An entry's `ack` fires once, when consumed; `clear` does not ack.
 */

export type MailboxEntry = {
  prompt: string
  /** When the entry reached this mailbox — orders a mid-turn injection
   *  against the other queued commands of the same round. */
  enqueuedAt: number
  /** Called once when the entry is consumed. */
  ack?: () => void
}

type Inbox = {
  queue: MailboxEntry[]
  /** Parked resolver when the recipient is idle-waiting; null when busy. */
  waiter: ((prompt: string | null) => void) | null
}

function consume(entry: MailboxEntry): string {
  try {
    entry.ack?.()
  } catch {
    // An ack only advances a cursor; failing it must not lose the prompt.
  }
  return entry.prompt
}

export class TeamMailbox {
  private readonly inboxes = new Map<string, Inbox>()

  private inbox(sessionId: string): Inbox {
    let ib = this.inboxes.get(sessionId)
    if (!ib) {
      ib = { queue: [], waiter: null }
      this.inboxes.set(sessionId, ib)
    }
    return ib
  }

  /**
   * Deliver a prompt to a session. Idle recipient (parked waiter) → resolve
   * immediately (inject now, acked now). Busy recipient → queue.
   */
  enqueue(sessionId: string, prompt: string, ack?: () => void): void {
    const ib = this.inbox(sessionId)
    const entry: MailboxEntry = { prompt, enqueuedAt: Date.now(), ...(ack ? { ack } : {}) }
    if (ib.waiter) {
      const resolve = ib.waiter
      ib.waiter = null
      resolve(consume(entry))
    } else {
      ib.queue.push(entry)
    }
  }

  /**
   * The teammate idle-loop wait. Returns the next prompt, or `null` when
   * the signal aborts (shutdown). Drains a queued prompt synchronously if
   * present; otherwise parks a resolver (the "idle" state) raced against
   * the abort signal — no polling.
   */
  awaitInboxOrStop(
    sessionId: string,
    signal: AbortSignal,
  ): Promise<string | null> {
    const ib = this.inbox(sessionId)
    if (signal.aborted) return Promise.resolve(null)
    const queued = ib.queue.shift()
    if (queued) {
      return Promise.resolve(consume(queued))
    }
    return new Promise<string | null>((resolve) => {
      const onAbort = () => {
        if (ib.waiter) ib.waiter = null
        resolve(null)
      }
      ib.waiter = (prompt) => {
        signal.removeEventListener('abort', onAbort)
        resolve(prompt)
      }
      signal.addEventListener('abort', onAbort, { once: true })
    })
  }

  /** True if a prompt is queued for the session (used for lead drain). */
  hasPending(sessionId: string): boolean {
    return (this.inboxes.get(sessionId)?.queue.length ?? 0) > 0
  }

  /** Pop the next queued prompt without waiting (lead turn-boundary drain). */
  takePending(sessionId: string): string | null {
    const entry = this.inboxes.get(sessionId)?.queue.shift()
    return entry ? consume(entry) : null
  }

  /**
   * Take EVERY queued entry, oldest first — the mid-turn injection: a
   * running turn takes its whole backlog between two tool rounds rather than
   * one message per turn. Each is acked.
   */
  takeAll(sessionId: string): MailboxEntry[] {
    const ib = this.inboxes.get(sessionId)
    if (!ib || ib.queue.length === 0) return []
    const taken = ib.queue.splice(0, ib.queue.length)
    for (const entry of taken) consume(entry)
    return taken
  }

  /**
   * Drop a session's inbox (on teardown). A parked waiter is resolved null.
   * Returns the entries that were still queued — never delivered, never
   * acked — so the caller can report them.
   */
  clear(sessionId: string): MailboxEntry[] {
    const ib = this.inboxes.get(sessionId)
    if (ib?.waiter) {
      const resolve = ib.waiter
      ib.waiter = null
      resolve(null)
    }
    this.inboxes.delete(sessionId)
    return ib?.queue ?? []
  }
}
