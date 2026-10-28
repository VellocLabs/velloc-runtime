/**
 * Stages 9-10 (F-26): `invokeStage` runs the tool and streams progress;
 * `shapeStage` builds the tool_result the model reads. Nothing is truncated here.
 */
import type { QueryRuntimeDeps } from '../../runtime/interfaces/QueryRuntimeDeps'
import type { ModelReplyRow, Message } from '../../runtime/RuntimeTypes'
import type { ToolOutcome } from '../toolContract'
import type { FileChangeDiff } from '../../utils/fileChangeHunks'
import {
  MSG_TYPE_USER,
  ROLE_USER,
  PART_IMAGE,
  PART_TOOL_RESULT_CANONICAL,
  MSG_TYPE_STREAM_EVENT,
  STREAM_TOOL_PROGRESS,
} from '../../runtime/VercelModelConstants'
import { traceLine } from '../../utils/debugLog'
import { shrinkToolResultImage } from '../../utils/images/inlineImage'
import { toolResultIndicatesSoftFailure } from '../../utils/toolResultStatus'
import {
  screenshotOf,
  toolResultParts,
  toolResultText,
  type ToolResultContentPart,
} from '../../utils/toolResultParts'
import { createProgressQueue, drainWithProgress } from './progressQueue'
import type { AdmittedRun, DeferredMessageUpdate, StageStep } from './executeToolCall'

/** The input a call runs with: the gate's amended input, else the model's. */
export function runInputOf(gateVerdict: unknown, fallback: Record<string, unknown>): Record<string, unknown> {
  return (
    (typeof gateVerdict === 'object' &&
    gateVerdict !== null &&
    'updatedInput' in gateVerdict &&
    gateVerdict.updatedInput &&
    typeof gateVerdict.updatedInput === 'object'
      ? (gateVerdict.updatedInput as Record<string, unknown>)
      : undefined) ?? fallback
  )
}


/** The tool_result message for one call, with its detail record. */
export function toolOutcomeMessage(params: {
  content: string | ToolResultContentPart[]
  /** The text form kept for the transcript when `content` is multimodal. */
  toolUseResultText?: string
  callRef: string
  modelReply: ModelReplyRow
  deps: QueryRuntimeDeps
  toolName?: string
  toolArgs?: unknown
  toolResultData?: unknown
  /** UI-only diff for file edits; kept on the detail record, never sent. */
  editDiff?: FileChangeDiff
  isError?: boolean
}): Message {
  const toolUseResultText =
    params.toolUseResultText ?? (typeof params.content === 'string' ? params.content : '')
  return {
    type: MSG_TYPE_USER,
    uuid: params.deps.uuid(),
    message: {
      role: ROLE_USER,
      content: [
        {
          type: PART_TOOL_RESULT_CANONICAL,
          result: params.content,
          ...(params.isError ? { isError: true } : {}),
          toolCallId: params.callRef,
        },
      ],
    },
    toolUseResult: toolUseResultText,
    sourceToolAssistantUUID: params.modelReply.uuid,
    ...(params.toolName
      ? {
          toolCallDetailRef: { toolCallId: params.callRef, toolName: params.toolName },
          toolCallDetail: {
            toolCallId: params.callRef,
            toolName: params.toolName,
            args: params.toolArgs,
            result: params.toolResultData,
            ...(params.editDiff ? { editDiff: params.editDiff } : {}),
            ...(params.isError ? { isError: true } : {}),
          },
        }
      : {}),
  }
}

/** Stamp rows a tool added with the assistant message they answer. */
function stampedWithReply(
  messages: readonly Message[] | undefined,
  modelReply: ModelReplyRow,
): Message[] {
  if (!messages || messages.length === 0) return []
  return messages.map(message =>
    message.sourceToolAssistantUUID
      ? message
      : { ...message, sourceToolAssistantUUID: modelReply.uuid },
  )
}

/** Shrink every image part at ingest; a part that cannot or need not shrink
 *  is returned as it was. */
async function shrinkImageParts(parts: ToolResultContentPart[]): Promise<ToolResultContentPart[]> {
  return Promise.all(
    parts.map(async part => {
      if (part.type !== PART_IMAGE || typeof part.image !== 'string') return part
      const smaller = await shrinkToolResultImage(
        part.image,
        typeof part.mimeType === 'string' ? part.mimeType : 'image/png',
      )
      return smaller ? { ...part, ...smaller } : part
    }),
  )
}

/** What the model reads for a result: a string, or content parts. */
export async function toolResultContent(
  result: ToolOutcome<unknown>,
): Promise<string | ToolResultContentPart[]> {
  const content = toolResultParts(result.data)
  return typeof content === 'string' ? content : shrinkImageParts(content)
}

/** The text form of a tool's result. */
export function serializeToolResult(result: ToolOutcome<unknown>): string {
  return toolResultText(result.data)
}

/** This call's tool_result, read back from a message: the stored data, the
 *  text the model reads, and whether it is an error. */
export function readToolResultMessage(
  message: Message,
  callRef: string,
): { data: unknown; text: string; isError: boolean } | undefined {
  const candidate = message as {
    type?: unknown
    message?: { content?: unknown }
    toolUseResult?: unknown
    toolCallDetail?: { result?: unknown }
  }
  if (candidate.type !== MSG_TYPE_USER) return undefined
  const content = candidate.message?.content
  if (!Array.isArray(content)) return undefined
  const block = content.find(
    (part): part is { type: string; toolCallId: string; result?: unknown; isError?: boolean } =>
      typeof part === 'object' &&
      part !== null &&
      (part as { type?: unknown }).type === PART_TOOL_RESULT_CANONICAL &&
      (part as { toolCallId?: unknown }).toolCallId === callRef,
  )
  if (!block) return undefined
  const text =
    typeof candidate.toolUseResult === 'string' && candidate.toolUseResult !== ''
      ? candidate.toolUseResult
      : typeof block.result === 'string'
        ? block.result
        : ''
  return { data: candidate.toolCallDetail?.result, text, isError: block.isError === true }
}

/** Settle-and-retry delays for a screenshot that came back without an
 *  image (the capture can fail transiently while the observation succeeds).
 *  A third blank result is returned as it is. */
const SCREENSHOT_RETRY_DELAYS_MS = [400, 1200]

/** Stage 9: run the tool, streaming progress as it arrives. */
export async function* invokeStage(run: AdmittedRun): AsyncGenerator<DeferredMessageUpdate, StageStep> {
  const { tool, block, callContext, deps } = run
  const runInput = runInputOf(run.gateVerdict, run.rawInput)
  run.runInput = runInput
  traceLine(`[tool] ${tool.name} start (${block.toolCallId})`)
  run.startedAtMs = Date.now()
  const progress = createProgressQueue()
  const pending = tool.call(runInput, callContext, run.decidePermission, run.modelReply, update => {
    const event = update as { toolUseID?: unknown; data?: unknown }
    progress.push({
      type: MSG_TYPE_STREAM_EVENT,
      uuid: deps.uuid(),
      event: {
        type: STREAM_TOOL_PROGRESS,
        toolUseID: typeof event.toolUseID === 'string' ? event.toolUseID : `${block.toolCallId}-progress`,
        toolName: tool.name,
        parentToolUseID: block.toolCallId,
        data: event.data,
      },
    } as Message)
  })
  let result = yield* drainWithProgress(pending, progress)
  const screenshotMissing = () =>
    tool.name === 'BrowserScreenshot' &&
    (result.data as { ok?: unknown } | null | undefined)?.ok === true &&
    !screenshotOf(result.data)
  for (const settleMs of SCREENSHOT_RETRY_DELAYS_MS) {
    if (!screenshotMissing()) break
    await new Promise(resolve => setTimeout(resolve, settleMs))
    result = await tool.call(runInput, callContext, run.decidePermission, run.modelReply)
  }
  run.outcome = result
  return 'continue'
}

/** Stage 10: the tool_result, then the rows the tool added. A soft failure
 *  (an `ok:false` envelope, or the tool's own `isError`) is flagged. */
export async function* shapeStage(run: AdmittedRun): AsyncGenerator<DeferredMessageUpdate, StageStep> {
  const { tool, block, modelReply, deps } = run
  const result = run.outcome!
  const softFailure = toolResultIndicatesSoftFailure(result.data) || result.isError === true
  traceLine(
    `[tool] ${tool.name} ${softFailure ? 'soft-failed' : 'ok'} in ${
      Date.now() - (run.startedAtMs ?? Date.now())
    }ms (${block.toolCallId})`,
    { level: softFailure ? 'info' : 'debug' },
  )
  yield {
    message: toolOutcomeMessage({
      content: await toolResultContent(result),
      toolUseResultText: serializeToolResult(result),
      callRef: block.toolCallId,
      modelReply,
      deps,
      toolName: tool.name,
      toolArgs: run.runInput,
      toolResultData: result.data,
      editDiff: result.uiEditDiff,
      isError: softFailure,
    }),
    contextPatch: result.contextPatch
      ? { toolUseID: block.toolCallId, modifyContext: result.contextPatch }
      : undefined,
    agentMeta: result.agentMeta,
  }
  for (const message of stampedWithReply(result.extraRows, modelReply)) {
    yield { message }
  }
  return 'continue'
}
