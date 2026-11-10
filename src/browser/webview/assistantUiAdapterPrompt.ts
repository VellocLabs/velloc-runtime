import type { AppendMessage, CompleteAttachment } from '@assistant-ui/react'
import type { ContentBlockParam } from '../../runtime/RuntimeTypes'
import { createQuotedAttachmentPrefix } from './BrowserComposerAttachmentAdapter'
import { encodeAttachmentImage, isImageLikeAttachment } from '../../utils/images/inlineImage'
import { imageSourceNote } from '../../utils/images/imageSourceNote'
import { formatBrowserValue } from './assistantUiAdapterParts'
import { passagesOfMetadata } from './replyQuote'
import { serializePassagePrompt } from './capturedPassages'

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
  // The composer's quote cards go ahead of the person's words; uploaded
  // attachments' paths go ahead of both.
  const text = serializePassagePrompt(
    passagesOfMetadata(message.metadata),
    extractTextFromAppendMessage(message),
  )
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
