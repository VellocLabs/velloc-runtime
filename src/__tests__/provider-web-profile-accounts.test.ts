/**
 * Provider mods, the account records of a web profile (F-27): written by the
 * platform when a sign-in ends in a kept profile, kept while a provider is
 * signed in through that site of the profile, and listed to each plugin with
 * its own providers. The sign-in service, the settings write path
 * (`providersHandlers`), the table (`WebProfiles`) and the noun are the real
 * ones; the window, the module and the files are fakes.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { providersHandlers, redactProviderConfigsForUi } from '../browser/bridge/adapter/providersBridgeAdapter'
import type { SignInCapture, SignInWindowRequest } from '../browser/bridge/signInWindow'
import { resetRuntimeProviders, runtimeProviderConfigs, setRuntimeProviderConfigs } from '../models/drivers/runtimeProviders'
import { IDENTITY_SITES, identityOfHost } from '../mods/provider/identitySites'
import { defaultCredentialDeps } from '../mods/provider/login/credentialDeps'
import { ProviderCredentials, type CredentialRuntime } from '../mods/provider/login/providerCredentials'
import { createWebProfileNouns } from '../mods/provider/login/providerLoginNouns'
import { lendProviderHostSources, resetProviderHostSources } from '../mods/provider/providerHostSources'
import { ProviderModHost, type ProviderPluginFacts } from '../mods/provider/providerModHost'
import { PROVIDER_WIRE_FORMATS, resolveProviders } from '../mods/provider/providerManifest'
import type { ProviderNounCall } from '../mods/provider/ProviderModRuntime'
import { WebProfiles, type WebProfile } from '../mods/provider/webProfiles'
import { keepWebProfilesAt, releaseWebProfileAccount, runtimeWebProfiles, setWebProfilesForTests } from '../mods/provider/webProfilesRuntime'
import { checkPluginDescriptor } from '../pluginHost/manifestValidator'
import { NEXUS_SETTINGS_FILE_NAME, wipeSettingsMemos } from '../settings/settingsStore'
import type { NexusProviderConfig } from '../settings/settingsTypes'
import type { RuntimeFs } from '../utils/fs/runtimeFs'

const HOME = '/home/u'
const SETTINGS = `${HOME}/.velloc/${NEXUS_SETTINGS_FILE_NAME}`
const NOW = 1_800_000_000_000
const P1 = 'velloc-profile-1'
const P2 = 'velloc-profile-2'
const SITE = 'accounts.vendor-a.test'
const PAGE = `https://${SITE}/authorize`
const REDIRECT = 'http://127.0.0.1:53682/callback'
/** Two providers of the plugin `acme`, one of `other`. */
const A = 'mod.acme.main'
const B = 'mod.acme.second'
const O = 'mod.other.main'
/** A provider that is no plugin's. */
const GATEWAY = 'my-gateway'

type Listed = Omit<WebProfile, 'accounts'> & { accounts: Array<{ site: string; account: string; at: number; providers: string[]; identity?: string }> }
type SignIn = { profile?: string; account?: string; page?: string; fails?: boolean }

function world(tableOnDisk: string | null = null) {
  const files = new Map<string, string>()
  const fs = {
    existsSync: (path: string) => files.has(path),
    readFile: async (path: string) => {
      const text = files.get(path)
      if (text === undefined) throw Object.assign(new Error(`ENOENT: ${path}`), { code: 'ENOENT' })
      return text
    },
    writeFile: async (path: string, data: string | Uint8Array) => {
      files.set(path, typeof data === 'string' ? data : new TextDecoder().decode(data))
    },
    mkdir: async () => {},
  } as unknown as RuntimeFs
  const ctx = { homeDir: HOME, fs, onConfigsChanged: setRuntimeProviderConfigs }
  const write = async (id: string, config: NexusProviderConfig, options?: { promote?: boolean; webProfile?: { id: string; site: string } | null }) => {
    await providersHandlers.upsert({ id, config }, ctx, undefined, options?.promote ?? true, options?.webProfile)
  }
  lendProviderHostSources({
    writeProviderConfig: write,
    removeProviderConfig: async id => {
      await providersHandlers.remove({ id }, ctx)
    },
  })

  const table = { text: tableOnDisk, failing: false }
  const deleted: string[] = []
  let clock = NOW
  const profiles = new WebProfiles({
    load: async () => table.text,
    save: async text => {
      if (table.failing) throw new Error('the disk is full')
      table.text = text
    },
    hostKeepsProfiles: () => true,
    deletePartition: async partition => void deleted.push(partition),
    now: () => clock++,
  })
  setWebProfilesForTests(profiles)

  const plans = new Map<string, SignIn>()
  const requests: SignInWindowRequest[] = []
  const lines: string[] = []
  let settle: ((capture: SignInCapture) => void) | undefined
  const runtime: CredentialRuntime = {
    hasHook: (_id, event) => event === 'provider.login',
    call: (async (id: string, event: string, e: Record<string, unknown> = {}) => {
      if (event !== 'provider.login') return { raised: false }
      const plan = plans.get(id)!
      await service.openWindow(e.loginId, [id], {
        url: plan.page ?? PAGE,
        captureRedirect: REDIRECT,
        ...(plan.profile !== undefined ? { profile: plan.profile } : {}),
      })
      if (plan.fails) throw new Error('the token exchange was refused')
      return { raised: true, value: { secrets: { access_token: 'AT' }, ...(plan.account !== undefined ? { account: plan.account } : {}) } }
    }) as CredentialRuntime['call'],
  }
  const service: ProviderCredentials = new ProviderCredentials({
    ...defaultCredentialDeps(),
    runtime: () => runtime,
    describe: id =>
      id.startsWith('mod.')
        ? { secrets: ['access_token'], methods: ['login'], loginWindow: [SITE, 'accounts.google.com', 'accounts.vendor-b.test'] }
        : undefined,
    openWindow: request => {
      requests.push(request)
      return new Promise<SignInCapture>((resolve, reject) => {
        settle = resolve
        request.signal.addEventListener('abort', () => {
          reject(request.signal.reason)
          request.onGone?.()
        })
      })
    },
    report: line => lines.push(line),
  })

  const stepOf = (id: string) => service.state().logins[id]?.step.kind
  /** Lets the queued clean-up after a release finish. */
  const settled = async () => {
    await new Promise(resolve => setTimeout(resolve, 0))
    await profiles.list()
  }
  /** Starts a sign-in and waits for its window. */
  const open = async (id: string, plan: SignIn) => {
    plans.set(id, plan)
    const before = requests.length
    const { loginId } = service.startLogin(id)
    await vi.waitFor(() => expect(requests.length).toBe(before + 1))
    return loginId
  }
  const capture = () => settle!({ url: `${REDIRECT}?code=c1`, finish: () => {}, close: () => {} })
  const windowGone = () => requests.at(-1)?.onGone?.()
  /** A whole sign-in: the window opens, captures, the sign-in ends, the window goes. */
  const signIn = async (id: string, plan: SignIn) => {
    await open(id, plan)
    capture()
    await vi.waitFor(() => expect(stepOf(id)).toMatch(/done|failed/))
    windowGone()
    await settled()
  }
  const nouns = createWebProfileNouns(() => profiles, id => runtimeProviderConfigs()[id])
  const call = (plugin: string, providers: string[], ...args: unknown[]) => ({ plugin, args, providers }) as unknown as ProviderNounCall
  const list = async (plugin: string, providers: string[]) => (await nouns.webProfilesList!(call(plugin, providers))) as Listed[]
  const stored = () => JSON.parse(files.get(SETTINGS) ?? '{}').providers?.configs ?? {}
  return { fs, files, ctx, write, table, deleted, profiles, service, requests, lines, nouns, call, list, stored, open, capture, windowGone, signIn, settled, stepOf }
}

beforeEach(() => {
  wipeSettingsMemos()
  resetRuntimeProviders()
  resetProviderHostSources()
})

afterEach(() => {
  setWebProfilesForTests(undefined)
  resetProviderHostSources()
  resetRuntimeProviders()
})

describe('a sign-in that ends in a kept web profile', () => {
  it('is recorded on the profile by the platform, with the provider that signed in; the module recorded nothing', async () => {
    const w = world()
    await w.signIn(A, { profile: 'new', account: 'ann@example.com' })
    expect(w.stepOf(A)).toBe('done')
    const listed = await w.list('acme', [A, B])
    expect(listed).toHaveLength(1)
    expect(listed[0]).toMatchObject({ id: P1, logins: [] })
    expect(listed[0]!.accounts).toEqual([{ site: SITE, account: 'ann@example.com', at: expect.any(Number), providers: [A] }])
    expect(w.stored()[A].webProfile).toEqual({ id: P1, site: SITE })
    expect(w.deleted).toEqual([])
  })

  it('shows another plugin the same record with none of its providers', async () => {
    const w = world()
    await w.signIn(A, { profile: 'new', account: 'ann@example.com' })
    const [profile] = await w.list('other', [O])
    expect(profile!.accounts).toEqual([{ site: SITE, account: 'ann@example.com', at: expect.any(Number), providers: [] }])
    // A caller is never told another plugin's provider id.
    expect(JSON.stringify(await w.list('other', []))).not.toContain(A)
  })

  it('a later sign-in to the same site of the profile replaces the account: still one record', async () => {
    const w = world()
    await w.signIn(A, { profile: 'new', account: 'ann@example.com' })
    const first = (await w.list('acme', [A]))[0]!.accounts[0]!.at
    await w.signIn(B, { profile: P1, account: 'bob@example.com' })
    const [profile] = await w.list('acme', [A, B])
    expect(profile!.accounts).toEqual([{ site: SITE, account: 'bob@example.com', at: expect.any(Number), providers: [A, B] }])
    expect(profile!.accounts[0]!.at).toBeGreaterThan(first)
  })

  it('records each site of a profile once, by the host its window was opened on', async () => {
    const w = world()
    await w.signIn(A, { profile: 'new', account: 'ann@example.com' })
    await w.signIn(B, { profile: P1, account: 'ann@vendor-b', page: 'https://ACCOUNTS.vendor-b.test/login?next=1' })
    const [profile] = await w.list('acme', [A, B])
    expect(profile!.accounts.map(each => [each.site, each.providers])).toEqual([
      [SITE, [A]],
      ['accounts.vendor-b.test', [B]],
    ])
  })

  it('carries the identity of a well-known identity site, and none for any other host', async () => {
    const w = world()
    await w.signIn(A, { profile: 'new', account: 'ann@gmail.test', page: 'https://accounts.google.com/o/oauth2/v2/auth' })
    await w.signIn(B, { profile: P1, account: 'ann@example.com' })
    const [profile] = await w.list('acme', [A, B])
    expect(profile!.accounts.find(each => each.site === 'accounts.google.com')).toMatchObject({ identity: 'google', providers: [A] })
    expect(profile!.accounts.find(each => each.site === SITE)).not.toHaveProperty('identity')
  })

  it('is there again after a restart, and a table with no account records loads', async () => {
    const w = world()
    await w.signIn(A, { profile: 'new', account: 'ann@example.com' })
    const again = new WebProfiles({ load: async () => w.table.text, save: async () => {}, hostKeepsProfiles: () => true, deletePartition: async () => {} })
    expect((await again.list())[0]!.accounts).toMatchObject([{ site: SITE, account: 'ann@example.com' }])

    const earlier = JSON.stringify({
      version: 2,
      next: 4,
      profiles: [{ number: 3, createdAt: NOW, logins: [{ site: 'vendor-a.test', account: 'one', plugin: 'acme', at: NOW }] }],
    })
    const old = new WebProfiles({ load: async () => earlier, save: async () => {}, hostKeepsProfiles: () => true, deletePartition: async () => {} })
    expect(await old.list()).toEqual([
      { id: 'velloc-profile-3', createdAt: NOW, logins: [{ site: 'vendor-a.test', account: 'one', plugin: 'acme', at: NOW }], accounts: [] },
    ])
  })
})

describe('the table the runtime keeps on disk', () => {
  afterEach(() => setWebProfilesForTests(undefined))

  const TABLE = `${HOME}/.velloc/web-profiles.json`
  const stored = JSON.stringify({
    version: 2,
    next: 4,
    profiles: [{ number: 3, createdAt: NOW, logins: [], accounts: [{ site: SITE, account: 'ann@example.com', at: NOW }] }],
  })
  // The browser's fs answers `existsSync` with false for every path.
  const fsOver = (read: (path: string) => Promise<string>, written: string[] = []) =>
    ({
      existsSync: () => false,
      readFile: read,
      writeFile: async (_path: string, data: string) => void written.push(data),
      mkdir: async () => {},
    }) as unknown as RuntimeFs
  const absent = async (path: string): Promise<string> => {
    throw Object.assign(new Error(`ENOENT: ${path}`), { code: 'ENOENT' })
  }

  it('is read after a restart on an fs that cannot say a path exists, so the next change keeps what was stored', async () => {
    const written: string[] = []
    const profiles = runtimeWebProfiles({ homeDir: HOME, fs: fsOver(async path => (path === TABLE ? stored : absent(path)), written) })
    expect(await profiles.list()).toMatchObject([{ id: 'velloc-profile-3', accounts: [{ site: SITE, account: 'ann@example.com' }] }])
    await profiles.recordAccount('velloc-profile-3', 'other.test', 'ann')
    expect(JSON.parse(written[0]!)).toMatchObject({ next: 4, profiles: [{ number: 3, accounts: [{ site: SITE }, { site: 'other.test' }] }] })
  })

  it('a missing file is an empty table; a file that cannot be read is not taken for one', async () => {
    expect(await runtimeWebProfiles({ homeDir: HOME, fs: fsOver(absent) }).list()).toEqual([])
    setWebProfilesForTests(undefined)
    const broken = runtimeWebProfiles({
      homeDir: HOME,
      fs: fsOver(async () => {
        throw new Error('EBUSY: the file is in use')
      }),
    })
    await expect(broken.list()).rejects.toThrow(/could not be read/)
  })

  it('a removal lets go of the account on such an fs, in a realm that has not used the table yet', async () => {
    const written: string[] = []
    const fs = fsOver(async path => (path === TABLE ? stored : absent(path)), written)
    await releaseWebProfileAccount({ homeDir: HOME, fs }, { id: 'velloc-profile-3', site: SITE }, {})
    // No host here to delete the emptied profile's session, so the profile itself is kept.
    expect(written).toHaveLength(1)
    expect(JSON.parse(written[0]!).profiles).toMatchObject([{ number: 3, accounts: [] }])
  })
})

describe('a sign-in that leaves no account record', () => {
  it('a failed one: nothing is written, and the profile made for it goes with its window', async () => {
    const w = world()
    await w.signIn(A, { profile: 'new', account: 'ann@example.com', fails: true })
    expect(w.stepOf(A)).toBe('failed')
    expect(await w.list('acme', [A])).toEqual([])
    expect(w.deleted).toEqual(['vellocprofileb'])
    expect(w.stored()[A]).toBeUndefined()
  })

  it('a cancelled one: nothing is written, and the profile made for it goes with its window', async () => {
    const w = world()
    const loginId = await w.open(A, { profile: 'new', account: 'ann@example.com' })
    expect(await w.profiles.list()).toHaveLength(1)
    w.service.cancel(loginId)
    w.windowGone()
    await w.settled()
    expect(await w.list('acme', [A])).toEqual([])
    expect(w.deleted).toEqual(['vellocprofileb'])
  })

  it('one in the temporary profile, or in the person\'s own', async () => {
    const w = world()
    await w.signIn(A, { profile: 'temporary', account: 'ann@example.com' })
    expect(w.requests[0]).toMatchObject({ isolated: true })
    await w.signIn(B, { account: 'bob@example.com' })
    expect(w.stepOf(A)).toBe('done')
    expect(w.stepOf(B)).toBe('done')
    expect(await w.list('acme', [A, B])).toEqual([])
    expect(w.stored()[A]).not.toHaveProperty('webProfile')
    expect(w.stored()[B]).not.toHaveProperty('webProfile')
    expect(w.table.text).toBeNull()
  })

  it('one whose answer names no account', async () => {
    const w = world()
    await w.signIn(A, { profile: 'new' })
    expect(w.stepOf(A)).toBe('done')
    expect(w.stored()[A]).toMatchObject({ signedIn: true })
    expect(w.stored()[A]).not.toHaveProperty('webProfile')
    expect(await w.list('acme', [A])).toEqual([])
    expect(w.deleted).toEqual(['vellocprofileb'])
  })

  it('a record that could not be written does not fail the sign-in', async () => {
    const w = world()
    await w.open(A, { profile: 'new', account: 'ann@example.com' })
    w.table.failing = true
    w.capture()
    await vi.waitFor(() => expect(w.stepOf(A)).toBe('done'))
    expect(w.lines.join('\n')).toContain('was not recorded')
    expect(w.stored()[A]).toMatchObject({ account: 'ann@example.com' })
  })
})

describe('a window closed before its sign-in ends', () => {
  it('does not take the new profile with it: the record is written first', async () => {
    const w = world()
    await w.open(A, { profile: 'new', account: 'ann@example.com' })
    // The host reports the window gone as soon as it captured; the sign-in is still being written.
    w.capture()
    w.windowGone()
    await vi.waitFor(() => expect(w.stepOf(A)).toBe('done'))
    await w.settled()
    expect((await w.list('acme', [A]))[0]!.accounts).toMatchObject([{ site: SITE, account: 'ann@example.com', providers: [A] }])
    expect(w.deleted).toEqual([])
  })
})

describe('the life of an account record', () => {
  it('two providers signed in through one site of a profile: the record stays until the last is removed, then the profile goes', async () => {
    const w = world()
    await w.signIn(A, { profile: 'new', account: 'ann@example.com' })
    await w.signIn(B, { profile: P1, account: 'ann@example.com' })
    await providersHandlers.remove({ id: A }, w.ctx)
    await w.settled()
    expect((await w.list('acme', [A, B]))[0]!.accounts).toMatchObject([{ site: SITE, providers: [B] }])
    expect(w.deleted).toEqual([])
    await providersHandlers.remove({ id: B }, w.ctx)
    await w.settled()
    expect(await w.list('acme', [A, B])).toEqual([])
    expect(w.deleted).toEqual(['vellocprofileb'])
  })

  it('signing out lets go like a removal; a plugin\'s own login record keeps the profile', async () => {
    const w = world()
    await w.signIn(A, { profile: 'new', account: 'ann@example.com' })
    await w.nouns.webProfilesSetLogin!(w.call('other', [O], P1, { site: 'vendor-a.test', account: 'note' }))
    await w.service.signOut(A)
    await w.settled()
    expect(w.stored()[A]).not.toHaveProperty('webProfile')
    const [profile] = await w.list('acme', [A])
    expect(profile).toMatchObject({ id: P1, accounts: [], logins: [{ plugin: 'other' }] })
    expect(w.deleted).toEqual([])
    await w.nouns.webProfilesRemoveLogin!(w.call('other', [O], P1, 'vendor-a.test'))
    expect(await w.profiles.list()).toEqual([])
    expect(w.deleted).toEqual(['vellocprofileb'])
  })

  it('a provider that signs in again elsewhere lets go of where it was', async () => {
    const w = world()
    await w.signIn(A, { profile: 'new', account: 'ann@example.com' })
    await w.signIn(A, { profile: 'new', account: 'ann@example.com' })
    const listed = await w.list('acme', [A])
    expect(listed.map(profile => profile.id)).toEqual([P2])
    expect(listed[0]!.accounts).toMatchObject([{ site: SITE, providers: [A] }])
    expect(w.deleted).toEqual(['vellocprofileb'])
    // Signing in with no kept profile lets go of the last one too.
    await w.signIn(A, { account: 'ann@example.com' })
    expect(await w.list('acme', [A])).toEqual([])
    expect(w.deleted).toEqual(['vellocprofileb', 'vellocprofilec'])
  })

  it('other providers\' sign-ins in the same profile are untouched by a removal', async () => {
    const w = world()
    await w.signIn(A, { profile: 'new', account: 'ann@example.com' })
    await w.signIn(O, { profile: P1, account: 'ann@vendor-b', page: 'https://accounts.vendor-b.test/login' })
    await providersHandlers.remove({ id: A }, w.ctx)
    await w.settled()
    const [profile] = await w.list('other', [O])
    expect(profile!.accounts).toMatchObject([{ site: 'accounts.vendor-b.test', account: 'ann@vendor-b', providers: [O] }])
    expect(w.deleted).toEqual([])
  })
})

describe('a plugin that is taken away', () => {
  function plugin(name: string): ProviderPluginFacts {
    const providers = {
      main: {
        providerApi: 1,
        displayName: { en: name },
        defaultBaseUrl: 'https://api.vendor-a.test/v1',
        domains: ['api.vendor-a.test', SITE],
        format: PROVIDER_WIRE_FORMATS[0],
        credentials: { methods: ['login'], secrets: [{ name: 'access_token' }], loginWindow: { allow: [SITE] } },
        module: './providers/main.js',
      },
    }
    const { manifest, errors } = checkPluginDescriptor({ name, version: '1.0.0', providers })
    expect(errors).toEqual([])
    const path = `${HOME}/.velloc/plugins/${name}`
    return { name, manifest: manifest!, path, source: `user:${path}`, enabled: true, providers: resolveProviders(name, path, manifest!.providers!) } as ProviderPluginFacts
  }

  function host(w: ReturnType<typeof world>, publish: () => Promise<void> = async () => {}): ProviderModHost {
    const made = new ProviderModHost()
    made.configure({
      createRuntime: async () => ({ register: () => {}, unregister: () => {}, replace: async () => {}, dispose: () => {} }) as never,
      readText: async () => '',
      report: line => w.lines.push(line),
      adopt: async () => {},
      publish,
      hasStoredConfigs: () => true,
      storedConfigs: runtimeProviderConfigs,
      writeConfig: w.write,
    })
    return made
  }

  it('lets go of what its providers signed in through; another plugin\'s sign-in through the same profile stays', async () => {
    const w = world()
    await w.signIn(A, { profile: 'new', account: 'ann@example.com' })
    await w.signIn(O, { profile: P1, account: 'ann@example.com' })
    await w.signIn(B, { profile: 'new', account: 'bob@example.com' })
    const mods = host(w)
    await mods.sync({ enabled: [plugin('acme'), plugin('other')], disabled: [] })
    expect((await w.list('other', [O])).map(profile => profile.id)).toEqual([P1, P2])

    // Switched off is not taken away.
    await mods.sync({ enabled: [plugin('other')], disabled: [plugin('acme')] })
    expect(w.stored()[A].webProfile).toEqual({ id: P1, site: SITE })

    await mods.sync({ enabled: [plugin('other')], disabled: [] })
    await w.settled()
    // The entry is kept, as for any plugin that is gone; only its place in the profile is not.
    expect(w.stored()[A]).toMatchObject({ account: 'ann@example.com' })
    expect(w.stored()[A]).not.toHaveProperty('webProfile')
    const [profile] = await w.list('other', [O])
    expect(profile!.accounts).toMatchObject([{ site: SITE, providers: [O] }])
    expect(w.lines).toEqual([])
    mods.dispose()
  })

  it('an entry removed while the sync runs is not written back', async () => {
    const w = world()
    await w.signIn(A, { profile: 'new', account: 'ann@example.com' })
    let removing = false
    const mods = host(w, async () => {
      if (removing) await providersHandlers.remove({ id: A }, w.ctx)
    })
    await mods.sync({ enabled: [plugin('acme')], disabled: [] })
    removing = true
    await mods.sync({ enabled: [], disabled: [] })
    await w.settled()
    expect(w.stored()).not.toHaveProperty(A)
    expect(await w.list('other', [O])).toEqual([])
    expect(w.lines).toEqual([])
    mods.dispose()
  })
})

describe('a release before the profiles were first used', () => {
  afterEach(() => setWebProfilesForTests(undefined))

  it('reports through the runtime\'s reporter, not the settings write\'s', async () => {
    const w = world()
    setWebProfilesForTests(undefined)
    const lines: string[] = []
    keepWebProfilesAt({ homeDir: HOME, fs: w.fs, report: line => lines.push(line) })
    w.files.set(
      `${HOME}/.velloc/web-profiles.json`,
      JSON.stringify({ version: 3, next: 2, profiles: [{ number: 1, createdAt: NOW, logins: [], accounts: [{ site: SITE, account: 'ann@example.com', at: NOW }] }] }),
    )
    await releaseWebProfileAccount({ homeDir: HOME, fs: w.fs }, { id: P1, site: SITE }, {})
    // No host here, so the emptied profile cannot be deleted: it is kept and said so.
    expect(lines).toEqual([expect.stringContaining(`${P1} could not be deleted`)])
  })
})

describe('security: who can write what', () => {
  it('no noun writes or removes an account record', async () => {
    const w = world()
    await w.signIn(A, { profile: 'new', account: 'ann@example.com' })
    expect(Object.keys(w.nouns).sort()).toEqual(['webProfilesList', 'webProfilesRemoveLogin', 'webProfilesSetLogin'])
    await w.nouns.webProfilesSetLogin!(w.call('other', [O], P1, { site: SITE, account: 'mallory', accounts: [{ site: SITE, account: 'mallory' }] }))
    await w.nouns.webProfilesRemoveLogin!(w.call('other', [O], P1, SITE))
    expect((await w.list('other', [O]))[0]!.accounts).toEqual([{ site: SITE, account: 'ann@example.com', at: expect.any(Number), providers: [] }])
  })

  it('only the sign-in service says which profile an entry signed in through; no page is told', async () => {
    const w = world()
    await w.signIn(A, { profile: 'new', account: 'ann@example.com' })
    // A write naming another profile, and one naming none, both leave it as it is.
    const page = await providersHandlers.upsert(
      { id: A, config: { source: 'mod', account: 'ann@example.com', webProfile: { id: P2, site: 'accounts.google.com' } } as NexusProviderConfig },
      w.ctx,
    )
    await providersHandlers.upsert({ id: A, config: { source: 'mod', account: 'ann@example.com' } }, w.ctx)
    expect(w.stored()[A].webProfile).toEqual({ id: P1, site: SITE })
    // A write cannot give one to an entry that has none, nor to a provider that is no plugin's.
    await providersHandlers.upsert({ id: B, config: { source: 'mod', webProfile: { id: P1, site: SITE } } as NexusProviderConfig }, w.ctx)
    await providersHandlers.upsert({ id: GATEWAY, config: { apiKey: 'k' } }, w.ctx, undefined, true, { id: P1, site: SITE })
    expect(w.stored()[B]).not.toHaveProperty('webProfile')
    expect(w.stored()[GATEWAY]).not.toHaveProperty('webProfile')
    expect((await w.list('acme', [A, B]))[0]!.accounts[0]!.providers).toEqual([A])

    expect(page.configs[A]).not.toHaveProperty('webProfile')
    expect((await providersHandlers.list(w.ctx)).configs[A]).not.toHaveProperty('webProfile')
    expect(redactProviderConfigsForUi(runtimeProviderConfigs())[A]).not.toHaveProperty('webProfile')
  })

  it('a malformed note in settings.json is not read', async () => {
    const w = world()
    w.files.set(
      SETTINGS,
      JSON.stringify({
        version: 1,
        providers: {
          configs: {
            [A]: { source: 'mod', webProfile: { id: P1, site: SITE } },
            [B]: { source: 'mod', webProfile: { id: P1 } },
            [O]: { source: 'mod', webProfile: 'velloc-profile-1' },
          },
        },
      }),
    )
    await providersHandlers.upsert({ id: GATEWAY, config: { apiKey: 'k' } }, w.ctx)
    const configs = runtimeProviderConfigs()
    expect(configs[A]!.webProfile).toEqual({ id: P1, site: SITE })
    expect(configs[B]).not.toHaveProperty('webProfile')
    expect(configs[O]).not.toHaveProperty('webProfile')
  })
})

describe('the identity sites', () => {
  it('file each sign-in host under one key, by exact host', () => {
    expect(identityOfHost('accounts.google.com')).toBe('google')
    expect(identityOfHost('GitHub.com')).toBe('github')
    expect(identityOfHost('login.microsoftonline.com')).toBe('microsoft')
    expect(identityOfHost('login.live.com')).toBe('microsoft')
    expect(identityOfHost('appleid.apple.com')).toBe('apple')
    expect(identityOfHost('google.com')).toBeUndefined()
    expect(identityOfHost('evil.accounts.google.com')).toBeUndefined()
    expect(identityOfHost('gist.github.com')).toBeUndefined()
  })

  it('name every key once and every host once', () => {
    const keys = IDENTITY_SITES.map(site => site.identity)
    const hosts = IDENTITY_SITES.flatMap(site => site.hosts)
    expect(new Set(keys).size).toBe(keys.length)
    expect(new Set(hosts).size).toBe(hosts.length)
    for (const site of IDENTITY_SITES) expect(site.name).not.toBe('')
    for (const host of hosts) expect(host).toBe(host.toLowerCase())
  })
})
