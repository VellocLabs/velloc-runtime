/**
 * The per-request loop as a pure state machine (F-26): `advanceTurn` returns the next state, effects
 * and rows; no IO, clock, global, config or id minting. Interpreter: `turnInterpreter.ts`.
 */
import type { CallContextPatch, EffectIdentity, TurnEvent, TurnPolicies, TurnState, Transition } from './turnEffects'
import { isLastStep } from './loop/stepBudget'
import { conclude, finish, idle, openDraft, seal } from './turnStep'
import { onBegin, onPrefetchStarted, onPromptHooks, onTurnStartRows } from './turnAdmission'
import { issueModelRequest, onCompactionRows, onContextFitted } from './turnRequest'
import { onCancelled, onDigestSettled, onModelAnswer, onStopHandled } from './turnSettlement'
import { onAfterToolRows, onDrained, onRefreshed, onToolBatchDone } from './turnContinuation'
import { toolCallsOf } from './turnRows'
import { onTurnContinued } from './turnContinueStep'
import { TERMINAL_PROMPT_TOO_LONG } from '../runtime/VercelModelConstants'

/** Continue-after-cut requests allowed once the cap was raised. */
export const OUTPUT_CAP_RETRY_LIMIT = 3

export const defaultTurnPolicies: TurnPolicies = {
  fitContext: ({ estimatedTokens, contextWindow }) =>
    estimatedTokens >= contextWindow ? 'overBlockingLimit' : 'fits',
  // No nudges by default; the conversation engine supplies its policy.
  chooseNudge: () => undefined,
  stepBudget: ({ k, maxTurns }) => ({
    lastStep: isLastStep(k, maxTurns),
    reached: !!maxTurns && k + 1 > maxTurns,
  }),
  recoverOutputCap: ({ outputCapRetries, outputTokenCapOverride }) => {
    if (outputTokenCapOverride === undefined) return 'escalate'
    return outputCapRetries < OUTPUT_CAP_RETRY_LIMIT ? 'resume' : 'giveUp'
  },
}

function isStale(state: TurnState, identity: EffectIdentity): boolean {
  return identity.sessionEpoch !== state.sessionEpoch || identity.turnId !== state.turnId
}

/** Takes in what the effect's IO changed on the live call context. */
function adopt(state: TurnState, patch: CallContextPatch | undefined): TurnState {
  if (!patch) return state
  return {
    ...state,
    ...(patch.loopLedger ? { loopLedger: patch.loopLedger } : {}),
    ...(patch.visibleTools ? { visibleTools: patch.visibleTools } : {}),
    ...(patch.fileReadLedger ? { fileReadLedger: patch.fileReadLedger } : {}),
    ...(patch.nestedMemoryPathsSeen ? { nestedMemoryPathsSeen: patch.nestedMemoryPathsSeen } : {}),
  }
}

export function advanceTurn(state: Readonly<TurnState>, event: TurnEvent, policies: TurnPolicies): Transition {
  if (state.phase !== 'running') return idle(state)
  if (event.type === 'crashed') {
    const d = openDraft(state)
    conclude(d, { kind: 'crash', phase: 'failed', error: event.error })
    return seal(d)
  }
  if (event.type === 'begin') return onBegin(state)
  if (event.type === 'cancelled') return onCancelled(state, event)
  if (isStale(state, event.identity)) return idle(state)
  const s = adopt(state, event.patch)
  switch (event.type) {
    case 'promptSubmitHooksDone':
      return onPromptHooks(s, event)
    case 'rowsGathered':
      if (event.stage === 'turnStart') return onTurnStartRows(s, event.rows)
      if (event.stage === 'afterCompaction') return onCompactionRows(s, event.rows, policies, event.instructions)
      return onAfterToolRows(s, event.rows, policies)
    case 'backgroundStarted': {
      const entry = s.background.find((b) => b.identity.effectId === event.identity.effectId)
      return entry?.kind === 'memoryPrefetch' ? onPrefetchStarted(s, policies) : idle(s)
    }
    case 'contextFitted':
      return onContextFitted(s, event, policies)
    case 'contextFitFailed': {
      const d = openDraft(s)
      if (event.overBlockingLimit) finish(d, { reason: TERMINAL_PROMPT_TOO_LONG, turnCount: s.k })
      else issueModelRequest(d, policies)
      return seal(d)
    }
    case 'modelStreamed':
      return onModelAnswer(s, event.replies, event.toolCalls, policies)
    case 'modelFailed':
      return onModelAnswer(s, event.replies, event.replies.flatMap(toolCallsOf), policies, event.kind, event.error)
    case 'toolBatchDone':
      return event.cancelled
        ? onCancelled(s, { type: 'cancelled', cause: 'user', partial: event })
        : onToolBatchDone(s, event)
    case 'queuedInputDrained':
      return onDrained(s, event.rows, policies)
    case 'stopHandled':
      return onStopHandled(s, event, policies)
    case 'promptContextRefreshed':
      return onRefreshed(s, event, policies)
    case 'turnContinued':
      return onTurnContinued(s, event, policies)
    case 'backgroundSettled':
      // Only the answer to the machine's own wait counts; a settle reported
      // on its own is noted and otherwise ignored.
      return event.kind === 'toolDigest' && s.awaiting?.effectId === event.identity.effectId
        ? onDigestSettled(s, event.value)
        : idle(s)
    case 'timerElapsed':
    case 'effectDone':
      return idle(s)
  }
}
