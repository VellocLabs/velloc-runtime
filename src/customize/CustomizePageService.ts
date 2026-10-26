/**
 * The runtime's half of the Customize page (F-35): opens or reuses this
 * window's `customize` utility tab, keeps one page-script channel to it,
 * turns the channel's route reports into state, and looks up the plugin or
 * connector each reported page shows so a client can add it. Tab calls are
 * serialized, so two quick `show`s open one tab and attach one channel.
 */
import {
  CUSTOMIZE_TAB_KEY,
  DIRECTORY_HOME_PATH,
  DIRECTORY_PAGE_SCRIPT,
  readPageMessage,
  type CustomizeAddRequest,
  type CustomizeMarketplaceDescription,
  type CustomizePageShowResult,
  type CustomizePageState,
  type DirectoryPageMessage,
} from './customizePageProtocol'
import {
  DirectoryLookupError,
  describeMarketplacePlugins,
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
  /** Opens `url` in a window of its own; null on a host without web windows. */
  openWindow: ((url: string) => Promise<void>) | null
}

export type CustomizePageErrorCode = 'host_unavailable' | 'not_shown' | 'no_item'

const MARKETPLACE_DESCRIPTION_TTL_MS = 10 * 60_000

const intentKey = (intent: DirectoryIntent) =>
  intent.kind === 'plugin' ? `plugin:${intent.manifestName}` : `connector:${intent.slug}`

const isWebUrl = (url: URL) => url.protocol === 'http:' || url.protocol === 'https:'

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
  private canGoBack: boolean | undefined
  /** The origin the tab was shown at, and the last address the page reported on it. */
  private pageOrigin: string | null = null
  private pageHref: string | null = null
  private apiOrigin: string | null = null
  private pageItem: DirectoryPageItem | undefined
  private pageItemKey: string | null = null
  private target: DirectoryInstallTarget | null = null
  private addRequest: CustomizeAddRequest | undefined
  private addSeq = 0
  /** An add asked for an item the page is being taken to; asked again once it shows. */
  private pendingAddKey: string | null = null
  private readonly descriptions = new Map<string, { at: number; value: Promise<CustomizeMarketplaceDescription> }>()
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
    const item = this.pageItem
      ? { pageItem: this.pageItem, ...(this.addRequest ? { addRequest: this.addRequest } : {}) }
      : {}
    if (host !== this.host || this.tabId === null) return { available: true, ...item }
    return {
      available: true,
      tabId: this.tabId,
      ...(this.path !== undefined ? { path: this.path } : {}),
      ...(this.canGoBack !== undefined ? { canGoBack: this.canGoBack } : {}),
      ...item,
    }
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
      this.pageOrigin = new URL(url).origin
      if (opened.tabId !== this.tabId) {
        this.tabId = opened.tabId
        this.channel = null
        this.forgetPage()
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

  /** Takes the page one entry back in its own history; false when it has no channel to do it with. */
  back(): Promise<boolean> {
    return this.serial(async () => {
      const host = this.bind()
      if (this.tabId === null) throw new CustomizePageError('not_shown', 'the Customize page is not open')
      if (this.channel === null || !host.pageScript) return false
      await host.pageScript.executeScript(this.channel, 'history.back()')
      return true
    })
  }

  /**
   * The directory's details for each plugin `marketplace` lists (kept ten
   * minutes per marketplace). Empty without lookup calls or before a show
   * names the listing's origin; a failed read is not kept.
   */
  describeMarketplace(marketplace: string): Promise<CustomizeMarketplaceDescription> {
    const offers = this.offers
    const origin = this.apiOrigin
    if (!offers || !origin) return Promise.resolve({ plugins: {} })
    const key = `${origin} ${marketplace}`
    const kept = this.descriptions.get(key)
    if (kept && Date.now() - kept.at < MARKETPLACE_DESCRIPTION_TTL_MS) return kept.value
    const value = describeMarketplacePlugins(marketplace, offers, origin).then(plugins => ({ plugins }))
    this.descriptions.set(key, { at: Date.now(), value })
    value.catch(() => {
      if (this.descriptions.get(key)?.value === value) this.descriptions.delete(key)
    })
    return value
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
    const key = intent ? intentKey(intent) : null
    if (key === this.pageItemKey) return
    this.pageItemKey = key
    this.target = null
    this.addRequest = undefined
    if (!intent || !this.offers || !this.apiOrigin) {
      this.pageItem = undefined
      return
    }
    const id = this.nextItemId++
    this.pageItem = { id, kind: intent.kind, phase: 'resolving' }
    if (key === this.pendingAddKey) {
      this.pendingAddKey = null
      this.addRequest = { seq: ++this.addSeq, itemId: id }
    }
    void this.resolve(id, intent, this.apiOrigin, this.offers)
  }

  private onPageMessage(message: DirectoryPageMessage): void {
    if (message.type === 'route') {
      if (message.href !== undefined && this.leaveForeignPage(message.href)) return
      if (message.href !== undefined) this.pageHref = message.href
      const moved = message.path !== this.path
      if (!moved && message.canGoBack === this.canGoBack) return
      this.path = message.path
      if (message.canGoBack !== undefined) this.canGoBack = message.canGoBack
      if (moved) this.follow(message.path)
      this.emit()
      return
    }
    if (message.type === 'add') {
      this.requestAdd(message.returnTo)
      return
    }
    this.openElsewhere(message.url)
  }

  /**
   * The page's own add button stopped at sign-in. `returnTo` naming another
   * item takes the page there and asks once that item shows; otherwise the
   * item on the page is asked for. A page with no item asks nothing.
   */
  private requestAdd(returnTo: string): void {
    const origin = this.pageOrigin
    let returnPath: string | null = null
    if (origin && returnTo) {
      try {
        const url = new URL(returnTo, origin)
        if (url.origin === origin) returnPath = url.pathname + url.search
      } catch {
        returnPath = null
      }
    }
    const intent = returnPath ? parseDirectoryIntent(returnPath) : null
    const key = intent ? intentKey(intent) : this.pageItemKey
    if (!key || !this.offers || !this.apiOrigin) return
    if (key === this.pageItemKey && this.pageItem) {
      this.addRequest = { seq: ++this.addSeq, itemId: this.pageItem.id }
      this.emit()
      return
    }
    if (!returnPath || !origin) return
    this.pendingAddKey = key
    this.navigate(origin + returnPath).catch(() => {
      if (this.pendingAddKey === key) this.pendingAddKey = null
    })
  }

  /** Opens a page the tab must not leave its site for in a window of its own. */
  private openElsewhere(href: string): void {
    let url: URL
    try {
      url = new URL(href)
    } catch {
      return
    }
    if (!isWebUrl(url)) return
    const host = this.host
    if (!host) return
    const tabId = this.tabId
    const opened = host.openWindow
      ? host.openWindow(url.href)
      : tabId !== null ? host.navigateUtilityTab(tabId, url.href) : Promise.resolve()
    opened.catch(() => undefined)
  }

  /**
   * Security: a document of another origin that landed in the tab anyway
   * (a redirect, a navigation that could not be stopped) opens in a window
   * of its own, and the tab goes back to the last page it showed on its site.
   */
  private leaveForeignPage(href: string): boolean {
    const origin = this.pageOrigin
    let url: URL
    try {
      url = new URL(href)
    } catch {
      return false
    }
    if (!origin || url.origin === origin) return false
    this.openElsewhere(href)
    const back = this.pageHref ?? origin + DIRECTORY_HOME_PATH
    this.navigate(back).catch(() => undefined)
    return true
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
          const message = readPageMessage(event.data)
          if (message) this.onPageMessage(message)
        }),
        script.onDetached(event => {
          if (event.channelId !== this.channel) return
          this.channel = null
          if (event.reason === 'target_gone') {
            this.tabId = null
            this.forgetPage()
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
    this.forgetPage()
  }

  /** Everything the tab's page told: its place, its history, its item. */
  private forgetPage(): void {
    this.path = undefined
    this.canGoBack = undefined
    this.pageHref = null
    this.pendingAddKey = null
    this.pageItem = undefined
    this.pageItemKey = null
    this.target = null
    this.addRequest = undefined
  }

  private emit(): void {
    for (const listener of Array.from(this.listeners)) listener()
  }
}

function withoutFailure(item: DirectoryPageItem): DirectoryPageItem {
  const { failure: _failure, ...rest } = item
  return rest
}
