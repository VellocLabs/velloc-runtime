/**
 * Compile-time guards on the frozen contract: the mod runtime already
 * satisfies the engine's extension interfaces (so E4 can declare
 * `implements` without changing behaviour), and the outcome set is exactly
 * the ten terminal reasons.
 */
import { describe, expect, it } from 'vitest'
import type { ModRuntime } from '../../../mods/ModRuntime'
import type { TurnExtensions } from '../../../engine/extensionSeam'
import type { ToolCallExtensions } from '../../../toolkit/toolExtensionSeam'
import type { TurnOutcomeReason } from '../../../engine/turnOutcome'
import type { TurnEffectKind, TurnEventType } from '../../../engine/turnEffects'

type Assert<T extends true> = T
type Equal<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false

// The mod runtime is assignable to both seams.
export type ModRuntimeIsToolExtensions = Assert<ModRuntime extends ToolCallExtensions ? true : false>
export type ModRuntimeIsTurnExtensions = Assert<ModRuntime extends TurnExtensions ? true : false>

export type TenOutcomes = Assert<
  Equal<
    TurnOutcomeReason,
    | 'completed'
    | 'awaiting_user_interaction'
    | 'aborted_streaming'
    | 'prompt_rejected'
    | 'prompt_too_long'
    | 'max_output_tokens'
    | 'api_error'
    | 'stop_hook_prevented'
    | 'max_failures'
    | 'max_turns'
  >
>

export type EffectKinds = Assert<
  Equal<
    TurnEffectKind,
    | 'requestModel'
    | 'runToolBatch'
    | 'summarizeForCompaction'
    | 'drainQueuedInput'
    | 'runStopHooks'
    | 'runPromptSubmitHooks'
    | 'persistRows'
    | 'pushHostSettings'
    | 'delay'
    | 'startBackground'
    | 'commitTerminal'
    | 'gatherRows'
    | 'refreshPromptContext'
    | 'awaitBackground'
    | 'raiseTurnContinue'
  >
>

export type EventSet = Assert<
  Equal<
    TurnEventType,
    | 'begin'
    | 'promptSubmitHooksDone'
    | 'contextFitted'
    | 'contextFitFailed'
    | 'modelStreamed'
    | 'modelFailed'
    | 'toolBatchDone'
    | 'queuedInputDrained'
    | 'stopHandled'
    | 'timerElapsed'
    | 'backgroundStarted'
    | 'backgroundSettled'
    | 'effectDone'
    | 'cancelled'
    | 'rowsGathered'
    | 'promptContextRefreshed'
    | 'turnContinued'
    | 'crashed'
  >
>

describe('contract types', () => {
  it('compiles (the guards are type-level)', () => {
    expect(true).toBe(true)
  })
})
