// The shell's side of the session channel: the session-list feed and task replies, which session this client views, and the activity report.
import { useEffect } from 'react'
import type { Dispatch, MutableRefObject, SetStateAction } from 'react'
import type { AppendMessage } from '@assistant-ui/react'
import type { SessionListChannel } from '../runtimeClient/sessionListChannel'
import type { useSessionManager } from './useSessionManager'
import type { MultiSessionShellProps } from './MultiSessionShell'
import {
  sessionActivityFromSummary,
  type SessionActivityById,
} from './sessionStatusEntries'
import { subAgentsEqual } from './backgroundSubAgents'
import { sessionSkillsEqual } from './sessionSkills'
import { deliverForkSend, type createForkSendRegistry } from './forkSend'
import { useClientActivityReport } from './clientActivityReport'
import type {
  NexusSessionActivity,
  NexusSessionSkillRow,
  NexusTaskDetail,
  NexusTaskInfo,
  NexusTaskSummaryRow,
  NexusTaskTranscriptEntry,
  NexusTurnEnding,
} from '../bridge/protocol/ui'
import type { TurnFileChange } from '../../utils/turnDiffs'

const NEXUS_ACTIVE_SESSION_CHANGED_EVENT = 'nexus:activeSessionChanged'

type SessionManager = ReturnType<typeof useSessionManager>

// Contract: the channel subscription re-subscribes only when `sessionChannel` or
// an `applyRemote*` function changes; every other callback is read from the
// render that subscribed, so pass identity-stable functions or refs.
export type SessionChannelFeedInput = {
  sessionChannel: SessionListChannel | undefined
  applyRemoteList: SessionManager['applyRemoteList']
  applyRemoteUpdate: SessionManager['applyRemoteUpdate']
  applyRemoteRemoval: SessionManager['applyRemoteRemoval']
  bootSessionsStageFiredRef: MutableRefObject<boolean>
  onBootStageRef: MutableRefObject<MultiSessionShellProps['onBootStage']>
  sessionRemovalWaitersRef: MutableRefObject<Map<string, (removed: boolean) => void>>
  pendingRewindRef: MutableRefObject<Map<string, string>>
  ownForkRequestsRef: MutableRefObject<Set<string>>
  handleDeleteThread: (sessionId: string) => void
  ownSideChatForksRef: MutableRefObject<Map<string, string>>
  setSideChatSelection: Dispatch<SetStateAction<ReadonlyMap<string, string>>>
  openSideChatPaneForRef: MutableRefObject<(parentId: string) => void>
  focusSession: SessionManager['focusSession']
  forkSendRegistry: ReturnType<typeof createForkSendRegistry<AppendMessage>>
  submitComposerMessageToSessionRef: MutableRefObject<
    (sessionId: string, message: AppendMessage) => Promise<void>
  >
  runningSeenSinceDetectRef: MutableRefObject<Set<string>>
  setSessionActivity: Dispatch<SetStateAction<SessionActivityById>>
  setRunningSessionIds: Dispatch<SetStateAction<ReadonlySet<string>>>
  setSummaryNeedsAnswerIds: Dispatch<SetStateAction<ReadonlySet<string>>>
  setSubAgentRows: Dispatch<SetStateAction<readonly NexusTaskSummaryRow[]>>
  setSessionSkillRows: Dispatch<SetStateAction<readonly NexusSessionSkillRow[]>>
  agentTurnDiffWaitersRef: MutableRefObject<
    Map<string, (files: TurnFileChange[] | null) => void>
  >
  subAgentTranscriptWaitersRef: MutableRefObject<
    Map<string, (detail: NexusTaskDetail | null) => void>
  >
  activeSessionId: string
}

export function useSessionChannelFeed({
  sessionChannel,
  applyRemoteList,
  applyRemoteUpdate,
  applyRemoteRemoval,
  bootSessionsStageFiredRef,
  onBootStageRef,
  sessionRemovalWaitersRef,
  pendingRewindRef,
  ownForkRequestsRef,
  handleDeleteThread,
  ownSideChatForksRef,
  setSideChatSelection,
  openSideChatPaneForRef,
  focusSession,
  forkSendRegistry,
  submitComposerMessageToSessionRef,
  runningSeenSinceDetectRef,
  setSessionActivity,
  setRunningSessionIds,
  setSummaryNeedsAnswerIds,
  setSubAgentRows,
  setSessionSkillRows,
  agentTurnDiffWaitersRef,
  subAgentTranscriptWaitersRef,
  activeSessionId,
}: SessionChannelFeedInput): void {
  useEffect(() => {
    if (!sessionChannel) return

    function handleWorkerMessage(data: Record<string, unknown>) {
      if (typeof data.type !== 'string') return

      if (
        data.type === 'session.list' &&
        Array.isArray((data.payload as Record<string, unknown>)?.sessions)
      ) {
        const payload = data.payload as {
          sessions: Array<{
            sessionId: string
            title?: string
            previewText?: string
            updatedAt?: number
            messageCount?: number
            templateType?: string
            composerDraft?: string
            lastComposerEditAt?: number
          }>
        }
        applyRemoteList(payload.sessions)
        // Real milestone → boot-welcome footer: the first session list has
        // arrived (sidebar populated) while the active session's runtime is
        // still spinning up. Once-guarded so later session.updated-driven list
        // refreshes don't re-fire it.
        if (!bootSessionsStageFiredRef.current) {
          bootSessionsStageFiredRef.current = true
          onBootStageRef.current?.('sessions')
        }
        return
      }

      if (data.type === 'session.updated') {
        const payload = data.payload as {
          session?: {
            sessionId: string
            title?: string
            previewText?: string
            updatedAt?: number
            messageCount?: number
            templateType?: string
            composerDraft?: string
            lastComposerEditAt?: number
          }
        }
        if (payload?.session?.sessionId) {
          applyRemoteUpdate(payload.session)
        }
        return
      }

      if (data.type === 'session.removed') {
        const payload = data.payload as { sessionId?: string }
        if (payload?.sessionId) {
          applyRemoteRemoval(payload.sessionId)
          sessionRemovalWaitersRef.current.get(payload.sessionId)?.(true)
        }
        return
      }

      if (data.type === 'session.forked') {
        // The manager copied the transcript into the new session (and broadcast
        // its summary via session.updated); switch the active view to it.
        const payload = data.payload as {
          newSessionId?: string
          requestId?: string
        }
        if (payload?.newSessionId) {
          // If this fork was a REWIND, drop the original (now superseded by the
          // truncated copy). Delete first (it auto-switches away), then force
          // the active session to the rewound copy so it wins the batch.
          const rid = payload.requestId
          const rewoundFrom = rid
            ? pendingRewindRef.current.get(rid)
            : undefined
          if (rid) pendingRewindRef.current.delete(rid)
          const ownFork = rid !== undefined && ownForkRequestsRef.current.delete(rid)
          // Another client's fork: its copy reaches the list via session.updated.
          if (!ownFork && !rewoundFrom) return
          if (rewoundFrom && rewoundFrom !== payload.newSessionId) {
            handleDeleteThread(rewoundFrom)
          }
          // A side chat opens in its parent's pane; the view stays on the parent.
          const sideChatParent = rid ? ownSideChatForksRef.current.get(rid) : undefined
          if (sideChatParent) {
            if (rid) ownSideChatForksRef.current.delete(rid)
            const newSideChatId = payload.newSessionId
            setSideChatSelection(prev => new Map(prev).set(sideChatParent, newSideChatId))
            openSideChatPaneForRef.current(sideChatParent)
            return
          }
          focusSession(payload.newSessionId)
          // A fork-send: the copy exists and is now active — send the
          // composer's message into it. Its client is created here if the
          // switch has not mounted it yet (the same client the mount reuses).
          // Settled only once the submit went out: a failed one resolves the
          // sender false, which hands the text back to its composer.
          const forkSend = forkSendRegistry.take(rid)
          if (forkSend) {
            const newSessionId = payload.newSessionId
            void deliverForkSend(forkSend, message =>
              submitComposerMessageToSessionRef.current(newSessionId, message),
            )
          }
        }
        return
      }

      if (data.type === 'session.summary') {
        // Compact, all-sessions snapshot from the unified state feed.
        // The manager re-broadcasts this to native (`nexusSessionsSummary`)
        // for the WebUI session-list; here we just need the per-session
        // `running` flag to decorate the in-flow rows.
        const payload = data.payload as {
          sessions?: Array<{
            sessionId: string
            running?: boolean
            needsAnswer?: boolean
            activity?: NexusSessionActivity
            ending?: NexusTurnEnding
            lastReply?: string
          }>
          subAgents?: NexusTaskSummaryRow[]
          skills?: NexusSessionSkillRow[]
        } | null
        if (Array.isArray(payload?.sessions)) {
          const next = new Set<string>()
          // Worker-derived halted-on-ask flags — the sidebar dot's source for
          // sessions whose client was disposed (mount-LRU eviction). Optional
          // field: an old SharedWorker bundle serving a newer UI simply never
          // sets it, and the client-derived union below still covers mounted
          // sessions.
          const nextNeedsAnswer = new Set<string>()
          for (const row of payload.sessions) {
            if (row.running) {
              next.add(row.sessionId)
              runningSeenSinceDetectRef.current.add(row.sessionId)
            }
            if (row.needsAnswer) nextNeedsAnswer.add(row.sessionId)
          }
          setSessionActivity(prev => sessionActivityFromSummary(prev, payload.sessions!))
          setRunningSessionIds(prev => {
            // Preserve referential identity when nothing changed — most
            // updates are counter bumps that don't flip the running set.
            if (prev.size !== next.size) return next
            for (const id of next) {
              if (!prev.has(id)) return next
            }
            return prev
          })
          setSummaryNeedsAnswerIds(prev => {
            if (prev.size !== nextNeedsAnswer.size) return nextNeedsAnswer
            for (const id of nextNeedsAnswer) {
              if (!prev.has(id)) return nextNeedsAnswer
            }
            return prev
          })
        }
        // Background sub-agents (G2/G5). Dedupe so an unrelated summary flush
        // (counter bump) doesn't churn the shell when the sub-agent set is
        // unchanged.
        {
          const nextSub = Array.isArray(payload?.subAgents)
            ? payload!.subAgents!
            : []
          setSubAgentRows(prev => (subAgentsEqual(prev, nextSub) ? prev : nextSub))
        }
        // Skills invoked per session (the Skill panel's "loaded in this
        // session" list). Same dedupe pattern as the sub-agent rows.
        {
          const nextSkills = Array.isArray(payload?.skills)
            ? payload!.skills!
            : []
          setSessionSkillRows(prev =>
            sessionSkillsEqual(prev, nextSkills) ? prev : nextSkills,
          )
        }
        return
      }

      if (data.type === 'task.stopped') {
        // Test seam: the drawer's Stop is fire-and-forget (the row flips on
        // the next session.summary), but the worker's stop OUTCOME
        // ('stopped' | 'already_finished' | 'stop_pending' | 'stop_failed' |
        // 'not_found' | sub-agent statuses) is invaluable when a Stop
        // appears to do nothing. Recorded on a global for debugging.
        ;(globalThis as unknown as {
          __NEXUS_LAST_TASK_STOP__?: unknown
        }).__NEXUS_LAST_TASK_STOP__ = data.payload
      }
      if (data.type === 'task.turnDiff') {
        const payload = data.payload as { requestId?: string; files?: TurnFileChange[] | null } | null
        const requestId = payload?.requestId
        const resolve = requestId ? agentTurnDiffWaitersRef.current.get(requestId) : undefined
        if (requestId && resolve) {
          agentTurnDiffWaitersRef.current.delete(requestId)
          resolve(payload?.files ?? null)
        }
        return
      }
      if (data.type === 'task.transcript') {
        // Reply to a drawer detail-view request — resolve the pending promise
        // with the transcript + header info bundle.
        const payload = data.payload as {
          requestId?: string
          entries?: NexusTaskTranscriptEntry[] | null
          info?: NexusTaskInfo | null
        } | null
        const requestId = payload?.requestId
        if (requestId) {
          const waiters = subAgentTranscriptWaitersRef.current
          const resolve = waiters.get(requestId)
          if (resolve) {
            waiters.delete(requestId)
            resolve({
              entries: payload?.entries ?? null,
              info: payload?.info ?? null,
            })
          }
        }
        return
      }
    }

    // Every session's metadata — the sidebar shows every session — and the
    // background-task replies. The `sessions` topic opens with the current list
    // (`session.list`), then carries `session.updated` / `session.removed` diffs.
    return sessionChannel.onMessage(handleWorkerMessage)
  }, [
    sessionChannel,
    applyRemoteList,
    applyRemoteUpdate,
    applyRemoteRemoval,
  ])

  // Whenever the user switches sessions (clicking the sidebar, "New Thread",
  // session.list selection), tell the runtime which session THIS client is
  // viewing (`presence.setViewing`). The runtime has no "current session": it
  // answers with that session's full status snapshot (topbar pill, composer
  // gate, running indicator all read it) and gives turn-end notifications to
  // sessions some client is viewing. The entry dies with the connection.
  useEffect(() => {
    if (!activeSessionId) return
    ;(globalThis as { __nexusActiveSessionId?: string }).__nexusActiveSessionId =
      activeSessionId
    try {
      globalThis.dispatchEvent?.(
        new CustomEvent(NEXUS_ACTIVE_SESSION_CHANGED_EVENT, {
          detail: { sessionId: activeSessionId },
        }),
      )
    } catch {
      // CustomEvent may be unavailable in non-browser tests.
    }
    sessionChannel?.request('presence.setViewing', { sessionId: activeSessionId })
  }, [sessionChannel, activeSessionId])

  // Input and visibility postpone the runtime's render-cache purge.
  useClientActivityReport(sessionChannel)
}
