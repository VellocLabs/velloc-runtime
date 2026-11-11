/**
 * One model call as its provider's `outcome` hook is told of it (F-27).
 *
 * Contract: `observeProviderCall` returns undefined for a provider whose
 * module has no `outcome` hook, and the call then costs nothing. Otherwise
 * the payload is marked so every stream of the call (each attempt of the
 * retry ladder) adds its facts, and `settle` raises the event once, when the
 * call is over. `settle` never throws and nothing waits for the hook.
 */
import {
  OUTCOME_CALL_FIELD,
  openOutcomeCall,
  outcomeEvent,
  raiseProviderOutcome,
} from '../../models/drivers/providerOutcome'
import { providerRequestSeamFor } from '../../models/drivers/providerRequestSeam'
import { classifyProviderConnectivityIssue } from '../../utils/providerConnectivity'

export type CallEnding = {
  ok: boolean
  /** What the last attempt failed with. */
  error?: unknown
  /** The call was cancelled, or abandoned by its reader. */
  aborted?: boolean
  /** Attempts the ladder made. */
  attempts: number
}

export type ObservedCall = {
  /** The payload with the call's mark; the mark is read by the stream host alone. */
  mark<T extends object>(payload: T): T
  settle(ending: CallEnding): void
}

export function observeProviderCall(providerId: string | undefined, model: string): ObservedCall | undefined {
  if (!providerId || !providerRequestSeamFor(providerId)?.outcome) return undefined
  const open = openOutcomeCall()
  const startedAt = Date.now()
  let settled = false
  return {
    mark: payload => ({ ...payload, [OUTCOME_CALL_FIELD]: open.key }),
    settle(ending) {
      if (settled) return
      settled = true
      const reported = open.close()
      try {
        const verdict = ending.ok || ending.aborted ? null : classifyProviderConnectivityIssue(ending.error)
        raiseProviderOutcome(
          providerRequestSeamFor(providerId),
          outcomeEvent(
            providerId,
            model,
            {
              ok: ending.ok,
              ...(verdict ? { verdict } : {}),
              ...(ending.aborted ? { aborted: true } : {}),
              attempts: ending.attempts,
              durationMs: Date.now() - startedAt,
            },
            reported,
          ),
        )
      } catch {
        // An observer: a failure to tell it changes nothing.
      }
    },
  }
}
