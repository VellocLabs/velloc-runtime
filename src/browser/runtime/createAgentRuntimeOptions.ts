import type { TraceLoggerEntry } from '../../engine/turn/modelTrace'
import type { AutoCompactWindowSettings } from '../../context/compaction/windowSettings'
import type { PermissionSettingsBySource } from '../../permissions/seedPermissionContext'
import type { ContentBlockParam, Message } from '../../runtime/RuntimeTypes'
import type { FileSnapshotRecorder } from '../../sessions/fileSnapshots/snapshotRecorder'
import type { BrowserConversationStore } from '../../sessions/sessionStore'
import type { RuntimeFs } from '../../utils/fs/runtimeFs'
import type { BrowserBridgeTransport } from '../bridge/browserBridgeProtocol'
import type { BrowserRuntimeOptions } from './AgentRuntimeState'

/** What `createBrowserRuntime` takes: the runtime options plus the worker's per-session hooks. */
export type CreateBrowserRuntimeOptions = BrowserRuntimeOptions & {
  bridgeTransport: BrowserBridgeTransport
  traceLogger?: (entry: TraceLoggerEntry) => void
  /**
   * Boot-welcome milestones from inside the runtime build, fired as each step starts: `connectingTools`
   * before the MCP pool connect, `restoring` before the transcript read. Primary boot session only; best-effort.
   */
  onBootStage?: (stage: 'connectingTools' | 'restoring') => void
  /**
   * Fired ONCE after the persisted transcript is read, before MCP connect and engine construction, so
   * the page can render early; submits stay parked until `worker.ready`. Not for a background fork.
   * Synchronous; must not throw.
   */
  onUiReady?: (info: {
    sessionId: string
    cwd: string
    projectRoot: string
    usedSandboxProjectRoot: boolean
    hostMode: string | undefined
    messages: Message[]
    /**
     * This build's own store. The worker stamps transcript lines from it;
     * the process-global slot may already name another session's.
     */
    conversationStore?: BrowserConversationStore
    /** This build's file-snapshot recorder; the turn-diff history reads it. */
    fileSnapshotRecorder?: FileSnapshotRecorder
    /** This build's filesystem; the display state reads the plan file with it. */
    installedFs?: RuntimeFs
    /** The auto-compact reader the built runtime exposes; not yet loaded. */
    autoCompactWindows?: AutoCompactWindowSettings
    /** The per-source permission settings the build seeds its rules from. */
    permissionSettings?: Promise<PermissionSettingsBySource>
  }) => void
  /**
   * Mid-turn task-notification drain.
   * Called by the session's main query loop between tool rounds; returns this
   * session's pending background-task `<task-notification>` batch (removed
   * from the delivery queue) or null. `includeLater` is true when the round
   * just ran Sleep, which also admits sub-agent completions. Unset → results
   * arrive only as the idle re-activation turn.
   */
  drainTaskNotifications?: (
    sessionId: string,
    opts: { includeLater: boolean },
  ) => { prompt: string; enqueuedAt: number } | null
  /**
   * Mid-turn team-mailbox drain: the frames queued for this session (it is a
   * teammate, or a lead), removed and marked read as they are returned.
   * Called between tool rounds next to the notification drain. Unset →
   * frames arrive only as turns.
   */
  drainTeamMessages?: (
    sessionId: string,
  ) => Array<{ prompt: string; enqueuedAt: number }>
  /** A turn's start: this session's queued child reports as one block, taken
   *  once (F-36). Unset → no child reports. */
  takeChildReports?: (
    sessionId: string,
    opts: { autoContinuation: boolean },
  ) => Promise<string | null>
  /**
   * Aborts when the runtime scope this build belongs to is disposed (the
   * worker's `RuntimeScope.abortController`). Published on
   * `ToolUseContext.options.runtimeScopeSignal` so work that outlives its tool
   * call can stop with the scope. See toolkit/toolContract.ts.
   */
  runtimeScopeSignal?: AbortSignal
  /**
   * Mid-turn user input drain: take this session's parked inject messages
   * (plain Enter while busy), removing them from the worker's queue. Called
   * by the main query loop between tool rounds, next to the notification
   * drain. Unset → inject messages only land as the next turn.
   */
  drainInjectMessages?: () => Array<{
    uuid: string
    prompt: string | Array<ContentBlockParam>
    enqueuedAt: number
  }>
  /**
   * Peek (never take) whether `drainInjectMessages` has anything parked.
   * Published on `ToolUseContext.options.hasPendingInjectMessages` so the
   * Sleep tool can end early when the user sends a message. See toolkit/toolContract.ts.
   */
  hasPendingInjectMessages?: () => boolean
  /**
   * A plugin's `$.prompt.submit` (F-25): queue the prompt the chain let
   * in as a turn of its own, run once the session is idle. The worker's turn
   * controller owns the queue. Unset (a headless or sub-agent build) → the
   * noun is refused by name.
   */
  enqueuePluginTurn?: (turn: import('../../mods/promptNouns').PluginPromptTurn) => void
  /**
   * Every session reloads its plugins (the worker host's fan-out): after
   * `$.config.set` stored a plugin's option. Unset → this session's engine
   * alone reloads.
   */
  reloadPluginsOnAllSessions?: () => void
  /**
   * The session draws a prompt box on a page (F-25): `$.prompt.read` /
   * `.fill` / `.suggest` ask it over `mods/ui/<sessionId>`. Unset (a headless
   * or sub-agent build) → answered as headless: the empty box, `no_composer`.
   */
  drawsComposer?: boolean
}
