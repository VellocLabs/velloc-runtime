/**
 * Contract: feeds events to `advanceTurn`, yields each transition's rows, runs effects one at a time and
 * turns each completion into the next event; streamed rows pass through. A thrown error is fed as
 * `crashed`, committed, then rethrown. Cancellation is observed after the model call and the tool batch.
 */
import type { QueryTerminal } from '../runtime/RuntimeTypes'
import type { TurnEffect, TurnEvent, TurnPolicies, TurnState } from './turnEffects'
import type { TurnConclusion } from './turnOutcome'
import { advanceTurn, defaultTurnPolicies } from './turnLoop'
import { runnerFor } from './effectRunners'
import { checkRecorded, guardTransition, consistent } from './turnInvariants'
import { ambientWithIds, type Ambient } from './ambient'
import { idReserveFor } from './idReserve'
import { getBlockingLimitTokens, outputBudgetOf } from './contextWindow'
import { assembleTurnDependencies } from './turn/turnDependencies'
import {
  mintRow,
  snapshotLedger,
  withLiveLedger,
  writeLedger,
  type LoopYield,
  type TurnEnvironment,
  type TurnLoopInput,
} from './turnEnvironment'

/** Passes a runner's stream through, noting the id of every row it yields. */
async function* noting<T>(
  source: AsyncGenerator<LoopYield, T>,
  recorded: Set<string>,
): AsyncGenerator<LoopYield, T> {
  for (;;) {
    const step = await source.next()
    if (step.done) return step.value
    note(recorded, step.value)
    yield step.value
  }
}

function note(recorded: Set<string>, row: unknown): void {
  const id = (row as { uuid?: unknown } | null)?.uuid
  if (typeof id === 'string') recorded.add(id)
}

export type { LoopYield, RefreshedPromptContext, SystemPromptRenderer, TurnLoopInput } from './turnEnvironment'

type LoopServices = { deps: TurnEnvironment['deps']; ambient: Ambient; idsThroughMods?: true }

function openServices(input: TurnLoopInput): LoopServices {
  const ctx = input.callContext
  // A foreground fork borrows the model call and the summarizer its parent
  // published on the call context; both are bound to the parent's scope.
  const borrowedModel = input.useRememberedCallModel ? ctx.options.callModel ?? undefined : undefined
  const borrowedSummarizer = input.useRememberedCallModel ? ctx.options.autocompact ?? undefined : undefined
  const deps = input.deps ?? (borrowedModel
    ? assembleTurnDependencies(undefined, { callModel: borrowedModel, ...(borrowedSummarizer ? { autocompact: borrowedSummarizer } : {}) })
    : assembleTurnDependencies())
  return { deps, ambient: input.ambient ?? ambientWithIds(() => deps.uuid(), input.runtimeConfig) }
}

function openEnvironment(input: TurnLoopInput, { deps, ambient, idsThroughMods }: LoopServices): TurnEnvironment {
  const ctx = input.callContext
  const stepTurnId = input.modTurnId ?? ambient.ids.turn()
  // The nesting depth is fixed for the whole run: one level below the caller.
  const chain = ctx.turnChain
    ? { chainId: ctx.turnChain.chainId, depth: ctx.turnChain.depth + 1 }
    : { chainId: ambient.ids.run(), depth: 0 }
  return { input, deps, ambient, ctx, chain, stepTurnId, stepIndex: 0, mintedIds: new Map(), prefetch: undefined, digest: undefined, ...(idsThroughMods ? { idsThroughMods } : {}) }
}

function openState(env: TurnEnvironment): TurnState {
  const { input, ctx } = env
  const model = ctx.options.mainLoopModel
  const sessionId = ctx.options.sessionId
  return {
    phase: 'running',
    sessionEpoch: 0,
    turnId: env.stepTurnId,
    caller: {
      turnCaller: input.turnCaller,
      ...(ctx.agentId !== undefined ? { agentId: ctx.agentId } : {}),
      isMainAgent: !!sessionId && !ctx.agentId,
    },
    limits: {
      maxTurns: input.stepLimit,
      servingModel: model,
      blockingLimitTokens: getBlockingLimitTokens(model, ctx.options.mainLoopProviderId),
      outputCeilingTokens: outputBudgetOf(model, input.providerId) ?? undefined,
    },
    k: 1,
    messages: input.messages,
    baseInstructions: input.baseInstructions,
    userAmbient: input.userAmbient,
    systemAmbient: input.systemAmbient,
    visibleTools: ctx.options.tools,
    fileReadLedger: new Map(ctx.fileReadLedger),
    nestedMemoryPathsSeen: new Set(ctx.nestedMemoryPathsSeen ?? []),
    loopLedger: ctx.agentLoopState ? snapshotLedger(ctx.agentLoopState) : undefined,
    autoCompactLedger: undefined,
    outputCapRetries: 0,
    outputTokenCapOverride: input.outputTokenCapOverride,
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
    ...(ctx.options.mods?.hasTurnContinueHooks?.() === true ? { continueRaised: true as const } : {}),
  }
}

function cancelledIfAborted(env: TurnEnvironment, effect: TurnEffect, answer: TurnEvent): TurnEvent {
  if (effect.kind !== 'requestModel' && effect.kind !== 'runToolBatch') return answer
  const signal = env.ctx.cancelSource.signal
  if (!signal.aborted) return answer
  return { type: 'cancelled', cause: signal.reason === 'interrupt' ? 'followUp' : 'user', partial: answer }
}

function terminalOf(conclusion: TurnConclusion): QueryTerminal {
  if (conclusion.kind === 'crash') throw conclusion.error
  return conclusion.outcome as unknown as QueryTerminal
}

export async function* runTurnLoop(
  input: TurnLoopInput,
  policies: TurnPolicies = defaultTurnPolicies,
): AsyncGenerator<LoopYield, QueryTerminal> {
  const services = openServices(input)
  const signal = input.callContext.cancelSource.signal
  const reserve = idReserveFor(input.callContext.options.mods, services.ambient, input.messages)
  if (reserve) Object.assign(services, { ambient: await reserve.open(signal), idsThroughMods: true })
  const env = openEnvironment(input, services)
  let state = openState(env)
  const queue: TurnEffect[] = []
  let event: TurnEvent = { type: 'begin' }
  // Ids of the rows the caller already holds or this loop yielded.
  const recorded = new Set<string>()
  for (const row of input.messages) note(recorded, row)
  try {
    for (;;) {
      const t = guardTransition(state, event, advanceTurn(state, event, policies))
      state = t.state
      if (state.loopLedger && env.ctx.agentLoopState) writeLedger(env.ctx.agentLoopState, state.loopLedger)
      for (const out of t.outputs) {
        const row = mintRow(env, out.message)
        note(recorded, row)
        yield row
      }
      queue.push(...t.effects)
      const effect = queue.shift()
      if (!effect) {
        consistent(false, `the turn machine asked for nothing after ${event.type}`, true)
        continue
      }
      if (effect.kind === 'commitTerminal') {
        if (input.commitTerminal) await input.commitTerminal(effect.conclusion)
        return terminalOf(effect.conclusion)
      }
      if (effect.kind === 'requestModel') checkRecorded(effect.k, effect.messages, recorded, env.mintedIds)
      if (reserve) await reserve.fill(signal)
      const answer = yield* noting(runnerFor(effect)(effect, env, state), recorded)
      event = withLiveLedger(env, cancelledIfAborted(env, effect, answer))
    }
  } catch (error) {
    if (state.phase === 'running') {
      state = advanceTurn(state, { type: 'crashed', error }, policies).state
      if (input.commitTerminal && state.conclusion) {
        try {
          await input.commitTerminal(state.conclusion)
        } catch {
          // The error that ended the turn is the one the caller gets.
        }
      }
    }
    throw error
  } finally {
    if (reserve) input.callContext.options.mods?.report?.(reserve.summary())
  }
}
