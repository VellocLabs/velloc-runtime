/**
 * Canonical constants for the message format (roles, part types, stream-chunk
 * types, tool shapes). Import from here, never raw literals; the native side
 * converts to provider formats.
 */

// ---------------------------------------------------------------------------
// Message roles
// ---------------------------------------------------------------------------

export const ROLE_SYSTEM = 'system' as const
export const ROLE_USER = 'user' as const
export const ROLE_ASSISTANT = 'assistant' as const
export const ROLE_TOOL = 'tool' as const

export type VercelRole =
  | typeof ROLE_SYSTEM
  | typeof ROLE_USER
  | typeof ROLE_ASSISTANT
  | typeof ROLE_TOOL

export function isRole(value: unknown): value is VercelRole {
  return (
    value === ROLE_SYSTEM ||
    value === ROLE_USER ||
    value === ROLE_ASSISTANT ||
    value === ROLE_TOOL
  )
}

export function isAssistantRole(value: unknown): value is typeof ROLE_ASSISTANT {
  return value === ROLE_ASSISTANT
}

export function isUserRole(value: unknown): value is typeof ROLE_USER {
  return value === ROLE_USER
}

export function isSystemRole(value: unknown): value is typeof ROLE_SYSTEM {
  return value === ROLE_SYSTEM
}

// ---------------------------------------------------------------------------
// Message envelope types (the `type` field on a Message)
// ---------------------------------------------------------------------------

export const MSG_TYPE_USER = 'user' as const
export const MSG_TYPE_ASSISTANT = 'assistant' as const
export const MSG_TYPE_SYSTEM = 'system' as const
export const MSG_TYPE_ATTACHMENT = 'attachment' as const
export const MSG_TYPE_STREAM_EVENT = 'stream_event' as const
export const MSG_TYPE_STREAM_REQUEST_START = 'stream_request_start' as const
export const MSG_TYPE_TOMBSTONE = 'tombstone' as const
export const MSG_TYPE_TOOL_USE_SUMMARY = 'tool_use_summary' as const
export const MSG_TYPE_RESULT = 'result' as const

export type VercelMessageType =
  | typeof MSG_TYPE_USER
  | typeof MSG_TYPE_ASSISTANT
  | typeof MSG_TYPE_SYSTEM
  | typeof MSG_TYPE_ATTACHMENT
  | typeof MSG_TYPE_STREAM_EVENT
  | typeof MSG_TYPE_STREAM_REQUEST_START
  | typeof MSG_TYPE_TOMBSTONE
  | typeof MSG_TYPE_TOOL_USE_SUMMARY
  | typeof MSG_TYPE_RESULT

export function isUserMessage(msg: { type: string }): boolean {
  return msg.type === MSG_TYPE_USER
}

export function isAssistantMessage(msg: { type: string }): boolean {
  return msg.type === MSG_TYPE_ASSISTANT
}

export function isSystemMessage(msg: { type: string }): boolean {
  return msg.type === MSG_TYPE_SYSTEM
}

export function isAttachmentMessage(msg: { type: string }): boolean {
  return msg.type === MSG_TYPE_ATTACHMENT
}

// ---------------------------------------------------------------------------
// System message subtypes
// ---------------------------------------------------------------------------

/**
 * System subtype for a compaction boundary. Compaction is non-destructive: the
 * API path sends the tail via `rowsSinceFoldLine`; the UI renders all of it.
 */
export const SYSTEM_SUBTYPE_COMPACT_BOUNDARY = 'compact_boundary' as const

// ---------------------------------------------------------------------------
// Content-part types (blocks inside message.content arrays)
// ---------------------------------------------------------------------------

export const PART_TEXT = 'text' as const
export const PART_TOOL_CALL = 'tool-call' as const
export const PART_TOOL_RESULT_CANONICAL = 'tool-result' as const

/** @deprecated Use PART_TOOL_CALL. Kept only for bridge compatibility fallback. */
export const LEGACY_PART_TOOL_USE = 'tool_use' as const
/** @deprecated Use PART_TOOL_RESULT_CANONICAL. Kept only for bridge compatibility fallback. */
export const LEGACY_PART_TOOL_RESULT = 'tool_result' as const

/** @deprecated Alias for LEGACY_PART_TOOL_USE — do not use in new code. */
export const PART_TOOL_USE = LEGACY_PART_TOOL_USE
/** @deprecated Alias for LEGACY_PART_TOOL_RESULT — do not use in new code. */
export const PART_TOOL_RESULT = LEGACY_PART_TOOL_RESULT
export const PART_THINKING = 'thinking' as const
export const PART_REDACTED_THINKING = 'redacted_thinking' as const
export const PART_IMAGE = 'image' as const
export const PART_DOCUMENT = 'document' as const
export const PART_FILE = 'file' as const
export const PART_REASONING = 'reasoning' as const

export type VercelContentPartType =
  | typeof PART_TEXT
  | typeof PART_TOOL_CALL
  | typeof PART_TOOL_RESULT_CANONICAL
  | typeof LEGACY_PART_TOOL_USE
  | typeof LEGACY_PART_TOOL_RESULT
  | typeof PART_THINKING
  | typeof PART_REDACTED_THINKING
  | typeof PART_IMAGE
  | typeof PART_DOCUMENT
  | typeof PART_FILE
  | typeof PART_REASONING

export function isToolUsePart(part: { type: string }): boolean {
  return part.type === PART_TOOL_USE || part.type === PART_TOOL_CALL
}

export function isToolResultPart(part: { type: string }): boolean {
  return part.type === PART_TOOL_RESULT || part.type === PART_TOOL_RESULT_CANONICAL
}

export function isTextPart(part: { type: string }): boolean {
  return part.type === PART_TEXT
}

// ---------------------------------------------------------------------------
// Stream chunk types (bridge streaming protocol)
// ---------------------------------------------------------------------------

export const STREAM_CONTENT_BLOCK_START = 'content_block_start' as const
export const STREAM_CONTENT_BLOCK_DELTA = 'content_block_delta' as const
export const STREAM_CONTENT_BLOCK_STOP = 'content_block_stop' as const
export const STREAM_MESSAGE_START = 'message_start' as const
export const STREAM_MESSAGE_DELTA = 'message_delta' as const
export const STREAM_MESSAGE_STOP = 'message_stop' as const
export const STREAM_ERROR = 'error' as const
export const STREAM_COMPACT_PROGRESS = 'compact_progress' as const
export const STREAM_TOOL_PROGRESS = 'tool_progress' as const

export type VercelStreamChunkType =
  | typeof STREAM_CONTENT_BLOCK_START
  | typeof STREAM_CONTENT_BLOCK_DELTA
  | typeof STREAM_CONTENT_BLOCK_STOP
  | typeof STREAM_MESSAGE_START
  | typeof STREAM_MESSAGE_DELTA
  | typeof STREAM_MESSAGE_STOP
  | typeof STREAM_ERROR
  | typeof STREAM_COMPACT_PROGRESS
  | typeof STREAM_TOOL_PROGRESS

// ---------------------------------------------------------------------------
// Stream delta sub-types
// ---------------------------------------------------------------------------

export const DELTA_TEXT = 'text_delta' as const
export const DELTA_THINKING = 'thinking_delta' as const
export const DELTA_SIGNATURE = 'signature_delta' as const

/**
 * Prefix of a thinking block `signature` that is a host-made reasoning replay
 * envelope, not an Anthropic signature: the provider's `reasoning_details`
 * bound to the provider + model that produced them. The host puts it back on
 * the next request only for that provider + model
 * (src/custom_browser/browser/nexus/api/llm/reasoning_replay.h).
 */
export const REASONING_REPLAY_SIGNATURE_PREFIX = 'velloc-replay-v1:' as const
export const DELTA_TOOL_CALL_STREAMING_START = 'tool-call-streaming-start' as const
export const DELTA_TOOL_CALL = 'tool-call-delta' as const

// ---------------------------------------------------------------------------
// Tool definition type
// ---------------------------------------------------------------------------

export const TOOL_DEF_FUNCTION = 'function' as const

// ---------------------------------------------------------------------------
// Stop / finish reasons
// ---------------------------------------------------------------------------

export const STOP_REASON_END_TURN = 'end_turn' as const
export const STOP_REASON_TOOL_USE = 'tool_use' as const

// ---------------------------------------------------------------------------
// Query terminal reasons
// ---------------------------------------------------------------------------

export const TERMINAL_COMPLETED = 'completed' as const
export const TERMINAL_AWAITING_USER = 'awaiting_user_interaction' as const
export const TERMINAL_STOP_HOOK_PREVENTED = 'stop_hook_prevented' as const
export const TERMINAL_STOP_HOOK_BLOCKING = 'stop_hook_blocking' as const
/** Set by `engine/turnLoop.ts` when a `UserPromptSubmit` hook blocks the user's
 *  prompt before the model runs. The user sees the hook's errors as a
 *  synthetic system response; the model never sees the prompt that
 *  turn. The next user prompt re-enters the loop normally. */
export const TERMINAL_PROMPT_REJECTED = 'prompt_rejected' as const
export const TERMINAL_MAX_TURNS = 'max_turns' as const
export const TERMINAL_NEXT_TURN = 'next_turn' as const
export const TERMINAL_ABORTED = 'aborted_streaming' as const
// Agent-loop guardrail terminal: a hard limit on repeated failure.
// Loop is exited when the consecutive-failures circuit trips
// (TERMINAL_MAX_FAILURES). Surfaces as an `error_*` subtype on the
// TurnResultRecord.
export const TERMINAL_MAX_FAILURES = 'max_failures' as const
// Surfaced when the provider truncated the response (`stop_reason:
// 'max_tokens'`) and the recovery loop in `engine/turnLoop.ts` exhausted both the
// one-shot upperLimit escalation and the multi-turn "Resume directly"
// continuation. Distinct from `TERMINAL_MAX_FAILURES` because the model
// did not behaviourally fail — the API ran out of room to emit. Lets SDK
// consumers tell "agent gave up" from "agent was cut off".
export const TERMINAL_MAX_OUTPUT_TOKENS = 'max_output_tokens' as const

// Surfaced when the request exceeded the model's input context window and the
// provider rejected it (HTTP 400/413). The deps-layer model transport converts
// that thrown error into an `apiError: 'prompt_too_long'` assistant message
// (so the loop doesn't terminate with an unhandled throw), and the query loop
// exits with this terminal reason. There is no auto-recovery (reactive
// compaction).
export const TERMINAL_PROMPT_TOO_LONG = 'prompt_too_long' as const
export const TERMINAL_API_ERROR = 'api_error' as const

// ---------------------------------------------------------------------------
// Attachment payload types
// ---------------------------------------------------------------------------

export const ATTACHMENT_BROWSER_CONTEXT = 'browser_context' as const
export const ATTACHMENT_FILE = 'file' as const
export const ATTACHMENT_PDF_REFERENCE = 'pdf_reference' as const
export const ATTACHMENT_PDF_DOCUMENT = 'pdf_document' as const
export const ATTACHMENT_SKILL_LISTING = 'skill_listing' as const
export const ATTACHMENT_SKILL_DISCOVERY = 'skill_discovery' as const
export const ATTACHMENT_PLAN_MODE = 'plan_mode' as const
export const ATTACHMENT_PLAN_MODE_REENTRY = 'plan_mode_reentry' as const
export const ATTACHMENT_PLAN_MODE_EXIT = 'plan_mode_exit' as const
export const ATTACHMENT_MAX_TURNS_REACHED = 'max_turns_reached' as const

// ---------------------------------------------------------------------------
// Session meta type
// ---------------------------------------------------------------------------

// LEGACY, read-only. Pre-`meta.json` builds appended this record to
// `transcript.jsonl` on every metadata write; the loader tolerates it and the
// one-time migration reads it, but nothing writes it anymore — metadata lives
// in the session's `meta.json` (`SessionMetaFile`).
export const SESSION_META_TYPE = '__session_meta' as const

// Dedicated session-title transcript entries. A USER rename
// is a `custom-title`; an auto-generated title is an `ai-title`. Readers prefer
// `customTitle` over `aiTitle` over the derived summary, so a user rename always
// wins regardless of append order — and the two entries are distinct so an AI
// title can never clobber a user title.
export const CUSTOM_TITLE_TYPE = 'custom-title' as const
export const AI_TITLE_TYPE = 'ai-title' as const
