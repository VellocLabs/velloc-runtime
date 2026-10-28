import type { StreamRecord } from '../runtime/RuntimeTypes'
import type {
  ModelReplyRow,
  Message,
  UserRow,
} from '../runtime/RuntimeTypes'
import type { FileChangeDiff } from './fileChangeHunks'
import {
  MSG_TYPE_ASSISTANT,
  MSG_TYPE_USER,
  MSG_TYPE_SYSTEM,
  MSG_TYPE_ATTACHMENT,
  MSG_TYPE_TOMBSTONE,
  MSG_TYPE_STREAM_EVENT,
  PART_TOOL_CALL,
  PART_TOOL_RESULT_CANONICAL,
  STREAM_CONTENT_BLOCK_START,
  DELTA_TOOL_CALL,
  STREAM_MESSAGE_DELTA,
  isAssistantMessage,
  isUserMessage,
  isToolUsePart,
} from '../runtime/VercelModelConstants'
import { ASK_TOOL_ID } from '../toolkit/builtin/askUser'
import { CHECKLIST_TOOL_ID } from '../toolkit/builtin/todoWrite'
import { A2UI_TOOL_NAMES } from '../toolkit/builtin/a2ui/a2uiToolNames'
import {
  EDIT_TOOL_ID,
  READ_TOOL_ID,
  WRITE_TOOL_ID,
} from '../prompting/fileToolNames'
import { TASK_ID_PATTERN } from '../backgroundTasks/taskId'
import {
  getSkillBodyDetailId,
  isSkillInvocationStub,
  skillInvocationStub,
} from '../skillLibrary/skillInvocationTags'
import { SKILL_TOOL_NAME } from '../prompting/skillToolName'
import { clonePlain } from './clonePlain'
import { toolResultParts, toolResultText } from './toolResultParts'

// A defensive copy that shares strings (immutable) — see clonePlain.ts.
function cloneValue<T>(value: T): T {
  return clonePlain(value)
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null
    ? (value as Record<string, unknown>)
    : null
}

function hasStringProperty(
  value: Record<string, unknown>,
  key: string,
): value is Record<string, string> {
  return typeof value[key] === 'string'
}

export const BACKGROUND_SHELL_TOOL_NAMES = new Set(['Bash', 'PowerShell'])

export type BackgroundShellArgsPreview = {
  command?: string
  run_in_background?: true
}

export type BackgroundShellResultPreview = {
  shell_id: string
  // 'running'   → a still-executing background handoff (its output lives in the
  //               drawer; the card is body-less and pinned complete).
  // 'completed' → a foreground-completed background shell (always-background
  //               middle layer): the inline `{output, exit_code, task_id}`
  //               result carries the `local_bash` task id, so the card offers a
  //               jump to the drawer item AND keeps its normal (lazy) output
  //               body. See buildForegroundShellResult in toolkit/builtin/host/shellArgs.ts.
  status: 'running' | 'completed'
}

export function isBackgroundShellToolName(toolName: string): boolean {
  return BACKGROUND_SHELL_TOOL_NAMES.has(toolName)
}

export function extractBackgroundShellArgsPreview(
  source: unknown,
  options: { includeForeground?: boolean } = {},
): BackgroundShellArgsPreview | null {
  const obj = asRecord(source)
  const isExplicitBackground = obj?.run_in_background === true
  if (!obj || (!isExplicitBackground && !options.includeForeground)) {
    return null
  }

  const preview: BackgroundShellArgsPreview = {}
  if (isExplicitBackground) {
    preview.run_in_background = true
  }
  if (typeof obj.command === 'string') {
    preview.command = obj.command
  }
  return preview.command || preview.run_in_background ? preview : null
}

function asRecordOrJsonString(value: unknown): Record<string, unknown> | null {
  const obj = asRecord(value)
  if (obj) return obj
  if (typeof value !== 'string') return null

  try {
    return asRecord(JSON.parse(value))
  } catch {
    return null
  }
}

export function extractBackgroundShellResultPreview(
  source: unknown,
): BackgroundShellResultPreview | null {
  const obj = asRecordOrJsonString(source)
  const shellId = obj?.shell_id
  const backgroundShellId = obj?.background_shell_id
  // The host's background / auto-background-on-timeout handoff result
  // (`buildBackgroundShellRunningResult`) carries the shell id under `task_id`
  // with `status:'running'` — the kind-agnostic task-registry rename moved it
  // off `shell_id`. Recognize it so the foreground→background flip renders the
  // background-handoff chrome (label + "Open in Background Tasks", status pinned
  // complete) instead of a plain lazy Bash card showing raw `{task_id,…}` JSON.
  const taskId = obj?.task_id
  const status = obj?.status
  if (status === 'running' && typeof shellId === 'string' && shellId.length > 0) {
    return { shell_id: shellId, status: 'running' }
  }
  if (typeof backgroundShellId === 'string' && backgroundShellId.length > 0) {
    return { shell_id: backgroundShellId, status: 'running' }
  }
  if (status === 'running' && typeof taskId === 'string' && taskId.length > 0) {
    return { shell_id: taskId, status: 'running' }
  }
  // A foreground-COMPLETED background shell (always-background middle layer): the
  // inline `{output, exit_code, task_id}` result carries the `local_bash` task id
  // but no running status. Surface it as a `completed` preview so the card can
  // offer the ">>" jump to the drawer item while keeping its normal output body.
  // Placed AFTER the running checks so a still-running handoff is never mis-tagged.
  // Also matches the re-fed preview shape `{shell_id, status:'completed'}` (this
  // function must be idempotent on its own output — the card re-extracts the id
  // from the slim transcript preview), hence the `shell_id ?? task_id` id source.
  const completedId =
    typeof shellId === 'string' && shellId.length > 0
      ? shellId
      : typeof taskId === 'string' && taskId.length > 0
        ? taskId
        : null
  if (completedId) {
    return { shell_id: completedId, status: 'completed' }
  }
  if (typeof source === 'string' && /\bbackground\b/i.test(source)) {
    // The current handoff id is a kind-prefixed `mintTaskHandle('local_bash')`
    // token (`b<base36>`, via TASK_ID_PATTERN); older transcripts used a legacy
    // `bg_…` shell id. Accept either so the string-only prose path is not stale.
    const bashTaskId = `(?:${TASK_ID_PATTERN}|bg_(?:[0-9a-f-]{36}|\\d+))`
    const explicitId =
      source.match(new RegExp(`\\bshell_id\\s*=\\s*(${bashTaskId})\\b`, 'i'))?.[1] ??
      source.match(new RegExp(`\\bshell id\\s+(${bashTaskId})\\b`, 'i'))?.[1] ??
      source.match(new RegExp(`\\bshell_id["']?\\s*:\\s*["']?(${bashTaskId})\\b`, 'i'))?.[1] ??
      // The prose handoff message reads "…moved to the background with ID: b…".
      source.match(new RegExp(`\\bwith ID:\\s*(${bashTaskId})\\b`, 'i'))?.[1]
    if (explicitId) {
      return { shell_id: explicitId, status: 'running' }
    }
  }
  return null
}

export const INLINE_TOOL_DETAIL_TOOL_NAMES = new Set([
  'collect_contact',
  'select_date',
  'show_location',
  // TodoWrite args are the tiny list rendered by <TodoSection> in the
  // assistant message body — lazy-loading them would force the section
  // header to flicker through an "empty plan" state on first render.
  CHECKLIST_TOOL_ID,
  // AskUserQuestion's args carry the question text + 2-4 options that the
  // dedicated AskUserQuestionToolUI renders inline. Lazy-loading them strips
  // `args` before the UI mounts and the component falls back to "No questions
  // provided.", leaving the user unable to answer. Same rationale as
  // TodoWrite above. The tool has its own generative UI (registered in
  // GenerativeToolUIs.tsx) so the lazy-detail ToolFallback path never runs
  // for it — args MUST be inline.
  ASK_TOOL_ID,
  // A2UI command-tool args (surface component tree + data-model patches) are
  // the source of truth the guest derives surfaces from — `extractA2uiCommands`
  // reads them straight off the transcript (on load and live) and feeds the
  // canonical-message translator + renderer. They MUST stay inline; stripping
  // them to a .tool-details sidecar would leave the guest unable to rebuild
  // surface state. See F-1.
  ...A2UI_TOOL_NAMES,
  // Agent args (`description`, `subagent_type`) feed the sub-agent card title.
  // Inline literal keeps the server tool module out of the renderer bundle.
  'Agent',
  // The teammate spawn, same reasoning: the spawn CARD is classified from the
  // ack text and, before the ack lands, from `args.name` — lazy-loading would
  // strip both (no LABEL_PREVIEW row carries `name`) and the card would never
  // render for a persisted call. Inline literal: SPAWN_TEAMMATE_TOOL_NAME in
  // toolkit/builtin/spawnTeammate.ts.
  'SpawnTeammate',
])

export type BrowserToolCallDetailRef = {
  toolCallId: string
  toolName: string
}

export type BrowserToolCallDetailRecord = BrowserToolCallDetailRef & {
  args?: unknown
  result?: unknown
  origin?: unknown
  // UI-only file-relative diff for Edit/Write (see ToolResult.uiEditDiff). It
  // rides the detail record only — it is never folded into the model-facing
  // `result` by hydrateMessageToolPayloads, so it can't bloat the transcript.
  editDiff?: FileChangeDiff
  isError?: boolean
  updatedAt?: number
}

export function shouldInlineToolPayloads(toolName: string): boolean {
  return INLINE_TOOL_DETAIL_TOOL_NAMES.has(toolName)
}

export function shouldLazyLoadToolDetail(toolName: string): boolean {
  return !shouldInlineToolPayloads(toolName)
}

function toToolCallDetailRef(
  toolCallId: string | null,
  toolName: string | null,
): BrowserToolCallDetailRef | null {
  if (!toolCallId || !toolName || !shouldLazyLoadToolDetail(toolName)) {
    return null
  }

  return {
    toolCallId,
    toolName,
  }
}

function getToolCallId(record: Record<string, unknown>): string | null {
  if (hasStringProperty(record, 'id')) {
    return record.id
  }

  return hasStringProperty(record, 'toolCallId') ? record.toolCallId : null
}

function getToolName(record: Record<string, unknown>): string | null {
  if (hasStringProperty(record, 'name')) {
    return record.name
  }

  return hasStringProperty(record, 'toolName') ? record.toolName : null
}

function getTimestampValue(message: Message): number | undefined {
  if (typeof message.timestamp !== 'string') {
    return undefined
  }

  const parsed = Date.parse(message.timestamp)
  return Number.isFinite(parsed) ? parsed : undefined
}

export function getToolCallDetailsFromMessage(
  message: Message,
): BrowserToolCallDetailRecord[] {
  const details: BrowserToolCallDetailRecord[] = []
  const updatedAt = getTimestampValue(message)

  if (isAssistantMessage(message)) {
    const assistantMessage = message as ModelReplyRow
    const content = assistantMessage.message.content
    for (const part of content) {
      const record = asRecord(part)
      if (!record) {
        continue
      }

      if (!isToolUsePart(record as { type: string })) {
        continue
      }

      const toolCallId = getToolCallId(record)
      const toolName = getToolName(record)
      const detailRef = toToolCallDetailRef(toolCallId, toolName)
      if (!detailRef) {
        continue
      }

      details.push({
        toolCallId: detailRef.toolCallId,
        toolName: detailRef.toolName,
        args: record.args,
        updatedAt,
      })
    }
  }

  const detailRecord = asRecord((message as { toolCallDetail?: unknown }).toolCallDetail)
  if (detailRecord) {
    const toolCallId =
      typeof detailRecord.toolCallId === 'string'
        ? detailRecord.toolCallId
        : null
    const toolName =
      typeof detailRecord.toolName === 'string'
        ? detailRecord.toolName
        : null

    const detailRef = toToolCallDetailRef(toolCallId, toolName)
    if (detailRef) {
      details.push({
        toolCallId: detailRef.toolCallId,
        toolName: detailRef.toolName,
        args: detailRecord.args,
        result: detailRecord.result,
        editDiff: detailRecord.editDiff as FileChangeDiff | undefined,
        isError: detailRecord.isError === true,
        updatedAt:
          typeof detailRecord.updatedAt === 'number'
            ? detailRecord.updatedAt
            : updatedAt,
      })
    }
  }

  return details
}

export function getLazyToolCallRefsFromMessage(
  message: Message,
): BrowserToolCallDetailRef[] {
  const refs = new Map<string, BrowserToolCallDetailRef>()

  if (isAssistantMessage(message)) {
    const assistantMessage = message as ModelReplyRow
    for (const part of assistantMessage.message.content) {
      const record = asRecord(part)
      if (!record) {
        continue
      }

      const partType = typeof record.type === 'string' ? record.type : null
      if (partType !== PART_TOOL_CALL) {
        continue
      }

      const ref = toToolCallDetailRef(
        getToolCallId(record),
        getToolName(record),
      )
      if (ref) {
        refs.set(ref.toolCallId, ref)
      }
    }
  }

  const toolCallDetailRef = asRecord(
    (message as { toolCallDetailRef?: unknown }).toolCallDetailRef,
  )
  if (toolCallDetailRef) {
    const ref = toToolCallDetailRef(
      typeof toolCallDetailRef.toolCallId === 'string'
        ? toolCallDetailRef.toolCallId
        : null,
      typeof toolCallDetailRef.toolName === 'string'
        ? toolCallDetailRef.toolName
        : null,
    )
    if (ref) {
      refs.set(ref.toolCallId, ref)
    }
  }

  const detailRecord = asRecord((message as { toolCallDetail?: unknown }).toolCallDetail)
  if (detailRecord) {
    const ref = toToolCallDetailRef(
      typeof detailRecord.toolCallId === 'string'
        ? detailRecord.toolCallId
        : null,
      typeof detailRecord.toolName === 'string'
        ? detailRecord.toolName
        : null,
    )
    if (ref) {
      refs.set(ref.toolCallId, ref)
    }
  }

  return Array.from(refs.values())
}

export function mergeToolCallDetails(
  current: BrowserToolCallDetailRecord | undefined,
  incoming: BrowserToolCallDetailRecord,
): BrowserToolCallDetailRecord {
  return {
    toolCallId: incoming.toolCallId,
    toolName: incoming.toolName || current?.toolName || 'tool',
    args:
      incoming.args !== undefined
        ? cloneValue(incoming.args)
        : current?.args !== undefined
          ? cloneValue(current.args)
          : undefined,
    result:
      incoming.result !== undefined
        ? cloneValue(incoming.result)
        : current?.result !== undefined
          ? cloneValue(current.result)
          : undefined,
    origin:
      incoming.origin !== undefined
        ? cloneValue(incoming.origin)
        : current?.origin !== undefined
          ? cloneValue(current.origin)
          : undefined,
    editDiff:
      incoming.editDiff !== undefined
        ? cloneValue(incoming.editDiff)
        : current?.editDiff !== undefined
          ? cloneValue(current.editDiff)
          : undefined,
    isError:
      incoming.isError !== undefined ? incoming.isError : current?.isError,
    updatedAt:
      incoming.updatedAt !== undefined
        ? incoming.updatedAt
        : current?.updatedAt,
  }
}

// browser_actions args carry three long reflection strings
// (`evaluation_previous_goal` / `memory` / `next_goal`) plus the
// `actions[]` batch. The reflections are the bulk of the payload and
// stay lazy-loaded; we just need each action's `type` to survive
// sanitization so the trigger label can render the action sequence
// ("create tab - click tab") synchronously without waiting for the
// detail fetch.
function extractBrowserActionsTypePreview(
  source: unknown,
): { actions: Array<{ type: string }> } | null {
  const obj = asRecord(source)
  if (!obj) return null
  const single = asRecord(obj.action)
  if (single && typeof single.type === 'string') {
    return { actions: [{ type: single.type }] }
  }
  if (Array.isArray(obj.actions)) {
    const types = obj.actions
      .map(item => {
        const record = asRecord(item)
        return record && typeof record.type === 'string'
          ? { type: record.type }
          : null
      })
      .filter((item): item is { type: string } => item !== null)
    if (types.length > 0) return { actions: types }
  }
  return null
}

// Read/Edit/Write args carry the heavy payload (Read: the file slice in the
// result; Edit: old+new strings; Write: the whole file `content`). Those stay
// lazy-loaded, but the tool card's title needs `file_path` synchronously — the
// card shows "Read/Edited/Wrote <file>" and links the filename to the
// right-panel view before the card is ever expanded. Keep just that one cheap
// field as a slim preview, exactly like the browser_actions type preview above.
// (Without Write here its args were stripped whole, so the Write card fell back
// to a bare "Write" with no filename — see the dated log.)
function extractFilePathPreview(source: unknown): { file_path: string } | null {
  const obj = asRecord(source)
  if (obj && typeof obj.file_path === 'string') {
    return { file_path: obj.file_path }
  }
  return null
}

// SuperEdit's slim preview keeps only `description`; `code` and `inputs` go to
// the sidecar. Inline literal keeps the server tool module out of this util.
const SUPER_EDIT_TOOL_NAME = 'SuperEdit'
function extractRunJsArgsPreview(
  source: unknown,
): { description: string } | null {
  const obj = asRecord(source)
  if (obj && typeof obj.description === 'string' && obj.description.length > 0) {
    return { description: obj.description }
  }
  return null
}

// Skill args are `{skill, args}` — two short strings. The Skill card title
// needs the skill name synchronously (same rationale as Read/Edit's
// file_path), so keep both; the sidecar still holds the canonical copy.
function extractSkillArgsPreview(
  source: unknown,
): { skill: string; args?: string } | null {
  const obj = asRecord(source)
  if (!obj || typeof obj.skill !== 'string') return null
  return {
    skill: obj.skill,
    ...(typeof obj.args === 'string' && obj.args.length > 0
      ? { args: obj.args }
      : {}),
  }
}

// Label-bearing lazy tools keep their short identifying string field(s) as the
// slim preview; a tool absent from every preview path has its args stripped
// whole. Values must stay short strings.
const LABEL_PREVIEW_STRING_FIELDS: Record<string, readonly string[]> = {
  Grep: ['pattern', 'path'],
  Glob: ['pattern', 'path'],
  WebSearch: ['query'],
  WebFetch: ['url'],
  ToolSearch: ['query'],
  NotebookEdit: ['notebook_path'],
  WorkspaceDiff: ['path'],
  // SuperShell: `code`/`inputs` are heavy and go to the sidecar; the card label
  // needs only the short `description`.
  SuperShell: ['description'],
  // SendMessage: the collapsed row's title is "SendMessage: <to>" — the
  // recipient is the one fact the row must show synchronously, and it is what
  // `toolUseSummary` reads. `message` (the heavy body) stays lazy-loaded in
  // the sidecar and renders behind the ">" expand. Inline literal (matches
  // MAIL_TOOL_ID in utils/toolLabels.ts) for the renderer-bundle
  // reason noted above. Keep this in step with LABEL_ARG_FIELDS there: this
  // table decides what NEW transcripts keep, that one what an OLD row (args
  // stripped whole, written before this preview existed) recovers.
  SendMessage: ['to'],
}

function extractLabelStringFieldsPreview(
  toolName: string,
  source: unknown,
): Record<string, string> | null {
  const fields = LABEL_PREVIEW_STRING_FIELDS[toolName]
  if (!fields) return null
  const obj = asRecord(source)
  if (!obj) return null
  const preview: Record<string, string> = {}
  for (const field of fields) {
    const value = obj[field]
    if (typeof value === 'string' && value.length > 0) {
      preview[field] = value
    }
  }
  return Object.keys(preview).length > 0 ? preview : null
}

function sanitizeAssistantContentPartForLazyDetail(
  part: Record<string, unknown>,
): Record<string, unknown> {
  const partType = typeof part.type === 'string' ? part.type : null
  if (partType !== PART_TOOL_CALL) {
    return part
  }

  const toolName = getToolName(part)
  if (!toolName || !shouldLazyLoadToolDetail(toolName)) {
    return part
  }

  // browser_actions keeps a slim `{ actions: [{ type }] }` preview; the full args
  // load on demand. Shells keep `command` for foreground runs too.
  const preview =
    toolName === 'browser_actions'
      ? extractBrowserActionsTypePreview(part.args ?? part.input)
      : toolName === READ_TOOL_ID ||
          toolName === EDIT_TOOL_ID ||
          toolName === WRITE_TOOL_ID
        ? extractFilePathPreview(part.args ?? part.input)
        : toolName === SKILL_TOOL_NAME
          ? extractSkillArgsPreview(part.args ?? part.input)
          : toolName === SUPER_EDIT_TOOL_NAME
            ? extractRunJsArgsPreview(part.args ?? part.input)
            : isBackgroundShellToolName(toolName)
              ? extractBackgroundShellArgsPreview(part.args ?? part.input, {
                  includeForeground: true,
                })
              : extractLabelStringFieldsPreview(
                  toolName,
                  part.args ?? part.input,
                )

  const sanitized = { ...part }
  if ('input' in sanitized) {
    delete sanitized.input
  }
  if ('args' in sanitized) {
    delete sanitized.args
  }
  if (preview) {
    sanitized.args = preview
  }
  return sanitized
}

function sanitizeToolResultContentPart(
  part: Record<string, unknown>,
  toolName?: string | null,
): Record<string, unknown> {
  const partType = typeof part.type === 'string' ? part.type : null
  if (partType !== PART_TOOL_RESULT_CANONICAL) {
    return part
  }

  const preview =
    toolName && isBackgroundShellToolName(toolName)
      ? extractBackgroundShellResultPreview(part.result)
      : null

  return {
    ...part,
    result: preview ?? undefined,
  }
}

function sanitizeMessageToolPayloads(
  message: Message,
  options: {
    redactToolResults: boolean
  },
): Message {
  const cloned = cloneValue(message)
  delete (cloned as { toolCallDetail?: unknown }).toolCallDetail

  if (isAssistantMessage(cloned)) {
    const assistantMessage = cloned as ModelReplyRow
    assistantMessage.message = {
      ...assistantMessage.message,
      content: assistantMessage.message.content.map(part => {
        const record = asRecord(part)
        return record
          ? sanitizeAssistantContentPartForLazyDetail(record)
          : part
      }),
    }
  }

  if (isUserMessage(cloned)) {
    const toolDetailRef = asRecord(
      (cloned as { toolCallDetailRef?: unknown }).toolCallDetailRef,
    )
    const toolName =
      typeof toolDetailRef?.toolName === 'string'
        ? toolDetailRef.toolName
        : null

    // A detail ref promises a sidecar record. Inline tools (TodoWrite, Agent,
    // AskUserQuestion, …) never get one — getToolCallDetailsFromMessage skips
    // them — so the ref the execution path stamps on every result row would
    // dangle in the transcript. Drop it here so the persisted row is honest.
    if (toolName && !shouldLazyLoadToolDetail(toolName)) {
      delete (cloned as { toolCallDetailRef?: unknown }).toolCallDetailRef
    }

    // A skill-invocation message (isMeta, string content, `skill:<uuid>` ref)
    // keeps only its tag header + marker; the SKILL.md body is the sidecar's
    // `result` and comes back via hydrateMessageToolPayloads. See
    // skillLibrary/skillInvocationTags.ts.
    if (getSkillBodyDetailId(cloned) !== null) {
      const userMessage = cloned as UserRow
      const content = userMessage.message.content
      if (typeof content === 'string' && !isSkillInvocationStub(content)) {
        userMessage.message = {
          ...userMessage.message,
          content: skillInvocationStub(content),
        }
      }
    }

    if (options.redactToolResults && toolName && shouldLazyLoadToolDetail(toolName)) {
      const userMessage = cloned as UserRow
      if (Array.isArray(userMessage.message.content)) {
        userMessage.message = {
          ...userMessage.message,
          content: userMessage.message.content.map(part => {
            const record = asRecord(part)
            return record ? sanitizeToolResultContentPart(record, toolName) : part
          }),
        }
      }

      if ('toolUseResult' in cloned) {
        ;(cloned as { toolUseResult?: unknown }).toolUseResult = ''
      }
    }
  }

  return cloned
}

export function sanitizeMessageForPersistence(message: Message): Message {
  return sanitizeMessageToolPayloads(message, {
    redactToolResults: true,
  })
}

export function sanitizeMessageForUi(message: Message): Message {
  return sanitizeMessageToolPayloads(message, {
    redactToolResults: true,
  })
}

function sanitizeStreamEvent(event: Record<string, unknown>): Record<string, unknown> {
  const eventType = typeof event.type === 'string' ? event.type : null
  if (eventType === STREAM_CONTENT_BLOCK_START) {
    const contentBlock = asRecord(event.content_block)
    if (contentBlock) {
      return {
        ...event,
        content_block: sanitizeAssistantContentPartForLazyDetail(contentBlock),
      }
    }
  }

  if (eventType === DELTA_TOOL_CALL) {
    return Object.fromEntries(
      Object.entries(event).filter(([key]) =>
        key === 'type' ||
        key === 'toolCallId' ||
        key === 'toolName' ||
        key === 'toolCallType',
      ),
    )
  }

  if (eventType === STREAM_MESSAGE_DELTA) {
    const usage = asRecord(event.usage)
    return usage
      ? { type: STREAM_MESSAGE_DELTA, usage }
      : { type: STREAM_MESSAGE_DELTA }
  }

  return event
}

export function sanitizeSdkMessageForUi(message: StreamRecord): StreamRecord {
  if (message.type === MSG_TYPE_STREAM_EVENT) {
    const streamEvent = asRecord((message as { event?: unknown }).event)
    if (!streamEvent) {
      return message
    }

    return {
      ...message,
      event: sanitizeStreamEvent(streamEvent),
    }
  }

  if (
    message.type === MSG_TYPE_ASSISTANT ||
    message.type === MSG_TYPE_USER ||
    message.type === MSG_TYPE_SYSTEM ||
    message.type === MSG_TYPE_ATTACHMENT ||
    message.type === MSG_TYPE_TOMBSTONE
  ) {
    return sanitizeMessageForUi(message)
  }

  return message
}

/** `details` is read only through `get` — the conversation store passes a view
 *  that records which ids a message looked up (its hydration memo). */
export function hydrateMessageToolPayloads(
  message: Message,
  details: Pick<ReadonlyMap<string, BrowserToolCallDetailRecord>, 'get'>,
): Message {
  const cloned = sanitizeMessageToolPayloads(message, {
    redactToolResults: false,
  })

  if (isAssistantMessage(cloned)) {
    const assistantMessage = cloned as ModelReplyRow

    assistantMessage.message = {
      ...assistantMessage.message,
      content: assistantMessage.message.content.map(part => {
        const record = asRecord(part)
        if (!record) {
          return part
        }

        const partType = typeof record.type === 'string' ? record.type : null
        if (partType !== PART_TOOL_CALL) {
          return part
        }

        const toolCallId = getToolCallId(record)
        const toolName = getToolName(record)
        if (!toolCallId || !toolName || !shouldLazyLoadToolDetail(toolName)) {
          return part
        }

        const detail = details.get(toolCallId)
        if (!detail || detail.args === undefined) {
          return part
        }

        return {
          ...record,
          args: cloneValue(detail.args),
        }
      }),
    }

    return assistantMessage
  }

  if (!isUserMessage(cloned)) {
    return cloned
  }

  const userMessage = cloned as UserRow
  if (!Array.isArray(userMessage.message.content)) {
    // Skill-invocation stub → full text from the sidecar (see sanitize above).
    // A missing sidecar leaves the stub in place: the model then sees the tags
    // + marker instead of the body, which is the honest degraded state.
    const skillDetailId = getSkillBodyDetailId(userMessage)
    const skillBody = skillDetailId ? details.get(skillDetailId)?.result : undefined
    if (
      skillDetailId &&
      typeof skillBody === 'string' &&
      skillBody.length > 0 &&
      isSkillInvocationStub(userMessage.message.content)
    ) {
      userMessage.message = { ...userMessage.message, content: skillBody }
    }
    return userMessage
  }

  let primaryResultContent: string | null = null
  userMessage.message = {
    ...userMessage.message,
    content: userMessage.message.content.map(part => {
      const record = asRecord(part)
      if (!record || record.type !== PART_TOOL_RESULT_CANONICAL) {
        return part
      }

      const toolUseId =
        typeof record.toolCallId === 'string' ? record.toolCallId : null
      if (!toolUseId) {
        return part
      }

      const detail = details.get(toolUseId)
      if (!detail) {
        return part
      }

      // Same shape the live call sent: an image stays an image part, never
      // base64 inside the text.
      if (primaryResultContent === null) {
        primaryResultContent = toolResultText(detail.result)
      }

      return {
        ...record,
        result: toolResultParts(detail.result),
      }
    }),
  }

  if (primaryResultContent !== null) {
    ;(userMessage as { toolUseResult?: unknown }).toolUseResult = primaryResultContent
  }

  return userMessage
}

export const hydrateAssistantToolArgs = hydrateMessageToolPayloads
