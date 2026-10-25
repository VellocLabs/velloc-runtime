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
  isCustomizePageUrlPayload,
  readCustomizePageState,
  readRouteReport,
  ROUTE_REPORT_SCRIPT,
  type CustomizePageState,
} from '../../customize/customizePageProtocol'
import {
  CustomizePageService,
  type CustomizePageHost,
  type CustomizePageScript,
} from '../../customize/CustomizePageService'

const PAGE = 'http://127.0.0.1:4100/customize/skills'

function fakeHost(options: { pageScript?: boolean; tabId?: number } = {}) {
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
      calls.push(`init ${channelId} ${source === ROUTE_REPORT_SCRIPT}`)
      return 's1'
    },
    executeScript: async (channelId, code) => {
      calls.push(`run ${channelId} ${code === ROUTE_REPORT_SCRIPT}`)
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

function rig(getHost: () => CustomizePageHost | null) {
  const registry = new CapabilityRegistry()
  const broker = new TopicBroker()
  const service = new CustomizePageService(getHost)
  const reg = registerCustomizePageCapability(registry, broker, service)
  const events: CustomizePageState[] = []
  broker.subscribe(
    { conn: conn(), send: evt => events.push((evt as unknown as { payload: CustomizePageState }).payload), bufferedBytes: () => 0 },
    CUSTOMIZE_PAGE_STATUS_TOPIC,
  )
  const call = (act: 'show' | 'navigate', payload: unknown) => {
    const entry = registry.resolve('customizePage', act)!
    expect(entry.spec.guard?.(payload, conn(), {} as never) ?? true).toBe(true)
    return entry.handle({ id: '1', route: { cap: 'customizePage', act }, payload, conn: conn() } as never, {} as never)
  }
  return { registry, broker, service, reg, events, call }
}

const settle = () => new Promise(resolve => setTimeout(resolve, 0))

describe('customizePage protocol', () => {
  it('every action and the topic are full scope', () => {
    expect(CUSTOMIZE_PAGE_ACTION_SCOPES).toEqual({ show: 'full', navigate: 'full' })
    expect(CUSTOMIZE_PAGE_TOPIC_SCOPE).toBe('full')
    const { registry } = rig(() => null)
    expect(registry.resolve('customizePage', 'show')!.spec.scope).toBe('full')
    expect(registry.resolve('customizePage', 'navigate')!.spec.scope).toBe('full')
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

  it('the channel carries route reports and nothing else', () => {
    expect(readRouteReport({ type: 'route', path: '/customize/skills' })).toBe('/customize/skills')
    expect(readRouteReport({ type: 'route', path: 7 })).toBeNull()
    expect(readRouteReport({ type: 'openSettings', section: 'mcp' })).toBeNull()
    expect(readRouteReport('route')).toBeNull()
    expect(readRouteReport(null)).toBeNull()
  })

  it('reads the published state and refuses other shapes', () => {
    expect(readCustomizePageState({ available: true, tabId: 4, path: '/customize/skills' }))
      .toEqual({ available: true, tabId: 4, path: '/customize/skills' })
    expect(readCustomizePageState({ available: false })).toEqual({ available: false })
    expect(readCustomizePageState({ available: true, tabId: '4' })).toBeNull()
    expect(readCustomizePageState({ tabId: 4 })).toBeNull()
  })
})

describe('customizePage service', () => {
  it('without a host the topic says unavailable and show is host_unavailable', async () => {
    const r = rig(() => null)
    await settle()
    expect(r.events).toEqual([{ available: false }])
    await expect(r.call('show', { url: PAGE })).rejects.toMatchObject({ code: 'host_unavailable' })
  })

  it('show opens the tab, attaches one channel and starts the route watcher in it', async () => {
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
    fake.report(1, { type: 'route', path: '/customize/plugins' })
    expect(r.events.at(-1)).toEqual({ available: true, tabId: 7, path: '/customize/plugins' })
    const count = r.events.length
    fake.report(2, { type: 'route', path: '/elsewhere' })
    fake.report(1, { type: 'other' })
    fake.report(1, { type: 'route', path: '/customize/plugins' })
    expect(r.events.length).toBe(count)
  })

  it('navigate loads the shown tab, and is a conflict before any show', async () => {
    const fake = fakeHost()
    const r = rig(() => fake.host)
    await expect(r.call('navigate', { url: PAGE })).rejects.toMatchObject({ code: 'conflict' })
    await r.call('show', { url: PAGE })
    await expect(r.call('navigate', { url: 'http://127.0.0.1:4100/customize/connectors' })).resolves.toEqual({ ok: true })
    expect(fake.calls.at(-1)).toBe('navigate 7 http://127.0.0.1:4100/customize/connectors')
  })

  it('a closed tab is forgotten, and the next show opens and attaches again', async () => {
    const fake = fakeHost()
    const r = rig(() => fake.host)
    await r.call('show', { url: PAGE })
    fake.report(1, { type: 'route', path: '/customize/plugins' })
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
    first.report(1, { type: 'route', path: '/customize/plugins' })
    expect(r.service.getState()).toEqual({ available: true, tabId: 9 })
  })

  it('dispose releases the channel listeners', async () => {
    const fake = fakeHost()
    const r = rig(() => fake.host)
    await r.call('show', { url: PAGE })
    r.reg.dispose()
    expect(fake.listenerCount()).toBe(0)
  })
})
