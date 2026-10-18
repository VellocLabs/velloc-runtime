import { ModUiContext } from '../../components/assistant-ui/mod-ui-context'
import {
  SessionCardsPopoverContext,
  SessionChangeFiguresContext,
} from '../../components/assistant-ui/session-card-stack'
import { useSessionModUi } from './mods/useSessionModUi'
import { useCan } from './useCan'
import type { RuntimeConnection } from '../runtimeClient/RuntimeConnection'
import type {
  AppendMessage,
  ThreadMessageLike,
} from '@assistant-ui/react'
import {
  ComposerDeliveryContext,
  takeInjectRestoreFiles,
  type ComposerDelivery,
} from '../../components/assistant-ui/inject-message-context'
import { resolveForkSendPlan } from './forkSend'
import {
  HistoryContentWindowContext,
  mergeWantedRows,
  windowMessageContent,
} from './historyContentWindow'
import { shareRowsById } from './structuralSharing'
import type { InjectRemoveResult, SubmitDelivery } from './BrowserRuntimeClient'
import {
  AssistantRuntimeProvider,
  AuiIf,
  useComposerRuntime,
  useExternalStoreRuntime,
} from '@assistant-ui/react'
import {
  ChevronRightIcon,
  FolderIcon,
  MoreHorizontalIcon,
  PencilIcon,
  SparklesIcon,
  Trash2Icon,
  XIcon,
} from 'lucide-react'
import { InkRipple } from '@/components/assistant-ui/ink-ripple'
import { SessionAttentionDot } from '@/components/assistant-ui/session-attention-dot'
import { DropdownMenu as DropdownMenuPrimitive } from 'radix-ui'
import {
  Fragment,
  Suspense,
  lazy,
  memo,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react'
import type {
  BrowserLlmSelection,
  NexusSettingsSection,
  ProviderMissingPrompt,
} from '../bridge/browserBridgeProtocol'
import type { AgentRuntimeWorkerSnapshot, SessionMcpServerView } from '../worker/workerProtocol'
import type { NexusTaskSummaryRow } from '../bridge/protocol/ui'
import { deriveSessionMetadataFromMessages, isConversationResumable } from '../../sessions/sessionStore'
import { BrowserComposerAttachmentAdapter } from './BrowserComposerAttachmentAdapter'
import { getSupportsImageInputForModel } from '../../engine/contextWindow'
import {
  ComposerAttachmentPickerProvider,
  ComposerModelCapabilitiesProvider,
} from '@/components/assistant-ui/attachment'
import {
  BypassPermissionsDialog,
  shouldGateBypassSwitch,
} from './BypassPermissionsDialog'

// The startup bypass-warning gate (F-13) fires at most once PER SESSION. Keyed
// by sessionId — NOT a per-instance ref — so it survives MultiSessionShell's LRU
// mount/unmount churn: a session that boots in the background and later
// foregrounds, or one evicted and remounted, must not re-warn. Keying on
// sessionId means this module-global does not leak across sessions (each session
// reads only its own key — cf. the multi-session global-state caveat).
const startupBypassGatedSessions = new Set<string>()
import { BackgroundTasksContext } from '@/components/assistant-ui/background-tasks-context'
import { SessionConnectorsContext } from '@/components/assistant-ui/session-connectors-context'
import { SessionBusyProvider } from '@/components/assistant-ui/session-busy-context'
import {
  RightPanelContentContext,
  type RightPanelDiffTarget,
  type RightPanelSkillTarget,
  type RightPanelFileTarget,
} from '@/components/assistant-ui/right-panel-content-context'
import {
  FilePathContext,
  createFilePathProbe,
  type FilePathStat,
} from '@/components/assistant-ui/file-path-context'
import {
  PlanPanelContext,
  type PlanPanelContextValue,
} from '@/components/assistant-ui/plan-panel-context'
import {
  PermissionAskContext,
  type PermissionAskContextValue,
} from '@/components/assistant-ui/permission-ask-context'
import {
  EnterPlanApprovalContext,
  type EnterPlanApprovalContextValue,
} from '@/components/assistant-ui/enter-plan-approval-context'
import { resolvePlanApproval } from '@/permissions/planApproval'
import { snapshotNeedsAnswer, snapshotBlocksComposerInput } from '@/utils/sessionNeedsAnswer'
import type { RuleEdit } from '@/permissions/ruleUpdates'
import type { BrowserRuntimeClientState } from './BrowserRuntimeClient'
import type { BrowserRuntimeToolResultSubmission } from './BrowserRuntimeClient'
import {
  combineThreadMessages,
  combineThreadMessagesDeps,
  convertTranscriptToThreadMessages,
  extractTextFromAppendMessage,
  PROVIDER_API_ERROR_RESUME_PROMPT,
  resolveProviderApiErrorRetryAction,
  shouldShowLoadingSkeleton,
  transcriptWillHydrateAssistantBody,
} from './assistantUiAdapter'
import {
  engageConversationLockOnFirstForeground,
  engageConversationLockToBottom,
  findConversationViewport,
} from './conversationScrollLock'
import {
  createConfiguredModelCatalog,
  isSelectionEnabled,
} from './modelCatalog'
import { sessionTimeBucket, sessionActivityTime } from './sessionTimeBucket'
import { useComposerDraftSync } from './useComposerDraftSync'
import { useProviderMissingPrompt } from './useProviderMissingPrompt'
import { useT, type TranslateFn } from './i18n'
import {
  getThreadLaunchers,
  getLauncherForType,
  launcherTitle,
  launcherDefaultTitle,
} from './threadLaunchers'
import { TokenUsageProvider } from './TokenUsageIndicator'
import {
  SessionEffortProvider,
  type SessionEffortContextValue,
} from './ComposerEffortPicker'
import { findActiveModel } from './ModelQuickPicker'
import { isTeammateSessionId } from '../../utils/sidechainStoragePaths'
import { getProviderUsageStore, useProviderUsage } from './providerUsageStore'
import { ToolCallDetailProvider } from '@/components/assistant-ui/tool-call-detail-context'
import { MessageActionsContext } from '@/components/assistant-ui/message-actions-context'
import { TooltipProvider } from '@/components/ui/tooltip'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import type { BrowserToolCallDetailRecord } from '../../utils/toolCallDetails'
import { findWorkspaceDiffFile, type TurnFileChange } from '../../utils/turnDiffs'
import {
  getBootDiagnosticTraceId,
  installSessionTracer,
} from '../../utils/sessionTrace'
// Static import on purpose: a lazy() Thread suspends on cold load for its chunk and its
// markdown chunk (P-2).
import {
  ComposerCancelStateProvider,
  ContinueConversationProvider,
  IsResumableProvider,
  LastTerminalReasonProvider,
  PermissionModeProvider,
  type ProjectFolderControls,
  ProjectFolderProvider,
  SlashCommandsProvider,
  SnapshotNeedsAnswerProvider,
  SnapshotBlocksComposerInputProvider,
  Thread,
  ThreadWelcome,
} from '@/components/assistant-ui/thread'
import { ASK_TOOL_ID } from '@/toolkit/builtin/askUser'
import { hasA2uiToolCall } from './a2ui/hasA2uiSurface'
import {
  A2UI_CREATE_SURFACE,
  A2UI_DELETE_SURFACE,
  A2UI_UPDATE_COMPONENTS,
  A2UI_UPDATE_DATA_MODEL,
} from '@/toolkit/builtin/a2ui/a2uiToolNames'
import { type SessionListItem } from './Sidebar'
import {
  consumePendingMessageJump,
  findLastEntryAtOrBeforeLine,
  setPendingMessageJump,
  peekPendingMessageJump,
  subscribePendingMessageJump,
} from './pendingMessageJumpStore'
import {
  revealRowForPart,
  revealThreadMessage,
} from './revealThreadMessage'
import { requestPartReveal } from './partRevealStore'
import { useShowReasoning, withoutReasoningParts } from './showReasoning'
import { ComposerDraftSync, ComposerTextRestore } from './ThreadComposerSync'
import { ProviderMissingDialog, WorkspaceProjectFolderDialog } from './ThreadDialogs'

/**
 * How many times one search jump may re-arm itself after a failed reveal; unbounded, a
 * reveal that cannot succeed would loop for as long as the session stays open.
 */
const MAX_JUMP_ATTEMPTS = 2

function bootTracer() {
  return installSessionTracer({ context: 'ui' })
}

const GenerativeToolUIs = lazy(async () => {
  const module = await import('./GenerativeToolUIs')
  return { default: module.GenerativeToolUIs }
})

// A2UI surfaces render INLINE in the conversation (via the a2ui_* tool UIs).
// This host wraps <Thread> with the shared A2UI runtime (one processor + the
// action loop + the maximize overlay) so those tool UIs can render the live
// surface. The renderer + Material Symbols font live in this on-demand chunk;
// only the cheap `hasA2uiToolCall` detector stays resident, so conversations
// that never use A2UI never fetch this code.
const A2uiProviderHost = lazy(async () => {
  const module = await import('./a2ui/A2uiProviderHost')
  return { default: module.A2uiProviderHost }
})

const GENERATIVE_TOOL_NAMES = new Set([
  'collect_contact',
  'select_date',
  'show_location',
  ASK_TOOL_ID,
  // The a2ui_* tool-calls render the surface (or a "jump to latest" breadcrumb)
  // inline at their position in the conversation.
  A2UI_CREATE_SURFACE,
  A2UI_UPDATE_COMPONENTS,
  A2UI_UPDATE_DATA_MODEL,
  A2UI_DELETE_SURFACE,
])

export type AssistantUiThreadProps = {
  state: BrowserRuntimeClientState
  readOnly?: boolean
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
   * Send a composer message into a forked copy of this session (the
   * composer's Ctrl/Cmd+Alt+Enter), cut inclusively at `cutUuid`. Resolves
   * `false` when the fork never happened, so the text goes back into the
   * composer. Bound to this thread's session by MultiSessionShell.
   */
  onSendInForkedSession?: (
    cutUuid: string,
    message: AppendMessage,
  ) => Promise<boolean>
  /** Rewind the conversation to a message uuid (restore + discard after). */
  onRewindToMessage?: (cutUuid: string) => void
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

/**
 * What a composer submit is allowed to do, given the session's current state.
 *
 * `send` is the only outcome that reaches the runtime; every other outcome is a
 * refusal the caller must pair with a composer-text restore, because
 * `composer.send()` has already cleared the composer by the time `onNew` runs.
 */
export type ComposerSendGateDecision =
  | { kind: 'send' }
  /** Snapshot hasn't arrived — we can't tell whether a provider is configured. */
  | { kind: 'not-ready' }
  /** This thread isn't the one the submit callbacks are bound to. */
  | { kind: 'wrong-session' }
  /** Halted on a permission / plan approval; a message can't unblock it. */
  | { kind: 'awaiting-confirm' }
  /** A code session must bind a real project folder before it can send. */
  | { kind: 'needs-project-folder' }
  /** The pinned model is gone but the catalog still has a usable default. */
  | { kind: 'adopt-default'; selection: BrowserLlmSelection }
  /** No usable provider at all — the set-up-a-provider dialog. */
  | { kind: 'provider-missing' }

/**
 * Pure send gate. `wrong-session` guards against validating THIS thread's snapshot while
 * the shell's submit callbacks target the ACTIVE session's client.
 */
export function resolveComposerSendGate(params: {
  snapshot: AgentRuntimeWorkerSnapshot | null | undefined
  activeSessionId?: string
  canAdoptDefault: boolean
}): ComposerSendGateDecision {
  const { snapshot, activeSessionId, canAdoptDefault } = params
  if (!snapshot) return { kind: 'not-ready' }
  if (activeSessionId != null && snapshot.sessionId !== activeSessionId) {
    return { kind: 'wrong-session' }
  }
  if ((snapshot.approvalQueue?.length ?? 0) > 0) {
    return { kind: 'awaiting-confirm' }
  }
  if (snapshot.needsProjectFolder) return { kind: 'needs-project-folder' }
  const catalog = createConfiguredModelCatalog(snapshot.modelCatalog)
  if (!isSelectionEnabled(catalog, snapshot.currentSelection)) {
    // `createConfiguredModelCatalog` only keeps `defaultSelection` when it
    // resolves to an ENABLED provider+model, so its presence distinguishes
    // "this session's pinned model went away but providers are fine" (adopt
    // the default + pop the picker so the user can change it) from "no usable
    // provider at all" (the set-up-a-provider dialog). Without the split, a
    // stale pinned model re-opened the provider dialog on every send even
    // after settings were configured — an endless loop, because opening
    // settings can never fix a stale per-session pin.
    const fallback = catalog?.defaultSelection
    if (fallback && canAdoptDefault) {
      return { kind: 'adopt-default', selection: fallback }
    }
    return { kind: 'provider-missing' }
  }
  return { kind: 'send' }
}

export function getConversationTitle(state: BrowserRuntimeClientState): string {
  const metadata = deriveSessionMetadataFromMessages(
    state.transcriptMessages,
    null,
  )
  return metadata.firstPrompt || 'New Thread'
}

/**
 * The `state.lastError` codes the thread has words for. A code missing here
 * renders as the raw `code: message` — a developer-facing fallback, kept so a
 * new runtime error is loud rather than hidden. A new code the user is meant
 * to read takes a row here and a catalog entry, never a literal.
 */
const RUNTIME_ERROR_MESSAGE_KEYS: Partial<Record<string, Parameters<TranslateFn>[0]>> = {
  runtime_connection_failed: 'thread.runtimeConnectionFailed',
  plugin_template_absent: 'thread.pluginTemplateAbsent',
  plugin_template_waiting: 'thread.pluginTemplateWaiting',
  plugin_template_owner: 'thread.pluginTemplateOwner',
  topbar_command_unknown: 'thread.topbarCommandUnknown',
}

/**
 * What the error card shows for `lastError`: the catalog text for a known
 * code, with the raw `code: message` as `detail` (the card's `title`, the
 * technical detail for a bug report); the raw pair itself for an unknown code.
 */
export function runtimeErrorText(
  lastError: BrowserRuntimeClientState['lastError'],
  t: TranslateFn,
): { text: string; detail: string | null } | null {
  if (!lastError) return null
  const raw = `${lastError.code}: ${lastError.message}`
  const key = RUNTIME_ERROR_MESSAGE_KEYS[lastError.code]
  return key ? { text: t(key), detail: raw } : { text: raw, detail: null }
}

function hasGenerativeToolParts(messages: readonly ThreadMessageLike[]): boolean {
  return messages.some(message => {
    if (typeof message.content === 'string') {
      return false
    }

    return message.content.some(
      part =>
        part.type === 'tool-call' &&
        GENERATIVE_TOOL_NAMES.has(part.toolName),
    )
  })
}

// --- Main component ---

// What a read-only thread gets for the callbacks it must not run. One shared
// function, not an inline literal: a fresh closure per render would change the
// identity of every hook in InteractiveAssistantUiThread that depends on it.
const readOnlyNoop = async (): Promise<void> => {}

export const AssistantUiThread = memo(function AssistantUiThread({
  state,
  readOnly = false,
  submitPrompt,
  submitActionMessage,
  continueConversation,
  submitComposerMessage,
  onPickAttachmentFiles,
  submitToolResult,
  loadToolCallDetail,
  loadTurnDiffDetail,
  interrupt,
  onClearPendingMessage,
  onRemoveInjectMessage,
  setPermissionMode,
  setSkipDangerousMode,
  resolveToolUseConfirm,
  clearPlanApproval,
  onOpenPlanPanel,
  onForkFromMessage,
  onSendInForkedSession,
  onRewindToMessage,
  sessions,
  activeSessionId,
  onOpenBackgroundTasks,
  runningBackgroundTaskCount,
  backgroundTaskRows,
  onStopBackgroundTask,
  onOpenBackgroundTasksList,
  onOpenFileInPanel,
  statFilePaths,
  onOpenDiffInPanel,
  onOpenSkillInPanel,
  onSwitchThread,
  onDeleteThread,
  onRenameThread,
  onNewThread,
  openSettings,
  onOpenPluginSettings,
  modPanesDocked,
  sessionCardsDocked,
  sessionCardsPopoverOpen,
  onSessionCardsPopoverClose,
  runtimeConnection,
  loadProviderMissingPrompt,
  onAdoptDefaultSelection,
  onSelectSessionModel,
  onSetAutoCompactWindow,
  onSelectProjectFolder,
  onOpenProjectFolder,
  onRevealProjectFolder,
  initialComposerDraft,
  onComposerEdit,
  onPendingQuestionsChange,
}: AssistantUiThreadProps) {
  return (
    <InteractiveAssistantUiThread
      state={state}
      readOnly={readOnly}
      submitPrompt={readOnly ? readOnlyNoop : submitPrompt}
      submitActionMessage={readOnly ? undefined : submitActionMessage}
      continueConversation={readOnly ? undefined : continueConversation}
      submitComposerMessage={readOnly ? undefined : submitComposerMessage}
      onPickAttachmentFiles={readOnly ? undefined : onPickAttachmentFiles}
      submitToolResult={readOnly ? readOnlyNoop : submitToolResult}
      loadToolCallDetail={loadToolCallDetail}
      loadTurnDiffDetail={loadTurnDiffDetail}
      interrupt={readOnly ? readOnlyNoop : interrupt}
      onClearPendingMessage={readOnly ? undefined : onClearPendingMessage}
      onRemoveInjectMessage={readOnly ? undefined : onRemoveInjectMessage}
      setPermissionMode={readOnly ? undefined : setPermissionMode}
      setSkipDangerousMode={readOnly ? undefined : setSkipDangerousMode}
      resolveToolUseConfirm={readOnly ? undefined : resolveToolUseConfirm}
      clearPlanApproval={readOnly ? undefined : clearPlanApproval}
      onOpenPlanPanel={readOnly ? undefined : onOpenPlanPanel}
      onForkFromMessage={readOnly ? undefined : onForkFromMessage}
      onSendInForkedSession={readOnly ? undefined : onSendInForkedSession}
      onRewindToMessage={readOnly ? undefined : onRewindToMessage}
      sessions={sessions}
      activeSessionId={activeSessionId}
      onOpenBackgroundTasks={onOpenBackgroundTasks}
      runningBackgroundTaskCount={runningBackgroundTaskCount}
      backgroundTaskRows={backgroundTaskRows}
      onStopBackgroundTask={readOnly ? undefined : onStopBackgroundTask}
      onOpenBackgroundTasksList={onOpenBackgroundTasksList}
      onOpenFileInPanel={onOpenFileInPanel}
      statFilePaths={statFilePaths}
      onOpenDiffInPanel={onOpenDiffInPanel}
      onOpenSkillInPanel={onOpenSkillInPanel}
      onSwitchThread={onSwitchThread}
      onDeleteThread={onDeleteThread}
      onRenameThread={onRenameThread}
      onNewThread={onNewThread}
      openSettings={openSettings}
      onOpenPluginSettings={onOpenPluginSettings}
      modPanesDocked={modPanesDocked}
      sessionCardsDocked={sessionCardsDocked}
      sessionCardsPopoverOpen={sessionCardsPopoverOpen}
      onSessionCardsPopoverClose={onSessionCardsPopoverClose}
      runtimeConnection={runtimeConnection}
      loadProviderMissingPrompt={loadProviderMissingPrompt}
      onAdoptDefaultSelection={onAdoptDefaultSelection}
      onSelectSessionModel={readOnly ? undefined : onSelectSessionModel}
      onSetAutoCompactWindow={readOnly ? undefined : onSetAutoCompactWindow}
      onSelectProjectFolder={onSelectProjectFolder}
      onOpenProjectFolder={onOpenProjectFolder}
      onRevealProjectFolder={onRevealProjectFolder}
      initialComposerDraft={initialComposerDraft}
      onComposerEdit={readOnly ? undefined : onComposerEdit}
      onPendingQuestionsChange={onPendingQuestionsChange}
    />
  )
})

function InteractiveAssistantUiThread({
  state,
  readOnly = false,
  submitPrompt,
  submitActionMessage,
  continueConversation,
  submitComposerMessage,
  onPickAttachmentFiles,
  submitToolResult,
  loadToolCallDetail,
  loadTurnDiffDetail,
  interrupt,
  onClearPendingMessage,
  onRemoveInjectMessage,
  setPermissionMode,
  setSkipDangerousMode,
  resolveToolUseConfirm,
  clearPlanApproval,
  onOpenPlanPanel,
  onForkFromMessage,
  onSendInForkedSession,
  onRewindToMessage,
  sessions,
  activeSessionId,
  onOpenBackgroundTasks,
  runningBackgroundTaskCount,
  backgroundTaskRows,
  onStopBackgroundTask,
  onOpenBackgroundTasksList,
  onOpenFileInPanel,
  statFilePaths,
  onOpenDiffInPanel,
  onOpenSkillInPanel,
  onSwitchThread,
  onDeleteThread,
  onRenameThread,
  onNewThread,
  openSettings,
  onOpenPluginSettings,
  modPanesDocked,
  sessionCardsDocked,
  sessionCardsPopoverOpen,
  onSessionCardsPopoverClose,
  runtimeConnection,
  loadProviderMissingPrompt,
  onAdoptDefaultSelection,
  onSelectSessionModel,
  onSetAutoCompactWindow,
  onSelectProjectFolder,
  onOpenProjectFolder,
  onRevealProjectFolder,
  initialComposerDraft,
  onComposerEdit,
  onPendingQuestionsChange,
}: AssistantUiThreadProps) {
  const t = useT()
  // The mods' UI for THIS session (F-25): `mods/ui/<sessionId>`'s lines and
  // panes, who each plugin is (`mods/state`, for the card on its icon above
  // the prompt), and the icon's jump to the Plugins page.
  const canListMods = useCan('mods', 'list')
  const modSessionId = state.snapshot?.sessionId
  const modUi = useSessionModUi(runtimeConnection, modSessionId, {
    canListMods,
    onOpenPluginSettings,
    panesDocked: modPanesDocked,
  })
  const sessionCardsPopover = useMemo(
    () => ({
      docked: !!sessionCardsDocked,
      open: !!sessionCardsPopoverOpen,
      onClose: onSessionCardsPopoverClose ?? (() => {}),
    }),
    [sessionCardsDocked, sessionCardsPopoverOpen, onSessionCardsPopoverClose],
  )
  const [headerError, setHeaderError] = useState<string | null>(null)
  // "Try again" on the ProviderApiErrorCard. When the failed turn is already
  // persisted (the normal case — the card's retryPrompt is derived from the
  // transcript), resume it with a hidden meta continuation instead of
  // resubmitting the prompt: resubmitting appended a duplicate user bubble
  // (and payload turn) on every retry. See resolveProviderApiErrorRetryAction.
  const handleRetryProviderApiError = useCallback(
    async (retryPrompt: string) => {
      if (readOnly) return
      if (
        resolveProviderApiErrorRetryAction(
          state.transcriptMessages,
          retryPrompt,
        ) === 'resume'
      ) {
        await (submitActionMessage ?? submitPrompt)(
          PROVIDER_API_ERROR_RESUME_PROMPT,
        )
        return
      }
      await submitPrompt(retryPrompt)
    },
    [state.transcriptMessages, submitActionMessage, submitPrompt],
  )
  const messageActionsValue = useMemo(
    () => ({
      onForkFromMessage: readOnly ? undefined : onForkFromMessage,
      onRewindToMessage: readOnly ? undefined : onRewindToMessage,
      onRetryProviderApiError: readOnly ? undefined : handleRetryProviderApiError,
    }),
    [readOnly, onForkFromMessage, onRewindToMessage, handleRetryProviderApiError],
  )
  const [providerPrompt, setProviderPrompt] = useState<string | null>(null)
  // Draft text to put back into the composer after a send was intercepted by
  // the adopt-default path in `onNew` (the runtime has already cleared the
  // composer by then, same as the ProviderMissingDialog case).
  const [restoreComposerText, setRestoreComposerText] = useState<string | null>(
    null,
  )
  const clearRestoreComposerText = useCallback(
    () => setRestoreComposerText(null),
    [],
  )
  const configuredCatalog = useMemo(
    () =>
      state.snapshot
        ? createConfiguredModelCatalog(state.snapshot.modelCatalog)
        : undefined,
    [state.snapshot],
  )
  const hasValidProvider =
    state.snapshot !== null &&
    isSelectionEnabled(configuredCatalog, state.snapshot.currentSelection)
  const providerPromptResources = useProviderMissingPrompt(
    loadProviderMissingPrompt,
    state.snapshot,
    hasValidProvider,
  )

  // The active session's template type → its per-type welcome page
  // (`src/template/<type>/welcome.md`, rendered in the empty viewport).
  const activeTemplateType = sessions?.find(
    (s) => s.sessionId === activeSessionId,
  )?.templateType
  const approvalQueue = state.snapshot?.approvalQueue ?? []
  const queuedPlanConfirm = useMemo(
    () => approvalQueue.find(entry => entry.toolName === 'ExitPlanMode'),
    [approvalQueue],
  )
  // Model-invoked EnterPlanMode ask ("Enter plan mode?") — its own footer
  // control (EnterPlanModeFooterControl), not the generic amber permission ask.
  const queuedEnterPlanConfirm = useMemo(
    () => approvalQueue.find(entry => entry.toolName === 'EnterPlanMode'),
    [approvalQueue],
  )
  const queuedPermissionConfirm = useMemo(
    () =>
      approvalQueue.find(
        entry =>
          entry.toolName !== 'ExitPlanMode' &&
          entry.toolName !== 'EnterPlanMode',
      ),
    [approvalQueue],
  )

  // Drives the composer's project-folder chip (all session types on a
  // picker-capable host). The chip gates itself on `canPick`, so this is
  // provided whenever a snapshot + active session exist. `locked` mirrors the
  // worker-side rebind guard: once the session has messages the folder is fixed.
  const projectFolderControls = useMemo<ProjectFolderControls | null>(() => {
    const snapshot = state.snapshot
    if (!snapshot || !activeSessionId) return null
    return {
      templateType: activeTemplateType ?? '',
      canPick: snapshot.canPickProjectFolder === true,
      projectRoot: snapshot.projectRoot,
      branch: snapshot.projectBranch,
      needsProjectFolder: snapshot.needsProjectFolder === true,
      locked: snapshot.messageCount > 0,
      onSelectFolder: (path: string) =>
        onSelectProjectFolder?.(activeSessionId, path),
      onOpenFolder: () => onOpenProjectFolder?.(activeSessionId),
      onRevealFolder: (path: string) => onRevealProjectFolder?.(path),
    }
  }, [
    state.snapshot,
    activeSessionId,
    activeTemplateType,
    onSelectProjectFolder,
    onOpenProjectFolder,
    onRevealProjectFolder,
  ])

  // Per-session plan-approval state + actions for the footer plan control
  // (replaces the old top banner). The loop HALTS on the first ExitPlanMode, so
  // there is at most one entry — render the first. `resolve` clears the approval
  // first (instant dismiss) then approves / keeps planning.
  const planPanelValue = useMemo<PlanPanelContextValue>(() => {
    if (queuedPlanConfirm) {
      const pending = {
        toolCallId: queuedPlanConfirm.approvalCallId,
        request: {
          toolName: queuedPlanConfirm.toolName,
          planText:
            typeof queuedPlanConfirm.permissionResult.planText === 'string'
              ? queuedPlanConfirm.permissionResult.planText
              : '',
          planFilePath:
            typeof queuedPlanConfirm.permissionResult.planFilePath === 'string'
              ? queuedPlanConfirm.permissionResult.planFilePath
              : '',
          restoreMode: queuedPlanConfirm.permissionResult.restoreMode ?? 'default',
        },
      }
      return {
        pending,
        openPanel: onOpenPlanPanel,
        resolve: (decision, feedback) =>
          resolveToolUseConfirm?.({
            approvalCallId: queuedPlanConfirm.approvalCallId,
            behavior: decision === 'approve' ? 'allow' : 'reject',
            updatedInput:
              decision === 'approve' ? queuedPlanConfirm.input : undefined,
            feedback,
          }),
      }
    }
    const entries = state.snapshot?.pendingPlanApproval
      ? Object.entries(state.snapshot.pendingPlanApproval)
      : []
    const first = entries[0]
    const pending = first
      ? { toolCallId: first[0], request: first[1] }
      : null
    return {
      pending,
      openPanel: onOpenPlanPanel,
      resolve: pending
        ? (decision, feedback) =>
            resolvePlanApproval(
              decision,
              pending.toolCallId,
              pending.request,
              { clearPlanApproval, setPermissionMode, submitToolResult },
              feedback,
            )
        : undefined,
    }
  }, [
    queuedPlanConfirm,
    state.snapshot?.pendingPlanApproval,
    onOpenPlanPanel,
    resolveToolUseConfirm,
    clearPlanApproval,
    setPermissionMode,
    submitToolResult,
  ])

  // Pending model-invoked EnterPlanMode ask for THIS session ("Enter plan
  // mode?"). Approve resolves the
  // suspended tool call with allow (call() then flips the mode); reject sends
  // the model a declined tool result. The dialog has no feedback field.
  const enterPlanApprovalValue = useMemo<EnterPlanApprovalContextValue>(() => {
    if (!queuedEnterPlanConfirm) return { pending: null }
    return {
      pending: { toolCallId: queuedEnterPlanConfirm.approvalCallId },
      resolve: decision =>
        resolveToolUseConfirm?.({
          approvalCallId: queuedEnterPlanConfirm.approvalCallId,
          behavior: decision === 'approve' ? 'allow' : 'reject',
          updatedInput:
            decision === 'approve' ? queuedEnterPlanConfirm.input : undefined,
        }),
    }
  }, [queuedEnterPlanConfirm, resolveToolUseConfirm])

  // Pending permission ASK (Allow/Deny/Always) for THIS session, surfaced in
  // the composer footer (PermissionAskFooterControl) instead of a top banner.
  // Resolve logic mirrors the former PermissionBanner: Deny → error result;
  // Allow-once/always → add the allow rule (always also persists) + a "granted,
  // retry" result; Allow-folder → add the directory via RuleEdit.
  const permissionAskValue = useMemo<PermissionAskContextValue>(() => {
    if (queuedPermissionConfirm) {
      const suggestedRule =
        queuedPermissionConfirm.permissionResult.suggestedRule ??
        queuedPermissionConfirm.toolName
      const request = {
        toolName: queuedPermissionConfirm.toolName,
        summary:
          queuedPermissionConfirm.permissionResult.summary ??
          queuedPermissionConfirm.permissionResult.message,
        suggestedRule,
        reason: queuedPermissionConfirm.permissionResult.reason,
        directory: queuedPermissionConfirm.permissionResult.directory,
      }
      const canAllowFolder =
        request.reason === 'outside-workspace' && Boolean(request.directory)
      return {
        pending: {
          toolCallId: queuedPermissionConfirm.approvalCallId,
          request,
        },
        canAllowFolder,
        resolve: async (decision, feedback) => {
          const ruleEdits: RuleEdit[] = []
          if (decision === 'allow-folder' && request.directory) {
            ruleEdits.push({
              type: 'addDirectories',
              directories: [request.directory],
              destination: 'localSettings',
            })
          } else if (decision === 'allow-always') {
            ruleEdits.push({
              type: 'addRules',
              behavior: 'allow',
              rules: [suggestedRule],
              destination: 'localSettings',
            })
          }
          await resolveToolUseConfirm?.({
            approvalCallId: queuedPermissionConfirm.approvalCallId,
            behavior: decision === 'deny' ? 'reject' : 'allow',
            updatedInput:
              decision === 'deny' ? undefined : queuedPermissionConfirm.input,
            feedback:
              decision === 'deny'
                ? (feedback ?? 'Permission denied by the user. Do not retry this call.')
                : feedback,
            ruleEdits:
              ruleEdits.length > 0 ? ruleEdits : undefined,
          })
        },
      }
    }
    // No `pendingPermissions` branch: real asks resolve via `queuedPermissionConfirm` above;
    // an allow-and-retry would re-match the ask rule and re-prompt.
    return { pending: null }
  }, [queuedPermissionConfirm, resolveToolUseConfirm])

  const snapshotRef = useRef(state.snapshot)
  snapshotRef.current = state.snapshot
  // `isRuntimeBusy` as of the last render, for `onNew` (declared above it).
  const runtimeBusyRef = useRef(false)

  // --- Lock-to-bottom controller -------------------------------------------
  // Nexus owns auto-scroll (thread.tsx disables assistant-ui's). Per mounted session, starts
  // ON: sending or scrolling to the bottom locks, scrolling elsewhere unlocks; while locked,
  // new content is pinned before paint. First foreground entry snaps to the bottom.
  const lockToBottomRef = useRef(true)
  const hasEnteredForegroundRef = useRef(false)
  // Mirror of isForegroundSession for the render-independent observer/scroll
  // callbacks below — a hidden session must never scroll itself.
  const isForegroundRef = useRef(false)
  // Root of THIS thread's pane. Viewport lookups scope to this subtree rather
  // than `document.querySelector` — during a switch BACK to an already-mounted
  // session, MultiSessionShell reorders `mountedSessionIds` one commit late, so
  // the visible session isn't the first viewport in document order for a beat.
  const threadRootRef = useRef<HTMLDivElement | null>(null)
  const findViewport = useCallback(
    (): HTMLElement | null => {
      return findConversationViewport(threadRootRef.current ?? document)
    },
    [],
  )
  // --------------------------------------------------------------------------

  // Per-model image-input capability for the ACTIVE selection, resolved
  // from the curated catalog (engine/contextWindow.ts). Kept in a ref so the
  // once-constructed attachment adapter always probes the LATEST value —
  // the selection changes underneath it (model picker, session switch)
  // without the adapter being rebuilt.
  const supportsImageInput = getSupportsImageInputForModel(
    state.snapshot?.currentSelection?.modelId ?? state.snapshot?.activeModelId,
    state.snapshot?.currentSelection?.providerId,
  )
  const supportsImageInputRef = useRef(supportsImageInput)
  supportsImageInputRef.current = supportsImageInput
  const composerModelCapabilities = useMemo(
    () => ({ supportsImageInput }),
    [supportsImageInput],
  )

  // The composer's effort control: this session's model and effort, applied
  // to this session only. A teammate shows it inert — it keeps the effort its
  // lead started it on (the page refuses the change anyway,
  // useMultiSessionClients.setModelSelectionForSession).
  const effortSessionId = state.snapshot?.sessionId
  const effortTeammate = !!effortSessionId && isTeammateSessionId(effortSessionId)
  const sessionEffort = useMemo<SessionEffortContextValue | null>(
    () =>
      onSelectSessionModel && effortSessionId
        ? {
            catalog: configuredCatalog,
            selection: state.snapshot?.currentSelection,
            disabled: effortTeammate,
            inertWhy: effortTeammate
              ? t('composerEffort.teammateLocked')
              : undefined,
            onSelect: selection =>
              onSelectSessionModel(effortSessionId, selection),
          }
        : null,
    [
      onSelectSessionModel,
      effortSessionId,
      configuredCatalog,
      state.snapshot?.currentSelection,
      effortTeammate,
      t,
    ],
  )

  const attachmentAdapter = useMemo(
    () =>
      new BrowserComposerAttachmentAdapter({
        supportsImageInput: () => supportsImageInputRef.current,
      }),
    [],
  )

  // Native-picker half of the same per-model image gate. The built-in
  // `<input>` path already flips its `accept` via the adapter; the host
  // picker is a separate round-trip, so it gets the live capability injected
  // here at click time — the same ref-mirror trick the adapter uses, so a
  // model switch takes effect without rebuilding the callback.
  const pickAttachmentFilesWithCapability = useMemo(
    () =>
      onPickAttachmentFiles
        ? () =>
            onPickAttachmentFiles({ allowImages: supportsImageInputRef.current })
        : undefined,
    [onPickAttachmentFiles],
  )

  // Drafts persist per session: MultiSessionShell keeps the last 3 thread trees mounted, so
  // each composer DOM survives `display: none`. A session evicted from the LRU loses its draft.

  // How the next composer send is delivered while the agent runs (set by the
  // composer right before `composer.send()`, which takes no arguments).
  const nextDeliveryRef = useRef<ComposerDelivery | undefined>(undefined)
  const composerDelivery = useMemo(
    () => ({
      setNextDelivery: (delivery: ComposerDelivery) => {
        nextDeliveryRef.current = delivery
      },
    }),
    [],
  )

  const onNew = useCallback(
    async (message: AppendMessage) => {
      const delivery = nextDeliveryRef.current
      nextDeliveryRef.current = undefined
      if (readOnly) return
      const decision = resolveComposerSendGate({
        snapshot: snapshotRef.current,
        activeSessionId,
        canAdoptDefault: onAdoptDefaultSelection != null,
      })
      if (decision.kind !== 'send') {
        // `composer.send()` has ALREADY cleared the composer by the time we
        // run, so EVERY refusal has to hand the text back or the user's draft
        // is silently destroyed. Restoring here — once, for every non-send
        // outcome — is what makes that structural instead of something each
        // new branch has to remember. (`provider-missing` is the exception:
        // its dialog owns the restore and puts the text back on close, so
        // restoring here too would clobber anything typed while it was open.)
        if (decision.kind === 'provider-missing') {
          setProviderPrompt(extractTextFromAppendMessage(message))
          return
        }
        setRestoreComposerText(extractTextFromAppendMessage(message))
        if (decision.kind === 'adopt-default') {
          onAdoptDefaultSelection?.(decision.selection)
        }
        return
      }

      // Ctrl/Cmd+Alt+Enter: the message goes into a forked copy of this
      // session, not into this one. Nothing to fork (an empty session) → it
      // is an ordinary send (`inject` is ignored while idle) — unless the
      // first turn is still running, when it would land in THAT turn
      // (`resolveForkSendPlan`): hand the text back instead.
      if (delivery === 'fork') {
        const plan = resolveForkSendPlan(
          state.transcriptMessages,
          runtimeBusyRef.current,
        )
        if (plan.kind === 'refuse') {
          setRestoreComposerText(extractTextFromAppendMessage(message))
          return
        }
        if (plan.kind === 'fork' && onSendInForkedSession) {
          const forked = await onSendInForkedSession(plan.cutUuid, message)
          if (!forked) {
            setRestoreComposerText(extractTextFromAppendMessage(message))
          }
          return
        }
      }
      const submitDelivery: SubmitDelivery | undefined =
        delivery === 'fork' ? 'inject' : delivery

      engageConversationLockToBottom(lockToBottomRef, findViewport())
      if (submitComposerMessage) {
        await submitComposerMessage(
          message,
          submitDelivery ? { delivery: submitDelivery } : undefined,
        )
        return
      }

      const prompt = extractTextFromAppendMessage(message).trim()
      if (!prompt) return
      await submitPrompt(prompt)
    },
    [
      submitComposerMessage,
      submitPrompt,
      onAdoptDefaultSelection,
      activeSessionId,
      onSendInForkedSession,
      state.transcriptMessages,
    ],
  )

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
  const showLoadingSkeleton = shouldShowLoadingSkeleton(state, messages.length)

  // No-hydratable-body terminal state: when no `AssistantMessageBody` will mount in a
  // delivered transcript, emit `nexus:assistantMessageBody:firstHydrated` here, or the boot
  // overlay never dismisses (P-2).
  const noHydratableBodySettledRef = useRef(false)
  useEffect(() => {
    if (noHydratableBodySettledRef.current) return
    if (state.snapshot == null || state.snapshot.messageCount <= 0) return
    const transcriptFullyDelivered =
      state.transcriptMessages.length >= state.snapshot.messageCount
    if (!transcriptFullyDelivered) return
    if (transcriptWillHydrateAssistantBody(messages)) return
    noHydratableBodySettledRef.current = true
    try {
      globalThis.dispatchEvent(
        new CustomEvent('nexus:assistantMessageBody:firstHydrated'),
      )
    } catch {
      // CustomEvent unavailable — the WebUI fallback timer still dismisses.
    }
  }, [state.snapshot, state.transcriptMessages.length, messages])
  const shouldLoadGenerativeToolUIs = useMemo(
    () => hasGenerativeToolParts(messages),
    [messages],
  )
  const shouldLoadA2uiSurfaces = useMemo(
    () => hasA2uiToolCall(state.transcriptMessages),
    [state.transcriptMessages],
  )
  const conversationTitle = useMemo(() => getConversationTitle(state), [state])
  const sessionId = state.snapshot?.sessionId ?? 'pending'
  // Handle for the conversation's Agent tool cards to open the global Background
  // Tasks drawer (the "jump to background task" affordance), provided via
  // BackgroundTasksContext. Memoized so the context value is referentially
  // stable across renders.
  const backgroundTasksValue = useMemo(
    () => ({
      openTasksDrawer: onOpenBackgroundTasks,
      runningTaskCount: runningBackgroundTaskCount,
      taskRows: backgroundTaskRows,
      stopTask: onStopBackgroundTask,
      openTasksList: onOpenBackgroundTasksList,
    }),
    [
      onOpenBackgroundTasks,
      runningBackgroundTaskCount,
      backgroundTaskRows,
      onStopBackgroundTask,
      onOpenBackgroundTasksList,
    ],
  )
  // Every snapshot is a new object; the Connectors card re-renders only when
  // the list itself changes.
  const sessionConnectorsKey = JSON.stringify(state.snapshot?.mcpServers ?? [])
  const sessionFolder = state.snapshot?.cwd ?? state.snapshot?.projectRoot
  const openMcpSettings = useMemo(
    () =>
      openSettings
        ? () => {
            void openSettings('mcp').catch((error: unknown) => {
              console.error('Failed to open MCP settings:', error)
            })
          }
        : undefined,
    [openSettings],
  )
  const sessionConnectors = useMemo(
    () => ({
      servers: JSON.parse(sessionConnectorsKey) as SessionMcpServerView[],
      ...(sessionFolder ? { folder: sessionFolder } : {}),
      ...(openMcpSettings ? { openMcpSettings } : {}),
    }),
    [sessionConnectorsKey, sessionFolder, openMcpSettings],
  )
  // Handle for the conversation's Read/Edit tool cards to open a file or diff in
  // the global Right Panel (Files / Diff views), provided via
  // RightPanelContentContext. Memoized for referential stability.
  // WorkspaceDiff card title → the Diff view. With a path: resolve that
  // file's whole-session snapshot diff (sentinel turn 0 — served by the
  // worker for fileSnapshots sessions) and open it as a `file` target; a
  // path-less call, an unresolvable path, or a load failure all land on the
  // turn-history tab — never a dead click.
  const onOpenWorkspaceDiff = useMemo(() => {
    if (!onOpenDiffInPanel) return undefined
    return (path?: string) => {
      void (async () => {
        if (path && path.trim() && loadTurnDiffDetail) {
          try {
            const files = await loadTurnDiffDetail(0)
            const match = findWorkspaceDiffFile(files, path)
            if (match) {
              onOpenDiffInPanel({
                kind: 'file',
                filePath: match.filePath,
                hunks: match.hunks,
                plusLines: match.plusLines,
                minusLines: match.minusLines,
              })
              return
            }
          } catch {
            // fall through to the turn-history tab
          }
        }
        onOpenDiffInPanel({ kind: 'turnHistory' })
      })()
    }
  }, [onOpenDiffInPanel, loadTurnDiffDetail])

  const rightPanelContentValue = useMemo(
    () => ({
      openFile: onOpenFileInPanel,
      openDiff: onOpenDiffInPanel,
      openSkill: onOpenSkillInPanel,
      openWorkspaceDiff: onOpenWorkspaceDiff,
    }),
    [onOpenFileInPanel, onOpenDiffInPanel, onOpenSkillInPanel, onOpenWorkspaceDiff],
  )
  // Auto-detected file paths in the transcript: the project root is the ONE
  // base a relative mention is resolved against (no searching), and the probe
  // is the batched existence check that decides whether a path becomes an
  // openable `>>` affordance. One probe per host `statPaths` function, so its
  // cache is shared by every message in this thread.
  const filePathProbe = useMemo(
    () => (statFilePaths ? createFilePathProbe(statFilePaths) : undefined),
    [statFilePaths],
  )
  const filePathContextValue = useMemo(
    () => ({ projectRoot: state.snapshot?.projectRoot, probe: filePathProbe }),
    [state.snapshot?.projectRoot, filePathProbe],
  )
  const handleComposerEdit = useCallback(
    (composerDraft: string, editedAt: number) => {
      if (!sessionId || sessionId === 'pending') return
      onComposerEdit?.(sessionId, composerDraft, editedAt)
    },
    [sessionId, onComposerEdit],
  )
  const currentSelection = state.snapshot?.currentSelection
  // The active provider's usage / credit balance, from the runtime's
  // `providers/usage` table. Re-read after every finished turn (the key
  // changes when a turn lands; the runtime throttles to once a minute).
  const usageProviderId = currentSelection?.providerId ?? state.snapshot?.currentProviderId
  const providerUsage = useProviderUsage(
    usageProviderId,
    state.status === 'submitting' ? 'busy' : state.transcriptMessages.length,
  )
  // Whether the active model is a free one — the ring's limit-reached warning
  // counts only the limits that meter it (OpenRouter: free-request quota).
  // The same configured row the model picker and the effort control read.
  const activeModelFree = findActiveModel(configuredCatalog, currentSelection)
    ?.model.free

  // Permission-mode picker wiring. This thread is the foreground session when
  // its snapshot sessionId matches the shell's activeSessionId (the picker
  // only binds the Shift+Ctrl+M shortcut for the foreground thread). Falls
  // back to active when no activeSessionId is provided (single-session embeds).
  const rawPermissionMode = state.snapshot?.currentPermissionMode ?? 'default'
  const hasPendingPlanApproval = Boolean(
    queuedPlanConfirm ||
      (state.snapshot?.pendingPlanApproval &&
        Object.keys(state.snapshot.pendingPlanApproval).length > 0),
  )
  const permissionMode = hasPendingPlanApproval ? 'plan' : rawPermissionMode
  const isForegroundSession =
    activeSessionId == null || state.snapshot?.sessionId === activeSessionId

  // First foreground entry of a mounted thread locks to the bottom. Later
  // switch-backs keep the session's existing lock state: locked sessions re-pin
  // in <Thread>, unlocked sessions preserve their scrollTop.
  useLayoutEffect(() => {
    engageConversationLockOnFirstForeground({
      isForeground: isForegroundSession,
      hasEnteredForegroundRef,
      isForegroundRef,
      lockRef: lockToBottomRef,
      viewport: findViewport(),
    })
  }, [isForegroundSession, findViewport])

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
    void (servedByPart
      ? revealRowForPart(root, index)
      : revealThreadMessage(root, index, jump.lineOrdinal, jump.term)
    ).then(revealed => {
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

  // Bypass-Permissions warning gate (F-13). A switch INTO bypassPermissions
  // is intercepted before it applies; `bypassPending` holds the prior mode to
  // restore on cancel (null for a live switch — it was never applied; 'default'
  // for the startup case below — it WAS applied at boot).
  const skipDangerousFlag =
    state.snapshot?.skipDangerousModePermissionPrompt === true
  const [bypassPending, setBypassPending] = useState<
    { revertTo: string | null } | null
  >(null)
  const handleSetPermissionMode = useCallback(
    (mode: string) => {
      if (
        shouldGateBypassSwitch({
          next: mode,
          current: permissionMode,
          skipFlag: skipDangerousFlag,
        })
      ) {
        setBypassPending({ revertTo: null }) // not applied yet; cancel = no-op
        return
      }
      void setPermissionMode?.(mode)
    },
    [setPermissionMode, permissionMode, skipDangerousFlag],
  )

  // Startup gate — the primary trigger: a session that boots already in
  // bypassPermissions without a prior acknowledgment shows the warning once.
  // Unlike a live switch, the mode was already applied, so cancel reverts to
  // `default`. Guarded per-session (module Set) so it fires at most once per
  // session even across LRU mount/unmount churn.
  const snapshotSessionId = state.snapshot?.sessionId
  useEffect(() => {
    if (!isForegroundSession || !snapshotSessionId) return
    if (startupBypassGatedSessions.has(snapshotSessionId)) return
    if (permissionMode === 'bypassPermissions' && !skipDangerousFlag) {
      startupBypassGatedSessions.add(snapshotSessionId)
      setBypassPending({ revertTo: 'default' })
    }
  }, [isForegroundSession, snapshotSessionId, permissionMode, skipDangerousFlag])

  // Isolate the dialog per session: a thread leaving the foreground with a
  // warning pending must not re-show it on switch-back (the accept/cancel
  // handlers only run on interaction with the now-unmounted dialog).
  useEffect(() => {
    if (!isForegroundSession) setBypassPending(null)
  }, [isForegroundSession])

  const handleBypassAccept = useCallback(async () => {
    try {
      // Mark this session gated BEFORE any await: a stale `worker.state` can predate the
      // persisted skip flag and re-open the dialog. Accepting IS the ack.
      if (snapshotSessionId) startupBypassGatedSessions.add(snapshotSessionId)
      // Persist the acknowledgment FIRST so the snapshot's skip-flag is true
      // BEFORE bypass becomes the active mode. Apply the mode only for a live
      // switch (startup is already in bypass). Keep the dialog open if a step
      // throws (no silent success).
      await setSkipDangerousMode?.(true)
      if (permissionMode !== 'bypassPermissions') {
        await setPermissionMode?.('bypassPermissions')
      }
      setBypassPending(null)
    } catch (err) {
      console.error('[bypass] failed to apply bypassPermissions', err)
    }
  }, [setSkipDangerousMode, setPermissionMode, permissionMode, snapshotSessionId])

  const handleBypassCancel = useCallback(() => {
    const revertTo = bypassPending?.revertTo
    setBypassPending(null)
    if (revertTo) {
      void Promise.resolve(setPermissionMode?.(revertTo)).catch(err =>
        console.error('[bypass] failed to revert permission mode', err),
      )
    }
  }, [bypassPending, setPermissionMode])

  const isRuntimeBusy =
    state.status === 'submitting' ||
    state.snapshot?.isBusy === true ||
    approvalQueue.length > 0 ||
    // A pending prompt only counts as "busy" while a turn is actually live.
    // After a `worker.error` the prompt is intentionally retained (so the
    // failed turn's content stays visible), but the runtime is NOT busy —
    // counting it here would leave the composer stuck in the running state.
    (state.pendingPrompt !== null && state.status !== 'error')
  runtimeBusyRef.current = isRuntimeBusy

  const isStopping = state.snapshot?.isStopping === true

  // Wrap the bare `interrupt` so repeated stop-button clicks while an abort
  // is already in flight become a no-op. The worker also guards re-entrant
  // interrupts, but short-circuiting on the UI side avoids a postMessage
  // round-trip and keeps the button visually "stuck" instead of flashing.
  const handleCancel = useCallback(async () => {
    if (isStopping) {
      return
    }
    await interrupt()
  }, [interrupt, isStopping])

  // The composer's Stop button calls this DIRECTLY instead of going through
  // `ComposerPrimitive.Cancel` → `runtime.cancelRun()`, whose "cancel undoes
  // the last user message" contract contradicts ours (the worker keeps the
  // message and appends the interrupt marker) and refilled the composer with
  // the just-sent text. Full reasoning at `handleCancelClick` in thread.tsx.
  // `onCancel` on the runtime below stays wired: it is what `cancelRun` calls
  // into if any other assistant-ui path ever reaches it.
  const composerCancelState = useMemo(
    () => ({
      isStopping,
      onCancel: () => {
        void handleCancel()
      },
    }),
    [isStopping, handleCancel],
  )

  // Rows the virtualizer keeps get their content; the rest go to assistant-ui
  // as contentless stubs, so its per-part clients exist only for the window
  // (see `historyContentWindow.ts`). Everything above reads the full
  // `messages`; only the runtime sees the windowed list.
  const [wantedRows, setWantedRows] = useState<ReadonlySet<number> | null>(null)
  const publishWantedRows = useCallback((rows: readonly number[]) => {
    setWantedRows(current => mergeWantedRows(current, rows))
  }, [])
  const historyContentWindow = useMemo(
    () => ({ wanted: wantedRows, publish: publishWantedRows }),
    [wantedRows, publishWantedRows],
  )
  // Settings · Appearance "Show reasoning": hiding it drops the reasoning
  // parts from what assistant-ui renders — and only there, so the boot gates,
  // search jumps and copy above all still read the full `messages`.
  const showReasoning = useShowReasoning()
  const runtimeMessages = useMemo(
    () =>
      windowMessageContent(
        showReasoning ? messages : withoutReasoningParts(messages),
        wantedRows,
      ),
    [messages, wantedRows, showReasoning],
  )

  const runtime = useExternalStoreRuntime<ThreadMessageLike>({
    messages: runtimeMessages,
    convertMessage: message => message,
    isRunning: isRuntimeBusy,
    onNew,
    adapters: {
      attachments: attachmentAdapter,
    },
    onAddToolResult: async options => {
      await submitToolResult({
        toolCallId: options.toolCallId,
        toolName: options.toolName,
        result: options.result,
        isError: options.isError,
      })
    },
    onCancel: handleCancel,
  })

  // Inject messages handed back to the composer (their x, or Stop) bring the
  // files this page attached, not just their text: the worker returns text
  // only, which for an attachment-only send is the file names
  // (`InjectRestoreDraft`). Text goes back through Thread as before; the files
  // are re-attached to THIS thread's composer here.
  const reattachComposerFiles = useCallback(
    (files: readonly File[]) => {
      for (const file of files) {
        void runtime.thread.composer.addAttachment(file).catch(error => {
          console.warn('[inject] failed to re-attach a file to the composer', error)
        })
      }
    },
    [runtime],
  )
  const removeInjectMessageRestoringFiles = useMemo(
    () =>
      onRemoveInjectMessage
        ? async (uuid: string) => {
            const result = await onRemoveInjectMessage(uuid)
            if (result.ok && result.files?.length) {
              reattachComposerFiles(result.files)
            }
            return result
          }
        : undefined,
    [onRemoveInjectMessage, reattachComposerFiles],
  )
  useEffect(() => {
    const files = takeInjectRestoreFiles(state.injectRestore)
    if (files.length > 0) reattachComposerFiles(files)
  }, [state.injectRestore, reattachComposerFiles])

  const handleOpenSettings = useCallback(async () => {
    if (!openSettings) return

    setHeaderError(null)
    try {
      await openSettings('models')
    } catch (error) {
      console.error('Failed to open settings:', error)
      setHeaderError(
        error instanceof Error
          ? error.message
          : t('thread.openSettingsFailed'),
      )
    }
  }, [openSettings])

  const combinedHeaderError = headerError
    ? headerError.replace(/^UI_ERROR:\s*/i, '')
    : null

  const runtimeError = runtimeErrorText(state.lastError, t)
  const runtimeErrorMessage = runtimeError?.text ?? null

  const errorMessage = combinedHeaderError ?? runtimeErrorMessage
  // The raw `code: message` behind a catalog-worded runtime error; a header
  // error is already its own words.
  const errorDetail = combinedHeaderError ? null : runtimeError?.detail ?? null

  const errorKey = combinedHeaderError
    ? `header:${combinedHeaderError}`
    : runtimeErrorMessage
      ? `runtime:${runtimeErrorMessage}`
      : null

  // `BrowserRuntimeClient.continueConversation` submits a hidden `isMeta` continuation, never
  // a visible user turn. Absent ⇒ Continue stays hidden.
  const handleContinueConversation = continueConversation

  // Compute if conversation is resumable using helper from sessionStorage
  const isResumable = useMemo(() => {
    const snapshot = state.snapshot
    if (!snapshot) return false

    return isConversationResumable(
      snapshot.lastTerminalReason,
      state.transcriptMessages,
      state.status,
    )
  }, [state.snapshot?.lastTerminalReason, state.transcriptMessages, state.status])

  return (
    <ComposerDeliveryContext.Provider value={composerDelivery}>
    <AssistantRuntimeProvider runtime={runtime}>
      <HistoryContentWindowContext.Provider value={historyContentWindow}>
      <MessageActionsContext.Provider value={messageActionsValue}>
      <BackgroundTasksContext.Provider value={backgroundTasksValue}>
      <SessionConnectorsContext.Provider value={sessionConnectors}>
      <RightPanelContentContext.Provider value={rightPanelContentValue}>
      <FilePathContext.Provider value={filePathContextValue}>
      <ComposerDraftSync
        initialComposerDraft={initialComposerDraft}
        onComposerEdit={handleComposerEdit}
      />
      <ToolCallDetailProvider
        key={sessionId}
        loadToolCallDetail={loadToolCallDetail}
      >
        {shouldLoadGenerativeToolUIs && (
          <Suspense fallback={null}>
            <GenerativeToolUIs />
          </Suspense>
        )}
        <TooltipProvider>
          {/*
            Sidebar is rendered once at MultiSessionShell scope (sibling to
            all mounted thread sections); this component owns only the "right
            pane" — the thread body. The sidebar show/hide toggle lives in the
            topbar now (NexusTopBar), so there's no in-pane floating trigger.
          */}
          <div
            ref={threadRootRef}
            className="relative flex h-full w-full flex-col overflow-hidden"
          >
            {errorMessage && (
              // Center + cap to the conversation content width so the error
              // banner lines up with the messages and composer instead of
              // spanning the full pane. This banner renders ABOVE <Thread>,
              // where `--thread-max-width` isn't in scope, so the clamp is
              // inlined to mirror thread.tsx's value; `px-2` matches the
              // per-message gutter.
              <div className="mx-auto mt-3 w-full max-w-[clamp(44rem,60vw,70rem)] px-2">
                <div
                  key={errorKey}
                  className="rounded-lg border border-destructive/25 bg-destructive/10 px-4 py-3 text-sm text-destructive"
                  {...(errorDetail !== null ? { title: errorDetail } : {})}
                >
                  {errorMessage}
                </div>
              </div>
            )}
            {/* Permission ASK moved OUT of this top banner into the composer
                footer (PermissionAskFooterControl, via PermissionAskContext) —
                same place as the plan-approval control. */}
            {/* Bypass-Permissions warning (F-13). Foreground session only —
                MultiSessionShell mounts several threads at once, so gating on
                isForegroundSession prevents stacked modals. */}
            {isForegroundSession ? (
              <BypassPermissionsDialog
                open={bypassPending !== null}
                onAccept={handleBypassAccept}
                onCancel={handleBypassCancel}
              />
            ) : null}
            {/* Plan approval lives in the composer footer (PlanApprovalFooterControl) and the
                right-side PlanDetailsPanel. */}
            <div className="flex min-h-0 flex-1 flex-row overflow-hidden">
            <main className="relative min-w-0 flex-1 overflow-hidden">
              {/* Thread is static-imported, so no Suspense boundary is needed here. */}
              <TokenUsageProvider
                value={{
                  messages: state.transcriptMessages,
                  liveEvents: state.liveEvents,
                  modelId:
                    currentSelection?.modelId ?? state.snapshot?.activeModelId,
                  providerId: currentSelection?.providerId,
                  catalog: configuredCatalog,
                  isStreaming: state.status === 'submitting',
                  planUsage: providerUsage?.usage,
                  autoCompact: state.snapshot?.autoCompact,
                  onSetAutoCompactWindow:
                    onSetAutoCompactWindow && effortSessionId
                      ? value => onSetAutoCompactWindow(effortSessionId, value)
                      : undefined,
                  modelFree: activeModelFree,
                  onPlanUsageOpen: usageProviderId
                    ? () => getProviderUsageStore().refresh(usageProviderId)
                    : undefined,
                }}
              >
                <ComposerModelCapabilitiesProvider
                  value={composerModelCapabilities}
                >
                <SessionEffortProvider value={sessionEffort}>
                <ComposerCancelStateProvider value={composerCancelState}>
                {/* "A turn is in flight" straight off the runtime client — the
                    running indicator's gate. Union of the optimistic submit
                    status and the worker snapshot so it covers the moment
                    between send and the worker's first `worker.state`, and the
                    retry window (where the snapshot stays busy while
                    assistant-ui's message-derived isRunning is false). */}
                <SessionBusyProvider
                  value={
                    state.status === 'submitting' ||
                    state.snapshot?.isBusy === true
                  }
                >
                <SnapshotNeedsAnswerProvider value={snapshotNeedsAnswer(state.snapshot)}>
                <SnapshotBlocksComposerInputProvider
                  value={
                    readOnly || snapshotBlocksComposerInput(state.snapshot)
                  }
                >
                  <PermissionModeProvider
                    value={
                      setPermissionMode
                        ? {
                            mode: permissionMode,
                            isActive: isForegroundSession,
                            setMode: handleSetPermissionMode,
                            bypassDisabled:
                              state.snapshot?.bypassPermissionsModeDisabled ===
                              true,
                          }
                        : null
                    }
                  >
                  <ProjectFolderProvider value={projectFolderControls}>
                  <PlanPanelContext.Provider value={planPanelValue}>
                  <EnterPlanApprovalContext.Provider value={enterPlanApprovalValue}>
                  <PermissionAskContext.Provider value={permissionAskValue}>
                  <SlashCommandsProvider
                    value={state.snapshot?.commandNames ?? []}
                  >
                  <ModUiContext.Provider value={modUi}>
                  <SessionCardsPopoverContext.Provider value={sessionCardsPopover}>
                  <SessionChangeFiguresContext.Provider value={state.sessionChangeFigures ?? null}>
                  <ComposerAttachmentPickerProvider
                    value={
                      // Only the real chromium host implements the native picker (`canPickProjectFolder`);
                      // elsewhere the paperclip uses assistant-ui's `<input>`. The wrapper carries the active
                      // model's image capability.
                      state.snapshot?.canPickProjectFolder === true
                        ? pickAttachmentFilesWithCapability ?? null
                        : null
                    }
                  >
                    {shouldLoadA2uiSurfaces ? (
                      // Wrap the conversation with the shared A2UI runtime so the
                      // inline a2ui_* tool UIs (rendered inside <Thread/>) can draw
                      // the live surface + the maximize overlay can cover this pane.
                      // fallback keeps <Thread/> visible during the lazy chunk load.
                      <Suspense fallback={
                        <ContinueConversationProvider value={{ onContinueConversation: handleContinueConversation }}>
                        <IsResumableProvider value={isResumable}>
                        <LastTerminalReasonProvider value={state.snapshot?.lastTerminalReason}>
                          <Thread templateType={activeTemplateType} sessionId={sessionId} isForeground={isForegroundSession} lockToBottomRef={lockToBottomRef} turnDiffHistory={state.turnDiffHistory} onPendingQuestionsChange={onPendingQuestionsChange} pendingMessage={state.pendingMessage} pendingMessageEntries={state.pendingMessageEntries} onClearPendingMessage={onClearPendingMessage} injectRestore={state.injectRestore} onRemoveInjectMessage={removeInjectMessageRestoringFiles} />
                        </LastTerminalReasonProvider>
                        </IsResumableProvider>
                        </ContinueConversationProvider>
                      }>
                        <A2uiProviderHost
                          messages={state.transcriptMessages}
                          submitActionMessage={submitActionMessage}
                          busy={state.status === 'submitting'}
                        >
                          <ContinueConversationProvider value={{ onContinueConversation: handleContinueConversation }}>
                          <IsResumableProvider value={isResumable}>
                          <LastTerminalReasonProvider value={state.snapshot?.lastTerminalReason}>
                            <Thread templateType={activeTemplateType} sessionId={sessionId} isForeground={isForegroundSession} lockToBottomRef={lockToBottomRef} turnDiffHistory={state.turnDiffHistory} onPendingQuestionsChange={onPendingQuestionsChange} pendingMessage={state.pendingMessage} pendingMessageEntries={state.pendingMessageEntries} onClearPendingMessage={onClearPendingMessage} injectRestore={state.injectRestore} onRemoveInjectMessage={removeInjectMessageRestoringFiles} />
                          </LastTerminalReasonProvider>
                          </IsResumableProvider>
                          </ContinueConversationProvider>
                        </A2uiProviderHost>
                      </Suspense>
                    ) : (
                      <ContinueConversationProvider value={{ onContinueConversation: handleContinueConversation }}>
                      <IsResumableProvider value={isResumable}>
                      <LastTerminalReasonProvider value={state.snapshot?.lastTerminalReason}>
                        <Thread templateType={activeTemplateType} sessionId={sessionId} isForeground={isForegroundSession} lockToBottomRef={lockToBottomRef} turnDiffHistory={state.turnDiffHistory} onPendingQuestionsChange={onPendingQuestionsChange} pendingMessage={state.pendingMessage} pendingMessageEntries={state.pendingMessageEntries} onClearPendingMessage={onClearPendingMessage} injectRestore={state.injectRestore} onRemoveInjectMessage={removeInjectMessageRestoringFiles} />
                      </LastTerminalReasonProvider>
                      </IsResumableProvider>
                      </ContinueConversationProvider>
                    )}
                  </ComposerAttachmentPickerProvider>
                  </SessionChangeFiguresContext.Provider>
                  </SessionCardsPopoverContext.Provider>
                  </ModUiContext.Provider>
                  </SlashCommandsProvider>
                  </PermissionAskContext.Provider>
                  </EnterPlanApprovalContext.Provider>
                  </PlanPanelContext.Provider>
                  </ProjectFolderProvider>
                  </PermissionModeProvider>
                </SnapshotBlocksComposerInputProvider>
                </SnapshotNeedsAnswerProvider>
                </SessionBusyProvider>
</ComposerCancelStateProvider>
                </SessionEffortProvider>
                </ComposerModelCapabilitiesProvider>
              </TokenUsageProvider>
            </main>
            </div>
            {/*
              Loading overlay: while s.thread.isEmpty AND shouldShowLoadingSkeleton, which is false for
              an empty new thread and for a delivered transcript with no renderable messages.
            */}
            {showLoadingSkeleton && (
              <AuiIf condition={(s) => s.thread.isEmpty}>
                <div
                  className="absolute inset-0 z-30 flex flex-col bg-background"
                  style={{
                    ["--thread-max-width" as string]: "44rem",
                  }}
                >
                  <ThreadWelcome />
                </div>
              </AuiIf>
            )}
          </div>
          {providerPrompt !== null && (
            <ProviderMissingDialog
              pendingText={providerPrompt}
              resources={providerPromptResources}
              onClose={() => setProviderPrompt(null)}
              onOpenSettings={openSettings ? handleOpenSettings : undefined}
            />
          )}
          {restoreComposerText !== null && (
            <ComposerTextRestore
              text={restoreComposerText}
              onDone={clearRestoreComposerText}
            />
          )}
          {state.snapshot?.needsProjectFolder &&
            state.snapshot.messageCount === 0 &&
            activeSessionId &&
            onOpenProjectFolder && (
              // Offers the folders the runtime already knows, which any scope
              // may bind (`runtimeHub/knownProjects.ts`) — the only way out for
              // a client that may not open the desktop's picker.
              <WorkspaceProjectFolderDialog
                onOpenFolder={() => onOpenProjectFolder(activeSessionId)}
                onSelectFolder={
                  onSelectProjectFolder
                    ? path => onSelectProjectFolder(activeSessionId, path)
                    : undefined
                }
                onCancel={() => onDeleteThread?.(activeSessionId)}
              />
            )}
        </TooltipProvider>
      </ToolCallDetailProvider>
      </FilePathContext.Provider>
      </RightPanelContentContext.Provider>
      </SessionConnectorsContext.Provider>
      </BackgroundTasksContext.Provider>
      </MessageActionsContext.Provider>
      </HistoryContentWindowContext.Provider>
    </AssistantRuntimeProvider>
    </ComposerDeliveryContext.Provider>
  )
}

// Re-exported to keep this module's public surface unchanged after the
// component split; `Sidebar` and `SessionListItem` now live in ./Sidebar.
export { Sidebar, SessionListBody, type SessionListItem } from './Sidebar'
