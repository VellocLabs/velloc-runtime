import { describe, expect, it } from 'vitest'

import { CapabilityRegistry } from '../../browser/runtimeHub/CapabilityRegistry'
import { TopicBroker } from '../../browser/runtimeHub/TopicBroker'
import { registerCustomizePageCapability } from '../../browser/runtimeHub/customizePageCapability'
import type { ConnectionInfo } from '../../browser/runtimeHub/types'
import {
  CUSTOMIZE_PAGE_ACTION_SCOPES,
  CUSTOMIZE_PAGE_STATUS_TOPIC,
  CUSTOMIZE_PAGE_TOPIC_SCOPE,
  CUSTOMIZE_TAB_KEY,
  DIRECTORY_PAGE_SCRIPT,
  isCustomizeMarketplacePayload,
  isCustomizePageEmptyPayload,
  isCustomizePageItemPayload,
  isCustomizePageUrlPayload,
  readCustomizePageState,
  readPageMessage,
  readRouteReport,
  type CustomizePageState,
} from '../../customize/customizePageProtocol'
import {
  CustomizePageService,
  directoryApiOriginFor,
  type CustomizePageHost,
  type CustomizePageScript,
} from '../../customize/CustomizePageService'
import type { DirectoryOfferDeps } from '../../customize/directoryOffer'
import { DIRECTORY_API_ORIGIN, DIRECTORY_SITE_HOST, DIRECTORY_SITE_ORIGIN } from '../../customize/directorySite'
import type { NexusMcpServerConfig } from '../../settings/settingsTypes'

const PAGE = 'http://127.0.0.1:4100/directory'

function fakeHost(options: { pageScript?: boolean; tabId?: number; webWindow?: boolean } = {}) {
  const calls: string[] = []
  const messageListeners = new Set<(e: { channelId: number; data: unknown }) => void>()
  const detachListeners = new Set<(e: { channelId: number; reason: string }) => void>()
  let nextChannel = 1
  let open = false
  const tabId = options.tabId ?? 7
  const script: CustomizePageScript = {
    attach: async target => {
      calls.push(`attach ${target.tabId}`)
      return nextChannel++
    },
    addInitScript: async (channelId, source) => {
      calls.push(`init ${channelId} ${source === DIRECTORY_PAGE_SCRIPT}`)
      return 's1'
    },
    executeScript: async (channelId, code) => {
      calls.push(`run ${channelId} ${code === DIRECTORY_PAGE_SCRIPT ? true : code}`)
      return { value: null }
    },
    onMessage: listener => {
      messageListeners.add(listener)
      return () => {
        messageListeners.delete(listener)
      }
    },
    onDetached: listener => {
      detachListeners.add(listener)
      return () => {
        detachListeners.delete(listener)
      }
    },
  }
  const host: CustomizePageHost = {
    openUtilityTab: async (key, url) => {
      calls.push(`open ${key} ${url}`)
      const created = !open
      open = true
      return { tabId, created }
    },
    navigateUtilityTab: async (id, url) => {
      calls.push(`navigate ${id} ${url}`)
    },
    pageScript: options.pageScript === false ? null : script,
    openWindow:
      options.webWindow === false
        ? null
        : async url => {
            calls.push(`window ${url}`)
          },
  }
  return {
    host,
    calls,
    report: (channelId: number, data: unknown) => {
      for (const l of Array.from(messageListeners)) l({ channelId, data })
    },
    detach: (channelId: number, reason: string) => {
      if (reason === 'target_gone') open = false
      for (const l of Array.from(detachListeners)) l({ channelId, reason })
    },
    listenerCount: () => messageListeners.size + detachListeners.size,
  }
}

const conn = (mode: 'observe' | 'manager' | 'full' = 'full') =>
  ({ connectionId: 'c', clientId: 'c', kind: 'cli', scope: { mode, sessions: 'all' }, transport: 'message-port' }) as ConnectionInfo

function rig(getHost: () => CustomizePageHost | null, offers?: DirectoryOfferDeps) {
  const registry = new CapabilityRegistry()
  const broker = new TopicBroker()
  const service = new CustomizePageService(getHost, offers)
  const reg = registerCustomizePageCapability(registry, broker, service)
  const events: CustomizePageState[] = []
  broker.subscribe(
    { conn: conn(), send: evt => events.push((evt as unknown as { payload: CustomizePageState }).payload), bufferedBytes: () => 0 },
    CUSTOMIZE_PAGE_STATUS_TOPIC,
  )
  const call = (act: 'show' | 'navigate' | 'back' | 'addPageItem' | 'describeMarketplace', payload: unknown) => {
    const entry = registry.resolve('customizePage', act)!
    expect(entry.spec.guard?.(payload, conn(), {} as never) ?? true).toBe(true)
    return entry.handle({ id: '1', route: { cap: 'customizePage', act }, payload, conn: conn() } as never, {} as never)
  }
  return { registry, broker, service, reg, events, call }
}

const settle = () => new Promise(resolve => setTimeout(resolve, 0))

describe('customizePage protocol', () => {
  it('every action and the topic are full scope', () => {
    expect(CUSTOMIZE_PAGE_ACTION_SCOPES).toEqual({
      show: 'full',
      navigate: 'full',
      back: 'full',
      addPageItem: 'full',
      describeMarketplace: 'full',
    })
    expect(CUSTOMIZE_PAGE_TOPIC_SCOPE).toBe('full')
    const { registry } = rig(() => null)
    for (const act of ['show', 'navigate', 'back', 'addPageItem', 'describeMarketplace']) {
      expect(registry.resolve('customizePage', act)!.spec.scope).toBe('full')
    }
  })

  it('an addPageItem payload is exactly one integer id', () => {
    expect(isCustomizePageItemPayload({ id: 3 })).toBe(true)
    expect(isCustomizePageItemPayload({ id: 1.5 })).toBe(false)
    expect(isCustomizePageItemPayload({ id: '3' })).toBe(false)
    expect(isCustomizePageItemPayload({ id: 3, install: true })).toBe(false)
    expect(isCustomizePageItemPayload(null)).toBe(false)
  })

  it('back takes an empty object; describeMarketplace exactly one marketplace name', () => {
    expect(isCustomizePageEmptyPayload({})).toBe(true)
    expect(isCustomizePageEmptyPayload({ steps: 2 })).toBe(false)
    expect(isCustomizePageEmptyPayload(null)).toBe(false)
    expect(isCustomizePageEmptyPayload([])).toBe(false)
    expect(isCustomizeMarketplacePayload({ marketplace: 'official-market' })).toBe(true)
    expect(isCustomizeMarketplacePayload({ marketplace: '' })).toBe(false)
    expect(isCustomizeMarketplacePayload({ marketplace: 'x'.repeat(201) })).toBe(false)
    expect(isCustomizeMarketplacePayload({ marketplace: 'm', origin: 'https://evil.example' })).toBe(false)
  })

  it('lookups go to the live listing for the live site and from a loopback page itself, never elsewhere', () => {
    expect(directoryApiOriginFor(`${DIRECTORY_SITE_ORIGIN}/directory`)).toBe(DIRECTORY_API_ORIGIN)
    expect(directoryApiOriginFor('http://127.0.0.1:4100/directory')).toBe('http://127.0.0.1:4100')
    expect(directoryApiOriginFor('http://localhost:4100/directory')).toBe('http://localhost:4100')
    expect(directoryApiOriginFor(`http://${DIRECTORY_SITE_HOST}/directory`)).toBeNull()
    expect(directoryApiOriginFor('https://evil.example/directory')).toBeNull()
    expect(directoryApiOriginFor('https://127.0.0.1/directory')).toBeNull()
  })

  it('a url payload is exactly one http(s) url', () => {
    expect(isCustomizePageUrlPayload({ url: PAGE })).toBe(true)
    expect(isCustomizePageUrlPayload({ url: 'https://example.test/customize/plugins' })).toBe(true)
    expect(isCustomizePageUrlPayload({ url: 'file:///C:/secret' })).toBe(false)
    expect(isCustomizePageUrlPayload({ url: 'javascript:alert(1)' })).toBe(false)
    expect(isCustomizePageUrlPayload({ url: 'not a url' })).toBe(false)
    expect(isCustomizePageUrlPayload({ url: PAGE, tabId: 3 })).toBe(false)
    expect(isCustomizePageUrlPayload({})).toBe(false)
    expect(isCustomizePageUrlPayload(null)).toBe(false)
  })

  it('the channel carries route reports, add asks and other-site opens, and nothing else', () => {
    expect(readRouteReport({ type: 'route', path: '/customize/skills' })).toBe('/customize/skills')
    expect(readRouteReport({ type: 'route', path: 7 })).toBeNull()
    expect(readRouteReport({ type: 'openSettings', section: 'mcp' })).toBeNull()
    expect(readRouteReport('route')).toBeNull()
    expect(readRouteReport(null)).toBeNull()
    expect(readPageMessage({ type: 'route', path: '/d', href: 'http://h/d', canGoBack: true }))
      .toEqual({ type: 'route', path: '/d', href: 'http://h/d', canGoBack: true })
    expect(readPageMessage({ type: 'route', path: '/d', canGoBack: 'yes' })).toEqual({ type: 'route', path: '/d' })
    expect(readPageMessage({ type: 'add', returnTo: '/directory/slack' }))
      .toEqual({ type: 'add', returnTo: '/directory/slack' })
    expect(readPageMessage({ type: 'add' })).toEqual({ type: 'add', returnTo: '' })
    expect(readPageMessage({ type: 'external', url: 'https://x.example' }))
      .toEqual({ type: 'external', url: 'https://x.example' })
    expect(readPageMessage({ type: 'external' })).toBeNull()
    expect(readPageMessage({ type: 'install', id: 'x' })).toBeNull()
  })

  it('reads the published state and refuses other shapes', () => {
    expect(readCustomizePageState({ available: true, tabId: 4, path: '/customize/skills' }))
      .toEqual({ available: true, tabId: 4, path: '/customize/skills' })
    expect(readCustomizePageState({ available: false })).toEqual({ available: false })
    expect(readCustomizePageState({ available: true, tabId: '4' })).toBeNull()
    const pageItem = { id: 2, kind: 'plugin', phase: 'ready', details: { name: 'notion' }, installable: true }
    expect(readCustomizePageState({ available: true, pageItem })).toEqual({ available: true, pageItem })
    expect(readCustomizePageState({ available: true, pageItem: { ...pageItem, phase: 'gone' } })).toBeNull()
    expect(readCustomizePageState({ available: true, pageItem: { ...pageItem, details: { name: 4 } } })).toBeNull()
    expect(readCustomizePageState({ available: true, pageItem: { ...pageItem, installedAs: 1 } })).toBeNull()
    expect(readCustomizePageState({ tabId: 4 })).toBeNull()
    expect(readCustomizePageState({ available: true, canGoBack: true, pageItem, addRequest: { seq: 2, itemId: 2 } }))
      .toEqual({ available: true, canGoBack: true, pageItem, addRequest: { seq: 2, itemId: 2 } })
    expect(readCustomizePageState({ available: true, canGoBack: 1 })).toBeNull()
    expect(readCustomizePageState({ available: true, addRequest: { seq: 'a', itemId: 2 } })).toBeNull()
  })
})

describe('customizePage service', () => {
  it('without a host the topic says unavailable and show is host_unavailable', async () => {
    const r = rig(() => null)
    await settle()
    expect(r.events).toEqual([{ available: false }])
    await expect(r.call('show', { url: PAGE })).rejects.toMatchObject({ code: 'host_unavailable' })
  })

  it('show opens the tab, attaches one channel and starts the page script in it', async () => {
    const fake = fakeHost()
    const r = rig(() => fake.host)
    await expect(r.call('show', { url: PAGE })).resolves.toEqual({ tabId: 7, created: true })
    expect(fake.calls).toEqual([`open ${CUSTOMIZE_TAB_KEY} ${PAGE}`, 'attach 7', 'init 1 true', 'run 1 true'])
    expect(r.events.at(-1)).toEqual({ available: true, tabId: 7 })
  })

  it('a second show reuses the tab and its channel', async () => {
    const fake = fakeHost()
    const r = rig(() => fake.host)
    await r.call('show', { url: PAGE })
    fake.calls.length = 0
    await expect(r.call('show', { url: PAGE })).resolves.toEqual({ tabId: 7, created: false })
    expect(fake.calls).toEqual([`open ${CUSTOMIZE_TAB_KEY} ${PAGE}`])
  })

  it('two shows at once attach one channel', async () => {
    const fake = fakeHost()
    const r = rig(() => fake.host)
    await Promise.all([r.call('show', { url: PAGE }), r.call('show', { url: PAGE })])
    expect(fake.calls.filter(c => c.startsWith('attach'))).toEqual(['attach 7'])
  })

  it('publishes the path the page reports on its own channel only', async () => {
    const fake = fakeHost()
    const r = rig(() => fake.host)
    await r.call('show', { url: PAGE })
    fake.report(1, { type: 'route', path: '/directory/slack' })
    expect(r.events.at(-1)).toEqual({ available: true, tabId: 7, path: '/directory/slack' })
    const count = r.events.length
    fake.report(2, { type: 'route', path: '/elsewhere' })
    fake.report(1, { type: 'other' })
    fake.report(1, { type: 'route', path: '/directory/slack' })
    expect(r.events.length).toBe(count)
  })

  it('navigate loads the shown tab, and is a conflict before any show', async () => {
    const fake = fakeHost()
    const r = rig(() => fake.host)
    await expect(r.call('navigate', { url: PAGE })).rejects.toMatchObject({ code: 'conflict' })
    await r.call('show', { url: PAGE })
    await expect(r.call('navigate', { url: 'http://127.0.0.1:4100/directory/new' })).resolves.toEqual({ ok: true })
    expect(fake.calls.at(-1)).toBe('navigate 7 http://127.0.0.1:4100/directory/new')
  })

  it('a closed tab is forgotten, and the next show opens and attaches again', async () => {
    const fake = fakeHost()
    const r = rig(() => fake.host)
    await r.call('show', { url: PAGE })
    fake.report(1, { type: 'route', path: '/directory/slack' })
    fake.detach(1, 'target_gone')
    expect(r.events.at(-1)).toEqual({ available: true })
    fake.calls.length = 0
    await expect(r.call('show', { url: PAGE })).resolves.toEqual({ tabId: 7, created: true })
    expect(fake.calls).toContain('attach 7')
  })

  it('a host without the page channel still shows the tab, with no path', async () => {
    const fake = fakeHost({ pageScript: false })
    const r = rig(() => fake.host)
    await r.call('show', { url: PAGE })
    expect(fake.calls).toEqual([`open ${CUSTOMIZE_TAB_KEY} ${PAGE}`])
    expect(r.events.at(-1)).toEqual({ available: true, tabId: 7 })
  })

  it('a replaced host port drops the old tab and its listeners', async () => {
    const first = fakeHost()
    const second = fakeHost({ tabId: 9 })
    let host: CustomizePageHost = first.host
    const r = rig(() => host)
    await r.call('show', { url: PAGE })
    host = second.host
    expect(r.service.getState()).toEqual({ available: true })
    await r.call('show', { url: PAGE })
    expect(first.listenerCount()).toBe(0)
    expect(second.calls).toContain('attach 9')
    first.report(1, { type: 'route', path: '/directory/slack' })
    expect(r.service.getState()).toEqual({ available: true, tabId: 9 })
  })

  it('publishes whether the page can go back, and back steps the page through its channel', async () => {
    const fake = fakeHost()
    const r = rig(() => fake.host)
    await expect(r.call('back', {})).rejects.toMatchObject({ code: 'conflict' })
    await r.call('show', { url: PAGE })
    fake.report(1, { type: 'route', path: '/directory', href: PAGE, canGoBack: false })
    expect(r.events.at(-1)).toEqual({ available: true, tabId: 7, path: '/directory', canGoBack: false })
    fake.report(1, { type: 'route', path: '/directory', href: PAGE, canGoBack: true })
    expect(r.events.at(-1)).toMatchObject({ canGoBack: true })
    await expect(r.call('back', {})).resolves.toEqual({ ok: true })
    expect(fake.calls.at(-1)).toBe('run 1 history.back()')
  })

  it('back on a host without the page channel answers ok: false', async () => {
    const fake = fakeHost({ pageScript: false })
    const r = rig(() => fake.host)
    await r.call('show', { url: PAGE })
    await expect(r.call('back', {})).resolves.toEqual({ ok: false })
  })

  it('a page on another site opens in a window of its own; without web windows it loads in the tab', async () => {
    const fake = fakeHost()
    const r = rig(() => fake.host)
    await r.call('show', { url: PAGE })
    fake.report(1, { type: 'external', url: 'https://docs.example/start' })
    fake.report(1, { type: 'external', url: 'file:///C:/secret' })
    fake.report(1, { type: 'external', url: 'javascript:alert(1)' })
    await settle()
    expect(fake.calls.filter(c => c.startsWith('window') || c.startsWith('navigate'))).toEqual([
      'window https://docs.example/start',
    ])

    const bare = fakeHost({ webWindow: false })
    const b = rig(() => bare.host)
    await b.call('show', { url: PAGE })
    bare.report(1, { type: 'external', url: 'https://docs.example/start' })
    await settle()
    expect(bare.calls.at(-1)).toBe('navigate 7 https://docs.example/start')
  })

  it('a document of another site that lands in the tab opens elsewhere and the tab returns to its last page', async () => {
    const fake = fakeHost()
    const r = rig(() => fake.host)
    await r.call('show', { url: PAGE })
    fake.report(1, { type: 'route', path: '/directory/slack', href: 'http://127.0.0.1:4100/directory/slack?x=1' })
    const before = r.events.length
    fake.report(1, { type: 'route', path: '/landing', href: 'https://partner.example/landing' })
    await settle()
    expect(fake.calls.slice(-2)).toEqual([
      'window https://partner.example/landing',
      'navigate 7 http://127.0.0.1:4100/directory/slack?x=1',
    ])
    expect(r.events.length).toBe(before)
    expect(r.service.getState().path).toBe('/directory/slack')
  })

  it('dispose releases the channel listeners', async () => {
    const fake = fakeHost()
    const r = rig(() => fake.host)
    await r.call('show', { url: PAGE })
    r.reg.dispose()
    expect(fake.listenerCount()).toBe(0)
  })
})

/** Directory listing and local lists for the page-item tests; every call is recorded. */
function fakeOffers(options: {
  records?: Record<string, unknown[]>
  fail?: boolean
  servers?: Record<string, NexusMcpServerConfig>
  installFails?: boolean
} = {}) {
  const calls: string[] = []
  const deps: DirectoryOfferDeps = {
    fetchJson: async url => {
      calls.push(`fetch ${url}`)
      if (options.fail) throw new Error('offline')
      const filter = new URL(url).searchParams.get('filter') ?? ''
      return { data: options.records?.[filter] ?? [] }
    },
    listMarketplaces: async () => [
      { name: 'official-market', source: { source: 'github', repo: 'acme/market' }, isOfficial: true },
    ],
    listMarketplaceListings: async () => [
      { name: 'notion', source: { source: 'url', url: 'https://github.com/makenotion/notion-plugin.git' }, installed: false },
    ],
    installPlugin: async id => {
      calls.push(`install ${id}`)
      if (options.installFails) throw new Error('blocked')
    },
    listMcpServers: async () => options.servers ?? {},
    upsertMcpServer: async (id, config) => {
      calls.push(`upsert ${id} ${config.url}`)
    },
  }
  return { deps, calls }
}

const SLACK = {
  name: 'Slack',
  slug: 'slack',
  summary: 'Chat',
  publisher: { name: 'Slack' },
  media: { icons: [{ url: 'https://slack.com' }] },
  components: [{ type: 'mcp_server', endpoint: { type: 'fixed', url: 'https://mcp.slack.com/mcp' } }],
}
const NOTION = {
  name: 'notion',
  slug: 'makenotion/notion-plugin',
  source: { repository: { url: 'https://github.com/makenotion/notion-plugin' } },
}
const NOTION_ID = 'b2be6e33-a55f-45ca-9453-3dabeb179a53'
const SLACK_FILTER = "slug == 'slack'"
const NOTION_FILTER = `manifest_name == '${NOTION_ID}'`
const NOTION_REPO_FILTER = "source.repository.url in ['https://github.com/makenotion/notion-plugin']"

describe('customizePage service — the page item', () => {
  async function shown(offers: DirectoryOfferDeps | undefined, page = PAGE) {
    const fake = fakeHost()
    const r = rig(() => fake.host, offers)
    await r.call('show', { url: page })
    return { fake, r }
  }
  const itemOf = (r: { service: CustomizePageService }) => r.service.getState().pageItem
  const PLUGIN_PATH = `/customize/plugins/id/${NOTION_ID}%40plugin-directory`

  it('a connector page is looked up and Add installs it as an http server', async () => {
    const o = fakeOffers({ records: { [SLACK_FILTER]: [SLACK] } })
    const { fake, r } = await shown(o.deps)
    fake.report(1, { type: 'route', path: '/directory/slack' })
    expect(itemOf(r)).toEqual({ id: 1, kind: 'connector', phase: 'resolving' })
    expect(r.events.at(-1)).toMatchObject({ path: '/directory/slack', pageItem: { phase: 'resolving' } })
    await settle()
    expect(o.calls[0]).toContain('fetch http://127.0.0.1:4100/api/directory/plugins?')
    expect(itemOf(r)).toEqual({
      id: 1,
      kind: 'connector',
      phase: 'ready',
      details: {
        name: 'Slack',
        summary: 'Chat',
        publisher: 'Slack',
        iconUrl: 'https://www.google.com/s2/favicons?sz=64&domain=slack.com',
        pagePath: '/directory/slack',
      },
      alreadyInstalled: false,
      installable: true,
    })
    await expect(r.call('addPageItem', { id: 1 })).resolves.toEqual({ ok: true })
    expect(o.calls.at(-1)).toBe('upsert slack https://mcp.slack.com/mcp')
    expect(itemOf(r)).toMatchObject({ phase: 'installed', installedAs: 'slack' })
    expect(r.events.map(e => e.pageItem?.phase)).toContain('installing')
  })

  it('a plugin page is matched to its marketplace listing and Add installs it by identifier', async () => {
    const o = fakeOffers({ records: { [NOTION_FILTER]: [NOTION] } })
    const { fake, r } = await shown(o.deps)
    fake.report(1, { type: 'route', path: PLUGIN_PATH })
    await settle()
    expect(itemOf(r)).toMatchObject({ kind: 'plugin', phase: 'ready', installable: true, alreadyInstalled: false })
    await r.call('addPageItem', { id: 1 })
    expect(o.calls.at(-1)).toBe('install notion@official-market')
    expect(itemOf(r)).toMatchObject({ phase: 'installed', installedAs: 'notion@official-market' })
  })

  it('an item already here says where, and Add is refused', async () => {
    const o = fakeOffers({
      records: { [SLACK_FILTER]: [SLACK] },
      servers: { chat: { transport: 'http', url: 'https://mcp.slack.com/mcp/' } },
    })
    const { fake, r } = await shown(o.deps)
    fake.report(1, { type: 'route', path: '/directory/slack' })
    await settle()
    expect(itemOf(r)).toMatchObject({ phase: 'ready', alreadyInstalled: true, installedAs: 'chat' })
    await expect(r.call('addPageItem', { id: 1 })).rejects.toMatchObject({ code: 'conflict' })
    expect(o.calls.some(c => c.startsWith('upsert'))).toBe(false)
  })

  it('an unknown item, a failed lookup and a failed install end as failed', async () => {
    const missing = fakeOffers()
    const a = await shown(missing.deps)
    a.fake.report(1, { type: 'route', path: '/directory/nothing-here' })
    await settle()
    expect(itemOf(a.r)).toMatchObject({ phase: 'failed', failure: 'not_found' })

    const offline = fakeOffers({ fail: true })
    const b = await shown(offline.deps)
    b.fake.report(1, { type: 'route', path: '/directory/slack' })
    await settle()
    expect(itemOf(b.r)).toMatchObject({ phase: 'failed', failure: 'lookup_failed' })

    const refused = fakeOffers({ records: { [NOTION_FILTER]: [NOTION] }, installFails: true })
    const c = await shown(refused.deps)
    c.fake.report(1, { type: 'route', path: PLUGIN_PATH })
    await settle()
    await c.r.call('addPageItem', { id: 1 })
    expect(itemOf(c.r)).toMatchObject({ phase: 'failed', failure: 'install_failed', details: { name: 'notion' } })
  })

  it('after a failed install Add can try again', async () => {
    const o = fakeOffers({ records: { [NOTION_FILTER]: [NOTION] }, installFails: true })
    const { fake, r } = await shown(o.deps)
    fake.report(1, { type: 'route', path: PLUGIN_PATH })
    await settle()
    await r.call('addPageItem', { id: 1 })
    expect(itemOf(r)).toMatchObject({ phase: 'failed', failure: 'install_failed' })
    o.deps.installPlugin = async id => void o.calls.push(`install ${id}`)
    await r.call('addPageItem', { id: 1 })
    expect(itemOf(r)).toMatchObject({ phase: 'installed', installedAs: 'notion@official-market' })
    expect(itemOf(r)?.failure).toBeUndefined()
    expect(o.calls.filter(c => c.startsWith('install'))).toHaveLength(2)
  })

  it('a failed lookup cannot be added', async () => {
    const o = fakeOffers({ fail: true })
    const { fake, r } = await shown(o.deps)
    fake.report(1, { type: 'route', path: '/directory/slack' })
    await settle()
    await expect(r.call('addPageItem', { id: 1 })).rejects.toMatchObject({ code: 'conflict' })
  })

  it('list pages, other channels and pages with no listing have no item', async () => {
    const o = fakeOffers({ records: { [SLACK_FILTER]: [SLACK] } })
    const { fake, r } = await shown(o.deps)
    fake.report(1, { type: 'route', path: '/directory' })
    fake.report(1, { type: 'route', path: '/directory/trending' })
    fake.report(1, { type: 'route', path: '/directory/category-design' })
    fake.report(2, { type: 'route', path: '/directory/slack' })
    expect(itemOf(r)).toBeUndefined()

    const elsewhere = await shown(o.deps, 'https://pages.example/directory')
    elsewhere.fake.report(1, { type: 'route', path: '/directory/slack' })
    expect(itemOf(elsewhere.r)).toBeUndefined()
    expect(o.calls).toEqual([])
  })

  it('the same item is looked up once; leaving it clears it, and a stale id cannot add', async () => {
    const o = fakeOffers({ records: { [SLACK_FILTER]: [SLACK] } })
    const { fake, r } = await shown(o.deps)
    fake.report(1, { type: 'route', path: '/directory/slack' })
    await settle()
    fake.report(1, { type: 'route', path: '/directory' })
    expect(itemOf(r)).toBeUndefined()
    expect(r.events.at(-1)).toEqual({ available: true, tabId: 7, path: '/directory' })
    fake.report(1, { type: 'route', path: '/directory/slack' })
    await settle()
    expect(itemOf(r)?.id).toBe(2)
    expect(o.calls.filter(c => c.startsWith('fetch'))).toHaveLength(2)
    await expect(r.call('addPageItem', { id: 1 })).rejects.toMatchObject({ code: 'conflict' })
  })

  it('a closed tab forgets the item', async () => {
    const o = fakeOffers({ records: { [SLACK_FILTER]: [SLACK] } })
    const { fake, r } = await shown(o.deps)
    fake.report(1, { type: 'route', path: '/directory/slack' })
    await settle()
    fake.detach(1, 'target_gone')
    expect(itemOf(r)).toBeUndefined()
  })

  it('the page\'s own add button asks to add the item it shows, once per press', async () => {
    const o = fakeOffers({ records: { [SLACK_FILTER]: [SLACK] } })
    const { fake, r } = await shown(o.deps)
    fake.report(1, { type: 'route', path: '/directory/slack' })
    fake.report(1, { type: 'add', returnTo: '/directory/slack' })
    expect(r.events.at(-1)).toMatchObject({
      pageItem: { id: 1, phase: 'resolving' },
      addRequest: { seq: 1, itemId: 1 },
    })
    fake.report(1, { type: 'add', returnTo: '' })
    expect(r.service.getState().addRequest).toEqual({ seq: 2, itemId: 1 })
    expect(o.calls.some(c => c.startsWith('upsert'))).toBe(false)
    fake.report(1, { type: 'route', path: '/directory' })
    expect(r.service.getState().addRequest).toBeUndefined()
  })

  it('an add naming another item takes the page there and asks once it shows; a list page asks nothing', async () => {
    const o = fakeOffers({ records: { [SLACK_FILTER]: [SLACK] } })
    const { fake, r } = await shown(o.deps)
    fake.report(1, { type: 'route', path: '/directory' })
    fake.report(1, { type: 'add', returnTo: '/directory' })
    fake.report(1, { type: 'add', returnTo: 'https://evil.example/directory/slack' })
    await settle()
    expect(r.service.getState().addRequest).toBeUndefined()
    expect(fake.calls.filter(c => c.startsWith('navigate'))).toEqual([])

    fake.report(1, { type: 'add', returnTo: '/directory/slack?from=card' })
    await settle()
    expect(fake.calls.at(-1)).toBe('navigate 7 http://127.0.0.1:4100/directory/slack?from=card')
    expect(r.service.getState().addRequest).toBeUndefined()
    fake.report(1, { type: 'route', path: '/directory/slack' })
    expect(r.service.getState()).toMatchObject({ pageItem: { id: 1 }, addRequest: { seq: 1, itemId: 1 } })
  })

  it('describeMarketplace answers the directory\'s details per plugin, and nothing before a show', async () => {
    const o = fakeOffers({ records: { [NOTION_REPO_FILTER]: [{ ...NOTION, summary: 'Notes' }] } })
    const fake = fakeHost()
    const r = rig(() => fake.host, o.deps)
    await expect(r.call('describeMarketplace', { marketplace: 'official-market' })).resolves.toEqual({ plugins: {} })
    await r.call('show', { url: PAGE })
    const answer = await r.call('describeMarketplace', { marketplace: 'official-market' })
    expect(answer).toMatchObject({ plugins: { notion: { name: 'notion', summary: 'Notes' } } })
    await r.call('describeMarketplace', { marketplace: 'official-market' })
    expect(o.calls.filter(c => c.startsWith('fetch'))).toHaveLength(1)
  })

  it('without lookup calls a page never has an item', async () => {
    const { fake, r } = await shown(undefined)
    fake.report(1, { type: 'route', path: '/directory/slack' })
    expect(itemOf(r)).toBeUndefined()
  })
})
