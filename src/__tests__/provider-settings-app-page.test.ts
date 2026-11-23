// @vitest-environment happy-dom
/**
 * A provider's settings app, page side (F-27, F-40): an app with
 * `topbar: false` has no topbar icon and no overflow entry, and the provider's
 * editor opens it once when the provider is added and from its "Open" button,
 * through the topbar's opener, offered as a `provider` press. On stable, where
 * no apps are published, neither entry exists.
 */
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { createElement as h } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { BrowserLlmProvider } from '../browser/bridge/protocol/nexus_llm'
import type { NexusProviderConfig } from '../settings/settingsTypes'
import { createShellCloseSettings, createShellHandleOpenProviderSettings } from '../browser/webview/shellSettingsActions'
import { EMPTY_MOD_CONTRIBUTIONS, type ModContributionsState } from '../browser/runtimeProtocol/modContributions'
import type { AppPressPort } from '../browser/webview/apps/appPress'
import {
  createProviderAppOpener,
  ProviderAppOpenerContext,
  type ProviderAppOpener,
} from '../browser/webview/apps/providerSettingsApp'
import { I18nProvider } from '../browser/webview/i18n'
import { setModContributions } from '../browser/webview/mods/modContributionsView'
import { ProviderSettingsAppEntry } from '../browser/webview/settings/sections/ProviderSettingsAppEntry'
import { PluginTopbarItems, usePluginTopbarItems } from '../browser/webview/topbar/PluginTopbarItems'
import { RuntimeCapabilitiesContext } from '../browser/webview/useCan'
import { TooltipProvider } from '../components/ui/tooltip'

const BETA: ModContributionsState = {
  ...EMPTY_MOD_CONTRIBUTIONS,
  apps: [
    { type: 'switch:console', appId: 'switch-console', plugin: 'switch', title: 'Switchboard', topbar: false },
    { type: 'pay:board', appId: 'pay-board', plugin: 'pay', title: 'Payments' },
  ],
}

afterEach(() => {
  cleanup()
  act(() => setModContributions(EMPTY_MOD_CONTRIBUTIONS))
})

const settle = () => act(async () => void (await new Promise(resolve => setTimeout(resolve, 0))))

const wrap = (child: ReturnType<typeof h>) =>
  h(I18nProvider, { locale: 'en' } as never, h(RuntimeCapabilitiesContext.Provider, { value: { can: () => true } }, h(TooltipProvider, null, child)))

describe('an app with topbar false', () => {
  function Bar(props: { folded: Set<string> }) {
    const state = usePluginTopbarItems(undefined, undefined, () => {})
    return h('div', null, h('span', { 'data-testid': 'ids' }, (state?.items ?? []).map(item => item.id).join(',')), h(PluginTopbarItems, { state, folded: props.folded }))
  }

  it('has no topbar icon and no overflow entry, while an ordinary app is unchanged', () => {
    act(() => setModContributions(BETA))
    render(wrap(h(Bar, { folded: new Set<string>() })))
    expect(screen.getByTestId('ids').textContent).toBe('app:pay:board')
    expect(screen.queryByTestId('topbar-app-switch-console')).toBeNull()
    expect(screen.getByTestId('topbar-app-pay-board')).toBeTruthy()
  })
})

const row = (settingsApp: string | undefined): BrowserLlmProvider =>
  ({
    id: 'mod.switch.route',
    label: 'Switchboard',
    iconSvg: '',
    enabled: true,
    models: [],
    mod: { state: 'ready', plugin: 'switch', kind: 'router', ...(settingsApp ? { settingsApp } : {}) },
  }) as BrowserLlmProvider

const ADOPTED: NexusProviderConfig = { source: 'mod', modVersion: '1' }
const KEYLESS: NexusProviderConfig = { source: 'mod', modVersion: '1', credentialMode: 'anonymous' }
const savedOf = (added: boolean | NexusProviderConfig | undefined): NexusProviderConfig | undefined =>
  added === true ? KEYLESS : added === false ? undefined : added

function renderEntry(provider: BrowserLlmProvider, added: boolean | NexusProviderConfig | undefined, open: ProviderAppOpener | undefined) {
  const tree = (now: boolean | NexusProviderConfig | undefined) =>
    wrap(h(ProviderAppOpenerContext.Provider, { value: open }, h(ProviderSettingsAppEntry, { provider, saved: savedOf(now) })))
  const view = render(tree(added))
  return { rerender: (now: boolean | NexusProviderConfig | undefined) => view.rerender(tree(now)) }
}

describe("the provider editor's entries", () => {
  it('opens the app once when the provider is added, and again from its button', () => {
    act(() => setModContributions(BETA))
    const open = vi.fn()
    const { rerender } = renderEntry(row('switch-console'), false, open)
    expect(open).not.toHaveBeenCalled()
    rerender(true)
    expect(open).toHaveBeenCalledTimes(1)
    expect(open.mock.calls[0]![0]).toMatchObject({ appId: 'switch-console', type: 'switch:console' })
    rerender(true)
    expect(open).toHaveBeenCalledTimes(1)
    const button = screen.getByTestId('mod-provider-settings-app-switch-console')
    expect(button.textContent).toBe('Open Switchboard')
    fireEvent.click(button)
    expect(open).toHaveBeenCalledTimes(2)
  })

  it('opens on the key-less switch, not when the host adopts the bare entry', () => {
    act(() => setModContributions(BETA))
    const open = vi.fn()
    const { rerender } = renderEntry(row('switch-console'), undefined, open)
    rerender(ADOPTED)
    expect(open).not.toHaveBeenCalled()
    rerender(KEYLESS)
    expect(open).toHaveBeenCalledTimes(1)
  })

  it('does not open a provider that was already added when the editor appeared', () => {
    act(() => setModContributions(BETA))
    const open = vi.fn()
    renderEntry(row('switch-console'), true, open)
    expect(open).not.toHaveBeenCalled()
  })

  it('draws nothing and opens nothing on stable, where no apps are published', () => {
    act(() => setModContributions({ ...EMPTY_MOD_CONTRIBUTIONS }))
    const open = vi.fn()
    const { rerender } = renderEntry(row('switch-console'), false, open)
    rerender(true)
    expect(open).not.toHaveBeenCalled()
    expect(screen.queryByTestId('mod-provider-settings-app-switch-console')).toBeNull()
  })

  it("does not take another plugin's app that holds the same id", () => {
    act(() =>
      setModContributions({
        ...EMPTY_MOD_CONTRIBUTIONS,
        apps: [{ type: 'other:console', appId: 'switch-console', plugin: 'other', title: 'Other' }],
      }),
    )
    const open = vi.fn()
    const { rerender } = renderEntry(row('switch-console'), false, open)
    rerender(true)
    expect(open).not.toHaveBeenCalled()
    expect(screen.queryByTestId('mod-provider-settings-app-switch-console')).toBeNull()
  })

  it('draws nothing for a provider that names no app', () => {
    act(() => setModContributions(BETA))
    renderEntry(row(undefined), true, vi.fn())
    expect(screen.queryByTestId(/^mod-provider-settings-app-/)).toBeNull()
  })
})

describe('the opener', () => {
  const app = { appId: 'switch-console', type: 'switch:console', title: 'Switchboard', plugin: 'switch' }

  it('closes Settings the way its close button does, arming the adopt-default pass', () => {
    const calls: string[] = []
    const set = (name: string) => (value: unknown) => void calls.push(`${name}=${String(value)}`)
    const armed = { current: false }
    createShellCloseSettings(set('provider') as never, set('plugin') as never, set('mcp') as never, set('section') as never, armed)()
    expect(armed.current).toBe(true)
    expect(calls).toEqual(['provider=null', 'plugin=null', 'mcp=null', 'section=null'])
  })

  it('offers the open as a provider press, then closes Settings and opens through the topbar opener', async () => {
    const asked: unknown[] = []
    const port: AppPressPort = {
      ask: async (...args) => {
        asked.push(args.filter(arg => arg !== undefined))
        return null
      },
      signIn: () => {},
      signOut: () => {},
    }
    const calls: string[] = []
    const opener = createProviderAppOpener(
      { port, signIn: undefined, openApp: type => calls.push(`open ${type}`), closeSettings: () => calls.push('close') },
      () => BETA.apps,
    )
    opener(app)
    expect(calls).toEqual([])
    await settle()
    expect(asked).toEqual([['switch-console', 'provider']])
    expect(calls).toEqual(['close', 'open switch:console'])
  })

  it('leaves Settings open when the module answers that it handled the open', async () => {
    const port: AppPressPort = { ask: async () => ({ kind: 'handled' }), signIn: () => {}, signOut: () => {} }
    const calls: string[] = []
    createProviderAppOpener({ port, signIn: undefined, openApp: () => calls.push('open'), closeSettings: () => calls.push('close') }, () => BETA.apps)(app)
    await settle()
    expect(calls).toEqual([])
  })

  it('opens at once without a port', () => {
    const calls: string[] = []
    createProviderAppOpener({ port: undefined, signIn: undefined, openApp: type => calls.push(type), closeSettings: () => calls.push('close') }, () => BETA.apps)(app)
    expect(calls).toEqual(['close', 'switch:console'])
  })
})

describe("the quick picker's provider gear", () => {
  const provider = (mod: BrowserLlmProvider['mod']): BrowserLlmProvider =>
    ({ id: 'mod.switch.route', label: 'Switchboard', iconSvg: '', enabled: true, models: [], mod }) as BrowserLlmProvider

  function press(providers: BrowserLlmProvider[], open: ProviderAppOpener | undefined) {
    const requests: unknown[] = []
    const sections: unknown[] = []
    const gear = createShellHandleOpenProviderSettings(
      ((update: unknown) => requests.push(typeof update === 'function' ? update(null) : update)) as never,
      ((section: unknown) => sections.push(section)) as never,
      { current: { providers, open } },
    )
    act(() => setModContributions(BETA))
    gear('mod.switch.route')
    return { requests, sections }
  }

  it("opens a ready router's settings app and leaves Settings closed", () => {
    const open = vi.fn()
    const { requests, sections } = press([provider({ state: 'ready', plugin: 'switch', kind: 'router', settingsApp: 'switch-console' })], open)
    expect(open).toHaveBeenCalledTimes(1)
    expect(open.mock.calls[0]![0]).toMatchObject({ appId: 'switch-console', type: 'switch:console' })
    expect(requests).toEqual([])
    expect(sections).toEqual([])
  })

  it.each([
    ['a provider that is not a router', { state: 'ready', plugin: 'switch', settingsApp: 'switch-console' }],
    ['a router that names no app', { state: 'ready', plugin: 'switch', kind: 'router' }],
    ['a router whose app is not published', { state: 'ready', plugin: 'switch', kind: 'router', settingsApp: 'missing' }],
    ['a router whose plugin is missing', { state: 'plugin-missing', plugin: 'switch', kind: 'router', settingsApp: 'switch-console' }],
  ] as const)('opens Settings → Models for %s', (_name, mod) => {
    const open = vi.fn()
    const { requests, sections } = press([provider(mod as BrowserLlmProvider['mod'])], open)
    expect(open).not.toHaveBeenCalled()
    expect(requests).toEqual([{ providerId: 'mod.switch.route', seq: 1 }])
    expect(sections).toEqual(['models'])
  })

  it('opens Settings → Models when apps cannot open', () => {
    const { requests, sections } = press([provider({ state: 'ready', plugin: 'switch', kind: 'router', settingsApp: 'switch-console' })], undefined)
    expect(requests).toEqual([{ providerId: 'mod.switch.route', seq: 1 }])
    expect(sections).toEqual(['models'])
  })
})
