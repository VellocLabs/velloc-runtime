import type { AgentRuntimeWorkerSnapshot } from '../worker/workerProtocol'
import type { Message, StreamRecord } from '../../runtime/RuntimeTypes'
import type { TurnDiffMeta } from '../../utils/turnDiffs'
import type { NexusAgentChangeSection } from '../bridge/protocol/ui'
import type { SessionChangeFigures } from '../../utils/sessionChangeDigest'

/** How a submit made while the session is busy is delivered: `inject` (plain
 *  Enter — into the running turn) or `next` (Ctrl/Cmd+Enter — the
 *  next-message strip). See `worker.submitMessage` `delivery`. */
export type SubmitDelivery = 'inject' | 'next'

export type BrowserRuntimeClientState = {
  status: 'idle' | 'initializing' | 'ready' | 'submitting' | 'error'
  snapshot: AgentRuntimeWorkerSnapshot | null
  transcriptMessages: Message[]
  liveEvents: StreamRecord[]
  lastError: { code: string; message: string } | null
  /**
   * A TRANSCRIPT-ONLY view (`startReadOnly`) whose load has settled, with the transcript or
   * `transcript_read_failed`. The loading gates read `snapshot != null`, and a read-only
   * client never gets a snapshot (a shutdown session must not claim a runtime), so this
   * flag marks it as loaded.
   */
  transcriptOnly?: boolean
  pendingPrompt: string | null
  pendingPromptId: string | null
  /**
   * Index into `liveEvents` where the CURRENT turn's events begin; earlier events render
   * BEFORE the optimistic pending-prompt bubble. Reset to 0 when `liveEvents` is cleared;
   * pre-split events are dropped on the next transcript reconcile. The live client always
   * sets it.
   */
  liveEventsTurnStart?: number
  /**
   * The PREVIOUS turn's optimistic user bubble, kept when a consumed next-message batch
   * re-arms `pendingPrompt`, so the consume is a pure APPEND ([U, A] → [U, A, U', A']).
   * Rendered before the pre-split live events, deduped by uuid, cleared by the next
   * transcript reconcile. Single slot. The live client always sets it.
   */
  preSplitPrompt?: string | null
  preSplitPromptId?: string | null
  /**
   * Turn-diff HISTORY metadata for the "Changes this turn" bar, newest first: stats and file
   * list, no hunks (`loadTurnDiffDetail`). `null` before the first `worker.turnDiffHistory`
   * push; `[]` = nothing to show. The live client always sets it.
   */
  turnDiffHistory?: TurnDiffMeta[] | null
  /**
   * The Outputs and Changes cards' figures from the session's stored digest,
   * sent on open in place of the history (`worker.sessionChangeFigures`).
   * Read only while `turnDiffHistory` is null. `null` = none sent.
   */
  sessionChangeFigures?: SessionChangeFigures | null
  /** File changes of the background sub-agents this session started, one
   *  section per sub-agent, newest first (F-2). */
  agentChanges?: NexusAgentChangeSection[]
  /**
   * The session's saved "next message" (a plain-text submit made while the
   * agent was busy, accumulated by the manager and broadcast in FULL). `null`
   * = none. Rendered verbatim by the NextMessage strip; consumed (auto-run) on
   * completion. Sourced from `worker.pendingMessageUpdated`/`…Cleared`.
   */
  pendingMessage?: string | null
  /**
   * The same saved "next message", but as ONE ENTRY PER PARKED SUBMIT.
   * `pendingMessage` is these joined with newlines and cannot be split back
   * apart — a single submit can be multi-line (Shift+Enter) — so the strip
   * counts and slices the queue from here. `null` = none, or an older worker
   * that doesn't send the list (the strip falls back to splitting the text).
   */
  pendingMessageEntries?: string[] | null
  /**
   * Set when the user clicked the Next-message strip's clear (×) and the
   * manager hasn't confirmed yet. While set, incoming `pendingMessageUpdated`
   * events are ignored so a stale in-flight append can't re-flash the strip the
   * user just dismissed. Cleared by `worker.pendingMessageCleared`. Per-session
   * (each sessionId has its own client), so sessions never interfere.
   */
  pendingClearInFlight?: boolean
  /**
   * Messages sent with plain Enter during a running turn, pinned at the bottom until they
   * land. `pending`: in the worker's inject queue. `landed`: `midturn` or `nextturn`
   * (persisted under `turnUuid`). Dropped once the transcript or live stream renders it.
   */
  injectBubbles?: InjectBubble[]
  /**
   * Inject texts Stop dropped, to hand back to THIS page's composer (set only
   * on the page that asked for the interrupt). Taken from the worker's
   * `injectMessagesCleared`, never from local bubbles: a message drained into
   * the model in the same instant must not also come back. `id` is unique per
   * restore so the composer applies it once. `files` are the attachments this
   * page sent with those messages (`InjectRestoreDraft`); absent when none.
   */
  injectRestore?: { id: string; text: string; files?: File[] } | null
}

/**
 * What THIS page sent with an inject message that carried attachments: the
 * composer text as typed and the attached files. The worker hands a removed /
 * Stop-dropped message back as its display text only — for an attachment-only
 * send, the file names — so without this the attachments were lost and their
 * names came back as typed text.
 */
export type InjectRestoreDraft = { text: string; files: File[] }

/** The result of `removeInjectMessage`: `text` (and `files`, when this page
 *  sent attachments with it) go back to the composer on `ok`. */
export type InjectRemoveResult = { ok: boolean; text?: string; files?: File[] }

export type InjectBubble = {
  uuid: string
  text: string
  hasAttachments: boolean
  state: 'pending' | 'landed'
  landedVia?: 'midturn' | 'nextturn'
  /** `nextturn` only: the user message the merged turn persists under. */
  turnUuid?: string
  /** Shown before the worker confirmed it parked the submit. */
  optimistic?: boolean
  /** Hidden while this page's remove (×) request is in flight. */
  removing?: boolean
}
