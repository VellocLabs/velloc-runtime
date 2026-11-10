import { useMemo, useRef } from 'react'
import type { ThreadMessageLike } from '@assistant-ui/react'
import type { BrowserRuntimeClientState } from './BrowserRuntimeClient'
import {
  combineThreadMessages,
  combineThreadMessagesDeps,
  convertTranscriptToThreadMessages,
} from './assistantUiAdapter'
import { shareRowsById } from './structuralSharing'
import type { TranslateFn } from './i18n'

/** The thread's rows: the converted transcript combined with the live turn. */
export function useThreadTranscriptMessages({
  state,
  t,
}: {
  state: BrowserRuntimeClientState
  t: TranslateFn
}) {
  // Tool calls the running turn is parked on awaiting the user (an
  // AskUserQuestion halt). The transcript conversion must not stamp these as
  // interrupted-on-restart — see convertTranscriptToThreadMessages. Keyed on a
  // joined string so the Set's identity (a dep of the HEAVY transcript memo
  // below) is stable across the snapshot pushes that don't change the halt set.
  const haltedToolCallIdsKey = Object.keys(
    state.snapshot?.pendingUserInteraction ?? {},
  )
    .sort()
    .join(',')
  const liveHaltedToolCallIds = useMemo(
    () => new Set(haltedToolCallIdsKey ? haltedToolCallIdsKey.split(',') : []),
    [haltedToolCallIdsKey],
  )

  // The heavy O(N) half — three full passes over the persisted transcript.
  // Memoized on `state.transcriptMessages` ALONE so it is NOT redone on every
  // streaming token (those only grow `state.liveEvents`; the transcript array
  // keeps a stable reference until the worker persists new messages). This is
  // the fix for the per-token full-transcript re-conversion that made the UI
  // run progressively slower as a turn streamed over a long history.
  const previousTranscriptRowsRef = useRef<readonly ThreadMessageLike[] | null>(
    null,
  )
  const transcriptThreadMessages = useMemo(
    () => {
      // Boot instrumentation — Direction B3 (attribute ms_merged_to_unmount).
      // Capture ENTRY of the FIRST conversion that runs on the FULLY MERGED
      // transcript. The heavy passes live here, so the start mark belongs here;
      // the matching end mark is captured in the combine memo below (same
      // render on the first full convert). Earlier partial-state conversions
      // (e.g. session-switch transients with truncated message lists) are
      // skipped so the marks describe the boot transition. Gates mirror the
      // transcriptMergedMs predicate in MultiSessionShell.
      const bootMarks = (globalThis as {
        __nexusBootMarks?: Record<string, number>
      }).__nexusBootMarks ?? {}
      const isFirstFullConvert =
        bootMarks.transcriptConvertStartMs == null &&
        state.snapshot != null &&
        state.snapshot.messageCount > 0 &&
        state.transcriptMessages.length >= state.snapshot.messageCount
      if (isFirstFullConvert) {
        bootMarks.transcriptConvertStartMs = Date.now()
        ;(globalThis as {
          __nexusBootMarks?: Record<string, number>
        }).__nexusBootMarks = bootMarks
      }
      const converted = convertTranscriptToThreadMessages(
        state.transcriptMessages,
        liveHaltedToolCallIds,
        t,
      )
      // Every row comes back as a new object; hand back the previous ones
      // wherever nothing changed (see `structuralSharing.ts`), so a turn
      // boundary doesn't rebuild assistant-ui's clients for the whole history.
      const shared = shareRowsById(
        previousTranscriptRowsRef.current,
        converted.messages,
      ) as ThreadMessageLike[]
      previousTranscriptRowsRef.current = shared
      return shared === converted.messages
        ? converted
        : { ...converted, messages: shared }
    },
    // Keyed on the transcript and the halted-call SET; `state.snapshot` must not be a dep
    // (snapshot pushes would redo the conversion). `t` translates slash output here.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [state.transcriptMessages, liveHaltedToolCallIds, t],
  )
  // The cheap half — pending prompt + live (streaming) messages + merge.
  // Re-runs per token, but only over the small live delta, reusing the
  // memoized transcript conversion above.
  const messages = useMemo(
    () => {
      const result = combineThreadMessages(transcriptThreadMessages, state, t)
      const bootMarks = (globalThis as {
        __nexusBootMarks?: Record<string, number>
      }).__nexusBootMarks ?? {}
      // EXIT of the first full convert (start was set in the transcript memo
      // on the same render). Set once, then latched.
      if (
        bootMarks.transcriptConvertStartMs != null &&
        bootMarks.transcriptConvertEndMs == null
      ) {
        bootMarks.transcriptConvertEndMs = Date.now()
        bootMarks.transcriptConvertResultLength = result.length
        ;(globalThis as {
          __nexusBootMarks?: Record<string, number>
        }).__nexusBootMarks = bootMarks
      }
      return result
    },
    // `combineThreadMessagesDeps` owns the state fields the combine reads; `t` is read by the
    // callback and is identity-stable per locale.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [transcriptThreadMessages, t, ...combineThreadMessagesDeps(state)],
  )

  return messages
}
