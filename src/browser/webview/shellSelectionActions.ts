import { type RefObject, type Dispatch, type SetStateAction } from 'react'
import type { BrowserLlmCatalog, BrowserLlmSelection } from '../bridge/browserBridgeProtocol'
import type { SessionListChannel } from '../runtimeClient/sessionListChannel'
import type { BrowserRuntimeClientState } from './BrowserRuntimeClient'
import {
  clearPendingMessageJump,
  setPendingMessageJump,
  type PendingMessageJump,
} from './pendingMessageJumpStore'
import { healReplacesGlobalDefault } from './modelCatalog'
import { ATTENTION_SECTION_ATTR, revealAttentionSource } from './attentionSource'
import { clearAttentionForSession, type AttentionEvent } from './sessionAttention'
import { randomUuid } from '@/utils/randomUuid'
import { isTurnAnchoredMessageId, sideChatCutForRow } from './assistantUiAdapter'
import { serializePassagePrompt } from './capturedPassages'
import type { ForkRetarget } from '../worker/sharedWorkerProtocol'

export function createShellHealActiveSessionSelection(
  configuredActiveCatalog: BrowserLlmCatalog | null | undefined,
  globalDefaultSelectionRef: RefObject<BrowserLlmSelection | null>,
  handleTopbarSelectModel: (selection: BrowserLlmSelection) => void,
  setModelSelection: (selection: BrowserLlmSelection) => Promise<void>,
) {
  return (selection: BrowserLlmSelection) => {
    if (
      healReplacesGlobalDefault(
        configuredActiveCatalog,
        globalDefaultSelectionRef.current,
      )
    ) {
      handleTopbarSelectModel(selection)
      return
    }
    void setModelSelection(selection).catch(() => {})
  }
}
export function createShellHandleAdoptDefaultSelection(
  healActiveSessionSelection: (selection: BrowserLlmSelection) => void,
  setModelPickerOpenToken: Dispatch<SetStateAction<number>>,
) {
  return (selection: BrowserLlmSelection) => {
    healActiveSessionSelection(selection)
    setModelPickerOpenToken(token => token + 1)
  }
}
export function createShellHandleSelectSideChat(
  activeSessionIdRef: RefObject<string>,
  setSideChatSelection: Dispatch<SetStateAction<ReadonlyMap<string, string>>>,
) {
  return (sideChatId: string) => {
    const parent = activeSessionIdRef.current
    if (!parent) return
    setSideChatSelection(prev => new Map(prev).set(parent, sideChatId))
  }
}
export function createShellHandleAddSideChat(
  activeSessionIdRef: RefObject<string>,
  forkSession: (fromSessionId: string, cutUuid: string | undefined, options?: { keepCutMessage?: boolean; retarget?: ForkRetarget; sideChat?: boolean; initialDraft?: string; }) => string,
) {
  return () => {
    const parent = activeSessionIdRef.current
    if (!parent) return
    forkSession(parent, undefined, { keepCutMessage: true, sideChat: true })
  }
}
export function createShellHandleStartSideChat(
  sessionStatesRef: RefObject<ReadonlyMap<string, BrowserRuntimeClientState>>,
  forkSession: (fromSessionId: string, cutUuid: string | undefined, options?: { keepCutMessage?: boolean; retarget?: ForkRetarget; sideChat?: boolean; initialDraft?: string; }) => string,
) {
  return (fromSessionId: string, cutUuid: string, selection: string) => {
    // A cut at the closing reply while the turn runs would miss its text.
    const running = sessionStatesRef.current.get(fromSessionId)?.status === 'submitting'
    const cut = sideChatCutForRow(cutUuid, running && isTurnAnchoredMessageId(cutUuid))
    if (!cut) return
    forkSession(fromSessionId, cut.cutUuid, {
      keepCutMessage: true,
      sideChat: true,
      initialDraft: serializePassagePrompt([selection.trim()], ''),
    })
  }
}
export function createShellHandleDetachSideChat(
  sessionChannelRef: RefObject<SessionListChannel | null>,
) {
  return (sideChatId: string) => {
    sessionChannelRef.current?.request('session.detachLineage', {
      sessionId: sideChatId,
      requestId: randomUuid(),
    })
  }
}
export function createShellHandleArchiveSideChat(
  handleArchiveThread: (sessionId: string, archived: boolean) => void,
) {
  return (sideChatId: string) => handleArchiveThread(sideChatId, true)
}
export function createShellPublishAttentionQueue(
  attentionQueueRef: RefObject<AttentionEvent[]>,
  setAttentionQueue: Dispatch<SetStateAction<AttentionEvent[]>>,
) {
  return (next: AttentionEvent[]) => {
    if (next === attentionQueueRef.current) return
    attentionQueueRef.current = next
    setAttentionQueue(next)
  }
}
export function createShellRevealAttentionInSession(

) {
  return (sessionId: string): boolean =>
      revealAttentionSource(
        document.querySelector(
          `[${ATTENTION_SECTION_ATTR}="${CSS.escape(sessionId)}"]`,
        ),
      )
}
export function createShellHandleAttentionSelect(
  activeSessionId: string,
  revealAttentionInSession: (sessionId: string) => boolean,
  attentionQueueRef: RefObject<AttentionEvent[]>,
  acknowledgedAttentionRef: RefObject<Set<string>>,
  publishAttentionQueue: (next: AttentionEvent[]) => void,
  focusSession: (sessionId: string) => void,
) {
  return (sessionId: string) => {
    if (sessionId === activeSessionId) {
      // Already here - the switch would be a no-op, so the useful action is
      // the reveal the `focus` route would have done. The visit effect will
      // not fire (neither of its inputs changes), so acknowledge here or the
      // row returns on the next switch away.
      revealAttentionInSession(sessionId)
      for (const event of attentionQueueRef.current) {
        if (event.sessionId !== sessionId) continue
        acknowledgedAttentionRef.current.add(event.id)
      }
      publishAttentionQueue(
        clearAttentionForSession(attentionQueueRef.current, sessionId),
      )
      return
    }
    focusSession(sessionId)
  }
}
export function createShellHandleSearchOpenSession(
  activeSessionId: string,
  focusSession: (sessionId: string) => void,
) {
  return (sessionId: string, target?: PendingMessageJump) => {
    if (target) {
      setPendingMessageJump(sessionId, target)
    } else {
      clearPendingMessageJump(sessionId)
    }
    // Only switch when it is a DIFFERENT conversation. Re-switching to
    // the one already on screen tears its view down and rebuilds it,
    // which reads as a reload and loses the scroll position we are
    // about to jump within.
    if (sessionId !== activeSessionId) {
      focusSession(sessionId)
    }
  }
}
export function createShellHandleSearchJump(
  handleSearchOpenSession: (sessionId: string, target?: PendingMessageJump) => void,
) {
  return (
      sessionId: string,
      uuid: string,
      lineOrdinal: number,
      needle?: string,
      term?: string,
    ) => handleSearchOpenSession(sessionId, { uuid, lineOrdinal, needle, term })
}
