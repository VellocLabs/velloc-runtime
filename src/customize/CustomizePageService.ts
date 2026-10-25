/**
 * The runtime's half of the Customize page (F-35): opens or reuses this
 * window's `customize` utility tab, keeps one page-script channel to it, and
 * turns the channel's route reports into state. Calls are serialized, so two
 * quick `show`s open one tab and attach one channel.
 */
import {
  CUSTOMIZE_TAB_KEY,
  readRouteReport,
  ROUTE_REPORT_SCRIPT,
  type CustomizePageShowResult,
  type CustomizePageState,
} from './customizePageProtocol'

/** The page-script calls the service makes (the native `pageScript` primitive). */
export type CustomizePageScript = {
  attach(target: { tabId: number }): Promise<number>
  addInitScript(channelId: number, source: string): Promise<string>
  executeScript(channelId: number, code: string): Promise<unknown>
  onMessage(listener: (event: { channelId: number; data: unknown }) => void): () => void
  onDetached(listener: (event: { channelId: number; reason: string }) => void): () => void
}

/**
 * Contract: one object per host port; a different object means the port was
 * replaced, and the old tab and channel ids no longer mean anything.
 */
export type CustomizePageHost = {
  openUtilityTab(key: string, url: string): Promise<CustomizePageShowResult>
  navigateUtilityTab(tabId: number, url: string): Promise<void>
  /** Null on a host without the page channel: the tab still works, the path stays unknown. */
  pageScript: CustomizePageScript | null
}

export type CustomizePageErrorCode = 'host_unavailable' | 'not_shown'

export class CustomizePageError extends Error {
  constructor(
    readonly code: CustomizePageErrorCode,
    message: string,
  ) {
    super(message)
    this.name = 'CustomizePageError'
  }
}

export class CustomizePageService {
  private host: CustomizePageHost | null = null
  private unsubscribe: Array<() => void> = []
  private tabId: number | null = null
  private channel: number | null = null
  private path: string | undefined
  private queue: Promise<unknown> = Promise.resolve()
  private readonly listeners = new Set<() => void>()

  constructor(private readonly getHost: () => CustomizePageHost | null) {}

  getState(): CustomizePageState {
    const host = this.getHost()
    if (!host) return { available: false }
    if (host !== this.host || this.tabId === null) return { available: true }
    return { available: true, tabId: this.tabId, ...(this.path !== undefined ? { path: this.path } : {}) }
  }

  onStateChange(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  /** Opens the tab at `url`, or brings the open one to the front where it is. */
  show(url: string): Promise<CustomizePageShowResult> {
    return this.serial(async () => {
      const host = this.bind()
      const opened = await host.openUtilityTab(CUSTOMIZE_TAB_KEY, url)
      if (opened.tabId !== this.tabId) {
        this.tabId = opened.tabId
        this.channel = null
        this.path = undefined
      }
      if (this.channel === null && host.pageScript) await this.attach(host.pageScript, opened.tabId)
      this.emit()
      return opened
    })
  }

  /** Loads `url` in the shown tab. */
  navigate(url: string): Promise<void> {
    return this.serial(async () => {
      const host = this.bind()
      if (this.tabId === null) throw new CustomizePageError('not_shown', 'the Customize page is not open')
      await host.navigateUtilityTab(this.tabId, url)
    })
  }

  dispose(): void {
    this.release()
    this.listeners.clear()
  }

  private serial<T>(run: () => Promise<T>): Promise<T> {
    const next = this.queue.then(run, run)
    this.queue = next.catch(() => undefined)
    return next
  }

  /** The current host, rebinding (and forgetting the old tab) when the port changed. */
  private bind(): CustomizePageHost {
    const host = this.getHost()
    if (!host) throw new CustomizePageError('host_unavailable', 'the runtime has no host bridge right now')
    if (host === this.host) return host
    this.release()
    this.host = host
    const script = host.pageScript
    if (script) {
      this.unsubscribe.push(
        script.onMessage(event => {
          if (event.channelId !== this.channel) return
          const path = readRouteReport(event.data)
          if (path === null || path === this.path) return
          this.path = path
          this.emit()
        }),
        script.onDetached(event => {
          if (event.channelId !== this.channel) return
          this.channel = null
          if (event.reason === 'target_gone') {
            this.tabId = null
            this.path = undefined
          }
          this.emit()
        }),
      )
    }
    return host
  }

  /** A failed attach leaves the tab without a channel: the path stays unknown. */
  private async attach(script: CustomizePageScript, tabId: number): Promise<void> {
    let channel: number
    try {
      channel = await script.attach({ tabId })
    } catch {
      return
    }
    this.channel = channel
    try {
      // Every later document gets the watcher at its start; the document
      // already showing (a reused tab) gets it now, which also reports where
      // the page is.
      await script.addInitScript(channel, ROUTE_REPORT_SCRIPT)
      await script.executeScript(channel, ROUTE_REPORT_SCRIPT)
    } catch {
      // The page is mid-navigation; the init script reports from the next document.
    }
  }

  private release(): void {
    for (const off of this.unsubscribe.splice(0)) off()
    this.host = null
    this.tabId = null
    this.channel = null
    this.path = undefined
  }

  private emit(): void {
    for (const listener of Array.from(this.listeners)) listener()
  }
}
