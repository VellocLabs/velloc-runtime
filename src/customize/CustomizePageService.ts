/**
 * The runtime's half of the Customize page (F-35): opens or reuses this
 * window's `customize` utility tab, keeps one page-script channel to it,
 * turns the channel's route reports into state, and looks up the plugin or
 * connector each reported page shows so a client can add it. Tab calls are
 * serialized, so two quick `show`s open one tab and attach one channel.
 */
import {
  CUSTOMIZE_TAB_KEY,
  DIRECTORY_PAGE_SCRIPT,
  readRouteReport,
  type CustomizePageShowResult,
  type CustomizePageState,
} from './customizePageProtocol'
import {
  DirectoryLookupError,
  installDirectoryTarget,
  parseDirectoryIntent,
  resolveDirectoryIntent,
  type DirectoryInstallTarget,
  type DirectoryIntent,
  type DirectoryOfferDeps,
  type DirectoryPageItem,
} from './directoryOffer'
import { DIRECTORY_API_ORIGIN, DIRECTORY_SITE_HOST } from './directorySite'

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

export type CustomizePageErrorCode = 'host_unavailable' | 'not_shown' | 'no_item'

/**
 * Security: the listing a page item is looked up in, for the page origin the
 * tab was shown at. The live site uses the public directory listing; a
 * loopback page (the e2e seam) serves its own; any other origin gets none.
 */
export function directoryApiOriginFor(pageUrl: string): string | null {
  let url: URL
  try {
    url = new URL(pageUrl)
  } catch {
    return null
  }
  if (url.protocol === 'https:' && url.hostname === DIRECTORY_SITE_HOST) return DIRECTORY_API_ORIGIN
  if (url.protocol === 'http:' && (url.hostname === '127.0.0.1' || url.hostname === 'localhost')) return url.origin
  return null
}

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
  private apiOrigin: string | null = null
  private pageItem: DirectoryPageItem | undefined
  private pageItemKey: string | null = null
  private target: DirectoryInstallTarget | null = null
  private nextItemId = 1
  private queue: Promise<unknown> = Promise.resolve()
  private readonly listeners = new Set<() => void>()

  /** Without `offers` no page item is looked up; the path is still published. */
  constructor(
    private readonly getHost: () => CustomizePageHost | null,
    private readonly offers?: DirectoryOfferDeps,
  ) {}

  getState(): CustomizePageState {
    const host = this.getHost()
    if (!host) return { available: false }
    const item = this.pageItem ? { pageItem: this.pageItem } : {}
    if (host !== this.host || this.tabId === null) return { available: true, ...item }
    return { available: true, tabId: this.tabId, ...(this.path !== undefined ? { path: this.path } : {}), ...item }
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
      this.apiOrigin = directoryApiOriginFor(url)
      if (opened.tabId !== this.tabId) {
        this.tabId = opened.tabId
        this.channel = null
        this.path = undefined
        this.forgetPageItem()
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

  /**
   * Installs the page item `id`; `no_item` unless it is the current,
   * installable, not-yet-installed one — `ready`, or `failed` by its install.
   */
  async addPageItem(id: number): Promise<void> {
    const item = this.pageItem
    const target = this.target
    const addable = item?.phase === 'ready' || (item?.phase === 'failed' && item.failure === 'install_failed')
    if (!item || item.id !== id || !addable || item.alreadyInstalled || !target || !this.offers) {
      throw new CustomizePageError('no_item', 'there is nothing to add on this page')
    }
    this.setPageItem({ ...withoutFailure(item), phase: 'installing' })
    try {
      const installedAs = await installDirectoryTarget(target, this.offers)
      if (this.pageItem?.id === id) this.setPageItem({ ...withoutFailure(item), phase: 'installed', installedAs })
    } catch {
      if (this.pageItem?.id === id) this.setPageItem({ ...item, phase: 'failed', failure: 'install_failed' })
    }
  }

  dispose(): void {
    this.release()
    this.listeners.clear()
  }

  /**
   * The page moved to `path`: a page on a plugin or connector is looked up
   * (once per item — a path that names the same item keeps its state); any
   * other page clears the item.
   */
  private follow(path: string): void {
    const intent = this.offers && this.apiOrigin ? parseDirectoryIntent(path) : null
    const key = intent ? (intent.kind === 'plugin' ? `plugin:${intent.manifestName}` : `connector:${intent.slug}`) : null
    if (key === this.pageItemKey) return
    this.pageItemKey = key
    this.target = null
    if (!intent || !this.offers || !this.apiOrigin) {
      this.pageItem = undefined
      return
    }
    const id = this.nextItemId++
    this.pageItem = { id, kind: intent.kind, phase: 'resolving' }
    void this.resolve(id, intent, this.apiOrigin, this.offers)
  }

  private async resolve(id: number, intent: DirectoryIntent, origin: string, deps: DirectoryOfferDeps) {
    try {
      const resolved = await resolveDirectoryIntent(intent, deps, origin)
      if (this.pageItem?.id !== id) return
      this.target = resolved.alreadyInstalled ? null : resolved.target
      this.setPageItem({
        id,
        kind: intent.kind,
        phase: 'ready',
        details: resolved.details,
        alreadyInstalled: resolved.alreadyInstalled,
        installable: resolved.alreadyInstalled || resolved.target !== null,
        ...(resolved.installedAs ? { installedAs: resolved.installedAs } : {}),
      })
    } catch (error) {
      if (this.pageItem?.id !== id) return
      const failure = error instanceof DirectoryLookupError ? error.code : 'lookup_failed'
      this.setPageItem({ id, kind: intent.kind, phase: 'failed', failure })
    }
  }

  private setPageItem(item: DirectoryPageItem): void {
    this.pageItem = item
    this.emit()
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
          this.follow(path)
          this.emit()
        }),
        script.onDetached(event => {
          if (event.channelId !== this.channel) return
          this.channel = null
          if (event.reason === 'target_gone') {
            this.tabId = null
            this.path = undefined
            this.forgetPageItem()
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
      // Every later document gets the script at its start; the document
      // already showing (a reused tab) gets it now, which also reports where
      // the page is.
      await script.addInitScript(channel, DIRECTORY_PAGE_SCRIPT)
      await script.executeScript(channel, DIRECTORY_PAGE_SCRIPT)
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
    this.forgetPageItem()
  }

  private forgetPageItem(): void {
    this.pageItem = undefined
    this.pageItemKey = null
    this.target = null
  }

  private emit(): void {
    for (const listener of Array.from(this.listeners)) listener()
  }
}

function withoutFailure(item: DirectoryPageItem): DirectoryPageItem {
  const { failure: _failure, ...rest } = item
  return rest
}
