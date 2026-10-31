/**
 * Contract: the runtime's copy of one terminal's screen (F-31) — a headless
 * emulator fed every piece of output the listeners get, in the same order,
 * and resized with the console. `serialize` answers with text that, written
 * to an emulator just reset to the same size, redraws this screen: the
 * history above it (at most `historyLines` lines), the screen, the cursor
 * and the modes. It describes the output fed before the call, never the
 * output fed after it; so do `mark` and `capture`, which read a command's
 * output below a marked line for `terminal.run`.
 *
 * A console that sends only the cells that changed leaves no point in its
 * raw output from which a replay rebuilds the screen, which is why a
 * snapshot is this serialized screen and not the output's tail.
 */
import { Terminal, type IMarker } from '@xterm/headless'
import { SerializeAddon } from '@xterm/addon-serialize'
import { Unicode11Addon } from '@xterm/addon-unicode11'

import { captureCommandOutput, promptAtCursor, type CommandCapture } from './commandCapture'

export class ScreenMirror {
  private readonly term: Terminal
  private readonly serializer = new SerializeAddon()
  private disposed = false
  /** Pending reads; each answers its empty value when the mirror is disposed first. */
  private readonly waiting = new Set<() => void>()

  constructor(cols: number, rows: number, historyLines: number) {
    this.term = new Terminal({ cols, rows, scrollback: historyLines, allowProposedApi: true })
    this.term.loadAddon(new Unicode11Addon())
    this.term.loadAddon(this.serializer)
    this.term.unicode.activeVersion = '11'
  }

  write(text: string): void {
    if (this.disposed || text.length === 0) return
    this.term.write(text)
  }

  resize(cols: number, rows: number): void {
    if (this.disposed || (cols === this.term.cols && rows === this.term.rows)) return
    this.term.resize(cols, rows)
  }

  /** The screen once everything written so far is parsed; '' once disposed, also while waiting. */
  async serialize(): Promise<string> {
    return (await this.afterParse(() => this.serializer.serialize())) ?? ''
  }

  /**
   * The cursor's line once everything written so far is parsed: a marker that
   * follows it as history scrolls, and its text up to the cursor. Null once disposed.
   */
  mark(): Promise<{ marker: IMarker; prompt: string } | null> {
    return this.afterParse(() => {
      const marker = this.term.registerMarker(0)
      return marker ? { marker, prompt: promptAtCursor(this.term.buffer.active) } : null
    })
  }

  /** The cursor's line up to the cursor once everything written so far is parsed; null once disposed. */
  textBeforeCursor(): Promise<string | null> {
    return this.afterParse(() => promptAtCursor(this.term.buffer.active))
  }

  /** What was printed below `marker`'s line (`captureCommandOutput`); null once disposed or once that line left the history. */
  async capture(marker: IMarker, prompt: string, maxLines: number): Promise<CommandCapture | null> {
    return this.afterParse(() =>
      marker.isDisposed || marker.line < 0
        ? null
        : captureCommandOutput(this.term.buffer.active, marker.line, prompt, maxLines),
    )
  }

  /** `read` once the text written before this call is parsed; null once disposed, also while waiting. */
  private afterParse<T>(read: () => T): Promise<T | null> {
    if (this.disposed) return Promise.resolve(null)
    return new Promise(resolve => {
      const cancel = (): void => resolve(null)
      this.waiting.add(cancel)
      // Parsing is queued: the callback runs once the text before it is in,
      // and before anything written after this call is.
      this.term.write('', () => {
        if (!this.waiting.delete(cancel)) return
        resolve(read())
      })
    })
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    for (const cancel of this.waiting) cancel()
    this.waiting.clear()
    this.term.dispose()
  }
}
