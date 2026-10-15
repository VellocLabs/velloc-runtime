/**
 * The only reader of the mailbox files; polls (no fs watch exists) every 1s
 * while a recipient is idle, 5s otherwise. One chain: a `kick()` during a poll
 * is dropped. `cursor.json` moves only through `ack` (frame consumed by a turn);
 * `handedOff` (memory) stops re-reading frames already handed over, so an
 * unconsumed frame is read again after a restart.
 */
import type { TeamMailboxStore } from './TeamMailboxStore'
import type { TeamMessageFrame } from './teamTypes'

/** Cadence when someone is waiting for mail. */
const IDLE_POLL_MS = 1_000
/** Cadence when nobody can act on a frame right now. */
const BUSY_POLL_MS = 5_000

export type MailboxRecipient = {
  /** The lead session directory whose `team/mailbox` tree holds the inbox. */
  leadSessionDir: string
  /** The lead session this inbox belongs to. Carried so a delivery can be
   *  resolved WITHIN one team: a member name is unique per team, not
   *  globally, and two live leads both have a `team-lead`. */
  headSessionId: string
  /** Member NAME (the inbox directory), not a sessionId. */
  memberKey: string
  /** Whether this recipient could start a turn right now. Drives cadence
   *  only — a busy recipient still receives its frames. */
  idle: boolean
}

export type MailboxPollerHost = {
  /** False before the bridge port is installed; a poll then does nothing. */
  hasTransport(): boolean
  /** Live recipients to serve this pass. */
  listRecipients(): MailboxRecipient[]
  /** Hand new frames to the in-memory side. A throw leaves them un-handed-off
   *  (they arrive on the next pass). The host acks each frame through
   *  `MailboxPoller.ack` when it is consumed; nothing here marks it read.
   *  The whole recipient is passed, not just its key, so the handler can
   *  resolve the addressee inside the right team. A returned promise is
   *  AWAITED before the next inbox is served, so a host that re-reads
   *  settings per delivery still places frames in inbox order. */
  onFrames(
    recipient: MailboxRecipient,
    frames: TeamMessageFrame[],
  ): void | Promise<void>
  /** A pass found nothing new for this inbox. Optional. */
  onInboxIdle?(recipient: MailboxRecipient): void
}

function inboxKey(leadSessionDir: string, memberKey: string): string {
  return `${leadSessionDir}\u0000${memberKey}`
}

export class MailboxPoller {
  private handle: ReturnType<typeof setTimeout> | null = null
  private pollInFlight = false
  /** Highest seq handed to the host, per inbox. */
  private readonly handedOff = new Map<string, number>()
  /** Highest seq acked, per inbox — the value the cursor is moving to. */
  private readonly acked = new Map<string, number>()
  /** Per-inbox cursor-write chain: two acks in quick succession must land in
   *  order, or the older write could finish last and move the cursor back. */
  private readonly cursorWrites = new Map<string, Promise<void>>()

  constructor(
    private readonly store: TeamMailboxStore,
    private readonly host: MailboxPollerHost,
  ) {}

  start(): void {
    this.schedule(0)
  }

  stop(): void {
    if (this.handle) clearTimeout(this.handle)
    this.handle = null
  }

  /** Poll now — used right after a local append so a same-process send does
   *  not wait out the interval. A no-op while a pass is running (that pass
   *  reschedules itself). */
  kick(): void {
    if (this.pollInFlight) return
    this.schedule(0)
  }

  /**
   * The recipient CONSUMED every frame up to `seq`: move the on-disk cursor.
   * Monotonic — a lower seq than one already acked is ignored — and written
   * through a per-inbox chain so the writes land in ack order.
   */
  ack(recipient: Pick<MailboxRecipient, 'leadSessionDir' | 'memberKey'>, seq: number): Promise<void> {
    const key = inboxKey(recipient.leadSessionDir, recipient.memberKey)
    if (seq <= (this.acked.get(key) ?? 0)) {
      return this.cursorWrites.get(key) ?? Promise.resolve()
    }
    this.acked.set(key, seq)
    const previous = this.cursorWrites.get(key) ?? Promise.resolve()
    const next = previous
      .catch(() => {})
      .then(async () => {
        // Re-read at write time: a later ack may already have raised it, and
        // writing the higher value once is the same as writing both.
        const target = this.acked.get(key) ?? seq
        await this.store.writeCursor(
          recipient.leadSessionDir,
          recipient.memberKey,
          { v: 1, deliveredSeq: target },
        )
      })
    this.cursorWrites.set(key, next)
    return next
  }

  private schedule(delayMs: number): void {
    if (this.handle) clearTimeout(this.handle)
    this.handle = setTimeout(() => {
      this.handle = null
      void this.poll()
    }, delayMs)
  }

  private nextDelay(): number {
    const recipients = this.host.listRecipients()
    if (recipients.length === 0) return BUSY_POLL_MS
    return recipients.some(r => r.idle) ? IDLE_POLL_MS : BUSY_POLL_MS
  }

  private async poll(): Promise<void> {
    if (this.pollInFlight) return
    this.pollInFlight = true
    try {
      if (!this.host.hasTransport()) return
      for (const recipient of this.host.listRecipients()) {
        const { leadSessionDir, memberKey } = recipient
        const key = inboxKey(leadSessionDir, memberKey)
        try {
          const cursor = await this.store.readCursor(leadSessionDir, memberKey)
          const after = Math.max(cursor.deliveredSeq, this.handedOff.get(key) ?? 0)
          const frames = await this.store.readAfter(
            leadSessionDir,
            memberKey,
            after,
          )
          if (frames.length === 0) {
            this.host.onInboxIdle?.(recipient)
            continue
          }
          await this.host.onFrames(recipient, frames)
          this.handedOff.set(key, frames[frames.length - 1]!.seq)
        } catch {
          // One unreadable mailbox must not stop the others, and must not
          // stop the chain: the next pass retries it.
        }
      }
    } finally {
      this.pollInFlight = false
      this.schedule(this.nextDelay())
    }
  }
}
