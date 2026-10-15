import type {
  AgentWorkerInboundMessage,
  AgentWorkerOutboundMessage,
} from './workerProtocol'
import type { BrowserToolCallDetailRecord } from '../../utils/toolCallDetails'
import type { TraceRecord } from '../../utils/sessionTrace'
import type { Message } from '../../runtime/RuntimeTypes'
import type { WorkerLogEntry } from '../../utils/workerLogBuffer'
import type {
  MainContentsLayoutPayload,
  NexusCurrentSessionPayload,
  NexusSessionsSummaryPayload,
  NexusTaskInfo,
  NexusTaskTranscriptEntry,
} from '../bridge/protocol/ui'

export type SessionWorkerInboundMessage = AgentWorkerInboundMessage & {
  sessionId: string
}

/**
 * Inbound subscription shape: `{ all: true }` (every session) or `{ sessionIds: [...] }`. Per-session
 * worker output goes to ports attached via `worker.init` regardless.
 */
export type SharedWorkerInboundMessage =
  | SessionWorkerInboundMessage
  /**
   * The host's bridge port for the runtime (`event.ports[0]`): every host call
   * a session makes rides it (`BridgeRequestRouter`). A later one replaces it.
   */
  | { type: 'bridge.setPort' }
  /**
   * Attach the isolated-worker kernel's control channel: the guest window
   * transfers one end of a MessageChannel (its `WindowWorkerHost` keeps the
   * other). The SharedWorker's `IsolatedWorkerKernel` uses it to ask the
   * window to spawn/terminate DedicatedWorkers — the SharedWorker cannot
   * `new Worker()` itself. `run_js` is the one profile on it today.
   * nexus_web-internal — never routed to C++.
   */
  | { type: 'workerHost.attachControlPort' }
    /**
     * Attach a UI ⇄ Runtime protocol client: `event.ports[0]` becomes one `ClientConnection` (the client
     * speaks `hello` first). `panelId` is optional.
     */
  | { type: 'bridge.attachRuntimePort'; homeDir: string; panelId?: string }
  /**
   * The page is going away (`pagehide` / `beforeunload`): release this
   * MessagePort's subscriptions, session attachments and diagnostics
   * entries. A SharedWorker gets no close event for a client port, so without
   * this every page (re)load leaked its port in the hub and every
   * `session.ports` set it had attached to.
   */
  | { type: 'port.disconnect' }
  | { type: 'session.list' }
  | {
      type: 'session.transcript'
      sessionId: string
      requestId: string
    }
  | { type: 'session.detach'; sessionId: string }
  | { type: 'session.delete'; sessionId: string; requestId?: string }
  | {
      // Human-initiated control over a background sub-agent (the Agent tool's
      // run_in_background path), from the Background Tasks drawer. `sessionId`
      // is the sub-agent's own `subagent-…` id. These reach `handlePortMessage`
      // (NOT `worker.*`, so `isSessionMessage` returns false) and call the
      // existing manager `stopSubAgent` — the same method the TaskStop model
      // tool uses. Optional `requestId` correlates the `task.stopped` ack.
      type: 'task.stop'
      sessionId: string
      requestId?: string
    }
  | {
      // Re-run a finished background sub-agent with a follow-up (calls the
      // existing manager `resumeSubAgent`, like the AgentResume tool).
      type: 'task.resume'
      sessionId: string
      /** Follow-up directive — `resumeSubAgent` requires a non-empty prompt. */
      prompt: string
      requestId?: string
    }
  | {
      // Request a sub-agent's projected transcript for the drawer's read-only
      // detail view. Replied with the `task.transcript` outbound below.
      type: 'task.transcript'
      sessionId: string
      requestId: string
    }
  | {
      // Lazily rebuild a session's restart-recovered Background Tasks drawer
      // rows (shells + run_js) from its persisted transcript. Sent when the
      // drawer OPENS — a closed drawer never triggers the scan (the recovery
      // scan + summary refresh are the "background data loading" we defer).
      // Idempotent: the manager recovers a session at most once per lifetime.
      // Fire-and-forget — the rebuilt rows arrive on the normal summary feed.
      type: 'task.recoverBackground'
      sessionId: string
    }
  | {
      // Rename a session: persist a manual `customTitle` (which overrides
      // the derived title) and broadcast `session.updated`. Works for
      // live AND disk-only sessions — see
      // `SharedWorkerSessionManager.handleSessionRename`. Empty/whitespace
      // `title` clears the override (reverts to the derived title).
      type: 'session.rename'
      sessionId: string
      title: string
      requestId?: string
    }
  | {
      // Pin or unpin a session: persist `pinned` in its metadata (live or
      // disk-only, like `session.rename`) and broadcast `session.updated`.
      type: 'session.pin'
      sessionId: string
      pinned: boolean
      requestId?: string
    }
  | {
      // Fork a session AT a message: copy the transcript prefix up to and
      // including `cutUuid` into a NEW session (rewriting sessionId +
      // parentUuid, copying tool-detail sidecars), then reply `session.forked`
      // and broadcast the new session's summary. The fork is cut at a
      // chosen uuid.
      type: 'session.fork'
      fromSessionId: string
      // Absent = cut at the last message, copying the whole conversation.
      cutUuid?: string
      requestId?: string
      // Exclusive cut: leave `cutUuid` OUT of the fork and carry its text into
      // the new session's composer draft instead. Set by "Fork from here";
      // rewind leaves it unset (inclusive cut). Optional — an older UI bundle
      // that never sets it still gets the original inclusive behaviour.
      moveCutMessageToDraft?: boolean
      // The NEW session's title, already localized by the page ("<source
      // title> (fork)" — the page owns the catalog and the displayed source
      // title). Set by "Fork from here"; rewind leaves it unset so the
      // replacement keeps the source's exact title. Persisted as the fork's
      // own `custom-title` action + `meta.json` title.
      title?: string
    }
  | {
      type: 'session.subscribe'
      all?: boolean
      sessionIds?: string[]
    }
  | {
      type: 'session.unsubscribe'
      all?: boolean
      sessionIds?: string[]
    }
  | {
      // Subscribe to one or more tool-call detail records. The manager
      // fires `toolDetail.ready` for each toolCallId when the sidecar
      // becomes available (cached, on-disk, or live-persisted). The
      // subscription is sticky — it stays active until unsubscribe so
      // the UI can re-render on future updates without re-polling.
      type: 'toolDetail.subscribe'
      toolCallIds: string[]
      // Optional session hint. If omitted, the manager will try each
      // known session's directory until one hits.
      sessionId?: string
    }
  | {
      type: 'toolDetail.unsubscribe'
      toolCallIds: string[]
    }
  | {
      // One-shot pull of the worker-realm tracer's ring buffer. Reply is
      // `trace.snapshot { records }`. Cheap — no allocation past the
      // serialized records.
      type: 'trace.flush'
      requestId?: string
    }
  | {
      // Subscribe to live span pushes from the worker-realm tracer.
      // Optional `traceId` filter narrows the stream to one click lineage.
      type: 'trace.subscribe'
      traceId?: string
    }
  | {
      type: 'trace.unsubscribe'
    }

export type SessionCard = {
  sessionId: string
  initialized: boolean
  title?: string
  /**
   * User-assigned title override (`customTitle`).
   * When present it IS the effective `title` above; surfaced separately
   * so the UI can distinguish a manual rename from a derived title and
   * avoid clobbering it with re-derived values.
   */
  customTitle?: string
  /**
   * Launcher template type (agent/chat/code); drives the row icon +
   * "New {type}" placeholder and is re-applied as the session's template.
   */
  templateType?: string
  /**
   * The lead session that spawned this one. Present ⇒ this is a teammate
   * (child) session: the sidebar hides it and the lead's tab strip lists it.
   */
  spawnerSessionId?: string
  /** This teammate's member name within its lead's team. */
  teammateName?: string
  /** True when a teammate was torn down and retained as a read-only transcript. */
  shutdown?: boolean
  shutdownAt?: number
  previewText?: string
  updatedAt?: number
  /**
   * Number of transcript messages this session has accumulated.
   * Authoritative "is this session empty" signal for the React-side
   * `openNewSession` reuse logic — see `useSessionManager.ts`. Composer
   * drafts do NOT count: a session with only a draft still has
   * `messageCount === 0` and is eligible for New Thread reuse.
   */
  messageCount?: number
  persisted?: boolean
  /**
   * In-progress composer text the user typed but didn't send. Persisted
   * to fs as session metadata; surfaced here so the sidebar can hydrate
   * draft state without a separate fetch.
   */
  composerDraft?: string
  /**
   * Wall-clock time of the last composer keystroke that produced a
   * persisted change. Combined with `updatedAt` (max) for the sidebar
   * sort key.
   */
  lastComposerEditAt?: number
  /** Persisted creation time; absent when unknown (a session older than the
   *  field, or one not yet persisted). (F-17) */
  createdAt?: number
  /** Pinned by the user: listed above unpinned sessions. Persisted in the
   *  session's metadata. */
  pinned?: boolean
}

export type SharedWorkerOutboundMessage =
  | (AgentWorkerOutboundMessage & { sessionId: string })
  | {
      // Manager-sourced broadcast of the session's saved "next message".
      // Emitted when a running-session submit is appended to
      // `SessionEntry.pendingMessage` (`reason:'appended'`, full text) and when
      // the pending message is consumed as the next turn on completion
      // (`reason:'consumed'`, empty text). The WebView renders the full text
      // verbatim — it never merges deltas locally.
      type: 'worker.pendingMessageUpdated'
      sessionId: string
      payload: {
        text: string
        reason: 'appended' | 'consumed'
        promptUuids?: string[]
        // `appended` only — one entry per parked submit (see workerProtocol).
        // `text` is these joined with newlines; the join is lossy because a
        // submit can be multi-line, so the count comes from here.
        entries?: string[]
        consumed?: { text: string; promptUuid?: string }
      }
    }
  | {
      // Confirmation that the session's pending message was cleared (a
      // `worker.clearPendingMessage` request, or an interrupt). WebViews
      // waiting on a clear stop ignoring stale `pendingMessageUpdated` events
      // once this arrives.
      type: 'worker.pendingMessageCleared'
      sessionId: string
    }
  | {
      type: 'worker.error'
      payload: { code: string; message: string }
    }
  | {
      type: 'session.list'
      payload: { sessions: SessionCard[] }
    }
  | {
      type: 'session.updated'
      payload: { session: SessionCard }
    }
  | {
      type: 'session.transcript'
      payload: {
        sessionId: string
        requestId: string
        messages: Message[]
        /** Set when the disk read failed — the tab must NOT render this as an
         *  empty transcript (a failed read is not "no messages"). */
        error?: string
      }
    }
  | {
      type: 'session.removed'
      payload: { sessionId: string; requestId?: string }
    }
  | {
      // Ack for `session.fork`: the new session's transcript has been written
      // and its summary broadcast. The requester switches to `newSessionId`.
      type: 'session.forked'
      payload: { fromSessionId: string; newSessionId: string; requestId?: string }
    }
  | {
      // Ack for `task.stop` — surfaces the manager's result so the drawer
      // can clear its pending row state (and toast on a no-op).
      type: 'task.stopped'
      payload: {
        sessionId: string
        status:
          | 'stopped'
          | 'not_found'
          | 'already_finished'
          | 'stop_failed'
          | 'stop_pending'
        requestId?: string
      }
    }
  | {
      // Ack for `task.resume` — `ok:false` carries a reason for a toast.
      type: 'task.resumed'
      payload: {
        sessionId: string
        ok: boolean
        reason?: 'not_found' | 'still_running' | 'unavailable'
        requestId?: string
      }
    }
  | {
      // Reply to `task.transcript`: the projected read-only transcript, or
      // null if it couldn't be read (no storage / no persisted session), plus
      // the detail header info (model / task / partial-or-final summary), null
      // when the sub-agent is unknown to the manager.
      type: 'task.transcript'
      payload: {
        sessionId: string
        requestId: string
        entries: NexusTaskTranscriptEntry[] | null
        info: NexusTaskInfo | null
      }
    }
  | {
      // Pushed to every subscriber of this toolCallId whenever the detail
      // becomes available. `detail: null` means we looked and it isn't
      // there (or can't be resolved) — callers should treat that as a
      // terminal "no data" rather than waiting longer.
      type: 'toolDetail.ready'
      payload: {
        toolCallId: string
        detail: BrowserToolCallDetailRecord | null
      }
    }
  | {
      // Reply to `trace.flush`. Carries the worker-realm tracer's ring
      // buffer at this instant. Sorted by `startMs` ascending.
      type: 'trace.snapshot'
      requestId?: string
      payload: { records: TraceRecord[] }
    }
  | {
      // Streamed for every span end / event in the worker realm while
      // a UI port has an active `trace.subscribe` (optionally filtered).
      type: 'trace.record'
      payload: { record: TraceRecord }
    }
  | {
      // The worker-realm console ring buffer (console.warn/error + uncaught
      // error / unhandledrejection) at flush time. Sent alongside
      // `trace.snapshot` in reply to `trace.flush` so the overlay's
      // SharedWorker tab seeds with history. Oldest→newest.
      type: 'worker.log.snapshot'
      payload: { entries: WorkerLogEntry[] }
    }
  | {
      // Streamed for every captured worker-realm console.warn/error (and
      // uncaught error / unhandledrejection) while a UI port has an active
      // `trace.subscribe`. Surfaces in the Nexus trace overlay's
      // SharedWorker tab — the only place worker-realm console output is
      // visible without opening the SharedWorker inspector.
      type: 'worker.log'
      payload: { entry: WorkerLogEntry }
    }
  | {
      // Unified per-session topbar feed (pill + model button + counters).
      // Snapshot on session open / switch / late subscriber; deltas on
      // subsequent changes. Sourced from `sessionRegistry`; routed to
      // per-session subscribers and `all` subscribers by
      // `SharedWorkerSessionManager`.
      type: 'session.currentState'
      payload: NexusCurrentSessionPayload
    }
  | {
      // Compact summary for the session-list UI. All-port (`all=true`)
      // subscribers only — every session's running flag + counters.
      type: 'session.summary'
      payload: NexusSessionsSummaryPayload
    }

export function isSessionMessage(
  msg: SharedWorkerInboundMessage,
): msg is SessionWorkerInboundMessage {
  return (
    'sessionId' in msg &&
    typeof msg.type === 'string' &&
    msg.type.startsWith('worker.')
  )
}

/**
 * The alphabet every session id this realm mints fits in — a v4 uuid
 * (`randomUuid`), `subagent-<label>_<hex>` (`createSidechainAgentId`),
 * `teammate-<team>-<key>-<ms>` (team id + member key are `[a-z0-9-]`),
 * `headless-rt_<ts>_<rand>-<ms>` (routines), and the public `a…` task ids
 * (`mintTaskHandle`, base36). No separators, no `.`/`..`, bounded length.
 */
const SAFE_SESSION_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/

/**
 * Whether a session id from a port message may be used as-is. Session ids
 * flow straight into storage paths (`joinRuntimePath(projectDir, sessionId)`
 * → a recursive delete on `session.delete`), so anything a page can post is
 * checked here before it reaches a handler. `.` and `..` cannot match (the
 * first character must be alphanumeric); a path separator never can.
 */
export function isSafeSessionId(value: unknown): value is string {
  return typeof value === 'string' && SAFE_SESSION_ID.test(value)
}
