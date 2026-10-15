/**
 * Turns the stored transcript into the history a model request carries.
 *
 * Stages run in a fixed order: attachments expand first, then assistant
 * turns the provider would reject are cleaned or dropped, then user turns
 * are folded together, and finally every tool call is matched to exactly
 * one answer in the user turn right after it.
 */

import type {
  ContextRow,
  ContentBlockParam,
  Message,
} from '../runtime/RuntimeTypes'
import {
  PART_DOCUMENT,
  PART_IMAGE,
  PART_REDACTED_THINKING,
  PART_TEXT,
  PART_THINKING,
  PART_TOOL_RESULT_CANONICAL,
  REASONING_REPLAY_SIGNATURE_PREFIX,
  isAssistantMessage,
  isAttachmentMessage,
  isToolResultPart,
  isToolUsePart,
  isUserMessage,
} from '../runtime/VercelModelConstants'
import { createGeneratedUserMessage } from './messageFactories'
import { renderAttachmentMessage } from './renderAttachments'

type Part = Record<string, unknown>
type Stage = (history: readonly Message[]) => Message[]

const LOST_ANSWER = '[Tool result missing due to internal error]'
const CUT_SHORT = '[Tool use interrupted]'
const STRAY_ANSWER_NOTE = '[Orphaned tool result removed due to conversation resume]'
const EMPTY_PLACEHOLDER = '(no content)'
const MEDIA_FAILURE = /image|document|pdf|too large|size/i

// ── small accessors ─────────────────────────────────────────────────────────

function partsOf(msg: Message): Part[] | undefined {
  const body = (msg as { message?: { content?: unknown } }).message?.content
  return Array.isArray(body) ? (body as Part[]) : undefined
}

function rawBody(msg: Message): unknown {
  return (msg as { message?: { content?: unknown } }).message?.content
}

function withBody(msg: Message, content: unknown): Message {
  const inner = (msg as { message?: object }).message
  return { ...msg, message: { ...inner, content } } as Message
}

function isPart(value: unknown): value is Part {
  return typeof value === 'object' && value !== null
}

function hasType(value: unknown, ...kinds: string[]): boolean {
  return isPart(value) && kinds.includes(value.type as string)
}

function isCall(p: unknown): p is Part {
  return isPart(p) && typeof p.type === 'string' && isToolUsePart(p as { type: string })
}

function isAnswer(p: unknown): p is Part {
  return isPart(p) && typeof p.type === 'string' && isToolResultPart(p as { type: string })
}

function callKey(p: Part): string | undefined {
  if (typeof p.toolCallId === 'string') return p.toolCallId
  return typeof p.id === 'string' ? p.id : undefined
}

function answerKey(p: Part): string | undefined {
  if (typeof p.toolCallId === 'string') return p.toolCallId
  return typeof p.tool_use_id === 'string' ? p.tool_use_id : undefined
}

function textPart(text: string): Part {
  return { type: PART_TEXT, text }
}

function isPlainText(p: unknown): p is Part & { text: string } {
  return hasType(p, PART_TEXT) && typeof (p as Part).text === 'string'
}

function lostAnswer(id: string): Part {
  return { type: PART_TOOL_RESULT_CANONICAL, toolCallId: id, result: LOST_ANSWER, isError: true }
}

function metaUser(content: string | Part[]): Message {
  return createGeneratedUserMessage(
    content as string | ContentBlockParam[],
    { isMeta: true },
  ) as unknown as Message
}

// ── assistant-side cleanup ──────────────────────────────────────────────────

export function isErrorCardTurn(msg: Message): boolean {
  return isAssistantMessage(msg)
    && (msg as { isApiErrorMessage?: unknown }).isApiErrorMessage === true
}

function isReplayReasoning(p: unknown): boolean {
  return hasType(p, PART_THINKING)
    && typeof (p as Part).signature === 'string'
    && ((p as Part).signature as string).startsWith(REASONING_REPLAY_SIGNATURE_PREFIX)
}

/** Remove reasoning parts; replay envelopes survive only beside real output. */
export const dropReasoningBlocks: Stage = history => history.map(msg => {
  const parts = isAssistantMessage(msg) ? partsOf(msg) : undefined
  if (!parts) return msg
  let kept = parts.filter(p =>
    !hasType(p, PART_THINKING, PART_REDACTED_THINKING) || isReplayReasoning(p))
  if (kept.length > 0 && kept.every(isReplayReasoning)) kept = []
  return kept.length === parts.length ? msg : withBody(msg, kept)
})

function firstText(msg: Message): string | undefined {
  return partsOf(msg)?.find(isPlainText)?.text
}

/**
 * When a provider refused a turn over an attachment, the user turn that sent
 * it loses its images and documents so the retry does not hit the same wall.
 */
export const dropMediaBeforeMediaError: Stage = history => {
  const result = [...history]
  result.forEach((card, at) => {
    if (!isErrorCardTurn(card)) return
    const said = firstText(card)
    if (said === undefined || !MEDIA_FAILURE.test(said)) return
    for (let back = at - 1; back >= 0; back--) {
      if (!isUserMessage(result[back])) continue
      const parts = partsOf(result[back])
      if (parts) {
        result[back] = withBody(
          result[back],
          parts.filter(p => !hasType(p, PART_IMAGE, PART_DOCUMENT)),
        )
      }
      break
    }
  })
  return result
}

export const dropErrorCardTurns: Stage = history =>
  history.filter(msg => !isErrorCardTurn(msg))

export const dropEmptyAssistantTurns: Stage = history =>
  history.filter(msg => !(isAssistantMessage(msg) && partsOf(msg)?.length === 0))

export const dropBlankAssistantTurns: Stage = history => history.filter(msg => {
  const parts = isAssistantMessage(msg) ? partsOf(msg) : undefined
  if (!parts) return true
  return !parts.every(p => isPlainText(p) && p.text.trim() === '')
})

// ── folding adjacent user turns ─────────────────────────────────────────────

function asParts(msg: Message): Part[] | undefined {
  const body = rawBody(msg)
  if (Array.isArray(body)) return body as Part[]
  if (typeof body === 'string') return [textPart(body)]
  return undefined
}

function answersFirst(parts: Part[]): Part[] {
  return [...parts.filter(isAnswer), ...parts.filter(p => !isAnswer(p))]
}

function foldUserTurns(history: readonly Message[]): Message[] {
  const out: Message[] = []
  for (const msg of history) {
    const held = out[out.length - 1]
    const heldParts = held && isUserMessage(held) && isUserMessage(msg) ? asParts(held) : undefined
    const incoming = heldParts ? asParts(msg) : undefined
    if (!heldParts || !incoming) {
      out.push(msg)
      continue
    }
    const answered = new Set(heldParts.filter(isAnswer).map(answerKey).filter(Boolean))
    const additions = incoming.filter(p => {
      if (!isAnswer(p)) return true
      const key = answerKey(p)
      if (key === undefined) return true
      if (answered.has(key)) return false
      answered.add(key)
      return true
    })
    if (additions.length === 0) continue
    const joined = [...heldParts]
    const tail = joined[joined.length - 1]
    if (isPlainText(tail) && hasType(additions[0], PART_TEXT)) {
      joined[joined.length - 1] = { ...tail, text: `${tail.text}\n` }
    }
    out[out.length - 1] = withBody(held, answersFirst([...joined, ...additions]))
  }
  return out
}

// ── matching calls with answers ─────────────────────────────────────────────

function matchCallsToAnswers(history: readonly Message[]): Message[] {
  const out: Message[] = []
  const issuedCalls = new Set<string>()
  let repaired = false

  for (let i = 0; i < history.length; i++) {
    const msg = history[i]

    if (!isAssistantMessage(msg)) {
      const parts = isUserMessage(msg) ? partsOf(msg) : undefined
      const unanchored = out.length === 0 || !isAssistantMessage(out[out.length - 1])
      if (!parts || !unanchored) {
        out.push(msg)
        continue
      }
      const rest = parts.filter(p => !isAnswer(p))
      if (rest.length === parts.length) {
        out.push(msg)
        continue
      }
      repaired = true
      if (rest.length > 0) out.push(withBody(msg, rest))
      else if (out.length === 0) out.push(withBody(msg, [textPart(STRAY_ANSWER_NOTE)]))
      continue
    }

    let turn = msg
    const parts = partsOf(msg)
    const liveCalls: string[] = []
    if (parts) {
      const kept = parts.filter(p => {
        if (!isCall(p)) return true
        const key = callKey(p)
        if (key === undefined) return true
        if (issuedCalls.has(key)) return false
        issuedCalls.add(key)
        liveCalls.push(key)
        return true
      })
      if (kept.length !== parts.length) {
        repaired = true
        turn = withBody(msg, kept.length > 0 ? kept : [textPart(CUT_SHORT)])
      }
    }
    out.push(turn)

    const next = history[i + 1]
    const nextIsUser = next !== undefined && isUserMessage(next)
    const nextParts = nextIsUser ? partsOf(next) : undefined
    const answerKeys: string[] = []
    let repeated = false
    for (const p of nextParts ?? []) {
      if (!isAnswer(p)) continue
      const key = answerKey(p)
      if (key === undefined) continue
      if (answerKeys.includes(key)) repeated = true
      else answerKeys.push(key)
    }
    const expected = new Set(liveCalls)
    const missing = liveCalls.filter(id => !answerKeys.includes(id))
    const stray = new Set(answerKeys.filter(id => !expected.has(id)))
    if (missing.length === 0 && stray.size === 0 && !repeated) continue

    if (nextIsUser) {
      repaired = true
      const base = nextParts ?? [textPart(typeof rawBody(next) === 'string' ? rawBody(next) as string : '')]
      const seen = new Set<string>()
      const cleaned = base.filter(p => {
        if (!isAnswer(p)) return true
        const key = answerKey(p)
        if (key === undefined) return true
        if (stray.has(key) || seen.has(key)) return false
        seen.add(key)
        return true
      })
      const merged = [...missing.map(lostAnswer), ...cleaned]
      out.push(merged.length > 0 ? withBody(next, merged) : metaUser(EMPTY_PLACEHOLDER))
      i++
    } else if (missing.length > 0) {
      repaired = true
      out.push(metaUser(missing.map(lostAnswer)))
    }
  }

  if (repaired) {
    console.warn(
      `[nexus] matchCallsToAnswers: fixed tool call/answer pairing (${history.length} → ${out.length} messages)`,
    )
  }
  return out
}

// ── entry point ─────────────────────────────────────────────────────────────

function expandAttachments(history: readonly Message[]): Message[] {
  return history.flatMap(msg =>
    isAttachmentMessage(msg) && (msg as { attachment?: unknown }).attachment
      ? renderAttachmentMessage(msg as ContextRow)
      : [msg])
}

const STAGES: readonly Stage[] = [
  expandAttachments,
  dropReasoningBlocks,
  dropMediaBeforeMediaError, // reads error cards, so it runs before they go
  dropErrorCardTurns,
  dropEmptyAssistantTurns,
  dropBlankAssistantTurns,
  foldUserTurns,
  matchCallsToAnswers,
]

export function prepareHistoryForModel(history: readonly Message[]): Message[] {
  return STAGES.reduce<Message[]>((acc, stage) => stage(acc), [...history])
}
