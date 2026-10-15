import { renderSkillListing } from '../skillLibrary/skillListing'
import type { BrowserHostBridge } from '../browser/bridge/BrowserHostBridge'
import type { ChromiumCommandMetadata } from '../runtime/CommandTypes'
import type { RuntimeConfig } from '../runtime/interfaces/RuntimeConfig'
import type {
  ContextRow,
  AttachmentPayload,
  BrowserContextAttachment,
  ContentBlockParam,
  DateChangeAttachment,
  DirectoryAttachment,
  FolderTreeAttachment,
  GitStateAttachment,
  FilePartsAttachment,
  Message,
  PDFDocumentAttachment,
  PdfPointer,
  PlanModeAttachment,
  PlanModeExitAttachment,
  PlanModeReentryAttachment,
  SkillDiscoveryAttachment,
  SkillListingAttachment,
  TextFileAttachment,
  UserRow,
  ReadFileLedger,
  FileStateEntry,
} from '../runtime/RuntimeTypes'
import { resolveToolByName } from '../toolkit/toolContract'
import { type PermissionDecider } from '../toolkit/permissionVerdict'
import { type ToolCallContext } from '../toolkit/toolCallContext'
import * as sessionTranscriptModule from '../sessions/transcriptWriter'
import {
  discoverRelevantSkills,
  getModelInvocableCommands,
} from '../skillLibrary/skillDiscovery'
import {
  deferralKeyFromContext,
  deriveActivatedSkillsFromMessages,
  getActiveSkills,
} from '../toolkit/run/deferredTools'
import { contextWindowOf } from '../engine/contextWindow'
import { BASE64_CHARS_PER_TOKEN } from '../engine/tokenCounts'
import { SPAWN_TOOL_ID } from '../toolkit/builtin/subagentLaunch'
import { SKILL_TOOL_NAME } from '../prompting/skillToolName'
import { PAUSE_TOOL_ID } from '../toolkit/builtin/sleepWait'
import { formatLocalISODate } from '../utils/dateFormat'
import { fsForContext, processFs } from '../utils/fs/runtimeFs'
import { withinMs } from '../utils/deadline'
import { FOLDER_TREE_TIMEOUT_MS, readFolderTree } from '../utils/folderTree'
import { GIT_STATE_TIMEOUT_MS, readGitState } from '../utils/gitState'
import { NEXUS_WORKSPACE_DIR_NAME } from '../utils/conversationStoragePaths'
import { makeContextRow, createGeneratedUserMessage } from './messageFactories'
import { findMentionedPaths, toMentionTarget } from './mentionParsing'
import { collectTodoReminderAttachments } from './todoReminder'

import { createPostCompactPlanReferenceMessage } from './planReminder'
export { createPostCompactPlanReferenceMessage }
export {
  TODO_NUDGE_CADENCE,
  collectTodoReminderAttachments,
  turnsSinceTodoActivity,
} from './todoReminder'
import { READ_TOOL_ID } from '../prompting/fileToolNames'
import { planDocPath, planFileExists } from '../utils/planFiles'
import { resolveDocumentInputMode } from '../config/nexusModelConfig/documentInput'
import type { NexusDocumentInputMode } from '../config/nexusModelConfig/types'
import { readUserLayer } from '../settings/settingsStore'
import { vetFileRead } from '../permissions/filesystemPermission'
import {
  assertUntrustedReadAllowed,
  untrustedReadDeniedMessage,
} from '../permissions/untrustedReadBoundary'
import {
  extnameRuntimePath,
  relativeRuntimePath,
  resolveRuntimePath,
} from '../utils/runtimePaths'
import {
  MSG_TYPE_ATTACHMENT,
  PART_DOCUMENT,
  PART_IMAGE,
  PART_TEXT,
  PART_TOOL_CALL,
  isAttachmentMessage,
} from '../runtime/VercelModelConstants'

// Limits for files and folders pulled in by an @ mention.
const AT_MENTION_MAX_SIZE_BYTES = 256 * 1024
const AT_MENTION_TRUNCATED_LINES = 2_000
const AT_MENTION_MAX_DIR_ENTRIES = 1_000
const AT_MENTION_IMAGE_EXTENSIONS: ReadonlySet<string> = new Set([
  '.png',
  '.jpg',
  '.jpeg',
  '.gif',
  '.webp',
])
const READ_TOKEN_LIMIT_PATTERN =
  /max_file_read_token_exceeded|exceeds maximum allowed tokens/
const READ_UNCHANGED_STUB_PREFIX = 'This file has not changed since you last read it;'
const PDF_INLINE_PAGE_LIMIT = 10
const PDF_PAGE_SIZE_ESTIMATE_BYTES = 100 * 1024
const PDF_RASTERIZE_MAX_BASE64_CHARS = 8 * 1024 * 1024
// Budgets for re-reading recent files after a compaction, scaled by context window.
const POST_COMPACT_RESTORE_FRONTIER_WINDOW_THRESHOLD = 200_000
const POST_COMPACT_RESTORE_MAX_FILES_FRONTIER = 12
const POST_COMPACT_RESTORE_MAX_FILES_SMALL = 5
const POST_COMPACT_RESTORE_TOKEN_BUDGET_FRONTIER = 16_000
const POST_COMPACT_RESTORE_TOKEN_BUDGET_SMALL = 8_000
const LARGE_CONTEXT_WINDOW_THRESHOLD = 500_000
const POST_COMPACT_RESTORE_LARGE_MAX_TOKENS_PER_FILE = 5_000
const POST_COMPACT_RESTORE_SMALL_MAX_TOKENS_PER_FILE = 2_500

function getPostCompactRestoreMaxFiles(contextWindow: number): number {
  return contextWindow >= POST_COMPACT_RESTORE_FRONTIER_WINDOW_THRESHOLD
    ? POST_COMPACT_RESTORE_MAX_FILES_FRONTIER
    : POST_COMPACT_RESTORE_MAX_FILES_SMALL
}

function getPostCompactRestoreTokenBudget(contextWindow: number): number {
  return contextWindow >= POST_COMPACT_RESTORE_FRONTIER_WINDOW_THRESHOLD
    ? POST_COMPACT_RESTORE_TOKEN_BUDGET_FRONTIER
    : POST_COMPACT_RESTORE_TOKEN_BUDGET_SMALL
}

type FileMention = {
  filename: string
  lineStart?: number
  lineEnd?: number
}

type QueuedAttachmentParams = {
  messages: Message[]
  toolUseContext: ToolCallContext
  runtimeConfig: RuntimeConfig
  assistantMessages?: Message[]
  querySource?: string
  sessionId?: string
  drainTaskNotifications?: (
    sessionId: string,
    opts: { includeLater: boolean },
  ) => { prompt: string; enqueuedAt: number } | null
  drainTeamMessages?: (
    sessionId: string,
  ) => Array<{ prompt: string; enqueuedAt: number }>
  drainInjectMessages?: () => Array<{
    uuid: string
    prompt: string | Array<ContentBlockParam>
    enqueuedAt: number
  }>
}

const MAIN_LOOP_QUERY_SOURCE = 'sdk'

/** Queued items for the main loop, without draining injected messages. */
export function collectTaskNotificationAttachments(
  params: QueuedAttachmentParams,
): AttachmentPayload[] {
  return collectMidTurnQueuedCommands({ ...params, drainInjectMessages: undefined })
}

function roundRanSleep(assistantMessages: Message[] | undefined): boolean {
  return (assistantMessages ?? []).some(message => {
    const content = (message.message as { content?: unknown } | undefined)?.content
    return (
      Array.isArray(content) &&
      content.some(
        block =>
          typeof block === 'object' &&
          block !== null &&
          (block as { type?: unknown }).type === PART_TOOL_CALL &&
          (block as { toolName?: unknown }).toolName === PAUSE_TOOL_ID,
      )
    )
  })
}

/** Drains commands queued during a main-loop turn into attachments, oldest first. */
export function collectMidTurnQueuedCommands(
  params: QueuedAttachmentParams,
): AttachmentPayload[] {
  if (params.querySource !== MAIN_LOOP_QUERY_SOURCE) return []
  const items: Array<{ enqueuedAt: number; attachment: AttachmentPayload }> = []
  const { drainTaskNotifications, sessionId } = params
  if (drainTaskNotifications && sessionId) {
    const batch = drainTaskNotifications(sessionId, {
      includeLater: roundRanSleep(params.assistantMessages),
    })
    if (batch) {
      items.push({
        enqueuedAt: batch.enqueuedAt,
        attachment: {
          type: 'queued_command',
          prompt: batch.prompt,
          commandMode: 'task-notification',
        },
      })
    }
  }
  const aborted = params.toolUseContext?.cancelSource?.signal.aborted === true
  if (params.drainTeamMessages && sessionId && !aborted) {
    for (const entry of params.drainTeamMessages(sessionId)) {
      items.push({
        enqueuedAt: entry.enqueuedAt,
        attachment: {
          type: 'queued_command',
          prompt: entry.prompt,
          commandMode: 'team-message',
        },
      })
    }
  }
  for (const entry of aborted ? [] : (params.drainInjectMessages?.() ?? [])) {
    items.push({
      enqueuedAt: entry.enqueuedAt,
      attachment: {
        type: 'queued_command',
        prompt: entry.prompt,
        commandMode: 'prompt',
        source_uuid: entry.uuid,
      },
    })
  }
  return items
    .map((item, index) => ({ ...item, index }))
    .sort((x, y) => x.enqueuedAt - y.enqueuedAt || x.index - y.index)
    .map(item => item.attachment)
}

function countLines(content: string): number {
  if (content.length === 0) {
    return 0
  }
  return content.split(/\r?\n/).length
}

const RESTORE_MEDIA_PAYLOAD_PATTERN =
  /"(?:image|data)"\s*:\s*"[A-Za-z0-9+/=]{512,}"|data:image\/[a-z+]+;base64,[A-Za-z0-9+/=]{512,}/

function carriesBase64MediaPayload(content: string): boolean {
  return RESTORE_MEDIA_PAYLOAD_PATTERN.test(content)
}

function isCachedMediaReadResult(content: string): boolean {
  if (!content.trimStart().startsWith('{')) return false
  if (!carriesBase64MediaPayload(content)) return false
  try {
    const parsed: unknown = JSON.parse(content)
    return typeof parsed === 'object' && parsed !== null
  } catch {
    return false
  }
}

function estimateRestoreTokens(text: string): number {
  if (carriesBase64MediaPayload(text)) {
    return Math.ceil(text.length / BASE64_CHARS_PER_TOKEN)
  }
  return Math.ceil(text.length / 4)
}

function countLeadingLines(text: string): number {
  let count = 0
  for (let i = 0; i < text.length; i++) {
    if (text[i] === '\n') count++
  }
  return count
}

export function getPostCompactRestoreMaxTokensPerFile(
  contextWindow: number,
): number {
  return contextWindow > LARGE_CONTEXT_WINDOW_THRESHOLD
    ? POST_COMPACT_RESTORE_LARGE_MAX_TOKENS_PER_FILE
    : POST_COMPACT_RESTORE_SMALL_MAX_TOKENS_PER_FILE
}

function getPostCompactRestoreContextWindow(params: {
  contextWindow?: number
  toolUseContext?: ToolCallContext
}): number {
  if (typeof params.contextWindow === 'number') return params.contextWindow

  const model = params.toolUseContext?.options.mainLoopModel
  const modelId = model && model !== 'inherit' ? model : undefined
  return contextWindowOf(
    modelId,
    params.toolUseContext?.options.mainLoopProviderId,
  )
}

/**
 * Re-surfaces the content of recently read files after a compaction, within
 * per-file and total token budgets. Null when nothing could be restored.
 */
export async function createPostCompactReadRestoreMessage(params: {
  readPaths?: Set<string>
  readFileState?: ReadFileLedger
  toolUseContext?: ToolCallContext
  contextWindow?: number
}): Promise<UserRow | null> {
  const restored: string[] = []
  const restoredState: Array<[string, FileStateEntry]> = []
  let usedTokens = 0
  const contextWindow = getPostCompactRestoreContextWindow(params)
  const maxTokensPerFile = getPostCompactRestoreMaxTokensPerFile(contextWindow)
  const maxFiles = getPostCompactRestoreMaxFiles(contextWindow)
  const tokenBudget = getPostCompactRestoreTokenBudget(contextWindow)
  params.toolUseContext?.postCompactReadFileState?.clear()

  const appendRestored = (
    filePath: string,
    content: string,
    metadata?: { offset?: number; limit?: number; mtimeMs?: number; partialRead?: boolean },
  ): boolean => {
    const remaining = tokenBudget - usedTokens
    if (remaining <= 0) return false
    const attrs = [
      `path="${filePath}"`,
      metadata?.offset !== undefined ? `offset="${metadata.offset}"` : null,
      metadata?.limit !== undefined ? `limit="${metadata.limit}"` : null,
    ].filter(Boolean)
    const perFileMaxChars = Math.min(maxTokensPerFile, remaining) * 4
    const restoreTruncated = content.length > perFileMaxChars
    const displayContent = restoreTruncated
      ? `${content.slice(0, perFileMaxChars)}\n[post-compact restore truncated]`
      : content
    const wrapped = `<file ${attrs.join(' ')}>\n${displayContent}\n</file>`
    const tokens = estimateRestoreTokens(wrapped)
    if (usedTokens + tokens > tokenBudget) return false
    usedTokens += tokens
    restored.push(wrapped)
    if (restoreTruncated && metadata?.partialRead) {
      return true
    }
    const restoredCoverageLines = restoreTruncated
      ? countLeadingLines(content.slice(0, perFileMaxChars))
      : undefined
    restoredState.push([
      filePath,
      {
        content,
        timestamp: Date.now(),
        mtimeMs: metadata?.mtimeMs,
        offset: metadata?.offset,
        limit: metadata?.limit,
        partialRead: metadata?.partialRead,
        postCompactRestored: true,
        restoredCoverageLines,
      },
    ])
    return true
  }

  const restoredFromState = new Set<string>()
  const stateEntries = [...(params.readFileState?.entries() ?? [])]
    .sort((a, b) => b[1].timestamp - a[1].timestamp)
    .slice(0, maxFiles)

  for (const [filePath, state] of stateEntries) {
    if (!state.content) continue
    if (isCachedMediaReadResult(state.content)) continue
    if (
      appendRestored(filePath, state.content, {
        offset: state.offset,
        limit: state.limit,
        mtimeMs: state.mtimeMs,
        partialRead: state.partialRead,
      })
    ) {
      restoredFromState.add(filePath)
    } else {
      break
    }
  }

  const remainingSlots = maxFiles - restored.length
  const paths =
    remainingSlots > 0
      ? [...(params.readPaths ?? [])]
          .filter(path => !restoredFromState.has(path))
          .slice(-remainingSlots)
      : []
  if (restored.length === 0 && paths.length === 0) return null

  const fs = params.toolUseContext
    ? fsForContext(params.toolUseContext)
    : processFs()
  for (const filePath of paths) {
    try {
      const stat = await fs.stat(filePath)
      if (!stat.isFile()) continue
      const raw = await fs.readFile(filePath, { encoding: 'utf-8' })
      if (!appendRestored(filePath, raw, { mtimeMs: stat.mtimeMs })) break
    } catch {
    }
  }
  if (restored.length === 0) return null
  if (params.toolUseContext?.postCompactReadFileState) {
    for (const [filePath, state] of restoredState) {
      params.toolUseContext.postCompactReadFileState.set(filePath, state)
    }
  }

  return createGeneratedUserMessage(
    `<system-reminder>Recent Read file content restored after compaction. Earlier full Read tool results may have been compacted away; use these restored snippets instead of relying on file_unchanged stubs.\n\n${restored.join('\n\n')}</system-reminder>`,
    { isMeta: true },
  )
}

function parsePdfPageRange(
  pageCount: number,
  pages?: string,
): { start: number; end: number } {
  if (!pages) {
    return {
      start: 1,
      end: pageCount,
    }
  }

  const match = pages.trim().match(/^(\d+)(?:-(\d+))?$/)
  if (!match) {
    throw new Error(`Invalid PDF page range "${pages}".`)
  }

  const start = Number.parseInt(match[1] ?? '', 10)
  const end = Number.parseInt(match[2] ?? match[1] ?? '', 10)
  if (!Number.isFinite(start) || !Number.isFinite(end) || start <= 0 || end < start) {
    throw new Error(`Invalid PDF page range "${pages}".`)
  }
  return {
    start,
    end: Math.min(end, pageCount),
  }
}

export function estimatePdfPageCount(fileSize: number): number {
  return Math.max(1, Math.ceil(fileSize / PDF_PAGE_SIZE_ESTIMATE_BYTES))
}

const AT_MENTION_CAN_USE_TOOL: PermissionDecider = (async () => ({
  behavior: 'allow' as const,
  updatedInput: {},
})) as PermissionDecider

const PDF_TOO_MANY_PAGES_PATTERN = /This PDF has (\d+) pages/
const PDF_PAGED_READ_COUNT_PATTERN = /\(pages \d+-\d+ of (\d+)\)/

async function createPdfAttachment(
  context: ToolCallContext,
  filePath: string,
  displayPath: string,
): Promise<PdfPointer | PDFDocumentAttachment | FilePartsAttachment | null> {
  const { size } = await fsForContext(context).stat(filePath)
  const reference = (
    pageCount: number,
    unreadable?: PdfPointer['unreadable'],
  ): PdfPointer => ({
    type: 'pdf_reference',
    filename: filePath,
    pageCount,
    fileSize: size,
    displayPath,
    ...(unreadable ? { unreadable } : {}),
  })
  const referenceForModel = async (pageCount: number): Promise<PdfPointer> =>
    reference(
      pageCount,
      (await mentionDocumentInputMode(context)) === 'none' ? 'text-only-model' : undefined,
    )

  const readTool = resolveToolByName(context.options.tools, READ_TOOL_ID)
  if (!readTool) {
    const estimate = estimatePdfPageCount(size)
    return estimate > PDF_INLINE_PAGE_LIMIT ? referenceForModel(estimate) : null
  }
  const readPdf = async (input: Record<string, unknown>): Promise<unknown> =>
    (
      await readTool.call(input, context, AT_MENTION_CAN_USE_TOOL, createGeneratedUserMessage(''))
    ).data
  const readError = (text: string): FilePartsAttachment => ({
    type: 'file_parts',
    filename: filePath,
    displayPath,
    parts: [{ type: 'text', text }],
  })

  const mode = await mentionDocumentInputMode(context)
  if (mode === 'native' && context.platformCapabilities?.supportsLlmDocumentParts?.() === true) {
    let data: unknown
    try {
      data = await readPdf({ file_path: filePath })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      const match = PDF_TOO_MANY_PAGES_PATTERN.exec(message)
      if (match) {
        return referenceForModel(Number.parseInt(match[1]!, 10))
      }
      return readError(`Error: ${message}`)
    }
    return (
      pdfDocumentFromReadResult(data, filePath, displayPath, size)
      ?? readError(pdfReadResultText(data))
    )
  }

  let firstPage: unknown
  try {
    firstPage = await readPdf({ file_path: filePath, pages: '1' })
  } catch (error) {
    return readError(`Error: ${error instanceof Error ? error.message : String(error)}`)
  }
  const parts = (firstPage as { content_parts?: unknown } | null)?.content_parts
  if (!Array.isArray(parts)) {
    return readError(pdfReadResultText(firstPage))
  }
  let counted: RegExpExecArray | null = null
  for (const part of parts) {
    const record = part as { type?: unknown; text?: unknown } | null
    if (record?.type === PART_TEXT && typeof record.text === 'string') {
      counted = PDF_PAGED_READ_COUNT_PATTERN.exec(record.text)
      if (counted) break
    }
  }
  const pageCount = counted ? Number.parseInt(counted[1]!, 10) : estimatePdfPageCount(size)
  if (pageCount > PDF_INLINE_PAGE_LIMIT) {
    return referenceForModel(pageCount)
  }
  if (mode === 'rasterize') {
    return (
      (pageCount === 1
        ? pdfPageImagesAttachment(firstPage, filePath, displayPath, '1-1')
        : await readPdfPageImages(context, readTool, filePath, displayPath, pageCount))
      ?? reference(pageCount)
    )
  }
  if (mode === 'none') {
    return reference(pageCount, 'text-only-model')
  }
  return reference(pageCount)
}

function pdfReadResultText(data: unknown): string {
  if (typeof data === 'string' && data.trim() !== '') return data
  const message = (data as { message?: unknown } | null)?.message
  if (typeof message === 'string' && message.trim() !== '') return message
  return 'Error: the Read tool returned no content for this PDF.'
}

async function mentionDocumentInputMode(
  context: ToolCallContext,
): Promise<NexusDocumentInputMode> {
  const model = context.options.mainLoopModel
  const modelId = model && model !== 'inherit' ? model : undefined
  let providers
  if (context.options.homeDir) {
    try {
      providers = (await readUserLayer(context.options.homeDir, fsForContext(context))).settings
        .providers
    } catch {
      providers = undefined
    }
  }
  const providerId = context.options.mainLoopProviderId ?? providers?.activeProviderId
  if (!providerId) {
    return 'native'
  }
  return resolveDocumentInputMode(providers, providerId, modelId)
}

async function readPdfPageImages(
  context: ToolCallContext,
  readTool: NonNullable<ReturnType<typeof resolveToolByName>>,
  filePath: string,
  displayPath: string,
  pageCount: number,
): Promise<FilePartsAttachment | null> {
  const pages = `1-${pageCount}`
  let data: unknown
  try {
    data = (
      await readTool.call(
        { file_path: filePath, pages },
        context,
        AT_MENTION_CAN_USE_TOOL,
        createGeneratedUserMessage(''),
      )
    ).data
  } catch {
    return null
  }
  return pdfPageImagesAttachment(data, filePath, displayPath, pages)
}

function pdfPageImagesAttachment(
  data: unknown,
  filePath: string,
  displayPath: string,
  pages: string,
): FilePartsAttachment | null {
  const parts = filePartsFromReadResult(data)
  if (!parts?.some(part => part.type === 'image')) {
    return null
  }
  const imageChars = parts.reduce(
    (total, part) => total + (part.type === 'image' ? part.image.length : 0),
    0,
  )
  if (imageChars > PDF_RASTERIZE_MAX_BASE64_CHARS) {
    return null
  }
  return { type: 'file_parts', filename: filePath, displayPath, pages, parts }
}

export function pdfDocumentFromReadResult(
  data: unknown,
  filePath: string,
  displayPath: string,
  fileSize: number,
): PDFDocumentAttachment | null {
  const parts = (data as { content_parts?: unknown } | null)?.content_parts
  if (!Array.isArray(parts)) {
    return null
  }
  let summary = ''
  for (const part of parts) {
    const record = part as Record<string, unknown> | null
    if (record?.type === PART_TEXT && typeof record.text === 'string') {
      summary = summary ? `${summary}\n${record.text}` : record.text
      continue
    }
    if (record?.type !== PART_DOCUMENT) {
      continue
    }
    const docData =
      typeof record.data === 'string'
        ? record.data
        : typeof record.document === 'string'
          ? record.document
          : undefined
    if (!docData) {
      continue
    }
    return {
      type: 'pdf_document',
      filename: filePath,
      displayPath,
      fileSize,
      summary: summary || `PDF file read: ${filePath}`,
      data: docData,
      mimeType:
        typeof record.mimeType === 'string' ? record.mimeType : 'application/pdf',
    }
  }
  return null
}

async function isMentionReadDenied(
  context: ToolCallContext,
  resolvedTarget: string,
): Promise<boolean> {
  const permission = context.readAppState().permissionRules
  if (!permission) {
    return false
  }
  const decision = await vetFileRead(
    READ_TOOL_ID,
    { file_path: resolvedTarget },
    {
      cwd: context.options.cwd,
      projectRoot: context.options.projectRoot,
      homeDir: context.options.homeDir,
      extraWorkspaceRoots: permission.extraWorkspaceRoots,
      mode: permission.mode,
      ruleLists: permission.ruleLists,
      allowRuleBook: permission.allowRuleBook as Record<string, string[]>,
      denyRuleBook: permission.denyRuleBook as Record<string, string[]>,
      askRuleBook: permission.askRuleBook as Record<string, string[]>,
      fs: fsForContext(context),
    },
  )
  return decision.behavior === 'deny'
}

async function createDirectoryAttachment(
  context: ToolCallContext,
  resolvedTarget: string,
  displayPath: string,
): Promise<DirectoryAttachment | null> {
  const verdict = await assertUntrustedReadAllowed(resolvedTarget, context, fsForContext(context))
  if (!verdict.ok) {
    return {
      type: 'directory',
      path: resolvedTarget,
      displayPath,
      content: untrustedReadDeniedMessage(verdict, context.options.untrustedReadRoot),
    }
  }
  const entries = await fsForContext(context).readdir(resolvedTarget)
  const names = entries.slice(0, AT_MENTION_MAX_DIR_ENTRIES).map(e => e.name)
  if (entries.length > AT_MENTION_MAX_DIR_ENTRIES) {
    names.push(`… and ${entries.length - AT_MENTION_MAX_DIR_ENTRIES} more entries`)
  }
  return {
    type: 'directory',
    path: resolvedTarget,
    displayPath,
    content: names.join('\n'),
  }
}

function filePartsFromReadResult(data: unknown): FilePartsAttachment['parts'] | null {
  const raw = (data as { content_parts?: unknown } | null)?.content_parts
  if (!Array.isArray(raw)) {
    return null
  }
  const parts: FilePartsAttachment['parts'] = []
  for (const part of raw) {
    const record = part as Record<string, unknown> | null
    if (record?.type === PART_TEXT && typeof record.text === 'string') {
      parts.push({ type: 'text', text: record.text })
      continue
    }
    if (record?.type !== PART_IMAGE) {
      continue
    }
    const image =
      typeof record.image === 'string'
        ? record.image
        : typeof record.data === 'string'
          ? record.data
          : undefined
    if (!image) {
      continue
    }
    const mimeType =
      typeof record.mimeType === 'string'
        ? record.mimeType
        : typeof record.mime_type === 'string'
          ? record.mime_type
          : 'image/png'
    parts.push({ type: 'image', image, mimeType })
  }
  return parts.length > 0 ? parts : null
}

async function createReadFileAttachment(
  context: ToolCallContext,
  mention: FileMention,
  resolvedTarget: string,
  displayPath: string,
  size: number,
  mtimeMs: number | undefined,
): Promise<TextFileAttachment | FilePartsAttachment | null> {
  const extension = extnameRuntimePath(resolvedTarget).toLowerCase()
  const oversized =
    size > AT_MENTION_MAX_SIZE_BYTES && !AT_MENTION_IMAGE_EXTENSIONS.has(extension)

  const previousRead = context.fileReadLedger.get(resolvedTarget)
  if (
    previousRead &&
    mention.lineStart === undefined &&
    mention.lineEnd === undefined &&
    mtimeMs !== undefined &&
    previousRead.timestamp === mtimeMs
  ) {
    return null
  }

  const readTool = resolveToolByName(context.options.tools, READ_TOOL_ID)
  if (!readTool) {
    return null
  }
  const rangeLimit =
    mention.lineStart !== undefined && mention.lineEnd !== undefined
      ? Math.max(mention.lineEnd - mention.lineStart + 1, 1)
      : undefined
  const headOnly = oversized && rangeLimit === undefined
  const offset = mention.lineStart ?? (headOnly ? 1 : undefined)
  const limit = headOnly ? AT_MENTION_TRUNCATED_LINES : rangeLimit
  const read = async (input: Record<string, unknown>) =>
    (
      await readTool.call(
        input,
        context,
        AT_MENTION_CAN_USE_TOOL,
        createGeneratedUserMessage(''),
      )
    ).data

  let data: unknown
  let truncated = headOnly
  try {
    data = await read({
      file_path: resolvedTarget,
      ...(offset !== undefined ? { offset } : {}),
      ...(limit !== undefined ? { limit } : {}),
    })
  } catch (error) {
    if (
      headOnly ||
      !READ_TOKEN_LIMIT_PATTERN.test(error instanceof Error ? error.message : String(error))
    ) {
      throw error
    }
    data = await read({
      file_path: resolvedTarget,
      offset: offset ?? 1,
      limit: AT_MENTION_TRUNCATED_LINES,
    })
    truncated = true
  }

  const parts = filePartsFromReadResult(data)
  if (parts) {
    return { type: 'file_parts', filename: resolvedTarget, displayPath, parts }
  }
  if (typeof data !== 'string') {
    return null
  }
  if (data.startsWith(READ_UNCHANGED_STUB_PREFIX)) {
    return null
  }
  const numLines = countLines(data)
  return {
    type: 'file',
    filename: resolvedTarget,
    displayPath,
    content: {
      type: 'text',
      file: {
        filePath: resolvedTarget,
        content: data,
        numLines,
        startLine: offset ?? 1,
        totalLines: numLines,
      },
    },
    ...(truncated ? { truncated } : {}),
  }
}

async function createFileAttachment(
  context: ToolCallContext,
  mention: FileMention,
): Promise<AttachmentPayload | null> {
  const absolutePath = resolveRuntimePath(context.options.cwd, mention.filename)
  const displayPath = relativeRuntimePath(context.options.cwd, absolutePath)
  const extension = extnameRuntimePath(absolutePath).toLowerCase()

  try {
    if (await isMentionReadDenied(context, absolutePath)) {
      return null
    }
    const stat = await fsForContext(context).stat(absolutePath)
    if (stat.isDirectory()) {
      return await createDirectoryAttachment(context, absolutePath, displayPath)
    }
    if (!stat.isFile()) {
      return null
    }
    if (extension === '.pdf') {
      return await createPdfAttachment(context, absolutePath, displayPath)
    }
    return await createReadFileAttachment(
      context,
      mention,
      absolutePath,
      displayPath,
      stat.size,
      stat.mtimeMs,
    )
  } catch {
    return null
  }
}

function getAttachmentState(context: ToolCallContext) {
  return context.readAppState().attachmentState ?? {}
}

function updateAttachmentState(
  context: ToolCallContext,
  updater: (
    previous: NonNullable<ReturnType<typeof getAttachmentState>>,
  ) => NonNullable<ReturnType<typeof getAttachmentState>>,
): void {
  context.writeAppState(previous => ({
    ...previous,
    attachmentState: updater(previous.attachmentState ?? {}),
  }))
}

async function collectPlanModeAttachments(
  context: ToolCallContext,
): Promise<Array<PlanModeAttachment | PlanModeReentryAttachment | PlanModeExitAttachment>> {
  const currentMode = context.readAppState().permissionRules.mode
  const attachmentState = getAttachmentState(context)
  const lastMode = attachmentState.lastPermissionMode
  const planFilePath = planDocPath(context)
  const planExists = await planFileExists(context)
  const sessionTools = Array.isArray(context.options?.tools)
    ? context.options.tools
    : []
  const hasSubagents = sessionTools.some(tool => tool?.name === SPAWN_TOOL_ID)
  const attachments: Array<
    PlanModeAttachment | PlanModeReentryAttachment | PlanModeExitAttachment
  > = []

  if (currentMode === 'plan') {
    if (lastMode !== 'plan' && attachmentState.hasExitedPlanModeInSession && planExists) {
      attachments.push({
        type: 'plan_mode_reentry',
        planFilePath,
      })
    }

    attachments.push({
      type: 'plan_mode',
      reminderType: lastMode === 'plan' ? 'sparse' : 'full',
      planFilePath,
      planExists,
      hasSubagents,
    })

    updateAttachmentState(context, previous => ({
      ...previous,
      lastPermissionMode: 'plan',
      hasExitedPlanModeInSession: false,
    }))
    return attachments
  }

  if (lastMode === 'plan') {
    attachments.push({
      type: 'plan_mode_exit',
      planFilePath,
      planExists,
    })
  }

  updateAttachmentState(context, previous => ({
    ...previous,
    lastPermissionMode: currentMode,
    hasExitedPlanModeInSession:
      lastMode === 'plan' ? true : (previous.hasExitedPlanModeInSession ?? false),
  }))

  return attachments
}

function getSessionActiveSkills(context: ToolCallContext): Set<string> {
  const active = getActiveSkills(context.readAppState())
  const messages = Array.isArray(context.messages) ? context.messages : []
  const tools = context.options?.tools
  let resolveToolSkill: ((toolName: string) => string | undefined) | undefined
  if (Array.isArray(tools)) {
    const skillByTool = new Map<string, string>()
    for (const t of tools) {
      if (t && typeof t.name === 'string' && typeof t.skill === 'string') {
        skillByTool.set(t.name, t.skill)
      }
    }
    resolveToolSkill = name => skillByTool.get(name)
  }
  for (const name of deriveActivatedSkillsFromMessages(
    messages,
    resolveToolSkill,
    deferralKeyFromContext(context),
  )) {
    active.add(name)
  }
  return active
}

function getAdvertisedSkillsFromTranscript(
  context: ToolCallContext,
): Set<string> {
  const advertised = new Set<string>()
  const messages = Array.isArray(context.messages) ? context.messages : []
  for (const message of messages) {
    if (!isAttachmentMessage(message) || !('attachment' in message)) {
      continue
    }
    const attachment = (message as { attachment?: { type?: string } })
      .attachment
    if (!attachment || attachment.type !== 'skill_listing') {
      continue
    }
    const listing = attachment as SkillListingAttachment
    if (Array.isArray(listing.skillNames)) {
      for (const name of listing.skillNames) {
        if (typeof name === 'string' && name) advertised.add(name)
      }
      continue
    }
    if (typeof listing.content === 'string') {
      for (const match of listing.content.matchAll(/^- ([^\s:]+):/gm)) {
        if (match[1]) advertised.add(match[1])
      }
    }
  }
  return advertised
}

function sessionHasSkillTool(context: ToolCallContext): boolean {
  const tools = Array.isArray(context.options?.tools)
    ? context.options.tools
    : []
  return tools.some(tool => tool?.name === SKILL_TOOL_NAME)
}

export function collectSkillListingAttachments(
  context: ToolCallContext,
): SkillListingAttachment[] {
  if (!sessionHasSkillTool(context)) {
    return []
  }
  const commands = getModelInvocableCommands(context.options.commands)
  if (commands.length === 0) {
    return []
  }

  const attachmentState = getAttachmentState(context)
  const sentSkillNames = new Set(attachmentState.sentSkillNames ?? [])
  const activeSkills = getSessionActiveSkills(context)
  const advertisedSkills = getAdvertisedSkillsFromTranscript(context)
  const unsent = commands.filter(
    command =>
      !sentSkillNames.has(command.name) &&
      !activeSkills.has(command.name) &&
      !advertisedSkills.has(command.name),
  )
  if (unsent.length === 0) {
    return []
  }

  for (const command of unsent) {
    sentSkillNames.add(command.name)
  }

  updateAttachmentState(context, previous => ({
    ...previous,
    sentSkillNames: [...sentSkillNames].sort(),
  }))

  const model = context.options.mainLoopModel
  const contextWindowTokens =
    model && model !== 'inherit'
      ? contextWindowOf(model, context.options.mainLoopProviderId)
      : undefined

  return [
    {
      type: 'skill_listing',
      content: renderSkillListing(unsent, contextWindowTokens),
      skillCount: unsent.length,
      isInitial:
        (attachmentState.sentSkillNames?.length ?? 0) === 0 &&
        advertisedSkills.size === 0,
      skillNames: unsent.map(command => command.name),
    },
  ]
}

function getDiscoveredSkillsFromTranscript(
  context: ToolCallContext,
): Set<string> {
  const discovered = new Set<string>()
  const messages = Array.isArray(context.messages) ? context.messages : []
  for (const message of messages) {
    if (!isAttachmentMessage(message) || !('attachment' in message)) {
      continue
    }
    const attachment = (message as { attachment?: { type?: string } })
      .attachment
    if (!attachment || attachment.type !== 'skill_discovery') {
      continue
    }
    const disc = attachment as SkillDiscoveryAttachment
    for (const skill of disc.skills ?? []) {
      if (skill && typeof skill.name === 'string' && skill.name) {
        discovered.add(skill.name)
      }
    }
  }
  return discovered
}

export function collectSkillDiscoveryAttachments(
  input: string,
  context: ToolCallContext,
): SkillDiscoveryAttachment[] {
  if (!sessionHasSkillTool(context)) {
    return []
  }
  const commands = getModelInvocableCommands(context.options.commands)
  if (commands.length === 0) {
    return []
  }

  const discoveredNames = new Set(getAttachmentState(context).discoveredSkillNames ?? [])
  const activeSkills = getSessionActiveSkills(context)
  const discoveredFromTranscript = getDiscoveredSkillsFromTranscript(context)
  const discovered = discoverRelevantSkills(input, commands).filter(
    skill =>
      !discoveredNames.has(skill.name) &&
      !activeSkills.has(skill.name) &&
      !discoveredFromTranscript.has(skill.name),
  )
  if (discovered.length === 0) {
    return []
  }

  for (const skill of discovered) {
    discoveredNames.add(skill.name)
    context.skillsFound?.add(skill.name)
  }

  updateAttachmentState(context, previous => ({
    ...previous,
    discoveredSkillNames: [...discoveredNames].sort(),
  }))

  return [
    {
      type: 'skill_discovery',
      skills: discovered,
      signal: 'user_input',
      source: 'native',
    },
  ]
}

export async function createBrowserContextAttachment(
  hostBridge: BrowserHostBridge,
): Promise<BrowserContextAttachment> {
  const snapshot = await hostBridge.getBrowserContextSnapshot({
    includeDomSnapshot: true,
    includeAccessibilitySnapshot: true,
  })

  return {
    type: 'browser_context',
    activeTab: snapshot.activeTab as Record<string, unknown> | null,
    tabs: snapshot.tabs as Array<Record<string, unknown>>,
    session: snapshot.session as Record<string, unknown>,
    workspace: snapshot.workspace as Record<string, unknown> | null,
    userProfile: snapshot.userProfile as Record<string, unknown> | null,
    domSnapshot: snapshot.domSnapshot as Record<string, unknown> | null,
    accessibilitySnapshot: snapshot.accessibilitySnapshot as Record<string, unknown> | null,
  }
}

function browserContextSignature(attachment: BrowserContextAttachment): string {
  return JSON.stringify({
    activeTab: attachment.activeTab,
    tabs: attachment.tabs,
    workspace: attachment.workspace,
    userProfile: attachment.userProfile,
    domSnapshotContent:
      typeof attachment.domSnapshot?.content === 'string'
        ? attachment.domSnapshot.content
        : null,
    accessibilityNodes: attachment.accessibilitySnapshot?.nodes ?? null,
  })
}

export async function collectPlanModeAttachmentMessages(params: {
  context: ToolCallContext
  runtimeConfig: RuntimeConfig
}): Promise<ContextRow[]> {
  return (await collectPlanModeAttachments(params.context)).map(attachment =>
    makeContextRow(params.runtimeConfig, attachment),
  )
}

/**
 * The plan rows that follow a compaction summary, for both the automatic and
 * the manual path: the full plan-mode reminder while plan mode is active (the
 * short one points at instructions the boundary just cut off), then the plan
 * file's current contents when there are any. Without a `runtimeConfig` (a
 * fork) only the contents are returned.
 */
export async function collectPostCompactPlanRows(
  context: ToolCallContext | undefined,
  runtimeConfig: RuntimeConfig | undefined,
): Promise<Message[]> {
  if (!context) return []
  const rows: Message[] = []
  if (runtimeConfig && context.readAppState().permissionRules?.mode === 'plan') {
    const tools = Array.isArray(context.options?.tools) ? context.options.tools : []
    const planFilePath = planDocPath(context)
    const planExists = await planFileExists(context)
    // Plan mode entered again since the last reminder: say so first, as the
    // per-step reminder would have.
    const state = getAttachmentState(context)
    if (state.lastPermissionMode !== 'plan' && state.hasExitedPlanModeInSession && planExists) {
      rows.push(makeContextRow(runtimeConfig, { type: 'plan_mode_reentry', planFilePath }))
    }
    rows.push(
      makeContextRow(runtimeConfig, {
        type: 'plan_mode',
        reminderType: 'full',
        planFilePath,
        planExists,
        hasSubagents: tools.some(tool => tool?.name === SPAWN_TOOL_ID),
      }),
    )
    updateAttachmentState(context, previous => ({
      ...previous,
      lastPermissionMode: 'plan',
      hasExitedPlanModeInSession: false,
    }))
  }
  const contents = await createPostCompactPlanReferenceMessage(context)
  if (contents) rows.push(contents)
  return rows
}

/** Attachments gathered for a new user prompt: mentions, plan mode, skills, reminders. */
export async function collectInitialAttachmentMessages(params: {
  input: string
  context: ToolCallContext
  runtimeConfig: RuntimeConfig
  hostBridge: BrowserHostBridge
}): Promise<ContextRow[]> {
  const attachments: AttachmentPayload[] = []

  const mentionedFiles = findMentionedPaths(params.input).map(
    toMentionTarget,
  )
  const fileAttachments = (
    await Promise.all(
      mentionedFiles.map(mention => createFileAttachment(params.context, mention)),
    )
  ).filter((attachment): attachment is AttachmentPayload => attachment !== null)
  attachments.push(...fileAttachments)

  attachments.push(...collectSkillListingAttachments(params.context))
  attachments.push(...collectSkillDiscoveryAttachments(params.input, params.context))
  attachments.push(...(await collectPlanModeAttachments(params.context)))
  attachments.push(...collectDateChangeAttachments(params.context, params.runtimeConfig))
  const [gitState, folderTree] = await Promise.all([
    collectGitStateAttachments(params.context, params.hostBridge),
    collectFolderTreeAttachments(params.context),
  ])
  attachments.push(...gitState, ...folderTree)
  attachments.push(
    ...collectTodoReminderAttachments(params.context.messages, params.context),
  )

  return attachments.map(attachment =>
    makeContextRow(params.runtimeConfig, attachment),
  )
}

/**
 * The working folder's git state, read once over the host shell on the
 * session's first turn (F-19): it fixes the environment block's
 * `Git repository` fact, and adds one row when the folder is a repository.
 * Main loop only. A row already in the transcript, or a fact already
 * recorded, means the read was done; no shell answering means not yet.
 */
export async function collectGitStateAttachments(
  context: ToolCallContext,
  hostBridge: Pick<BrowserHostBridge, 'browser'> | undefined,
  limits: { timeoutMs?: number } = {},
): Promise<GitStateAttachment[]> {
  if (context.agentId) return []
  const messages = Array.isArray(context.messages) ? context.messages : []
  const reported = messages.some(
    row => (row as ContextRow | undefined)?.attachment?.type === 'git_state',
  )
  const state = getAttachmentState(context)
  if (reported) {
    if (state.gitRepository === undefined) {
      updateAttachmentState(context, previous => ({ ...previous, gitRepository: true }))
    }
    return []
  }
  if (state.gitRepository !== undefined || state.gitStateTimedOut) return []
  const callTool = hostBridge?.browser?.callTool
  const folder = snapshotFolderOf(context)
  if (!callTool || !folder) return []
  const waited = await withinMs(
    readGitState(request => callTool(request), folder, context.options.sessionId),
    limits.timeoutMs ?? GIT_STATE_TIMEOUT_MS,
  )
  if (waited.timedOut) {
    // Out of time once is out of time for the session: a folder that does
    // not answer would hold every turn.
    updateAttachmentState(context, previous => ({ ...previous, gitStateTimedOut: true }))
    return []
  }
  const read = waited.value
  if (!read) return []
  if (read.repository === 'unavailable') {
    // No git on the host: the fact still comes from the folder itself; the
    // snapshot does not.
    const repository = await hasGitFolder(context, folder)
    updateAttachmentState(context, previous => ({ ...previous, gitRepository: repository }))
    return []
  }
  updateAttachmentState(context, previous => ({ ...previous, gitRepository: read.repository }))
  if (!read.repository) return []
  const { repository: _repository, root, ...state_ } = read
  // The top folder is worth a line only when the working directory is inside it.
  const inside = root !== undefined && pathKey(root) !== pathKey(folder)
  return [{ type: 'git_state', ...(inside ? { root } : {}), ...state_ }]
}

function pathKey(path: string): string {
  return path.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()
}

/**
 * The folder the first-turn snapshots describe: the bound project folder,
 * else the session cwd. None for the shared sandbox workspace under
 * `~/.velloc/`: it is not the person's project, and a listing of it tells
 * the model nothing it should act on.
 */
function snapshotFolderOf(context: ToolCallContext): string | undefined {
  const folder = context.options.projectRoot || context.options.cwd
  if (!folder) return undefined
  const segments = folder.split(/[/\\]+/).filter(Boolean)
  return segments.includes(NEXUS_WORKSPACE_DIR_NAME) ? undefined : folder
}

async function hasGitFolder(context: ToolCallContext, folder: string): Promise<boolean> {
  try {
    const entries = await fsForContext(context).readdir(folder)
    return entries.some(entry => entry.name === '.git')
  } catch {
    return false
  }
}

/**
 * The working folder's file names, read once over the runtime fs on the
 * session's first turn (F-19): one row, names only, a few levels deep.
 * Main loop only; an empty folder adds no row. A row already in the
 * transcript, or the recorded read, means it was done.
 */
export async function collectFolderTreeAttachments(
  context: ToolCallContext,
  limits: { timeoutMs?: number } = {},
): Promise<FolderTreeAttachment[]> {
  if (context.agentId) return []
  const messages = Array.isArray(context.messages) ? context.messages : []
  const reported = messages.some(
    row => (row as ContextRow | undefined)?.attachment?.type === 'folder_tree',
  )
  const state = getAttachmentState(context)
  if (reported || state.folderTreeRead) {
    if (!state.folderTreeRead) updateAttachmentState(context, previous => ({ ...previous, folderTreeRead: true }))
    return []
  }
  const folder = snapshotFolderOf(context)
  if (!folder) return []
  const fs = fsForContext(context)
  // Security: on an untrusted provider the listing is uploaded, so each folder
  // passes the read boundary first; a link out of the root is not entered.
  const mayEnter = context.options.untrustedReadRoot
    ? async (path: string) => (await assertUntrustedReadAllowed(path, context, fs)).ok
    : undefined
  const waited = await withinMs(readFolderTree(fs, folder, { mayEnter }), limits.timeoutMs ?? FOLDER_TREE_TIMEOUT_MS)
  // Read, or out of time: either way not tried again this session.
  updateAttachmentState(context, previous => ({ ...previous, folderTreeRead: true }))
  if (waited.timedOut || waited.value.lines.length === 0) return []
  return [{ type: 'folder_tree', lines: waited.value.lines, truncated: waited.value.truncated }]
}

export async function* collectQueuedAttachmentMessages(
  params: QueuedAttachmentParams,
): AsyncGenerator<Message, void, unknown> {
  const reminders: AttachmentPayload[] = []
  reminders.push(...collectSkillListingAttachments(params.toolUseContext))
  reminders.push(...(await collectPlanModeAttachments(params.toolUseContext)))
  reminders.push(...collectDateChangeAttachments(params.toolUseContext, params.runtimeConfig))
  reminders.push(
    ...collectTodoReminderAttachments(params.messages, params.toolUseContext),
  )
  const attachments = [...(await collectQueuedThroughMods(params)), ...reminders]

  for (const attachment of attachments) {
    yield makeContextRow(params.runtimeConfig, attachment)
  }
}

async function collectQueuedThroughMods(params: QueuedAttachmentParams): Promise<AttachmentPayload[]> {
  const mods = params.toolUseContext?.options.mods
  if (!mods?.sessionReceive || mods.hasSessionReceiveHooks?.() === false) {
    return collectMidTurnQueuedCommands(params)
  }
  const deliveries = await receiveThroughMods(
    params,
    collectMidTurnQueuedCommands({ ...params, drainInjectMessages: undefined }),
  )
  const typed = collectMidTurnQueuedCommands({
    ...params,
    drainTaskNotifications: undefined,
    drainTeamMessages: undefined,
  })
  return [...deliveries, ...typed]
}

async function receiveThroughMods(
  params: QueuedAttachmentParams,
  queued: AttachmentPayload[],
): Promise<AttachmentPayload[]> {
  const mods = params.toolUseContext?.options.mods
  if (!mods?.sessionReceive || mods.hasSessionReceiveHooks?.() === false) return queued
  const out: AttachmentPayload[] = []
  for (const attachment of queued) {
    if (attachment.type !== 'queued_command' || attachment.commandMode === 'prompt') {
      out.push(attachment)
      continue
    }
    const kind = attachment.commandMode === 'team-message' ? 'peer' : 'task-notification'
    const text = typeof attachment.prompt === 'string' ? attachment.prompt : ''
    let received: { text: string } | { consumed: string }
    try {
      received = await mods.sessionReceive({ origin: { kind }, text }, params.toolUseContext?.cancelSource.signal)
    } catch {
      received = { text }
    }
    if ('consumed' in received) continue
    out.push(received.text === text ? attachment : { ...attachment, prompt: received.text })
  }
  return out
}

/** Emits a date change once the local date differs from the last one seen. */
export function collectDateChangeAttachments(
  context: ToolCallContext,
  runtimeConfig: RuntimeConfig,
): DateChangeAttachment[] {
  const currentDate = formatLocalISODate(new Date(runtimeConfig.now()))
  const state = getAttachmentState(context)
  const lastDate = state.lastReportedDate

  if (lastDate === undefined) {
    updateAttachmentState(context, previous => ({
      ...previous,
      lastReportedDate: currentDate,
    }))
    return []
  }

  if (currentDate === lastDate) {
    return []
  }

  updateAttachmentState(context, previous => ({
    ...previous,
    lastReportedDate: currentDate,
  }))
  if (context.options.memorySettings?.memoryMaintenance === 'dailyLog') {
    sessionTranscriptModule.rollOverAtMidnight(context.messages, currentDate)
  }
  return [{ type: 'date_change', newDate: currentDate }]
}

export function getInitialSkillSummaries(
  commands: readonly ChromiumCommandMetadata[],
): Array<{ name: string; description: string; shortId?: string }> {
  return getModelInvocableCommands(commands).map(command => ({
    name: command.name,
    description: command.description,
    shortId: command.name,
  }))
}
