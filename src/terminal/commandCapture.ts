/**
 * Contract: what a command typed at a shell prompt has printed so far (F-31),
 * read from a terminal screen. `startLine` is the buffer line the prompt sat
 * on when the command was typed and `prompt` that line's text up to the
 * cursor. The output is every line below the typed command (its wrapped
 * tail skipped), wrapped rows joined, trailing blank lines dropped, at most
 * `maxLines` of the last lines kept. The command is over once the cursor
 * rests on a later line whose text up to the cursor is `prompt` again; that
 * prompt line is not output.
 */

/** The part of an xterm buffer the capture reads. */
export type CaptureBuffer = {
  readonly baseY: number
  readonly cursorY: number
  readonly cursorX: number
  readonly length: number
  getLine(y: number):
    | { readonly isWrapped: boolean; translateToString(trimRight?: boolean, start?: number, end?: number): string }
    | undefined
}

export type CommandCapture = {
  output: string
  truncated: boolean
  /** The shell printed `prompt` again: the command finished. */
  promptBack: boolean
}

/** The text of the cursor's line up to the cursor: what a prompt check compares. */
export function promptAtCursor(buffer: CaptureBuffer): string {
  return buffer.getLine(buffer.baseY + buffer.cursorY)?.translateToString(false, 0, buffer.cursorX) ?? ''
}

export function captureCommandOutput(
  buffer: CaptureBuffer,
  startLine: number,
  prompt: string,
  maxLines: number,
): CommandCapture {
  const cursorLine = buffer.baseY + buffer.cursorY
  let first = startLine + 1
  while (first <= cursorLine && buffer.getLine(first)?.isWrapped) first += 1
  const promptBack = prompt.trim().length > 0 && cursorLine >= first && promptAtCursor(buffer) === prompt
  const last = Math.min(promptBack ? cursorLine - 1 : cursorLine, buffer.length - 1)

  const lines: string[] = []
  for (let y = first; y <= last; y += 1) {
    const line = buffer.getLine(y)
    if (!line) continue
    // A row continued on the next one keeps its trailing spaces: they are text, not padding.
    const continued = buffer.getLine(y + 1)?.isWrapped === true
    const text = continued ? line.translateToString(false) : line.translateToString(true).trimEnd()
    if (line.isWrapped && lines.length > 0) lines[lines.length - 1] += text
    else lines.push(text)
  }
  while (lines.length > 0 && lines[lines.length - 1]!.trim() === '') lines.pop()
  const truncated = lines.length > maxLines
  const kept = truncated ? lines.slice(lines.length - maxLines) : lines
  return { output: kept.join('\n'), truncated, promptBack }
}
