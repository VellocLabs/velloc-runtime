// Executes one assistant turn's tool calls in batches: adjacent concurrency-safe
// calls run in parallel (capped), any other call alone. Each call's hook /
// in-progress bracket closes exactly once however the stream ends.

import type {
  QueryRuntimeDeps,
  QueryToolUseBlock,
} from '../../runtime/interfaces/QueryRuntimeDeps'
import type { ModelReplyRow, Message } from '../../runtime/RuntimeTypes'
import {
  PART_TOOL_CALL,
  PART_TOOL_RESULT_CANONICAL,
} from '../../runtime/VercelModelConstants'
import { resolveToolByName, type AgentToolMeta, type ToolContract } from '../toolContract'
import { type PermissionDecider } from '../permissionVerdict'
import { type ToolCallContext } from '../toolCallContext'
import { executeToolCall, type DeferredMessageUpdate, type PendingToolUse } from './executeToolCall'
import { executePostToolUseHook, executePreToolUseHook } from './toolCallTelemetry'

/** What the batch runner calls for each call: the call itself and the
 *  telemetry bracket. Injected by tests; production uses the defaults. */
export type ToolBatchRunner = {
  executeCall: typeof executeToolCall
  before: typeof executePreToolUseHook
  after: typeof executePostToolUseHook
}

export const defaultToolBatchRunner: ToolBatchRunner = {
  executeCall: executeToolCall,
  before: executePreToolUseHook,
  after: executePostToolUseHook,
}

export type ToolBatchUpdate = {
  message?: Message
  newContext: ToolCallContext
  pendingToolUse?: PendingToolUse
}

const DEFAULT_PARALLEL_LIMIT = 10
const PARALLEL_LIMIT_ENV = 'VELLOC_MAX_TOOL_USE_CONCURRENCY'
/** Read by the transcript UI; the key and shape must not change. */
const BATCH_METADATA_KEY = 'toolBatch'

export type ToolBatch = { parallel: boolean; calls: QueryToolUseBlock[] }

type ContextChange = (context: ToolCallContext) => ToolCallContext

function parallelLimit(): number {
  const env = (globalThis as { process?: { env?: Record<string, string | undefined> } })
    .process?.env
  const parsed = Number.parseInt(env?.[PARALLEL_LIMIT_ENV] ?? '', 10)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_PARALLEL_LIMIT
}

function canRunInParallel(call: QueryToolUseBlock, tools: readonly ToolContract[]): boolean {
  const tool = resolveToolByName(tools as ToolContract[], call.toolName)
  if (!tool) return false
  try {
    if (tool.haltsForUser?.() === true) return false
    return Boolean(tool.parallelSafe((call.args ?? {}) as never))
  } catch {
    return false
  }
}

/**
 * Pure: split calls into batches. Adjacent calls that may run in parallel
 * (the tool exists, does not halt for the user, and calls its arguments
 * parallel-safe; a throwing check is unsafe) share a batch; every other call
 * is a batch of its own.
 */
export function planToolBatches(
  calls: readonly QueryToolUseBlock[],
  tools: readonly ToolContract[],
): ToolBatch[] {
  const batches: ToolBatch[] = []
  for (const call of calls) {
    const parallel = canRunInParallel(call, tools)
    const last = batches[batches.length - 1]
    if (parallel && last?.parallel) {
      last.calls.push(call)
    } else {
      batches.push({ parallel, calls: [call] })
    }
  }
  return batches
}

function contentParts(message: Message | undefined): unknown[] | undefined {
  const inner = (message as { message?: { content?: unknown } } | undefined)?.message
  return Array.isArray(inner?.content) ? inner.content : undefined
}

function isToolCallPart(part: unknown, toolCallId: string): part is Record<string, unknown> {
  if (!part || typeof part !== 'object') return false
  const record = part as Record<string, unknown>
  return record.type === PART_TOOL_CALL && record.toolCallId === toolCallId
}

function owningAssistantMessage(
  call: QueryToolUseBlock,
  modelReplies: ModelReplyRow[],
): ModelReplyRow | undefined {
  const owner = modelReplies.find(message =>
    contentParts(message)?.some(part => isToolCallPart(part, call.toolCallId)),
  )
  return owner ?? modelReplies[0]
}

function tagParallelBatch(
  calls: QueryToolUseBlock[],
  modelReplies: ModelReplyRow[],
  deps: QueryRuntimeDeps,
): void {
  const tag = { mode: 'concurrent' as const, batchId: deps.uuid(), batchSize: calls.length }
  const ids = new Set<string>()
  for (const call of calls) {
    ;(call as Record<string, unknown>)[BATCH_METADATA_KEY] = tag
    ids.add(call.toolCallId)
  }
  for (const message of modelReplies) {
    for (const part of contentParts(message) ?? []) {
      if (!part || typeof part !== 'object') continue
      const record = part as Record<string, unknown>
      if (record.type === PART_TOOL_CALL && ids.has(record.toolCallId as string)) {
        record[BATCH_METADATA_KEY] = tag
      }
    }
  }
}

function reportsErrorResult(message: Message | undefined): boolean {
  return (
    contentParts(message)?.some(part => {
      if (!part || typeof part !== 'object') return false
      const record = part as Record<string, unknown>
      return record.type === PART_TOOL_RESULT_CANONICAL && record.isError === true
    }) ?? false
  )
}

/**
 * Runs one call between its hooks. `hookContext` supplies the context the
 * hooks see (current context for solo calls, batch-start context for
 * parallel ones). The finally block is the single place the call is closed.
 */
async function* runSingleCall(
  call: QueryToolUseBlock,
  modelReplies: ModelReplyRow[],
  decidePermission: PermissionDecider,
  startContext: ToolCallContext,
  hookContext: () => ToolCallContext,
  deps: QueryRuntimeDeps,
  runner: ToolBatchRunner,
): AsyncGenerator<DeferredMessageUpdate, void> {
  const id = call.toolCallId
  startContext.markCallsInFlight(prev => new Set(prev).add(id))
  const release = () =>
    startContext.markCallsInFlight(prev => {
      const next = new Set(prev)
      next.delete(id)
      return next
    })

  const modelReply = owningAssistantMessage(call, modelReplies)
  if (!modelReply) {
    release()
    return
  }

  // Known quirk, kept: the block has no `input` field (its arguments are
  // `args`), so the telemetry always receives undefined here.
  await runner.before(hookContext(), call.toolName, (call as { input?: unknown }).input)
  let lastMeta: AgentToolMeta | undefined
  let succeeded = true
  try {
    for await (const update of runner.executeCall(call, modelReply, decidePermission, startContext, deps)) {
      if (update.agentMeta) lastMeta = update.agentMeta
      if (reportsErrorResult(update.message)) succeeded = false
      yield update
    }
  } catch (error) {
    succeeded = false
    throw error
  } finally {
    try {
      await runner.after(hookContext(), call.toolName, lastMeta, succeeded)
    } finally {
      release()
    }
  }
}

type Lane = {
  index: number
  iterator: AsyncGenerator<DeferredMessageUpdate, void>
}

type LaneStep = { lane: Lane; result: IteratorResult<DeferredMessageUpdate, void> }

async function* runParallelBatch(
  calls: QueryToolUseBlock[],
  modelReplies: ModelReplyRow[],
  decidePermission: PermissionDecider,
  context: ToolCallContext,
  deps: QueryRuntimeDeps,
  runner: ToolBatchRunner,
): AsyncGenerator<ToolBatchUpdate, { halted: boolean; context: ToolCallContext }> {
  const limit = parallelLimit()
  const changesByCall: ContextChange[][] = calls.map(() => [])
  const inFlight = new Map<Lane, Promise<LaneStep>>()
  let nextIndex = 0

  const advance = (lane: Lane) => {
    const step = lane.iterator.next().then(result => ({ lane, result }))
    // Keep a rejected step from surfacing as unhandled if the batch is
    // closed before it is awaited.
    step.catch(() => {})
    inFlight.set(lane, step)
  }
  const openLane = () => {
    const index = nextIndex++
    const iterator = runSingleCall(
      calls[index]!,
      modelReplies,
      decidePermission,
      context,
      () => context,
      deps,
      runner,
    )
    advance({ index, iterator })
  }

  try {
    while (nextIndex < calls.length && inFlight.size < limit) openLane()
    while (inFlight.size > 0) {
      const { lane, result } = await Promise.race(inFlight.values())
      if (result.done) {
        inFlight.delete(lane)
        if (nextIndex < calls.length) openLane()
        continue
      }
      const update = result.value
      if (update.contextPatch) {
        changesByCall[lane.index]!.push(update.contextPatch.modifyContext)
      }
      yield { message: update.message, newContext: context, pendingToolUse: update.pendingToolUse }
      if (update.pendingToolUse) {
        inFlight.delete(lane)
        await lane.iterator.return(undefined)
        return { halted: true, context }
      }
      advance(lane)
    }
  } finally {
    // Close every lane still open (consumer stopped, a sibling threw, or a
    // halt). Each lane's own finally runs its post-hook exactly once.
    const open = [...inFlight.keys()]
    inFlight.clear()
    await Promise.allSettled(open.map(lane => lane.iterator.return(undefined)))
  }

  let updated = context
  for (const changes of changesByCall) {
    for (const change of changes) updated = change(updated)
  }
  yield { newContext: updated }
  return { halted: false, context: updated }
}

async function* runSoloCall(
  call: QueryToolUseBlock,
  modelReplies: ModelReplyRow[],
  decidePermission: PermissionDecider,
  context: ToolCallContext,
  deps: QueryRuntimeDeps,
  runner: ToolBatchRunner,
): AsyncGenerator<ToolBatchUpdate, { halted: boolean; context: ToolCallContext }> {
  let current = context
  const updates = runSingleCall(call, modelReplies, decidePermission, context, () => current, deps, runner)
  for await (const update of updates) {
    if (update.contextPatch) current = update.contextPatch.modifyContext(current)
    yield { message: update.message, newContext: current, pendingToolUse: update.pendingToolUse }
    if (update.pendingToolUse) return { halted: true, context: current }
  }
  return { halted: false, context: current }
}

/**
 * Runs `calls` batch by batch and streams every update. The stream ends
 * early, right after the update that carries a `pendingToolUse`.
 */
export async function* runToolBatch(
  calls: QueryToolUseBlock[],
  modelReplies: ModelReplyRow[],
  decidePermission: PermissionDecider,
  context: ToolCallContext,
  deps: QueryRuntimeDeps,
  runner: ToolBatchRunner = defaultToolBatchRunner,
): AsyncGenerator<ToolBatchUpdate, void> {
  let current = context
  for (const batch of planToolBatches(calls, context.options.tools)) {
    let outcome: { halted: boolean; context: ToolCallContext }
    if (batch.parallel) {
      if (batch.calls.length > 1) tagParallelBatch(batch.calls, modelReplies, deps)
      outcome = yield* runParallelBatch(batch.calls, modelReplies, decidePermission, current, deps, runner)
    } else {
      outcome = yield* runSoloCall(batch.calls[0]!, modelReplies, decidePermission, current, deps, runner)
    }
    if (outcome.halted) return
    current = outcome.context
  }
}
