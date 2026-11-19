// @vitest-environment happy-dom
import { createElement } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'

import { ModelsSection } from '../browser/webview/settings/sections/ModelsSection'
import { SettingsBridgeContext } from '../browser/webview/nexusSettingsBridge'
import type { NexusSettingsBridge } from '../browser/webview/nexusSettingsBridge'
import type { BrowserBridgeTransport } from '../browser/bridge/browserBridgeProtocol'
import type { BrowserLlmCatalog, BrowserLlmProvider } from '../browser/bridge/protocol/nexus_llm'
import { I18nProvider } from '../browser/webview/i18n'
import type { NexusProviderConfig } from '../settings/settingsTypes'
import { sendsThroughView } from '../browser/webview/settings/modRouterView'

/**
 * Settings -> Models for a router provider (F-27): its row and add-menu entry
 * read "Router" from the catalog, its editor has no key or base-URL row, and
 * its "sends through" card names the providers it may use by their labels.
 */

const ROUTER = 'mod.relay.main'
const ALPHA = 'mod.alpha.main'
const BETA = 'mod.beta.main'

function modRow(id: string, name: string, over: Partial<NonNullable<BrowserLlmProvider['mod']>> = {}): BrowserLlmProvider {
  return {
    id,
    // The plain label differs from the shown name: names must come from `displayName`.
    label: `${name} plain`,
    iconSvg: '<svg viewBox="0 0 1 1"></svg>',
    enabled: false,
    models: [],
    mod: {
      state: 'ready',
      plugin: name.toLowerCase(),
      configId: `${name.toLowerCase()}@inline`,
      displayName: { en: name, de: `${name} DE` },
      defaultBaseUrl: 'https://api.example.test/v1',
      credentialMethods: ['apiKey'],
      secrets: [],
      settings: {
        endpoint: { type: 'string', title: 'Endpoint', binds: 'baseUrl' },
      },
      prompts: [],
      ...over,
    },
  }
}

function routerRow(routesTo: '*' | string[] | undefined): BrowserLlmProvider {
  return modRow(ROUTER, 'Relay', {
    kind: 'router',
    ...(routesTo !== undefined ? { routesTo } : {}),
    // Kept on purpose: the editor must hide the base-URL row for a router by its kind.
    credentialMethods: ['anonymous'],
  })
}

const ANON: NexusProviderConfig = { source: 'mod', credentialMode: 'anonymous' }

function harness(initialConfigs: Record<string, NexusProviderConfig>, providers: BrowserLlmProvider[]) {
  let configs = { ...initialConfigs }
  const upserts: Array<{ id: string; config: NexusProviderConfig }> = []
  const verifies: string[] = []
  const bridge = {
    request: vi.fn(async (route: { action: string }, payload: Record<string, unknown>) => {
      switch (route.action) {
        case 'list':
          return { configs, activeProviderId: undefined }
        case 'upsert': {
          const config = payload.config as NexusProviderConfig
          upserts.push({ id: payload.id as string, config })
          configs = { ...configs, [payload.id as string]: config }
          return { ok: true, configs }
        }
        case 'modOptions':
          return { ok: true, options: {}, storedSensitive: [] }
        case 'verify':
          verifies.push(payload.id as string)
          return { ok: true }
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
  const catalog: BrowserLlmCatalog = { providers }
  return { bridge, transport, catalog, upserts, verifies }
}

function mount(h: ReturnType<typeof harness>, locale = 'en') {
  render(
    createElement(
      I18nProvider,
      { locale },
      createElement(
        SettingsBridgeContext.Provider,
        { value: h.bridge },
        createElement(ModelsSection, { catalog: h.catalog, transport: h.transport }),
      ),
    ),
  )
}

afterEach(() => {
  cleanup()
  ;(globalThis as { __nexusUnsavedEdits?: number }).__nexusUnsavedEdits = 0
})

async function openEditor(id: string) {
  fireEvent.click(await screen.findByTestId(`models-provider-settings-${id}`))
  return screen.findByTestId('mod-provider-editor')
}

describe('a router in the lists', () => {
  it('the add menu marks a router with the catalog word, beside the other providers', async () => {
    mount(harness({}, [modRow(ALPHA, 'Alpha'), routerRow('*')]), 'de')
    fireEvent.keyDown(await screen.findByTestId('models-add-provider'), { key: 'Enter' })
    const item = await screen.findByTestId(`models-provider-select-option-${ROUTER}`)
    expect(item.textContent).toContain('Relay DE')
    expect(screen.getByTestId(`models-provider-router-mark-${ROUTER}`).textContent).toBe('Router')
    expect(screen.getByTestId(`models-provider-select-option-${ALPHA}`)).toBeTruthy()
    expect(screen.queryByTestId(`models-provider-router-mark-${ALPHA}`)).toBeNull()
  })

  it('the home row reads Router where a plugin provider reads Plugin provider', async () => {
    mount(harness({ [ROUTER]: ANON, [ALPHA]: ANON }, [modRow(ALPHA, 'Alpha'), routerRow('*')]))
    expect((await screen.findByTestId(`models-provider-kind-${ROUTER}`)).textContent).toBe('Router')
    expect(screen.getByTestId(`models-provider-kind-${ALPHA}`).textContent).toBe('Plugin provider')
  })
})

describe('the router editor', () => {
  it('has no key row, no base-URL row and no method choice, and never verifies', async () => {
    const h = harness({ [ROUTER]: ANON }, [routerRow('*')])
    mount(h)
    await openEditor(ROUTER)
    expect(screen.getByTestId('mod-router-panel')).toBeTruthy()
    expect(screen.queryByTestId('mod-prompt-api_key')).toBeNull()
    expect(screen.queryByTestId('mod-prompt-form')).toBeNull()
    expect(screen.queryByTestId('mod-base-url')).toBeNull()
    expect(screen.queryByTestId('mod-method-group')).toBeNull()
    expect(screen.queryByTestId('mod-anonymous-panel')).toBeNull()
    expect(screen.getByTestId('mod-router-on')).toBeTruthy()
    expect(h.verifies).toEqual([])
  })

  it('adding it writes the keyless entry once, with no key and no verify', async () => {
    const h = harness({}, [modRow(ALPHA, 'Alpha'), routerRow('*')])
    mount(h)
    fireEvent.keyDown(await screen.findByTestId('models-add-provider'), { key: 'Enter' })
    fireEvent.click(await screen.findByTestId(`models-provider-select-option-${ROUTER}`))
    fireEvent.click(await screen.findByTestId('mod-router-use'))
    await waitFor(() => expect(h.upserts).toHaveLength(1))
    expect(h.upserts[0]).toMatchObject({ id: ROUTER, config: { source: 'mod', credentialMode: 'anonymous' } })
    expect('apiKey' in h.upserts[0]!.config).toBe(false)
    await screen.findByTestId('mod-router-on')
    expect(h.verifies).toEqual([])
  })

  it('"*": any set-up provider, named by its label; not-set-up ones and routers are left out', async () => {
    const other = { ...routerRow('*'), id: 'mod.other.main' }
    mount(
      harness(
        { [ROUTER]: ANON, [ALPHA]: ANON, [BETA]: ANON, 'mod.other.main': ANON },
        [modRow(ALPHA, 'Alpha'), modRow(BETA, 'Beta'), modRow('mod.gamma.main', 'Gamma'), routerRow('*'), other],
      ),
    )
    await openEditor(ROUTER)
    const card = screen.getByTestId('mod-router-sends-through')
    expect(card.dataset.scope).toBe('any')
    expect(card.dataset.needsProviders).toBe('false')
    expect(screen.getByTestId('mod-router-scope').textContent).toBe('Any provider you have set up.')
    expect(screen.getByTestId(`mod-router-target-${ALPHA}`).textContent).toBe('Alpha')
    expect(screen.getByTestId(`mod-router-target-${BETA}`).textContent).toBe('Beta')
    expect(screen.queryByTestId('mod-router-target-mod.gamma.main')).toBeNull()
    expect(screen.queryByTestId('mod-router-target-mod.other.main')).toBeNull()
    expect(screen.queryByTestId(`mod-router-target-${ROUTER}`)).toBeNull()
    expect(screen.queryByTestId('mod-router-needs-providers')).toBeNull()
  })

  it('a list: the listed providers by label, set up or not, and the uninstalled ones counted', async () => {
    mount(
      harness(
        { [ROUTER]: ANON, [ALPHA]: ANON, [BETA]: ANON },
        [modRow(ALPHA, 'Alpha'), modRow(BETA, 'Beta'), modRow('mod.gamma.main', 'Gamma'), routerRow([BETA, 'mod.gamma.main', ALPHA, 'mod.gone.main'])],
      ),
    )
    await openEditor(ROUTER)
    expect(screen.getByTestId('mod-router-sends-through').dataset.scope).toBe('list')
    expect(screen.getByTestId('mod-router-scope').textContent).toBe('Only these providers:')
    const shown = [...screen.getByTestId('mod-router-targets').querySelectorAll('li')].map(li => li.textContent)
    expect(shown).toEqual(['Beta', 'Gamma (not set up)', 'Alpha'])
    expect(screen.getByTestId('mod-router-unknown').textContent).toBe('1 more listed, not installed.')
    expect(screen.queryByTestId('mod-router-needs-providers')).toBeNull()
  })

  it('one uninstalled provider reads in the singular', async () => {
    mount(harness({ [ROUTER]: ANON, [ALPHA]: ANON }, [modRow(ALPHA, 'Alpha'), routerRow([ALPHA, 'mod.gone.main'])]), 'fr')
    await openEditor(ROUTER)
    expect(screen.getByTestId('mod-router-unknown').textContent).toBe('1 autre listé, non installé.')
  })

  it('fewer than two to send through: says what a router is for and opens the add menu', async () => {
    mount(harness({ [ROUTER]: ANON, [ALPHA]: ANON }, [modRow(ALPHA, 'Alpha'), modRow(BETA, 'Beta'), routerRow('*')]))
    await openEditor(ROUTER)
    expect(screen.getByTestId('mod-router-sends-through').dataset.needsProviders).toBe('true')
    expect(screen.getByTestId('mod-router-needs-providers').textContent).toContain('It can reach 1 now')
    fireEvent.click(screen.getByTestId('mod-router-connect-provider'))
    expect(await screen.findByTestId('models-provider-home')).toBeTruthy()
    expect(await screen.findByTestId(`models-provider-select-option-${BETA}`)).toBeTruthy()
  })
})

describe('a provider that is not a router', () => {
  it('draws as before: key and base-URL rows, no router panel', async () => {
    mount(harness({}, [modRow(ALPHA, 'Alpha')]))
    fireEvent.keyDown(await screen.findByTestId('models-add-provider'), { key: 'Enter' })
    fireEvent.click(await screen.findByTestId(`models-provider-select-option-${ALPHA}`))
    await screen.findByTestId('mod-provider-editor')
    expect(screen.getByTestId('mod-prompt-api_key')).toBeTruthy()
    expect(screen.getByTestId('mod-base-url')).toBeTruthy()
    expect(screen.queryByTestId('mod-router-panel')).toBeNull()
    expect(screen.queryByTestId('mod-router-sends-through')).toBeNull()
  })
})

describe('sendsThroughView', () => {
  const rows = [
    { id: 'a', label: 'A', setUp: true, router: false },
    { id: 'b', label: 'B', setUp: false, router: false },
    { id: 'r', label: 'R', setUp: true, router: true },
  ]
  it('an unreadable boundary grants nothing', () => {
    expect(sendsThroughView(undefined, 'r', rows)).toMatchObject({ scope: 'list', targets: [], reachable: 0, needsProviders: true })
  })
  it('never lists itself or another router, even when named', () => {
    expect(sendsThroughView(['r', 'a'], 'self', rows).targets.map(target => target.id)).toEqual(['a'])
  })
})
