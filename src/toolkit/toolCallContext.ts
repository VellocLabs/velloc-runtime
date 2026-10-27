/**
 * The context every tool call runs with: the session's options, its state
 * accessors and the per-turn bookkeeping a tool may read or add to.
 *
 * Many imports below are type-only on purpose. Tools import this file, and a
 * value import from here into a module that imports tools (snapshot recorder,
 * fs layer, transports) would close an import cycle.
 */
import type { ToolCallMods } from '../mods/toolCallEvent'
import type { AutoCompactWindowSettings } from '../context/compaction/windowSettings'
import type { DispatchContext } from '../mods/modTypes'
import type { PlatformCapabilities } from '../runtime/interfaces/PlatformCapabilities'
import type {
  AgentProfile,
  WorkingState,
  ReadFileLedger,
  ServerLink,
  Message,
  RuntimeCommandList,
  SDKStatus,
  ReasoningBudget,
  PendingApproval,
  ToolUseConfirmOptions,
  ToolUseConfirmResolution,
} from '../runtime/RuntimeTypes'
import type { AgentLoopState } from '../engine/loop/agentLoopState'
import type { AutocompactFn, ModelCallFn } from '../engine/turn/modelCallTypes'
import type {
  FileSnapshotRecorder,
  SnapshotTurnInfo,
} from '../sessions/fileSnapshots/snapshotRecorder'
import type { RuntimeFs } from '../utils/fs/runtimeFs'
import type { SidechainTranscriptStore } from '../utils/sidechainTranscripts'
import type { ResolvedMemorySettings } from '../memory/memoryPaths'
import type { ToolRunSeams } from './run/toolLifecycleHooks'
import type { RuntimeConfig } from '../runtime/interfaces/RuntimeConfig'
import type { ToolContractList } from './toolContract'

/** The agent definitions a session may dispatch to, and all it knows. */
export type AgentRoster = {
  enabledAgents: AgentProfile[]
  allAgents: AgentProfile[]
}

export type ToolCallContext = {
  options: {
    commands: RuntimeCommandList
    /** The session template ('agent' | 'chat' | 'code'). Limits which
     *  type-restricted bundled skills the model may invoke on its own; the
     *  user's slash commands ignore it. Absent: no restriction. */
    templateType?: string
    /** Skills this session type's allowlist removed. They are already gone
     *  from `commands`; the names are kept only so both dispatch paths can
     *  answer "not available in this session type" rather than "unknown". */
    deniedSkillNames?: readonly string[]
    cwd: string
    /** The session's project root, fixed at boot. Memory and instruction
     *  file paths anchor here rather than at the live working directory. */
    projectRoot: string
    /** The user's home directory as the host resolved it, so background
     *  memory work finds the same memory directory as the main turn. Absent
     *  in tests. */
    homeDir?: string
    /** The provider the session's model resolved to. A teammate spawn
     *  derives the child's isolation from it. */
    userSpecifiedProviderId?: string
    /** For a child session on an untrusted provider: every path a tool
     *  touches must resolve inside this root. Set by the manager from the
     *  provider's trust setting, never by a model. Absent: no boundary. */
    untrustedReadRoot?: string
    /** Team identity, set on a spawned child only: the team it joined, the
     *  name the lead uses for it, and the lead's session. The team tools and
     *  the untrusted-write refusal read them. */
    teamName?: string
    teammateName?: string
    spawnerSessionId?: string
    /** Root of the session-storage tree. Kept outside the read boundary: it
     *  holds every other session's transcript. */
    sessionStoragePath?: string
    /** The directory this session's own folder lives under, as the storage
     *  router set it (nested for teammates and background agents). */
    sessionStorageBase?: string
    /** The memory settings snapshot taken at boot; the toggles can change
     *  live, the directory only for the next session. */
    memorySettings?: ResolvedMemorySettings
    /** This runtime's config object, used as its identity. One worker realm
     *  hosts several runtimes, so per-runtime services look their state up
     *  by this reference instead of a module-level slot. */
    runtimeConfig?: RuntimeConfig
    /** The session's extension hooks for the tool path, present only when a
     *  hooks module is loaded. */
    mods?: Partial<ToolCallMods> & {
      /** For a loop running under the session (sub-agent, teammate): the
       *  agent id its tool-call events carry. */
      agentId?: string
      /** Slash commands the extensions registered, for the help listing.
       *  Absent for a loop under the session. */
      listRegisteredCommands?: () => ReadonlyArray<{
        name: string
        description: string
        argumentHint?: string
        plugin: string
      }>
    }
    sessionId: string
    debug: boolean
    mainLoopProviderId?: string
    mainLoopModel: string
    tools: ToolContractList
    verbose: boolean
    thinkingConfig: ReasoningBudget
    mcpClients: ServerLink[]
    mcpResources: Record<string, unknown[]>
    isNonInteractiveSession: boolean
    agentDefinitions: AgentRoster
    maxBudgetUsd?: number
    customSystemPrompt?: string
    appendSystemPrompt?: string
    querySource?: string
    refreshTools?: () => ToolContractList
    /** This session's model-call function. Side calls (titles, recall, page
     *  extraction, prompt hooks) use it, never a shared slot, so a background
     *  agent's disposed transport cannot leak into a sibling session. Forks
     *  share it through `options`. Absent in tests without a transport. */
    callModel?: ModelCallFn
    /** This session's compaction function, published beside `callModel` so a
     *  forked run compacts through its parent's live transport. Absent where
     *  the runtime has none; the fork then does not compact. */
    autocompact?: AutocompactFn
    /** This session's auto-compact settings reader (switch + windows), the
     *  one its `autocompact` resolves through. Absent without settings. */
    autoCompactWindows?: AutoCompactWindowSettings
    /** This session's filesystem. Tools that must not lose a write to another
     *  runtime's teardown read this first and fall back to the process
     *  filesystem only when it is absent. Forks share it. */
    fsOperations?: RuntimeFs
    /** This session's sidechain transcript store; `null` when the runtime
     *  does not persist. Absent in tests. */
    sidechainStore?: SidechainTranscriptStore | null
    /** Aborts when this session's runtime scope is disposed. Work that
     *  outlives the call that started it (a shell left running) stops here.
     *  Absent in tests. */
    runtimeScopeSignal?: AbortSignal
    /** True while user input typed during the turn is waiting for the next
     *  step boundary. Read-only; the Sleep tool polls it to wake early. Only
     *  the main agent consumes that input, so only it may act on this. */
    hasPendingInjectMessages?: () => boolean
    /** Records file contents before a mutation, for templates that keep file
     *  snapshots; the workspace-diff tool reads from it. Absent: no capture. */
    fileSnapshotRecorder?: FileSnapshotRecorder
  }
  cancelSource: AbortController
  fileReadLedger: ReadFileLedger
  /** Read ranges restored after a compaction; used only for read stubs. */
  postCompactReadFileState?: ReadFileLedger
  platformCapabilities: PlatformCapabilities
  readAppState(): WorkingState
  writeAppState(f: (prev: WorkingState) => WorkingState): void
  answerElicitation?: (...args: unknown[]) => Promise<unknown>
  requestToolUseConfirm?: (
    item: PendingApproval,
    options?: ToolUseConfirmOptions,
  ) => Promise<ToolUseConfirmResolution>
  postNotice?: (...args: unknown[]) => void
  markCallsInFlight: (f: (prev: Set<string>) => Set<string>) => void
  noteReplyLength: (f: (prev: number) => number) => void
  noteFileHistory: (updater: (prev: unknown) => unknown) => void
  noteAttribution: (updater: (prev: unknown) => unknown) => void
  reportHostStatus?: (status: SDKStatus) => void
  messages: Message[]
  /** The spawning session's turn that file snapshots taken in this run belong
   *  to. Set on a forked run's context, whose own messages do not count the
   *  session's turns; absent in the main agent, which derives it from
   *  `messages`. */
  snapshotTurn?: SnapshotTurnInfo
  agentId?: string
  /** An extension's own tool call in flight: which extension raised it, so
   *  checks inside the call can name it. */
  modCallContext?: DispatchContext
  /** Overrides for the tool-run path: the settings-hook executors the call
   *  stages use and the gates nested steps pass. Absent: production ones. */
  toolRunSeams?: ToolRunSeams
  skillsFound?: Set<string>
  /** Paths read during this step. The read tool adds to this shared set; the
   *  turn loop drains it after the tools ran and adds any path-scoped rule
   *  files that match. Absent: nothing is collected. */
  nestedMemoryCues?: Set<string>
  /** Recently read paths, restored after a compaction. */
  recentReadPaths?: Set<string>
  /** Path-scoped rule files already added this session, so a rule is not
   *  added again on every matching read. Cleared on compaction. */
  nestedMemoryPathsSeen?: Set<string>
  /** Instruction files the system prompt already contains; never added again
   *  as path-scoped rules. Not cleared on compaction. */
  promptInstructionPaths?: ReadonlySet<string>
  /** Fork nesting: the chain id and how deep this run is inside it. */
  turnChain?: {
    chainId: string
    depth: number
  }
  /** Per-conversation loop-guard state (repeat detection, stagnation,
   *  failure circuit, final-answer flag, budget warning). Created per engine
   *  run; absent in tests, where the guards do nothing. */
  agentLoopState?: AgentLoopState
}
