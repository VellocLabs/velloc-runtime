import { reviewNoticeRunId } from '../../codeReview/review-protocol'
import type { ThreadMessageLike } from '@assistant-ui/react'
import type { ModelReplyRow, Message, UserRow } from '../../runtime/RuntimeTypes'
import { SYSTEM_SUBTYPE_COMPACT_BOUNDARY } from '../../runtime/VercelModelConstants'
import {
  type ThreadPart,
  type ToolCallInfo,
  type ToolResultEntry,
  asDate,
  backgroundResultKind,
  commandInvocationPillText,
  extractPlainUserText,
  formatBrowserValue,
  formatSystemMessage,
  isInternalToolResultMessage,
  isInterruptMarkerMessage,
  isInterruptToolUseVariant,
  skillBodyRefFromMessage,
  skillInvocationThreadMessage,
} from './assistantUiAdapterParts'
import { createTranslate, type TranslateFn } from './i18n/translate'
import {
  contentToAssistantParts,
  convertUserContentWithAttachments,
  hasPendingToolCalls,
} from './assistantUiAdapterContent'
import {
  backgroundResultsThreadMessage,
  compactBoundaryThreadMessage,
  memorySavedThreadMessage,
  teamMessageThreadMessage,
} from './assistantUiAdapterCards'
import { parseTeamMessageEnvelope } from '../../team/parseTeamFrame'
import { withoutPluginPromptFrame } from '../../mods/promptNouns'
import { a2uiBlockKeysOf } from './a2ui/a2uiRowKeys'

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

export function withProviderApiErrorMetadata(
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
        apiErrorMessage: assistantMessage.errorMessage,
        apiErrorCode: assistantMessage.errorCode,
        // Safety-stop category (the provider's `stop_details.category`, e.g.
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

export function convertTranscriptMessage(
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

      // An imported session's slash-command "pill" — a non-meta user message
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

      const { content, attachments, quotes } = convertUserContentWithAttachments(
        displayedUserContent(userMessage),
      )
      // A visible empty user turn renders as a blank bubble, so it is dropped
      // like the assistant branch drops empty content below. Older transcripts
      // carry one empty non-meta user message per continue-after-stop click. An attachment-only send is not
      // empty: its cards are the message.
      if (
        attachments.length === 0 &&
        quotes === undefined &&
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
        ...(userMessage.pluginPrompt || quotes !== undefined
          ? {
              metadata: {
                custom: {
                  ...(userMessage.pluginPrompt ? { pluginPrompt: { ...userMessage.pluginPrompt } } : {}),
                  // The quoted texts, in order; the source rows are not kept
                  // in the transcript.
                  ...(quotes !== undefined ? { quotes } : {}),
                },
              },
            }
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
            ...a2uiBlockKeysOf(assistantMessage.uuid, assistantMessage.message.content),
          },
        },
      }, assistantMessage, retryPrompt)
    }

    case 'system': {
      const reviewRunId = reviewNoticeRunId(message)
      if (reviewRunId) return {
        id: message.uuid ?? `review-${reviewRunId}`,
        role: 'assistant',
        content: [{ type: 'text', text: (t ?? createTranslate('en'))('reviewCard.title') }],
        status: { type: 'complete', reason: 'stop' },
        metadata: { custom: { sourceType: 'code-review', reviewRunId } },
      }

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
      // An imported `queued_command` attachment whose queued command is a
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
      // date-change, browser context) are INTERNAL context attached to the
      // user turn for the model — not user-authored chat. They are not
      // rendered as bubbles; the model still receives them in the API payload.
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

/**
 * The turn's closing reply: mark the LAST text part of an `end_turn` message
 * so the body renders it as its own top-level paragraph. The turn merge can
 * put more tool calls after it (a task-notification or hook wakes the agent
 * again), and without the mark it would fold into a collapsed tool group or
 * plan step and vanish from view. Both the transcript conversion and the live
 * path mark it, so the reply does not collapse while the turn is still live.
 */
export function markEndTurnReply(content: ThreadPart[], stopReason: unknown): void {
  if (stopReason !== 'end_turn') return
  for (let i = content.length - 1; i >= 0; i--) {
    const part = content[i]
    if (part && typeof part === 'object' && part.type === 'text') {
      ;(part as { endTurn?: boolean }).endTurn = true
      return
    }
  }
}

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
  // replaces it in place). An imported session has none: fall back to the
  // attachment entry's own uuid so the user's words still render.
  const id =
    typeof attachment.source_uuid === 'string'
      ? attachment.source_uuid
      : (message as { uuid?: unknown }).uuid
  if (typeof id !== 'string' || id === '') return null
  const { content, attachments, quotes } = convertUserContentWithAttachments(
    attachment.prompt,
  )
  if (
    attachments.length === 0 &&
    quotes === undefined &&
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
    metadata: { custom: { injectLanded: true, ...(quotes !== undefined ? { quotes } : {}) } },
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

/** A slash command's output row's stamp (`NoticeRow.slashCommand`), as
 *  the row's metadata carries it for a mod's `CommandOutput` site. */
function commandOutputStampOf(message: unknown): { commandOutput?: { command: string; args: string } } {
  const stamp = (message as { slashCommand?: { name?: unknown; args?: unknown } }).slashCommand
  return stamp && typeof stamp.name === 'string' && typeof stamp.args === 'string'
    ? { commandOutput: { command: stamp.name, args: stamp.args } }
    : {}
}
