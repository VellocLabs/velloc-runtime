/**
 * A provider's dynamic egress pools (F-27): the manifest declaration, the
 * members its module registers with `$.provider.setEgress`, a `route` that
 * names a member, and the wider grant a pool is.
 */
import { afterEach, describe, expect, it } from 'vitest'

import { readRequestPlan } from '../models/drivers/providerRequestPlan'
import type { ProviderNounCall } from '../mods/provider/ProviderModRuntime'
import type { ProviderModRuntime } from '../mods/provider/ProviderModRuntime'
import { createMemoryKeyVault } from '../mods/provider/nouns/keyVault'
import { createProviderNouns } from '../mods/provider/nouns/providerNounTable'
import { MemorySessionStores } from '../mods/provider/nouns/sessionStore'
import { EGRESS_MAX, EGRESS_POOL_MAX_MEMBERS, checkProviderEgress } from '../mods/provider/providerEgressManifest'
import {
  POOL_MEMBER_URL_MAX_LENGTH,
  ProviderEgressPoolRegistry,
  isLocalProxyHost,
  providerEgressPools,
  proxyHostOfMember,
} from '../mods/provider/providerEgressPools'
import { checkProviderManifests, type ProviderManifest } from '../mods/provider/providerManifest'
import { providerSeamListener, seamForRegistration } from '../mods/provider/providerSeamWiring'
import { resetProviderRequestSeams } from '../models/drivers/providerRequestSeam'
import { grantOf, widened, type Grant } from '../pluginHost/providerGrant'
import { providerJson } from './_helpers/pluginArchive'

const PUBLIC = { max: 4, local: false }
const LOCAL = { max: 4, local: true }
const ID = 'mod.acme.main'

afterEach(() => {
  providerEgressPools.clear(ID)
  resetProviderRequestSeams()
})

describe('a pool in the manifest', () => {
  function check(value: unknown) {
    const problems: string[] = []
    const declared = checkProviderEgress(value, (message: string) => problems.push(message))
    return { declared, problems: problems.join(' | ') }
  }

  it('is read with its defaults', () => {
    const { declared, problems } = check({
      pool: { dynamic: true },
      home: { dynamic: true, max: 3, local: true },
    })
    expect(problems).toBe('')
    expect(declared).toEqual({ pool: { max: EGRESS_POOL_MAX_MEMBERS, local: false }, home: { max: 3, local: true } })
    expect(check({}).declared).toEqual({})
  })

  // A manifest cannot state a proxy's address, literal or held in a secret.
  it.each([
    ['a literal address', { url: 'http://p.example.com:8080', hosts: ['p.example.com'] }],
    ['an address held in a secret', { url: '{{secret:proxy_a}}', hosts: ['p.example.com'] }],
    ['a pool that also states an address', { dynamic: true, url: 'http://p.example.com' }],
  ])('refuses %s', (_what, entry) => {
    const { declared, problems } = check({ pool: entry })
    expect(declared).toBeUndefined()
    expect(problems).toContain('egress.pool: a proxy address cannot be declared')
  })

  it('refuses what is no table of pools, too many of them, and a bad name', () => {
    expect(check([]).problems).toContain('egress: expected an object of named pools')
    const many = Object.fromEntries(Array.from({ length: EGRESS_MAX + 1 }, (_, i) => [`p${i}`, { dynamic: true }]))
    expect(check(many).problems).toContain(`egress: at most ${EGRESS_MAX} pools`)
    expect(check({ 'bad name': { dynamic: true } }).problems).toContain('egress.bad name: a name is 1-32')
    expect(check({ pool: 5 }).problems).toContain('egress.pool: expected a pool')
  })

  it.each([
    ['dynamic that is not true', { dynamic: false }, 'egress.pool.dynamic: expected true'],
    ['an unknown property', { dynamic: true, schemes: ['http'] }, 'egress.pool.schemes: not a known property of a pool'],
    ['no members allowed', { dynamic: true, max: 0 }, 'egress.pool.max: expected a whole number from 1 to'],
    ['more members than the limit', { dynamic: true, max: EGRESS_POOL_MAX_MEMBERS + 1 }, 'egress.pool.max: expected a whole number'],
    ['local that is no boolean', { dynamic: true, local: 'yes' }, 'egress.pool.local: expected true or false'],
  ])('refuses %s', (_what, entry, problem) => {
    const { declared, problems } = check({ pool: entry })
    expect(declared).toBeUndefined()
    expect(problems).toContain(problem)
  })
})

describe('a member address', () => {
  it('yields its host for the three schemes, credentials allowed on http and https', () => {
    expect(proxyHostOfMember('http://203.0.113.7:8080', PUBLIC)).toBe('203.0.113.7')
    expect(proxyHostOfMember('HTTPS://user:p%40ss@Gate.Example.com/', PUBLIC)).toBe('gate.example.com')
    expect(proxyHostOfMember('socks5://[2001:db8::1]:1080', PUBLIC)).toBe('2001:db8::1')
  })

  it.each([
    ['not a string', 5],
    ['empty', ''],
    ['too long', `http://${'a'.repeat(POOL_MEMBER_URL_MAX_LENGTH)}`],
    ['no scheme', '203.0.113.7:8080'],
    ['another scheme', 'socks4://203.0.113.7'],
    ['a path', 'http://203.0.113.7/path'],
    ['port zero', 'http://203.0.113.7:0'],
    ['a port past the range', 'http://203.0.113.7:70000'],
    ['socks5 with credentials', 'socks5://u:p@203.0.113.7'],
    ['a stored secret as the user name', 'http://{{secret:api_key}}:x@203.0.113.7:3128'],
    ['a stored secret as the whole address', '{{secret:proxy_a}}'],
    ['a host with odd characters', 'http://bad_host!:8080'],
  ])('refuses %s', (_what, url) => {
    expect(() => proxyHostOfMember(url, LOCAL)).toThrow(TypeError)
  })

  it.each([
    'localhost', 'box.localhost', 'printer.local', '127.0.0.1', '10.1.2.3', '172.16.0.1', '172.31.255.1',
    '192.168.1.1', '169.254.10.10', '100.64.0.1', '0.0.0.0', '::1', '::', 'fd00::1', 'fe80::1', '::ffff:10.0.0.1',
  ])('%s is this machine or a private network', host => {
    expect(isLocalProxyHost(host)).toBe(true)
  })

  it.each(['203.0.113.7', '172.32.0.1', '100.128.0.1', '8.8.8.8', '2001:db8::1', 'proxy.example.com', '::ffff:8.8.8.8'])(
    '%s is not',
    host => {
      expect(isLocalProxyHost(host)).toBe(false)
    },
  )

  it.each([
    ['http://2130706433:8080', '127.0.0.1'],
    ['http://0x7f.1:8080', '127.0.0.1'],
    ['http://127.1:8080', '127.0.0.1'],
    ['http://012.0.0.1:8080', '10.0.0.1'],
    ['http://[::ffff:7f00:1]:8080', '::ffff:7f00:1'],
    ['http://[::ffff:127.0.0.1]:8080', '::ffff:7f00:1'],
    ['http://[::FFFF:a00:1]:8080', '::ffff:a00:1'],
  ])('%s is judged in its canonical form', (url, canonical) => {
    expect(() => proxyHostOfMember(url, PUBLIC)).toThrow('did not declare')
    expect(proxyHostOfMember(url, LOCAL)).toBe(canonical)
  })

  it('a public address in another spelling stays public', () => {
    expect(proxyHostOfMember('http://[::ffff:808:808]:8080', PUBLIC)).toBe('::ffff:808:808')
    expect(proxyHostOfMember('http://134744072:8080', PUBLIC)).toBe('8.8.8.8')
  })

  it('a local address needs a pool that declared local', () => {
    expect(() => proxyHostOfMember('http://127.0.0.1:8080', PUBLIC)).toThrow('did not declare')
    expect(() => proxyHostOfMember('http://[::1]:8080', PUBLIC)).toThrow('did not declare')
    expect(proxyHostOfMember('http://127.0.0.1:8080', LOCAL)).toBe('127.0.0.1')
  })
})

describe('the registry of members', () => {
  const members = [
    { id: 'p0', url: 'http://203.0.113.7:8080' },
    { id: 'p1', url: 'https://user:secret-pass@gate.example.com' },
  ]

  it('answers a registered member as the egress a request is sent with', () => {
    const registry = new ProviderEgressPoolRegistry()
    registry.set(ID, 'pool', PUBLIC, members)
    expect(registry.ids(ID, 'pool')).toEqual(['p0', 'p1'])
    expect(registry.member(ID, 'pool', 'p1', PUBLIC)).toEqual({ url: 'https://user:secret-pass@gate.example.com', hosts: ['gate.example.com'] })
    expect(registry.member(ID, 'pool', 'p9', PUBLIC)).toBeUndefined()
    expect(registry.member(ID, 'other', 'p0', PUBLIC)).toBeUndefined()
    expect(registry.member('mod.acme.other', 'pool', 'p0', PUBLIC)).toBeUndefined()
  })

  it('a set replaces the pool whole; an empty list empties it', () => {
    const registry = new ProviderEgressPoolRegistry()
    registry.set(ID, 'pool', PUBLIC, members)
    registry.set(ID, 'pool', PUBLIC, [{ id: 'q', url: 'http://203.0.113.9' }])
    expect(registry.ids(ID, 'pool')).toEqual(['q'])
    registry.set(ID, 'pool', PUBLIC, [])
    expect(registry.ids(ID, 'pool')).toEqual([])
  })

  it('one bad member refuses the call, leaves the pool as it was, and never quotes an address', () => {
    const registry = new ProviderEgressPoolRegistry()
    registry.set(ID, 'pool', PUBLIC, members)
    const attempt = () =>
      registry.set(ID, 'pool', PUBLIC, [
        { id: 'ok', url: 'http://203.0.113.9' },
        { id: 'bad', url: 'socks5://user:secret-pass@203.0.113.10' },
      ])
    expect(attempt).toThrow('member "bad"')
    try {
      attempt()
    } catch (error) {
      expect(String(error)).not.toContain('secret-pass')
      expect(String(error)).not.toContain('203.0.113.10')
    }
    expect(registry.ids(ID, 'pool')).toEqual(['p0', 'p1'])
  })

  it.each([
    ['members that are no list', { id: 'p0' }, 'must be a list'],
    ['more members than the pool takes', Array.from({ length: 5 }, (_, i) => ({ id: `p${i}`, url: 'http://203.0.113.7' })), 'more than this pool'],
    ['a member with no id', [{ url: 'http://203.0.113.7' }], 'member 0: id must be'],
    ['an id listed twice', [{ id: 'a', url: 'http://203.0.113.7' }, { id: 'a', url: 'http://203.0.113.8' }], 'listed twice'],
  ])('refuses %s', (_what, value, problem) => {
    expect(() => new ProviderEgressPoolRegistry().set(ID, 'pool', PUBLIC, value)).toThrow(problem)
  })

  it('clear forgets one provider and leaves the others', () => {
    const registry = new ProviderEgressPoolRegistry()
    registry.set(ID, 'pool', PUBLIC, members)
    registry.set('mod.acme.mainline', 'pool', PUBLIC, members)
    registry.clear(ID)
    expect(registry.ids(ID, 'pool')).toEqual([])
    expect(registry.ids('mod.acme.mainline', 'pool')).toEqual(['p0', 'p1'])
  })
})

describe('$.provider.setEgress', () => {
  function setup(pools: Record<string, { max: number; local: boolean }> | undefined) {
    const registry = new ProviderEgressPoolRegistry()
    const nouns = createProviderNouns({
      vault: createMemoryKeyVault(),
      sessions: new MemorySessionStores(),
      device: () => ({ userAgent: 'x', appVersion: '1', locale: 'en' }),
      declaredSecrets: () => [],
      writeProviderSecrets: async () => {},
      egress: { declaredPools: () => pools, registry },
    })
    const call = async (...args: unknown[]): Promise<unknown> =>
      nouns.table.setEgress!({ plugin: 'acme', noun: 'provider', method: 'setEgress', args, providers: [ID] } as unknown as ProviderNounCall)
    return { call, registry }
  }

  it('fills a declared pool', async () => {
    const { call, registry } = setup({ pool: PUBLIC })
    await call('pool', [{ id: 'p0', url: 'http://203.0.113.7:8080' }])
    expect(registry.ids(ID, 'pool')).toEqual(['p0'])
  })

  it('refuses a pool the provider does not declare, and one that is only an inherited name', async () => {
    const { call } = setup({ pool: PUBLIC })
    await expect(call('other', [])).rejects.toMatchObject({ name: 'NotAllowedError' })
    await expect(call('toString', [])).rejects.toMatchObject({ name: 'NotAllowedError' })
    await expect(setup(undefined).call('pool', [])).rejects.toMatchObject({ name: 'NotAllowedError' })
  })

  it('a refused member is a TypeError that names the call and not the address', async () => {
    const { call } = setup({ pool: PUBLIC })
    const refused = call('pool', [{ id: 'home', url: 'http://user:secret-pass@192.168.1.5:3128' }])
    await expect(refused).rejects.toThrow(TypeError)
    await expect(refused).rejects.toThrow('$.provider.setEgress: member "home"')
    await refused.catch(error => expect(String(error)).not.toContain('secret-pass'))
  })
})

describe('a route to a pool member', () => {
  const lookup = (pool: string, member: string) =>
    pool === 'pool' && member === 'p0' ? { url: 'http://203.0.113.7:8080', hosts: ['203.0.113.7'] } : undefined

  it('reads as that member, marked dynamic', () => {
    expect(readRequestPlan({ route: { egress: 'pool', member: 'p0' } }, {}, lookup)).toEqual({
      egress: { name: 'pool/p0', url: 'http://203.0.113.7:8080', hosts: ['203.0.113.7'], dynamic: true },
    })
  })

  it.each([
    [{ egress: 'pool', member: 'p9' }, '"p9" is not a registered member of the pool "pool"'],
    [{ egress: 'nope', member: 'p0' }, 'is not a registered member'],
    [{ egress: 'pool' }, 'route is not { egress, member }'],
    [{ egress: 'pool', member: 'p0', url: 'http://x' }, 'route.url is not a known property'],
  ])('refuses %j', (route, problem) => {
    expect(() => readRequestPlan({ route }, {}, lookup)).toThrow(problem)
  })

  it('a provider with no pool refuses every member', () => {
    expect(() => readRequestPlan({ route: { egress: 'pool', member: 'p0' } })).toThrow('is not a registered member')
  })
})

// ── manifest → seam → grant ─────────────────────────────────────────────────

function manifestOf(over: Record<string, unknown>): ProviderManifest {
  const errors: string[] = []
  const parsed = checkProviderManifests(
    'acme',
    { main: providerJson({ domains: ['api.acme.test'], credentials: { methods: ['apiKey'] }, ...over }) },
    errors,
  )
  expect(errors).toEqual([])
  return parsed!.main!
}

const runtime = { call: async () => ({ raised: false }), hasHook: () => true, whenLoaded: async () => {} } as unknown as ProviderModRuntime

describe('the seam of a provider with a pool', () => {
  it('finds members of its declared pools only, and of its own provider', () => {
    const manifest = manifestOf({ egress: { pool: { dynamic: true } } })
    expect(manifest.egressPools).toEqual({ pool: { max: EGRESS_POOL_MAX_MEMBERS, local: false } })
    const seam = seamForRegistration({ providerId: ID, manifest, runtime }, () => {})
    providerEgressPools.set(ID, 'pool', PUBLIC, [{ id: 'p0', url: 'http://203.0.113.7' }])
    providerEgressPools.set(ID, 'undeclared', PUBLIC, [{ id: 'p0', url: 'http://203.0.113.8' }])
    expect(seam.egressMember?.('pool', 'p0')).toEqual({ url: 'http://203.0.113.7', hosts: ['203.0.113.7'] })
    expect(seam.egressMember?.('undeclared', 'p0')).toBeUndefined()
    expect(seamForRegistration({ providerId: ID, manifest: manifestOf({}), runtime }, () => {}).egressMember).toBeUndefined()
  })

  it('taking the provider out forgets its members', async () => {
    const manifest = manifestOf({ egress: { pool: { dynamic: true } } })
    const unplug = providerSeamListener(() => {})({ providerId: ID, manifest, runtime } as never)
    providerEgressPools.set(ID, 'pool', PUBLIC, [{ id: 'p0', url: 'http://203.0.113.7' }])
    ;(unplug as () => void)()
    await Promise.resolve()
    expect(providerEgressPools.ids(ID, 'pool')).toEqual([])
  })

  it('an update keeps the members its new module already registered', async () => {
    const manifest = manifestOf({ egress: { pool: { dynamic: true } } })
    const listener = providerSeamListener(() => {})
    const unplugOld = listener({ providerId: ID, manifest, runtime } as never)
    const unplugNew = listener({ providerId: ID, manifest, runtime } as never)
    providerEgressPools.set(ID, 'pool', PUBLIC, [{ id: 'p0', url: 'http://203.0.113.7' }])
    ;(unplugOld as () => void)()
    await Promise.resolve()
    expect(providerEgressPools.ids(ID, 'pool')).toEqual(['p0'])
    ;(unplugNew as () => void)()
    await Promise.resolve()
    expect(providerEgressPools.ids(ID, 'pool')).toEqual([])
  })

  it('a member is answered only while it meets the pool as declared now', () => {
    const manifest = manifestOf({ egress: { pool: { dynamic: true, max: 1 } } })
    const seam = seamForRegistration({ providerId: ID, manifest, runtime }, () => {})
    providerEgressPools.set(ID, 'pool', { max: 64, local: true }, [
      { id: 'p0', url: 'http://203.0.113.7' },
      { id: 'p1', url: 'http://203.0.113.8' },
      { id: 'home', url: 'http://192.168.1.1' },
    ])
    expect(seam.egressMember?.('pool', 'p0')).toEqual({ url: 'http://203.0.113.7', hosts: ['203.0.113.7'] })
    expect(seam.egressMember?.('pool', 'p1')).toBeUndefined()
    expect(seam.egressMember?.('pool', 'home')).toBeUndefined()
  })
})

describe('a pool in the grant', () => {
  const grant = (egress?: Record<string, unknown>): Grant => grantOf({ main: manifestOf(egress ? { egress } : {}) })

  it('is public unless a pool declared local; absent with no pool', () => {
    expect(grant().providers.main).not.toHaveProperty('proxyPools')
    expect(grant({ a: { dynamic: true } }).providers.main!.proxyPools).toBe('public')
    expect(grant({ a: { dynamic: true }, b: { dynamic: true, local: true } }).providers.main!.proxyPools).toBe('local')
  })

  it('a first pool widens, local widens further, and going back does not', () => {
    const none = grant()
    const pub = grant({ a: { dynamic: true } })
    const local = grant({ a: { dynamic: true, local: true } })
    expect(widened(none, pub).added.perProvider.main).toMatchObject({ proxyPools: 'public' })
    expect(widened(pub, local).added.perProvider.main).toMatchObject({ proxyPools: 'local' })
    expect(widened(pub, grant({ b: { dynamic: true, max: 2 } })).widened).toBe(false)
    expect(widened(local, pub).widened).toBe(false)
    expect(widened(local, none).widened).toBe(false)
  })
})
