/**
 * Contract: finds the window-title sequences a shell writes — OSC 0 and OSC 2,
 * `ESC ] 0 ; title BEL` or terminated by `ESC \` — in output text fed in
 * arbitrary pieces; a sequence split across pieces is still found (F-31). The
 * text is not altered: the emulator reads the same sequence itself. `feed`
 * returns the titles found, in order; the caller keeps the last.
 */
const ESC = '\x1b'
const BEL = '\x07'
const OSC_START = `${ESC}]`
const STRING_TERMINATOR = `${ESC}\\`
/** Longer than any title; an unterminated sequence past this is dropped. */
const MAX_PENDING_UNITS = 4096

export class TitleSequenceScanner {
  /** The unfinished tail of the last piece: an open sequence, or a lone ESC. */
  private pending = ''

  feed(piece: string): string[] {
    const titles: string[] = []
    const text = this.pending + piece
    this.pending = ''
    let from = 0
    for (;;) {
      const start = text.indexOf(OSC_START, from)
      if (start < 0) break
      const bodyStart = start + OSC_START.length
      const bel = text.indexOf(BEL, bodyStart)
      const st = text.indexOf(STRING_TERMINATOR, bodyStart)
      let end: number
      let terminatorLength: number
      if (bel >= 0 && (st < 0 || bel < st)) {
        end = bel
        terminatorLength = BEL.length
      } else if (st >= 0) {
        end = st
        terminatorLength = STRING_TERMINATOR.length
      } else {
        const tail = text.slice(start)
        if (tail.length <= MAX_PENDING_UNITS) this.pending = tail
        return titles
      }
      const body = text.slice(bodyStart, end)
      const separator = body.indexOf(';')
      if (separator >= 0) {
        const code = body.slice(0, separator)
        if (code === '0' || code === '2') titles.push(body.slice(separator + 1))
      }
      from = end + terminatorLength
    }
    // A piece ending in ESC may be the first half of an `ESC ]` the next piece completes.
    if (text.endsWith(ESC)) this.pending = ESC
    return titles
  }
}
