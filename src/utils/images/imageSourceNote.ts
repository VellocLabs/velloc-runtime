/**
 * The one-line note sent to the model beside a composer image: where the
 * uploaded original is on disk and, when the sent copy was scaled down, both
 * sizes and the coordinate factor. Travels as its own text block, hidden from
 * the user's bubble via `isImageSourceNoteText`.
 */

import type { ImageSizing } from './inlineImage'

const OPEN = '[Image'
const PATH_LEAD = `${OPEN} source: `

function scalingClause(sizing: ImageSizing): string {
  const factor = (sizing.sourceWidth / sizing.sentWidth).toFixed(2)
  return (
    `scaled down from ${sizing.sourceWidth}x${sizing.sourceHeight} ` +
    `to ${sizing.sentWidth}x${sizing.sentHeight} for sending, ` +
    `so multiply coordinates read from this copy by ${factor} to locate them in the original`
  )
}

const SCALING_PATTERN =
  'scaled down from \\d+x\\d+ to \\d+x\\d+ for sending, ' +
  'so multiply coordinates read from this copy by \\d+\\.\\d{2} to locate them in the original'
const PATH_LINE = /^\[Image source: .+\]$/
const SCALING_ONLY_LINE = new RegExp(`^\\[Image ${SCALING_PATTERN}\\]$`)

/** Whether the sizes are usable: both source sides set, both sent sides positive. */
function measured(sizing: ImageSizing | undefined): sizing is ImageSizing {
  return (
    sizing !== undefined &&
    Boolean(sizing.sourceWidth) &&
    Boolean(sizing.sourceHeight) &&
    sizing.sentWidth > 0 &&
    sizing.sentHeight > 0
  )
}

/** The note for one image, or null when it has nothing to say. */
export function imageSourceNote(
  sizing: ImageSizing | undefined,
  sourcePath?: string,
): string | null {
  const scaled =
    measured(sizing) &&
    (sizing.sourceWidth !== sizing.sentWidth || sizing.sourceHeight !== sizing.sentHeight)
  const clause = scaled ? scalingClause(sizing) : null

  if (sourcePath) {
    return clause ? `${PATH_LEAD}${sourcePath}; ${clause}]` : `${PATH_LEAD}${sourcePath}]`
  }
  return clause ? `${OPEN} ${clause}]` : null
}

/** True for text made only of image source notes, one per line (blank lines ignored). */
export function isImageSourceNoteText(text: string): boolean {
  const lines = text.split('\n').filter(Boolean)
  return (
    lines.length > 0 &&
    lines.every(line => PATH_LINE.test(line) || SCALING_ONLY_LINE.test(line))
  )
}
