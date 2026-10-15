import type { UserRow } from '../runtime/RuntimeTypes'
import type { ToolCallContext } from '../toolkit/toolCallContext'
import { fsForContext } from '../utils/fs/runtimeFs'
import { planDocPath } from '../utils/planFiles'
import { createGeneratedUserMessage } from './messageFactories'

const PLAN_BODY_LIMIT = 20_000
const TRUNCATION_MARKER = '[plan truncated]'

function capPlanBody(body: string): string {
  if (body.length <= PLAN_BODY_LIMIT) return body
  return `${body.slice(0, PLAN_BODY_LIMIT)}\n${TRUNCATION_MARKER}`
}

async function loadPlanBody(ctx: ToolCallContext, path: string): Promise<string | null> {
  try {
    return await fsForContext(ctx).readFile(path, { encoding: 'utf8' })
  } catch {
    return null
  }
}

function resolvePlanPath(ctx: ToolCallContext): string | null {
  try {
    return planDocPath(ctx)
  } catch {
    return null
  }
}

/**
 * After a compaction, hands the session's plan file back to the model so an
 * approved plan is not lost. Null when there is no usable plan.
 */
export async function createPostCompactPlanReferenceMessage(
  toolUseContext: ToolCallContext | undefined,
): Promise<UserRow | null> {
  if (!toolUseContext) return null
  const path = resolvePlanPath(toolUseContext)
  if (path === null) return null
  const body = await loadPlanBody(toolUseContext, path)
  if (body === null || body.trim() === '') return null

  const lines = [
    '<system-reminder>',
    `A plan file exists from plan mode at: ${path}`,
    '',
    'Plan contents:',
    '',
    capPlanBody(body),
    '',
    'Pick the plan back up only where it still applies to the task at hand and has steps left to do.',
    '</system-reminder>',
  ]
  return createGeneratedUserMessage(lines.join('\n'), { isMeta: true })
}
