import type {
  AppendMessage,
  CompleteAttachment,
  ThreadMessageLike,
} from '@assistant-ui/react'
import type {
  ModelReplyRow,
  ContentBlockParam,
  Message,
  StreamRecord,
  NoticeRow,
  UserRow,
} from '../../runtime/RuntimeTypes'
import type { BrowserRuntimeClientState, InjectBubble } from './BrowserRuntimeClient'
import { createQuotedAttachmentPrefix } from './BrowserComposerAttachmentAdapter'
import {
  encodeAttachmentImage,
  isImageLikeAttachment,
} from '../../utils/images/inlineImage'
import { imageSourceNote } from '../../utils/images/imageSourceNote'
import {
  extractBackgroundShellArgsPreview,
  isBackgroundShellToolName,
  shouldLazyLoadToolDetail,
} from '../../utils/toolCallDetails'
import {
  PRIOR_TODOS_KEY,
  readTodoWriteTodos,
  type PriorTodoStatus,
} from '../../utils/todoSections'
import { CHECKLIST_TOOL_ID } from '../../toolkit/builtin/todoWrite'
import {
  MSG_TYPE_STREAM_EVENT,
  MSG_TYPE_STREAM_REQUEST_START,
  STREAM_COMPACT_PROGRESS,
  STREAM_TOOL_PROGRESS,
  SYSTEM_SUBTYPE_COMPACT_BOUNDARY,
} from '../../runtime/VercelModelConstants'
import {
  INTERRUPTED_TOOL_RESULT,
  type ThreadPart,
  type ToolCallInfo,
  type ToolResultEntry,
  asDate,
  asRecord,
  backgroundResultKind,
  collectToolCalls,
  collectToolResults,
  commandInvocationPillText,
  extractBrowserActionsTypePreview,
  extractPlainUserText,
  formatBrowserValue,
  formatSystemMessage,
  isInternalToolResultMessage,
  isInterruptMarkerMessage,
  isInterruptToolUseVariant,
  normalizeToolArgs,
  pendingBackgroundAgentResult,
  applySkillBodyRefs,
  collectSkillBodyRefs,
  skillBodyRefFromMessage,
  skillInvocationThreadMessage,
} from './assistantUiAdapterParts'
import type { TranslateFn } from './i18n/translate'
import { TURN_SETTLED_KEY } from './turnSettled'
import {
  appendTextPart,
  attachmentToText,
  contentToAssistantParts,
  convertUserContentWithAttachments,
  hasPendingToolCalls,
} from './assistantUiAdapterContent'
import {
  backgroundResultsThreadMessage,
  compactBoundaryThreadMessage,
  compactProgressThreadMessage,
  isBackgroundResultsThreadMessage,
  isCompactBoundaryThreadMessage,
  isCompactProgressThreadMessage,
  isProviderApiErrorThreadMessage,
  isTeamMessageThreadMessage,
  memorySavedThreadMessage,
  teamMessageThreadMessage,
} from './assistantUiAdapterCards'
import { parseTeamMessageEnvelope } from '../../team/parseTeamFrame'
import { withoutPluginPromptFrame } from '../../mods/promptNouns'

function findPreviousVisibleUserPrompt(
  messages: readonly Message[],
  beforeIndex: number,
): string | undefined {
  for (let i = beforeIndex - 1; i >= 0; i -= 1) {
    const message = messages[i]
    if (!message || message.type !== 'user') continue
    const userMessage = message as UserRow
    if (
      userMessage.isMeta ||
      isInternalToolResultMessage(userMessage) ||
      isInterruptMarkerMessage(userMessage)
    ) {
      continue
    }
    const text = extractPlainUserText(userMessage)
    // Neither a background-task notification nor a peer's mailbox frame is
    // something the USER asked for, even though both arrive as user turns.
    if (
      text &&
      !backgroundResultKind(text) &&
      !(userMessage.origin === 'mailbox' && parseTeamMessageEnvelope(text))
    ) {
      return text
    }
  }
  return undefined
}

/**
 * The hidden `isMeta` continuation the ProviderApiErrorCard's "Try again"
 * submits when the failed turn is already persisted (see
 * {@link resolveProviderApiErrorRetryAction}). Model-facing only — `isMeta`
 * user messages never render in the transcript.
 */
export const PROVIDER_API_ERROR_RESUME_PROMPT =
  'The previous request failed with a provider API error. Continue from where you left off.'

/**
 * How the ProviderApiErrorCard's "Try again" re-runs the failed turn: `resume` re-enters
 * the loop via a hidden `isMeta` continuation ({@link PROVIDER_API_ERROR_RESUME_PROMPT}),
 * adding no user message; `resubmit` resends `retryPrompt` when the prompt was never persisted.
 */
export type ProviderApiErrorRetryAction = 'resume' | 'resubmit'

export function resolveProviderApiErrorRetryAction(
  transcriptMessages: readonly Message[],
  retryPrompt: string,
): ProviderApiErrorRetryAction {
  for (let i = transcriptMessages.length - 1; i >= 0; i -= 1) {
    const message = transcriptMessages[i]
    if (!message || message.type !== 'user') continue
    const userMessage = message as UserRow
    // Same visibility filter as findPreviousVisibleUserPrompt — the card's
    // retryPrompt is derived from visible user prompts only, so a hidden
    // (meta/internal) message with matching text is not evidence the
    // prompt persisted.
    if (
      userMessage.isMeta ||
      isInternalToolResultMessage(userMessage) ||
      isInterruptMarkerMessage(userMessage)
    ) {
      continue
    }
    if (extractPlainUserText(userMessage) === retryPrompt) {
      return 'resume'
    }
  }
  return 'resubmit'
}

function withProviderApiErrorMetadata(
  message: ThreadMessageLike,
  assistantMessage: ModelReplyRow,
  retryPrompt: string | undefined,
): ThreadMessageLike {
  if (assistantMessage.isApiErrorMessage !== true) {
    return message
  }

  return {
    ...message,
    metadata: {
      ...message.metadata,
      custom: {
        ...message.metadata?.custom,
        sourceType: 'provider_api_error',
        apiErrorKind: assistantMessage.error,
        apiErrorDetails: assistantMessage.errorDetails,
        apiErrorRetryCount: assistantMessage.errorRetryCount,
        // Safety-stop category (Anthropic `stop_details.category`, e.g.
        // "cyber") so the card's refusal hint can name it. Absent for every
        // other error kind and for an uncategorized refusal.
        apiErrorRefusalCategory:
          typeof assistantMessage.message.stop_details?.category === 'string'
            ? assistantMessage.message.stop_details.category
            : undefined,
        retryPrompt,
      },
    },
  }
}

function convertTranscriptMessage(
  message: Message,
  toolResults: Map<string, ToolResultEntry>,
  toolCalls: ReadonlyMap<string, ToolCallInfo>,
  idCounter: { value: number },
  retryPrompt?: string,
  /** Active-locale translator for slash output's `i18nContent`. */
  t?: TranslateFn,
  /** Skill-invocation messages already represented by a model-invoked `Skill`
   *  tool-call card (collectSkillBodyRefs) — not rendered a second time. */
  absorbedSkillMessageIds?: ReadonlySet<string>,
): ThreadMessageLike | null {
  switch (message.type) {
    case 'user': {
      const userMessage = message as UserRow
      if (isInternalToolResultMessage(userMessage)) {
        return null
      }
      if (isInterruptMarkerMessage(userMessage)) {
        // Keep the interrupt sentinel in the transcript (the next model request needs it) but
        // render it as a divider (`sourceType: 'interrupt'`); `role: 'system'` keeps it out of
        // merges and the user-bubble branch.
        const variant = isInterruptToolUseVariant(userMessage)
          ? 'for_tool_use'
          : 'plain'
        return {
          id: userMessage.uuid,
          createdAt: asDate(userMessage.timestamp),
          role: 'system',
          content: [{ type: 'text', text: 'Interrupted' }],
          metadata: {
            custom: {
              sourceType: 'interrupt',
              variant,
            },
          },
        }
      }

      // `isMeta` user messages are internal context for the model, never user-authored chat:
      // hidden here, still sent in the API payload. After the interrupt check on purpose.
      if (userMessage.isMeta) {
        // EXCEPT a skill invocation: it renders as a Skill card (name + "View
        // skill" → right-panel Skill tab), the way a tool call would. A
        // model-invoked one is already the `Skill` tool call's card (the body
        // ref was folded into that call's result) — only the user-typed
        // `/skill` form, which has no tool call, gets a synthesized card here.
        const skillRef = skillBodyRefFromMessage(userMessage)
        if (
          skillRef &&
          typeof userMessage.uuid === 'string' &&
          !absorbedSkillMessageIds?.has(userMessage.uuid)
        ) {
          return skillInvocationThreadMessage({
            id: userMessage.uuid,
            createdAt: asDate(userMessage.timestamp),
            ref: skillRef,
          })
        }
        return null
      }

      // An imported Claude Code slash-command "pill" — a non-meta user message
      // holding only the `<command-message>`/`<command-name>`/`<command-args>`
      // tags (see commandInvocationPillText). Render it as the `/<name> <args>`
      // (or `Skill(<name>)`) text, not the raw XML.
      const commandPill = commandInvocationPillText(userMessage)
      if (commandPill) {
        return {
          id: userMessage.uuid,
          createdAt: asDate(userMessage.timestamp),
          role: 'user',
          content: commandPill,
        }
      }

      const userText = extractPlainUserText(userMessage)
      // A mailbox frame delivered as a real turn (TeamCoordinator's
      // `enqueueMailboxTurn`). Rendered as a card naming the peer, not as the
      // raw envelope — see parseTeamMessageEnvelope. Only a turn the runtime
      // marked as mailbox-delivered qualifies: the envelope is plain text, so
      // a user who types `[message from X]: …` must still see their message.
      const teamMessage =
        userText && userMessage.origin === 'mailbox'
          ? parseTeamMessageEnvelope(userText)
          : null
      if (teamMessage) {
        return teamMessageThreadMessage({
          id: userMessage.uuid,
          createdAt: asDate(userMessage.timestamp),
          parsed: teamMessage,
        })
      }
      const backgroundKind = userText ? backgroundResultKind(userText) : null
      if (userText && backgroundKind) {
        return backgroundResultsThreadMessage({
          id: userMessage.uuid,
          createdAt: asDate(userMessage.timestamp),
          text: userText,
          kind: backgroundKind,
        })
      }

      const { content, attachments } = convertUserContentWithAttachments(
        displayedUserContent(userMessage),
      )
      // Nothing legitimate produces a visible empty user turn — the composer
      // blocks empty sends — but transcripts written before
      // `continueConversation` switched to hidden `isMeta` continuations
      // carry one empty non-meta user message per continue-after-stop click.
      // Rendering it draws a blank user bubble; drop it like the assistant
      // branch drops empty content below. An attachment-only send is not
      // empty: its cards are the message.
      if (
        attachments.length === 0 &&
        ((typeof content === 'string' && content.trim() === '') ||
          (Array.isArray(content) && content.length === 0))
      ) {
        return null
      }

      return {
        id: userMessage.uuid,
        createdAt: asDate(userMessage.timestamp),
        role: 'user',
        content,
        ...(attachments.length > 0 ? { attachments } : {}),
        // The plugin that sent a `$.prompt.submit` turn: a mod's
        // `UserMessage` site reads it as `origin` (F-25).
        ...(userMessage.pluginPrompt
          ? { metadata: { custom: { pluginPrompt: { ...userMessage.pluginPrompt } } } }
          : {}),
      }
    }

    case 'assistant': {
      const assistantMessage = message as ModelReplyRow
      const content = contentToAssistantParts(
        assistantMessage.message.content,
        toolResults,
        toolCalls,
        idCounter,
      )
      if (content.length === 0) {
        return null
      }

      const backgroundText =
        content.length === 1 &&
        content[0]?.type === 'text' &&
        typeof content[0].text === 'string'
          ? content[0].text
          : undefined
      const backgroundKind = backgroundText
        ? backgroundResultKind(backgroundText)
        : null
      if (backgroundText && backgroundKind) {
        return backgroundResultsThreadMessage({
          id: assistantMessage.uuid,
          createdAt: asDate(assistantMessage.timestamp),
          text: backgroundText,
          kind: backgroundKind,
        })
      }

      markEndTurnReply(content, assistantMessage.message.stop_reason)

      return withProviderApiErrorMetadata({
        id: assistantMessage.uuid,
        createdAt: asDate(assistantMessage.timestamp),
        role: 'assistant',
        content,
        status: hasPendingToolCalls(content)
          ? { type: 'requires-action', reason: 'tool-calls' }
          : { type: 'complete', reason: 'stop' },
        metadata: {
          custom: {
            model: assistantMessage.message.model,
            stopReason: assistantMessage.message.stop_reason,
          },
        },
      }, assistantMessage, retryPrompt)
    }

    case 'system': {
      // `compact_boundary` is a transcript slice marker, not a status note.
      // Render it as a distinct message with its own sourceType so the
      // thread component can show a visible divider between pre-compact
      // and post-compact messages. Pre-compact messages remain rendered
      // exactly as they were before — the marker just demarcates them.
      if ((message as { subtype?: unknown }).subtype === SYSTEM_SUBTYPE_COMPACT_BOUNDARY) {
        // role:'assistant' with `sourceType: 'compact_boundary'` renders a `TranscriptDivider`;
        // `text` is the bare label fallback (export / a11y), kept in sync with thread.tsx.
        return compactBoundaryThreadMessage(message)
      }

      // `memory_saved` — the background extract fork saved topic files
      // (a "memory saved" notice). Rendered as a
      // TranscriptDivider, same pattern as compact_boundary.
      if ((message as { subtype?: unknown }).subtype === 'memory_saved') {
        return memorySavedThreadMessage(message)
      }

      const systemText = formatSystemMessage(message, t)
      if (!systemText) {
        return null
      }

      return {
        id: message.uuid,
        createdAt: asDate(message.timestamp),
        role: 'assistant',
        content: systemText,
        status: { type: 'complete', reason: 'stop' },
        metadata: {
          custom: {
            sourceType: 'system',
            subtype: message.subtype,
            // A slash command's output row: the page raises it as a mod's
            // `CommandOutput` site (F-25).
            ...commandOutputStampOf(message),
          },
        },
      }
    }

    case 'attachment': {
      // User input sent with plain Enter while the turn was running, drained
      // into that turn (`commandMode:'prompt'`): render it as the user's own
      // message at the point it reached the model, under the pending bubble's
      // id (`source_uuid`) so the landing is an in-place change. Only the text
      // the user wrote shows — never the system-reminder wrapper the model got.
      const userInput = queuedUserInputThreadMessage(message)
      if (userInput) {
        return userInput
      }
      // A team frame the running turn took between two tool rounds
      // (`commandMode:'team-message'`): the same card a frame delivered as a
      // turn gets. Unrendered, a teammate's message that arrived mid-turn was
      // in the model's context but invisible to the user.
      const queuedTeam = (
        message as { attachment?: { prompt?: unknown; commandMode?: unknown } }
      ).attachment
      if (
        queuedTeam?.commandMode === 'team-message' &&
        typeof queuedTeam.prompt === 'string'
      ) {
        const parsed = parseTeamMessageEnvelope(queuedTeam.prompt)
        if (parsed) {
          return teamMessageThreadMessage({
            id: message.uuid,
            createdAt: asDate(message.timestamp),
            parsed,
          })
        }
      }
      // A Claude Code `queued_command` attachment whose queued command is a
      // background `<task-notification>` (commandMode 'task-notification') is a
      // completed background task that landed while the agent was busy. Render
      // it as a background-results card — the same card a delivered
      // task-notification user turn gets — so these completions aren't lost.
      // The `backgroundResultKind` guard (prompt must start with
      // `<task-notification>`) keeps every other queued command / attachment on
      // the internal-context path below.
      const queuedPrompt = (
        message as { attachment?: { prompt?: unknown; commandMode?: unknown } }
      ).attachment?.commandMode === 'prompt'
        ? undefined
        : (message as { attachment?: { prompt?: unknown } }).attachment?.prompt
      const queuedKind =
        typeof queuedPrompt === 'string' ? backgroundResultKind(queuedPrompt) : null
      if (typeof queuedPrompt === 'string' && queuedKind) {
        return backgroundResultsThreadMessage({
          id: message.uuid,
          createdAt: asDate(message.timestamp),
          text: queuedPrompt,
          kind: queuedKind,
        })
      }
      // Attachment messages (skill listing, file/pdf references, plan-mode,
      // date-change, and formerly browser context) are INTERNAL context
      // attached to the user turn for the model — not user-authored chat.
      // Don't render them as conversation bubbles; the model still receives
      // them in the API payload, this only affects the visible transcript.
      // `attachmentToText` is kept for diagnostics / a possible future
      // "show attachments" affordance.
      return null
    }

    case 'tombstone':
      return null

    default:
      return {
        id: message.uuid,
        createdAt: asDate(message.timestamp),
        role: 'assistant',
        content: formatBrowserValue(message),
        status: { type: 'complete', reason: 'unknown' },
        metadata: {
          custom: {
            sourceType: message.type,
          },
        },
      }
  }
}

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
      : isBackgroundShellToolName(params.toolName)
        ? extractBackgroundShellArgsPreview(args) ?? {}
        : {}
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

/**
 * The turn's closing reply: mark the LAST text part of an `end_turn` message
 * so the body renders it as its own top-level paragraph. The turn merge can
 * put more tool calls after it (a task-notification or hook wakes the agent
 * again), and without the mark it would fold into a collapsed tool group or
 * plan step and vanish from view. Both the transcript conversion and the live
 * path mark it, so the reply does not collapse while the turn is still live.
 */
function markEndTurnReply(content: ThreadPart[], stopReason: unknown): void {
  if (stopReason !== 'end_turn') return
  for (let i = content.length - 1; i >= 0; i--) {
    const part = content[i]
    if (part && typeof part === 'object' && part.type === 'text') {
      ;(part as { endTurn?: boolean }).endTurn = true
      return
    }
  }
}

function createLiveAssistantMessages(
  liveEvents: StreamRecord[],
  idCounter: { value: number },
  turnAnchorUuid: string | null,
  retryPrompt: string | undefined,
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

  for (const message of structuredMessages) {
    switch (message.type) {
      case 'attachment': {
        // Plain-Enter input drained into THIS turn: it renders where it
        // reached the model, between the tool round it followed and the reply
        // that answers it (the transcript copy renders the same id later).
        const userInput = queuedUserInputThreadMessage(message)
        if (userInput) {
          liveMessages.push(userInput)
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
              },
            },
          }, assistantMessage, retryPrompt))
          liveIndex++
        }
        break
      }

      case 'system': {
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

  for (const liveEvent of liveEvents) {
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

export function extractTextFromAppendMessage(message: AppendMessage): string {
  const text = message.content
    .flatMap(part => {
      if (part.type === 'text') {
        return [part.text]
      }

      if (part.type === 'file') {
        return [part.filename ?? 'file']
      }

      return []
    })
    .join('\n')

  return text || formatBrowserValue(message.content)
}

export async function buildPromptFromAppendMessage(
  message: AppendMessage,
  resolveAttachmentPath: (
    attachment: CompleteAttachment,
  ) => Promise<string | null>,
): Promise<string | Array<ContentBlockParam>> {
  const text = extractTextFromAppendMessage(message)
  const attachments = message.attachments ?? []
  if (attachments.length === 0) {
    return text
  }

  // Images ride inline as base64 content blocks; everything else is uploaded
  // to disk and referenced by `@"path"`. Image bytes must NOT take the path
  // route — the runtime would read them back as utf-8 garbage.
  const imageAttachments = attachments.filter(isImageLikeAttachment)
  const fileAttachments = attachments.filter(
    attachment => !isImageLikeAttachment(attachment),
  )

  const resolvedPaths = (
    await Promise.all(
      fileAttachments.map(attachment => resolveAttachmentPath(attachment)),
    )
  ).filter((path): path is string => typeof path === 'string' && path.length > 0)

  const prefix = createQuotedAttachmentPrefix(resolvedPaths)
  const prefixedText = prefix
    ? text
      ? `${prefix}${text}`
      : prefix.trimEnd()
    : text

  if (imageAttachments.length === 0) {
    return prefixedText
  }

  // Each image becomes an inline base64 content part, the shape both the
  // C++ provider translators and the transcript renderer read. The original
  // is also uploaded, and a source note (`imageSourceNote`) tells the model
  // where it is on disk, plus the scale factor when the sent copy was scaled
  // down, so the model can hand the file to a tool. A failed upload costs
  // only the path in that note; the image itself still goes inline.
  const images = await Promise.all(
    imageAttachments.map(async attachment => {
      const [converted, sourcePath] = await Promise.all([
        encodeAttachmentImage(attachment),
        resolveAttachmentPath(attachment).catch(() => null),
      ])
      return converted
        ? {
            block: converted.part,
            metadata: imageSourceNote(
              converted.sizing,
              sourcePath ?? undefined,
            ),
          }
        : null
    }),
  )
  const imageBlocks = images.flatMap(image => (image ? [image.block] : []))

  if (imageBlocks.length === 0) {
    return prefixedText
  }

  const blocks: Array<ContentBlockParam> = [...imageBlocks]
  if (prefixedText.trim()) {
    blocks.push({ type: 'text', text: prefixedText })
  }
  // A block of its own, after the user's text, so the transcript can hide
  // it (`isImageSourceNoteText`).
  const metadataLines = images.flatMap(image => (image?.metadata ? [image.metadata] : []))
  if (metadataLines.length > 0) {
    blocks.push({ type: 'text', text: metadataLines.join('\n') })
  }
  return blocks
}

function mergeConsecutiveAssistantMessages(
  messages: readonly ThreadMessageLike[],
): ThreadMessageLike[] {
  const merged: ThreadMessageLike[] = []

  for (const message of messages) {
    const previous = merged[merged.length - 1]

    const canMerge =
      previous !== undefined &&
      previous.role === 'assistant' &&
      message.role === 'assistant' &&
      Array.isArray(previous.content) &&
      Array.isArray(message.content) &&
      // Compact boundaries are role:'assistant' so the default Thread render
      // shows them, but they're slice markers — never merge them with the
      // real assistant on either side or the divider disappears.
      !isCompactBoundaryThreadMessage(previous) &&
      !isCompactBoundaryThreadMessage(message) &&
      // Compact progress rows are temporary status items that disappear once the
      // boundary marker streams. Keep them separate from real assistant content.
      !isCompactProgressThreadMessage(previous) &&
      !isCompactProgressThreadMessage(message) &&
      !isBackgroundResultsThreadMessage(previous) &&
      !isBackgroundResultsThreadMessage(message) &&
      !isProviderApiErrorThreadMessage(previous) &&
      !isProviderApiErrorThreadMessage(message) &&
      // A peer's message is its own card, and it stands between two of THIS
      // session's assistant turns — merging it would fold the peer's text
      // into the local assistant's message.
      !isTeamMessageThreadMessage(previous) &&
      !isTeamMessageThreadMessage(message)

    if (canMerge && previous && Array.isArray(previous.content) && Array.isArray(message.content)) {
      // Dedup tool-call parts by toolCallId across the merge: a duplicate key throws in
      // assistant-ui and blanks the UI. The resolved part wins; otherwise the live (newer) one.
      const toolId = (p: ThreadPart): string | undefined =>
        p.type === 'tool-call'
        && typeof (p as { toolCallId?: unknown }).toolCallId === 'string'
          ? (p as { toolCallId: string }).toolCallId
          : undefined
      const isResolvedTool = (p: ThreadPart): boolean =>
        p.type === 'tool-call' && (p as { result?: unknown }).result !== undefined
      const prevParts = previous.content as ThreadPart[]
      const liveParts = message.content as ThreadPart[]
      const liveToolById = new Map<string, ThreadPart>()
      for (const p of liveParts) {
        const id = toolId(p)
        if (id) liveToolById.set(id, p)
      }
      const prevToolById = new Map<string, ThreadPart>()
      for (const p of prevParts) {
        const id = toolId(p)
        if (id) prevToolById.set(id, p)
      }
      const combinedContent: ThreadPart[] = [
        // Keep prev parts; drop a tool-call duplicated in the live half UNLESS
        // prev is the resolved one and live is not (then prev wins).
        ...prevParts.filter(part => {
          const id = toolId(part)
          if (id === undefined) return true
          const live = liveToolById.get(id)
          if (!live) return true
          return isResolvedTool(part) && !isResolvedTool(live)
        }),
        // Keep live parts; drop a tool-call where the resolved prev part won.
        ...liveParts.filter(part => {
          const id = toolId(part)
          if (id === undefined) return true
          const prev = prevToolById.get(id)
          if (!prev) return true
          return !(isResolvedTool(prev) && !isResolvedTool(part))
        }),
      ]
      merged[merged.length - 1] = {
        ...previous,
        content: combinedContent,
        // Inherit the live half's status: assistant-ui derives `thread.isRunning` from it, and the
        // tool card's spinner follows the resolved PART, not this status.
        status: message.status ?? previous.status,
        metadata: {
          ...previous.metadata,
          ...message.metadata,
          custom: {
            ...previous.metadata?.custom,
            ...message.metadata?.custom,
            // A merged row covers BOTH halves' lines. Spreading alone
            // keeps only the later half's range, and a hit in the earlier
            // one would then find no row claiming it.
            ...mergeLineRanges(previous, message),
            ...mergePartLines(previous, message),
            ...mergeTextLines(previous, message),
          },
        },
      }
      continue
    }

    merged.push(message)
  }

  return merged
}

/**
 * UUID of the user message owning the current turn, the anchor for a stable merged
 * assistant id: the in-flight prompt, else the last non-internal user message.
 */
function findTurnAnchorUuid(state: BrowserRuntimeClientState): string | null {
  if (state.pendingPromptId) return state.pendingPromptId
  for (let i = state.transcriptMessages.length - 1; i >= 0; i--) {
    const msg = state.transcriptMessages[i]
    if (msg.type === 'user') {
      const userMsg = msg as UserRow
      // Skip messages that never reach the UI so the anchor uuid
      // always matches something the user can actually see — otherwise
      // the trailing assistant ends up keyed to a hidden sentinel.
      // `isMeta` messages (e.g. expanded skill instructions) are hidden by
      // convertTranscriptMessage, so they must not be picked as the anchor.
      if (
        !isInternalToolResultMessage(userMsg) &&
        !isInterruptMarkerMessage(userMsg) &&
        !userMsg.isMeta
      ) {
        return userMsg.uuid ?? null
      }
    }
  }
  return null
}

/**
 * Stamp every TodoWrite-bearing assistant turn with the todos of the LAST earlier TodoWrite
 * (`PRIOR_TODOS_KEY`, a JSON string), so a resumed plan's card does not render every step
 * again. Runs after the merge and over the live tail.
 */
function stampPriorTodos(merged: ThreadMessageLike[]): void {
  let priorJson: string | undefined
  for (let i = 0; i < merged.length; i++) {
    const message = merged[i]!
    if (message.role !== 'assistant' || !Array.isArray(message.content)) {
      continue
    }
    let latestJson: string | undefined
    for (const part of message.content as ReadonlyArray<{
      type: string
      toolName?: string
      args?: unknown
    }>) {
      if (part.type !== 'tool-call' || part.toolName !== CHECKLIST_TOOL_ID) {
        continue
      }
      const todos = readTodoWriteTodos(part.args)
      if (!todos) continue
      const state: PriorTodoStatus[] = todos.map(({ content, status }) => ({
        content,
        status,
      }))
      latestJson = JSON.stringify(state)
    }
    if (latestJson === undefined) continue
    if (priorJson !== undefined) {
      const custom = message.metadata?.custom
      merged[i] = {
        ...message,
        metadata: {
          ...message.metadata,
          custom: { ...(custom ?? {}), [PRIOR_TODOS_KEY]: priorJson },
        },
      }
    }
    priorJson = latestJson
  }
}

/**
 * After merging, overwrite the trailing assistant message's id with a stable
 * turn-derived id. The assistant that closes the current turn is the one most
 * likely to flip identity during live → transcript (uuid swap, fallback ids,
 * merge reshuffling). Anchoring it to the user's uuid keeps React's key
 * stable across that boundary so the message doesn't replay its mount
 * animation when the worker persists results.
 */
function stabilizeTrailingAssistantId(
  merged: ThreadMessageLike[],
  anchor: string,
): void {
  for (let i = merged.length - 1; i >= 0; i--) {
    const m = merged[i]
    // A plain-Enter bubble pinned below the running turn has not reached the
    // model yet — it is not a turn boundary. Stopping here would drop the
    // running assistant's stable id (remount + flash) for as long as the
    // bubble is on screen.
    if (m.role === 'user' && isInjectBubbleThreadMessage(m)) continue
    if (m.role === 'user') break
    if (m.role === 'assistant') {
      // Skip compact boundary markers — they're role:'assistant' for
      // visibility but they're slice markers, not the turn's trailing
      // assistant. Stabilizing their id would collide with the previous
      // boundary's stabilized id across compactions.
      if (isCompactBoundaryThreadMessage(m)) continue
      if (isCompactProgressThreadMessage(m)) continue
      if (isBackgroundResultsThreadMessage(m)) continue
      if (isProviderApiErrorThreadMessage(m)) continue
      if (isTeamMessageThreadMessage(m)) continue
      merged[i] = { ...m, id: `turn:${anchor}:assistant` }
      break
    }
  }
}

function ensureUniqueThreadMessageIds(
  messages: readonly ThreadMessageLike[],
): ThreadMessageLike[] {
  const seen = new Set<string>()
  const occurrences = new Map<string, number>()
  let changed = false

  const uniqueMessages = messages.map(message => {
    const id = message.id
    if (!id) {
      return message
    }

    const occurrence = occurrences.get(id) ?? 0
    occurrences.set(id, occurrence + 1)
    if (occurrence === 0 && !seen.has(id)) {
      seen.add(id)
      return message
    }

    changed = true
    let suffix = occurrence > 0 ? occurrence : 1
    let nextId = `${id}:duplicate-${suffix}`
    while (seen.has(nextId)) {
      suffix += 1
      nextId = `${id}:duplicate-${suffix}`
    }
    seen.add(nextId)
    return { ...message, id: nextId }
  })

  return changed ? uniqueMessages : [...messages]
}

/**
 * The transcript half of the conversion (the O(N) passes), memoized on
 * `state.transcriptMessages` alone. `nextId` carries the fallback-id counter on to
 * {@link combineThreadMessages}.
 */
export type ConvertedTranscript = {
  messages: ThreadMessageLike[]
  nextId: number
}

/**
 * The physical transcript line an entry was read from, or null.
 *
 * Stamped by the storage loader, counted the way the search host counts
 * (every line in the file, blanks included) — see
 * `session-storage-physical-line.test.ts`, which exists to keep the two
 * in step.
 */
function lineOf(message: unknown): number | null {
  const line = (message as { transcriptLine?: unknown } | null)?.transcriptLine
  return typeof line === 'number' && Number.isFinite(line) && line >= 0
    ? line
    : null
}

/**
 * Records the transcript lines a rendered row covers: rows are sparse, so a hit is located
 * by which declared range contains it.
 */
function withLineRange(
  message: ThreadMessageLike,
  from: number,
  to: number,
): ThreadMessageLike {
  const metadata = (message.metadata ?? {}) as Record<string, unknown>
  const custom = (metadata.custom ?? {}) as Record<string, unknown>
  return {
    ...message,
    metadata: {
      ...metadata,
      custom: { ...custom, lineFrom: from, lineTo: to },
    },
  } as ThreadMessageLike
}

/**
 * Concatenates two rows' per-part line lists, in the order their content
 * is concatenated — so the combined list still lines up part for part.
 */
export function mergePartLines(
  a: ThreadMessageLike,
  b: ThreadMessageLike,
): { partLines?: string } {
  const read = (message: ThreadMessageLike): string => {
    const custom = (message.metadata as { custom?: Record<string, unknown> })
      ?.custom
    const value = custom?.[PART_LINES_KEY]
    return typeof value === 'string' ? value : ''
  }
  const joined = [read(a), read(b)].filter(part => part.length > 0).join(' ')
  return joined.length > 0 ? { partLines: joined } : {}
}

/** Concatenates two rows' text-part line lists, in render order. */
export function mergeTextLines(
  a: ThreadMessageLike,
  b: ThreadMessageLike,
): { textLines?: string } {
  const read = (message: ThreadMessageLike): string => {
    const custom = (message.metadata as { custom?: Record<string, unknown> })
      ?.custom
    const value = custom?.[TEXT_LINES_KEY]
    return typeof value === 'string' ? value : ''
  }
  const joined = [read(a), read(b)].filter(part => part.length > 0).join(' ')
  return joined.length > 0 ? { textLines: joined } : {}
}

/** Union of two rows' line ranges, for the assistant merge pass. */
export function mergeLineRanges(
  a: ThreadMessageLike,
  b: ThreadMessageLike,
): { lineFrom?: number; lineTo?: number } {
  const read = (message: ThreadMessageLike, key: string): number | undefined => {
    const custom = (message.metadata as { custom?: Record<string, unknown> })
      ?.custom
    const value = custom?.[key]
    return typeof value === 'number' ? value : undefined
  }
  const from = [read(a, 'lineFrom'), read(b, 'lineFrom')].filter(
    (value): value is number => value !== undefined,
  )
  const to = [read(a, 'lineTo'), read(b, 'lineTo')].filter(
    (value): value is number => value !== undefined,
  )
  return {
    ...(from.length ? { lineFrom: Math.min(...from) } : {}),
    ...(to.length ? { lineTo: Math.max(...to) } : {}),
  }
}

/** `9 9 12` — the transcript line behind each content part, in order. */
export const PART_LINES_KEY = 'partLines'

/**
 * `9 12` — the line behind each TEXT part, in order.
 *
 * Text blocks render as a homogeneous sequence in the message body, so
 * the Nth of them is the Nth text part. The mixed part list cannot be
 * matched that way: consecutive tool parts are grouped into wrapper
 * elements, so a row with forty parts can render two children.
 */
export const TEXT_LINES_KEY = 'textLines'

/** `call-1=9:12 call-2=15:20` — the lines each tool card covers. */
export const TOOL_LINE_RANGES_KEY = 'toolLineRanges'

/**
 * The transcript lines behind each tool call, from the issuing assistant line to the result
 * line, so a collapsed card can declare them. A string, so per-message selectors stay stable.
 */
export function collectToolLineRanges(
  messages: readonly Message[],
): string {
  const callLine = new Map<string, number>()
  const resultLine = new Map<string, number>()
  for (const message of messages) {
    const line = lineOf(message)
    if (line === null) continue
    const content = (message as { message?: { content?: unknown } }).message
      ?.content
    if (!Array.isArray(content)) continue
    for (const raw of content) {
      const part = raw as { type?: unknown; toolCallId?: unknown; toolUseId?: unknown }
      const id =
        typeof part.toolCallId === 'string'
          ? part.toolCallId
          : typeof part.toolUseId === 'string'
            ? part.toolUseId
            : null
      if (!id) continue
      if (part.type === 'tool-call' || part.type === 'tool_use') {
        if (!callLine.has(id)) callLine.set(id, line)
      } else if (part.type === 'tool-result' || part.type === 'tool_result') {
        resultLine.set(id, Math.max(resultLine.get(id) ?? line, line))
      }
    }
  }
  const encoded: string[] = []
  for (const [id, from] of callLine) {
    const to = Math.max(from, resultLine.get(id) ?? from)
    encoded.push(`${id}=${from}:${to}`)
  }
  return encoded.join(' ')
}

/** Reads one tool call's range out of the encoded map. */
export function toolLineRange(
  encoded: string | undefined,
  toolCallId: string,
): { from: number; to: number } | null {
  if (!encoded) return null
  for (const chunk of encoded.split(' ')) {
    const at = chunk.indexOf('=')
    if (at < 0 || chunk.slice(0, at) !== toolCallId) continue
    const [from, to] = chunk.slice(at + 1).split(':').map(Number)
    if (!Number.isFinite(from) || !Number.isFinite(to)) return null
    return { from: from!, to: to! }
  }
  return null
}

export function convertTranscriptToThreadMessages(
  transcriptMessages: readonly Message[],
  /**
   * Tool calls the RUNNING turn is deliberately parked on — the worker
   * snapshot's `pendingUserInteraction` keys (AskUserQuestion and any other
   * `requiresUserInteraction` halt). These are unresolved on purpose and must
   * NOT be stamped with the restart sentinel below; see the loop's comment.
   */
  liveHaltedToolCallIds?: ReadonlySet<string>,
  /**
   * Active-locale translator. Slash-command output carries `i18nContent`
   * parts that are rendered here rather than in a component, because the copy
   * button reads this function's output and not the DOM.
   */
  t?: TranslateFn,
): ConvertedTranscript {
  const idCounter = { value: 0 }
  const toolCalls = collectToolCalls(transcriptMessages)
  const toolResults = collectToolResults(transcriptMessages, toolCalls)
  const skillBodyRefs = collectSkillBodyRefs(transcriptMessages, toolCalls)
  applySkillBodyRefs(toolResults, skillBodyRefs)
  // Convert, then attribute. A row covers its own line plus every
  // following line that rendered nothing of its own — a tool result
  // folded into its card, an internal marker, a line the loader dropped.
  // That range is what a search hit is matched against, so it has to be
  // recorded here where the correspondence is still known.
  const messages: ThreadMessageLike[] = []
  const rowFrom: number[] = []
  const rowTo: number[] = []
  const rowPartLines: number[][] = []
  const rowTextLines: number[][] = []
  transcriptMessages.forEach((message, index) => {
    const converted = convertTranscriptMessage(
      message,
      toolResults,
      toolCalls,
      idCounter,
      findPreviousVisibleUserPrompt(transcriptMessages, index),
      t,
      skillBodyRefs.absorbedMessageIds,
    )
    const line = lineOf(message)
    if (converted !== null) {
      messages.push(converted)
      rowFrom.push(line ?? Number.NaN)
      rowTo.push(line ?? Number.NaN)
      // Bind the line to each PART OBJECT, not a positional list: later merges and dedup would
      // drift an index-aligned array.
      const content = Array.isArray(converted.content) ? converted.content : []
      if (line !== null) {
        for (const part of content) {
          if (part && typeof part === 'object') {
            ;(part as { sourceLine?: number }).sourceLine = line
          }
        }
      }
      rowPartLines.push(
        line === null ? [] : content.map(() => line),
      )
      rowTextLines.push(
        line === null
          ? []
          : content
              .filter(part => (part as { type?: unknown }).type === 'text')
              .map(() => line),
      )
      return
    }
    const last = messages.length - 1
    if (last < 0 || line === null) return
    if (Number.isNaN(rowFrom[last]!)) rowFrom[last] = line
    rowTo[last] = Math.max(Number.isNaN(rowTo[last]!) ? line : rowTo[last]!, line)
  })
  // Whole-conversation tool ranges, indexed by tool-call id so each row
  // can be stamped with ONLY the ranges for the tool calls it actually
  // renders — not a copy of every tool call in the conversation.
  const toolRangeById = new Map<string, string>()
  for (const chunk of collectToolLineRanges(transcriptMessages).split(' ')) {
    const eq = chunk.indexOf('=')
    if (eq > 0) toolRangeById.set(chunk.slice(0, eq), chunk)
  }
  for (let at = 0; at < messages.length; at++) {
    const from = rowFrom[at]
    const to = rowTo[at]
    if (from === undefined || to === undefined) continue
    if (Number.isNaN(from) || Number.isNaN(to)) continue
    messages[at] = withLineRange(messages[at]!, from, to)
    const textLines = rowTextLines[at]
    if (textLines && textLines.length > 0) {
      const message = messages[at]!
      const metadata = (message.metadata ?? {}) as Record<string, unknown>
      const custom = (metadata.custom ?? {}) as Record<string, unknown>
      messages[at] = {
        ...message,
        metadata: {
          ...metadata,
          custom: { ...custom, [TEXT_LINES_KEY]: textLines.join(' ') },
        },
      } as ThreadMessageLike
    }
    const partLines = rowPartLines[at]
    if (partLines && partLines.length > 0) {
      const message = messages[at]!
      const metadata = (message.metadata ?? {}) as Record<string, unknown>
      const custom = (metadata.custom ?? {}) as Record<string, unknown>
      messages[at] = {
        ...message,
        metadata: {
          ...metadata,
          custom: { ...custom, [PART_LINES_KEY]: partLines.join(' ') },
        },
      } as ThreadMessageLike
    }
    if (toolRangeById.size > 0) {
      const message = messages[at]!
      const content = Array.isArray(message.content) ? message.content : []
      const own: string[] = []
      for (const part of content) {
        const id = (part as { toolCallId?: unknown }).toolCallId
        if (typeof id === 'string') {
          const range = toolRangeById.get(id)
          if (range !== undefined) own.push(range)
        }
      }
      if (own.length > 0) {
        const metadata = (message.metadata ?? {}) as Record<string, unknown>
        const custom = (metadata.custom ?? {}) as Record<string, unknown>
        messages[at] = {
          ...message,
          metadata: {
            ...metadata,
            custom: { ...custom, [TOOL_LINE_RANGES_KEY]: own.join(' ') },
          },
        } as ThreadMessageLike
      }
    }
  }

  // A restored transcript is never live: stamp the LAST assistant message's unresolved tool
  // calls with a sentinel — except one the live turn is parked on (`liveHaltedToolCallIds`),
  // which is waiting for the user.
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const msg = messages[i]!
    if (msg.role !== 'assistant') continue
    const parts = msg.content as ReadonlyArray<{
      type: string
      toolCallId?: string
      result?: unknown
    }> | undefined
    if (!Array.isArray(parts)) break
    let patched = false
    const newParts = parts.map((part) => {
      if (
        part.type === 'tool-call' &&
        part.result === undefined &&
        !(
          part.toolCallId !== undefined &&
          liveHaltedToolCallIds?.has(part.toolCallId)
        )
      ) {
        patched = true
        return { ...part, result: INTERRUPTED_TOOL_RESULT }
      }
      return part
    })
    if (patched) {
      // The status was computed as 'requires-action' during conversion (because
      // hasPendingToolCalls saw result===undefined). Now that we've resolved
      // them, downgrade to 'complete' so isBackgroundRunning stays false.
      const status = (msg as { status?: { type?: string } }).status
      const newStatus =
        status?.type === 'requires-action'
          ? { type: 'complete' as const, reason: 'stop' as const }
          : status
      messages[i] = { ...msg, content: newParts, status: newStatus } as typeof msg
    }
    break
  }

  return { messages, nextId: idCounter.value }
}

/** The cheap half: appends the pending prompt + live events onto the memoized transcript
 *  conversion, then merges; the only part that re-runs per token. */
/**
 * A `queued_command` attachment carrying user input (`commandMode:'prompt'`)
 * as the user's own message. Null for every other attachment.
 */
function queuedUserInputThreadMessage(message: Message): ThreadMessageLike | null {
  const attachment = (message as {
    attachment?: { type?: unknown; commandMode?: unknown; prompt?: unknown; source_uuid?: unknown }
  }).attachment
  if (attachment?.type !== 'queued_command' || attachment.commandMode !== 'prompt') {
    return null
  }
  // Nexus stamps `source_uuid` (the pending bubble's id, so the landed row
  // replaces it in place). A Claude Code import has none: fall back to the
  // attachment entry's own uuid so the user's words still render.
  const id =
    typeof attachment.source_uuid === 'string'
      ? attachment.source_uuid
      : (message as { uuid?: unknown }).uuid
  if (typeof id !== 'string' || id === '') return null
  const { content, attachments } = convertUserContentWithAttachments(
    attachment.prompt,
  )
  if (
    attachments.length === 0 &&
    ((typeof content === 'string' && content.trim() === '') ||
      (Array.isArray(content) && content.length === 0))
  ) {
    return null
  }
  return {
    id,
    createdAt: asDate((message as { timestamp?: string }).timestamp),
    role: 'user',
    content,
    ...(attachments.length > 0 ? { attachments } : {}),
    metadata: { custom: { injectLanded: true } },
  }
}

/**
 * A plugin's `$.prompt.submit` turn (F-25) is stored as the model reads
 * it — "The <plugin> plugin sent a message: …" — and shown as the text the
 * plugin sent, without the frame, like a team message's envelope. Any other
 * row, and an `asUser` prompt (stored bare), is shown as stored.
 */
function displayedUserContent(userMessage: {
  message: { content: unknown }
  pluginPrompt?: { plugin: string; asUser?: true }
}): Parameters<typeof convertUserContentWithAttachments>[0] {
  const content = userMessage.message.content as Parameters<typeof convertUserContentWithAttachments>[0]
  const stamp = userMessage.pluginPrompt
  if (!stamp || stamp.asUser) return content
  if (typeof content === 'string') return withoutPluginPromptFrame(content, stamp.plugin)
  if (!Array.isArray(content)) return content
  let done = false
  return content.map(part => {
    const text = (part as { type?: unknown; text?: unknown })
    if (done || text.type !== 'text' || typeof text.text !== 'string') return part
    done = true
    return { ...part, text: withoutPluginPromptFrame(text.text, stamp.plugin) }
  }) as typeof content
}

function pendingPromptContent(
  prompt: string,
): Pick<ThreadMessageLike, 'content' | 'attachments'> {
  const { content, attachments } = convertUserContentWithAttachments(prompt)
  return attachments.length > 0 ? { content, attachments } : { content: prompt }
}

function isInjectBubbleThreadMessage(message: ThreadMessageLike): boolean {
  const custom = (message.metadata as { custom?: { injectState?: unknown } } | undefined)?.custom
  return custom?.injectState !== undefined
}

/** A plain-Enter message not yet rendered from the stream / transcript. */
function injectBubbleThreadMessage(bubble: InjectBubble): ThreadMessageLike {
  return {
    id: bubble.uuid,
    role: 'user',
    content: bubble.text,
    metadata: {
      custom: {
        injectState: bubble.state,
        injectUuid: bubble.uuid,
        ...(bubble.hasAttachments ? { injectHasAttachments: true } : {}),
      },
    },
  }
}

export function combineThreadMessages(
  transcript: ConvertedTranscript,
  state: BrowserRuntimeClientState,
  /** Active-locale translator for slash output's `i18nContent`. */
  t?: TranslateFn,
): ThreadMessageLike[] {
  const idCounter = { value: transcript.nextId }
  const anchor = findTurnAnchorUuid(state)
  // Copy: `transcript.messages` is reused across renders by the memoizing
  // caller, so it must never be mutated by the pushes below.
  const messages = transcript.messages.slice()

  // Pre-split events (finished turns not yet reconciled) render ahead of the re-armed bubble,
  // from `liveEventsTurnStart`. Anchor `null`: they carry their own persisted uuids.
  const liveTurnStart = Math.min(
    Math.max(state.liveEventsTurnStart ?? 0, 0),
    state.liveEvents.length,
  )
  // The PREVIOUS turn's optimistic bubble, promoted at the consume so the
  // pickup is a pure append instead of a reshape (see `preSplitPrompt` in
  // BrowserRuntimeClientState). It chronologically precedes the pre-split
  // events (its turn's stream), so it renders first. Deduped against the
  // persisted copy exactly like the pendingPrompt push below.
  if (state.preSplitPrompt && state.preSplitPromptId) {
    const alreadyPresent = messages.some(m => m.id === state.preSplitPromptId)
    if (!alreadyPresent) {
      const backgroundKind = backgroundResultKind(state.preSplitPrompt)
      messages.push(
        backgroundKind
          ? backgroundResultsThreadMessage({
              id: state.preSplitPromptId,
              text: state.preSplitPrompt,
              kind: backgroundKind,
            })
          : {
              id: state.preSplitPromptId,
              role: 'user',
              content: state.preSplitPrompt,
            },
      )
    }
  }
  if (liveTurnStart > 0) {
    messages.push(
      // Their turns are over (the consume fires at the turn boundary), so
      // none of them is "running" — createLiveAssistantMessages leaves its
      // trailing message running, which here would read as a live turn
      // (e.g. a finished plan card showing "Working").
      ...createLiveAssistantMessages(
        state.liveEvents.slice(0, liveTurnStart),
        idCounter,
        null,
        undefined,
        t,
      ).map(message =>
        message.role === 'assistant' &&
        message.status?.type === 'running'
          ? { ...message, status: { type: 'complete' as const, reason: 'stop' as const } }
          : message,
      ),
    )
  }

  // Guard against the documented "intentional overlap window" in
  // BrowserRuntimeClient.ts:812 where pendingPrompt / pendingPromptId stay
  // populated AFTER the worker has already persisted the prompt into the
  // transcript. Without this, the same uuid lands in `messages` twice (once
  // from `convertTranscriptMessage`, once from the push below) and
  // assistant-ui's MessageRepository throws "A message with the same id
  // already exists in the parent tree".
  if (state.pendingPrompt && state.pendingPromptId) {
    const alreadyPresent = messages.some(m => m.id === state.pendingPromptId)
    if (!alreadyPresent) {
      const backgroundKind = backgroundResultKind(state.pendingPrompt)
      messages.push(
        backgroundKind
          ? backgroundResultsThreadMessage({
              id: state.pendingPromptId,
              text: state.pendingPrompt,
              kind: backgroundKind,
            })
          : {
              id: state.pendingPromptId,
              role: 'user',
              // The optimistic bubble shows the same cards the persisted row
              // will, not the raw `@"…/.velloc/uploads/…"` prefix.
              ...pendingPromptContent(state.pendingPrompt),
            },
      )
    }
  }

  // Inject messages that landed as part of the NEXT turn render where that
  // turn's user message goes — before its live output — until the transcript
  // (or the re-armed pendingPrompt above) carries them.
  // A landing for a LATER turn (another turn's bubble is still the armed
  // pendingPrompt) waits below the running turn's output instead.
  const injectBubbles = (state.injectBubbles ?? []).filter(
    bubble => !bubble.removing,
  )
  const isNextTurnLanding = (bubble: InjectBubble): boolean =>
    bubble.state === 'landed' && bubble.landedVia === 'nextturn'
  const rendersBeforeLive = (bubble: InjectBubble): boolean =>
    isNextTurnLanding(bubble) &&
    (!state.pendingPromptId || state.pendingPromptId === bubble.turnUuid)
  const alreadyRendered = (bubble: InjectBubble): boolean =>
    messages.some(m => m.id === bubble.uuid || (bubble.turnUuid !== undefined && m.id === bubble.turnUuid))
  for (const bubble of injectBubbles) {
    if (!rendersBeforeLive(bubble) || alreadyRendered(bubble)) continue
    messages.push(injectBubbleThreadMessage(bubble))
  }

  const liveMessages = createLiveAssistantMessages(
    liveTurnStart > 0 ? state.liveEvents.slice(liveTurnStart) : state.liveEvents,
    idCounter,
    anchor,
    state.pendingPrompt ?? undefined,
    t,
  )
  // The trailing message stays `running` until the transcript refetch (the composer must not
  // read idle), but its metadata says the turn is over so `MarkdownText` stops animating.
  const turnSettled = state.status !== 'submitting'
  messages.push(
    ...(turnSettled
      ? liveMessages.map(message =>
          message.role === 'assistant' && message.status?.type === 'running'
            ? {
                ...message,
                metadata: {
                  ...message.metadata,
                  custom: { ...message.metadata?.custom, [TURN_SETTLED_KEY]: true },
                },
              }
            : message,
        )
      : liveMessages),
  )

  // Pending inject messages (and mid-turn landings whose attachment has not
  // streamed in yet) are pinned at the very bottom, below whatever the turn is
  // producing: they have not reached the model, so nothing above answers them.
  for (const bubble of injectBubbles) {
    if (rendersBeforeLive(bubble) || alreadyRendered(bubble)) continue
    messages.push(injectBubbleThreadMessage(bubble))
  }

  const merged = mergeConsecutiveAssistantMessages(messages)
  stampPriorTodos(merged)
  if (anchor) {
    stabilizeTrailingAssistantId(merged, anchor)
  }
  return ensureUniqueThreadMessageIds(
    dropSupersededApiErrorCards(merged, state.status === 'submitting'),
  )
}

/**
 * Every state field {@link combineThreadMessages} reads beyond the memoized transcript: the
 * exact memo key its React caller must use, spread into the dependency array (constant length).
 */
export function combineThreadMessagesDeps(
  state: BrowserRuntimeClientState,
): readonly unknown[] {
  return [
    state.liveEvents,
    state.liveEventsTurnStart,
    state.pendingPrompt,
    state.pendingPromptId,
    state.preSplitPrompt,
    state.preSplitPromptId,
    state.status,
    state.injectBubbles,
  ]
}

/**
 * Keep only the LAST provider API-error card in the visible list; any later message
 * supersedes a card, and while a turn is in flight every card is. Rendering only — the
 * persisted transcript keeps the errors.
 */
function dropSupersededApiErrorCards(
  messages: readonly ThreadMessageLike[],
  turnInFlight: boolean,
): ThreadMessageLike[] {
  let lastApiErrorIndex = -1
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    if (isProviderApiErrorThreadMessage(messages[i]!)) {
      lastApiErrorIndex = i
      break
    }
  }
  if (lastApiErrorIndex < 0) return [...messages]
  // The card survives ONLY while it is the last visible message of a settled
  // conversation — anything after it (a retried prompt, a reply, a divider),
  // or a new turn in flight, means the failure is superseded. When the
  // trailing entry is an error card, earlier error cards (from stacked
  // failed retries) are dropped so they don't pile up.
  const trailingIsApiError =
    !turnInFlight && lastApiErrorIndex === messages.length - 1
  return messages.filter((message, index) => {
    if (!isProviderApiErrorThreadMessage(message)) return true
    return trailingIsApiError && index === lastApiErrorIndex
  })
}

export function convertBrowserRuntimeStateToThreadMessages(
  state: BrowserRuntimeClientState,
  /** Active-locale translator for slash output's `i18nContent`. */
  t?: TranslateFn,
): ThreadMessageLike[] {
  return combineThreadMessages(
    convertTranscriptToThreadMessages(
      state.transcriptMessages,
      new Set(Object.keys(state.snapshot?.pendingUserInteraction ?? {})),
      t,
    ),
    state,
    t,
  )
}

/**
 * Whether the loading skeleton (`ThreadWelcome`) may render; ANDed with `thread.isEmpty`.
 * False once the transcript is fully delivered, even if it converts to nothing.
 *
 * @param convertedMessageCount length of the converted thread-message list
 *   (i.e. `convertBrowserRuntimeStateToThreadMessages(state).length`).
 */
export function shouldShowLoadingSkeleton(
  state: BrowserRuntimeClientState,
  convertedMessageCount: number,
): boolean {
  // A SETTLED transcript-only view is done loading, whatever it found (it never gets a
  // snapshot); the in-flight read still shows the skeleton.
  if (state.transcriptOnly) {
    return false
  }
  // Snapshot not yet arrived — still booting the session.
  if (state.snapshot == null) {
    return true
  }
  // Only the bare pre-runtime snapshot (neither `initialized` nor `uiReady`) pins the
  // skeleton; a provisional `uiReady` snapshot falls through like an initialized one.
  if (!state.snapshot.initialized && !state.snapshot.uiReady) {
    return true
  }
  // Genuinely-empty new thread (e.g. "New Thread"): nothing to load, so show
  // the interactive composer immediately rather than a loading skeleton.
  if (state.snapshot.messageCount <= 0) {
    return false
  }
  // The whole transcript has been delivered but converts to zero renderable
  // messages — an empty / all-internal conversation, not a loading state.
  const transcriptFullyDelivered =
    state.transcriptMessages.length >= state.snapshot.messageCount
  if (transcriptFullyDelivered && convertedMessageCount === 0) {
    return false
  }
  // messageCount > 0 and we're still waiting on the transcript (or its
  // converted messages) to arrive/render.
  return true
}

/**
 * Message kinds that render through a DEDICATED component instead of
 * `<AssistantMessage />` → `AssistantMessageBody` — the component whose first
 * hydration dispatches `nexus:assistantMessageBody:firstHydrated`. Mirrors the
 * `sourceType` switch in `HistoryRow` (components/assistant-ui/
 * thread.tsx); if a new sourceType diverts there, add it here or the boot
 * gate below can wait on a hydration signal that has no source.
 */
const NON_HYDRATING_SOURCE_TYPES: ReadonlySet<string> = new Set([
  'interrupt',
  'background_results',
  'compact_progress',
  'compact_boundary',
  'provider_api_error',
  'memory_saved',
])

/**
 * Whether the converted transcript mounts at least one `AssistantMessageBody`, i.e. whether
 * `nexus:assistantMessageBody:firstHydrated` can ever fire; if not, `AssistantUiThread`
 * fires it on transcript-settled.
 */
export function transcriptWillHydrateAssistantBody(
  messages: readonly ThreadMessageLike[],
): boolean {
  return messages.some(message => {
    if (message.role !== 'assistant') return false
    const sourceType = (
      message.metadata as
        | { custom?: { sourceType?: unknown } }
        | undefined
    )?.custom?.sourceType
    return (
      typeof sourceType !== 'string' ||
      !NON_HYDRATING_SOURCE_TYPES.has(sourceType)
    )
  })
}

/**
 * Whether the host boot-welcome overlay can be dismissed: the DISMISS half of the loading
 * contract, consistent with `shouldShowLoadingSkeleton` (the SHOW half). Event-driven, no
 * timer: ready status + snapshot; then, for a non-empty thread, `threadWelcomeUnmounted`
 * AND `bodyHydrated`.
 */
export function shouldDismissBootWelcome(
  state: BrowserRuntimeClientState,
  gates: { threadWelcomeUnmounted: boolean; bodyHydrated: boolean },
): boolean {
  // A SETTLED transcript-only view dismisses immediately, before the status check (a failed
  // read leaves `status: 'error'`); the SHOW half is false for it too.
  if (state.transcriptOnly) return true
  if (state.status !== 'ready') return false
  if (state.snapshot == null) return false
  // Never dismiss on the bare pre-runtime snapshot (neither `initialized` nor `uiReady`); a
  // provisional `uiReady` snapshot is dismissal-worthy, the render gates still apply.
  if (!state.snapshot.initialized && !state.snapshot.uiReady) return false
  if (state.snapshot.messageCount <= 0) return true
  return gates.threadWelcomeUnmounted && gates.bodyHydrated
}

/** A slash command's output row's stamp (`NoticeRow.slashCommand`), as
 *  the row's metadata carries it for a mod's `CommandOutput` site. */
function commandOutputStampOf(message: unknown): { commandOutput?: { command: string; args: string } } {
  const stamp = (message as { slashCommand?: { name?: unknown; args?: unknown } }).slashCommand
  return stamp && typeof stamp.name === 'string' && typeof stamp.args === 'string'
    ? { commandOutput: { command: stamp.name, args: stamp.args } }
    : {}
}
