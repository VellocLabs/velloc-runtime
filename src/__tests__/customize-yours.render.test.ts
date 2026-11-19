// @vitest-environment happy-dom
/**
 * Customize → Yours (F-35): the left row, the Themes and Plugins tabs, the
 * theme cards (order, the one in effect, on and off), their menu, and what
 * Enable, Disable, Uninstall and the options ask of the bridge and the runtime.
 */
import { afterEach, describe, expect, it } from 'vitest'
import { createElement } from 'react'
import { act, cleanup, fireEvent, render, waitFor, within } from '@testing-library/react'

import type { ThemePluginRow } from '../mods/themeMods'
import type { RuntimeConnection } from '../browser/runtimeClient/RuntimeConnection'
import { CustomizeScreen } from '../browser/webview/customize/CustomizeScreen'
import { cardsOf } from '../browser/webview/customize/YourThemes'
import type { ThemePlugin, ThemeTarget } from '../browser/webview/customize/useThemeCatalog'
import { en as EN } from '../browser/webview/i18n/messages/en'
import { SettingsBridgeContext, type NexusSettingsBridge } from '../browser/webview/nexusSettingsBridge'
import { RuntimeCapabilitiesContext } from '../browser/webview/useCan'

afterEach(cleanup)

const LAGOON: ThemePluginRow = { plugin: 'lagoon', id: 'lagoon@velloc', enabled: true }
const SCENES: ThemePluginRow = { plugin: 'theme-examples', id: 'theme-examples@velloc', enabled: false }
const MINE: ThemePluginRow = { plugin: 'mine', id: 'mine@inline', root: '/home/u/.velloc/plugins/mine', enabled: false }
const BUILTIN: ThemePluginRow = { plugin: 'aurora', id: 'aurora@builtin', enabled: false }

const LISTINGS = [
  {
    name: 'lagoon',
    installed: true,
    author: { name: 'Acme' },
    theme: { looks: [{ id: 'lagoon', name: 'Honu Lagoon', preview: 'https://plugins.example/lagoon.svg' }] },
  },
  {
    name: 'theme-examples',
    installed: true,
    theme: {
      looks: [
        { id: 'a', name: 'A', preview: 'https://plugins.example/a.svg' },
        { id: 'b', name: 'B', preview: 'https://plugins.example/b.svg' },
      ],
    },
  },
] as unknown as ThemePlugin[]

const TARGET: ThemeTarget = { sessionId: 's1', title: 'Fix the build', busy: false }

function setup(
  options: {
    rows?: ThemePluginRow[]
    single?: boolean
    standing?: { plugin: string } | null
    target?: ThemeTarget | null
    deny?: string[]
    uninstallFails?: boolean
    turnOffFails?: boolean
    holdUse?: Promise<void>
  } = {},
) {
  let rows = (options.rows ?? [LAGOON, SCENES, MINE, BUILTIN]).map(row => ({ ...row }))
  const bridgeAsked: string[] = []
  const runtimeAsked: string[] = []
  let listener: ((event: { type: string; payload: unknown }) => void) | null = null
  const publish = () =>
    listener?.({
      type: 'state',
      payload: {
        mods: [],
        plugins: rows,
        backdropScope: 'window',
        single: options.single === true,
        on: rows.filter(row => row.enabled).length,
      },
    })
  const bridge = {
    request: async (route: { capability: string; action: string }, payload: Record<string, unknown>) => {
      const key = `${route.capability}.${route.action}`
      bridgeAsked.push(`${key} ${JSON.stringify(payload)}`)
      switch (key) {
        case 'plugins.listMarketplaces':
          return { marketplaces: [] }
        case 'plugins.listMarketplacePlugins':
          return {
            marketplace: payload.marketplace,
            manifest: { name: payload.marketplace, plugins: payload.kind === 'themes' ? LISTINGS : [] },
          }
        case 'plugins.refreshMarketplace':
          return { ok: true, pluginCount: 0, manifest: null }
        case 'plugins.setEnabled':
          rows = rows.map(row => (row.id === payload.identifier ? { ...row, enabled: payload.enabled === true } : row))
          publish()
          return { ok: true, effectiveEnabled: payload.enabled }
        case 'plugins.setLocalEnabled':
          rows = rows.map(row => (row.root === payload.path ? { ...row, enabled: payload.enabled === true } : row))
          publish()
          return { ok: true, name: 'mine' }
        case 'plugins.uninstall':
          if (options.uninstallFails) throw new Error('locked')
          rows = rows.filter(row => row.id !== payload.identifier)
          publish()
          return { ok: true }
        case 'plugins.listInstalled':
          return { plugins: [{ name: 'lagoon', marketplace: 'velloc', version: '1.0.0', enabled: true, scope: 'user' }] }
        case 'plugins.listLocal':
          return { roots: [] }
        case 'plugins.listBuiltin':
          return { mods: [] }
        default:
          return {}
      }
    },
  } as unknown as NexusSettingsBridge
  const connection = {
    subscribe: (topic: string, next: (event: { type: string; payload: unknown }) => void) => {
      if (topic === 'mods/themes') {
        listener = next
        publish()
      }
      return () => {}
    },
    can: () => true,
    request: async (route: string, payload: Record<string, unknown>) => {
      if (route === 'customizePage.show') return { tabId: 7, created: true }
      if (route === 'customizePage.describeMarketplace') return { plugins: {} }
      if (route === 'themeMods.read') {
        publish()
        return { ok: true }
      }
      runtimeAsked.push(`${route} ${JSON.stringify(payload)}`)
      if (route === 'theme.useLook' && options.holdUse) await options.holdUse
      if (route === 'themeMods.turnOffAll') {
        if (options.turnOffFails) throw new Error('refused')
        let count = 0
        rows = rows.map(row => {
          if (!row.enabled || row.plugin === payload.keep) return row
          count += 1
          return { ...row, enabled: false }
        })
        publish()
        return { ok: true, turnedOff: count }
      }
      return { ok: true }
    },
  } as unknown as RuntimeConnection
  const deny = new Set(options.deny ?? [])
  const grant = { can: (cap: string, act?: string) => !deny.has(`${cap}.${act}`) }
  const view = render(
    createElement(
      RuntimeCapabilitiesContext.Provider,
      { value: grant },
      createElement(
        SettingsBridgeContext.Provider,
        { value: bridge },
        createElement(CustomizeScreen, {
          runtimeConnection: async () => connection,
          shell: null,
          onClose: () => {},
          onOpenSettings: () => {},
          themeTarget: options.target === undefined ? TARGET : options.target,
          themeStanding: options.standing,
        }),
      ),
    ),
  )
  const open = async () => {
    fireEvent.click(view.getByTestId('customize-market-yours'))
    await waitFor(() => expect(view.queryByTestId('customize-yours-themes') ?? view.queryByTestId('customize-yours-empty')).toBeTruthy())
    await act(async () => {
      await Promise.resolve()
    })
  }
  const card = (plugin: string) =>
    view.getAllByTestId('customize-yours-theme').find(el => el.getAttribute('data-plugin') === plugin)!
  const openMenu = (plugin: string) => {
    fireEvent.keyDown(within(card(plugin)).getByTestId('customize-yours-menu'), { key: 'Enter' })
    return view.getByTestId('customize-yours-menu-content')
  }
  return { view, open, card, openMenu, bridgeAsked, runtimeAsked }
}

describe('Customize → Yours — the row and the tabs', () => {
  it('is the last row of the left column and opens on Themes', async () => {
    const { view, open } = setup()
    const rows = view.getByTestId('customize-markets')
    const last = Array.from(rows.querySelectorAll('[data-testid^="customize-market"]')).at(-1)!
    expect(last.getAttribute('data-testid')).toBe('customize-market-yours')
    expect(last.textContent).toContain(EN['customize.yours.title'])
    await open()
    expect(view.getByTestId('customize-title').textContent).toBe(EN['customize.yours.title'])
    expect(view.getByTestId('customize-yours-tab-themes').getAttribute('aria-selected')).toBe('true')
  })

  it('Plugins shows the Settings plugins page in the pane, and Themes comes back', async () => {
    const { view, open } = setup()
    await open()
    fireEvent.click(view.getByTestId('customize-yours-tab-plugins'))
    const pane = view.getByTestId('customize-yours-plugins')
    await waitFor(() => expect(within(pane).getByTestId('plugin-toggle-lagoon')).toBeTruthy())
    expect(view.queryByTestId('customize-yours-themes')).toBeNull()
    fireEvent.click(view.getByTestId('customize-yours-tab-themes'))
    expect(view.getByTestId('customize-yours-themes')).toBeTruthy()
  })
})

describe('Customize → Yours — the theme cards', () => {
  it('orders the one in effect first, then the enabled, then the rest by name', () => {
    const on = { ...SCENES, enabled: true }
    const names = (cards: ReturnType<typeof cardsOf>) => cards.map(card => card.row.plugin)
    expect(names(cardsOf([MINE, on, LAGOON, BUILTIN], LISTINGS, { plugin: 'lagoon' }))).toEqual([
      'lagoon',
      'theme-examples',
      'aurora',
      'mine',
    ])
    // No session to read: the only enabled one is in effect.
    expect(cardsOf([LAGOON, SCENES], LISTINGS, undefined).map(card => card.inEffect)).toEqual([true, false])
    expect(cardsOf([LAGOON, on], LISTINGS, undefined).some(card => card.inEffect)).toBe(false)
    // A session with no theme: none.
    expect(cardsOf([LAGOON], LISTINGS, null)[0]!.inEffect).toBe(false)
    expect(cardsOf([LAGOON], LISTINGS, { plugin: 'lagoon@velloc' })[0]!.inEffect).toBe(true)
  })

  it('marks the theme in effect, says On or Off, and draws a listing picture or the initial', async () => {
    const { view, open, card } = setup({ rows: [LAGOON, SCENES, MINE], standing: { plugin: 'lagoon' } })
    await open()
    const lagoon = card('lagoon')
    expect(within(lagoon).getByTestId('customize-yours-in-effect').textContent).toBe(EN['customize.yours.inEffect'])
    expect(within(lagoon).getByText('Honu Lagoon')).toBeTruthy()
    expect(within(lagoon).getByTestId('customize-theme-preview').getAttribute('src')).toBe('https://plugins.example/lagoon.svg')
    expect(lagoon.textContent).toContain('By Acme')
    const scenes = card('theme-examples')
    expect(within(scenes).getByText('Theme examples')).toBeTruthy()
    expect(scenes.textContent).toContain(EN['customize.themes.looksCount'].replace('{count}', '2'))
    expect(within(scenes).getByTestId('customize-yours-state').textContent).toBe(EN['customize.yours.off'])
    const mine = card('mine')
    expect(within(mine).getByTestId('customize-theme-preview-fallback').textContent).toBe('M')
    expect(mine.textContent).toContain(EN['customize.yours.source.local'])
    expect(view.getAllByTestId('customize-yours-in-effect')).toHaveLength(1)
  })

  it('a menu offers what fits the plugin: Choose a look for a pack, Uninstall only for a marketplace install', async () => {
    const { open, openMenu } = setup()
    await open()
    const pack = openMenu('theme-examples')
    expect(within(pack).getByTestId('customize-yours-enable')).toBeTruthy()
    expect(within(pack).getByTestId('customize-yours-choose-look')).toBeTruthy()
    expect(within(pack).getByTestId('customize-yours-uninstall')).toBeTruthy()
    fireEvent.keyDown(pack, { key: 'Escape' })
    await waitFor(() => expect(document.querySelector('[data-testid="customize-yours-menu-content"]')).toBeNull())
    for (const plugin of ['mine', 'aurora']) {
      const menu = openMenu(plugin)
      expect(within(menu).queryByTestId('customize-yours-uninstall')).toBeNull()
      expect(within(menu).queryByTestId('customize-yours-choose-look')).toBeNull()
      expect(within(menu).getByTestId('customize-yours-manage')).toBeTruthy()
      fireEvent.keyDown(menu, { key: 'Escape' })
      await waitFor(() => expect(document.querySelector('[data-testid="customize-yours-menu-content"]')).toBeNull())
    }
  })

  it('Enable turns the plugin on and every other theme plugin off, and says so', async () => {
    const { view, open, openMenu, card, bridgeAsked, runtimeAsked } = setup()
    await open()
    fireEvent.click(within(openMenu('theme-examples')).getByTestId('customize-yours-enable'))
    await waitFor(() =>
      expect(view.getByTestId('customize-yours-notice').textContent).toBe(
        EN['customize.yours.notice.enabledOthersOff'].replace('{name}', 'Theme examples'),
      ),
    )
    expect(bridgeAsked).toContain('plugins.setEnabled {"identifier":"theme-examples@velloc","enabled":true}')
    expect(runtimeAsked).toContain('themeMods.turnOffAll {"keep":"theme-examples"}')
    expect(card('theme-examples').getAttribute('data-enabled')).toBe('true')
    expect(card('lagoon').getAttribute('data-enabled')).toBe('false')
  })

  it('Enable whose turn-off of the others fails says so, and the plugin stays on', async () => {
    const { view, open, card, openMenu } = setup({ turnOffFails: true })
    await open()
    fireEvent.click(within(openMenu('theme-examples')).getByTestId('customize-yours-enable'))
    await waitFor(() =>
      expect(view.getByTestId('customize-yours-notice').textContent).toBe(EN['customize.themes.notice.failedTurnOff']),
    )
    expect(card('theme-examples').getAttribute('data-enabled')).toBe('true')
    expect(card('lagoon').getAttribute('data-enabled')).toBe('true')
  })

  it('two installs of one plugin each get a card', async () => {
    const { view, open } = setup({ rows: [{ ...LAGOON, enabled: false }, { ...LAGOON, id: 'lagoon@mymarket' }] })
    await open()
    const cards = view.getAllByTestId('customize-yours-theme')
    expect(cards).toHaveLength(2)
    expect(cards.map(el => el.getAttribute('data-enabled')).sort()).toEqual(['false', 'true'])
  })

  it('a folder plugin is switched through its folder; Disable turns only it off', async () => {
    const { view, open, openMenu, bridgeAsked, runtimeAsked } = setup()
    await open()
    fireEvent.click(within(openMenu('mine')).getByTestId('customize-yours-enable'))
    await waitFor(() => expect(bridgeAsked.some(line => line.startsWith('plugins.setLocalEnabled'))).toBe(true))
    expect(bridgeAsked).toContain('plugins.setLocalEnabled {"path":"/home/u/.velloc/plugins/mine","enabled":true}')
    await waitFor(() => expect(view.getByTestId('customize-yours-notice').getAttribute('data-kind')).toBe('enabled'))
    runtimeAsked.length = 0
    fireEvent.click(within(openMenu('mine')).getByTestId('customize-yours-disable'))
    await waitFor(() =>
      expect(view.getByTestId('customize-yours-notice').textContent).toBe(
        EN['customize.yours.notice.disabled'].replace('{name}', 'Mine'),
      ),
    )
    expect(runtimeAsked).toEqual([])
  })

  it('Uninstall asks first, then removes the card; a failure stays in the dialog', async () => {
    const ok = setup()
    await ok.open()
    fireEvent.click(within(ok.openMenu('lagoon')).getByTestId('customize-yours-uninstall'))
    const dialog = await ok.view.findByTestId('customize-yours-uninstall-dialog')
    expect(dialog.textContent).toContain(EN['customize.yours.uninstall.title'].replace('{name}', 'Honu Lagoon'))
    fireEvent.click(within(dialog).getByTestId('customize-yours-uninstall-confirm'))
    await waitFor(() => expect(ok.view.queryByTestId('customize-yours-uninstall-dialog')).toBeNull())
    expect(ok.bridgeAsked).toContain('plugins.uninstall {"identifier":"lagoon@velloc"}')
    await waitFor(() => expect(ok.view.getAllByTestId('customize-yours-theme').some(el => el.getAttribute('data-plugin') === 'lagoon')).toBe(false))
    expect(ok.view.getByTestId('customize-yours-notice').getAttribute('data-kind')).toBe('uninstalled')
    ok.view.unmount()

    const bad = setup({ uninstallFails: true })
    await bad.open()
    fireEvent.click(within(bad.openMenu('lagoon')).getByTestId('customize-yours-uninstall'))
    const stuck = await bad.view.findByTestId('customize-yours-uninstall-dialog')
    fireEvent.click(within(stuck).getByTestId('customize-yours-uninstall-confirm'))
    await waitFor(() => expect(within(stuck).getByRole('alert').textContent).toContain('Honu Lagoon'))
  })

  it('Choose a look opens the Theme directory; Manage opens the Plugins tab', async () => {
    const { view, open, openMenu } = setup()
    await open()
    fireEvent.click(within(openMenu('theme-examples')).getByTestId('customize-yours-choose-look'))
    await waitFor(() => expect(view.getByTestId('customize-themes')).toBeTruthy())
    fireEvent.click(view.getByTestId('customize-market-yours'))
    await waitFor(() => expect(view.getByTestId('customize-yours-themes')).toBeTruthy())
    fireEvent.click(within(openMenu('lagoon')).getByTestId('customize-yours-manage'))
    expect(view.getByTestId('customize-yours-tab-plugins').getAttribute('aria-selected')).toBe('true')
  })

  it('with no theme plugin, says so and offers the Theme directory', async () => {
    const { view, open } = setup({ rows: [] })
    await open()
    expect(view.getByTestId('customize-yours-empty').textContent).toContain(EN['customize.yours.empty'])
    fireEvent.click(view.getByTestId('customize-yours-browse'))
    await waitFor(() => expect(view.getByTestId('customize-themes')).toBeTruthy())
  })
})

describe('Customize → Yours — the theme plugin options', () => {
  it('the one-at-a-time switch shows the stored flag and asks the runtime to change it', async () => {
    const { view, open, runtimeAsked } = setup({ single: true })
    await open()
    const toggle = view.getByTestId('customize-themes-single')
    await waitFor(() => expect(toggle.getAttribute('aria-checked')).toBe('true'))
    fireEvent.click(toggle)
    await waitFor(() => expect(runtimeAsked).toContain('themeMods.setSingle {"on":false}'))
  })

  it('Turn off all turns every card off and then waits until one is on again', async () => {
    const { view, open, card, runtimeAsked } = setup()
    await open()
    const button = view.getByTestId('customize-themes-turn-off') as HTMLButtonElement
    expect(button.disabled).toBe(false)
    fireEvent.click(button)
    await waitFor(() =>
      expect(view.getByTestId('customize-yours-notice').textContent).toBe(EN['customize.themes.notice.turnedOff']),
    )
    expect(runtimeAsked).toContain('themeMods.turnOffAll {}')
    expect(card('lagoon').getAttribute('data-enabled')).toBe('false')
    await waitFor(() => expect(button.disabled).toBe(true))
  })

  it('after Turn off all, the Theme directory no longer marks the look used before', async () => {
    const { view, open } = setup()
    fireEvent.click(view.getByTestId('customize-market-themes'))
    const look = () =>
      view.getAllByTestId('customize-theme-look').find(el => el.getAttribute('data-look') === 'b')!
    await waitFor(() => expect(within(look()).getByTestId('customize-theme-use')).toBeTruthy())
    fireEvent.click(within(look()).getByTestId('customize-theme-use'))
    await waitFor(() => expect(within(look()).getByTestId('customize-theme-in-use')).toBeTruthy())
    await open()
    fireEvent.click(view.getByTestId('customize-themes-turn-off'))
    await waitFor(() => expect(view.getByTestId('customize-yours-notice').getAttribute('data-kind')).toBe('turnedOff'))
    fireEvent.click(view.getByTestId('customize-market-themes'))
    await waitFor(() => expect(look()).toBeTruthy())
    expect(view.queryAllByTestId('customize-theme-in-use')).toHaveLength(0)
  })

  it('Turn off all waits while a look from the Theme directory is still being applied', async () => {
    let release = () => {}
    const holdUse = new Promise<void>(resolve => {
      release = resolve
    })
    const { view, open } = setup({ holdUse })
    fireEvent.click(view.getByTestId('customize-market-themes'))
    const look = () =>
      view.getAllByTestId('customize-theme-look').find(el => el.getAttribute('data-look') === 'b')!
    await waitFor(() => expect(within(look()).getByTestId('customize-theme-use')).toBeTruthy())
    fireEvent.click(within(look()).getByTestId('customize-theme-use'))
    await open()
    const button = view.getByTestId('customize-themes-turn-off') as HTMLButtonElement
    expect(button.disabled).toBe(true)
    await act(async () => {
      release()
      await holdUse
    })
    await waitFor(() => expect(button.disabled).toBe(false))
  })

  it('a connection without the grants gets no menu actions it may not ask, no switch change and no Turn off all', async () => {
    const { view, open, openMenu } = setup({
      single: true,
      deny: ['themeMods.setSingle', 'themeMods.turnOffAll', 'plugins.uninstall'],
    })
    await open()
    expect((view.getByTestId('customize-themes-single') as HTMLButtonElement).disabled).toBe(true)
    expect(view.queryByTestId('customize-themes-turn-off')).toBeNull()
    const menu = openMenu('lagoon')
    expect(within(menu).queryByTestId('customize-yours-disable')).toBeNull()
    expect(within(menu).queryByTestId('customize-yours-uninstall')).toBeNull()
    expect(within(menu).getByTestId('customize-yours-manage')).toBeTruthy()
  })
})
