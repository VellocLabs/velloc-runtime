/**
 * Contract: What the replacement log records (F-39): one entry per replacement,
 * with the text before the replacement and the text after it, each cut to the
 * matched piece plus `CONTEXT_CHARS` characters on either side (fewer at the
 * start or end of the text). `traceEntries` cuts them from a whole string.
 * `ChannelTrace` does the same for a streamed channel, where the text after a
 * replacement arrives later: it keeps the last `CONTEXT_CHARS` characters of
 * each side and finishes an entry once enough text followed it, or at
 * `finish()`. Neither changes the text it is given. At most `MAX_TRACE_ENTRIES`
 * entries are kept per sink.
 */
import type { MaskingHit } from './maskingRules'

export const CONTEXT_CHARS = 50
export const MAX_TRACE_ENTRIES = 5000

export type ReplacementEntry = {
  /** Epoch milliseconds when the replacement was made. */
  at: number
  /** `out`: toward the model. `in`: from the model. */
  dir: 'in' | 'out'
  where: string
  /** The text before the replacement, around the matched piece. */
  original: string
  /** The text after the replacement, around the replacing piece. */
  replaced: string
}

/** Entries for the hits found when turning `original` into `replaced`. */
export function traceEntries(
  dir: ReplacementEntry['dir'],
  where: string,
  original: string,
  replaced: string,
  hits: readonly MaskingHit[],
  sink: ReplacementEntry[],
): void {
  const at = Date.now()
  for (const hit of hits) {
    if (sink.length >= MAX_TRACE_ENTRIES) return
    sink.push({
      at,
      dir,
      where,
      original: original.slice(Math.max(0, hit.start - CONTEXT_CHARS), hit.end + CONTEXT_CHARS),
      replaced: replaced.slice(Math.max(0, hit.outStart - CONTEXT_CHARS), hit.outEnd + CONTEXT_CHARS),
    })
  }
}

type OpenEntry = {
  at: number
  original: string
  originalNeeds: number
  replaced: string
  replacedNeeds: number
}

/** The replacements of one streamed channel, from `dir: 'in'`. */
export class ChannelTrace {
  private beforeOriginal = ''
  private beforeReplaced = ''
  private open: OpenEntry[] = []

  constructor(
    private readonly where: string,
    private readonly sink: ReplacementEntry[],
  ) {}

  /**
   * One settled piece: the model's `consumed` text became `emitted`; `hits`
   * are relative to those two strings.
   */
  feed(consumed: string, emitted: string, hits: readonly MaskingHit[]): void {
    for (const entry of this.open) {
      const original = consumed.slice(0, entry.originalNeeds)
      const replaced = emitted.slice(0, entry.replacedNeeds)
      entry.original += original
      entry.originalNeeds -= original.length
      entry.replaced += replaced
      entry.replacedNeeds -= replaced.length
    }
    const originalText = this.beforeOriginal + consumed
    const replacedText = this.beforeReplaced + emitted
    for (const hit of hits) {
      if (this.sink.length + this.open.length >= MAX_TRACE_ENTRIES) break
      const start = this.beforeOriginal.length + hit.start
      const end = this.beforeOriginal.length + hit.end
      const outStart = this.beforeReplaced.length + hit.outStart
      const outEnd = this.beforeReplaced.length + hit.outEnd
      const original = originalText.slice(Math.max(0, start - CONTEXT_CHARS), end + CONTEXT_CHARS)
      const replaced = replacedText.slice(Math.max(0, outStart - CONTEXT_CHARS), outEnd + CONTEXT_CHARS)
      this.open.push({
        at: Date.now(),
        original,
        originalNeeds: Math.max(0, end + CONTEXT_CHARS - originalText.length),
        replaced,
        replacedNeeds: Math.max(0, outEnd + CONTEXT_CHARS - replacedText.length),
      })
    }
    this.beforeOriginal = originalText.slice(-CONTEXT_CHARS)
    this.beforeReplaced = replacedText.slice(-CONTEXT_CHARS)
    this.open = this.open.filter(entry => {
      if (entry.originalNeeds > 0 || entry.replacedNeeds > 0) return true
      this.emit(entry)
      return false
    })
  }

  /** Completes what is still waiting for text that did not come. */
  finish(): void {
    for (const entry of this.open) this.emit(entry)
    this.open = []
  }

  private emit(entry: OpenEntry): void {
    this.sink.push({ at: entry.at, dir: 'in', where: this.where, original: entry.original, replaced: entry.replaced })
  }
}
