import { ModUiContext } from '../../components/assistant-ui/mod-ui-context'
import {
  AgentChangesContext,
  SessionCardsPopoverContext,
  SessionChangeFiguresContext,
} from '../../components/assistant-ui/session-card-stack'
import { useSessionModUi } from './mods/useSessionModUi'
import { useSessionProposals } from './proposalsView'
import { CodeReviewProvider } from '@/components/assistant-ui/code-review-card'
import { useSessionChapters } from './chaptersView'
import {
  chapterEntriesOf,
  chapterTargetFor,
  entryKeyOfRow,
  resolveChapterAnchor,
  type ChapterAnchor,
} from './chapterAnchors'
import {
  ChapterMarksProvider,
  type ChapterMarksValue,
  type ChapterPlace,
} from '../../components/assistant-ui/chapter-marks'
import { SessionProposalsContext } from '../../components/assistant-ui/session-proposals-context'
import { useCan } from './useCan'
import type {
  ThreadMessageLike,
} from '@assistant-ui/react'
import {
  ComposerDeliveryContext,
  takeInjectRestoreFiles,
  type ComposerDelivery,
} from '../../components/assistant-ui/inject-message-context'
import { resolveAfterResponseCut } from './messageContextMenuModel'
import { ComposerPassagesProvider } from '@/components/assistant-ui/composer-passages'
import {
  HistoryContentWindowContext,
  mergeWantedRows,
  windowMessageContent,
} from './historyContentWindow'
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
import type { NexusAgentChangeSection } from '../bridge/protocol/ui'
import {
  deriveSessionMetadataFromMessages,
  isConversationResumable,
  resolvePromptCutForToolCall,
} from '../../sessions/sessionStore'
import type { ContinueInCodeFolder } from './sessionMessageCallbacks'
import { BrowserComposerAttachmentAdapter } from './BrowserComposerAttachmentAdapter'
import { getSupportsImageInputForModel } from '../../engine/contextWindow'
import {
  ComposerAttachmentPickerProvider,
  ComposerModelCapabilitiesProvider,
} from '@/components/assistant-ui/attachment'
import {
  BypassPermissionsDialog,
} from './BypassPermissionsDialog'
import { BackgroundTasksContext } from '@/components/assistant-ui/background-tasks-context'
import { SessionConnectorsContext } from '@/components/assistant-ui/session-connectors-context'
import { SessionBusyProvider } from '@/components/assistant-ui/session-busy-context'
import {
  RightPanelContentContext,
} from '@/components/assistant-ui/right-panel-content-context'
import { ShellCommandContext } from '@/components/assistant-ui/shell-command'
import {
  FilePathContext,
} from '@/components/assistant-ui/file-path-context'
import {
  PlanPanelContext,
} from '@/components/assistant-ui/plan-panel-context'
import {
  PermissionAskContext,
} from '@/components/assistant-ui/permission-ask-context'
import {
  EnterPlanApprovalContext,
} from '@/components/assistant-ui/enter-plan-approval-context'
import { snapshotNeedsAnswer, snapshotBlocksComposerInput } from '@/utils/sessionNeedsAnswer'
import type { BrowserRuntimeClientState } from './BrowserRuntimeClient'
import {
  PROVIDER_API_ERROR_RESUME_PROMPT,
  resolveProviderApiErrorRetryAction,
  shouldShowLoadingSkeleton,
  transcriptWillHydrateAssistantBody,
} from './assistantUiAdapter'
import {
  engageConversationLockOnFirstForeground,
  findConversationViewport,
} from './conversationScrollLock'
import {
  createConfiguredModelCatalog,
  isSelectionEnabled,
} from './modelCatalog'
import { sessionTimeBucket, sessionActivityTime } from './sessionTimeBucket'
import { useComposerDraftSync } from './useComposerDraftSync'
import { useProviderMissingPrompt } from './useProviderMissingPrompt'
import { useT } from './i18n'
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
  ArchivedSessionProvider,
  Thread,
  ThreadWelcome,
} from '@/components/assistant-ui/thread'
import { hasA2uiBlockInRecentRows, hasA2uiContent } from './a2ui/hasA2uiSurface'
import { useAppBoard } from './apps/appSurfaceView'
import {
  revealChapterRow,
} from './revealThreadMessage'
import { useShowReasoning, withoutReasoningParts } from './showReasoning'
import { ComposerDraftSync, ComposerTextInsert, ComposerTextRestore } from './ThreadComposerSync'
import { ProviderMissingDialog, WorkspaceProjectFolderDialog } from './ThreadDialogs'
import type { AssistantUiThreadProps } from './AssistantUiThreadProps'
import { runtimeErrorText } from './runtimeErrorText'
import { hasGenerativeToolParts } from './generativeToolParts'
import { useThreadApprovalContexts } from './useThreadApprovalContexts'
import { useComposerSubmit } from './useComposerSubmit'
import { useThreadTranscriptMessages } from './useThreadTranscriptMessages'
import { useThreadPanelContexts } from './useThreadPanelContexts'
import { usePendingMessageJumpReveal } from './usePendingMessageJumpReveal'
import { useBypassPermissionsGate } from './useBypassPermissionsGate'

export type { AssistantUiThreadProps } from './AssistantUiThreadProps'
export {
  COMPOSER_CATALOG_WAIT_MS,
  resolveComposerSendGate,
  resolveComposerSendGateOnceCatalogLoads,
  type ComposerSendGateDecision,
} from './composerSendGate'
export { runtimeErrorText } from './runtimeErrorText'
export { hasGenerativeToolParts } from './generativeToolParts'

/** One empty list, so a session without sub-agent changes keeps a stable value. */
const NO_AGENT_CHANGES: readonly NexusAgentChangeSection[] = []

function bootTracer() {
  return installSessionTracer({ context: 'ui' })
}

const GenerativeToolUIs = lazy(async () => {
  const module = await import('./GenerativeToolUIs')
  return { default: module.GenerativeToolUIs }
})

// A2UI surfaces render in the side pane; the a2ui_* tool UIs render a card in
// the conversation. This host wraps <Thread> with the shared A2UI runtime (one
// processor + the action loop + the pane portal) so the cards and the pane
// share it. The renderer + Material Symbols font live in this on-demand chunk;
// only the cheap `hasA2uiContent` detector stays resident, so conversations
// that never use A2UI never fetch this code.
const A2uiProviderHost = lazy(async () => {
  const module = await import('./a2ui/A2uiProviderHost')
  return { default: module.A2uiProviderHost }
})

export function getConversationTitle(state: BrowserRuntimeClientState): string {
  const metadata = deriveSessionMetadataFromMessages(
    state.transcriptMessages,
    null,
  )
  return metadata.firstPrompt || 'New Thread'
}

// --- Main component ---

// What a read-only thread gets for the callbacks it must not run. One shared
// function, not an inline literal: a fresh closure per render would change the
// identity of every hook in InteractiveAssistantUiThread that depends on it.
const readOnlyNoop = async (): Promise<void> => {}

export const AssistantUiThread = memo(function AssistantUiThread({
  state,
  readOnly = false,
  threadSessionId,
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
  onForkAfterMessage,
  onSendInForkedSession,
  onContinueInCode,
  onRewindToMessage,
  onStartSideChat,
  sessions,
  activeSessionId,
  onOpenBackgroundTasks,
  runningBackgroundTaskCount,
  backgroundTaskRows,
  onStopBackgroundTask,
  onOpenBackgroundTasksList,
  onOpenFileInPanel,
  onOpenTerminalInPanel,
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
  composerInsert,
  onComposerEdit,
  onPendingQuestionsChange,
  onUnarchive,
}: AssistantUiThreadProps) {
  return (
    <InteractiveAssistantUiThread
      state={state}
      readOnly={readOnly}
      onUnarchive={readOnly ? undefined : onUnarchive}
      threadSessionId={threadSessionId}
      submitPrompt={readOnly ? readOnlyNoop : submitPrompt}
      submitActionMessage={readOnly ? undefined : submitActionMessage}
      continueConversation={readOnly ? undefined : continueConversation}
      submitComposerMessage={readOnly ? undefined : submitComposerMessage}
      onPickAttachmentFiles={readOnly ? undefined : onPickAttachmentFiles}
      composerInsert={readOnly ? null : composerInsert}
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
      onForkAfterMessage={readOnly ? undefined : onForkAfterMessage}
      onSendInForkedSession={readOnly ? undefined : onSendInForkedSession}
      onContinueInCode={readOnly ? undefined : onContinueInCode}
      onRewindToMessage={readOnly ? undefined : onRewindToMessage}
      onStartSideChat={readOnly ? undefined : onStartSideChat}
      sessions={sessions}
      activeSessionId={activeSessionId}
      onOpenBackgroundTasks={onOpenBackgroundTasks}
      runningBackgroundTaskCount={runningBackgroundTaskCount}
      backgroundTaskRows={backgroundTaskRows}
      onStopBackgroundTask={readOnly ? undefined : onStopBackgroundTask}
      onOpenBackgroundTasksList={onOpenBackgroundTasksList}
      onOpenFileInPanel={onOpenFileInPanel}
      onOpenTerminalInPanel={onOpenTerminalInPanel}
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
  onUnarchive,
  threadSessionId,
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
  onForkAfterMessage,
  onSendInForkedSession,
  onContinueInCode,
  onRewindToMessage,
  onStartSideChat,
  sessions,
  activeSessionId,
  onOpenBackgroundTasks,
  runningBackgroundTaskCount,
  backgroundTaskRows,
  onStopBackgroundTask,
  onOpenBackgroundTasksList,
  onOpenFileInPanel,
  onOpenTerminalInPanel,
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
  composerInsert,
  onComposerEdit,
  onPendingQuestionsChange,
}: AssistantUiThreadProps) {
  const t = useT()
  // The mods' UI for THIS session (F-25): `mods/ui/<sessionId>`'s lines and
  // panes, who each plugin is (`mods/state`, for the card on its icon above
  // the prompt), and the icon's jump to the Plugins page.
  const canListMods = useCan('mods', 'list')
  const modSessionId = state.snapshot?.sessionId
  // The session's child-session proposal cards (F-36).
  const canAnswerProposals = useCan('proposals', 'start') && !readOnly
  const sessionProposals = useSessionProposals(runtimeConnection, modSessionId, canAnswerProposals)
  // The session's chapter marks (F-37); a read-only thread shows them too.
  const canMarkChapters = useCan('chapters', 'mark') && !readOnly
  const sessionChapters = useSessionChapters(
    runtimeConnection,
    modSessionId ?? threadSessionId,
    canMarkChapters,
  )
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
  // "Continue in Code": the offer card opens this folder chooser; a chosen
  // folder forks the chat at the prompt behind the offer. Offers taken in this
  // window fold their cards. (F-17)
  const [continueInCodeCall, setContinueInCodeCall] = useState<string | null>(null)
  const [continuedInCode, setContinuedInCode] = useState<ReadonlySet<string>>(() => new Set())
  const handleRequestContinueInCode = useCallback((toolCallId: string) => {
    setContinueInCodeCall(toolCallId)
  }, [])
  const finishContinueInCode = useCallback(
    async (folder: ContinueInCodeFolder) => {
      const toolCallId = continueInCodeCall
      if (!toolCallId || !onContinueInCode) return
      const cut = resolvePromptCutForToolCall(state.transcriptMessages, toolCallId)
      if (!cut) {
        setContinueInCodeCall(null)
        return
      }
      if (await onContinueInCode(cut, folder)) {
        setContinuedInCode(previous => new Set(previous).add(toolCallId))
        setContinueInCodeCall(null)
      }
    },
    [continueInCodeCall, onContinueInCode, state.transcriptMessages],
  )
  // The thread's rows, for a reply's fork cut; set once the rows are built below.
  const runtimeMessagesRef = useRef<readonly ThreadMessageLike[]>([])
  const transcriptMessagesRef = useRef(state.transcriptMessages)
  transcriptMessagesRef.current = state.transcriptMessages
  const resolveForkAfterResponse = useCallback((responseRowId: string) => {
    const rows = runtimeMessagesRef.current.flatMap(row => {
      if (typeof row.id !== 'string') return []
      const sourceType = (row.metadata as { custom?: { sourceType?: unknown } } | undefined)?.custom?.sourceType
      return [{ id: row.id, role: row.role, ...(typeof sourceType === 'string' ? { sourceType } : {}) }]
    })
    return resolveAfterResponseCut(rows, transcriptMessagesRef.current, responseRowId)
  }, [])
  const liveEventsRef = useRef(state.liveEvents)
  liveEventsRef.current = state.liveEvents
  const messageActionsValue = useMemo(
    () => ({
      onForkFromMessage: readOnly ? undefined : onForkFromMessage,
      resolveForkAfterResponse: readOnly || !onForkAfterMessage ? undefined : resolveForkAfterResponse,
      onForkAfterResponse: readOnly ? undefined : onForkAfterMessage,
      onRewindToMessage: readOnly || onUnarchive ? undefined : onRewindToMessage,
      onStartSideChat: readOnly ? undefined : onStartSideChat,
      onRetryProviderApiError: readOnly || onUnarchive ? undefined : handleRetryProviderApiError,
      onRequestContinueInCode:
        readOnly || !onContinueInCode ? undefined : handleRequestContinueInCode,
      continuedInCode,
    }),
    [
      readOnly,
      onUnarchive,
      onForkFromMessage,
      onForkAfterMessage,
      resolveForkAfterResponse,
      onRewindToMessage,
      handleRetryProviderApiError,
      onContinueInCode,
      handleRequestContinueInCode,
      continuedInCode,
    ],
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

  const {
    planPanelValue,
    enterPlanApprovalValue,
    permissionAskValue,
  } = useThreadApprovalContexts({
    state,
    queuedPlanConfirm,
    queuedEnterPlanConfirm,
    queuedPermissionConfirm,
    submitToolResult,
    setPermissionMode,
    resolveToolUseConfirm,
    clearPlanApproval,
    onOpenPlanPanel,
  })

  const snapshotRef = useRef(state.snapshot)
  snapshotRef.current = state.snapshot
  // Resolvers for `waitForSnapshot`, released by the next snapshot.
  const snapshotWaitersRef = useRef<Array<() => void>>([])
  useEffect(() => {
    const waiters = snapshotWaitersRef.current
    snapshotWaitersRef.current = []
    for (const release of waiters) release()
  }, [state.snapshot])
  const waitForSnapshot = useCallback(
    (ms: number) =>
      new Promise<void>(resolve => {
        const timer = setTimeout(release, ms)
        function release() {
          clearTimeout(timer)
          resolve()
        }
        snapshotWaitersRef.current.push(release)
      }),
    [],
  )
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
  // Chapter marks resolve against the rows and entries at the moment they are
  // read, so a streaming token does not rebuild the value. (F-37)
  const chapterMarksValue = useMemo<ChapterMarksValue>(() => {
    const entries = () =>
      chapterEntriesOf(transcriptMessagesRef.current, liveEventsRef.current)
    const rowOf = (rowId: string) =>
      runtimeMessagesRef.current.find(row => row.id === rowId)
    const placeOf = (anchor: ChapterAnchor): ChapterPlace =>
      anchor.kind !== 'row'
        ? { status: anchor.kind }
        : { status: 'ready', index: anchor.index, ...(anchor.ordinal === undefined ? {} : { ordinal: anchor.ordinal }) }
    const anchorsOf: ChapterMarksValue['anchorsOf'] = marks => {
      const loaded = entries()
      return marks.map(mark => placeOf(resolveChapterAnchor(runtimeMessagesRef.current, loaded, mark)))
    }
    return {
      marks: sessionChapters.marks,
      mark: sessionChapters.mark,
      unmark: sessionChapters.unmark,
      targetFor: (rowId, line) => chapterTargetFor(rowOf(rowId), line, entries()),
      entryKeyOf: rowId => entryKeyOfRow(rowOf(rowId), entries()),
      anchorsOf,
      reveal: async mark => {
        const root = threadRootRef.current
        const [place] = anchorsOf([mark])
        if (!root || place?.status !== 'ready') return false
        return revealChapterRow(root, place.index, place.ordinal)
      },
      revealStart: async () => {
        const root = threadRootRef.current
        if (!root || runtimeMessagesRef.current.length === 0) return false
        return revealChapterRow(root, 0)
      },
    }
  }, [sessionChapters])
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
  const {
    passageStore,
    onNew,
  } = useComposerSubmit({
    state,
    readOnly,
    activeSessionId,
    submitPrompt,
    submitComposerMessage,
    onSendInForkedSession,
    onAdoptDefaultSelection,
    snapshotRef,
    waitForSnapshot,
    runtimeBusyRef,
    lockToBottomRef,
    nextDeliveryRef,
    findViewport,
    setProviderPrompt,
    setRestoreComposerText,
  })

  const messages = useThreadTranscriptMessages({
    state,
    t,
  })
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
  // A block the model is writing loads the host too, so its surface draws as it
  // streams; once loaded the host stays for the session (it owns the surfaces).
  const a2uiLoadedRef = useRef<{ sessionId: string | undefined; loaded: boolean }>({ sessionId: undefined, loaded: false })
  if (a2uiLoadedRef.current.sessionId !== state.snapshot?.sessionId) {
    a2uiLoadedRef.current = { sessionId: state.snapshot?.sessionId, loaded: false }
  }
  const a2uiInTranscript = useMemo(
    () => hasA2uiContent(state.transcriptMessages),
    [state.transcriptMessages],
  )
  const appBoard = useAppBoard(runtimeConnection, state.snapshot?.sessionId, activeTemplateType)
  const shouldLoadA2uiSurfaces =
    a2uiLoadedRef.current.loaded ||
    appBoard !== undefined ||
    a2uiInTranscript ||
    hasA2uiBlockInRecentRows(messages as readonly { role?: unknown; content?: unknown }[])
  a2uiLoadedRef.current.loaded = shouldLoadA2uiSurfaces
  const conversationTitle = useMemo(() => getConversationTitle(state), [state])
  const sessionId = state.snapshot?.sessionId ?? 'pending'
  const {
    backgroundTasksValue,
    sessionConnectors,
    rightPanelContentValue,
    shellCommandValue,
    filePathContextValue,
  } = useThreadPanelContexts({
    state,
    readOnly,
    runtimeConnection,
    onOpenBackgroundTasks,
    runningBackgroundTaskCount,
    backgroundTaskRows,
    onStopBackgroundTask,
    onOpenBackgroundTasksList,
    openSettings,
    loadTurnDiffDetail,
    onOpenDiffInPanel,
    onOpenFileInPanel,
    onOpenSkillInPanel,
    onOpenTerminalInPanel,
    statFilePaths,
  })
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

  usePendingMessageJumpReveal({
    state,
    messages,
    sessionId,
    isForegroundSession,
    threadRootRef,
  })

  const {
    bypassPending,
    handleSetPermissionMode,
    handleBypassAccept,
    handleBypassCancel,
  } = useBypassPermissionsGate({
    state,
    permissionMode,
    isForegroundSession,
    setPermissionMode,
    setSkipDangerousMode,
  })

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

  runtimeMessagesRef.current = runtimeMessages
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
      <ShellCommandContext.Provider value={shellCommandValue}>
      <FilePathContext.Provider value={filePathContextValue}>
      <ComposerPassagesProvider store={readOnly ? null : passageStore}>
      <ChapterMarksProvider value={chapterMarksValue}>
      <ComposerDraftSync
        initialComposerDraft={initialComposerDraft}
        onComposerEdit={handleComposerEdit}
        passages={readOnly ? undefined : passageStore}
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
                <SnapshotNeedsAnswerProvider value={snapshotNeedsAnswer(state.snapshot) || !!onUnarchive}>
                <ArchivedSessionProvider value={onUnarchive ? { onUnarchive } : null}>
                <SnapshotBlocksComposerInputProvider
                  value={
                    readOnly || snapshotBlocksComposerInput(state.snapshot) || !!onUnarchive
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
                  <CodeReviewProvider value={{ connection: runtimeConnection, sessionId: modSessionId ?? threadSessionId, readOnly }}>
                  <SessionProposalsContext.Provider value={sessionProposals}>
                  <SessionCardsPopoverContext.Provider value={sessionCardsPopover}>
                  <SessionChangeFiguresContext.Provider value={state.sessionChangeFigures ?? null}>
                  <AgentChangesContext.Provider value={state.agentChanges ?? NO_AGENT_CHANGES}>
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
                      // a2ui_* cards (rendered inside <Thread/>) and the side pane
                      // share one processor and action loop.
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
                          sessionId={sessionId}
                          messages={state.transcriptMessages}
                          submitActionMessage={submitActionMessage}
                          busy={state.status === 'submitting'}
                          appBoard={appBoard}
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
                  </AgentChangesContext.Provider>
                  </SessionChangeFiguresContext.Provider>
                  </SessionCardsPopoverContext.Provider>
                  </SessionProposalsContext.Provider>
                  </CodeReviewProvider>
                  </ModUiContext.Provider>
                  </SlashCommandsProvider>
                  </PermissionAskContext.Provider>
                  </EnterPlanApprovalContext.Provider>
                  </PlanPanelContext.Provider>
                  </ProjectFolderProvider>
                  </PermissionModeProvider>
                </SnapshotBlocksComposerInputProvider>
                </ArchivedSessionProvider>
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
          {composerInsert && <ComposerTextInsert insert={composerInsert} />}
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
          {continueInCodeCall && (
            <WorkspaceProjectFolderDialog
              onOpenFolder={() => finishContinueInCode({ pick: true })}
              onSelectFolder={path => void finishContinueInCode({ path })}
              onCancel={() => setContinueInCodeCall(null)}
              cancelLabel={t('continueInCode.cancel')}
            />
          )}
        </TooltipProvider>
      </ToolCallDetailProvider>
      </ChapterMarksProvider>
      </ComposerPassagesProvider>
      </FilePathContext.Provider>
      </ShellCommandContext.Provider>
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
