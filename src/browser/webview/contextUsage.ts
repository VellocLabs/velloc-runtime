/**
 * A session's context-window figures: the tokens in its context, measured against the window it
 * auto-compacts at (the model's own window while auto or off). The composer's context ring and the
 * phone shell's usage sheet both read them here, so the two always agree (F-24).
 */
import type { Message, StreamRecord } from '../../runtime/RuntimeTypes'
import {
  estimateTranscriptTokens,
  tokensFromUsage,
  tokenWarningLevel,
} from '../../engine/tokenCounts'
import { contextUsageShares, contextWindowOf } from '../../engine/contextWindow'
import { thresholdForChoice, type WindowChoice } from '../../context/compaction/windowSlider'
import type { AutoCompactView } from '../worker/workerProtocol'

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object'
    ? (value as Record<string, unknown>)
    : undefined
}

/** The in-flight turn's usage, merged from its `message_start` and `message_delta` events. */
export function liveTurnUsage(
  liveEvents: StreamRecord[],
): Record<string, unknown> | undefined {
  let merged: Record<string, unknown> | undefined
  for (const event of liveEvents) {
    const record = asRecord(event)
    if (!record) continue
    const inner =
      record.type === 'stream_event'
        ? asRecord(record.event)
        : record
    if (!inner) continue
    const type = inner.type
    if (type === 'message_start') {
      const msg = asRecord(inner.message)
      const usage = asRecord(msg?.usage)
      if (usage) merged = { ...(merged ?? {}), ...usage }
    } else if (type === 'message_delta') {
      const usage = asRecord(inner.usage)
      if (usage) merged = { ...(merged ?? {}), ...usage }
    }
  }
  return merged
}

/**
 * Tokens in the session's context: the live turn's input + cache + output while one streams,
 * else the transcript's estimate. O(messages).
 */
export function contextTokensUsed(messages: Message[], liveEvents: StreamRecord[]): number {
  const live = liveTurnUsage(liveEvents)
  if (live && typeof live.input_tokens === 'number') return tokensFromUsage(live)
  return estimateTranscriptTokens(messages)
}

/** The window usage is measured against: the auto-compact window `choice`, or the model's own. */
export function contextMeasureWindow(
  modelId: string | undefined,
  providerId: string | undefined,
  autoCompact: AutoCompactView | undefined,
  choice: WindowChoice,
): number {
  return autoCompact?.enabled !== false && choice !== 'auto'
    ? thresholdForChoice(choice, modelId, providerId)
    : contextWindowOf(modelId, providerId)
}

export type ContextUsageFigures = {
  usedTokens: number
  windowTokens: number
  /** 0–100, unrounded. */
  percent: number
  warning: 'none' | 'warning' | 'danger'
}

/** The figures at the saved auto-compact window. */
export function contextUsageFigures(input: {
  messages: Message[]
  liveEvents: StreamRecord[]
  modelId: string | undefined
  providerId: string | undefined
  autoCompact: AutoCompactView | undefined
}): ContextUsageFigures {
  const usedTokens = contextTokensUsed(input.messages, input.liveEvents)
  const windowTokens = contextMeasureWindow(
    input.modelId,
    input.providerId,
    input.autoCompact,
    input.autoCompact?.windowTokens ?? 'auto',
  )
  return {
    usedTokens,
    windowTokens,
    percent: contextUsageShares(usedTokens, windowTokens).usedPercentage,
    warning: tokenWarningLevel(usedTokens, { modelOptions: { contextWindowSize: windowTokens } }),
  }
}
