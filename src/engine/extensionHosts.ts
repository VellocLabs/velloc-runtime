/**
 * The six `$` hosts the session's extensions call: tools, model, agents,
 * transcript, conversation and prompt. Each call runs on a context of its
 * own whose abort is the calling hook's signal or the runtime scope going
 * away, never the turn's: an extension may call outside any turn.
 */
import type { Message, InstructionText } from '../runtime/RuntimeTypes'
import type { ToolCallContext } from '../toolkit/toolCallContext'
import type { ModToolHost, ToolCallMods } from '../mods/toolCallEvent'
import { callToolForMod, checkToolForMod, listToolsForMods } from '../toolkit/run/executeToolCall'
import { createGeneratedUserMessage, makeNoticeRow } from '../messages/messageFactories'
import { contextWindowOf, getFastModelForProvider, getTierModelForProvider } from './contextWindow'
import { tierFromEffort } from '../config/nexusModelConfig/providers/shared/listing'
import { isAssistantMessage } from '../runtime/VercelModelConstants'
import { extractAssistantText } from '../models/fastModelCall'
import { ModRegisteredTools, isModRegisteredTool, modToolFullName, type ModRegisteredTool } from '../mods/modRegisteredTools'
import { mcpServerSkillName } from '../mcp/toolAdapter'
import {
  ModRegisteredAgents,
  agentIdOfLaunch,
  agentInfoOf,
  agentToolInputOf,
  denialOfLaunch,
  isModRegisteredAgent,
  type ModAgentHost,
} from '../mods/modAgents'
import { getSubAgentController } from '../team/subAgentController'
import {
  agentDeny,
  appendRefusal,
  compactCallResultOf,
  sessionUsageOf,
  type ModConversationHost,
  type ModTranscriptHost,
} from '../mods/sessionNouns'
import { describeAppendRow, type StoredRow } from '../mods/sessionAppendEvent'
import { tokensBeforeOf } from '../mods/sessionCompactEvent'
import { getTeamMessenger } from '../team/teamMessenger'
import { sendTeamMessage } from '../toolkit/builtin/teamTools'
import type { ModPromptHost } from '../mods/promptNouns'
import { sessionCostUsd } from './usageCost'
import { modModelHost, usageOf, type ModModelHost, type ModelOneShot, type ModelOneShotOutcome } from '../mods/modModel'
import { getRecordedMessagesForSession } from '../sessions/sessionStore'
import { composeSectionsOf } from '../mods/promptEvents'
import { resolvePromptProfile } from '../prompting/promptProfile'
import { traceLine } from '../utils/debugLog'
import { assembleTurnDependencies } from './turn/turnDependencies'
import { assemblePrompt, visibleToolNames } from './promptAssembly'
import { measureSessionWindow } from './windowBreakdownInput'
import { compactTranscriptNow } from './builtinCommands'
import type { SessionLedger } from './sessionLedger'
import type { TranscriptWriter } from './transcriptWriter'

function refusal(name: string, message: string): Error {
  const error = new Error(message)
  error.name = name
  return error
}

/** A controller that aborts with `signal` or the runtime scope; `dispose`
 *  detaches it from both. */
function linkedToScope(ledger: SessionLedger, signal: AbortSignal | undefined): { controller: AbortController; dispose: () => void } {
  const controller = new AbortController()
  const abort = () => controller.abort()
  const signals = [signal, ledger.config.runtimeScopeSignal].filter((each): each is AbortSignal => each !== undefined)
  for (const each of signals) {
    if (each.aborted) controller.abort()
    else each.addEventListener('abort', abort)
  }
  return { controller, dispose: () => { for (const each of signals) each.removeEventListener('abort', abort) } }
}

type HostParts = { ledger: SessionLedger; writer: TranscriptWriter; modTools: ModRegisteredTools; rewritten: () => void }

function toolHost({ ledger, modTools }: HostParts): ModToolHost {
  const { config } = ledger
  return {
    list: () => listToolsForMods(ledger.callContext()),
    // A plugin tool may not take the name space of a connected MCP server:
    // it would stand in for that server's tools and fall under the rules
    // the person granted the server.
    register: (spec, plugin) => {
      const prefix = modToolFullName(plugin, '')
      const server = config.mcpClients.find(client => typeof client.name === 'string' && `${mcpServerSkillName(client.name)}__` === prefix)
      const taken = config.tools.find(tool => !isModRegisteredTool(tool) && tool.name.startsWith(prefix))
      if (server || taken) {
        throw refusal(
          'NotAllowedError',
          `$.tool.register: ${modToolFullName(plugin, spec.name)} is refused — "${plugin}" names an MCP server ` +
            'of this session, whose tools and permission rules a plugin tool may not take',
        )
      }
      return modTools.register(spec, plugin)
    },
    forget: plugin => modTools.forget(plugin),
    call: async (input, raise) => {
      const mods = config.mods
      if (!mods?.toolCall || !mods.hasToolCallHooks) {
        throw refusal('NotSupportedError', '$.tool.call is not available: this session has no mod runtime')
      }
      const { controller, dispose } = linkedToScope(ledger, raise.signal)
      try {
        const context = ledger.callContext(undefined, controller)
        const confirm = context.requestToolUseConfirm
        const asksPerson = mods.whileAskingPerson?.bind(mods)
        // While the permission dialog is open the person is being waited
        // on, and the slot's time bounds pause.
        if (confirm && asksPerson) context.requestToolUseConfirm = (item, options) => asksPerson(() => confirm(item, options))
        return await callToolForMod({
          input,
          mods: mods as ToolCallMods,
          context: raise.context,
          canUseTool: config.decidePermission,
          callContext: context,
          deps: config.queryRuntimeDeps ?? assembleTurnDependencies(config.runtimeConfig),
        })
      } finally {
        dispose()
      }
    },
    check: async (input, raise) => {
      const mods = config.mods
      if (!mods?.toolCheck) throw refusal('NotSupportedError', '$.tool.check is not available: this session has no mod runtime')
      const { controller, dispose } = linkedToScope(ledger, raise.signal)
      try {
        return await checkToolForMod({ input, mods: mods as ToolCallMods, context: raise.context, callContext: ledger.callContext(undefined, controller) })
      } finally {
        dispose()
      }
    },
  }
}

/** An alias as the transport takes it: the provider's tier ladder for the
 *  tier names, the session's model for `inherit`, an id as it is. */
function resolveAlias(ledger: SessionLedger, model: string): string | undefined {
  const providerId = ledger.config.userSpecifiedProviderId
  switch (model) {
    case 'inherit':
    case 'session':
      return undefined
    case 'haiku':
    case 'fast':
      return getTierModelForProvider(providerId, 'fast')
    case 'sonnet':
    case 'balanced':
      return getTierModelForProvider(providerId, 'balanced')
    case 'opus':
    case 'best':
      return getTierModelForProvider(providerId, 'best')
    default:
      return model
  }
}

type OneShot = {
  messages: Message[]
  instructions: InstructionText
  userAmbient?: Record<string, string>
  hostAmbient?: Record<string, string>
  modelOverride?: string
  maxTokens?: number
  effort?: ModelOneShot['effort']
  signal: AbortSignal
  querySource: string
}

/** One tool-less completion through the session's own transport. */
async function runOneShot(ledger: SessionLedger, params: OneShot): Promise<ModelOneShotOutcome> {
  const { config } = ledger
  const callModel = config.queryRuntimeDeps?.callModel
  if (!callModel) throw refusal('NotSupportedError', '$.model is not available: this session has no model transport')
  const { controller, dispose } = linkedToScope(ledger, params.signal)
  const context: ToolCallContext = ledger.callContext(undefined, controller)
  context.options = { ...context.options, tools: [] }
  const tier = params.effort !== undefined ? tierFromEffort(params.effort) : undefined
  let text = ''
  let usage = usageOf(undefined)
  let apiError: { error: string; status: number | null } | undefined
  try {
    for await (const message of callModel({
      messages: params.messages,
      baseInstructions: params.instructions,
      userContext: params.userAmbient ?? {},
      systemAmbient: params.hostAmbient ?? {},
      callContext: context,
      providerId: config.userSpecifiedProviderId,
      querySource: params.querySource,
      ...(params.modelOverride !== undefined ? { modelOverride: params.modelOverride } : {}),
      ...(params.maxTokens !== undefined ? { outputTokenCapOverride: params.maxTokens } : {}),
      ...(tier !== undefined ? { thinkingTier: tier as string } : {}),
      forceFinalResponse: true,
      noCacheWrite: true,
    })) {
      if (!isAssistantMessage(message)) continue
      const row = message as Message & { usage?: unknown; message?: { usage?: unknown }; isApiErrorMessage?: boolean; apiError?: string; error?: string }
      const seen = row.message?.usage ?? row.usage
      if (seen !== undefined) usage = usageOf(seen)
      if (row.isApiErrorMessage === true || row.apiError === 'prompt_too_long') {
        // The error row names the kind of failure, never an HTTP status.
        apiError = { error: row.error ?? 'unknown', status: null }
        continue
      }
      const part = extractAssistantText(message)
      if (part) text = part
    }
  } catch (error) {
    if (controller.signal.aborted) throw error
    return { kind: 'api-error', error: 'unknown', status: null, usage }
  } finally {
    dispose()
  }
  if (text === '' && apiError) return { kind: 'api-error', ...apiError, usage }
  if (text === '') return { kind: 'empty-reply', usage }
  return { kind: 'answered', text, usage }
}

function modelHost({ ledger }: HostParts): ModModelHost {
  return modModelHost({
    fastModel: () => getFastModelForProvider(ledger.config.userSpecifiedProviderId),
    complete: request =>
      runOneShot(ledger, {
        messages: [createGeneratedUserMessage(request.prompt, { isMeta: false })],
        instructions: request.system !== undefined && request.system !== '' ? [request.system] : [],
        modelOverride: resolveAlias(ledger, request.model),
        maxTokens: request.maxTokens,
        effort: request.effort,
        signal: request.signal,
        querySource: 'mod_model_complete',
      }),
    fork: async request => {
      // Nothing to fork before the conversation has a single reply.
      if (!ledger.rows.some(message => isAssistantMessage(message))) return { kind: 'nothing-to-fork' }
      const parts = await assemblePrompt(ledger, ledger.activeModel())
      return runOneShot(ledger, {
        messages: [...ledger.rows, createGeneratedUserMessage(request.prompt, { isMeta: false })],
        instructions: parts.defaultSystemPrompt,
        userAmbient: parts.userContext,
        hostAmbient: parts.systemContext,
        signal: request.signal,
        querySource: 'mod_model_fork',
      })
    },
  })
}

function agentHost({ ledger }: HostParts, registeredAgents: ModRegisteredAgents, tools: ModToolHost): ModAgentHost {
  const fallbackDenial = 'the Agent tool did not start a subagent'
  return {
    register: (spec, plugin) => registeredAgents.register(spec, plugin),
    forget: plugin => registeredAgents.forget(plugin),
    list: () => getSubAgentController()?.list(ledger.sessionId()).map(entry => agentInfoOf(entry)) ?? [],
    // A spawn is the plugin's own Agent tool call, in the background: it
    // resolves once the subagent started.
    spawn: async (args, raise) => {
      const answer = (await tools.call(agentToolInputOf(args), raise)) as { result?: unknown; text?: unknown } | undefined
      const text = typeof answer?.text === 'string' ? answer.text : answer?.result
      const denied = denialOfLaunch(text)
      if (denied !== undefined) return { deny: denied }
      const agentId = agentIdOfLaunch(text)
      if (agentId === undefined) {
        return { deny: typeof text === 'string' ? text.trim().split('\n')[0] ?? fallbackDenial : fallbackDenial }
      }
      return { model: ledger.activeModel(), agentId }
    },
  }
}

function transcriptHost({ ledger }: HostParts, startedAt: number): Required<ModTranscriptHost> {
  const { config } = ledger
  return {
    rows: () => ledger.rows as unknown as readonly StoredRow[],
    agentRows: async agentId => {
      const listed = getSubAgentController()?.list(ledger.sessionId()).some(entry => entry.sessionId === agentId) ?? false
      if (!listed) return agentDeny(agentId, "not one of this session's agents")
      const rows = await getRecordedMessagesForSession(agentId, config.conversationStore)
      if (rows.length === 0) return agentDeny(agentId, 'no saved transcript to read yet')
      return rows as unknown as readonly StoredRow[]
    },
    usage: () => {
      const usd = sessionCostUsd(ledger.rows)
      return sessionUsageOf({
        rows: ledger.rows as unknown as readonly StoredRow[],
        // With no model picked, the window of the model the last reply names.
        window: contextWindowOf(config.pickedModel ?? ledger.lastResponseModel(), config.userSpecifiedProviderId),
        fallbackStartedAt: startedAt,
        ...(usd !== undefined ? { costUsd: usd } : {}),
      })
    },
    // Measured against the same window the plain figures report.
    breakdown: ({ columns }) =>
      measureSessionWindow(ledger, {
        model: config.pickedModel ?? ledger.lastResponseModel() ?? ledger.activeModel(),
        window: contextWindowOf(config.pickedModel ?? ledger.lastResponseModel(), config.userSpecifiedProviderId),
        ...(columns !== undefined ? { columns } : {}),
      }),
  }
}

/** A teammate's name for an id; an id with no teammate passes unchanged. */
function teammateNameFor(ledger: SessionLedger, id: string): string {
  const roster = getTeamMessenger()?.listMembers?.(ledger.sessionId()) ?? []
  return roster.find(member => member.sessionId === id)?.name ?? id
}

function conversationHost(parts: HostParts): ModConversationHost {
  const { ledger, writer, rewritten } = parts
  let compacting = false
  return {
    compact: async (args, raise) => {
      ledger.refuseDuringModelTurn('$.session.compact')
      if (compacting) throw refusal('InvalidStateError', '$.session.compact: a compaction this plugin call started is still running')
      if (ledger.rows.length === 0) return { skip: 'the conversation has no messages to compact' }
      compacting = true
      try {
        const { rows, didCompact, settled } = await compactTranscriptNow(ledger, {
          trigger: 'plugin',
          ...(args.instructions !== undefined ? { instructions: args.instructions } : {}),
          callContext: ledger.callContext(),
          raise,
        })
        const kept = await writer.appendRows(rows)
        if (didCompact) ledger.rows = kept
        else ledger.rows.push(...kept)
        await writer.persist()
        rewritten()
        if (settled && 'skip' in settled) return { skip: settled.skip }
        if (!didCompact || !settled || !('boundaryMarker' in settled)) {
          throw new Error(`$.session.compact: ${settled && 'error' in settled ? settled.error : 'this session cannot compact'}`)
        }
        return compactCallResultOf(kept.slice(1) as unknown as StoredRow[], tokensBeforeOf(settled.boundaryMarker))
      } finally {
        compacting = false
      }
    },
    send: async (args, raise) => {
      const to = typeof args.to === 'string' ? args.to : teammateNameFor(ledger, 'sessionId' in args.to ? args.to.sessionId : args.to.agentId)
      const { sent } = await sendTeamMessage({
        options: ledger.callContext().options,
        to,
        text: args.text,
        origin: { kind: 'plugin', name: raise.context.origin.plugin },
        ...(raise.signal ? { signal: raise.signal } : {}),
        context: raise.context,
      })
      return sent
    },
    append: async (args, raise) => {
      if (args.agentId !== undefined) {
        throw refusal(
          'NotSupportedError',
          `$.session.append({ agentId: "${args.agentId}" }): this engine appends to the main conversation alone; omit agentId`,
        )
      }
      ledger.refuseDuringModelTurn('$.session.append')
      const refused = appendRefusal(args.message)
      if (refused !== null) throw new TypeError(`$.session.append: ${refused}`)
      const texts = args.message.content.map(block => String(block.text))
      const row: Message =
        args.message.type === 'system'
          ? makeNoticeRow(ledger.config.runtimeConfig, texts[0]!)
          : createGeneratedUserMessage(texts.map(text => ({ type: 'text' as const, text })), { isMeta: true })
      const mods = ledger.config.mods
      const outcome = mods?.appendNote ? await mods.appendNote(row as unknown as StoredRow, raise) : { row: row as unknown as StoredRow }
      if ('deny' in outcome) return { deny: outcome.deny }
      ledger.rows.push(outcome.row as unknown as Message)
      await writer.persist()
      rewritten()
      const described = describeAppendRow(outcome.row)!
      return { message: described.message, uuid: described.uuid }
    },
  }
}

/** The engine's own render for the facts asked, without the session's
 *  prompt hooks, then `prompt.compose` with the caller's context. Nothing
 *  is stored. */
function promptHost({ ledger }: HostParts): Pick<ModPromptHost, 'compose'> {
  return {
    compose: async (args, raise) => {
      const model = args.model ?? ledger.activeModel()
      const providerId = ledger.config.userSpecifiedProviderId
      const tools = visibleToolNames(ledger, model, ledger.rows, providerId).filter(name => !args.tools || args.tools.includes(name))
      const parts = await assemblePrompt(ledger, model, ledger.rows, providerId, {
        withMods: false,
        ...(args.tools ? { onlyTools: args.tools } : {}),
      })
      const own = composeSectionsOf(parts.sections ?? parts.defaultSystemPrompt.map(text => ({ text })))
      const mods = ledger.config.mods
      if (!mods?.promptCompose) return { sections: own }
      const profile = resolvePromptProfile({ providerId, modelId: model })
      const sections = await mods.promptCompose(
        { model, promptModel: model, surfaces: ['desktop'], tools, outputStyle: null, traits: profile === 'lean' ? ['lean'] : [] },
        own,
        raise.signal,
        raise.context,
      )
      return { sections }
    },
  }
}

export class ExtensionHosts {
  readonly tools: ModToolHost
  readonly model: ModModelHost
  readonly agents: ModAgentHost
  readonly transcript: Required<ModTranscriptHost>
  readonly conversation: ModConversationHost
  readonly prompt: Pick<ModPromptHost, 'compose'>
  /** Agent types extensions registered, kept beside the session's own. */
  readonly registeredAgents: ModRegisteredAgents
  /** A loop under a slot: list the tools the slot's extensions registered,
   *  in place of any listed before. */
  readonly inheritRegisteredTools: (tools: readonly ModRegisteredTool[]) => void
  private rewrittenListener: (() => void) | undefined

  constructor(private readonly ledger: SessionLedger, writer: TranscriptWriter) {
    const { config } = ledger
    // Each change rebuilds the session's list: its own entries plus the
    // registered ones, replaced by name.
    const listRegistered = (registered: readonly ModRegisteredTool[]) => {
      const names = new Set(registered.map(tool => tool.name))
      config.tools = [...config.tools.filter(tool => !isModRegisteredTool(tool) && !names.has(tool.name)), ...registered]
    }
    const modTools = new ModRegisteredTools(registered => {
      listRegistered(registered)
      config.onModToolsChanged?.(registered)
    })
    this.inheritRegisteredTools = listRegistered
    this.registeredAgents = new ModRegisteredAgents(registered => {
      const names = new Set(registered.map(agent => agent.name))
      config.agents = [
        ...config.agents.filter(agent => !isModRegisteredAgent(agent as { modPlugin?: unknown }) && !names.has(agent.name ?? '')),
        ...registered,
      ]
    })
    const parts: HostParts = { ledger, writer, modTools, rewritten: () => this.notifyRewritten() }
    this.tools = toolHost(parts)
    this.model = modelHost(parts)
    this.agents = agentHost(parts, this.registeredAgents, this.tools)
    this.transcript = transcriptHost(parts, Date.now())
    this.conversation = conversationHost(parts)
    this.prompt = promptHost(parts)
  }

  /** The worker's: told when an extension changed the conversation outside
   *  the stream it copies. */
  setRewrittenListener(listener: (() => void) | undefined): void {
    this.rewrittenListener = listener
  }

  /** `session.measure` after a main-thread turn; not awaited. */
  measure(): void {
    const mods = this.ledger.config.mods
    if (!mods?.sessionMeasure || mods.agentId !== undefined) return
    void mods.sessionMeasure(() => this.transcript.usage())
  }

  private notifyRewritten(): void {
    try {
      this.rewrittenListener?.()
    } catch (error) {
      traceLine(`[mods] the conversation listener failed: ${error instanceof Error ? error.message : String(error)}`, { level: 'warn' })
    }
  }
}
