/**
 * The `classic.*` events (F-25): the settings hooks as events BENEATH every plugin's
 * hooks, `e` being the hook's whole stdin input; `classic.PreToolUse` takes the
 * `tool.call` envelope and fires inside `tool.call`'s core. Pure shapes and the
 * mappings between a result and the executor's aggregate.
 */

import {
  permissionRequestDecisionOf,
  type PermissionRequestDecision,
} from '../lifecycleHooks/hookOutput'

/** The classic events Velloc raises: the ones with a production call site
 *  (`lifecycleHooks/runHooks.ts` wrappers that are actually called).
 *  `SessionStart`, `SessionEnd` (a `/clear` alone) and `SubagentStart`,
 *  `Notification` (the turn-end notice) and `StopFailure` (a
 *  turn an API error ended)
 *  (`lifecycleHooks/sessionLifecycleHooks.ts`), and `PermissionRequest` (a
 *  tool call's ask, `lifecycleHooks/permissionRequestHooks.ts`). The rest of `LIFECYCLE_EVENT_NAMES` have none, and are not raised. */
export const CLASSIC_EVENTS_RAISED = [
  'PreToolUse',
  'PostToolUse',
  'PostToolUseFailure',
  'UserPromptSubmit',
  'Stop',
  'SubagentStop',
  'PreCompact',
  'PostCompact',
  'SessionStart',
  'SessionEnd',
  'SubagentStart',
  'Notification',
  'StopFailure',
  'PermissionRequest',
] as const

export type ClassicEventRaised = (typeof CLASSIC_EVENTS_RAISED)[number]

/** `classic.<Event>` for each raised event, in the order above. */
export const CLASSIC_EVENT_NAMES: readonly string[] = CLASSIC_EVENTS_RAISED.map(
  event => `classic.${event}`,
)

/** What a `classic.<Event>` hook (PreToolUse aside) returns, and what core
 *  answers. `ref` is core's: it names the executor's run, whose aggregate
 *  (its warnings, its per-hook results) stays on the host side. */
export type ClassicResult = {
  block?: string
  preventContinuation?: true
  stopReason?: string
  additionalContext?: string[]
  sessionTitle?: string
  suppressOriginalPrompt?: true
  /** `classic.PermissionRequest`'s answer to the ask
   *  (`hookSpecificOutput.decision`). */
  decision?: PermissionRequestDecision
  ref?: number
}

/** What a `classic.PreToolUse` hook returns. */
export type PreToolUseResult = {
  allow?: true
  ask?: string
  deny?: string
  updatedInput?: Record<string, unknown>
  additionalContext?: string[]
  ref?: number
}

/** The slice of the executor's aggregate a call site reads. */
export type ClassicAggregate = {
  blocked: boolean
  errors: string[]
  warnings: string[]
  additionalContext: string[]
  systemMessages: string[]
  permissionRequest?: PermissionRequestDecision
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every(v => typeof v === 'string')
}

/** Whether a hook's return is a `classic.<Event>` result (PreToolUse aside). */
export function isClassicResult(value: unknown): boolean {
  if (!isRecord(value)) return false
  const { block, preventContinuation, stopReason, additionalContext, sessionTitle, suppressOriginalPrompt, decision, ref } = value
  return (
    (decision === undefined || permissionRequestDecisionOf(decision) !== undefined) &&
    (block === undefined || typeof block === 'string') &&
    (preventContinuation === undefined || preventContinuation === true) &&
    (stopReason === undefined || typeof stopReason === 'string') &&
    (additionalContext === undefined || isStringArray(additionalContext)) &&
    (sessionTitle === undefined || typeof sessionTitle === 'string') &&
    (suppressOriginalPrompt === undefined || suppressOriginalPrompt === true) &&
    (ref === undefined || typeof ref === 'number')
  )
}

/** Whether a hook's return is a `classic.PreToolUse` result: "one of
 *  `allow`, `ask`, `deny`, or none of them". */
export function isPreToolUseResult(value: unknown): boolean {
  if (!isRecord(value)) return false
  const { allow, ask, deny, updatedInput, additionalContext, ref } = value
  const decisions = [allow !== undefined, ask !== undefined, deny !== undefined].filter(Boolean).length
  if (decisions > 1) return false
  return (
    (allow === undefined || allow === true) &&
    (ask === undefined || typeof ask === 'string') &&
    (deny === undefined || typeof deny === 'string') &&
    (updatedInput === undefined || isRecord(updatedInput)) &&
    (additionalContext === undefined || isStringArray(additionalContext)) &&
    (ref === undefined || typeof ref === 'number')
  )
}

/** Core's answer from the executor's aggregate: a block becomes `block`
 *  (the errors joined, as the call sites join them), the contexts ride
 *  along; `systemMessages` and `warnings` stay with the run (`ref`). */
export function classicResultOfAggregate(aggregate: ClassicAggregate, ref: number): ClassicResult {
  return {
    ...(aggregate.blocked ? { block: aggregate.errors.join('\n') } : {}),
    ...(aggregate.additionalContext.length > 0 ? { additionalContext: [...aggregate.additionalContext] } : {}),
    ...(aggregate.permissionRequest ? { decision: aggregate.permissionRequest } : {}),
    ref,
  }
}

/** Core's answer for `classic.PreToolUse`: a block is a `deny`. */
export function preToolUseResultOfAggregate(aggregate: ClassicAggregate, ref: number): PreToolUseResult {
  return {
    ...(aggregate.blocked ? { deny: aggregate.errors.join('\n') } : {}),
    ...(aggregate.additionalContext.length > 0 ? { additionalContext: [...aggregate.additionalContext] } : {}),
    ref,
  }
}

/**
 * What the chain settled on, as the call site reads it: the executor's
 * aggregate when the result is core's own run (`ref` names it) and nothing
 * above changed it, else an aggregate built from the hook's answer — a
 * `block` (or a `deny`) is a block with that one error, the contexts and the
 * `decision` are the answer's. A hook's answer carries no warnings and no
 * per-hook results.
 */
export function aggregateOfClassicResult(
  result: ClassicResult | PreToolUseResult,
  runs: ReadonlyMap<number, ClassicAggregate>,
): ClassicAggregate {
  const run = result.ref !== undefined ? runs.get(result.ref) : undefined
  const block = 'deny' in result ? result.deny : (result as ClassicResult).block
  const decision =
    'decision' in result ? permissionRequestDecisionOf(result.decision) : undefined
  if (run) {
    const sameBlock = run.blocked ? block === run.errors.join('\n') : block === undefined
    const sameContext =
      (result.additionalContext ?? []).join('\u0000') === run.additionalContext.join('\u0000')
    const sameDecision = JSON.stringify(decision) === JSON.stringify(run.permissionRequest)
    if (sameBlock && sameContext && sameDecision) return run
  }
  return {
    blocked: block !== undefined,
    errors: block !== undefined ? [block] : [],
    warnings: run?.warnings ?? [],
    additionalContext: [...(result.additionalContext ?? [])],
    systemMessages: run?.systemMessages ?? [],
    ...(decision ? { permissionRequest: decision } : {}),
  }
}
