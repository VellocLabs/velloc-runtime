/**
 * When an app's script runs (F-40). Contract: a script is wanted while some
 * page shows its app, and for `idleMs` after the last page stopped showing
 * it; an action or a press on an app no page shows wants it for `idleMs`
 * too. `sleep(appId)` is called once that time has passed with no page
 * showing the app; a show before then cancels it. Holds no worker: the
 * runtime starts and stops them.
 */

/** How long an app's script runs on after the last page stopped showing the app. */
export const APP_SCRIPT_IDLE_MS = 60_000

/**
 * How long a press waits for a stopped script to load before the hook's own
 * budget starts: with that budget, inside the time a page waits for a press's
 * answer. A load that takes longer leaves the press unanswered.
 */
export const APP_SCRIPT_PRESS_START_MS = 1_200

export type AppScriptLifetimeOptions = {
  idleMs: number
  /** Whether some page shows the app now. */
  shown: (appId: string) => boolean
  /** The app has not been shown for `idleMs`: its script may stop. */
  sleep: (appId: string) => void
}

export class AppScriptLifetimes<Ref extends { readonly appId: string }> {
  private readonly refs = new Map<string, Ref>()
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>()

  constructor(private readonly options: AppScriptLifetimeOptions) {}

  /** The scripts the published apps declare now; a gone one loses its timer. */
  sync(refs: readonly Ref[]): void {
    const wanted = new Set(refs.map(ref => ref.appId))
    for (const appId of [...this.refs.keys()]) {
      if (!wanted.has(appId)) {
        this.refs.delete(appId)
        this.clear(appId)
      }
    }
    for (const ref of refs) this.refs.set(ref.appId, ref)
  }

  /** The script of `appId` is wanted now: its ref, or undefined when the app declares none. */
  wake(appId: string): Ref | undefined {
    const ref = this.refs.get(appId)
    if (!ref) return undefined
    if (this.options.shown(appId)) this.clear(appId)
    else this.arm(appId)
    return ref
  }

  /** No page shows the app any more: its script stops after the idle time. */
  hidden(appId: string): void {
    if (this.refs.has(appId) && !this.options.shown(appId)) this.arm(appId)
  }

  dispose(): void {
    for (const appId of [...this.timers.keys()]) this.clear(appId)
    this.refs.clear()
  }

  private arm(appId: string): void {
    this.clear(appId)
    this.timers.set(
      appId,
      setTimeout(() => {
        this.timers.delete(appId)
        if (!this.options.shown(appId)) this.options.sleep(appId)
      }, this.options.idleMs),
    )
  }

  private clear(appId: string): void {
    const timer = this.timers.get(appId)
    if (timer === undefined) return
    clearTimeout(timer)
    this.timers.delete(appId)
  }
}

/** Waits for a module's load in flight, at most `timeoutMs`; never rejects. */
export async function untilReady(module: { readonly starting?: Promise<unknown> }, timeoutMs: number): Promise<void> {
  const starting = module.starting
  if (!starting) return
  let timer: ReturnType<typeof setTimeout> | undefined
  const late = new Promise<void>(resolve => {
    timer = setTimeout(resolve, timeoutMs)
  })
  try {
    await Promise.race([starting.then(() => undefined, () => undefined), late])
  } finally {
    clearTimeout(timer)
  }
}
