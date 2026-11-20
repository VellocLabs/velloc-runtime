// @vitest-environment happy-dom
import { act, createElement } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'

import { ModelsSection } from '../browser/webview/settings/sections/ModelsSection'
import { SettingsBridgeContext } from '../browser/webview/nexusSettingsBridge'
import type { NexusSettingsBridge } from '../browser/webview/nexusSettingsBridge'
import type { BrowserBridgeTransport } from '../browser/bridge/browserBridgeProtocol'
import type { BrowserLlmProvider } from '../browser/bridge/protocol/nexus_llm'
import { I18nProvider } from '../browser/webview/i18n'
import type { NexusProviderConfig } from '../settings/settingsTypes'
import { EMPTY_MOD_CONTRIBUTIONS, type ModContributionsState } from '../browser/runtimeProtocol/modContributions'
import { setModContributions } from '../browser/webview/mods/modContributionsView'
import { ProviderAppOpenerContext } from '../browser/webview/apps/providerSettingsApp'

/**
 * Settings -> Models for a router that names a settings app (F-27, F-40):
 * opening it, from its row or from the Add provider menu, opens the app and
 * never the generic editor; without a published app the editor stays.
 */

const ROUTER = 'mod.switch.main'

const APPS: ModContributionsState = {
  ...EMPTY_MOD_CONTRIBUTIONS,
  apps: [{ type: 'switch:console', appId: 'switch-console', plugin: 'switch', title: 'Switchboard', topbar: false }],
}

function routerRow(settingsApp: string | undefined): BrowserLlmProvider {
  return {
    id: ROUTER,
    label: 'Switch',
    iconSvg: '<svg viewBox="0 0 1 1"></svg>',
    enabled: false,
    models: [],
    mod: {
      state: 'ready',
      plugin: 'switch',
      configId: 'switch@inline',
      displayName: { en: 'Switch' },
      kind: 'router',
      routesTo: '*',
      credentialMethods: ['anonymous'],
      ...(settingsApp ? { settingsApp } : {}),
    },
  }
}

function mount(initial: Record<string, NexusProviderConfig>, row: BrowserLlmProvider, failUpsert = false, failReloadAfterAdd = false, openProviderRequest?: { providerId: string; seq: number }) {
  let configs = { ...initial }
  const upserts: NexusProviderConfig[] = []
  const bridge = {
    request: vi.fn(async (route: { action: string }, payload: Record<string, unknown>) => {
      switch (route.action) {
        case 'list':
          if (failReloadAfterAdd && upserts.length > 0) throw new Error('reload failed')
          return { configs, activeProviderId: undefined }
        case 'upsert': {
          if (failUpsert) throw new Error('disk full')
          const config = payload.config as NexusProviderConfig
          upserts.push(config)
          configs = { ...configs, [payload.id as string]: config }
          return { ok: true, configs }
        }
        case 'modOptions':
          return { ok: true, options: {}, storedSensitive: [] }
        case 'modelFamilies':
          return { ok: true, families: [] }
        default:
          return {}
      }
    }),
    subscribeEvents: () => () => {},
  } as unknown as NexusSettingsBridge
  const transport = {
    request: vi.fn(async () => ({ ok: true, result: { providers: [] } })),
    subscribeEvents: () => () => {},
  } as unknown as BrowserBridgeTransport
  const open = vi.fn()
  render(
    createElement(
      I18nProvider,
      { locale: 'en' },
      createElement(
        ProviderAppOpenerContext.Provider,
        { value: open },
        createElement(
          SettingsBridgeContext.Provider,
          { value: bridge },
          createElement(ModelsSection, { catalog: { providers: [row] }, transport, ...(openProviderRequest ? { openProviderRequest } : {}) }),
        ),
      ),
    ),
  )
  return { open, upserts }
}

afterEach(() => {
  cleanup()
  act(() => setModContributions(EMPTY_MOD_CONTRIBUTIONS))
  ;(globalThis as { __nexusUnsavedEdits?: number }).__nexusUnsavedEdits = 0
})

const ANON: NexusProviderConfig = { source: 'mod', credentialMode: 'anonymous' }

async function pickFromAddMenu() {
  fireEvent.keyDown(await screen.findByTestId('models-add-provider'), { key: 'Enter' })
  fireEvent.click(await screen.findByTestId(`models-provider-select-option-${ROUTER}`))
}

describe('a router with a settings app', () => {
  it('its row opens the app, not the editor', async () => {
    act(() => setModContributions(APPS))
    const { open, upserts } = mount({ [ROUTER]: ANON }, routerRow('switch-console'))
    fireEvent.click(await screen.findByTestId(`models-provider-settings-${ROUTER}`))
    expect(open).toHaveBeenCalledTimes(1)
    expect(open.mock.calls[0]![0]).toMatchObject({ appId: 'switch-console', plugin: 'switch' })
    expect(screen.queryByTestId('mod-provider-editor')).toBeNull()
    expect(screen.getByTestId('models-provider-home')).toBeTruthy()
    expect(upserts).toEqual([])
  })

  it("the quick picker's Edit… opens the app, not the editor", async () => {
    act(() => setModContributions(APPS))
    const { open } = mount({ [ROUTER]: ANON }, routerRow('switch-console'), false, false, { providerId: ROUTER, seq: 1 })
    await waitFor(() => expect(open).toHaveBeenCalledTimes(1))
    expect(open.mock.calls[0]![0]).toMatchObject({ appId: 'switch-console', plugin: 'switch' })
    expect(screen.queryByTestId('mod-provider-editor')).toBeNull()
    expect(screen.queryByTestId('mod-router-panel')).toBeNull()
  })

  it("the quick picker's Edit… keeps the editor without a published app", async () => {
    const { open } = mount({ [ROUTER]: ANON }, routerRow('switch-console'), false, false, { providerId: ROUTER, seq: 1 })
    expect(await screen.findByTestId('mod-router-panel')).toBeTruthy()
    expect(open).not.toHaveBeenCalled()
  })

  it('picked from the Add provider menu: added by its keyless entry, then the app opens', async () => {
    act(() => setModContributions(APPS))
    const { open, upserts } = mount({}, routerRow('switch-console'))
    await pickFromAddMenu()
    await waitFor(() => expect(open).toHaveBeenCalledTimes(1))
    expect(upserts).toHaveLength(1)
    expect(upserts[0]).toMatchObject({ source: 'mod', credentialMode: 'anonymous' })
    expect(screen.queryByTestId('mod-provider-editor')).toBeNull()
  })

  it('an add whose page reload fails still opens the app', async () => {
    act(() => setModContributions(APPS))
    const { open, upserts } = mount({}, routerRow('switch-console'), false, true)
    await pickFromAddMenu()
    await waitFor(() => expect(open).toHaveBeenCalledTimes(1))
    expect(upserts).toHaveLength(1)
    expect(screen.queryByTestId('mod-provider-editor')).toBeNull()
  })

  it('an add that fails opens the editor, so the failure is seen', async () => {
    act(() => setModContributions(APPS))
    const { open } = mount({}, routerRow('switch-console'), true)
    await pickFromAddMenu()
    expect(await screen.findByTestId('mod-provider-editor')).toBeTruthy()
    expect(open).not.toHaveBeenCalled()
  })
})

describe('without a published app the editor stays', () => {
  it('the router names no settings app', async () => {
    act(() => setModContributions(APPS))
    const { open } = mount({ [ROUTER]: ANON }, routerRow(undefined))
    fireEvent.click(await screen.findByTestId(`models-provider-settings-${ROUTER}`))
    expect(await screen.findByTestId('mod-router-panel')).toBeTruthy()
    expect(open).not.toHaveBeenCalled()
  })

  it('the app is not published', async () => {
    const { open } = mount({ [ROUTER]: ANON }, routerRow('switch-console'))
    fireEvent.click(await screen.findByTestId(`models-provider-settings-${ROUTER}`))
    expect(await screen.findByTestId('mod-router-panel')).toBeTruthy()
    expect(open).not.toHaveBeenCalled()
  })
})

/** The same provider as a plain gateway: not a router, keyless or key-only. */
function gatewayRow(credentialMethods: string[]): BrowserLlmProvider {
  const row = routerRow('switch-console')
  const { kind: _kind, routesTo: _routesTo, ...mod } = row.mod as unknown as Record<string, unknown>
  return { ...row, mod: { ...mod, credentialMethods } } as unknown as BrowserLlmProvider
}

describe('a provider that is not a router, with a published app', () => {
  it('keyless, picked from the Add menu: added by its keyless entry, then the app opens', async () => {
    act(() => setModContributions(APPS))
    const { open, upserts } = mount({}, gatewayRow(['anonymous']))
    await pickFromAddMenu()
    await waitFor(() => expect(open).toHaveBeenCalledTimes(1))
    expect(open.mock.calls[0]![0]).toMatchObject({ appId: 'switch-console', plugin: 'switch' })
    expect(upserts).toEqual([expect.objectContaining({ source: 'mod', credentialMode: 'anonymous' })])
    expect(screen.queryByTestId('mod-provider-editor')).toBeNull()
  })

  it('needing a key, picked from the Add menu: the editor opens, nothing is stored', async () => {
    act(() => setModContributions(APPS))
    const { open, upserts } = mount({}, gatewayRow(['apiKey']))
    await pickFromAddMenu()
    expect(await screen.findByTestId('mod-provider-editor')).toBeTruthy()
    expect(open).not.toHaveBeenCalled()
    expect(upserts).toEqual([])
  })

  it("already added, its row's settings button opens the editor", async () => {
    act(() => setModContributions(APPS))
    const { open } = mount({ [ROUTER]: ANON }, gatewayRow(['anonymous']))
    fireEvent.click(await screen.findByTestId(`models-provider-settings-${ROUTER}`))
    expect(await screen.findByTestId('mod-provider-editor')).toBeTruthy()
    expect(open).not.toHaveBeenCalled()
  })
})
