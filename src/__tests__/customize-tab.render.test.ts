// @vitest-environment happy-dom
/**
 * The Customize screen (F-35): the utility tab's show / unavailable cycle,
 * the left list of the directory and the marketplaces, the top bar's page
 * Home / Back and the status and Add for the item the page shows, the dialog
 * the page's own add button opens, the marketplaces' start page with cards
 * and detail pages, and adding and removing a marketplace.
 */
import { afterEach, describe, expect, it } from 'vitest'
import { createElement } from 'react'
import { act, cleanup, fireEvent, render, renderHook, waitFor } from '@testing-library/react'

import type { RuntimeConnection } from '../browser/runtimeClient/RuntimeConnection'
import { useCustomizeTab } from '../browser/webview/customize/useCustomizeTab'
import { CustomizeScreen } from '../browser/webview/customize/CustomizeScreen'
import { directoryUrl } from '../browser/webview/customize/customizeRoutes'
import { en as EN_MESSAGES } from '../browser/webview/i18n/messages/en'
import { SettingsBridgeContext, type NexusSettingsBridge } from '../browser/webview/nexusSettingsBridge'

afterEach(() => cleanup())

const STATUS = 'customizePage/status'
type Handler = (event: { type?: string; payload: unknown }) => void

/**
 * A connection whose `show` answers come from `answers`, in order; the last
 * one repeats. `described` is what `describeMarketplace` answers.
 */
function fakeConnection(answers: Array<'ok' | 'fail'>, described: Record<string, unknown> = {}) {
  const handlers = new Map<string, Handler>()
  const shows: unknown[] = []
  const answered: string[] = []
  const connection = {
    subscribe: (topic: string, handler: Handler) => {
      handlers.set(topic, handler)
      return () => handlers.delete(topic)
    },
    can: () => true,
    request: async (route: string, payload: unknown) => {
      if (route !== 'customizePage.show') {
        answered.push(`${route} ${JSON.stringify(payload)}`)
        if (route === 'customizePage.describeMarketplace') return { plugins: described }
        return { ok: true }
      }
      shows.push(payload)
      const answer = answers[Math.min(shows.length - 1, answers.length - 1)]
      if (answer === 'fail') throw new Error('UI_ERROR: openUtilityTab: no tab was created')
      return { tabId: 7, created: shows.length === 1 }
    },
  } as unknown as RuntimeConnection
  return {
    getConnection: async () => connection,
    status: (payload: unknown) => handlers.get(STATUS)?.({ type: 'state', payload }),
    subscribed: () => handlers.has(STATUS),
    shows,
    answered,
  }
}

describe('useCustomizeTab — a show that fails', () => {
  it('a refused show marks the tab unavailable, and retry shows it again', async () => {
    const fake = fakeConnection(['fail', 'ok'])
    const { result } = renderHook(() => useCustomizeTab(fake.getConnection, true))
    expect(result.current.unavailable).toBe(false)
    await waitFor(() => expect(result.current.unavailable).toBe(true))
    expect(fake.shows).toHaveLength(1)

    act(() => result.current.retry())
    expect(result.current.unavailable).toBe(false)
    await waitFor(() => expect(fake.shows).toHaveLength(2))
    await act(async () => {})
    expect(result.current.unavailable).toBe(false)
  })

  it('a successful show stays available', async () => {
    const fake = fakeConnection(['ok'])
    const { result } = renderHook(() => useCustomizeTab(fake.getConnection, true))
    await waitFor(() => expect(fake.shows).toHaveLength(1))
    await act(async () => {})
    expect(result.current.unavailable).toBe(false)
  })

  it('a connection that cannot be had counts as a failed show', async () => {
    const getConnection = () => Promise.reject(new Error('no runtime'))
    const { result } = renderHook(() => useCustomizeTab(getConnection, true))
    await waitFor(() => expect(result.current.unavailable).toBe(true))
  })

  it('no runtime connection at all is unavailable', () => {
    const { result } = renderHook(() => useCustomizeTab(undefined, true))
    expect(result.current.unavailable).toBe(true)
  })

  it('a closed screen asks nothing and reports nothing', async () => {
    const fake = fakeConnection(['fail'])
    const { result } = renderHook(() => useCustomizeTab(fake.getConnection, false))
    await act(async () => {})
    expect(fake.shows).toHaveLength(0)
    expect(result.current.unavailable).toBe(false)
  })
})

describe('useCustomizeTab — the host port', () => {
  it('available: false is unavailable, and the port coming back shows the tab again', async () => {
    const fake = fakeConnection(['fail', 'ok'])
    const { result } = renderHook(() => useCustomizeTab(fake.getConnection, true))
    await waitFor(() => expect(fake.subscribed()).toBe(true))
    act(() => fake.status({ available: false }))
    expect(result.current.unavailable).toBe(true)
    await waitFor(() => expect(fake.shows).toHaveLength(1))

    act(() => fake.status({ available: true }))
    await waitFor(() => expect(fake.shows).toHaveLength(2))
    act(() => fake.status({ available: true, tabId: 7 }))
    await waitFor(() => expect(result.current.unavailable).toBe(false))
    expect(result.current.tabId).toBe(7)
  })

  it('an available host that was never missing asks for no extra show', async () => {
    const fake = fakeConnection(['ok'])
    renderHook(() => useCustomizeTab(fake.getConnection, true))
    await waitFor(() => expect(fake.subscribed()).toBe(true))
    act(() => fake.status({ available: true }))
    act(() => fake.status({ available: true, tabId: 7 }))
    await act(async () => {})
    expect(fake.shows).toHaveLength(1)
  })
})

/** Flips `document.visibilityState` and fires `visibilitychange`, as a parked page does. */
function setVisibility(state: 'visible' | 'hidden') {
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => state })
  document.dispatchEvent(new Event('visibilitychange'))
}

describe('useCustomizeTab — the page turning visible again', () => {
  afterEach(() => setVisibility('visible'))

  it('a page reopened from the tray shows the tab again, at the directory', async () => {
    const fake = fakeConnection(['ok'])
    renderHook(() => useCustomizeTab(fake.getConnection, true))
    await waitFor(() => expect(fake.subscribed()).toBe(true))
    act(() => fake.status({ available: true, tabId: 7, path: '/directory/slack' }))
    expect(fake.shows).toHaveLength(1)

    act(() => setVisibility('hidden'))
    await act(async () => {})
    expect(fake.shows).toHaveLength(1)

    act(() => setVisibility('visible'))
    await waitFor(() => expect(fake.shows).toHaveLength(2))
    expect(fake.shows[1]).toEqual({ url: directoryUrl() })
  })

  it('a closed screen does not show the tab when the page turns visible', async () => {
    const fake = fakeConnection(['ok'])
    const { rerender } = renderHook(({ open }) => useCustomizeTab(fake.getConnection, open), {
      initialProps: { open: true },
    })
    await waitFor(() => expect(fake.shows).toHaveLength(1))
    rerender({ open: false })
    act(() => setVisibility('hidden'))
    act(() => setVisibility('visible'))
    await act(async () => {})
    expect(fake.shows).toHaveLength(1)
  })
})

type Route = { capability: string; action: string }

type FakeMarket = { name: string; isOfficial?: boolean; isBuiltin?: boolean }
type AddAnswer = Record<string, unknown> | Error

/**
 * A settings bridge with one marketplace list; every request is recorded.
 * A refresh keeps what a marketplace lists (a never-downloaded one becomes
 * empty) unless `refreshFails`; `holdRefresh` keeps refreshes pending until
 * `release()`. `addAnswers` answer `addMarketplace` in order; an `added`
 * answer joins the list.
 */
function fakeBridge(
  options: {
    marketplaces?: FakeMarket[]
    manifests?: Record<string, { plugins: Array<Record<string, unknown>> } | null>
    installFails?: boolean
    refreshFails?: boolean
    holdRefresh?: boolean
    addAnswers?: AddAnswer[]
    removeFails?: boolean
  } = {},
) {
  const requests: string[] = []
  const manifests = { ...(options.manifests ?? {}) }
  const markets: FakeMarket[] = [...(options.marketplaces ?? [])]
  const control = { refreshFails: options.refreshFails ?? false }
  let release: () => void = () => {}
  const held = options.holdRefresh ? new Promise<void>(resolve => (release = resolve)) : Promise.resolve()
  const addAnswers = [...(options.addAnswers ?? [])]
  const bridge = {
    request: async (route: Route, payload: Record<string, unknown>) => {
      const key = `${route.capability}.${route.action}`
      requests.push(`${key} ${JSON.stringify(payload)}`)
      switch (key) {
        case 'plugins.listMarketplaces':
          return { marketplaces: markets.map(m => ({ isOfficial: false, isBuiltin: false, ...m })) }
        case 'plugins.listMarketplacePlugins': {
          const manifest = manifests[payload.marketplace as string]
          if (manifest === undefined) throw new Error('unknown marketplace')
          return { marketplace: payload.marketplace, manifest: manifest && { name: payload.marketplace, ...manifest } }
        }
        case 'plugins.refreshMarketplace': {
          await held
          if (control.refreshFails) throw new Error('offline')
          const name = payload.name as string
          if (manifests[name] === null) manifests[name] = { plugins: [] }
          return { ok: true, pluginCount: 0, manifest: null }
        }
        case 'plugins.install': {
          if (options.installFails) throw new Error('blocked')
          const [name, market] = (payload.identifier as string).split('@')
          for (const plugin of manifests[market!]?.plugins ?? []) if (plugin.name === name) plugin.installed = true
          return { ok: true }
        }
        case 'plugins.addMarketplace': {
          const answer = addAnswers.shift() ?? new Error('no answer')
          if (answer instanceof Error) throw answer
          if (answer.status === 'added') {
            markets.push({ name: answer.name as string })
            manifests[answer.name as string] = { plugins: [{ name: 'fresh', installed: false }] }
          }
          return answer
        }
        case 'plugins.removeMarketplace': {
          if (options.removeFails) throw new Error('disk full')
          const at = markets.findIndex(m => m.name === payload.name)
          if (at >= 0) markets.splice(at, 1)
          return { ok: true, removed: at >= 0 }
        }
        default:
          throw new Error(`unexpected ${key}`)
      }
    },
  } as unknown as NexusSettingsBridge
  return { bridge, requests, control, release: () => release() }
}

function screen(
  getConnection: () => Promise<RuntimeConnection>,
  options: { bridge?: NexusSettingsBridge; onOpenSettings?: (section: string) => void } = {},
) {
  return render(
    createElement(
      SettingsBridgeContext.Provider,
      { value: options.bridge ?? null },
      createElement(CustomizeScreen, {
        runtimeConnection: getConnection,
        shell: null,
        onClose: () => {},
        onOpenSettings: options.onOpenSettings ?? (() => {}),
      }),
    ),
  )
}

describe('CustomizeScreen — the unavailable state', () => {
  it('replaces the placeholder with a message and a retry, and the retry brings the placeholder back', async () => {
    const fake = fakeConnection(['fail', 'ok'])
    const view = screen(fake.getConnection)
    expect(view.queryByTestId('webview-area')).not.toBeNull()

    await waitFor(() => expect(view.queryByTestId('customize-unavailable')).not.toBeNull())
    expect(view.queryByTestId('webview-area')).toBeNull()
    expect(view.getByTestId('customize-unavailable').textContent).toContain(EN_MESSAGES['customize.unavailable'])
    const retry = view.getByTestId('customize-retry')
    expect(retry.textContent).toBe(EN_MESSAGES['customize.retry'])

    fireEvent.click(retry)
    await waitFor(() => expect(fake.shows).toHaveLength(2))
    await act(async () => {})
    expect(view.queryByTestId('customize-unavailable')).toBeNull()
    expect(view.queryByTestId('webview-area')).not.toBeNull()
  })
})

describe('CustomizeScreen — the left list', () => {
  it('lists the directory first, then the marketplaces added here by name; official and built-in ones are left out', async () => {
    const fake = fakeConnection(['ok'])
    const { bridge } = fakeBridge({
      marketplaces: [
        { name: 'team-tools' },
        { name: 'official-market', isOfficial: true },
        { name: 'product-builtin', isBuiltin: true },
        { name: 'alpha' },
      ],
      manifests: { 'team-tools': { plugins: [] }, alpha: { plugins: [] } },
    })
    const view = screen(fake.getConnection, { bridge })
    await waitFor(() => expect(view.getAllByTestId('customize-market')).toHaveLength(2))
    const directory = view.getByTestId('customize-market-directory')
    expect(directory.getAttribute('aria-current')).toBe('page')
    expect(directory.textContent).toContain(EN_MESSAGES['customize.directory.title'])
    expect(view.getAllByTestId('customize-market').map(row => row.getAttribute('data-name'))).toEqual(['alpha', 'team-tools'])
    expect(view.getByTestId('customize-title').textContent).toBe(EN_MESSAGES['customize.directory.title'])
    expect(view.queryByRole('tablist')).toBeNull()
    expect(fake.shows).toEqual([{ url: directoryUrl() }])
  })

  it('with nothing added, the list says so and still offers Add', async () => {
    const fake = fakeConnection(['ok'])
    const { bridge } = fakeBridge({ marketplaces: [{ name: 'official-market', isOfficial: true }] })
    const view = screen(fake.getConnection, { bridge })
    expect((await view.findByTestId('customize-markets-none')).textContent).toBe(EN_MESSAGES['customize.markets.none'])
    expect(view.getByTestId('customize-market-add-open').getAttribute('aria-label')).toBe(EN_MESSAGES['customize.addMarket.open'])
  })

  it('a marketplace shows the start page scrolled to its section; the directory shows the tab again', async () => {
    const scrolled: string[] = []
    const original = Element.prototype.scrollIntoView
    Element.prototype.scrollIntoView = function (this: Element) {
      scrolled.push(this.getAttribute('data-marketplace') ?? '')
    }
    try {
      const fake = fakeConnection(['ok'])
      const { bridge } = fakeBridge({
        marketplaces: [{ name: 'alpha' }, { name: 'team-tools' }],
        manifests: { alpha: { plugins: [] }, 'team-tools': { plugins: [] } },
      })
      const view = screen(fake.getConnection, { bridge })
      await waitFor(() => expect(fake.shows).toHaveLength(1))
      await waitFor(() => expect(view.getAllByTestId('customize-market')).toHaveLength(2))
      fireEvent.click(view.getAllByTestId('customize-market')[1]!)
      expect(view.queryByTestId('webview-area')).toBeNull()
      expect(view.getByTestId('customize-title').textContent).toBe(EN_MESSAGES['customize.browse.title'])
      expect(view.getAllByTestId('customize-market-section').map(s => s.getAttribute('data-marketplace'))).toEqual([
        'alpha',
        'team-tools',
      ])
      expect(scrolled).toEqual(['team-tools'])
      expect(view.getAllByTestId('customize-market')[1]!.getAttribute('aria-current')).toBe('page')

      // Choosing it again scrolls to it again.
      fireEvent.click(view.getAllByTestId('customize-market')[1]!)
      expect(scrolled).toEqual(['team-tools', 'team-tools'])

      fireEvent.click(view.getByTestId('customize-market-directory'))
      expect(view.queryByTestId('webview-area')).not.toBeNull()
      await waitFor(() => expect(fake.shows).toHaveLength(2))
    } finally {
      Element.prototype.scrollIntoView = original
    }
  })
})

describe('CustomizeScreen — the item the page shows', () => {
  const details = { name: 'Slack', publisher: 'Slack', summary: 'Chat' }

  it('a page with no item shows nothing on the right of the top bar', async () => {
    const fake = fakeConnection(['ok'])
    const view = screen(fake.getConnection)
    await waitFor(() => expect(fake.subscribed()).toBe(true))
    act(() => fake.status({ available: true, tabId: 7, path: '/directory' }))
    expect(view.queryByTestId('customize-item')).toBeNull()
    expect(view.queryByTestId('webview-area')).not.toBeNull()
  })

  it('resolving, then Add, which asks the runtime to install it, then Adding…', async () => {
    const fake = fakeConnection(['ok'])
    const view = screen(fake.getConnection)
    await waitFor(() => expect(fake.subscribed()).toBe(true))
    act(() => fake.status({ available: true, tabId: 7, pageItem: { id: 4, kind: 'connector', phase: 'resolving' } }))
    expect(view.getByTestId('customize-item').textContent).toContain(EN_MESSAGES['customize.item.resolving'])
    expect(view.queryByTestId('webview-area')).not.toBeNull()

    const ready = { id: 4, kind: 'connector', phase: 'ready', details, alreadyInstalled: false, installable: true }
    act(() => fake.status({ available: true, tabId: 7, pageItem: ready }))
    expect(view.getByTestId('customize-item-name').textContent).toBe('Slack')
    expect(view.getByTestId('customize-item').textContent).toContain(EN_MESSAGES['customize.item.kind.connector'])
    const add = view.getByTestId('customize-item-add')
    expect(add.textContent).toBe(EN_MESSAGES['customize.item.add'])
    fireEvent.click(add)
    await waitFor(() => expect(fake.answered).toEqual(['customizePage.addPageItem {"id":4}']))

    act(() => fake.status({ available: true, tabId: 7, pageItem: { ...ready, phase: 'installing' } }))
    expect((view.getByTestId('customize-item-add') as HTMLButtonElement).disabled).toBe(true)
    expect(view.getByTestId('customize-item-add').textContent).toBe(EN_MESSAGES['customize.item.adding'])
  })

  it('an installed item shows where it is installed and Manage opens its Settings page', async () => {
    const fake = fakeConnection(['ok'])
    const opened: string[] = []
    const view = screen(fake.getConnection, { onOpenSettings: section => opened.push(section) })
    await waitFor(() => expect(fake.subscribed()).toBe(true))
    act(() =>
      fake.status({
        available: true,
        pageItem: { id: 5, kind: 'connector', phase: 'ready', details, alreadyInstalled: true, installable: true, installedAs: 'chat' },
      }),
    )
    expect(view.getByTestId('customize-item-installed').textContent).toBe('Installed as chat')
    expect(view.queryByTestId('customize-item-add')).toBeNull()
    fireEvent.click(view.getByTestId('customize-item-manage'))
    act(() =>
      fake.status({
        available: true,
        pageItem: { id: 6, kind: 'plugin', phase: 'installed', details, installedAs: 'slack@market' },
      }),
    )
    expect(view.getByTestId('customize-item-installed').textContent).toBe('Installed as slack@market')
    fireEvent.click(view.getByTestId('customize-item-manage'))
    expect(opened).toEqual(['mcp', 'plugins'])
  })

  it('an item that cannot be added here and a failure say why; only a failed install offers Add again', async () => {
    const fake = fakeConnection(['ok'])
    const view = screen(fake.getConnection)
    await waitFor(() => expect(fake.subscribed()).toBe(true))
    const cases: Array<[Record<string, unknown>, string]> = [
      [{ phase: 'ready', kind: 'plugin', details, alreadyInstalled: false, installable: false }, EN_MESSAGES['customize.item.notInstallable.plugin']],
      [{ phase: 'ready', kind: 'connector', details, alreadyInstalled: false, installable: false }, EN_MESSAGES['customize.item.notInstallable.connector']],
      [{ phase: 'failed', kind: 'plugin', failure: 'not_found' }, EN_MESSAGES['customize.item.failed.notFound']],
      [{ phase: 'failed', kind: 'connector', failure: 'lookup_failed' }, EN_MESSAGES['customize.item.failed.lookup']],
      [{ phase: 'failed', kind: 'plugin', details, failure: 'install_failed' }, EN_MESSAGES['customize.item.failed.install']],
    ]
    for (const [pageItem, text] of cases) {
      act(() => fake.status({ available: true, pageItem: { id: 5, ...pageItem } }))
      expect(view.getByTestId('customize-item').textContent).toContain(text)
      expect(view.queryByTestId('customize-item-add')).toBeNull()
    }

    // A failed install of an installable item keeps Add, to try again.
    act(() =>
      fake.status({
        available: true,
        pageItem: { id: 5, phase: 'failed', kind: 'plugin', details, installable: true, alreadyInstalled: false, failure: 'install_failed' },
      }),
    )
    expect(view.getByTestId('customize-item-failed').textContent).toBe(EN_MESSAGES['customize.item.failed.install'])
    fireEvent.click(view.getByTestId('customize-item-add'))
    await waitFor(() => expect(fake.answered).toEqual(['customizePage.addPageItem {"id":5}']))
  })
})

describe('CustomizeScreen — the marketplaces\' start page', () => {
  async function opened(bridgeOptions: Parameters<typeof fakeBridge>[0]) {
    const fake = fakeConnection(['ok'])
    const b = fakeBridge({ marketplaces: [{ name: 'team-tools' }], ...bridgeOptions })
    const view = screen(fake.getConnection, { bridge: b.bridge })
    fireEvent.click((await view.findAllByTestId('customize-market'))[0]!)
    return { view, fake, ...b }
  }

  it('each opening fetches every list from its source, reads it again, then asks the directory about it', async () => {
    const { fake, requests } = await opened({
      marketplaces: [{ name: 'alpha' }, { name: 'team-tools' }],
      manifests: { alpha: { plugins: [] }, 'team-tools': { plugins: [] } },
    })
    await waitFor(() => expect(fake.answered.filter(a => a.startsWith('customizePage.describeMarketplace'))).toHaveLength(2))
    for (const name of ['alpha', 'team-tools']) {
      const reads = requests.filter(r => r === `plugins.listMarketplacePlugins ${JSON.stringify({ marketplace: name })}`)
      expect(reads).toHaveLength(2)
      expect(requests).toContain(`plugins.refreshMarketplace ${JSON.stringify({ name })}`)
      expect(requests.indexOf(`plugins.refreshMarketplace ${JSON.stringify({ name })}`)).toBeLessThan(
        requests.lastIndexOf(`plugins.listMarketplacePlugins ${JSON.stringify({ marketplace: name })}`),
      )
    }
  })

  it('lists its plugins, Add installs one by identifier and the card then reads Installed', async () => {
    const { view, requests } = await opened({
      manifests: {
        'team-tools': {
          plugins: [
            { name: 'lint', description: 'Lints things', author: { name: 'Acme' }, installed: false },
            { name: 'docs', installed: true },
          ],
        },
      },
    })
    const rows = await view.findAllByTestId('customize-market-plugin')
    expect(rows.map(row => row.getAttribute('data-name'))).toEqual(['lint', 'docs'])
    expect(rows[0]!.textContent).toContain('By Acme')
    expect(rows[1]!.textContent).toContain(EN_MESSAGES['customize.item.installed'])
    expect(view.getByTestId('customize-market-section').textContent).toContain('2 plugins')
    fireEvent.click(view.getByTestId('customize-market-add'))
    await waitFor(() => expect(view.queryByTestId('customize-market-add')).toBeNull())
    expect(requests).toContain('plugins.install {"identifier":"lint@team-tools","refreshFirst":false}')
    expect(view.getAllByTestId('customize-market-installed')).toHaveLength(2)
  })

  it('a section shows ten cards and Show all, which lists every plugin and returns to the start page', async () => {
    const plugins = Array.from({ length: 12 }, (_, i) => ({ name: `p${String(i).padStart(2, '0')}`, installed: false }))
    const { view } = await opened({ manifests: { 'team-tools': { plugins } } })
    await waitFor(() => expect(view.getAllByTestId('customize-market-plugin')).toHaveLength(10))
    const showAll = view.getByTestId('customize-market-show-all')
    expect(showAll.textContent).toContain(EN_MESSAGES['customize.browse.showAll'].replace('{count}', '12'))

    fireEvent.click(showAll)
    expect(view.getByTestId('customize-market-all')).not.toBeNull()
    expect(view.getAllByTestId('customize-market-plugin')).toHaveLength(12)
    expect(view.queryByTestId('customize-market-show-all')).toBeNull()

    fireEvent.click(view.getByTestId('customize-market-all-back'))
    expect(view.getByTestId('customize-browse')).not.toBeNull()
    expect(view.getAllByTestId('customize-market-plugin')).toHaveLength(10)
  })

  it('ten or fewer plugins offer no Show all', async () => {
    const plugins = Array.from({ length: 10 }, (_, i) => ({ name: `p${i}`, installed: false }))
    const { view } = await opened({ manifests: { 'team-tools': { plugins } } })
    await waitFor(() => expect(view.getAllByTestId('customize-market-plugin')).toHaveLength(10))
    expect(view.queryByTestId('customize-market-show-all')).toBeNull()
  })

  it('a fetch under way shows Checking for updates on its section, gone once it ends', async () => {
    const { view, release } = await opened({
      manifests: { 'team-tools': { plugins: [{ name: 'lint', installed: false }] } },
      holdRefresh: true,
    })
    const updating = await view.findByTestId('customize-market-refreshing')
    expect(updating.textContent).toBe(EN_MESSAGES['customize.browse.updating'])
    expect(view.getAllByTestId('customize-market-plugin')).toHaveLength(1)
    release()
    await waitFor(() => expect(view.queryByTestId('customize-market-refreshing')).toBeNull())
  })

  it('one never downloaded is downloaded at once, saying so, then shows its list', async () => {
    const { view, release } = await opened({ manifests: { 'team-tools': null }, holdRefresh: true })
    await waitFor(() =>
      expect(view.getByTestId('customize-market-not-fetched').textContent).toContain(EN_MESSAGES['customize.browse.downloading']),
    )
    expect(view.queryByTestId('customize-market-download')).toBeNull()
    release()
    expect((await view.findByTestId('customize-market-empty')).textContent).toBe(EN_MESSAGES['customize.market.empty'])
  })

  it('a download that fails offers Download, which tries again', async () => {
    const { view, requests, control } = await opened({ manifests: { 'team-tools': null }, refreshFails: true })
    const download = await view.findByTestId('customize-market-download')
    expect(view.getByTestId('customize-market-not-fetched').textContent).toContain(EN_MESSAGES['customize.market.notFetched'])
    control.refreshFails = false
    fireEvent.click(download)
    await view.findByTestId('customize-market-empty')
    expect(requests.filter(r => r === 'plugins.refreshMarketplace {"name":"team-tools"}')).toHaveLength(2)
  })

  it('a failed install says so on its card and keeps Add', async () => {
    const { view } = await opened({
      manifests: { 'team-tools': { plugins: [{ name: 'lint', installed: false }] } },
      installFails: true,
    })
    fireEvent.click(await view.findByTestId('customize-market-add'))
    await waitFor(() =>
      expect(view.getByTestId('customize-market-plugin').textContent).toContain(EN_MESSAGES['customize.item.failed.install']),
    )
    expect((view.getByTestId('customize-market-add') as HTMLButtonElement).disabled).toBe(false)
  })

  it('one that cannot be read says so', async () => {
    const { view } = await opened({ manifests: {} })
    expect((await view.findByTestId('customize-market-failed')).textContent).toBe(EN_MESSAGES['customize.market.loadFailed'])
  })
})

describe('CustomizeScreen — adding a marketplace', () => {
  async function opened(bridgeOptions: Parameters<typeof fakeBridge>[0]) {
    const fake = fakeConnection(['ok'])
    const b = fakeBridge(bridgeOptions)
    const view = screen(fake.getConnection, { bridge: b.bridge })
    await waitFor(() => expect(fake.shows).toHaveLength(1))
    fireEvent.click(await view.findByTestId('customize-market-add-open'))
    const input = view.getByTestId('customize-add-market-input') as HTMLInputElement
    const type = (text: string) => fireEvent.change(input, { target: { value: text } })
    const confirm = () => fireEvent.click(view.getByTestId('customize-add-market-confirm'))
    return { view, fake, type, confirm, ...b }
  }

  it('opening it over the directory holds the page; text that is no repository is refused without a request', async () => {
    const { view, type, confirm, requests } = await opened({})
    expect(view.getByTestId('customize-add-market-dialog').textContent).toContain(EN_MESSAGES['customize.addMarket.description'])
    expect(view.queryByTestId('webview-area')).toBeNull()
    expect(view.getByTestId('customize-page-held')).not.toBeNull()
    expect((view.getByTestId('customize-add-market-confirm') as HTMLButtonElement).disabled).toBe(true)

    type('not a repository')
    confirm()
    const hint = view.getByTestId('customize-add-market-hint')
    expect(hint.textContent).toBe(EN_MESSAGES['customize.addMarket.invalid'])
    expect(view.getByTestId('customize-add-market-input').getAttribute('aria-invalid')).toBe('true')
    expect(requests.some(r => r.startsWith('plugins.addMarketplace'))).toBe(false)

    type('acme/too')
    expect(hint.textContent).toBe(EN_MESSAGES['customize.addMarket.hint'])
  })

  it('an added marketplace joins the list, the dialog closes, and the start page shows its section', async () => {
    const { view, type, confirm, requests } = await opened({
      addAnswers: [{ ok: true, status: 'added', name: 'acme-market', pluginCount: 1 }],
    })
    type('acme/tools')
    confirm()
    await waitFor(() => expect(view.queryByTestId('customize-add-market-dialog')).toBeNull())
    expect(requests).toContain('plugins.addMarketplace {"source":"acme/tools"}')
    const row = view.getAllByTestId('customize-market').find(r => r.getAttribute('data-name') === 'acme-market')!
    expect(row.getAttribute('aria-current')).toBe('page')
    expect(view.getByTestId('customize-title').textContent).toBe(EN_MESSAGES['customize.browse.title'])
    await waitFor(() => expect(view.getByTestId('customize-market-plugin').getAttribute('data-name')).toBe('fresh'))
  })

  it('a repository already added says under which name, and Show it goes there', async () => {
    const { view, type, confirm } = await opened({
      marketplaces: [{ name: 'acme-market' }],
      manifests: { 'acme-market': { plugins: [] } },
      addAnswers: [{ ok: true, status: 'alreadyAdded', name: 'acme-market' }],
    })
    type('https://github.com/acme/tools')
    confirm()
    const already = await view.findByTestId('customize-add-market-already')
    expect(already.textContent).toContain(EN_MESSAGES['customize.addMarket.already'].replace('{name}', 'acme-market'))
    fireEvent.click(view.getByTestId('customize-add-market-show'))
    await waitFor(() => expect(view.queryByTestId('customize-add-market-dialog')).toBeNull())
    expect(view.getByTestId('customize-market').getAttribute('aria-current')).toBe('page')
  })

  it('a repository that cannot be read says so with the reason, and the dialog stays to try again', async () => {
    const { view, type, confirm, requests } = await opened({
      addAnswers: [
        { ok: true, status: 'failed', stage: 'fetch', error: 'HTTP 404' },
        { ok: true, status: 'added', name: 'acme-market', pluginCount: 1 },
      ],
    })
    type('acme/missing')
    confirm()
    const failed = await view.findByTestId('customize-add-market-failed')
    expect(failed.textContent).toContain(EN_MESSAGES['customize.addMarket.fetchFailed'])
    expect(failed.textContent).toContain('HTTP 404')
    expect(view.queryAllByTestId('customize-market')).toHaveLength(0)

    confirm()
    await waitFor(() => expect(view.queryByTestId('customize-add-market-dialog')).toBeNull())
    expect(requests.filter(r => r.startsWith('plugins.addMarketplace'))).toHaveLength(2)
  })

  it('a refused request is a save failure', async () => {
    const { view, type, confirm } = await opened({ addAnswers: [new Error('not allowed')] })
    type('acme/tools')
    confirm()
    expect((await view.findByTestId('customize-add-market-failed')).textContent).toContain(
      EN_MESSAGES['customize.addMarket.saveFailed'],
    )
  })
})

describe('CustomizeScreen — removing a marketplace', () => {
  async function opened(bridgeOptions: Parameters<typeof fakeBridge>[0] = {}) {
    const fake = fakeConnection(['ok'])
    const b = fakeBridge({
      marketplaces: [{ name: 'alpha' }, { name: 'team-tools' }],
      manifests: { alpha: { plugins: [] }, 'team-tools': { plugins: [] } },
      ...bridgeOptions,
    })
    const view = screen(fake.getConnection, { bridge: b.bridge })
    await view.findAllByTestId('customize-market')
    return { view, ...b }
  }

  it('each row has a remove button that asks first, says what removing does, and Remove takes it off the list', async () => {
    const { view, requests } = await opened()
    const removes = view.getAllByTestId('customize-market-remove')
    expect(removes).toHaveLength(2)
    expect(removes[1]!.getAttribute('aria-label')).toBe(EN_MESSAGES['customize.removeMarket.open'].replace('{name}', 'team-tools'))
    fireEvent.click(removes[1]!)
    const dialog = view.getByTestId('customize-remove-market-dialog')
    expect(dialog.textContent).toContain(EN_MESSAGES['customize.removeMarket.title'].replace('{name}', 'team-tools'))
    expect(dialog.textContent).toContain(EN_MESSAGES['customize.removeMarket.description'])
    expect(view.queryByTestId('webview-area')).toBeNull()

    fireEvent.click(view.getByTestId('customize-remove-market-confirm'))
    await waitFor(() => expect(view.queryByTestId('customize-remove-market-dialog')).toBeNull())
    expect(requests).toContain('plugins.removeMarketplace {"name":"team-tools"}')
    expect(view.getAllByTestId('customize-market').map(r => r.getAttribute('data-name'))).toEqual(['alpha'])
    expect(view.queryByTestId('webview-area')).not.toBeNull()
  })

  it('a failed remove says so and keeps the marketplace', async () => {
    const { view } = await opened({ removeFails: true })
    fireEvent.click(view.getAllByTestId('customize-market-remove')[0]!)
    fireEvent.click(view.getByTestId('customize-remove-market-confirm'))
    await waitFor(() =>
      expect(view.getByTestId('customize-remove-market-dialog').textContent).toContain(
        EN_MESSAGES['customize.removeMarket.failed'],
      ),
    )
    expect(view.getAllByTestId('customize-market')).toHaveLength(2)
  })

  it('removing the last one while browsing leaves the start page empty, offering Add', async () => {
    const { view } = await opened({ marketplaces: [{ name: 'alpha' }], manifests: { alpha: { plugins: [] } } })
    fireEvent.click(view.getByTestId('customize-market'))
    fireEvent.click(view.getByTestId('customize-market-remove'))
    fireEvent.click(view.getByTestId('customize-remove-market-confirm'))
    const empty = await view.findByTestId('customize-browse-empty')
    expect(empty.textContent).toContain(EN_MESSAGES['customize.browse.empty'])
    fireEvent.click(view.getByTestId('customize-browse-add'))
    expect(view.getByTestId('customize-add-market-dialog')).not.toBeNull()
  })
})

describe('CustomizeScreen — the page controls', () => {
  it('Home and Back sit in the centre of the top bar; Back follows whether the page can go back', async () => {
    const fake = fakeConnection(['ok'])
    const view = screen(fake.getConnection)
    await waitFor(() => expect(fake.subscribed()).toBe(true))
    act(() => fake.status({ available: true, tabId: 7, path: '/directory', canGoBack: false }))
    const center = view.getByTestId('customize-center')
    const home = view.getByTestId('customize-page-home')
    const back = view.getByTestId('customize-page-back') as HTMLButtonElement
    expect(center.contains(home) && center.contains(back)).toBe(true)
    expect(home.getAttribute('aria-label')).toBe(EN_MESSAGES['customize.page.home'])
    expect(back.getAttribute('aria-label')).toBe(EN_MESSAGES['customize.page.back'])
    expect(back.disabled).toBe(true)

    act(() => fake.status({ available: true, tabId: 7, path: '/directory/slack', canGoBack: true }))
    expect(back.disabled).toBe(false)
    fireEvent.click(back)
    fireEvent.click(home)
    await waitFor(() => expect(fake.answered).toHaveLength(2))
    expect(fake.answered).toEqual([
      'customizePage.back {}',
      `customizePage.navigate ${JSON.stringify({ url: directoryUrl() })}`,
    ])
  })

  it('the item status shares the centre with them, and a marketplace hides both', async () => {
    const fake = fakeConnection(['ok'])
    const { bridge } = fakeBridge({ marketplaces: [{ name: 'team-tools' }], manifests: { 'team-tools': { plugins: [] } } })
    const view = screen(fake.getConnection, { bridge })
    await waitFor(() => expect(fake.subscribed()).toBe(true))
    act(() => fake.status({ available: true, tabId: 7, pageItem: { id: 4, kind: 'connector', phase: 'resolving' } }))
    expect(view.getByTestId('customize-center').contains(view.getByTestId('customize-item'))).toBe(true)
    fireEvent.click(await view.findByTestId('customize-market'))
    expect(view.queryByTestId('customize-page-home')).toBeNull()
    expect(view.queryByTestId('customize-item')).toBeNull()
  })
})

describe('CustomizeScreen — the page asks to add', () => {
  const ready = {
    id: 4,
    kind: 'plugin',
    phase: 'ready',
    installable: true,
    alreadyInstalled: false,
    details: {
      name: 'code-review',
      publisher: 'Acme',
      summary: 'Reviews pull requests',
      verified: true,
      components: [{ type: 'command', name: '/code-review', description: 'Review a PR' }],
    },
  }

  async function asked() {
    const fake = fakeConnection(['ok'])
    const settings: string[] = []
    const view = screen(fake.getConnection, { onOpenSettings: section => settings.push(section) })
    await waitFor(() => expect(fake.subscribed()).toBe(true))
    act(() => fake.status({ available: true, tabId: 7, pageItem: ready }))
    return { fake, view, settings }
  }

  it('an ask standing when the screen subscribed opens nothing', async () => {
    const fake = fakeConnection(['ok'])
    const view = screen(fake.getConnection)
    await waitFor(() => expect(fake.subscribed()).toBe(true))
    act(() => fake.status({ available: true, tabId: 7, pageItem: ready, addRequest: { seq: 3, itemId: 4 } }))
    expect(view.queryByTestId('customize-add-dialog')).toBeNull()
    act(() => fake.status({ available: true, tabId: 7, pageItem: ready, addRequest: { seq: 4, itemId: 4 } }))
    expect(view.queryByTestId('customize-add-dialog')).not.toBeNull()
  })

  it('a new ask confirms what will be added, hides the page under the dialog, and Add installs it', async () => {
    const { fake, view } = await asked()
    expect(view.queryByTestId('webview-area')).not.toBeNull()
    act(() => fake.status({ available: true, tabId: 7, pageItem: ready, addRequest: { seq: 1, itemId: 4 } }))
    const dialog = await view.findByTestId('customize-add-dialog')
    expect(view.getByTestId('customize-add-dialog-title').textContent).toBe('Add code-review to Velloc?')
    expect(dialog.textContent).toContain('Reviews pull requests')
    expect(dialog.textContent).toContain(EN_MESSAGES['customize.addDialog.whatPlugin'])
    expect(dialog.textContent).toContain('/code-review')
    expect(dialog.textContent).toContain(EN_MESSAGES['customize.detail.verified'])
    expect(view.queryByTestId('webview-area')).toBeNull()
    expect(view.queryByTestId('customize-page-held')).not.toBeNull()

    fireEvent.click(view.getByTestId('customize-add-dialog-confirm'))
    await waitFor(() => expect(fake.answered).toContain('customizePage.addPageItem {"id":4}'))
    act(() =>
      fake.status({ available: true, tabId: 7, pageItem: { ...ready, phase: 'installing' }, addRequest: { seq: 1, itemId: 4 } }),
    )
    expect(view.getByTestId('customize-add-dialog-confirm').textContent).toBe(EN_MESSAGES['customize.item.adding'])
    act(() =>
      fake.status({
        available: true,
        tabId: 7,
        pageItem: { ...ready, phase: 'installed', installedAs: 'code-review@market' },
        addRequest: { seq: 1, itemId: 4 },
      }),
    )
    expect(view.getByTestId('customize-add-dialog-title').textContent).toBe('code-review is added')
    expect(view.getByTestId('customize-add-dialog').textContent).toContain('Installed as code-review@market.')
    fireEvent.click(view.getByTestId('customize-add-dialog-done'))
    await waitFor(() => expect(view.queryByTestId('customize-add-dialog')).toBeNull())
    expect(view.queryByTestId('webview-area')).not.toBeNull()
  })

  it('Cancel installs nothing, and the same ask does not come back', async () => {
    const { fake, view } = await asked()
    act(() => fake.status({ available: true, tabId: 7, pageItem: ready, addRequest: { seq: 1, itemId: 4 } }))
    fireEvent.click(await view.findByTestId('customize-add-dialog-cancel'))
    await waitFor(() => expect(view.queryByTestId('customize-add-dialog')).toBeNull())
    act(() => fake.status({ available: true, tabId: 7, pageItem: ready, addRequest: { seq: 1, itemId: 4 } }))
    expect(view.queryByTestId('customize-add-dialog')).toBeNull()
    expect(fake.answered.filter(a => a.startsWith('customizePage.addPageItem'))).toEqual([])
  })

  it('an item this computer cannot add explains why and offers no Add', async () => {
    const { fake, view } = await asked()
    const blocked = { ...ready, installable: false }
    act(() => fake.status({ available: true, tabId: 7, pageItem: blocked, addRequest: { seq: 1, itemId: 4 } }))
    const dialog = await view.findByTestId('customize-add-dialog')
    expect(dialog.textContent).toContain(EN_MESSAGES['customize.addDialog.noSource'])
    expect(view.queryByTestId('customize-add-dialog-confirm')).toBeNull()
  })

  it('an installed item with a newer reviewed version says where to update it', async () => {
    const { fake, view } = await asked()
    const installed = { ...ready, alreadyInstalled: true, installedAs: 'code-review@plugin-directory', updateAvailable: true }
    act(() => fake.status({ available: true, tabId: 7, pageItem: installed, addRequest: { seq: 1, itemId: 4 } }))
    expect((await view.findByTestId('customize-add-dialog-update')).textContent).toBe(
      EN_MESSAGES['customize.addDialog.updateAvailable'],
    )
    act(() => fake.status({ available: true, tabId: 7, pageItem: { ...installed, updateAvailable: false }, addRequest: { seq: 1, itemId: 4 } }))
    expect(view.queryByTestId('customize-add-dialog-update')).toBeNull()
  })

  it('an item still being looked up waits with Add disabled', async () => {
    const { fake, view } = await asked()
    act(() =>
      fake.status({ available: true, tabId: 7, pageItem: { id: 5, kind: 'connector', phase: 'resolving' }, addRequest: { seq: 1, itemId: 5 } }),
    )
    expect((await view.findByTestId('customize-add-dialog-title')).textContent).toBe(EN_MESSAGES['customize.addDialog.lookingUp'])
    expect((view.getByTestId('customize-add-dialog-confirm') as HTMLButtonElement).disabled).toBe(true)
  })
})

describe('CustomizeScreen — a marketplace plugin\'s detail page', () => {
  const described = {
    lint: {
      name: 'Lint',
      summary: 'Finds problems',
      description: 'Checks every file you change.',
      publisher: 'Acme Inc',
      iconUrl: 'https://cdn.example/lint.png',
      verified: true,
      screenshots: ['https://cdn.example/shot.png'],
      components: [
        { type: 'skill', name: 'lint-rules', description: 'Knows the rules' },
        { type: 'command', name: '/lint' },
      ],
      links: { documentation: 'https://docs.example/lint' },
      updatedTime: '2026-10-23T22:41:42Z',
      pagePath: `/customize/plugins/id/b2be6e33-a55f-45ca-9453-3dabeb179a53@plugin-directory`,
    },
  }

  async function opened() {
    const fake = fakeConnection(['ok'], described)
    const b = fakeBridge({
      marketplaces: [{ name: 'team-tools' }],
      manifests: {
        'team-tools': {
          plugins: [
            { name: 'lint', description: 'Lints things', version: '1.2.0', author: { name: 'Acme' }, installed: false },
            { name: 'docs', description: 'Writes docs', installed: true },
          ],
        },
      },
    })
    const view = screen(fake.getConnection, { bridge: b.bridge })
    fireEvent.click(await view.findByTestId('customize-market'))
    await view.findAllByTestId('customize-market-plugin')
    await waitFor(() => expect(view.getAllByTestId('customize-market-plugin')[0]!.textContent).toContain('Finds problems'))
    return { fake, view, requests: b.requests }
  }

  it('cards show the directory\'s icon, publisher, summary and parts, and the listing for the rest', async () => {
    const { fake, view } = await opened()
    expect(fake.answered).toContain('customizePage.describeMarketplace {"marketplace":"team-tools"}')
    const [lint, docs] = view.getAllByTestId('customize-market-plugin')
    expect(lint!.textContent).toContain('By Acme Inc')
    expect(lint!.textContent).toContain(EN_MESSAGES['customize.detail.verified'])
    expect(lint!.textContent).toContain(`${EN_MESSAGES['customize.detail.parts.skills']} · 1`)
    expect(lint!.querySelector('img')?.getAttribute('src')).toBe('https://cdn.example/lint.png')
    expect(docs!.textContent).toContain('Writes docs')
  })

  it('a card opens its detail page with everything known, and back returns to the cards', async () => {
    const { view } = await opened()
    fireEvent.click(view.getAllByTestId('customize-market-open')[0]!)
    const detail = await view.findByTestId('customize-market-detail')
    expect(detail.textContent).toContain('Finds problems')
    expect(view.getByTestId('customize-detail-description').textContent).toBe('Checks every file you change.')
    expect(view.getByTestId('customize-included').textContent).toContain('lint-rules')
    expect(view.getByTestId('customize-screenshots').querySelector('img')?.getAttribute('src')).toBe('https://cdn.example/shot.png')
    const facts = view.getByTestId('customize-facts').textContent
    expect(facts).toContain('1.2.0')
    expect(facts).toContain('team-tools')
    expect(facts).toContain(EN_MESSAGES['customize.detail.links.documentation'])
    fireEvent.click(view.getByTestId('customize-market-detail-back'))
    expect(await view.findAllByTestId('customize-market-plugin')).toHaveLength(2)
  })

  it('Add on the detail page installs it; View in directory shows its directory page', async () => {
    const { fake, view, requests } = await opened()
    fireEvent.click(view.getAllByTestId('customize-market-open')[0]!)
    await view.findByTestId('customize-market-detail')
    fireEvent.click(view.getByTestId('customize-market-add'))
    await waitFor(() => expect(requests).toContain('plugins.install {"identifier":"lint@team-tools","refreshFirst":false}'))
    fireEvent.click(view.getByTestId('customize-market-in-directory'))
    await waitFor(() =>
      expect(fake.answered).toContain(
        `customizePage.navigate ${JSON.stringify({ url: directoryUrl().replace(/\/directory$/, described.lint.pagePath) })}`,
      ),
    )
    expect(view.getByTestId('customize-market-directory').getAttribute('aria-current')).toBe('page')
  })

  it('a plugin the directory does not carry still has a detail page from its listing', async () => {
    const { view } = await opened()
    fireEvent.click(view.getAllByTestId('customize-market-open')[1]!)
    const detail = await view.findByTestId('customize-market-detail')
    expect(detail.textContent).toContain('Writes docs')
    expect(view.getByTestId('customize-detail-not-listed').textContent).toBe(EN_MESSAGES['customize.detail.notInDirectory'])
    expect(view.queryByTestId('customize-market-in-directory')).toBeNull()
  })
})
