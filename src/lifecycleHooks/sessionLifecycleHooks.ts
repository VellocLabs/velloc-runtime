/**
 * Session-lifecycle classic hooks (`SessionStart`, `SessionEnd`,
 * `SubagentStart`, `Notification`, `StopFailure`; F-7, F-25). Start hooks'
 * `additionalContext` becomes one meta user message; blocking is ignored.
 * Runners never reject and run nothing without a session id.
 */

import type { ToolCallContext } from '../toolkit/toolCallContext'
import type { ModelReplyRow, Message } from '../runtime/RuntimeTypes'
import { createGeneratedUserMessage } from '../messages/messageFactories'
import { traceLine } from '../utils/debugLog'
import { runClassicHooks } from './classicThroughMods'
import type { DispatchContext } from '../mods/modTypes'
import {
  fireAlertRaised,
  fireSessionClosed,
  fireSessionOpened,
  fireTurnFailed,
  fireChildAgentStarted,
  type HookBatchVerdict,
} from './runHooks'
import { buildHookInput } from './hookInput'
import { createBashHookCommandRunner } from './hookCommandRunner'
import { createModelHookPromptRunner } from './hookPromptRunner'
import { createForkedAgentHookRunner } from './hookAgentRunner'
import { createNetworkHookHttpRunner } from './hookHttpRunner'

/** Why a `SessionStart` hook fires: a new session, a resume, a clear, or a compaction. */
export type SessionStartSource = 'startup' | 'resume' | 'clear' | 'compact'

/** The runners and the stdin context every lifecycle event shares. */
function hookRunners(toolUseContext: ToolCallContext, sessionId: string) {
  const appState = toolUseContext.readAppState()
  return {
    sessionId,
    appState,
    setAppState: toolUseContext.writeAppState,
    signal: toolUseContext.cancelSource.signal,
    commandRunner: createBashHookCommandRunner(toolUseContext),
    promptRunner: createModelHookPromptRunner(toolUseContext),
    agentRunner: createForkedAgentHookRunner(toolUseContext),
    httpRunner: createNetworkHookHttpRunner(toolUseContext),
    hookInput: {
      cwd: toolUseContext.options.cwd,
      projectRoot: toolUseContext.options.projectRoot,
      permissionMode: appState.permissionRules?.mode,
    },
  }
}

/** The hooks' context and notes as one meta user message, or none. */
function contextRows(result: HookBatchVerdict): Message[] {
  const injected = [...result.additionalContext, ...result.systemMessages]
  if (injected.length === 0) return []
  return [createGeneratedUserMessage(injected.join('\n\n'), { isMeta: true })]
}

async function settle(
  event: string,
  run: () => Promise<HookBatchVerdict>,
): Promise<HookBatchVerdict | undefined> {
  try {
    return await run()
  } catch (error) {
    traceLine(
      `[hooks] ${event} hooks failed: ${error instanceof Error ? error.message : String(error)}`,
      { level: 'warn' },
    )
    return undefined
  }
}

/**
 * `SessionStart` for the main thread of `toolUseContext`'s session: the rows
 * its hooks' context adds (empty when none ran or none answered). Matched on
 * `source`; stdin `{ source, model }`.
 */
export async function runSessionStartHooks(
  source: SessionStartSource,
  toolUseContext: ToolCallContext,
): Promise<Message[]> {
  const sessionId = toolUseContext.options.sessionId
  if (!sessionId || toolUseContext.agentId) return []
  const runners = hookRunners(toolUseContext, sessionId)
  const model = toolUseContext.options.mainLoopModel
  const result = await settle('SessionStart', () =>
    runClassicHooks(
      toolUseContext.options.mods,
      'SessionStart',
      () =>
        buildHookInput({
          event: 'SessionStart',
          sessionId,
          cwd: runners.hookInput.cwd,
          permissionMode: runners.hookInput.permissionMode,
          toolName: source,
          model,
        }),
      () =>
        fireSessionOpened({
          ...runners,
          source,
          hookInput: { ...runners.hookInput, model },
        }),
      runners.signal,
    ),
  )
  return result ? contextRows(result) : []
}

/**
 * `SessionEnd` for `toolUseContext`'s session: informational — matched on
 * `reason`, stdin `{ reason }`, the outcome ignored. Awaited, so it runs
 * before the conversation it ends is wiped.
 */
export async function runSessionEndHooks(
  reason: string,
  toolUseContext: ToolCallContext,
): Promise<void> {
  const sessionId = toolUseContext.options.sessionId
  if (!sessionId || toolUseContext.agentId) return
  const runners = hookRunners(toolUseContext, sessionId)
  await settle('SessionEnd', () =>
    runClassicHooks(
      toolUseContext.options.mods,
      'SessionEnd',
      () =>
        buildHookInput({
          event: 'SessionEnd',
          sessionId,
          cwd: runners.hookInput.cwd,
          permissionMode: runners.hookInput.permissionMode,
          toolName: reason,
        }),
      () => fireSessionClosed({ ...runners, reason }),
      runners.signal,
    ),
  )
}

/**
 * `SubagentStart` for a fork about to run under `agentId`: the rows its
 * hooks' context adds to the fork's opening messages. Run with the PARENT's
 * context (the fork's own has not started). Matched on the agent id, as
 * Velloc's `SubagentStop` is; stdin `{ agent_id, agent_type }`.
 */
export async function runSubagentStartHooks(
  agentId: string,
  agentType: string | undefined,
  toolUseContext: ToolCallContext,
): Promise<Message[]> {
  const sessionId = toolUseContext.options.sessionId
  if (!sessionId) return []
  const runners = hookRunners(toolUseContext, sessionId)
  const result = await settle('SubagentStart', () =>
    runClassicHooks(
      toolUseContext.options.mods,
      'SubagentStart',
      () =>
        buildHookInput({
          event: 'SubagentStart',
          sessionId,
          cwd: runners.hookInput.cwd,
          permissionMode: runners.hookInput.permissionMode,
          toolName: agentId,
          ...(agentType ? { agentType } : {}),
        }),
      () =>
        fireChildAgentStarted({
          ...runners,
          agentId,
          hookInput: { ...runners.hookInput, ...(agentType ? { agentType } : {}) },
        }),
      runners.signal,
    ),
  )
  return result ? contextRows(result) : []
}

/** What a `Notification` hook is told about the notification going out.
 *  `raisedBy`: a plugin's own `$.ui.notify`, whose calling hook is skipped. */
export type HookNotification = { message: string; title?: string; notificationType: string; raisedBy?: DispatchContext }

/**
 * `Notification` for `toolUseContext`'s session: informational — matched on
 * `notification_type`, stdin `{ message, title?, notification_type }`, the
 * outcome ignored. The session manager asks the session's runtime to run it
 * where it publishes a notification
 * (`SharedWorkerSessionManager.maybeNotifyTurnEnd`).
 */
export async function runNotificationHooks(
  notification: HookNotification,
  toolUseContext: ToolCallContext,
): Promise<void> {
  const sessionId = toolUseContext.options.sessionId
  if (!sessionId || toolUseContext.agentId) return
  const runners = hookRunners(toolUseContext, sessionId)
  const text = {
    message: notification.message,
    ...(notification.title ? { title: notification.title } : {}),
  }
  await settle('Notification', () =>
    runClassicHooks(
      toolUseContext.options.mods,
      'Notification',
      () =>
        buildHookInput({
          event: 'Notification',
          sessionId,
          cwd: runners.hookInput.cwd,
          permissionMode: runners.hookInput.permissionMode,
          toolName: notification.notificationType,
          ...text,
        }),
      () =>
        fireAlertRaised({
          ...runners,
          notificationType: notification.notificationType,
          hookInput: { ...runners.hookInput, ...text },
        }),
      runners.signal,
      notification.raisedBy,
    ),
  )
}

/** The error kinds a `StopFailure` matcher can see. */
const STOP_FAILURE_ERRORS: ReadonlySet<string> = new Set([
  'authentication_failed',
  'billing_error',
  'rate_limit',
  'invalid_request',
  'server_error',
  'unknown',
  'max_output_tokens',
])

/**
 * The `error` a `StopFailure` hook is told for the message that ended the
 * turn, as one of `STOP_FAILURE_ERRORS`. Velloc's own two error kinds map
 * onto that set: a safety refusal is `invalid_request`, and so is a
 * provider's repetitive-tool-call rejection (an HTTP 400 there). A
 * truncation is `max_output_tokens`, a context overflow with no error kind
 * `invalid_request` (the request was too long), anything else `unknown`.
 */
export function stopFailureError(message: ModelReplyRow): string {
  if (message.apiError === 'max_output_tokens') return 'max_output_tokens'
  const error = message.error
  if (error === 'refusal' || error === 'repetitive_tool_calls') return 'invalid_request'
  if (error && STOP_FAILURE_ERRORS.has(error)) return error
  if (message.apiError === 'prompt_too_long') return 'invalid_request'
  return 'unknown'
}

function assistantText(message: ModelReplyRow): string | undefined {
  const content = message.message?.content
  if (!Array.isArray(content)) return undefined
  const text = content
    .filter(part => part.type === 'text' && typeof part.text === 'string')
    .map(part => part.text as string)
    .join('\n')
    .trim()
  return text || undefined
}

/**
 * `StopFailure` for the turn `message` ended: informational — matched on
 * `error`, stdin `{ error, error_details?, last_assistant_message? }`, the
 * outcome ignored. The query loop fires it, not awaited, where it returns on
 * an API error in place of the Stop hooks (`engine/turnLoop.ts`). A fork's failure
 * fires it too, with the session's hooks.
 */
export async function runStopFailureHooks(
  message: ModelReplyRow,
  toolUseContext: ToolCallContext,
): Promise<void> {
  const sessionId = toolUseContext.options.sessionId
  if (!sessionId) return
  const runners = hookRunners(toolUseContext, sessionId)
  const error = stopFailureError(message)
  const text = assistantText(message)
  const fields = {
    ...(message.errorDetails ? { errorDetails: message.errorDetails } : {}),
    ...(text ? { finalReplyText: text } : {}),
  }
  await settle('StopFailure', () =>
    runClassicHooks(
      toolUseContext.options.mods,
      'StopFailure',
      () =>
        buildHookInput({
          event: 'StopFailure',
          sessionId,
          cwd: runners.hookInput.cwd,
          permissionMode: runners.hookInput.permissionMode,
          toolName: error,
          ...fields,
        }),
      () =>
        fireTurnFailed({
          ...runners,
          error,
          hookInput: { ...runners.hookInput, ...fields },
        }),
      runners.signal,
    ),
  )
}
