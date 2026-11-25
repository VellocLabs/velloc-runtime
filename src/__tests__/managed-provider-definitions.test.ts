// @vitest-environment happy-dom
/**
 * A provider definition a router manages (`providers.<key>.managedBy`, F-27):
 * the manifest check, the catalog row, which router reaches it, and where it
 * is left out of what the person picks from.
 */
import { createElement as h } from 'react'
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'

import type { BrowserLlmCatalog, BrowserLlmProvider } from '../browser/bridge/protocol/nexus_llm'
import { isSelectionEnabled } from '../browser/webview/modelCatalog'
import { isManagedProvider } from '../browser/webview/settings/modRouterView'
import { NexusModelPicker } from '../browser/webview/topbar/NexusModelPicker'
import { checkRouteAnswer, type RouteAnswerFacts } from '../models/drivers/providerRouteAnswer'
import { routerReaches } from '../models/drivers/providerRouter'
import { modProviderDefinition } from '../mods/provider/modProviderDefinition'
import { peersTableFor, type PeerInstance } from '../mods/provider/nouns/providerPeersNoun'
import { PROVIDER_WIRE_FORMATS, resolveProviders } from '../mods/provider/providerManifest'
import { checkPluginDescriptor } from '../pluginHost/manifestValidator'

const ROUTER = {
  providerApi: 1,
  kind: 'router',
  displayName: { en: 'Hub' },
  credentials: { methods: ['anonymous'] },
  routesTo: '*',
  module: './providers/router.js',
}

const POOL = {
  providerApi: 1,
  displayName: { en: 'Pool' },
  defaultBaseUrl: 'https://pool.example/v1',
  domains: ['pool.example'],
  format: PROVIDER_WIRE_FORMATS[0],
  credentials: { methods: ['anonymous'] },
  module: './providers/pool.js',
}

function check(providers: Record<string, unknown>) {
  const { manifest, errors } = checkPluginDescriptor({ name: 'hub', version: '1.0.0', providers })
  return { providers: manifest?.providers, errors: errors.join('\n') }
}

describe('manifest: managedBy', () => {
  it('keeps the key of a router of the same plugin', () => {
    const { providers, errors } = check({ router: ROUTER, pool: { ...POOL, managedBy: 'router' } })
    expect(errors).toBe('')
    expect(providers?.pool?.managedBy).toBe('router')
    expect(providers?.router?.managedBy).toBeUndefined()
  })

  it('refuses a key that is not a router of this plugin, and keeps the others', () => {
    const missing = check({ router: ROUTER, pool: { ...POOL, managedBy: 'nobody' } })
    expect(Object.keys(missing.providers ?? {})).toEqual(['router'])
    expect(missing.errors).toMatch(/providers\.pool\.managedBy: "nobody" is not a router of this plugin/)

    const plain = check({ router: ROUTER, pool: { ...POOL, managedBy: 'other' }, other: { ...POOL, module: './providers/other.js' } })
    expect(Object.keys(plain.providers ?? {}).sort()).toEqual(['other', 'router'])
    expect(plain.errors).toMatch(/providers\.pool\.managedBy: "other" is not a router of this plugin/)
  })

  it('refuses a router that was itself left out', () => {
    // The router shares the provider's module, so it is not loaded and manages nothing.
    const { providers, errors } = check({ pool: { ...POOL, managedBy: 'router' }, router: { ...ROUTER, module: './providers/pool.js' } })
    expect(providers).toBeUndefined()
    expect(errors).toMatch(/providers\.pool\.managedBy: "router" is not a router of this plugin/)
  })

  it.each([
    ['a value that is not a key', { managedBy: 'mod.hub.router' }, /managedBy: expected the key of a router/],
    ['a list', { managedBy: ['router'] }, /managedBy: expected the key of a router/],
    ['a settings app of its own', { managedBy: 'router', settingsApp: 'console' }, /managedBy: a managed provider has no settingsApp of its own/],
  ])('refuses %s', (_name, over, message) => {
    const { providers, errors } = check({ router: ROUTER, pool: { ...POOL, ...over } })
    expect(Object.keys(providers ?? {})).toEqual(['router'])
    expect(errors).toMatch(message)
  })

  it('refuses a managed router', () => {
    const { providers, errors } = check({ router: ROUTER, second: { ...ROUTER, module: './providers/second.js', managedBy: 'router' } })
    expect(Object.keys(providers ?? {})).toEqual(['router'])
    expect(errors).toMatch(/providers\.second\.managedBy: a router is not managed by another router/)
  })
})

describe('the catalog row of a managed provider', () => {
  it('names its router by provider id', () => {
    const { providers } = check({ router: ROUTER, pool: { ...POOL, managedBy: 'router' } })
    const resolved = resolveProviders('hub', '/plugins/hub', providers!)
    const definitionOf = (key: string) =>
      modProviderDefinition({ plugin: 'hub', provider: resolved.find(each => each.key === key)!, isLoaded: () => true })
    expect(definitionOf('pool').catalogMod?.managedBy).toBe('mod.hub.router')
    expect(definitionOf('router').catalogMod?.managedBy).toBeUndefined()
  })
})

describe('which router reaches a managed provider', () => {
  it('its own router does, listed or not; no other router does', () => {
    const managed = { definition: 'mod.hub.pool', managedBy: 'mod.hub.router' }
    expect(routerReaches('mod.hub.router', [], managed)).toBe(true)
    expect(routerReaches('mod.hub.router', '*', managed)).toBe(true)
    expect(routerReaches('mod.other.router', '*', managed)).toBe(false)
    expect(routerReaches('mod.other.router', ['mod.hub.pool'], managed)).toBe(false)
    // Any other provider is decided by the boundary, as before.
    expect(routerReaches('mod.hub.router', '*', { definition: 'vendor-a' })).toBe(true)
    expect(routerReaches('mod.hub.router', ['vendor-b'], { definition: 'vendor-a' })).toBe(false)
  })

  const instance = (id: string, over: Partial<PeerInstance> = {}): PeerInstance => ({
    id,
    definition: id,
    label: id,
    router: false,
    source: 'mod',
    connected: true,
    models: [{ id: 'm', picked: true, supportsTools: true }],
    ...over,
  })
  const instances = [instance('vendor-a', { source: 'builtin' }), instance('mod.hub.pool', { managedBy: 'mod.hub.router' })]
  const table = (routerId: string, routesTo: '*' | string[]) =>
    peersTableFor(routerId, { instances: () => instances, routesToOf: () => routesTo, stateOf: () => ({ models: {} }), now: () => 0 })

  it('the peers table lists it for its router only, marked as managed', () => {
    expect(table('mod.hub.router', '*').map(peer => [peer.id, peer.managed])).toEqual([['vendor-a', undefined], ['mod.hub.pool', true]])
    expect(table('mod.hub.router', []).map(peer => peer.id)).toEqual(['mod.hub.pool'])
    expect(table('mod.other.router', '*').map(peer => peer.id)).toEqual(['vendor-a'])
  })

  it('a route answer naming it is taken from its router and refused from another', () => {
    const facts: RouteAnswerFacts = {
      routerId: 'mod.hub.router',
      routesTo: ['vendor-a'],
      isSetUp: () => true,
      isRouter: () => false,
      definitionOf: provider => provider,
      managedByOf: provider => (provider === 'mod.hub.pool' ? 'mod.hub.router' : undefined),
      serves: () => true,
      knownModel: () => true,
    }
    const answer = { provider: 'mod.hub.pool', model: 'm' }
    expect(checkRouteAnswer(answer, facts)).toEqual({ kind: 'target', target: answer })
    expect(checkRouteAnswer(answer, { ...facts, routerId: 'mod.other.router', routesTo: '*' })).toEqual({
      kind: 'refused',
      reason: 'the provider mod.hub.pool is outside what this router may send through',
    })
  })
})

describe('what the person picks from', () => {
  const providers = [
    { id: 'mod.hub.router', label: 'Hub', enabled: true, iconSvg: '', models: [{ id: 'free', label: 'FreeRouter', enabled: true }], mod: { state: 'ready', kind: 'router' } },
    { id: 'mod.hub.pool', label: 'Pool', enabled: true, iconSvg: '', models: [{ id: 'pool-model', label: 'Pool model', enabled: true }], mod: { state: 'ready', managedBy: 'mod.hub.router' } },
    { id: 'plain', label: 'Plain', enabled: true, iconSvg: '', models: [{ id: 'plain-model', label: 'Plain model', enabled: true }] },
  ] as unknown as BrowserLlmProvider[]
  const catalog = { providers, defaultSelection: { providerId: 'mod.hub.router', modelId: 'free' } } as unknown as BrowserLlmCatalog

  afterEach(cleanup)

  it('a managed provider is told apart by its row', () => {
    expect(providers.map(provider => isManagedProvider(provider))).toEqual([false, true, false])
    expect(isManagedProvider(undefined)).toBe(false)
  })

  it('its model is not a session\'s selection, while its router\'s route is', () => {
    expect(isSelectionEnabled(catalog, { providerId: 'mod.hub.router', modelId: 'free' })).toBe(true)
    expect(isSelectionEnabled(catalog, { providerId: 'mod.hub.pool', modelId: 'pool-model' })).toBe(false)
  })

  it('the model picker lists the router\'s route and not the managed provider\'s model', () => {
    render(h(NexusModelPicker, { catalog, selection: { providerId: 'mod.hub.router', modelId: 'free' }, onSelect: () => {}, onOpenSettings: () => {}, openToken: 1 }))
    expect(screen.queryAllByText('FreeRouter').length).toBeGreaterThan(0)
    // The list is open: another provider's model is in it.
    expect(screen.queryAllByText('Plain model').length).toBeGreaterThan(0)
    expect(screen.queryByText('Pool model')).toBeNull()
    expect(screen.queryByText('Pool')).toBeNull()
  })
})
