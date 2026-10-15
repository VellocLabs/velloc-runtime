/**
 * Hook command input — the JSON object written to a command hook's stdin.
 *
 * The field names are the hook input format hook scripts read. The type is
 * deliberately loose (`[key: string]: unknown`) so an event can carry extra
 * fields; the precise field set per event is whatever `buildHookInput`
 * constructs below.
 */

import type { LifecycleEventName } from './hookTypes'

export type HookInput = {
  session_id: string
  transcript_path?: string
  cwd: string
  hook_event_name: LifecycleEventName
  permission_mode?: string
  [key: string]: unknown
}

export type BuildHookInputParams = {
  event: LifecycleEventName
  sessionId: string
  cwd: string
  transcriptPath?: string
  permissionMode?: string
  /** The matcher subject: the tool name for tool-scoped events, the agent
   *  id for `SubagentStart` / `SubagentStop`, the `source` for
   *  `SessionStart`, the `reason` for `SessionEnd`, the
   *  `notification_type` for `Notification`. */
  toolName?: string
  /** `agent_type` of `SessionStart` (the main thread's agent, when one is
   *  set) and `SubagentStart` (the sub-agent's type). */
  agentType?: string
  /** `model` of `SessionStart`: the session's model. */
  model?: string
  /** `message` / `title` of `Notification` (its type is the subject). */
  message?: string
  title?: string
  /** `error_details` / `last_assistant_message` of `StopFailure` (its
   *  `error` is the matcher subject, `toolName`). */
  errorDetails?: string
  finalReplyText?: string
  /** `permission_suggestions` of `PermissionRequest`: the "always allow"
   *  options the ask offers. */
  alwaysAllowOffers?: unknown[]
  toolInput?: unknown
  toolResponse?: unknown
  toolUseId?: string
  /** User prompt text for `UserPromptSubmit`. */
  prompt?: string
  /** `Stop` / `SubagentStop` reentrancy guard flag. */
  stopHookActive?: boolean
  /** `custom_instructions` of `PreCompact` (its `trigger` is the subject):
   *  the text typed after `/compact`, `null` when there is none. */
  foldGuidance?: string | null
  /** `compact_summary` of `PostCompact`: the summary text. */
  compactSummary?: string
}

/**
 * Build the per-event hook input object. Base fields
 * (`session_id`/`cwd`/`hook_event_name`) are always present; each event
 * adds its own fields on top of them.
 */
export function buildHookInput(params: BuildHookInputParams): HookInput {
  const input: HookInput = {
    session_id: params.sessionId,
    cwd: params.cwd,
    hook_event_name: params.event,
  }
  if (params.transcriptPath) input.transcript_path = params.transcriptPath
  if (params.permissionMode) input.permission_mode = params.permissionMode

  switch (params.event) {
    case 'PreToolUse':
      input.tool_name = params.toolName
      input.tool_input = params.toolInput ?? {}
      if (params.toolUseId) input.tool_use_id = params.toolUseId
      break
    case 'PostToolUse':
    case 'PostToolUseFailure':
      input.tool_name = params.toolName
      input.tool_input = params.toolInput ?? {}
      input.tool_response = params.toolResponse
      if (params.toolUseId) input.tool_use_id = params.toolUseId
      break
    case 'PermissionRequest':
      // `{ tool_name, tool_input, permission_suggestions? }` (no tool_use_id).
      input.tool_name = params.toolName
      input.tool_input = params.toolInput ?? {}
      if (params.alwaysAllowOffers?.length) {
        input.permission_suggestions = params.alwaysAllowOffers
      }
      break
    case 'UserPromptSubmit':
      input.prompt = params.prompt ?? ''
      break
    case 'SessionStart':
      // `{ source, agent_type?, model? }`.
      input.source = params.toolName ?? 'startup'
      if (params.agentType) input.agent_type = params.agentType
      if (params.model) input.model = params.model
      break
    case 'SessionEnd':
      // `{ reason }`.
      input.reason = params.toolName ?? 'other'
      break
    case 'Notification':
      // `{ message, title?, notification_type }`.
      input.message = params.message ?? ''
      if (params.title) input.title = params.title
      input.notification_type = params.toolName ?? ''
      break
    case 'SubagentStart':
      if (params.toolName) input.agent_id = params.toolName
      if (params.agentType) input.agent_type = params.agentType
      break
    case 'Stop':
    case 'SubagentStop':
      input.stop_hook_active = params.stopHookActive ?? false
      if (params.event === 'SubagentStop' && params.toolName) {
        input.agent_id = params.toolName
      }
      break
    case 'StopFailure':
      // `{ error, error_details?, last_assistant_message? }`.
      input.error = params.toolName ?? 'unknown'
      if (params.errorDetails) input.error_details = params.errorDetails
      if (params.finalReplyText) {
        input.last_assistant_message = params.finalReplyText
      }
      break
    case 'PreCompact':
      // `{ trigger, custom_instructions }`.
      input.trigger = params.toolName ?? 'auto'
      input.custom_instructions = params.foldGuidance ?? null
      break
    case 'PostCompact':
      // `{ trigger, compact_summary }`.
      input.trigger = params.toolName ?? 'auto'
      input.compact_summary = params.compactSummary ?? ''
      break
    default:
      // Other events carry only the base
      // fields for now; their extra fields land when those hooks
      // grow consumers.
      break
  }

  return input
}
