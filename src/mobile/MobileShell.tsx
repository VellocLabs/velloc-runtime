/**
 * The phone shell of the remote page (F-24). It drives the desktop runtime's sessions through the
 * same session hooks and the same conversation view as the desktop shell, and draws its own
 * chrome around them: the top bar, the session drawer, the session menu. It never imports the
 * desktop shell's UI (pinned by mobile-shell-imports.test). This phone browses on its own: its open
 * session is not the desktop's.
 */
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'

import { switchToDesktopShell } from '../browser/boot/mobileEntry'
import type { AgentRuntimeWorkerInitPayload } from '../browser/worker/workerProtocol'
import type { BrowserBridgeTransport } from '../browser/bridge/browserBridgeProtocol'
import type { BrowserWorkerClientTransport } from '../browser/webview/BrowserRuntimeClient'
import type {
  RuntimeConnection,
  RuntimeFileAccess,
  SessionListChannel,
  SessionStatusChannel,
} from '../browser/runtimeClient'
import {
  readStoredActiveSessionId,
  resolveBootSession,
  writeStoredActiveSessionId,
} from '../browser/webview/bootSessionPointer'
import { folderName } from '../browser/webview/childSessionStatus'
import { useClientActivityReport } from '../browser/webview/clientActivityReport'
import { useT } from '../browser/webview/i18n'
import {
  isRuntimeReady,
  RuntimeReadyContext,
  useRuntimeConnectionState,
} from '../browser/webview/RuntimeConnectionBanner'
import { isSandboxProjectRoot } from '../browser/webview/projectTree'
import { createSessionMessageCallbackFactory } from '../browser/webview/sessionMessageCallbacks'
import {
  createShellHandleArchiveThread,
  createShellHandleRequestDelete,
  createShellHandleRequestFork,
  createShellHandleRequestRename,
  createShellHandleRewindFromMessage,
} from '../browser/webview/shellSessionRequests'
import {
  renderShellSessionThread,
  type ShellSessionThreadInputs,
} from '../browser/webview/shellSessionThread'
import {
  createShellHandleLoadProviderMissingPrompt,
  createShellHandleSessionSelectModel,
  createShellHandleSetAutoCompactWindow,
} from '../browser/webview/shellSettingsActions'
import { createShellCreateSessionInitPayload } from '../browser/webview/shellSidebarActions'
import {
  createShellHandleComposerEdit,
  createShellHandleLaunchInProject,
  createShellHandleSelectProjectFolder,
  createShellOnSessionStateChange,
} from '../browser/webview/shellThreadActions'
import { SessionStatusChannelContext } from '../browser/webview/topbar/useNexusSessionStatus'
import { RuntimeCapabilitiesContext, useCapabilityQuery } from '../browser/webview/useCan'
import { useMultiSessionClients } from '../browser/webview/useMultiSessionClients'
import { useSessionManager } from '../browser/webview/useSessionManager'
import { randomUuid } from '../utils/randomUuid'
import { snapshotNeedsAnswer } from '../utils/sessionNeedsAnswer'
import { MobileDrawer } from './MobileDrawer'
import { namedTitle } from './mobileSessionGroups'
import { MobileRenameSheet, MobileSessionMenu, type MobileMenuTarget } from './MobileSessionMenu'
import { MobileTopBar } from './MobileTopBar'
import { useThreadBottomInset } from './threadBottomInset'

/** What the phone shell reads of the props `renderShell` passes every shell. */
export type MobileShellProps = {
  createWorkerTransport: () => BrowserWorkerClientTransport
  hostBridgeTransport: BrowserBridgeTransport
  files?: RuntimeFileAccess
  createInitPayload: (sessionId: string) => AgentRuntimeWorkerInitPayload
  openingSessionId?: string
  sessionChannel?: SessionListChannel
  sessionStatusChannel?: SessionStatusChannel
  runtimeConnection?: () => Promise<RuntimeConnection>
}

type SessionListPayload = Parameters<ReturnType<typeof useSessionManager>['applyRemoteList']>[0]
type SessionUpdatePayload = Parameters<ReturnType<typeof useSessionManager>['applyRemoteUpdate']>[0]
type SessionItem = NonNullable<ShellSessionThreadInputs['sessionItems']>[number]
type InitPayloadArgs = Parameters<typeof createShellCreateSessionInitPayload>

const noop = (): void => {}

/** The ids whose `flag` is set in a `session.summary` row; `prev` when unchanged. */
function summaryIdSet(
  prev: ReadonlySet<string>,
  rows: ReadonlyArray<Record<string, unknown>>,
  flag: 'running' | 'needsAnswer',
): ReadonlySet<string> {
  const next = new Set<string>()
  for (const row of rows) {
    if (row[flag] === true && typeof row.sessionId === 'string') next.add(row.sessionId)
  }
  if (next.size !== prev.size) return next
  for (const id of next) if (!prev.has(id)) return next
  return prev
}

export function MobileShell(props: MobileShellProps): ReactNode {
  const {
    createWorkerTransport,
    hostBridgeTransport,
    files,
    createInitPayload,
    openingSessionId,
    sessionChannel,
    sessionStatusChannel,
    runtimeConnection,
  } = props
  const t = useT()
  const runtimeCapabilities = useCapabilityQuery(runtimeConnection)
  const threadBottomInset = useThreadBottomInset()
  const connectionState = useRuntimeConnectionState(runtimeConnection)

  const sessionChannelRef = useRef<SessionListChannel | null>(sessionChannel ?? null)
  sessionChannelRef.current = sessionChannel ?? null

  const bootSession = useMemo(
    () =>
      resolveBootSession({
        initialSessionId: openingSessionId,
        storedSessionId: readStoredActiveSessionId(),
        mintSessionId: () => randomUuid(),
      }),
    [openingSessionId],
  )

  const ownForkRequestsRef = useRef<Set<string>>(new Set())
  const ownSideChatForksRef = useRef<Map<string, string>>(new Map())
  const pendingRewindRef = useRef<Map<string, string>>(new Map())
  const handleRequestDelete = useMemo(() => createShellHandleRequestDelete(sessionChannelRef), [])
  const handleRequestRename = useMemo(() => createShellHandleRequestRename(sessionChannelRef), [])
  const handleRequestFork = useMemo(
    () => createShellHandleRequestFork(ownForkRequestsRef, ownSideChatForksRef, sessionChannelRef, t),
    [t],
  )
  const handleArchiveThread = useMemo(() => createShellHandleArchiveThread(sessionChannelRef), [])
  const handleRewindFromMessage = useMemo(
    () => createShellHandleRewindFromMessage(pendingRewindRef, sessionChannelRef),
    [],
  )

  const {
    activeSessionId,
    sessions,
    openNewSession,
    getSessionTemplateType,
    getSessionProjectRoot,
    focusSession,
    deleteSession,
    retitleSession,
    forkSession,
    updateSessionMeta,
    applyRemoteList,
    applyRemoteUpdate,
    applyRemoteRemoval,
  } = useSessionManager({
    openingSessionId: bootSession.sessionId,
    onRequestDelete: handleRequestDelete,
    onRequestRename: handleRequestRename,
    onRequestFork: handleRequestFork,
  })

  useEffect(() => {
    writeStoredActiveSessionId(activeSessionId)
  }, [activeSessionId])

  const shutdownSessionIds = useMemo(
    () => new Set(sessions.filter(s => s.shutdown).map(s => s.sessionId)),
    [sessions],
  )

  // No default model of its own: an existing session reopens with its persisted
  // selection, and a new one gets the runtime's default.
  const noSelectionRef: InitPayloadArgs[1] = useRef(null)
  const noCatalogRef: InitPayloadArgs[6] = useRef(null)
  const createSessionInitPayload = useMemo(
    () =>
      createShellCreateSessionInitPayload(
        createInitPayload,
        noSelectionRef,
        noSelectionRef,
        noSelectionRef,
        getSessionTemplateType,
        getSessionProjectRoot,
        noCatalogRef,
        bootSession,
      ),
    [createInitPayload, getSessionTemplateType, getSessionProjectRoot, bootSession],
  )

  const mountedSessionIds = useMemo(() => [activeSessionId], [activeSessionId])
  const onSessionStateChange = useMemo(
    () => createShellOnSessionStateChange(updateSessionMeta),
    [updateSessionMeta],
  )
  const clients = useMultiSessionClients({
    activeSessionId,
    shutdownSessionIds,
    mountedSessionIds,
    createWorkerTransport,
    hostBridgeTransport,
    files,
    createInitPayload: createSessionInitPayload,
    onSessionStateChange,
  })
  const { disposeClient } = clients

  const handleDeleteThread = useCallback(
    (sessionId: string) => {
      disposeClient(sessionId)
      deleteSession(sessionId)
    },
    [disposeClient, deleteSession],
  )
  const handleDeleteThreadRef = useRef(handleDeleteThread)
  handleDeleteThreadRef.current = handleDeleteThread

  // Running and halted-on-a-question, per session, from the runtime's summary.
  const [summaryRunning, setSummaryRunning] = useState<ReadonlySet<string>>(() => new Set())
  const [summaryNeedsAnswer, setSummaryNeedsAnswer] = useState<ReadonlySet<string>>(() => new Set())

  // The session list, and the forks this page asked for: a fork or a rewind
  // switches this page to the copy; another client's fork only lists it.
  useEffect(() => {
    if (!sessionChannel) return undefined
    return sessionChannel.onMessage((data: Record<string, unknown>) => {
      const payload = data.payload as Record<string, unknown> | undefined
      if (data.type === 'session.list' && Array.isArray(payload?.sessions)) {
        applyRemoteList(payload.sessions as SessionListPayload)
        return
      }
      if (data.type === 'session.updated') {
        const session = payload?.session as SessionUpdatePayload | undefined
        if (session?.sessionId) applyRemoteUpdate(session)
        return
      }
      if (data.type === 'session.summary') {
        const rows = payload?.sessions
        if (!Array.isArray(rows)) return
        setSummaryRunning(prev => summaryIdSet(prev, rows, 'running'))
        setSummaryNeedsAnswer(prev => summaryIdSet(prev, rows, 'needsAnswer'))
        return
      }
      if (data.type === 'session.removed') {
        if (typeof payload?.sessionId === 'string') applyRemoteRemoval(payload.sessionId)
        return
      }
      if (data.type === 'session.forked') {
        const newSessionId = payload?.newSessionId
        const requestId = payload?.requestId
        if (typeof newSessionId !== 'string') return
        const rid = typeof requestId === 'string' ? requestId : undefined
        const rewoundFrom = rid ? pendingRewindRef.current.get(rid) : undefined
        if (rid) pendingRewindRef.current.delete(rid)
        const ownFork = rid !== undefined && ownForkRequestsRef.current.delete(rid)
        if (!ownFork && !rewoundFrom) return
        if (rewoundFrom && rewoundFrom !== newSessionId) handleDeleteThreadRef.current(rewoundFrom)
        focusSession(newSessionId)
      }
    })
  }, [sessionChannel, applyRemoteList, applyRemoteUpdate, applyRemoteRemoval, focusSession])

  // Tell the runtime which session this client views: it answers with that
  // session's status, and turn-end notifications follow it.
  useEffect(() => {
    if (!activeSessionId) return
    sessionChannel?.request('presence.setViewing', { sessionId: activeSessionId })
  }, [sessionChannel, activeSessionId])
  useClientActivityReport(sessionChannel)

  const getSessionMessageCallbacks = useMemo(
    () => createSessionMessageCallbackFactory(forkSession, handleRewindFromMessage),
    [forkSession, handleRewindFromMessage],
  )

  const sessionItems: SessionItem[] = useMemo(
    () =>
      sessions
        .filter(s => !s.spawnerSessionId && !s.sideChat)
        .map(s => ({
          sessionId: s.sessionId,
          title: s.title,
          templateType: s.templateType,
          projectRoot: s.projectRoot,
          parentSessionId: s.parentSessionId,
          lineageKind: s.lineageKind,
          archived: s.archived,
          shutdown: s.shutdown,
          previewText: s.previewText,
          updatedAt: s.updatedAt,
          createdAt: s.createdAt,
          lastComposerEditAt: s.lastComposerEditAt,
          pinned: s.pinned,
          renamed: s.renamed === true,
          messageCount: s.messageCount,
        })),
    [sessions],
  )

  const sessionDraftBySessionId = useMemo(
    () =>
      new Map(
        sessions
          .filter(s => typeof s.composerDraft === 'string' && s.composerDraft.length > 0)
          .map(s => [s.sessionId, s.composerDraft as string]),
      ),
    [sessions],
  )

  const handleSessionSelectModel = useMemo(
    () => createShellHandleSessionSelectModel(clients.setModelSelectionForSession),
    [clients.setModelSelectionForSession],
  )
  const handleSetAutoCompactWindow = useMemo(
    () => createShellHandleSetAutoCompactWindow(clients.setAutoCompactWindowForSession),
    [clients.setAutoCompactWindowForSession],
  )
  const handleSelectProjectFolder = useMemo(
    () =>
      createShellHandleSelectProjectFolder(
        clients.rebindProjectFolder,
        getSessionTemplateType,
        clients.updateSessionMetadata,
      ),
    [clients.rebindProjectFolder, getSessionTemplateType, clients.updateSessionMetadata],
  )
  const handleLoadProviderMissingPrompt = useMemo(
    () => createShellHandleLoadProviderMissingPrompt(hostBridgeTransport),
    [hostBridgeTransport],
  )
  const handleComposerEdit = useMemo(
    () => createShellHandleComposerEdit(updateSessionMeta, clients.updateSessionMetadata),
    [updateSessionMeta, clients.updateSessionMetadata],
  )
  const [cliSessions] = useState(() => new Map<string, { cli: string; type: string }>())
  const noSubAgentRows = useCallback(() => [], [])

  // Panes, settings and session cards are the desktop shell's: this shell
  // offers none of them, so their requests are absent or do nothing.
  const threadInputs: ShellSessionThreadInputs = {
    activeSessionId,
    sessionActionsFor: clients.sessionActionsFor,
    sessionStates: clients.sessionStates,
    activeState: clients.activeState,
    getSessionMessageCallbacks,
    cliSessions,
    runtimeConnection,
    openTerminalLink: noop,
    t,
    shutdownSessionIds,
    submitPrompt: clients.submitPrompt,
    submitActionMessage: clients.submitActionMessage,
    continueConversation: clients.continueConversation,
    submitComposerMessage: clients.submitComposerMessage,
    pickComposerAttachmentFiles: clients.pickComposerAttachmentFiles,
    submitToolResult: clients.submitToolResult,
    loadToolCallDetail: clients.loadToolCallDetail,
    loadTurnDiffDetail: clients.loadTurnDiffDetail,
    interrupt: clients.interrupt,
    setPermissionMode: clients.setPermissionMode,
    setSkipDangerousMode: clients.setSkipDangerousMode,
    clearPendingMessage: clients.clearPendingMessage,
    removeInjectMessage: clients.removeInjectMessage,
    resolveToolUseConfirm: clients.resolveToolUseConfirm,
    clearPlanApproval: clients.clearPlanApproval,
    rejectPlanApproval: clients.rejectPlanApproval,
    sessionItems,
    handleArchiveThread,
    handleOpenBackgroundTasks: undefined,
    subAgentRowsForSession: noSubAgentRows,
    handleStopBackgroundTask: undefined,
    handleOpenBackgroundTasksList: undefined,
    openSidePane: undefined,
    openFile: undefined,
    openTerminalInPanel: undefined,
    statFilePaths: clients.statFilePaths,
    openDiffInPanel: undefined,
    openSkillInPanel: undefined,
    focusSession,
    handleDeleteThread,
    retitleSession,
    handlePendingQuestionsChange: undefined,
    openNewSession,
    handleOpenSettings: undefined,
    handleOpenPluginSettings: undefined,
    modPanesDocked: false,
    sessionCardsDocked: false,
    sessionCardsFit: false,
    sessionCardsPopoverOpen: false,
    closeSessionCardsPopover: undefined,
    handleLoadProviderMissingPrompt,
    handleAdoptDefaultSelection: clients.setModelSelection,
    handleSessionSelectModel,
    handleSetAutoCompactWindow,
    handleSelectProjectFolder,
    handleOpenProjectFolder: undefined,
    handleRevealProjectFolder: undefined,
    sessionDraftBySessionId,
    composerInsert: null,
    handleComposerEdit,
    // No Shift on a soft keyboard: Enter is a newline and the Send button
    // sends; a hard keyboard keeps Ctrl/Cmd+Enter (F-24).
    composerEnterSends: false,
  }

  const activeItem = sessions.find(s => s.sessionId === activeSessionId)
  const title = namedTitle(activeItem?.title) || t('mobile.topbar.untitledSession')
  const activeSnapshot = clients.activeState.snapshot
  const activeRunning = clients.activeState.status === 'submitting' || summaryRunning.has(activeSessionId)
  const activeNeedsAnswer = snapshotNeedsAnswer(activeSnapshot)
  const running = useMemo(() => {
    if (!activeRunning || summaryRunning.has(activeSessionId)) return summaryRunning
    return new Set([...summaryRunning, activeSessionId])
  }, [summaryRunning, activeRunning, activeSessionId])
  const needsAnswer = useMemo(() => {
    if (!activeNeedsAnswer || summaryNeedsAnswer.has(activeSessionId)) return summaryNeedsAnswer
    return new Set([...summaryNeedsAnswer, activeSessionId])
  }, [summaryNeedsAnswer, activeNeedsAnswer, activeSessionId])
  const projectRoot = activeItem?.projectRoot
  const projectName = projectRoot && !isSandboxProjectRoot(projectRoot) ? folderName(projectRoot) : undefined

  const [drawerOpen, setDrawerOpen] = useState(false)
  const [menuTarget, setMenuTarget] = useState<MobileMenuTarget | null>(null)
  const [renameTarget, setRenameTarget] = useState<MobileMenuTarget | null>(null)
  const launchInProject = useMemo(() => createShellHandleLaunchInProject(openNewSession), [openNewSession])

  const selectSession = useCallback(
    (sessionId: string) => {
      setDrawerOpen(false)
      focusSession(sessionId)
    },
    [focusSession],
  )
  const startNewSession = useCallback(() => {
    setDrawerOpen(false)
    const templateType = getSessionTemplateType(activeSessionId)
    if (projectRoot?.trim()) launchInProject(projectRoot, templateType ?? '')
    else openNewSession(templateType)
  }, [activeSessionId, getSessionTemplateType, launchInProject, openNewSession, projectRoot])
  const openRowMenu = useCallback(
    (sessionId: string) => {
      const item = sessions.find(s => s.sessionId === sessionId)
      if (!item) return
      // The branch is known for the open session only.
      const branch = sessionId === activeSessionId ? activeSnapshot?.projectBranch : undefined
      setMenuTarget({ sessionId, title: namedTitle(item.title), branch: branch || undefined })
    },
    [sessions, activeSessionId, activeSnapshot],
  )
  const archiveSession = useCallback(
    (sessionId: string) => handleArchiveThread(sessionId, true),
    [handleArchiveThread],
  )

  return (
    <RuntimeCapabilitiesContext.Provider value={runtimeCapabilities}>
      <RuntimeReadyContext.Provider value={isRuntimeReady(connectionState)}>
        <SessionStatusChannelContext.Provider value={sessionStatusChannel ?? null}>
          <main data-testid="mobile-shell" className="flex h-full w-full flex-col bg-background text-foreground">
            <MobileTopBar
              title={title}
              projectName={projectName}
              running={running.has(activeSessionId)}
              onOpenDrawer={() => setDrawerOpen(true)}
              onOpenMenu={() => openRowMenu(activeSessionId)}
            />
            <div
              className="relative min-h-0 flex-1"
              data-testid="mobile-thread"
              style={{
                ['--thread-bottom-inset' as string]: threadBottomInset,
                paddingLeft: 'env(safe-area-inset-left)',
                paddingRight: 'env(safe-area-inset-right)',
              }}
            >
              {renderShellSessionThread(threadInputs, activeSessionId, false)}
            </div>
            <MobileDrawer
              open={drawerOpen}
              onOpenChange={setDrawerOpen}
              sessions={sessions}
              running={running}
              needsAnswer={needsAnswer}
              activeSessionId={activeSessionId}
              onSelectSession={selectSession}
              onSessionMenu={openRowMenu}
              onNewSession={startNewSession}
              onDesktopView={() => switchToDesktopShell({ win: window, baseUri: document.baseURI })}
            />
            <MobileSessionMenu
              target={menuTarget}
              onClose={() => setMenuTarget(null)}
              onRename={target => {
                setMenuTarget(null)
                setRenameTarget(target)
              }}
              onArchive={archiveSession}
            />
            <MobileRenameSheet
              target={renameTarget}
              onClose={() => setRenameTarget(null)}
              onSave={retitleSession}
            />
          </main>
        </SessionStatusChannelContext.Provider>
      </RuntimeReadyContext.Provider>
    </RuntimeCapabilitiesContext.Provider>
  )
}
