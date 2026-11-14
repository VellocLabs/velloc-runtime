import { reviewNoticeRunId } from '../../codeReview/review-protocol'
import type { ThreadMessageLike } from '@assistant-ui/react'
import type { ModelReplyRow, Message, StreamRecord, NoticeRow } from '../../runtime/RuntimeTypes'
import {
  extractBackgroundShellArgsPreview,
  extractToolDescriptionPreview,
  isBackgroundShellToolName,
  shouldLazyLoadToolDetail,
} from '../../utils/toolCallDetails'
import {
  MSG_TYPE_STREAM_EVENT,
  MSG_TYPE_STREAM_REQUEST_START,
  STREAM_COMPACT_PROGRESS,
  STREAM_TOOL_PROGRESS,
  SYSTEM_SUBTYPE_COMPACT_BOUNDARY,
} from '../../runtime/VercelModelConstants'
import {
  type ThreadPart,
  asRecord,
  collectToolCalls,
  collectToolResults,
  extractBrowserActionsTypePreview,
  formatSystemMessage,
  normalizeToolArgs,
  pendingBackgroundAgentResult,
  applySkillBodyRefs,
  collectSkillBodyRefs,
} from './assistantUiAdapterParts'
import { createTranslate, type TranslateFn } from './i18n/translate'
import { appendTextPart, contentToAssistantParts } from './assistantUiAdapterContent'
import {
  compactBoundaryThreadMessage,
  compactProgressThreadMessage,
  memorySavedThreadMessage,
} from './assistantUiAdapterCards'
import { a2uiBlockKeysOf } from './a2ui/a2uiRowKeys'
import {
  convertTranscriptMessage,
  markEndTurnReply,
  withProviderApiErrorMetadata,
} from './assistantUiAdapterMessage'

function unwrapStreamEvent(event: StreamRecord): Record<string, unknown> | null {
  const record = asRecord(event)
  if (!record) {
    return null
  }

  if (record.type === 'stream_event' && asRecord(record.event)) {
    return record.event as Record<string, unknown>
  }

  return record
}

function appendRunningToolPart(
  parts: ThreadPart[],
  params: {
    toolCallId: string
    toolName: string
    args?: unknown
  },
): void {
  const lazyDetail = shouldLazyLoadToolDetail(params.toolName)
  const args = normalizeToolArgs(params.args)
  const inlineArgs = lazyDetail
    ? params.toolName === 'browser_actions'
      ? extractBrowserActionsTypePreview(args)
      : {
          ...extractToolDescriptionPreview(params.toolName, args),
          ...(isBackgroundShellToolName(params.toolName)
            ? extractBackgroundShellArgsPreview(args)
            : null),
        }
    : args
  const argsText = lazyDetail ? '' : JSON.stringify(args, null, 2)
  const backgroundAgentPendingResult = pendingBackgroundAgentResult(
    params.toolName,
    args,
  )

  const existingIndex = parts.findIndex(
    part => part.type === 'tool-call' && part.toolCallId === params.toolCallId,
  )
  if (existingIndex !== -1) {
    // The streaming-start event fires before content_block_start, so the
    // first appendRunningToolPart call lands without args. Once
    // content_block_start arrives with the real args we want to refresh
    // the part so the trigger label can render the action types
    // (browser_actions) or any inlined args. Skip the update if the new
    // call carries no args — that's a streaming-start re-fire and we
    // don't want to clobber what the previous call already set.
    if (params.args === undefined) {
      return
    }
    const previous = parts[existingIndex] as ThreadPart & { type: 'tool-call' }
    parts[existingIndex] = {
      ...previous,
      args: inlineArgs,
      argsText,
      ...(backgroundAgentPendingResult ? { result: backgroundAgentPendingResult } : {}),
    }
    return
  }

  parts.push({
    type: 'tool-call',
    toolCallId: params.toolCallId,
    toolName: params.toolName,
    args: inlineArgs,
    argsText,
    ...(backgroundAgentPendingResult ? { result: backgroundAgentPendingResult } : {}),
    artifact: lazyDetail
      ? {
          lazyToolDetail: true,
        }
      : undefined,
  })
}

export function createLiveAssistantMessages(
  liveEvents: StreamRecord[],
  idCounter: { value: number },
  turnAnchorUuid: string | null,
  retryPrompt: string | undefined,
  persistedUuids: ReadonlySet<string>,
  /** Active-locale translator for slash output's `i18nContent`. */
  t?: TranslateFn,
): ThreadMessageLike[] {
  if (liveEvents.length === 0) {
    return []
  }

  let compactProgressStage: 'start' | 'end' | null = null
  for (const liveEvent of liveEvents) {
    const event = unwrapStreamEvent(liveEvent)
    if (!event) continue
    if (event.type === STREAM_COMPACT_PROGRESS) {
      compactProgressStage = event.stage === 'end' ? 'end' : 'start'
    }
  }

  const structuredMessages = liveEvents.filter(
    (event): event is Message =>
      typeof event === 'object' &&
      event !== null &&
      typeof (event as { type?: unknown }).type === 'string' &&
      (event as { type: string }).type !== MSG_TYPE_STREAM_EVENT &&
      (event as { type: string }).type !== 'result' &&
      (event as { type: string }).type !== 'stream_request_start',
  )
  const toolCalls = collectToolCalls(structuredMessages)
  const toolResults = collectToolResults(structuredMessages, toolCalls)
  applySkillBodyRefs(
    toolResults,
    collectSkillBodyRefs(structuredMessages, toolCalls),
  )

  const liveMessages: ThreadMessageLike[] = []
  let liveIndex = 0

  let lastPersistedEvent = -1
  for (const message of structuredMessages) {
    // System boundaries retain their independent live lifecycle.
    if (message.type !== 'system' && message.uuid && persistedUuids.has(message.uuid)) {
      lastPersistedEvent = liveEvents.indexOf(message)
      continue
    }
    switch (message.type) {
      case 'attachment': {
        const attachment = convertTranscriptMessage(
          message,
          toolResults,
          toolCalls,
          idCounter,
          retryPrompt,
          t,
        )
        if (attachment) {
          liveMessages.push(attachment)
          liveIndex++
        }
        break
      }

      case 'assistant': {
        const assistantMessage = message as ModelReplyRow
        const parts = contentToAssistantParts(
          assistantMessage.message.content,
          toolResults,
          toolCalls,
          idCounter,
        )
        if (parts.length > 0) {
          markEndTurnReply(parts, assistantMessage.message.stop_reason)
          liveMessages.push(withProviderApiErrorMetadata({
            id:
              assistantMessage.uuid
              ?? (turnAnchorUuid
                ? `turn:${turnAnchorUuid}:live-assistant-${liveIndex}`
                : `live-assistant-${liveIndex}`),
            role: 'assistant',
            content: parts,
            status: { type: 'running' },
            metadata: {
              custom: {
                sourceType: 'live_events',
                ...a2uiBlockKeysOf(assistantMessage.uuid, assistantMessage.message.content),
              },
            },
          }, assistantMessage, retryPrompt))
          liveIndex++
        }
        break
      }

      case 'system': {
        const reviewRunId = reviewNoticeRunId(message)
        if (reviewRunId) {
          liveMessages.push({
            id: message.uuid ?? `review-${reviewRunId}`,
            role: 'assistant',
            content: [{ type: 'text', text: (t ?? createTranslate('en'))('reviewCard.title') }],
            status: { type: 'complete', reason: 'stop' },
            metadata: { custom: { sourceType: 'code-review', reviewRunId } },
          })
          liveIndex++
          break
        }

        if ((message as { subtype?: unknown }).subtype === SYSTEM_SUBTYPE_COMPACT_BOUNDARY) {
          liveMessages.push(compactBoundaryThreadMessage(message))
          liveIndex++
          break
        }

        if ((message as { subtype?: unknown }).subtype === 'memory_saved') {
          liveMessages.push(memorySavedThreadMessage(message))
          liveIndex++
          break
        }

        const systemText = formatSystemMessage(message, t)
        if (systemText) {
          liveMessages.push({
            id: message.uuid ?? `live-system-${liveIndex}`,
            role: 'assistant',
            content: systemText,
            status: { type: 'complete', reason: 'stop' },
            metadata: {
              custom: {
                sourceType: 'live_events',
                subtype: (message as NoticeRow).subtype,
              },
            },
          })
          liveIndex++
        }
        break
      }

      default:
        break
    }
  }

  if (compactProgressStage === 'start') {
    liveMessages.push(compactProgressThreadMessage(compactProgressStage))
  }

  if (liveMessages.length > 0) {
    for (let i = 0; i < liveMessages.length - 1; i++) {
      // Only assistant-rendered messages carry a status (a live user message
      // — mid-turn input — has none).
      if (liveMessages[i]!.role !== 'assistant') continue
      liveMessages[i] = {
        ...liveMessages[i],
        status: { type: 'complete', reason: 'stop' },
      }
    }
    return liveMessages
  }

  const parts: ThreadPart[] = []

  for (const liveEvent of liveEvents.slice(lastPersistedEvent + 1)) {
    const event = unwrapStreamEvent(liveEvent)
    if (!event) {
      continue
    }

    const eventType = typeof event.type === 'string' ? event.type : null
    if (eventType === STREAM_COMPACT_PROGRESS) {
      continue
    }

    // A new model-call attempt starts (retry after stream timeout / provider
    // error). Discard parts accumulated from the FAILED attempt so orphaned
    // tool-call cards (e.g. Read cards whose SSE stream died mid-args) don't
    // linger as permanent "running" spinners.
    if (eventType === MSG_TYPE_STREAM_REQUEST_START) {
      parts.length = 0
      continue
    }

    if (eventType === STREAM_TOOL_PROGRESS) {
      const data = asRecord(event.data)
      const output = typeof data?.output === 'string' ? data.output : ''
      const toolName = typeof event.toolName === 'string' ? event.toolName : 'Tool'
      const elapsed = typeof data?.elapsed_time_seconds === 'number'
        ? ` · ${Math.round(data.elapsed_time_seconds)}s`
        : ''
      appendTextPart(parts, output || `${toolName} running${elapsed}`)
      continue
    }

    if (eventType === 'content_block_delta') {
      const delta = asRecord(event.delta)
      if (delta?.type === 'text_delta' && typeof delta.text === 'string') {
        appendTextPart(parts, delta.text)
        continue
      }

      if (
        delta?.type === 'thinking_delta' &&
        typeof delta.thinking === 'string'
      ) {
        appendTextPart(parts, delta.thinking, 'reasoning')
        continue
      }

      continue
    }

    if (eventType === 'content_block_start') {
      const contentBlock = asRecord(event.content_block)
      if (contentBlock?.type === 'text' && typeof contentBlock.text === 'string') {
        appendTextPart(parts, contentBlock.text)
        continue
      }

      if (
        contentBlock?.type === 'thinking' &&
        typeof contentBlock.thinking === 'string'
      ) {
        appendTextPart(parts, contentBlock.thinking, 'reasoning')
        continue
      }

      if (contentBlock?.type === 'tool-call') {
        const toolName =
          typeof contentBlock.toolName === 'string' ? contentBlock.toolName : 'tool'
        const toolCallId =
          typeof contentBlock.toolCallId === 'string'
            ? contentBlock.toolCallId
            : `tool-${toolName}-${idCounter.value++}`
        appendRunningToolPart(parts, {
          toolCallId,
          toolName,
          args: contentBlock.args,
        })
        continue
      }
    }

    if (
      eventType === 'tool-call-streaming-start' ||
      eventType === 'tool-call-delta' ||
      eventType === 'message_delta' ||
      eventType === 'message_start' ||
      eventType === 'message_stop' ||
      eventType === 'content_block_stop'
    ) {
      if (eventType === 'tool-call-streaming-start') {
        const toolName =
          typeof event.toolName === 'string' ? event.toolName : 'tool'
        const toolCallId =
          typeof event.toolCallId === 'string'
            ? event.toolCallId
            : `tool-${toolName}-${idCounter.value++}`
        appendRunningToolPart(parts, {
          toolCallId,
          toolName,
        })
      }
      continue
    }

    if (eventType === 'error') {
      const error = asRecord(event.error)
      const message =
        typeof error?.message === 'string'
          ? error.message
          : 'Tool stream failed.'
      appendTextPart(parts, message)
    }
  }

  if (parts.length === 0) {
    return []
  }

  return [
    {
      id: turnAnchorUuid
        ? `turn:${turnAnchorUuid}:live-stream`
        : 'live-assistant-message',
      role: 'assistant',
      content: parts,
      status: { type: 'running' },
      metadata: {
        custom: {
          sourceType: 'live_events',
        },
      },
    },
  ]
}
