// @vitest-environment happy-dom
/**
 * The Customize screen (F-35): the utility tab's show / unavailable cycle,
 * the left list of the directory and the marketplaces, the top bar's status
 * and Add for the item the page shows, and a marketplace's plugin list.
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

/** A connection whose `show` answers come from `answers`, in order; the last one repeats. */
function fakeConnection(answers: Array<'ok' | 'fail'>) {
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

/** A settings bridge with one marketplace list; every request is recorded. */
function fakeBridge(
  options: {
    marketplaces?: Array<{ name: string; isOfficial?: boolean }>
    manifests?: Record<string, { plugins: Array<Record<string, unknown>> } | null>
    installFails?: boolean
  } = {},
) {
  const requests: string[] = []
  const manifests = { ...(options.manifests ?? {}) }
  const bridge = {
    request: async (route: Route, payload: Record<string, unknown>) => {
      const key = `${route.capability}.${route.action}`
      requests.push(`${key} ${JSON.stringify(payload)}`)
      switch (key) {
        case 'plugins.listMarketplaces':
          return {
            marketplaces: (options.marketplaces ?? []).map(m => ({ isOfficial: false, isBuiltin: false, ...m })),
          }
        case 'plugins.listMarketplacePlugins': {
          const manifest = manifests[payload.marketplace as string]
          if (manifest === undefined) throw new Error('unknown marketplace')
          return { marketplace: payload.marketplace, manifest: manifest && { name: payload.marketplace, ...manifest } }
        }
        case 'plugins.refreshMarketplace':
          manifests[payload.name as string] = { plugins: [] }
          return { ok: true, pluginCount: 0, manifest: null }
        case 'plugins.install': {
          if (options.installFails) throw new Error('blocked')
          const [name, market] = (payload.identifier as string).split('@')
          for (const plugin of manifests[market!]?.plugins ?? []) if (plugin.name === name) plugin.installed = true
          return { ok: true }
        }
        default:
          throw new Error(`unexpected ${key}`)
      }
    },
  } as unknown as NexusSettingsBridge
  return { bridge, requests }
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
  it('lists the directory first, then the marketplaces with the official ones first, and no segmented control', async () => {
    const fake = fakeConnection(['ok'])
    const { bridge } = fakeBridge({
      marketplaces: [{ name: 'team-tools' }, { name: 'official-market', isOfficial: true }],
    })
    const view = screen(fake.getConnection, { bridge })
    await waitFor(() => expect(view.getAllByTestId('customize-market')).toHaveLength(2))
    const directory = view.getByTestId('customize-market-directory')
    expect(directory.getAttribute('aria-current')).toBe('page')
    expect(directory.textContent).toContain(EN_MESSAGES['customize.directory.title'])
    expect(view.getAllByTestId('customize-market').map(row => row.getAttribute('data-name'))).toEqual([
      'official-market',
      'team-tools',
    ])
    expect(view.getAllByTestId('customize-market')[0]!.textContent).toContain(EN_MESSAGES['customize.markets.official'])
    expect(view.getByTestId('customize-title').textContent).toBe(EN_MESSAGES['customize.directory.title'])
    expect(view.queryByRole('tablist')).toBeNull()
    expect(fake.shows).toEqual([{ url: directoryUrl() }])
  })

  it('a marketplace takes the page area, and choosing the directory again shows the tab again', async () => {
    const fake = fakeConnection(['ok'])
    const { bridge } = fakeBridge({ marketplaces: [{ name: 'team-tools' }], manifests: { 'team-tools': { plugins: [] } } })
    const view = screen(fake.getConnection, { bridge })
    await waitFor(() => expect(fake.shows).toHaveLength(1))
    fireEvent.click(await view.findByTestId('customize-market'))
    expect(view.queryByTestId('webview-area')).toBeNull()
    expect(view.getByTestId('customize-title').textContent).toBe('team-tools')
    expect((await view.findByTestId('customize-market-empty')).textContent).toBe(EN_MESSAGES['customize.market.empty'])

    fireEvent.click(view.getByTestId('customize-market-directory'))
    expect(view.queryByTestId('webview-area')).not.toBeNull()
    await waitFor(() => expect(fake.shows).toHaveLength(2))
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

describe('CustomizeScreen — a marketplace', () => {
  async function opened(bridgeOptions: Parameters<typeof fakeBridge>[0]) {
    const fake = fakeConnection(['ok'])
    const b = fakeBridge({ marketplaces: [{ name: 'team-tools' }], ...bridgeOptions })
    const view = screen(fake.getConnection, { bridge: b.bridge })
    fireEvent.click(await view.findByTestId('customize-market'))
    return { view, requests: b.requests }
  }

  it('lists its plugins, Add installs one by identifier and the list then reads Installed', async () => {
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
    fireEvent.click(view.getByTestId('customize-market-add'))
    await waitFor(() => expect(view.queryByTestId('customize-market-add')).toBeNull())
    expect(requests).toContain('plugins.install {"identifier":"lint@team-tools","refreshFirst":false}')
    expect(view.getAllByTestId('customize-market-installed')).toHaveLength(2)
  })

  it('a failed install says so on its row and keeps Add', async () => {
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

  it('one never downloaded offers Download, which fetches it and reads it again', async () => {
    const { view, requests } = await opened({ manifests: { 'team-tools': null } })
    const note = await view.findByTestId('customize-market-not-fetched')
    expect(note.textContent).toContain(EN_MESSAGES['customize.market.notFetched'])
    fireEvent.click(view.getByTestId('customize-market-download'))
    await view.findByTestId('customize-market-empty')
    expect(requests).toContain('plugins.refreshMarketplace {"name":"team-tools"}')
  })

  it('one that cannot be read says so', async () => {
    const { view } = await opened({ manifests: {} })
    expect((await view.findByTestId('customize-market-failed')).textContent).toBe(EN_MESSAGES['customize.market.loadFailed'])
  })
})
