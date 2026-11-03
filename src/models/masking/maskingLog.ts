/**
 * Contract: The replacement log of model egress masking (F-39): one line per
 * fact, `key=value` fields joined by `|`, appended to the file the user named.
 * Rule numbers are 1-based, as `/masking` shows them.
 * `MaskingLogWriter.append` serializes writes, rotates the file past
 * `MAX_LOG_BYTES` (keeping `LOG_GENERATIONS` older files as `.1` …), and
 * reports a failure (the thrown value) to `onError` without throwing.
 */

/** Where the log goes: the host filesystem, through the runtime. */
export type MaskingLogSink = {
  append(path: string, text: string): Promise<void>
  /** Size in bytes; undefined when the file does not exist. */
  size(path: string): Promise<number | undefined>
  /** Absent: no rotation. */
  rename?(from: string, to: string): Promise<void>
  remove?(path: string): Promise<void>
}

export const MAX_LOG_BYTES = 8 * 1024 * 1024
export const LOG_GENERATIONS = 4

export type LogFields = Record<string, string | number | undefined>

/** One log line, newline included; empty fields are left out. */
export function formatLogLine(fields: LogFields): string {
  const parts: string[] = []
  for (const [key, value] of Object.entries(fields)) {
    if (value === undefined || value === '') continue
    parts.push(`${key}=${String(value).replace(/[\r\n|]/g, ' ')}`)
  }
  return `${parts.join('|')}\n`
}

export class MaskingLogWriter {
  private chain: Promise<void> = Promise.resolve()

  constructor(
    private readonly sink: MaskingLogSink,
    private readonly onError: (error: unknown) => void,
  ) {}

  append(path: string, text: string): Promise<void> {
    if (!text) return this.chain
    this.chain = this.chain.then(() => this.write(path, text))
    return this.chain
  }

  private async write(path: string, text: string): Promise<void> {
    try {
      await this.rotateIfFull(path)
      await this.sink.append(path, text)
    } catch (error) {
      this.onError(error)
    }
  }

  private async rotateIfFull(path: string): Promise<void> {
    const { rename, remove } = this.sink
    if (!rename) return
    const size = await this.sink.size(path)
    if (size === undefined || size < MAX_LOG_BYTES) return
    const oldest = `${path}.${LOG_GENERATIONS}`
    if ((await this.sink.size(oldest)) !== undefined) await remove?.call(this.sink, oldest)
    for (let n = LOG_GENERATIONS - 1; n >= 1; n -= 1) {
      const from = `${path}.${n}`
      if ((await this.sink.size(from)) !== undefined) await rename.call(this.sink, from, `${path}.${n + 1}`)
    }
    await rename.call(this.sink, path, `${path}.1`)
  }
}
