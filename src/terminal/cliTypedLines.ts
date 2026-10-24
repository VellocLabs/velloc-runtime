/**
 * The lines a person submitted to a CLI, rebuilt from the keystrokes sent to
 * its terminal (F-34), so a conversation log can be matched to the session
 * whose prompt it records. Best effort: edits made with the cursor keys are
 * not followed, and such a line simply matches nothing.
 */

export type SubmittedLine = { text: string; at: number }

/** Submitted lines kept per session, newest last. */
const KEPT_LINES = 16

/** Characters kept of a line being typed. */
const LINE_LIMIT = 4_096

/** Longest escape sequence followed before it is dropped. */
const ESCAPE_LIMIT = 32

const ESC = '\u001b'
const BRACKETED_PASTE_START = '[200~'
const BRACKETED_PASTE_END = '[201~'

export class CliTypedLines {
  private line = ''
  private pasting = false
  /** The escape sequence being read (without its ESC), or null outside one. */
  private escape: string | null = null
  private readonly submitted: SubmittedLine[] = []

  /** The lines submitted so far, oldest first. */
  get lines(): readonly SubmittedLine[] {
    return this.submitted
  }

  /** Keystrokes sent to the terminal at `at`. An Enter outside a paste submits the line. */
  feed(data: string, at: number): void {
    for (const ch of data) {
      if (this.escape !== null) {
        this.readEscape(ch)
      } else if (ch === ESC) {
        this.escape = ''
      } else if (ch === '\r' || ch === '\n') {
        if (this.pasting) this.append(' ')
        else this.submit(at)
      } else if (ch === '\u007f' || ch === '\b') {
        this.line = Array.from(this.line).slice(0, -1).join('')
      } else if (ch === '\u0015' || ch === '\u0003') {
        // Ctrl+U and Ctrl+C drop the line.
        this.line = ''
      } else if (ch >= ' ') {
        this.append(ch)
      }
    }
  }

  private readEscape(ch: string): void {
    const seq = this.escape + ch
    if (seq === '[' || seq === 'O') {
      this.escape = seq
      return
    }
    if (seq.startsWith('[')) {
      const code = ch.charCodeAt(0)
      if (code >= 0x40 && code <= 0x7e) {
        if (seq === BRACKETED_PASTE_START) this.pasting = true
        else if (seq === BRACKETED_PASTE_END) this.pasting = false
        this.escape = null
      } else {
        this.escape = seq.length > ESCAPE_LIMIT ? null : seq
      }
      return
    }
    // A two-character sequence (Alt+key) or SS3 (`ESC O x`) ends here.
    this.escape = null
  }

  private append(ch: string): void {
    if (this.line.length < LINE_LIMIT) this.line += ch
  }

  private submit(at: number): void {
    const text = this.line.trim()
    this.line = ''
    if (!text) return
    this.submitted.push({ text, at })
    if (this.submitted.length > KEPT_LINES) this.submitted.shift()
  }
}

/** Whether a submitted line is the prompt a log's title was made from: whitespace aside, and a cut title (`…`) matches the line's start. */
export function lineMatchesPromptTitle(line: string, title: string): boolean {
  const flat = (text: string) => text.replace(/\s+/g, '')
  const cut = title.endsWith('…')
  const want = flat(cut ? title.slice(0, -1) : title)
  if (!want) return false
  const typed = flat(line)
  return cut ? typed.startsWith(want) : typed === want
}
