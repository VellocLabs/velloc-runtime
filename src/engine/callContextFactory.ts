/**
 * Builds the call context a turn (or an extension's own call) hands to the
 * tools: the session's options, its live state holders and inert defaults
 * for the reporting hooks a turn does not use.
 */
import type { ReadFileLedger } from '../runtime/RuntimeTypes'
import type { ToolCallContext } from '../toolkit/toolCallContext'
import type { AgentLoopState } from './loop/agentLoopState'
import type { ConversationEngineConfig } from './engineConfig'
import { getSessionId as storeSessionId } from '../sessions/sessionStore'

/** The engine-lived holders a context shares with every other context of
 *  the same session. */
export type SharedHolders = {
  readonly agentLoopState: AgentLoopState
  readonly nestedMemoryPathsSeen: Set<string>
  readonly promptInstructionPaths: ReadonlySet<string>
  readonly postCompactReads: ReadFileLedger
}

function optionsFor(config: ConversationEngineConfig, model: string): ToolCallContext['options'] {
  return {
    commands: config.commands,
    templateType: config.templateType,
    deniedSkillNames: config.deniedSkillNames,
    cwd: config.cwd,
    projectRoot: config.projectRoot,
    homeDir: config.homeDir,
    userSpecifiedProviderId: config.userSpecifiedProviderId,
    untrustedReadRoot: config.untrustedReadRoot,
    teamName: config.teamName,
    teammateName: config.peerName,
    spawnerSessionId: config.spawnerSessionId,
    sessionStoragePath: config.sessionStoragePath,
    sessionStorageBase: config.sessionStorageBase,
    memorySettings: config.memorySettings,
    // Background services look this runtime up by it, so they never reach a
    // sibling runtime sharing the realm.
    runtimeConfig: config.runtimeConfig,
    mods: config.mods,
    sessionId: storeSessionId(config.conversationStore),
    debug: false,
    mainLoopProviderId: config.userSpecifiedProviderId,
    mainLoopModel: model,
    tools: config.tools,
    verbose: config.verbose ?? false,
    thinkingConfig: config.reasoningSettings ?? { type: 'disabled' },
    mcpClients: config.mcpClients,
    mcpResources: {},
    isNonInteractiveSession: true,
    agentDefinitions: { enabledAgents: config.agents, allAgents: config.agents },
    maxBudgetUsd: config.spendCapUsd,
    customSystemPrompt: config.promptOverride,
    appendSystemPrompt: config.promptSuffix,
    // The session's own model transport and summarizer. Both are bound to
    // this runtime's scope, so they travel with its context and never through
    // a slot another runtime could overwrite.
    callModel: config.queryRuntimeDeps?.callModel,
    autocompact: config.queryRuntimeDeps?.autocompact,
    autoCompactWindows: config.queryRuntimeDeps?.autoCompactWindows,
    fileSnapshotRecorder: config.fileSnapshotRecorder,
    fsOperations: config.fsOperations,
    sidechainStore: config.sidechainStore,
    runtimeScopeSignal: config.runtimeScopeSignal,
    hasPendingInjectMessages: config.hasPendingInjectMessages,
  }
}

export function buildCallContext(
  config: ConversationEngineConfig,
  model: string,
  cancelSource: AbortController,
  holders: SharedHolders,
): ToolCallContext {
  return {
    options: optionsFor(config, model),
    cancelSource,
    fileReadLedger: config.fileReadSeed,
    postCompactReadFileState: holders.postCompactReads,
    platformCapabilities: config.platformCapabilities,
    readAppState: config.readAppState,
    writeAppState: config.writeAppState,
    answerElicitation: config.answerElicitation,
    requestToolUseConfirm: config.requestToolUseConfirm,
    markCallsInFlight: () => {},
    noteReplyLength: () => {},
    noteFileHistory: () => {},
    noteAttribution: () => {},
    reportHostStatus: config.reportHostStatus,
    messages: config.seedTranscript ? [...config.seedTranscript] : [],
    skillsFound: new Set<string>(config.readAppState().attachmentState?.discoveredSkillNames ?? []),
    // Files read during one step, drained after the tools ran to bring in
    // the rules that match them. Fresh for every context.
    nestedMemoryCues: new Set<string>(),
    recentReadPaths: config.recentReadPaths,
    // Rule files already brought in this session; emptied on compaction.
    nestedMemoryPathsSeen: holders.nestedMemoryPathsSeen,
    // Instruction files the system prompt already carries.
    promptInstructionPaths: holders.promptInstructionPaths,
    agentLoopState: holders.agentLoopState,
  }
}
