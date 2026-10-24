/**
 * A CLI session's title follows its terminal's title (F-34): the CLI's
 * OSC 0/2 title, its leading status glyph removed, its executable's own name
 * or path ignored, written once the text has held still for a moment and
 * only when it changed. A manual rename still wins at every read.
 */

/** How long a title must hold before it is written, so passing titles are not. */
export const CLI_TITLE_SETTLE_MS = 1_500
/** Longer titles are cut to this many characters. */
export const CLI_TITLE_MAX_CHARS = 200

// Spinner frames, status marks and private-use icons ahead of the text.
const LEADING_GLYPHS = /^[\s\p{So}\p{Co}\p{Cf}️]+/u
const EXECUTABLE_SUFFIX = /\.(exe|cmd|bat|ps1)$/i

/** The session title a terminal title gives, or null when it gives none. */
export function cliSessionTitle(raw: string, cli: string): string | null {
  const text = raw.replace(LEADING_GLYPHS, '').trim()
  if (!text) return null
  const base = text.split(/[\\/]/).pop()?.replace(EXECUTABLE_SUFFIX, '') ?? text
  if (base.toLowerCase() === cli.toLowerCase()) return null
  return text.length > CLI_TITLE_MAX_CHARS ? text.slice(0, CLI_TITLE_MAX_CHARS) : text
}

export type CliTitleTimers = {
  setTimeout(callback: () => void, ms: number): unknown
  clearTimeout(handle: unknown): void
}

const DEFAULT_TIMERS: CliTitleTimers = {
  setTimeout: (callback, ms) => globalThis.setTimeout(callback, ms),
  clearTimeout: handle => globalThis.clearTimeout(handle as ReturnType<typeof setTimeout>),
}

/** Debounces each session's terminal titles into title writes; one pending write per session. */
export class CliTitleFollower {
  private readonly pending = new Map<string, unknown>()
  private readonly written = new Map<string, string>()

  constructor(
    private readonly write: (sessionId: string, title: string) => Promise<void>,
    private readonly settleMs = CLI_TITLE_SETTLE_MS,
    private readonly timers: CliTitleTimers = DEFAULT_TIMERS,
  ) {}

  /** A new terminal title for `sessionId`'s CLI. */
  observe(sessionId: string, cli: string, raw: string): void {
    const title = cliSessionTitle(raw, cli)
    if (title === null) return
    this.cancel(sessionId)
    if (this.written.get(sessionId) === title) return
    const handle = this.timers.setTimeout(() => {
      this.pending.delete(sessionId)
      this.written.set(sessionId, title)
      void this.write(sessionId, title).catch(() => {
        if (this.written.get(sessionId) === title) this.written.delete(sessionId)
      })
    }, this.settleMs)
    this.pending.set(sessionId, handle)
  }

  /** Drops `sessionId`'s pending write and what was last written for it. */
  forget(sessionId: string): void {
    this.cancel(sessionId)
    this.written.delete(sessionId)
  }

  dispose(): void {
    for (const handle of this.pending.values()) this.timers.clearTimeout(handle)
    this.pending.clear()
    this.written.clear()
  }

  private cancel(sessionId: string): void {
    const handle = this.pending.get(sessionId)
    if (handle === undefined) return
    this.timers.clearTimeout(handle)
    this.pending.delete(sessionId)
  }
}
