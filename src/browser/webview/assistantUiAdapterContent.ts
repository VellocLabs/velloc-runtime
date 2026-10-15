import type { ContextRow, Message } from '../../runtime/RuntimeTypes'
import { A2UI_DELETE_SURFACE } from '../../toolkit/builtin/a2ui/a2uiToolNames'
import { PLAN_OFF_TOOL_ID } from '../../toolkit/builtin/planExit'
import { toRenderableImageUrl } from '../../utils/images/inlineImage'
import { isImageSourceNoteText } from '../../utils/images/imageSourceNote'
import {
  extractBackgroundShellArgsPreview,
  isBackgroundShellToolName,
  shouldLazyLoadToolDetail,
} from '../../utils/toolCallDetails'
import type { ReadonlyJSONObject } from 'assistant-stream/utils'
import type { ThreadMessageLike } from '@assistant-ui/react'
import { splitUploadedAttachmentPrefix } from './pastedTextAttachment'
import { SKILL_TOOL_NAME } from '../../prompting/skillToolName'
import {
  LAZY_DETAIL_FINISHED_SENTINEL,
  SKILL_BODY_REF_KEY,
  TOOL_BATCH_METADATA_KEY,
  type ThreadPart,
  type ToolCallInfo,
  type ToolResultEntry,
  asRecord,
  extractBrowserActionsTypePreview,
  formatBrowserValue,
  isContentlessAssistantText,
  normalizeToolArgs,
  pendingBackgroundAgentResult,
  readToolBatchInfo,
} from './assistantUiAdapterParts'

/**
 * Content conversion: a runtime `Message`'s content blocks -> assistant-ui
 * `ThreadPart`s.
 *
 * Sits between `assistantUiAdapterParts.ts` (the primitives it builds on) and
 * `assistantUiAdapter.ts` (the transcript/live conversion that calls it).
 */

export function appendTextPart(
  parts: ThreadPart[],
  text: string,
  type: 'text' | 'reasoning' = 'text',
): void {
  if (!text.trim()) {
    return
  }

  const lastPart = parts.at(-1)
  if (lastPart && lastPart.type === type) {
    const mergedText = `${lastPart.text}${text}`
    parts[parts.length - 1] =
      type === 'reasoning'
        ? { type: 'reasoning', text: mergedText }
        : { type: 'text', text: mergedText }
    return
  }

  parts.push(type === 'reasoning' ? { type: 'reasoning', text } : { type: 'text', text })
}

export function convertAssistantBlock(
  block: unknown,
  toolResults: Map<string, ToolResultEntry>,
  toolCalls: ReadonlyMap<string, ToolCallInfo>,
  idCounter: { value: number },
): ThreadPart[] {
  if (typeof block === 'string') {
    return block.trim() ? [{ type: 'text', text: block }] : []
  }

  const record = asRecord(block)
  if (!record) {
    return [{ type: 'text', text: formatBrowserValue(block) }]
  }

  const blockType = typeof record.type === 'string' ? record.type : null
  switch (blockType) {
    case 'text':
      // Skip content-less text — empty/whitespace, or the bare quote-pair
      // ("" / '') some models emit as a "nothing to say" reply (e.g. the A2UI
      // action loop, where the model does the update tool-call and is told NOT
      // to narrate). The turn then yields zero parts and the message is dropped
      // (see contentToAssistantParts) instead of rendering as a stray `""`
      // bubble. Mirrors the string-block case above.
      return typeof record.text === 'string' &&
        !isContentlessAssistantText(record.text)
        ? [{ type: 'text', text: record.text }]
        : []

    case 'thinking':
      return typeof record.thinking === 'string'
        ? [{ type: 'reasoning', text: record.thinking }]
        : []

    case 'redacted_thinking':
      return [{ type: 'reasoning', text: '[redacted thinking]' }]

    case 'tool-call': {
      const toolName =
        typeof record.toolName === 'string'
          ? record.toolName
          : 'tool'
      // a2ui_delete_surface has NO inline UI — the tombstone shows in the
      // surface rendered elsewhere — so drop the part; a delete-only turn then
      // doesn't render an empty bubble. (a2ui_update_data_model DOES render: it
      // relocates the surface to its newest position, leaving a breadcrumb
      // behind.) The surface store / feeder read the RAW transcript, not these
      // adapter parts, so dropping delete is render-only.
      if (toolName === A2UI_DELETE_SURFACE) {
        return []
      }
      const args = normalizeToolArgs(record.args)
      const toolCallId =
        typeof record.toolCallId === 'string'
          ? record.toolCallId
          : `tool-${toolName}-${idCounter.value++}`
      const toolCallInfo = toolCalls.get(toolCallId)
      const lazyDetail =
        toolCallInfo?.lazyDetail ?? shouldLazyLoadToolDetail(toolName)
      const toolExecution = readToolBatchInfo(record)
      const toolResult = toolResults.get(toolCallId)
      const hasFinished =
        toolResult !== undefined || record.result !== undefined
      // ExitPlanMode HALTS for the user: the model never "runs" it on the main
      // thread (it suspends for plan approval, which resolves via a separate
      // turn — NOT a tool_result). So its tool_use never gets a result and would
      // otherwise read as perpetually "running" (animated spinner) AND pin the
      // whole assistant message to requires-action (hasPendingToolCalls) for the
      // rest of the session — even while later tools execute. Treat it as
      // SETTLED: the message-list entry is just a record that a plan was
      // presented; the approval interaction lives in the footer plan control.
      const settledByPolicy = toolName === PLAN_OFF_TOOL_ID
      // assistant-ui treats `!part.result` as "still running" and inherits
      // the parent message's status. For lazy-detail tools we never hand
      // back the real result here (it's loaded on demand), so a finished
      // call would otherwise look like it's still running and show the
      // spinner alongside the actually in-flight tool. Provide a truthy
      // sentinel when the tool has finished — the rendered UI uses
      // `detail?.result`, not this field, so the sentinel is never visible.
      const backgroundAgentPendingResult =
        hasFinished ? undefined : pendingBackgroundAgentResult(toolName, args)
      const backgroundShellResultPreview =
        toolName && isBackgroundShellToolName(toolName)
          ? toolResult?.preview
          : undefined
      // A model-invoked Skill call whose injected skill message was paired
      // (collectSkillBodyRefs): hand the card the body ref as its result so
      // "View skill" can open the instructions. The call is lazy-detail, so
      // without this its result would be the opaque finished sentinel.
      const skillBodyResult =
        toolName === SKILL_TOOL_NAME && toolResult?.skillBodyRef
          ? ({ [SKILL_BODY_REF_KEY]: toolResult.skillBodyRef } as ReadonlyJSONObject)
          : undefined
      const resolvedResult =
        backgroundAgentPendingResult ??
        backgroundShellResultPreview ??
        skillBodyResult ??
        (lazyDetail
          ? hasFinished || settledByPolicy
            ? LAZY_DETAIL_FINISHED_SENTINEL
            : undefined
          : (toolResult?.value ?? record.result))

      const inlineArgs = lazyDetail
        ? toolName === 'browser_actions'
          ? extractBrowserActionsTypePreview(args)
          : toolName === SKILL_TOOL_NAME
            // {skill, args} is the slim preview sanitize keeps inline - the
            // card title needs the skill name synchronously.
            ? args
          : isBackgroundShellToolName(toolName)
            ? extractBackgroundShellArgsPreview(args, {
                includeForeground: backgroundShellResultPreview !== undefined,
              }) ?? {}
            : {}
        : args

      return [
        {
          type: 'tool-call',
          toolCallId,
          toolName,
          args: inlineArgs,
          argsText: lazyDetail ? '' : JSON.stringify(args, null, 2),
          result: resolvedResult,
          isError: toolResult
            ? toolResult.isError
            : typeof record.isError === 'boolean'
              ? record.isError
              : undefined,
          artifact: lazyDetail || toolExecution
            ? {
                ...(lazyDetail ? { lazyToolDetail: true } : {}),
                ...(toolExecution
                  ? { [TOOL_BATCH_METADATA_KEY]: toolExecution }
                  : {}),
              }
            : undefined,
        },
      ]
    }

    default:
      if (typeof record.text === 'string') {
        return [{ type: 'text', text: record.text }]
      }

      return [{ type: 'text', text: formatBrowserValue(record) }]
  }
}

export function contentToAssistantParts(
  content: unknown,
  toolResults: Map<string, ToolResultEntry>,
  toolCalls: ReadonlyMap<string, ToolCallInfo>,
  idCounter: { value: number },
): ThreadPart[] {
  if (!Array.isArray(content)) {
    const text = formatBrowserValue(content)
    return text.trim() ? [{ type: 'text', text }] : []
  }

  if (content.length === 0) {
    return []
  }

  // An empty result means every block was intentionally dropped: return it as-is so the caller drops
  // the whole turn. Never fall back to stringifying the raw content.
  return content.flatMap(item =>
    convertAssistantBlock(item, toolResults, toolCalls, idCounter),
  )
}

function contentToUserText(content: unknown): string {
  return formatBrowserValue(content)
}

// User message content can be a plain string (the common case) or an array of
// content blocks when the composer sent images (see
// `buildPromptFromAppendMessage`). When an image block is present we build a
// structured parts array so the inline `<img>` renders; otherwise we keep the
// existing string rendering untouched.
export function convertUserContent(content: unknown): string | ThreadPart[] {
  if (!Array.isArray(content)) {
    return contentToUserText(content)
  }

  const hasImage = content.some(block => {
    const record = asRecord(block)
    return record?.type === 'image' && typeof record.image === 'string'
  })
  if (!hasImage) {
    return contentToUserText(content)
  }

  const parts: ThreadPart[] = []
  for (const block of content) {
    const record = asRecord(block)
    if (record?.type === 'image' && typeof record.image === 'string') {
      parts.push({
        type: 'image',
        image: toRenderableImageUrl({
          image: record.image,
          mimeType:
            typeof record.mimeType === 'string' ? record.mimeType : undefined,
        }),
      })
      continue
    }
    if (record?.type === 'text' && typeof record.text === 'string') {
      // The image source note block is for the model, not the bubble
      // (`buildPromptFromAppendMessage`).
      if (record.text.trim() && !isImageSourceNoteText(record.text)) {
        parts.push({ type: 'text', text: record.text })
      }
      continue
    }
    // Unknown block — fold its formatted text in so nothing is silently lost.
    const text = formatBrowserValue(block)
    if (text.trim()) {
      parts.push({ type: 'text', text })
    }
  }

  return parts.length > 0 ? parts : contentToUserText(content)
}

export type UserMessageAttachments = NonNullable<ThreadMessageLike['attachments']>

/**
 * `convertUserContent`, plus the composer uploads the prompt names. A sent
 * prompt starts with one `@"<cwd>/.velloc/uploads/<session>/<8hex>-<name>"`
 * per non-image attachment (`buildPromptFromAppendMessage`); that run is cut
 * from the bubble's text and returned as attachment cards, so a reloaded
 * message shows `spec.pdf` rather than the path. A `@"file"` the user typed
 * is not an upload and stays text.
 */
export function convertUserContentWithAttachments(content: unknown): {
  content: string | ThreadPart[]
  attachments: UserMessageAttachments
} {
  const converted = convertUserContent(content)
  if (typeof converted === 'string') {
    const split = splitUploadedAttachmentPrefix(converted)
    return {
      content: split.attachments.length > 0 ? split.text : converted,
      attachments: split.attachments.map(uploadMentionToAttachment),
    }
  }
  // Content-array prompts (images present) carry the prefix on the one text
  // block `buildPromptFromAppendMessage` appends after the images.
  const textIndex = converted.findIndex(part => part.type === 'text')
  const textPart = converted[textIndex]
  if (!textPart || textPart.type !== 'text') {
    return { content: converted, attachments: [] }
  }
  const split = splitUploadedAttachmentPrefix(textPart.text)
  if (split.attachments.length === 0) {
    return { content: converted, attachments: [] }
  }
  const parts = [...converted]
  if (split.text.trim()) {
    parts[textIndex] = { ...textPart, text: split.text }
  } else {
    parts.splice(textIndex, 1)
  }
  return {
    content: parts,
    attachments: split.attachments.map(uploadMentionToAttachment),
  }
}

function uploadMentionToAttachment(mention: {
  path: string
  name: string
}): UserMessageAttachments[number] {
  return {
    id: mention.path,
    type: mention.name.toLowerCase().endsWith('.pdf') ? 'document' : 'file',
    name: mention.name,
    status: { type: 'complete' },
    content: [],
  }
}

export function hasPendingToolCalls(parts: ThreadPart[]): boolean {
  return parts.some(
    part => part.type === 'tool-call' && part.result === undefined,
  )
}

export function attachmentToText(message: ContextRow): string {
  const attachment = message.attachment

  switch (attachment.type) {
    case 'browser_context': {
      const activeTab = asRecord(attachment.activeTab)
      const activeTitle =
        typeof activeTab?.title === 'string' ? activeTab.title : 'Unknown tab'
      const activeUrl =
        typeof activeTab?.url === 'string' ? activeTab.url : 'unknown URL'
      return [
        'Browser context updated.',
        `Active tab: ${activeTitle}`,
        `URL: ${activeUrl}`,
        `Open tabs: ${attachment.tabs.length}`,
      ].join('\n')
    }

    case 'file':
      return [
        `Attached file: ${attachment.filename}`,
        `Path: ${attachment.displayPath}`,
        `Lines: ${attachment.content.file.numLines}`,
      ].join('\n')

    case 'pdf_reference':
      return [
        `Referenced PDF: ${attachment.filename}`,
        `Path: ${attachment.displayPath}`,
        `Pages: ${attachment.pageCount}`,
      ].join('\n')

    case 'pdf_document':
      return [
        `Attached PDF: ${attachment.filename}`,
        `Path: ${attachment.displayPath}`,
      ].join('\n')

    case 'file_parts': {
      // An image, a notebook, a PDF sent as page images, or a Read error.
      const images = attachment.parts.filter(part => part.type === 'image').length
      return [
        `Attached file: ${attachment.filename}`,
        `Path: ${attachment.displayPath}`,
        ...(attachment.pages ? [`Pages: ${attachment.pages}`] : []),
        ...(images > 0 ? [`Images: ${images}`] : []),
      ].join('\n')
    }

    case 'directory':
      return [
        `Attached directory: ${attachment.path}`,
        `Path: ${attachment.displayPath}`,
        `Entries: ${attachment.content === '' ? 0 : attachment.content.split('\n').length}`,
      ].join('\n')

    case 'skill_listing':
      return `Available skills (${attachment.skillCount}).\n${attachment.content}`

    case 'skill_discovery':
      return `Discovered skills: ${attachment.skills
        .map(skill => skill.name)
        .join(', ')}`

    case 'plan_mode':
      return attachment.planExists
        ? `Plan mode is active. Plan file: ${attachment.planFilePath}`
        : `Plan mode is active. Expected plan file: ${attachment.planFilePath}`

    case 'plan_mode_reentry':
      return `Plan mode resumed. Plan file: ${attachment.planFilePath}`

    case 'plan_mode_exit':
      return attachment.planExists
        ? `Plan mode exited. Plan file: ${attachment.planFilePath}`
        : `Plan mode exited. Missing plan file: ${attachment.planFilePath}`

    case 'invoked_skills':
      // Post-compact restoration attachment — invisible to the user (filtered
      // out by the meta-message rules), so this summary only surfaces in
      // debug-style transcript views.
      return `Restored ${attachment.skills.length} invoked skill${
        attachment.skills.length === 1 ? '' : 's'
      } after compaction.`

    case 'max_turns_reached':
      return `Max turns reached (${attachment.turnCount}/${attachment.maxTurns}).`

    case 'date_change':
      return `Date changed to ${attachment.newDate}.`

    case 'git_state': {
      const count = attachment.changes.length + attachment.more
      return `Git snapshot at session start: ${attachment.branch ?? 'detached HEAD'}, ${count} changed path${count === 1 ? '' : 's'}.`
    }

    case 'folder_tree':
      return `Folder listing at session start (${attachment.lines.length} entries${attachment.truncated ? ', truncated' : ''}).`

    case 'todo_reminder':
      return `Todo reminder (${attachment.itemCount} item${attachment.itemCount === 1 ? '' : 's'}).`

    case 'queued_command':
      return typeof attachment.prompt === 'string'
        ? attachment.prompt
        : `Queued ${attachment.commandMode} (${attachment.prompt.length} blocks).`

    default: {
      // A new attachment type must say how it reads here.
      const _exhaustive: never = attachment
      return ''
    }
  }
}
