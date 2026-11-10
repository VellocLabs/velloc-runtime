import type { ThreadMessageLike } from '@assistant-ui/react'
import type { ModelReplyRow, Message, UserRow } from '../../runtime/RuntimeTypes'
import type { BrowserRuntimeClientState, InjectBubble } from './BrowserRuntimeClient'
import { PRIOR_TODOS_KEY, readTodoWriteTodos, type PriorTodoStatus } from '../../utils/todoSections'
import { CHECKLIST_TOOL_ID } from '../../toolkit/builtin/todoWrite'
import {
  INTERRUPTED_TOOL_RESULT,
  type ThreadPart,
  backgroundResultKind,
  collectToolCalls,
  collectToolResults,
  extractPlainUserText,
  isInternalToolResultMessage,
  isInterruptMarkerMessage,
  applySkillBodyRefs,
  collectSkillBodyRefs,
} from './assistantUiAdapterParts'
import type { TranslateFn } from './i18n/translate'
import { TURN_SETTLED_KEY } from './turnSettled'
import {
  contentToAssistantParts,
  convertUserContentWithAttachments,
} from './assistantUiAdapterContent'
import {
  backgroundResultsThreadMessage,
  isBackgroundResultsThreadMessage,
  isCompactBoundaryThreadMessage,
  isCompactProgressThreadMessage,
  isProviderApiErrorThreadMessage,
  isTeamMessageThreadMessage,
} from './assistantUiAdapterCards'
import { parseTeamMessageEnvelope } from '../../team/parseTeamFrame'
import { splitQuotedPrompt } from './replyQuote'
import { mergeA2uiBlockKeys } from './a2ui/a2uiRowKeys'
import {
  mergeLineRanges,
  mergePartLines,
  mergeTextLines,
  lineOf,
  collectToolLineRanges,
  withLineRange,
  TEXT_LINES_KEY,
  PART_LINES_KEY,
  TOOL_LINE_RANGES_KEY,
} from './assistantUiAdapterLines'
import { createLiveAssistantMessages } from './assistantUiAdapterLive'
import { convertTranscriptMessage } from './assistantUiAdapterMessage'
export {
  PROVIDER_API_ERROR_RESUME_PROMPT,
  type ProviderApiErrorRetryAction,
  resolveProviderApiErrorRetryAction,
} from './assistantUiAdapterMessage'
export {
  extractTextFromAppendMessage,
  buildPromptFromAppendMessage,
} from './assistantUiAdapterPrompt'
export {
  mergePartLines,
  mergeTextLines,
  mergeLineRanges,
  PART_LINES_KEY,
  TEXT_LINES_KEY,
  TOOL_LINE_RANGES_KEY,
  collectToolLineRanges,
  toolLineRange,
} from './assistantUiAdapterLines'

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
            ...mergeA2uiBlockKeys(previous, message),
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
 * Whether a row id is the turn-anchored one `stabilizeTrailingAssistantId`
 * gives the conversation's closing assistant message, rather than a transcript
 * uuid. A cut at that row is a cut at the conversation's end.
 */
export function isTurnAnchoredMessageId(messageId: string): boolean {
  return messageId.startsWith('turn:') && messageId.endsWith(':assistant')
}

/**
 * Where a side chat started from a row is cut (F-36): at that row's uuid; at
 * the conversation's end for the turn-anchored closing reply; nowhere (null)
 * while the row is still running, since its text is not yet in the
 * transcript. Running is the row's state, not its id: the streaming reply
 * already carries the turn-anchored id.
 */
export function sideChatCutForRow(
  messageId: string,
  running: boolean,
): { cutUuid: string | undefined } | null {
  if (running) return null
  return { cutUuid: isTurnAnchoredMessageId(messageId) ? undefined : messageId }
}

/** `sideChatCutForRow` for a row of the thread, by id; null when the row is not there. */
export function sideChatCutForThreadRow(
  messages: readonly Pick<ThreadMessageLike, 'id' | 'status'>[],
  messageId: string,
): { cutUuid: string | undefined } | null {
  const row = messages.find((message) => message.id === messageId)
  if (!row) return null
  return sideChatCutForRow(messageId, row.status?.type === 'running')
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

function pendingPromptContent(
  prompt: string,
): Pick<ThreadMessageLike, 'content' | 'attachments' | 'metadata'> {
  const { content, attachments, quotes } = convertUserContentWithAttachments(prompt)
  const metadata = quotes === undefined ? {} : { metadata: { custom: { quotes } } }
  return attachments.length > 0 || quotes !== undefined
    ? { content, ...(attachments.length > 0 ? { attachments } : {}), ...metadata }
    : { content: prompt }
}

function isInjectBubbleThreadMessage(message: ThreadMessageLike): boolean {
  const custom = (message.metadata as { custom?: { injectState?: unknown } } | undefined)?.custom
  return custom?.injectState !== undefined
}

/** A plain-Enter message not yet rendered from the stream / transcript. */
function injectBubbleThreadMessage(bubble: InjectBubble): ThreadMessageLike {
  const { quotes, text } = splitQuotedPrompt(bubble.text)
  return {
    id: bubble.uuid,
    role: 'user',
    content: quotes.length > 0 ? text : bubble.text,
    metadata: {
      custom: {
        ...(quotes.length > 0 ? { quotes } : {}),
        injectState: bubble.state,
        injectUuid: bubble.uuid,
        ...(bubble.hasAttachments ? { injectHasAttachments: true } : {}),
      },
    },
  }
}

/** The cheap half: appends the pending prompt + live events onto the memoized transcript
 *  conversion, then merges; the only part that re-runs per token. */
export function combineThreadMessages(
  transcript: ConvertedTranscript,
  state: BrowserRuntimeClientState,
  /** Active-locale translator for slash output's `i18nContent`. */
  t?: TranslateFn,
): ThreadMessageLike[] {
  const idCounter = { value: transcript.nextId }
  const persistedUuids = new Set(state.transcriptMessages.flatMap(message =>
    typeof message.uuid === 'string' && message.uuid.length > 0 ? [message.uuid] : [],
  ))
  const anchor = findTurnAnchorUuid(state)
  // Copy: `transcript.messages` is reused across renders by the memoizing
  // caller, so it must never be mutated by the pushes below.
  const liveRows = state.liveEvents.filter((event): event is Message =>
    event !== null && typeof event === 'object' && (event as { type?: unknown }).type === 'user',
  )
  const calls = collectToolCalls(state.transcriptMessages)
  const liveResults = collectToolResults(liveRows, calls)
  const persistedRefs = collectSkillBodyRefs(state.transcriptMessages, calls)
  const combinedRows = [
    ...state.transcriptMessages,
    ...state.liveEvents.filter((event): event is Message =>
      event !== null && typeof event === 'object' &&
      ['assistant', 'user'].includes((event as { type: string }).type) &&
      !(event.uuid && persistedUuids.has(event.uuid)),
    ),
  ]
  const missingRefs = collectSkillBodyRefs(combinedRows, calls)
  for (const id of persistedRefs.byToolCallId.keys()) missingRefs.byToolCallId.delete(id)
  const persistedResults = collectToolResults(state.transcriptMessages, calls)
  const pendingLiveCalls = new Set(
    state.status === 'submitting'
      ? [...collectToolCalls(state.liveEvents.slice(state.liveEventsTurnStart ?? 0)
          .filter((event): event is Message => event.type === 'assistant')).keys()]
          .filter(id => !persistedResults.has(id) && !liveResults.has(id) && !persistedRefs.byToolCallId.has(id))
      : [],
  )
  for (const id of persistedResults.keys()) liveResults.delete(id)
  applySkillBodyRefs(liveResults, missingRefs)
  const updatedTools = new Map<string, ThreadPart>()
  for (const message of state.transcriptMessages) {
    if (message.type !== 'assistant') continue
    const content = (message as ModelReplyRow).message.content
    if (!Array.isArray(content)) continue
    const matching = content.filter(block => block.type === 'tool-call' && typeof block.toolCallId === 'string' && (liveResults.has(block.toolCallId) || pendingLiveCalls.has(block.toolCallId)))
    for (const part of contentToAssistantParts(matching, liveResults, calls, idCounter)) {
      if (part.type === 'tool-call' && typeof part.toolCallId === 'string' && (liveResults.has(part.toolCallId) || pendingLiveCalls.has(part.toolCallId))) updatedTools.set(part.toolCallId, part)
    }
  }
  const messages = transcript.messages.map(message => !Array.isArray(message.content) ? message : {
    ...message,
    content: message.content.map(part => part.type === 'tool-call' && updatedTools.has(part.toolCallId)
      ? { ...part, ...updatedTools.get(part.toolCallId) }
      : part),
  })

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
              ...pendingPromptContent(state.preSplitPrompt),
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
        persistedUuids,
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
    persistedUuids,
    t,
  )
  const trailingMessage = messages.at(-1)
  if (
    state.status === 'submitting' &&
    liveMessages.length === 0 &&
    trailingMessage?.role === 'assistant' &&
    state.liveEvents.slice(liveTurnStart).some(event =>
      event.type === 'assistant' && !!event.uuid && persistedUuids.has(event.uuid),
    )
  ) {
    // Assistant-ui derives thread liveness from the trailing message's status.
    messages[messages.length - 1] = { ...trailingMessage, status: { type: 'running' } }
  }
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

  const trailingCard = messages.at(-1)
  if (
    state.status === 'submitting' &&
    trailingCard &&
    (isBackgroundResultsThreadMessage(trailingCard) || isTeamMessageThreadMessage(trailingCard)) &&
    state.liveEvents.slice(liveTurnStart).some(event =>
      event.type === 'attachment' && event.uuid === trailingCard.id,
    )
  ) {
    // A completed task does not settle the parent turn waiting on its next reply.
    messages[messages.length - 1] = { ...trailingCard, status: { type: 'running' } }
  }

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
  'code-review',
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
