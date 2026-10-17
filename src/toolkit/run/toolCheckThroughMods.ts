/**
 * `tool.check` through the mods' chain (F-25): raised once over
 * `decideToolPermission`'s verdict, before the mode settles its first ask and
 * before the classic PreToolUse hooks. Security: a path-safety ask survives a
 * hook's `{ allow }`, reported, never silently dropped.
 */

import type { ToolContract } from '../toolContract'
import type { DispatchContext } from '../../mods/modTypes'
import {
  toolCheckEventOf,
  type ToolCheckResult,
} from '../../mods/toolCallEvent'
import { suggestAllowRule } from '../../permissions/ruleEngine'
import { traceLine } from '../../utils/debugLog'
import type { ToolCallExtensions } from '../toolExtensionSeam'
import type { ToolPermissionVerdict } from './toolPermissionGate'

/** The model's error for a hook's `{ decision: 'deny' }` with no reason. */
export const TOOL_CHECK_DENIED_TEXT = 'Permission denied by a plugin hook.'

/** What `tool.check` reports of a verdict: core's `{ decision, reason?, rule? }`. */
export function toolCheckResultOf(verdict: ToolPermissionVerdict): ToolCheckResult {
  return {
    decision: verdict.decision,
    ...(verdict.reason !== undefined ? { reason: verdict.reason } : {}),
    ...(verdict.rule !== undefined ? { rule: verdict.rule } : {}),
  }
}

/**
 * The verdict the chain settled on, as the flow acts on it. The same decision
 * as core's keeps core's verdict (its message, metadata and resume point); a
 * hook's deny carries its reason to the model; a hook's ask is one more ask
 * for the mode's decider, allowed into the call as approved; a hook's allow
 * runs the tool as the model asked — unless the ask it would clear is a
 * path-safety one, which stands.
 */
export function verdictOfToolCheck(
  verdict: ToolPermissionVerdict,
  answer: ToolCheckResult,
  tool: ToolContract,
  input: Record<string, unknown>,
  report: (line: string) => void,
): ToolPermissionVerdict {
  if (answer.decision === verdict.decision) {
    if (verdict.decision === 'deny' && answer.reason !== undefined && answer.reason !== verdict.reason) {
      return { ...verdict, message: answer.reason, reason: answer.reason }
    }
    return verdict
  }
  switch (answer.decision) {
    case 'allow': {
      if (verdict.decision === 'ask' && verdict.safety) {
        report(
          `mods: tool.check answered { allow } for ${tool.name}, but its ask is a path-safety check ` +
            `(${verdict.metadata?.reason ?? 'safety'}), which a hook cannot allow away; the call asks as before`,
        )
        return verdict
      }
      const updatedInput = verdict.decision === 'ask' ? verdict.requestedInput : input
      return {
        decision: 'allow',
        updatedInput,
        permissionResult: { behavior: 'allow', updatedInput },
        ...(answer.reason !== undefined ? { reason: answer.reason } : {}),
      }
    }
    case 'deny': {
      const message = answer.reason ?? TOOL_CHECK_DENIED_TEXT
      return {
        decision: 'deny',
        message,
        log: `[tool] ${tool.name} denied by a tool.check hook: ${message}`,
        reason: message,
      }
    }
    case 'ask': {
      const { suggestedRule, summary } = suggestAllowRule(tool.name, input)
      return {
        decision: 'ask',
        // On core's allow, the input it settled on (a tool's check may have
        // normalized it) is the one asked about and run.
        requestedInput: verdict.decision === 'allow' ? verdict.updatedInput : input,
        message: answer.reason ?? 'Permission required',
        metadata: { suggestedRule, summary },
        safety: false,
        resume: { stage: 'hook', ruleSet: undefined as never },
        ...(answer.reason !== undefined ? { reason: answer.reason } : {}),
      }
    }
  }
}

export type CheckToolThroughModsParams = {
  mods: Partial<Pick<ToolCallExtensions, 'hasToolCheckHooks' | 'toolCheck' | 'report' | 'agentId'>>
  tool: ToolContract
  input: Record<string, unknown>
  /** The engine's own verdict: core of the event. */
  verdict: ToolPermissionVerdict
  /** The call being decided; absent on a `$.tool.check` query. */
  callRef?: string
  /** The loop a real call is decided in (a sub-agent's, a teammate's);
   *  absent on the main loop and on a query. */
  agentId?: string
  signal?: AbortSignal
  /** Who raised it, when a plugin did (`$.tool.check`, or `tool.check`
   *  inside its `$.tool.call`): its `next.origin`, and the hook to skip. */
  context?: DispatchContext
  /** A `$.tool.check` query: raised even when no hook selects the event (the
   *  chain is then core alone). A call's check costs nothing without one. */
  always?: boolean
  /** The filesystem safety gate's ask for `input`, if any. Core's verdict may
   *  have stopped before that gate ran (a plan-mode or rule deny comes first),
   *  so a hook that lifts a deny or a plain ask is checked against it here:
   *  a hook cannot allow away a path-safety ask it never saw. */
  safetyAsk?: () => ToolPermissionVerdict | null
}

/**
 * Raise `tool.check` around `verdict`, when a hook selects it (or `always`,
 * for a plugin's query), and return the verdict the flow acts on. With no hook
 * on it, nothing is dispatched and `verdict` is returned as is; a chain that
 * fails or is abandoned leaves the engine's own verdict standing.
 */
export async function checkToolThroughMods(
  params: CheckToolThroughModsParams,
): Promise<ToolPermissionVerdict> {
  const { mods, tool, input, verdict, context } = params
  if (!mods.toolCheck) return verdict
  if (!params.always && mods.hasToolCheckHooks?.() !== true) return verdict
  const settlement = await mods.toolCheck(
    toolCheckEventOf(tool.name, input, params.callRef, params.agentId),
    async () => toolCheckResultOf(verdict),
    params.signal,
    context,
  )
  if (!settlement.settled) return verdict
  const report = (line: string) => {
    if (mods.report) mods.report(line)
    else traceLine(line, { level: 'info' })
  }
  let settled = verdictOfToolCheck(verdict, settlement.result, tool, input, report)
  const lifted =
    settled !== verdict &&
    settled.decision !== 'deny' &&
    verdict.decision !== 'allow' &&
    !(verdict.decision === 'ask' && verdict.safety)
  if (lifted && params.safetyAsk) {
    const safety = params.safetyAsk()
    if (safety) {
      report(
        `mods: tool.check answered { ${settled.decision} } for ${tool.name} over core's ${verdict.decision}, ` +
          `but the path-safety check asks (${safety.decision === 'ask' ? (safety.metadata?.reason ?? 'safety') : 'safety'}); ` +
          'a hook cannot allow it away, so the call asks',
      )
      settled = safety
    }
  }
  if (settled !== verdict) {
    traceLine(
      `[tool] ${tool.name} tool.check: core said ${verdict.decision}, the chain settled on ${settled.decision}`,
      { level: 'info' },
    )
  }
  return settled
}
