import { type RefObject, type Dispatch, type SetStateAction } from 'react'
import type { GlobalDefaultMirror } from './globalDefaultSelection'
import type { SettingsBridge } from '../runtimeClient/settingsBridgeOverConnection'
import type { TranslateFn } from './i18n/translate'
import type { BrowserLlmSelection } from '../bridge/browserBridgeProtocol'
import type { SessionListChannel } from '../runtimeClient/sessionListChannel'
import type { RuntimeConnection } from '../runtimeClient/RuntimeConnection'
import { writeGlobalDefault } from './globalDefaultSelection'
import { randomUuid } from '@/utils/randomUuid'
import type { NexusTaskDetail } from '../bridge/protocol/ui'
import type { ForkRetarget } from '../worker/sharedWorkerProtocol'
import type { ModsPressTopbarResult } from '../runtimeProtocol/modContributions'
import type { TurnFileChange } from '../../utils/turnDiffs'

export function createShellHandleReconnectNow(
  runtimeConnection: (() => Promise<RuntimeConnection>) | undefined,
) {
  return () => {
    void runtimeConnection?.().then(
      connection => connection.reconnectNow(),
      () => {
        // No connection to hurry — the overlay only shows over a live one.
      },
    )
  }
}
export function createShellHandlePressPluginItem(
  runtimeConnection: (() => Promise<RuntimeConnection>) | undefined,
) {
  return async (sessionId: string, id: string): Promise<ModsPressTopbarResult> => {
    if (!runtimeConnection) return { ok: false, reason: 'no-session' }
    const connection = await runtimeConnection()
    return connection.request<ModsPressTopbarResult>('mods.pressTopbar', { sessionId, id })
  }
}
export function createShellPickGlobalDefaultSelection(
  globalDefaultMirror: GlobalDefaultMirror,
  settingsBridgeRef: RefObject<SettingsBridge | undefined>,
) {
  return (selection: BrowserLlmSelection) => {
    globalDefaultMirror.pick(selection, () =>
      writeGlobalDefault(settingsBridgeRef.current, selection),
    )
  }
}
export function createShellHandleRequestDelete(
  sessionChannelRef: RefObject<SessionListChannel | null>,
) {
  return (sessionId: string, requestId: string) => {
    sessionChannelRef.current?.request('session.delete', { sessionId, requestId })
  }
}
export function createShellHandleRequestRename(
  sessionChannelRef: RefObject<SessionListChannel | null>,
) {
  return (sessionId: string, title: string, requestId: string) => {
    sessionChannelRef.current?.request('session.rename', {
      sessionId,
      title,
      requestId,
    })
  }
}
export function createShellHandlePinThread(
  sessionChannelRef: RefObject<SessionListChannel | null>,
) {
  return (sessionId: string, pinned: boolean) => {
    sessionChannelRef.current?.request('session.pin', {
      sessionId,
      pinned,
      requestId: randomUuid(),
    })
  }
}
export function createShellHandleArchiveThread(
  sessionChannelRef: RefObject<SessionListChannel | null>,
) {
  return (sessionId: string, archived: boolean) => {
    sessionChannelRef.current?.request('session.archive', {
      sessionId,
      archived,
      requestId: randomUuid(),
    })
  }
}
export function createShellHandleRequestFork(
  ownForkRequestsRef: RefObject<Set<string>>,
  ownSideChatForksRef: RefObject<Map<string, string>>,
  sessionChannelRef: RefObject<SessionListChannel | null>,
  t: TranslateFn,
) {
  return (
    fromSessionId: string,
    cutUuid: string | undefined,
    requestId: string,
    sourceTitle?: string,
    keepCutMessage?: boolean,
    retarget?: ForkRetarget,
    sideChat?: { initialDraft?: string },
  ) => {
    ownForkRequestsRef.current.add(requestId)
    if (sideChat) ownSideChatForksRef.current.set(requestId, fromSessionId)
    sessionChannelRef.current?.request('session.fork', {
      fromSessionId,
      ...(cutUuid !== undefined ? { cutUuid } : {}),
      requestId,
      ...(retarget ? { retarget } : {}),
      ...(sideChat
        ? { sideChat: true, ...(sideChat.initialDraft ? { initialDraft: sideChat.initialDraft } : {}) }
        : {}),
      ...(keepCutMessage ? {} : { moveCutMessageToDraft: true }),
      ...(sourceTitle
        ? { title: t('session.forkTitle', { title: sourceTitle }) }
        : {}),
    })
  }
}
export function createShellHandleStopSubAgent(
  sessionChannelRef: RefObject<SessionListChannel | null>,
) {
  return (subAgentSessionId: string) => {
    sessionChannelRef.current?.request('task.stop', {
      sessionId: subAgentSessionId,
      requestId: randomUuid(),
    })
  }
}
export function createShellHandleResumeSubAgent(
  sessionChannelRef: RefObject<SessionListChannel | null>,
) {
  return (subAgentSessionId: string, prompt: string) => {
    sessionChannelRef.current?.request('task.resume', {
      sessionId: subAgentSessionId,
      prompt,
      requestId: randomUuid(),
    })
  }
}
export function createShellHandleLoadSubAgentTranscript(
  sessionChannelRef: RefObject<SessionListChannel | null>,
  subAgentTranscriptWaitersRef: RefObject<Map<string, (detail: NexusTaskDetail | null) => void>>,
) {
  return (
    subAgentSessionId: string,
  ): Promise<NexusTaskDetail | null> => {
    const channel = sessionChannelRef.current
    if (!channel) return Promise.resolve(null)
    const requestId = randomUuid()
    return new Promise((resolve) => {
      const waiters = subAgentTranscriptWaitersRef.current
      // Safety net: resolve null if the worker never replies.
      const timer = window.setTimeout(() => {
        if (waiters.delete(requestId)) resolve(null)
      }, 10_000)
      // Wrap the resolver so the normal worker reply also CLEARS the safety-net
      // timer (otherwise it leaks a 10s timer + closure per detail open).
      waiters.set(requestId, (detail) => {
        window.clearTimeout(timer)
        resolve(detail)
      })
      channel.request('task.transcript', {
        sessionId: subAgentSessionId,
        requestId,
      })
    })
  }
}
export function createShellLoadAgentTurnDiffDetail(
  sessionChannelRef: RefObject<SessionListChannel | null>,
  agentTurnDiffWaitersRef: RefObject<Map<string, (files: TurnFileChange[] | null) => void>>,
) {
  return (taskId: string, turnIndex: number): Promise<TurnFileChange[] | null> => {
    const channel = sessionChannelRef.current
    if (!channel) return Promise.resolve(null)
    const requestId = randomUuid()
    return new Promise((resolve) => {
      const waiters = agentTurnDiffWaitersRef.current
      const timer = window.setTimeout(() => {
        if (waiters.delete(requestId)) resolve(null)
      }, 10_000)
      waiters.set(requestId, (files) => {
        window.clearTimeout(timer)
        resolve(files)
      })
      channel.request('task.turnDiff', { sessionId: taskId, requestId, turnIndex })
    })
  }
}
export function createShellHandleRewindFromMessage(
  pendingRewindRef: RefObject<Map<string, string>>,
  sessionChannelRef: RefObject<SessionListChannel | null>,
) {
  return (fromSessionId: string, cutUuid: string) => {
    const requestId = randomUuid()
    pendingRewindRef.current.set(requestId, fromSessionId)
    sessionChannelRef.current?.request('session.fork', {
      fromSessionId,
      cutUuid,
      requestId,
      replacesSource: true,
    })
  }
}
export function createShellHandlePendingQuestionsChange(
  setSessionsWithPendingQuestions: Dispatch<SetStateAction<ReadonlySet<string>>>,
) {
  return (sessionId: string, hasPending: boolean) => {
    setSessionsWithPendingQuestions(prev => {
      if (prev.has(sessionId) === hasPending) return prev
      const next = new Set(prev)
      if (hasPending) next.add(sessionId)
      else next.delete(sessionId)
      return next
    })
  }
}
