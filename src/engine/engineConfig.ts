/**
 * What a conversation engine is built from, and the small option shapes its
 * public calls take. Types only, plus the step ceiling a main session runs
 * under.
 */
import type { ConversationStore } from '../runtime/interfaces/ConversationStore'
import type { PluginInitSummary, SystemInitEmitter } from '../runtime/interfaces/SystemInitEmitter'
import type { PromptContextProvider } from '../runtime/interfaces/PromptContextProvider'
import type { QueryRuntimeDeps } from '../runtime/interfaces/QueryRuntimeDeps'
import type { RuntimeConfig } from '../runtime/interfaces/RuntimeConfig'
import type { FileSnapshotRecorder } from '../sessions/fileSnapshots/snapshotRecorder'
import type { RuntimeFs } from '../utils/fs/runtimeFs'
import type { SidechainTranscriptStore } from '../utils/sidechainTranscripts'
import type { PlatformCapabilities } from '../runtime/interfaces/PlatformCapabilities'
import type { UserInputPipeline } from '../runtime/interfaces/UserInputPipeline'
import type {
  AgentProfile,
  WorkingState,
  ReadFileLedger,
  JsonSchema,
  ServerLink,
  Message,
  StrayApproval,
  RuntimeCommandList,
  SDKStatus,
  ReasoningBudget,
  UserRow,
} from '../runtime/RuntimeTypes'
import type { PermissionDecider } from '../toolkit/permissionVerdict'
import type { ToolCallContext } from '../toolkit/toolCallContext'
import type { ToolContractList } from '../toolkit/toolContract'
import type { ResolvedMemorySettings } from '../memory/memoryPaths'
import type { TurnExtensions } from './extensionSeam'
import type { PluginPromptTurn } from '../mods/promptNouns'
import type { AgentLoopSettings } from '../config/agentLoopConfig'
import type { TitleServices } from './autoTitle'

/** The step ceiling of a main (user-facing) session: high enough never to
 *  be reached in practice. Sub-agents keep the ceiling they were given. */
export const MAIN_SESSION_STEP_CEILING = 10000

/** The extension-runtime calls the engine makes. Every one but `ready` and
 *  `promptSubmit` is optional: a host wires only what it supports. */
export type EngineExtensions = Pick<TurnExtensions, 'ready' | 'promptSubmit'> &
  Partial<
    Pick<
      TurnExtensions,
      | 'hasToolCallHooks'
      | 'toolCall'
      | 'hasTurnStepHooks'
      | 'turnStep'
      | 'hasTurnRequestHooks'
      | 'turnRequest'
      | 'hasTurnRecoverHooks'
      | 'turnRecover'
      | 'hasTurnContinueHooks'
      | 'turnContinue'
      | 'hasIdsNextHooks'
      | 'idsNext'
      | 'hasToolCheckHooks'
      | 'toolCheck'
      | 'whileAskingPerson'
      | 'report'
      | 'turnStart'
      | 'turnComplete'
      | 'sessionMeasure'
      | 'afterTurn'
      | 'hasPromptHooks'
      | 'promptSections'
      | 'promptCompose'
      | 'promptContext'
      | 'hasSessionAppendHooks'
      | 'sessionAppend'
      | 'appendNote'
      | 'sessionCompact'
      | 'hasSessionReceiveHooks'
      | 'sessionReceive'
      | 'hasCommandDescribeHooks'
      | 'commandDescriptions'
      | 'sessionEnd'
      | 'commandRun'
      | 'hasCommandRunHooks'
      | 'registeredCommand'
      | 'isImmediateCommand'
      | 'commandRunImmediate'
      | 'listRegisteredCommands'
      | 'reload'
    >
  > & {
    /** Present when the loop runs under a parent session's slot. */
    agentId?: string
  }

/** What a plugin reload hands back: the sets the engine swaps in. */
export type ReloadedPluginSet = {
  commands: RuntimeCommandList
  /** Skill names the session type's allow-list now denies. Absent: none. */
  deniedSkillNames?: readonly string[]
  agents: AgentProfile[]
  plugins: PluginInitSummary[]
}

export type ConversationEngineConfig = {
  cwd: string
  /** The session's project directory. Memory and instruction files are
   *  anchored here, and it does not move for the life of the engine. */
  projectRoot: string
  /** The user's home directory as the host resolved it (the worker has no
   *  environment to read it from). */
  homeDir?: string
  /** The memory settings in force. The on/off switches can change while the
   *  session runs (`applyMemorySettings`); the directory cannot. */
  memorySettings?: ResolvedMemorySettings
  tools: ToolContractList
  commands: RuntimeCommandList
  mcpClients: ServerLink[]
  agents: AgentProfile[]
  /** Loaded plugins, listed in the session-init row. */
  plugins?: PluginInitSummary[]
  /** Re-runs plugin discovery for the given allow-list (none: read it again
   *  from disk). Resolves null when discovery failed. */
  onReloadPlugins?: (activePluginSet?: string[]) => Promise<ReloadedPluginSet | null>
  /** Opens a section of the host's settings page. May reject on hosts that
   *  have no settings page. */
  onOpenSettings?: (section: string) => void | Promise<void>
  /** The session's extension runtime, when an enabled plugin carries one. */
  mods?: EngineExtensions
  decidePermission: PermissionDecider
  readAppState: () => WorkingState
  writeAppState: (f: (prev: WorkingState) => WorkingState) => void
  seedTranscript?: Message[]
  fileReadSeed: ReadFileLedger
  recentReadPaths?: Set<string>
  promptOverride?: string
  promptSuffix?: string
  /** The session type, which picks the prompt skeleton and tool set. */
  templateType?: string
  /** Skills this session type withholds, so a call to one reads "denied
   *  here" rather than "unknown". */
  deniedSkillNames?: readonly string[]
  userSpecifiedProviderId?: string
  /** The read boundary of a child running on an untrusted provider. */
  untrustedReadRoot?: string
  teamName?: string
  peerName?: string
  spawnerSessionId?: string
  sessionStoragePath?: string
  sessionStorageBase?: string
  pickedModel?: string
  /** The reasoning tier picked for the model; read at every request. */
  userSpecifiedThinkingTier?: string
  /** Selects the shorter prompt variant; read at every turn. */
  flashMode?: boolean
  backupModel?: string
  reasoningSettings?: ReasoningBudget
  maxTurns?: number
  spendCapUsd?: number
  taskBudget?: { total: number }
  jsonSchema?: JsonSchema
  verbose?: boolean
  echoUserRows?: boolean
  answerElicitation?: ToolCallContext['answerElicitation']
  requestToolUseConfirm?: ToolCallContext['requestToolUseConfirm']
  streamPartialRows?: boolean
  reportHostStatus?: (status: SDKStatus) => void
  cancelSource?: AbortController
  strandedAsk?: StrayApproval
  platformCapabilities: PlatformCapabilities
  queryRuntimeDeps?: QueryRuntimeDeps
  /** Agent-loop tunables; defaults apply to anything left out. */
  agentLoopSettings?: Partial<AgentLoopSettings>
  snipReplay?: (
    yieldedSystemMsg: Message,
    store: Message[],
  ) => { messages: Message[]; executed: boolean } | undefined
  promptContextProvider: PromptContextProvider
  conversationStore: ConversationStore
  userInputPipeline: UserInputPipeline
  systemInitEmitter: SystemInitEmitter
  runtimeConfig: RuntimeConfig
  isSubAgent?: boolean
  /** This session's file-snapshot recorder, for types that keep snapshots. */
  fileSnapshotRecorder?: FileSnapshotRecorder
  /** This session's own file system; never a sibling runtime's. */
  fsOperations?: RuntimeFs
  /** This session's side-transcript store (null: nothing is stored). */
  sidechainStore?: SidechainTranscriptStore | null
  /** Aborts when the owning runtime scope goes away. */
  runtimeScopeSignal?: AbortSignal
  /** Whether user input is parked for the running turn. */
  hasPendingInjectMessages?: () => boolean
  /** Replaces the services the session-title writer uses (tests). */
  titleServices?: Partial<TitleServices>
}

/** Options of one `submitTurn`. */
export type SubmitTurnOptions = {
  uuid?: string
  isMeta?: boolean
  origin?: UserRow['origin']
  /** A turn delivered from the worker's own queue: a team message or a
   *  background task's notice. Never set from a client payload. */
  delivery?: 'peer' | 'task-notification'
  /** A turn a plugin submitted; its text already passed the submit hooks. */
  plugin?: PluginPromptTurn
}

/** The provider, model and reasoning tier a session runs on. A selection
 *  without a tier clears the stored one. */
export type ModelSelection = {
  providerId?: string
  model: string
  thinkingTier?: string
}
