/**
 * Contract: batches one terminal's output text into one delivery per window
 * (F-31) — delivered when `maxUnits` UTF-16 units are pending or `windowMs`
 * after the first pending piece, whichever comes first — so a chatty program
 * costs one publish per frame rather than one per host chunk. `flush`
 * delivers what is pending now; `dispose` drops it.
 */
export class OutputCoalescer {
  private pending = ''
  private timer: ReturnType<typeof setTimeout> | null = null

  constructor(
    private readonly deliver: (data: string) => void,
    private readonly windowMs: number,
    private readonly maxUnits: number,
  ) {}

  push(text: string): void {
    if (text.length === 0) return
    this.pending += text
    if (this.pending.length >= this.maxUnits) {
      this.flush()
      return
    }
    if (this.timer === null) {
      this.timer = setTimeout(() => this.flush(), this.windowMs)
    }
  }

  flush(): void {
    this.clearTimer()
    if (this.pending.length === 0) return
    const data = this.pending
    this.pending = ''
    this.deliver(data)
  }

  dispose(): void {
    this.clearTimer()
    this.pending = ''
  }

  private clearTimer(): void {
    if (this.timer !== null) {
      clearTimeout(this.timer)
      this.timer = null
    }
  }
}
