/**
 * `turn.recover`: the retry ladder's `decideRetry` decision, replaceable by a hook, raised for every
 * attempt the ladder judges (not cancellation or prompt-too-long). The engine clamps a hook's answer:
 * no retry past the last attempt, wait bounded by `recoverDecisionOf`. Never awaited without a hook.
 */
import type { QueryModelCallParams } from './modelCallTypes'
import type { ToolCallMods } from '../../mods/toolCallEvent'
import type { TurnRecoverInput } from '../../mods/turnRecoverEvent'
import { classifyModelFailure, decideRetry, type RetryDecision, type RetryInput } from './retryLadder'

type RecoverMods = Pick<Partial<ToolCallMods>, 'hasTurnRecoverHooks' | 'turnRecover' | 'report'>

function modsOf(params: QueryModelCallParams): RecoverMods | undefined {
  return params.callContext.options.mods as RecoverMods | undefined
}

/** Whether a failure of this call raises `turn.recover`. */
export function raisesTurnRecover(params: QueryModelCallParams): boolean {
  const mods = modsOf(params)
  return params.modStep !== undefined && !!mods?.turnRecover && mods.hasTurnRecoverHooks?.() === true
}

/** The decision that stands for a failed attempt, through the chain; or
 *  undefined when the failure is not the ladder's to judge. */
export async function recoverThroughMods(
  params: QueryModelCallParams,
  error: unknown,
  ladder: Omit<RetryInput, 'failure' | 'caller' | 'cancelled'>,
): Promise<RetryDecision | undefined> {
  const mods = modsOf(params)
  const place = params.modStep
  if (!place || !mods?.turnRecover || mods.hasTurnRecoverHooks?.() !== true) return undefined
  const failure = classifyModelFailure(error)
  if (failure.kind === 'aborted' || failure.kind === 'prompt_too_long') return undefined
  const signal = params.callContext.cancelSource.signal
  const decision = decideRetry({ ...ladder, failure, caller: params.querySource, cancelled: signal.aborted })
  const e: TurnRecoverInput = {
    turnId: place.turnId,
    attempt: ladder.attempt,
    failure: {
      kind: failure.kind,
      message: failure.message,
      ...(failure.kind !== 'other' && failure.retryAfterMs !== undefined ? { retryAfterMs: failure.retryAfterMs } : {}),
    },
    decision,
    ...(place.agentId !== undefined ? { agentId: place.agentId } : {}),
  }
  const settled = await mods.turnRecover(e, signal)
  if (settled.retry && ladder.attempt >= ladder.maxAttempts) {
    mods.report?.(`mods: turn.recover asked for a retry after the last attempt (${ladder.attempt}); the call ends`)
    return { retry: false }
  }
  return settled
}
