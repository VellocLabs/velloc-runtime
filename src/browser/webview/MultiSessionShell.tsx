import {
  Suspense,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from 'react'
import type { AppendMessage } from '@assistant-ui/react'
import type {
  BrowserBridgeTransport,
  BrowserLlmCatalog,
  BrowserLlmSelection,
  NexusSettingsSection,
  ProviderMissingPrompt,
} from '../bridge/browserBridgeProtocol'
import type { AgentRuntimeWorkerInitPayload } from '../worker/workerProtocol'
import type { RuntimeFileAccess } from '../runtimeClient/fileAccess'
import type { SessionListChannel } from '../runtimeClient/sessionListChannel'
import type { SessionStatusChannel } from '../runtimeClient/sessionStatusChannel'
import type { ShellChannel } from '../runtimeClient/shellChannel'
import { SessionStatusChannelContext } from './topbar/useNexusSessionStatus'
import type { BrowserSessionMetadata } from '../../sessions/sessionStore'
import type { BrowserWorkerClientTransport } from './BrowserRuntimeClient'
import type { SessionListItem } from './Sidebar'
import type { BrowserRuntimeClientState } from './BrowserRuntimeClient'
import { AssistantUiThread } from './AssistantUiThread'
import { Sidebar } from './Sidebar'
import { SidebarSplitter } from './SidebarSplitter'
import { SidebarPeek } from './SidebarPeek'
import { resolveShellLayout, rightPanelWantWidth } from './layout/shellLayout'
import { initialRightPanelPresence, stepRightPanelPresence } from './layout/rightPanelPresence'
import { useOverlayDismiss } from './layout/useOverlayDismiss'
import { setSessionCardsShown } from './layout/sessionCards'
import { useSessionCardPrefs } from '@/components/assistant-ui/session-card-stack'
import {
  CHAT_CONTENT_MIN_WIDTH_PX,
  PANE_GUTTER_PX,
  RIGHT_PANEL_OVERLAY_CHAT_STRIP_PX,
  RIGHT_PANEL_MIN_WIDTH_PX,
  SIDEBAR_DEFAULT_WIDTH_PX,
  SIDEBAR_MAX_WIDTH_PX,
  SIDEBAR_MIN_WIDTH_PX,
} from './layout/layoutConstants'
import {
  clampSidebarWidth,
  readViewportWidth,
} from './layout/computeLayout'
import {
  closePane,
  hasPane,
  browserToggleAction,
  followBrowserTabs,
  openPane,
  movePane,
  paneLayoutEquals,
  panesIn,
  paneToggleAction,
  paneWeightFor,
  pruneUnrestorable,
  resetPaneLayout,
  setMaximized,
  type FilesPaneState,
  type PaneDropTarget,
  type PaneLayout,
  type SessionPaneRecord,
  type SidePaneKind,
  CHAT_WEIGHT as PANE_CHAT_WEIGHT,
} from './layout/paneLayout'
import { sideRegionMetrics } from './layout/paneGeometry'
import { rootPaneWeightsByKind } from './layout/paneResize'
import { activateFileTab, closeFileTab, emptyFilesPane, openFileTab } from './layout/filesPane'
import { createSessionLayoutsStore, useSessionLayouts, type SessionLayoutsStore } from './layout/sessionLayouts'
import { paneShortcutFor } from './layout/paneShortcuts'
import { PaneArea } from './panes/PaneArea'
import { PaneFrame } from './panes/PaneFrame'
import { PANE_ICON, PANE_LABEL_KEY } from './panes/paneKinds'
import { foldModDock, sameModDockFront, type ModDockFront } from './layout/modDock'
import { useSessionModUi } from './mods/useSessionModUi'
import { useModAgentView } from './mods/useModAgentView'
import {
  RightPanelContentContext,
  type RightPanelDiffTarget,
  type RightPanelSkillTarget,
  type RightPanelFileTarget,
} from '@/components/assistant-ui/right-panel-content-context'
import {
  FilePathContext,
  createFilePathProbe,
} from '@/components/assistant-ui/file-path-context'
import { ThreadErrorBoundary } from './ThreadErrorBoundary'
import { TopbarSearch } from './topbar/TopbarSearch'
import {
  clearPendingMessageJump,
  setPendingMessageJump,
  type PendingMessageJump,
} from './pendingMessageJumpStore'
import {
  createConfiguredModelCatalog,
  orderCatalogProviders,
  isSelectionEnabled,
  healReplacesGlobalDefault,
} from './modelCatalog'
import { setCustomProviderRecords } from '../../config/customProviderRegistry'
import {
  deriveSessionTabs,
  resolveTeammateJumpTarget,
  sidebarActiveSessionId,
} from './sessionTabs'
import {
  hiddenSessionIds,
  pickVisibleSession,
  withoutHidden,
  withoutHiddenKeys,
} from './sessionVisibility'
import { readSectionCollapsed, readSessionListView } from './sessionListView'
import { sidebarRowOrder } from './sessionPinning'
import { subscribeTeammateJump } from './teammateJumpRequests'
import {
  ATTENTION_SECTION_ATTR,
  revealAttentionSource,
} from './attentionSource'
import { SessionAttentionBar } from './SessionAttentionBar'
import {
  RuntimeReadyContext,
  isRuntimeReady,
  useRuntimeConnectionState,
} from './RuntimeConnectionBanner'
import { RemoteInstallTip } from './remote/RemoteInstallTip'
import { RemoteOfflineOverlay } from './remote/RemoteOfflineOverlay'
import { RuntimeCapabilitiesContext, useCapabilityQuery } from './useCan'
import { SessionAreaVisibleContext } from './sessionAreaVisibility'
import { useActiveSessionOnHost } from './useActiveSessionOnHost'
import {
  createExternalLinkClickHandler,
  openInClientTab,
} from './externalLinkClicks'
import type { RuntimeConnection } from '../runtimeClient/RuntimeConnection'
import { ForbiddenScopeNotice } from './forbiddenScopeNotice'
import {
  attentionDelivery,
  clearAttentionForSession,
  deliveryConsumesEvent,
  createEndedQuestionTracker,
  detectEndedWithQuestion,
  reconcileAttention,
  type AttentionEvent,
} from './sessionAttention'
import { showHostNotification } from './nexusBridgeActions'
import { sessionDisplayTitle } from './SessionRows'
import { useUnsavedEditsGate } from '@/glic/unsavedEditsGate'
import {
  createGlobalDefaultMirror,
  followGlobalDefault,
  writeGlobalDefault,
} from './globalDefaultSelection'
import {
  createProvidersReadGate,
  isProvidersChangedEvent,
  providersChangeAffectsCatalog,
} from './settings/clients'
import type { NexusProviderConfig } from '../../settings/settingsTypes'
import {
  getProviderMissingPrompt,
  openSessionTab,
  openUrl,
  setActiveSessionTitle,
  setWindowDragRegions,
  pickProjectFolder,
  revealProjectFolder,
  subscribeAgentConfig,
  subscribeSessionTabsChanged,
} from './nexusBridgeActions'
import { WebviewArea } from './WebviewArea'
import { postMainContentsLayout } from './useMainContentsLayout'
import {
  applyE2eTestCodePrefix,
  formatWindowTitle,
  getE2eTestCode,
  resolveActiveSessionWindowTitle,
  subscribeE2eTestCode,
} from './windowTitle'
import { getProductName } from '../../branding/productName'
import { signalFirstScreen } from '../boot/firstScreenSignal'
import { addRecentFolder } from './recentFoldersStorage'
import { writeLastFolderForType } from './lastFolderByTypeStorage'
import { isForcedFolderTemplateType } from '../../utils/conversationStoragePaths'
import {
  addProject,
  removeProject,
  projectDisplayName,
} from './projectsStorage'
import { useWorkspaceState } from './workspaceStore'
import { normalizeProjectPath } from './projectTree'
import { RUNTIME_DIR_NAME } from '../../branding/runtimeDir'
import { Button } from '@/components/ui/button'
import { PlusIcon } from 'lucide-react'
import { NexusTopBar } from './topbar/NexusTopBar'
import {
  IMPORT_SOURCE_META,
  importSourceIconSvg,
} from './sessionImport/sourceMeta'
import type { ImportSource } from '../bridge/protocol/sessionImport'
import { useDetectedImportSources } from './sessionImport/useDetectedImportSources'
import { useTranscriptSearchGate } from './topbar/useTranscriptSearchGate'
// Background sub-agents are rendered PER-SESSION inside AssistantUiThread (a
// child of the session's UI), not as a shell-global bar. The shell only owns
// the cross-session `subAgentRows` feed (deduped via `subAgentsEqual`) and
// hands it to each mounted thread, which filters to its own session.
import {
  countRunning,
  filterSubAgentRowsBySession,
  subAgentsEqual,
} from './backgroundSubAgents'
import { resolvePlanApproval } from '@/permissions/planApproval'
import { createPlanAutoOpenGate } from './planAutoOpenGate'
import { snapshotNeedsAnswer } from '@/utils/sessionNeedsAnswer'
import { writeClipboard } from '@/utils/clipboard'
import { randomUuid } from '@/utils/randomUuid'
import type {
  NexusSessionSkillRow,
  NexusTaskDetail,
  NexusTaskInfo,
  NexusTaskSummaryRow,
  NexusTaskTranscriptEntry,
} from '../bridge/protocol/ui'
import {
  buildSessionSkillPanelList,
  restoreSessionSkillsFromTranscript,
  sessionSkillsEqual,
  type SkillPanelListRow,
} from './sessionSkills'
// Settings, the right panel and the import dialog load on demand — see
// `coldUi.ts` for the measurement and for why the prefetch below is part of
// the same change rather than an optimization on top of it.
import {
  ImportDialog,
  SettingsScreen,
  prefetchColdUi,
  SidePaneBody,
  FilesPane,
} from './coldUi'
// Type-only, so it adds no edge to the emitted graph and the split holds.
import type { SettingsSectionId } from './settings/SettingsScreen'
import { isSettingsSectionVisible } from './settings/settingsNav'
import { useRemoteAccessView } from './remote/remoteAccessView'
import type { DrivenDesktop } from './remote/hostIdentity'
import {
  NexusSettingsBridge,
  SettingsBridgeContext,
  SettingsHostActionsContext,
  SettingsSessionContext,
  type SettingsHostActions,
} from './nexusSettingsBridge'
import { NEXUS_MODEL_CONFIG } from '../../config/nexusModelConfig'
import { useSessionManager } from './useSessionManager'
import { useMultiSessionClients } from './useMultiSessionClients'
import { shouldDismissBootWelcome } from './assistantUiAdapter'
import { createSessionMessageCallbackFactory } from './sessionMessageCallbacks'
import { createForkSendRegistry, deliverForkSend } from './forkSend'
import {
  isRestoredSessionPointer,
  readStoredActiveSessionId,
  resolveBootSession,
  writeStoredActiveSessionId,
} from './bootSessionPointer'
import { useT } from './i18n'
import { useAttachModContributions } from './mods/modContributionsView'
import type { ModsPressTopbarResult } from '../runtimeProtocol/modContributions'
import {
  getBootDiagnosticTraceId,
  installSessionTracer,
} from '../../utils/sessionTrace'
import { useClientActivityReport } from './clientActivityReport'

/**
 * An opaque identity of what a snapshot is halted ON — the ids of its pending
 * tool-use confirms, permissions, plan approvals and user interactions, in a
 * stable order. Two snapshots halted on the same asks give the same key; a
 * new ask after an answer gives a different one. Empty when nothing pends.
 * Feeds `needsInputKeys` of the attention reconcile — the counterpart of
 * `snapshotNeedsAnswer`, which only says THAT the session is halted.
 */
function snapshotAskKey(
  snapshot: Parameters<typeof snapshotNeedsAnswer>[0],
): string {
  if (!snapshot) return ''
  const ids = [
    ...(snapshot.approvalQueue ?? []).map(item => item.approvalCallId),
    ...Object.keys(snapshot.pendingPermissions ?? {}),
    ...Object.keys(snapshot.pendingPlanApproval ?? {}),
    ...Object.keys(snapshot.pendingUserInteraction ?? {}),
  ]
  return ids.sort().join('\u0000')
}


export type MultiSessionShellProps = {
  createWorkerTransport: () => BrowserWorkerClientTransport
  hostBridgeTransport: BrowserBridgeTransport
  /** File access over `fsx` — see `BrowserRuntimeClientOptions.files`. */
  files?: RuntimeFileAccess
  createInitPayload: (sessionId: string) => AgentRuntimeWorkerInitPayload
  openingSessionId?: string
  title?: string
  /**
   * The session list, fork / rename / delete and the background-task drawer
   * on the runtime connection — what used to be
   * posted straight to the (deleted) `sharedWorkerPort` prop.
   */
  sessionChannel?: SessionListChannel
  /** The session status feed (topbar pill, composer gate) — see `SessionStatusChannelContext`. */
  sessionStatusChannel?: SessionStatusChannel
  /** The settings capabilities on the runtime connection (`SettingsBridgeContext`). */
  settingsBridge?: NexusSettingsBridge
  /**
   * The page's ONE runtime connection: its STATE drives the reconnect banner and the composer
   * gate, its `welcome` capability list drives `useCan`. Omitted ⇒ "allowed" and "ready".
   */
  runtimeConnection?: () => Promise<RuntimeConnection>
  /** The window chrome around this guest (`shell.*`): layout, boot progress, the reveal. */
  shellChannel?: ShellChannel
  /** Host advertises the `search` bridge capability (span-index
   *  transcript search). Gates the topbar button + Ctrl+K so the guest
   *  degrades cleanly against an older binary. */
  searchCapable?: boolean
  /**
   * This page is a REMOTE client, and this is the desktop it drives (F-24).
   * Only the remote boot passes it; the desktop panel never does. It swaps
   * the topbar's connected-devices button for the host indicator — see
   * `RemoteHostIndicator`'s header for why page identity, not capability, is
   * the predicate for that one.
   */
  remoteHost?: DrivenDesktop
  /** Forget this device's pairing and hand the page back to the connect
   *  screen. Passed with `remoteHost` and only by the remote boot. */
  onRemoteLogOut?: () => void
  onSubmitPromptReady?: ((submitPrompt: ((prompt: string) => Promise<void>) | null) => void)
  /**
   * Fires exactly once, the first time the React shell reaches an
   * "interactive moment": active session client is `ready`, the worker
   * snapshot has arrived, and the SharedWorker has flushed at least one
   * session list. Used by the host to dismiss the boot welcome and reveal
   * the rest of the parent WebUI's layout.
   */
  onGuestFullyReady?: () => void
  /**
   * Report a real boot milestone to the host's boot-welcome footer (`sessions`, `opening`,
   * `finalizing`; `nexusBoot` fires `rendering`). Fire-and-forget; no timer.
   */
  onBootStage?: (stage: 'rendering' | 'sessions' | 'opening' | 'finalizing') => void
}

// The "last active session" pointer lives in `bootSessionPointer.ts` — key,
// read, write, and the durability caveat that makes a restored id a hint.
const NEXUS_ACTIVE_SESSION_CHANGED_EVENT = 'nexus:activeSessionChanged'

// Wide-mode docked-sidebar collapse state. Only mutated when the user
// clicks the toggle in wide mode; narrow-mode forced collapses do NOT
// touch this so the wide-mode preference is preserved across resizes.
const SIDEBAR_COLLAPSED_STORAGE_KEY = 'shift-sidebar-collapsed'

// Wide-mode sidebar width (px). Persists across reloads; mirrors the
// collapse pref's behavior — only written when the splitter is actually
// usable (i.e. wide viewport + sidebar expanded). Narrow-mode auto-
// collapses hide the splitter entirely, so the saved width survives a
// resize round-trip.
const SIDEBAR_WIDTH_STORAGE_KEY = 'shift-sidebar-width'

function readSavedSidebarCollapsed(): boolean {
  try {
    return globalThis.localStorage?.getItem(SIDEBAR_COLLAPSED_STORAGE_KEY) === '1'
  } catch {
    return false
  }
}

function writeSavedSidebarCollapsed(collapsed: boolean): void {
  try {
    globalThis.localStorage?.setItem(
      SIDEBAR_COLLAPSED_STORAGE_KEY,
      collapsed ? '1' : '0',
    )
  } catch {
    // localStorage may be unavailable; persistence is best-effort.
  }
}

function readSavedSidebarWidth(): number {
  try {
    const raw = globalThis.localStorage?.getItem(SIDEBAR_WIDTH_STORAGE_KEY)
    if (raw == null) return SIDEBAR_DEFAULT_WIDTH_PX
    const parsed = Number(raw)
    if (!Number.isFinite(parsed)) return SIDEBAR_DEFAULT_WIDTH_PX
    return clampSidebarWidth(parsed)
  } catch {
    return SIDEBAR_DEFAULT_WIDTH_PX
  }
}

function writeSavedSidebarWidth(width: number): void {
  try {
    globalThis.localStorage?.setItem(
      SIDEBAR_WIDTH_STORAGE_KEY,
      String(Math.round(width)),
    )
  } catch {
    // localStorage may be unavailable; persistence is best-effort.
  }
}

/**
 * Number of recent thread trees kept mounted: switching among them is a `display:` toggle;
 * an evicted session pays a full remount. Each mounted tree costs ~10 MB.
 */
const MAX_MOUNTED_THREADS = 5

// Boot-splash logic was reverted — multiple iterations didn't
// reliably eliminate the right-panel welcome flash. We're now in
// "instrument and observe" mode: see the diagnostic console traces
// inside the component for the timeline of state transitions, then
// fix once we understand the actual race.

function getTranscriptUpdatedAt(state: BrowserRuntimeClientState): number {
  for (let index = state.transcriptMessages.length - 1; index >= 0; index -= 1) {
    const timestamp = (
      state.transcriptMessages[index] as { timestamp?: unknown } | undefined
    )?.timestamp
    if (typeof timestamp !== 'string') {
      continue
    }

    const parsed = Date.parse(timestamp)
    if (Number.isFinite(parsed)) {
      return parsed
    }
  }

  return Date.now()
}

/**
 * Per-session, in-memory pane content that is not layout (F-9): the Diff and
 * Skill targets and a file's reveal request. The layout itself is the
 * session's persisted record (`sessionLayouts`).
 */
interface PaneSessionUi {
  // The diff the Diff pane shows: the last one the person opened.
  diffTarget: RightPanelDiffTarget | null
  // The skill whose instructions the Skill pane shows (Skill card "View skill").
  skillTarget: RightPanelSkillTarget | null
  // Line-reveal request for a file, from a `path:42` transcript mention. The
  // nonce edge-triggers delivery, so clicking the same `path:42` twice
  // re-centers.
  fileReveal: { path: string; line: number; nonce: number } | null
}

const EMPTY_PANE_UI: PaneSessionUi = { diffTarget: null, skillTarget: null, fileReveal: null }

const EMPTY_FILES_PANE: FilesPaneState = emptyFilesPane()

export function MultiSessionShell({
  createWorkerTransport,
  hostBridgeTransport,
  files,
  createInitPayload,
  openingSessionId,
  sessionChannel,
  sessionStatusChannel,
  settingsBridge,
  runtimeConnection,
  shellChannel,
  searchCapable,
  remoteHost,
  onRemoteLogOut,
  onSubmitPromptReady,
  onGuestFullyReady,
  onBootStage,
}: MultiSessionShellProps) {
  const t = useT()
  // The two things read off the runtime connection. Both are inert on
  // the desktop — `ready` forever, and a `full` grant — so this adds a seam
  // for the remote client without changing desktop behaviour.
  const connectionState = useRuntimeConnectionState(runtimeConnection)
  const handleReconnectNow = useCallback(() => {
    void runtimeConnection?.().then(
      connection => connection.reconnectNow(),
      () => {
        // No connection to hurry — the overlay only shows over a live one.
      },
    )
  }, [runtimeConnection])
  const runtimeCapabilities = useCapabilityQuery(runtimeConnection)
  // F-25: the launchers and topbar items of the person's plugins, one store
  // for the whole page; the bundled launchers never wait for it.
  useAttachModContributions(runtimeConnection)
  const handlePressPluginItem = useCallback(
    async (sessionId: string, id: string): Promise<ModsPressTopbarResult> => {
      if (!runtimeConnection) return { ok: false, reason: 'no-session' }
      const connection = await runtimeConnection()
      return connection.request<ModsPressTopbarResult>('mods.pressTopbar', { sessionId, id })
    },
    [runtimeConnection],
  )
  // F-24: remote devices connected to this desktop, for the topbar's link
  // button. Read from the page's shared remote/state store, and only by a
  // connection that may read the topic at all (the desktop, a manager). The
  // count is 0 unless the Remote access page is one this connection may open —
  // the button's click goes there, and must not land anywhere else.
  const { view: remoteAccessView } = useRemoteAccessView(
    runtimeConnection,
    runtimeCapabilities.can('remote', 'pairList'),
  )
  const remoteDeviceCount =
    remoteAccessView?.access.enabled &&
    isSettingsSectionVisible(
      'remoteAccess',
      runtimeCapabilities,
      remoteAccessView.access.supported === true,
      undefined,
      remoteHost !== undefined,
    )
      ? remoteAccessView.access.clients
      : 0
  // The boot session, plus whether its id was RESTORED from the persisted
  // pointer rather than minted here. The distinction is load-bearing: a
  // restored id can name a session that no longer exists, so the runtime must
  // not treat "no record on disk" as "brand-new session" for it and re-create
  // a deleted session's directory. See `bootSessionPointer.ts` for why the
  // pointer cannot be trusted, `restoredSessionId` in `workerProtocol.ts` for
  // what the flag means, and `appendSessionMetadataEntry` for the guard.
  const bootSession = useMemo(
    () =>
      resolveBootSession({
        initialSessionId: openingSessionId,
        storedSessionId: readStoredActiveSessionId(),
        mintSessionId: () => randomUuid(),
      }),
    [openingSessionId],
  )
  const resolvedInitialSessionId = bootSession.sessionId
  const [browserDefaultSelection, setBrowserDefaultSelection] =
    useState<BrowserLlmSelection | null>(null)
  const [sharedModelCatalog, setSharedModelCatalog] =
    useState<BrowserLlmCatalog | null>(null)
  const defaultSelectionRef = useRef(browserDefaultSelection)
  defaultSelectionRef.current = browserDefaultSelection
  const sharedModelCatalogRef = useRef(sharedModelCatalog)
  sharedModelCatalogRef.current = sharedModelCatalog
  // The GLOBAL default a new session starts on: the last TOPBAR pick, settings.json
  // `agent.model`, owned by the runtime and mirrored here (`globalDefaultSelection.ts`). The
  // composer's effort control never moves it (F-12). `null` until the user has picked once.
  const [globalDefaultSelection, setGlobalDefaultSelection] =
    useState<BrowserLlmSelection | null>(null)
  const globalDefaultSelectionRef = useRef(globalDefaultSelection)
  globalDefaultSelectionRef.current = globalDefaultSelection
  const settingsBridgeRef = useRef(settingsBridge)
  settingsBridgeRef.current = settingsBridge
  const [globalDefaultMirror] = useState(() =>
    createGlobalDefaultMirror(selection => {
      globalDefaultSelectionRef.current = selection
      setGlobalDefaultSelection(selection)
    }),
  )
  // This page's pick of the global default: shown at once, written by the
  // runtime, and published back to every page (this one included).
  const pickGlobalDefaultSelection = useCallback(
    (selection: BrowserLlmSelection) => {
      globalDefaultMirror.pick(selection, () =>
        writeGlobalDefault(settingsBridgeRef.current, selection),
      )
    },
    [globalDefaultMirror],
  )
  // The ACTIVE session's last defined selection — the last-resort seed for a
  // new thread while neither the global default nor the catalog default is
  // known yet (early boot). Updated below once `activeSelection` is computed.
  const activeSelectionRef = useRef<BrowserLlmSelection | null | undefined>(
    undefined,
  )

  // The raw port still carries the main-contents layout;
  // session-list traffic and presence ride `sessionChannel`.
  // The window chrome's channel: layout frames, boot progress, the reveal.
  const shellChannelRef = useRef<ShellChannel | null>(shellChannel ?? null)
  shellChannelRef.current = shellChannel ?? null
  const sessionChannelRef = useRef<SessionListChannel | null>(sessionChannel ?? null)
  sessionChannelRef.current = sessionChannel ?? null

  const handleRequestDelete = useCallback(
    (sessionId: string, requestId: string) => {
      sessionChannelRef.current?.request('session.delete', { sessionId, requestId })
    },
    [],
  )

  const handleRequestRename = useCallback(
    (sessionId: string, title: string, requestId: string) => {
      sessionChannelRef.current?.request('session.rename', {
        sessionId,
        title,
        requestId,
      })
    },
    [],
  )

  // Pinned state is the runtime's: the row moves once its `session.updated`
  // carries the new flag.
  const handlePinThread = useCallback((sessionId: string, pinned: boolean) => {
    sessionChannelRef.current?.request('session.pin', {
      sessionId,
      pinned,
      requestId: randomUuid(),
    })
  }, [])

  // "Fork from here" stops BEFORE the cut message and returns its text to the new composer;
  // the fork is titled "<title> (fork)". Rewind posts the same message without the flag or a
  // title (it replaces the original). "Send in a forked session" (`keepCutMessage`) copies
  // the whole conversation, as does the sidebar's Fork, which names no cut at all.
  // Fork requests this window sent. Every client on the sessions topic hears
  // `session.forked`; only the one that asked switches to the copy.
  const ownForkRequestsRef = useRef<Set<string>>(new Set())
  const handleRequestFork = useCallback(
    (
      fromSessionId: string,
      cutUuid: string | undefined,
      requestId: string,
      sourceTitle?: string,
      keepCutMessage?: boolean,
    ) => {
      ownForkRequestsRef.current.add(requestId)
      sessionChannelRef.current?.request('session.fork', {
        fromSessionId,
        ...(cutUuid !== undefined ? { cutUuid } : {}),
        requestId,
        ...(keepCutMessage ? {} : { moveCutMessageToDraft: true }),
        ...(sourceTitle
          ? { title: t('session.forkTitle', { title: sourceTitle }) }
          : {}),
      })
    },
    [t],
  )

  // Human-initiated background sub-agent control (the Background Tasks drawer).
  // Posts to the SharedWorker, which routes to the existing manager
  // stopSubAgent / resumeSubAgent; the row flips on the next session.summary.
  const handleStopSubAgent = useCallback((subAgentSessionId: string) => {
    sessionChannelRef.current?.request('task.stop', {
      sessionId: subAgentSessionId,
      requestId: randomUuid(),
    })
  }, [])

  const handleResumeSubAgent = useCallback(
    (subAgentSessionId: string, prompt: string) => {
      sessionChannelRef.current?.request('task.resume', {
        sessionId: subAgentSessionId,
        prompt,
        requestId: randomUuid(),
      })
    },
    [],
  )

  // Pending `task.transcript` requests, keyed by requestId, resolved when
  // the worker replies (see the `task.transcript` branch in
  // handleWorkerMessage). Drives the drawer's read-only detail view.
  const subAgentTranscriptWaitersRef = useRef<
    Map<string, (detail: NexusTaskDetail | null) => void>
  >(new Map())
  const handleLoadSubAgentTranscript = useCallback(
    (
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
    },
    [],
  )

  // Rewind = fork at the cut, then drop the original. We reuse `session.fork`
  // and remember which requestIds are rewinds (requestId → original sessionId);
  // when the `session.forked` ack lands we delete the original and switch to
  // the truncated copy.
  const pendingRewindRef = useRef<Map<string, string>>(new Map())
  // Fork-sends (the composer's Ctrl/Cmd+Alt+Enter) waiting on their
  // `session.forked` ack: the message to send into the new session.
  // Read through a ref: the worker-message effect below does not re-subscribe
  // when the clients hook hands out a new function.
  const submitComposerMessageToSessionRef = useRef<
    (sessionId: string, message: AppendMessage) => Promise<void>
  >(async () => {})
  const [forkSendRegistry] = useState(() =>
    createForkSendRegistry<AppendMessage>(),
  )
  const handleRewindFromMessage = useCallback(
    (fromSessionId: string, cutUuid: string) => {
      const requestId = randomUuid()
      pendingRewindRef.current.set(requestId, fromSessionId)
      sessionChannelRef.current?.request('session.fork', {
        fromSessionId,
        cutUuid,
        requestId,
        replacesSource: true,
      })
    },
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
    openingSessionId: resolvedInitialSessionId,
    onRequestDelete: handleRequestDelete,
    onRequestRename: handleRequestRename,
    onRequestFork: handleRequestFork,
  })

  const shutdownSessionIds = useMemo(
    () =>
      new Set(
        sessions
          .filter(session => session.shutdown)
          .map(session => session.sessionId),
      ),
    [sessions],
  )

  // LRU of recent active sessions. The active is always at the front;
  // when the user switches to a fresh session, the oldest is evicted
  // beyond MAX_MOUNTED_THREADS. Each id in this array gets a mounted
  // thread tree below — the active one is visible, the rest are
  // `display: none` so flipping back is a paint-toggle, not a remount.
  const [mountedSessionIds, setMountedSessionIds] = useState<string[]>(
    () => [resolvedInitialSessionId],
  )

  // Per-session "is the agent currently doing something" flag. Sourced
  // from the SharedWorker's `session.summary` broadcast (which derives
  // it from streaming + inflight tool calls). Drives the shimmer
  // overlay on each row in the sidebar / popover so the user can see
  // at a glance which thread is busy without having to switch.
  const [runningSessionIds, setRunningSessionIds] = useState<
    ReadonlySet<string>
  >(() => new Set())
  // Every session a summary reported running since the ended-question
  // detector's last pass. Collected per message, because React may render a
  // short turn's `running: true` and `running: false` summaries as one
  // update — `runningSessionIds` then never shows the session at all.
  const runningSeenSinceDetectRef = useRef<Set<string>>(new Set())

  // Worker-derived "halted waiting on the user" flags from the same summary
  // broadcast. This is the source that keeps the sidebar's "needs your
  // response" dot working for sessions whose CLIENT was disposed by the
  // mount-LRU — the client-derived signal below only covers sessions that
  // still have one.
  const [summaryNeedsAnswerIds, setSummaryNeedsAnswerIds] = useState<
    ReadonlySet<string>
  >(() => new Set())

  // Per-session "has an unanswered AskUserQuestion" flag, reported up from each
  // mounted thread's pending-questions store (that state doesn't ride the
  // worker snapshot, unlike plan/permission approvals). Unioned with the
  // snapshot-derived halts to drive the session-list "needs your response" dot.
  const [sessionsWithPendingQuestions, setSessionsWithPendingQuestions] =
    useState<ReadonlySet<string>>(() => new Set())
  const handlePendingQuestionsChange = useCallback(
    (sessionId: string, hasPending: boolean) => {
      setSessionsWithPendingQuestions(prev => {
        if (prev.has(sessionId) === hasPending) return prev
        const next = new Set(prev)
        if (hasPending) next.add(sessionId)
        else next.delete(sessionId)
        return next
      })
    },
    [],
  )

  // Background sub-agents across sessions (G2/G5 human-facing surface), sourced
  // from the `session.summary` broadcast. Feeds the global Background Tasks
  // drawer (and the topbar running-count badge).
  const [subAgentRows, setSubAgentRows] = useState<
    readonly NexusTaskSummaryRow[]
  >(() => [])
  const [backgroundTaskFocusSessionId, setBackgroundTaskFocusSessionId] =
    useState<string | null>(null)

  // Skills invoked per session, sourced from the same `session.summary`
  // broadcast. Feeds the Skill panel's "loaded in this session" list.
  const [sessionSkillRows, setSessionSkillRows] = useState<
    readonly NexusSessionSkillRow[]
  >(() => [])

  // The person's sidebar choice (expanded / icon rail), persisted. The drawn
  // form comes from `resolveShellLayout`: a narrow session area hides the
  // sidebar without touching this choice, and the topbar toggle then opens
  // the peek drawer instead (F-9).
  const [sidebarCollapsed, setSidebarCollapsed] = useState(readSavedSidebarCollapsed)
  const [sidebarPeek, setSidebarPeek] = useState(false)
  const sidebarHiddenRef = useRef(false)
  const sidebarRailRef = useRef(false)
  // How the open Right Panel is presented beyond its docked form (F-9): the
  // overlay over the chat when it has no room beside it, an agent-opened
  // float, a settled float's held width. Each writer reports its event.
  const [rightPanelPresence, presentRightPanel] = useReducer(
    stepRightPanelPresence,
    undefined,
    initialRightPanelPresence,
  )
  const rightPanelPresenceRef = useRef(rightPanelPresence)
  rightPanelPresenceRef.current = rightPanelPresence
  const handleToggleSidebar = useCallback(() => {
    if (sidebarHiddenRef.current) {
      setSidebarPeek(open => !open)
      return
    }
    setSidebarCollapsed(prev => {
      writeSavedSidebarCollapsed(!prev)
      return !prev
    })
  }, [])
  // The session area's width, which the whole shell layout follows. A hidden
  // area (Settings open) reports 0 and is ignored: the last width stands.
  const [sessionAreaWidth, setSessionAreaWidth] = useState(readViewportWidth)
  const sessionAreaObserverRef = useRef<ResizeObserver | null>(null)
  const sessionAreaRef = useCallback((node: HTMLDivElement | null) => {
    sessionAreaObserverRef.current?.disconnect()
    sessionAreaObserverRef.current = null
    if (!node || typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(entries => {
      const width = Math.round(entries[entries.length - 1]?.contentRect.width ?? 0)
      if (width > 0) setSessionAreaWidth(width)
    })
    observer.observe(node)
    sessionAreaObserverRef.current = observer
  }, [])

  // Draggable sidebar width. Lives at shell scope so the splitter
  // (rendered between the lifted Sidebar and the conversation section)
  // and the Sidebar itself read the same value. Persisted on drag-end
  // and on every keyboard step; pointermove updates state without
  // hitting localStorage so a fast drag doesn't thrash storage.
  const [sidebarWidth, setSidebarWidth] = useState(() => readSavedSidebarWidth())
  const [isResizingSidebar, setIsResizingSidebar] = useState(false)
  // Mirrors `isResizingSidebar` for the resize callback. The callback
  // closes over its deps once per change; using state in the closure
  // would mean keyboard ArrowLeft/Right (which fires without a prior
  // resize-start) sees `isResizingSidebar=false` and persists every
  // step — fine — while pointermove during a drag sees `true` and
  // skips persistence. A ref keeps both reads synchronous without an
  // extra dep on the callback.
  const isResizingSidebarRef = useRef(false)
  isResizingSidebarRef.current = isResizingSidebar

  const handleSidebarResize = useCallback((width: number) => {
    setSidebarWidth(width)
    // Pointer-drag path: skip storage writes mid-drag — drag-end
    // persists the final value. Keyboard path: persist every step
    // (cheap; one localStorage write per ArrowLeft/Right is fine).
    if (!isResizingSidebarRef.current) {
      writeSavedSidebarWidth(width)
    }
  }, [])
  const handleSidebarResizeStart = useCallback(() => {
    setIsResizingSidebar(true)
  }, [])
  const handleSidebarResizeEnd = useCallback(() => {
    setIsResizingSidebar(false)
    writeSavedSidebarWidth(sidebarWidth)
  }, [sidebarWidth])

  // Per-session browser-tab counts, keyed by sessionId. `nexus` (tabs
  // hosted in the kNexus window) gates the session's browser pane: the
  // pane is drawn only while it is > 0, and a change above zero places it
  // (`followBrowserTabs`). Seeded by every
  // `session.setActiveSession` response; kept live by the host-pushed
  // `browser.sessionTabsChanged` events (first tab from a browser tool,
  // tab closed, tab dragged between windows, session deleted).
  const [sessionTabCounts, setSessionTabCounts] = useState<
    ReadonlyMap<string, { nexus: number; total: number }>
  >(() => new Map())
  const mergeSessionTabCounts = useCallback(
    (sessionId: string, nexus: number, total: number) => {
      setSessionTabCounts(prev => {
        const existing = prev.get(sessionId)
        if (existing && existing.nexus === nexus && existing.total === total) {
          return prev
        }
        const next = new Map(prev)
        next.set(sessionId, { nexus, total })
        return next
      })
    },
    [],
  )

  // Warm the on-demand panel chunks (settings, right panel, import dialog)
  // once the shell is up and the main thread goes idle. This is the other half
  // of the split in `coldUi.ts`, not an optimization layered on top of it: a
  // lazy boundary whose chunk is first fetched when the user clicks is the
  // regression `Sidebar.tsx` reverted — a visible multi-second Suspense stall.
  // Warming here means the click resolves from the module map instead.
  useEffect(() => prefetchColdUi(), [])


  useEffect(() => {
    setMountedSessionIds(prev => {
      if (prev[0] === activeSessionId) return prev
      const filtered = prev.filter(id => id !== activeSessionId)
      const next = [activeSessionId, ...filtered]
      return next.length > MAX_MOUNTED_THREADS
        ? next.slice(0, MAX_MOUNTED_THREADS)
        : next
    })
  }, [activeSessionId])

  // Render-commit timing: the ref is written each render and the dep-less layout effect reads
  // it before paint, joined to the current session.switch trace.
  const renderStartRef = useRef(0)
  renderStartRef.current = performance.now()
  // Boot-welcome footer: latest onBootStage reporter (a stable prop, but read
  // via a ref so the long-lived session.list message-listener effect below
  // never captures a stale closure) plus a once-guard so the `sessions` stage
  // fires only on the FIRST session.list, not on every later diff broadcast.
  const onBootStageRef = useRef(onBootStage)
  onBootStageRef.current = onBootStage
  const bootSessionsStageFiredRef = useRef(false)
  useLayoutEffect(() => {
    const tracer = installSessionTracer({ context: 'ui' })
    const ctx = tracer.getCurrentTraceContext()
    // Only record when a session.switch trace is currently active.
    // Idle re-renders (initial mount, prop noise, hot-reload) would
    // otherwise each create their own orphan traceId and flood the
    // overlay's dropdown with junk.
    if (!ctx) return
    const ms = performance.now() - renderStartRef.current
    tracer.event('ui.shell.render.commit', {
      traceId: ctx.traceId,
      parentSpanId: ctx.parentSpanId,
      attrs: { ms: Math.round(ms * 100) / 100, activeSessionId },
    })
  })

  useEffect(() => {
    writeStoredActiveSessionId(activeSessionId)
  }, [activeSessionId])

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

  // Mirror the active session to the HOST (boot + every switch), which seeds
  // the map above. Not sent without `session.setActiveSession`.
  useActiveSessionOnHost(
    hostBridgeTransport,
    activeSessionId,
    runtimeCapabilities,
    mergeSessionTabCounts,
  )

  // Live per-session tab-count feed from the host's tab tracker.
  useEffect(() => {
    return subscribeSessionTabsChanged(hostBridgeTransport, event => {
      mergeSessionTabCounts(
        event.sessionId,
        event.nexusTabCount,
        event.totalTabCount,
      )
    })
  }, [hostBridgeTransport, mergeSessionTabCounts])

  // Transcript search anchors its targets at the host home — the runtime's
  // answer over `fsx`, like every other file question the page asks.
  const resolveSearchHomeDir = useCallback(
    (): Promise<string> =>
      files
        ? files.userHome()
        : Promise.reject(new Error('fsx: the shell was built without file access')),
    [files],
  )

  const createSessionInitPayload = useCallback(
    (sessionId: string) => {
      const payload = createInitPayload(sessionId)
      // Seed from the GLOBAL default (the last topbar pick, model + effort),
      // then the catalog default, then — early boot only — the active
      // session's selection. NOT the active session first: its effort may be
      // a per-session composer override that must not leak into new
      // sessions. An existing session reopened with this payload keeps its
      // own persisted model + effort (`resolveSelection` /
      // `mergeRequestedTier`).
      const defaultSelection =
        globalDefaultSelectionRef.current ??
        defaultSelectionRef.current ??
        activeSelectionRef.current
      const effectiveTemplateType =
        getSessionTemplateType(sessionId) ?? payload.templateType
      // The folder this page KNOWS for the session (one it persisted, or one it
      // was just created bound to). With none, the runtime decides at
      // `session.open`: a forced-folder type (`code`/`safe_code`) inherits the
      // user's last folder of that type, every other type opens in its per-type
      // shared workspace (`worker/sessionOpenComposer.ts`).
      const autoProjectRoot = getSessionProjectRoot(sessionId)
      return {
        ...payload,
        ...(defaultSelection
          ? {
              userSpecifiedProviderId: defaultSelection.providerId,
              userSpecifiedModel: defaultSelection.modelId,
              // Carry the user's current reasoning-effort over so a brand-
              // new session inherits the same tier instead of resetting to
              // the model's catalog default (or no tier at all).
              ...(defaultSelection.thinkingTier
                ? {
                    userSpecifiedThinkingTier: defaultSelection.thinkingTier,
                  }
                : {}),
            }
          : {}),
        initialModelCatalog:
          sharedModelCatalogRef.current ?? payload.initialModelCatalog,
        // Per-session agent template chosen by the thread launcher (selects
        // the prompt + tools). Falls back to the boot-default templateType.
        templateType: effectiveTemplateType,
        ...(autoProjectRoot ? { projectRoot: autoProjectRoot } : {}),
        // ONLY the session restored from the persisted pointer carries this.
        // Every other id in this document was minted here — by `openNewSession`
        // or by the boot fallback — so an absent record genuinely means "new"
        // and must still be created at bind. Narrow here is not enough on its
        // own: the worker replays this payload under minted ids for every
        // background spawn, so `commitInitTemplate` scrubs the flag out of
        // `lastInitTemplate` (F-17).
        ...(isRestoredSessionPointer(bootSession, sessionId)
          ? { restoredSessionId: true }
          : {}),
      }
    },
    [
      bootSession,
      createInitPayload,
      getSessionTemplateType,
      getSessionProjectRoot,
    ],
  )

  const {
    activeState,
    sessionStates,
    submitPrompt,
    submitActionMessage,
    continueConversation,
    submitComposerMessage,
    submitComposerMessageToSession,
    submitToolResult,
    loadToolCallDetail,
    loadTurnDiffDetail,
    requestTurnDiffHistory,
    loadBundledSkillBody,
    readFileText,
    statFilePaths,
    writeFileText,
    pickComposerAttachmentFiles,
    setModelSelection,
    setModelSelectionForSession,
    setAutoCompactWindowForSession,
    setPermissionMode,
    setSkipDangerousMode,
    clearPendingMessage,
    removeInjectMessage,
    resolveToolUseConfirm,
    clearPlanApproval,
    refreshModelCatalog,
    refreshProjectBranch,
    // applyRuntimeSettings was the WebUI-side handler for the legacy
    // C++ pref-observer fan-out (`session.applyAgentConfig` carried
    // maxTurns). Post-Path 2 those keys ride the
    // `agent.changed` broadcast directly to `applyAgentSettingsToAllSessions`,
    // so the shell no longer needs to re-route them. The hook still
    // exposes the method for tests + any future direct caller.
    restartRuntime,
    rebindProjectFolder,
    interrupt,
    updateSessionMetadata,
    disposeClient,
  } = useMultiSessionClients({
    activeSessionId,
    shutdownSessionIds,
    mountedSessionIds,
    createWorkerTransport,
    hostBridgeTransport,
    files,
    createInitPayload: createSessionInitPayload,
    onSessionStateChange: useCallback(
      (
        sessionId: string,
        state: BrowserRuntimeClientState,
        metadata: BrowserSessionMetadata,
      ) => {
        updateSessionMeta(sessionId, {
          title: metadata.firstPrompt || 'New Thread',
          previewText: metadata.previewText || metadata.firstPrompt || '',
          updatedAt: getTranscriptUpdatedAt(state),
          // Forward the live transcript length (or a pending prompt) so `openNewSession` never
          // reuses a thread that is no longer empty.
          messageCount: Math.max(
            state.transcriptMessages.length,
            typeof metadata.messageCount === 'number' ? metadata.messageCount : 0,
          ),
        })
      },
      [updateSessionMeta],
    ),
  })
  submitComposerMessageToSessionRef.current = submitComposerMessageToSession

  // -- DIAGNOSTIC TRACING (no functional behavior — pure observation) --
  //
  // The boot-splash code that USED to live here didn't reliably
  // suppress the right-panel welcome flash. Each diagnostic event
  // attaches to a single shared `bootDiagnosticTraceId`, so the
  // user can copy ONE trace from the overlay (the one with name
  // prefix `boot.*`) instead of fishing console logs.
  useEffect(() => {
    const tracer = installSessionTracer({ context: 'ui' })
    tracer.event('boot.activeState.change', {
      traceId: getBootDiagnosticTraceId(),
      attrs: {
        sessionId: activeSessionId,
        status: activeState.status,
        snapshotMessageCount: activeState.snapshot?.messageCount ?? null,
        transcriptLength: activeState.transcriptMessages.length,
        pendingPrompt: activeState.pendingPrompt !== null,
      },
    })
    // Boot instrumentation: record the FIRST crossing of each phase boundary for the
    // boot.guestReady.signaled event; later session switches never overwrite it.
    const bootMarks = (globalThis as {
      __nexusBootMarks?: Record<string, number>
    }).__nexusBootMarks ?? {}
    let mutated = false
    if (
      bootMarks.workerSnapshotReadyMs == null &&
      activeState.status === 'ready' &&
      activeState.snapshot != null
    ) {
      bootMarks.workerSnapshotReadyMs = Date.now()
      mutated = true
      // Real milestone → boot-welcome footer: the active session's worker
      // snapshot (runtime + model catalog + session metadata) has arrived, so
      // the session is "opening" — the transcript load + first assistant-ui
      // paint remain. Guarded by `workerSnapshotReadyMs == null`, so this fires
      // exactly once per page life (not on later session switches).
      // Fire-and-forget.
      onBootStage?.('opening')
    }
    if (
      bootMarks.transcriptMergedMs == null &&
      activeState.snapshot != null &&
      activeState.transcriptMessages.length >=
        activeState.snapshot.messageCount &&
      activeState.snapshot.messageCount > 0
    ) {
      bootMarks.transcriptMergedMs = Date.now()
      mutated = true
      // Real milestone → boot-welcome footer: the transcript is fully merged
      // and assistant-ui is now painting the conversation — the last step
      // before `onGuestFullyReady` dismisses the overlay, so "Almost ready…".
      // Only fires for sessions WITH messages (guarded by `messageCount > 0`);
      // an empty session reaches the interactive moment at snapshot-ready, so
      // its last shown stage is `opening`. Guarded once per page life.
      onBootStage?.('finalizing')
    }
    if (mutated) {
      ;(globalThis as {
        __nexusBootMarks?: Record<string, number>
      }).__nexusBootMarks = bootMarks
    }
  }, [activeState, activeSessionId, onBootStage])

  // -- BOOT-COMPLETE SIGNAL TO PARENT WEBUI --
  // Tell the parent to drop its welcome overlay once the shell is interactive: status ready,
  // a snapshot, and — when messageCount > 0 — ThreadWelcome unmounted. Fires once per page.
  const [threadWelcomeUnmounted, setThreadWelcomeUnmounted] = useState(false)
  // Only listen for ThreadWelcome unmount AFTER the gate conditions have
  // been met. Earlier unmounts (e.g. the loading→ready transition that
  // briefly unmounts ThreadWelcome before snapshot arrives, around the
  // 567 ms mark in the trace) are not the unmount we care about — we
  // want the unmount that fires when assistant-ui finally swaps in the
  // message list, which can only happen after snapshot + transcript are
  // loaded.
  const shouldArmThreadWelcomeUnmountListener =
    !threadWelcomeUnmounted &&
    activeState.status === 'ready' &&
    activeState.snapshot != null &&
    activeState.snapshot.messageCount > 0
  useEffect(() => {
    if (!shouldArmThreadWelcomeUnmountListener) return
    const handler = () => {
      setThreadWelcomeUnmounted(true)
      // Boot instrumentation: capture the "real" ThreadWelcome unmount
      // — i.e. the one that fires AFTER snapshot is loaded and assistant-
      // ui has actually swapped to the message list. The earlier capture
      // in thread.tsx fires on EVERY unmount including the loading→ready
      // transient, which produced a negative ms_merged_to_unmount delta
      // in the first run of this instrumentation. This listener is gated
      // by `shouldArmThreadWelcomeUnmountListener` so it can only fire
      // for the right unmount.
      const m = (globalThis as { __nexusBootMarks?: Record<string, number> })
        .__nexusBootMarks ?? {}
      if (m.threadWelcomeRealUnmountedMs == null) {
        m.threadWelcomeRealUnmountedMs = Date.now()
        ;(globalThis as { __nexusBootMarks?: Record<string, number> })
          .__nexusBootMarks = m
      }
    }
    globalThis.addEventListener(
      'nexus:threadWelcome:unmounted',
      handler as EventListener,
    )
    return () => {
      globalThis.removeEventListener(
        'nexus:threadWelcome:unmounted',
        handler as EventListener,
      )
    }
  }, [shouldArmThreadWelcomeUnmountListener])

  // Body-hydration gate: hold the overlay until the first AssistantMessageBody hydrates.
  // Empty threads never fire it; the dispatch gate handles `messageCount === 0`.
  const [bodyHydrated, setBodyHydrated] = useState(false)
  useEffect(() => {
    if (bodyHydrated) return
    const handler = () => setBodyHydrated(true)
    globalThis.addEventListener(
      'nexus:assistantMessageBody:firstHydrated',
      handler as EventListener,
    )
    return () => {
      globalThis.removeEventListener(
        'nexus:assistantMessageBody:firstHydrated',
        handler as EventListener,
      )
    }
  }, [bodyHydrated])

  const guestReadyFiredRef = useRef(false)
  useEffect(() => {
    if (guestReadyFiredRef.current) return
    // The status / snapshot preconditions belong to `shouldDismissBootWelcome` alone. Hold the
    // host overlay until painted content shows; event-driven, no wall-clock cap.
    if (
      !shouldDismissBootWelcome(activeState, {
        threadWelcomeUnmounted,
        bodyHydrated,
      })
    ) {
      return
    }

    guestReadyFiredRef.current = true
    if (typeof window !== 'undefined') signalFirstScreen(window)
    // E2e seam (a one-shot global write): record the active session's state at the instant
    // the host boot splash is dismissed, read after the boot completes.
    ;(globalThis as { __NEXUS_E2E_BOOT_DISMISS__?: unknown }).__NEXUS_E2E_BOOT_DISMISS__ = {
      status: activeState.status,
      initialized: activeState.snapshot?.initialized ?? null,
      // UI-ready split: with the provisional dismiss the snapshot at hand-off
      // is EXPECTED to be uninitialized-but-uiReady (the MCP connect + engine
      // build are still running). The e2e asserts initialized OR uiReady —
      // never the bare pre-runtime snapshot.
      uiReady: activeState.snapshot?.uiReady ?? null,
      messageCount: activeState.snapshot?.messageCount ?? null,
      transcriptLength: activeState.transcriptMessages.length,
      threadWelcomeUnmounted,
      bodyHydrated,
    }
    // Boot instrumentation: absolute marks from earlier layers (C++ and JS) combined into
    // per-transition sub-deltas in one trace event.
    const marks = (globalThis as { __nexusBootMarks?: Record<string, number> })
      .__nexusBootMarks ?? {}
    const signalAtMs = Date.now()
    const cppStart = marks.nexusViewContainerFirstCreatedMs ?? null
    const cppLoadUrl = marks.loadInitialUrlReturnedMs ?? null
    const cppGlicNav = marks.glicNavigationCommittedMs ?? null
    // chrome://glic intermediate marks, passed via URL search params on the webview navigation.
    const glicMainStarted = marks.glicMainStartedMs ?? null
    const webviewSrcSet = marks.webviewSrcSetMs ?? null
    const html = marks.htmlParsedMs ?? null
    const dcl = marks.domContentLoadedMs ?? null
    const reactModule = marks.reactModuleStartMs ?? null
    const transportReady = marks.transportReadyMs ?? null
    const reactImported = marks.reactImportResolvedMs ?? null
    const reactDomImported = marks.reactDomImportResolvedMs ?? null
    const createRootDone = marks.createRootDoneMs ?? null
    const shellImported = marks.shellImportResolvedMs ?? null
    const renderStart = marks.renderCallStartMs ?? null
    const renderReturned = marks.renderCallReturnedMs ?? null
    const twMount = marks.threadWelcomeMountedMs ?? null
    const snapshotReady = marks.workerSnapshotReadyMs ?? null
    const firstMsgs = marks.firstWorkerMessagesReceivedMs ?? null
    const transcriptMerged = marks.transcriptMergedMs ?? null
    // Use the "real" unmount captured by the gated listener above —
    // threadWelcomeFirstUnmountedMs would catch the loading→ready
    // transient unmount that fires before snapshot is loaded.
    const twUnmount = marks.threadWelcomeRealUnmountedMs ?? null
    // Keep the "first" unmount available for diagnostic purposes (so we
    // can see if the transient unmount happened at all and when).
    const twFirstUnmount = marks.threadWelcomeFirstUnmountedMs ?? null
    // Direction B3: subdivide ms_merged_to_unmount (~1087 ms) across
    // assistant-ui's render pipeline. Marks captured in:
    //   AssistantUiThread.tsx (useMemo for `messages`)
    //   components/assistant-ui/thread.tsx (Thread + first-message useEffect)
    const transcriptConvertStart = marks.transcriptConvertStartMs ?? null
    const transcriptConvertEnd = marks.transcriptConvertEndMs ?? null
    const transcriptConvertResultLength =
      marks.transcriptConvertResultLength ?? null
    const auiThreadFirstCommit = marks.auiThreadFirstCommitMs ?? null
    const auiThreadCommitCount = marks.auiThreadCommitCount ?? null
    const firstMessageRenderProp = marks.firstMessageRenderPropMs ?? null
    const lastMessageRenderProp = marks.lastMessageRenderPropMs ?? null
    const firstMessageMounted = marks.firstMessageMountedMs ?? null
    const firstMessageRole =
      (marks as { firstMessageMountedRole?: string })
        .firstMessageMountedRole ?? null
    const delta = (a: number | null, b: number | null) =>
      a != null && b != null ? a - b : null
    installSessionTracer({ context: 'ui' }).event('boot.guestReady.signaled', {
      traceId: getBootDiagnosticTraceId(),
      attrs: {
        sessionId: activeSessionId,
        sessionsCount: sessions.length,
        transcriptLength: activeState.transcriptMessages.length,
        threadWelcomeUnmounted,
        snapshotMessageCount: activeState.snapshot?.messageCount ?? null,
        // Absolute marks (ms since Unix epoch).
        nexusViewContainerFirstCreatedMs: cppStart,
        loadInitialUrlReturnedMs: cppLoadUrl,
        glicNavigationCommittedMs: cppGlicNav,
        glicMainStartedMs: glicMainStarted,
        webviewSrcSetMs: webviewSrcSet,
        htmlParsedMs: html,
        domContentLoadedMs: dcl,
        reactModuleStartMs: reactModule,
        transportReadyMs: transportReady,
        reactImportResolvedMs: reactImported,
        reactDomImportResolvedMs: reactDomImported,
        createRootDoneMs: createRootDone,
        shellImportResolvedMs: shellImported,
        renderCallStartMs: renderStart,
        renderCallReturnedMs: renderReturned,
        threadWelcomeMountedMs: twMount,
        workerSnapshotReadyMs: snapshotReady,
        firstWorkerMessagesReceivedMs: firstMsgs,
        transcriptMergedMs: transcriptMerged,
        threadWelcomeRealUnmountedMs: twUnmount,
        threadWelcomeFirstUnmountedMs: twFirstUnmount,
        // Direction B3 absolute marks.
        transcriptConvertStartMs: transcriptConvertStart,
        transcriptConvertEndMs: transcriptConvertEnd,
        transcriptConvertResultLength,
        auiThreadFirstCommitMs: auiThreadFirstCommit,
        auiThreadCommitCount,
        firstMessageRenderPropMs: firstMessageRenderProp,
        lastMessageRenderPropMs: lastMessageRenderProp,
        firstMessageMountedMs: firstMessageMounted,
        firstMessageRole,
        signalAtMs,
        bootTimingsRoundTripMs: marks.bootTimingsRoundTripMs ?? null,
        // Macro deltas — same as before, for at-a-glance.
        ms_pre_react_layer: delta(html, cppStart),
        ms_bundle_parse: delta(reactModule, html),
        ms_react_init: delta(transportReady, reactModule),
        ms_react_mount_to_ready: delta(signalAtMs, transportReady),
        ms_total_observable_boot: delta(signalAtMs, cppStart),
        // Fine-grained sub-deltas (pre-React layer).
        ms_cpp_setup: delta(cppLoadUrl, cppStart),
        ms_glic_load: delta(cppGlicNav, cppLoadUrl),
        ms_inner_webview_spawn_and_fetch: delta(html, cppGlicNav),
        // Subdivide ms_inner_webview_spawn_and_fetch: glic page parse + script start; glic JS
        // top-level work before navigating; Chromium guest spawn + Vite serve.
        ms_glic_committed_to_main_script:
          delta(glicMainStarted, cppGlicNav),
        ms_main_script_to_webview_src:
          delta(webviewSrcSet, glicMainStarted),
        ms_webview_src_to_html_parsed:
          delta(html, webviewSrcSet),
        ms_html_parse_to_module: delta(reactModule, html),
        ms_module_to_dcl: delta(dcl, reactModule),
        // Fine-grained sub-deltas — Direction B (React mount → ready).
        ms_mount_to_first_paint: delta(twMount, transportReady),
        // Sub-deltas inside ms_mount_to_first_paint (5 segments):
        ms_transport_to_react_import:
          delta(reactImported, transportReady),
        ms_react_to_reactdom_import:
          delta(reactDomImported, reactImported),
        ms_reactdom_to_create_root:
          delta(createRootDone, reactDomImported),
        ms_create_root_to_shell_import:
          delta(shellImported, createRootDone),
        ms_shell_import_to_render_start:
          delta(renderStart, shellImported),
        ms_render_call_duration:
          delta(renderReturned, renderStart),
        ms_render_returned_to_first_paint:
          delta(twMount, renderReturned),
        ms_first_paint_to_snapshot: delta(snapshotReady, twMount),
        ms_snapshot_to_messages: delta(firstMsgs, snapshotReady),
        ms_messages_to_merged: delta(transcriptMerged, firstMsgs),
        ms_merged_to_unmount: delta(twUnmount, transcriptMerged),
        ms_unmount_to_signal: delta(signalAtMs, twUnmount),
        // Direction B3 — subdivide ms_merged_to_unmount across assistant-ui's
        // pipeline. Note: transcriptConvertStartMs is captured during render
        // (inside useMemo), while transcriptMergedMs is captured in a useEffect
        // AFTER the commit that produced the merged transcript — so
        // ms_merged_to_convert_start can be NEGATIVE (convert ran first within
        // the same render cycle) by ~ a few ms. That's expected; the absolute
        // value is the post-commit→post-effect lag for that render cycle.
        ms_merged_to_convert_start:
          delta(transcriptConvertStart, transcriptMerged),
        ms_convert_duration:
          delta(transcriptConvertEnd, transcriptConvertStart),
        ms_convert_to_aui_committed:
          delta(auiThreadFirstCommit, transcriptConvertEnd),
        ms_aui_committed_to_first_message:
          delta(firstMessageMounted, auiThreadFirstCommit),
        // Inside ms_aui_committed_to_first_message: split into the gap
        // assistant-ui takes to start iterating its message list (store
        // propagation + render kickoff), the iteration time itself
        // (rendering 65 message subtrees), and the post-iteration
        // commit + paint + effect-queue tail.
        ms_aui_committed_to_render_prop:
          delta(firstMessageRenderProp, auiThreadFirstCommit),
        ms_render_prop_iteration:
          delta(lastMessageRenderProp, firstMessageRenderProp),
        ms_render_prop_to_first_message_mount:
          delta(firstMessageMounted, lastMessageRenderProp),
        ms_first_message_to_unmount:
          delta(twUnmount, firstMessageMounted),
      },
    })
    onGuestFullyReady?.()
  }, [
    sessions.length,
    activeState.status,
    activeState.snapshot,
    activeState.transcriptMessages.length,
    activeSessionId,
    threadWelcomeUnmounted,
    bodyHydrated,
    onGuestFullyReady,
  ])

  const activeCatalog = activeState.snapshot?.modelCatalog
  // Display fallback: while a freshly-switched / cold session's `worker.ready`
  // is still in flight (its snapshot is null), show the last-known shared
  // catalog so the topbar picker dropdown + the settings provider list don't
  // flash empty. The model catalog is global (same providers for every
  // session), so the last-known one is always correct to DISPLAY. NB: the
  // submit gate in AssistantUiThread keys on the session's OWN snapshot, not
  // this — it must keep bailing while the snapshot is genuinely absent.
  const displayCatalog = activeCatalog ?? sharedModelCatalog
  const configuredActiveCatalog = useMemo(
    () => createConfiguredModelCatalog(displayCatalog),
    [displayCatalog],
  )
  // The user's provider order (Settings → Provider connection, drag to
  // reorder), applied for DISPLAY only: the topbar quick picker and the
  // settings pages get the ordered catalog; default adoption and the import
  // icons keep reading `configuredActiveCatalog`, whose `defaultSelection`
  // the worker resolves on the same, unordered basis.
  const [providerOrder, setProviderOrder] = useState<string[]>([])
  const orderedActiveCatalog = useMemo(
    () => orderCatalogProviders(configuredActiveCatalog, providerOrder),
    [configuredActiveCatalog, providerOrder],
  )

  useEffect(() => {
    // Only propagate a POPULATED catalog to the shared/new-session seed. An
    // empty `{providers:[]}` (host mid-init) must never become the seed: a new
    // session adopts `initialModelCatalog` and then SKIPS its Phase-2 refetch
    // (`if (!this.modelCatalog)`), so an empty seed would durably blank that
    // session's picker until something else refreshed it.
    if (!activeCatalog || activeCatalog.providers.length === 0) {
      return
    }

    setSharedModelCatalog(activeCatalog)
  }, [activeCatalog])

  useEffect(() => {
    if (browserDefaultSelection || !configuredActiveCatalog?.defaultSelection) {
      return
    }

    setBrowserDefaultSelection(configuredActiveCatalog.defaultSelection)
  }, [browserDefaultSelection, configuredActiveCatalog])

  useEffect(() => {
    onSubmitPromptReady?.(submitPrompt)
    return () => {
      onSubmitPromptReady?.(null)
    }
  }, [onSubmitPromptReady, submitPrompt])

  // The curated NEXUS_MODEL_CONFIG is published by the RUNTIME, not here
  // (`ManagerBootServices.publishModelCatalogAtBoot`): the host's copy backs
  // `model.catalog`, which every session's selection is validated against, so
  // it cannot depend on a client being allowed to push it.

  // Intercept external http/https anchor clicks (capture phase): a default click would
  // navigate away from the SPA. Opens via the host (`ui.openUrl`, `full`) or this client's
  // own browser — see `externalLinkClicks.ts`.
  useEffect(() => {
    const onDocumentClick = createExternalLinkClickHandler({
      canOpenOnHost: () => runtimeCapabilities.can('ui', 'openUrl'),
      openOnHost: url => openUrl(hostBridgeTransport, url),
      openInClient: openInClientTab,
    })
    document.addEventListener('click', onDocumentClick, { capture: true })
    return () => {
      document.removeEventListener('click', onDocumentClick, { capture: true })
    }
  }, [hostBridgeTransport, runtimeCapabilities])

  // The worker's settings capabilities (providers / features / agent /
  // mcpSettings / plugins / …) ride the runtime connection; `nexusBoot` owns
  // the bridge, this app only publishes it (phase 5b).
  useEffect(() => {
    if (!settingsBridge) return
    // E2E hook: expose the live settings bridge so specs can drive worker
    // capabilities (agent/mcpSettings/features/…) directly — the React analog
    // of the deleted Lit settings elements' internal methods the "live-flip"
    // specs reached into. Call as `bridge.request({namespace:'nexus',
    // capability, action}, payload)`. Harmless in production (just a handle).
    ;(globalThis as unknown as { __NEXUS_SETTINGS_BRIDGE_E2E__?: unknown })
      .__NEXUS_SETTINGS_BRIDGE_E2E__ = settingsBridge
    return () => {
      ;(globalThis as unknown as { __NEXUS_SETTINGS_BRIDGE_E2E__?: unknown })
        .__NEXUS_SETTINGS_BRIDGE_E2E__ = undefined
    }
  }, [settingsBridge])

  // Session import: probe once per bridge for agent products whose
  // transcripts live on this machine (Claude Code first). A detected source
  // mounts its topbar button; none detected → no button, no dialog. Not
  // probed without `sessionImport.detect`.
  const importSources = useDetectedImportSources(settingsBridge, runtimeCapabilities)
  const [importDialogSource, setImportDialogSource] =
    useState<ImportSource | null>(null)
  // The dialog is a cold chunk: its mount latches on the first open (never at boot) and
  // stays, so it animates out and keeps its tab state. Latched during render.
  const [importDialogMounted, setImportDialogMounted] = useState(false)
  if (importDialogSource !== null && !importDialogMounted) {
    setImportDialogMounted(true)
  }
  const topbarImportSources = useMemo(
    () =>
      importSources.map(entry => ({
        source: entry.source,
        label: IMPORT_SOURCE_META[entry.source].label,
        iconSvg: importSourceIconSvg(configuredActiveCatalog, entry.source),
      })),
    [importSources, configuredActiveCatalog],
  )

  // Open the settings UI in-app (React `settingsSection` state). `null` = conversation visible.
  const [settingsSection, setSettingsSection] =
    useState<SettingsSectionId | null>(null)

  // Side panes (F-9). Each session's arrangement is a persisted record held
  // in one store seeded at boot; the pane content that is not layout stays
  // in memory per session.
  const sessionLayoutsStoreRef = useRef<SessionLayoutsStore | null>(null)
  if (sessionLayoutsStoreRef.current === null) {
    sessionLayoutsStoreRef.current = createSessionLayoutsStore()
  }
  const sessionLayoutsStore = sessionLayoutsStoreRef.current
  const sessionLayouts = useSessionLayouts(sessionLayoutsStore)
  const [paneSessionUi, setPaneSessionUi] = useState<Map<string, PaneSessionUi>>(
    () => new Map(),
  )
  const activeSessionIdRef = useRef(activeSessionId)
  activeSessionIdRef.current = activeSessionId
  const settingsOpenRef = useRef(false)
  settingsOpenRef.current = settingsSection !== null

  const activePaneUi =
    (activeSessionId ? paneSessionUi.get(activeSessionId) : undefined) ?? EMPTY_PANE_UI
  const activeNexusTabCount = activeSessionId
    ? (sessionTabCounts.get(activeSessionId)?.nexus ?? 0)
    : 0
  const sessionTabCountsRef = useRef(sessionTabCounts)
  sessionTabCountsRef.current = sessionTabCounts
  // The drawn record: the stored one with the panes this session cannot show
  // right now pruned (a browser pane while it owns no tab; its slot stays, so
  // it returns in place). Every decision reads this same pruned record.
  const readPaneRecord = useCallback(
    (sessionId: string) =>
      pruneUnrestorable(sessionLayoutsStore.get(sessionId), {
        browserTabs: sessionTabCountsRef.current.get(sessionId)?.nexus ?? 0,
      }),
    [sessionLayoutsStore],
  )
  const storedPaneRecord = activeSessionId ? sessionLayouts.records.get(activeSessionId) : undefined
  const activePaneRecord = useMemo(
    () => pruneUnrestorable(storedPaneRecord ?? sessionLayoutsStore.get(''), { browserTabs: activeNexusTabCount }),
    [storedPaneRecord, activeNexusTabCount, sessionLayoutsStore],
  )
  const paneLayout = activePaneRecord.layout
  const openPanes = useMemo(() => panesIn(paneLayout), [paneLayout])
  const paneMaximized = activePaneRecord.maximized
  const sideVisible = openPanes.length > 0
  const rightPanelDiffTarget = activePaneUi.diffTarget
  const rightPanelSkillTarget = activePaneUi.skillTarget
  const rightPanelFileReveal = activePaneUi.fileReveal
  // The pane a press or focus last landed in, and the pane last closed, per
  // session: what the close and reopen shortcuts act on.
  const focusedPaneRef = useRef(new Map<string, SidePaneKind>())
  const lastClosedPaneRef = useRef(new Map<string, SidePaneKind>())
  useEffect(() => {
    if (activeSessionId) sessionLayoutsStore.touch(activeSessionId)
  }, [activeSessionId, sessionLayoutsStore])

  // Apply a record change to a session (the active one by default); the
  // store writes it and re-renders the shell. A record returned unchanged
  // writes nothing. The side region closing (its last pane gone) is reported
  // to the presence reducer.
  const updatePaneRecord = useCallback(
    (fn: (prev: SessionPaneRecord) => SessionPaneRecord, sessionId = activeSessionIdRef.current) => {
      if (!sessionId) return
      const prev = readPaneRecord(sessionId)
      const next = fn(prev)
      if (next === prev) return
      if (panesIn(prev.layout).length > 0 && panesIn(next.layout).length === 0) {
        presentRightPanel({ type: 'close' })
      }
      sessionLayoutsStore.put(sessionId, next)
    },
    [sessionLayoutsStore, readPaneRecord],
  )
  const focusPane = useCallback((kind: SidePaneKind) => {
    const id = activeSessionIdRef.current
    if (id) focusedPaneRef.current.set(id, kind)
  }, [])
  /** Open `kind` for the person: placed, focused, shown when overlaid, and
   *  expanded in place of a pane that was expanded. */
  const openPaneFor = useCallback(
    (kind: SidePaneKind) => {
      updatePaneRecord(r => {
        const opened = openPane(r, kind, sessionLayoutsStore.getSnapshot().weights)
        return opened.maximized !== null ? setMaximized(opened, kind) : opened
      })
      focusPane(kind)
      presentRightPanel({ type: 'personOpen', view: kind })
    },
    [updatePaneRecord, sessionLayoutsStore, focusPane],
  )
  // The tab count a session's browser pane was closed at: the pane returns
  // on new tab activity (another count), not for the state it was closed in.
  // Transient, like the dismissal it replaces.
  const browserDismissedAtRef = useRef(new Map<string, number>())
  const closePaneFor = useCallback(
    (kind: SidePaneKind) => {
      const id = activeSessionIdRef.current
      if (!id) return
      if (!hasPane(readPaneRecord(id).layout, kind)) return
      updatePaneRecord(r => closePane(r, kind))
      lastClosedPaneRef.current.set(id, kind)
      if (focusedPaneRef.current.get(id) === kind) focusedPaneRef.current.delete(id)
      if (kind === 'browser') {
        browserDismissedAtRef.current.set(id, sessionTabCountsRef.current.get(id)?.nexus ?? 0)
      }
    },
    [updatePaneRecord, readPaneRecord],
  )
  /** A new session-owned tab inside the browser pane: the host creates it in
   *  this window; the count change then places the pane (`followBrowserTabs`). */
  const openBrowserTab = useCallback(
    (sessionId: string) => {
      browserDismissedAtRef.current.delete(sessionId)
      void openSessionTab(hostBridgeTransport, sessionId).catch(() => {
        /* no Nexus window (a remote page, the dev mock): nothing to show */
      })
    },
    [hostBridgeTransport],
  )
  /** The topbar toggle (`paneToggleAction` against the drawn record). */
  const togglePane = useCallback(
    (kind: SidePaneKind) => {
      const id = activeSessionIdRef.current
      if (!id) return
      setBackgroundTaskFocusSessionId(null)
      const presence = rightPanelPresenceRef.current
      const overlayHidden = presence.form === 'overlay' && !presence.overlay
      const action =
        kind === 'browser'
          ? browserToggleAction(readPaneRecord(id), overlayHidden, {
              browserTabs: sessionTabCountsRef.current.get(id)?.nexus ?? 0,
            })
          : paneToggleAction(readPaneRecord(id), kind, overlayHidden)
      switch (action) {
        case 'new-tab':
          openBrowserTab(id)
          break
        case 'open':
          if (kind === 'browser') browserDismissedAtRef.current.delete(id)
          openPaneFor(kind)
          break
        case 'show-overlay':
          presentRightPanel({ type: 'personOpen', view: kind })
          break
        case 'move-expansion':
          updatePaneRecord(r => setMaximized(r, kind))
          focusPane(kind)
          break
        case 'close':
          closePaneFor(kind)
          break
      }
    },
    [readPaneRecord, openPaneFor, closePaneFor, updatePaneRecord, focusPane, openBrowserTab],
  )
  // The browser pane follows each session's tab count: a change above zero
  // places it (unless closed at that count), zero leaves it to the prune.
  const prevTabCountsRef = useRef<ReadonlyMap<string, { nexus: number; total: number }>>(new Map())
  useEffect(() => {
    const prev = prevTabCountsRef.current
    prevTabCountsRef.current = sessionTabCounts
    for (const [sessionId, counts] of sessionTabCounts) {
      const prevTabs = prev.get(sessionId)?.nexus ?? 0
      if (counts.nexus === prevTabs) continue
      updatePaneRecord(
        r =>
          followBrowserTabs(
            r,
            {
              prevTabs,
              nextTabs: counts.nexus,
              dismissedAt: browserDismissedAtRef.current.get(sessionId) ?? null,
            },
            sessionLayoutsStore.getSnapshot().weights,
          ),
        sessionId,
      )
    }
  }, [sessionTabCounts, updatePaneRecord, sessionLayoutsStore])
  const handleResetLayout = useCallback(() => {
    updatePaneRecord(resetPaneLayout)
  }, [updatePaneRecord])
  // A separator run ends in one commit: the session's layout, then the weight
  // of every pane sitting directly in the root row as what its kind opens at
  // next (a column's panes have none of their own); a held float share gives
  // way to the person's own sizing.
  const commitPaneResize = useCallback(
    (layout: PaneLayout) => {
      updatePaneRecord(r => (paneLayoutEquals(r.layout, layout) ? r : { ...r, layout }))
      for (const [kind, weight] of Object.entries(rootPaneWeightsByKind(layout))) {
        if (typeof weight === 'number') sessionLayoutsStore.setWeight(kind as SidePaneKind, weight)
      }
      presentRightPanel({ type: 'drag' })
    },
    [updatePaneRecord, sessionLayoutsStore],
  )
  // A drop on a zone or an arrow key at a pane's handle moves the pane: one
  // record write, nothing when the tree does not change.
  const commitPaneMove = useCallback(
    (kind: SidePaneKind, target: PaneDropTarget) => {
      updatePaneRecord(r => {
        const layout = movePane(r.layout, kind, target, sessionLayoutsStore.getSnapshot().weights)
        return layout === r.layout ? r : { ...r, layout }
      })
    },
    [updatePaneRecord, sessionLayoutsStore],
  )
  const updatePaneUi = useCallback((sessionId: string, fn: (prev: PaneSessionUi) => PaneSessionUi) => {
    setPaneSessionUi(prev => {
      const cur = prev.get(sessionId) ?? EMPTY_PANE_UI
      const next = fn(cur)
      if (next === cur) return prev
      const m = new Map(prev)
      m.set(sessionId, next)
      return m
    })
  }, [])

  // Paths whose Files-view editor currently holds UNSAVED edits. Reported by
  // the mounted `FilePanel`s (and cleared by them on unmount), so this only
  // ever describes bodies that are alive right now — which is exactly the set
  // that must be exempt from the panel's body LRU and its file-tab cap.
  const [dirtyFilePaths, setDirtyFilePaths] = useState<ReadonlySet<string>>(
    () => new Set(),
  )
  const dirtyFilePathsRef = useRef(dirtyFilePaths)
  dirtyFilePathsRef.current = dirtyFilePaths
  const handleFileDirtyChange = useCallback((path: string, dirty: boolean) => {
    setDirtyFilePaths(prev => {
      if (prev.has(path) === dirty) return prev
      const next = new Set(prev)
      if (dirty) next.add(path)
      else next.delete(path)
      return next
    })
  }, [])

  // The panes render outside AssistantUiThread's provider tree, so the shell
  // provides its own path probe + open handles around them.
  const shellFilePathProbe = useMemo(
    () => createFilePathProbe(statFilePaths),
    [statFilePaths],
  )
  const shellFilePathContextValue = useMemo(
    () => ({
      projectRoot: activeState.snapshot?.projectRoot,
      probe: shellFilePathProbe,
    }),
    [activeState.snapshot?.projectRoot, shellFilePathProbe],
  )

  // Monotonic nonce for fileReveal — a plain counter (no Date.now) so two
  // clicks in the same millisecond still read as two requests.
  const fileRevealNonceRef = useRef(0)
  // Open a file as a tab of the Files pane; past the strip's cap the oldest
  // tab is dropped, never the active or a dirty one.
  const openFileInPanel = useCallback((target: RightPanelFileTarget) => {
    const id = activeSessionIdRef.current
    if (!id) return
    updatePaneRecord(r => {
      const files = openFileTab(r.files ?? EMPTY_FILES_PANE, target.path, {
        protectedPaths: dirtyFilePathsRef.current,
      })
      const opened = openPane(r, 'files', sessionLayoutsStore.getSnapshot().weights)
      return files === r.files ? opened : { ...opened, files }
    })
    focusPane('files')
    // A `path:42` mention carries a landing line — record the reveal even
    // for an already-open tab (the click means "take me THERE, again").
    if (target.line !== undefined) {
      const line = target.line
      updatePaneUi(id, cur => ({
        ...cur,
        fileReveal: { path: target.path, line, nonce: ++fileRevealNonceRef.current },
      }))
    }
    presentRightPanel({ type: 'personOpen', view: 'files' })
  }, [updatePaneRecord, sessionLayoutsStore, focusPane, updatePaneUi])
  const handleActivateFileTab = useCallback(
    (path: string) => {
      updatePaneRecord(r => {
        const files = activateFileTab(r.files ?? EMPTY_FILES_PANE, path)
        return files === r.files ? r : { ...r, files }
      })
    },
    [updatePaneRecord],
  )
  const handleCloseFileTab = useCallback(
    (path: string) => {
      updatePaneRecord(r => {
        const files = closeFileTab(r.files ?? EMPTY_FILES_PANE, path)
        return files === r.files ? r : { ...r, files }
      })
    },
    [updatePaneRecord],
  )
  const openDiffInPanel = useCallback((target: RightPanelDiffTarget) => {
    const id = activeSessionIdRef.current
    if (!id) return
    updatePaneUi(id, cur => ({ ...cur, diffTarget: target }))
    openPaneFor('diff')
  }, [updatePaneUi, openPaneFor])

  // Skill card "View skill" → the Skill pane: stores the target the pane
  // body reads and opens the pane.
  const openSkillInPanel = useCallback((target: RightPanelSkillTarget) => {
    const id = activeSessionIdRef.current
    if (!id) return
    updatePaneUi(id, cur => ({ ...cur, skillTarget: target }))
    openPaneFor('skill')
  }, [updatePaneUi, openPaneFor])

  // Open handles for FilePathLinks rendered INSIDE the panel (plan text /
  // `.md` preview) — same handlers the transcript uses.
  const shellRightPanelContentValue = useMemo(
    () => ({
      openFile: openFileInPanel,
      openDiff: openDiffInPanel,
      openSkill: openSkillInPanel,
    }),
    [openFileInPanel, openDiffInPanel, openSkillInPanel],
  )


  // Background Tasks is per-session content (P6): the active session's panel
  // shows only the sub-agents IT launched, never another session's. Drives both
  // the panel rows and the topbar badge so the two always agree.
  const activeSessionSubAgentRows = useMemo(
    () => filterSubAgentRowsBySession(subAgentRows, activeSessionId),
    [subAgentRows, activeSessionId],
  )
  // Each mounted thread's own rows: the same array while that session's rows
  // are unchanged, so another session's feed change re-renders nothing here.
  const subAgentRowsSeenRef = useRef(new Map<string, NexusTaskSummaryRow[]>())
  const subAgentRowsForSession = useMemo(() => {
    const bySession = new Map<string, NexusTaskSummaryRow[]>()
    return (sessionId: string): NexusTaskSummaryRow[] => {
      let rows = bySession.get(sessionId)
      if (!rows) {
        rows = filterSubAgentRowsBySession(subAgentRows, sessionId)
        const seen = subAgentRowsSeenRef.current.get(sessionId)
        if (seen && subAgentsEqual(seen, rows)) rows = seen
        else subAgentRowsSeenRef.current.set(sessionId, rows)
        bySession.set(sessionId, rows)
      }
      return rows
    }
  }, [subAgentRows])
  // LAZY restart-recovery of the Background Tasks drawer rows: only when the
  // drawer is actually OPEN do we ask the worker to rebuild this session's
  // recovered shell + run_js rows from its persisted transcript
  // (`task.recoverBackground`, idempotent per session in the manager). A closed
  // drawer triggers no transcript scan — the deferral the user asked for.
  // Mirrors the Skills tab's open-gated scan below.
  const backgroundTasksTabOpen = openPanes.includes('tasks')
  useEffect(() => {
    // Depend on `sessionChannel` (not just the ref) so that if it is not there
    // yet when the drawer first opens, the request re-fires the moment it is —
    // never silently dropped.
    if (!backgroundTasksTabOpen || !activeSessionId || !sessionChannel) return
    sessionChannel.request('task.recoverBackground', {
      sessionId: activeSessionId,
    })
  }, [backgroundTasksTabOpen, activeSessionId, sessionChannel])
  // Skill invocations recovered from the ACTIVE session's transcript, so the
  // Skills pane survives a restart. View-only (never written to the worker
  // store), scanned only while the pane is open.
  const skillTabOpen = openPanes.includes('skill')
  const restoredSessionSkills = useMemo(
    () =>
      skillTabOpen
        ? restoreSessionSkillsFromTranscript(activeState.transcriptMessages)
        : [],
    [skillTabOpen, activeState.transcriptMessages],
  )
  // Skills loaded (invoked) in the ACTIVE session — the Skills tab's top
  // list. Membership/order/size come from the worker's invoked-skills feed,
  // extended past restarts by the transcript scan above; the registry
  // snapshot only enriches rows (description, size backfill) — the tab lists
  // what THIS session loaded, not the whole skill registry.
  const activeLoadedSkills = useMemo(
    () =>
      buildSessionSkillPanelList(
        sessionSkillRows,
        activeSessionId,
        activeState.snapshot?.loadedSkills,
        restoredSessionSkills,
      ),
    [
      sessionSkillRows,
      activeSessionId,
      activeState.snapshot?.loadedSkills,
      restoredSessionSkills,
    ],
  )
  // Select a loaded skill IN PLACE: open the (singleton) Skill tab and render
  // its body in the child view — never a new tab. Body source: the on-disk
  // `SKILL.md` when the row has a real path; otherwise (transcript-restored
  // rows with an unknown path, and bundled skills whose `path` is the
  // synthetic `bundled:<name>` — nothing readable on disk) the invocation's
  // `skill:<uuid>` sidecar via `detailId`.
  const handleSelectSkill = useCallback(
    (skill: SkillPanelListRow) => {
      // A failed invocation has no body — open it as an error target.
      if (skill.status === 'failed') {
        openSkillInPanel({
          name: skill.name,
          detailId: null,
          inlineBody: null,
          eventId: skill.id,
          status: 'failed',
          error: skill.error,
        })
        return
      }
      const diskPath =
        skill.path && skill.source !== 'bundled' ? skill.path : null
      openSkillInPanel({
        name: skill.name,
        path: diskPath ?? undefined,
        detailId: diskPath ? null : skill.detailId ?? null,
        inlineBody: null,
        eventId: skill.id,
        status: skill.status,
      })
    },
    [openSkillInPanel],
  )
  const handleOpenBackgroundTasks = useCallback((focusSessionId?: string) => {
    setBackgroundTaskFocusSessionId(focusSessionId ?? null)
    openPaneFor('tasks')
  }, [openPaneFor])
  // Tasks on its list: each request (a count) sends the drawer back from any
  // task detail it shows.
  const [backgroundTaskListRequest, setBackgroundTaskListRequest] = useState(0)
  const handleOpenBackgroundTasksList = useCallback(() => {
    setBackgroundTaskFocusSessionId(null)
    setBackgroundTaskListRequest(n => n + 1)
    openPaneFor('tasks')
  }, [openPaneFor])

  // `$.ui.view` (F-25): a teammate's transcript is its own session; a
  // subagent's is its Tasks detail, expanded over the conversation. Going
  // back restores that session's panes as they were before.
  const panesBeforeAgentView = useRef(
    new Map<string, { hadTasks: boolean; maximized: SidePaneKind | null }>(),
  )
  useModAgentView(runtimeConnection, activeSessionId ?? undefined, {
    focusSession,
    showSubagent: taskId => {
      const sessionId = activeSessionIdRef.current
      if (sessionId && !panesBeforeAgentView.current.has(sessionId)) {
        const record = readPaneRecord(sessionId)
        panesBeforeAgentView.current.set(sessionId, {
          hadTasks: hasPane(record.layout, 'tasks'),
          maximized: record.maximized,
        })
      }
      handleOpenBackgroundTasks(taskId)
      updatePaneRecord(r => setMaximized(r, 'tasks'))
    },
    leaveSubagent: () => {
      const sessionId = activeSessionIdRef.current
      const before = sessionId ? panesBeforeAgentView.current.get(sessionId) : undefined
      if (sessionId) panesBeforeAgentView.current.delete(sessionId)
      setBackgroundTaskFocusSessionId(null)
      setBackgroundTaskListRequest(n => n + 1)
      if (!before) {
        updatePaneRecord(r => setMaximized(r, null))
        return
      }
      updatePaneRecord(r => {
        const restored = before.hadTasks ? r : closePane(r, 'tasks')
        return setMaximized(restored, before.maximized)
      })
    },
  })
  // The drawer consumed the focus id (detail opened) — clear it so a later
  // summary broadcast can't re-open the detail after the user navigates back,
  // and so a repeat jump to the SAME task re-triggers (null → id transition).
  const handleTaskFocusConsumed = useCallback(() => {
    setBackgroundTaskFocusSessionId(null)
  }, [])

  const activeQueuedPlanConfirm = useMemo(
    () =>
      activeState.snapshot?.approvalQueue?.find(
        entry => entry.toolName === 'ExitPlanMode',
      ) ?? null,
    [activeState.snapshot?.approvalQueue],
  )
  const activePlanEntry = useMemo(() => {
    if (activeQueuedPlanConfirm) {
      return {
        toolCallId: activeQueuedPlanConfirm.approvalCallId,
        request: {
          toolName: activeQueuedPlanConfirm.toolName,
          planText:
            typeof activeQueuedPlanConfirm.permissionResult.planText === 'string'
              ? activeQueuedPlanConfirm.permissionResult.planText
              : '',
          planFilePath:
            typeof activeQueuedPlanConfirm.permissionResult.planFilePath ===
            'string'
              ? activeQueuedPlanConfirm.permissionResult.planFilePath
              : '',
          restoreMode:
            activeQueuedPlanConfirm.permissionResult.restoreMode ?? 'default',
        },
      }
    }
    const pending = activeState.snapshot?.pendingPlanApproval
    const first = pending ? Object.entries(pending)[0] : undefined
    return first ? { toolCallId: first[0], request: first[1] } : null
  }, [
    activeQueuedPlanConfirm,
    activeState.snapshot?.pendingPlanApproval,
  ])
  const resolveActivePlan = useCallback(
    (decision: 'approve' | 'reject', feedback?: string) => {
      if (!activePlanEntry) return
      if (activeQueuedPlanConfirm) {
        return resolveToolUseConfirm({
          approvalCallId: activeQueuedPlanConfirm.approvalCallId,
          behavior: decision === 'approve' ? 'allow' : 'reject',
          updatedInput:
            decision === 'approve' ? activeQueuedPlanConfirm.input : undefined,
          feedback,
        })
      }
      return resolvePlanApproval(
        decision,
        activePlanEntry.toolCallId,
        activePlanEntry.request,
        { clearPlanApproval, setPermissionMode, submitToolResult },
        feedback,
      )
    },
    [
      activePlanEntry,
      activeQueuedPlanConfirm,
      resolveToolUseConfirm,
      clearPlanApproval,
      setPermissionMode,
      submitToolResult,
    ],
  )
  // The Plan pane closes once its approval resolves (a plan gives way to
  // none in the same session); a session restored with a Plan pane and no
  // plan keeps it. The close is DEFERRED a tick: a session switch / snapshot
  // refetch can make `activePlanEntry` momentarily null and resolve back to
  // a real plan on the next render — the cleanup cancels the pending close.
  const lastPlanRef = useRef<{ sessionId: string; toolCallId: string | null }>({
    sessionId: '',
    toolCallId: null,
  })
  useEffect(() => {
    const last = lastPlanRef.current
    const toolCallId = activePlanEntry?.toolCallId ?? null
    lastPlanRef.current = { sessionId: activeSessionId, toolCallId }
    if (toolCallId !== null || last.sessionId !== activeSessionId || last.toolCallId === null) return
    const id = window.setTimeout(() => {
      updatePaneRecord(r => {
        if (!hasPane(r.layout, 'plan')) return r
        const next = closePane(r, 'plan')
        const remaining = panesIn(next.layout)
        presentRightPanel({ type: 'planClosed', nextView: remaining[0] ?? null })
        return next
      }, activeSessionId)
    }, 0)
    return () => window.clearTimeout(id)
  }, [activePlanEntry, activeSessionId, updatePaneRecord])
  // Auto-open the Plan pane when a NEW pending plan approval arrives (mirrors
  // the file/diff-click auto-open) so the user sees the plan without having to
  // press "View plan". Gate semantics (per-session keying, never re-opening
  // the same pending plan, never clearing on null) live in
  // `createPlanAutoOpenGate` — see its doc.
  const planAutoOpenGateRef = useRef(createPlanAutoOpenGate())
  // Set below, once the layout is known: reports a pane the agent opened.
  const agentOpenRightPanelRef = useRef<(view: SidePaneKind) => void>(() => {})
  useEffect(() => {
    if (
      !planAutoOpenGateRef.current(activeSessionId, activePlanEntry?.toolCallId)
    ) {
      return
    }
    agentOpenRightPanelRef.current('plan')
    updatePaneRecord(r => openPane(r, 'plan', sessionLayoutsStore.getSnapshot().weights))
  }, [activePlanEntry, activeSessionId, updatePaneRecord, sessionLayoutsStore])
  // Declared after the plan auto-open, so a switch keeps the float that
  // effect just opened for the session switched to.
  useEffect(() => {
    presentRightPanel({ type: 'sessionSwitch', sessionId: activeSessionId })
  }, [activeSessionId])

  // Whenever no browser pane can be on screen (the active session's tree has
  // none, or Settings covers the area), push an explicit hide to the native
  // main-contents-view: the placeholder's own unmount covers most paths, this
  // covers a session switch to a tree that never mounts one. The dedupe in
  // postMainContentsLayout makes overlaps free.
  const browserPaneShown = openPanes.includes('browser') && settingsSection === null
  useEffect(() => {
    if (!browserPaneShown) {
      postMainContentsLayout(shellChannelRef.current, { visible: false })
    }
  }, [browserPaneShown])

  // The side region as the cascade sees it: its minimum is its root-row
  // children's minimums plus gutters, its share the side weights over all
  // weights; a settled float holds its own share while its pane stays in
  // front (never saved).
  const sideMetrics = useMemo(() => sideRegionMetrics(paneLayout), [paneLayout])
  const frontPane = openPanes[0] ?? null
  const rightPanelHold = rightPanelPresence.hold
  const sideShareNow =
    rightPanelHold && frontPane !== null && rightPanelHold.kind === frontPane
      ? rightPanelHold.share
      : sideMetrics.share
  const rightPanelFloat = rightPanelPresence.float
  // The drawn layout for this width (F-9): sidebar form, the side region's
  // drawn width (the chat yields first), the chat's clip, and where the card stack goes.
  const shellLayout = resolveShellLayout({
    areaW: sessionAreaWidth,
    sidebar: { collapsed: sidebarCollapsed, width: sidebarWidth },
    panel: {
      visible: sideVisible,
      maximized: paneMaximized !== null,
      share: sideShareNow,
      minWidth: Math.max(RIGHT_PANEL_MIN_WIDTH_PX, sideMetrics.minWidth),
      maxWidth: Number.POSITIVE_INFINITY,
      floatWidth: sideVisible ? rightPanelFloat?.width ?? null : null,
      gutter: PANE_GUTTER_PX,
    },
  })
  const sidebarHidden = shellLayout.sidebar === 'hidden'
  // The card stack docks only where it fits and the person has it shown;
  // where it does not fit, the topbar toggle opens the cards as a popover.
  const [sessionCardPrefs, writeSessionCardPrefs] = useSessionCardPrefs()
  const sessionCardsFit = shellLayout.stack === 'docked'
  const sessionCardsDocked = sessionCardsFit && sessionCardPrefs.shown
  const [sessionCardsPopoverOpen, setSessionCardsPopoverOpen] = useState(false)
  useEffect(() => {
    setSessionCardsPopoverOpen(false)
  }, [sessionCardsFit, activeSessionId])
  const handleToggleSessionCards = useCallback(() => {
    // A maximized panel covers the cards: the toggle restores the chat and
    // shows them.
    if (paneMaximized !== null) {
      updatePaneRecord(r => setMaximized(r, null))
      if (sessionCardsFit) writeSessionCardPrefs(setSessionCardsShown(sessionCardPrefs, true))
      else setSessionCardsPopoverOpen(true)
      return
    }
    if (sessionCardsFit) {
      writeSessionCardPrefs(setSessionCardsShown(sessionCardPrefs, !sessionCardPrefs.shown))
    } else {
      setSessionCardsPopoverOpen(open => !open)
    }
  }, [
    paneMaximized,
    updatePaneRecord,
    sessionCardsFit,
    sessionCardPrefs,
    writeSessionCardPrefs,
  ])
  const closeSessionCardsPopover = useCallback(() => setSessionCardsPopoverOpen(false), [])
  sidebarHiddenRef.current = sidebarHidden
  const sidebarRail = !sidebarHidden && shellLayout.sidebar === 'rail'
  sidebarRailRef.current = sidebarRail
  const rightPanelOverlaid = shellLayout.panel === 'overlay'
  const rightPanelOverlayShown = rightPanelOverlaid && rightPanelPresence.overlay
  // Over the chat it leaves a strip of the chat to press back into.
  const effectiveSideWidth =
    shellLayout.panel === 'overlay'
      ? Math.max(0, Math.min(shellLayout.panelOffRowW, shellLayout.chatW - RIGHT_PANEL_OVERLAY_CHAT_STRIP_PX))
      : shellLayout.panel === 'float'
        ? shellLayout.panelOffRowW
        : shellLayout.panelW
  const rightPanelFloating = shellLayout.panel === 'float'
  // The room a docked region splits with the chat: beside, both widths;
  // otherwise the chat's width less the gutter the region would take.
  const rightPanelRoom =
    shellLayout.chatW + shellLayout.panelW - (shellLayout.panel === 'beside' ? 0 : PANE_GUTTER_PX)
  useEffect(() => {
    presentRightPanel({
      type: 'resize',
      areaW: sessionAreaWidth,
      form: shellLayout.panel,
      room: rightPanelRoom,
    })
  }, [sessionAreaWidth, shellLayout.panel, rightPanelRoom])
  // The agent opening a pane while the region is closed floats it over the
  // spare width at the transcript's end, measured here.
  agentOpenRightPanelRef.current = (view: SidePaneKind) => {
    const panelOpen = sideVisible
    const section = panelOpen
      ? null
      : document.querySelector(`[data-session-section="${CSS.escape(activeSessionId)}"]`)
    const column = section?.querySelector('.aui-thread-viewport-footer')
    const weight = paneWeightFor(view, sessionLayouts.weights)
    presentRightPanel({
      type: 'agentOpen',
      view,
      sessionId: activeSessionId,
      panelOpen,
      spare:
        section && column
          ? Math.floor(section.getBoundingClientRect().right - column.getBoundingClientRect().right)
          : null,
      dockedWidth: rightPanelWantWidth(
        weight / (PANE_CHAT_WEIGHT + weight),
        rightPanelRoom,
        RIGHT_PANEL_MIN_WIDTH_PX,
        Number.POSITIVE_INFINITY,
      ),
      areaW: sessionAreaWidth,
    })
  }
  // The person's next input settles the float: a press (after its click
  // lands, so nothing moves under it), a key, a wheel.
  useEffect(() => {
    if (!rightPanelFloating) return
    const settle = () => presentRightPanel({ type: 'input' })
    const settleAfterClick = () => window.setTimeout(settle, 0)
    document.addEventListener('pointerup', settleAfterClick, true)
    document.addEventListener('keydown', settle, true)
    document.addEventListener('wheel', settle, { capture: true, passive: true })
    return () => {
      document.removeEventListener('pointerup', settleAfterClick, true)
      document.removeEventListener('keydown', settle, true)
      document.removeEventListener('wheel', settle, true)
    }
  }, [rightPanelFloating])
  const closeRightPanelOverlay = useCallback(() => presentRightPanel({ type: 'dismiss' }), [])
  const rightPanelOverlayDismiss = useOverlayDismiss(
    rightPanelOverlayShown,
    closeRightPanelOverlay,
    '[data-testid^="topbar-pane-"], [data-testid="topbar-more-panes"], [data-testid="topbar-more-panes-menu"]',
  )
  useEffect(() => {
    if (!sidebarHidden) setSidebarPeek(false)
  }, [sidebarHidden])

  // The model picker's `⋯` → "Edit…": Settings → Models, on that provider's
  // editor. `seq` makes a repeat request for the same provider land again;
  // any other way into Settings, and closing it, drops the request — a
  // remounted Models page must not replay it.
  const [providerSettingsRequest, setProviderSettingsRequest] = useState<{
    providerId: string
    seq: number
  } | null>(null)

  // A mod's icon above the prompt → Plugins & Mods, scrolled to that
  // plugin's row, which flashes. Same `seq` shape as the provider request;
  // any other way into or around Settings, and closing it, drops it.
  const [pluginSettingsRequest, setPluginSettingsRequest] = useState<{
    plugin: string
    seq: number
  } | null>(null)
  const handleOpenPluginSettings = useCallback((plugin: string) => {
    setProviderSettingsRequest(null)
    setPluginSettingsRequest(prev => ({ plugin, seq: (prev?.seq ?? 0) + 1 }))
    setSettingsSection('plugins')
  }, [])

  // Mods' panes docked in the session card stack, at the transcript's top
  // right (F-25; a pane with `placement: 'dock'`). The shell owns which pane
  // card is open per session and reports it as the seat's `showing`; it reads
  // the ACTIVE session's mod UI for that (the same per-session stores the
  // thread reads).
  const modPanesDocked = sessionCardsDocked
  const shellModUi = useSessionModUi(runtimeConnection, activeSessionId, {
    canListMods: runtimeCapabilities.can('mods', 'list'),
    onOpenPluginSettings: handleOpenPluginSettings,
    panesDocked: modPanesDocked,
  })
  const [modDockFronts, setModDockFronts] = useState<ReadonlyMap<string, ModDockFront | null>>(
    () => new Map(),
  )
  const handleModDockFrontChange = useCallback(
    (sessionId: string, front: ModDockFront | null) => {
      setModDockFronts(prev => {
        if (sameModDockFront(prev.get(sessionId) ?? null, front)) return prev
        const next = new Map(prev)
        next.set(sessionId, front)
        return next
      })
    },
    [],
  )
  // The panes last folded per session (`foldModDock`'s `seen`): a pane the
  // person asked for since comes to the front.
  const modDockSeenRef = useRef(new Map<string, Map<string, number>>())
  useEffect(() => {
    if (!activeSessionId || !shellModUi.isLoaded || !modPanesDocked) return
    const seenBySession = modDockSeenRef.current
    setModDockFronts(prev => {
      const folded = foldModDock({
        front: prev.get(activeSessionId) ?? null,
        panes: shellModUi.panes,
        seen: seenBySession.get(activeSessionId),
      })
      seenBySession.set(activeSessionId, folded.seen)
      if (sameModDockFront(prev.get(activeSessionId) ?? null, folded.front)) return prev
      const next = new Map(prev)
      next.set(activeSessionId, folded.front)
      return next
    })
  }, [activeSessionId, shellModUi.isLoaded, shellModUi.panes, modPanesDocked])
  // Where this window draws the active session's panes (`mods.seat`): what
  // places a mod's own open and what `$.ui.panes()` reports shown — a
  // maximized Right Panel covers the stack, so it shows nothing, and a mod
  // toggling its pane (the diff mod's `/diff`) opens it again rather than
  // closing what the person cannot see. A session left behind is told this
  // window no longer draws it.
  const { reportSeat: reportModSeat } = shellModUi
  const modSeat = paneMaximized !== null ? 'dock-hidden' : !modPanesDocked ? 'inline' : 'dock-visible'
  const modSeatShowing =
    modSeat === 'dock-visible' && activeSessionId ? modDockFronts.get(activeSessionId) ?? null : null
  const modSeatShowingPlugin = modSeatShowing?.plugin
  const modSeatShowingId = modSeatShowing?.id
  const modSeatReportedRef = useRef<{
    sessionId: string
    report: NonNullable<typeof reportModSeat>
  } | null>(null)
  useEffect(() => {
    const last = modSeatReportedRef.current
    if (last && (last.sessionId !== activeSessionId || last.report !== reportModSeat)) {
      if (last.sessionId !== activeSessionId) void last.report('none').catch(() => {})
      modSeatReportedRef.current = null
    }
    if (!activeSessionId || !reportModSeat) return
    modSeatReportedRef.current = { sessionId: activeSessionId, report: reportModSeat }
    const showing =
      modSeatShowingPlugin !== undefined && modSeatShowingId !== undefined
        ? { plugin: modSeatShowingPlugin, id: modSeatShowingId }
        : undefined
    void reportModSeat(modSeat, showing).catch(() => {})
  }, [activeSessionId, reportModSeat, modSeat, modSeatShowingPlugin, modSeatShowingId])
  // Pane shortcuts (F-9): Diff toggles, the focused pane closes or
  // expands, the last closed pane reopens. Not while Settings covers the area.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.defaultPrevented || settingsOpenRef.current) return
      const shortcut = paneShortcutFor(event)
      if (!shortcut) return
      const id = activeSessionIdRef.current
      if (!id) return
      event.preventDefault()
      const record = readPaneRecord(id)
      const panes = panesIn(record.layout)
      const focused = focusedPaneRef.current.get(id)
      const target = focused && panes.includes(focused) ? focused : panes[panes.length - 1]
      switch (shortcut.action) {
        case 'toggle':
          togglePane(shortcut.kind)
          break
        case 'close-focused':
          if (target) closePaneFor(target)
          break
        case 'expand-focused':
          if (record.maximized !== null) updatePaneRecord(r => setMaximized(r, null))
          else if (target) updatePaneRecord(r => setMaximized(r, target))
          break
        case 'reopen-closed': {
          const kind = lastClosedPaneRef.current.get(id)
          if (kind && !panes.includes(kind)) openPaneFor(kind)
          break
        }
      }
    }
    document.addEventListener('keydown', onKey, true)
    return () => document.removeEventListener('keydown', onKey, true)
  }, [readPaneRecord, togglePane, closePaneFor, openPaneFor, updatePaneRecord])
  const handleSettingsNavigate = useCallback((section: SettingsSectionId) => {
    setPluginSettingsRequest(null)
    setSettingsSection(section)
  }, [])

  const handleOpenNexusSettings = useCallback(
    (section: SettingsSectionId = 'models') => {
      setProviderSettingsRequest(null)
      setPluginSettingsRequest(null)
      setSettingsSection(section)
    },
    [],
  )
  const handleOpenProviderSettings = useCallback((providerId: string) => {
    setProviderSettingsRequest(prev => ({ providerId, seq: (prev?.seq ?? 0) + 1 }))
    setSettingsSection('models')
  }, [])

  // Deep-link receiver: the thin Lit panel no longer hosts settings,
  // so it forwards the C++ `ui.openNexusSettings` deep-link (e.g. a rejected
  // tool's `?settings=<section>` link) as a window postMessage to this guest
  // webview. Open the matching React section.
  useEffect(() => {
    // 'appearance' and 'system' used to name their own pages; both folded
    // into 'general', so a legacy deep-link naming either must not strand the
    // user on a page that no longer exists — it lands on 'general'.
    const VALID = new Set<string>([
      'general', 'models', 'mcp', 'features', 'plugins', 'remoteAccess', 'about',
    ])
    const onMessage = (event: MessageEvent) => {
      // Only the host panel (embedder) legitimately forwards this, via
      // `webview.contentWindow.postMessage` — so `event.source` is never the
      // guest's own window. Reject self-posted messages (the main in-page
      // injection vector); the `VALID` section allowlist below bounds the rest
      // to "open a known settings section". Full origin-pinning is impractical:
      // the embedder origin varies (chrome:// in the real host vs the dev mock).
      if (event.source === window) return
      const data = event.data as { type?: unknown; section?: unknown } | null
      if (!data || data.type !== 'nexus-settings-deep-link') return
      const raw = typeof data.section === 'string' ? data.section : ''
      const section = VALID.has(raw)
        ? (raw as SettingsSectionId)
        : raw === 'appearance' || raw === 'system'
          ? 'general'
          : 'models'
      setSettingsSection(section)
    }
    window.addEventListener('message', onMessage)
    return () => window.removeEventListener('message', onMessage)
  }, [])

  // Topbar model pick → drive the active session's selection AND make it the
  // global default: new sessions start on it, in every window — the runtime
  // writes it to settings.json and publishes it (same path the
  // `session.applyAgentConfig` handler takes). Both writes are best-effort; a
  // failure must not break the UI.
  const handleTopbarSelectModel = useCallback(
    (selection: BrowserLlmSelection) => {
      pickGlobalDefaultSelection(selection)
      void setModelSelection(selection).catch(() => {})
    },
    [setModelSelection, pickGlobalDefaultSelection],
  )

  // Composer effort pick → THIS session only. No global default, no
  // settings.json: a new session still starts on the topbar's pick. The
  // topbar keeps showing the active session's selection, so it follows.
  // Bound to the session the pick came from — not the active one, which a
  // pick landing in the same tick as a session switch would otherwise hit.
  const handleSessionSelectModel = useCallback(
    (sessionId: string, selection: BrowserLlmSelection) => {
      void setModelSelectionForSession(sessionId, selection).catch(() => {})
    },
    [setModelSelectionForSession],
  )

  // Context popover's auto-compact handle → the session it was dragged in.
  // A failed write comes back on the snapshot (`autoCompact.saveError`).
  const handleSetAutoCompactWindow = useCallback(
    (sessionId: string, value: number | 'auto') => {
      void setAutoCompactWindowForSession(sessionId, value).catch(() => {})
    },
    [setAutoCompactWindowForSession],
  )

  // An AUTOMATIC fallback for the active session (the send gate's
  // adopt-default, the post-settings heal below) is not a topbar pick: it
  // fixes that session and leaves the user's global default and settings.json
  // alone — unless that default is itself unusable, when new sessions would
  // keep starting on it, and the fallback replaces it too.
  const healActiveSessionSelection = useCallback(
    (selection: BrowserLlmSelection) => {
      if (
        healReplacesGlobalDefault(
          configuredActiveCatalog,
          globalDefaultSelectionRef.current,
        )
      ) {
        handleTopbarSelectModel(selection)
        return
      }
      void setModelSelection(selection).catch(() => {})
    },
    [configuredActiveCatalog, handleTopbarSelectModel, setModelSelection],
  )

  // Mirror the runtime's global default: every `agent.changed` carries it
  // (any window's pick, a remote client's, a settings write), and the boot
  // read of settings.json `agent.model` seeds it. Subscribed BEFORE the read,
  // so a change published while the read is in flight is not lost — the
  // mirror drops the seed once it has heard anything fresher, and holds
  // echoes while this page's own pick is still being written.
  useEffect(() => {
    if (!settingsBridge) return
    return followGlobalDefault(settingsBridge, globalDefaultMirror)
  }, [settingsBridge, globalDefaultMirror])

  // Send gate fallback (AssistantUiThread.onNew): the active session's pinned
  // model is stale/unavailable but the catalog still has enabled providers.
  // Adopt the catalog default AND pop the quick model picker so the user sees
  // the adopted model and can switch it before re-sending.
  const [modelPickerOpenToken, setModelPickerOpenToken] = useState(0)
  const handleAdoptDefaultSelection = useCallback(
    (selection: BrowserLlmSelection) => {
      healActiveSessionSelection(selection)
      setModelPickerOpenToken(token => token + 1)
    },
    [healActiveSessionSelection],
  )

  // Closing the settings page arms a one-shot "heal the selection" pass: if
  // the active session's pinned model is (still) unavailable once the
  // refreshed catalog lands, silently adopt the catalog default so the next
  // send just works — this is what breaks the old loop where every send after
  // configuring a provider re-opened the provider-missing dialog. The ref
  // stays armed across renders because the post-settings catalog broadcast
  // arrives asynchronously; it disarms on the first render where the
  // selection is valid (nothing to do) or a default exists (adopt it).
  const adoptDefaultAfterSettingsRef = useRef(false)
  useEffect(() => {
    if (!adoptDefaultAfterSettingsRef.current) return
    const snapshot = activeState.snapshot
    const catalog = configuredActiveCatalog
    if (!snapshot || !catalog) return
    if (isSelectionEnabled(catalog, snapshot.currentSelection)) {
      adoptDefaultAfterSettingsRef.current = false
      return
    }
    // `createConfiguredModelCatalog` only keeps `defaultSelection` when it
    // resolves to an enabled provider+model; absent means no usable provider
    // yet — keep the pass armed and wait for the next catalog broadcast.
    const fallback = catalog.defaultSelection
    if (!fallback) return
    adoptDefaultAfterSettingsRef.current = false
    healActiveSessionSelection(fallback)
  }, [configuredActiveCatalog, activeState.snapshot, healActiveSessionSelection])

  const activeSelection = activeState.snapshot?.currentSelection
  // Track the last DEFINED active selection for new-thread inheritance. Only
  // overwrite when defined: by the time createSessionInitPayload runs for a
  // New Thread, the active session has already switched to the new (empty)
  // session whose snapshot has no selection yet — overwriting with that
  // `undefined` would lose the outgoing session's pick and reset to the boot
  // default. Keeping the last defined value inherits what the user was using.
  if (activeSelection) activeSelectionRef.current = activeSelection

  // Mirror the active session's title into the NATIVE window title via the host bridge (and
  // document.title). Under e2e (`?e2eTrace=1`) the running test's code is prefixed; in
  // production `applyE2eTestCodePrefix` is the identity function.
  const e2eTestCode = useSyncExternalStore(
    subscribeE2eTestCode,
    getE2eTestCode,
    getE2eTestCode,
  )
  const activeWindowTitle = resolveActiveSessionWindowTitle(
    sessions,
    activeSessionId,
  )
  // Only the NATIVE title carries the prefix: `document.title` stays the bare composed
  // title, a guest-visible contract.
  const hostWindowTitle = applyE2eTestCodePrefix(activeWindowTitle, e2eTestCode)
  useEffect(() => {
    void setActiveSessionTitle(hostBridgeTransport, hostWindowTitle).catch(
      () => {
        // Best-effort — dev/mock hosts don't implement ui.setActiveSessionTitle.
      },
    )
    document.title = formatWindowTitle(activeWindowTitle, getProductName())
  }, [hostBridgeTransport, activeWindowTitle, hostWindowTitle])

  // `session.applyAgentConfig`: route only the `model` key to the active session and mirror
  // it into `browserDefaultSelection`; other keys are ignored (global keys ride `agent.changed`).
  useEffect(() => {
    return subscribeAgentConfig(hostBridgeTransport, event => {
      const model = event.config?.['model'] as
          | { providerId?: unknown; modelId?: unknown; thinkingTier?: unknown }
          | undefined
      if (
        model &&
        typeof model.providerId === 'string' &&
        typeof model.modelId === 'string'
      ) {
        const newSelection: BrowserLlmSelection = {
          providerId: model.providerId,
          modelId: model.modelId,
          ...(typeof model.thinkingTier === 'string'
            ? { thinkingTier: model.thinkingTier }
            : {}),
        }
        void setModelSelection(newSelection)
        setBrowserDefaultSelection(newSelection)
        // A profile-wide pick is a global one: new sessions follow it. The
        // runtime writes it to `~/.velloc/settings.json` `agent.model` and
        // publishes it to every page.
        pickGlobalDefaultSelection(newSelection)
      }
    })
  }, [
    hostBridgeTransport,
    setModelSelection,
    pickGlobalDefaultSelection,
  ])

  // Refresh the model catalogue and the git branch when the view regains focus. Two calls on
  // purpose: `refreshModelCatalog` does not re-resolve the branch.
  useEffect(() => {
    function triggerRefresh() {
      void refreshModelCatalog()
      void refreshProjectBranch()
    }

    function handleVisibilityChange() {
      if (typeof document !== 'undefined' && !document.hidden) {
        triggerRefresh()
      }
    }

    if (typeof document !== 'undefined') {
      document.addEventListener('visibilitychange', handleVisibilityChange)
    }
    if (typeof window !== 'undefined') {
      window.addEventListener('focus', triggerRefresh)
    }

    return () => {
      if (typeof document !== 'undefined') {
        document.removeEventListener('visibilitychange', handleVisibilityChange)
      }
      if (typeof window !== 'undefined') {
        window.removeEventListener('focus', triggerRefresh)
      }
    }
  }, [refreshModelCatalog, refreshProjectBranch])

  // Refresh the catalog on `providers.changed` too (an in-shell settings save fires no focus
  // event). One read gate for this and the boot read, so an older `providers.list` never wins.
  const providersReadGate = useMemo(() => createProvidersReadGate(), [])
  useEffect(() => {
    if (!settingsBridge) return
    return settingsBridge.subscribeEvents(envelope => {
      if (isProvidersChangedEvent(envelope)) {
        providersReadGate.noteChanged()
        const payload = envelope.payload as {
          configs?: Record<string, NexusProviderConfig>
          order?: string[]
          reason?: string
        }
        // Mirror the worker's registry into the PAGE realm. The two run in
        // separate JS contexts, each with its own `NEXUS_MODEL_CONFIG`, so
        // without this the shell-side lookups (context-window meter, tier
        // pills, curated-rule matching) would miss every custom model even
        // though the worker resolves them fine.
        if (payload?.configs) setCustomProviderRecords(payload.configs)
        if (Array.isArray(payload?.order)) setProviderOrder(payload.order)
        // A reorder configures no provider: the picker re-sorts from
        // `providerOrder` alone, so the catalog round trip is skipped.
        if (providersChangeAffectsCatalog(payload)) void refreshModelCatalog()
      }
    })
  }, [settingsBridge, refreshModelCatalog, providersReadGate])

  // Seed the page-realm custom-provider registry once at boot — the
  // `providers.changed` subscription above only fires on WRITES, so a
  // restored session on a custom provider would otherwise render with
  // built-in-only model metadata until the user touched the settings page.
  useEffect(() => {
    if (!settingsBridge) return
    let cancelled = false
    void providersReadGate
      .read(settingsBridge)
      .then(result => {
        // `null`: a `providers.changed` landed first and already applied a
        // state at least as new as this read.
        if (cancelled || !result) return
        setCustomProviderRecords(result.configs)
        // An older worker answers without `order`: keep the catalog order.
        if (Array.isArray(result.order)) setProviderOrder(result.order)
      })
      .catch(() => {
        /* best-effort — the worker seeds its own registry independently */
      })
    return () => {
      cancelled = true
    }
  }, [settingsBridge, providersReadGate])

  // sessionItems intentionally excludes `isActive` — the Sidebar
  // computes that internally from the separate `activeSessionId`
  // prop. Keeping it out lets sessions+sessionItems be stable across
  // switches, so React.memo on AssistantUiThread can shallow-compare
  // and skip re-renders of hidden mounted siblings.
  // Sessions HALTED awaiting the user: snapshot-derived approval controls
  // (plan / permission asks, read per mounted session) unioned with the
  // thread-reported unanswered questions. Drives the session-list attention dot.
  const needsAnswerSessionIds = useMemo(() => {
    const ids = new Set<string>()
    // Three sources, unioned: client snapshots (mounted sessions — immediate,
    // no summary-coalesce latency), the worker summary flag (covers sessions
    // whose client was disposed on mount-LRU eviction), and thread-reported
    // AskUserQuestion cards (which don't ride the worker snapshot).
    for (const [sessionId, sessionState] of sessionStates) {
      if (snapshotNeedsAnswer(sessionState.snapshot)) ids.add(sessionId)
    }
    for (const sessionId of summaryNeedsAnswerIds) ids.add(sessionId)
    for (const sessionId of sessionsWithPendingQuestions) ids.add(sessionId)
    return ids
  }, [sessionStates, summaryNeedsAnswerIds, sessionsWithPendingQuestions])

  // WHICH ask each halted session is halted on, for the sessions whose
  // snapshot is mounted. The attention queue's event id is per session, so
  // this is what lets it tell "answered and asked again" from "the same ask
  // blinked" (see `sessionAttention` — Identity). Summary-only and
  // thread-reported sessions carry no key; that reads as unknown, not as new.
  const needsInputAskKeys = useMemo(() => {
    const keys = new Map<string, string>()
    for (const [sessionId, sessionState] of sessionStates) {
      const key = snapshotAskKey(sessionState.snapshot)
      if (key) keys.set(sessionId, key)
    }
    return keys
  }, [sessionStates])

  const allSessionItems: SessionListItem[] = useMemo(
    () =>
      sessions.map(s => ({
        sessionId: s.sessionId,
        title: s.title,
        templateType: s.templateType,
        // Feeds the sidebar's Projects node — already persisted in the
        // session's `meta.json` and already on the summary broadcast, so
        // grouping by it costs no extra reads.
        projectRoot: s.projectRoot,
        spawnerSessionId: s.spawnerSessionId,
        teammateName: s.teammateName,
        shutdown: s.shutdown,
        shutdownAt: s.shutdownAt,
        previewText: s.previewText,
        updatedAt: s.updatedAt,
        // Only the topbar tab strip reads it: a lead's teammates are ordered
        // newest-first, so the child just spawned sits next to the lead.
        createdAt: s.createdAt,
        lastComposerEditAt: s.lastComposerEditAt,
        pinned: s.pinned,
        messageCount: s.messageCount,
        running: runningSessionIds.has(s.sessionId),
        needsAnswer: needsAnswerSessionIds.has(s.sessionId),
      })),
    [sessions, runningSessionIds, needsAnswerSessionIds],
  )

  // Sessions this channel does not show: a type its launcher catalog does not
  // list (a `team` created on beta, opened on stable), plus that session's
  // teammates. See `sessionVisibility.ts`.
  const hiddenIds = useMemo(
    () => hiddenSessionIds(allSessionItems),
    [allSessionItems],
  )

  // THE one place teammates and channel-hidden sessions are dropped.
  // Everything the sidebar, the search corpus and the thread list read is this
  // filtered array, so no component has to know what a team or a channel is;
  // the unfiltered array above exists only for the tab strip, which is where a
  // teammate becomes reachable.
  const sessionItems: SessionListItem[] = useMemo(
    () =>
      allSessionItems.filter(s => !s.spawnerSessionId && !hiddenIds.has(s.sessionId)),
    [allSessionItems, hiddenIds],
  )
  // The tab strip reads every visible session, teammates included — a hidden
  // lead takes its whole family out of it.
  const tabSessionItems: SessionListItem[] = useMemo(
    () => allSessionItems.filter(s => !hiddenIds.has(s.sessionId)),
    [allSessionItems, hiddenIds],
  )
  const sessionTabs = useMemo(
    () => deriveSessionTabs(tabSessionItems, activeSessionId),
    [tabSessionItems, activeSessionId],
  )
  // While a teammate is on screen, highlight its LEAD's row in the sidebar
  // (teammates are filtered out of sessionItems, so no row matches the raw
  // activeSessionId). Read the unfiltered allSessionItems for the lookup.
  const sidebarActiveId = useMemo(
    () => sidebarActiveSessionId(allSessionItems, activeSessionId),
    [allSessionItems, activeSessionId],
  )

  // Move off a boot session this channel hides, once the list is in. Not once-only: the
  // first `session.list` lands before its rows reach `sessions`.
  useEffect(() => {
    if (!bootSessionsStageFiredRef.current) return
    if (!hiddenIds.has(activeSessionId)) return
    const next = pickVisibleSession(sessions, hiddenIds)
    if (next) focusSession(next.sessionId)
    else openNewSession()
  }, [hiddenIds, activeSessionId, sessions, focusSession, openNewSession])

  // --- Session attention: "a session wants you, and you are not looking" ---
  // The queue lives here because this is where all three inputs already meet:
  // `needsAnswerSessionIds` (halted sessions, teammates included), the running
  // set, and the session rows carrying the last message. `sessionAttention.ts`
  // owns the rules; everything below is the shell's half - focus, the OS
  // notification, the switch.
  const [attentionQueue, setAttentionQueue] = useState<AttentionEvent[]>([])
  // The queue is ALSO held in a ref, and the ref is the one both writers read.
  // The reconcile below has to send an OS notification for each newly raised
  // event, and a side effect must never sit inside a `setState` updater: React
  // double-invokes updaters in StrictMode, which would fire every toast twice.
  // So the effects compute against the ref, run their side effects once, and
  // publish the result to state for rendering.
  const attentionQueueRef = useRef<AttentionEvent[]>(attentionQueue)
  const publishAttentionQueue = useCallback((next: AttentionEvent[]) => {
    if (next === attentionQueueRef.current) return
    attentionQueueRef.current = next
    setAttentionQueue(next)
  }, [])

  // Event ids already DELIVERED, pruned to those still desired. A `focus` reveal is marked
  // only once it found the control, so a not-yet-mounted card is retried.
  const deliveredAttentionRef = useRef<Set<string>>(new Set())

  // Event ids the user has ACKNOWLEDGED by going to the session (one raised where the user
  // already was is not); an acknowledged event never comes back. Pruned like the delivered marks.
  const acknowledgedAttentionRef = useRef<Set<string>>(new Set())

  // When each marked id was first seen missing from the derived set. Both
  // mark sets above end with their event, but "missing" is not "ended": a
  // remount of a halted session's thread makes its thread-reported ask blink
  // out and back, and forgetting the acknowledgement on that blink re-raised
  // an ask the user had already visited. `reconcileAttention` forgets a mark
  // only once its absence outlasts `ATTENTION_DROP_GRACE_MS`.
  const attentionAbsentSinceRef = useRef<Map<string, number>>(new Map())

  // The ask each live / marked id was last seen producing — what a returning
  // id is measured against, so a re-ask within the grace is not mistaken for
  // the blink the grace exists for.
  const attentionAskKeysRef = useRef<Map<string, string>>(new Map())

  // Scope the reveal to the session's OWN section: every mounted thread is in
  // the DOM at once (hidden ones are `display: none`), so an unscoped query
  // would happily focus a sibling session's pending control. Returns whether a
  // control was found. Synchronous on purpose: these run from effects, after
  // the commit that put the control in the DOM, and a deferral through
  // `requestAnimationFrame` never fires while the page is occluded — which is
  // exactly the state a window the user is not looking at is in.
  const revealAttentionInSession = useCallback(
    (sessionId: string): boolean =>
      revealAttentionSource(
        document.querySelector(
          `[${ATTENTION_SECTION_ATTR}="${CSS.escape(sessionId)}"]`,
        ),
      ),
    [],
  )

  // Is the Velloc window the user's ACTIVE surface? Both halves matter: a
  // window can be visible but not focused (a second monitor the user is not
  // typing into). The initial read is synchronous so the first event delivered
  // after boot is not classified against a guessed value.
  const [windowFocused, setWindowFocused] = useState(
    () =>
      typeof document === 'undefined' ||
      (document.visibilityState !== 'hidden' && document.hasFocus()),
  )
  useEffect(() => {
    const sync = () => {
      setWindowFocused(
        document.visibilityState !== 'hidden' && document.hasFocus(),
      )
    }
    window.addEventListener('focus', sync)
    window.addEventListener('blur', sync)
    document.addEventListener('visibilitychange', sync)
    return () => {
      window.removeEventListener('focus', sync)
      window.removeEventListener('blur', sync)
      document.removeEventListener('visibilitychange', sync)
    }
  }, [])

  // Sessions whose last turn ENDED on a question without halting: latched on the running →
  // stopped edge until visited or run again. `detectEndedWithQuestion` orders the two feeds.
  const endedQuestionTrackerRef = useRef(createEndedQuestionTracker())
  const [endedWithQuestion, setEndedWithQuestion] = useState<
    ReadonlyMap<string, string>
  >(() => new Map())
  useEffect(() => {
    // One index for every lookup below, instead of a linear scan per session.
    const rowById = new Map(
      sessions.map(item => [item.sessionId, item] as const),
    )
    // Mutates the tracker ref only — never inside the `setEndedWithQuestion`
    // updater, which StrictMode double-invokes.
    const ranSince = runningSeenSinceDetectRef.current
    runningSeenSinceDetectRef.current = new Set()
    const raised = detectEndedWithQuestion(
      endedQuestionTrackerRef.current,
      runningSessionIds,
      sessionId => rowById.get(sessionId)?.previewText,
      sessionId => rowById.has(sessionId),
      ranSince,
    )

    setEndedWithQuestion(current => {
      let next: Map<string, string> | null = null
      for (const [sessionId, preview] of raised) {
        if (current.get(sessionId) === preview) continue
        next = next ?? new Map(current)
        next.set(sessionId, preview)
      }
      // A session that started running again has superseded its own question.
      for (const sessionId of current.keys()) {
        if (!runningSessionIds.has(sessionId)) continue
        next = next ?? new Map(current)
        next.delete(sessionId)
      }
      return next ?? current
    })
  }, [runningSessionIds, sessions])

  // What a row needs to be recognised: the title, and the launcher type for
  // the same icon the sidebar row shows.
  const attentionSessions = useMemo(() => {
    const titles = new Map<string, string>()
    const templateTypes = new Map<string, string | undefined>()
    for (const item of allSessionItems) {
      titles.set(item.sessionId, sessionDisplayTitle(item, t))
      templateTypes.set(item.sessionId, item.templateType)
    }
    return { titles, templateTypes }
  }, [allSessionItems, t])

  // Reconcile, then deliver whatever is NEW. Delivery is decided per event by
  // `attentionDelivery`, and only `bar` actually needs the queue - a `focus`
  // event is consumed on the spot, and a `notify` event stays queued precisely
  // because the user is not there to consume it.
  useEffect(() => {
    // A session this channel hides never asks for attention: the bar would
    // offer a switch to a row the sidebar does not have, and the OS
    // notification would name one the user cannot find.
    // An event still derivable keeps its marks; one that has gone away — for
    // longer than a remount's blink — loses them, so the same session asking
    // again is delivered again. `reconcileAttention` owns that lifetime and
    // updates the three refs in place.
    const { queue, added, suppressed } = reconcileAttention(
      attentionQueueRef.current,
      {
        needsInputSessionIds: withoutHidden(needsAnswerSessionIds, hiddenIds),
        // Keyed by session and only ever read for a halted one, so the hidden
        // filter above already scopes it.
        needsInputKeys: needsInputAskKeys,
        endedWithQuestion: withoutHiddenKeys(endedWithQuestion, hiddenIds),
        titles: attentionSessions.titles,
        templateTypes: attentionSessions.templateTypes,
        now: Date.now(),
      },
      {
        acknowledged: acknowledgedAttentionRef.current,
        delivered: deliveredAttentionRef.current,
        absentSince: attentionAbsentSinceRef.current,
        askKeys: attentionAskKeysRef.current,
      },
    )

    // An acknowledged event is never delivered again — but the user may be
    // standing in the very session whose control the arrival could not find
    // (a session evicted from the mount LRU mounts on arrival and renders its
    // card a moment later). Retry that one reveal here, on the same terms as
    // the `focus` route below: it is the reveal that is outstanding, not the
    // notification.
    for (const event of suppressed) {
      if (!windowFocused || event.sessionId !== activeSessionId) continue
      if (deliveredAttentionRef.current.has(event.id)) continue
      if (revealAttentionInSession(event.sessionId)) {
        deliveredAttentionRef.current.add(event.id)
      }
    }

    let result = queue
    for (const event of added) {
      const delivery = attentionDelivery(event, {
        activeSessionId,
        windowFocused,
      })
      const alreadyDelivered = deliveredAttentionRef.current.has(event.id)
      // A route that DELIVERS the event where the user already is also spends
      // it (`deliveryConsumesEvent`). Marked before the branches below so the
      // rule is one line in one place rather than a property of whichever
      // branch happens to run.
      if (deliveryConsumesEvent(delivery)) {
        acknowledgedAttentionRef.current.add(event.id)
      }
      if (delivery === 'focus') {
        // The user is already here, so this never enters the queue — which
        // is why the clearing runs on EVERY pass while the ask is live, but
        // the reveal only on the first that finds the control. The
        // acknowledgement above is what makes the clearing STICK: without it
        // the derived queue re-raised the same event on the next pass and,
        // once the user had moved to another session, announced it there.
        const sessionId = event.sessionId
        result = clearAttentionForSession(result, sessionId)
        if (alreadyDelivered) continue
        if (revealAttentionInSession(sessionId)) {
          deliveredAttentionRef.current.add(event.id)
        }
        continue
      }
      deliveredAttentionRef.current.add(event.id)
      if (delivery === 'notify' && !alreadyDelivered) {
        // Reuse of the existing host surface: `ui.showNotification` is the
        // OS toast the turn-end nudge already uses, and the host suppresses
        // it whenever the window is active - so this cannot double up with
        // the bar even if our own focus read were stale.
        void showHostNotification(hostBridgeTransport, {
          title: t('attention.notificationTitle', { title: event.title }),
          message:
            event.kind === 'needs_input'
              ? t('attention.notificationNeedsInput')
              : (event.detail ?? t('attention.notificationQuestion')),
          notificationType: `session_attention_${event.kind}`,
        })
      }
    }
    publishAttentionQueue(result)
  }, [
    needsAnswerSessionIds,
    needsInputAskKeys,
    endedWithQuestion,
    hiddenIds,
    attentionSessions,
    activeSessionId,
    windowFocused,
    hostBridgeTransport,
    t,
    publishAttentionQueue,
    revealAttentionInSession,
  ])

  // THE clearing rule, and the only one: arriving at a session drops its
  // events. Keyed on (active session, window focus) rather than on the click,
  // so every route in - the bar, the OS notification, the sidebar, a teammate
  // jump, a plain tab switch - clears identically, and none of them has to
  // remember to. The focus half matters: a notification click raises the
  // window and selects the session in either order, and only the second of
  // those two events means the user has actually seen it.
  useEffect(() => {
    if (!activeSessionId || !windowFocused) return
    const before = attentionQueueRef.current
    const next = clearAttentionForSession(before, activeSessionId)
    publishAttentionQueue(next)
    // Arriving at a waiting session reveals its control, whatever the route, and marks its
    // events delivered; if the control is not mounted yet, the marks are dropped so the
    // reconcile retries.
    if (next !== before) {
      const revealed = revealAttentionInSession(activeSessionId)
      for (const event of before) {
        if (event.sessionId !== activeSessionId) continue
        // The visit IS the acknowledgement, whether or not a control was
        // found: the user went where they were sent. Re-raising it the
        // moment they move on is the "it never goes away" defect, and the
        // case where nothing was found is precisely the one that must not
        // be advertised a second time.
        acknowledgedAttentionRef.current.add(event.id)
        if (revealed) deliveredAttentionRef.current.add(event.id)
        else deliveredAttentionRef.current.delete(event.id)
      }
    }
    setEndedWithQuestion(current => {
      if (!current.has(activeSessionId)) return current
      const next = new Map(current)
      next.delete(activeSessionId)
      return next
    })
  }, [
    activeSessionId,
    windowFocused,
    publishAttentionQueue,
    revealAttentionInSession,
  ])

  const handleAttentionSelect = useCallback(
    (sessionId: string) => {
      if (sessionId === activeSessionId) {
        // Already here - the switch would be a no-op, so the useful action is
        // the reveal the `focus` route would have done. The visit effect will
        // not fire (neither of its inputs changes), so acknowledge here or the
        // row returns on the next switch away.
        revealAttentionInSession(sessionId)
        for (const event of attentionQueueRef.current) {
          if (event.sessionId !== sessionId) continue
          acknowledgedAttentionRef.current.add(event.id)
        }
        publishAttentionQueue(
          clearAttentionForSession(attentionQueueRef.current, sessionId),
        )
        return
      }
      focusSession(sessionId)
    },
    [
      activeSessionId,
      focusSession,
      publishAttentionQueue,
      revealAttentionInSession,
    ],
  )

  // The transcript's teammate cards — a peer's message, and the `Agent` call
  // that spawned it — jump to that teammate's session. They sit deep inside
  // assistant-ui's message tree with no path back to the shell, so they post
  // the request to a module store and it is resolved HERE, where the session
  // list is: by id for a spawn card, by member name (within this lead's own
  // family) for a message card. An unresolvable name means the teammate is
  // gone; the click is dropped rather than reported.
  useEffect(
    () =>
      subscribeTeammateJump(request => {
        const target = resolveTeammateJumpTarget(
          allSessionItems,
          activeSessionId,
          request,
        )
        if (target && target !== activeSessionId) focusSession(target)
      }),
    [allSessionItems, activeSessionId, focusSession],
  )

  // --- Global transcript search (Ctrl+K + the topbar control) --------------
  // Gated on the host advertising the `search` bridge capability AND on the
  // grant holding `search.queryTranscripts` (useTranscriptSearchGate).
  const transcriptSearch = useTranscriptSearchGate(
    searchCapable ?? false,
    runtimeCapabilities,
  )

  // The ONE search gesture that moves the user, in two forms: a HIT arms
  // a jump to its message, then switches; a TITLE-only row has no hits,
  // so it just switches (`target` absent) — and drops any jump still
  // armed for that session by an earlier hit whose reveal never ran (the
  // user switched away while the transcript was loading), or the plain
  // open would land on that stale message. Opening a session's result
  // LIST does neither.
  const handleSearchOpenSession = useCallback(
    (sessionId: string, target?: PendingMessageJump) => {
      if (target) {
        setPendingMessageJump(sessionId, target)
      } else {
        clearPendingMessageJump(sessionId)
      }
      // Only switch when it is a DIFFERENT conversation. Re-switching to
      // the one already on screen tears its view down and rebuilds it,
      // which reads as a reload and loses the scroll position we are
      // about to jump within.
      if (sessionId !== activeSessionId) {
        focusSession(sessionId)
      }
    },
    [focusSession, activeSessionId],
  )
  const handleSearchJump = useCallback(
    (
      sessionId: string,
      uuid: string,
      lineOrdinal: number,
      needle?: string,
      term?: string,
    ) => handleSearchOpenSession(sessionId, { uuid, lineOrdinal, needle, term }),
    [handleSearchOpenSession],
  )

  const sessionsRef = useRef(sessions)
  sessionsRef.current = sessions
  const sessionItemsRef = useRef(sessionItems)
  sessionItemsRef.current = sessionItems
  const handleDeleteThread = useCallback(
    (sessionId: string) => {
      // The runtime deletes a lead's teammates with it, so their threads go too.
      const doomed = new Set([
        sessionId,
        ...sessionsRef.current
          .filter(session => session.spawnerSessionId === sessionId)
          .map(session => session.sessionId),
      ])
      for (const id of doomed) disposeClient(id)
      // The successor of a deleted on-screen session is its neighbor among the
      // rows the sidebar shows; a row a collapsed section hides takes its
      // neighbor in the full order. The rail ignores collapse.
      const view = readSessionListView()
      const now = Date.now()
      const ids = (collapsed?: { pinned: boolean; recents: boolean }) =>
        sidebarRowOrder(sessionItemsRef.current, view, now, collapsed).map(
          session => session.sessionId,
        )
      const full = ids()
      const rowOrders = sidebarRailRef.current
        ? [full]
        : [
            ids({
              pinned: readSectionCollapsed('pinned'),
              recents: readSectionCollapsed('recents'),
            }),
            full,
          ]
      deleteSession(sessionId, rowOrders)
      setMountedSessionIds(prev => prev.filter(id => !doomed.has(id)))
      // Drop the deleted sessions' pane records and content (no leak).
      sessionLayoutsStore.remove(doomed)
      setPaneSessionUi(prev => {
        if (![...doomed].some(id => prev.has(id))) return prev
        const m = new Map(prev)
        for (const id of doomed) m.delete(id)
        return m
      })
    },
    [disposeClient, deleteSession, sessionLayoutsStore],
  )

  const handleComposerEdit = useCallback(
    (sessionId: string, composerDraft: string, editedAt: number) => {
      // Optimistic local cache update so the sidebar reorders before
      // the fs round-trip completes.
      updateSessionMeta(sessionId, {
        composerDraft,
        lastComposerEditAt: editedAt,
      })
      // Authoritative persist via the worker → conversation store →
      // fs. The SharedWorker manager will rebroadcast `session.updated`
      // back to us; mergeSessions reconciles by `lastComposerEditAt`.
      void updateSessionMetadata(sessionId, {
        composerDraft,
        lastComposerEditAt: editedAt,
      }).catch(error => {
        console.warn(
          'Failed to persist composer draft for session',
          sessionId,
          error,
        )
      })
    },
    [updateSessionMeta, updateSessionMetadata],
  )

  // Stable per-session callbacks keep the memoized <AssistantUiThread> trees from
  // re-rendering (createSessionMessageCallbackFactory). "Send in a forked session": fork with
  // an inclusive cut; resolves false when no ack arrives, so the text returns to the composer.
  const handleSendInForkedSession = useCallback(
    (fromSessionId: string, cutUuid: string, message: AppendMessage) =>
      forkSendRegistry.register(
        forkSession(fromSessionId, cutUuid, { keepCutMessage: true }),
        message,
      ),
    [forkSession, forkSendRegistry],
  )

  // The sidebar's Fork: copy the whole conversation; the `session.forked` ack
  // switches to the copy.
  const handleForkThread = useCallback(
    (sessionId: string) => {
      forkSession(sessionId, undefined, { keepCutMessage: true })
    },
    [forkSession],
  )

  const getSessionMessageCallbacks = useMemo(
    () =>
      createSessionMessageCallbackFactory(
        forkSession,
        handleRewindFromMessage,
        handleSendInForkedSession,
      ),
    [forkSession, handleRewindFromMessage, handleSendInForkedSession],
  )

  // Re-bind a code session to a known recent folder (chip dropdown pick). The
  // rebind rebuilds the runtime in the new folder; it no-ops (resolves false)
  // once the session has messages — folder is locked. Only on an accepted
  // rebind do we promote the folder in the MRU list and persist it on the
  // session (optimistic local + authoritative fs), so a locked session never
  // reorders recents or rewrites its metadata.
  const handleSelectProjectFolder = useCallback(
    (sessionId: string, path: string) => {
      const trimmed = path.trim()
      if (!trimmed) return
      void rebindProjectFolder(sessionId, trimmed).then(bound => {
        if (!bound) return
        addRecentFolder(trimmed)
        // Remember this folder as the default for a NEW session of the SAME
        // forced-folder type (`code`/`safe_code`) — the only types that inherit
        // their last-bound folder (`isForcedFolderTemplateType`; the runtime's
        // `session.open` composer), each in its OWN bucket. We
        // deliberately do NOT record for other types: binding a folder to an
        // agent/chat session must not leak into the bucket that new sessions
        // read, and defaulting an unknown type to `'agent'` here is exactly how
        // the `'agent'` bucket got polluted and opened agent sessions blank.
        const boundType = getSessionTemplateType(sessionId)
        if (isForcedFolderTemplateType(boundType)) {
          writeLastFolderForType(boundType, trimmed)
        }
        // Authoritative persist (worker → conversation store → fs). On resume /
        // reload `createSessionInitPayload` reads it back via
        // `getSessionProjectRoot` and re-binds the same folder. The current
        // session is already live on the new folder from the rebind above, so
        // no optimistic local write is needed.
        void updateSessionMetadata(sessionId, { projectRoot: trimmed }).catch(
          error => {
            console.warn(
              'Failed to persist project folder for session',
              sessionId,
              error,
            )
          },
        )
      })
    },
    [rebindProjectFolder, updateSessionMetadata, getSessionTemplateType],
  )

  // Open the native OS folder picker for a code session, then bind the chosen
  // folder. Used by the chip's "Open folder…" item and the forced first-run
  // dialog. A cancel (no path) is a silent no-op.
  const handleOpenProjectFolder = useCallback(
    async (sessionId: string) => {
      let result: Awaited<ReturnType<typeof pickProjectFolder>>
      try {
        result = await pickProjectFolder(hostBridgeTransport)
      } catch (error) {
        console.warn('Failed to open the project-folder picker:', error)
        return
      }
      if (result.canceled || !result.path) return
      handleSelectProjectFolder(sessionId, result.path)
    },
    [hostBridgeTransport, handleSelectProjectFolder],
  )

  // --- Sidebar "Projects" node -------------------------------------------
  //
  // The tree itself is DERIVED from `sessionItems[].projectRoot` (already
  // broadcast from each session's `meta.json`), so nothing here reads the
  // filesystem. This state covers only the gap that derivation cannot fill: a
  // project the user just added and has not opened a session in yet, which no
  // summary mentions. See `projectsStorage`. The list is the runtime's
  // (`workspace`); this re-renders whenever the mirror changes.
  const addedProjects = useWorkspaceState(state => state.projects)
  const addedProjectPaths = useMemo(
    () => addedProjects.map(entry => entry.path),
    [addedProjects],
  )
  const addedProjectOrder = useMemo(
    () => new Map(addedProjects.map(entry => [entry.path, entry.addedAt])),
    [addedProjects],
  )
  // The project awaiting delete confirmation (`null` = no dialog). Carries the
  // session count so the dialog can state exactly what is about to be removed.
  const [projectDeleteTarget, setProjectDeleteTarget] = useState<{
    path: string
    sessionCount: number
  } | null>(null)

  // "+" on the Projects header: native folder picker → registered project.
  // A cancel (no path) is a silent no-op, as with the composer chip's picker.
  const handleAddProject = useCallback(async () => {
    let result: Awaited<ReturnType<typeof pickProjectFolder>>
    try {
      result = await pickProjectFolder(hostBridgeTransport)
    } catch (error) {
      console.warn('Failed to open the project-folder picker:', error)
      return
    }
    if (result.canceled || !result.path) return
    addProject(result.path)
    // Also feed the type-agnostic MRU the composer chip's quick-picks read, so
    // a folder added here is offered there too.
    addRecentFolder(result.path)
  }, [hostBridgeTransport])

  // Launch a session of `templateType` bound to `projectRoot`, from a project
  // node's ⋯ menu. The folder is bound AT CREATION (`openNewSession`'s second
  // argument), which is what makes a `code` session created this way skip the
  // forced folder picker: `createSessionInitPayload` reads the folder back via
  // `getSessionProjectRoot`, so the runtime resolves a real project root and
  // `needsProjectFolder` never goes true. Verified by the e2e
  // "creates a code session in a project WITHOUT the folder picker".
  const handleLaunchInProject = useCallback(
    (projectRoot: string, templateType: string) => {
      const trimmed = projectRoot.trim()
      if (!trimmed) return
      openNewSession(templateType, trimmed)
      addRecentFolder(trimmed)
      writeLastFolderForType(templateType, trimmed)
    },
    [openNewSession],
  )

  // Copy a project's path (⋯ menu). Mirrors the composer chip's Copy path.
  const handleCopyProjectPath = useCallback((path: string) => {
    // Through the shared util: it falls back to execCommand where
    // `navigator.clipboard` is missing (non-secure context / guest webview).
    void writeClipboard(path).then(ok => {
      if (!ok) console.warn('Failed to copy the project path')
    })
  }, [])

  // Delete a project: confirmed in `projectDeleteTarget`'s dialog, then this
  // removes every session filed under that folder and drops the registry entry.
  // It NEVER touches the user's folder on disk — only the conversation history
  // Nexus stores under `~/.velloc/projects/<sanitized>/`.
  const handleConfirmDeleteProject = useCallback(
    (path: string) => {
      const normalized = normalizeProjectPath(path)
      const doomed = sessions.filter(
        session =>
          session.projectRoot &&
          normalizeProjectPath(session.projectRoot) === normalized,
      )
      // Delete the ACTIVE session last: `deleteSession` re-points from a stale closure, so
      // deleting it first could leave the shell on a sibling deleted later.
      const ordered = [
        ...doomed.filter(s => s.sessionId !== activeSessionId),
        ...doomed.filter(s => s.sessionId === activeSessionId),
      ]
      for (const session of ordered) {
        handleDeleteThread(session.sessionId)
      }
      removeProject(path)
      setProjectDeleteTarget(null)
    },
    [activeSessionId, handleDeleteThread, sessions],
  )

  // Reveal the bound folder in the native OS file manager (chip "Show in
  // Explorer"). Fire-and-forget; chromium-host only (mock/dev hosts reject).
  const handleRevealProjectFolder = useCallback(
    (path: string) => {
      const trimmed = path.trim()
      if (!trimmed) return
      void revealProjectFolder(hostBridgeTransport, trimmed).catch(error => {
        console.warn('Failed to reveal the project folder:', error)
      })
    },
    [hostBridgeTransport],
  )

  // Resolve the persisted draft for each mounted thread up-front so the
  // map below stays cheap. `sessions` is the merged local+remote list;
  // entries hydrated from localStorage at boot already carry their
  // saved `composerDraft`, so this lookup works on the very first
  // render before any worker traffic.
  const sessionDraftBySessionId = useMemo(() => {
    const map = new Map<string, string>()
    for (const session of sessions) {
      if (session.composerDraft) {
        map.set(session.sessionId, session.composerDraft)
      }
    }
    return map
  }, [sessions])

  const handleOpenSettings = useCallback(
    // eslint-disable-next-line @typescript-eslint/require-await
    async (section?: NexusSettingsSection): Promise<void> => {
      // Settings render IN-APP (React) instead of the separate Lit
      // panel pane. Map the legacy bridge sections onto the React nav: the
      // webapp-URL field now lives under "About".
      const legacySection = section as string | undefined
      const mapped: SettingsSectionId =
        legacySection === 'mcp'
          ? 'mcp'
          : legacySection === 'webapp'
            ? 'about'
            : legacySection === 'tools'
              ? 'general'
              : 'models'
      setSettingsSection(mapped)
    },
    [],
  )

  const handleLoadProviderMissingPrompt = useCallback(
    async (): Promise<ProviderMissingPrompt> =>
      getProviderMissingPrompt(hostBridgeTransport),
    [hostBridgeTransport],
  )

  const settingsHostActions = useMemo<SettingsHostActions>(
    () => ({
      revealFolder: (path: string) =>
        revealProjectFolder(hostBridgeTransport, path),
    }),
    [hostBridgeTransport],
  );

  // One pane's frame and body (F-9). The panes render outside the thread
  // providers, so each brings the handles the deep cards need. Overlaid,
  // Escape belongs to the overlay (it hides it); the panes' own Escape
  // handlers must not close a pane kept open.
  const renderSidePane = (kind: SidePaneKind): ReactNode => {
    const name = t(PANE_LABEL_KEY[kind])
    const Icon = PANE_ICON[kind]
    const frame = (title: ReactNode, body: ReactNode, actions?: ReactNode) => (
      <PaneFrame
        kind={kind}
        name={name}
        title={title}
        actions={actions}
        maximized={paneMaximized === kind}
        onToggleMaximized={() =>
          updatePaneRecord(r => setMaximized(r, r.maximized === kind ? null : kind))
        }
        onClose={() => closePaneFor(kind)}
        onFocus={() => focusPane(kind)}
        className="h-full"
      >
        <SessionAreaVisibleContext.Provider value={!settingsSection && !rightPanelOverlaid}>
        <RightPanelContentContext.Provider value={shellRightPanelContentValue}>
        <FilePathContext.Provider value={shellFilePathContextValue}>
        <Suspense fallback={null}>{body}</Suspense>
        </FilePathContext.Provider>
        </RightPanelContentContext.Provider>
        </SessionAreaVisibleContext.Provider>
      </PaneFrame>
    )
    if (kind === 'files') {
      return (
        <Suspense fallback={null}>
          <FilesPane
            state={activePaneRecord.files ?? EMPTY_FILES_PANE}
            sessionKey={activeSessionId}
            onActivate={handleActivateFileTab}
            onCloseTab={handleCloseFileTab}
            protectedPaths={dirtyFilePaths}
            onDirtyChange={handleFileDirtyChange}
            fileReveal={rightPanelFileReveal}
            readFileText={readFileText}
            writeFileText={writeFileText}
            // Lock the editor while THIS session's turn is running (the agent
            // may be writing the same files); editing re-enables when it ends.
            editingLocked={runningSessionIds.has(activeSessionId)}
            frame={({ title, body }) => frame(title, body)}
          />
        </Suspense>
      )
    }
    const label = (
      <>
        <Icon aria-hidden className="size-3.5 shrink-0 text-muted-foreground" />
        <span className="min-w-0 truncate">{name}</span>
      </>
    )
    if (kind === 'browser') {
      // The title slot names the tab count until the pane has a page title to
      // show (the pane's own tab strip is a later package).
      return frame(
        <>
          {label}
          <span
            data-testid="pane-browser-tab-count"
            className="min-w-0 truncate font-normal text-muted-foreground"
          >
            {activeNexusTabCount === 1
              ? t('pane.browser.oneTab')
              : t('pane.browser.tabs', { count: String(activeNexusTabCount) })}
          </span>
        </>,
        <WebviewArea active shell={shellChannel ?? null} />,
        <Button
          type="button"
          variant="ghost"
          size="icon-xs"
          className="size-7"
          data-testid="pane-browser-new-tab"
          aria-label={t('pane.browser.newTab')}
          title={t('pane.browser.newTab')}
          onClick={() => {
            if (activeSessionId) openBrowserTab(activeSessionId)
          }}
        >
          <PlusIcon className="size-3.5" />
        </Button>,
      )
    }
    return frame(
      label,
      <SidePaneBody
        kind={kind}
        planEntry={activePlanEntry}
        onPlanResolve={resolveActivePlan}
        onClosePlan={() => closePaneFor('plan')}
        taskRows={activeSessionSubAgentRows}
        taskFocusSessionId={backgroundTaskFocusSessionId}
        taskListRequest={backgroundTaskListRequest}
        onTaskFocusConsumed={handleTaskFocusConsumed}
        onCloseTasks={() => closePaneFor('tasks')}
        onTaskStop={handleStopSubAgent}
        onTaskResume={handleResumeSubAgent}
        loadTaskTranscript={handleLoadSubAgentTranscript}
        diffTarget={rightPanelDiffTarget}
        skillTarget={rightPanelSkillTarget}
        loadedSkills={activeLoadedSkills}
        onSelectSkill={handleSelectSkill}
        loadToolCallDetail={loadToolCallDetail}
        loadBundledSkillBody={loadBundledSkillBody}
        readFileText={readFileText}
        turnDiffHistory={activeState.turnDiffHistory ?? null}
        loadTurnDiffDetail={loadTurnDiffDetail}
        requestTurnDiffHistory={requestTurnDiffHistory}
        onOpenFile={openFileInPanel}
      />,
    )
  }

  return (
    // Both providers are no-ops on the desktop (F-24): a `full`
    // grant answers every `can()` true, and a MessagePort connection is
    // `ready` for its whole life.
    <RuntimeCapabilitiesContext.Provider value={runtimeCapabilities}>
    <RuntimeReadyContext.Provider value={isRuntimeReady(connectionState)}>
    <SessionStatusChannelContext.Provider value={sessionStatusChannel ?? null}>
    <SettingsBridgeContext.Provider value={settingsBridge ?? null}>
    <>
    <SettingsHostActionsContext.Provider value={settingsHostActions}>
    <SettingsSessionContext.Provider value={activeSessionId ?? null}>
    <main
      style={{
        // NO fixed min-height: a floor taller than the panel is clipped by `#app`'s overflow,
        // cutting off the composer.
        minHeight: 0,
        height: '100%',
        width: '100%',
        display: 'flex',
        flexDirection: 'column',
      }}
    >
      <NexusTopBar
        sessionTabs={sessionTabs}
        activeSessionId={activeSessionId}
        // Switching tab IS switching session — that is the whole feature.
        onSelectSessionTab={focusSession}
        catalog={orderedActiveCatalog}
        selection={activeSelection}
        defaultSelection={globalDefaultSelection ?? browserDefaultSelection}
        onSelectModel={handleTopbarSelectModel}
        modelPickerOpenToken={modelPickerOpenToken}
        onOpenSettings={handleOpenNexusSettings}
        onOpenProviderSettings={handleOpenProviderSettings}
        onPressPluginItem={runtimeConnection ? handlePressPluginItem : undefined}
        sidebarCollapsed={sidebarCollapsed || sidebarHidden}
        onToggleSidebar={handleToggleSidebar}
        searchSlot={
          transcriptSearch.enabled ? (
            <TopbarSearch
              transport={hostBridgeTransport}
              resolveHomeDir={resolveSearchHomeDir}
              sessions={sessionItems}
              activeSessionId={activeSessionId}
              onJumpToMatch={handleSearchJump}
              onOpenSession={handleSearchOpenSession}
              openToken={transcriptSearch.openToken}
            />
          ) : undefined
        }
        onDragRegionsChange={(regions) => {
          void setWindowDragRegions(hostBridgeTransport, regions).catch(() => {
            /* build-gated C++ route / mock host has no window to drag */
          })
        }}
        openPanes={openPanes}
        onTogglePane={togglePane}
        sessionOverview={{
          shown:
            paneMaximized === null &&
            (sessionCardsFit ? sessionCardPrefs.shown : sessionCardsPopoverOpen),
          onToggle: handleToggleSessionCards,
        }}
        onResetLayout={handleResetLayout}
        backgroundTaskCount={countRunning(activeSessionSubAgentRows)}
        importSources={topbarImportSources}
        onOpenImport={setImportDialogSource}
        remoteDeviceCount={remoteDeviceCount}
        remoteHost={remoteHost}
        onRemoteLogOut={onRemoteLogOut}
      />
      {/* The wire to the runtime is down (remote only): one
          overlay over the whole shell, with the countdown to the next try
          and a button to try now. Nothing at all while `ready`, which is
          every desktop moment. */}
      <RemoteOfflineOverlay
        state={connectionState}
        onReconnectNow={handleReconnectNow}
      />
      {/* Remote only (page identity, like the host indicator): how to open
          this page as an app. Nothing once installed or dismissed. */}
      {remoteHost ? <RemoteInstallTip /> : null}
      {/*
        Between the topbar and the session area, in the same flex column, so a
        waiting session pushes the conversation down instead of covering it.
        Renders nothing while the queue is empty, and nothing while the window
        is not the user's active surface: an event raised then was delivered
        as the OS toast and waits in the queue for the user's return.
      */}
      <SessionAttentionBar
        events={attentionQueue}
        windowFocused={windowFocused}
        onSelect={handleAttentionSelect}
      />
      {importDialogMounted ? (
        <Suspense fallback={null}>
          <ImportDialog
            source={importDialogSource}
            open={importDialogSource !== null}
            onOpenChange={(next) => {
              if (!next) setImportDialogSource(null)
            }}
            onOpenSession={(sessionId) => {
              setImportDialogSource(null)
              handleSearchOpenSession(sessionId)
            }}
          />
        </Suspense>
      ) : null}
      {/* Settings is an overlay SIBLING: the session area stays mounted (`display:none`), so
          mounted threads keep their UI state and attention acknowledgements. */}
      {settingsSection ? (
        <Suspense fallback={null}>
        <SettingsScreen
          section={settingsSection}
          onNavigate={handleSettingsNavigate}
          onClose={() => {
            // Arm the one-shot adopt-default pass (see the effect by
            // handleAdoptDefaultSelection): if the user came here from the
            // provider-missing flow, the session's stale pinned model must be
            // replaced by the now-available default or every send re-opens
            // the dialog.
            adoptDefaultAfterSettingsRef.current = true
            setProviderSettingsRequest(null)
            setPluginSettingsRequest(null)
            setSettingsSection(null)
          }}
          catalog={orderedActiveCatalog}
          transport={hostBridgeTransport}
          openProviderRequest={providerSettingsRequest}
          revealPluginRequest={pluginSettingsRequest}
          // Remote access reads `remote/state` and calls `remote.*` over
          // the page's one connection — never the host bridge directly (P-3).
          runtimeConnection={runtimeConnection}
          // F-24: Remote access manages the DESKTOP's listener — never shown
          // on a remote client page, whatever its grant.
          remoteClient={remoteHost !== undefined}
          // OAuth sign-in (e.g. ChatGPT Pro) connects on the C++ broker without
          // firing `providers.changed`, so refresh the catalog directly on
          // success — otherwise the quick model picker misses the new provider
          // until the next window focus/visibility event.
          onProviderConnected={() => {
            void refreshModelCatalog()
          }}
        />
        </Suspense>
      ) : null}
      {
      /* Full-bleed below the topbar: no radius and no outer border. */
      // Hidden is not gone: keyboard listeners stay live under Settings, so the area's
      // visibility is published as one flag, `SessionAreaVisibleContext`.
      <SessionAreaVisibleContext.Provider value={!settingsSection}>
      <div
        ref={sessionAreaRef}
        data-testid="nexus-session-area"
        data-sidebar-form={shellLayout.sidebar}
        className="relative flex min-h-0 w-full flex-1 overflow-hidden bg-background"
        // See the overlay note above: hidden — never unmounted — while settings
        // is open, so the mounted threads keep their pending-question and
        // attention state across an open→close.
        style={settingsSection ? { display: 'none' } : undefined}
      >
        {/*
          Sidebar lives once at shell scope (lifted out of
          AssistantUiThread). It receives `sessionItems` (stable
          across switches — no `isActive` baked in) plus the
          separate `activeSessionId`, and computes per-item
          highlighting internally. Renders once per shell-render,
          regardless of how many thread trees are in the LRU.
        */}
        <SidebarPeek
          hidden={sidebarHidden}
          open={sidebarPeek}
          onOpenChange={setSidebarPeek}
          activeSessionId={activeSessionId}
        >
        <Sidebar
          title="Conversation"
          sessionId={activeSessionId}
          activeSessionId={sidebarActiveId}
          collapsed={sidebarRail}
          sessions={sessionItems}
          onNewThread={openNewSession}
          onLaunchThread={openNewSession}
          onSwitchThread={focusSession}
          onDeleteThread={handleDeleteThread}
          onRenameThread={retitleSession}
          onPinThread={handlePinThread}
          onForkThread={handleForkThread}
          width={sidebarWidth}
          isResizing={isResizingSidebar}
          runtimeConnection={runtimeConnection}
          addedProjectPaths={addedProjectPaths}
          addedProjectOrder={addedProjectOrder}
          onAddProject={handleAddProject}
          onDeleteProject={(path, sessionCount) =>
            setProjectDeleteTarget({ path, sessionCount })
          }
          onRevealProject={handleRevealProjectFolder}
          onCopyProjectPath={handleCopyProjectPath}
          onLaunchInProject={handleLaunchInProject}
        />
        </SidebarPeek>
        {/* Splitter between the docked sidebar and the conversation; it draws the 1px divider. */}
        {shellLayout.sidebar === 'expanded' && (
          <SidebarSplitter
            width={sidebarWidth}
            minWidth={SIDEBAR_MIN_WIDTH_PX}
            maxWidth={Math.max(SIDEBAR_MIN_WIDTH_PX, Math.min(SIDEBAR_MAX_WIDTH_PX, shellLayout.sidebarMaxW))}
            onResize={handleSidebarResize}
            onResizeStart={handleSidebarResizeStart}
            onResizeEnd={handleSidebarResizeEnd}
          />
        )}
        {/*
          Render one <AssistantUiThread> per mounted session
          (keep the last MAX_MOUNTED_THREADS mounted, hide non-active
          with `display: none`). Hidden trees stay in the React tree so
          switching is a paint-toggle, not an unmount/remount.
        */}
        <PaneArea
          layout={paneLayout}
          maximized={paneMaximized}
          form={shellLayout.panel}
          chatWidth={shellLayout.chatW}
          seatWidth={effectiveSideWidth}
          overlayShown={rightPanelOverlayShown}
          seatProps={rightPanelOverlaid ? rightPanelOverlayDismiss : undefined}
          renderPane={renderSidePane}
          onResizeCommit={commitPaneResize}
          onPaneMove={commitPaneMove}
          chat={
          <>
        {mountedSessionIds.map(sessionId => {
          const isActive = sessionId === activeSessionId
          const state = sessionStates.get(sessionId) ?? activeState
          const messageCallbacks = getSessionMessageCallbacks(sessionId)
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
                // Narrower than its content: the content keeps its width and
                // is clipped at the panel's edge, never squeezed.
                overflow: isActive && shellLayout.chatClipped ? 'clip' : undefined,
              }}
              data-chat-clipped={(isActive && shellLayout.chatClipped) || undefined}
            >
              <div
                className="flex h-full min-w-0 flex-1"
                style={
                  isActive && shellLayout.chatClipped
                    ? { minWidth: CHAT_CONTENT_MIN_WIDTH_PX }
                    : undefined
                }
              >
              <ThreadErrorBoundary sessionId={sessionId} t={t}>
                <AssistantUiThread
                  state={state}
                  readOnly={shutdownSessionIds.has(sessionId)}
                  submitPrompt={submitPrompt}
                  submitActionMessage={submitActionMessage}
                  continueConversation={continueConversation}
                  submitComposerMessage={submitComposerMessage}
                  onPickAttachmentFiles={pickComposerAttachmentFiles}
                  submitToolResult={submitToolResult}
                  loadToolCallDetail={loadToolCallDetail}
                  loadTurnDiffDetail={loadTurnDiffDetail}
                  interrupt={interrupt}
                  setPermissionMode={setPermissionMode}
                  setSkipDangerousMode={setSkipDangerousMode}
                  onClearPendingMessage={clearPendingMessage}
                  onRemoveInjectMessage={removeInjectMessage}
                  resolveToolUseConfirm={resolveToolUseConfirm}
                  clearPlanApproval={clearPlanApproval}
                  sessions={sessionItems}
                  activeSessionId={activeSessionId}
                  onOpenBackgroundTasks={handleOpenBackgroundTasks}
                  // THIS session's running background tasks (not the active
                  // session's) — each mounted thread shows its own footer
                  // "still working" indicator.
                  runningBackgroundTaskCount={countRunning(subAgentRowsForSession(sessionId))}
                  backgroundTaskRows={subAgentRowsForSession(sessionId)}
                  onStopBackgroundTask={handleStopSubAgent}
                  onOpenBackgroundTasksList={handleOpenBackgroundTasksList}
                  onOpenPlanPanel={() => openPaneFor('plan')}
                  onOpenFileInPanel={openFileInPanel}
                  statFilePaths={statFilePaths}
                  onOpenDiffInPanel={openDiffInPanel}
                  onOpenSkillInPanel={openSkillInPanel}
                  onSwitchThread={focusSession}
                  onDeleteThread={handleDeleteThread}
                  onRenameThread={retitleSession}
                  onForkFromMessage={messageCallbacks.onFork}
                  onSendInForkedSession={messageCallbacks.onSendInFork}
                  onRewindToMessage={messageCallbacks.onRewind}
                  onPendingQuestionsChange={handlePendingQuestionsChange}
                  onNewThread={openNewSession}
                  openSettings={handleOpenSettings}
                  onOpenPluginSettings={handleOpenPluginSettings}
                  modPanesDocked={modPanesDocked}
                  modDockFront={modDockFronts.get(sessionId) ?? null}
                  onModDockFrontChange={handleModDockFrontChange}
                  sessionCardsPopoverOpen={isActive && !sessionCardsFit && sessionCardsPopoverOpen}
                  onSessionCardsPopoverClose={closeSessionCardsPopover}
                  runtimeConnection={runtimeConnection}
                  loadProviderMissingPrompt={handleLoadProviderMissingPrompt}
                  onAdoptDefaultSelection={handleAdoptDefaultSelection}
                  onSelectSessionModel={handleSessionSelectModel}
                  onSetAutoCompactWindow={handleSetAutoCompactWindow}
                  onSelectProjectFolder={handleSelectProjectFolder}
                  onOpenProjectFolder={handleOpenProjectFolder}
                  onRevealProjectFolder={handleRevealProjectFolder}
                  initialComposerDraft={sessionDraftBySessionId.get(sessionId)}
                  onComposerEdit={handleComposerEdit}
                />
              </ThreadErrorBoundary>
              </div>
            </section>
          )
        })}
          </>
          }
        />
      </div>
      </SessionAreaVisibleContext.Provider>}
      {projectDeleteTarget && (
        <ProjectDeleteDialog
          path={projectDeleteTarget.path}
          sessionCount={projectDeleteTarget.sessionCount}
          onCancel={() => setProjectDeleteTarget(null)}
          onConfirm={() =>
            handleConfirmDeleteProject(projectDeleteTarget.path)
          }
        />
      )}
      {/* Safety net for a refusal no `useCan` trimmed — and the thing that
          keeps `forbidden_scope` from surfacing as an unhandled rejection. */}
      <ForbiddenScopeNotice />
    </main>
    </SettingsSessionContext.Provider>
    </SettingsHostActionsContext.Provider>
    </>
    </SettingsBridgeContext.Provider>
    </SessionStatusChannelContext.Provider>
    </RuntimeReadyContext.Provider>
    </RuntimeCapabilitiesContext.Provider>
  )
}

/**
 * Confirmation for deleting a project: it removes the conversation history Nexus stores
 * (`~/.velloc/projects/<sanitized>/`), never the user's source folder, and names both
 * paths. A project with no sessions is only un-listed. Backdrop click cancels.
 */
export function ProjectDeleteDialog({
  path,
  sessionCount,
  onCancel,
  onConfirm,
}: {
  path: string
  sessionCount: number
  onCancel: () => void
  onConfirm: () => void
}) {
  const t = useT()
  const name = projectDisplayName(path)
  // Hand-rolled modal, not the shared Dialog primitive (which holds the gate
  // itself): hold the background updater's reload while it is up
  // (glic/unsavedEditsGate.ts). Mounted only while shown.
  useUnsavedEditsGate(true)
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4 backdrop-blur-sm"
      role="dialog"
      aria-modal="true"
      aria-labelledby="project-delete-dialog-title"
      data-testid="project-delete-dialog"
      onClick={onCancel}
    >
      <div
        className="w-full max-w-md rounded-2xl border bg-background p-6 shadow-2xl"
        onClick={event => event.stopPropagation()}
      >
        <h2
          id="project-delete-dialog-title"
          className="text-lg font-semibold text-foreground"
        >
          {t('sidebar.projectDeleteTitle')}
        </h2>
        <p className="mt-2 text-sm leading-relaxed text-muted-foreground">
          {sessionCount === 0
            ? t('sidebar.projectDeleteEmptyBody', { name })
            : t('sidebar.projectDeleteBody', {
                count: sessionCount,
                name,
                store: `${RUNTIME_DIR_NAME}/projects`,
                path,
              })}
        </p>
        <div className="mt-6 flex justify-end gap-2">
          <Button
            variant="outline"
            data-testid="project-delete-cancel"
            onClick={onCancel}
          >
            {t('sidebar.projectDeleteCancel')}
          </Button>
          <Button
            variant="destructive"
            data-testid="project-delete-confirm"
            onClick={onConfirm}
          >
            {t('sidebar.projectDeleteConfirm')}
          </Button>
        </div>
      </div>
    </div>
  )
}
