
import type { PermissionDecider } from '../toolkit/permissionVerdict'
import type { ToolCallContext } from '../toolkit/toolCallContext'
import type { RuntimeConfig } from '../runtime/interfaces/RuntimeConfig'
import { runTurnLoop } from '../engine/turnInterpreter'
import {
  getBlockingLimitTokens,
  isContextWindowKnown,
  type TierModelCandidate,
} from '../engine/contextWindow'
import { recordPinCandidateFailure } from '../models/pinFailureLog'
import { estimateTranscriptTokens } from '../engine/tokenCounts'
import type {
  ReadFileLedger,
  Message,
  InstructionText,
} from '../runtime/RuntimeTypes'
import type { TurnOrigin } from '../runtime/interfaces/QueryRuntimeDeps'
import {
  notifyForkFinished,
  notifyForkProgress,
  notifyForkStarted,
} from '../backgroundTasks/sideTaskSink'
import { serializeSystemPromptForDisplay } from '../utils/systemPromptDisplay'
import { snapshotTurnForCall } from '../utils/turnDiffs'
import { runSubagentStartHooks } from '../lifecycleHooks/sessionLifecycleHooks'
import {
  createSidechainAgentId,
  type SidechainEntry,
  type SidechainMetadata,
  type SidechainTranscriptStore,
} from '../utils/sidechainTranscripts'

// The pieces of the parent's request a fork reuses unchanged, so the fork's
// prompt prefix matches the parent's and can hit the provider's prompt cache.
export type ForkPrefixSnapshot = {
  systemPrompt: InstructionText
  userContext: Record<string, string>
  systemContext: Record<string, string>
  toolUseContext: ToolCallContext
  forkSeedRows: Message[]
  providerId?: string
  thinkingTier?: string
  renderSystemPromptForModel?: (selection: {
    providerId?: string
    modelId: string
  }) => Promise<InstructionText>
}

export function captureForkPrefix(input: {
  systemPrompt: InstructionText
  userContext: Record<string, string>
  systemContext: Record<string, string>
  toolUseContext: ToolCallContext
  messages: Message[]
  providerId?: string
  thinkingTier?: string
  renderSystemPromptForModel?: ForkPrefixSnapshot['renderSystemPromptForModel']
}): ForkPrefixSnapshot {
  return {
    systemPrompt: input.systemPrompt,
    userContext: input.userContext,
    systemContext: input.systemContext,
    toolUseContext: input.toolUseContext,
    forkSeedRows: input.messages,
    providerId: input.providerId,
    thinkingTier: input.thinkingTier,
    renderSystemPromptForModel: input.renderSystemPromptForModel,
  }
}

// Latest parent snapshot, kept per runtime when one is given, else in a
// single process-wide slot.
const cacheSafeParamsByRuntime = new WeakMap<RuntimeConfig, ForkPrefixSnapshot>()
let latestForkPrefix: ForkPrefixSnapshot | null = null

export function rememberForkPrefix(
  params: ForkPrefixSnapshot | null,
  runtimeConfig?: RuntimeConfig,
): void {
  if (runtimeConfig) {
    if (params) {
      cacheSafeParamsByRuntime.set(runtimeConfig, params)
    } else {
      cacheSafeParamsByRuntime.delete(runtimeConfig)
    }
    return
  }
  latestForkPrefix = params
}

export function recallForkPrefix(
  runtimeConfig?: RuntimeConfig,
): ForkPrefixSnapshot | null {
  if (runtimeConfig) {
    return cacheSafeParamsByRuntime.get(runtimeConfig) ?? null
  }
  return latestForkPrefix
}

export function cloneReadFileState(parent: ReadFileLedger): ReadFileLedger {
  return new Map(parent)
}

// A controller that aborts with its parent but can be aborted on its own.
function linkedAbortController(parent: AbortController): AbortController {
  const child = new AbortController()
  if (parent.signal.aborted) {
    child.abort(parent.signal.reason)
  } else {
    parent.signal.addEventListener(
      'abort',
      () => child.abort(parent.signal.reason),
      { once: true },
    )
  }
  return child
}

export type ChildContextOptions = {
  options?: ToolCallContext['options']
  agentId?: ToolCallContext['agentId']
  messages?: Message[]
  readFileState?: ToolCallContext['fileReadLedger']
  abortController?: AbortController
  getAppState?: ToolCallContext['readAppState']
  inheritStateWriter?: boolean
  inheritLengthMeter?: boolean
  inheritAbort?: boolean
}

const SUBAGENT_START_QUERY_SOURCES: ReadonlySet<string> = new Set(['agent_tool', 'skill_fork'])

// Builds a child tool context from the parent's. By default the child gets
// its own abort controller, file-read cache copy and state setters; the
// `share*` overrides opt back into the parent's.
export function deriveChildToolContext(
  outerToolContext: ToolCallContext,
  overrides: ChildContextOptions = {},
): ToolCallContext {
  const cancelSource =
    overrides.abortController ??
    (overrides.inheritAbort
      ? outerToolContext.cancelSource
      : linkedAbortController(outerToolContext.cancelSource))

  const readAppState = overrides.getAppState ?? outerToolContext.readAppState

  return {
    options: overrides.options ?? outerToolContext.options,

    cancelSource,

    fileReadLedger: cloneReadFileState(
      overrides.readFileState ?? outerToolContext.fileReadLedger,
    ),

    postCompactReadFileState: new Map(),

    platformCapabilities: outerToolContext.platformCapabilities,

    readAppState,

    writeAppState: overrides.inheritStateWriter
      ? outerToolContext.writeAppState
      : () => {},

    answerElicitation: outerToolContext.answerElicitation,

    postNotice: undefined,
    reportHostStatus: undefined,

    markCallsInFlight: () => {},

    noteReplyLength: overrides.inheritLengthMeter
      ? outerToolContext.noteReplyLength
      : () => {},

    noteFileHistory: () => {},
    noteAttribution: () => {},

    messages: overrides.messages ?? outerToolContext.messages,

    // File snapshots of the child's writes land on the turn that spawned it.
    snapshotTurn: snapshotTurnForCall(outerToolContext),

    agentId: overrides.agentId ?? createSidechainAgentId('subagent'),

    skillsFound: new Set<string>(),

    turnChain: {
      chainId:
        outerToolContext.turnChain?.chainId ??
        `fork-${Date.now().toString(36)}-${Math.random()
          .toString(36)
          .slice(2, 8)}`,
      depth: (outerToolContext.turnChain?.depth ?? -1) + 1,
    },

    agentLoopState: undefined,
  }
}

export type ForkRunRequest = {
  openingRows: Message[]

  forkPrefix: ForkPrefixSnapshot

  canUseTool: PermissionDecider

  querySource: TurnOrigin

  forkLabel: string

  agentType?: string
  description?: string

  overrides?: ChildContextOptions

  maxOutputTokens?: number

  maxTurns?: number

  skipCacheWrite?: boolean

  onMessage?: (message: Message) => void

  sidechainStore?: SidechainTranscriptStore

  spawnerSessionId?: string

  agentId?: string

  offRecord?: boolean

  systemPromptOverride?: InstructionText

  omitParentContext?: boolean

  useRealModelTransport?: boolean

  modelLadder?: TierModelCandidate[]
}

export type ForkRunOutcome = {
  messages: Message[]
  agentId: string
}

// Runs a side agent seeded with the parent's context (unless
// `omitParentContext`), optionally on a different model, and returns the
// messages it produced.
export async function launchFork(
  params: ForkRunRequest,
): Promise<ForkRunOutcome> {
  const {
    openingRows,
    forkPrefix,
    canUseTool,
    querySource,
    forkLabel,
    agentType,
    description,
    overrides,
    maxOutputTokens,
    maxTurns,
    skipCacheWrite,
    onMessage,
    sidechainStore,
    spawnerSessionId,
    offRecord,
    useRealModelTransport,
    omitParentContext,
  } = params

  const {
    systemPrompt,
    userContext,
    systemContext,
    toolUseContext,
    forkSeedRows: forkContextMessages,
  } = forkPrefix

  // A model differing from the parent's is used only when the seeded
  // conversation fits its window; otherwise the run stays on the parent's.
  const initialMessages: Message[] = omitParentContext
    ? [...openingRows]
    : [...forkContextMessages, ...openingRows]

  const parentCandidate: TierModelCandidate = {
    providerId:
      forkPrefix.providerId
      ?? toolUseContext.options.mainLoopProviderId
      ?? '',
    modelId: toolUseContext.options.mainLoopModel,
  }
  const differsFromParent = (c: TierModelCandidate): boolean =>
    c.modelId !== parentCandidate.modelId ||
    c.providerId !== parentCandidate.providerId
  let override: TierModelCandidate | undefined =
    params.modelLadder?.[0] && differsFromParent(params.modelLadder[0])
      ? params.modelLadder[0]
      : undefined
  let fallbackCandidate: TierModelCandidate | undefined =
    override ? params.modelLadder?.[1] : undefined
  let modelSource: string | undefined = params.modelLadder
    ? override
      ? 'session-model-policy'
      : 'inherit'
    : undefined

  if (
    override
    && !omitParentContext
    && isContextWindowKnown(override.modelId, override.providerId)
  ) {
    const seedTokens = estimateTranscriptTokens(initialMessages)
    const limit = getBlockingLimitTokens(override.modelId, override.providerId)
    if (seedTokens >= limit) {
      console.info(
        '[forkedAgent] %s: resolved model %s/%s window cannot fit the inherited context (~%d tokens >= limit %d); falling back to the parent model %s/%s',
        forkLabel,
        override.providerId,
        override.modelId,
        seedTokens,
        limit,
        parentCandidate.providerId,
        parentCandidate.modelId,
      )
      override = undefined
      fallbackCandidate = undefined
      modelSource = 'window-fallback'
    }
  }

  const effectiveOverrides = override
    ? {
        ...(overrides ?? {}),
        options: {
          ...(overrides?.options ?? toolUseContext.options),
          mainLoopModel: override.modelId,
          mainLoopProviderId: override.providerId,
        },
      }
    : overrides

  const effectiveProviderId = override
    ? override.providerId
    : (forkPrefix.providerId ?? toolUseContext.options.mainLoopProviderId)
  const sameModelThinkingTier =
    params.modelLadder?.[0] && !differsFromParent(params.modelLadder[0])
      ? params.modelLadder[0].thinkingTier
      : undefined
  const effectiveThinkingTier = override
    ? override.thinkingTier
    : (sameModelThinkingTier ?? forkPrefix.thinkingTier)

  const parentSystemPrompt = params.systemPromptOverride ?? systemPrompt
  const forkSystemPrompt =
    params.systemPromptOverride === undefined
    && override
    && forkPrefix.renderSystemPromptForModel
      ? await forkPrefix.renderSystemPromptForModel({
          providerId: override.providerId,
          modelId: override.modelId,
        })
      : parentSystemPrompt

  const agentId =
    params.agentId ?? overrides?.agentId ?? createSidechainAgentId(forkLabel)

  const isolatedToolUseContext = deriveChildToolContext(toolUseContext, {
    ...(effectiveOverrides ?? {}),
    agentId,
  })

  notifyForkStarted({
    agentId,
    spawnerSessionId,
    querySource,
    forkLabel,
    agentType,
    description,
    model: isolatedToolUseContext.options.mainLoopModel,
    prompt: extractPromptText(openingRows),
    systemPrompt: serializeSystemPromptForDisplay(forkSystemPrompt),
    startedAt: Date.now(),
    abort: () => isolatedToolUseContext.cancelSource.abort(),
  })

  const shouldRecord =
    sidechainStore !== undefined &&
    spawnerSessionId !== undefined &&
    offRecord !== true

  const recordEntry = async (entry: SidechainEntry): Promise<void> => {
    if (!shouldRecord || !sidechainStore || !spawnerSessionId) return
    try {
      await sidechainStore.append(spawnerSessionId, agentId, entry)
    } catch {
    }
  }

  const outputMessages: Message[] = []

  try {
    if (shouldRecord) {
      const parentTail = forkContextMessages[forkContextMessages.length - 1] as
        | (Message & { uuid?: string })
        | undefined
      const metadata: SidechainMetadata = {
        type: '__sidechain_meta',
        agentId,
        spawnerSessionId: spawnerSessionId!,
        forkLabel,
        startedAt: Date.now(),
        model: isolatedToolUseContext.options.mainLoopModel,
        parentUuid: parentTail?.uuid,
        agentType,
        description,
        modelSource,
      }
      await recordEntry(metadata)
      for (const promptMessage of openingRows) {
        await recordEntry(promptMessage)
      }
    }

    if (SUBAGENT_START_QUERY_SOURCES.has(querySource)) {
      const startRows = await runSubagentStartHooks(agentId, agentType, toolUseContext)
      for (const row of startRows) {
        initialMessages.push(row)
        await recordEntry(row)
      }
    }

    const driveOnce = async (
      providerIdArg: string | undefined,
      thinkingTierArg: string | undefined,
      systemPromptArg: InstructionText,
    ): Promise<Message[]> => {
      const collected: Message[] = []
      for await (const message of runTurnLoop({
        messages: initialMessages,
        baseInstructions: systemPromptArg,
        userAmbient: userContext,
        systemAmbient: systemContext,
        decidePermission: canUseTool,
        callContext: isolatedToolUseContext,
        ...(providerIdArg ? { providerId: providerIdArg } : {}),
        ...(thinkingTierArg ? { thinkingTier: thinkingTierArg } : {}),
        turnCaller: querySource,
        outputTokenCapOverride: maxOutputTokens,
        stepLimit: maxTurns,
        noCacheWrite: skipCacheWrite,
        useRememberedCallModel: useRealModelTransport,
      })) {
        if (
          message.type === 'stream_event' ||
          message.type === 'stream_request_start'
        ) {
          continue
        }

        const persisted = message as Message
        collected.push(persisted)
        outputMessages.push(persisted)
        notifyForkProgress(agentId, persisted)
        onMessage?.(persisted)
        await recordEntry(persisted)
      }
      return collected
    }

    const outputMark = outputMessages.length
    let firstError: unknown = null
    let firstCollected: Message[] | null = null
    try {
      firstCollected = await driveOnce(
        effectiveProviderId,
        effectiveThinkingTier,
        forkSystemPrompt,
      )
    } catch (error) {
      firstError = error
    }
    const firstAttemptFailed = (): boolean => {
      if (firstError !== null) return true
      const assistants = (firstCollected ?? []).filter(
        m => m.type === 'assistant',
      )
      return (
        assistants.length > 0 &&
        assistants.every(
          m =>
            (m as { isApiErrorMessage?: boolean }).isApiErrorMessage === true,
        )
      )
    }
    if (
      fallbackCandidate
      && !isolatedToolUseContext.cancelSource.signal.aborted
      && firstAttemptFailed()
    ) {
      const fb = fallbackCandidate
      if (override) {
        recordPinCandidateFailure(
          override,
          firstError instanceof Error
            ? firstError.message
            : firstError !== null
              ? String(firstError)
              : 'model returned only API errors',
        )
      }
      console.info(
        '[forkedAgent] %s: model %s/%s failed%s; retrying once on the parent model %s/%s',
        forkLabel,
        effectiveProviderId,
        isolatedToolUseContext.options.mainLoopModel,
        firstError instanceof Error ? ` (${firstError.message})` : '',
        fb.providerId,
        fb.modelId,
      )
      isolatedToolUseContext.options.mainLoopModel = fb.modelId
      isolatedToolUseContext.options.mainLoopProviderId = fb.providerId
      outputMessages.length = outputMark
      await driveOnce(fb.providerId, forkPrefix.thinkingTier, parentSystemPrompt)
    } else if (firstError !== null) {
      throw firstError
    }
  } catch (error) {
    notifyForkFinished({
      agentId,
      status: isolatedToolUseContext.cancelSource.signal.aborted
        ? 'stopped'
        : 'error',
      finishedAt: Date.now(),
      errorMessage: error instanceof Error ? error.message : String(error),
      model: isolatedToolUseContext.options.mainLoopModel,
    })
    throw error
  }

  notifyForkFinished({
    agentId,
    status: isolatedToolUseContext.cancelSource.signal.aborted
      ? 'stopped'
      : 'success',
    finishedAt: Date.now(),
    model: isolatedToolUseContext.options.mainLoopModel,
  })

  return { messages: outputMessages, agentId }
}

function extractPromptText(openingRows: Message[]): string | undefined {
  const parts: string[] = []
  for (const msg of openingRows) {
    const content = (msg as { message?: { content?: unknown } })?.message
      ?.content
    if (typeof content === 'string') {
      parts.push(content)
      continue
    }
    if (!Array.isArray(content)) continue
    for (const block of content) {
      if (block && typeof block === 'object') {
        const b = block as { type?: string; text?: string }
        if (b.type === 'text' && typeof b.text === 'string') parts.push(b.text)
      }
    }
  }
  const joined = parts.join('\n').trim()
  return joined.length > 0 ? joined : undefined
}
