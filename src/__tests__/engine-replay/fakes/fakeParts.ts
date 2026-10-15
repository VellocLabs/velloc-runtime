/**
 * Fake external parts for the state-machine tests: a scripted model and a
 * scripted tool runner that answer effects with `TurnEvent`s, a responder
 * that routes every effect kind, a recording extensions holder, and a
 * builder for a plain starting `TurnState`.
 */
import type {
  BackgroundKind,
  EffectIdentity,
  ModelFailureKind,
  ToolBatchUpdate,
  ToolResultDigest,
  TurnEffect,
  TurnEvent,
  TurnState,
} from '../../../engine/turnEffects'
import { noTurnExtensions, type TurnExtensions } from '../../../engine/extensionSeam'
import type { QueryToolUseBlock } from '../../../runtime/interfaces/QueryRuntimeDeps'
import type { ModelReplyRow, Message } from '../../../runtime/RuntimeTypes'
import { MSG_TYPE_ASSISTANT, PART_TOOL_CALL, ROLE_ASSISTANT } from '../../../runtime/VercelModelConstants'
import type { EffectContext, EffectResponder } from './fakeInterpreter'

// -- state ------------------------------------------------------------------

export function startingTurnState(overrides: Partial<TurnState> = {}): TurnState {
  return {
    phase: 'running',
    sessionEpoch: 1,
    turnId: 'turn-1',
    caller: { turnCaller: 'repl_main_thread', isMainAgent: true },
    limits: {},
    k: 1,
    messages: [],
    baseInstructions: [],
    userAmbient: {},
    systemAmbient: {},
    visibleTools: [],
    fileReadLedger: new Map(),
    nestedMemoryPathsSeen: new Set(),
    loopLedger: undefined,
    autoCompactLedger: undefined,
    outputCapRetries: 0,
    outputTokenCapOverride: undefined,
    reactiveCompactTried: false,
    inStopHook: false,
    lastContinuation: undefined,
    stepReplies: [],
    stepToolCalls: [],
    stepResults: [],
    pendingHalts: [],
    pendingMessages: undefined,
    awaiting: undefined,
    background: [],
    nextEffectOrdinal: 1,
    conclusion: undefined,
    ...overrides,
  }
}

// -- model ------------------------------------------------------------------

export type ModelStep =
  | { readonly reply: string; readonly toolCalls?: readonly { id: string; name: string; args?: unknown }[] }
  | { readonly fail: ModelFailureKind; readonly error?: string }

export function assistantReply(text: string, toolCalls: readonly { id: string; name: string; args?: unknown }[] = []): ModelReplyRow {
  return {
    type: MSG_TYPE_ASSISTANT,
    message: {
      role: ROLE_ASSISTANT,
      content: [
        { type: 'text', text },
        ...toolCalls.map((c) => ({ type: PART_TOOL_CALL, toolCallId: c.id, toolName: c.name, args: c.args })),
      ],
    },
  } as ModelReplyRow
}

/** Answers `requestModel` effects from a script, in order. Throws when the
 *  script runs out, so an unexpected extra request fails the test. */
export function scriptedModel(steps: readonly ModelStep[]): {
  answer: (effect: Extract<TurnEffect, { kind: 'requestModel' }>, ctx: EffectContext) => TurnEvent
  readonly requests: Extract<TurnEffect, { kind: 'requestModel' }>[]
} {
  const queue = [...steps]
  const requests: Extract<TurnEffect, { kind: 'requestModel' }>[] = []
  return {
    requests,
    answer(effect, ctx) {
      requests.push(effect)
      if (ctx.aborted) return { type: 'modelFailed', kind: 'aborted', replies: [], identity: effect.identity }
      const step = queue.shift()
      if (!step) throw new Error(`scriptedModel: no reply scripted for request k=${effect.k}`)
      if ('fail' in step) {
        return { type: 'modelFailed', kind: step.fail, replies: [], identity: effect.identity, ...(step.error !== undefined ? { error: step.error } : {}) }
      }
      const calls = step.toolCalls ?? []
      const toolCalls: QueryToolUseBlock[] = calls.map((c) => ({ type: PART_TOOL_CALL, toolCallId: c.id, toolName: c.name, args: c.args }))
      return { type: 'modelStreamed', replies: [assistantReply(step.reply, calls)], toolCalls, identity: effect.identity }
    },
  }
}

// -- tools ------------------------------------------------------------------

export type FakeToolAnswer = {
  readonly text?: string
  readonly isError?: boolean
  /** The call halts for the user instead of answering. */
  readonly halt?: boolean
}

export function toolResultRow(toolCallId: string, text: string, isError: boolean): Message {
  return { type: 'user', message: { role: 'user', content: [{ type: 'tool-result', toolCallId, isError, output: text }] } }
}

/** Answers `runToolBatch` effects: each call by tool name from `byName`
 *  (default: an empty success), in call order. */
export function fakeToolRunner(byName: Readonly<Record<string, FakeToolAnswer>> = {}): {
  answer: (effect: Extract<TurnEffect, { kind: 'runToolBatch' }>, ctx: EffectContext) => TurnEvent
  readonly batches: Extract<TurnEffect, { kind: 'runToolBatch' }>[]
} {
  const batches: Extract<TurnEffect, { kind: 'runToolBatch' }>[] = []
  return {
    batches,
    answer(effect, ctx) {
      batches.push(effect)
      const updates: ToolBatchUpdate[] = []
      const results: ToolResultDigest[] = []
      for (const call of effect.calls) {
        const a = byName[call.toolName] ?? {}
        if (a.halt) {
          updates.push({ kind: 'halt', pending: { toolUseId: call.toolCallId, toolName: call.toolName } })
          continue
        }
        const isError = ctx.aborted || a.isError === true
        const text = ctx.aborted ? 'Interrupted by user' : (a.text ?? '')
        updates.push({ kind: 'row', message: toolResultRow(call.toolCallId, text, isError) })
        results.push({ toolCallId: call.toolCallId, isError, content: text })
      }
      return { type: 'toolBatchDone', updates, results, cancelled: ctx.aborted, identity: effect.identity }
    },
  }
}

// -- routing ----------------------------------------------------------------

export type FakeParts = {
  readonly model?: ReturnType<typeof scriptedModel>
  readonly tools?: ReturnType<typeof fakeToolRunner>
  /** Overrides for any effect kind; return undefined to fall through. */
  readonly other?: (effect: TurnEffect, ctx: EffectContext) => TurnEvent | undefined
}

/** One responder for every serial effect kind. Unscripted kinds answer the
 *  neutral event (`effectDone`, nothing drained, stop hooks allow, …). */
export function routeEffects(parts: FakeParts): EffectResponder {
  return (effect, ctx) => {
    const custom = parts.other?.(effect, ctx)
    if (custom) return custom
    const identity = effect.identity
    switch (effect.kind) {
      case 'requestModel':
        if (!parts.model) throw new Error('routeEffects: requestModel with no scripted model')
        return parts.model.answer(effect, ctx)
      case 'runToolBatch':
        if (!parts.tools) throw new Error('routeEffects: runToolBatch with no fake tool runner')
        return parts.tools.answer(effect, ctx)
      case 'runPromptSubmitHooks':
        return { type: 'promptSubmitHooksDone', blocked: false, rows: [], identity }
      case 'summarizeForCompaction':
        return { type: 'contextFitted', messages: effect.messages, compacted: false, rows: [], identity }
      case 'drainQueuedInput':
        return { type: 'queuedInputDrained', rows: [], identity }
      case 'runStopHooks':
        return { type: 'stopHandled', preventContinuation: false, blockerRows: [], identity }
      case 'delay':
        return { type: 'timerElapsed', identity }
      case 'startBackground':
        return { type: 'backgroundStarted', identity }
      case 'gatherRows':
        return { type: 'rowsGathered', stage: effect.stage, rows: [], identity }
      case 'refreshPromptContext':
        return { type: 'promptContextRefreshed', injected: [], identity }
      case 'awaitBackground':
        return { type: 'backgroundSettled', kind: effect.background, value: null, identity }
      case 'raiseTurnContinue':
        return { type: 'turnContinued', pending: effect.pending, stop: false, identity }
      case 'persistRows':
      case 'pushHostSettings':
      case 'commitTerminal':
        return { type: 'effectDone', identity }
    }
  }
}

/** A background settle arrival's event. */
export function backgroundSettled(identity: EffectIdentity, kind: BackgroundKind, value: unknown): TurnEvent {
  return { type: 'backgroundSettled', kind, value, identity }
}

// -- extensions ---------------------------------------------------------------

/** A `TurnExtensions` that behaves like no extensions and records each call
 *  by member name, for asserting which seams the engine raised. */
export function recordingExtensions(): { extensions: TurnExtensions; calls: string[] } {
  const calls: string[] = []
  const base = noTurnExtensions() as unknown as Record<string, unknown>
  const wrapped: Record<string, unknown> = {}
  for (const [name, value] of Object.entries(base)) {
    wrapped[name] =
      typeof value === 'function'
        ? (...args: unknown[]) => {
            calls.push(name)
            return (value as (...a: unknown[]) => unknown)(...args)
          }
        : value
  }
  return { extensions: wrapped as unknown as TurnExtensions, calls }
}
