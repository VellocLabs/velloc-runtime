import type { Message } from '../runtime/RuntimeTypes.js'
import {
  MSG_TYPE_USER,
  MSG_TYPE_ASSISTANT,
  MSG_TYPE_SYSTEM,
  PART_TEXT,
  PART_IMAGE,
  PART_DOCUMENT,
  PART_TOOL_RESULT_CANONICAL,
  PART_TOOL_CALL,
  isUserMessage,
  isAssistantMessage,
  isSystemMessage,
} from '../runtime/VercelModelConstants.js'

/**
 * Cost of one base64 media payload in CHARS (callers divide by 4): charged natively,
 * `min(payloadLength, cap)` near `NATIVE_MEDIA_TOKENS`. Over-counting is not safe either: the blocking
 * check would refuse to send.
 */
const NATIVE_MEDIA_TOKENS = 1_600
const NATIVE_MEDIA_CHARS = NATIVE_MEDIA_TOKENS * 4

/**
 * Chars per token for base64 that reaches the tokenizer as TEXT (the post-compact read restore);
 * measured on a live turn.
 */
export const BASE64_CHARS_PER_TOKEN = 1.5

function estimateMediaChars(payloadLength: number): number {
  return Math.min(payloadLength, NATIVE_MEDIA_CHARS)
}

function estimateMediaPartChars(block: any): number | undefined {
  if (!block || typeof block !== 'object') return undefined
  if (block.type === PART_IMAGE && typeof block.image === 'string') {
    return estimateMediaChars(block.image.length)
  }
  if (block.type === PART_DOCUMENT && typeof block.data === 'string') {
    return estimateMediaChars(block.data.length)
  }
  return undefined
}

/**
 * Estimates the number of characters in a message.
 */
export function estimateMessageChars(msg: Message): number {
  if (isUserMessage(msg)) {
    const content = (msg as any).message?.content
    if (typeof content === 'string') {
      return content.length
    }
    if (Array.isArray(content)) {
      return content.reduce((acc: number, block: any) => {
        if (typeof block === 'string') return acc + block.length
        if (typeof block === 'object' && block !== null) {
          if (block.type === PART_TEXT && typeof block.text === 'string') {
            return acc + block.text.length
          }
          const inlineMedia = estimateMediaPartChars(block)
          if (inlineMedia !== undefined) return acc + inlineMedia
          if (block.type === PART_TOOL_RESULT_CANONICAL) {
            // The canonical tool-result block carries its payload in `result`
            // (see BridgeModelCanonicalToolResultContentPart in nexus_llm.ts),
            // NOT `content`. Reading the wrong field counted every tool result
            // as 0 chars, so `tokenCountWithEstimation` massively under-counted
            // tool-heavy turns and the token-pressure gate fired far too late.
            // `?? content` keeps any legacy `content`-shaped block working.
            const payload = block.result ?? block.content
            if (typeof payload === 'string') return acc + payload.length
            if (Array.isArray(payload)) {
              return acc + payload.reduce((cAcc: number, cBlock: any) => {
                if (cBlock?.type === PART_TEXT && typeof cBlock.text === 'string') {
                  return cAcc + cBlock.text.length
                }
                const media = estimateMediaPartChars(cBlock)
                if (media !== undefined) return cAcc + media
                return cAcc
              }, 0)
            }
            // Structured object result — approximate via JSON length (matches
            // the old countHistoryChars treatment of non-text blocks).
            if (payload && typeof payload === 'object') {
              try {
                return acc + JSON.stringify(payload).length
              } catch {
                return acc
              }
            }
          }
        }
        return acc
      }, 0)
    }
  }

  if (isAssistantMessage(msg)) {
    const content = (msg as any).message?.content
    if (Array.isArray(content)) {
      return content.reduce((acc: number, block: any) => {
        if (typeof block === 'object' && block !== null) {
          if (block.type === PART_TEXT && typeof block.text === 'string') {
            return acc + block.text.length
          }
          if (block.type === PART_TOOL_CALL && typeof block.args === 'object') {
            return acc + JSON.stringify(block.args).length
          }
        }
        return acc
      }, 0)
    }
  }

  if (isSystemMessage(msg)) {
    const text = (msg as any).message
    if (typeof text === 'string') return text.length
  }

  return 0
}

function asTokenCount(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0
}

/**
 * Full context-window size from one response's usage: input + cache_creation + cache_read + output.
 * Additive because the native bridge normalises `input_tokens` to EXCLUDE the cache fields.
 */
export function tokensFromUsage(usage: Record<string, unknown>): number {
  return (
    asTokenCount(usage.input_tokens) +
    asTokenCount(usage.cache_creation_input_tokens) +
    asTokenCount(usage.cache_read_input_tokens) +
    asTokenCount(usage.output_tokens)
  )
}

/**
 * Accurately estimates token count by walking backwards to find the last
 * known usage block from the model, and estimating the remainder.
 */
export function estimateTranscriptTokens(messages: Message[]): number {
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i]
    if (isAssistantMessage(msg)) {
      const usage = (msg.message as any)?.usage
      if (typeof usage?.input_tokens === 'number') {
        let extraChars = 0
        for (let j = i + 1; j < messages.length; j++) {
          extraChars += estimateMessageChars(messages[j])
        }
        // Full context size (input + cache + output) for the anchor response,
        // then ~4 chars per token for the not-yet-billed trailing messages.
        return tokensFromUsage(usage) + Math.ceil(extraChars / 4)
      }
    }
  }

  // No usage data — pure character estimation
  let totalChars = 0
  for (const msg of messages) {
    totalChars += estimateMessageChars(msg)
  }
  return Math.ceil(totalChars / 4)
}

/**
 * Calculates current token warning state relative to context window limits.
 */
export function tokenWarningLevel(
  totalTokens: number,
  runtimeConfig: { modelOptions?: { contextWindowSize?: number } }
): 'none' | 'warning' | 'danger' {
  const contextWindow = runtimeConfig.modelOptions?.contextWindowSize ?? 200_000
  const ratio = totalTokens / contextWindow
  if (ratio > 0.9) return 'danger'
  if (ratio > 0.8) return 'warning'
  return 'none'
}
