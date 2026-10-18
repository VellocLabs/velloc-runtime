/**
 * When the emulator re-fits its host element (F-31), free of xterm.js: the
 * `ResizeObserver`'s notices, debounced so a drag settles first, and a check
 * of the host's box on every render of the host. The observer delivers only
 * when the window renders, and a covered window does not render; a render
 * still happens, and a box that differs from the one last fitted is refitted.
 */

export type HostBox = { width: number; height: number }

export type FitSchedulerOptions = {
  /** The host element's current box; 0×0 while it is hidden. */
  measure: () => HostBox
  /** Apply the host's box to the emulator and the console. */
  fit: () => void
  debounceMs: number
}

export class FitScheduler {
  private timer: ReturnType<typeof setTimeout> | null = null
  private fitted: HostBox | null = null
  private disposed = false

  constructor(private readonly options: FitSchedulerOptions) {}

  /** The observer saw the host's box change: fit once it settles. */
  observed(): void {
    this.schedule()
  }

  /**
   * The host was rendered again: fit if its box is not the one last fitted.
   * Returns whether a fit was scheduled.
   */
  rendered(): boolean {
    if (this.disposed) return false
    const box = this.options.measure()
    if (this.fitted && this.fitted.width === box.width && this.fitted.height === box.height) return false
    this.schedule()
    return true
  }

  /** Fit at once, dropping a pending one. */
  fitNow(): void {
    if (this.disposed) return
    this.cancel()
    this.run()
  }

  dispose(): void {
    this.disposed = true
    this.cancel()
  }

  private schedule(): void {
    if (this.disposed) return
    this.cancel()
    this.timer = setTimeout(() => {
      this.timer = null
      this.run()
    }, this.options.debounceMs)
  }

  private cancel(): void {
    if (this.timer !== null) {
      clearTimeout(this.timer)
      this.timer = null
    }
  }

  private run(): void {
    this.fitted = this.options.measure()
    this.options.fit()
  }
}
