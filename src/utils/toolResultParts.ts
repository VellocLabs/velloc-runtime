/**
 * The content the model reads for a tool's result data (F-26): text, or
 * content parts with each image as its own part. Pure and synchronous, so a
 * result read back from its detail record is shaped like the live one.
 */
import {
  PART_TEXT,
  PART_IMAGE,
  PART_DOCUMENT,
} from '../runtime/VercelModelConstants'

/** One part of a multimodal tool_result. Text-only results stay a string. */
export type ToolResultContentPart =
  | { type: typeof PART_TEXT; text: string }
  | { type: typeof PART_IMAGE; image: string; mimeType: string }
  | { type: typeof PART_DOCUMENT; data: string; mimeType: string }

function stringField(record: Record<string, unknown>, ...keys: string[]): string | undefined {
  for (const key of keys) {
    if (typeof record[key] === 'string') return record[key] as string
  }
  return undefined
}

/** A host tool's own `content_parts`, normalized. */
function hostedContentParts(data: unknown): ToolResultContentPart[] | undefined {
  if (!data || typeof data !== 'object') return undefined
  const parts = (data as { content_parts?: unknown }).content_parts
  if (!Array.isArray(parts)) return undefined
  const out: ToolResultContentPart[] = []
  for (const part of parts) {
    if (!part || typeof part !== 'object') continue
    const record = part as Record<string, unknown>
    if (record.type === PART_TEXT && typeof record.text === 'string') {
      out.push({ type: PART_TEXT, text: record.text })
    } else if (record.type === PART_IMAGE) {
      const image = stringField(record, 'image', 'data')
      if (image) {
        out.push({ type: PART_IMAGE, image, mimeType: stringField(record, 'mimeType', 'mime_type') ?? 'image/png' })
      }
    } else if (record.type === PART_DOCUMENT) {
      const document = stringField(record, 'data', 'document')
      if (document) {
        out.push({
          type: PART_DOCUMENT,
          data: document,
          mimeType: stringField(record, 'mimeType', 'mime_type') ?? 'application/pdf',
        })
      }
    }
  }
  return out.length > 0 ? out : undefined
}

function hostedContentText(data: unknown): string | undefined {
  if (!data || typeof data !== 'object') return undefined
  const message = (data as { message?: unknown }).message
  if (typeof message === 'string' && message.length > 0) return message
  const parts = hostedContentParts(data)
  if (!parts) return undefined
  const text = parts
    .filter((part): part is { type: typeof PART_TEXT; text: string } => part.type === PART_TEXT)
    .map(part => part.text)
    .join('\n')
    .trim()
  return text || '[multimodal tool result]'
}

/** The text form of a tool's result data. */
export function toolResultText(data: unknown): string {
  if (data === undefined || data === null) return ''
  const hostedText = hostedContentText(data)
  if (hostedText !== undefined) return hostedText
  if (typeof data === 'string') return data
  return JSON.stringify(data)
}

/** The first tab screenshot a browser observation carries, if any. */
export function screenshotOf(data: unknown): { mime: string; dataBase64: string } | undefined {
  if (!data || typeof data !== 'object') return undefined
  const observation = (data as { observation?: unknown }).observation
  if (!observation || typeof observation !== 'object') return undefined
  const tabs = (observation as { tabs?: unknown }).tabs
  if (!Array.isArray(tabs)) return undefined
  for (const tab of tabs) {
    const shot = (tab as { screenshot?: unknown } | null)?.screenshot
    if (!shot || typeof shot !== 'object') continue
    const dataBase64 = (shot as { data_base64?: unknown }).data_base64
    if (typeof dataBase64 === 'string' && dataBase64.length > 0) {
      const mime = (shot as { mime?: unknown }).mime
      return { mime: typeof mime === 'string' && mime ? mime : 'image/jpeg', dataBase64 }
    }
  }
  return undefined
}

/** A copy of `data` whose screenshot bytes are replaced by a marker, so the
 *  text part does not repeat what the image part carries. */
function withoutScreenshotBytes(data: unknown): unknown {
  if (!data || typeof data !== 'object') return data
  const copy = structuredClone(data) as {
    observation?: { tabs?: Array<{ screenshot?: { data_base64?: unknown } }> }
  }
  const tabs = copy.observation?.tabs
  if (Array.isArray(tabs)) {
    for (const tab of tabs) {
      if (tab?.screenshot && typeof tab.screenshot === 'object') {
        delete tab.screenshot.data_base64
        ;(tab.screenshot as Record<string, unknown>).delivered_as_image = true
      }
    }
  }
  return copy
}

/** What the model reads for a tool's result data: a string, or content parts.
 *  Images are passed through at their stored size. */
export function toolResultParts(data: unknown): string | ToolResultContentPart[] {
  const hosted = hostedContentParts(data)
  if (hosted) return hosted
  const shot = screenshotOf(data)
  if (!shot) return toolResultText(data)
  const stripped = withoutScreenshotBytes(data)
  const text = typeof stripped === 'string' ? stripped : JSON.stringify(stripped)
  return [
    { type: PART_TEXT, text },
    { type: PART_IMAGE, image: shot.dataBase64, mimeType: shot.mime },
  ]
}
