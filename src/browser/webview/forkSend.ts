import type { Message } from '../../runtime/RuntimeTypes'
import {
  AI_TITLE_TYPE,
  CUSTOM_TITLE_TYPE,
  SESSION_META_TYPE,
} from '../../runtime/VercelModelConstants'

/**
 * "Send in a forked session" (the composer's Ctrl/Cmd+Alt+Enter): copy the
 * conversation into a new session, switch to it, and send the composer's
 * message THERE. The copy reuses `session.fork` with an INCLUSIVE cut at the
 * last persisted message — the whole conversation, unlike "Fork from here",
 * which stops before its message and re-opens it in the composer.
 */

/**
 * The fork's cut: the last message of the persisted transcript, as of the last settle (the manager's
 * fork builder carries a parked AskUserQuestion's answer across it). `null` for an empty session: the
 * caller sends normally.
 */
export function resolveForkSendCutUuid(
  transcriptMessages: readonly Message[],
): string | null {
  for (let i = transcriptMessages.length - 1; i >= 0; i--) {
    const message = transcriptMessages[i]
    if (!message || typeof message.uuid !== 'string' || !message.uuid) continue
    if (
      message.type === SESSION_META_TYPE ||
      message.type === CUSTOM_TITLE_TYPE ||
      message.type === AI_TITLE_TYPE
    ) {
      continue
    }
    return message.uuid
  }
  return null
}

/**
 * What a fork-send does: `fork` at the cut and send into the copy; `send` normally when there is
 * nothing to fork and the session is idle; `refuse` when there is nothing to fork yet but the session is
 * busy (the caller hands the text back).
 */
export type ForkSendPlan =
  | { kind: 'fork'; cutUuid: string }
  | { kind: 'send' }
  | { kind: 'refuse' }

export function resolveForkSendPlan(
  transcriptMessages: readonly Message[],
  busy: boolean,
): ForkSendPlan {
  const cutUuid = resolveForkSendCutUuid(transcriptMessages)
  if (cutUuid) return { kind: 'fork', cutUuid }
  return busy ? { kind: 'refuse' } : { kind: 'send' }
}

/**
 * Send a claimed fork-send's message into the new session, and only THEN
 * settle the sender: `true` once the submit went out, `false` when it failed
 * (an attachment upload, the client's start), so the sender hands the text
 * back to its composer instead of losing it.
 */
export async function deliverForkSend<T>(
  claimed: { payload: T; settle: (ok: boolean) => void },
  send: (payload: T) => Promise<void>,
): Promise<void> {
  try {
    await send(claimed.payload)
  } catch (error) {
    console.warn('Failed to send into the forked session:', error)
    claimed.settle(false)
    return
  }
  claimed.settle(true)
}

/** How long a fork-send waits for the manager's `session.forked` ack. */
export const FORK_SEND_ACK_TIMEOUT_MS = 15_000

/**
 * Fork-sends waiting on their `session.forked` ack, keyed by requestId. The
 * manager's fork is best-effort — a failure never acks — and the composer has
 * already been cleared by then, so `register` resolves `false` on timeout and
 * the caller hands the text back instead of losing it. `take` claims an ack:
 * a late ack after the timeout finds nothing and the fork is just a fork.
 */
export function createForkSendRegistry<T>(
  timeoutMs: number = FORK_SEND_ACK_TIMEOUT_MS,
) {
  const pending = new Map<
    string,
    { payload: T; resolve: (ok: boolean) => void; timer: ReturnType<typeof setTimeout> }
  >()
  return {
    register(requestId: string, payload: T): Promise<boolean> {
      return new Promise<boolean>(resolve => {
        const timer = setTimeout(() => {
          if (pending.delete(requestId)) resolve(false)
        }, timeoutMs)
        pending.set(requestId, { payload, resolve, timer })
      })
    },
    take(
      requestId: string | undefined,
    ): { payload: T; settle: (ok: boolean) => void } | undefined {
      if (!requestId) return undefined
      const entry = pending.get(requestId)
      if (!entry) return undefined
      pending.delete(requestId)
      clearTimeout(entry.timer)
      return { payload: entry.payload, settle: entry.resolve }
    },
  }
}
