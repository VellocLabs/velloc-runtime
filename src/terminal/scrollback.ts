/**
 * Contract: the decoded output a terminal keeps (F-31), oldest first, capped
 * at `limit` UTF-16 code units (`string.length`, the unit every reader of the
 * text measures in). Trimming drops whole pieces from the front, then cuts the
 * oldest remaining piece at a character boundary — never between the two
 * halves of a surrogate pair — so the kept text always starts on a character.
 */
export class ScrollbackRing {
  private pieces: string[] = []
  private units = 0

  constructor(private readonly limit: number) {}

  /** Code units kept right now. */
  get size(): number {
    return this.units
  }

  append(text: string): void {
    if (text.length === 0) return
    if (text.length >= this.limit) {
      const kept = fromCharBoundary(text, text.length - this.limit)
      this.pieces = [kept]
      this.units = kept.length
      return
    }
    this.pieces.push(text)
    this.units += text.length
    while (this.units > this.limit) {
      const excess = this.units - this.limit
      const oldest = this.pieces[0]!
      if (oldest.length <= excess) {
        this.pieces.shift()
        this.units -= oldest.length
        continue
      }
      const kept = fromCharBoundary(oldest, excess)
      this.units -= oldest.length - kept.length
      this.pieces[0] = kept
    }
  }

  /** The kept text, joined (and kept joined, so a second read is free). */
  text(): string {
    if (this.pieces.length > 1) this.pieces = [this.pieces.join('')]
    return this.pieces[0] ?? ''
  }

  clear(): void {
    this.pieces = []
    this.units = 0
  }
}

const isHighSurrogate = (unit: number): boolean => unit >= 0xd800 && unit <= 0xdbff
const isLowSurrogate = (unit: number): boolean => unit >= 0xdc00 && unit <= 0xdfff

/** `text` from `from` on, moved one unit forward when `from` would split a surrogate pair. */
function fromCharBoundary(text: string, from: number): string {
  let start = from
  if (
    start > 0 &&
    start < text.length &&
    isLowSurrogate(text.charCodeAt(start)) &&
    isHighSurrogate(text.charCodeAt(start - 1))
  ) {
    start += 1
  }
  return text.slice(start)
}
