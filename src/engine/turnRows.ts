/**
 * Pure row builders and readers for the turn machine: the rows it adds on
 * its own (answers for unanswered tool calls, the interruption note, the
 * step-budget marker, the over-the-limit reply, the output-cap note, the
 * nudge) and the
 * small readers it needs over model replies and tool-result rows. Ids come
 * from the draft as placeholders; no clock is read.
 */
import type { QueryToolUseBlock } from '../runtime/interfaces/QueryRuntimeDeps'
import type { ModelReplyRow, Message } from '../runtime/RuntimeTypes'
import {
  ATTACHMENT_MAX_TURNS_REACHED,
  MSG_TYPE_ASSISTANT,
  MSG_TYPE_ATTACHMENT,
  MSG_TYPE_STREAM_REQUEST_START,
  MSG_TYPE_USER,
  PART_TOOL_CALL,
  PART_TOOL_RESULT_CANONICAL,
  ROLE_USER,
} from '../runtime/VercelModelConstants'
import { makeStopRow } from '../messages/messageFactories'
import { rowId, type Draft } from './turnStep'

/** The text every tool call left unanswered by a cancellation receives. */
export const CANCELLED_CALL_TEXT = 'Interrupted by user'

/**
 * The note sent after a reply was cut at the output-token cap and the cap
 * was already raised once. It asks the model to carry on from the cut point
 * without going back over earlier text, and to split what is left.
 */
export const OUTPUT_CAP_CONTINUE_NOTE =
  'Your previous reply stopped because it reached the output-token limit. ' +
  'Carry on exactly where it stopped, without restating anything already written ' +
  'or apologising, and finish the remaining work in smaller parts.'

const PROMPT_TOO_LONG_TEXT =
  'Prompt is too long for the selected model context window. Try /compact or start a new conversation.'

/** The marker yielded before every model request. */
export const REQUEST_START_ROW = { type: MSG_TYPE_STREAM_REQUEST_START } as unknown as Message

export function toolCallsOf(message: Message): QueryToolUseBlock[] {
  const body = typeof message.message === 'object' && message.message !== null
    ? (message.message as { content?: unknown })
    : undefined
  const parts = Array.isArray(body?.content) ? body.content : []
  return parts.filter(
    (part: unknown): part is QueryToolUseBlock =>
      typeof part === 'object' &&
      part !== null &&
      (part as { type?: unknown }).type === PART_TOOL_CALL &&
      typeof (part as { toolCallId?: unknown }).toolCallId === 'string' &&
      typeof (part as { toolName?: unknown }).toolName === 'string',
  )
}

/** One tool-result part as the failure count reads it. */
export type ResultPart = { toolCallId: string; failed: boolean; body: unknown }

export function resultPartsOf(message: Message): ResultPart[] {
  const body = typeof message.message === 'object' && message.message !== null
    ? (message.message as { content?: unknown })
    : undefined
  const parts = Array.isArray(body?.content) ? body.content : []
  const found: ResultPart[] = []
  for (const part of parts) {
    if (!part || typeof part !== 'object') continue
    const p = part as { type?: unknown; toolCallId?: unknown; isError?: unknown; result?: unknown; content?: unknown }
    if (p.type !== PART_TOOL_RESULT_CANONICAL || typeof p.toolCallId !== 'string') continue
    // Current rows hold the body in `result`; older bridge rows in `content`.
    found.push({ toolCallId: p.toolCallId, failed: p.isError === true, body: p.result ?? p.content })
  }
  return found
}

/** Which API failure, if any, the last reply of a model request reports. */
export function replyFailure(reply: Message | undefined): 'output_cap' | 'prompt_too_long' | 'api_error' | undefined {
  if (!reply || reply.type !== MSG_TYPE_ASSISTANT) return undefined
  const a = reply as ModelReplyRow
  if (a.apiError === 'max_output_tokens') return 'output_cap'
  if (a.apiError === 'prompt_too_long') return 'prompt_too_long'
  if (a.isApiErrorMessage === true) return 'api_error'
  return undefined
}

/** Error answers for every tool call in `replies` not yet answered, at most
 *  one per call id. */
export function answerUnansweredCalls(
  d: Draft,
  replies: readonly ModelReplyRow[],
  answered: ReadonlySet<string> = new Set(),
): Message[] {
  const done = new Set(answered)
  const rows: Message[] = []
  for (const reply of replies) {
    for (const call of toolCallsOf(reply)) {
      if (done.has(call.toolCallId)) continue
      done.add(call.toolCallId)
      rows.push({
        type: MSG_TYPE_USER,
        uuid: rowId(d),
        message: {
          role: ROLE_USER,
          content: [
            { type: PART_TOOL_RESULT_CANONICAL, result: CANCELLED_CALL_TEXT, isError: true, toolCallId: call.toolCallId },
          ],
        },
        toolUseResult: CANCELLED_CALL_TEXT,
        sourceToolAssistantUUID: reply.uuid,
      } as Message)
    }
  }
  return rows
}

export function interruptionRow(d: Draft, afterToolUse: boolean): Message {
  return makeStopRow(rowId(d), { toolUse: afterToolUse })
}

export function stepBudgetRow(d: Draft, limit: number, reachedAt: number): Message {
  return {
    type: MSG_TYPE_ATTACHMENT,
    uuid: rowId(d),
    attachment: { type: ATTACHMENT_MAX_TURNS_REACHED, maxTurns: limit, turnCount: reachedAt },
  } as Message
}

export function overLimitReply(d: Draft, model: string | undefined): ModelReplyRow {
  return {
    type: MSG_TYPE_ASSISTANT,
    uuid: rowId(d),
    message: { role: 'assistant', content: [{ type: 'text', text: PROMPT_TOO_LONG_TEXT }], model },
    apiError: 'prompt_too_long',
    isApiErrorMessage: true,
    error: 'invalid_request',
    errorDetails: 'Context is at the blocking limit after auto-compaction did not reduce it.',
  } as ModelReplyRow
}

/** A nudge as the model reads it: a generated user row wrapping the text in
 *  the reminder tags the system prompt describes. */
export function nudgeRow(d: Draft, text: string): Message {
  return {
    type: MSG_TYPE_USER,
    uuid: rowId(d),
    message: { role: ROLE_USER, content: `<system-reminder>
${text}
</system-reminder>` },
    isMeta: true,
  } as Message
}

export function outputCapNote(d: Draft): Message {
  return {
    type: MSG_TYPE_USER,
    uuid: rowId(d),
    message: { role: ROLE_USER, content: OUTPUT_CAP_CONTINUE_NOTE },
    isMeta: true,
  } as Message
}
