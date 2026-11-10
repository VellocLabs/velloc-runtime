import { useEffect, useState, type RefObject } from 'react'
import type { ThreadMessageLike } from '@assistant-ui/react'
import type { BrowserRuntimeClientState } from './BrowserRuntimeClient'
import {
  consumePendingMessageJump,
  findLastEntryAtOrBeforeLine,
  setPendingMessageJump,
  peekPendingMessageJump,
  subscribePendingMessageJump,
} from './pendingMessageJumpStore'
import {
  currentRevealGeneration,
  revealRowForPart,
  revealThreadMessage,
} from './revealThreadMessage'
import { requestPartReveal } from './partRevealStore'

/**
 * How many times one search jump may re-arm itself after a failed reveal; unbounded, a
 * reveal that cannot succeed would loop for as long as the session stays open.
 */
const MAX_JUMP_ATTEMPTS = 2

/** Consumes a pending transcript-search jump once this thread's rows hold its target. */
export function usePendingMessageJumpReveal({
  state,
  messages,
  sessionId,
  isForegroundSession,
  threadRootRef,
}: {
  state: BrowserRuntimeClientState
  messages: ThreadMessageLike[]
  sessionId: string
  isForegroundSession: boolean
  threadRootRef: RefObject<HTMLDivElement | null>
}) {
  // --- Transcript-search jump consumption ---------------------------------
  // A search-result selection stashes {uuid, lineOrdinal} in the pending
  // jump store and switches the session; this effect fires once the
  // thread's messages contain the target and reveals + flashes the row.
  // A uuid without its own rendered row (e.g. a tool_result merged into a
  // tool card) falls back to the nearest EARLIER transcript entry that
  // does render. Consume-once: the jump is deleted only when acted on.
  const [pendingJumpVersion, setPendingJumpVersion] = useState(0)
  useEffect(
    () =>
      subscribePendingMessageJump(() =>
        setPendingJumpVersion(version => version + 1),
      ),
    [],
  )
  useEffect(() => {
    if (!isForegroundSession) return
    const jump = peekPendingMessageJump(sessionId)
    if (!jump) return
    const ids = messages.map(message =>
      typeof message.id === 'string' ? message.id : null,
    )
    let index = jump.uuid ? ids.indexOf(jump.uuid) : -1
    // Locate the row by the hit's LINE, not by its uuid. Rendered rows are
    // sparse — one row can stand for a hundred transcript lines, and the
    // lines between two rows may render nowhere — so the row is the one
    // whose recorded range contains the line. This is also the only step
    // that can run before anything is on screen, which is what lets the
    // reveal pin the right row instead of scrolling around looking for it.
    if (index < 0) {
      index = messages.findIndex(message => {
        const custom = (message.metadata as
          | { custom?: Record<string, unknown> }
          | undefined)?.custom
        const from = custom?.lineFrom
        const to = custom?.lineTo
        return (
          typeof from === 'number' &&
          typeof to === 'number' &&
          jump.lineOrdinal >= from &&
          jump.lineOrdinal <= to
        )
      })
    }
    if (index < 0 && state.transcriptMessages.length > 0) {
      const entries = state.transcriptMessages as {
        uuid?: string
        transcriptLine?: number
      }[]
      const at = jump.uuid
        ? entries.findIndex(entry => entry.uuid === jump.uuid)
        : -1
      // `jump.lineOrdinal` is a physical FILE line number (meta and
      // attachment lines included) — it is NOT an index into `entries`,
      // which holds message entries only. Map it through each entry's
      // `transcriptLine` — the physical line the loader read it from, so
      // the same unit as the hit — and take the last entry at or before
      // it. Then walk back from there to the nearest entry that has a
      // rendered row.
      const start =
        at >= 0 ? at : findLastEntryAtOrBeforeLine(entries, jump.lineOrdinal)
      for (let i = start; i >= 0 && index < 0; i--) {
        const candidate = entries[i]?.uuid
        if (candidate) index = ids.indexOf(candidate)
      }
    }
    // A uuid that names no rendered row is normal: several entries merge
    // into one message, and virtualization culls distant rows entirely.
    // Aim at the proportional position rather than giving up — the reveal
    // scrolls there, which mounts rows, and then locates the row by its
    // text. Giving up here is why a hit in a long conversation could
    // silently do nothing.
    if (
      index < 0 &&
      messages.length > 0 &&
      state.transcriptMessages.length > 0
    ) {
      const share =
        Math.min(jump.lineOrdinal, state.transcriptMessages.length - 1) /
        state.transcriptMessages.length
      index = Math.min(
        messages.length - 1,
        Math.max(0, Math.round(share * messages.length)),
      )
    }
    // A hit we cannot place yet is NOT a reason to guess. Switching to a
    // conversation starts this effect before its transcript has finished
    // arriving, and aiming at the middle of a half-built thread sends the
    // reveal scrolling for seconds, failing, re-arming, and doing it
    // again — which is what "clicking a hit does nothing" looked like.
    // The effect re-runs as messages arrive, so waiting costs nothing.
    if (index < 0 && jump.uuid) return
    // No uuid to wait for (an older jump payload): the reveal can still
    // find the row by text, and any in-range hint lets it start.
    if (index < 0 && messages.length > 0 && (jump.needle || jump.term)) {
      index = Math.floor(messages.length / 2)
    }
    // Nothing to aim at and no text to search for — keep it pending; the
    // effect re-runs as messages arrive.
    if (index < 0) return
    // Check the root BEFORE consuming: bailing after the consume threw
    // the jump away for good, so a thread whose ref had not attached yet
    // silently swallowed the hit.
    const root = threadRootRef.current
    if (!root) return
    consumePendingMessageJump(sessionId)
    // Can the message serve this itself? It can when one of its parts
    // carries the line — then it opens the container holding that part
    // and the part scrolls itself into view.
    const target = messages[index]
    const targetId = typeof target?.id === 'string' ? target.id : null
    const targetRole = (target as { role?: unknown } | undefined)?.role
    const targetParts = Array.isArray(target?.content) ? target.content : []
    const term =
      typeof jump.term === 'string' ? jump.term.trim().toLowerCase() : ''
    // Serve from the part only for a hit in VISIBLE assistant text on this line; everything
    // else takes the line-addressed DOM descent, which opens the enclosing collapsed card.
    const servedByPart =
      targetId !== null &&
      targetRole !== 'user' &&
      term.length > 0 &&
      targetParts.some(part => {
        const p = part as {
          type?: unknown
          text?: unknown
          sourceLine?: unknown
        }
        return (
          p.sourceLine === jump.lineOrdinal &&
          p.type === 'text' &&
          typeof p.text === 'string' &&
          p.text.toLowerCase().includes(term)
        )
      })
    if (servedByPart && targetId) {
      requestPartReveal(targetId, jump.lineOrdinal, jump.term)
    }
    // Only ONE of the two runs. The DOM walk alongside a self-revealing
    // part is not just redundant: it expands and re-queries while React
    // re-renders the subtree that just opened, and neither finishes.
    const reveal = servedByPart
      ? revealRowForPart(root, index)
      : revealThreadMessage(root, index, jump.lineOrdinal, jump.term)
    // Taken right after the call: the reveal claims its generation before its first await.
    const generation = currentRevealGeneration()
    void reveal.then(revealed => {
      // A newer reveal (another hit, or a chapter jump) took over: this
      // one did not fail, and re-arming it would pull the view back.
      if (currentRevealGeneration() !== generation) return
      // Re-arm rather than lose it: the rows for this hit may still be
      // mounting, and the next render will try again. BOUNDED, because
      // re-arming unconditionally is an infinite loop when the reveal
      // simply cannot succeed — it re-runs, fails, re-arms, forever,
      // scrolling the conversation the whole time.
      const attempts = (jump.attempts ?? 0) + 1
      if (!revealed && attempts < MAX_JUMP_ATTEMPTS) {
        setPendingMessageJump(sessionId, { ...jump, attempts })
      }
    })
  }, [
    messages,
    sessionId,
    isForegroundSession,
    pendingJumpVersion,
    state.transcriptMessages,
  ])
}
