import { Suspense, type ComponentProps, type ReactNode } from 'react'
import { AssistantUiThread } from './AssistantUiThread'
import { ThreadErrorBoundary } from './ThreadErrorBoundary'
import { CliSessionView } from './coldUi'
import { countRunning } from './backgroundSubAgents'
import { threadMount } from './sideChat'
import { getTemplateTitle } from '../../prompting/templateCatalog'
import type { BrowserRuntimeClientState } from './BrowserRuntimeClient'
import type { SessionBoundActions } from './useMultiSessionClients'
import type { SessionMessageCallbacks } from './sessionMessageCallbacks'
import type { SidePaneKind } from './layout/paneLayout'
import type { TranslateFn } from './i18n/translate'
import type { NexusTaskSummaryRow } from '../bridge/protocol/ui'

type ThreadProps = ComponentProps<typeof AssistantUiThread>

/**
 * Contract: the shell values one conversation reads. Each is handed to the
 * thread as-is, so a value's identity is the identity the shell holds.
 */
export interface ShellSessionThreadInputs {
  activeSessionId: string
  sessionActionsFor: (sessionId: string) => SessionBoundActions
  sessionStates: ReadonlyMap<string, BrowserRuntimeClientState>
  activeState: BrowserRuntimeClientState
  getSessionMessageCallbacks: (sessionId: string) => SessionMessageCallbacks
  cliSessions: ReadonlyMap<string, { cli: string; type: string }>
  runtimeConnection: ThreadProps['runtimeConnection']
  openTerminalLink: (url: string) => void
  t: TranslateFn
  shutdownSessionIds: ReadonlySet<string>
  submitPrompt: ThreadProps['submitPrompt']
  submitActionMessage: ThreadProps['submitActionMessage']
  continueConversation: ThreadProps['continueConversation']
  submitComposerMessage: ThreadProps['submitComposerMessage']
  pickComposerAttachmentFiles: ThreadProps['onPickAttachmentFiles']
  submitToolResult: ThreadProps['submitToolResult']
  loadToolCallDetail: ThreadProps['loadToolCallDetail']
  loadTurnDiffDetail: ThreadProps['loadTurnDiffDetail']
  interrupt: ThreadProps['interrupt']
  setPermissionMode: ThreadProps['setPermissionMode']
  setSkipDangerousMode: ThreadProps['setSkipDangerousMode']
  clearPendingMessage: ThreadProps['onClearPendingMessage']
  removeInjectMessage: ThreadProps['onRemoveInjectMessage']
  resolveToolUseConfirm: ThreadProps['resolveToolUseConfirm']
  clearPlanApproval: ThreadProps['clearPlanApproval']
  sessionItems: ThreadProps['sessions']
  handleOpenBackgroundTasks: ThreadProps['onOpenBackgroundTasks']
  subAgentRowsForSession: (sessionId: string) => NexusTaskSummaryRow[]
  handleStopBackgroundTask: ThreadProps['onStopBackgroundTask']
  handleOpenBackgroundTasksList: ThreadProps['onOpenBackgroundTasksList']
  openPaneFor: (kind: SidePaneKind) => void
  openFile: ThreadProps['onOpenFileInPanel']
  openTerminalInPanel: ThreadProps['onOpenTerminalInPanel']
  statFilePaths: ThreadProps['statFilePaths']
  openDiffInPanel: ThreadProps['onOpenDiffInPanel']
  openSkillInPanel: ThreadProps['onOpenSkillInPanel']
  focusSession: ThreadProps['onSwitchThread']
  handleDeleteThread: ThreadProps['onDeleteThread']
  retitleSession: ThreadProps['onRenameThread']
  handlePendingQuestionsChange: ThreadProps['onPendingQuestionsChange']
  openNewSession: ThreadProps['onNewThread']
  handleOpenSettings: ThreadProps['openSettings']
  handleOpenPluginSettings: ThreadProps['onOpenPluginSettings']
  modPanesDocked: ThreadProps['modPanesDocked']
  sessionCardsDocked: ThreadProps['sessionCardsDocked']
  sessionCardsFit: boolean
  sessionCardsPopoverOpen: boolean
  closeSessionCardsPopover: ThreadProps['onSessionCardsPopoverClose']
  handleLoadProviderMissingPrompt: ThreadProps['loadProviderMissingPrompt']
  handleAdoptDefaultSelection: ThreadProps['onAdoptDefaultSelection']
  handleSessionSelectModel: ThreadProps['onSelectSessionModel']
  handleSetAutoCompactWindow: ThreadProps['onSetAutoCompactWindow']
  handleSelectProjectFolder: ThreadProps['onSelectProjectFolder']
  handleOpenProjectFolder: ThreadProps['onOpenProjectFolder']
  handleRevealProjectFolder: ThreadProps['onRevealProjectFolder']
  sessionDraftBySessionId: ReadonlyMap<string, string>
  composerInsert: { sessionId: string; text: string; nonce: number } | null
  handleComposerEdit: ThreadProps['onComposerEdit']
}

// One session's conversation: in the chat slot (shown when active, kept
// mounted hidden otherwise) or in the Side chats pane (`inPane`), where its
// actions are bound to it rather than to the active session (F-36).
// A plain render function, not a component: the shell calls it inline, so the
// element tree is the one the shell would build itself.
export function renderShellSessionThread(
  inputs: ShellSessionThreadInputs,
  sessionId: string,
  inPane: boolean,
): ReactNode {
  const {
    activeSessionId, sessionActionsFor, sessionStates, activeState,
    getSessionMessageCallbacks, cliSessions, runtimeConnection, openTerminalLink, t,
    shutdownSessionIds, submitPrompt, submitActionMessage, continueConversation,
    submitComposerMessage, pickComposerAttachmentFiles, submitToolResult,
    loadToolCallDetail, loadTurnDiffDetail, interrupt, setPermissionMode,
    setSkipDangerousMode, clearPendingMessage, removeInjectMessage, resolveToolUseConfirm,
    clearPlanApproval, sessionItems, handleOpenBackgroundTasks, subAgentRowsForSession,
    handleStopBackgroundTask, handleOpenBackgroundTasksList, openPaneFor, openFile,
    openTerminalInPanel, statFilePaths, openDiffInPanel, openSkillInPanel, focusSession,
    handleDeleteThread, retitleSession, handlePendingQuestionsChange, openNewSession,
    handleOpenSettings, handleOpenPluginSettings, modPanesDocked, sessionCardsDocked,
    sessionCardsFit, sessionCardsPopoverOpen, closeSessionCardsPopover,
    handleLoadProviderMissingPrompt, handleAdoptDefaultSelection, handleSessionSelectModel,
    handleSetAutoCompactWindow, handleSelectProjectFolder, handleOpenProjectFolder,
    handleRevealProjectFolder, sessionDraftBySessionId, composerInsert, handleComposerEdit,
  } = inputs
  const isActive = inPane || sessionId === activeSessionId
  const bound = inPane ? sessionActionsFor(sessionId) : null
  const mount = threadMount(sessionId, inPane, activeSessionId)
        const state = sessionStates.get(sessionId) ?? activeState
        const messageCallbacks = getSessionMessageCallbacks(sessionId)
        const cliSession = cliSessions.get(sessionId)
        return (
          <section
            key={sessionId}
            // Scope for the attention reveal: every mounted thread is in the
            // DOM at once, so the reveal must find THIS session's control.
            data-session-section={sessionId}
            style={{
              height: '100%',
              flex: isActive ? 1 : undefined,
              // A maximized Right Panel covers the conversation: hide it the
              // same way an inactive session is hidden (display none keeps
              // the thread mounted, so restoring is a paint toggle).
              display: isActive ? 'flex' : 'none',
              // A row-flex item: without it the section cannot narrow below a
              // terminal's drawn width, and the emulator refits a few columns at a time.
              minWidth: 0,
            }}
          >
            <div className="flex h-full min-w-0 flex-1">
            {cliSession ? (
              <Suspense fallback={null}>
                <CliSessionView
                  sessionId={sessionId}
                  cli={cliSession.cli}
                  name={getTemplateTitle(cliSession.type)}
                  runtimeConnection={runtimeConnection}
                  openLink={openTerminalLink}
                />
              </Suspense>
            ) : (
            <ThreadErrorBoundary sessionId={sessionId} t={t}>
              <AssistantUiThread
                state={state}
                readOnly={shutdownSessionIds.has(sessionId)}
                threadSessionId={sessionId}
                submitPrompt={bound?.submitPrompt ?? submitPrompt}
                submitActionMessage={bound?.submitActionMessage ?? submitActionMessage}
                continueConversation={bound?.continueConversation ?? continueConversation}
                submitComposerMessage={bound?.submitComposerMessage ?? submitComposerMessage}
                onPickAttachmentFiles={pickComposerAttachmentFiles}
                submitToolResult={bound?.submitToolResult ?? submitToolResult}
                loadToolCallDetail={bound?.loadToolCallDetail ?? loadToolCallDetail}
                loadTurnDiffDetail={loadTurnDiffDetail}
                interrupt={bound?.interrupt ?? interrupt}
                setPermissionMode={bound?.setPermissionMode ?? setPermissionMode}
                setSkipDangerousMode={bound?.setSkipDangerousMode ?? setSkipDangerousMode}
                onClearPendingMessage={bound?.clearPendingMessage ?? clearPendingMessage}
                onRemoveInjectMessage={bound?.removeInjectMessage ?? removeInjectMessage}
                resolveToolUseConfirm={bound?.resolveToolUseConfirm ?? resolveToolUseConfirm}
                clearPlanApproval={bound?.clearPlanApproval ?? clearPlanApproval}
                sessions={sessionItems}
                activeSessionId={mount.foregroundSessionId}
                onOpenBackgroundTasks={handleOpenBackgroundTasks}
                // THIS session's running background tasks (not the active
                // session's) — each mounted thread shows its own footer
                // "still working" indicator.
                runningBackgroundTaskCount={countRunning(subAgentRowsForSession(sessionId))}
                backgroundTaskRows={subAgentRowsForSession(sessionId)}
                onStopBackgroundTask={handleStopBackgroundTask}
                onOpenBackgroundTasksList={handleOpenBackgroundTasksList}
                onOpenPlanPanel={() => openPaneFor('plan')}
                onOpenFileInPanel={openFile}
                onOpenTerminalInPanel={openTerminalInPanel}
                statFilePaths={statFilePaths}
                onOpenDiffInPanel={openDiffInPanel}
                onOpenSkillInPanel={openSkillInPanel}
                onSwitchThread={focusSession}
                onDeleteThread={handleDeleteThread}
                onRenameThread={retitleSession}
                onForkFromMessage={messageCallbacks.onFork}
                onForkAfterMessage={messageCallbacks.onForkAfter}
                onSendInForkedSession={messageCallbacks.onSendInFork}
                onContinueInCode={messageCallbacks.onContinueInCode}
                onRewindToMessage={messageCallbacks.onRewind}
                onStartSideChat={inPane ? undefined : messageCallbacks.onStartSideChat}
                onPendingQuestionsChange={handlePendingQuestionsChange}
                onNewThread={openNewSession}
                openSettings={mount.lightControls ? undefined : handleOpenSettings}
                onOpenPluginSettings={handleOpenPluginSettings}
                modPanesDocked={modPanesDocked}
                sessionCardsDocked={sessionCardsDocked}
                sessionCardsPopoverOpen={!inPane && isActive && !sessionCardsFit && sessionCardsPopoverOpen}
                onSessionCardsPopoverClose={closeSessionCardsPopover}
                runtimeConnection={runtimeConnection}
                loadProviderMissingPrompt={handleLoadProviderMissingPrompt}
                onAdoptDefaultSelection={handleAdoptDefaultSelection}
                onSelectSessionModel={mount.lightControls ? undefined : handleSessionSelectModel}
                onSetAutoCompactWindow={handleSetAutoCompactWindow}
                onSelectProjectFolder={mount.lightControls ? undefined : handleSelectProjectFolder}
                onOpenProjectFolder={mount.lightControls ? undefined : handleOpenProjectFolder}
                onRevealProjectFolder={mount.lightControls ? undefined : handleRevealProjectFolder}
                initialComposerDraft={sessionDraftBySessionId.get(sessionId)}
                composerInsert={composerInsert?.sessionId === sessionId ? composerInsert : null}
                onComposerEdit={handleComposerEdit}
              />
            </ThreadErrorBoundary>
            )}
            </div>
          </section>
        )
}
