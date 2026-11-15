/**
 * Contract: how a transcript reads as model steps (F-41). One step is an
 * assistant message that carries anything besides reasoning. The reminder
 * modules count steps back from the end to the latest call of the tool they
 * watch and to their latest reminder row; the message shapes those counts
 * depend on are read here, once.
 */
import type { Message } from '../runtime/RuntimeTypes'
import {
  LEGACY_PART_TOOL_USE,
  PART_REASONING,
  PART_REDACTED_THINKING,
  PART_THINKING,
  PART_TOOL_CALL,
  isAssistantMessage,
} from '../runtime/VercelModelConstants'

export type ScanPart = { type?: string; toolName?: string; name?: string }

const REASONING_KINDS = new Set<string>([PART_THINKING, PART_REDACTED_THINKING, PART_REASONING])

/** The content of a message when it is a list of parts, `null` when it is text. */
export function partsOf(message: Message): ScanPart[] | null {
  const content = (message as { message?: { content?: unknown } }).message?.content
  return Array.isArray(content) ? (content as ScanPart[]) : null
}

/** True for parts that carry nothing but reasoning. */
export function isReasoningOnly(parts: ScanPart[] | null): boolean {
  return !!parts && parts.length > 0 && parts.every(part => REASONING_KINDS.has(part?.type ?? ''))
}

/** True when the parts hold a call of `toolName`, in either tool-call shape. */
export function callsTool(parts: ScanPart[] | null, toolName: string): boolean {
  return !!parts?.some(
    part =>
      (part?.type === PART_TOOL_CALL && part.toolName === toolName) ||
      (part?.type === LEGACY_PART_TOOL_USE && part.name === toolName),
  )
}

export type StepScan = {
  /** Model steps newer than the latest call the scan looks for. */
  sinceCall: number
  /** Model steps newer than the latest row `isMarker` accepts. */
  sinceMarker: number
}

/**
 * Counts model steps from the end of the transcript, stopping once both counts
 * are known. Reasoning-only replies are not steps; every other row that is not
 * a model step (a person's message, a tool result, a notice) is passed over
 * without resetting either count.
 */
export function countModelSteps(
  messages: readonly Message[],
  scan: {
    calls: (parts: ScanPart[] | null) => boolean
    isMarker: (message: Message) => boolean
  },
): StepScan {
  let steps = 0
  let sinceCall: number | null = null
  let sinceMarker: number | null = null
  for (let i = messages.length - 1; i >= 0 && (sinceCall === null || sinceMarker === null); i--) {
    const message = messages[i]
    if (!message) continue
    if (scan.isMarker(message)) {
      sinceMarker ??= steps
      continue
    }
    if (!isAssistantMessage(message)) continue
    const parts = partsOf(message)
    if (isReasoningOnly(parts)) continue
    if (scan.calls(parts)) sinceCall ??= steps
    steps++
  }
  return { sinceCall: sinceCall ?? steps, sinceMarker: sinceMarker ?? steps }
}
