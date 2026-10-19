/**
 * Whether a terminal's emulator is kept while nobody can see it (F-31), free
 * of xterm.js. A view that stays out of sight releases its emulator (and its
 * WebGL context); the runtime keeps the terminal and its screen, so a view
 * shown again builds a new emulator from the snapshot. A view starts live,
 * whatever it is shown in, and comes back the moment it is shown.
 */

/** Where a view is: on screen, in a hidden part of the page, or in a hidden page. */
export type ViewSight = 'shown' | 'paneHidden' | 'pageHidden'

/** How long a view stays out of sight before its emulator is released. */
export const RELEASE_AFTER_MS: Readonly<Record<Exclude<ViewSight, 'shown'>, number>> = {
  // Settings over the session, another pane maximized, the side panel shut.
  paneHidden: 2_000,
  // A minimized, covered or background window: the person may be back soon.
  pageHidden: 30_000,
}

export type ViewRetentionOptions = {
  /** The emulator is to be built (`true`) or released (`false`). */
  onChange: (live: boolean) => void
  delays?: Readonly<Record<Exclude<ViewSight, 'shown'>, number>>
  now?: () => number
}

export class ViewRetention {
  private liveNow = true
  private hiddenSince: number | null = null
  private sight: ViewSight = 'shown'
  private timer: ReturnType<typeof setTimeout> | null = null
  private disposed = false
  private readonly delays: Readonly<Record<Exclude<ViewSight, 'shown'>, number>>
  private readonly now: () => number

  constructor(private readonly options: ViewRetentionOptions) {
    this.delays = options.delays ?? RELEASE_AFTER_MS
    this.now = options.now ?? Date.now
  }

  get live(): boolean {
    return this.liveNow
  }

  /** The view was measured at `sight`. */
  update(sight: ViewSight): void {
    if (this.disposed || sight === this.sight) return
    this.sight = sight
    this.cancel()
    if (sight === 'shown') {
      this.hiddenSince = null
      this.set(true)
      return
    }
    if (!this.liveNow) return
    this.hiddenSince ??= this.now()
    const wait = Math.max(0, this.delays[sight] - (this.now() - this.hiddenSince))
    this.timer = setTimeout(() => {
      this.timer = null
      this.set(false)
    }, wait)
  }

  dispose(): void {
    this.disposed = true
    this.cancel()
  }

  private set(live: boolean): void {
    if (live === this.liveNow) return
    this.liveNow = live
    this.options.onChange(live)
  }

  private cancel(): void {
    if (this.timer !== null) {
      clearTimeout(this.timer)
      this.timer = null
    }
  }
}

/**
 * Where `el` is: a page the browser reports hidden, or an element with no box
 * (inside `display: none`, or squeezed to nothing) is out of sight.
 */
export function measureViewSight(el: HTMLElement): ViewSight {
  if (el.getClientRects().length === 0 || el.clientWidth === 0 || el.clientHeight === 0) return 'paneHidden'
  if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return 'pageHidden'
  return 'shown'
}
