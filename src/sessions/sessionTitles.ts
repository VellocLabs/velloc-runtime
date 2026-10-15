import type { Message } from '../runtime/RuntimeTypes'
import type { ToolCallContext } from '../toolkit/toolCallContext'
import { queryFastModel } from '../models/fastModelCall'

/**
 * Session-title generation: a plain-text one-shot to the per-provider
 * `fastModel` for a human-readable title, then sanitized.
 */

const TITLER_BRIEF =
  'Generate a short, human-readable title (3-5 words) that captures the main ' +
  'topic of this conversation. Use normal capitalization and spaces (Title ' +
  'Case) — NOT a slug or hyphens. Examples: "Fix login redirect bug", "Add ' +
  'OAuth support", "Refactor API client", "Debug failing tests". Reply with ' +
  'ONLY the title — no quotes, no trailing punctuation, no explanation.'

/** Max characters of conversation text fed to the namer (tail-sliced). */
const MAX_CONTEXT_CHARS = 2000
/** Hard cap on the generated name length. */
const MAX_NAME_LENGTH = 60

function messageText(message: Message): string {
  const content = (message as { message?: { content?: unknown } })?.message
    ?.content
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  const parts: string[] = []
  for (const block of content) {
    if (block && typeof block === 'object') {
      const b = block as { type?: string; text?: string }
      if (b.type === 'text' && typeof b.text === 'string') parts.push(b.text)
    }
  }
  return parts.join(' ')
}

/** Flatten the visible user/assistant turns to a single text blob, tail-sliced. */
export function dialogueDigest(messages: readonly Message[]): string {
  const lines: string[] = []
  for (const message of messages) {
    if (message.type !== 'user' && message.type !== 'assistant') continue
    if ((message as { isMeta?: unknown }).isMeta === true) continue
    if ('toolUseResult' in message) continue
    const text = messageText(message).replace(/\s+/g, ' ').trim()
    if (text) lines.push(`${message.type}: ${text}`)
  }
  const joined = lines.join('\n')
  return joined.length > MAX_CONTEXT_CHARS
    ? joined.slice(-MAX_CONTEXT_CHARS)
    : joined
}

/**
 * Normalize a model reply into a clean, human-readable display title (or null).
 * Preserves the model's natural casing + spaces — it only takes the first line,
 * strips wrapping quotes, collapses whitespace, drops trailing sentence
 * punctuation, and caps the length. Deliberately NOT kebab-cased (this is a GUI
 * label, not a slug — see the module docstring). Exported for unit testing.
 */
export function sanitizeTitle(raw: string): string | null {
  const cleaned = (raw.split('\n')[0] ?? '')
    .trim()
    .replace(/^["'`]+|["'`]+$/g, '') // strip wrapping quotes/backticks
    .replace(/\s+/g, ' ') // collapse internal whitespace
    .replace(/[.!?]+$/g, '') // drop trailing sentence punctuation
    .trim()
    .slice(0, MAX_NAME_LENGTH)
    .trim()
  return cleaned.length > 0 ? cleaned : null
}

/**
 * A short session title via the fast model; null with no conversation or on a
 * failed call (errors swallowed). `signal` overrides the turn's abort signal.
 */
export async function proposeSessionTitle(
  messages: readonly Message[],
  toolUseContext: ToolCallContext,
  signal?: AbortSignal,
): Promise<string | null> {
  const conversationText = dialogueDigest(messages)
  if (!conversationText) {
    return null
  }
  try {
    const providerId = toolUseContext.options.mainLoopProviderId ?? 'anthropic'
    const effectiveSignal =
      signal ??
      toolUseContext.cancelSource?.signal ??
      new AbortController().signal
    const result = await queryFastModel({
      systemPrompt: TITLER_BRIEF,
      userPrompt: conversationText,
      signal: effectiveSignal,
      toolUseContext,
      providerId,
      querySource: 'rename_generate_name',
    })
    return sanitizeTitle(result)
  } catch {
    // Fast-model timeout / rate-limit / not-bootstrapped / abort-on-rename are
    // expected operational failures — degrade to "no name", never throw.
    return null
  }
}
