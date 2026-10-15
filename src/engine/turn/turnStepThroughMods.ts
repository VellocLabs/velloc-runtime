/**
 * `turn.step` (L2.5, F-25): with no hook this IS `callModel(params)`. With one, the engine's call is the
 * chain's bottom and the yielded messages are rebuilt from what leaves the outermost hook. Core errors
 * pass up unchanged; other rejections are reported and, if nothing was sent yet, the request goes out
 * without hooks.
 */

import type { Message } from '../../runtime/RuntimeTypes'
import type { QueryModelCallParams } from '../../runtime/interfaces/QueryRuntimeDeps'
import type { TurnExtensions } from '../extensionSeam'
import { tierFromEffort } from '../../config/nexusModelConfig/providers/shared/listing'
import {
  TurnStepAssembler,
  TurnStepRefs,
  hookMadeAssistant,
  modelChunks,
  turnStepEffortOf,
  type TurnStepChunk,
  type TurnStepInput,
  type TurnStepResult,
} from '../../mods/turnStepEvent'

/** What the model call needs of the session's extensions: the `turn.step`
 *  seam and its gate, and the report line. */
export type TurnStepMods = {
  hasTurnStepHooks?: TurnExtensions['hasTurnStepHooks']
  turnStep?: TurnExtensions['turnStep']
  report?: TurnExtensions['report']
}

/** Which step of which turn this call is. */
export type TurnStepPlace = {
  turnId: string
  index: number
  transcriptLength: number
  agentId?: string
}

export async function* callModelThroughTurnStep(
  callModel: (params: QueryModelCallParams) => AsyncGenerator<Message, void, unknown>,
  params: QueryModelCallParams,
  place: TurnStepPlace,
  mods: TurnStepMods | undefined,
  ids: { uuid(): string; timestamp(): string },
): AsyncGenerator<Message, void, unknown> {
  if (!mods?.turnStep || mods.hasTurnStepHooks?.() !== true) {
    yield* callModel(params)
    return
  }
  const model = params.modelOverride ?? params.callContext.options.mainLoopModel
  const effort = turnStepEffortOf(params.thinkingTier)
  const e: TurnStepInput = {
    turnId: place.turnId,
    index: place.index,
    model,
    ...(effort !== undefined ? { effort } : {}),
    messageCount: place.transcriptLength,
    ...(place.agentId !== undefined ? { agentId: place.agentId } : {}),
  }
  const refs = new TurnStepRefs()
  let coreStarted = false
  let coreFailure: { error: unknown } | undefined
  async function* watched(
    chunks: AsyncGenerator<TurnStepChunk, TurnStepResult, undefined>,
  ): AsyncGenerator<TurnStepChunk, TurnStepResult, undefined> {
    try {
      return yield* chunks
    } catch (error) {
      coreFailure = { error }
      throw error
    }
  }
  const core = (arrived: TurnStepInput): AsyncIterator<TurnStepChunk, TurnStepResult> => {
    coreStarted = true
    // A hook's rewrite goes out as the request's: another model is a
    // per-call model override (the provider is the step's), another effort
    // the thinking tier — one the engine has a tier for.
    const request: QueryModelCallParams = {
      ...params,
      ...(arrived.model !== model ? { modelOverride: arrived.model } : {}),
      ...(arrived.effort !== effort && typeof arrived.effort === 'string'
        ? { thinkingTier: tierFromEffort(arrived.effort) ?? arrived.effort }
        : {}),
    }
    return watched(modelChunks(callModel(request), refs, arrived))
  }
  const signal = params.callContext.cancelSource.signal
  const stream = mods.turnStep(e, core, signal)
  if (!stream) {
    yield* callModel(params)
    return
  }
  const assembler = new TurnStepAssembler(refs, () => hookMadeAssistant(ids.uuid(), ids.timestamp(), e.model))
  let sent = 0
  try {
    for await (const chunk of stream) {
      for (const message of assembler.push(chunk)) {
        sent += 1
        yield message
      }
    }
  } catch (error) {
    if (signal.aborted) {
      yield* assembler.finish()
      return
    }
    if (coreFailure && error === coreFailure.error) throw error
    const fallBack = sent === 0 && !coreStarted
    mods.report?.(
      `mods: turn.step failed: ${error instanceof Error ? error.message : String(error)}; ` +
        (fallBack ? 'the request is sent without its hooks' : 'the response ends where it stood'),
    )
    yield* assembler.finish()
    if (fallBack) yield* callModel(params)
    return
  }
  yield* assembler.finish()
}
