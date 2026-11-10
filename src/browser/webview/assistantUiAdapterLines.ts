import type { ThreadMessageLike } from '@assistant-ui/react'
import type { Message } from '../../runtime/RuntimeTypes'

/**
 * The physical transcript line an entry was read from, or null.
 *
 * Stamped by the storage loader, counted the way the search host counts
 * (every line in the file, blanks included) — see
 * `session-storage-physical-line.test.ts`, which exists to keep the two
 * in step.
 */
export function lineOf(message: unknown): number | null {
  const line = (message as { transcriptLine?: unknown } | null)?.transcriptLine
  return typeof line === 'number' && Number.isFinite(line) && line >= 0
    ? line
    : null
}

/**
 * Records the transcript lines a rendered row covers: rows are sparse, so a hit is located
 * by which declared range contains it.
 */
export function withLineRange(
  message: ThreadMessageLike,
  from: number,
  to: number,
): ThreadMessageLike {
  const metadata = (message.metadata ?? {}) as Record<string, unknown>
  const custom = (metadata.custom ?? {}) as Record<string, unknown>
  return {
    ...message,
    metadata: {
      ...metadata,
      custom: { ...custom, lineFrom: from, lineTo: to },
    },
  } as ThreadMessageLike
}

/**
 * Concatenates two rows' per-part line lists, in the order their content
 * is concatenated — so the combined list still lines up part for part.
 */
export function mergePartLines(
  a: ThreadMessageLike,
  b: ThreadMessageLike,
): { partLines?: string } {
  const read = (message: ThreadMessageLike): string => {
    const custom = (message.metadata as { custom?: Record<string, unknown> })
      ?.custom
    const value = custom?.[PART_LINES_KEY]
    return typeof value === 'string' ? value : ''
  }
  const joined = [read(a), read(b)].filter(part => part.length > 0).join(' ')
  return joined.length > 0 ? { partLines: joined } : {}
}

/** Concatenates two rows' text-part line lists, in render order. */
export function mergeTextLines(
  a: ThreadMessageLike,
  b: ThreadMessageLike,
): { textLines?: string } {
  const read = (message: ThreadMessageLike): string => {
    const custom = (message.metadata as { custom?: Record<string, unknown> })
      ?.custom
    const value = custom?.[TEXT_LINES_KEY]
    return typeof value === 'string' ? value : ''
  }
  const joined = [read(a), read(b)].filter(part => part.length > 0).join(' ')
  return joined.length > 0 ? { textLines: joined } : {}
}

/** Union of two rows' line ranges, for the assistant merge pass. */
export function mergeLineRanges(
  a: ThreadMessageLike,
  b: ThreadMessageLike,
): { lineFrom?: number; lineTo?: number } {
  const read = (message: ThreadMessageLike, key: string): number | undefined => {
    const custom = (message.metadata as { custom?: Record<string, unknown> })
      ?.custom
    const value = custom?.[key]
    return typeof value === 'number' ? value : undefined
  }
  const from = [read(a, 'lineFrom'), read(b, 'lineFrom')].filter(
    (value): value is number => value !== undefined,
  )
  const to = [read(a, 'lineTo'), read(b, 'lineTo')].filter(
    (value): value is number => value !== undefined,
  )
  return {
    ...(from.length ? { lineFrom: Math.min(...from) } : {}),
    ...(to.length ? { lineTo: Math.max(...to) } : {}),
  }
}

/** `9 9 12` — the transcript line behind each content part, in order. */
export const PART_LINES_KEY = 'partLines'

/**
 * `9 12` — the line behind each TEXT part, in order.
 *
 * Text blocks render as a homogeneous sequence in the message body, so
 * the Nth of them is the Nth text part. The mixed part list cannot be
 * matched that way: consecutive tool parts are grouped into wrapper
 * elements, so a row with forty parts can render two children.
 */
export const TEXT_LINES_KEY = 'textLines'

/** `call-1=9:12 call-2=15:20` — the lines each tool card covers. */
export const TOOL_LINE_RANGES_KEY = 'toolLineRanges'

/**
 * The transcript lines behind each tool call, from the issuing assistant line to the result
 * line, so a collapsed card can declare them. A string, so per-message selectors stay stable.
 */
export function collectToolLineRanges(
  messages: readonly Message[],
): string {
  const callLine = new Map<string, number>()
  const resultLine = new Map<string, number>()
  for (const message of messages) {
    const line = lineOf(message)
    if (line === null) continue
    const content = (message as { message?: { content?: unknown } }).message
      ?.content
    if (!Array.isArray(content)) continue
    for (const raw of content) {
      const part = raw as { type?: unknown; toolCallId?: unknown; toolUseId?: unknown }
      const id =
        typeof part.toolCallId === 'string'
          ? part.toolCallId
          : typeof part.toolUseId === 'string'
            ? part.toolUseId
            : null
      if (!id) continue
      if (part.type === 'tool-call' || part.type === 'tool_use') {
        if (!callLine.has(id)) callLine.set(id, line)
      } else if (part.type === 'tool-result' || part.type === 'tool_result') {
        resultLine.set(id, Math.max(resultLine.get(id) ?? line, line))
      }
    }
  }
  const encoded: string[] = []
  for (const [id, from] of callLine) {
    const to = Math.max(from, resultLine.get(id) ?? from)
    encoded.push(`${id}=${from}:${to}`)
  }
  return encoded.join(' ')
}

/** Reads one tool call's range out of the encoded map. */
export function toolLineRange(
  encoded: string | undefined,
  toolCallId: string,
): { from: number; to: number } | null {
  if (!encoded) return null
  for (const chunk of encoded.split(' ')) {
    const at = chunk.indexOf('=')
    if (at < 0 || chunk.slice(0, at) !== toolCallId) continue
    const [from, to] = chunk.slice(at + 1).split(':').map(Number)
    if (!Number.isFinite(from) || !Number.isFinite(to)) return null
    return { from: from!, to: to! }
  }
  return null
}
