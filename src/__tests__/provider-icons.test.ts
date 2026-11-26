/**
 * A provider's brand mark as a mod is handed it (F-27): on a peer, on a
 * definition a router's settings app lists, and from `$.provider.icons`.
 */
import { afterEach, describe, expect, it } from 'vitest'
import type { BrowserLlmCatalog } from '../browser/bridge/protocol/nexus_llm'
import { publishHostProviderIcons, resetHostProviderIcons } from '../config/hostProviderIcons'
import {
  BUILTIN_PROVIDER_DEFINITIONS,
  registerModProviderDefinition,
  resetModProviderDefinitions,
} from '../config/nexusModelConfig/providers'
import { registerProviderRouter, resetProviderRouters } from '../models/drivers/providerRouter'
import { resetRuntimeProviders, setRuntimeProviderConfigs } from '../models/drivers/runtimeProviders'
import { refuseAppBackgroundCall } from '../mods/app/appBackgroundEvents'
import {
  refuseSettingsAppProviderCall,
  runtimeSettingsAppIcons,
  serveSettingsAppProviderCall,
  type SettingsAppBinding,
} from '../mods/app/appProviderCalls'
import { iconAsImage, modProviderDefinition } from '../mods/provider/modProviderDefinition'
import { runtimePeersTable } from '../mods/provider/nouns/providerPeersNoun'
import {
  ICON_DEFINITIONS_MAX,
  iconImageUrl,
  providerIconOf,
  resetProviderIconUrls,
  serveProviderIcons,
} from '../mods/provider/providerIcons'
import { listDefinitions, type InstanceCallsDeps } from '../mods/provider/providerInstanceCalls'
import { PROVIDER_WIRE_FORMATS, resolveProviders } from '../mods/provider/providerManifest'
import { checkPluginDescriptor } from '../pluginHost/manifestValidator'

const ROUTER = 'mod.pool.router'
const MOD = 'mod.acme.gateway'
/** A built-in whose mark the host ships: its definition states none. */
const HOSTED = BUILTIN_PROVIDER_DEFINITIONS.find(d => !d.runtimeOnly && !d.iconSvg)!.config.providerId
/** A built-in whose mark its own definition states. */
const OWN = BUILTIN_PROVIDER_DEFINITIONS.find(d => d.iconSvg)!

const COLOURED = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path fill="#4285F4" d="M0 0h24v24H0z"/></svg>'
const INKED = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor"><path d="M0 0h24v24H0z"/></svg>'
const VENDOR = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16"><circle cx="8" cy="8" r="6" fill="#f60"/></svg>'

const PREFIX = 'data:image/svg+xml;charset=utf-8,'
const textOf = (url: string): string => decodeURIComponent(url.slice(PREFIX.length))

function hostCatalog(marks: Record<string, string>): BrowserLlmCatalog {
  return {
    providers: Object.entries(marks).map(([id, iconSvg]) => ({ id, label: id, iconSvg, enabled: true, models: [] })),
  } as unknown as BrowserLlmCatalog
}

function modProvider(id: string, iconSvg?: string): void {
  const { manifest, errors } = checkPluginDescriptor({
    name: 'acme',
    version: '1.0.0',
    providers: {
      gateway: {
        providerApi: 1,
        displayName: 'Acme Gateway',
        defaultBaseUrl: 'https://api.acme.test/v1',
        domains: ['api.acme.test'],
        format: PROVIDER_WIRE_FORMATS[0],
        credentials: { methods: ['apiKey'] },
        module: './providers/gateway.js',
      },
    },
  })
  expect(errors).toEqual([])
  const [provider] = resolveProviders('acme', '/plugins/acme', manifest!.providers!)
  expect(provider!.id).toBe(id)
  registerModProviderDefinition(
    modProviderDefinition({ plugin: 'acme', provider: provider!, ...(iconSvg !== undefined ? { iconSvg } : {}), isLoaded: () => true }),
  )
}

const ROUTER_APP: SettingsAppBinding = { providerId: ROUTER, router: true, routesTo: '*' }
const PLAIN_APP: SettingsAppBinding = { providerId: MOD, router: false }

function openRouter(): void {
  registerProviderRouter(ROUTER, { route: async () => undefined }, { routesTo: '*' })
}

afterEach(() => {
  resetHostProviderIcons()
  resetProviderIconUrls()
  resetProviderRouters()
  resetRuntimeProviders()
  resetModProviderDefinitions()
})

describe('the image form', () => {
  it('is an image URL of the SVG text, never markup', () => {
    const url = iconImageUrl(COLOURED)
    expect(url.startsWith(PREFIX)).toBe(true)
    expect(url).not.toContain('<')
    expect(textOf(url)).toBe(COLOURED)
  })

  it('gives a mark drawn in the text colour a colour for each scheme, since an image takes none from the page', () => {
    const text = textOf(iconImageUrl(INKED))
    expect(text).toMatch(/^<svg [^>]*><style>:root\{color:#[0-9a-f]{6}\}@media \(prefers-color-scheme:dark\)\{:root\{color:#[0-9a-f]{6}\}\}<\/style><path /)
    expect(text.replace(/<style>.*<\/style>/, '')).toBe(INKED)
  })

  it('answers the same string for the same mark', () => {
    expect(iconImageUrl(INKED)).toBe(iconImageUrl(INKED))
  })
})

describe("a peer's icon", () => {
  it("a built-in carries the host catalog's mark, set up or not", () => {
    publishHostProviderIcons(hostCatalog({ [HOSTED]: COLOURED }))
    openRouter()
    const peer = runtimePeersTable(ROUTER).find(each => each.id === HOSTED)!
    expect(peer.connected).toBe(false)
    expect(peer.icon).toBe(iconImageUrl(COLOURED))
  })

  it("a built-in the runtime builds the row of carries its definition's mark", () => {
    openRouter()
    const peer = runtimePeersTable(ROUTER).find(each => each.id === OWN.config.providerId)!
    expect(peer.icon).toBe(iconImageUrl(OWN.iconSvg!))
  })

  it("a built-in has none before the host's catalog arrived, and an empty catalog changes nothing", () => {
    openRouter()
    expect('icon' in runtimePeersTable(ROUTER).find(each => each.id === HOSTED)!).toBe(false)
    publishHostProviderIcons(hostCatalog({ [HOSTED]: COLOURED }))
    publishHostProviderIcons({ providers: [] } as unknown as BrowserLlmCatalog)
    publishHostProviderIcons(null)
    expect(runtimePeersTable(ROUTER).find(each => each.id === HOSTED)!.icon).toBe(iconImageUrl(COLOURED))
  })

  it("a provider mod's carries its manifest icon, from the checked text and not the page's drawing of it", () => {
    modProvider(MOD, VENDOR)
    openRouter()
    const peer = runtimePeersTable(ROUTER).find(each => each.id === MOD)!
    expect(peer.source).toBe('mod')
    expect(textOf(peer.icon!)).toBe(VENDOR)
    expect(peer.icon).not.toBe(iconImageUrl(iconAsImage(VENDOR)))
  })

  it('a provider mod without a manifest icon has no icon field', () => {
    modProvider(MOD)
    openRouter()
    expect('icon' in runtimePeersTable(ROUTER).find(each => each.id === MOD)!).toBe(false)
  })

  it("a custom provider has no icon field, whatever the host's catalog row of it draws", () => {
    setRuntimeProviderConfigs({ 'custom-relay': { isCustomProvider: true, displayName: 'My relay', customModels: [{ modelId: 'm' }] } })
    publishHostProviderIcons(hostCatalog({ 'custom-relay': COLOURED, [HOSTED]: COLOURED }))
    openRouter()
    const peer = runtimePeersTable(ROUTER).find(each => each.id === 'custom-relay')!
    expect(peer.source).toBe('custom')
    expect('icon' in peer).toBe(false)
    expect(providerIconOf('custom-relay')).toBeUndefined()
  })
})

describe('definitions()', () => {
  function deps(icon?: InstanceCallsDeps['icon']): InstanceCallsDeps {
    const managedEntry = (displayName: string) => ({
      providerApi: 1,
      displayName,
      defaultBaseUrl: 'https://api.pool.test/v1',
      domains: ['api.pool.test'],
      format: PROVIDER_WIRE_FORMATS[0],
      credentials: { methods: ['anonymous'] },
      managedBy: 'router',
      module: './p.js',
    })
    const { manifest, errors } = checkPluginDescriptor({
      name: 'pool',
      version: '1.0.0',
      providers: {
        router: { providerApi: 1, kind: 'router', routesTo: '*', displayName: 'Router', credentials: { methods: ['anonymous'] }, module: './r.js' },
        free: managedEntry('Free'),
        bare: managedEntry('Bare'),
      },
    })
    expect(errors).toEqual([])
    const managed = resolveProviders('pool', '/plugins/pool', manifest!.providers!).filter(p => p.manifest.managedBy === 'router')
    return {
      managedBy: (routerId: string) => (routerId === ROUTER ? managed.map(provider => ({ provider, owner: 'pool@inline' })) : []),
      ...(icon ? { icon } : {}),
      locale: () => 'en',
    } as unknown as InstanceCallsDeps
  }

  it('each definition carries its mark; one without a mark has no icon field', () => {
    const rows = listDefinitions(ROUTER, deps(id => (id === 'mod.pool.free' ? iconImageUrl(VENDOR) : undefined)))
    expect(rows).toEqual([
      { key: 'free', id: 'mod.pool.free', label: 'Free', icon: iconImageUrl(VENDOR), method: 'anonymous', instances: 'single' },
      { key: 'bare', id: 'mod.pool.bare', label: 'Bare', method: 'anonymous', instances: 'single' },
    ])
    expect('icon' in rows[1]!).toBe(false)
  })

  it('lists them without icons where no icon source is attached', () => {
    expect(listDefinitions(ROUTER, deps()).some(row => 'icon' in row)).toBe(false)
  })
})

describe('$.provider.icons', () => {
  it("answers a built-in that is not set up, a provider mod's definition, and a built-in with its own mark", () => {
    publishHostProviderIcons(hostCatalog({ [HOSTED]: INKED }))
    modProvider(MOD, VENDOR)
    expect(serveProviderIcons({ definitions: [HOSTED, MOD, OWN.config.providerId] })).toEqual({
      [HOSTED]: iconImageUrl(INKED),
      [MOD]: iconImageUrl(VENDOR),
      [OWN.config.providerId]: iconImageUrl(OWN.iconSvg!),
    })
  })

  it('leaves out an id it does not know, a custom provider and a definition without a mark: no error', () => {
    setRuntimeProviderConfigs({ 'custom-relay': { isCustomProvider: true, displayName: 'My relay' } })
    publishHostProviderIcons(hostCatalog({ 'custom-relay': COLOURED, nope: COLOURED }))
    modProvider(MOD)
    expect(serveProviderIcons({ definitions: ['nope'] })).toEqual({})
    expect(serveProviderIcons({ definitions: ['nope', 'custom-relay', MOD, '__proto__'] })).toEqual({})
    expect(serveProviderIcons({ definitions: [] })).toEqual({})
  })

  it('names an id once however often it is asked', () => {
    publishHostProviderIcons(hostCatalog({ [HOSTED]: COLOURED }))
    expect(Object.keys(serveProviderIcons({ definitions: [HOSTED, HOSTED] }))).toEqual([HOSTED])
  })

  it('takes 32 ids and refuses more, answering nothing', () => {
    const ids = Array.from({ length: ICON_DEFINITIONS_MAX }, (_, index) => `id-${index}`)
    expect(ICON_DEFINITIONS_MAX).toBe(32)
    expect(serveProviderIcons({ definitions: ids })).toEqual({})
    expect(() => serveProviderIcons({ definitions: [...ids, HOSTED] })).toThrow(RangeError)
  })

  it('refuses a malformed call', () => {
    for (const bad of [undefined, null, 'openrouter', ['openrouter'], {}, { definitions: 'openrouter' }, { definitions: [1] }, { definitions: [''] }]) {
      expect(() => serveProviderIcons(bad)).toThrow(TypeError)
    }
  })

  it("a router's settings app is served", async () => {
    publishHostProviderIcons(hostCatalog({ [HOSTED]: COLOURED }))
    const deps = { reload: async () => undefined, icons: runtimeSettingsAppIcons }
    expect(await serveSettingsAppProviderCall(ROUTER_APP, 'icons', [{ definitions: [HOSTED, 'nope'] }], deps)).toEqual({
      [HOSTED]: iconImageUrl(COLOURED),
    })
    await expect(
      serveSettingsAppProviderCall(ROUTER_APP, 'icons', [{ definitions: Array.from({ length: 33 }, (_, i) => `id-${i}`) }], deps),
    ).rejects.toThrow(RangeError)
  })

  it("is refused to an app that is no provider's settings app, and to the settings app of a provider that is no router", async () => {
    expect(refuseSettingsAppProviderCall('icons', ROUTER_APP)).toBeNull()
    expect(refuseSettingsAppProviderCall('icons', undefined)).toMatch(/settings app alone/)
    expect(refuseSettingsAppProviderCall('icons', PLAIN_APP)).toMatch(/is a router's/)
    expect(refuseAppBackgroundCall('provider', 'icons', undefined)).toMatch(/settings app alone/)
    expect(refuseAppBackgroundCall('provider', 'icons', ROUTER_APP)).toBeNull()
    let asked = 0
    const deps = { reload: async () => undefined, icons: () => (asked++, {}) }
    await expect(serveSettingsAppProviderCall(PLAIN_APP, 'icons', [{ definitions: [HOSTED] }], deps)).rejects.toMatchObject({ name: 'NotAllowedError' })
    expect(asked).toBe(0)
  })

  it('fails as unavailable where no icon source is attached', async () => {
    await expect(
      serveSettingsAppProviderCall(ROUTER_APP, 'icons', [{ definitions: [HOSTED] }], { reload: async () => undefined }),
    ).rejects.toMatchObject({ name: 'NotSupportedError' })
  })
})
