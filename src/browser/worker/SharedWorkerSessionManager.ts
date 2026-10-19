import type {
  BrowserBridgeRequest,
} from '../bridge/browserBridgeProtocol'
import { createBridgeRoute } from '../bridge/protocol/core'
import { createNativePrimitives } from '../bridge/nativePrimitives'
import {
  setBackgroundShellResultAcknowledger,
  setBackgroundShellSink,
  setBackgroundShellSpawner,
  type BackgroundShellLaunch,
} from '../../toolkit/run/backgroundShellSink'
import {
  setSideTaskSink,
  type FastCallFinish,
  type FastCallStart,
  type ForkTaskFinish,
  type ForkTaskStart,
  type RunJsTaskFinish,
  type RunJsTaskStart,
} from '../../backgroundTasks/sideTaskSink'
import { mintTaskHandle } from '../../backgroundTasks/taskId'
import {
  SUBAGENT_TASK_FILE_NAME,
  finishedRecordFromSessionMeta,
  finishedRecordFromTaskFile,
  parseSubAgentTaskFile,
} from './subAgentTaskFile'
import { awaitMemoryExtractions } from '../../memory/extract/extractionRunner'
import { snapshotNeedsAnswer } from '../../utils/sessionNeedsAnswer'
import {
  getNexusWorkspaceDirForType,
  projectHomeFor,
} from '../../utils/conversationStoragePaths'
import { SessionStorageCoordinator } from './SessionStorageCoordinator'
import { SessionSummaryRepository } from './SessionSummaryRepository'
import { WorkerEventRouter } from './WorkerEventRouter'
import { PortMessageRouter } from './PortMessageRouter'
import { SessionWorkerFactory } from './SessionWorkerFactory'
import { projectSessionInfo } from './sessionInfoProjection'
import type {
  BrowserConversationStore,
  BrowserSessionCounters,
  BrowserSessionMetadata,
  BrowserTranscriptWriteEntry,
  SessionMetaFile,
} from '../../sessions/sessionStore'
import {
  applyDiskOnlyMetadataPatch,
  applyDiskOnlyRename,
  buildForkedTranscriptEntries,
  isMessageLike,
} from '../../sessions/sessionStore'
import type { BrowserToolCallDetailRecord } from '../../utils/toolCallDetails'
import { installSessionTracer } from '../../utils/sessionTrace'
import { joinRuntimePath } from '../../utils/runtimePaths'
import { loadSessionTrustResolver } from '../../team/sessionTrust'
import type { ProviderTrust } from '../../settings/providerTrust'
import { installWorkerLogCapture } from '../../utils/workerLogBuffer'
import type { AgentRuntimeWorkerOptions } from './AgentRuntimeWorker'
import type { Message } from '../../runtime/RuntimeTypes'
import type { AgentToolKind } from './AgentTurnState'
import type { AgentRuntimeWorkerHandle } from './AgentRuntimeWorkerHandle'
export type { AgentRuntimeWorkerHandle } from './AgentRuntimeWorkerHandle'
import type {
  AgentRuntimeWorkerInitPayload,
  AgentWorkerInboundMessage,
  AgentWorkerOutboundMessage,
  AgentRuntimeWorkerSnapshot,
} from './workerProtocol'
import { DEFAULT_TEMPLATE_TYPE } from './workerProtocol'
import type {
  SharedWorkerInboundMessage,
  SessionWorkerInboundMessage,
  SessionCard,
} from './sharedWorkerProtocol'
import type { BrowserLlmSelection } from '../bridge/protocol/nexus_llm'
import type {
  NexusCurrentSessionPhase,
  NexusTaskInfo,
  NexusTaskKind,
  NexusTaskTranscriptEntry,
} from '../bridge/protocol/ui'
import {
  DEFAULT_PANEL_ID,
  FsxSearchService,
  RuntimeHub,
  installSessionSurface,
  registerFsxCapability,
  registerTerminalCapability,
  type HostEnvironment,
  type SessionOpenPayload,
  type SessionProjectRoot,
  type SessionSurface,
} from '../runtimeHub'
import { wireError } from '../runtimeProtocol'
import { composeSessionInit, hostEnvironmentOf } from './sessionOpenComposer'
import { NEXUS_INTERFACE_VERSION } from '../bridge/protocol/interfaceVersion'
import { setTeammateSpawner } from '../../team/teammateSpawner'
import {
  setSubAgentSpawner,
  type SubAgentSpawnParams,
} from '../../team/subAgentSpawner'
import {
  setSubAgentController,
  type SubAgentSnapshot,
  type SubAgentStopResult,
  type SubAgentResumeResult,
  type SubAgentListEntry,
} from '../../team/subAgentController'
import { setTeamMessenger } from '../../team/teamMessenger'
import { TeamCoordinator } from './TeamCoordinator'
import type { SpawnTeammateParams } from '../../team/teamTypes'
import {
  raiseDesktopAlert,
  type DesktopAlert,
} from '../../notifications/desktopNotify'
import { TURN_END_HOOK_NOTIFICATION_TYPE, buildTurnEndNotification } from '../../notifications/turnEndNotification'
import { getProductName } from '../../branding/productName'
import { LruMap } from './LruMap'
import {
  joinShellOutput,
  formatShellExit,
  formatShellSummary,
  classifyShellExit,
} from './shellFormatting'
import { DiagnosticsHub } from './DiagnosticsHub'
import { SharedWorkerPortHub } from './SharedWorkerPortHub'
import { TaskRegistry } from './TaskRegistry'
import { TaskDeliveryQueue } from './TaskDeliveryQueue'
import { SideTaskCoordinator } from './SideTaskCoordinator'
import { RoutineCoordinator } from './RoutineCoordinator'
import type { RestartWorkInputs } from '../runtimeHub/restartReadiness'
import type { DeliverRoutineToSession } from '../../routines/SessionDeliveryRunner'
import { BackgroundShellCoordinator } from './BackgroundShellCoordinator'
import { SuperShellTaskCoordinator } from './SuperShellTaskCoordinator'
import { setSuperShellTaskSink } from '../../backgroundTasks/superShellTaskSink'
import { BackgroundShellHostBridge } from './BackgroundShellHostBridge'
import { SubAgentCoordinator } from './SubAgentCoordinator'
import { SessionFeedPublisher } from './SessionFeedPublisher'
import {
  extractRecoveredRunJsRows,
  type RecoveredRunJsRow,
} from './recoverRunJsRows'
import {
  extractRecoveredTitleRows,
  type RecoveredTitleRow,
} from './recoverTitleRows'
import {
  extractRecoveredBashRows,
  SHELL_LAUNCH_TOOL_IDS,
  type RecoveredBashRow,
} from './recoverBashRows'
import {
  extractRecoveredSuperShellRows,
  parseSuperShellDetachedTaskId,
  parseSuperShellTaskOutputResult,
  resolveRecoveredSuperShellRows,
  type RecoveredSuperShellRow,
} from './recoverSuperShellRows'
import {
  clearSkillInvocationLogForSession,
  getAllSkillInvocationEvents,
  seedSkillInvocationEvents,
  setSkillEventLogPersister,
} from '../../skillLibrary/skillInvocationLog'
import { BridgeRequestRouter } from './BridgeRequestRouter'
import { ManagerBootServices } from './ManagerBootServices'
import { endProviderSessions } from '../../mods/provider/providerSessionEnd'
import { closeSessionMCPPool } from '../../mcp/sessionPools'
import { SessionInitOrchestrator } from './SessionInitOrchestrator'
import { setMcpHostProvider, type McpHostAccess } from '../../mcp/mcpHost'
import { TaskControlSurface } from './TaskControlSurface'
import type {
  RunJsSidecarDetail,
  SuperShellSidecarDetail,
} from './TaskControlSurface'
import {
  ZERO_COUNTERS,
  type SubAgentRunState,
  type OwnerRuntimeGlobals,
  type SubAgentResult,
  type NexusTaskDeliveryResult,
  type NexusTaskState,
  type NexusFinishedTaskRecord,
  type FinishedSubAgentRecord,
} from './taskTypes'
import {
  extractFinalAssistantText,
  projectSubAgentTranscript,
  forkDisplayLabel,
  fastCallDisplayLabel,
  runJsDisplayLabel,
  formatTaskNotifications,
  isNextPriorityTaskResult,
  isSubAgentSessionId,
  isTeammateSessionId,
} from './taskProjection'
import { currentRenderCachePolicy } from '../../renderCache/runtimeRenderCache'

const TOOL_DETAIL_CACHE_MAX = 64

// Super Edit's wire name. Inline literal (matching `SUPER_EDIT_TOOL_NAME` in
// browser/runJs/runJsProtocol.ts) for the same reason the renderer utils
// inline theirs — this module has no business importing a tool module.
const SUPER_EDIT_TOOL_NAME = 'SuperEdit'
// SuperShell's wire name — same inline-literal rule (`SUPER_SHELL_TOOL_NAME`).
const SUPER_SHELL_TOOL_NAME = 'SuperShell'

type SessionEntry = {
  worker: AgentRuntimeWorkerHandle
  /** Unique token per worker instance. Stale events from a disposed
   *  worker carry the old instanceId and are dropped by handleWorkerEmit. */
  instanceId: string
  ports: Set<MessagePort>
  /** True for the sessions no user is looking at — background sub-agents,
   *  teammates, headless routine runs. They own a real worker and a real
   *  entry, but get no status baseline at bind: that is for a session a client
   *  shows (see `bindSessionRuntime`). Set at registration rather than
   *  inferred from `ports.size`, which is transiently 0 for a UI session whose
   *  panel detached and would misclassify its re-bind. */
  background?: boolean
  // Set after `bindSessionRuntime` lands; the counter-persist write path.
  conversationStore?: BrowserConversationStore
  // A rename that arrived while the runtime existed but its store was not
  // bound yet (the `createAgentRuntime` window — MCP connect sits in it).
  // Applied through the store at bind, BEFORE the backfill write, so that
  // write cannot overwrite `meta.json` from a store that never saw the title.
  // Only the bound store writes `meta.json` while a runtime is bound; a
  // manager-side write here would be a lost-update race against it.
  pendingRename?: string
  // A pin/unpin that arrived in the same pre-bind window; written with the
  // identity patch at bind, for the same reason as `pendingRename`.
  pendingPinned?: boolean
  // Persisted to `meta.json` at bind so the sidebar icon/title survive
  // reload.
  templateType?: string
  // From the init payload only (never the sandbox fallback) — keeping unbound
  // sessions promptable. Persisted at bind so resume re-binds the folder.
  projectRoot?: string
  // Teammate identity from the init payload (see SessionInitEntry).
  spawnerSessionId?: string
  teammateName?: string
  // Synchronous projections; the store is the disk-of-record. Execution
  // state (phase, retry, stopRequested) lives on the Worker / delivery queue.
  model: BrowserLlmSelection | null
  counters: BrowserSessionCounters
  needsAnswer: boolean
  // Init failed → the next worker.init must re-dispatch instead of reusing a
  // runtime-less worker (P-1).
  initFailed?: boolean
  // Rebind revision: only the NEWEST ready commits pointers/stub deletion
  // (P-1).
  rebindOperationId?: number
  // Per-runtime globals snapshot captured at worker.ready — the sub-agent
  // ownerGlobals restore source; never re-read from the shared process slot.
  runtimeGlobals?: OwnerRuntimeGlobals
}

/** Priority of a queued `worker.submitMessage` turn — LOWER runs first:
 *  user input outranks team messages outrank
 *  sub-agent result deliveries. */
const SUBMIT_PRIORITY = { user: 0, mailbox: 1, delivery: 2 } as const

/** Coalesce window for `skill-events.json` writes: several invocations in one
 *  turn collapse into a single truncate-and-rewrite of the capped log. */
const SKILL_EVENTS_WRITE_COALESCE_MS = 250

export type SharedWorkerSessionManagerOptions = {
  createWorker: (options: AgentRuntimeWorkerOptions) => AgentRuntimeWorkerHandle
  /**
   * Ends a session's terminals when its runtime ends (F-31). Default: the
   * manager's own terminal service; a test passes a recorder.
   */
  closeTerminalsForSession?: (sessionId: string) => void
}

export class SharedWorkerSessionManager {
  // The single worker-allocation recipe: instance-token mint +
  // emit closure + storage-backend pass-through live in the factory; the
  // sessions map (whose entry shape differs per caller) stays here.
  // Assigned in the constructor — it wraps `options.createWorker`.
  private readonly workerFactory: SessionWorkerFactory
  private readonly bootServices: ManagerBootServices
  /** Ends a session's terminals with its runtime (F-31); assigned in the constructor. */
  private readonly closeTerminalsForSession: (sessionId: string) => void
  /** The `fsx` file search (F-9): its children run on the runtime's host port. */
  private readonly fsxSearch: FsxSearchService
  private readonly initOrchestrator: SessionInitOrchestrator
  private readonly taskControl: TaskControlSurface
  private readonly sessions = new Map<string, SessionEntry>()
  /** Which panel opened each session — where its boot progress is published. */
  private readonly panelOfSession = new Map<string, string>()
  /** Sessions whose in-memory counters changed during the current turn. */
  private readonly dirtySessionCounters = new Set<string>()
  /** Sessions a `session.delete` is tearing down; metadata writes for them are refused. */
  private readonly deletingSessions = new Set<string>()
  /** Compatibility state for worker handles without explicit boundary returns. */
  private readonly legacyStreamEndedSessions = new Set<string>()
  private readonly bridgeRouter = new BridgeRequestRouter({
    getSessionWorker: sessionId => this.sessions.get(sessionId)?.worker,
    listSessionIds: () => this.sessions.keys(),
    onDirectTransportChanged: transport => {
      this.runtimeHub.handleDirectTransportChanged(transport)
      if (transport) {
        this.bootServices.onDirectTransportAttached(transport)
        this.maybeAdoptPersistentShells()
        void this.storageCoordinator
          .handleDirectTransportAttached()
          .catch(error => {
            this.tracer.event('worker.manager.storage.refreshFailed', {
              attrs: {
                message:
                  error instanceof Error ? error.message : String(error),
              },
            })
          })
      } else {
        this.storageCoordinator.handleDirectTransportDetached()
        this.bootServices.onDirectTransportDetached()
      }
    },
  })
  // The UI ⇄ Runtime protocol hub: one ClientConnection per `bridge.attachRuntimePort`.
  // `runtimeVersion` is the bridge interface version.
  private readonly runtimeHub = new RuntimeHub({
    getDirectBridgeTransport: () => this.bridgeRouter.getDirectTransport(),
    createBridgeRequestId: () => this.generateBridgeRequestId(),
    applyAgentSettingsToAllSessions: config =>
      this.applyAgentSettingsToAllSessions(config),
    reloadPluginsOnAllSessions: () => this.reloadPluginsOnAllSessions(),
    reloadModsOnAllSessions: () => this.reloadModsOnAllSessions(),
    submitToSession: (sessionId, payload) => {
      if (!this.sessions.has(sessionId) || !this.runtimeSessionSurface) return false
      this.runtimeSessionSurface.submit(sessionId, payload)
      return true
    },
    runtimeVersion: `interface-${NEXUS_INTERFACE_VERSION}`,
    resolveHomeDir: () => this.storageCoordinator.resolveHomeDir(),
    // A client started viewing a session: it needs that session's full status,
    // not a delta against a state it never saw.
    onPresenceChanged: change => {
      if (change.viewing) this.feed.announceStatus(change.viewing)
    },
    sessionProjectRoots: () => this.sessionProjectRoots(),
    panelOfSession: sessionId => this.panelOfSession.get(sessionId),
  })
  // The protocol's session surface: `session.*` / `task.*` /
  // `diag.traceFlush` requests and the `sessions` / `session/<id>/*` / `tasks` /
  // `diag/trace` topics, as a strangler over this Manager's port protocol — the
  // hub's ONE virtual port goes through `portRouter.handle` like a page port,
  // and what the Manager posts back to it is published to topics. Installed in
  // the constructor (needs `portRouter`, a later field).
  private runtimeSessionSurface: SessionSurface | null = null
  // Port subscription state is owned by the SharedWorkerPortHub (PR 8):
  // the connected-port set, per-port session subscriptions, and the
  // toolCallId → ports reverse index all live there. The Manager drives
  // the hub from the connect/disconnect/subscribe lifecycle and reads
  // subscribers back for broadcasts.
  private readonly portHub = new SharedWorkerPortHub()
  // Tool-call detail LRU. Entries land here either via proactive
  // persistence (`worker.toolDetailPersisted`) or via explicit fs load
  // when a late subscriber asks for an id the worker never touched.
  private readonly toolDetails = new LruMap<
    string,
    BrowserToolCallDetailRecord | null
  >(TOOL_DETAIL_CACHE_MAX)
  // RECOVERED run_js drawer rows per loaded session — rebuilt from each full
  // transcript emission (worker.messages, mode 'full'), so the drawer's
  // "Super Edit" section survives an app restart even though the registry's
  // local_js records are worker-lifetime-only. The publisher merges these,
  // skipping call ids the registry still knows. Cleared on session dispose.
  private readonly recoveredRunJs = new Map<string, RecoveredRunJsRow[]>()
  // Same restart-recovery story for background shells (`local_bash`): the
  // registry's shell records are worker-lifetime-only, but a loaded session's
  // transcript still holds every backgrounded command + its output-file path,
  // so the drawer's shell rows survive an app restart. The process itself is
  // long dead — this is read-only history (no Stop/Resume). Cleared on dispose.
  private readonly recoveredBash = new Map<string, RecoveredBashRow[]>()
  // …and for SuperShell runs (`local_supershell`), which also need each call's
  // tool-detail sidecar: only the sidecar names a detached run's task id, whose
  // outcome is a later notification or TaskOutput read (recoverSuperShellRows.ts).
  // Cleared on dispose.
  private readonly recoveredSuperShell = new Map<string, RecoveredSuperShellRow[]>()
  // …and for the session-title namer (`local_fast`, Sub-agents section): each
  // title it stored is an `ai-title` transcript entry, rebuilt into a finished
  // row. Only titles from before `lifetimeStartedAt` — later ones still have
  // their registry record. Cleared on dispose.
  private readonly recoveredTitles = new Map<string, RecoveredTitleRow[]>()
  private readonly lifetimeStartedAt = Date.now()
  // Sessions whose restart-recovered drawer rows have already been rebuilt this
  // lifetime — the LAZY gate. The transcript scan runs at most once per session,
  // triggered by the Background Tasks drawer opening (`task.recoverBackground`),
  // never eagerly on load. Cleared on dispose so a reopened session re-recovers.
  private readonly backgroundRecovered = new Set<string>()
  // Recoveries still in flight. A Super Shell detail loaded meanwhile waits for
  // them, so a detached run shows its result instead of its hand-off.
  private readonly backgroundRecoveries = new Map<string, Promise<void>>()
  // Restart persistence for the Skills-tab invocation event log
  // (`skillInvocationLog`, realm-global + in-memory). The Manager owns storage,
  // so it registers a write-through persister at construction and coalesces each
  // session's writes here (one timer per session, latest state wins), and reads
  // the `skill-events.json` sidecar back on session bind — once per session per
  // lifetime, promise-cached below — so the loaded/failed history
  // survives a process restart. See `ensureSkillEventsRecovered` /
  // `flushSkillEventsPersist`.
  private readonly skillEventsWriteTimers = new Map<
    string,
    ReturnType<typeof setTimeout>
  >()
  private readonly skillEventsRecovery = new Map<string, Promise<void>>()
  // Live trace subscribers, owned by the DiagnosticsHub (PR 8). Each entry
  // maps a port to an optional traceId filter (undefined = receive every
  // record). The hub pushes `trace.record` to each entry as spans land in
  // the tracer, and owns the WHOLE source-subscription
  // lifecycle itself (install on first subscriber, teardown with the last,
  // through unsubscribe AND disconnect). The Manager's former duplicate
  // unsubscribe fields are gone: the disconnect path only tore down the
  // tracer half, leaving the worker-log listener installed forever.
  private readonly diagnostics = new DiagnosticsHub()
  // Single shared tracer for this realm. Records all spans across the
  // manager and every per-session BrowserRuntimeWorker.
  private readonly tracer = installSessionTracer({ context: 'worker' })
  // Worker-realm console capture (console.warn/error + uncaught errors),
  // shared across the manager and every per-session worker in this realm.
  // Patches the global console once; the originals are still called.
  private readonly workerLogBuffer = installWorkerLogCapture()
  // ---- Session-transcript storage ----------------
  // Backend bring-up (grouped home-anchored vs legacy flat layout), the
  // memoized home-dir probe, and per-session storage routing live in the
  // coordinator. The Manager supplies the transport getter (the direct
  // port installs after construction, via bridge.setPort) and kicks its
  // post-storage boot subsystems from `onStorageReady`. The read-only
  // getters below keep the Manager's many read sites (`this.storage.…`)
  // unchanged; every writer lives inside the coordinator.
  private readonly storageCoordinator = new SessionStorageCoordinator({
    getDirectBridgeTransport: () => this.bridgeRouter.getDirectTransport(),
    onStorageReady: () => {
      // Sidebar summary preload — background, throttled; nothing on the
      // boot-critical path awaits it (the worker.init reconcile does its own
      // targeted read, see `reconcilePersistedSessionBinding`).
      void this.summaryRepo.preloadFsSummaries()
      // Provider trust is needed synchronously when a frame is rendered, so
      // it is cached here. The AUTHORITATIVE read is the async one the spawn
      // path does (SpawnAgentTool) — this cache only labels messages.
      void this.refreshProviderTrust()
      this.bootServices.onStorageReady()
    },
  })
  private get storage() {
    return this.storageCoordinator.getStorage()
  }
  /** Cached session-provider to trust lookup (`loadSessionTrustResolver`);
   *  null until the first load lands. Refreshed before every lead delivery
   *  (`TeamCoordinatorHost.refreshSessionTrust`), not only at boot. */
  private providerTrust:
    | ((pinnedProviderId: string | undefined) => ProviderTrust)
    | null = null
  private get groupedStorage() {
    return this.storageCoordinator.getGroupedStorage()
  }
  private get homeDir() {
    return this.storageCoordinator.getHomeDir()
  }
  private get storagePath() {
    return this.storageCoordinator.storageRoot()
  }
  // ---- Session read-model caches ------------------
  // The live metadata overlay, fs-summary LRU, memoized routing scan,
  // persisted-projectRoot reconcile, and sidebar preload live in the
  // repository. The getters below keep the Manager's many map call sites
  // (`this.sessionMeta.…` / `this.fsSummaries.…`) unchanged; the
  // preload's "sidebar snap" broadcast stays here (it needs the ports).
  private readonly summaryRepo = new SessionSummaryRepository(
    this.storageCoordinator,
    {
      tracer: this.tracer,
      isSessionLive: sessionId => this.sessions.has(sessionId),
      onPreloadComplete: () => {
        // After preload, send each fs-only session to list subscribers so
        // their sidebar snaps from "live only" to the full list. Per-session
        // subscribers already see their targets via the subscribe handler's
        // immediate flush, so they don't need anything here.
        const listSubscribers = this.getListSubscribers()
        if (listSubscribers.length === 0) return
        const snapshot = {
          type: 'session.list' as const,
          payload: { sessions: this.buildSessionInfoList() },
        }
        for (const port of listSubscribers) {
          port.postMessage(snapshot)
        }
      },
      notifySessionUpserted: sessionId => this.notifySessionUpserted(sessionId),
    },
  )
  private get sessionMeta() {
    return this.summaryRepo.liveMeta
  }
  private get fsSummaries() {
    return this.summaryRepo.fsSummaries
  }
  // ---- Worker-event dispatch ----------------------
  // The dispatch ORDER for per-session worker outbound events lives in
  // the router; the Manager implements the branch bodies that still need
  // its state (sessions map, routine registry, subscriber ports) as the
  // host methods below. The sub-agent interception lives on the
  // SubAgentCoordinator.
  private readonly eventRouter = new WorkerEventRouter(this.summaryRepo, {
    isCurrentInstance: (sessionId, instanceId) => {
      // Instance guard. A stale worker (disposed and replaced for
      // the same sessionId) may still emit late events. Drop them if the
      // instanceId no longer matches the current session entry.
      const entry = this.sessions.get(sessionId)
      if (!entry || entry.instanceId !== instanceId) return false
      return true
    },
    captureRuntimeGlobalsOnReady: sessionId =>
      this.captureRuntimeGlobalsOnReady(sessionId),
    trackNeedsAnswerFromSnapshot: (sessionId, snapshot) =>
      this.trackNeedsAnswerFromSnapshot(sessionId, snapshot),
    refreshSessionStatus: sessionId => {
      this.feed.emitStatus(sessionId)
      currentRenderCachePolicy()?.noteBusyChanged()
    },
    interceptHeadlessEmit: (sessionId, message) =>
      this.routines.interceptEmit(sessionId, message),
    interceptSubAgentEmit: (sessionId, message) =>
      this.subAgents.interceptEmit(sessionId, message),
    routeBridgeRequest: (sessionId, payload) =>
      this.routeBridgeRequest(sessionId, payload),
    recordPersistedToolDetail: (toolCallId, detail) => {
      this.toolDetails.set(toolCallId, detail)
      this.notifyToolDetailReady(toolCallId, detail)
    },
    broadcastToSessionPorts: (sessionId, message) => {
      const session = this.sessions.get(sessionId)
      if (!session) return
      const tagged = { ...message, sessionId }
      for (const port of session.ports) {
        port.postMessage(tagged)
      }
    },
  })
  // ---- Inbound port-message dispatch ---------------
  // The router owns WHICH branch runs per inbound message type (and the
  // trivial reply envelopes); the Manager implements the branch bodies
  // that need its state as the named host methods below.
  private readonly portRouter = new PortMessageRouter({
    handleSessionMessage: (port, message) =>
      this.handleSessionMessage(port, message),
    setHostBridgePort: port => this.bridgeRouter.setHostPort(port),
    handlePortDisconnect: port => this.handlePortDisconnect(port),
    attachRuntimePort: (port, homeDir, panelId) =>
      this.runtimeHub.attachPort(port, homeDir, panelId),
    buildSessionInfoList: () => this.buildSessionInfoList(),
    detachSessionPort: (sessionId, port) =>
      this.detachSessionPort(sessionId, port),
    deleteSession: (port, sessionId, requestId) =>
      void this.handleSessionDelete(port, sessionId, requestId),
    retitleSession: (port, sessionId, title, requestId) =>
      void this.handleSessionRename(port, sessionId, title, requestId),
    pinSession: (port, sessionId, pinned, requestId) =>
      void this.handleSessionPin(port, sessionId, pinned, requestId),
    forkSession: (
      port,
      fromSessionId,
      cutUuid,
      requestId,
      moveCutMessageToDraft,
      title,
      replacesSource,
    ) =>
      void this.handleSessionFork(
        port,
        fromSessionId,
        cutUuid,
        requestId,
        moveCutMessageToDraft,
        title,
        replacesSource,
      ),
    handleTaskStop: (port, message) => this.handleTaskStop(port, message),
    handleTaskResume: (port, message) => this.handleTaskResume(port, message),
    handleTaskTranscript: (port, message) =>
      this.handleTaskTranscript(port, message),
    handleSessionTranscript: (port, message) =>
      this.handleSessionTranscript(port, message),
    handleRecoverBackground: message =>
      void this.handleRecoverBackground(message.sessionId),
    handleSubscribe: (port, all, sessionIds) =>
      this.handleSubscribe(port, all, sessionIds),
    handleUnsubscribe: (port, all, sessionIds) =>
      this.handleUnsubscribe(port, all, sessionIds),
    handleToolDetailSubscribe: (port, toolCallIds, sessionIdHint) =>
      this.handleToolDetailSubscribe(port, toolCallIds, sessionIdHint),
    handleToolDetailUnsubscribe: (port, toolCallIds) =>
      this.handleToolDetailUnsubscribe(port, toolCallIds),
    handleTraceFlush: (port, requestId) =>
      this.handleTraceFlush(port, requestId),
    handleTraceSubscribe: (port, traceId) =>
      this.handleTraceSubscribe(port, traceId),
    handleTraceUnsubscribe: port => this.handleTraceUnsubscribe(port),
  })

  // ---------- Routines subsystem (cron / scheduled / remote-triggered) ----------
  //
  // `lastInitTemplate` snapshots the most recent UI-initiated worker.init
  // payload so headless routine runs
  // (and background sub-agents / teammates) inherit the same
  // model/cwd/agentLoopSettings the user just used. The headless run
  // lifecycle itself lives on the RoutineCoordinator below.
  private lastInitTemplate: AgentRuntimeWorkerInitPayload | null = null
  // The host half of every init payload (hostManifest, env, locale, storage
  // paths, trace gates, …), published by the desktop page
  // (`runtime.publishHostEnvironment`). `session.open` builds a session's init
  // from it, so a client that is not the desktop can open sessions too.
  private hostEnvironment: HostEnvironment | null = null
  // Teammate lifecycle (registry + mailbox + aborts + spawn/deliver/
  // shutdown/teardown + lead inbox drain) is owned by the TeamCoordinator.
  // Assigned in the constructor (it needs the worker factory).
  private readonly teams: TeamCoordinator
  // The two coalesced UI feeds — `session.currentState` (topbar pill,
  // composer gate) + `session.summary` (sidebar rows, Background Tasks
  // drawer) — live on the SessionFeedPublisher, which
  // also owns the current-session pointer. The Manager keeps the public
  // mark*/bind/setModel wrappers as the write points.
  private readonly feed: SessionFeedPublisher
  // Unified task data is owned by the TaskRegistry (PR 6A integration):
  // live tasks, finished records, and the public-taskId → native-id index
  // all live there. The Manager drives the registry from register/finalize/
  // cascade and reads back via type-narrowed accessors.
  private readonly taskRegistry = new TaskRegistry<NexusTaskState, NexusFinishedTaskRecord>()
  // Side-task lifecycle (fork + fast-call) is owned by the SideTaskCoordinator.
  private readonly sideTasks: SideTaskCoordinator
  // The headless routine-run lifecycle (registry + spawn/turn/finalize/
  // stop + emit interception, with the single terminal
  // authority) is owned by the RoutineCoordinator. Assigned in the
  // constructor (it needs the worker factory).
  private readonly routines: RoutineCoordinator
  // Background shell lifecycle is owned by the BackgroundShellCoordinator.
  private readonly shells: BackgroundShellCoordinator
  private readonly superShells: SuperShellTaskCoordinator
  // Sub-agent waiter management + queries are owned by the SubAgentCoordinator.
  private readonly subAgents: SubAgentCoordinator
  // Task delivery now owned by TaskDeliveryQueue. Flushed (injected as
  // one re-activation turn) when the parent is idle and not suppressed.
  private readonly taskDelivery = new TaskDeliveryQueue<NexusTaskDeliveryResult>({
    turnSink: {
      enqueueDeliveryTurn: (spawnerSessionId, prompt) => {
        // Report the outcome explicitly. A missing
        // entry in the SharedWorker means the session was DELETED (page
        // reload/detach never removes entries), so the queue drops the
        // batch instead of parking it forever.
        const session = this.sessions.get(spawnerSessionId)
        if (!session) return 'parent_gone' as const
        session.worker.enqueueSubmit(
          {
            type: 'worker.submitMessage',
            sessionId: spawnerSessionId,
            payload: { prompt },
          } as SessionWorkerInboundMessage,
          SUBMIT_PRIORITY.delivery,
        )
        return 'accepted' as const
      },
    },
    stateReader: {
      isBusy: (sessionId) => {
        const session = this.sessions.get(sessionId)
        return session ? session.worker.isBusy() : false
      },
      needsAnswer: (sessionId) => {
        const session = this.sessions.get(sessionId)
        if (!session) return false
        return snapshotNeedsAnswer(session.worker.getSnapshot())
      },
    },
    formatBatch: (results) => formatTaskNotifications(results),
    taskIdOf: (result) => result.taskId,
  })

  /**
   * Deliver a cron fire into an EXISTING session as a hidden, low-priority meta turn
   * (`delivery.mode === 'session'`). A missing entry → `session_gone`; `needsAnswer` defers; `isBusy`
   * is not checked (the queue delays). `routineFireId` arms the recursion guard.
   */
  deliverRoutineToSession(
    ...params: Parameters<DeliverRoutineToSession>
  ): ReturnType<DeliverRoutineToSession> {
    const { sessionId, routine } = params[0]
    const session = this.sessions.get(sessionId)
    if (!session) return 'session_gone'
    if (snapshotNeedsAnswer(session.worker.getSnapshot())) return 'busy_ask'
    // A session the user just halted (Stop → `TaskDeliveryQueue.isSuppressed`,
    // lifted by the next genuine submit) must not be revived by a routine
    // fire — the rule sub-agent results and team mail already follow
    // (`TeamCoordinator.leadCanTakeTurnNow`). Reported as `busy_ask`: the
    // verdict type has no "suppressed" arm, and the scheduler treats both as
    // "not now, keep the routine".
    if (this.taskDelivery.isSuppressed(sessionId)) return 'busy_ask'
    session.worker.enqueueSubmit(
      {
        type: 'worker.submitMessage',
        sessionId,
        payload: {
          prompt: routine.prompt,
          isMeta: true,
          routineFireId: routine.id,
        },
      } as SessionWorkerInboundMessage,
      SUBMIT_PRIORITY.delivery,
    )
    return 'accepted'
  }

  /**
   * Read-only readiness probe for a session-delivery target, consulted by
   * the scheduler before it consumes a routine's slot.
   *
   * `isBusy` IS checked here (unlike in `deliverRoutineToSession`, where a
   * busy session is a harmless race): skipping the tick is what keeps fires
   * from accumulating behind a long turn. See `SessionDeliveryRunner`.
   */
  canDeliverRoutineToSession(
    sessionId: string,
  ): 'ready' | 'session_gone' | 'busy' {
    const session = this.sessions.get(sessionId)
    if (!session) return 'session_gone'
    if (session.worker.isBusy()) return 'busy'
    if (snapshotNeedsAnswer(session.worker.getSnapshot())) return 'busy'
    // Mirrors `deliverRoutineToSession`: a Stop-suppressed session is not
    // free for a fire either.
    if (this.taskDelivery.isSuppressed(sessionId)) return 'busy'
    return 'ready'
  }

  /** Test/internal accessor for the delivery queue's pending map. */
  get pendingTaskResults(): Map<string, NexusTaskDeliveryResult[]> {
    return this.taskDelivery.getPendingMap()
  }
  // Per-sub-agent abort controllers are owned by the SubAgentCoordinator
  // alongside the spawn/finalize/stop lifecycle.
  // Pending `TaskOutput(block:true)` waiters, keyed by sub-agent sessionId.
  // Each resolver is called with the terminal snapshot when the run finalizes
  // (Background shells + their finished records now live in the unified `tasks` /
  // `finishedTasks` maps above, keyed by shell_id, discriminated `type:'local_bash'`.)
  // (Sub-agent TaskOutput waiters are owned by the SubAgentCoordinator.)

  // ---------- Unified topbar / session-list state ----------
  // The current-session pointer, the prev-snapshot/prev-summary delta
  // caches, and the emit/coalesce logic live on the SessionFeedPublisher
  // (`this.feed`). The public mark*/bind/setModel
  // methods below stay here as the write points; they delegate the
  // fan-out to the feed.

  private registerSessionEntry(
    sessionId: string,
    options: {
      worker: AgentRuntimeWorkerHandle
      instanceId: string
      ports?: Set<MessagePort>
      /** Sub-agent / teammate / routine sessions — see `SessionEntry.background`. */
      background?: boolean
      /** Teammate identity, carried from the spawn so the live entry can
       *  answer "is this a child, and whose" from the moment it exists —
       *  see the team `registerSessionEntry` host callback. */
      spawnerSessionId?: string
      teammateName?: string
      templateType?: string
      /** A background run's own bound folder (from its init payload), so it
       *  can answer `getParentSessionBinding` for anything IT spawns. */
      projectRoot?: string
    },
  ): SessionEntry {
    // A rename stashed on an entry that is being REPLACED (resume-while-
    // teardown, force-reinit) must ride over to the replacement, or it is
    // applied nowhere.
    const previous = this.sessions.get(sessionId)
    const entry: SessionEntry = {
      worker: options.worker,
      instanceId: options.instanceId,
      ports: options.ports ?? new Set(),
      model: null,
      counters: { ...ZERO_COUNTERS },
      needsAnswer: false,
      ...(options.background ? { background: true } : {}),
      ...(options.spawnerSessionId
        ? { spawnerSessionId: options.spawnerSessionId }
        : {}),
      ...(options.teammateName ? { teammateName: options.teammateName } : {}),
      ...(options.templateType ? { templateType: options.templateType } : {}),
      ...(options.projectRoot ? { projectRoot: options.projectRoot } : {}),
      ...(previous?.pendingRename !== undefined
        ? { pendingRename: previous.pendingRename }
        : {}),
      ...(previous?.pendingPinned !== undefined
        ? { pendingPinned: previous.pendingPinned }
        : {}),
    }
    this.sessions.set(sessionId, entry)
    return entry
  }

  /**
   * `runtime.getRestartReadiness`'s worker-memory sources. Each is read on its
   * own; one that throws (or whose coordinator is not built yet) is `null`,
   * which counts as blocking. Sub-agent and teammate sessions are live
   * `sessions` entries, so their phases are covered here too.
   */
  private restartReadinessInputs(): RestartWorkInputs {
    const read = <T>(fn: () => T): T | null => {
      try {
        return fn()
      } catch {
        return null
      }
    }
    return {
      sessions: read(() =>
        [...this.sessions].map(([sessionId, entry]) => ({
          sessionId,
          idle: read(() => entry.worker.getPhase().kind === 'idle'),
          needsAnswer: entry.needsAnswer,
        })),
      ),
      // ANY live task blocks — unlike the sidebar's hasRunningTasksFor, no
      // local_fork / local_fast carve-out: a restart kills them all.
      liveTaskCount: read(() => [...this.taskRegistry.allLive()].length),
      teammateStatuses: read(() => this.teams.teammateStatuses()),
      headlessRunCount: read(() => this.routines.size),
    }
  }

  constructor(options: SharedWorkerSessionManagerOptions) {
    this.fsxSearch = new FsxSearchService({
      spawner: () => {
        const transport = this.bridgeRouter.getDirectTransport()
        if (!transport) return null
        const manifest = this.hostEnvironment?.hostManifest ?? this.lastInitTemplate?.hostManifest ?? undefined
        const primitives = createNativePrimitives({
          transport,
          createRequestId: () => this.generateBridgeRequestId(),
          manifest,
        })
        return (spec, handlers) => primitives.shell.spawnArgvStream(spec, handlers)
      },
      publish: (id, payload, opts) => this.runtimeHub.broker.publish(id, payload, opts),
      dropTopic: id => this.runtimeHub.broker.dropTopic(id),
      connections: () => this.runtimeHub.list(),
    })
    this.runtimeHub.broker.registerProvider(this.fsxSearch.topicProvider())
    // `fsx`: client file access, resolved against the
    // session's own cwd / project root as its worker last reported them.
    registerFsxCapability(this.runtimeHub.registry, {
      sessionRoots: sessionId => {
        const entry = this.sessions.get(sessionId)
        if (!entry) return null
        const snapshot = entry.worker.getSnapshot()
        const cwd = snapshot?.cwd ?? entry.projectRoot
        if (!cwd) return null
        const projectRoot = snapshot?.projectRoot ?? entry.projectRoot
        return { cwd, ...(projectRoot ? { projectRoot } : {}) }
      },
    }, this.fsxSearch)
    this.runtimeSessionSurface = installSessionSurface(this.runtimeHub, {
      dispatch: (port, data) =>
        this.portRouter.handle(port, { data } as MessageEvent),
      attachSessionPort: (sessionId, port) => {
        const session = this.sessions.get(sessionId)
        if (!session) return false
        session.ports.add(port)
        return true
      },
      detachSessionPort: (sessionId, port) => this.detachSessionPort(sessionId, port),
      subscribeSessionList: port => this.portHub.subscribe(port, true, []),
      unsubscribeSessionList: port => this.portHub.unsubscribe(port, true, []),
      getSessionSnapshot: sessionId =>
        this.sessions.get(sessionId)?.worker.getSnapshot() ?? null,
      buildSessionInfoList: () => this.buildSessionInfoList(),
      loadToolDetail: (sessionId, toolCallId) =>
        this.loadToolDetailForRuntime(sessionId, toolCallId),
      loadPersistedTranscript: sessionId =>
        this.loadPersistedTranscript(sessionId),
      openSession: (port, open, panelId) => this.openSession(port, open, panelId),
      knownProjectRoots: sessionScope => this.runtimeHub.knownProjectRoots(sessionScope),
      publishHostEnvironment: environment => {
        this.hostEnvironment = hostEnvironmentOf(environment)
        this.bootServices.onHostManifestChanged()
        // Manifest gate: arm the runtime's remoteAccess driver only when
        // the host advertises the capability. An older binary (no
        // 'remoteAccess' in capabilities) leaves it disarmed so ZERO host
        // calls are made — the no-interface-version-bump rule.
        this.runtimeHub.setRemoteAccessSupported(
          this.hostEnvironment.hostManifest?.capabilities?.includes('remoteAccess') ?? false,
        )
        // The manifest says whether the host serves the persistent shells the
        // background-shell registry is built on.
        this.maybeAdoptPersistentShells()
      },
      getRestartReadinessInputs: () => this.restartReadinessInputs(),
      flushTrace: () => ({
        records: this.tracer.drain(),
        logEntries: this.workerLogBuffer.drain(),
      }),
    })
    this.workerFactory = new SessionWorkerFactory(options.createWorker, {
      onEmit: (sessionId, instanceId, message) =>
        this.handleWorkerEmit(sessionId, instanceId, message),
      getWorkerHost: () => this,
    })
    this.initOrchestrator = new SessionInitOrchestrator({
      getEntry: sessionId => this.sessions.get(sessionId),
      ensureStorage: storagePath =>
        this.storageCoordinator.ensureStorage(storagePath),
      reconcilePersistedSessionBinding: (sessionId, payload) =>
        this.summaryRepo.reconcilePersistedSessionBinding(sessionId, payload),
      prepareWorkerStorageTarget: (sessionId, payload) =>
        this.storageCoordinator.prepareWorkerStorageTarget(sessionId, payload),
      prepareWorkerStorage: (sessionId, payload) =>
        this.storageCoordinator.prepareWorkerStorage(sessionId, payload),
      createWorker: (sessionId, backend) =>
        this.workerFactory.create(sessionId, backend),
      registerEntry: (sessionId, worker, instanceId, ports) =>
        this.registerSessionEntry(sessionId, {
          worker,
          instanceId,
          ports,
        }),
      isSessionMarkedShutdown: sessionId =>
        this.isSessionMarkedShutdown(sessionId),
      markSessionShutdown: (sessionId, shutdownAt, opts) =>
        this.markSessionShutdown(sessionId, shutdownAt, opts),
      wasTeammateTornDown: sessionId => this.teams.wasTornDown(sessionId),
      projectRouteOf: sessionId =>
        this.groupedStorage?.projectRouteOf(sessionId),
      deleteSessionInDir: (projectDir, sessionId) =>
        this.groupedStorage?.deleteSessionInDir(projectDir, sessionId) ??
        Promise.resolve(),
      setLastInitTemplate: payload => {
        this.lastInitTemplate = payload
        this.bootServices.onHostManifestChanged()
      },
      announceSessionStatus: sessionId => this.feed.announceStatus(sessionId),
      notifySessionUpserted: sessionId => this.notifySessionUpserted(sessionId),
      trace: (event, traceId, attrs) =>
        this.tracer.event(event, { traceId, attrs }),
    })
    this.bootServices = new ManagerBootServices({
      getDirectBridgeTransport: () => this.bridgeRouter.getDirectTransport(),
      createBridgeRequestId: () => this.generateBridgeRequestId(),
      getHomeDir: () => this.homeDir,
      resolveHomeDir: () => this.storageCoordinator.resolveHomeDir(),
      getLocale: () => this.hostEnvironment?.locale ?? this.lastInitTemplate?.locale,
      reloadPluginsOnAllSessions: () => this.reloadPluginsOnAllSessions(),
      getHostEnvironment: () => this.hostEnvironment,
      getHostManifest: () =>
        this.hostEnvironment?.hostManifest ?? this.lastInitTemplate?.hostManifest ?? null,
      storageRoot: () => this.storagePath,
      spawnHeadlessSession: params =>
        this.routines.spawnHeadlessSession(params),
      deliverRoutineToSession: params => this.deliverRoutineToSession(params),
      canDeliverRoutineToSession: sessionId =>
        this.canDeliverRoutineToSession(sessionId),
      scheduleSummary: () => this.feed.scheduleSummary(),
      isAnySessionBusy: () =>
        [...this.sessions.values()].some(entry => entry.worker.isBusy()),
      getSessionCwd: sessionId => this.sessionTerminalCwd(sessionId),
      trace: (event, data) =>
        this.tracer.event(event, { attrs: data ?? {} }),
    })
    this.closeTerminalsForSession =
      options.closeTerminalsForSession ??
      (sessionId => this.bootServices.terminals.closeForSession(sessionId))
    // The `terminal` capability and its two topics (F-31), over the runtime's
    // own terminal service — all `full`.
    registerTerminalCapability(this.runtimeHub.registry, this.runtimeHub.broker, {
      service: this.bootServices.terminals,
    })
    setActiveSessionManager(this)
    // The hub owns the source-subscription lifecycle; the
    // Manager only supplies the ring buffers.
    this.diagnostics.attachSources({
      subscribeTrace: handler => this.tracer.subscribe(handler),
      subscribeWorkerLog: handler => this.workerLogBuffer.subscribe(handler),
    })
    this.feed = new SessionFeedPublisher(this.taskRegistry, {
      getSessionEntry: sessionId => this.sessions.get(sessionId),
      sessionEntries: () => this.sessions.entries(),
      getSubscribersFor: sessionId => this.getSubscribersFor(sessionId),
      getListSubscribers: () => this.getListSubscribers(),
      isViewed: sessionId => this.runtimeHub.presence.isViewed(sessionId),
      notifyTurnEnd: (sessionId, prevPhase, nextPhase) =>
        this.maybeNotifyTurnEnd(sessionId, prevPhase, nextPhase),
      getFsSummaries: () => this.fsSummaries,
      routineTasks: () => this.routines.all(),
      recoveredRunJsRows: () => this.recoveredRunJs.entries(),
      recoveredBashRows: () => this.recoveredBash.entries(),
      recoveredSuperShellRows: () => this.recoveredSuperShell.entries(),
      recoveredTitleRows: () => this.recoveredTitles.entries(),
    })
    // Write-through persistence for the Skills-tab invocation event log: the log
    // lives realm-global (its producers run in the runtime), but only the
    // Manager owns storage — so it drives the sidecar write from here. Coalesced
    // per session; the flush recovers the pre-restart log first so it can never
    // clobber the on-disk history with just this lifetime's newer events.
    setSkillEventLogPersister(sessionId =>
      this.scheduleSkillEventsPersist(sessionId),
    )
    this.sideTasks = new SideTaskCoordinator(this.taskRegistry, {
      scheduleSummary: () => this.feed.scheduleSummary(),
      mintTaskHandle: (prefix) => mintTaskHandle(prefix as NexusTaskKind),
      forkDisplayLabel: (start) => forkDisplayLabel(start as ForkTaskStart),
      fastCallDisplayLabel: (qs) => fastCallDisplayLabel(qs),
      runJsDisplayLabel: () => runJsDisplayLabel(),
      extractFinalAssistantText: (msgs) => extractFinalAssistantText(msgs),
      projectSubAgentTranscript: (msgs) => projectSubAgentTranscript(msgs),
      evictFinishedOverCap: (kind, cap, onEvict) =>
        this.evictFinishedOverCap(
          kind as NexusTaskKind,
          cap,
          onEvict,
        ),
    })
    // Transport-facing shell plumbing (the persistent-shell + fs primitives,
    // output-file path resolution) lives in the host bridge;
    // the coordinator — the worker's background-shell registry
    // — owns the start/poll/exit/stop lifecycle on top of it.
    const shellBridge = new BackgroundShellHostBridge({
      getTransport: () => this.bridgeRouter.getDirectTransport(),
      getManifest: () =>
        this.hostEnvironment?.hostManifest ??
        this.lastInitTemplate?.hostManifest ??
        null,
      createRequestId: () => this.generateBridgeRequestId(),
      getHomeDir: () => this.homeDir,
      storageRoot: () => this.storagePath,
      getSessionProjectRoot: spawnerSessionId =>
        this.sessions.get(spawnerSessionId)?.projectRoot,
      // The committed storage routing is authoritative for
      // where the parent's files live; the entry's templateType feeds the
      // unrouted fallback so a non-default-type unbound session's shell
      // output never lands in the DEFAULT type's workspace.
      projectRouteOf: spawnerSessionId =>
        this.groupedStorage?.projectRouteOf(spawnerSessionId),
      getSessionTemplateType: spawnerSessionId =>
        this.sessions.get(spawnerSessionId)?.templateType,
    })
    this.shells = new BackgroundShellCoordinator(
      this.taskRegistry,
      shellBridge,
      {
        scheduleSummary: () => this.feed.scheduleSummary(),
        deliverResult: (spawnerSessionId, result) =>
          this.deliverTaskResult(spawnerSessionId, result),
        dropPendingResult: (pred) => this.dropPendingTaskResult(pred),
        getOutputPath: (spawnerSessionId, taskId, providedPath) =>
          shellBridge.getOutputPath(spawnerSessionId, taskId, providedPath ?? undefined),
        evictFinishedOverCap: (kind, cap, onEvict, filter) =>
          this.evictFinishedOverCap(kind as NexusTaskKind, cap, onEvict, filter),
      },
    )
    this.superShells = new SuperShellTaskCoordinator(this.taskRegistry, {
      scheduleSummary: () => this.feed.scheduleSummary(),
      mintTaskHandle: () => mintTaskHandle('local_supershell'),
      deliverResult: (spawnerSessionId, result) =>
        this.deliverTaskResult(spawnerSessionId, result),
      dropPendingResult: (pred) => this.dropPendingTaskResult(pred),
      evictFinishedOverCap: (kind, cap) => this.evictFinishedOverCap(kind, cap),
    })
    this.routines = new RoutineCoordinator(this.taskRegistry, {
      getInitTemplate: () => this.lastInitTemplate,
      prepareWorkerStorage: (sessionId, payload) =>
        this.storageCoordinator.prepareWorkerStorage(sessionId, payload),
      createWorker: (sessionId, backend) =>
        this.workerFactory.create(sessionId, backend),
      registerSessionEntry: (sessionId, worker, instanceId, binding) => {
        this.registerSessionEntry(sessionId, {
          worker,
          instanceId,
          background: true,
          ...(binding?.projectRoot ? { projectRoot: binding.projectRoot } : {}),
          ...(binding?.templateType
            ? { templateType: binding.templateType }
            : {}),
        })
      },
      getSessionWorker: sessionId => this.sessions.get(sessionId)?.worker,
      reapSessionEntry: sessionId => this.reapSessionEntrySync(sessionId),
      routeBridgeRequest: (sessionId, payload) =>
        this.routeBridgeRequest(sessionId, payload),
      scheduleSummary: () => this.feed.scheduleSummary(),
    })
    this.subAgents = new SubAgentCoordinator(this.taskRegistry, {
      getSnapshot: (id) => this.getSubAgentSnapshot(id),
      stop: (id) => { void this.stopSubAgent(id) },
      // --- Lifecycle capabilities ---
      getInitTemplate: () => this.lastInitTemplate,
      getParentModelSelection: spawnerSessionId =>
        this.sessions.get(spawnerSessionId)?.model ?? null,
      getParentSessionBinding: spawnerSessionId =>
        this.getSessionBinding(spawnerSessionId),
      // The parent's captured per-runtime snapshot, falling back to the
      // parent worker's live report (a spawn racing the parent's
      // `worker.ready`) — never the shared process slot.
      getOwnerGlobals: spawnerSessionId => {
        const ownerSession = this.sessions.get(spawnerSessionId)
        return (
          ownerSession?.runtimeGlobals ??
          ownerSession?.worker.getRuntimeGlobals?.()
        )
      },
      prepareWorkerStorage: (sessionId, payload, spawnerSessionId) =>
        this.storageCoordinator.prepareWorkerStorage(
          sessionId,
          payload,
          spawnerSessionId,
        ),
      createWorker: (sessionId, backend) =>
        this.workerFactory.create(sessionId, backend),
      registerSessionEntry: (sessionId, worker, instanceId, binding) => {
        this.registerSessionEntry(sessionId, {
          worker,
          instanceId,
          background: true,
          ...(binding?.projectRoot ? { projectRoot: binding.projectRoot } : {}),
          ...(binding?.templateType
            ? { templateType: binding.templateType }
            : {}),
        })
      },
      getSessionWorker: sessionId => this.sessions.get(sessionId)?.worker,
      reapSessionEntry: sessionId => this.reapSessionEntrySync(sessionId),
      disposeManagedSession: (sessionId, opts) =>
        this.disposeManagedSession(sessionId, opts),
      deliverTaskResult: (spawnerSessionId, result) =>
        this.deliverTaskResult(spawnerSessionId, result),
      routeBridgeRequest: (sessionId, payload) =>
        this.routeBridgeRequest(sessionId, payload),
      scheduleSummary: () => this.feed.scheduleSummary(),
      persistSubAgentTaskFile: (spawnerSessionId, sessionId, json) => {
        void this.storageCoordinator.writeSubAgentTaskFile(
          spawnerSessionId,
          sessionId,
          SUBAGENT_TASK_FILE_NAME,
          json,
        )
      },
    })
    this.taskControl = new TaskControlSurface(
      this.taskRegistry,
      this.subAgents,
      this.shells,
      this.sideTasks,
      this.routines,
      this.taskDelivery,
      {
        getFs: () => this.bootServices.getManagerFs(),
        getStorage: () => this.storage,
        dropSessionRouting: sessionId =>
          this.groupedStorage?.dropSessionRouting(sessionId),
        scheduleSummary: () => this.feed.scheduleSummary(),
        loadRunJsSidecar: toolCallId => this.loadRunJsSidecar(toolCallId),
        loadSuperShellSidecar: toolCallId =>
          this.loadSuperShellSidecar(toolCallId),
        loadRecoveredShell: taskId => this.loadRecoveredShell(taskId),
        loadRecoveredShellDetail: toolCallId =>
          this.loadRecoveredShellDetail(toolCallId),
        loadRecoveredTitle: taskId => this.loadRecoveredTitle(taskId),
      },
      this.superShells,
    )
    this.teams = new TeamCoordinator({
      getInitTemplate: () => this.lastInitTemplate,
      prepareWorkerStorage: (sessionId, payload, spawnerSessionId) =>
        this.storageCoordinator.prepareWorkerStorage(
          sessionId,
          payload,
          spawnerSessionId,
        ),
      createWorker: (sessionId, backend) =>
        this.workerFactory.create(sessionId, backend),
      registerSessionEntry: (sessionId, worker, instanceId, identity) => {
        this.registerSessionEntry(sessionId, {
          worker,
          instanceId,
          background: true,
          // Carried from the spawn, not left to the persisted summary:
          // the sidebar filter and the tab strip both key on
          // `spawnerSessionId` and read the LIVE entry first, so without
          // this the child shows up as an ordinary top-level thread with
          // no tab until (or unless) an fs-summary refresh lands.
          ...(identity.spawnerSessionId
            ? { spawnerSessionId: identity.spawnerSessionId }
            : {}),
          teammateName: identity.teammateName,
          ...(identity.templateType
            ? { templateType: identity.templateType }
            : {}),
          ...(identity.projectRoot
            ? { projectRoot: identity.projectRoot }
            : {}),
        })
      },
      getSessionWorker: sessionId => this.sessions.get(sessionId)?.worker,
      disposeManagedSession: (sessionId, opts) =>
        this.disposeManagedSession(sessionId, opts),
      notifySessionUpserted: sessionId => this.notifySessionUpserted(sessionId),
      markSessionShutdown: (sessionId, shutdownAt, opts) =>
        this.markSessionShutdown(sessionId, shutdownAt, opts),
      broadcastSessionRemoved: sessionId => {
        const removedMessage = {
          type: 'session.removed' as const,
          payload: { sessionId },
        }
        for (const p of this.getSubscribersFor(sessionId)) {
          p.postMessage(removedMessage)
        }
      },
      enqueueMailboxTurn: (sessionId, prompt) => {
        const session = this.sessions.get(sessionId)
        // No live entry, nothing took it: the coordinator keeps the frame
        // unread rather than acking a delivery that did not happen.
        if (!session) return false
        session.worker.enqueueSubmit(
          {
            type: 'worker.submitMessage',
            sessionId,
            payload: { prompt },
          } as SessionWorkerInboundMessage,
          SUBMIT_PRIORITY.mailbox,
        )
        return true
      },
      getDirectBridgeTransport: () => this.bridgeRouter.getDirectTransport(),
      getSessionDirectory: sessionId => {
        const dir = this.groupedStorage?.projectRouteOf(sessionId)
        return dir ? joinRuntimePath(dir, sessionId) : null
      },
      isSessionBusy: sessionId =>
        this.sessions.get(sessionId)?.worker.isBusy() ?? false,
      sessionNeedsAnswer: sessionId => {
        const session = this.sessions.get(sessionId)
        return session
          ? snapshotNeedsAnswer(session.worker.getSnapshot())
          : false
      },
      isDeliverySuppressed: sessionId => this.taskDelivery.isSuppressed(sessionId),
      // Same source as the sub-agent host's: the LEAD's own per-runtime
      // snapshot, falling back to its worker's live report when a spawn
      // races its `worker.ready`.
      getOwnerGlobals: spawnerSessionId => {
        const leadSession = this.sessions.get(spawnerSessionId)
        return (
          leadSession?.runtimeGlobals ??
          leadSession?.worker.getRuntimeGlobals?.()
        )
      },
      getSessionTrust: sessionId => this.getSessionTrust(sessionId),
      // The lead's trust is read live at delivery; "live" means this read,
      // not the one made at boot.
      refreshSessionTrust: () => this.refreshProviderTrust(),
      getFinalAssistantText: sessionId =>
        this.sessions.get(sessionId)?.worker.getFinalAssistantText?.() ?? '',
      getFinalAssistantMessageUuid: sessionId =>
        this.sessions.get(sessionId)?.worker.getFinalAssistantMessageUuid?.(),
      // The lead's own binding seeds the child's project / template — the
      // same source the sub-agent host hands `SubAgentCoordinator`.
      getParentSessionBinding: spawnerSessionId =>
        this.getSessionBinding(spawnerSessionId),
      tracer: this.tracer,
    })
    // Register the teammate spawner so the Agent
    // tool can spawn teammates without importing this manager (cycle
    // avoidance — see team/teammateSpawner.ts).
    setTeammateSpawner((params: SpawnTeammateParams) =>
      this.spawnTeammateSession(params),
    )
    // Register the background sub-agent spawner (worker-hosted Agent tool) on
    // the same leaf pattern — the Agent tool reaches it via getSubAgentSpawner()
    // without importing this manager. See team/subAgentSpawner.ts.
    setSubAgentSpawner((params: SubAgentSpawnParams) =>
      this.spawnSubAgentSession(params),
    )
    // Register the background sub-agent CONTROL surface (G1/G3/G4) on the same
    // leaf pattern — the TaskStop / TaskOutput / AgentResume tools reach it via
    // getSubAgentController(). See team/subAgentController.ts.
    setSubAgentController({
      getSnapshot: (id) => this.getSubAgentSnapshot(id),
      waitForCompletion: (id, timeoutMs, signal) =>
        this.waitForSubAgentCompletion(id, timeoutMs, signal),
      stop: (id) => this.stopSubAgent(id),
      resume: (id, prompt) => this.resumeSubAgent(id, prompt),
      list: (spawnerSessionId) => this.listSubAgents(spawnerSessionId),
      acknowledgeResult: (id) => this.acknowledgeSubAgentResult(id),
    })
    // Register the team messenger (Phases D/E) — SendMessage / Shutdown
    // tools reach the mailbox + teammate lifecycle through this leaf.
    setTeamMessenger({
      deliver: (args) => this.teams.deliver(args),
      shutdownMember: (args) => this.teams.shutdownMember(args),
      listMembers: (headSessionId) => this.teams.listTeammatesOf(headSessionId),
    })
    // Register the background-shell sink — the Bash tool (in-process, no manager
    // handle) notifies this leaf when a `run_in_background` launch returns a
    // shell_id, so the manager can mirror it as a `local_bash` task in the
    // Background Tasks drawer. See toolkit/run/backgroundShellSink.ts.
    setBackgroundShellSink((launch) => this.registerBackgroundShell(launch))
    // …and starts it: the Bash / PowerShell tool hands every background
    // command to the worker's registry, which spawns it as a persistent host
    // child.
    setBackgroundShellSpawner({
      canSpawn: () => this.shells.canSpawn(),
      isKnown: () => this.shells.isSpawnKnown(),
      spawn: request => this.shells.spawn(request),
    })
    // SuperShell invocations mirror as `local_supershell` tasks (drawer row,
    // TaskOutput/TaskStop, delivery once they finish in the background). See
    // backgroundTasks/superShellTaskSink.ts.
    setSuperShellTaskSink({
      started: (start) => this.superShells.register(start),
      finished: (finish) => this.superShells.finish(finish),
    })
    setBackgroundShellResultAcknowledger((shellId) =>
      this.acknowledgeBackgroundShellResult(shellId),
    )
    // Register the side-task sink — in-process forks (`launchFork`) and
    // fast-model one-shots (`queryFastModel`) notify this leaf so the manager
    // mirrors them as `local_fork` / `local_fast` tasks in the Background
    // Tasks drawer. See backgroundTasks/sideTaskSink.ts.
    setSideTaskSink({
      forkStarted: (start) => this.registerForkTask(start),
      forkProgress: (agentId, message) =>
        this.progressForkTask(agentId, message),
      forkFinished: (finish) => this.finishForkTask(finish),
      fastCallStarted: (start) => this.registerFastCall(start),
      fastCallFinished: (finish) => this.finishFastCall(finish),
      runJsStarted: (start) => this.registerRunJsTask(start),
      runJsFinished: (finish) => this.finishRunJsTask(finish),
    })
  }

  // ---------- Public registry-style API ----------
  // Called by `BrowserRuntimeWorker` and `toolkit/run/toolCallTelemetry.ts`
  // through `getActiveSessionManager()`. All cross-session bookkeeping
  // and emission lives here; workers no longer subscribe themselves.

  /**
   * The runtime's host port and the host's manifest, for the worker MCP client. Null until the host
   * attaches a port.
   */
  mcpHostAccess(): McpHostAccess | null {
    const transport = this.bridgeRouter.getDirectTransport()
    if (!transport) return null
    return {
      transport,
      manifest:
        this.hostEnvironment?.hostManifest ?? this.lastInitTemplate?.hostManifest,
    }
  }

  getSessionProjectRoot(sessionId: string): string | undefined {
    const entry = this.sessions.get(sessionId)
    if (!entry) return undefined
    return entry.worker.getSnapshot()?.projectRoot ?? entry.projectRoot
  }

  /**
   * A live session's own project binding, the seed for what it spawns. `cwd` only when the session is
   * itself worktree-isolated (else it would flip isolation on for its child). Null when unknown.
   */
  private getSessionBinding(
    sessionId: string,
  ): { projectRoot?: string; templateType?: string; cwd?: string } | null {
    const entry = this.sessions.get(sessionId)
    if (!entry) return null
    let snapshot: AgentRuntimeWorkerSnapshot | undefined
    try {
      snapshot = entry.worker.getSnapshot()
    } catch {
      snapshot = undefined
    }
    const cwd =
      snapshot?.cwd &&
      snapshot.projectRoot &&
      snapshot.cwd !== snapshot.projectRoot
        ? snapshot.cwd
        : undefined
    return {
      ...(entry.projectRoot ? { projectRoot: entry.projectRoot } : {}),
      ...(entry.templateType ? { templateType: entry.templateType } : {}),
      ...(cwd ? { cwd } : {}),
    }
  }

  /**
   * Every session's bound folder this runtime holds — each live session's
   * current one, then each persisted summary's — for the known-project rule
   * (`runtimeHub/knownProjects.ts`). Background sub-agents are left out, as
   * they are from the session list: a scoped client never saw them.
   */
  private sessionProjectRoots(): SessionProjectRoot[] {
    const out: SessionProjectRoot[] = []
    for (const sessionId of this.sessions.keys()) {
      const projectRoot = this.getSessionProjectRoot(sessionId)
      if (projectRoot && !isSubAgentSessionId(sessionId)) out.push({ sessionId, projectRoot })
    }
    for (const sessionId of this.fsSummaries.keys()) {
      const projectRoot = this.fsSummaries.peek(sessionId)?.projectRoot
      if (projectRoot && !isSubAgentSessionId(sessionId)) out.push({ sessionId, projectRoot })
    }
    return out
  }

  /**
   * Hydrate the runtime overlay from the conversation store's current
   * metadata (model + counters) and emit the first snapshot. Called by
   * the worker right after `applyImmediateModelSelection` so
   * `currentMetadata` is populated.
   */
  async bindSessionRuntime(
    sessionId: string,
    store: BrowserConversationStore,
    initMeta?: {
      templateType?: string
      projectRoot?: string
      spawnerSessionId?: string
      teammateName?: string
    },
  ): Promise<boolean> {
    const entry = this.sessions.get(sessionId)
    if (!entry) return false
    entry.conversationStore = store
    // Invariant: with initMeta present, its values are the BUILD's truth —
    // projectRoot including `undefined` (an unbound build); templateType has
    // no unbind concept so it keeps the `??` fallback. Entry values only
    // back-fill meta-less callers. Full rationale: P-1
    // Rules.
    const templateType = initMeta?.templateType ?? entry.templateType
    const projectRoot = initMeta ? initMeta.projectRoot : entry.projectRoot
    // Staleness fence: `entry.conversationStore` is reassigned synchronously
    // at the start of every bind, so "still our store" must be re-checked
    // after EVERY await (P-1).
    const isCurrentBind = (): boolean =>
      this.sessions.get(sessionId)?.conversationStore === store
    // A rename stashed during the pre-bind window goes through the store
    // FIRST (see `SessionEntry.pendingRename`), so the identity write below
    // and every later persist carry it.
    const pendingRename = entry.pendingRename
    if (pendingRename !== undefined) {
      try {
        await store.storeUserTitle(pendingRename, 'user')
        // Cleared only once the store has it — a failed save leaves it on
        // the entry for the next bind, or for the dispose-time flush.
        if (entry.pendingRename === pendingRename) {
          entry.pendingRename = undefined
        }
      } catch {
        // best-effort; the live overlay already reflects it, and the stash
        // stays armed
      }
      if (!isCurrentBind()) return false
    }
    let metadata: BrowserSessionMetadata | undefined
    try {
      metadata = await store.getSessionMetadata()
    } catch {
      metadata = undefined
    }
    if (!isCurrentBind()) return false
    const pendingPinned = entry.pendingPinned
    // CRITICAL merged identity write FIRST — the worker awaits this bind
    // before worker.ready and the force-reinit stub deletion rides the
    // returned persist outcome (P-1). projectRoot writes
    // whenever the store disagrees but never clears on an unbound build;
    // templateType corrects a stale stored value only when initMeta carries
    // one.
    const patch: Partial<BrowserSessionMetadata> = {
      ...(templateType &&
      (initMeta?.templateType !== undefined
        ? metadata?.templateType !== templateType
        : !metadata?.templateType)
        ? { templateType }
        : {}),
      ...(initMeta
        ? projectRoot && metadata?.projectRoot !== projectRoot
          ? { projectRoot }
          : {}
        : projectRoot && !metadata?.projectRoot
          ? { projectRoot }
          : {}),
      // Teammate identity: written on the first bind that carries it and
      // never cleared or corrected afterwards — a child cannot change lead.
      ...(initMeta?.spawnerSessionId && !metadata?.spawnerSessionId
        ? { spawnerSessionId: initMeta.spawnerSessionId }
        : {}),
      ...(initMeta?.teammateName && !metadata?.teammateName
        ? { teammateName: initMeta.teammateName }
        : {}),
      ...(pendingPinned !== undefined ? { pinned: pendingPinned } : {}),
    }
    let persisted = true
    if (!metadata || Object.keys(patch).length > 0) {
      try {
        await store.updateSessionMetadata(patch)
        if (entry.pendingPinned === pendingPinned) {
          entry.pendingPinned = undefined
        }
      } catch {
        // The in-memory entry still drives the UI, but the caller must
        // know the durable record is incomplete.
        persisted = false
      }
    }
    if (!isCurrentBind()) return persisted
    // Best-effort hydration AFTER the critical write — the status feed is
    // display state, not part of the barrier.
    this.feed.refreshSessionFromMetadata(entry, metadata)
    // A UI session that just bound publishes a fresh status baseline for
    // whoever shows it. Every worker kind binds through here — sub-agents,
    // teammates and routine runs included; they publish their own status on
    // ordinary emits and never needed the baseline (when the feed still had ONE
    // current session, a sub-agent bind stole it and silenced the foreground
    // session's turn-end idle — each session has its own stream now).
    if (!entry.background) {
      this.feed.announceStatus(sessionId)
      // Restart survival for the Skills tab: reseed this session's persisted
      // invocation event log so its loaded/failed rows reappear in
      // the summary feed. Best-effort + once per lifetime; sub-agents/routines
      // (background) have no Skills tab, so they never pay the sidecar read.
      void this.ensureSkillEventsRecovered(sessionId)
      // A team lead coming back: any teammate it has on record but no
      // runtime for was lost to a browser restart. Settle them now, not when
      // someone happens to open their tab.
      if (!isTeammateSessionId(sessionId)) {
        void this.reconcileLostTeammates(sessionId)
      }
    }
    this.feed.scheduleSummary()
    return persisted
  }

  /** See `TeamCoordinator.reconcileLost`. Best-effort: a failed read leaves
   *  the lazy per-tab gate (SessionInitOrchestrator) as the fallback. */
  private async reconcileLostTeammates(headSessionId: string): Promise<void> {
    const grouped = this.groupedStorage
    if (!grouped) return
    try {
      const children = await grouped.listTeammateChildren(headSessionId)
      if (children.length === 0) return
      await this.teams.reconcileLost(headSessionId, children)
    } catch {
      // best-effort (see above)
    }
  }

  /** Reload the cached provider-trust lookup from settings.json. */
  private async refreshProviderTrust(): Promise<void> {
    const homeDir = this.homeDir
    if (!homeDir) return
    try {
      // The manager's own fs, not the realm-global slot a session wrote last.
      this.providerTrust = await loadSessionTrustResolver(
        homeDir,
        this.bootServices.getManagerFs(),
      )
    } catch {
      // Leave the previous answer in place; a spawn does its own read.
    }
  }

  /**
   * Security: trust class of a session's provider, used to LABEL inter-agent messages (isolation is
   * decided at spawn). Fails CLOSED: unknown or unreadable → untrusted.
   */
  private getSessionTrust(sessionId: string): ProviderTrust {
    if (!this.providerTrust) return 'untrusted'
    return this.providerTrust(this.sessions.get(sessionId)?.model?.providerId)
  }

  setModel(sessionId: string, selection: BrowserLlmSelection | null): void {
    // A sub-agent worker reports its APPLIED selection through here
    // (BrowserRuntimeWorker.applyModelSelection → manager.setModel). Refresh
    // the live run's display-only `effectiveModel` so the Tasks-drawer detail
    // shows the model the worker ACTUALLY booted on — which can differ from
    // the spawn-time guess when catalog resolution fell back (e.g. a tier
    // pair disabled in the live catalog → the parent's model). The finalize
    // path copies `run.effectiveModel` onto the finished record, so the
    // corrected value survives reaping too.
    const run = this.agentTask(sessionId)
    if (run && selection) run.effectiveModel = selection.modelId
    const entry = this.sessions.get(sessionId)
    if (!entry) return
    entry.model = selection
    this.feed.emitStatus(sessionId)
  }

  markStreamStart(sessionId: string): void {
    const entry = this.sessions.get(sessionId)
    if (!entry) return
    this.legacyStreamEndedSessions.delete(sessionId)
    entry.worker.markStreamStart()
    this.feed.emitStatus(sessionId)
    this.feed.scheduleSummary()
  }

  markStreamEnd(sessionId: string): void {
    const entry = this.sessions.get(sessionId)
    if (!entry) return
    let reachedTurnBoundary: boolean
    if (entry.worker.markStreamEndWithBoundary) {
      reachedTurnBoundary = entry.worker.markStreamEndWithBoundary()
    } else {
      const phaseBefore = entry.worker.getPhase()
      entry.worker.markStreamEnd()
      const waitingForTools =
        phaseBefore.kind === 'running' &&
        phaseBefore.sub.type === 'tools'
      reachedTurnBoundary =
        phaseBefore.kind === 'running' && !waitingForTools
      if (waitingForTools) {
        this.legacyStreamEndedSessions.add(sessionId)
      }
    }
    if (reachedTurnBoundary) {
      this.legacyStreamEndedSessions.delete(sessionId)
      this.persistCountersAtTurnBoundary(sessionId, entry)
    }
    this.feed.emitStatus(sessionId)
    this.feed.scheduleSummary()
    // Cross-session: deliver deferred background-task results.
    this.maybeFlushTaskResults(sessionId)
    // …and a team lead's queued mailbox frames. Here, not only in the
    // viewed-session turn-end hook: a lead the user is not looking at still
    // reaches its boundaries, and its reports must not wait for a click.
    this.teams.maybeDrainLeadInbox(sessionId)
  }

  markToolStart(
    sessionId: string,
    name: string,
    kind: AgentToolKind,
    actionType?: string,
  ): void {
    const entry = this.sessions.get(sessionId)
    if (!entry) return
    entry.worker.markToolStart(name, kind, actionType)
    this.teams.noteToolStart(sessionId)
    this.feed.emitStatus(sessionId)
    this.feed.scheduleSummary()
  }

  /**
   * Pop one in-flight tool and increment the appropriate counter. Counter
   * persistence is best-effort and deliberately off the critical tool loop:
   * a stalled fs bridge write must not keep the session busy or block the
   * submit queue from dispatching the follow-up turn.
   */
  async markToolEnd(sessionId: string, success: boolean): Promise<void> {
    const entry = this.sessions.get(sessionId)
    if (!entry) return
    let transition
    if (entry.worker.markToolEndWithBoundary) {
      transition = entry.worker.markToolEndWithBoundary()
    } else {
      const phaseBefore = entry.worker.getPhase()
      const ended = entry.worker.markToolEnd()
      transition = {
        ended,
        reachedTurnBoundary:
          this.legacyStreamEndedSessions.has(sessionId) &&
          phaseBefore.kind === 'running' &&
          phaseBefore.sub.type === 'tools' &&
          phaseBefore.sub.tools.length <= 1,
      }
    }
    const ended = transition.ended

    if (ended) {
      const next: BrowserSessionCounters = { ...entry.counters }
      if (ended.kind === 'mcp') {
        next.mcp += 1
        if (!success) next.mcpFail += 1
      } else {
        next.tool += 1
        if (!success) next.toolFail += 1
      }
      entry.counters = next
      this.dirtySessionCounters.add(sessionId)
    }
    if (transition.reachedTurnBoundary) {
      this.legacyStreamEndedSessions.delete(sessionId)
      this.persistCountersAtTurnBoundary(sessionId, entry)
    }

    this.feed.emitStatus(sessionId)
    this.feed.scheduleSummary()
    // Cross-session: deliver deferred background-task results on idle.
    this.maybeFlushTaskResults(sessionId)
    this.teams.maybeDrainLeadInbox(sessionId)
  }

  /**
   * Coalesce per-tool counter writes into one metadata append at the turn
   * boundary. The live entry remains the immediate UI source of truth.
   */
  private persistCountersAtTurnBoundary(
    sessionId: string,
    entry: SessionEntry,
  ): void {
    if (!this.dirtySessionCounters.delete(sessionId)) {
      return
    }
    const store = entry.conversationStore
    if (!store) {
      return
    }
    const counters = { ...entry.counters }
    void store.updateSessionMetadata({ counters }).catch(() => {
      /* swallow — UI state already reflects via cache */
    })
  }

  /**
   * A sub-agent's projected transcript for the drawer's read-only view: from the live stream while
   * running, from the retained terminal record when finished, else from disk. Null when unavailable.
   */
  async loadSubAgentTranscript(
    sessionId: string,
  ): Promise<NexusTaskTranscriptEntry[] | null> {
    return this.taskControl.loadTranscript(sessionId)
  }

  /**
   * Header info for the drawer's detail view: the
   * directive (`task`), the result (`summary` — partial while running, final
   * once terminal), and the effective model. Read from the live run, else the
   * retained finished record; null for an unknown id. Kept off the per-flush
   * summary broadcast (task/result can be large) — loaded once on detail open.
   */
  loadSubAgentInfo(sessionId: string): NexusTaskInfo | null {
    return this.taskControl.loadInfo(sessionId)
  }

  /**
   * Detail-view info with the task's output file read best-effort (for `local_bash`, the fuller
   * record); falls back to the summary-only info.
   */
  async loadTaskInfoWithOutput(sessionId: string): Promise<NexusTaskInfo | null> {
    return this.taskControl.loadInfoWithOutput(sessionId)
  }

  // `forwardUiBroadcast` + `uiBroadcastDisabled` were the legacy
  // C++-pass-through path for `nexusCurrentSessionState` /
  // `nexusSessionsSummary`. Deleted: `broadcastWebUiBridgeEvent`
  // fan-out is direct (worker port → panel) and has no rejection
  // round-trip — the "disabled after first failure" flag served no
  // purpose in the new model.

  // ── Turn-end notifications ──────────────────────────────────────────────
  // Nudge the user when a turn fully completes. The
  // phase only reaches `idle` once QueryEngine clears its per-turn streaming
  // flag in the outer `finally` (tool steps keep `streaming` true), so a
  // non-idle → idle transition on the current session is a reliable
  // end-of-turn signal — no idle timer / debounce needed. The host
  // suppresses the notification while the Nexus window is focused, so it is
  // safe to fire unconditionally from here.

  /**
   * The runtime asks for attention; it does not pop a toast. The runtime used
   * to call the host's `ui.showNotification` itself, so the only person it
   * could ever reach was whoever sat at this machine. It publishes on the
   * `notifications` topic instead and each client renders it (R5: no reverse
   * call) — the desktop shell asks the host for its OS toast, which still
   * suppresses it while the window is focused.
   */
  private readonly notificationSink = (
    opts: DesktopAlert & { sessionId?: string },
  ): Promise<{ ok: true }> => {
    this.runtimeHub.notify(opts)
    return Promise.resolve({ ok: true } as const)
  }

  private maybeNotifyTurnEnd(
    sessionId: string,
    prevPhase: NexusCurrentSessionPhase | null,
    nextPhase: NexusCurrentSessionPhase,
  ): void {
    // Only on a genuine active → idle transition. `prevPhase === null` means
    // we just opened/switched to this session (no transition to report), so
    // skip — we don't notify merely for selecting an already-idle session.
    if (nextPhase !== 'idle' || prevPhase === null || prevPhase === 'idle') {
      return
    }
    // The turn may have added or removed files: file search lists its folders again.
    this.fsxSearch.invalidate()
    // Lead-side mailbox drain: if this session is a
    // team lead with a queued teammate message, deliver it as the lead's
    // next turn at this idle boundary. Teammates drain via their own idle
    // loop; only the lead needs this hook (it has no TeammateRunner).
    this.teams.maybeDrainLeadInbox(sessionId)
    // NOTE: background sub-agent result delivery is NOT hooked here —
    // maybeNotifyTurnEnd only fires for a session some client is VIEWING
    // (`SessionFeedHost.isViewed`), which would strand results for a parent
    // nobody is looking at.
    // The flush runs from markStreamEnd / markToolEnd instead (focus-independent).
    // The toast's bold line is the session title and the body is
    // "{product} is waiting for your input".
    const notification = buildTurnEndNotification(
      getProductName(),
      this.buildSessionInfo(sessionId)?.title,
    )
    // The `Notification` hooks run first (F-7);
    // they run in the session's own runtime, which has the hooks and the
    // shell. Not awaited: the outcome is informational, and the person's
    // notice does not wait on a hook command.
    void this.sessions.get(sessionId)?.worker.fireNotificationHooks?.({
      ...notification,
      notificationType: TURN_END_HOOK_NOTIFICATION_TYPE,
    }).catch(() => {})
    void raiseDesktopAlert(notification, opts => this.notificationSink({ ...opts, sessionId }))
  }

  handleConnect(port: MessagePort): void {
    this.portHub.connect(port)
    port.addEventListener('message', (event: MessageEvent) => {
      this.handlePortMessage(port, event)
    })
    port.start()
  }

  handlePortDisconnect(port: MessagePort): void {
    this.portHub.disconnect(port)
    // The hub tears its source subscriptions down with the
    // last subscriber — BOTH of them (this path used to skip the
    // worker-log unsubscribe, leaking the console-capture listener).
    this.diagnostics.removePort(port)
    for (const session of this.sessions.values()) {
      session.ports.delete(port)
    }
  }

  private handlePortMessage(port: MessagePort, event: MessageEvent): void {
    this.portRouter.handle(port, event)
  }

  private handleSessionTranscript(
    port: MessagePort,
    message: Extract<SharedWorkerInboundMessage, { type: 'session.transcript' }>,
  ): void {
    void (async () => {
      const result = await this.loadPersistedTranscript(message.sessionId)
      port.postMessage({
        type: 'session.transcript',
        payload: {
          sessionId: message.sessionId,
          requestId: message.requestId,
          messages: result.messages,
          ...(result.error !== undefined ? { error: result.error } : {}),
        },
      })
    })()
  }

  /**
   * Read a session's PERSISTED transcript without touching or creating a runtime (the read-only tab),
   * for both transports. A failed read is an `error`, never an empty transcript. Title records and
   * legacy `__session_meta` lines are dropped.
   */
  async loadPersistedTranscript(
    sessionId: string,
  ): Promise<{ messages: Message[]; error?: string }> {
    try {
      const entries = await this.readPersistedEntries(sessionId)
      return { messages: entries.filter(isMessageLike) }
    } catch (err) {
      return {
        messages: [],
        error: err instanceof Error ? err.message : String(err),
      }
    }
  }

  /**
   * Contract: a session's raw persisted entries (title records included), read
   * without creating a runtime. Brings storage up from the published host
   * environment when no `worker.init` has yet, and routes the session to its
   * project dir first. Throws when no storage backend can be reached; an
   * unwritten session reads as [].
   */
  private async readPersistedEntries(sessionId: string): Promise<unknown[]> {
    // A client that may not open sessions can be the runtime's first reader.
    if (!this.storage && this.hostEnvironment?.sessionStoragePath) {
      await this.storageCoordinator.ensureStorage(this.hostEnvironment.sessionStoragePath)
    }
    const storage = this.storage
    if (!storage) {
      throw new Error('session storage is not available')
    }
    // Grouped storage answers EMPTY from the default dir until the session is routed.
    await this.groupedStorage?.routeSessionFromMeta(sessionId)
    const payload = await storage.load(sessionId)
    if (Array.isArray(payload)) return payload
    const wrapped = (payload as { messages?: unknown } | null)?.messages
    return Array.isArray(wrapped) ? wrapped : []
  }

  /**
   * True when the session's persisted meta carries the shutdown marker. The
   * worker.init gate reads this BEFORE creating a runtime, so a stale-boot
   * (the boot-active pointer naming a torn-down teammate) can never register
   * one. Reads storage (authoritative); falls back to the fs-summary cache,
   * which may already hold it post-preload.
   */
  private async isSessionMarkedShutdown(sessionId: string): Promise<boolean> {
    const cached = this.fsSummaries.get(sessionId)
    if (cached?.shutdown === true) return true
    const storage = this.storage
    if (!storage) return false
    try {
      const meta = await storage.readSessionMeta(sessionId)
      return meta?.metadata.shutdown === true
    } catch {
      return false
    }
  }

  private async markSessionShutdown(
    sessionId: string,
    shutdownAt: number,
    opts?: { lost?: boolean },
  ): Promise<boolean> {
    const storage = this.storage
    if (!storage) return false
    const current = await storage.readSessionMeta(sessionId)
    if (!current) return false
    await storage.writeSessionMeta(sessionId, {
      ...current,
      updatedAt: Math.max(current.updatedAt, shutdownAt),
      metadata: {
        ...current.metadata,
        shutdown: true,
        shutdownAt,
        // A teammate LOST to a restart records WHY, durably. `shutdown` alone
        // is also what a lead's own `Shutdown` writes, and `reconcileLost`
        // skips a child that carries it — so without this the explanation
        // survives exactly one restart (see `BrowserSessionMetadata.lostAt`).
        ...(opts?.lost ? { lostAt: shutdownAt } : {}),
      },
    })
    // The marker is on disk: that is what `true` reports. A failed summary
    // refresh only delays the list projection, and must not make the caller
    // treat the teammate as unmarked (which removes its read-only tab).
    try {
      await this.summaryRepo.refreshFsSummary(sessionId)
    } catch {
      /* the next list scan picks the marker up */
    }
    return true
  }

  /** `session.detach`: drop one port's attachment to a session. */
  private detachSessionPort(sessionId: string, port: MessagePort): void {
    const session = this.sessions.get(sessionId)
    if (session) {
      session.ports.delete(port)
    }
  }

  /** `task.stop` (Background Tasks drawer): stop ANY kind of task by its
   *  public id and ack with the resulting status. */
  private handleTaskStop(
    port: MessagePort,
    message: Extract<SharedWorkerInboundMessage, { type: 'task.stop' }>,
  ): void {
    this.taskControl.handleDrawerStop(port, message)
  }

  /** `task.resume` (Background Tasks drawer): AgentResume by public id + ack. */
  private handleTaskResume(
    port: MessagePort,
    message: Extract<SharedWorkerInboundMessage, { type: 'task.resume' }>,
  ): void {
    this.taskControl.handleDrawerResume(port, message)
  }

  /** `task.transcript` (Background Tasks drawer detail view): header info +
   *  transcript projection ride one async reply. */
  private handleTaskTranscript(
    port: MessagePort,
    message: Extract<SharedWorkerInboundMessage, { type: 'task.transcript' }>,
  ): void {
    this.taskControl.handleDrawerTranscript(port, message)
  }

  /**
   * `task.recoverBackground`: rebuild the session's restart-recovered shell, run_js and SuperShell
   * drawer rows from its persisted transcript, at most once per session per lifetime. Best-effort.
   */
  private async handleRecoverBackground(sessionId: string): Promise<void> {
    if (this.backgroundRecovered.has(sessionId)) return
    // Claim eagerly so a rapid re-open can't run two concurrent recoveries…
    this.backgroundRecovered.add(sessionId)
    const recovery = this.recoverBackgroundRows(sessionId)
    this.backgroundRecoveries.set(sessionId, recovery)
    try {
      await recovery
    } finally {
      if (this.backgroundRecoveries.get(sessionId) === recovery) {
        this.backgroundRecoveries.delete(sessionId)
      }
    }
  }

  private async recoverBackgroundRows(sessionId: string): Promise<void> {
    let messages: unknown[] = []
    try {
      // The request can precede the first `worker.init` (a pane restored open
      // on the session the window boots into); the read brings storage up.
      messages = await this.readPersistedEntries(sessionId)
    } catch {
      // No storage backend: release the claim so the next request reads again.
      this.backgroundRecovered.delete(sessionId)
      return
    }
    if (messages.length === 0) {
      // Nothing written yet; a later request reads what the session has by then.
      this.backgroundRecovered.delete(sessionId)
      return
    }
    this.recoverRunJsRowsFromTranscript(sessionId, messages)
    this.recoverTitleRowsFromTranscript(sessionId, messages)
    // The shell rows need no sidecar: publish them now, synchronously, rather
    // than behind the SuperShell sidecar reads below (one per run, from
    // storage). Those reads name the `background: true` steps whose completion
    // notifications the shell rebuild leaves out — so the rows are rebuilt a
    // second time, minus those steps, once the reads have settled.
    this.recoverBashRowsFromTranscript(sessionId, messages)
    const superShellSteps = await this.recoverSuperShellRowsFromTranscript(
      sessionId,
      messages,
    )
    if (superShellSteps.size > 0) {
      this.recoverBashRowsFromTranscript(sessionId, messages, superShellSteps)
    }
    // The persisted transcript parts don't carry pass/fail — upgrade a
    // recovered row to 'error' from its tool-detail sidecar's isError.
    await this.markRecoveredTaskErrors(sessionId)
  }

  /** `trace.flush`: one-shot drain of the trace ring + console capture. */
  private handleTraceFlush(
    port: MessagePort,
    requestId: string | undefined,
  ): void {
    port.postMessage({
      type: 'trace.snapshot',
      ...(requestId ? { requestId } : {}),
      payload: { records: this.tracer.drain() },
    })
    // Seed the overlay's SharedWorker tab with the captured console
    // history in the same round-trip (no separate flush message).
    port.postMessage({
      type: 'worker.log.snapshot',
      payload: { entries: this.workerLogBuffer.drain() },
    })
  }

  /** `trace.subscribe`: register a live trace subscriber. The hub installs
   *  its tracer + console-capture source subscriptions with the first one
   *  (lifecycle owned by the hub, not duplicated here). */
  private handleTraceSubscribe(
    port: MessagePort,
    traceId: string | undefined,
  ): void {
    this.diagnostics.subscribeTrace(port, traceId)
  }

  /** `trace.unsubscribe`: drop a subscriber; the hub tears both source
   *  subscriptions down with the last one. */
  private handleTraceUnsubscribe(port: MessagePort): void {
    this.diagnostics.unsubscribeTrace(port)
  }

  private handleSubscribe(
    port: MessagePort,
    all: boolean,
    sessionIds: string[] | undefined,
  ): void {
    this.portHub.subscribe(port, all, sessionIds ?? [])

    // Flush the relevant current state to the subscriber so it does not
    // need a separate one-shot session.list request to prime its view.
    if (all) {
      port.postMessage({
        type: 'session.list',
        payload: { sessions: this.buildSessionInfoList() },
      })
      return
    }

    if (sessionIds) {
      for (const id of sessionIds) {
        const info = this.buildSessionInfo(id)
        if (info) {
          port.postMessage({
            type: 'session.updated',
            payload: { session: info },
          })
        }
      }
    }
  }

  private handleUnsubscribe(
    port: MessagePort,
    all: boolean,
    sessionIds: string[] | undefined,
  ): void {
    this.portHub.unsubscribe(port, all, sessionIds ?? [])
  }

  private handleToolDetailSubscribe(
    port: MessagePort,
    toolCallIds: string[],
    sessionIdHint: string | undefined,
  ): void {
    this.portHub.subscribeToolDetail(port, toolCallIds)
    for (const toolCallId of toolCallIds) {
      // Immediate flush from cache so the UI doesn't wait if the detail
      // is already known. `null` cached means "looked and nothing there"
      // — still a valid terminal answer.
      if (this.toolDetails.has(toolCallId)) {
        port.postMessage({
          type: 'toolDetail.ready',
          payload: {
            toolCallId,
            detail: this.toolDetails.get(toolCallId) ?? null,
          },
        })
        continue
      }

      // Not cached — try to pull it from disk. If the session isn't
      // known we try every known session (cheap: it's one stat per).
      void this.lookupToolDetailFromDisk(toolCallId, sessionIdHint)
    }
  }

  private handleToolDetailUnsubscribe(
    port: MessagePort,
    toolCallIds: string[],
  ): void {
    this.portHub.unsubscribeToolDetail(port, toolCallIds)
  }

  private async lookupToolDetailFromDisk(
    toolCallId: string,
    sessionIdHint: string | undefined,
  ): Promise<void> {
    const storage = this.storage
    if (!storage) return

    const candidates: string[] = []
    if (sessionIdHint) candidates.push(sessionIdHint)
    for (const sessionId of this.sessions.keys()) {
      if (sessionId !== sessionIdHint) candidates.push(sessionId)
    }
    for (const sessionId of this.fsSummaries.keys()) {
      if (!candidates.includes(sessionId)) candidates.push(sessionId)
    }

    for (const sessionId of candidates) {
      try {
        const detail = await storage.loadToolCallDetail(sessionId, toolCallId)
        if (detail) {
          this.toolDetails.set(toolCallId, detail)
          this.notifyToolDetailReady(toolCallId, detail)
          return
        }
      } catch {
        // try the next candidate
      }
    }

    // Not on disk (yet). Leave the subscription open and DO NOT push
    // `null` — a still-running tool call will produce the sidecar later
    // via `worker.toolDetailPersisted`, and we want the UI to see that
    // instead of a premature terminal-null. The UI's own timeout is the
    // only escape hatch for "this truly doesn't exist."
  }

  /**
   * Recover a SuperEdit's persisted detail for the drawer when its registry record is gone, by tool call
   * id (cache, then candidate sessions). Null when absent or not a SuperEdit call.
   */
  private async loadRunJsSidecar(
    toolCallId: string,
  ): Promise<RunJsSidecarDetail | null> {
    const storage = this.storage
    if (!storage?.loadToolCallDetail) return null

    let detail: BrowserToolCallDetailRecord | null =
      this.toolDetails.get(toolCallId) ?? null
    if (!detail) {
      const candidates: string[] = []
      const push = (sessionId: string | null | undefined): void => {
        if (sessionId && !candidates.includes(sessionId)) {
          candidates.push(sessionId)
        }
      }
      push(this.sessionOfRecoveredCall(toolCallId))
      for (const sessionId of this.sessions.keys()) push(sessionId)
      for (const sessionId of this.fsSummaries.keys()) push(sessionId)
      for (const sessionId of candidates) {
        try {
          detail = await storage.loadToolCallDetail(sessionId, toolCallId)
        } catch {
          detail = null
        }
        if (detail) break
      }
    }

    if (!detail || detail.toolName !== SUPER_EDIT_TOOL_NAME) return null
    const args =
      detail.args && typeof detail.args === 'object'
        ? (detail.args as Record<string, unknown>)
        : {}
    const path = typeof args.path === 'string' ? args.path : undefined
    const resultText =
      typeof detail.result === 'string'
        ? detail.result
        : detail.result != null
          ? JSON.stringify(detail.result)
          : undefined
    return {
      code: typeof args.code === 'string' ? args.code : '',
      description:
        typeof args.description === 'string' ? args.description : undefined,
      path,
      inputs:
        args.inputs && typeof args.inputs === 'object' && !Array.isArray(args.inputs)
          ? (args.inputs as Record<string, unknown>)
          : undefined,
      timeoutSec: typeof args.timeoutSec === 'number' ? args.timeoutSec : undefined,
      inlineCode: !path,
      resultText,
    }
  }

  /**
   * Recover a SuperShell call's persisted detail for the drawer by tool call id, preferring the run's
   * own recovered result over the hand-off. Null when absent or not a SuperShell call.
   */
  private async loadSuperShellSidecar(
    toolCallId: string,
  ): Promise<SuperShellSidecarDetail | null> {
    const detail = await this.loadToolCallDetailAcrossSessions(toolCallId)
    if (!detail || detail.toolName !== SUPER_SHELL_TOOL_NAME) return null
    const args =
      detail.args && typeof detail.args === 'object'
        ? (detail.args as Record<string, unknown>)
        : {}
    const callResult =
      typeof detail.result === 'string'
        ? detail.result
        : detail.result != null
          ? JSON.stringify(detail.result)
          : undefined
    const resultText =
      callResult !== undefined && parseSuperShellDetachedTaskId(callResult) !== null
        ? ((await this.recoveredSuperShellResult(toolCallId)) ?? callResult)
        : callResult
    return {
      code: typeof args.code === 'string' ? args.code : '',
      description:
        typeof args.description === 'string' ? args.description : undefined,
      inputs:
        args.inputs && typeof args.inputs === 'object' && !Array.isArray(args.inputs)
          ? (args.inputs as Record<string, unknown>)
          : undefined,
      resultText,
    }
  }

  /**
   * The result of a detached SuperShell run that restart recovery found — from
   * its `<task-notification>`, or from the TaskOutput call that read it — else
   * undefined. Waits for recoveries still in flight first: a card's jump asks for
   * the detail while the drawer, opening, recovers the rows, and a detail loaded
   * before that ends would show the hand-off.
   */
  private async recoveredSuperShellResult(
    toolCallId: string,
  ): Promise<string | undefined> {
    await Promise.allSettled(this.backgroundRecoveries.values())
    for (const rows of this.recoveredSuperShell.values()) {
      const row = rows.find(r => r.callId === toolCallId)
      if (!row) continue
      if (row.resultText !== undefined) return row.resultText
      if (!row.resultDetailId) return undefined
      const read = await this.loadToolCallDetailAcrossSessions(row.resultDetailId)
      return typeof read?.result === 'string'
        ? parseSuperShellTaskOutputResult(read.result)?.resultText
        : undefined
    }
    return undefined
  }

  /**
   * Rebuild `sessionId`'s recovered run_js drawer rows from a full
   * transcript emission. Registry-known ids are NOT filtered here (the map
   * is rebuilt only on full loads, but a run can start/finish after it) —
   * the publisher filters at read time, where the registry state is
   * current.
   */
  private recoverRunJsRowsFromTranscript(
    sessionId: string,
    messages: unknown[],
  ): void {
    const rows = extractRecoveredRunJsRows(messages)
    const prev = this.recoveredRunJs.get(sessionId)
    if (rows.length === 0) {
      if (!prev) return
      this.recoveredRunJs.delete(sessionId)
    } else {
      this.recoveredRunJs.set(sessionId, rows)
    }
    this.feed.scheduleSummary()
  }

  /**
   * Rebuild `sessionId`'s recovered session-title rows from the transcript's
   * stored titles — those written before this worker lifetime (see
   * `recoveredTitles`).
   */
  private recoverTitleRowsFromTranscript(
    sessionId: string,
    messages: unknown[],
  ): void {
    const rows = extractRecoveredTitleRows(
      sessionId,
      messages,
      this.lifetimeStartedAt,
    )
    if (rows.length === 0) {
      if (!this.recoveredTitles.delete(sessionId)) return
    } else {
      this.recoveredTitles.set(sessionId, rows)
    }
    this.feed.scheduleSummary()
  }

  /**
   * Rebuild `sessionId`'s recovered `local_bash` drawer rows from a full transcript; the publisher
   * filters registry-known ids at read time. `excludeTaskIds` are recovered SuperShell steps.
   */
  private recoverBashRowsFromTranscript(
    sessionId: string,
    messages: unknown[],
    excludeTaskIds: ReadonlySet<string> = new Set(),
  ): void {
    const rows = extractRecoveredBashRows(messages).filter(
      row => !excludeTaskIds.has(row.taskId),
    )
    const prev = this.recoveredBash.get(sessionId)
    if (rows.length === 0) {
      if (!prev) return
      this.recoveredBash.delete(sessionId)
    } else {
      this.recoveredBash.set(sessionId, rows)
    }
    this.feed.scheduleSummary()
  }

  /**
   * Rebuild `sessionId`'s recovered `local_supershell` drawer rows: the
   * transcript scan, completed from each call's tool-detail sidecar — whether the
   * run ended inline or continued in the background, and how a detached run
   * ended (recoverSuperShellRows.ts). Registry-known runs are filtered by the
   * publisher at read time, as for run_js. Returns the task ids of the
   * `background: true` steps the recovered runs started.
   */
  private async recoverSuperShellRowsFromTranscript(
    sessionId: string,
    messages: unknown[],
  ): Promise<ReadonlySet<string>> {
    const { rows, backgroundStepTaskIds } = await resolveRecoveredSuperShellRows(
      extractRecoveredSuperShellRows(messages),
      toolCallId => this.loadToolDetailForRuntime(sessionId, toolCallId),
    )
    const prev = this.recoveredSuperShell.get(sessionId)
    if (rows.length === 0) {
      if (!prev) return backgroundStepTaskIds
      this.recoveredSuperShell.delete(sessionId)
    } else {
      this.recoveredSuperShell.set(sessionId, rows)
    }
    this.feed.scheduleSummary()
    return backgroundStepTaskIds
  }

  /**
   * Merge `sessionId`'s `skill-events.json` sidecar into the realm-global `skillInvocationLog` once per
   * lifetime (promise-cached). Best-effort.
   */
  private ensureSkillEventsRecovered(sessionId: string): Promise<void> {
    const inflight = this.skillEventsRecovery.get(sessionId)
    if (inflight) return inflight
    const promise = (async () => {
      const storage = this.storage
      if (!storage?.loadSkillEvents) return
      try {
        const events = await storage.loadSkillEvents(sessionId)
        if (
          events &&
          events.length > 0 &&
          seedSkillInvocationEvents(sessionId, events)
        ) {
          this.feed.scheduleSummary()
        }
      } catch {
        // best-effort — a missing/torn sidecar leaves the transcript-scan
        // fallback; drop the cache entry so a later open can retry.
        this.skillEventsRecovery.delete(sessionId)
      }
    })()
    this.skillEventsRecovery.set(sessionId, promise)
    return promise
  }

  /** A DELETED session's skill event log and its recovery entry go with it.
   *  (A dispose keeps both on purpose — see `disposeManagedSession` — but a
   *  deleted id never re-opens, so without this the realm-global log and the
   *  recovery cache grew by one session for every delete in the worker's
   *  lifetime.) Runs after `disposeManagedSession`, whose flush has already
   *  taken the pending write. */
  private forgetSkillEvents(sessionId: string): void {
    const timer = this.skillEventsWriteTimers.get(sessionId)
    if (timer !== undefined) {
      clearTimeout(timer)
      this.skillEventsWriteTimers.delete(sessionId)
    }
    this.skillEventsRecovery.delete(sessionId)
    clearSkillInvocationLogForSession(sessionId)
  }

  /** Queue a coalesced write of `sessionId`'s skill event log to its sidecar.
   *  Called (via the registered persister) on every logged invocation; a burst
   *  in one turn collapses into a single write. */
  private scheduleSkillEventsPersist(sessionId: string): void {
    if (this.skillEventsWriteTimers.has(sessionId)) return
    const timer = setTimeout(() => {
      void this.flushSkillEventsPersist(sessionId)
    }, SKILL_EVENTS_WRITE_COALESCE_MS)
    this.skillEventsWriteTimers.set(sessionId, timer)
  }

  /** Write `sessionId`'s current skill event log to its sidecar now. Recovers
   *  the pre-restart log FIRST so this write can never clobber the on-disk
   *  history with only this lifetime's newer events (the first post-restart
   *  invocation would otherwise overwrite it before recovery had run). */
  private async flushSkillEventsPersist(sessionId: string): Promise<void> {
    const timer = this.skillEventsWriteTimers.get(sessionId)
    if (timer !== undefined) {
      clearTimeout(timer)
      this.skillEventsWriteTimers.delete(sessionId)
    }
    const storage = this.storage
    if (!storage?.saveSkillEvents) return
    try {
      await this.ensureSkillEventsRecovered(sessionId)
    } catch {
      // best-effort — proceed with whatever is in memory
    }
    try {
      await storage.saveSkillEvents(
        sessionId,
        getAllSkillInvocationEvents(sessionId),
      )
    } catch {
      // best-effort — a failed persist just leaves the log live-session-only
    }
  }

  /**
   * The drawer's detail fallback for a background shell whose live/finished
   * registry record is gone (session reloaded after an app restart). Looks the
   * recovered row up by public task id across every loaded session's rebuilt
   * rows and returns its command + output-file path so
   * `TaskControlSurface.loadInfoWithOutput` can read the persisted log lazily.
   */
  private loadRecoveredTitle(taskId: string): { title: string } | null {
    for (const rows of this.recoveredTitles.values()) {
      const row = rows.find(r => r.taskId === taskId)
      if (row) return { title: row.title }
    }
    return null
  }

  private loadRecoveredShell(
    taskId: string,
  ): { command?: string; outputFilePath?: string; detailId?: string } | null {
    for (const rows of this.recoveredBash.values()) {
      const row = rows.find(r => r.taskId === taskId)
      if (row) {
        return {
          command: row.command,
          outputFilePath: row.outputFilePath,
          detailId: row.detailId,
        }
      }
    }
    return null
  }

  /** The protocol's `session.getToolDetail`: the hinted session first (one
   *  stat), then the cache-first search across every candidate session. */
  private async loadToolDetailForRuntime(
    sessionId: string,
    toolCallId: string,
  ): Promise<BrowserToolCallDetailRecord | null> {
    const cached = this.toolDetails.get(toolCallId)
    if (cached) return cached
    const storage = this.storage
    if (storage?.loadToolCallDetail && sessionId) {
      try {
        const detail = await storage.loadToolCallDetail(sessionId, toolCallId)
        if (detail) return detail
      } catch {
        // fall through to the cross-session search
      }
    }
    // WITH the session as the hint: this is the loader the session's own
    // background recovery runs, and a hint-less search waits on every
    // in-flight recovery to learn the session — including the one asking,
    // which then waited on itself for good (a SuperShell sidecar the
    // session's storage did not hold).
    return this.loadToolCallDetailAcrossSessions(toolCallId, sessionId)
  }

  /**
   * The session a recovered drawer row with this tool call id (or result
   * sidecar id) was rebuilt from — the first place its sidecar can be. There is
   * no "current session" to guess with instead.
   */
  private sessionOfRecoveredCall(id: string): string | undefined {
    for (const [sessionId, rows] of this.recoveredRunJs) {
      if (rows.some(row => row.callId === id)) return sessionId
    }
    for (const [sessionId, rows] of this.recoveredSuperShell) {
      if (rows.some(row => row.callId === id || row.resultDetailId === id)) return sessionId
    }
    for (const [sessionId, rows] of this.recoveredBash) {
      if (rows.some(row => row.detailId === id)) return sessionId
    }
    return undefined
  }

  private async loadToolCallDetailAcrossSessions(
    toolCallId: string,
    sessionHint?: string,
  ): Promise<BrowserToolCallDetailRecord | null> {
    const storage = this.storage
    if (!storage?.loadToolCallDetail) return null
    const cached = this.toolDetails.get(toolCallId)
    if (cached) return cached
    const candidates: string[] = []
    const push = (sessionId: string | null | undefined): void => {
      if (sessionId && !candidates.includes(sessionId)) candidates.push(sessionId)
    }
    let hint = sessionHint ?? this.sessionOfRecoveredCall(toolCallId)
    if (hint === undefined && this.backgroundRecoveries.size > 0) {
      // A drawer jump can ask while its session's recovery is still reading the
      // transcript: the row that names the session is not there yet.
      await Promise.allSettled(this.backgroundRecoveries.values())
      hint = this.sessionOfRecoveredCall(toolCallId)
    }
    push(hint)
    for (const sessionId of this.sessions.keys()) push(sessionId)
    for (const sessionId of this.fsSummaries.keys()) push(sessionId)
    for (const sessionId of candidates) {
      try {
        const detail = await storage.loadToolCallDetail(sessionId, toolCallId)
        if (detail) return detail
      } catch {
        // try the next candidate session
      }
    }
    return null
  }

  /**
   * After a lazy recovery, upgrade a recovered row to `'error'` when its sidecar records `isError`;
   * never downgrades.
   */
  private async markRecoveredTaskErrors(sessionId: string): Promise<void> {
    const sidecarIsError = async (id: string | undefined): Promise<boolean> => {
      if (!id) return false
      const detail = await this.loadToolCallDetailAcrossSessions(id, sessionId)
      return detail?.isError === true
    }
    let changed = false
    for (const row of this.recoveredRunJs.get(sessionId) ?? []) {
      if (row.status !== 'error' && (await sidecarIsError(row.callId))) {
        row.status = 'error'
        changed = true
      }
    }
    for (const row of this.recoveredBash.get(sessionId) ?? []) {
      if (row.status !== 'error' && (await sidecarIsError(row.detailId))) {
        row.status = 'error'
        changed = true
      }
    }
    if (changed) this.feed.scheduleSummary()
  }

  private async loadRecoveredShellDetail(
    toolCallId: string,
  ): Promise<{ outputFilePath?: string; outputText?: string } | null> {
    const detail = await this.loadToolCallDetailAcrossSessions(toolCallId)
    if (!detail || !SHELL_LAUNCH_TOOL_IDS.has(detail.toolName ?? '')) return null
    const result =
      detail.result && typeof detail.result === 'object'
        ? (detail.result as Record<string, unknown>)
        : {}
    const outputFilePath =
      typeof result.output_file === 'string' && result.output_file.length > 0
        ? result.output_file
        : undefined
    const outputText =
      typeof result.output === 'string' ? result.output : undefined
    return { outputFilePath, outputText }
  }

  private notifyToolDetailReady(
    toolCallId: string,
    detail: BrowserToolCallDetailRecord | null,
  ): void {
    this.portHub.broadcastToToolDetailSubscribers(toolCallId, {
      type: 'toolDetail.ready' as const,
      payload: { toolCallId, detail },
    })
  }

  private getSubscribersFor(sessionId: string): MessagePort[] {
    return this.portHub.getSubscribersFor(sessionId)
  }

  private getListSubscribers(): MessagePort[] {
    return this.portHub.getListSubscribers()
  }

  /**
   * Contract: unified session disposal, in fixed order for every delete path: drop queued deliveries,
   * fire the C++ session_deleted stop, clear ports, dispose the worker, remove the entry. Best-effort per step.
   */
  private async disposeManagedSession(
    sessionId: string,
    opts: { fireStop?: boolean } = {},
  ): Promise<void> {
    this.taskDelivery.dropParent(sessionId)
    this.dirtySessionCounters.delete(sessionId)
    this.legacyStreamEndedSessions.delete(sessionId)
    this.recoveredRunJs.delete(sessionId)
    this.recoveredBash.delete(sessionId)
    this.recoveredSuperShell.delete(sessionId)
    this.recoveredTitles.delete(sessionId)
    this.backgroundRecovered.delete(sessionId)
    // Flush any pending skill-events write so a debounced burst isn't lost when
    // the session is torn down (the flush no-ops for a deleted session via the
    // storage tombstone guard). The recovery-cache entry is intentionally kept:
    // it holds a resolved read, and the realm-global log persists across a
    // dispose, so a re-open needs no second sidecar read.
    if (this.skillEventsWriteTimers.has(sessionId)) {
      void this.flushSkillEventsPersist(sessionId)
    }
    const session = this.sessions.get(sessionId)
    if (!session) return
    if (opts.fireStop && session.worker.fireSessionDeletedStop) {
      try {
        await session.worker.fireSessionDeletedStop()
      } catch {
        // best-effort; JS-side teardown continues
      }
    }
    await this.disposeSessionWorker(sessionId, session)
    // A stopped sub-agent can be resumed while the old worker is still
    // awaiting native teardown. Never delete a replacement registered under
    // the same session id.
    if (this.sessions.get(sessionId) === session) {
      this.sessions.delete(sessionId)
      this.flushPendingRename(sessionId, session)
      // The feed's prev-snapshot cache is keyed per session and grew an entry
      // for every sub-agent / teammate / routine run (the router refreshes
      // status BEFORE the background interceptors), but only the UI delete
      // path forgot it. Idempotent — the delete path forgets again.
      this.feed.forgetStatus(sessionId)
      // A session removed mid-turn never reports its turn ending.
      currentRenderCachePolicy()?.noteBusyChanged()
    }
  }

  /**
   * A rename or pin stashed for a runtime that never bound is written the disk-only way as the entry goes.
   */
  private flushPendingRename(sessionId: string, entry: SessionEntry): void {
    const pendingPinned = entry.pendingPinned
    if (pendingPinned !== undefined && this.storage) {
      entry.pendingPinned = undefined
      void applyDiskOnlyMetadataPatch(this.storage, sessionId, {
        pinned: pendingPinned,
      })
        .catch(() => false)
        .then(persisted => {
          if (!persisted) this.dropPinnedOverlay(sessionId)
        })
    }
    const pendingRename = entry.pendingRename
    if (pendingRename === undefined || !this.storage) return
    entry.pendingRename = undefined
    void applyDiskOnlyRename(
      this.storage,
      sessionId,
      pendingRename,
      Date.now(),
    ).catch(() => {})
  }

  /** The live overlay stops claiming a pin that never reached storage; the summary falls back to disk. */
  private dropPinnedOverlay(sessionId: string): void {
    const prev = this.sessionMeta.get(sessionId)
    if (!prev || prev.pinned === undefined) return
    const { pinned: _unsaved, ...rest } = prev
    this.sessionMeta.set(sessionId, rest)
    void this.summaryRepo.refreshFsSummary(sessionId).catch(() => {})
  }

  private reapSessionEntrySync(sessionId: string): void {
    const session = this.sessions.get(sessionId)
    this.dirtySessionCounters.delete(sessionId)
    this.legacyStreamEndedSessions.delete(sessionId)
    this.sessions.delete(sessionId)
    if (session) {
      this.flushPendingRename(sessionId, session)
      this.taskDelivery.dropParent(sessionId)
      void this.disposeSessionWorker(sessionId, session)
    }
    // See `disposeManagedSession`: a reaped background run must not leave its
    // status cache entry behind.
    this.feed.forgetStatus(sessionId)
  }

  /**
   * The step every session-ending path shares — the awaited dispose and the
   * sync reap alike: detach the ports, end the session's terminals (they
   * belong to the session and die with it, F-31), dispose the worker. The
   * terminals go before the worker's own teardown is awaited, so a path that
   * does not wait still ends them at once. Best-effort.
   */
  private async disposeSessionWorker(sessionId: string, session: SessionEntry): Promise<void> {
    session.ports.clear()
    try {
      this.closeTerminalsForSession(sessionId)
    } catch {
      // best-effort
    }
    try {
      await session.worker.dispose?.()
    } catch {
      // best-effort
    }
  }

  /** Where a session's terminal starts: its worker's cwd (the worktree when it runs in one), else its project root. */
  private sessionTerminalCwd(sessionId: string): string | undefined {
    const entry = this.sessions.get(sessionId)
    if (!entry) return undefined
    let snapshot: AgentRuntimeWorkerSnapshot | undefined
    try {
      snapshot = entry.worker.getSnapshot()
    } catch {
      snapshot = undefined
    }
    return snapshot?.cwd || snapshot?.projectRoot || entry.projectRoot || undefined
  }

  private async handleSessionDelete(
    port: MessagePort,
    sessionId: string,
    requestId?: string,
  ): Promise<void> {
    this.deletingSessions.add(sessionId)
    // Deleting a lead shuts its teammates down, AWAITED before the storage delete below (their teardown
    // writes under this dir). Ids are collected before the abort: record rows plus running ones.
    const teammateIds = new Set(
      this.teams.listTeammatesOf(sessionId).map(tm => tm.sessionId),
    )
    try {
      try {
        for (const child of (await this.groupedStorage?.listTeammateChildren(
          sessionId,
        )) ?? []) {
          teammateIds.add(child.sessionId)
        }
      } catch {
        // best-effort; the live roster still covers the running children
      }
      await this.teams.abortTeammatesOf(sessionId)
      // What the coordinator remembered about this lead goes with it — after
      // the children's teardown, which is what writes the last of it.
      this.teams.forgetLead(sessionId)

      // Cascade: deleting a parent abandons its in-flight background
      // sub-agents — abort + tear them down so they don't keep running / leak, and
      // drop any results queued for the vanishing parent. AWAITED: the children's
      // transcripts live under the parent dir the
      // storage delete below removes, and each child's worktree cleanup is
      // sequenced after its worker dispose inside the cascade.
      await this.cascadeSubAgentsOnParentClose(sessionId)

      // Unified disposal (drop deliveries, fire C++ stop, clear ports,
      // dispose worker, remove entry).
      await this.disposeManagedSession(sessionId, { fireStop: true })
      this.sessionMeta.delete(sessionId)
      this.fsSummaries.delete(sessionId)
      this.forgetSkillEvents(sessionId)
      // Written on every `session.open`; this is its only removal.
      this.panelOfSession.delete(sessionId)
      this.runtimeSessionSurface?.dropSessionTopics(sessionId)

      // A deleted session must not leave its prev-snapshot cache
      // behind, so nothing stale can re-emit for the dead id.
      this.feed.forgetStatus(sessionId)

      // Provider mods: `provider.sessionEnd` in the modules that hook it, then
      // the session's provider stores go (5 s at most, never rejects; a no-op in
      // a realm with no provider mod). The teammates' sessions end with the lead.
      await endProviderSessions([sessionId, ...teammateIds])
      // The session's MCP servers stop now rather than after the release grace.
      void closeSessionMCPPool(sessionId)

      if (this.storage) {
        // A background extract fork spawned by this session's last turn may
        // still be mid-flight, appending its sidechain transcript under the
        // session dir the delete below removes. Give it a bounded window to
        // finish (memory writes land in the memory dir, so this mainly
        // prevents the fork erroring against vanished storage). The timeout
        // is short — a
        // user-initiated delete must not hang on a slow model call.
        try {
          await awaitMemoryExtractions(5_000)
        } catch {
          // drain is best-effort; deletion proceeds regardless
        }
        try {
          await this.storage.deleteSession(sessionId)
        } catch {
          // best-effort; the in-memory state is already gone
        }
        // Cascade the meta ROWS of this session's teammates. Their FILES are
        // already gone — they live under the directory just removed — but the
        // rows are in the one global sessions DB and would otherwise leak:
        // never listed (their parent no longer exists) and never removed.
        try {
          await this.groupedStorage?.deleteMetaByParent(sessionId)
        } catch {
          // best-effort; an orphan row is hidden, not harmful
        }
      }

      // A write that landed while the delete awaited must not outlive it.
      this.sessionMeta.delete(sessionId)
      this.fsSummaries.delete(sessionId)
    } finally {
      // A throw above leaves the session alive; its pins must not stay refused.
      this.deletingSessions.delete(sessionId)
    }

    const removedMessage = {
      type: 'session.removed' as const,
      payload: { sessionId, ...(requestId ? { requestId } : {}) },
    }
    // Only the ports that asked (either targeted or 'all') learn about the
    // removal. Ports with no interest in this session don't get woken up.
    const targets = new Set<MessagePort>(this.getSubscribersFor(sessionId))
    if (requestId) targets.add(port)
    for (const p of targets) {
      p.postMessage(removedMessage)
    }
    // The children went with the lead — their files under its directory, their
    // rows via `deleteMetaByParent` — but only the lead was announced, so the
    // tab strip kept a child the user could click into a teammate id with no
    // storage behind it, and the children's summaries stayed cached here and in
    // every client list until a restart. Each one is dropped and announced like
    // a session of its own, to its own subscribers and to whoever learned of
    // the lead's removal.
    teammateIds.delete(sessionId)
    for (const teammateId of teammateIds) {
      this.sessionMeta.delete(teammateId)
      this.fsSummaries.delete(teammateId)
      this.panelOfSession.delete(teammateId)
      this.runtimeSessionSurface?.dropSessionTopics(teammateId)
      this.feed.forgetStatus(teammateId)
      this.forgetSkillEvents(teammateId)
      const childRemoved = {
        type: 'session.removed' as const,
        payload: { sessionId: teammateId },
      }
      const childTargets = new Set<MessagePort>([
        ...targets,
        ...this.getSubscribersFor(teammateId),
      ])
      for (const p of childTargets) {
        p.postMessage(childRemoved)
      }
    }
  }

  /**
   * Rename via a manual `customTitle`; ONLY the bound store writes `meta.json` while a runtime is bound
   * (pre-bind: stashed; no runtime: `applyDiskOnlyRename`). `customTitle` wins at every read; empty clears it.
   */
  private async handleSessionRename(
    port: MessagePort,
    sessionId: string,
    title: string,
    requestId?: string,
  ): Promise<void> {
    const trimmed = title.trim()
    const entry = this.sessions.get(sessionId)

    // A manual rename supersedes any in-flight auto-title generation: tell the
    // live worker to abort its fast-model title call so it doesn't land and
    // race the user's choice. (The `/rename` command path cancels in-engine;
    // this covers the sidebar `session.rename` path.)
    if (entry) {
      const cancelMessage: SessionWorkerInboundMessage = {
        type: 'worker.cancelAutoTitle',
        sessionId,
      }
      void entry.worker.receiveFrame(cancelMessage)
    }

    if (entry?.conversationStore) {
      // Live session: route through the store, which logs ONE `custom-title`
      // record and rewrites `meta.json`.
      try {
        await entry.conversationStore.storeUserTitle(trimmed, 'user')
      } catch {
        // best-effort; the live overlay + broadcast below still reflect it
      }
    } else if (entry) {
      // Runtime exists, store not bound yet: the store already loaded its
      // state, so a disk write here would be overwritten by its first persist.
      // Stash it; `bindSessionRuntime` applies it through the store.
      entry.pendingRename = trimmed
    } else if (this.storage) {
      // Disk-only session (no live worker): fresh read-modify-write of
      // `meta.json` plus one `custom-title` log record, shared with the store's
      // own rename path so the two writers cannot drift. The session's
      // project dir must be KNOWN first — before the routing scan has mapped
      // it, the grouped storage would probe the default dir, find nothing,
      // and the rename would be silently dropped.
      let persisted = false
      try {
        await this.summaryRepo.ensureSessionRouting()
        persisted = await applyDiskOnlyRename(
          this.storage,
          sessionId,
          trimmed,
          Date.now(),
        )
      } catch {
        // best-effort
      }
      if (!persisted) {
        // Nothing on disk describes this session (or it could not be read):
        // there is nothing to rename. Do not paint the overlay with a title
        // that has no durable counterpart — the row keeps its real title.
        console.warn(
          `[SharedWorkerSessionManager] rename of ${sessionId} not persisted: ` +
            'no meta.json or transcript found for it',
        )
        return
      }
    }

    // Reflect the rename in the live overlay immediately (before the fs
    // round-trip in refreshFsSummary lands) so an open session's row
    // updates without waiting on disk. A cleared rename writes the `null`
    // TOMBSTONE — `undefined` would let the projection fall
    // back to the fs cache's old title until the refresh below lands.
    const prev = this.sessionMeta.get(sessionId) ?? {}
    this.sessionMeta.set(sessionId, {
      ...prev,
      customTitle: trimmed.length > 0 ? trimmed : null,
    })

    // Re-read the persisted summary (now carrying customTitle) into the LRU
    // and broadcast session.updated to subscribers.
    await this.summaryRepo.refreshFsSummary(sessionId)

    // Ack the requesting port even if it isn't a session subscriber, so an
    // optimistic UI can reconcile (mirrors handleSessionDelete's ack).
    if (requestId) {
      const session = this.buildSessionInfo(sessionId)
      if (session) {
        port.postMessage({
          type: 'session.updated' as const,
          payload: { session },
        })
      }
    }
  }

  /**
   * Pin or unpin a session by writing `pinned` into its metadata, through the
   * same three owners as a rename: the bound store, the pre-bind stash, or a
   * disk-only write of `meta.json`.
   */
  private async handleSessionPin(
    port: MessagePort,
    sessionId: string,
    pinned: boolean,
    requestId?: string,
  ): Promise<void> {
    if (this.deletingSessions.has(sessionId)) {
      console.warn(`[SharedWorkerSessionManager] pin of ${sessionId} refused: it is being deleted`)
      return
    }
    const entry = this.sessions.get(sessionId)
    if (entry?.conversationStore) {
      // This choice supersedes a pre-bind stash, so a bind still in flight
      // does not write the older value after it.
      entry.pendingPinned = undefined
      try {
        await entry.conversationStore.updateSessionMetadata({ pinned })
      } catch (error) {
        console.warn(`[SharedWorkerSessionManager] pin of ${sessionId} not persisted`, error)
        return
      }
    } else if (entry) {
      entry.pendingPinned = pinned
    } else if (this.storage) {
      let persisted = false
      try {
        await this.summaryRepo.ensureSessionRouting()
        persisted = await applyDiskOnlyMetadataPatch(this.storage, sessionId, {
          pinned,
        })
      } catch {
        // best-effort
      }
      if (!persisted) {
        console.warn(
          `[SharedWorkerSessionManager] pin of ${sessionId} not persisted: ` +
            'no meta.json or transcript found for it',
        )
        return
      }
      // A runtime that opened during the write loaded the sidecar without the
      // pin; hand it the value so its own next save keeps it.
      const opened = this.sessions.get(sessionId)
      if (opened?.conversationStore) {
        await opened.conversationStore
          .updateSessionMetadata({ pinned })
          .catch(() => {})
      } else if (opened) {
        opened.pendingPinned = pinned
      }
    }

    const prev = this.sessionMeta.get(sessionId) ?? {}
    this.sessionMeta.set(sessionId, { ...prev, pinned })
    await this.summaryRepo.refreshFsSummary(sessionId)

    if (requestId) {
      const session = this.buildSessionInfo(sessionId)
      if (session) {
        port.postMessage({
          type: 'session.updated' as const,
          payload: { session },
        })
      }
    }
  }

  /**
   * `session.open`: build the session's init payload here — from the published
   * host environment, the desktop's own fields when it sent them, the
   * session's persisted binding and, for a forced-folder type with no folder,
   * the user's last folder of that type (the runtime's workspace index) — then
   * run it through the same init path a `worker.init` takes.
   */
  private async openSession(
    port: MessagePort,
    open: SessionOpenPayload,
    panelId?: string,
  ): Promise<void> {
    // Which window's boot overlay this session's runtime build reports to.
    this.panelOfSession.set(open.sessionId, panelId ?? DEFAULT_PANEL_ID)
    const summary = this.fsSummaries.peek(open.sessionId)
    const composed = composeSessionInit({
      open,
      hostEnvironment: this.hostEnvironment,
      lastInitTemplate: this.lastInitTemplate,
      persisted: {
        ...(summary?.projectRoot ? { projectRoot: summary.projectRoot } : {}),
        ...(summary?.templateType ? { templateType: summary.templateType } : {}),
      },
    })
    if (!composed.payload) {
      throw wireError('host_unavailable', composed.reason)
    }
    const { payload } = composed
    if (composed.needsLastFolderFor) {
      const workspace = await this.runtimeHub.workspace.current().catch(() => null)
      const lastFolder = workspace?.lastFolderByType[composed.needsLastFolderFor]
      if (lastFolder) payload.projectRoot = lastFolder
    }
    this.initOrchestrator.handle(port, {
      type: 'worker.init',
      sessionId: open.sessionId,
      payload,
    })
  }

  private handleSessionMessage(
    port: MessagePort,
    message: SessionWorkerInboundMessage,
  ): void {
    const { sessionId } = message

    if (message.type === 'worker.init') {
      this.initOrchestrator.handle(port, message)
      return
    }

    const session = this.sessions.get(sessionId)
    if (!session) {
      port.postMessage({
        type: 'worker.error',
        payload: {
          code: 'session_not_found',
          message: `Session '${sessionId}' not found`,
        },
      })
      return
    }

    // A genuine user turn re-arms background-task delivery: any results that
    // were suppressed by a prior Stop should flush once the user is actively
    // driving the conversation again.
    // Suppression is now owned by TaskDeliveryQueue.
    if (message.type === 'worker.submitMessage') {
      this.taskDelivery.resumeParent(sessionId)
    }

    // submitMessage and clearPendingMessage are handled internally
    // by the Worker (which owns the submit queue + pending message). The Manager
    // only intercepts for lifecycle (worker.init above) and cross-session
    // concerns (worker.interrupt cascade below).
    void session.worker.receiveFrame(message).catch(error => {
      if (
        this.sessions.get(sessionId) !== session ||
        (error instanceof Error && error.name === 'AbortError')
      ) {
        return
      }
      const messageText =
        error instanceof Error ? error.message : String(error)
      try {
        port.postMessage({
          type: 'worker.error',
          sessionId,
          payload: {
            code: 'worker_message_failed',
            message: messageText,
          },
        })
      } catch {
        // Port may already be gone.
      }
      this.tracer.event('worker.manager.message.failed', {
        attrs: { sessionId, type: message.type, message: messageText },
      })
    })

    // User Stop on a session = "halt everything this session started", not just
    // the parent turn. The interrupt above unblocks any TaskOutput(block) the
    // parent was parked on (its abort path stops that ONE awaited sub-agent);
    // this cascade additionally stops every OTHER background sub-agent the
    // session launched but wasn't blocked on. `stopSubAgent` is idempotent, so a
    // sub-agent the parent was already blocked on is safe to re-stop. (Sync
    // in-context forks aren't worker sessions — they stop via the interrupt's
    // child-abort, not here.)
    if (message.type === 'worker.interrupt') {
      // Suppress background-task re-activation: a task finishing moments after
      // Stop must not inject a `<task-notification>` turn that revives the
      // conversation the user just halted. Drop anything already queued (it
      // would otherwise flush the instant the interrupted turn unwinds) and set
      // the flag to suppress results that finalize during the stopping window.
      // Both clear on the next genuine user submit.
      // Suppression is now owned by TaskDeliveryQueue.
      this.taskDelivery.suppressParent(sessionId)
      this.stopRunningSubAgentsForParent(sessionId)
      // Teammates too (team feature): Stop on a lead interrupts every
      // teammate turn in flight. They are NOT shut down — a teammate
      // outlives a turn and parks on its mailbox for the next brief; only
      // Shutdown / deleting the lead removes one (`abortTeammatesOf`).
      this.teams.interruptTeammatesOf(sessionId)
    }
  }

  /**
   * Spawn a BACKGROUND, worker-hosted sub-agent (the `Agent` tool's execution
   * path). Delegates to the SubAgentCoordinator, which owns the
   * whole spawn/launch/finalize/stop lifecycle; registered with the
   * subAgentSpawner leaf in the constructor. Returns the public `a…` taskId,
   * or null (no init template yet / nesting depth cap).
   */
  spawnSubAgentSession(params: SubAgentSpawnParams): string | null {
    return this.subAgents.spawn(params)
  }

  /**
   * Per-kind FIFO cap on the unified `finishedTasks` map: evict the OLDEST
   * record(s) of `kind` (Map preserves insertion order, so the first matching
   * entry is the oldest of that kind) once its count exceeds `cap`. `onEvict`
   * runs per evicted id (e.g. purge the shell acknowledged set).
   */
  private evictFinishedOverCap(
    kind: NexusTaskKind,
    cap: number,
    onEvict?: (id: string) => void,
    filter?: (record: NexusFinishedTaskRecord) => boolean,
  ): void {
    this.taskRegistry.evictFinishedOverCap(kind, cap, onEvict, filter)
  }

  /** Live sub-agent task by native id, or undefined (not an agent / unknown). */
  private agentTask(id: string): SubAgentRunState | undefined {
    return this.taskRegistry.getLiveByType(id, 'local_agent')
  }

  // ---------- In-process fork + fast-call task lifecycle (`sideTaskSink`) ----------
  // Mirrors registerBackgroundShell: the choke points (launchFork /
  // queryFastModel) notify the sink leaf; the manager mirrors the run as a
  // drawer task. Purely informational — NOTHING here may enqueue
  // `pendingTaskResults` (forks deliver to their caller in-process; fast calls
  // are fire-and-forget), so no `<task-notification>` turn ever fires.

  /** Register a fork the query loop just started. */
  private registerForkTask(start: ForkTaskStart): void {
    this.sideTasks.registerFork(start)
  }

  /** Per persisted fork message: liveness + the live detail transcript. */
  private progressForkTask(agentId: string, message: unknown): void {
    this.sideTasks.progressFork(agentId, message)
  }

  /** Terminal transition for a fork: reap the live state, retain a record. */
  private finishForkTask(finish: ForkTaskFinish): void {
    this.sideTasks.finishFork(finish)
  }

  /** Register a fast-model one-shot the query loop just issued. */
  private registerFastCall(start: FastCallStart): void {
    this.sideTasks.registerFastCall(start)
  }

  /** Terminal transition for a fast call: reap + retain the record. */
  private finishFastCall(finish: FastCallFinish): void {
    this.sideTasks.finishFastCall(finish)
  }

  /** Register a `run_js` execution the tool just dispatched. */
  private registerRunJsTask(start: RunJsTaskStart): void {
    this.sideTasks.registerRunJs(start)
  }

  /** Terminal transition for a `run_js` execution: reap + retain the record. */
  private finishRunJsTask(finish: RunJsTaskFinish): void {
    this.sideTasks.finishRunJs(finish)
  }

  // ---------- Background sub-agent control surface (G1/G3/G4) ----------
  // Registered with the `subAgentController` leaf so the TaskStop / TaskOutput
  // / AgentResume tools reach this state without importing the manager.

  /** Non-blocking snapshot of a running or finished sub-agent; null if unknown. */
  getSubAgentSnapshot(sessionId: string): SubAgentSnapshot | null {
    return this.taskControl.getSnapshot(sessionId)
  }

  /**
   * Enumerate the background sub-agents launched from `spawnerSessionId`
   * (`AgentList`, G2): in-flight runs from `subAgentRuns` plus retained terminal
   * records from `finishedSubAgents`, filtered to this parent. Running entries
   * sort first (oldest-running first — likely the most interesting), then
   * terminal entries most-recently-finished first.
   */
  listSubAgents(spawnerSessionId: string): SubAgentListEntry[] {
    return this.taskControl.list(spawnerSessionId)
  }

  /**
   * Resolve when the sub-agent reaches a terminal state, or with its current
   * (still-`running`) snapshot after `timeoutMs`. Resolves null for an unknown
   * id. A resolver registry holds the waiters; finalize resolves them
   * directly, with no poll loop.
   */
  waitForSubAgentCompletion(
    sessionId: string,
    timeoutMs: number,
    signal?: AbortSignal,
  ): Promise<SubAgentSnapshot | null> {
    return this.taskControl.waitForCompletion(sessionId, timeoutMs, signal)
  }

  /**
   * Abort + reap a running background sub-agent (`TaskStop`, G1). Records a
   * `stopped` terminal state (readable via `TaskOutput`) and does NOT deliver a
   * result to the parent. No-op-safe on an already-finished / unknown id.
   */
  stopSubAgent(sessionId: string): SubAgentStopResult {
    return this.taskControl.stop(sessionId)
  }

  /**
   * Re-launch a FINISHED background sub-agent into its persisted transcript
   * with a follow-up `prompt` (`AgentResume`, G4). The resumed run keeps the
   * original agent identity
   * (system prompt / model / tool scope / worktree) and depth, and delivers its
   * new result back to the original parent like any background sub-agent.
   */
  resumeSubAgent(publicId: string, prompt: string): SubAgentResumeResult {
    return this.taskControl.resume(publicId, prompt)
  }

  /**
   * The model read a finished sub-agent's TERMINAL result via `TaskOutput`, so
   * drop that result from the parent's pending-delivery queue — it would
   * otherwise be re-injected as a duplicate `[Background sub-agent results]`
   * turn. No-op if the id is
   * unknown or nothing is queued (e.g. it was already delivered).
   */
  acknowledgeSubAgentResult(publicId: string): void {
    this.taskControl.acknowledgeResult(publicId)
  }

  /** Remove every queued task result matching `pred` from all parents' queues. */
  private dropPendingTaskResult(
    pred: (r: NexusTaskDeliveryResult) => boolean,
  ): boolean {
    return this.taskDelivery.acknowledge(pred)
  }

  /** Queue a finished background-task result (agent or shell) and try to flush
   *  it to the parent as one task-notification turn. */
  private deliverTaskResult(
    spawnerSessionId: string,
    result: NexusTaskDeliveryResult,
  ): void {
    this.taskDelivery.enqueue(spawnerSessionId, result)
  }

  private maybeFlushTaskResults(spawnerSessionId: string): void {
    this.taskDelivery.flushIfReady(spawnerSessionId)
  }

  /**
   * Worker host: the running turn takes the team frames queued for this
   * session (teammate or lead) between two tool rounds — see
   * `TeamCoordinator.takeMidTurnMessages`. Each is marked read as it is taken.
   */
  drainMidTurnTeamMessages(
    sessionId: string,
  ): Array<{ prompt: string; enqueuedAt: number }> {
    return this.teams
      .takeMidTurnMessages(sessionId)
      .map(entry => ({ prompt: entry.prompt, enqueuedAt: entry.enqueuedAt }))
  }

  drainMidTurnTaskNotifications(
    sessionId: string,
    opts: { includeLater: boolean },
  ): { prompt: string; enqueuedAt: number } | null {
    const drained = this.taskDelivery.drain(
      sessionId,
      result => isNextPriorityTaskResult(result) || opts.includeLater,
    )
    if (drained.length === 0) return null
    const times = drained
      .map(result => this.taskDelivery.enqueuedAtOf(result))
      .filter((t): t is number => typeof t === 'number')
    return {
      prompt: formatTaskNotifications(drained),
      enqueuedAt: times.length > 0 ? Math.min(...times) : Date.now(),
    }
  }

  /**
   * Cascade a parent's Stop to its in-flight background sub-agents: each is STOPPED (a readable
   * `stopped` record + worker abort). Idempotent.
   */
  private stopRunningSubAgentsForParent(spawnerSessionId: string): void {
    this.taskControl.stopRunningForParent(spawnerSessionId)
  }

  // ===========================================================================
  // Background shells (`local_bash` tasks): persistent host children started and polled by
  // BackgroundShellCoordinator; Stop → `shell.persistentKill`; re-adopted after a worker restart.
  // ===========================================================================

  /** Register a background shell the Bash tool just launched + start polling.
   *  (Primitive calls + output-path plumbing live in BackgroundShellHostBridge.) */
  registerBackgroundShell(launch: BackgroundShellLaunch): void {
    this.shells.register(launch)
  }

  /** The direct transport the last adoption ran on (once per transport). */
  private persistentShellsAdoptedFor: object | null = null

  /**
   * Re-adopt the persistent children a previous worker started and that are
   * still running (BackgroundShellCoordinator.adoptRunning). Runs once per
   * host port, as soon as the port AND a manifest listing the persistent
   * shells are both known — whichever arrives second triggers it.
   */
  private maybeAdoptPersistentShells(): void {
    const transport = this.bridgeRouter.getDirectTransport()
    if (!transport || this.persistentShellsAdoptedFor === transport) return
    if (!this.shells.canSpawn()) return
    this.persistentShellsAdoptedFor = transport
    void this.shells.adoptRunning().then(
      adopted => {
        if (adopted > 0) {
          this.tracer.event('worker.manager.shells.adopted', { attrs: { adopted } })
        }
      },
      () => {},
    )
  }

  /** Acknowledge a shell result (model already read it). Delegates to the
   *  BackgroundShellCoordinator. */
  private acknowledgeBackgroundShellResult(shellId: string): void {
    this.shells.acknowledgeResult(shellId)
  }

  /**
   * Cascade a parent's deletion to its in-flight background sub-agents and drop their queued results.
   * Settles once every child's teardown and worktree cleanup finished, before the parent's storage goes.
   */
  private cascadeSubAgentsOnParentClose(spawnerSessionId: string): Promise<void> {
    return this.taskControl.cascadeOnParentClose(spawnerSessionId)
  }

  /**
   * Spawn a teammate session. Delegates to the
   * TeamCoordinator, which owns the teammate registry,
   * mailbox-driven idle loop, and teardown; registered with the
   * teammateSpawner leaf in the constructor. Returns the new sessionId,
   * or null when no UI session has booted yet (no init template).
   */
  spawnTeammateSession(params: SpawnTeammateParams): string | null {
    return this.teams.spawn(params)
  }

  /** Parents whose finished sub-agents were already restored from disk this
   *  worker lifetime (`restoreFinishedSubAgentsFromDisk`). */
  private readonly restoredSubAgentParents = new Set<string>()

  /**
   * Restore a parent's FINISHED background sub-agents into the task registry from their `task.json`
   * seeds (or `meta.json`), once per parent per lifetime after its routing commits; released on failure.
   * Restored sub-agents re-register their storage routing.
   */
  private async restoreFinishedSubAgentsFromDisk(
    spawnerSessionId: string,
  ): Promise<void> {
    if (
      isSubAgentSessionId(spawnerSessionId) ||
      this.restoredSubAgentParents.has(spawnerSessionId)
    ) {
      return
    }
    this.restoredSubAgentParents.add(spawnerSessionId)
    try {
      const dirs =
        await this.storageCoordinator.listSubAgentSessionDirs(spawnerSessionId)
      let seeded = 0
      for (const subagentSessionId of dirs) {
        if (
          this.taskRegistry.getLive(subagentSessionId) ||
          this.taskRegistry.getFinished(subagentSessionId)
        ) {
          continue
        }
        const record = await this.readRestoredSubAgentRecord(
          spawnerSessionId,
          subagentSessionId,
        )
        if (!record) continue
        if (this.subAgents.seedRestoredRecord(record)) {
          this.storageCoordinator.registerSubAgentRouting(
            spawnerSessionId,
            subagentSessionId,
          )
          seeded++
        }
      }
      if (seeded > 0) this.feed.scheduleSummary()
    } catch {
      // Storage not up yet / bridge hiccup: release the guard so the next
      // session upsert retries.
      this.restoredSubAgentParents.delete(spawnerSessionId)
    }
  }

  /** One restored record: `task.json` first, `meta.json` fallback. */
  private async readRestoredSubAgentRecord(
    spawnerSessionId: string,
    subagentSessionId: string,
  ): Promise<FinishedSubAgentRecord | null> {
    const now = Date.now()
    const taskText = await this.storageCoordinator.readSubAgentFile(
      spawnerSessionId,
      subagentSessionId,
      SUBAGENT_TASK_FILE_NAME,
    )
    if (taskText) {
      const file = parseSubAgentTaskFile(taskText)
      if (file && file.sessionId === subagentSessionId) {
        return finishedRecordFromTaskFile(file, now)
      }
    }
    // A sub-agent's meta now lives as a ROW in the single sqlite store (keyed by
    // its sessionId), not a `subagents/<id>/meta.json` FILE — new sub-agents no
    // longer write that file. `readSessionMeta` does not filter sub-agent ids
    // (only the sidebar `listAll` does), so it answers here.
    const meta = await this.storage?.readSessionMeta(subagentSessionId)
    if (!meta) return null
    return finishedRecordFromSessionMeta({
      sessionId: subagentSessionId,
      spawnerSessionId,
      taskId: mintTaskHandle('local_agent'),
      firstPrompt: meta.metadata.firstPrompt,
      previewText: meta.metadata.previewText,
      lastTerminalReason: meta.metadata.lastTerminalReason,
      updatedAt: meta.updatedAt,
      now,
    })
  }

  private notifySessionUpserted(sessionId: string): void {
    // A session upsert fires (among other places) when an init commits -- the
    // first moment the parent's storage routing is known, which is what the
    // sub-agent restart-restore needs. Guarded + idempotent, so the extra
    // firings are cheap no-ops.
    void this.restoreFinishedSubAgentsFromDisk(sessionId)
    const session = this.buildSessionInfo(sessionId)
    if (!session) return
    const message = {
      type: 'session.updated' as const,
      payload: { session },
    }
    for (const port of this.getSubscribersFor(sessionId)) {
      port.postMessage(message)
    }
  }

  private buildSessionInfoList(): SessionCard[] {
    const ids = new Set<string>([
      ...this.sessions.keys(),
      ...this.fsSummaries.keys(),
    ])
    return Array.from(ids)
      // Background sub-agents are not user-facing sessions (see
      // `isSubAgentSessionId`) — never list them as top-level sidebar sessions.
      .filter(id => !isSubAgentSessionId(id))
      .map(id => this.buildSessionInfo(id))
      .filter((info): info is SessionCard => info !== null)
  }

  private buildSessionInfo(sessionId: string): SessionCard | null {
    // Pure assembly lives in sessionInfoProjection;
    // the Manager only gathers the three sources.
    const entry = this.sessions.get(sessionId)
    return projectSessionInfo({
      sessionId,
      entry: entry
        ? {
            templateType: entry.templateType,
            projectRoot: entry.projectRoot,
            ...(entry.spawnerSessionId
              ? { spawnerSessionId: entry.spawnerSessionId }
              : {}),
            ...(entry.teammateName ? { teammateName: entry.teammateName } : {}),
            snapshot: entry.worker.getSnapshot(),
          }
        : undefined,
      live: this.sessionMeta.get(sessionId),
      fs: this.fsSummaries.get(sessionId),
    })
  }

  private handleWorkerEmit(
    sessionId: string,
    instanceId: string,
    message: AgentWorkerOutboundMessage,
  ): void {
    this.eventRouter.handle(sessionId, instanceId, message)
  }

  /**
   * Snapshot this session's OWN runtime singletons when ready, from the worker's per-runtime report
   * (never the shared slot); what a sub-agent's `ownerGlobals` restores to.
   */
  private captureRuntimeGlobalsOnReady(sessionId: string): void {
    const readySession = this.sessions.get(sessionId)
    if (readySession) {
      readySession.runtimeGlobals = readySession.worker.getRuntimeGlobals?.()
    }
  }

  /**
   * Track the halted-on-ask flag from a full-snapshot emission. A flip
   * re-broadcasts the summary — the moment an ask appears is otherwise NOT
   * a phase transition (the tool stays in flight, waiting), so nothing else
   * would flush and the sidebar dot would lag until an unrelated bump.
   */
  private trackNeedsAnswerFromSnapshot(
    sessionId: string,
    snapshot: AgentRuntimeWorkerSnapshot,
  ): void {
    const entry = this.sessions.get(sessionId)
    if (entry) {
      const needsAnswer = snapshotNeedsAnswer(snapshot)
      if (needsAnswer !== entry.needsAnswer) {
        entry.needsAnswer = needsAnswer
        this.feed.scheduleSummary()
      }
    }
  }

  /**
   * Public: re-read a session's persisted summary into the LRU and broadcast
   * `session.updated`. For out-of-band transcript writers (e.g. QueryEngine's
   * automatic AI session-title) that append a `custom-title` / `ai-title` entry
   * directly and need the sidebar to refresh without a full turn.
   */
  async refreshSessionSummary(sessionId: string): Promise<void> {
    await this.summaryRepo.refreshFsSummary(sessionId)
  }

  /**
   * Fork a session at `cutUuid` into a NEW session (prefix copied via `buildForkedTranscriptEntries`,
   * sidecars copied), refresh its summary and ack. Best-effort: no ack on failure.
   */
  private async handleSessionFork(
    port: MessagePort,
    fromSessionId: string,
    cutUuid: string | undefined,
    requestId?: string,
    moveCutMessageToDraft?: boolean,
    title?: string,
    replacesSource?: boolean,
  ): Promise<void> {
    const storage = this.storage
    if (!storage) return
    try {
      const payload = await storage.load(fromSessionId)
      const sourceEntries = Array.isArray(payload) ? payload : []
      if (sourceEntries.length === 0) {
        console.warn('[nexus] fork skipped: the source has no saved messages', fromSessionId)
        return
      }
      const newSessionId =
        globalThis.crypto?.randomUUID?.() ??
        `fork-${Date.now().toString(36)}-${Math.random().toString(16).slice(2, 8)}`
      // Carry the source session's config (type / bound folder / title / model /
      // permission mode) into the fork so the copy is a faithful duplicate, not
      // a reset-to-default thread — the same tail read the rename flow trusts.
      // Transcript-derived fields are recomputed from the cut prefix.
      const sourceMetadata =
        (await storage.loadSessionMetadata?.(fromSessionId)) ?? undefined
      const built = buildForkedTranscriptEntries(
        sourceEntries,
        cutUuid,
        newSessionId,
        Date.now(),
        sourceMetadata,
        // Carry the source id so the fork copies its plan file on init.
        fromSessionId,
        // "Fork from here" cuts EXCLUSIVE, re-opens the cut prompt in the
        // fork's composer, and names the copy after the source ("<title>
        // (fork)", localized by the page); rewind keeps the inclusive cut and
        // the source's exact title.
        { moveCutMessageToDraft, title, ...(replacesSource ? { as: 'rewind' as const } : {}) },
      )
      if (!built) {
        console.warn('[nexus] fork skipped: no message to cut at', fromSessionId)
        return
      }
      // Tool details are lazy-loaded per session by toolCallId; copy the
      // referenced sidecars so the fork's tool cards don't get stuck loading.
      const toolDetails: BrowserToolCallDetailRecord[] = []
      for (const toolCallId of built.toolCallIds) {
        try {
          const detail = await storage.loadToolCallDetail?.(
            fromSessionId,
            toolCallId,
          )
          if (detail) toolDetails.push(detail)
        } catch {
          // best-effort; a missing sidecar just leaves that card to lazy-load
        }
      }
      // The fork is written BEFORE the new session's worker.init runs, so it
      // is routed to the source's project dir (else the effective one for its
      // type/folder) up front — see `writeSessionBundle`.
      await this.writeSessionBundle({
        sessionId: newSessionId,
        entries: built.entries,
        meta: built.meta,
        toolDetails,
        projectDir: this.groupedStorage?.projectRouteOf(fromSessionId),
        projectRoot: sourceMetadata?.projectRoot,
        templateType: sourceMetadata?.templateType,
      })
      port.postMessage({
        type: 'session.forked' as const,
        payload: { fromSessionId, newSessionId, requestId },
      })
    } catch (error) {
      // No ack means no fork happened.
      console.warn('[nexus] fork failed', fromSessionId, error)
    }
  }

  /**
   * Write a COMPLETE session (log, `meta.json`, sidecars) and publish it; shared by fork and import.
   * Order: route the id first, then the log, the projection, the sidecars, the summary refresh.
   * `projectDir` wins when given, else derived as `worker.init` would.
   */
  async writeSessionBundle(args: {
    sessionId: string
    entries: readonly BrowserTranscriptWriteEntry[]
    meta: SessionMetaFile
    toolDetails: readonly BrowserToolCallDetailRecord[]
    projectDir?: string
    projectRoot?: string
    templateType?: string
    /** Skip the summary refresh / `session.updated` broadcast. For sessions
     *  the sidebar must NOT list (a background sub-agent's own session). */
    publish?: boolean
  }): Promise<void> {
    const storage = this.storage
    if (!storage) {
      throw new Error('session storage is not available')
    }
    if (this.groupedStorage) {
      const projectDir =
        args.projectDir ??
        (this.homeDir
          ? projectHomeFor(
              this.homeDir,
              args.projectRoot ??
                getNexusWorkspaceDirForType(
                  this.homeDir,
                  args.templateType ?? DEFAULT_TEMPLATE_TYPE,
                ),
            )
          : undefined)
      if (projectDir) {
        this.groupedStorage.setSessionProjectDir(args.sessionId, projectDir)
      }
    }
    for (const entry of args.entries) {
      await storage.append(args.sessionId, entry)
    }
    await storage.writeSessionMeta(args.sessionId, args.meta)
    for (const detail of args.toolDetails) {
      try {
        await storage.saveToolCallDetail?.(args.sessionId, detail)
      } catch {
        // best-effort; a missing sidecar just leaves that card to lazy-load
      }
    }
    if (args.publish !== false) {
      await this.summaryRepo.refreshFsSummary(args.sessionId)
    }
  }

  /**
   * Write an IMPORTED sub-agent as a finished background sub-agent of `spawnerSessionId` (bundle under
   * `<projectDir>/<parent>/subagents/<sessionId>/` + `task.json`); nothing is published. Commits the
   * parent's routing from the sub-agent's `projectRoot`; without one it throws.
   */
  async writeSubAgentBundle(
    spawnerSessionId: string,
    bundle: {
      sessionId: string
      entries: readonly BrowserTranscriptWriteEntry[]
      meta: SessionMetaFile
      toolDetails: readonly BrowserToolCallDetailRecord[]
      task: Record<string, unknown>
    },
  ): Promise<void> {
    let subagentsDir =
      this.storageCoordinator.getSubAgentsDirForParent(spawnerSessionId)
    if (!subagentsDir) {
      const projectRoot = bundle.meta.metadata?.projectRoot
      if (this.groupedStorage && this.homeDir && projectRoot) {
        this.groupedStorage.setSessionProjectDir(
          spawnerSessionId,
          projectHomeFor(this.homeDir, projectRoot),
        )
        subagentsDir =
          this.storageCoordinator.getSubAgentsDirForParent(spawnerSessionId)
      }
    }
    if (!subagentsDir) {
      throw new Error('parent session is not routed; write it first')
    }
    await this.writeSessionBundle({
      sessionId: bundle.sessionId,
      entries: bundle.entries,
      meta: bundle.meta,
      toolDetails: bundle.toolDetails,
      projectDir: subagentsDir,
      publish: false,
    })
    await this.storageCoordinator.writeSubAgentTaskFile(
      spawnerSessionId,
      bundle.sessionId,
      SUBAGENT_TASK_FILE_NAME,
      JSON.stringify(bundle.task),
    )
  }

  /**
   * Ids of every session on disk. Grouped layout: one tree scan (the same
   * one the sidebar list uses). Legacy flat layout has no cheap enumeration
   * and yields an empty set — callers needing one id fall back to
   * `hasStoredSession`. Used by the import adapter's "already imported"
   * marking.
   */
  async listStoredSessionIds(): Promise<Set<string>> {
    if (!this.groupedStorage) return new Set()
    return new Set(await this.groupedStorage.listSessions())
  }

  /** Whether a session with this id exists on disk (its `meta.json`). */
  async hasStoredSession(sessionId: string): Promise<boolean> {
    if (this.groupedStorage) {
      return (await this.listStoredSessionIds()).has(sessionId)
    }
    const storage = this.storage
    if (!storage) return false
    return (await storage.readSessionMeta(sessionId)) !== null
  }

  private routeBridgeRequest(
    sessionId: string,
    payload: unknown,
  ): void {
    this.bridgeRouter.routeRequest(sessionId, payload)
  }

  /**
   * Fan `worker.applyRuntimeSettings` to every active session; the engine ignores unknown keys.
   * Per-session failures are logged and swallowed.
   */
  private applyAgentSettingsToAllSessions(
    config: Record<string, unknown>,
  ): void {
    for (const [sessionId, entry] of this.sessions) {
      void entry.worker
        .receiveFrame({
          type: 'worker.applyRuntimeSettings',
          payload: { config },
        })
        .catch(err => {
          console.warn(
            `[SharedWorkerSessionManager] applyAgentSettings to session ${sessionId} failed:`,
            err instanceof Error ? err.message : err,
          )
        })
    }
  }

  /** Fan a `worker.reloadMods` to every session: each slot reloads the
   *  mods whose module text changed (F-25, the `mods.reload` action). */
  private reloadModsOnAllSessions(): void {
    for (const [sessionId, entry] of this.sessions) {
      void entry.worker
        .receiveFrame({ type: 'worker.reloadMods' })
        .catch(err => {
          console.warn(
            `[SharedWorkerSessionManager] reloadMods to session ${sessionId} failed:`,
            err instanceof Error ? err.message : err,
          )
        })
    }
  }

  /** Also the worker host's (`AgentRuntimeWorkerHost`): `$.config.set`. */
  reloadPluginsOnAllSessions(): void {
    // Provider mods are global, not any session's: rescan them here too, so a
    // plugin switched on while no session is loaded still adds its providers.
    void import('../../mods/provider/providerModBoot')
      .then(m => m.reloadProviderMods())
      .catch(err => console.warn('[SharedWorkerSessionManager] provider-mod reload failed:', err instanceof Error ? err.message : err))
    for (const [sessionId, entry] of this.sessions) {
      void entry.worker
        .receiveFrame({ type: 'worker.reloadPlugins' })
        .catch(err => {
          console.warn(
            `[SharedWorkerSessionManager] reloadPlugins to session ${sessionId} failed:`,
            err instanceof Error ? err.message : err,
          )
        })
    }
  }

  private generateBridgeRequestId(): string {
    return `webui-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
  }

  /**
   * Worker-side boot progress for a panel's boot-welcome overlay. The
   * per-session worker's host bridge calls it during a runtime build
   * (`connectingTools`, `restoring`); the hub applies the panel's rules —
   * nothing after the overlay is dismissed, and only the first session to
   * report drives it, so a slower neighbour build cannot walk it backwards.
   */
  broadcastBootStage(stage: string, sessionId: string): void {
    this.runtimeHub.publishBootStage(
      this.panelOfSession.get(sessionId) ?? DEFAULT_PANEL_ID,
      sessionId,
      stage,
    )
  }
}

// ---------- Module-level accessor ----------
//
// `toolkit/run/toolCallTelemetry.ts` and the QueryEngine stream lifecycle hit
// the manager's tool/stream/model marks via this accessor. We avoid
// threading a controller through `ToolUseContext` / `BrowserRuntimeWorker`
// because the manager is a SharedWorker singleton — there's exactly one
// alive at a time. Tests instantiate a manager which replaces the
// previous active reference in the constructor.

let activeSessionManager: SharedWorkerSessionManager | null = null

function setActiveSessionManager(
  manager: SharedWorkerSessionManager | null,
): void {
  activeSessionManager = manager
  // The worker MCP client connects on the runtime's own host port, not a
  // session's scoped view (src/mcp/mcpHost.ts).
  setMcpHostProvider(manager ? () => manager.mcpHostAccess() : null)
}

export function getActiveSessionManager(): SharedWorkerSessionManager | null {
  return activeSessionManager
}
