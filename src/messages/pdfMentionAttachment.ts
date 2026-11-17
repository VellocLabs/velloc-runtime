/**
 * The attachment for an `@`-mentioned PDF: the document itself when the model takes documents,
 * page images when it takes images, else a reference the model can Read in pages. Loaded on the
 * first PDF mention, not with the collectors.
 */

import type { FilePartsAttachment, PDFDocumentAttachment, PdfPointer } from '../runtime/RuntimeTypes'
import { resolveToolByName } from '../toolkit/toolContract'
import { type ToolCallContext } from '../toolkit/toolCallContext'
import { fsForContext } from '../utils/fs/runtimeFs'
import { createGeneratedUserMessage } from './messageFactories'
import { READ_TOOL_ID } from '../prompting/fileToolNames'
import { resolveDocumentInputMode } from '../config/nexusModelConfig/documentInput'
import type { NexusDocumentInputMode } from '../config/nexusModelConfig/types'
import { readUserLayer } from '../settings/settingsStore'
import { PART_DOCUMENT, PART_TEXT } from '../runtime/VercelModelConstants'
import { AT_MENTION_CAN_USE_TOOL, filePartsFromReadResult } from './mentionReadHelpers'

const PDF_INLINE_PAGE_LIMIT = 10
const PDF_PAGE_SIZE_ESTIMATE_BYTES = 100 * 1024
const PDF_RASTERIZE_MAX_BASE64_CHARS = 8 * 1024 * 1024

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

const PDF_TOO_MANY_PAGES_PATTERN = /This PDF has (\d+) pages/
const PDF_PAGED_READ_COUNT_PATTERN = /\(pages \d+-\d+ of (\d+)\)/

export async function createPdfAttachment(
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
