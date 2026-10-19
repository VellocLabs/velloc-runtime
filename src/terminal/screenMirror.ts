/**
 * Contract: the runtime's copy of one terminal's screen (F-31) — a headless
 * emulator fed every piece of output the listeners get, in the same order,
 * and resized with the console. `serialize` answers with text that, written
 * to an emulator just reset to the same size, redraws this screen: the
 * history above it (at most `historyLines` lines), the screen, the cursor
 * and the modes. It describes the output fed before the call, never the
 * output fed after it.
 *
 * A console that sends only the cells that changed leaves no point in its
 * raw output from which a replay rebuilds the screen, which is why a
 * snapshot is this serialized screen and not the output's tail.
 */
import { Terminal } from '@xterm/headless'
import { SerializeAddon } from '@xterm/addon-serialize'
import { Unicode11Addon } from '@xterm/addon-unicode11'

export class ScreenMirror {
  private readonly term: Terminal
  private readonly serializer = new SerializeAddon()
  private disposed = false
  private readonly waiting = new Set<(text: string) => void>()

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
  serialize(): Promise<string> {
    if (this.disposed) return Promise.resolve('')
    return new Promise(resolve => {
      this.waiting.add(resolve)
      // Parsing is queued: the callback runs once the text before it is in,
      // and before anything written after this call is.
      this.term.write('', () => {
        if (!this.waiting.delete(resolve)) return
        resolve(this.serializer.serialize())
      })
    })
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    for (const resolve of this.waiting) resolve('')
    this.waiting.clear()
    this.term.dispose()
  }
}
