/**
 * The text a model without image or document input is sent in place of such a
 * part. Applied on the wire only: the stored transcript keeps the part.
 */
import { PART_DOCUMENT, PART_IMAGE, PART_TEXT } from './VercelModelConstants'

const IMAGE_OMITTED_PLACEHOLDER =
  '[image omitted: the selected model does not support image input]'
const DOCUMENT_OMITTED_PLACEHOLDER =
  '[document omitted: the selected model does not support document input]'

/** Which kinds of media part to replace. Both when not stated. */
export type OmittedMedia = { images?: boolean; documents?: boolean }

function typeOf(part: unknown): unknown {
  return typeof part === 'object' && part !== null ? (part as { type?: unknown }).type : undefined
}

/** An image/document part as its text placeholder; anything else as-is. */
export function omitMediaPart(part: unknown, omit: OmittedMedia = { images: true, documents: true }): unknown {
  const type = typeOf(part)
  if (type === PART_IMAGE && omit.images) {
    return { type: PART_TEXT, text: IMAGE_OMITTED_PLACEHOLDER }
  }
  if (type === PART_DOCUMENT && omit.documents) {
    return { type: PART_TEXT, text: DOCUMENT_OMITTED_PLACEHOLDER }
  }
  return part
}
