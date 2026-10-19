import { Terminal } from '@xterm/headless'

import type { TerminalSnapshot } from '../../terminal/protocol'

/**
 * What a view shows for `snapshot`: its text written to a fresh emulator of
 * the snapshot's size, read back as lines (history first), trailing blank
 * lines and spaces trimmed.
 */
export async function renderSnapshot(snapshot: TerminalSnapshot | undefined): Promise<string[]> {
  if (!snapshot) throw new Error('no snapshot')
  const term = new Terminal({ cols: snapshot.cols, rows: snapshot.rows, scrollback: 100_000, allowProposedApi: true })
  try {
    await new Promise<void>(resolve => term.write(snapshot.scrollback, resolve))
    const buffer = term.buffer.active
    const lines: string[] = []
    for (let i = 0; i < buffer.length; i++) lines.push(buffer.getLine(i)?.translateToString(true) ?? '')
    while (lines.length > 0 && lines[lines.length - 1] === '') lines.pop()
    return lines
  } finally {
    term.dispose()
  }
}
