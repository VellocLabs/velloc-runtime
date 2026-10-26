/**
 * A CLI session's title follows its terminal's title (F-34): the CLI's
 * OSC 0/2 title, its leading status glyph removed, its executable's own name
 * or path ignored, written once the text has held still for a moment and
 * only when it changed. A manual rename still wins at every read. The glyph
 * itself is read for the session's status: one that keeps changing is a
 * spinner, so the CLI is working.
 */

/** How long a title must hold before it is written, so passing titles are not. */
export const CLI_TITLE_SETTLE_MS = 1_500
/** Longer titles are cut to this many characters. */
export const CLI_TITLE_MAX_CHARS = 200

// Spinner frames, status marks and private-use icons ahead of the text.
const LEADING_GLYPHS = /^[\s\p{So}\p{Co}\p{Cf}\uFE0F]+/u
const EXECUTABLE_SUFFIX = /\.(exe|cmd|bat|ps1)$/i

/** How long after the glyph last changed the CLI still counts as working. */
export const CLI_BUSY_HOLD_MS = 2_000
/** How often a working CLI's session records activity. */
export const CLI_ACTIVITY_INTERVAL_MS = 60_000

/** The status glyph ahead of a terminal title's text; '' when there is none. */
export function cliTitleGlyph(raw: string): string {
  return (raw.match(LEADING_GLYPHS)?.[0] ?? '').trim()
}

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

  /** True once a terminal title of `sessionId`'s CLI is written or about to be. */
  hasTitle(sessionId: string): boolean {
    return this.written.has(sessionId) || this.pending.has(sessionId)
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

/**
 * Whether each session's CLI is working, from its title glyphs: a glyph that
 * differs from the previous glyph starts or extends `holdMs` of busy; the
 * first glyph seen, one after a glyph-less title, the same glyph again, or
 * none, does not. `onChange`
 * hears each flip.
 */
export class CliBusyTracker {
  private readonly lastGlyph = new Map<string, string>()
  private readonly idleTimers = new Map<string, unknown>()

  constructor(
    private readonly onChange: (sessionId: string, busy: boolean) => void,
    private readonly holdMs = CLI_BUSY_HOLD_MS,
    private readonly timers: CliTitleTimers = DEFAULT_TIMERS,
  ) {}

  isBusy(sessionId: string): boolean {
    return this.idleTimers.has(sessionId)
  }

  /** A new terminal title for `sessionId`'s CLI. */
  observe(sessionId: string, raw: string): void {
    const glyph = cliTitleGlyph(raw)
    const previous = this.lastGlyph.get(sessionId)
    this.lastGlyph.set(sessionId, glyph)
    if (!previous || !glyph || glyph === previous) return
    const wasBusy = this.isBusy(sessionId)
    const pending = this.idleTimers.get(sessionId)
    if (pending !== undefined) this.timers.clearTimeout(pending)
    this.idleTimers.set(
      sessionId,
      this.timers.setTimeout(() => {
        this.idleTimers.delete(sessionId)
        this.onChange(sessionId, false)
      }, this.holdMs),
    )
    if (!wasBusy) this.onChange(sessionId, true)
  }

  /** The CLI stopped (exited, closed): idle now, and its next start begins afresh. */
  end(sessionId: string): void {
    this.lastGlyph.delete(sessionId)
    const pending = this.idleTimers.get(sessionId)
    if (pending === undefined) return
    this.timers.clearTimeout(pending)
    this.idleTimers.delete(sessionId)
    this.onChange(sessionId, false)
  }

  dispose(): void {
    for (const handle of this.idleTimers.values()) this.timers.clearTimeout(handle)
    this.idleTimers.clear()
    this.lastGlyph.clear()
  }
}

/**
 * A working CLI is its session's activity: `touch` hears a session when its
 * CLI starts working, every `intervalMs` while it works, and when it stops.
 */
export class CliActivityClock {
  private readonly ticking = new Map<string, unknown>()

  constructor(
    private readonly touch: (sessionId: string) => void,
    private readonly intervalMs = CLI_ACTIVITY_INTERVAL_MS,
    private readonly timers: CliTitleTimers = DEFAULT_TIMERS,
  ) {}

  /** `sessionId`'s CLI started (`true`) or stopped (`false`) working. */
  busy(sessionId: string, busy: boolean): void {
    const ticking = this.ticking.has(sessionId)
    if (busy === ticking) return
    if (busy) {
      this.schedule(sessionId)
    } else {
      this.timers.clearTimeout(this.ticking.get(sessionId))
      this.ticking.delete(sessionId)
    }
    this.touch(sessionId)
  }

  dispose(): void {
    for (const handle of this.ticking.values()) this.timers.clearTimeout(handle)
    this.ticking.clear()
  }

  private schedule(sessionId: string): void {
    this.ticking.set(
      sessionId,
      this.timers.setTimeout(() => {
        this.schedule(sessionId)
        this.touch(sessionId)
      }, this.intervalMs),
    )
  }
}
