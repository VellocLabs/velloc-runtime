/**
 * Contract: The replacement log of model egress masking (F-39): one line per
 * replacement, `date|dir|where|original|replaced`, appended to the file the
 * user named. `date` is ISO 8601 UTC; `dir` is `out` (toward the model) or
 * `in`; `original` and `replaced` are the text before and after the
 * replacement, each with its context (see `replacementTrace`). Line breaks in
 * the text are written as one space, `\` as `\\` and `|` as `\|`; the data itself is not
 * changed. `MaskingLogWriter.append` serializes writes, keeps the file to at
 * most `MAX_LOG_LINES` lines: an append that would pass it rewrites the file
 * with the newest `TRIM_LOG_LINES` lines (older lines are dropped, never
 * rotated to another file), and reports a failure (the thrown value) to `onError`
 * without throwing.
 */
import type { ReplacementEntry } from './replacementTrace'

/** Where the log goes: the host filesystem, through the runtime. */
export type MaskingLogSink = {
  append(path: string, text: string): Promise<void>
  /** Size in bytes; undefined when the file does not exist. */
  size(path: string): Promise<number | undefined>
  /** The whole file as UTF-8; undefined when it does not exist. */
  read(path: string): Promise<string | undefined>
  /** Replaces the whole file. */
  write(path: string, text: string): Promise<void>
}

export const MAX_LOG_LINES = 5000
/** Lines kept by a rewrite, so the next rewrite is a thousand lines away. */
export const TRIM_LOG_LINES = 4000

const ENCODER = new TextEncoder()

function logText(text: string): string {
  return text.replace(/\r\n|[\r\n\u2028\u2029]/g, ' ').replace(/[\\|]/g, '\\$&')
}

/** One log line, newline included. */
export function formatLogLine(entry: ReplacementEntry): string {
  const date = new Date(entry.at).toISOString()
  return `${date}|${entry.dir}|${logText(entry.where)}|${logText(entry.original)}|${logText(entry.replaced)}\n`
}

function linesOf(text: string): string[] {
  const lines = text.split('\n')
  if (lines.at(-1) === '') lines.pop()
  return lines
}

type Known = { path: string; bytes: number; lines: number }

export class MaskingLogWriter {
  private chain: Promise<void> = Promise.resolve()
  /** What the file held after our last write, to notice an outside change. */
  private known: Known | undefined

  constructor(
    private readonly sink: MaskingLogSink,
    private readonly onError: (error: unknown) => void,
  ) {}

  /** Appends `lines` (each ending in a newline). */
  append(path: string, lines: readonly string[]): Promise<void> {
    if (lines.length === 0) return this.chain
    this.chain = this.chain.then(() => this.write(path, lines))
    return this.chain
  }

  private async write(path: string, lines: readonly string[]): Promise<void> {
    try {
      const have = await this.linesInFile(path)
      if (have + lines.length <= MAX_LOG_LINES) {
        const text = lines.join('')
        await this.sink.append(path, text)
        this.known = { path, bytes: this.known!.bytes + ENCODER.encode(text).length, lines: have + lines.length }
        return
      }
      const existing = linesOf((await this.sink.read(path)) ?? '')
      const kept = [...existing, ...lines.map(line => line.replace(/\n$/, ''))].slice(-TRIM_LOG_LINES)
      const text = `${kept.join('\n')}\n`
      await this.sink.write(path, text)
      this.known = { path, bytes: ENCODER.encode(text).length, lines: kept.length }
    } catch (error) {
      this.known = undefined
      this.onError(error)
    }
  }

  /** The line count of the file now; counted again when the file is not as we left it. */
  private async linesInFile(path: string): Promise<number> {
    const bytes = await this.sink.size(path)
    if (bytes === undefined) {
      this.known = { path, bytes: 0, lines: 0 }
      return 0
    }
    if (this.known && this.known.path === path && this.known.bytes === bytes) return this.known.lines
    const lines = linesOf((await this.sink.read(path)) ?? '').length
    this.known = { path, bytes, lines }
    return lines
  }
}
