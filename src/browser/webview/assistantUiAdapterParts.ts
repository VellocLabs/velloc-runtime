import type { ThreadMessageLike } from '@assistant-ui/react'
import type {
  ReadonlyJSONObject,
  ReadonlyJSONValue,
} from 'assistant-stream/utils'
import type {
  ModelReplyRow,
  Message,
  SystemMessagePart,
  UserRow,
} from '../../runtime/RuntimeTypes'
import { renderParts } from '../../input/systemMessageParts'
import { isMessageKey, type TranslateFn } from './i18n/translate'
import {
  extractBackgroundShellResultPreview,
  isBackgroundShellToolName,
  shouldLazyLoadToolDetail,
} from '../../utils/toolCallDetails'
import {
  STOPPED_BY_USER_TEXT,
  STOPPED_DURING_TOOL_TEXT,
} from '../../messages/messageFactories'
import { SKILL_TOOL_NAME } from '../../prompting/skillToolName'
import {
  getSkillBodyDetailId,
  isSkillInvocationStub,
  parseSkillInvocationTags,
} from '../../skillLibrary/skillInvocationTags'


/**
 * Low-level primitives shared by every stage of the assistant-ui adapter:
 * shape coercion, tool-call / tool-result extraction, and the value
 * formatters used to render tool arguments.
 *
 * This is the leaf of the adapter's module graph — it imports nothing from
 * its siblings, and all three of them import it.
 */

export type ThreadPart = Exclude<ThreadMessageLike['content'], string>[number]
export type ToolCallInfo = {
  toolName: string
  lazyDetail: boolean
}
export type ToolResultEntry = {
  value?: unknown
  preview?: unknown
  isError: boolean
  /** Set on a model-invoked `Skill` call whose injected skill-invocation
   *  message was found (see collectSkillBodyRefs) — the card renders the
   *  skill name from it and "View skill" opens the body. */
  skillBodyRef?: SkillBodyRef
}

/**
 * What a Skill card needs, carried as the `Skill` tool-call part's `result`. `detailId`: the
 * `skill:<uuid>` tool-detail id holding the full text (null without the sidecar); `inlineBody`: the full
 * text when the transcript row still carries it inline, else null.
 */
export type SkillBodyRef = {
  name: string
  args?: string
  detailId: string | null
  inlineBody: string | null
}

export const SKILL_BODY_REF_KEY = 'skillBodyRef'

/** Read a Skill card's body ref back off its `result` prop. */
export function readSkillBodyRef(result: unknown): SkillBodyRef | null {
  const ref = asRecord(asRecord(result)?.[SKILL_BODY_REF_KEY])
  if (!ref || typeof ref.name !== 'string') return null
  return {
    name: ref.name,
    ...(typeof ref.args === 'string' ? { args: ref.args } : {}),
    detailId: typeof ref.detailId === 'string' ? ref.detailId : null,
    inlineBody: typeof ref.inlineBody === 'string' ? ref.inlineBody : null,
  }
}

/** The body ref for one skill-invocation message (null if it is not one). */
export function skillBodyRefFromMessage(message: UserRow): SkillBodyRef | null {
  if (!message.isMeta) return null
  const content = message.message.content
  const tags = parseSkillInvocationTags(content)
  if (!tags) return null
  const detailId = getSkillBodyDetailId(message)
  return {
    name: tags.name,
    ...(tags.args !== undefined ? { args: tags.args } : {}),
    detailId,
    inlineBody:
      typeof content === 'string' && !isSkillInvocationStub(content)
        ? content
        : null,
  }
}

export type SkillBodyRefs = {
  /** Model-invoked `Skill` tool-call id -> the body its injected message holds. */
  byToolCallId: Map<string, SkillBodyRef>
  /** uuids of skill-invocation messages already represented by a tool call
   *  (the adapter must not ALSO synthesize a card for them). */
  absorbedMessageIds: Set<string>
}

/**
 * Pair each skill-invocation message with the model-invoked `Skill` tool
 * call that produced it. The SkillRunTool's `newMessages` are stamped with
 * `sourceToolAssistantUUID` = the assistant message holding the call; when
 * that message holds several Skill calls (parallel invocations) the n-th
 * injected message belongs to the n-th call. A message with no such source
 * (user-typed `/skill`) stays unpaired and gets its own synthesized card.
 */
export function collectSkillBodyRefs(
  messages: readonly Message[],
  toolCalls: ReadonlyMap<string, ToolCallInfo>,
): SkillBodyRefs {
  const byToolCallId = new Map<string, SkillBodyRef>()
  const absorbedMessageIds = new Set<string>()
  const skillCallsByAssistant = new Map<string, string[]>()
  const pairedPerAssistant = new Map<string, number>()

  for (const message of messages) {
    if (message.type === 'assistant') {
      const assistantMessage = message as ModelReplyRow
      const uuid = assistantMessage.uuid
      if (typeof uuid !== 'string') continue
      const ids: string[] = []
      for (const part of assistantMessage.message.content) {
        const record = asRecord(part)
        if (record?.type !== 'tool-call') continue
        const id = typeof record.toolCallId === 'string' ? record.toolCallId : null
        if (!id) continue
        const toolName =
          typeof record.toolName === 'string'
            ? record.toolName
            : toolCalls.get(id)?.toolName
        if (toolName === SKILL_TOOL_NAME) ids.push(id)
      }
      if (ids.length > 0) skillCallsByAssistant.set(uuid, ids)
      continue
    }
    if (message.type !== 'user') continue
    const userMessage = message as UserRow
    const ref = skillBodyRefFromMessage(userMessage)
    if (!ref) continue
    const source = (userMessage as { sourceToolAssistantUUID?: unknown })
      .sourceToolAssistantUUID
    if (typeof source !== 'string') continue
    const ids = skillCallsByAssistant.get(source)
    if (!ids) continue
    const n = pairedPerAssistant.get(source) ?? 0
    const toolCallId = ids[n]
    if (!toolCallId) continue
    pairedPerAssistant.set(source, n + 1)
    byToolCallId.set(toolCallId, ref)
    if (typeof userMessage.uuid === 'string') {
      absorbedMessageIds.add(userMessage.uuid)
    }
  }

  return { byToolCallId, absorbedMessageIds }
}

/** Fold the paired body refs into the tool-result map the part converter reads. */
export function applySkillBodyRefs(
  toolResults: Map<string, ToolResultEntry>,
  refs: SkillBodyRefs,
): void {
  for (const [toolCallId, skillBodyRef] of refs.byToolCallId) {
    const existing = toolResults.get(toolCallId)
    toolResults.set(toolCallId, {
      ...(existing ?? { isError: false }),
      skillBodyRef,
    })
  }
}

/** The thread message the adapter synthesizes for an UNPAIRED skill-invocation
 *  message (user-typed `/skill`): one `Skill` tool-call part carrying the body
 *  ref, rendered by SkillToolUI exactly like a model-invoked call. */
export function skillInvocationThreadMessage(params: {
  id: string
  createdAt: Date | undefined
  ref: SkillBodyRef
}): ThreadMessageLike {
  const { id, createdAt, ref } = params
  return {
    id,
    ...(createdAt ? { createdAt } : {}),
    role: 'assistant',
    status: { type: 'complete', reason: 'stop' },
    content: [
      {
        type: 'tool-call',
        toolCallId: ref.detailId ?? `skill-card:${id}`,
        toolName: SKILL_TOOL_NAME,
        args: { skill: ref.name, ...(ref.args !== undefined ? { args: ref.args } : {}) },
        argsText: '',
        result: { [SKILL_BODY_REF_KEY]: ref } as ReadonlyJSONObject,
      },
    ],
    metadata: { custom: { sourceType: 'skillInvocation' } },
  }
}

export const TOOL_BATCH_METADATA_KEY = 'toolBatch'

export type ToolBatchInfo = {
  mode: 'concurrent'
  batchId: string
  batchSize: number
}

export function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null
    ? (value as Record<string, unknown>)
    : null
}

export function readToolBatchInfo(
  record: Record<string, unknown>,
): ToolBatchInfo | undefined {
  const metadata = asRecord(record[TOOL_BATCH_METADATA_KEY])
  if (
    metadata?.mode === 'concurrent' &&
    typeof metadata.batchId === 'string' &&
    typeof metadata.batchSize === 'number' &&
    metadata.batchSize > 1
  ) {
    return {
      mode: 'concurrent',
      batchId: metadata.batchId,
      batchSize: metadata.batchSize,
    }
  }
  return undefined
}

// Frozen sentinel used to mark lazy-detail tool calls as "finished" without
// exposing their real result here (results for lazy-detail tools are loaded on
// demand by ToolFallback). assistant-ui only checks `!part.result` to decide
// running-vs-complete, so any non-falsy stable reference works.
export const LAZY_DETAIL_FINISHED_SENTINEL: ReadonlyJSONObject = Object.freeze({
  lazyDetailFinished: true,
})

export const SPAWN_TOOL_ID = 'Agent'
const BACKGROUND_AGENT_PENDING_RESULT: ReadonlyJSONObject = Object.freeze({
  backgroundAgentLaunchPending: true,
})

/**
 * Sentinel result injected into unresolved tool calls on the LAST assistant
 * message of a restored transcript. Prevents the UI from treating a dead
 * (app-killed) tool call as "still running" — which would animate the todo
 * spinner and show a perpetual "Working" state. The sentinel is truthy so
 * `part.result === undefined` checks (hasPendingToolCalls, isBackgroundRunning)
 * treat the call as settled.
 */
export const INTERRUPTED_TOOL_RESULT: ReadonlyJSONObject = Object.freeze({
  interruptedOnRestart: true,
})

/** True for the restart sentinel above (by shape, so a cloned copy counts). */
export function isInterruptedToolResult(result: unknown): boolean {
  return (
    typeof result === 'object' &&
    result !== null &&
    (result as { interruptedOnRestart?: unknown }).interruptedOnRestart === true
  )
}

function isBackgroundAgentArgs(args: unknown): boolean {
  const obj = asRecord(args)
  return obj?.run_in_background === true || obj?.isolation === 'worktree'
}

export function pendingBackgroundAgentResult(toolName: string, args: unknown): ReadonlyJSONObject | undefined {
  return toolName === SPAWN_TOOL_ID && isBackgroundAgentArgs(args)
    ? BACKGROUND_AGENT_PENDING_RESULT
    : undefined
}

// browser_actions args carry three long reflection strings
// (`evaluation_previous_goal` / `memory` / `next_goal`) plus the
// `actions[]` batch. The reflection strings are the bulk of the payload
// and stay lazy-loaded; we only need each action's `type` here so the
// trigger label can render the action sequence ("create tab - click tab")
// synchronously without waiting for the detail fetch.
export function extractBrowserActionsTypePreview(args: unknown): ReadonlyJSONObject {
  const obj = asRecord(args)
  if (!obj) return {}
  const single = asRecord(obj.action)
  if (single && typeof single.type === 'string') {
    return { actions: [{ type: single.type }] }
  }
  if (Array.isArray(obj.actions)) {
    const types = obj.actions
      .map(item => {
        const record = asRecord(item)
        return record && typeof record.type === 'string' ? { type: record.type } : null
      })
      .filter((item): item is { type: string } => item !== null)
    if (types.length > 0) return { actions: types }
  }
  return {}
}

export function asDate(timestamp?: string): Date | undefined {
  if (!timestamp) {
    return undefined
  }

  const parsed = new Date(timestamp)
  return Number.isNaN(parsed.valueOf()) ? undefined : parsed
}

export function formatBrowserValue(value: unknown): string {
  if (typeof value === 'string') {
    return value
  }

  if (Array.isArray(value)) {
    return value.map(item => formatBrowserValue(item)).join('\n')
  }

  const record = asRecord(value)
  if (record) {
    if (typeof record.text === 'string') {
      return record.text
    }

    if (typeof record.message === 'string') {
      return record.message
    }

    if (typeof record.thinking === 'string') {
      return record.thinking
    }

    if (Array.isArray(record.content)) {
      return record.content.map(item => formatBrowserValue(item)).join('\n')
    }

    return JSON.stringify(record, null, 2)
  }

  return String(value)
}

/**
 * Classify an imported `<task-notification>` (no `<task-type>` tag) by its `<summary>` prefix:
 * `Background command ` and `Monitor ` are shell tasks, anything else an agent task.
 */
export function ccTaskTypeFromSummary(
  summary: string,
): 'local_agent' | 'local_bash' {
  const trimmed = summary.trimStart()
  if (
    trimmed.startsWith('Background command ') ||
    trimmed.startsWith('Monitor ')
  ) {
    return 'local_bash'
  }
  return 'local_agent'
}

export function backgroundResultKind(text: string): 'shell' | 'subagent' | null {
  // Delivery: a background-task completion is one `<task-notification>`
  // turn (SharedWorkerSessionManager.formatTaskNotifications). Classify the card
  // by the FIRST block's `<task-type>` — the manager coalesces per-parent, so a
  // batch is single-kind in practice; a rare mixed batch renders as the first
  // kind's card (cosmetic only).
  if (!text.startsWith('<task-notification>')) return null
  const type = text.match(/<task-type>(local_agent|local_bash)<\/task-type>/)?.[1]
  if (type === 'local_bash') return 'shell'
  if (type === 'local_agent') return 'subagent'
  // Imported Claude Code notifications carry no `<task-type>` — infer the kind
  // from the first block's `<summary>` (see ccTaskTypeFromSummary) so they
  // render as a card instead of falling through to raw `<task-notification>`
  // XML in the transcript.
  const summary = text.match(/<summary>([\s\S]*?)<\/summary>/)?.[1] ?? ''
  return ccTaskTypeFromSummary(summary) === 'local_bash' ? 'shell' : 'subagent'
}

// Some models (e.g. gpt-5.5 in the A2UI action loop, told "do not narrate")
// emit a content-less "nothing to say" turn verbatim — an empty string,
// whitespace, or a bare quote-pair like "" or ''. Treat all of these as empty
// so they don't render as a stray `""` bubble. Only a STANDALONE pair matches
// (e.g. `the value is ""` is real content and is kept).
const CONTENTLESS_ASSISTANT_TEXT = new Set(['', '""', "''", '“”', '``'])
export function isContentlessAssistantText(text: string): boolean {
  return CONTENTLESS_ASSISTANT_TEXT.has(text.trim())
}

function toReadonlyJsonValue(value: unknown): ReadonlyJSONValue {
  if (
    value === null ||
    typeof value === 'string' ||
    typeof value === 'number' ||
    typeof value === 'boolean'
  ) {
    return value
  }

  if (Array.isArray(value)) {
    return value.map(item => toReadonlyJsonValue(item))
  }

  const record = asRecord(value)
  if (record) {
    return Object.fromEntries(
      Object.entries(record).map(([key, entry]) => [
        key,
        toReadonlyJsonValue(entry),
      ]),
    )
  }

  return formatBrowserValue(value)
}

export function normalizeToolArgs(value: unknown): ReadonlyJSONObject {
  const record = asRecord(value)
  if (!record) {
    return {}
  }

  return Object.fromEntries(
    Object.entries(record).map(([key, entry]) => [
      key,
      toReadonlyJsonValue(entry),
    ]),
  )
}

function tryParseJsonString(value: string): unknown {
  try {
    return JSON.parse(value) as unknown
  } catch {
    return value
  }
}

export function extractToolResultBlocks(message: UserRow): Array<{
  toolUseId: string
  rawValue: unknown
  isError: boolean
}> {
  const content = message.message.content
  if (!Array.isArray(content)) {
    return []
  }

  const results: Array<{
    toolUseId: string
    rawValue: unknown
    isError: boolean
  }> = []

  for (const part of content) {
    const record = asRecord(part)
    if (!record || record.type !== 'tool-result') {
      continue
    }

    const toolUseId =
      typeof record.toolCallId === 'string' ? record.toolCallId : null
    if (!toolUseId) {
      continue
    }

    results.push({
      toolUseId,
      rawValue: record.result,
      isError: record.isError === true,
    })
  }

  return results
}

export function formatSystemMessage(
  message: Message,
  /**
   * Active-locale translator. Omitted by callers that only need the English
   * text (tests, non-UI consumers), which is what `message` already holds.
   */
  t?: TranslateFn,
): string | null {
  if (message.type !== 'system') {
    return null
  }

  let messageText =
    typeof message.message === 'string' ? message.message : null

  // Slash-command output ships translatable parts beside the English text.
  // Translating HERE, in the adapter, rather than in a component: the copy
  // button reads `ThreadMessageLike.content` (the adapter's output), not the
  // DOM, so a component-only translation would copy English out of a Chinese
  // transcript.
  const parts = (message as { i18nContent?: SystemMessagePart[] }).i18nContent
  if (t && parts?.length && messageText !== null) {
    messageText = renderParts(parts, t, isMessageKey, messageText)
  }

  if (message.subtype === 'init') {
    return null
  }

  // Provider retry status messages (subtype 'api_error') are transient
  // progress indicators emitted while the query loop retries a failed
  // request. They must NOT appear in the transcript — the user only sees
  // the final ProviderApiErrorCard once retries are exhausted.
  if (message.subtype === 'api_error') {
    return null
  }

  if (!messageText) {
    return null
  }

  // Render slash-command output (subtype 'informational') and other system
  // notes as plain text — no `[subtype]` debug prefix. The user's typed
  // command is surfaced separately as its own user-message bubble (see the
  // slash branch in processUserInput), so the response reads on its own.
  return messageText
}

export function isInternalToolResultMessage(message: UserRow): boolean {
  const content = message.message.content
  return (
    Array.isArray(content) &&
    content.length > 0 &&
    content.every(part => {
      const record = asRecord(part)
      return record?.type === 'tool-result'
    })
  )
}

// Mirrors the Claude Code desktop detection in
// `src/components/messages/UserTextMessage.tsx`: the interrupt marker
// stays in conversation history (the next turn's model call needs to see
// it) but renders as a dim inline "Interrupted" affordance in the UI
// instead of a raw user bubble containing the sentinel text. Exact-string
// equality matches Claude Code's predicate — we deliberately don't fire
// on messages that merely *contain* the sentinel (e.g. a user quoting
// the phrase).
export function extractPlainUserText(message: UserRow): string | null {
  const content = message.message.content
  if (typeof content === 'string') {
    return content
  }
  if (
    Array.isArray(content) &&
    content.length === 1 &&
    asRecord(content[0])?.type === 'text' &&
    typeof (asRecord(content[0]) as { text?: unknown }).text === 'string'
  ) {
    return (asRecord(content[0]) as { text: string }).text
  }
  return null
}

/**
 * The pill text (`/<name> <args>`, or `Skill(<name>)`) for an imported slash-command invocation: a
 * non-meta user message carrying only the command tags. Null for any other shape, including native
 * isMeta skill invocations.
 */
export function commandInvocationPillText(message: UserRow): string | null {
  if (message.isMeta) return null
  const text = extractPlainUserText(message)
  if (text === null) return null
  const tags = parseSkillInvocationTags(text)
  if (!tags) return null
  if (tags.skillFormat) return `Skill(${tags.name})`
  return tags.args ? `/${tags.name} ${tags.args}` : `/${tags.name}`
}

export function isInterruptMarkerMessage(message: UserRow): boolean {
  const text = extractPlainUserText(message)
  return (
    text === STOPPED_BY_USER_TEXT || text === STOPPED_DURING_TOOL_TEXT
  )
}

export function isInterruptToolUseVariant(message: UserRow): boolean {
  return extractPlainUserText(message) === STOPPED_DURING_TOOL_TEXT
}

export function collectToolResults(
  messages: readonly Message[],
  toolCalls: ReadonlyMap<string, ToolCallInfo>,
): Map<string, ToolResultEntry> {
  const toolResults = new Map<string, ToolResultEntry>()

  for (const message of messages) {
    if (message.type !== 'user') {
      continue
    }

    const userMessage = message as UserRow
    for (const result of extractToolResultBlocks(userMessage)) {
      const toolCallInfo = toolCalls.get(result.toolUseId)
      const lazyDetail = toolCallInfo?.lazyDetail === true
      const resultValue =
        typeof result.rawValue === 'string'
          ? tryParseJsonString(result.rawValue)
          : result.rawValue
      toolResults.set(result.toolUseId, {
        value: lazyDetail ? undefined : resultValue,
        preview:
          lazyDetail &&
          toolCallInfo?.toolName &&
          isBackgroundShellToolName(toolCallInfo.toolName)
            ? extractBackgroundShellResultPreview(result.rawValue) ?? undefined
            : undefined,
        isError: result.isError,
      })
    }
  }

  return toolResults
}

export function collectToolCalls(
  messages: readonly Message[],
): Map<string, ToolCallInfo> {
  const toolCalls = new Map<string, ToolCallInfo>()

  for (const message of messages) {
    if (message.type === 'assistant') {
      const assistantMessage = message as ModelReplyRow
      for (const part of assistantMessage.message.content) {
        const record = asRecord(part)
        if (!record) {
          continue
        }

        const partType = typeof record.type === 'string' ? record.type : null
        if (partType !== 'tool-call') {
          continue
        }

        const toolCallId =
          typeof record.toolCallId === 'string'
            ? record.toolCallId
            : null
        const toolName =
          typeof record.toolName === 'string'
            ? record.toolName
            : null

        if (!toolCallId || !toolName) {
          continue
        }

        toolCalls.set(toolCallId, {
          toolName,
          lazyDetail: shouldLazyLoadToolDetail(toolName),
        })
      }
    }

    const toolDetailRef = asRecord(
      (message as { toolCallDetailRef?: unknown }).toolCallDetailRef,
    )
    if (
      typeof toolDetailRef?.toolCallId === 'string' &&
      typeof toolDetailRef.toolName === 'string'
    ) {
      toolCalls.set(toolDetailRef.toolCallId, {
        toolName: toolDetailRef.toolName,
        lazyDetail: shouldLazyLoadToolDetail(toolDetailRef.toolName),
      })
    }
  }

  return toolCalls
}
