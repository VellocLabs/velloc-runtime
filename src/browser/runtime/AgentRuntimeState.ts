import type { ConversationEngine } from '../../engine/conversationEngine'
import type { SidechainTranscriptStore } from '../../utils/sidechainTranscripts'
import type { ChromiumCommandMetadata } from '../../runtime/CommandTypes'
import type { QueryRuntimeDeps } from '../../runtime/interfaces/QueryRuntimeDeps'
import type { ReadFileLedger, FileStateEntry, Message } from '../../runtime/RuntimeTypes'
import type { AgentProfile, WorkingState, ServerLink } from '../../runtime/RuntimeTypes'
import type { PermissionDecider } from '../../toolkit/permissionVerdict'
import type { ToolContractList } from '../../toolkit/toolContract'
import type { ToolCallContext } from '../../toolkit/toolCallContext'
import type { ToolSetName } from '../../toolkit/toolRegistry'
import type { BrowserHostBridge } from '../bridge/BrowserHostBridge'
import type {
  BrowserHostManifest,
} from '../bridge/browserBridgeProtocol'
import type { BrowserRuntimeConfig } from '../../config/BrowserRuntimeConfig'
import type { BrowserPromptContextProvider } from '../../engine/systemPromptSources'
import type { BrowserUserInputPipeline } from '../../input/submitUserInput'
import type { BrowserSystemInitEmitter } from '../init/BrowserSystemInitEmitter'
import type {
  BrowserConversationStore,
  BrowserConversationStorageBackend,
} from '../../sessions/sessionStore'
import type { RuntimeFs } from '../../utils/fs/runtimeFs'
import type { AgentLoopSettings } from '../../config/agentLoopConfig'
import type { FileSnapshotRecorder } from '../../sessions/fileSnapshots/snapshotRecorder'
import type { AutoCompactWindowSettings } from '../../context/compaction/windowSettings'

export type BrowserRuntimeOptions = {
  cwd: string
  /**
   * Optional project-root directory. Defaults to the shared `${cwd}/.velloc/shared-workspace/`
   * (or its per-type subdir), so memory and project instructions accumulate across sessions (F-11).
   */
  projectRoot?: string
  /**
   * Optional session cwd override (a worktree-isolated sub-agent): host file/shell tools run in it
   * while `projectRoot` stays on the repo root. Validated like a memory path; invalid → `cwd === projectRoot`.
   */
  cwdOverride?: string
  /**
   * Resolved user-settings home (`~/.velloc/settings.json` anchor), via
   * `resolveSettingsHomeDir`. Distinct from `cwd`/`projectRoot` (which point
   * at the workspace). Stored so worker-side settings writes (permission
   * "Always allow", agent-model mirror) target the real home instead of the
   * workspace. Falls back to `cwd` when the home can't be resolved.
   */
  settingsHomeDir?: string
  sessionId?: string
  /**
   * `sessionId` was RESTORED from a pointer that outlived the document that
   * wrote it, so it may name a session that no longer exists. Forwarded to
   * `BrowserConversationStore`, which then refuses to CREATE the session from
   * a metadata-only write. See
   * `AgentRuntimeWorkerInitPayload.restoredSessionId`.
   */
  restoredSessionId?: boolean
  hostMode?: 'browser' | 'nexus'
  env?: Record<string, string>
  runtimeName?: string
  locale?: string
  timezone?: string
  userAgent?: string
  customSystemPrompt?: string
  appendSystemPrompt?: string
  /** Per-session agent-template type (e.g. 'chat'); defaults to 'chat'. */
  templateType?: string
  /** 'local' ⇒ lazy-load this type from the local `.velloc/template/` folder
   *  (host-gated via `?template=local`); else bundled only. */
  templateSource?: 'local'
  userSpecifiedProviderId?: string
  userSpecifiedModel?: string
  /** Teammate identity, forwarded to the tool context (see `toolkit/toolContract.ts`). */
  teamName?: string
  teammateName?: string
  spawnerSessionId?: string
  /**
   * Reasoning-effort / extended-thinking tier attached to the current
   * model selection. Kept on options so that the engine config can be
   * rebuilt (e.g. on restart) with the same tier the user last picked.
   */
  userSpecifiedThinkingTier?: string
  fallbackModel?: string
  maxTurns?: number
  isSubAgent?: boolean
  maxBudgetUsd?: number
  taskBudget?: { total: number }
  /**
   * Per-engine override for the agent loop tunables (mirrors
   * `AgentRuntimeWorkerInitPayload.agentLoopSettings`). Forwarded to
   * `QueryEngine` via `mergeAgentLoopSettings`. Used by tests to
   * lower mechanism #3 thresholds; production callers leave undefined.
   */
  agentLoopSettings?: Partial<AgentLoopSettings>
  toolPreset?: ToolSetName
  hostManifest?: BrowserHostManifest
  commands?: ChromiumCommandMetadata[]
  mcpClients?: ServerLink[]
  agents?: AgentProfile[]
  /**
   * Names of local plugins to enable. A plugin directory under
   * `~/.velloc/plugins/<name>/` or `<cwd>/.velloc/plugins/<name>/` whose name
   * is in this list has its skills, slash commands, hooks, MCP servers, and
   * custom agents wired in. When omitted, falls back to the comma-separated
   * `NEXUS_ENABLED_PLUGINS` env var; when neither is set, no plugins load.
   */
  enabledPlugins?: string[]
  canUseTool?: PermissionDecider
  requestToolUseConfirm?: ToolCallContext['requestToolUseConfirm']
  queryRuntimeDeps?: QueryRuntimeDeps
  conversationStorageBackend?: BrowserConversationStorageBackend
  fsImplementation?: RuntimeFs
  /**
   * Per-project session-storage base dir; the file-snapshot store uses `<sessionStoragePath>/<sessionId>/`
   * beside the transcript. Absent ⇒ no snapshot store.
   */
  sessionStoragePath?: string
}

export type BrowserRuntimeCoreState = {
  options: BrowserRuntimeOptions
  /**
   * True when a `code` session fell back to the shared sandbox workspace
   * because it had no valid `projectRoot` override — i.e. it is not bound to a
   * real project folder. Surfaced (AND-ed with host folder-picker capability)
   * as the snapshot's `needsProjectFolder`, which drives the forced
   * project-folder modal. Always `false` for `agent`/`chat` and for bound
   * `code` sessions. See `createBrowserRuntime` / `projectRootIsSandbox`.
   */
  usedSandboxProjectRoot: boolean
  /** The user's auto-compact switch and windows; see
   *  context/compaction/windowSettings.ts. */
  autoCompactWindows: AutoCompactWindowSettings
  runtimeConfig: BrowserRuntimeConfig
  hostBridge: BrowserHostBridge
  conversationStore: BrowserConversationStore
  /**
   * The process-global singletons THIS runtime installed (fs + sidechain
   * store; the conversation store above is the third). Exposed so the
   * per-session worker can report its OWN globals to the Manager
   * (`getRuntimeGlobals`) instead of the Manager re-reading the shared
   * global slot on `worker.ready` — which a concurrent sibling runtime
   * build may already have clobbered.
   */
  installedFs: RuntimeFs
  installedSidechainStore: SidechainTranscriptStore | null
  promptContextProvider: BrowserPromptContextProvider
  userInputPipeline: BrowserUserInputPipeline
  systemInitEmitter: BrowserSystemInitEmitter
  queryRuntimeDeps: QueryRuntimeDeps
  tools: ToolContractList
  readFileCache: ReadFileLedger
  initialMessages: Message[]
  getAppState: () => WorkingState
  setAppState: (updater: (prev: WorkingState) => WorkingState) => void
  /**
   * THIS session's file-snapshot recorder (`fileSnapshots: true` templates —
   * SafeCode), or undefined. On the runtime state so the worker can drive
   * the turn lifecycle (`finalizeOpenTurns` at turn end,
   * `recoverUnfinalized` on install); tools reach the same instance via
   * `ToolUseContext.options.fileSnapshotRecorder`.
   */
  fileSnapshotRecorder?: FileSnapshotRecorder
}

export type BrowserRuntimeState = BrowserRuntimeCoreState & {
  engine: ConversationEngine
}

export function createInitialBrowserAppState(): WorkingState {
  return {
    permissionRules: {
      mode: 'default',
      extraWorkspaceRoots: new Map<string, { path: string; source: string }>(),
      allowRuleBook: {},
      denyRuleBook: {},
      askRuleBook: {},
    },
    // Empty sparse map — `isFeatureEnabled(id, appState)` falls back to
    // the feature's registry `default` when the key is absent. The
    // SharedWorker seeds this from `<projectRoot>/.velloc/settings.json`
    // at boot via `readUserLayer`.
    enabledFeatures: {},
    fastMode: false,
    fileHistory: {},
    attribution: {},
    attachmentState: {
      sentSkillNames: [],
      discoveredSkillNames: [],
      lastPermissionMode: 'default',
      hasExitedPlanModeInSession: false,
    },
  }
}

export function createBrowserReadFileCache(): ReadFileLedger {
  return new Map<string, FileStateEntry>()
}

// --- Compat aliases (PR 1A: AgentRuntime naming migration) ---

/** @deprecated Use AgentRuntimeState. */
export type { BrowserRuntimeState as AgentRuntimeState }
/** @deprecated Use AgentRuntimeOptions. */
export type { BrowserRuntimeOptions as AgentRuntimeOptions }
/** @deprecated Use AgentRuntimeCoreState. */
export type { BrowserRuntimeCoreState as AgentRuntimeCoreState }
