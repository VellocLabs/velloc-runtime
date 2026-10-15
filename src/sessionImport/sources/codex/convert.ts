/**
 * Codex rollout → native Velloc session (F-8): each `response_item` maps to a
 * canonical-part message and the shared core assembles. Rollouts are linear:
 * uuids are synthesized in file order; calls pair with output by `call_id`.
 * Developer messages and ghost_snapshot / world_state are dropped; reasoning
 * keeps its summary only. Pure: no fs, no bridge.
 */

import type { Message } from '../../../runtime/RuntimeTypes'
import {
  MSG_TYPE_ASSISTANT,
  MSG_TYPE_USER,
  PART_TEXT,
  PART_THINKING,
  PART_TOOL_CALL,
  PART_TOOL_RESULT_CANONICAL,
} from '../../../runtime/VercelModelConstants'
import {
  ImportConvertError,
  type ImportConvertResult,
  type ImportSubAgentInput,
} from '../../protocol'
import {
  assembleConvertedBundle,
  finalizeImportResult,
  IMPORTED_TEMPLATE_TYPE,
} from '../../core/assemble'
import type { Converted } from '../../core/chain'
import { asRecord, asString } from '../../core/json'
import { pickSessionTitle } from '../../core/sessionTitle'
import {
  firstUserPrompt,
  isSyntheticUserText,
  parseRollout,
  type CodexResponseItem,
} from './parseRollout'
import { sessionIdFromPath } from './parseLite'

type ToolCallInfo = { toolName: string; args: unknown }
type Part = Record<string, unknown>

function tryParseJson(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    return text
  }
}

/** Unwrap a shell/tool output. Codex `output` is always a string; a shell
 *  result is itself JSON `{ output, metadata:{ exit_code } }` — surface the
 *  inner text and map a non-zero exit to an error. */
function unwrapOutput(output: string): { text: string; isError: boolean } {
  const trimmed = output.trim()
  if (trimmed.startsWith('{')) {
    const parsed = asRecord(tryParseJson(trimmed))
    if (parsed && typeof parsed.output === 'string') {
      const meta = asRecord(parsed.metadata)
      const exit = typeof meta?.exit_code === 'number' ? meta.exit_code : 0
      return { text: parsed.output, isError: exit !== 0 }
    }
  }
  return { text: output, isError: false }
}

function assistantMessage(
  uuid: string,
  timestamp: string,
  parts: Part[],
): Converted {
  return {
    uuid,
    message: {
      type: MSG_TYPE_ASSISTANT,
      uuid,
      timestamp,
      message: { role: 'assistant', content: parts },
    } as Message,
  }
}

function convertMessage(
  item: CodexResponseItem,
  uuid: string,
  timestamp: string,
): Converted[] {
  const role = asString(item.role)
  const content = Array.isArray(item.content) ? item.content : []

  if (role === 'developer') return [] // permission / sandbox preamble

  if (role === 'assistant') {
    const parts: Part[] = []
    for (const block of content) {
      const rec = asRecord(block)
      if (rec?.type === 'output_text' && typeof rec.text === 'string') {
        parts.push({ type: PART_TEXT, text: rec.text })
      }
    }
    return parts.length ? [assistantMessage(uuid, timestamp, parts)] : []
  }

  // user
  const texts: string[] = []
  let synthetic = false
  for (const block of content) {
    const rec = asRecord(block)
    if (rec?.type === 'input_text' && typeof rec.text === 'string') {
      if (isSyntheticUserText(rec.text)) synthetic = true
      texts.push(rec.text)
    } else if (rec?.type === 'input_image') {
      texts.push('[image]') // v1: images are noted, not embedded
    }
  }
  if (texts.length === 0) return []
  return [
    {
      uuid,
      message: {
        type: MSG_TYPE_USER,
        uuid,
        timestamp,
        message: { role: 'user', content: texts.join('\n') },
        ...(synthetic ? { isMeta: true } : {}),
      } as Message,
    },
  ]
}

function convertReasoning(
  item: CodexResponseItem,
  uuid: string,
  timestamp: string,
): Converted[] {
  const summary = Array.isArray(item.summary) ? item.summary : []
  const texts: string[] = []
  for (const block of summary) {
    const rec = asRecord(block)
    if (rec?.type === 'summary_text' && typeof rec.text === 'string') {
      texts.push(rec.text)
    }
  }
  if (texts.length === 0) return []
  return [
    assistantMessage(uuid, timestamp, [
      { type: PART_THINKING, thinking: texts.join('\n\n') },
    ]),
  ]
}

function convertToolCall(
  item: CodexResponseItem,
  uuid: string,
  timestamp: string,
  toolCalls: Map<string, ToolCallInfo>,
): Converted[] {
  const callId = asString(item.call_id) ?? asString(item.id)
  const toolName = asString(item.name)
  if (!callId || !toolName) return []
  // function_call.arguments is a JSON-encoded string; custom_tool_call.input is
  // a raw (non-JSON) string, e.g. an apply_patch body.
  const args =
    item.type === 'custom_tool_call'
      ? (asString(item.input) ?? '')
      : tryParseJson(asString(item.arguments) ?? '{}')
  toolCalls.set(callId, { toolName, args })
  return [
    assistantMessage(uuid, timestamp, [
      { type: PART_TOOL_CALL, toolCallId: callId, toolName, args },
    ]),
  ]
}

function convertToolOutput(
  item: CodexResponseItem,
  uuid: string,
  timestamp: string,
  toolCalls: Map<string, ToolCallInfo>,
): Converted[] {
  const callId = asString(item.call_id)
  if (!callId) return []
  const { text, isError } = unwrapOutput(asString(item.output) ?? '')
  const info = toolCalls.get(callId)
  const detail = info
    ? {
        toolCallDetailRef: { toolCallId: callId, toolName: info.toolName },
        toolCallDetail: {
          toolCallId: callId,
          toolName: info.toolName,
          args: info.args,
          result: text,
          ...(isError ? { isError: true } : {}),
        },
      }
    : {}
  return [
    {
      uuid,
      message: {
        type: MSG_TYPE_USER,
        uuid,
        timestamp,
        message: {
          role: 'user',
          content: [
            {
              type: PART_TOOL_RESULT_CANONICAL,
              result: text,
              ...(isError ? { isError: true } : {}),
              toolCallId: callId,
            },
          ],
        },
        toolUseResult: text,
        ...detail,
      } as Message,
    },
  ]
}

function convertWebSearch(
  item: CodexResponseItem,
  uuid: string,
  timestamp: string,
): Converted[] {
  const callId = asString(item.call_id) ?? uuid
  const action = asRecord(item.action)
  const queries = Array.isArray(action?.queries) ? action.queries : []
  const query =
    asString(action?.query) ??
    (queries.length ? queries.join(', ') : '')
  return [
    assistantMessage(uuid, timestamp, [
      {
        type: PART_TOOL_CALL,
        toolCallId: callId,
        toolName: 'web_search',
        args: { query },
      },
    ]),
  ]
}

function convertItem(
  item: CodexResponseItem,
  uuid: string,
  timestamp: string,
  toolCalls: Map<string, ToolCallInfo>,
): Converted[] {
  switch (item.type) {
    case 'message':
      return convertMessage(item, uuid, timestamp)
    case 'reasoning':
      return convertReasoning(item, uuid, timestamp)
    case 'function_call':
    case 'custom_tool_call':
      return convertToolCall(item, uuid, timestamp, toolCalls)
    case 'function_call_output':
    case 'custom_tool_call_output':
      return convertToolOutput(item, uuid, timestamp, toolCalls)
    case 'web_search_call':
      return convertWebSearch(item, uuid, timestamp)
    default:
      return [] // ghost_snapshot, world_state, local_shell_call, …
  }
}

export function convert(args: {
  path: string
  bytes: ArrayBuffer
  now: number
  // Codex sub-agents are separate threads (thread_spawn_edges), not in-transcript;
  // v1 imports each thread standalone, so this is unused.
  subagents?: ImportSubAgentInput[]
}): ImportConvertResult {
  const parsed = parseRollout(new TextDecoder('utf-8').decode(args.bytes))
  if (parsed.items.length === 0) {
    throw new ImportConvertError('empty', `No conversation in ${args.path}`)
  }
  const projectRoot = parsed.meta.cwd
  if (!projectRoot) {
    throw new ImportConvertError(
      'no_project_root',
      `No working directory recorded in ${args.path}`,
    )
  }
  const sessionId = sessionIdFromPath(args.path) ?? parsed.meta.id ?? null
  if (!sessionId) {
    throw new ImportConvertError('no_session_id', `No session id for ${args.path}`)
  }

  const fallbackTimestamp = new Date(args.now).toISOString()
  const toolCalls = new Map<string, ToolCallInfo>()
  const converted: Converted[] = []
  parsed.items.forEach(({ item, timestamp }, index) => {
    const ts = timestamp ?? parsed.meta.timestamp ?? fallbackTimestamp
    converted.push(...convertItem(item, `codex-${index}`, ts, toolCalls))
  })

  const title = pickSessionTitle({
    firstPrompt: firstUserPrompt(parsed.items),
  })
  const bundle = assembleConvertedBundle(converted, {
    sessionId,
    now: args.now,
    path: args.path,
    title: title ?? undefined,
    carryOver: { templateType: IMPORTED_TEMPLATE_TYPE, projectRoot },
  })

  return finalizeImportResult({
    source: 'codex',
    sessionId,
    projectRoot,
    path: args.path,
    now: args.now,
    bundle,
    subAgents: [],
    stats: {
      lines: parsed.lines,
      skippedLines: parsed.skippedLines,
      droppedRecords: 0,
      droppedSidechain: 0,
      messages: converted.length,
      subAgents: 0,
    },
  })
}
