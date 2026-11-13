// @vitest-environment happy-dom
/**
 * Settings · Plugins, provider plugins: the enable flow's consent dialog (Enable records the baseline via
 * `providerUpdates.baseline`, then turns the plugin on; Cancel turns on nothing) and the row's update status from
 * `plugins/providerUpdates`; without `full` the status shows with no button.
 */
import { createElement } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'

import type { CapabilityAdvert } from '../browser/runtimeProtocol'
import { SettingsBridgeContext } from '../browser/webview/nexusSettingsBridge'
import { PluginsSection } from '../browser/webview/settings/sections/PluginsSection'
import {
  ProviderConsentDialog,
  ProviderUpdatePanel,
  grantDeltaLines,
} from '../browser/webview/settings/sections/ProviderModUpdates'
import { RuntimeCapabilitiesContext } from '../browser/webview/useCan'
import { queryFor } from './_helpers/capabilityQuery'
import { makeMockSettingsBridge } from './_helpers/mockSettingsBridge'
import type { RuntimeConnection } from '../browser/runtimeClient/RuntimeConnection'
import { createTranslate } from '../browser/webview/i18n'
import type { ProviderModUpdateStatus } from '../pluginHost/providerModUpdates'
import { PROVIDER_UPDATES_TOPIC } from '../pluginHost/providerUpdatesProtocol'

const memoryStorage = new Map<string, string>()
vi.stubGlobal('localStorage', {
  getItem: (k: string) => memoryStorage.get(k) ?? null,
  setItem: (k: string, v: string) => void memoryStorage.set(k, String(v)),
  removeItem: (k: string) => void memoryStorage.delete(k),
  clear: () => memoryStorage.clear(),
})

afterEach(() => {
  cleanup()
  localStorage.clear()
})

const t = createTranslate('en')

const GRANT = {
  providers: {
    zen: {
      domains: ['api.zen.example', 'cdn.zen.example'],
      secrets: ['session-token'],
      readsSecrets: true,
      requestNeeds: ['system', 'body'] as Array<'system' | 'tools' | 'body' | 'cwd'>,
      signNeeds: 'digest' as const,
    },
  },
}

function status(over: Partial<ProviderModUpdateStatus> = {}): ProviderModUpdateStatus {
  return {
    pluginId: 'zen-plugin@shop',
    state: 'up-to-date',
    grant: GRANT,
    consented: true,
    publisher: 'Zen Labs',
    activeVersion: '1.0.0',
    source: { url: 'https://example.com/zen.json' },
    lastCheckedAt: new Date(Date.now() - 5 * 60_000).toISOString(),
    ...over,
  } as ProviderModUpdateStatus
}

const NEEDS_CONSENT = status({
  state: 'needs-consent',
  pending: {
    version: '2.0.0',
    stagedAt: new Date().toISOString(),
    grant: GRANT,
    delta: {
      widened: true,
      added: {
        providers: ['turbo'],
        perProvider: {
          zen: {
            domains: ['telemetry.zen.example'],
            secrets: ['refresh-token'],
            readsSecrets: true,
            requestNeeds: ['tools'],
            signNeeds: 'body',
          },
          turbo: { domains: [], secrets: [], readsSecrets: false, requestNeeds: [] },
        },
      },
      removed: [],
    },
  },
  rollbackVersion: '0.9.0',
})

describe('ProviderConsentDialog', () => {
  function open(extra: { busy?: boolean; error?: string | null } = {}, s = status()) {
    const calls: string[] = []
    render(
      createElement(ProviderConsentDialog, {
        target: { name: 'zen-plugin', status: s },
        busy: extra.busy ?? false,
        error: extra.error ?? null,
        onEnable: () => calls.push('enable'),
        onCancel: () => calls.push('cancel'),
        t,
      }),
    )
    return calls
  }

  it('shows the publisher, each provider\'s domains, secrets, plain-text reading, needs, and the standing statement', () => {
    open()
    expect(screen.getByText('Turn on zen-plugin?')).toBeTruthy()
    expect(screen.getByTestId('consent-publisher').textContent).toBe('Published by Zen Labs')
    expect(screen.getByTestId('consent-provider-zen').textContent).toContain('Provider: zen')
    expect(screen.getByTestId('consent-domains-zen').textContent).toBe('May contact: api.zen.example, cdn.zen.example')
    expect(screen.getByTestId('consent-secrets-zen').textContent).toBe('Stores secrets named: session-token')
    expect(screen.getByTestId('consent-reads-secrets-zen').textContent).toMatch(/Reads its saved secrets in plain text/)
    expect(screen.getByTestId('consent-needs-zen').textContent).toBe(
      'Its code is shown, with each request: the system prompt, the whole request, including the conversation',
    )
    expect(screen.getByTestId('consent-sign-zen').textContent).toBe('Signs requests from a digest of the request.')
    expect(screen.getByTestId('consent-standing').textContent).toMatch(/receives the conversation it is sent/)
  })

  it('names the cwd need in plain words', () => {
    open({}, status({ grant: { providers: { zen: { ...GRANT.providers.zen, requestNeeds: ['system', 'cwd'] } } } }))
    expect(screen.getByTestId('consent-needs-zen').textContent).toBe(
      'Its code is shown, with each request: the system prompt, the folder the session is working in',
    )
  })

  it('lists the proxy hosts of a provider that declares an egress, and no such line otherwise', () => {
    open({}, status({ grant: { providers: { zen: { ...GRANT.providers.zen, proxies: ['proxy-a.zen.example', 'proxy-b.zen.example'] } } } }))
    expect(screen.getByTestId('consent-proxies-zen').textContent).toBe(
      'Sends your requests through these proxy servers instead of your own proxy setting: proxy-a.zen.example, proxy-b.zen.example',
    )
    cleanup()
    open()
    expect(screen.queryByTestId('consent-proxies-zen')).toBeNull()
  })

  it('says a pool of proxies is chosen by the code, and says more when it reaches local ones', () => {
    open({}, status({ grant: { providers: { zen: { ...GRANT.providers.zen, proxyPools: 'public' as const } } } }))
    expect(screen.getByTestId('consent-proxy-pools-zen').textContent).toBe(
      'Sends your requests through proxy servers its code chooses, instead of your own proxy setting. Their addresses are not shown here.',
    )
    cleanup()
    open({}, status({ grant: { providers: { zen: { ...GRANT.providers.zen, proxyPools: 'local' as const } } } }))
    expect(screen.getByTestId('consent-proxy-pools-zen').textContent).toContain('including ones on this computer or your local network')
    cleanup()
    open()
    expect(screen.queryByTestId('consent-proxy-pools-zen')).toBeNull()
  })

  it('says so plainly when a provider declares nothing, and when the publisher is unstated', () => {
    open(
      {},
      status({
        publisher: undefined,
        grant: { providers: { zen: { domains: [], secrets: [], readsSecrets: false, requestNeeds: [] } } },
      }),
    )
    expect(screen.getByTestId('consent-publisher').textContent).toBe('The publisher is not stated.')
    expect(screen.getByTestId('consent-domains-zen').textContent).toBe('Declares no domains to contact.')
    expect(screen.getByTestId('consent-secrets-zen').textContent).toBe('Stores no secrets of its own.')
    expect(screen.getByTestId('consent-reads-secrets-zen').textContent).toBe('Cannot read its saved secrets in plain text.')
    expect(screen.getByTestId('consent-needs-zen').textContent).toMatch(/only the basic facts/)
    expect(screen.queryByTestId('consent-sign-zen')).toBeNull()
  })

  it("an app's folders are listed, read and written apart, with their own intro and standing line; no provider, no provider line", () => {
    open({}, status({ grant: { providers: {}, folders: { read: ['~/Downloads'], write: ['~/Documents/invoices'] } } }))
    expect(screen.getByText(/runs in the background and asks to reach folders of yours/)).toBeTruthy()
    expect(screen.getByTestId('consent-folders-read').textContent).toBe('May read: ~/Downloads')
    expect(screen.getByTestId('consent-folders-write').textContent).toBe('May read and write: ~/Documents/invoices')
    expect(screen.getByTestId('consent-folders-standing').textContent).toMatch(/with no session open/)
    expect(screen.queryByTestId('consent-standing')).toBeNull()
    cleanup()
    open({}, status({ grant: { ...GRANT, folders: { read: ['~/Downloads'], write: [] } } }))
    expect(screen.getByText(/adds model providers and asks to reach folders of yours/)).toBeTruthy()
    expect(screen.getByTestId('consent-standing')).toBeTruthy()
    expect(screen.queryByTestId('consent-folders-write')).toBeNull()
  })

  it("an app's agent runs have their own block, naming the daily limit, and their own intro, with or without providers", () => {
    open({}, status({ grant: { providers: {}, agent: true } }))
    expect(screen.getByText(/runs in the background and asks to start agent runs on its own/)).toBeTruthy()
    expect(screen.getByTestId('consent-agent').textContent).toMatch(/^Agent runs.*at most 24 times a day for each of its apps, counted since .+ last started\..*runs no commands/)
    expect(screen.queryByTestId('consent-standing')).toBeNull()
    cleanup()
    open({}, status({ grant: { ...GRANT, agent: true } }))
    expect(screen.getByText(/adds model providers and asks to start agent runs on its own/)).toBeTruthy()
    expect(screen.getByTestId('consent-standing')).toBeTruthy()
  })

  it('Turn on and Cancel are the two ways out; a failure is shown inside the dialog', () => {
    const calls = open({ error: 'no connection' })
    expect(screen.getByTestId('consent-error').textContent).toBe("Couldn't turn it on: no connection")
    fireEvent.click(screen.getByTestId('consent-enable'))
    fireEvent.click(screen.getByTestId('consent-cancel'))
    expect(calls).toEqual(['enable', 'cancel'])
  })

  it('cannot be dismissed or double-submitted while it is working', () => {
    open({ busy: true })
    expect((screen.getByTestId('consent-enable') as HTMLButtonElement).disabled).toBe(true)
    expect((screen.getByTestId('consent-cancel') as HTMLButtonElement).disabled).toBe(true)
  })

  it('is closed with no target', () => {
    render(
      createElement(ProviderConsentDialog, { target: null, busy: false, error: null, onEnable() {}, onCancel() {}, t }),
    )
    expect(screen.queryByTestId('provider-consent-dialog')).toBeNull()
  })
})

describe('ProviderUpdatePanel', () => {
  function panel(s: ProviderModUpdateStatus, over: Partial<Parameters<typeof ProviderUpdatePanel>[0]> = {}) {
    const calls: string[] = []
    render(
      createElement(ProviderUpdatePanel, {
        name: 'zen-plugin',
        status: s,
        canCheck: true,
        canDecide: true,
        busy: null,
        error: null,
        onCheck: () => calls.push('check'),
        onApprove: v => calls.push(`approve ${v}`),
        onDecline: v => calls.push(`decline ${v}`),
        onRollback: () => calls.push('rollback'),
        formatTime: iso => `at ${iso.slice(0, 4)}`,
        t,
        ...over,
      }),
    )
    return calls
  }

  it('up to date: says so with when it was checked, and offers Check for updates', () => {
    const calls = panel(status())
    expect(screen.getByTestId('provider-updates-state-zen-plugin').textContent).toMatch(/^Up to date · checked at \d{4}$/)
    fireEvent.click(screen.getByTestId('provider-updates-check-zen-plugin'))
    expect(calls).toEqual(['check'])
    expect(screen.queryByTestId('provider-updates-pending-zen-plugin')).toBeNull()
  })

  it('says when a version was applied, silently or not', () => {
    panel(status({ applied: { version: '1.1.0', at: '2026-10-01T00:00:00.000Z', silent: true } }))
    expect(screen.getByTestId('provider-updates-applied-zen-plugin').textContent).toBe('Updated to version 1.1.0 automatically')
    cleanup()
    panel(status({ applied: { version: '1.2.0', at: '2026-10-01T00:00:00.000Z', silent: false } }))
    expect(screen.getByTestId('provider-updates-applied-zen-plugin').textContent).toBe('Updated to version 1.2.0')
  })

  it('needs-consent: lists every widening, and Approve / Decline / Roll back act on the versions shown', () => {
    const calls = panel(NEEDS_CONSENT)
    expect(screen.getByTestId('provider-updates-pending-zen-plugin').textContent).toMatch(/Version 2\.0\.0 is waiting for your approval/)
    const lines = [...screen.getByTestId('provider-updates-delta-zen-plugin').querySelectorAll('li')].map(li => li.textContent)
    expect(lines).toEqual([
      'New provider: turbo',
      'zen may now contact: telemetry.zen.example',
      'zen now stores secrets named: refresh-token',
      'zen now reads its saved secrets in plain text.',
      "zen's code is now also shown: the tool definitions",
      'zen now signs requests from the full request body.',
    ])
    fireEvent.click(screen.getByTestId('provider-updates-approve-zen-plugin'))
    fireEvent.click(screen.getByTestId('provider-updates-decline-zen-plugin'))
    fireEvent.click(screen.getByTestId('provider-updates-rollback-zen-plugin'))
    expect(calls).toEqual(['approve 2.0.0', 'decline 2.0.0', 'rollback'])
    expect(screen.getByTestId('provider-updates-rollback-zen-plugin').textContent).toBe('Roll back to version 0.9.0')
  })

  it('without the full grant it shows the status and no button', () => {
    panel(NEEDS_CONSENT, { canCheck: false, canDecide: false })
    expect(screen.getByTestId('provider-updates-pending-zen-plugin')).toBeTruthy()
    expect(screen.queryByTestId('provider-updates-approve-zen-plugin')).toBeNull()
    expect(screen.queryByTestId('provider-updates-decline-zen-plugin')).toBeNull()
    expect(screen.queryByTestId('provider-updates-rollback-zen-plugin')).toBeNull()
    expect(screen.queryByTestId('provider-updates-check-zen-plugin')).toBeNull()
  })

  it.each([
    ['fetch', 'the download failed'],
    ['integrity', 'the download does not match its checksum'],
    ['invalid-archive', 'the update package is not valid'],
    ['invalid-manifest', 'its description file is not valid'],
    ['unsupported-provider-api', 'it needs a newer version of Velloc'],
    ['no-providers', 'it no longer adds any provider'],
    ['name-mismatch', 'it is for a different plugin'],
    ['source-missing', 'the plugin is no longer listed at its update source'],
    ['admission', 'its code was refused as unsafe to run'],
    ['activate', 'it could not be switched on, so the previous version keeps running'],
  ] as const)('a %s failure is put in plain words, with the detail as given', (kind, words) => {
    panel(status({ state: 'failed', failure: { at: 'x', kind, reason: 'ECONNRESET at 10.0.0.1', version: '2.0.0' } }))
    const failure = screen.getByTestId('provider-updates-failure-zen-plugin')
    expect(failure.getAttribute('data-failure-kind')).toBe(kind)
    expect(failure.textContent).toBe(`Couldn't update to version 2.0.0: ${words}ECONNRESET at 10.0.0.1`)
  })

  it('a failure with no version is a failed check', () => {
    panel(status({ state: 'failed', failure: { at: 'x', kind: 'fetch', reason: 'HTTP 503' } }))
    expect(screen.getByTestId('provider-updates-failure-zen-plugin').textContent).toBe(
      "Couldn't check for updates: the download failedHTTP 503",
    )
  })

  it('shows nothing for a plugin with no source, no failure, nothing parked and nothing to roll back', () => {
    const { container } = render(
      createElement(ProviderUpdatePanel, {
        name: 'x',
        status: status({ state: 'no-source', source: undefined, lastCheckedAt: undefined }),
        canCheck: true,
        canDecide: true,
        busy: null,
        error: null,
        onCheck() {},
        onApprove() {},
        onDecline() {},
        onRollback() {},
        formatTime: iso => iso,
        t,
      }),
    )
    expect(container.textContent).toBe('')
  })

  it('an update that adds cwd says so in the same plain words', () => {
    const parked = status({
      state: 'needs-consent',
      pending: {
        ...NEEDS_CONSENT.pending!,
        delta: {
          widened: true,
          added: {
            providers: [],
            perProvider: { zen: { domains: [], secrets: [], readsSecrets: false, requestNeeds: ['cwd'] } },
          },
          removed: [],
        },
      },
    })
    expect(grantDeltaLines(parked, t)).toEqual(["zen's code is now also shown: the folder the session is working in"])
  })

  it('an update that adds a proxy host names it', () => {
    const parked = status({
      state: 'needs-consent',
      pending: {
        ...NEEDS_CONSENT.pending!,
        delta: {
          widened: true,
          added: {
            providers: [],
            perProvider: { zen: { domains: [], secrets: [], readsSecrets: false, requestNeeds: [], proxies: ['proxy.zen.example'] } },
          },
          removed: [],
        },
      },
    })
    expect(grantDeltaLines(parked, t)).toEqual(['zen may now send requests through: proxy.zen.example'])
  })

  it('an update that adds a pool of proxies says so', () => {
    const parked = (proxyPools: 'public' | 'local') =>
      status({
        state: 'needs-consent',
        pending: {
          ...NEEDS_CONSENT.pending!,
          delta: {
            widened: true,
            added: { providers: [], perProvider: { zen: { domains: [], secrets: [], readsSecrets: false, requestNeeds: [], proxyPools } } },
            removed: [],
          },
        },
      })
    expect(grantDeltaLines(parked('public'), t)).toEqual(['zen may now send requests through proxy servers its code chooses'])
    expect(grantDeltaLines(parked('local'), t)).toEqual([
      'zen may now send requests through proxy servers its code chooses, including ones on this computer or your local network',
    ])
  })

  it('grantDeltaLines names agent runs newly asked for', () => {
    const parked = status({
      ...NEEDS_CONSENT,
      pending: { ...NEEDS_CONSENT.pending!, delta: { widened: true, added: { providers: [], perProvider: {}, agent: true }, removed: [] } },
    })
    expect(grantDeltaLines(parked, t)).toEqual(['Asks to start agent runs on its own'])
  })

  it('grantDeltaLines reads nothing when nothing is parked', () => {
    expect(grantDeltaLines(status(), t)).toEqual([])
  })
})

// ── the Plugins page ──

const FULL: CapabilityAdvert[] = [
  { cap: 'plugins', acts: ['listInstalled', 'listMarketplaces', 'listMarketplacePlugins', 'setEnabled'] },
  { cap: 'providerUpdates', acts: ['check', 'consent', 'decline', 'rollback', 'baseline'] },
]
const MANAGER: CapabilityAdvert[] = [{ cap: 'plugins', acts: ['listInstalled', 'listMarketplaces', 'listMarketplacePlugins', 'setEnabled'] }]

function pageRig(options: { enabled: boolean; states: ProviderModUpdateStatus[] }) {
  const calls: string[] = []
  const requests: Array<{ route: string; payload: unknown }> = []
  const bridge = makeMockSettingsBridge({
    'plugins.listInstalled': () => ({
      plugins: [
        {
          name: 'zen-plugin',
          marketplace: 'shop',
          scope: 'user',
          installPath: '/plugins/zen',
          version: '1.0.0',
          enabled: options.enabled,
          enabledSource: 'explicit',
        },
      ],
    }),
    'plugins.listMarketplaces': () => ({ marketplaces: [] }),
    'plugins.setEnabled': (payload: unknown) => {
      calls.push('plugins.setEnabled')
      requests.push({ route: 'plugins.setEnabled', payload })
      return { ok: true, effectiveEnabled: true }
    },
  })
  const conn = {
    subscribe: (topic: string, listener: (event: { payload: unknown }) => void) => {
      if (topic === PROVIDER_UPDATES_TOPIC) {
        queueMicrotask(() => listener({ payload: { plugins: options.states }, form: 'snapshot' } as never))
      }
      return () => {}
    },
    request: async (route: string, payload: unknown) => {
      calls.push(route)
      requests.push({ route, payload })
      return {}
    },
  } as unknown as RuntimeConnection
  return { bridge, calls, requests, connection: () => Promise.resolve(conn) }
}

function renderPage(rig: ReturnType<typeof pageRig>, adverts: CapabilityAdvert[]) {
  render(
    createElement(
      RuntimeCapabilitiesContext.Provider,
      { value: queryFor(adverts) },
      createElement(
        SettingsBridgeContext.Provider,
        { value: rig.bridge },
        createElement(PluginsSection, { runtimeConnection: rig.connection }),
      ),
    ),
  )
}

describe('PluginsSection — turning on a provider plugin', () => {
  it('opens the consent dialog first; Cancel turns on nothing', async () => {
    const rig = pageRig({ enabled: false, states: [status()] })
    renderPage(rig, FULL)
    await screen.findByTestId('installed-plugin-zen-plugin')
    await screen.findByTestId('provider-updates-zen-plugin')
    fireEvent.click(screen.getByTestId('plugin-toggle-zen-plugin'))
    expect(await screen.findByTestId('provider-consent-dialog')).toBeTruthy()
    expect(rig.calls).toEqual([])
    fireEvent.click(screen.getByTestId('consent-cancel'))
    await waitFor(() => expect(screen.queryByTestId('provider-consent-dialog')).toBeNull())
    expect(rig.calls).toEqual([])
  })

  it('Turn on records the baseline the person saw, then enables the plugin', async () => {
    const rig = pageRig({ enabled: false, states: [status()] })
    renderPage(rig, FULL)
    await screen.findByTestId('provider-updates-zen-plugin')
    fireEvent.click(screen.getByTestId('plugin-toggle-zen-plugin'))
    fireEvent.click(await screen.findByTestId('consent-enable'))
    await waitFor(() => expect(rig.calls).toContain('plugins.setEnabled'))
    expect(rig.calls).toEqual(['providerUpdates.baseline', 'plugins.setEnabled'])
    expect(rig.requests[0]).toEqual({ route: 'providerUpdates.baseline', payload: { pluginId: 'zen-plugin@shop' } })
    await waitFor(() => expect(screen.queryByTestId('provider-consent-dialog')).toBeNull())
  })

  it('turning it OFF asks nothing', async () => {
    const rig = pageRig({ enabled: true, states: [status()] })
    renderPage(rig, FULL)
    await screen.findByTestId('provider-updates-zen-plugin')
    fireEvent.click(screen.getByTestId('plugin-toggle-zen-plugin'))
    await waitFor(() => expect(rig.calls).toEqual(['plugins.setEnabled']))
    expect(screen.queryByTestId('provider-consent-dialog')).toBeNull()
  })

  it('a plugin with no provider is turned on as before', async () => {
    const rig = pageRig({ enabled: false, states: [] })
    renderPage(rig, FULL)
    await screen.findByTestId('installed-plugin-zen-plugin')
    fireEvent.click(screen.getByTestId('plugin-toggle-zen-plugin'))
    await waitFor(() => expect(rig.calls).toEqual(['plugins.setEnabled']))
  })

  it('a connection without the full grant is told to do it on this computer, and nothing is enabled', async () => {
    const rig = pageRig({ enabled: false, states: [status()] })
    renderPage(rig, MANAGER)
    await screen.findByTestId('provider-updates-zen-plugin')
    fireEvent.click(screen.getByTestId('plugin-toggle-zen-plugin'))
    expect(await screen.findByText(/Providers can only be turned on from this computer/)).toBeTruthy()
    expect(rig.calls).toEqual([])
    expect(screen.queryByTestId('provider-consent-dialog')).toBeNull()
    // The status still reads, with no button.
    expect(screen.queryByTestId('provider-updates-check-zen-plugin')).toBeNull()
  })
})

describe('PluginsSection — the update status of a provider plugin', () => {
  it('Check for updates, Approve, Decline and Roll back ask the runtime with the plugin id and the version shown', async () => {
    const rig = pageRig({ enabled: true, states: [NEEDS_CONSENT] })
    renderPage(rig, FULL)
    fireEvent.click(await screen.findByTestId('provider-updates-check-zen-plugin'))
    await waitFor(() => expect(rig.calls).toContain('providerUpdates.check'))
    fireEvent.click(screen.getByTestId('provider-updates-approve-zen-plugin'))
    await waitFor(() => expect(rig.calls).toContain('providerUpdates.consent'))
    fireEvent.click(screen.getByTestId('provider-updates-decline-zen-plugin'))
    await waitFor(() => expect(rig.calls).toContain('providerUpdates.decline'))
    fireEvent.click(screen.getByTestId('provider-updates-rollback-zen-plugin'))
    await waitFor(() => expect(rig.calls).toContain('providerUpdates.rollback'))
    expect(rig.requests.filter(r => r.route.startsWith('providerUpdates.')).map(r => [r.route, r.payload])).toEqual([
      ['providerUpdates.check', { pluginId: 'zen-plugin@shop' }],
      ['providerUpdates.consent', { pluginId: 'zen-plugin@shop', version: '2.0.0' }],
      ['providerUpdates.decline', { pluginId: 'zen-plugin@shop', version: '2.0.0' }],
      ['providerUpdates.rollback', { pluginId: 'zen-plugin@shop' }],
    ])
  })

  it('a refused ask is shown on the row, in the runtime\'s words', async () => {
    const rig = pageRig({ enabled: true, states: [NEEDS_CONSENT] })
    const failing = {
      subscribe: (topic: string, listener: (event: { payload: unknown }) => void) => {
        if (topic === PROVIDER_UPDATES_TOPIC) {
          queueMicrotask(() => listener({ payload: { plugins: [NEEDS_CONSENT] }, form: 'snapshot' } as never))
        }
        return () => {}
      },
      request: async () => {
        throw new Error('zen-plugin@shop has no parked update 2.0.0 waiting for consent')
      },
    } as unknown as RuntimeConnection
    renderPage({ ...rig, connection: () => Promise.resolve(failing) }, FULL)
    fireEvent.click(await screen.findByTestId('provider-updates-approve-zen-plugin'))
    expect((await screen.findByTestId('provider-updates-error-zen-plugin')).textContent).toBe(
      "Couldn't do that: zen-plugin@shop has no parked update 2.0.0 waiting for consent",
    )
  })

  it('shows no update line for a runtime that publishes nothing (older runtime, no provider plugin)', async () => {
    const rig = pageRig({ enabled: true, states: [] })
    renderPage(rig, FULL)
    await screen.findByTestId('installed-plugin-zen-plugin')
    expect(screen.queryByTestId('provider-updates-zen-plugin')).toBeNull()
  })
})

describe('PluginsSection - an enabled plugin the person never approved', () => {
  const UNAPPROVED = status({ consented: false })

  it('offers Review and turn on; approving records the baseline and switches nothing', async () => {
    const rig = pageRig({ enabled: true, states: [UNAPPROVED] })
    renderPage(rig, FULL)
    expect((await screen.findByTestId('provider-unapproved-zen-plugin')).textContent).toMatch(/switched off until you approve/)
    fireEvent.click(screen.getByTestId('provider-review-zen-plugin'))
    expect(await screen.findByTestId('provider-consent-dialog')).toBeTruthy()
    fireEvent.click(screen.getByTestId('consent-enable'))
    await waitFor(() => expect(rig.calls).toContain('providerUpdates.baseline'))
    await waitFor(() => expect(screen.queryByTestId('provider-consent-dialog')).toBeNull())
    expect(rig.calls).toEqual(['providerUpdates.baseline'])
  })

  it('Cancel changes nothing', async () => {
    const rig = pageRig({ enabled: true, states: [UNAPPROVED] })
    renderPage(rig, FULL)
    fireEvent.click(await screen.findByTestId('provider-review-zen-plugin'))
    fireEvent.click(await screen.findByTestId('consent-cancel'))
    await waitFor(() => expect(screen.queryByTestId('provider-consent-dialog')).toBeNull())
    expect(rig.calls).toEqual([])
  })

  it('an approved plugin has no such line; a connection without the full grant sees the line and no button', async () => {
    const approved = pageRig({ enabled: true, states: [status()] })
    renderPage(approved, FULL)
    await screen.findByTestId('provider-updates-zen-plugin')
    expect(screen.queryByTestId('provider-unapproved-zen-plugin')).toBeNull()
    cleanup()
    const rig = pageRig({ enabled: true, states: [UNAPPROVED] })
    renderPage(rig, MANAGER)
    await screen.findByTestId('provider-unapproved-zen-plugin')
    expect(screen.queryByTestId('provider-review-zen-plugin')).toBeNull()
  })
})

describe('PluginsSection - a plugin whose apps ask for folders and that carries no provider', () => {
  const FOLDERS_ONLY = status({ consented: false, grant: { providers: {}, folders: { read: ['~/Downloads'], write: [] } } })

  it('turning it on opens the consent dialog with its folders; Turn on records the baseline, then enables it', async () => {
    const rig = pageRig({ enabled: false, states: [FOLDERS_ONLY] })
    renderPage(rig, FULL)
    await screen.findByTestId('provider-updates-zen-plugin')
    fireEvent.click(screen.getByTestId('plugin-toggle-zen-plugin'))
    expect(await screen.findByTestId('provider-consent-dialog')).toBeTruthy()
    expect(screen.getByTestId('consent-folders-read').textContent).toBe('May read: ~/Downloads')
    expect(rig.calls).toEqual([])
    fireEvent.click(screen.getByTestId('consent-enable'))
    await waitFor(() => expect(rig.calls).toEqual(['providerUpdates.baseline', 'plugins.setEnabled']))
  })

  it('left on and never approved, its line speaks of folders, not providers', async () => {
    const rig = pageRig({ enabled: true, states: [FOLDERS_ONLY] })
    renderPage(rig, FULL)
    expect((await screen.findByTestId('provider-unapproved-zen-plugin')).textContent).toBe(
      "Its apps can't reach your folders until you approve them.Review and turn on",
    )
  })

  it('asking for agent runs and no folders, left on and never approved, its line speaks of the agent', async () => {
    const rig = pageRig({ enabled: true, states: [status({ consented: false, grant: { providers: {}, agent: true } })] })
    renderPage(rig, FULL)
    expect((await screen.findByTestId('provider-unapproved-zen-plugin')).textContent).toBe(
      "Its apps can't run the agent until you approve them.Review and turn on",
    )
  })
})
