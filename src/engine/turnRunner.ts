/**
 * One submitted turn in five stages: receive, commands, prompt, loop (rows stored as yielded; the
 * loop's single commit closes the turn), settle.
 */
import type { ContentBlockParam, Message, QueryTerminal, StreamRecord, TurnResultRecord } from '../runtime/RuntimeTypes'
import type { ProcessUserInputResult } from '../runtime/interfaces/UserInputPipeline'
import type { SystemPromptParts } from '../runtime/interfaces/PromptContextProvider'
import type { ToolCallContext } from '../toolkit/toolCallContext'
import type { ChromiumSkillSummary } from '../runtime/CommandTypes'
import type { BuildSystemInitMessageParams } from '../runtime/interfaces/SystemInitEmitter'
import type { TurnConclusion } from './turnOutcome'
import { runTurnLoop } from './turnInterpreter'
import { defaultTurnPolicies } from './turnLoop'
import { chooseLoopNudge } from './loop/nudgePolicy'
import { recordPageFingerprint } from './loop/actionLoopDetector'
import { promptTextOf, withPromptText } from '../mods/sessionMessageEvents'
import { submitCarriesToolResult, toolResultIdsInPrompt } from '../utils/sessionNeedsAnswer'
import { assembleTurnDependencies } from './turn/turnDependencies'
import { isCallModelLogEnabled, logCallModelEvent, nextSubmitId } from './turn/callModelTrace'
import { hydrateMessagesForModel } from '../sessions/sessionStore'
import { runSessionStartHooks, type SessionStartSource } from '../lifecycleHooks/sessionLifecycleHooks'
import { getActiveSessionManager } from '../browser/worker/SharedWorkerSessionManager'
import {
  MSG_TYPE_ASSISTANT,
  MSG_TYPE_RESULT,
  MSG_TYPE_STREAM_EVENT,
  MSG_TYPE_STREAM_REQUEST_START,
  MSG_TYPE_TOMBSTONE,
  TERMINAL_ABORTED,
  TERMINAL_AWAITING_USER,
  TERMINAL_COMPLETED,
  TERMINAL_MAX_TURNS,
  TERMINAL_STOP_HOOK_PREVENTED,
} from '../runtime/VercelModelConstants'
import type { SubmitTurnOptions } from './engineConfig'
import type { SessionLedger } from './sessionLedger'
import type { TranscriptWriter } from './transcriptWriter'
import type { SessionTitler } from './autoTitle'
import type { ExtensionHosts } from './extensionHosts'
import { assemblePrompt } from './promptAssembly'
import { commandFor } from './builtinCommands'
import { answerSince, isStoredRow, isSuccessfulTerminal, resultRow, resultSubtype, sessionInitRow } from './turnReport'
import { intakeUserInput, labelIntake, passCommandHooks, passPromptHooks, type Prompt } from './inputIntake'

/** The engine's parts a turn works with. */
export type EngineParts = {
  readonly ledger: SessionLedger
  readonly writer: TranscriptWriter
  readonly titler: SessionTitler
  readonly hosts: ExtensionHosts
}

type Turn = {
  readonly parts: EngineParts
  readonly startTime: number
  readonly submitId: number
  readonly callContext: ToolCallContext
}

/** Stage 1. Undefined when `session.receive` consumed the delivery. */
async function receive(ledger: SessionLedger, prompt: Prompt, options?: SubmitTurnOptions): Promise<Prompt | undefined> {
  if (ledger.modsSettling) await ledger.modsSettling
  if (ledger.modsArriving) await ledger.modsArriving
  const mods = ledger.config.mods
  if (options?.delivery && mods?.hasSessionReceiveHooks?.() && mods.sessionReceive) {
    const received = await mods.sessionReceive({ origin: { kind: options.delivery }, text: promptTextOf(prompt) })
    if ('consumed' in received) return undefined
    if (received.text !== promptTextOf(prompt)) prompt = withPromptText(prompt, received.text) as Prompt
  }
  openTurn(ledger, prompt)
  return prompt
}

/** The submit listener hears the submit before anything is awaited. */
function announceSubmit(ledger: SessionLedger): void {
  try {
    ledger.afterSubmit?.()
  } catch {
    /* the listener's failure is its own */
  }
}

function openTurn(ledger: SessionLedger, prompt: Prompt): void {
  ledger.turnCount++
  ledger.renewCancelSource()
  // A tool result answers the halt of that one call; a plain message leaves
  // every halt open.
  for (const id of toolResultIdsInPrompt(prompt)) {
    ledger.dropPending('pendingPermissions', id)
    ledger.dropPending('pendingPlanApproval', id)
    ledger.dropPending('pendingUserInteraction', id)
  }
}

/** Stage 2. The processed input and the built-in command it names; the
 *  caller runs the command, so its rows reach the stream directly. */
async function commands(
  turn: Turn,
  prompt: Prompt,
  options?: SubmitTurnOptions,
): Promise<{ result: ProcessUserInputResult; entered: Prompt; command?: AsyncGenerator<Message, void, unknown> }> {
  const { ledger } = turn.parts
  const { config } = ledger
  const { callContext } = turn
  const submitted = await passPromptHooks(ledger, prompt, options)
  const commanded = submitted.dropped ? undefined : await passCommandHooks(ledger, submitted.prompt, callContext, options)
  // Tools and agents an extension registered while loading count from this
  // turn on: the context was made before the wait.
  if (config.mods && (callContext.options.tools !== config.tools || callContext.options.agentDefinitions.enabledAgents !== config.agents)) {
    callContext.options = {
      ...callContext.options,
      tools: config.tools,
      agentDefinitions: { ...callContext.options.agentDefinitions, enabledAgents: config.agents, allAgents: config.agents },
    }
  }
  const result = submitted.dropped ?? commanded ?? (await intakeUserInput(ledger, submitted.prompt, callContext, options))
  labelIntake(result, submitted, options)
  // A model turn that does not answer an open question ends it: the request
  // closes the call, so the record would only block the composer. A local
  // command reaches no model and leaves the question open.
  if (result.shouldQuery && !submitCarriesToolResult(prompt)) ledger.dropPending('pendingUserInteraction')
  if (result.model) {
    config.pickedModel = result.model
    if (result.providerId) config.userSpecifiedProviderId = result.providerId
  }
  callContext.options.mainLoopProviderId = config.userSpecifiedProviderId
  callContext.options.mainLoopModel = config.pickedModel ?? callContext.options.mainLoopModel
  const command = commandFor(result)
  if (command) {
    const { parts } = turn
    const run = command({
      ledger,
      writer: parts.writer,
      titler: parts.titler,
      result,
      callContext,
      refreshPlugins: set => ledger.refreshPluginSet(set, () => parts.hosts.registeredAgents.list()),
    })
    return { result, entered: submitted.prompt, command: run }
  }
  return { result, entered: submitted.prompt }
}

/** Stage 3. The rendered prompt, or undefined when the turn ends here. */
async function* prepare(turn: Turn, result: ProcessUserInputResult): AsyncGenerator<StreamRecord, SystemPromptParts | undefined> {
  const { ledger, writer } = turn.parts
  const { callContext } = turn
  // `SessionStart` is raised by the first turn that reaches the model (and
  // the first after a `/clear`); its rows go ahead of the prompt.
  let startRows: Message[] = []
  if (result.shouldQuery && ledger.sessionStartSource !== null) {
    const source: SessionStartSource = ledger.sessionStartSource ?? 'startup'
    ledger.sessionStartSource = null
    startRows = await writer.appendRows(await runSessionStartHooks(source, callContext))
    ledger.rows.push(...startRows)
  }
  ledger.rows.push(...(await writer.appendRows(result.messages)))
  callContext.messages = ledger.rows
  await writer.persist()
  yield await sessionInitRow(ledger, ledger.activeModel())
  for (const row of startRows) yield row
  if (!result.shouldQuery) {
    // A local command's own rows reach the stream here; they never pass the
    // request loop.
    for (const row of result.messages) yield row
    yield resultRow(ledger, 'success', false, {
      duration_ms: ledger.config.runtimeConfig.now() - turn.startTime,
      result: result.resultText ?? '',
      num_turns: ledger.rows.length,
      permission_denials: ledger.deniedCalls,
      usage: ledger.usageSoFar,
    })
    return undefined
  }
  // Only a turn that reaches the model renders a prompt, for its own model.
  return assemblePrompt(ledger, callContext.options.mainLoopModel)
}

/** The page-refresh half of the step refresh: records the page fingerprint
 *  the last tool stashed, and renders the prompt again after a browser
 *  step. The nudge is the machine's (`chooseLoopNudge`). */
function stepRefresher(turn: Turn) {
  const { ledger } = turn.parts
  return async (messages: readonly Message[], calls: readonly { toolName: string }[]) => {
    const state = ledger.agentLoopState
    if (state.pendingFingerprint) {
      recordPageFingerprint(state, state.pendingFingerprint)
      state.pendingFingerprint = null
    }
    if (!calls.some(call => call.toolName.startsWith('Browser'))) return undefined
    return { promptParts: await assemblePrompt(ledger, ledger.config.pickedModel ?? turn.callContext.options.mainLoopModel, messages) }
  }
}

/** Stage 4. Runs the request loop and returns its terminal. */
async function* loop(turn: Turn, prompt: Prompt, promptParts: SystemPromptParts): AsyncGenerator<StreamRecord, QueryTerminal> {
  const { ledger, writer, titler, hosts } = turn.parts
  const { config } = ledger
  const mods = config.mods
  const turnId = config.runtimeConfig.createUUID()
  const rowsBefore = ledger.rows.length
  ledger.runningTurnId = turnId
  let endTurn!: () => void
  ledger.turnEnded = new Promise<void>(resolve => {
    endTurn = resolve
  })
  const release = () => {
    if (ledger.runningTurnId === turnId) ledger.runningTurnId = undefined
    ledger.turnEnded = undefined
    endTurn()
  }
  const completion = (reason: 'answer' | 'aborted' | 'error', isAborted: boolean) => ({
    turnId,
    answer: answerSince(ledger.rows, rowsBefore),
    durationMs: config.runtimeConfig.now() - turn.startTime,
    reason,
    isAborted,
  })
  const pending: Message[] = []
  const commitTerminal = async (conclusion: TurnConclusion): Promise<void> => {
    if (conclusion.kind === 'crash') {
      try {
        await writer.flush(pending)
      } catch (persistError) {
        console.warn('[nexus] failed to persist partial query messages:', persistError)
      }
      await mods?.turnComplete?.(completion('error', ledger.cancelSource.signal.aborted))
      hosts.measure()
      return
    }
    const terminal = conclusion.outcome as unknown as QueryTerminal
    await writer.flush(pending)
    release()
    const reason = terminal.reason === TERMINAL_ABORTED ? 'aborted' : isSuccessfulTerminal(terminal) ? 'answer' : 'error'
    await mods?.turnComplete?.(completion(reason, terminal.reason === TERMINAL_ABORTED))
    hosts.measure()
  }
  await mods?.turnStart?.({ text: typeof prompt === 'string' ? prompt : '', turnId }, ledger.cancelSource.signal)
  const iterator = runTurnLoop(
    {
      messages: [...ledger.rows],
      baseInstructions: promptParts.defaultSystemPrompt,
      userAmbient: promptParts.userContext,
      systemAmbient: promptParts.systemContext,
      decidePermission: config.decidePermission,
      callContext: turn.callContext,
      providerId: config.userSpecifiedProviderId,
      thinkingTier: config.userSpecifiedThinkingTier,
      backupModel: config.backupModel,
      turnCaller: 'sdk',
      stepLimit: config.maxTurns,
      spendBudget: config.taskBudget,
      runtimeConfig: config.runtimeConfig,
      deps: config.queryRuntimeDeps ?? assembleTurnDependencies(config.runtimeConfig),
      modTurnId: turnId,
      ...(writer.rewritesRows() ? { keptRow: (row: Message) => writer.keptRow(row) } : {}),
      // A fork that moves to another model renders that model's prompt.
      renderSystemPromptForModel: async selection =>
        (await assemblePrompt(ledger, selection.modelId, ledger.rows, selection.providerId ?? config.userSpecifiedProviderId)).defaultSystemPrompt,
      refreshPromptContext: stepRefresher(turn),
      renderPromptAfterCompaction: messages =>
        assemblePrompt(ledger, config.pickedModel ?? turn.callContext.options.mainLoopModel, messages),
      commitTerminal,
    },
    { ...defaultTurnPolicies, chooseNudge: chooseLoopNudge },
  )[Symbol.asyncIterator]()
  try {
    while (true) {
      const next = await iterator.next()
      if (next.done) {
        // A turn that never reached the model has nothing worth a title.
        if (isSuccessfulTerminal(next.value)) titler.start(turn.callContext)
        return next.value
      }
      if (isStoredRow(next.value)) {
        // Stored row by row, so a crash loses at most the row in hand.
        pending.push(next.value)
        try {
          await writer.flush(pending)
        } catch (error) {
          // The loop records the failure as its own crash, then rethrows.
          await iterator.throw(error)
          throw error
        }
      }
      // The stored form when an append hook rewrote the row.
      yield writer.keptRow(next.value as Message)
    }
  } catch (error) {
    try {
      await writer.flush(pending)
    } catch (persistError) {
      console.warn('[nexus] failed to persist partial query messages:', persistError)
    }
    throw error
  } finally {
    release()
  }
}

/** Stage 5. */
async function* settle(turn: Turn, terminal: QueryTerminal): AsyncGenerator<StreamRecord, void> {
  const { ledger } = turn.parts
  const { config } = ledger
  // A module edited during the turn reloads now; the next turn waits for it.
  const afterTurn = config.mods?.afterTurn?.()
  if (afterTurn) ledger.noteSettling(afterTurn)
  if (typeof terminal.reason === 'string') {
    await config.conversationStore.saveTerminalState(terminal.reason, config.runtimeConfig.now())
  }
  if (isCallModelLogEnabled()) {
    logCallModelEvent('submit-end', { submitId: turn.submitId, terminalReason: terminal.reason ?? '<none>', finalMessageCount: ledger.rows.length })
  }
  yield resultRow(ledger, resultSubtype(terminal), !isSuccessfulTerminal(terminal), {
    duration_ms: config.runtimeConfig.now() - turn.startTime,
    num_turns: ledger.rows.length,
    permission_denials: ledger.deniedCalls,
    terminal,
    usage: ledger.usageSoFar,
  })
}

/** Everything after receipt, up to the result row. */
async function* accepted(parts: EngineParts, prompt: Prompt, options?: SubmitTurnOptions): AsyncGenerator<StreamRecord, void> {
  const { ledger } = parts
  let submitId = 0
  if (isCallModelLogEnabled()) {
    submitId = nextSubmitId()
    logCallModelEvent('submit-start', {
      submitId,
      turnCount: ledger.turnCount,
      existingMessageCount: ledger.rows.length,
      promptShape: typeof prompt === 'string' ? 'string' : 'array',
    })
  }
  void ledger.pushHostSettings()
  const startTime = ledger.config.runtimeConfig.now()
  const model = ledger.activeModel()
  // The store's rows are the turn's starting point. An empty store leaves
  // the engine's rows alone: a fork's seed is not stored yet.
  const hydrated = await hydrateMessagesForModel(ledger.config.conversationStore)
  if (hydrated && hydrated.length > 0) ledger.rows = [...hydrated]
  if (ledger.sessionStartSource === undefined) ledger.sessionStartSource = ledger.rows.length > 0 ? 'resume' : 'startup'
  const turn: Turn = { parts, startTime, submitId, callContext: ledger.callContext(model, ledger.cancelSource) }
  const { result, entered, command } = await commands(turn, prompt, options)
  if (command) yield* command
  const promptParts = yield* prepare(turn, result)
  if (!promptParts) return
  const terminal = yield* loop(turn, entered, promptParts)
  yield* settle(turn, terminal)
}

/** Runs one submitted turn, yielding every row the stream shows. */
export async function* runTurn(
  parts: EngineParts,
  prompt: string | Array<ContentBlockParam>,
  options?: SubmitTurnOptions,
): AsyncGenerator<StreamRecord, void, unknown> {
  // Stage 1 runs inline: a settled ledger reaches the store's first read
  // with no extra await between them.
  const { ledger } = parts
  announceSubmit(ledger)
  if (ledger.modsSettling || ledger.modsArriving || options?.delivery) {
    const received = await receive(ledger, prompt, options)
    if (received === undefined) return
    prompt = received
  } else {
    openTurn(ledger, prompt)
  }
  const received = prompt
  // The topbar shows the session as thinking while no tool runs; cleared
  // however the turn ends.
  const sessionId = parts.ledger.sessionId()
  const manager = sessionId ? getActiveSessionManager() : null
  manager?.markStreamStart(sessionId)
  try {
    yield* accepted(parts, received, options)
  } finally {
    manager?.markStreamEnd(sessionId)
  }
}
