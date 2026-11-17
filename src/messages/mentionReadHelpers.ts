/** What an `@`-mention read shares between the collectors and the PDF path: the allow-all decider
 *  a mention read runs under, and the normalizer for a Read's `content_parts`. A leaf: it must not
 *  import either of its users. */

import type { FilePartsAttachment } from '../runtime/RuntimeTypes'
import { type PermissionDecider } from '../toolkit/permissionVerdict'
import { PART_IMAGE, PART_TEXT } from '../runtime/VercelModelConstants'

export const AT_MENTION_CAN_USE_TOOL: PermissionDecider = (async () => ({
  behavior: 'allow' as const,
  updatedInput: {},
})) as PermissionDecider

export function filePartsFromReadResult(data: unknown): FilePartsAttachment['parts'] | null {
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
