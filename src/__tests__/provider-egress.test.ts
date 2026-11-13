/**
 * A provider's declared egresses (F-27): the manifest's `egress`, the proxy
 * hosts in the grant a person consents to, and the seam a registered
 * provider gets.
 */
import { describe, expect, it } from 'vitest'

import { egressNamed } from '../models/drivers/providerEgress'
import type { ProviderModRuntime } from '../mods/provider/ProviderModRuntime'
import {
  EGRESS_HOSTS_MAX,
  EGRESS_MAX,
  EGRESS_URL_MAX_LENGTH,
  checkProviderEgress,
  egressHostsOf,
} from '../mods/provider/providerEgressManifest'
import { checkProviderManifests, type ProviderManifest } from '../mods/provider/providerManifest'
import { seamForRegistration } from '../mods/provider/providerSeamWiring'
import { grantOf, widened, type Grant } from '../pluginHost/providerGrant'
import { providerJson } from './_helpers/pluginArchive'

const SECRETS = new Set(['proxy_a', 'proxy_pass'])

function check(value: unknown) {
  const problems: string[] = []
  const table = checkProviderEgress(value, SECRETS, message => problems.push(message))
  return { table, problems }
}

const problemOf = (entry: unknown) => check({ pool: entry }).problems.join(' | ')

describe('a manifest egress', () => {
  it('keeps a secret address and a literal one, hosts in lower case and unique', () => {
    const { table, problems } = check({
      'pool-a': { url: '{{secret:proxy_a}}', hosts: ['Proxy-A.example.com', 'proxy-a.example.com'] },
      pool_b: { url: 'https://me:{{secret:proxy_pass}}@gate.example.com:8443', hosts: ['gate.example.com'] },
      local: { url: 'socks5://127.0.0.1:1080', hosts: ['127.0.0.1', '2001:db8::1'] },
    })
    expect(problems).toEqual([])
    expect(table).toEqual({
      'pool-a': { url: '{{secret:proxy_a}}', hosts: ['proxy-a.example.com'] },
      pool_b: { url: 'https://me:{{secret:proxy_pass}}@gate.example.com:8443', hosts: ['gate.example.com'] },
      local: { url: 'socks5://127.0.0.1:1080', hosts: ['127.0.0.1', '2001:db8::1'] },
    })
    expect(egressHostsOf(table)).toEqual(['127.0.0.1', '2001:db8::1', 'gate.example.com', 'proxy-a.example.com'])
  })

  it('an empty table is a table with no egress', () => {
    expect(check({})).toEqual({ table: {}, problems: [] })
    expect(egressHostsOf(undefined)).toEqual([])
  })

  it.each([
    ['a list', ['pool'], 'egress: expected an object of named proxies'],
    ['a name with a dot', { 'pool.a': { url: 'http://p.example.com', hosts: ['p.example.com'] } }, 'egress.pool.a: a name is'],
    ['an entry that is no object', { pool: 'http://p.example.com' }, 'egress.pool: expected an object with url and hosts'],
  ])('refuses %s', (_what, value, problem) => {
    const { table, problems } = check(value)
    expect(table).toBeUndefined()
    expect(problems.join(' | ')).toContain(problem)
  })

  it.each([
    ['no address', { hosts: ['p.example.com'] }, 'egress.pool.url: expected the proxy'],
    ['an address past the length limit', { url: `http://${'a'.repeat(EGRESS_URL_MAX_LENGTH)}`, hosts: ['p.example.com'] }, 'egress.pool.url: longer than'],
    ['a secret the provider does not declare', { url: '{{secret:other}}', hosts: ['p.example.com'] }, '{{secret:other}} is not a declared credentials.secrets name'],
    ['another template', { url: 'http://{{oauth:access_token}}@p.example.com', hosts: ['p.example.com'] }, 'only {{secret:NAME}} may be used'],
    ['a literal address with no scheme', { url: 'p.example.com:8080', hosts: ['p.example.com'] }, 'expected an address starting with http://, https://, socks5://'],
    ['a scheme the host does not send through', { url: 'socks4://p.example.com', hosts: ['p.example.com'] }, 'expected an address starting with'],
    ['socks5 with credentials', { url: 'socks5://u:{{secret:proxy_pass}}@p.example.com', hosts: ['p.example.com'] }, 'a socks5 proxy cannot take a user name and password'],
    ['no hosts', { url: '{{secret:proxy_a}}' }, 'egress.pool.hosts: expected a non-empty list'],
    ['an empty host list', { url: '{{secret:proxy_a}}', hosts: [] }, 'egress.pool.hosts: expected a non-empty list'],
    ['a host with a port', { url: '{{secret:proxy_a}}', hosts: ['p.example.com:8080'] }, 'is not a plain host name or IP address'],
    ['a wildcard host', { url: '{{secret:proxy_a}}', hosts: ['*.example.com'] }, 'is not a plain host name or IP address'],
    ['too many hosts', { url: '{{secret:proxy_a}}', hosts: Array.from({ length: EGRESS_HOSTS_MAX + 1 }, (_, i) => `p${i}.example.com`) }, `at most ${EGRESS_HOSTS_MAX} host names`],
    ['an unknown property', { url: '{{secret:proxy_a}}', hosts: ['p.example.com'], kind: 'socks5' }, 'egress.pool.kind: not a known property'],
  ])('refuses %s', (_what, entry, problem) => {
    expect(check({ pool: entry }).table).toBeUndefined()
    expect(problemOf(entry)).toContain(problem)
  })

  it('refuses more proxies than the limit', () => {
    const many = Object.fromEntries(
      Array.from({ length: EGRESS_MAX + 1 }, (_, i) => [`p${i}`, { url: '{{secret:proxy_a}}', hosts: ['p.example.com'] }]),
    )
    expect(check(many).problems.join()).toContain(`at most ${EGRESS_MAX} proxies`)
  })

  it('a name is looked up as an own key only', () => {
    const table = check({ pool: { url: '{{secret:proxy_a}}', hosts: ['p.example.com'] } }).table
    expect(egressNamed(table, 'pool')).toEqual({ url: '{{secret:proxy_a}}', hosts: ['p.example.com'] })
    expect(egressNamed(table, 'toString')).toBeUndefined()
    expect(egressNamed(table, 'constructor')).toBeUndefined()
    expect(egressNamed(undefined, 'pool')).toBeUndefined()
  })
})

// ── in a provider manifest, its grant and its seam ──────────────────────────

const BASE = {
  domains: ['api.acme.test'],
  credentials: { methods: ['apiKey'], secrets: [{ name: 'proxy_a' }], readsSecrets: false },
}
const POOL = { pool: { url: '{{secret:proxy_a}}', hosts: ['proxy.acme.test'] } }

function parse(over: Record<string, unknown>): { manifest?: ProviderManifest; errors: string[] } {
  const errors: string[] = []
  const parsed = checkProviderManifests('acme', { main: providerJson({ ...BASE, ...over }) }, errors)
  return { ...(parsed?.main ? { manifest: parsed.main } : {}), errors }
}

const grant = (over: Record<string, unknown> = {}): Grant => {
  const { manifest, errors } = parse(over)
  expect(errors).toEqual([])
  return grantOf({ main: manifest! })
}

describe('egress in a provider manifest', () => {
  it('is kept on the manifest, checked against the provider\'s declared secrets', () => {
    expect(parse({ egress: POOL }).manifest?.egress).toEqual(POOL)
    expect(parse({}).manifest?.egress).toBeUndefined()
    expect(parse({ egress: {} }).manifest?.egress).toBeUndefined()
  })

  it('a bad egress refuses the provider, naming the path', () => {
    const { manifest, errors } = parse({ egress: { pool: { url: '{{secret:undeclared}}', hosts: ['proxy.acme.test'] } } })
    expect(manifest).toBeUndefined()
    expect(errors.join(' | ')).toContain('providers.main.egress.pool.url: {{secret:undeclared}} is not a declared')
  })
})

describe('proxy hosts in the grant', () => {
  it('a provider with no egress has no proxies in its grant', () => {
    expect(grant().providers.main).not.toHaveProperty('proxies')
  })

  it('lists every proxy host once, sorted', () => {
    const egress = {
      b: { url: '{{secret:proxy_a}}', hosts: ['z.acme.test', 'a.acme.test'] },
      a: { url: '{{secret:proxy_a}}', hosts: ['a.acme.test'] },
    }
    expect(grant({ egress }).providers.main!.proxies).toEqual(['a.acme.test', 'z.acme.test'])
  })

  it('a first proxy host widens the grant, and names it', () => {
    const delta = widened(grant(), grant({ egress: POOL }))
    expect(delta.widened).toBe(true)
    expect(delta.added.perProvider.main).toMatchObject({ proxies: ['proxy.acme.test'], domains: [] })
  })

  it('another proxy host widens by that host alone; the same hosts under another name do not', () => {
    const more = { pool: { url: '{{secret:proxy_a}}', hosts: ['proxy.acme.test', 'proxy2.acme.test'] } }
    expect(widened(grant({ egress: POOL }), grant({ egress: more })).added.perProvider.main!.proxies).toEqual(['proxy2.acme.test'])
    const renamed = { other: { url: 'http://proxy.acme.test:8080', hosts: ['proxy.acme.test'] } }
    expect(widened(grant({ egress: POOL }), grant({ egress: renamed })).widened).toBe(false)
  })

  it('dropping the egress is not wider', () => {
    expect(widened(grant({ egress: POOL }), grant()).widened).toBe(false)
  })

  it('a grant consented to before proxies existed reads as having none', () => {
    const before: Grant = { providers: { main: { domains: ['api.acme.test'], secrets: ['proxy_a'], readsSecrets: false, requestNeeds: [] } } }
    expect(widened(before, grant()).widened).toBe(false)
    expect(widened(before, grant({ egress: POOL })).added.perProvider.main!.proxies).toEqual(['proxy.acme.test'])
  })
})

describe('the seam of a provider with an egress', () => {
  const runtime = {
    call: async () => ({ raised: false }),
    hasHook: () => true,
    whenLoaded: async () => {},
  } as unknown as ProviderModRuntime

  it('carries the declared table, and none when the manifest has none', () => {
    const withEgress = seamForRegistration(
      { providerId: 'mod.acme.main', manifest: parse({ egress: POOL }).manifest!, runtime },
      () => {},
    )
    expect(withEgress.egress).toEqual(POOL)
    const without = seamForRegistration({ providerId: 'mod.acme.main', manifest: parse({}).manifest!, runtime }, () => {})
    expect(without.egress).toBeUndefined()
  })
})
