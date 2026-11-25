// @vitest-environment happy-dom
/**
 * A router's `recognizes.hosts` (F-27): the manifest check, the two facts the
 * peers table adds for such a router (`recognizedHost`, `baseUrlChanged`),
 * that nothing else of a base URL reaches it, and the consent the person
 * gives for the list.
 */
import { createElement } from 'react'
import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import { createTranslate } from '../browser/webview/i18n'
import { ProviderConsentDialog, grantDeltaLines } from '../browser/webview/settings/sections/ProviderModUpdates'
import type { ProviderDefinition } from '../config/nexusModelConfig/providerDefinition'
import {
  BUILTIN_PROVIDER_DEFINITIONS,
  registerModProviderDefinition,
  resetModProviderDefinitions,
} from '../config/nexusModelConfig/providers'
import { registerProviderRouter, resetProviderRouters } from '../models/drivers/providerRouter'
import { resetRuntimeProviders, setRuntimeProviderConfigs } from '../models/drivers/runtimeProviders'
import { runtimePeersTable } from '../mods/provider/nouns/providerPeersNoun'
import { PROVIDER_WIRE_FORMATS } from '../mods/provider/providerManifest'
import { baseUrlChanged, recognizedHostOf } from '../mods/provider/routerRecognizes'
import { checkPluginDescriptor } from '../pluginHost/manifestValidator'
import { pluginGrantOf, widened, type Grant } from '../pluginHost/providerGrant'
import type { ProviderModUpdateStatus } from '../pluginHost/providerModUpdates'
import type { NexusProviderConfig } from '../settings/settingsTypes'

const t = createTranslate('en')
const ROUTER_ID = 'mod.hub.router'
const HOSTS = ['gateway.vendor-a.test', '*.vendor-b.test']

/** A built-in with a default base URL of its own. */
const BUILTIN = BUILTIN_PROVIDER_DEFINITIONS.find(d => d.config.defaultBaseUrl?.startsWith('https://'))!
const BUILTIN_ID = BUILTIN.config.providerId
const BUILTIN_ORIGIN = new URL(BUILTIN.config.defaultBaseUrl!).origin

afterEach(() => {
  cleanup()
  resetProviderRouters()
  resetRuntimeProviders()
  resetModProviderDefinitions()
})

const ROUTER_MANIFEST = {
  providerApi: 1,
  kind: 'router',
  displayName: 'Hub',
  routesTo: '*',
  credentials: { methods: ['anonymous'] },
  module: './providers/router.js',
}

function check(router: Record<string, unknown>) {
  const { manifest, errors } = checkPluginDescriptor({ name: 'hub', version: '1.0.0', providers: { router } })
  return { manifest, router: manifest?.providers?.router, errors: errors.join('\n') }
}

describe('recognizes in the manifest', () => {
  it('keeps plain and suffix entries on a router, trimmed, lower case and once each', () => {
    const { router, errors } = check({
      ...ROUTER_MANIFEST,
      recognizes: { hosts: [' Gateway.Vendor-A.test', 'gateway.vendor-a.test', '*.vendor-b.test'] },
    })
    expect(errors).toBe('')
    expect(router?.recognizes).toEqual({ hosts: ['gateway.vendor-a.test', '*.vendor-b.test'] })
  })

  it.each([
    ['a bare wildcard', ['*']],
    ['a wildcard inside a name', ['api.*.vendor-a.test']],
    ['a partial wildcard', ['a*.vendor-a.test']],
    ['a wildcard top-level domain', ['*.test']],
    ['a URL', ['https://gateway.vendor-a.test']],
    ['a port', ['gateway.vendor-a.test:443']],
    ['an IP address', ['10.0.0.5']],
    ['localhost', ['localhost']],
    ['a local name', ['*.localhost']],
    ['an empty list', []],
    ['65 entries', Array.from({ length: 65 }, (_, i) => `h${i}.vendor-a.test`)],
  ])('refuses %s', (_, hosts) => {
    const { router, errors } = check({ ...ROUTER_MANIFEST, recognizes: { hosts } })
    expect(router).toBeUndefined()
    expect(errors).toMatch(/recognizes\.hosts/)
  })

  it('takes 64 entries', () => {
    const hosts = Array.from({ length: 64 }, (_, i) => `h${i}.vendor-a.test`)
    expect(check({ ...ROUTER_MANIFEST, recognizes: { hosts } }).errors).toBe('')
  })

  it('is a router\'s alone', () => {
    const { errors } = check({
      providerApi: 1,
      displayName: 'Plain',
      defaultBaseUrl: 'https://api.vendor-a.test/v1',
      domains: ['api.vendor-a.test'],
      format: PROVIDER_WIRE_FORMATS[0],
      credentials: { methods: ['apiKey'] },
      recognizes: { hosts: ['api.vendor-a.test'] },
      module: './providers/plain.js',
    })
    expect(errors).toMatch(/recognizes: only a router/)
  })
})

describe('matching a base URL', () => {
  it('names the entry as listed: an equal host, or a sub-domain of a suffix entry', () => {
    expect(recognizedHostOf(HOSTS, 'https://gateway.vendor-a.test/api/v1')).toBe('gateway.vendor-a.test')
    expect(recognizedHostOf(HOSTS, 'https://GATEWAY.vendor-a.test.:8443/x?y=1')).toBe('gateway.vendor-a.test')
    expect(recognizedHostOf(HOSTS, 'https://eu.api.vendor-b.test/v1')).toBe('*.vendor-b.test')
  })

  it('matches nothing else', () => {
    expect(recognizedHostOf(HOSTS, 'https://vendor-b.test/v1')).toBeUndefined()
    expect(recognizedHostOf(HOSTS, 'https://gateway.vendor-a.test.evil.test/v1')).toBeUndefined()
    expect(recognizedHostOf(HOSTS, 'https://evilvendor-b.test/v1')).toBeUndefined()
    expect(recognizedHostOf(HOSTS, 'ftp://gateway.vendor-a.test/')).toBeUndefined()
    expect(recognizedHostOf(HOSTS, 'not a url')).toBeUndefined()
    expect(recognizedHostOf(HOSTS, undefined)).toBeUndefined()
  })

  it('never matches a loopback or private-network address', () => {
    for (const url of ['http://127.0.0.1:8080', 'http://[::1]/v1', 'http://10.0.0.5/v1', 'http://localhost/v1', 'http://x.vendor-b.test.localhost/']) {
      expect(recognizedHostOf([...HOSTS, '*.vendor-b.test.localhost'], url)).toBeUndefined()
    }
  })

  it('a changed base URL is another origin than the default; no default, no answer', () => {
    expect(baseUrlChanged('https://api.vendor-a.test/v2', 'https://api.vendor-a.test/v1')).toBe(false)
    expect(baseUrlChanged(undefined, 'https://api.vendor-a.test/v1')).toBe(false)
    expect(baseUrlChanged('https://proxy.vendor-c.test/v1', 'https://api.vendor-a.test/v1')).toBe(true)
    expect(baseUrlChanged('http://api.vendor-a.test/v1', 'https://api.vendor-a.test/v1')).toBe(true)
    expect(baseUrlChanged('https://api.vendor-a.test:8443/v1', 'https://api.vendor-a.test/v1')).toBe(true)
    expect(baseUrlChanged('https://relay.vendor-c.test/v1', undefined)).toBeUndefined()
  })
})

describe('the peers a recognizing router sees', () => {
  function router(recognizes?: string[]): void {
    registerModProviderDefinition({
      config: { providerId: ROUTER_ID, models: [] },
      runtimeOnly: true,
      label: 'Hub',
      catalogMod: {
        state: 'ready',
        plugin: 'hub',
        kind: 'router',
        routesTo: '*',
        credentialMethods: ['anonymous'],
        ...(recognizes ? { recognizes } : {}),
      },
    } as unknown as ProviderDefinition)
    registerProviderRouter(ROUTER_ID, { route: async () => undefined }, { routesTo: '*' })
  }
  const custom = (baseUrl: string): NexusProviderConfig => ({ isCustomProvider: true, displayName: 'Relay', hasApiKey: true, baseUrl })
  const peer = (id: string) => runtimePeersTable(ROUTER_ID).find(each => each.id === id)

  it('a custom provider pointing at a listed host carries the entry', () => {
    router(HOSTS)
    setRuntimeProviderConfigs({ 'custom-a': custom('https://gateway.vendor-a.test/api/v1'), 'custom-b': custom('https://eu.vendor-b.test') })
    expect(peer('custom-a')?.recognizedHost).toBe('gateway.vendor-a.test')
    expect(peer('custom-b')?.recognizedHost).toBe('*.vendor-b.test')
    expect(peer('custom-a')).not.toHaveProperty('baseUrlChanged')
  })

  it('a custom provider pointing elsewhere carries no entry, and its host is nowhere in the table', () => {
    router(HOSTS)
    setRuntimeProviderConfigs({
      'custom-x': custom('https://relay.unlisted-vendor.test:9443/secret-path?team=blue'),
      'custom-l': custom('http://127.0.0.1:11434/v1'),
    })
    expect(peer('custom-x')).toBeDefined()
    expect(peer('custom-x')).not.toHaveProperty('recognizedHost')
    expect(peer('custom-l')).not.toHaveProperty('recognizedHost')
    expect(JSON.stringify(runtimePeersTable(ROUTER_ID))).not.toMatch(/unlisted-vendor|secret-path|team=blue|9443|127\.0\.0\.1|11434/)
  })

  it('a built-in whose address was changed says so; its default address does not', () => {
    router(HOSTS)
    setRuntimeProviderConfigs({ [BUILTIN_ID]: { hasApiKey: true, baseUrl: 'https://proxy.vendor-c.test/v1' } })
    expect(peer(BUILTIN_ID)?.baseUrlChanged).toBe(true)
    expect(JSON.stringify(peer(BUILTIN_ID))).not.toMatch(/vendor-c/)
    setRuntimeProviderConfigs({ [BUILTIN_ID]: { hasApiKey: true, baseUrl: `${BUILTIN_ORIGIN}/another/path` } })
    expect(peer(BUILTIN_ID)).not.toHaveProperty('baseUrlChanged')
    setRuntimeProviderConfigs({ [BUILTIN_ID]: { hasApiKey: true } })
    expect(peer(BUILTIN_ID)).not.toHaveProperty('baseUrlChanged')
  })

  it('a router without recognizes gets neither field', () => {
    router()
    setRuntimeProviderConfigs({
      'custom-a': custom('https://gateway.vendor-a.test/api/v1'),
      [BUILTIN_ID]: { hasApiKey: true, baseUrl: 'https://proxy.vendor-c.test/v1' },
    })
    for (const each of runtimePeersTable(ROUTER_ID)) {
      expect(each).not.toHaveProperty('recognizedHost')
      expect(each).not.toHaveProperty('baseUrlChanged')
    }
  })
})

describe('consent to recognizes', () => {
  const grantWith = (hosts?: string[]): Grant => {
    const { manifest, errors } = check({ ...ROUTER_MANIFEST, ...(hosts ? { recognizes: { hosts } } : {}) })
    expect(errors).toBe('')
    return pluginGrantOf(manifest)
  }
  const status = (grant: Grant, over: Partial<ProviderModUpdateStatus> = {}) =>
    ({ pluginId: 'hub@shop', state: 'up-to-date', grant, consented: false, activeVersion: '1.0.0', ...over }) as ProviderModUpdateStatus

  it('the grant holds the entries; a newly listed one widens it', () => {
    const agreed = grantWith(['gateway.vendor-a.test'])
    expect(agreed.providers.router?.recognizes).toEqual(['gateway.vendor-a.test'])
    expect(grantWith().providers.router).not.toHaveProperty('recognizes')
    const next = grantWith(HOSTS)
    expect(widened(agreed, next)).toMatchObject({ widened: true, added: { perProvider: { router: { recognizes: ['*.vendor-b.test'] } } } })
    expect(widened(next, agreed).widened).toBe(false)
  })

  it('the dialog lists the services, and the update notice names a new one', () => {
    const grant = grantWith(HOSTS)
    render(
      createElement(ProviderConsentDialog, {
        target: { name: 'RouterHub', status: status(grant) },
        busy: false,
        error: null,
        onEnable: () => {},
        onCancel: () => {},
        t,
      }),
    )
    expect(screen.getByTestId('consent-recognizes-router').textContent).toBe(
      'RouterHub will know whether you have set up these services: *.vendor-b.test, gateway.vendor-a.test',
    )
    const agreed = grantWith(['gateway.vendor-a.test'])
    const lines = grantDeltaLines(
      status(agreed, {
        state: 'needs-consent',
        pending: { version: '2.0.0', stagedAt: new Date(0).toISOString(), grant, delta: widened(agreed, grant) },
      } as Partial<ProviderModUpdateStatus>),
      t,
    )
    expect(lines).toEqual(['router may now know whether you have set up: *.vendor-b.test'])
  })
})
