/**
 * Provider mods (PM-9a) — the grant a person consents to, and when an update
 * widens it. Every axis widens on its own; narrowing and rewording are silent.
 */
import { describe, expect, it } from 'vitest'
import { checkProviderManifests, type ProviderManifest } from '../mods/provider/providerManifest'
import { grantOf, providerGrantOf, widened, type Grant } from '../pluginHost/providerGrant'
import { providerJson } from './_helpers/pluginArchive'

function manifests(over: Record<string, Record<string, unknown>>): Record<string, ProviderManifest> {
  const errors: string[] = []
  const parsed = checkProviderManifests(
    'acme',
    Object.fromEntries(Object.entries(over).map(([key, value]) => [key, providerJson(value)])),
    errors,
  )
  expect(errors).toEqual([])
  return parsed!
}

const grant = (over: Record<string, unknown> = {}): Grant => grantOf(manifests({ main: over }))
const BASE = {
  domains: ['api.acme.test'],
  credentials: { methods: ['apiKey'], secrets: [{ name: 'token' }], readsSecrets: false },
  requestNeeds: ['system'],
}

describe('grantOf', () => {
  it('reads the declared domains, secret names, readsSecrets, needs', () => {
    const g = providerGrantOf(
      manifests({
        main: {
          domains: ['B.acme.test', 'a.acme.test', 'a.acme.test'],
          defaultBaseUrl: 'https://a.acme.test/v1',
          credentials: { methods: ['apiKey'], secrets: [{ name: 'zeta' }, { name: 'alpha' }], readsSecrets: true },
          requestNeeds: ['body', 'system'],
          signNeeds: 'digest',
        },
      }).main!,
    )
    expect(g).toEqual({
      domains: ['a.acme.test', 'b.acme.test'],
      secrets: ['alpha', 'zeta'],
      readsSecrets: true,
      requestNeeds: ['system', 'body'],
      signNeeds: 'digest',
    })
  })

  it('a provider with nothing optional has an empty grant beyond its domain', () => {
    expect(providerGrantOf(manifests({ main: {} }).main!)).toEqual({
      domains: ['api.acme.test'],
      secrets: [],
      readsSecrets: false,
      requestNeeds: [],
    })
  })

  it('ignores wording: display name, icon text, settings, prompts do not enter the grant', () => {
    expect(grant({ ...BASE, displayName: { en: 'Other name' } })).toEqual(grant(BASE))
  })
})

describe('widened', () => {
  it('the same grant is not wider', () => {
    const delta = widened(grant(BASE), grant(BASE))
    expect(delta).toEqual({ widened: false, added: { providers: [], perProvider: {} }, removed: [] })
  })

  it('a new domain widens, and names it', () => {
    const delta = widened(grant(BASE), grant({ ...BASE, domains: ['api.acme.test', 'cdn.acme.test'] }))
    expect(delta.widened).toBe(true)
    expect(delta.added.perProvider.main).toMatchObject({ domains: ['cdn.acme.test'], secrets: [], readsSecrets: false, requestNeeds: [] })
  })

  it('a replaced domain widens (the new one is new)', () => {
    const delta = widened(grant(BASE), grant({ ...BASE, domains: ['other.test'], defaultBaseUrl: 'https://other.test/v1' }))
    expect(delta.widened).toBe(true)
    expect(delta.added.perProvider.main!.domains).toEqual(['other.test'])
  })

  it('a domain written in other case is the same domain', () => {
    expect(widened(grant(BASE), grant({ ...BASE, domains: ['API.Acme.Test'] })).widened).toBe(false)
  })

  it('a new secret name widens', () => {
    const delta = widened(
      grant(BASE),
      grant({ ...BASE, credentials: { methods: ['apiKey'], secrets: [{ name: 'token' }, { name: 'device_key' }] } }),
    )
    expect(delta.widened).toBe(true)
    expect(delta.added.perProvider.main!.secrets).toEqual(['device_key'])
  })

  it('readsSecrets turned on widens; already on, does not', () => {
    const reads = { ...BASE, credentials: { ...BASE.credentials, readsSecrets: true } }
    const on = widened(grant(BASE), grant(reads))
    expect(on.widened).toBe(true)
    expect(on.added.perProvider.main!.readsSecrets).toBe(true)
    expect(widened(grant(reads), grant(reads)).widened).toBe(false)
  })

  it('a new requestNeeds value widens', () => {
    const delta = widened(grant(BASE), grant({ ...BASE, requestNeeds: ['system', 'tools'] }))
    expect(delta.widened).toBe(true)
    expect(delta.added.perProvider.main!.requestNeeds).toEqual(['tools'])
    expect(widened(grant({ ...BASE, requestNeeds: [] }), grant({ ...BASE, requestNeeds: ['body'] })).widened).toBe(true)
  })

  it('adding cwd to a new version widens the grant, and only by cwd; dropping it is silent', () => {
    const delta = widened(grant(BASE), grant({ ...BASE, requestNeeds: ['system', 'cwd'] }))
    expect(delta.widened).toBe(true)
    expect(delta.added.perProvider.main!.requestNeeds).toEqual(['cwd'])
    expect(grant({ ...BASE, requestNeeds: ['cwd', 'system'] }).providers.main!.requestNeeds).toEqual(['system', 'cwd'])
    expect(widened(grant({ ...BASE, requestNeeds: ['system', 'cwd'] }), grant(BASE)).widened).toBe(false)
  })

  it('signNeeds widens when it appears or goes from digest to body', () => {
    expect(widened(grant(BASE), grant({ ...BASE, signNeeds: 'digest' })).added.perProvider.main!.signNeeds).toBe('digest')
    expect(widened(grant(BASE), grant({ ...BASE, signNeeds: 'body' })).added.perProvider.main!.signNeeds).toBe('body')
    expect(widened(grant({ ...BASE, signNeeds: 'digest' }), grant({ ...BASE, signNeeds: 'body' })).widened).toBe(true)
  })

  it('a new provider widens, in full', () => {
    const consented = grantOf(manifests({ main: BASE }))
    const next = grantOf(manifests({ main: BASE, extra: { domains: ['x.test'], defaultBaseUrl: 'https://x.test/v1' } }))
    const delta = widened(consented, next)
    expect(delta.widened).toBe(true)
    expect(delta.added.providers).toEqual(['extra'])
    expect(delta.added.perProvider.extra!.domains).toEqual(['x.test'])
  })

  it('a renamed provider key is a new provider', () => {
    const delta = widened(
      grantOf(manifests({ main: BASE })),
      grantOf(manifests({ renamed: BASE })),
    )
    expect(delta.added.providers).toEqual(['renamed'])
    expect(delta.removed).toEqual(['main'])
  })
})

describe('narrowing is silent', () => {
  it('fewer domains, secrets, needs; readsSecrets off; signNeeds reduced or gone', () => {
    const wide = {
      domains: ['api.acme.test', 'cdn.acme.test'],
      credentials: { methods: ['apiKey'], secrets: [{ name: 'a' }, { name: 'b' }], readsSecrets: true },
      requestNeeds: ['system', 'tools', 'body'],
      signNeeds: 'body',
    }
    const narrow = {
      domains: ['api.acme.test'],
      credentials: { methods: ['apiKey'], secrets: [{ name: 'a' }], readsSecrets: false },
      requestNeeds: ['system'],
      signNeeds: 'digest',
    }
    expect(widened(grant(wide), grant(narrow))).toEqual({ widened: false, added: { providers: [], perProvider: {} }, removed: [] })
    expect(widened(grant(narrow), grant({ ...narrow, signNeeds: undefined })).widened).toBe(false)
  })

  it('a dropped provider is reported as removed and is not wider', () => {
    const delta = widened(grantOf(manifests({ main: BASE, extra: BASE })), grantOf(manifests({ main: BASE })))
    expect(delta).toEqual({ widened: false, added: { providers: [], perProvider: {} }, removed: ['extra'] })
  })

  it('one axis widening among narrowing ones still widens', () => {
    const delta = widened(
      grant({ ...BASE, requestNeeds: ['system', 'tools'] }),
      grant({ ...BASE, requestNeeds: ['system'], domains: ['api.acme.test', 'new.acme.test'] }),
    )
    expect(delta.widened).toBe(true)
    expect(delta.added.perProvider.main).toMatchObject({ domains: ['new.acme.test'], requestNeeds: [] })
  })
})
