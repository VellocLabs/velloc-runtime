/**
 * Contract: a tool call raised as the `tool.call` event (F-25); core is
 * `executeToolCallStages`. Progress streams live; every other message is held
 * under the run's `ref` until the chain settles: core's own object emits that run
 * verbatim, `{ result }` builds a tool_result, `{ deny }` an error tool_result,
 * `context` one model-only message. A HALT is not wrapped. If the chain fails, the
 * last run's messages are used, or core runs directly. Also serves
 * `$.tool.call` and a tool's NESTED steps (a mod guarding `{ tool: 'Bash' }` must
 * not be bypassed by SuperShell or `exec`).
 */

import type { ToolContract } from '../toolContract'
import type { ToolCallContext } from '../toolCallContext'
import type { QueryToolUseBlock } from '../../runtime/interfaces/QueryRuntimeDeps'
import type { Message } from '../../runtime/RuntimeTypes'
import { MSG_TYPE_STREAM_EVENT } from '../../runtime/VercelModelConstants'
import { traceLine } from '../../utils/debugLog'
import {
  isToolCallResult,
  toolCallArgsOf,
  toolCallContextOf,
  toolCallEventOf,
  type ToolCallCoreResult,
} from '../../mods/toolCallEvent'
import type { ToolCallExtensions } from '../toolExtensionSeam'
import type { DispatchContext } from '../../mods/modTypes'
import type { DeferredMessageUpdate } from './executeToolCall'
import { createProgressQueue, drainWithProgress } from './progressQueue'

/** The text a halted run answers `next` with. Never shown to the model: a
 *  halted call's own messages are emitted instead. */
export const TOOL_CALL_HALTED_TEXT =
  'The call is waiting for the user; its result arrives outside this hook.'

/** What a `tool.call` raise needs of the session's extensions. */
export type ToolCallSeam = Pick<ToolCallExtensions, 'ready' | 'hasToolCallHooks' | 'toolCall' | 'agentId'>

export type ToolCallThroughModsParams = {
  mods: ToolCallSeam
  /** The loop the call runs in, when the context does not say (a sub-agent
   *  or teammate session is the main loop of its OWN runtime). */
  agentId?: string
  toolUse: QueryToolUseBlock
  tool: ToolContract
  callContext: ToolCallContext
  /** The engine's own behaviour for this call, with these arguments. */
  runCore: (
    toolUse: QueryToolUseBlock,
    callContext: ToolCallContext,
  ) => AsyncGenerator<DeferredMessageUpdate, void>
  /** The tool_result message of this call, when `message` is it. */
  readResultMessage: (
    message: Message,
  ) => { data: unknown; text: string; isError: boolean } | undefined
  /** A tool_result message for a result a hook supplied (or a deny). */
  buildResultMessage: (answer: {
    data: unknown
    isError: boolean
    args: Record<string, unknown>
  }) => Promise<Message>
  /** A message only the model reads. */
  buildContextMessage: (text: string) => Message
}

type CoreRun = {
  ref: number
  args: Record<string, unknown>
  updates: DeferredMessageUpdate[]
  halted: boolean
  /** What this run answered `next` with. */
  answer?: ToolCallCoreResult
  /** The `result` as handed to the chain, serialized — to tell core's object
   *  relayed unchanged from one a hook rewrote. Undefined: not serializable. */
  handed?: string
}

/** A deny that settled after core had started: it withholds what ran and
 *  undoes nothing, so the reader is told the tool ran. */
function deniedText(toolName: string, deny: string, started: boolean): string {
  return started ? `${toolName} ran, but a plugin withheld its result: ${deny}` : deny
}

/** Whether a call of `tool` is raised as `tool.call` at all. */
export function raisesToolCall(tool: ToolContract): boolean {
  // AskUserQuestion and the plan tools halt the loop and are answered by the
  // user through another path; there is no result for a hook to wrap.
  return tool.haltsForUser?.() !== true
}

function isProgress(update: DeferredMessageUpdate): boolean {
  return (
    update.message !== undefined &&
    (update.message as { type?: unknown }).type === MSG_TYPE_STREAM_EVENT
  )
}

/** A value that survives a port: a result is a tool's own record, and may hold
 *  anything. What cannot be copied is handed over as nothing (`text` remains). */
function portable(value: unknown): { value: unknown; json?: string } {
  if (value === undefined) return { value: undefined }
  try {
    const json = JSON.stringify(value)
    if (json === undefined) return { value: undefined }
    return { value: JSON.parse(json), json }
  } catch {
    return { value: undefined }
  }
}

function serialized(value: unknown): string | undefined {
  try {
    return JSON.stringify(value)
  } catch {
    return undefined
  }
}

type CoreRunParams = Pick<
  ToolCallThroughModsParams,
  'toolUse' | 'tool' | 'callContext' | 'runCore' | 'readResultMessage'
>

/** The core of one call's `tool.call` event, and the record of its runs. */
function createCoreRuns(params: CoreRunParams) {
  const { toolUse, tool, callContext: callContext } = params
  const originalArgs = (toolUse.args ?? {}) as Record<string, unknown>
  const parent = callContext.cancelSource

  const live = createProgressQueue()
  const runs = new Map<number, CoreRun>()
  let lastRun: CoreRun | undefined
  let nextRef = 1
  let hasSettled = false

  const core = async (arrived: unknown, signal: AbortSignal): Promise<ToolCallCoreResult> => {
    const run: CoreRun = {
      ref: nextRef++,
      args: toolCallArgsOf(arrived, originalArgs),
      updates: [],
      halted: false,
    }
    // A run of its own can be stopped without stopping the turn.
    const child = new AbortController()
    const stop = () => child.abort()
    if (parent.signal.aborted || signal.aborted) child.abort()
    parent.signal.addEventListener('abort', stop)
    signal.addEventListener('abort', stop)
    try {
      const generator = params.runCore(
        { ...toolUse, args: run.args },
        { ...callContext, cancelSource: child },
      )
      for await (const update of generator) {
        if (isProgress(update)) {
          // After the chain settled nobody drains the queue.
          if (!hasSettled && update.message) live.push(update.message)
          continue
        }
        run.updates.push(update)
        if (update.pendingToolUse) run.halted = true
      }
    } finally {
      parent.signal.removeEventListener('abort', stop)
      signal.removeEventListener('abort', stop)
    }
    runs.set(run.ref, run)
    lastRun = run

    if (run.halted) {
      run.answer = { ref: run.ref, result: undefined, text: TOOL_CALL_HALTED_TEXT, isError: true }
      return run.answer
    }
    let read: ReturnType<typeof params.readResultMessage>
    for (const update of run.updates) {
      read = update.message ? params.readResultMessage(update.message) : undefined
      if (read) break
    }
    const handed = portable(read?.data)
    run.handed = handed.json
    let isReadOnly = false
    try {
      isReadOnly = tool.readsOnly(run.args as never) === true
    } catch {
      isReadOnly = false
    }
    run.answer = {
      ref: run.ref,
      result: handed.value,
      ...(read ? { text: read.text } : {}),
      ...(read?.isError ? { isError: true as const } : {}),
      ...(isReadOnly ? { isReadOnly: true as const } : {}),
    }
    return run.answer
  }

  return {
    core,
    live,
    runs,
    originalArgs,
    last: (): CoreRun | undefined => lastRun,
    /** Whether core started at least once, finished or not. */
    started: (): boolean => nextRef > 1,
    settled: (): void => {
      hasSettled = true
    },
  }
}

function cancelledError(): Error {
  const error = new Error('the tool call was aborted')
  error.name = 'AbortError'
  return error
}

/**
 * A plugin's `$.tool.call`: raises `tool.call` beneath the calling hook's frames
 * (`DispatchContext.frames`) and resolves to what the chain settled on. Nothing is emitted; `context` on the
 * answer is dropped.
 */
export async function callToolThroughMods(
  params: CoreRunParams & { mods: ToolCallSeam; context: DispatchContext },
): Promise<unknown> {
  const { mods, toolUse, tool, callContext: callContext } = params
  const tracker = createCoreRuns(params)
  const parent = callContext.cancelSource
  const event = toolCallEventOf(
    tool.name,
    toolUse.toolCallId,
    tracker.originalArgs,
    callContext.agentId,
  )
  const settlement = await mods.toolCall(event, tracker.core, parent.signal, params.context)
  tracker.settled()
  if (parent.signal.aborted) throw cancelledError()

  const halted = [...tracker.runs.values()].find(run => run.halted)
  if (halted) return halted.answer

  if (!settlement.settled && settlement.refused !== undefined) throw new Error(settlement.refused)
  if (!settlement.settled || !isToolCallResult(settlement.result)) {
    // The chain failed. The call still has an answer: the last run's, or
    // core's own, run now.
    const ran = tracker.last()
    if (ran) return ran.answer
    const never = new AbortController()
    return tracker.core(event, never.signal)
  }
  const { context: _context, ...answer } = settlement.result as Record<string, unknown>
  if (typeof answer.deny === 'string') answer.deny = deniedText(tool.name, answer.deny, tracker.started())
  return answer
}

/** What one nested step answers its caller (`runNestedTool`): whether it ran,
 *  the text the caller reads, and the tool's own data. `answeredByHook`: a
 *  hook supplied the result — the tool itself did not produce it. */
export type NestedToolOutcome = {
  ok: boolean
  data: string
  raw?: unknown
  answeredByHook?: true
}

export type NestedToolThroughModsParams = {
  mods: ToolCallSeam
  tool: ToolContract
  /** The step's own id: no tool_use block carries it. */
  callRef: string
  args: Record<string, unknown>
  callContext: ToolCallContext
  /** The nested pipeline with these arguments. */
  runCore: (args: Record<string, unknown>) => Promise<NestedToolOutcome>
  /** A hook's own result as the text the caller reads. */
  serialize: (data: unknown) => string
}

/**
 * A nested step raised as `tool.call`. The same settlement as the model's
 * call: core's own object is that run's outcome; `{ deny }` is a step that
 * failed, the text its reason (saying the step ran when core had started); a hook's `{ result }` is the step's
 * answer (the run that happened stays happened); `context` is appended to
 * the text, as a nested PostToolUse note is — a step has no message of its
 * own to put it in.
 */
export async function runNestedToolThroughMods(
  params: NestedToolThroughModsParams,
): Promise<NestedToolOutcome> {
  const { mods, tool, callRef: callRef, args, callContext: callContext } = params
  const runs = new Map<number, { outcome: NestedToolOutcome; handed?: string }>()
  let last: NestedToolOutcome | undefined
  let nextRef = 1

  const core = async (arrived: unknown): Promise<ToolCallCoreResult> => {
    const ref = nextRef++
    const runArgs = toolCallArgsOf(arrived, args)
    const outcome = await params.runCore(runArgs)
    const handed = portable(outcome.raw)
    runs.set(ref, { outcome, handed: handed.json })
    last = outcome
    let isReadOnly = false
    try {
      isReadOnly = tool.readsOnly(runArgs as never) === true
    } catch {
      isReadOnly = false
    }
    return {
      ref,
      result: handed.value,
      text: outcome.data,
      ...(outcome.ok ? {} : { isError: true as const }),
      ...(isReadOnly ? { isReadOnly: true as const } : {}),
    }
  }

  const event = toolCallEventOf(tool.name, callRef, args, callContext.agentId ?? mods.agentId)
  const settlement = await mods.toolCall(
    event,
    core,
    callContext.cancelSource.signal,
    callContext.modCallContext,
  )
  if (!settlement.settled && settlement.refused !== undefined) return { ok: false, data: settlement.refused }
  if (!settlement.settled || !isToolCallResult(settlement.result)) {
    // Abandoned or failed: the step still answers — the last run's, or core's.
    return last ?? params.runCore(args)
  }
  const result = settlement.result as {
    deny?: unknown
    result?: unknown
    ref?: unknown
    isError?: unknown
  }
  if (typeof result.deny === 'string') {
    traceLine(`[tool] nested ${tool.name} denied by a tool.call hook (${callRef})`, {
      level: 'info',
    })
    return { ok: false, data: deniedText(tool.name, result.deny, nextRef > 1) }
  }
  const note = toolCallContextOf(result).join('\n\n')
  const withNote = (outcome: NestedToolOutcome): NestedToolOutcome =>
    note ? { ...outcome, data: `${outcome.data}\n${note}` } : outcome
  const relayed = typeof result.ref === 'number' ? runs.get(result.ref) : undefined
  if (relayed && (relayed.handed === undefined || serialized(result.result) === relayed.handed)) {
    return withNote(relayed.outcome)
  }
  return withNote({
    ok: result.isError !== true,
    data: params.serialize(result.result),
    raw: result.result,
    answeredByHook: true,
  })
}

export async function* runToolUseThroughMods(
  params: ToolCallThroughModsParams,
): AsyncGenerator<DeferredMessageUpdate, void> {
  const { mods, toolUse, tool, callContext: callContext } = params
  const callRef = toolUse.toolCallId
  const parent = callContext.cancelSource
  const tracker = createCoreRuns(params)
  const { core, live, runs, originalArgs } = tracker

  const event = toolCallEventOf(
    tool.name,
    callRef,
    originalArgs,
    callContext.agentId ?? params.agentId,
  )
  const settlement = yield* drainWithProgress(mods.toolCall(event, core, parent.signal), live)
  tracker.settled()
  const lastRun = tracker.last()

  // A halt is not an answer a hook can replace: the loop is suspended on it.
  const halted = [...runs.values()].find(run => run.halted)
  if (halted) {
    yield* halted.updates
    return
  }

  if (!settlement.settled || !isToolCallResult(settlement.result)) {
    // Abandoned (the turn was interrupted) or failed. The call still owes the
    // model a tool_result: what the last run produced, or core's own.
    const ran = lastRun as CoreRun | undefined
    if (ran) {
      yield* ran.updates
    } else {
      yield* params.runCore(toolUse, callContext)
    }
    return
  }

  const result = settlement.result as {
    deny?: unknown
    result?: unknown
    ref?: unknown
    isError?: unknown
  }

  if (typeof result.deny === 'string') {
    traceLine(`[tool] ${tool.name} denied by a tool.call hook (${callRef})`, {
      level: 'info',
    })
    yield {
      message: await params.buildResultMessage({
        data: deniedText(tool.name, result.deny, tracker.started()),
        isError: true,
        args: originalArgs,
      }),
    }
    return
  }

  const relayed = typeof result.ref === 'number' ? runs.get(result.ref) : undefined
  const isVerbatim =
    relayed !== undefined &&
    (relayed.handed === undefined || serialized(result.result) === relayed.handed)

  if (relayed && isVerbatim) {
    yield* relayed.updates
  } else {
    // The hook's own answer. It replaces what the model reads; whatever else
    // the last run produced stands, because that run happened.
    const ran = lastRun as CoreRun | undefined
    const message = await params.buildResultMessage({
      data: result.result,
      isError: result.isError === true,
      args: ran?.args ?? originalArgs,
    })
    let isReplaced = false
    for (const update of ran?.updates ?? []) {
      if (!isReplaced && update.message && params.readResultMessage(update.message)) {
        isReplaced = true
        yield { ...update, message }
        continue
      }
      yield update
    }
    if (!isReplaced) yield { message }
  }

  const context = toolCallContextOf(result)
  if (context.length > 0) {
    yield { message: params.buildContextMessage(context.join('\n\n')) }
  }
}
