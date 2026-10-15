/**
 * `turn.request`: raised once per request series of a turn step (not side calls), after
 * `buildModelRequest` and before the first attempt; retries resend the settled request. A changed
 * `model`/`effort` rebuilds; a changed `system`/`messages`/`tools` replaces. Bodies are held while hooks
 * read; an unknown placeholder refuses that field. Never awaited without a hook.
 */
import type { QueryModelCallParams } from './modelCallTypes'
import type { ToolCallMods } from '../../mods/toolCallEvent'
import { effortOfTier, tierFromEffort } from '../../config/nexusModelConfig/providers/shared/listing'
import {
  holdBodies,
  isTurnRequestEffort,
  restoreBodies,
  systemTextOf,
  type TurnRequestInput,
} from '../../mods/turnRequestEvent'

/** What this reads of a built request (`modelTransport`'s `ModelRequest`,
 *  named structurally so the transport may import this module). */
type BuiltRequest = {
  payload: Record<string, unknown>
  facts: { effectiveModel: string; transcriptLength: number; toolCount: number }
  trace: { transcriptLength: number; toolCount: number }
}

type RequestMods = Pick<Partial<ToolCallMods>, 'hasTurnRequestHooks' | 'turnRequest' | 'report'>

function modsOf(params: QueryModelCallParams): RequestMods | undefined {
  return params.callContext.options.mods as RequestMods | undefined
}

/** Whether this call raises `turn.request`: a turn step's request, with a
 *  hook selecting the event. */
export function raisesTurnRequest(params: QueryModelCallParams): boolean {
  const mods = modsOf(params)
  return params.modStep !== undefined && !!mods?.turnRequest && mods.hasTurnRequestHooks?.() === true
}

function same(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b)
}

/**
 * The request to send for `params`: `built` as the chain settled it.
 * `rebuild` builds the request again for a changed model or tier.
 */
export async function requestThroughTurnRequest<R extends BuiltRequest>(
  built: R,
  params: QueryModelCallParams,
  rebuild: (params: QueryModelCallParams) => R,
): Promise<R> {
  const mods = modsOf(params)
  const place = params.modStep
  if (!place || !mods?.turnRequest || mods.hasTurnRequestHooks?.() !== true) return built
  const held = new Map<string, unknown>()
  const payload = built.payload
  const wireEffort = effortOfTier(params.thinkingTier)
  const effort = isTurnRequestEffort(wireEffort) ? wireEffort : undefined
  const e: TurnRequestInput = {
    turnId: place.turnId,
    index: place.index,
    model: built.facts.effectiveModel,
    ...(effort !== undefined ? { effort } : {}),
    system: systemTextOf(payload.systemPrompt),
    messages: holdBodies(payload.messages ?? [], held) as unknown[],
    tools: (payload.tools ?? []) as unknown[],
    ...(place.agentId !== undefined ? { agentId: place.agentId } : {}),
  }
  const rewrite = await mods.turnRequest(e, params.callContext.cancelSource.signal)
  if (!rewrite) return built
  const report = (line: string): void => mods.report?.(`mods: turn.request: ${line}`)

  const modelChanged = rewrite.model !== undefined && rewrite.model !== e.model
  const effortChanged = rewrite.effort !== undefined && rewrite.effort !== e.effort
  const base =
    modelChanged || effortChanged
      ? rebuild({
          ...params,
          ...(modelChanged ? { modelOverride: rewrite.model } : {}),
          ...(effortChanged ? { thinkingTier: tierFromEffort(rewrite.effort) ?? rewrite.effort } : {}),
        })
      : built
  const next: Record<string, unknown> = { ...base.payload }
  if (rewrite.system !== undefined && rewrite.system !== e.system) next.systemPrompt = rewrite.system
  if (rewrite.messages !== undefined && !same(rewrite.messages, e.messages)) {
    const restored = restoreBodies(rewrite.messages, held)
    if ('refused' in restored) report(`${restored.refused}; the messages are sent as built`)
    else next.messages = restored.value
  }
  if (rewrite.tools !== undefined && !same(rewrite.tools, e.tools)) next.tools = rewrite.tools
  const messageCount = Array.isArray(next.messages) ? next.messages.length : base.facts.transcriptLength
  const toolCount = Array.isArray(next.tools) ? next.tools.length : base.facts.toolCount
  return {
    ...base,
    payload: next,
    facts: { ...base.facts, transcriptLength: messageCount, toolCount },
    trace: { ...base.trace, transcriptLength: messageCount, toolCount },
  }
}
