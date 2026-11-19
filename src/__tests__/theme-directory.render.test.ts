// @vitest-environment happy-dom
/**
 * The Customize screen's theme directory (F-35): the left row, the grid of
 * looks (packs under their own header, single themes as cards), and what
 * Add, Add & use and Use ask of the bridge and the runtime.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createElement } from 'react'
import { act, cleanup, fireEvent, render, waitFor, within } from '@testing-library/react'

import type { RuntimeConnection } from '../browser/runtimeClient/RuntimeConnection'
import { CustomizeScreen } from '../browser/webview/customize/CustomizeScreen'
import { createShellHandleOpenThemeStore } from '../browser/webview/shellSettingsActions'
import { INSTALL_TOAST_MS } from '../browser/webview/customize/InstallToasts'
import { PACK_LIMIT, packTitle } from '../browser/webview/customize/ThemeBrowser'
import type { ThemeTarget } from '../browser/webview/customize/useThemeCatalog'
import { en as EN } from '../browser/webview/i18n/messages/en'
import { SettingsBridgeContext, type NexusSettingsBridge } from '../browser/webview/nexusSettingsBridge'

afterEach(() => {
  vi.useRealTimers()
  cleanup()
})

type Listing = Record<string, unknown> & { name: string; installed: boolean }

const look = (id: string, appearance: 'light' | 'dark' | 'both', use = true) => ({
  id,
  name: id.toUpperCase(),
  description: `${id} look`,
  appearance,
  preview: `https://plugins.example/previews/${id}.svg`,
  ...(use ? { use: { command: 'pick-scene', args: id } } : {}),
})

const pack = (count = 2): Listing => ({
  name: 'scenes',
  description: 'Animated backdrops.',
  author: { name: 'Acme' },
  installed: false,
  theme: {
    official: true,
    looks: Array.from({ length: count }, (_, i) => look(`scene-${i}`, i % 2 === 0 ? 'light' : 'dark')),
  },
})

const single = (): Listing => ({
  name: 'snow',
  description: 'Falling snow.',
  author: { name: 'sam' },
  installed: false,
  theme: { looks: [{ ...look('snow', 'dark', false), name: 'Snow', description: undefined }] },
})

// A look applied to a session is remembered for the window: each setup takes a session of its own.
let sessions = 0

function setup(
  options: {
    themes?: Listing[] | 'fail'
    target?: ThemeTarget | null | 'busy'
    useAnswer?: unknown
    /** Answers to successive `theme.useLook` requests, before `useAnswer`. */
    useAnswers?: unknown[]
    /** `theme.useLook` waits for this before it answers. */
    useGate?: Promise<void>
    installFails?: boolean
    /** The session's published theme: a plugin's, or `null` for none. Left out: never published. */
    standing?: { plugin: string } | null
    /** The screen mounts with this request to show the theme directory. */
    themesRequest?: { seq: number } | null
  } = {},
) {
  const TARGET: ThemeTarget = { sessionId: `s${++sessions}`, title: 'Fix the build', busy: false }
  const themes = options.themes ?? [pack(), single()]
  const bridgeAsked: string[] = []
  const runtimeAsked: string[] = []
  let failing = themes === 'fail'
  const bridge = {
    request: async (route: { capability: string; action: string }, payload: Record<string, unknown>) => {
      const key = `${route.capability}.${route.action}`
      bridgeAsked.push(`${key} ${JSON.stringify(payload)}`)
      switch (key) {
        case 'plugins.listMarketplaces':
          return { marketplaces: [] }
        case 'plugins.listMarketplacePlugins':
          if (failing) throw new Error('unreadable')
          return {
            marketplace: payload.marketplace,
            manifest: { name: payload.marketplace, plugins: payload.kind === 'themes' && themes !== 'fail' ? themes : [] },
          }
        case 'plugins.refreshMarketplace':
          if (failing) throw new Error('offline')
          return { ok: true, pluginCount: 0, manifest: null }
        case 'plugins.install': {
          if (options.installFails) throw new Error('blocked')
          const name = (payload.identifier as string).split('@')[0]
          if (themes !== 'fail') for (const listing of themes) if (listing.name === name) listing.installed = true
          return { ok: true }
        }
        default:
          throw new Error(`unexpected ${key}`)
      }
    },
  } as unknown as NexusSettingsBridge
  const connection = {
    subscribe: () => () => {},
    can: () => true,
    request: async (route: string, payload: unknown) => {
      if (route === 'customizePage.show') return { tabId: 7, created: true }
      if (route === 'customizePage.describeMarketplace') return { plugins: {} }
      runtimeAsked.push(`${route} ${JSON.stringify(payload)}`)
      if (route === 'theme.useLook') {
        await options.useGate
        return options.useAnswers?.shift() ?? options.useAnswer ?? { ok: true, via: 'command' }
      }
      return { ok: true }
    },
  } as unknown as RuntimeConnection
  let closed = 0
  const screenWith = (themesRequest: { seq: number } | null) => createElement(CustomizeScreen, {
    runtimeConnection: async () => connection,
    shell: null,
    onClose: () => {
      closed += 1
    },
    onOpenSettings: () => {},
    themeTarget: options.target === undefined ? TARGET : options.target === 'busy' ? { ...TARGET, busy: true } : options.target,
    themeStanding: options.standing,
    themesRequest,
  })
  const wrap = (themesRequest: { seq: number } | null) =>
    createElement(SettingsBridgeContext.Provider, { value: bridge }, screenWith(themesRequest))
  const view = render(wrap(options.themesRequest ?? null))
  const open = async () => {
    fireEvent.click(view.getByTestId('customize-market-themes'))
    await waitFor(() => expect(view.queryByText(EN['customize.loading'])).toBeNull())
    // The list is read again after the fetch from its source: settle before asserting.
    await waitFor(() => expect(view.queryByTestId('customize-themes-refreshing')).toBeNull())
    await waitFor(() => expect(bridgeAsked.some(line => line.startsWith('plugins.refreshMarketplace'))).toBe(true))
    await act(async () => {
      await Promise.resolve()
    })
  }
  const card = (plugin: string, id: string) =>
    view.getAllByTestId('customize-theme-look').find(
      el => el.getAttribute('data-plugin') === plugin && el.getAttribute('data-look') === id,
    )!
  return {
    view,
    open,
    card,
    target: TARGET,
    bridgeAsked,
    runtimeAsked,
    closed: () => closed,
    requestThemes: (seq: number) => view.rerender(wrap({ seq })),
    heal: () => {
      failing = false
    },
  }
}

describe('Customize — the theme directory row', () => {
  it('sits under the plugin directory and shows the themes of the built-in marketplace', async () => {
    const { view, open, bridgeAsked } = setup()
    const rows = within(view.getByTestId('customize-markets')).getAllByRole('button')
    expect(rows[0]!.textContent).toContain(EN['customize.directory.title'])
    expect(rows[1]!.textContent).toContain(EN['customize.themes.title'])
    await act(async () => {
      await new Promise(resolve => setTimeout(resolve, 20))
    })
    expect(bridgeAsked.filter(line => line.includes('"kind":"themes"') || line.includes('"name":"velloc"'))).toEqual([])
    await open()
    expect(view.getByTestId('customize-title').textContent).toBe(EN['customize.themes.title'])
    expect(view.queryByTestId('webview-area')).toBeNull()
    expect(view.getByTestId('customize-market-themes').getAttribute('aria-current')).toBe('page')
    expect(bridgeAsked).toContain('plugins.listMarketplacePlugins {"marketplace":"velloc","kind":"themes"}')
    expect(bridgeAsked).toContain('plugins.refreshMarketplace {"name":"velloc"}')
  })
})

describe('Customize — opened for more themes', () => {
  it('the menu opener opens Customize with a new themes request each time', () => {
    let request: { seq: number } | null = null
    let opened = 0
    const open = createShellHandleOpenThemeStore(
      next => {
        request = typeof next === 'function' ? next(request) : next
      },
      () => {
        opened += 1
      },
    )
    open()
    expect(request).toEqual({ seq: 1 })
    open()
    expect(request).toEqual({ seq: 2 })
    expect(opened).toBe(2)
  })

  it('mounts on the theme directory, never on the plugin directory', async () => {
    const { view } = setup({ themesRequest: { seq: 1 } })
    expect(view.getByTestId('customize-market-themes').getAttribute('aria-current')).toBe('page')
    expect(view.getByTestId('customize-market-directory').getAttribute('aria-current')).toBeNull()
    expect(view.getByTestId('customize-title').textContent).toBe(EN['customize.themes.title'])
    expect(view.queryByTestId('webview-area')).toBeNull()
    await waitFor(() => expect(view.queryByText(EN['customize.loading'])).toBeNull())
  })

  it('a new request selects the theme directory again; the same one does not', async () => {
    const { view, requestThemes } = setup({ themesRequest: { seq: 1 } })
    await waitFor(() => expect(view.queryByText(EN['customize.loading'])).toBeNull())
    fireEvent.click(view.getByTestId('customize-market-directory'))
    expect(view.getByTestId('customize-market-directory').getAttribute('aria-current')).toBe('page')
    requestThemes(1)
    expect(view.getByTestId('customize-market-directory').getAttribute('aria-current')).toBe('page')
    requestThemes(2)
    await waitFor(() =>
      expect(view.getByTestId('customize-market-themes').getAttribute('aria-current')).toBe('page'),
    )
  })
})

describe('Theme directory — the grid', () => {
  it('a pack is a section of its looks; single themes follow under their heading', async () => {
    const { view, open } = setup()
    await open()
    const section = view.getByTestId('customize-theme-pack')
    expect(section.getAttribute('data-name')).toBe('scenes')
    expect(within(section).getByRole('heading').textContent).toBe('Scenes')
    expect([packTitle('theme-examples'), packTitle('looks'), packTitle('my_theme--pack'), packTitle('-')]).toEqual([
      'Theme examples',
      'Looks',
      'My theme pack',
      '-',
    ])
    expect(within(section).getByTestId('customize-theme-pack-count').textContent).toContain('2')
    expect(within(section).getByTestId('customize-theme-official')).toBeTruthy()
    expect(within(section).getAllByTestId('customize-theme-look').map(el => el.getAttribute('data-look'))).toEqual([
      'scene-0',
      'scene-1',
    ])
    const singles = view.getByTestId('customize-themes-singles')
    const items = within(singles).getAllByRole('listitem')
    expect(items).toHaveLength(1)
    expect(within(singles).getByText(EN['customize.themes.singles'])).toBeTruthy()
    expect(items[0]!.getAttribute('data-plugin')).toBe('snow')
    expect(items[0]!.textContent).toContain('Falling snow.')
    expect(view.getByTestId('customize-themes-target').textContent).toBe(
      EN['customize.themes.appliesTo'].replace('{title}', 'Fix the build'),
    )
    const picture = within(items[0]!).getByTestId('customize-theme-preview')
    expect(picture.getAttribute('src')).toBe('https://plugins.example/previews/snow.svg')
    expect(picture.getAttribute('referrerpolicy')).toBe('no-referrer')
    fireEvent.error(picture)
    expect(within(items[0]!).getByTestId('customize-theme-preview-fallback').textContent).toBe('S')
  })

  it('the appearance filter keeps matching looks, and a section left with none goes', async () => {
    const { view, open } = setup()
    await open()
    fireEvent.click(within(view.getByTestId('customize-themes-filter')).getByText(EN['customize.themes.filter.light']))
    expect(view.getAllByTestId('customize-theme-look').map(el => el.getAttribute('data-look'))).toEqual(['scene-0'])
    expect(view.queryByTestId('customize-themes-singles')).toBeNull()
    fireEvent.click(within(view.getByTestId('customize-themes-filter')).getByText(EN['customize.themes.filter.dark']))
    expect(view.getAllByTestId('customize-theme-look').map(el => el.getAttribute('data-look'))).toEqual([
      'scene-1',
      'snow',
    ])
  })

  it('a pack past its limit shows the rest on Show all', async () => {
    const { view, open } = setup({ themes: [pack(PACK_LIMIT + 2)] })
    await open()
    const section = view.getByTestId('customize-theme-pack')
    expect(within(section).getAllByTestId('customize-theme-look')).toHaveLength(PACK_LIMIT)
    fireEvent.click(within(section).getByTestId('customize-theme-pack-toggle'))
    expect(within(section).getAllByTestId('customize-theme-look')).toHaveLength(PACK_LIMIT + 2)
  })

  it('a list that cannot be read says so and reads again on Try again', async () => {
    const { view, open, heal } = setup({ themes: 'fail' })
    await open()
    expect(view.getByTestId('customize-themes-failed').textContent).toContain(EN['customize.themes.loadFailed'])
    heal()
    fireEvent.click(view.getByTestId('customize-themes-retry'))
    await waitFor(() => expect(view.getByTestId('customize-themes-empty')).toBeTruthy())
  })
})

describe('Theme directory — Add and Use', () => {
  it('Add & use on a pack look installs the plugin, then asks the runtime for that look', async () => {
    const { view, open, card, bridgeAsked, runtimeAsked, closed, target } = setup()
    await open()
    const button = within(card('scenes', 'scene-1')).getByTestId('customize-theme-add')
    expect(button.textContent).toBe(EN['customize.themes.addAndUse'])
    fireEvent.click(button)
    await waitFor(() => expect(runtimeAsked).toEqual([`theme.useLook {"sessionId":"${target.sessionId}","plugin":"scenes","lookId":"scene-1"}`]))
    expect(bridgeAsked).toContain('plugins.install {"identifier":"scenes@velloc"}')
    await waitFor(() => expect(within(card('scenes', 'scene-1')).getByTestId('customize-theme-in-use')).toBeTruthy())
    expect(within(card('scenes', 'scene-0')).getByTestId('customize-theme-use')).toBeTruthy()
    const notice = view.getByTestId('customize-theme-notice')
    expect(notice.getAttribute('data-kind')).toBe('applied')
    expect(notice.textContent).toContain('SCENE-1')
    fireEvent.click(view.getByTestId('customize-theme-notice-view'))
    expect(closed()).toBe(1)
  })

  it('Add & use asks again while the open session is still loading the new plugin', async () => {
    const { view, open, card, runtimeAsked } = setup({
      useAnswers: [{ ok: false, reason: 'notLoaded' }, { ok: false, reason: 'notOwnCommand' }],
    })
    await open()
    fireEvent.click(within(card('scenes', 'scene-1')).getByTestId('customize-theme-add'))
    await waitFor(() => expect(view.getByTestId('customize-theme-notice').getAttribute('data-kind')).toBe('applied'), {
      timeout: 4000,
    })
    expect(runtimeAsked).toHaveLength(3)
    expect(within(card('scenes', 'scene-1')).getByTestId('customize-theme-in-use')).toBeTruthy()
  })

  it('a refusal on Use is not asked again', async () => {
    const { view, open, card, runtimeAsked } = setup({
      themes: [{ ...pack(), installed: true }],
      useAnswer: { ok: false, reason: 'notLoaded' },
    })
    await open()
    fireEvent.click(within(card('scenes', 'scene-0')).getByTestId('customize-theme-use'))
    await waitFor(() => expect(view.getByTestId('customize-theme-notice').getAttribute('data-kind')).toBe('failed'))
    await new Promise(resolve => setTimeout(resolve, 700))
    expect(runtimeAsked).toHaveLength(1)
  })

  it('while one look is applied every other Use is off', async () => {
    let release!: () => void
    const useGate = new Promise<void>(resolve => {
      release = resolve
    })
    const { view, open, card, runtimeAsked } = setup({ themes: [{ ...pack(), installed: true }], useGate })
    await open()
    fireEvent.click(within(card('scenes', 'scene-0')).getByTestId('customize-theme-use'))
    await waitFor(() => expect(runtimeAsked).toHaveLength(1))
    const other = within(card('scenes', 'scene-1')).getByTestId('customize-theme-use') as HTMLButtonElement
    expect(other.disabled).toBe(true)
    await act(async () => {
      release()
    })
    await waitFor(() => expect(within(card('scenes', 'scene-0')).getByTestId('customize-theme-in-use')).toBeTruthy())
    expect((within(card('scenes', 'scene-1')).getByTestId('customize-theme-use') as HTMLButtonElement).disabled).toBe(false)
  })

  it('an install toast is drawn in the screen\'s one stack', async () => {
    const { view, open } = setup()
    await open()
    fireEvent.click(view.getByTestId('customize-theme-pack-add'))
    await waitFor(() => expect(view.getAllByTestId('customize-install-toasts')).toHaveLength(1))
    expect(view.getByTestId('customize-install-toasts').textContent).not.toBe('')
  })

  it('the pack header adds the plugin without picking a look', async () => {
    const { view, open, runtimeAsked } = setup()
    await open()
    fireEvent.click(view.getByTestId('customize-theme-pack-add'))
    await waitFor(() => expect(view.getByTestId('customize-theme-installed')).toBeTruthy())
    expect(runtimeAsked).toEqual([])
  })

  it('a single theme is added on its own and started in the session; Use then asks the runtime, and a refusal says why', async () => {
    const { view, open, card, runtimeAsked, target } = setup({ useAnswer: { ok: false, reason: 'notLoaded' } })
    await open()
    const add = within(card('snow', 'snow')).getByTestId('customize-theme-add')
    expect(add.textContent).toBe(EN['customize.item.add'])
    fireEvent.click(add)
    await waitFor(() => expect(within(card('snow', 'snow')).getByTestId('customize-theme-use')).toBeTruthy())
    const started = `theme.onEnable {"sessionId":"${target.sessionId}","plugin":"snow"}`
    await waitFor(() => expect(runtimeAsked).toEqual([started]))
    vi.useFakeTimers({ shouldAdvanceTime: true, toFake: ['setTimeout', 'clearTimeout'] })
    fireEvent.click(within(card('snow', 'snow')).getByTestId('customize-theme-use'))
    await waitFor(() => expect(view.getByTestId('customize-theme-notice').getAttribute('data-kind')).toBe('failed'))
    expect(runtimeAsked).toEqual([started, `theme.useLook {"sessionId":"${target.sessionId}","plugin":"snow","lookId":"snow"}`])
    expect(view.getByTestId('customize-theme-notice').textContent).toContain(EN['customize.themes.reason.notLoaded'])
    // A failure is not taken away by the clock: it stays until dismissed.
    act(() => {
      vi.advanceTimersByTime(INSTALL_TOAST_MS + 1)
    })
    vi.useRealTimers()
    expect(view.getByTestId('customize-theme-notice').getAttribute('data-kind')).toBe('failed')
    fireEvent.click(view.getByTestId('customize-theme-notice-dismiss'))
    expect(view.queryByTestId('customize-theme-notice')).toBeNull()
    expect(within(card('snow', 'snow')).queryByTestId('customize-theme-in-use')).toBeNull()
  })

  it('a failed install says so on the card and keeps Add', async () => {
    const { view, open, card } = setup({ installFails: true })
    await open()
    fireEvent.click(within(card('snow', 'snow')).getByTestId('customize-theme-add'))
    await waitFor(() => expect(card('snow', 'snow').textContent).toContain(EN['customize.item.failed.install']))
    expect(within(card('snow', 'snow')).getByTestId('customize-theme-add')).toBeTruthy()
  })


  it('with no session, or a turn running, Use is off with the reason and a pack look only adds', async () => {
    const installed = [{ ...pack(), installed: true }, single()]
    for (const [target, reason] of [
      [null, EN['customize.themes.noSession']],
      ['busy', EN['customize.themes.busy']],
    ] as const) {
      const { view, open, card, runtimeAsked } = setup({ themes: installed.map(x => ({ ...x })), target })
      await open()
      expect(view.getByTestId('customize-themes-target').textContent).toBe(reason)
      const use = within(card('scenes', 'scene-0')).getByTestId('customize-theme-use') as HTMLButtonElement
      expect(use.disabled).toBe(true)
      expect(use.title).toBe(reason)
      fireEvent.click(use)
      expect(runtimeAsked).toEqual([])
      cleanup()
    }
    const { view, open, card } = setup({ target: null })
    await open()
    expect(within(card('scenes', 'scene-0')).getByTestId('customize-theme-add').textContent).toBe(EN['customize.item.add'])
    expect(view.getByTestId('customize-themes-target').textContent).toBe(EN['customize.themes.noSession'])
  })
})

describe('Theme directory — what is in use', () => {
  it('a look applied earlier is still marked when the screen opens again on that session', async () => {
    const installed = () => [{ ...pack(), installed: true }, single()]
    const first = setup({ themes: installed() })
    await first.open()
    fireEvent.click(within(first.card('scenes', 'scene-1')).getByTestId('customize-theme-use'))
    await waitFor(() => expect(within(first.card('scenes', 'scene-1')).getByTestId('customize-theme-in-use')).toBeTruthy())
    first.view.unmount()

    const again = setup({ themes: installed(), target: first.target, standing: { plugin: 'scenes@velloc' } })
    await again.open()
    await waitFor(() => expect(within(again.card('scenes', 'scene-1')).getByTestId('customize-theme-in-use')).toBeTruthy())
    expect(again.view.getAllByTestId('customize-theme-in-use')).toHaveLength(1)
  })

  it('a look whose answer arrives after the screen closed is still marked when it opens again', async () => {
    const installed = () => [{ ...pack(), installed: true }, single()]
    let answer!: () => void
    const first = setup({ themes: installed(), useGate: new Promise<void>(resolve => (answer = resolve)) })
    await first.open()
    fireEvent.click(within(first.card('scenes', 'scene-1')).getByTestId('customize-theme-use'))
    await waitFor(() => expect(first.runtimeAsked.some(r => r.startsWith('theme.useLook'))).toBe(true))
    first.view.unmount()
    await act(async () => {
      answer()
      await new Promise(resolve => setTimeout(resolve, 0))
    })

    const again = setup({ themes: installed(), target: first.target, standing: { plugin: 'scenes' } })
    await again.open()
    await waitFor(() => expect(within(again.card('scenes', 'scene-1')).getByTestId('customize-theme-in-use')).toBeTruthy())
    expect(again.view.getAllByTestId('customize-theme-in-use')).toHaveLength(1)
  })

  it('a session with no theme marks no card; a standing single theme marks its own', async () => {
    const installed = () => [{ ...pack(), installed: true }, { ...single(), installed: true }]
    const none = setup({ themes: installed(), standing: null })
    await none.open()
    expect(none.view.queryAllByTestId('customize-theme-in-use')).toHaveLength(0)
    none.view.unmount()

    const snow = setup({ themes: installed(), standing: { plugin: 'snow' } })
    await snow.open()
    await waitFor(() => expect(within(snow.card('snow', 'snow')).getByTestId('customize-theme-in-use')).toBeTruthy())
    expect(snow.view.getAllByTestId('customize-theme-in-use')).toHaveLength(1)
  })

  it('a theme set by something the directory does not list, or a pack with no look remembered, marks nothing', async () => {
    const installed = () => [{ ...pack(), installed: true }, single()]
    for (const plugin of ['my-own-mod', 'scenes']) {
      const { view, open } = setup({ themes: installed(), standing: { plugin } })
      await open()
      await act(async () => {
        await Promise.resolve()
      })
      expect(view.queryAllByTestId('customize-theme-in-use')).toHaveLength(0)
      view.unmount()
    }
  })

  it('with no single theme listed there is no single themes section', async () => {
    const { view, open } = setup({ themes: [pack()] })
    await open()
    expect(view.queryByTestId('customize-themes-singles')).toBeNull()
    expect(view.queryByText(EN['customize.themes.singles'])).toBeNull()
  })
})
