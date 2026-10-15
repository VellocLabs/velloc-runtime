/**
 * Contract: image bytes into the base64 content part a model request carries.
 * Composer images within 2000px per side and 3.75 MB of an inline type go byte
 * for byte; others are scaled to fit 2000x2000 and re-encoded (png first, then
 * jpeg 0.8 down to 0.2, final fallback 1000px jpeg 0.2). Tool-result images are
 * capped at a 1024px long edge; small payloads and GIFs are left alone and any
 * failure keeps the original. Runs on the page thread and in workers.
 */

/** Image types a model request can carry inline. */
export const INLINE_IMAGE_MIME_TYPES = [
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/webp',
] as const

export type InlineImageMime = (typeof INLINE_IMAGE_MIME_TYPES)[number]

/** An image content part as sent to the model. */
export interface InlineImagePart {
  type: 'image'
  /** Raw base64, no `data:` prefix. */
  image: string
  mimeType: string
  /**
   * The same bytes as a `data:<mime>;base64,…` URL, for providers whose wire
   * format wants a URL rather than a bare base64 string.
   */
  url: string
}

/** An image's pixel size as received and as sent. */
export interface ImageSizing {
  sourceWidth: number
  sourceHeight: number
  sentWidth: number
  sentHeight: number
}

/** An encoded composer image; `sizing` is absent when it could not be decoded. */
export interface EncodedImage {
  part: InlineImagePart
  sizing?: ImageSizing
}

// Base64 of an inline image must stay under 5 MB; base64 is 4/3 the size of
// the bytes it encodes.
const RAW_BYTE_BUDGET = (5 * 1024 * 1024 * 3) / 4
const COMPOSER_MAX_SIDE = 2000
const TOOL_RESULT_MAX_SIDE = 1024
const TOOL_RESULT_MIN_BASE64_CHARS = 100_000
const JPEG_QUALITY_STEPS = [0.8, 0.6, 0.4, 0.2] as const
const LAST_RESORT_MAX_WIDTH = 1000
const LAST_RESORT_QUALITY = 0.2
const FALLBACK_MIME = 'image/png'

const INLINE_MIME_SET: ReadonlySet<string> = new Set(INLINE_IMAGE_MIME_TYPES)

/** True for an image type the model can be sent inline, in any letter case. */
export function isInlineImageMime(mime: string | undefined | null): boolean {
  return typeof mime === 'string' && INLINE_MIME_SET.has(mime.toLowerCase())
}

/**
 * True when a composer attachment should travel as an inline image: the
 * attachment adapter tagged it an image, or its content type is inline-able.
 * (An SVG is markup the decoder cannot draw; it goes by file path instead.)
 */
export function isImageLikeAttachment(attachment: {
  type?: string
  contentType?: string
}): boolean {
  return attachment.type === 'image' || isInlineImageMime(attachment.contentType)
}

/** A URL an `<img>` can show: data/http(s) URLs as-is, raw base64 wrapped. */
export function toRenderableImageUrl(part: { image: string; mimeType?: string }): string {
  if (/^(?:data:|https?:\/\/)/.test(part.image)) return part.image
  return dataUrlOf(part.image, part.mimeType || FALLBACK_MIME)
}

/** Read a file as a `data:` URL, unchanged (composer thumbnails). */
export function readFileAsDataUrl(file: Blob): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(reader.result as string)
    reader.onerror = () => reject(reader.error ?? new Error('could not read the image file'))
    reader.readAsDataURL(file)
  })
}

/** Encode a composer image file as an inline content part. */
export async function encodeImageFile(file: File): Promise<EncodedImage> {
  const declared = file.type || FALLBACK_MIME
  const inlineable = INLINE_MIME_SET.has(declared)
  const bitmap = await decode(file)

  if (!bitmap) {
    return { part: partFrom(await base64Of(file), inlineable ? declared : FALLBACK_MIME) }
  }

  try {
    const source = { width: bitmap.width, height: bitmap.height }
    const sendAsIs =
      inlineable &&
      source.width > 0 &&
      source.width <= COMPOSER_MAX_SIDE &&
      source.height <= COMPOSER_MAX_SIDE &&
      file.size <= RAW_BYTE_BUDGET
    if (sendAsIs) {
      return {
        part: partFrom(await base64Of(file), declared),
        sizing: sizingOf(source, source),
      }
    }

    const target = fitInside(source, COMPOSER_MAX_SIDE)
    const encoded = await reencode(bitmap, target, prefersPng(declared, inlineable))
    return {
      part: partFrom(await base64Of(encoded.blob), encoded.mime),
      sizing: sizingOf(source, encoded),
    }
  } finally {
    bitmap.close()
  }
}

/** `encodeImageFile` for a composer attachment; null when it carries no `File`. */
export async function encodeAttachmentImage(attachment: {
  file?: File
}): Promise<EncodedImage | null> {
  return attachment.file instanceof File ? encodeImageFile(attachment.file) : null
}

/**
 * A smaller copy of a tool-result image, or null to keep the original — the
 * caller writes `(await shrinkToolResultImage(b64, mime)) ?? original`.
 */
export async function shrinkToolResultImage(
  base64: string,
  mimeType: string,
): Promise<{ image: string; mimeType: string } | null> {
  if (typeof createImageBitmap !== 'function') return null
  if (base64.length < TOOL_RESULT_MIN_BASE64_CHARS) return null
  // A canvas draws one frame, so an animated GIF would come back as a still.
  if (mimeType === 'image/gif') return null

  const bytes = blobFromBase64(base64, mimeType)
  const bitmap = bytes && (await decode(bytes))
  if (!bitmap) return null

  try {
    const source = { width: bitmap.width, height: bitmap.height }
    if (Math.max(source.width, source.height) <= TOOL_RESULT_MAX_SIDE) return null
    const target = fitInside(source, TOOL_RESULT_MAX_SIDE)
    const encoded = await reencode(
      bitmap,
      target,
      prefersPng(mimeType, INLINE_MIME_SET.has(mimeType)),
    )
    const image = await base64Of(encoded.blob)
    // A flat UI screenshot can grow when re-encoded; keep the smaller one.
    return image.length < base64.length ? { image, mimeType: encoded.mime } : null
  } catch {
    return null
  } finally {
    bitmap.close()
  }
}

// ---------------------------------------------------------------------------
// Internals

interface Size {
  width: number
  height: number
}

interface EncodeStep extends Size {
  mime: 'image/png' | 'image/jpeg'
  quality?: number
}

interface Encoded extends EncodeStep {
  blob: Blob
}

type DrawSurface = OffscreenCanvas | HTMLCanvasElement

function dataUrlOf(base64: string, mime: string): string {
  return `data:${mime};base64,${base64}`
}

function partFrom(base64: string, mime: string): InlineImagePart {
  return { type: 'image', image: base64, mimeType: mime, url: dataUrlOf(base64, mime) }
}

function sizingOf(source: Size, sent: Size): ImageSizing {
  return {
    sourceWidth: source.width,
    sourceHeight: source.height,
    sentWidth: sent.width,
    sentHeight: sent.height,
  }
}

function prefersPng(mime: string, inlineable: boolean): boolean {
  return !inlineable || mime === 'image/png'
}

async function decode(bytes: Blob): Promise<ImageBitmap | null> {
  try {
    return await createImageBitmap(bytes)
  } catch {
    return null
  }
}

async function base64Of(bytes: Blob): Promise<string> {
  const url = await readFileAsDataUrl(bytes)
  return url.slice(url.indexOf(',') + 1)
}

function blobFromBase64(base64: string, mime: string): Blob | null {
  let binary: string
  try {
    binary = atob(base64)
  } catch {
    return null
  }
  const buffer = new ArrayBuffer(binary.length)
  const view = new Uint8Array(buffer)
  for (let i = 0; i < binary.length; i++) view[i] = binary.charCodeAt(i)
  return new Blob([buffer], { type: mime })
}

/**
 * Scale down (never up) to at most `maxSide` wide, then at most `maxSide`
 * high, keeping the aspect ratio. Each pass rounds to whole pixels.
 */
function fitInside(source: Size, maxSide: number): Size {
  let { width, height } = source
  if (width > maxSide) {
    ;[width, height] = [maxSide, Math.round((height * maxSide) / width)]
  }
  if (height > maxSide) {
    ;[width, height] = [Math.round((width * maxSide) / height), maxSide]
  }
  return { width, height }
}

/** Every encode to try, in order; the last one is taken whatever its size. */
function encodePlan(target: Size, pngFirst: boolean): EncodeStep[] {
  const plan: EncodeStep[] = pngFirst ? [{ ...target, mime: 'image/png' }] : []
  for (const quality of JPEG_QUALITY_STEPS) plan.push({ ...target, mime: 'image/jpeg', quality })
  const width = Math.min(target.width, LAST_RESORT_MAX_WIDTH)
  plan.push({
    width,
    height: Math.round((target.height * width) / Math.max(target.width, 1)),
    mime: 'image/jpeg',
    quality: LAST_RESORT_QUALITY,
  })
  return plan
}

async function reencode(bitmap: ImageBitmap, target: Size, pngFirst: boolean): Promise<Encoded> {
  const plan = encodePlan(target, pngFirst)
  for (const [index, step] of plan.entries()) {
    const blob = await render(bitmap, step)
    if (blob.size <= RAW_BYTE_BUDGET || index === plan.length - 1) return { ...step, blob }
  }
  throw new Error('empty encode plan')
}

function surface(size: Size): DrawSurface {
  if (typeof OffscreenCanvas !== 'undefined') return new OffscreenCanvas(size.width, size.height)
  const canvas = document.createElement('canvas')
  canvas.width = size.width
  canvas.height = size.height
  return canvas
}

async function render(bitmap: ImageBitmap, step: EncodeStep): Promise<Blob> {
  const canvas = surface(step)
  const context = canvas.getContext('2d') as
    | OffscreenCanvasRenderingContext2D
    | CanvasRenderingContext2D
    | null
  if (!context) throw new Error('no 2d drawing context')
  context.drawImage(bitmap, 0, 0, step.width, step.height)

  if ('convertToBlob' in canvas) {
    return canvas.convertToBlob({ type: step.mime, quality: step.quality })
  }
  return new Promise<Blob>((resolve, reject) => {
    canvas.toBlob(
      blob => (blob ? resolve(blob) : reject(new Error('canvas produced no image'))),
      step.mime,
      step.quality,
    )
  })
}
