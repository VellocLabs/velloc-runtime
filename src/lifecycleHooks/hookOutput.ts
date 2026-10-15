/**
 * Hook command output: the structured stdout JSON (fields of
 * `hookJsonToDecision`, validated by hand) and the exit-code protocol: 0 =
 * success, 2 = blocking (output surfaced to the model), other = non-blocking.
 */

export type HookPermissionDecision = 'allow' | 'deny' | 'ask' | 'passthrough'

/** A `PermissionRequest` hook's answer: allow, with a rewritten input or
 *  permission rules to add, or deny. A rule in `updatedPermissions` has the
 *  shape `{ toolName, ruleContent? }`. */
export type PermissionRequestDecision =
  | {
      behavior: 'allow'
      updatedInput?: Record<string, unknown>
      updatedPermissions?: unknown[]
    }
  | { behavior: 'deny'; message?: string; interrupt?: boolean }

export type HookSpecificOutput = {
  hookEventName?: string
  permissionDecision?: HookPermissionDecision
  permissionDecisionReason?: string
  additionalContext?: string
  /** `PermissionRequest`'s decision. */
  decision?: unknown
}

export type HookStdoutReply = {
  /** When false, the agent should stop instead of continuing (a block here). */
  continue?: boolean
  suppressOutput?: boolean
  stopReason?: string
  decision?: 'approve' | 'block'
  reason?: string
  systemMessage?: string
  hookSpecificOutput?: HookSpecificOutput
}

/**
 * Parse a hook's stdout. Returns the structured JSON when stdout is a JSON
 * object (only output that starts with `{` counts as structured), else null
 * — the caller then falls back to the exit-code protocol.
 */
export function readHookReply(stdout: string): HookStdoutReply | null {
  const trimmed = stdout.trim()
  if (!trimmed.startsWith('{')) {
    return null
  }
  try {
    const parsed: unknown = JSON.parse(trimmed)
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as HookStdoutReply
    }
  } catch {
    // Not valid JSON — treat as plain text (exit-code protocol applies).
  }
  return null
}

export type HookDecision =
  | { kind: 'block'; reason: string }
  | {
      kind: 'pass'
      systemMessage?: string
      additionalContext?: string
      permissionRequest?: PermissionRequestDecision
    }

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * `value` as a `PermissionRequest` decision, or undefined when it is not one
 * (accepted shapes: `behavior` `allow` with an optional `updatedInput` object and
 * `updatedPermissions` array, or `deny` with an optional `message` string and
 * `interrupt` boolean). A malformed decision is no decision.
 */
export function permissionRequestDecisionOf(
  value: unknown,
): PermissionRequestDecision | undefined {
  if (!isRecord(value)) return undefined
  if (value.behavior === 'allow') {
    const { updatedInput, updatedPermissions } = value
    if (updatedInput !== undefined && !isRecord(updatedInput)) return undefined
    if (updatedPermissions !== undefined && !Array.isArray(updatedPermissions)) return undefined
    return {
      behavior: 'allow',
      ...(updatedInput ? { updatedInput } : {}),
      ...(updatedPermissions ? { updatedPermissions } : {}),
    }
  }
  if (value.behavior === 'deny') {
    const { message, interrupt } = value
    if (message !== undefined && typeof message !== 'string') return undefined
    if (interrupt !== undefined && typeof interrupt !== 'boolean') return undefined
    return {
      behavior: 'deny',
      ...(message ? { message } : {}),
      ...(interrupt ? { interrupt } : {}),
    }
  }
  return undefined
}

/**
 * Map hook JSON to block/pass: `continue === false`, `decision: 'block'` or
 * PreToolUse `permissionDecision: 'deny'` block; anything else passes. A
 * PermissionRequest `decision` passes, carrying it. `systemMessage` and
 * `additionalContext` ride on the pass result.
 */
export function hookJsonToDecision(json: HookStdoutReply): HookDecision {
  if (json.continue === false) {
    return {
      kind: 'block',
      reason: json.stopReason || json.reason || 'Hook requested stop',
    }
  }

  const permissionDecision = json.hookSpecificOutput?.permissionDecision
  if (permissionDecision === 'deny') {
    return {
      kind: 'block',
      reason:
        json.hookSpecificOutput?.permissionDecisionReason
        || json.reason
        || 'Blocked by hook',
    }
  }

  if (json.decision === 'block') {
    return { kind: 'block', reason: json.reason || 'Blocked by hook' }
  }

  // A hookSpecificOutput `decision` is an answer only on a `PermissionRequest`
  // hook; on any other event it is ignored.
  const permissionRequest =
    json.hookSpecificOutput?.hookEventName === 'PermissionRequest'
      ? permissionRequestDecisionOf(json.hookSpecificOutput.decision)
      : undefined

  return {
    kind: 'pass',
    systemMessage: json.systemMessage,
    additionalContext: json.hookSpecificOutput?.additionalContext,
    ...(permissionRequest ? { permissionRequest } : {}),
  }
}
