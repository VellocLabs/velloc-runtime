import type { ConversationStore } from '../interfaces/ConversationStore'
import { RUNTIME_DIR_NAME } from '../../branding/runtimeDir'
import type { PlatformCapabilities } from '../interfaces/PlatformCapabilities'
import type {
  BuildSystemInitMessageParams,
  SystemInitEmitter,
} from '../interfaces/SystemInitEmitter'
import type {
  FetchSystemPromptPartsParams,
  PromptContextProvider,
} from '../interfaces/PromptContextProvider'
import type { RuntimeConfig } from '../interfaces/RuntimeConfig'
import type {
  ProcessUserInputParams,
  ProcessUserInputResult,
  UserInputPipeline,
} from '../interfaces/UserInputPipeline'
import type {
  WorkingState,
  ReadFileLedger,
  FileStateEntry,
  Message,
  RuntimeCommandList,
  StreamRecord,
} from '../RuntimeTypes'
import type { AgentRoster, ToolCallContext } from '../../toolkit/toolCallContext'
import type { PermissionRuleSet } from '../../toolkit/permissionVerdict'
import type { ToolContractList } from '../../toolkit/toolContract'

function createFallbackUUID(): string {
  return `uuid-${Math.random().toString(16).slice(2)}-${Date.now().toString(16)}`
}

export function createMemoryFileStateCache(): ReadFileLedger {
  return new Map<string, FileStateEntry>()
}

export function createEmptyAppState(): WorkingState {
  return {
    permissionRules: {
      mode: 'default',
      extraWorkspaceRoots: new Map<string, { path: string; source: string }>(),
    },
    attachmentState: {
      sentSkillNames: [],
      discoveredSkillNames: [],
      lastPermissionMode: 'default',
      hasExitedPlanModeInSession: false,
    },
    fastMode: false,
    fileHistory: {},
    attribution: {},
  }
}

export class NoopPromptContextProvider implements PromptContextProvider {
  async gatherSystemPromptSources(
    _params: FetchSystemPromptPartsParams,
  ): Promise<{
    defaultSystemPrompt: string[]
    userContext: Record<string, string>
    systemContext: Record<string, string>
  }> {
    return {
      defaultSystemPrompt: ['You are running inside the chromium-runtime sidecar project.'],
      userContext: {},
      systemContext: {},
    }
  }
}

// eslint-disable-next-line @typescript-eslint/no-unused-vars
export class NoopPlatformCapabilities implements PlatformCapabilities {
  // The C++-side `browser` capability is a runtime-only surface (it
  // requires a real `ToolsAdapter` on the C++ side). Keep it absent in
  // tests; consumers should guard with `?.` per the optional shape on
  // `PlatformCapabilities.browser`.
}

export class MemoryConversationStore implements ConversationStore {
  private readonly messages: Message[] = []

  constructor(
    private readonly sessionId: string = globalThis.crypto?.randomUUID?.() ??
      createFallbackUUID(),
  ) {}

  async saveTranscriptRows(messages: readonly Message[]): Promise<void> {
    this.messages.length = 0
    this.messages.push(...messages)
  }

  async drainWrites(): Promise<void> {}

  getSessionId(): string {
    return this.sessionId
  }

  isEphemeral(): boolean {
    return false
  }

  getRecordedMessages(): readonly Message[] {
    return this.messages
  }

  async saveTerminalState(_reason: string, _timestamp: number): Promise<void> {
    // no-op for in-memory store
  }
}

export class NoopUserInputPipeline implements UserInputPipeline {
  constructor(
    private readonly runtimeConfig: RuntimeConfig,
    private readonly shouldQuery = false,
  ) {}

  async processUserInput(
    params: ProcessUserInputParams,
  ): Promise<ProcessUserInputResult> {
    const content =
      typeof params.input === "string" ? params.input : params.input

    return {
      messages: [
        {
          type: 'user',
          uuid: params.uuid ?? this.runtimeConfig.createUUID(),
          timestamp: this.runtimeConfig.createTimestamp(),
          message: {
            role: 'user',
            content,
          },
          isMeta: params.isMeta ?? false,
        },
      ],
      shouldQuery: this.shouldQuery,
      resultText:
        typeof params.input === 'string'
          ? params.input
          : '[content-block-input]',
    }
  }
}

export class NoopSystemInitEmitter implements SystemInitEmitter {
  async buildSystemInitMessage(
    params: BuildSystemInitMessageParams,
  ): Promise<StreamRecord> {
    return {
      type: 'system',
      subtype: 'init',
      session_id: params.sessionId,
      model: params.model,
      permissionMode: params.permissionMode,
      tools: params.tools.map(tool => tool.name),
      mcpClients: params.mcpClients.map(client => client.name ?? 'unknown'),
      skills: params.skills ?? [],
      uuid: params.sessionId,
    }
  }
}

export class DefaultRuntimeConfig implements RuntimeConfig {
  constructor(private readonly env: Record<string, string> = {}) {}

  getEnv(name: string): string | undefined {
    return this.env[name]
  }

  flagOn(name: string): boolean {
    const value = this.getEnv(name)
    if (!value) return false
    const normalized = value.toLowerCase().trim()
    return normalized === '1' || normalized === 'true' || normalized === 'yes'
  }

  now(): number {
    return Date.now()
  }

  createUUID(): string {
    return globalThis.crypto?.randomUUID?.() ?? createFallbackUUID()
  }

  createTimestamp(): string {
    return new Date(this.now()).toISOString()
  }

  getMaxStructuredOutputRetries(): number {
    const raw = this.getEnv('MAX_STRUCTURED_OUTPUT_RETRIES')
    if (!raw) return 5
    const parsed = Number.parseInt(raw, 10)
    return Number.isFinite(parsed) && parsed > 0 ? parsed : 5
  }
}

export function createNoopToolUseContext(params: {
  tools: ToolContractList
  platformCapabilities: PlatformCapabilities
  appState: WorkingState
  setAppState: (updater: (prev: WorkingState) => WorkingState) => void
  readFileState?: ReadFileLedger
  commands?: RuntimeCommandList
  cwd?: string
  projectRoot?: string
  sessionId?: string
  mainLoopModel?: string
  thinkingConfig?: { type: string; [key: string]: unknown }
  permissionContext?: PermissionRuleSet
  abortController?: AbortController
}): ToolCallContext {
  const agentDefinitions: AgentRoster = {
    enabledAgents: [],
    allAgents: [],
  }
  let currentAppState = params.appState

  const writeAppState = (updater: (prev: WorkingState) => WorkingState) => {
    currentAppState = updater(currentAppState)
    params.setAppState(() => currentAppState)
  }

  return {
    options: {
      commands: params.commands ?? [],
      cwd: params.cwd ?? '/workspace',
      projectRoot:
        params.projectRoot ?? `${params.cwd ?? '/workspace'}/${RUNTIME_DIR_NAME}/${params.sessionId ?? 'noop-session'}/workspace`,
      sessionId: params.sessionId ?? 'noop-session',
      debug: false,
      mainLoopModel: params.mainLoopModel ?? 'browser-test',
      tools: params.tools,
      verbose: false,
      thinkingConfig: params.thinkingConfig ?? { type: 'disabled' },
      mcpClients: [],
      mcpResources: {},
      isNonInteractiveSession: true,
      agentDefinitions,
    },
    cancelSource: params.abortController ?? new AbortController(),
    fileReadLedger: params.readFileState ?? createMemoryFileStateCache(),
    platformCapabilities: params.platformCapabilities,
    readAppState: () => currentAppState,
    writeAppState,
    markCallsInFlight: () => {},
    noteReplyLength: () => {},
    noteFileHistory: previous => previous,
    noteAttribution: previous => previous,
    messages: [],
    skillsFound: new Set<string>(),
  }
}
