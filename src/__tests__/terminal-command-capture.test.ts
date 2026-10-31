/**
 * `captureCommandOutput` over a real headless emulator (F-31): the typed
 * command and its wrapped tail are skipped, wrapped output rows join into
 * one line, trailing blank lines go, the returned prompt ends the command
 * and is not output, and only the last `maxLines` lines are kept.
 */
import { describe, expect, it } from 'vitest'
import { Terminal } from '@xterm/headless'
import { captureCommandOutput, promptAtCursor } from '../terminal/commandCapture'

async function screen(cols: number, rows = 10) {
  const term = new Terminal({ cols, rows, scrollback: 100, allowProposedApi: true })
  const write = (text: string) => new Promise<void>(resolve => term.write(text, resolve))
  const buffer = () => term.buffer.active
  /** Write a prompt and remember where it sits, as a run does before typing. */
  const prompt = async (text: string) => {
    await write(text)
    return { line: buffer().baseY + buffer().cursorY, prompt: promptAtCursor(buffer()) }
  }
  return { term, write, buffer, prompt }
}

describe('captureCommandOutput', () => {
  it('skips the typed command, wrapped or not, and stops at the returned prompt', async () => {
    const s = await screen(12)
    const start = await s.prompt('PS C:\\> ')
    expect(start.prompt).toBe('PS C:\\> ')
    await s.write('git status --short\r\n')
    expect(captureCommandOutput(s.buffer(), start.line, start.prompt, 100)).toEqual({
      output: '',
      truncated: false,
      promptBack: false,
    })
    await s.write(' M a.ts\r\n?? b.ts\r\n\r\nPS C:\\> ')
    expect(captureCommandOutput(s.buffer(), start.line, start.prompt, 100)).toEqual({
      output: ' M a.ts\n?? b.ts',
      truncated: false,
      promptBack: true,
    })
  })

  it('joins an output line the screen wrapped, keeping the spaces at the wrap', async () => {
    const s = await screen(10)
    const start = await s.prompt('$ ')
    await s.write('ls\r\nabcd efgh ijkl\r\n$ ')
    expect(captureCommandOutput(s.buffer(), start.line, start.prompt, 100).output).toBe('abcd efgh ijkl')
  })

  it('is still running while the cursor sits on another prompt-like line', async () => {
    const s = await screen(40)
    const start = await s.prompt('PS C:\\p> ')
    await s.write('read-host\r\nName: ')
    expect(captureCommandOutput(s.buffer(), start.line, start.prompt, 100)).toEqual({
      output: 'Name:',
      truncated: false,
      promptBack: false,
    })
  })

  it('never ends on an empty prompt', async () => {
    const s = await screen(40)
    const start = await s.prompt('')
    await s.write('cmd\r\nout\r\n')
    expect(captureCommandOutput(s.buffer(), start.line, start.prompt, 100)).toMatchObject({ output: 'out', promptBack: false })
  })

  it('keeps only the last lines and says it cut', async () => {
    const s = await screen(20, 5)
    const start = await s.prompt('> ')
    await s.write('seq\r\n1\r\n2\r\n3\r\n4\r\n5\r\n> ')
    expect(captureCommandOutput(s.buffer(), start.line, start.prompt, 3)).toEqual({
      output: '3\n4\n5',
      truncated: true,
      promptBack: true,
    })
  })
})
