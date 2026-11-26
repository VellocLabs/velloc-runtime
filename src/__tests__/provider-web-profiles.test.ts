/**
 * Provider mods, web profiles: the shared table (`WebProfiles`) against an
 * in-memory file and a fake host, a sign-in window opened in a profile, the
 * shared window's `storagePartition`, and the nouns. The real worker's
 * `$.provider.webProfiles` is in `provider-mod-login.test.ts`.
 */
import { describe, expect, it } from 'vitest'
import { createNativePrimitives } from '../browser/bridge/nativePrimitives'
import type { BrowserBridgeRequest, BrowserBridgeTransport } from '../browser/bridge/browserBridgeProtocol'
import { openSignInWindow, type SignInCapture, type SignInWindowRequest } from '../browser/bridge/signInWindow'
import { ProviderCredentials, type CredentialRuntime } from '../mods/provider/login/providerCredentials'
import { createWebProfileNouns } from '../mods/provider/login/providerLoginNouns'
import type { ProviderNounCall } from '../mods/provider/ProviderModRuntime'
import {
  WEB_PROFILES_MAX,
  WEB_PROFILE_LOGINS_PER_PLUGIN_MAX,
  WebProfiles,
  webProfilePartition,
} from '../mods/provider/webProfiles'
import {
  currentWebProfiles,
  forgetPluginWebProfiles,
  keepWebProfilesAt,
  setWebProfilesForTests,
  WEB_PROFILES_FILE_NAME,
} from '../mods/provider/webProfilesRuntime'
import type { RuntimeFs } from '../utils/fs/runtimeFs'

const NOW = 1_800_000_000_000
const P1 = 'velloc-profile-1'
const P2 = 'velloc-profile-2'

function rig(options: { file?: string | null; hostKeeps?: boolean; deleteFails?: boolean } = {}) {
  const disk = { text: options.file ?? null }
  const deleted: string[] = []
  const failing = { on: options.deleteFails ?? false }
  let saves = 0
  let clock = NOW
  const make = () =>
    new WebProfiles({
      load: async () => disk.text,
      save: async text => {
        saves += 1
        disk.text = text
      },
      hostKeepsProfiles: () => options.hostKeeps ?? true,
      deletePartition: async partition => {
        if (failing.on) throw new Error('the host said no')
        deleted.push(partition)
      },
      now: () => clock++,
    })
  return { profiles: make(), reopen: make, disk, deleted, failing, saves: () => saves }
}

/** Lets the queued clean-up after a release finish. */
const settled = async (profiles: WebProfiles) => {
  await new Promise(resolve => setTimeout(resolve, 0))
  await profiles.list()
}

/** A profile with one login record of `plugin`, no window open. */
async function signedIn(profiles: WebProfiles, plugin: string, site: string, account: string): Promise<string> {
  const held = await profiles.hold('new')
  await profiles.setLogin(plugin, held.id, { site, account })
  held.release()
  await settled(profiles)
  return held.id
}

describe('web profiles', () => {
  it('a new profile gets the next id of the platform\'s numbering and a partition name of letters', async () => {
    const r = rig()
    const first = await r.profiles.hold('new')
    const second = await r.profiles.hold('new')
    expect([first.id, second.id]).toEqual([P1, P2])
    expect([first.partition, second.partition]).toEqual(['vellocprofileb', 'vellocprofilec'])
    expect(webProfilePartition(26)).toBe('vellocprofileba')
    expect(webProfilePartition(27 * 26)).toMatch(/^[a-z]{8,32}$/)
  })

  it('a profile nobody recorded a login in is deleted when its window lets go, and its number is not used again', async () => {
    const r = rig()
    const held = await r.profiles.hold('new')
    expect((await r.profiles.list()).map(row => row.id)).toEqual([P1])
    held.release()
    held.release()
    await settled(r.profiles)
    expect(await r.profiles.list()).toEqual([])
    expect(r.deleted).toEqual(['vellocprofileb'])
    expect((await r.profiles.hold('new')).id).toBe(P2)
    expect((await r.reopen().hold('new')).id).toBe('velloc-profile-3')
  })

  it('records a login under the plugin that made it; every plugin reads every record', async () => {
    const r = rig()
    const held = await r.profiles.hold('new')
    await r.profiles.setLogin('acme', held.id, { site: 'Mail.Vendor-A.test', account: ' zed@vendor-a.test ', data: { plan: 'pro' } })
    await r.profiles.setLogin('other', held.id, { site: 'mail.vendor-a.test', account: 'zed@vendor-a.test' })
    held.release()
    await settled(r.profiles)
    expect(await r.profiles.list()).toEqual([
      {
        id: P1,
        createdAt: NOW,
        logins: [
          { site: 'mail.vendor-a.test', account: 'zed@vendor-a.test', plugin: 'acme', at: NOW + 1, data: { plan: 'pro' } },
          { site: 'mail.vendor-a.test', account: 'zed@vendor-a.test', plugin: 'other', at: NOW + 2 },
        ],
        accounts: [],
      },
    ])
  })

  it('a plugin replaces and removes only its own record of a site', async () => {
    const r = rig()
    const id = await signedIn(r.profiles, 'acme', 'vendor-a.test', 'one')
    await r.profiles.setLogin('other', id, { site: 'vendor-a.test', account: 'theirs' })
    await r.profiles.setLogin('acme', id, { site: 'vendor-a.test', account: 'two' })
    const accounts = async () => (await r.profiles.list())[0]!.logins.map(login => `${login.plugin}:${login.account}`)
    expect(await accounts()).toEqual(['other:theirs', 'acme:two'])
    await r.profiles.removeLogin('acme', id, 'vendor-a.test')
    expect(await accounts()).toEqual(['other:theirs'])
    // A record it does not have: nothing changes.
    await r.profiles.removeLogin('acme', id, 'vendor-a.test')
    expect(await accounts()).toEqual(['other:theirs'])
    expect(r.deleted).toEqual([])
  })

  it('the last record leaving deletes the profile and its session', async () => {
    const r = rig()
    const id = await signedIn(r.profiles, 'acme', 'vendor-a.test', 'one')
    await r.profiles.removeLogin('acme', id, 'vendor-a.test')
    expect(await r.profiles.list()).toEqual([])
    expect(r.deleted).toEqual(['vellocprofileb'])
  })

  it('a plugin that is gone: its records leave every profile, the profiles left empty are deleted', async () => {
    const r = rig()
    const mine = await signedIn(r.profiles, 'acme', 'vendor-a.test', 'one')
    const shared = await signedIn(r.profiles, 'acme', 'mail.vendor-b.test', 'zed')
    await r.profiles.setLogin('other', shared, { site: 'mail.vendor-b.test', account: 'zed' })
    await r.profiles.forgetPlugin('acme')
    const left = await r.profiles.list()
    expect(left.map(row => row.id)).toEqual([shared])
    expect(left[0]!.logins.map(login => login.plugin)).toEqual(['other'])
    expect(r.deleted).toEqual([webProfilePartition(Number(mine.split('-').at(-1)))])
  })

  it('a profile whose session the host could not delete is kept, and deleted at the next change', async () => {
    const r = rig({ deleteFails: true })
    const id = await signedIn(r.profiles, 'acme', 'vendor-a.test', 'one')
    await r.profiles.removeLogin('acme', id, 'vendor-a.test')
    expect((await r.profiles.list()).map(row => row.id)).toEqual([id])
    r.failing.on = false
    await r.profiles.forgetPlugin('nobody')
    expect(await r.profiles.list()).toEqual([])
  })

  it('a profile a window is open in is not deleted, whatever its records', async () => {
    const r = rig()
    const id = await signedIn(r.profiles, 'acme', 'vendor-a.test', 'one')
    const held = await r.profiles.hold(id)
    expect(held).toMatchObject({ id, partition: 'vellocprofileb' })
    await r.profiles.removeLogin('acme', id, 'vendor-a.test')
    expect((await r.profiles.list()).map(row => row.id)).toEqual([id])
    held.release()
    await settled(r.profiles)
    expect(await r.profiles.list()).toEqual([])
  })

  it('opening a profile stamps when it was last used; an id that names none is refused', async () => {
    const r = rig()
    const id = await signedIn(r.profiles, 'acme', 'vendor-a.test', 'one')
    ;(await r.profiles.hold(id)).release()
    expect((await r.profiles.list())[0]!.lastUsedAt).toBeGreaterThan(NOW)
    await expect(r.profiles.hold('velloc-profile-99')).rejects.toMatchObject({ name: 'NotFoundError' })
    await expect(r.profiles.hold('temporary')).rejects.toMatchObject({ name: 'NotFoundError' })
    await expect(r.profiles.setLogin('acme', 'velloc-profile-99', { site: 'a.test', account: 'x' })).rejects.toMatchObject({
      name: 'NotFoundError',
    })
  })

  it('refuses a record out of bounds, and stores nothing', async () => {
    const r = rig()
    const id = await signedIn(r.profiles, 'acme', 'vendor-a.test', 'one')
    const before = r.saves()
    const bad: unknown[] = [
      { site: 'https://vendor-a.test', account: 'x' },
      { site: 'vendor-a.test/path', account: 'x' },
      { site: 'vendor-a.test', account: '' },
      { site: 'vendor-a.test', account: 'x'.repeat(201) },
      { site: 'vendor-a.test', account: 'x', data: 'note' },
      { site: 'vendor-a.test', account: 'x', data: { big: 'x'.repeat(1024) } },
      'vendor-a.test',
    ]
    for (const login of bad) expect(() => r.profiles.setLogin('acme', id, login)).toThrow(TypeError)
    expect(() => r.profiles.removeLogin('acme', id, 'not a host')).toThrow(TypeError)
    expect(r.saves()).toBe(before)
  })

  it(`a plugin records at most ${WEB_PROFILE_LOGINS_PER_PLUGIN_MAX} sign-ins in a profile`, async () => {
    const r = rig()
    const held = await r.profiles.hold('new')
    for (let i = 0; i < WEB_PROFILE_LOGINS_PER_PLUGIN_MAX; i += 1) {
      await r.profiles.setLogin('acme', held.id, { site: `s${i}.vendor-a.test`, account: 'x' })
    }
    await expect(r.profiles.setLogin('acme', held.id, { site: 'more.vendor-a.test', account: 'x' })).rejects.toMatchObject({
      name: 'QuotaExceededError',
    })
    await expect(r.profiles.setLogin('acme', held.id, { site: 's0.vendor-a.test', account: 'again' })).resolves.toEqual({ ok: true })
    await expect(r.profiles.setLogin('other', held.id, { site: 'more.vendor-a.test', account: 'x' })).resolves.toEqual({ ok: true })
  })

  it(`keeps at most ${WEB_PROFILES_MAX} profiles`, async () => {
    const r = rig()
    for (let i = 0; i < WEB_PROFILES_MAX; i += 1) await r.profiles.hold('new')
    await expect(r.profiles.hold('new')).rejects.toMatchObject({ name: 'QuotaExceededError' })
  })

  it('is there again after a restart', async () => {
    const r = rig()
    const id = await signedIn(r.profiles, 'acme', 'vendor-a.test', 'one')
    expect(await r.reopen().list()).toEqual([
      { id, createdAt: NOW, logins: [{ site: 'vendor-a.test', account: 'one', plugin: 'acme', at: NOW + 1 }], accounts: [] },
    ])
  })

  it('a table it cannot read is left as it is', async () => {
    const r = rig({ file: '{ not json' })
    await expect(r.profiles.list()).rejects.toMatchObject({ name: 'DataError' })
    await expect(r.profiles.hold('new')).rejects.toMatchObject({ name: 'DataError' })
    expect(r.disk.text).toBe('{ not json')
  })

  it('a host that keeps no profiles opens none', async () => {
    const r = rig({ hostKeeps: false })
    await expect(r.profiles.hold('new')).rejects.toMatchObject({ name: 'NotSupportedError' })
    expect(r.saves()).toBe(0)
  })
})

describe('the nouns', () => {
  it('list is the same for every plugin; a record is made for the calling plugin, whatever it says', async () => {
    const r = rig()
    const nouns = createWebProfileNouns(() => r.profiles, () => undefined)
    const call = (plugin: string, ...args: unknown[]) => ({ plugin, args, providers: [] }) as unknown as ProviderNounCall
    const held = await r.profiles.hold('new')
    await nouns.webProfilesSetLogin!(call('acme', held.id, { site: 'vendor-a.test', account: 'one', plugin: 'other' }))
    expect(await nouns.webProfilesList!(call('other'))).toEqual(await nouns.webProfilesList!(call('acme')))
    expect(((await nouns.webProfilesList!(call('other'))) as Array<{ logins: Array<{ plugin: string }> }>)[0]!.logins).toMatchObject([
      { plugin: 'acme', site: 'vendor-a.test' },
    ])
    await nouns.webProfilesRemoveLogin!(call('other', held.id, 'vendor-a.test'))
    expect((await r.profiles.list())[0]!.logins).toHaveLength(1)
    // A malformed call rejects; it does not throw into the runtime.
    await expect(nouns.webProfilesSetLogin!(call('acme', held.id, 'vendor-a.test'))).rejects.toBeInstanceOf(TypeError)
  })
})

describe('an uninstalled plugin', () => {
  function home(text?: string) {
    const files = new Map<string, string>()
    const path = () => [...files.keys()].find(key => key.endsWith(WEB_PROFILES_FILE_NAME))
    const fs = {
      existsSync: (file: string) => files.has(file),
      readFile: async (file: string) => files.get(file)!,
      writeFile: async (file: string, body: string) => void files.set(file, body),
      mkdir: async () => {},
    } as unknown as RuntimeFs
    return { fs, files, path, seed: (file: string) => files.set(file, text ?? '') }
  }

  it('loses what it recorded, in the table on disk; a table never written stays unwritten', async () => {
    setWebProfilesForTests(undefined)
    const none = home()
    await forgetPluginWebProfiles({ homeDir: '/home/zed', fs: none.fs }, 'acme')
    expect(none.files.size).toBe(0)

    const r = rig()
    const kept = await r.profiles.hold('new')
    await r.profiles.setLogin('acme', kept.id, { site: 'vendor-a.test', account: 'one' })
    await r.profiles.setLogin('other', kept.id, { site: 'vendor-a.test', account: 'two' })
    const first = home()
    setWebProfilesForTests(r.profiles)
    await forgetPluginWebProfiles({ homeDir: '/home/zed', fs: first.fs }, 'acme')
    expect((await r.profiles.list())[0]!.logins.map(login => login.plugin)).toEqual(['other'])
    setWebProfilesForTests(undefined)
  })

  it('a table it cannot read does not fail the uninstall', async () => {
    setWebProfilesForTests(undefined)
    const lines: string[] = []
    const h = home()
    const probe = home()
    // Find where the table lives by letting a first, empty run look for it.
    const asked: string[] = []
    ;(probe.fs as unknown as { existsSync: (file: string) => boolean }).existsSync = file => (asked.push(file), false)
    await forgetPluginWebProfiles({ homeDir: '/home/zed', fs: probe.fs }, 'acme')
    h.files.set(asked[0]!, '{ not json')
    await expect(
      forgetPluginWebProfiles({ homeDir: '/home/zed', fs: h.fs, report: line => lines.push(line) }, 'acme'),
    ).resolves.toBeUndefined()
    expect(lines.join('\n')).toContain('acme')
    expect(h.files.get(asked[0]!)).toBe('{ not json')
    setWebProfilesForTests(undefined)
  })
})

const PROVIDER = 'mod.acme.main'
const PAGE = 'https://accounts.vendor-a.test/authorize'
const REDIRECT = 'http://127.0.0.1:53682/callback'

const flush = async () => {
  for (let i = 0; i < 30; i += 1) await Promise.resolve()
}

function signIn(login: (e: Record<string, unknown>, service: ProviderCredentials) => Promise<unknown>, withProfiles = true) {
  const r = rig()
  const requests: SignInWindowRequest[] = []
  let settle: ((capture: SignInCapture) => void) | undefined
  const runtime: CredentialRuntime = {
    hasHook: () => true,
    call: (async (_id: string, event: string, e: Record<string, unknown> = {}) =>
      event === 'provider.login' ? { raised: true, value: await login(e, service) } : { raised: false }) as CredentialRuntime['call'],
  }
  const service: ProviderCredentials = new ProviderCredentials({
    runtime: () => runtime,
    describe: id =>
      id === PROVIDER ? { secrets: ['access_token'], methods: ['login'], loginWindow: ['accounts.vendor-a.test'] } : undefined,
    storedConfigOf: () => ({ source: 'mod', modVersion: '1.0.0' }),
    writeConfig: async () => {},
    report: () => {},
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
    ...(withProfiles ? { holdProfile: profile => r.profiles.hold(profile) } : {}),
  })
  const capture = () => settle!({ url: `${REDIRECT}?code=c1`, finish: () => {}, close: () => {} })
  /** The host says the window is gone. */
  const windowGone = () => requests.at(-1)?.onGone?.()
  return { ...r, service, requests, capture, windowGone }
}

describe('a sign-in window in a web profile', () => {
  const spec = (profile?: string) => ({ url: PAGE, captureRedirect: REDIRECT, ...(profile !== undefined ? { profile } : {}) })

  it('`new` makes a profile, opens in its session and hands the module its id; a recorded login keeps it', async () => {
    let opened: unknown
    const t = signIn(async (e, service) => {
      opened = await service.openWindow(e.loginId, [PROVIDER], spec('new'))
      await t.profiles.setLogin('acme', (opened as { profile: string }).profile, { site: 'vendor-a.test', account: 'one' })
      return { secrets: { access_token: 'AT' }, account: 'one' }
    })
    t.service.startLogin(PROVIDER)
    await flush()
    expect(t.requests[0]).toMatchObject({ partition: 'vellocprofileb' })
    expect(t.requests[0]).not.toHaveProperty('isolated')
    t.capture()
    await flush()
    expect(opened).toEqual({ url: `${REDIRECT}?code=c1`, profile: P1 })
    expect(t.service.state().logins[PROVIDER]?.step.kind).toBe('done')
    await settled(t.profiles)
    expect((await t.profiles.list()).map(row => row.id)).toEqual([P1])
    expect(t.deleted).toEqual([])
  })

  it('a cancelled sign-in leaves no new profile behind, once its window is gone', async () => {
    const t = signIn(async (e, service) => {
      await service.openWindow(e.loginId, [PROVIDER], spec('new'))
      return new Promise(() => {})
    })
    const { loginId } = t.service.startLogin(PROVIDER)
    await flush()
    expect(await t.profiles.list()).toHaveLength(1)
    t.service.cancel(loginId)
    t.windowGone()
    await settled(t.profiles)
    expect(await t.profiles.list()).toEqual([])
    expect(t.deleted).toEqual(['vellocprofileb'])
  })

  it('a failed sign-in keeps its new profile while the window shows the failure, and deletes it once the window is gone', async () => {
    const t = signIn(async (e, service) => {
      await service.openWindow(e.loginId, [PROVIDER], spec('new'))
      throw new Error('the token exchange was refused')
    })
    t.service.startLogin(PROVIDER)
    await flush()
    t.capture()
    await flush()
    expect(t.service.state().logins[PROVIDER]?.step.kind).toBe('failed')
    await settled(t.profiles)
    expect((await t.profiles.list()).map(row => row.id)).toEqual([P1])
    expect(t.deleted).toEqual([])
    t.windowGone()
    await settled(t.profiles)
    expect(await t.profiles.list()).toEqual([])
    expect(t.deleted).toEqual(['vellocprofileb'])
  })

  it('an existing profile is opened again by its id, by any plugin\'s provider', async () => {
    let opened: unknown
    const t = signIn(async (e, service) => {
      opened = await service.openWindow(e.loginId, [PROVIDER], spec(P1))
      return { secrets: { access_token: 'AT' } }
    })
    await signedIn(t.profiles, 'other', 'mail.vendor-b.test', 'zed')
    t.service.startLogin(PROVIDER)
    await flush()
    expect(t.requests[0]).toMatchObject({ partition: 'vellocprofileb' })
    t.capture()
    await flush()
    expect(opened).toMatchObject({ profile: P1 })
  })

  it('the temporary profile is a session that ends with the window; no profile is the person\'s own', async () => {
    const got: unknown[] = []
    const temporary = signIn(async (e, service) => {
      got.push(await service.openWindow(e.loginId, [PROVIDER], spec('temporary')))
      return new Promise(() => {})
    })
    temporary.service.startLogin(PROVIDER)
    await flush()
    expect(temporary.requests[0]).toMatchObject({ isolated: true })
    expect(temporary.requests[0]).not.toHaveProperty('partition')
    temporary.capture()
    await flush()
    expect(got[0]).toEqual({ url: `${REDIRECT}?code=c1` })
    expect(await temporary.profiles.list()).toEqual([])

    const plain = signIn(async (e, service) => {
      await service.openWindow(e.loginId, [PROVIDER], spec())
      return new Promise(() => {})
    })
    plain.service.startLogin(PROVIDER)
    await flush()
    expect(plain.requests[0]).not.toHaveProperty('partition')
    expect(plain.requests[0]).not.toHaveProperty('isolated')
  })

  it('an id that names no profile opens nothing, and the sign-in may then open another', async () => {
    const refusals: string[] = []
    const t = signIn(async (e, service) => {
      await service.openWindow(e.loginId, [PROVIDER], spec('velloc-profile-9')).catch(error => refusals.push(error.name))
      expect(t.requests).toEqual([])
      await service.openWindow(e.loginId, [PROVIDER], spec('new'))
      return new Promise(() => {})
    })
    t.service.startLogin(PROVIDER)
    await flush()
    expect(refusals).toEqual(['NotFoundError'])
    expect(t.requests).toHaveLength(1)
  })

  it('a window the host refuses to open lets its new profile go, without the window saying so', async () => {
    const r = rig()
    const runtime: CredentialRuntime = {
      hasHook: () => true,
      call: (async (_id: string, event: string, e: Record<string, unknown> = {}) =>
        event === 'provider.login'
          ? { raised: true, value: await service.openWindow(e.loginId, [PROVIDER], spec('new')).catch(() => new Promise(() => {})) }
          : { raised: false }) as CredentialRuntime['call'],
    }
    const service: ProviderCredentials = new ProviderCredentials({
      runtime: () => runtime,
      describe: () => ({ secrets: ['access_token'], methods: ['login'], loginWindow: ['accounts.vendor-a.test'] }),
      storedConfigOf: () => ({ source: 'mod', modVersion: '1.0.0' }),
      writeConfig: async () => {},
      report: () => {},
      openWindow: () => Promise.reject(Object.assign(new Error('the host said no'), { name: 'NotSupportedError' })),
      holdProfile: profile => r.profiles.hold(profile),
    })
    service.startLogin(PROVIDER)
    await flush()
    await settled(r.profiles)
    expect(await r.profiles.list()).toEqual([])
    expect(r.deleted).toEqual(['vellocprofileb'])
  })

  it('a Velloc with no web profiles refuses `new`', async () => {
    let refused = ''
    const t = signIn(async (e, service) => {
      await service.openWindow(e.loginId, [PROVIDER], spec('new')).catch(error => (refused = error.name))
      return new Promise(() => {})
    }, false)
    t.service.startLogin(PROVIDER)
    await flush()
    expect(refused).toBe('NotSupportedError')
    expect(t.requests).toEqual([])
  })
})

describe('the shared window and a kept session', () => {
  function fakeHost(primitives: string[]) {
    const requests: BrowserBridgeRequest[] = []
    const transport: BrowserBridgeTransport = {
      async request(request) {
        requests.push(request as BrowserBridgeRequest)
        return { id: request.id, route: request.route, ok: true, result: { windowId: 7, ok: true } } as never
      },
      subscribeEvents: () => () => {},
    }
    const manifest = { capabilities: ['webWindow'], primitives }
    let next = 0
    const { webWindow } = createNativePrimitives({ transport, createRequestId: () => `r${next++}`, manifest })
    const sent = (action: string) => requests.filter(r => r.route.action === action).map(r => r.payload)
    return { webWindow, manifest, sent }
  }
  const request = (over: Partial<SignInWindowRequest>): SignInWindowRequest => ({
    url: PAGE,
    redirectUri: REDIRECT,
    signal: new AbortController().signal,
    ...over,
  })

  it('names the partition to a host that keeps them, and refuses on one that does not', async () => {
    const host = fakeHost(['webWindow.captureRedirect', 'webWindow.storagePartition'])
    void openSignInWindow(host.webWindow, host.manifest, request({ partition: 'vellocprofileb' })).catch(() => {})
    await flush()
    expect(host.sent('open')[0]).toMatchObject({ storagePartition: 'vellocprofileb' })
    expect(host.sent('open')[0]).not.toHaveProperty('isolatedSession')

    const old = fakeHost(['webWindow.captureRedirect'])
    await expect(openSignInWindow(old.webWindow, old.manifest, request({ partition: 'vellocprofileb' }))).rejects.toMatchObject({
      name: 'NotSupportedError',
    })
    expect(old.sent('open')).toEqual([])
  })

  it('deletes a partition by name, only on a host that lists the primitive', async () => {
    const host = fakeHost(['webWindow.storagePartition'])
    await host.webWindow.deleteStoragePartition('vellocprofileb')
    expect(host.sent('deleteStoragePartition')).toEqual([{ name: 'vellocprofileb' }])
    const old = fakeHost([])
    await expect(old.webWindow.deleteStoragePartition('vellocprofileb')).rejects.toThrow()
    expect(old.sent('deleteStoragePartition')).toEqual([])
  })
})

describe('the realm\'s profiles', () => {
  it('are there for a sign-in window before any module has asked for them', async () => {
    const files = new Map<string, string>()
    const fs = {
      existsSync: (file: string) => files.has(file),
      readFile: async (file: string) => files.get(file) ?? '',
      writeFile: async (file: string, text: string) => void files.set(file, text),
      mkdir: async () => {},
      stat: async () => ({ isDirectory: () => true }),
    } as unknown as RuntimeFs
    setWebProfilesForTests(undefined)
    expect(currentWebProfiles()).toBeUndefined()
    keepWebProfilesAt({ homeDir: '/home/zed', fs })
    expect(currentWebProfiles()).toBeInstanceOf(WebProfiles)
    expect(currentWebProfiles()).toBe(currentWebProfiles())
    setWebProfilesForTests(undefined)
  })
})

describe('an uninstalled plugin whose name another installed plugin has', () => {
  it('keeps the records filed under that name', async () => {
    const r = rig()
    const id = await signedIn(r.profiles, 'acme', 'vendor-a.test', 'one')
    setWebProfilesForTests(r.profiles)
    const fs = { existsSync: () => true } as unknown as RuntimeFs
    await forgetPluginWebProfiles({ homeDir: '/home/zed', fs, stillInstalled: async name => name === 'acme' }, 'acme')
    expect((await r.profiles.list()).map(row => row.id)).toEqual([id])
    await forgetPluginWebProfiles({ homeDir: '/home/zed', fs, stillInstalled: async () => false }, 'acme')
    await settled(r.profiles)
    expect(await r.profiles.list()).toEqual([])
    setWebProfilesForTests(undefined)
  })
})
