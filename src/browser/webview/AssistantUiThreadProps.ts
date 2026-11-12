import type { AppendMessage } from '@assistant-ui/react'
import type { RuntimeConnection } from '../runtimeClient/RuntimeConnection'
import type {
  BrowserLlmSelection,
  NexusSettingsSection,
  ProviderMissingPrompt,
} from '../bridge/browserBridgeProtocol'
import type { NexusTaskSummaryRow } from '../bridge/protocol/ui'
import type {
  BrowserRuntimeClientState,
  BrowserRuntimeToolResultSubmission,
  InjectRemoveResult,
  SubmitDelivery,
} from './BrowserRuntimeClient'
import type { ContinueInCodeFolder } from './sessionMessageCallbacks'
import type { FilePathStat } from '@/components/assistant-ui/file-path-context'
import type {
  RightPanelDiffTarget,
  RightPanelFileTarget,
  RightPanelSkillTarget,
} from '@/components/assistant-ui/right-panel-content-context'
import type { RuleEdit } from '@/permissions/ruleUpdates'
import type { BrowserToolCallDetailRecord } from '../../utils/toolCallDetails'
import type { TurnFileChange } from '../../utils/turnDiffs'
import type { SessionListItem } from './Sidebar'

export type AssistantUiThreadProps = {
  state: BrowserRuntimeClientState
  readOnly?: boolean
  /** Set only while the session is archived: the composer is held and offers this. (F-36) */
  onUnarchive?: () => void
  /** The session this thread shows, for reads that must work without a snapshot (a read-only thread has none). */
  threadSessionId?: string
  submitPrompt: (prompt: string) => Promise<void>
  /**
   * Submit a hidden, model-only "meta" turn — used by A2UI surface actions
   * (button clicks). Threaded down to the lazy A2UI panel; absent for sessions
   * that never render a surface. See UpstreamA2uiPanel.
   */
  submitActionMessage?: (prompt: string) => Promise<void>
  /**
   * Resume an interrupted/completed conversation (the composer's Continue
   * button) via `BrowserRuntimeClient.continueConversation` — a hidden
   * `isMeta` continuation that never renders as a user bubble. Absent ⇒ the
   * Continue button stays hidden (thread.tsx gates on the context value).
   */
  continueConversation?: () => Promise<void>
  submitComposerMessage?: (
    message: AppendMessage,
    options?: { delivery?: SubmitDelivery },
  ) => Promise<void>
  /**
   * Open the host's native multi-file picker (the guest `<webview>` cannot raise its own
   * `<input type=file>`). Absent ⇒ assistant-ui's built-in `<input>`. `allowImages` follows
   * the ACTIVE model's capability.
   */
  onPickAttachmentFiles?: (options?: { allowImages?: boolean }) => Promise<File[]>
  submitToolResult: (submission: BrowserRuntimeToolResultSubmission) => Promise<void>
  loadToolCallDetail?: (
    toolCallId: string,
  ) => Promise<BrowserToolCallDetailRecord | null>
  loadTurnDiffDetail?: (
    turnIndex: number,
  ) => Promise<TurnFileChange[] | null>
  interrupt: () => Promise<void>
  /**
   * Clear this session's saved "next message" (the NextMessageStrip × button).
   * Routes to the active session's client → `worker.clearPendingMessage`. The
   * clearing WebView restores the text into its own composer (handled inside
   * the strip); other WebViews just hide the strip. Absent ⇒ the × is inert.
   */
  onClearPendingMessage?: () => void
  /**
   * Remove one pending plain-Enter bubble (its ×) via
   * `worker.removeInjectMessage`. Resolves with the worker's verdict; only an
   * `ok:true` hands the text (and the files this page attached) back to this
   * composer. Absent ⇒ no × is shown.
   */
  onRemoveInjectMessage?: (uuid: string) => Promise<InjectRemoveResult>
  /**
   * Set this session's permission mode (composer mode picker / Shift+Ctrl+M).
   * Routes to `worker.setPermissionMode`. Absent ⇒ the picker doesn't render
   * (e.g. tests / storybook). Mirrors how other host actions thread in.
   */
  setPermissionMode?: (mode: string) => void
  /**
   * Persist the user's acceptance of the Bypass-Permissions warning dialog
   * (F-13). Used by the confirm-before-apply gate over switches into
   * `bypassPermissions`. Absent ⇒ the gate still works but the acknowledgment
   * is not persisted (re-prompts next session).
   */
  setSkipDangerousMode?: (value: boolean) => void
  /** Resolve a queued interactive tool confirmation (one ask at a time). */
  resolveToolUseConfirm?: (params: {
    approvalCallId: string
    behavior: 'allow' | 'reject' | 'abort'
    updatedInput?: Record<string, unknown>
    feedback?: string
    ruleEdits?: RuleEdit[]
  }) => void | Promise<void>
  /**
   * Resolve a pending plan approval: clears it in the engine + refreshes the
   * snapshot so the plan-approval control dismisses immediately. Called before
   * setPermissionMode + submitToolResult when the user approves / keeps
   * planning.
   */
  clearPlanApproval?: (toolCallId?: string) => void | Promise<void>
  /**
   * Open the right-side plan-details panel (shell-level drawer) for this
   * session's pending plan. Wired from MultiSessionShell; absent on embeds
   * without a panel host (the footer control's "View plan" is then inert).
   */
  onOpenPlanPanel?: () => void
  /**
   * Persisted composer draft for THIS session (loaded from localStorage
   * by the parent). Restored into the composer on first mount when the
   * live composer is still empty. Subsequent prop changes are ignored —
   * we never overwrite the user's in-progress typing.
   */
  initialComposerDraft?: string
  /** Text to add to the end of the composer, once per `nonce` (F-9 *Attach as context*). */
  composerInsert?: { text: string; nonce: number } | null
  /**
   * Fires on a 500 ms debounce after the user edits the composer. The
   * parent persists the draft to localStorage and bumps the session's
   * `lastComposerEditAt`, which the sidebar's sort key consumes. The
   * `sessionId` argument lets the parent share a single stable callback
   * across all mounted thread trees in the LRU.
   */
  onComposerEdit?: (
    sessionId: string,
    composerDraft: string,
    editedAt: number,
  ) => void
  /**
   * Fork the conversation at a message uuid. Bound to this thread's session by
   * MultiSessionShell; surfaced as the user-message "Fork from here" action.
   */
  onForkFromMessage?: (cutUuid: string) => void
  /**
   * Fork the conversation INCLUSIVELY at a transcript uuid, the composer left
   * empty: the message menu's "Fork from here" on a reply (F-22). Bound to
   * this thread's session by MultiSessionShell.
   */
  onForkAfterMessage?: (cutUuid: string) => void
  /**
   * Send a composer message into a forked copy of this session (the
   * composer's Ctrl/Cmd+Alt+Enter), cut inclusively at `cutUuid`. Resolves
   * `false` when the fork never happened, so the text goes back into the
   * composer. Bound to this thread's session by MultiSessionShell.
   */
  onSendInForkedSession?: (
    cutUuid: string,
    message: AppendMessage,
  ) => Promise<boolean>
  /**
   * Continue this chat in a new Code session bound to a folder, forked at
   * `cutUuid` (exclusive). Resolves false when no folder was chosen. Bound to
   * this thread's session by MultiSessionShell.
   */
  onContinueInCode?: (cutUuid: string, folder: ContinueInCodeFolder) => Promise<boolean>
  /** Rewind the conversation to a message uuid (restore + discard after). */
  onRewindToMessage?: (cutUuid: string) => void
  /** Open a side chat cut at a message, quoting the selection (F-36). */
  onStartSideChat?: (cutUuid: string, selection: string) => void
  /**
   * Session list props (mirror the Sidebar prop shape) — threaded through
   * to the thread body for session-scoped actions.
   */
  sessions?: SessionListItem[]
  activeSessionId?: string
  /** Open the global Background Tasks drawer. Provided to the conversation via
   *  `BackgroundTasksContext` so the Agent tool card can surface a "jump to
   *  background task" affordance on a background launch. */
  onOpenBackgroundTasks?: (focusSessionId?: string) => void
  /** Number of THIS session's background tasks still running. Rides
   *  `BackgroundTasksContext` to the composer-footer "session still working"
   *  indicator (a settled turn with running tasks WILL receive more
   *  task-notification turns). */
  runningBackgroundTaskCount?: number
  /** THIS session's background task rows, for the session card stack. */
  backgroundTaskRows?: readonly NexusTaskSummaryRow[]
  onStopBackgroundTask?: (taskId: string) => void
  /** Open the Tasks view on its list rather than a task's detail. */
  onOpenBackgroundTasksList?: () => void
  /** Open a file in the right-panel Files view. Provided via
   *  `RightPanelContentContext`; consumed by the Read/Edit tool cards' path
   *  headers. Absent on embeds without a panel host. */
  onOpenFileInPanel?: (target: RightPanelFileTarget) => void
  /** Bring the Terminal pane forward on one of `sessionId`'s terminals: a chat Run card ran a command in it. */
  onOpenTerminalInPanel?: (sessionId: string, terminalId: string) => void
  /** Batched existence check for file paths the transcript auto-detects.
   *  Absent on hosts without an fs bridge — paths then stay plain text. */
  statFilePaths?: (paths: string[]) => Promise<readonly FilePathStat[]>
  /** Open an Edit's diff in the right-panel Diff view. Consumed by the Edit
   *  tool card's clickable title. */
  onOpenDiffInPanel?: (target: RightPanelDiffTarget) => void
  /** Open a skill's instructions in the right-panel Skill view. Consumed by
   *  the Skill card's "View skill". */
  onOpenSkillInPanel?: (target: RightPanelSkillTarget) => void
  onSwitchThread?: (sessionId: string) => void
  onDeleteThread?: (sessionId: string) => void
  onRenameThread?: (sessionId: string, title: string) => void
  onNewThread?: () => void
  onLaunchThread?: (templateType?: string) => void
  openSettings?: (section?: NexusSettingsSection) => Promise<void>
  /** Open Settings → Plugins & Mods at one plugin's row — the icon on a
   *  mod's rows above the prompt (F-25). */
  onOpenPluginSettings?: (plugin: string) => void
  /** The shell docks the mods' panes in its Plugins side pane (F-25,
   *  `placement: 'dock'`): the thread draws none above the prompt. */
  modPanesDocked?: boolean
  /** The session card stack docks at the transcript's top right (F-9). */
  sessionCardsDocked?: boolean
  /** The session cards' popover (the stack does not dock): open for this
   *  thread, and how it asks to close. */
  sessionCardsPopoverOpen?: boolean
  onSessionCardsPopoverClose?: () => void
  /** The page's runtime connection, for `mods/ui/<sessionId>` — the mods'
   *  status lines, notices and toasts (F-25). Absent on a mock host. */
  runtimeConnection?: () => Promise<RuntimeConnection>
  loadProviderMissingPrompt?: () => Promise<ProviderMissingPrompt>
  /**
   * Adopt the catalog's default model as this session's selection, when the send gate finds
   * the persisted one unavailable but enabled providers exist. The shell also opens the quick
   * model picker.
   */
  onAdoptDefaultSelection?: (selection: BrowserLlmSelection) => void
  /**
   * Apply a selection to THIS session only — the composer's effort control.
   * Unlike the topbar pick it never moves the global default new sessions
   * start on (F-12, "Session effort"). Absent = the
   * control is not rendered. Called with THIS thread's sessionId (as
   * `onSelectProjectFolder` is), never routed to whichever session is active.
   */
  onSelectSessionModel?: (sessionId: string, selection: BrowserLlmSelection) => void
  /** Save (tokens) or clear (`'auto'`) the NAMED session's active model's
   *  auto-compact window — the context popover's drag handle. */
  onSetAutoCompactWindow?: (sessionId: string, value: number | 'auto') => void
  /**
   * Re-bind a code session to an already-known recent project folder (picked
   * from the composer chip's dropdown). Bound to a sessionId by
   * MultiSessionShell. No-op once the session has messages (folder is locked).
   */
  onSelectProjectFolder?: (sessionId: string, path: string) => void
  /**
   * Open the native folder picker for a code session and bind the chosen
   * folder (the chip's "Open folder…" item + the forced first-run dialog).
   * Resolves once the pick + bind settle so callers can show progress.
   */
  onOpenProjectFolder?: (sessionId: string) => Promise<void> | void
  /**
   * Reveal the bound folder in the native OS file manager (the chip's "Show in
   * Explorer" action). Operates on the folder path, not a session.
   */
  onRevealProjectFolder?: (path: string) => void
  /**
   * Report whether THIS session currently has an unanswered AskUserQuestion.
   * That pending state lives only in the per-thread pending-questions store
   * (it doesn't survive on the worker snapshot), so it's surfaced upward to the
   * shell to union into the session-list "needs your response" indicator. The
   * other halting controls (plan / permission approvals) are read directly from
   * the snapshot at the shell and don't need this.
   */
  onPendingQuestionsChange?: (sessionId: string, hasPending: boolean) => void
}
