/**
 * Provider mods PM-7 - refresh (single-flight, the expiry margin, the 401
 * recovery with its one shared re-send) and sign-out, on `ProviderCredentials`
 * and the request flow, against a fake module runtime. The real worker and the
 * real stream host are `provider-mod-login.test.ts`.
 */
import { describe, expect, it } from 'vitest'
import { createProviderSeam, type ProviderSeamRuntime } from '../mods/provider/providerSeamAdapter'
import {
  EXPIRY_MARGIN_MS,
  ProviderRequestFlow,
  ProviderSignInRequiredError,
  type ProviderRequestSeam,
} from '../models/drivers/providerRequestSeam'
import {
  ProviderCredentials,
  type CredentialDeps,
  type CredentialRuntime,
} from '../mods/provider/login/providerCredentials'
import type { NexusProviderConfig } from '../settings/settingsTypes'
import { createSecretWriter } from '../mods/provider/nouns/providerNounDeps'
import { holdsModSignIn } from '../settings/providerSignIn'

const ID = 'mod.acme.main'

function deferred<T = unknown>() {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

function rig(
  options: {
    refresh?: (reason: string) => Promise<unknown>
    logout?: () => Promise<unknown>
    login?: () => Promise<unknown>
    stored?: NexusProviderConfig
    hasRefreshHook?: boolean
    /** Every settings write waits for this before it lands. */
    holdWrites?: Promise<unknown>
  } = {},
) {
  const configs: Record<string, NexusProviderConfig | undefined> = {
    [ID]: options.stored ?? { source: 'mod', modVersion: '1.0.0', account: 'zed', tokenExpiresAt: Date.now() + 3_600_000 },
  }
  const writes: NexusProviderConfig[] = []
  const calls: string[] = []
  const reasons: string[] = []
  const runtime: CredentialRuntime = {
    hasHook: (_id, event) => (event === 'provider.refresh' && options.hasRefreshHook === false ? false : undefined),
    call: (async (_id: string, event: string, e: Record<string, unknown> = {}) => {
      calls.push(event)
      if (event === 'provider.refresh') {
        if (!options.refresh) return { raised: false }
        reasons.push(String(e.reason))
        return { raised: true, value: await options.refresh(String(e.reason)) }
      }
      if (event === 'provider.logout') {
        if (!options.logout) return { raised: false }
        await options.logout()
        return { raised: true, value: undefined }
      }
      if (event === 'provider.login') {
        return options.login ? { raised: true, value: await options.login() } : new Promise(() => {})
      }
      return { raised: false }
    }) as CredentialRuntime['call'],
  }
  const deps: CredentialDeps = {
    runtime: () => runtime,
    describe: id => (id === ID ? { secrets: ['access_token', 'refresh_token'], methods: ['login'] } : undefined),
    storedConfigOf: id => configs[id],
    writeConfig: async (id, config) => {
      if (options.holdWrites) await options.holdWrites
      writes.push(config)
      const { secrets: _secrets, ...rest } = config
      configs[id] = rest
    },
    report: () => {},
  }
  const service = new ProviderCredentials(deps)
  return { service, configs, writes, calls, reasons }
}

const fresh = (n: number) => ({ secrets: { access_token: `at-${n}`, refresh_token: `rt-${n}` }, expiresAt: Date.now() + 7_200_000 })

describe('refresh is single-flight', () => {
  it('N concurrent refreshes make ONE provider.refresh call and all wait for it', async () => {
    const gate = deferred<unknown>()
    const r = rig({ refresh: () => gate.promise })
    const waiting = Array.from({ length: 6 }, (_, i) => r.service.refresh(ID, i % 2 ? 'expiry' : 'unauthorized'))
    await Promise.resolve()
    expect(r.reasons).toHaveLength(1)
    gate.resolve(fresh(1))
    expect(await Promise.all(waiting)).toEqual(Array(6).fill('refreshed'))
    expect(r.reasons).toHaveLength(1)
    expect(r.writes).toHaveLength(1)
    expect(r.writes[0]).toMatchObject({
      source: 'mod',
      modVersion: '1.0.0',
      account: 'zed',
      secrets: { access_token: 'at-1', refresh_token: 'rt-1' },
    })
    expect(r.service.tokenExpiresAt(ID)).toBe(r.writes[0]!.tokenExpiresAt)
    expect(r.service.epoch(ID)).toBe(1)
  })

  it('a refresh after the first finished is a new call', async () => {
    let n = 0
    const r = rig({ refresh: async () => fresh(++n) })
    await r.service.refresh(ID, 'expiry')
    await r.service.refresh(ID, 'expiry')
    expect(r.reasons).toHaveLength(2)
    expect(r.service.epoch(ID)).toBe(2)
  })

  it('a request sent under an older epoch than the stored token needs no new call', async () => {
    const r = rig({ refresh: async () => fresh(1) })
    const sentUnder = r.service.epoch(ID)
    await r.service.refresh(ID, 'unauthorized', { since: sentUnder })
    expect(r.reasons).toHaveLength(1)
    // A second request, sent before that refresh, gets its 401 after it: nothing to ask.
    expect(await r.service.refresh(ID, 'unauthorized', { since: sentUnder })).toBe('refreshed')
    expect(r.reasons).toHaveLength(1)
    // One sent AFTER it (same epoch as now) is a real 401: refresh.
    await r.service.refresh(ID, 'unauthorized', { since: r.service.epoch(ID) })
    expect(r.reasons).toHaveLength(2)
  })

  it('one waiter giving up does not cancel the shared call', async () => {
    const gate = deferred<unknown>()
    const r = rig({ refresh: () => gate.promise })
    const controller = new AbortController()
    const quitter = r.service.refresh(ID, 'expiry', { signal: controller.signal })
    const stayer = r.service.refresh(ID, 'expiry')
    controller.abort()
    await expect(quitter).rejects.toMatchObject({ name: 'AbortError' })
    gate.resolve(fresh(1))
    expect(await stayer).toBe('refreshed')
    expect(r.writes).toHaveLength(1)
  })

  it('a module with no refresh hook is "unhooked" and nothing is written', async () => {
    const r = rig({ hasRefreshHook: false })
    expect(await r.service.refresh(ID, 'unauthorized')).toBe('unhooked')
    const noAnswer = rig({})
    expect(await noAnswer.service.refresh(ID, 'unauthorized')).toBe('unhooked')
    expect(r.writes).toHaveLength(0)
    expect(noAnswer.writes).toHaveLength(0)
  })

  it('a refresh with no expiry clears the stored one (the token has none that we know of)', async () => {
    const r = rig({ refresh: async () => ({ secrets: { access_token: 'at-2' } }) })
    await r.service.refresh(ID, 'expiry')
    expect(r.writes[0]!.tokenExpiresAt).toBeUndefined()
    expect(r.service.tokenExpiresAt(ID)).toBeUndefined()
  })
})

describe('a refresh that cannot be done ends the sign-in', () => {
  it('{ signedOut: true } clears the stored token, keeps the account, publishes the mark, and rejects', async () => {
    const r = rig({ refresh: async () => ({ signedOut: true }) })
    const states: unknown[] = []
    r.service.subscribe(state => states.push(state))
    await expect(r.service.refresh(ID, 'unauthorized')).rejects.toBeInstanceOf(ProviderSignInRequiredError)
    expect(r.writes).toHaveLength(1)
    expect(r.writes[0]!.secrets).toEqual({ access_token: '', refresh_token: '' })
    expect(r.writes[0]!.account).toBe('zed')
    expect(r.writes[0]!.tokenExpiresAt).toBeUndefined()
    expect(r.service.state().signedOut[ID]).toMatchObject({ reason: expect.any(String) })
    expect(states.length).toBeGreaterThan(0)
  })

  it('a refresh that throws, answers nonsense or runs over also ends it - and the mark clears at the next sign-in', async () => {
    for (const refresh of [
      async () => {
        throw new Error('network down')
      },
      async () => ({ secrets: { sneaky: 'x' } }),
      async () => 'nope',
    ]) {
      const r = rig({ refresh })
      await expect(r.service.refresh(ID, 'expiry')).rejects.toMatchObject({ name: 'ProviderSignInRequiredError' })
      expect(r.service.state().signedOut[ID]).toBeDefined()
      expect(r.writes).toHaveLength(0)
    }
    let ok = false
    const r = rig({ refresh: async () => (ok ? fresh(1) : { signedOut: true }), login: async () => fresh(2) })
    await expect(r.service.refresh(ID, 'expiry')).rejects.toBeInstanceOf(ProviderSignInRequiredError)
    expect(r.service.state().signedOut[ID]).toBeDefined()
    ok = true
    await r.service.refresh(ID, 'expiry')
    expect(r.service.state().signedOut[ID]).toBeUndefined()
  })

  it('a fresh sign-in clears the signed-out mark', async () => {
    const r = rig({ refresh: async () => ({ signedOut: true }), login: async () => ({ secrets: { access_token: 'at' }, account: 'zed' }) })
    await expect(r.service.refresh(ID, 'expiry')).rejects.toBeInstanceOf(ProviderSignInRequiredError)
    r.service.startLogin(ID)
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(r.service.state().signedOut[ID]).toBeUndefined()
  })
})

describe('sign-out', () => {
  it('runs provider.logout, then removes the declared secrets, the account and the expiry', async () => {
    const order: string[] = []
    const r = rig({
      logout: async () => {
        order.push('logout')
      },
    })
    await r.service.signOut(ID)
    expect(r.calls).toContain('provider.logout')
    expect(r.writes).toHaveLength(1)
    expect(r.writes[0]!.secrets).toEqual({ access_token: '', refresh_token: '' })
    expect(r.writes[0]!.account).toBeUndefined()
    expect(r.writes[0]!.tokenExpiresAt).toBeUndefined()
    expect(r.writes[0]).toMatchObject({ source: 'mod', modVersion: '1.0.0' })
    expect(order).toEqual(['logout'])
    expect(r.service.tokenExpiresAt(ID)).toBeUndefined()
  })

  it('clears the credentials anyway when the logout hook fails, or there is none', async () => {
    const failing = rig({
      logout: async () => {
        throw new Error('vendor offline')
      },
    })
    await failing.service.signOut(ID)
    expect(failing.writes).toHaveLength(1)
    const none = rig({})
    await none.service.signOut(ID)
    expect(none.writes).toHaveLength(1)
    expect(none.writes[0]!.account).toBeUndefined()
  })

  it('cancels a sign-in under way, and a refresh that finishes after it is not written back', async () => {
    const gate = deferred<unknown>()
    const r = rig({ refresh: () => gate.promise, logout: async () => {} })
    r.service.startLogin(ID)
    expect(r.service.state().logins[ID]).toBeDefined()
    const refreshing = r.service.refresh(ID, 'expiry')
    await Promise.resolve()
    await r.service.signOut(ID)
    expect(r.service.state().logins[ID]).toBeUndefined()
    gate.resolve(fresh(9))
    // Whatever is stored now is the person's: no token written over the sign-out.
    expect(await refreshing).toBe('refreshed')
    expect(r.writes.filter(w => w.secrets?.access_token === 'at-9')).toHaveLength(0)
  })

  it('a refresh that finishes while a sign-in is being written does not write over it', async () => {
    const refreshGate = deferred<unknown>()
    const writeGate = deferred<void>()
    const r = rig({
      refresh: () => refreshGate.promise,
      login: async () => ({ secrets: { access_token: 'at-login', refresh_token: 'rt-login' }, account: 'new' }),
      holdWrites: writeGate.promise,
    })
    const refreshing = r.service.refresh(ID, 'expiry')
    await Promise.resolve()
    r.service.startLogin(ID)
    // The sign-in's answer is in and its write queued; then the refresh answers.
    await new Promise(resolve => setTimeout(resolve, 0))
    refreshGate.resolve(fresh(9))
    await new Promise(resolve => setTimeout(resolve, 0))
    writeGate.resolve()
    expect(await refreshing).toBe('refreshed')
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(r.writes.map(w => w.secrets?.access_token)).toEqual(['at-login'])
    expect(r.configs[ID]).toMatchObject({ account: 'new' })
  })

  it('$.provider.setSecrets waits for a sign-in being written, and keeps what it wrote', async () => {
    const writeGate = deferred<void>()
    const r = rig({
      stored: { source: 'mod', modVersion: '1.0.0' },
      login: async () => ({ secrets: { access_token: 'at-login', refresh_token: 'rt-login' }, account: 'new', expiresAt: 2e12 }),
      holdWrites: writeGate.promise,
    })
    const writeSecrets = createSecretWriter({
      storedConfigOf: id => r.configs[id],
      sources: () => ({ writeProviderConfig: async (id: string, config: NexusProviderConfig) => {
        await writeGate.promise
        r.writes.push(config)
        const { secrets: _secrets, ...rest } = config
        r.configs[id] = rest
      } }) as never,
    })
    r.service.startLogin(ID)
    await new Promise(resolve => setTimeout(resolve, 0))
    const setting = writeSecrets(ID, { access_token: 'set-by-module' })
    writeGate.resolve()
    await setting
    expect(r.writes.map(w => w.secrets?.access_token)).toEqual(['at-login', 'set-by-module'])
    expect(r.configs[ID]).toMatchObject({ account: 'new', tokenExpiresAt: 2e12 })
  })

  it('a sign-in that names no account still counts as one, until sign-out', async () => {
    const r = rig({
      stored: { source: 'mod', modVersion: '1.0.0', credentialMode: 'anonymous' },
      login: async () => ({ secrets: { access_token: 'at-1', refresh_token: 'rt-1' } }),
      logout: async () => {},
    })
    r.service.startLogin(ID)
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(r.configs[ID]).toMatchObject({ signedIn: true })
    expect(r.configs[ID]!.account).toBeUndefined()
    expect(holdsModSignIn(r.configs[ID])).toBe(true)
    await r.service.signOut(ID)
    expect(r.configs[ID]!.signedIn).toBeUndefined()
    expect(holdsModSignIn(r.configs[ID])).toBe(false)
    // One that names an account carries no mark.
    const named = rig({ login: async () => ({ secrets: { access_token: 'a' }, account: 'zed' }) })
    named.service.startLogin(ID)
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(named.configs[ID]!.signedIn).toBeUndefined()
  })

  it('refuses a provider that is not registered', async () => {
    await expect(rig().service.signOut('mod.nobody.x')).rejects.toMatchObject({ code: 'not_found' })
  })
})

// ── the request flow ──

const request = { url: 'https://api.acme.example/v1/chat', method: 'POST', headers: { authorization: 'Bearer {{secret:access_token}}' }, body: new TextEncoder().encode('{}') }
const facts = { provider: ID, model: 'm', format: 'x', baseUrl: 'https://api.acme.example' }

function flowFor(service: ProviderCredentials, seam: Partial<ProviderRequestSeam> = {}, signal = new AbortController().signal) {
  const full: ProviderRequestSeam = { credentials: service.seamCredentials(ID), ...seam }
  return new ProviderRequestFlow(full, facts, signal)
}

describe('the expiry margin', () => {
  it('refreshes first when the token expires within 60 s, not when it has more', async () => {
    const near = rig({
      stored: { source: 'mod', account: 'zed', tokenExpiresAt: Date.now() + EXPIRY_MARGIN_MS - 5_000 },
      refresh: async () => fresh(1),
    })
    await flowFor(near.service).prepare(request)
    expect(near.reasons).toEqual(['expiry'])

    const far = rig({
      stored: { source: 'mod', account: 'zed', tokenExpiresAt: Date.now() + EXPIRY_MARGIN_MS + 120_000 },
      refresh: async () => fresh(1),
    })
    await flowFor(far.service).prepare(request)
    expect(far.reasons).toEqual([])

    const unknown = rig({ stored: { source: 'mod', account: 'zed' }, refresh: async () => fresh(1) })
    await flowFor(unknown.service).prepare(request)
    expect(unknown.reasons).toEqual([])
  })

  it('an expired token is refreshed before the send; a refresh that fails stops the request with the sign-in sentence', async () => {
    const r = rig({ stored: { source: 'mod', account: 'zed', tokenExpiresAt: Date.now() - 10_000 }, refresh: async () => ({ signedOut: true }) })
    await expect(flowFor(r.service).prepare(request)).rejects.toThrow(/Sign in again/)
  })

  it('N requests preparing together make one refresh', async () => {
    const gate = deferred<unknown>()
    const r = rig({ stored: { source: 'mod', account: 'zed', tokenExpiresAt: Date.now() - 1 }, refresh: () => gate.promise })
    const prepared = Array.from({ length: 5 }, () => flowFor(r.service).prepare(request))
    await Promise.resolve()
    gate.resolve(fresh(1))
    await Promise.all(prepared)
    expect(r.reasons).toEqual(['expiry'])
  })

  it('no credentials on the seam: nothing is asked of anyone', async () => {
    const r = rig({ stored: { source: 'mod', account: 'zed', tokenExpiresAt: 1 }, refresh: async () => fresh(1) })
    const flow = new ProviderRequestFlow({}, facts, new AbortController().signal)
    await flow.prepare(request)
    expect(r.reasons).toEqual([])
  })
})

describe('a 401 refreshes once, then the request is sent once more', () => {
  const unauthorized = { status: 401, headers: {}, bodyText: 'expired' }

  it('refreshes (reason unauthorized), then re-sends once, signed again with a new attempt', async () => {
    const r = rig({ refresh: async () => fresh(1) })
    const signs: number[] = []
    const flow = flowFor(r.service, { sign: e => (signs.push(e.context.attempt), { headers: { 'x-attempt': String(e.context.attempt) } }) })
    const first = await flow.prepare(request)
    const again = await flow.recoverAfter(unauthorized, first)
    expect(r.reasons).toEqual(['unauthorized'])
    expect(again).toBeDefined()
    expect(again!.context.attempt).toBe(2)
    expect(again!.context.requestId).not.toBe(first.context.requestId)
    expect(again!.request.headers['x-attempt']).toBe('2')
    // The secret is still the TEMPLATE: the host substitutes the new value per send.
    expect(again!.request.headers.authorization).toBe('Bearer {{secret:access_token}}')
    expect(signs).toEqual([1, 2])
  })

  it('a second 401 gets no second re-send - the response\'s error stands', async () => {
    const r = rig({ refresh: async () => fresh(1) })
    const flow = flowFor(r.service)
    const first = await flow.prepare(request)
    const again = await flow.recoverAfter(unauthorized, first)
    expect(await flow.recoverAfter(unauthorized, again!)).toBeUndefined()
    expect(r.reasons).toEqual(['unauthorized'])
  })

  it('the re-send is ONE budget shared with provider.retry', async () => {
    // retry spent first -> a later 401 does not refresh.
    const a = rig({ refresh: async () => fresh(1) })
    const retried: number[] = []
    const flowA = flowFor(a.service, { retry: () => (retried.push(1), { retry: { headers: { 'x-retry': '1' } } }) })
    const firstA = await flowA.prepare(request)
    const resendA = await flowA.recoverAfter({ status: 400, headers: {}, bodyText: 'x' }, firstA)
    expect(resendA!.request.headers['x-retry']).toBe('1')
    expect(await flowA.recoverAfter(unauthorized, resendA!)).toBeUndefined()
    expect(a.reasons).toEqual([])

    // refresh spent first -> a later error does not run the retry hook.
    const b = rig({ refresh: async () => fresh(1) })
    const asked: number[] = []
    const flowB = flowFor(b.service, { retry: () => (asked.push(1), { retry: { headers: { 'x-retry': '1' } } }) })
    const firstB = await flowB.prepare(request)
    const resendB = await flowB.recoverAfter(unauthorized, firstB)
    expect(resendB).toBeDefined()
    expect(await flowB.recoverAfter({ status: 400, headers: {}, bodyText: 'x' }, resendB!)).toBeUndefined()
    expect(asked).toEqual([])
  })

  it('only a 401 refreshes: other statuses go to the retry hook alone', async () => {
    const r = rig({ refresh: async () => fresh(1) })
    const flow = flowFor(r.service)
    const first = await flow.prepare(request)
    for (const status of [400, 403, 429, 500]) {
      expect(await flowFor(r.service).recoverAfter({ status, headers: {}, bodyText: '' }, first)).toBeUndefined()
    }
    expect(r.reasons).toEqual([])
  })

  it('a module with no refresh hook leaves a 401 to the retry hook as before', async () => {
    const r = rig({ hasRefreshHook: false })
    const noCredentials = flowFor(r.service, { credentials: undefined, retry: () => ({ retry: { headers: { 'x-retry': 'yes' } } }) })
    const first = await noCredentials.prepare(request)
    const again = await noCredentials.recoverAfter(unauthorized, first)
    expect(again!.request.headers['x-retry']).toBe('yes')
  })

  it('a refresh that answers "unhooked" falls through to the retry hook with the budget unspent', async () => {
    const r = rig({})
    const flow = flowFor(r.service, { retry: () => ({ retry: { headers: { 'x-retry': 'yes' } } }) })
    const first = await flow.prepare(request)
    const again = await flow.recoverAfter(unauthorized, first)
    expect(again!.request.headers['x-retry']).toBe('yes')
  })

  it('a refresh that cannot be done rejects with the sign-in error and sends nothing more', async () => {
    const r = rig({ refresh: async () => ({ signedOut: true }) })
    const flow = flowFor(r.service)
    const first = await flow.prepare(request)
    await expect(flow.recoverAfter(unauthorized, first)).rejects.toBeInstanceOf(ProviderSignInRequiredError)
    expect(r.service.state().signedOut[ID]).toBeDefined()
  })

  it('two requests that both got a 401 share one refresh - whether the second 401 comes during it or after it', async () => {
    const gate = deferred<unknown>()
    const r = rig({ refresh: () => gate.promise })
    const a = flowFor(r.service)
    const b = flowFor(r.service)
    const firstA = await a.prepare(request)
    const firstB = await b.prepare(request)
    const during = Promise.all([a.recoverAfter(unauthorized, firstA), b.recoverAfter(unauthorized, firstB)])
    await Promise.resolve()
    gate.resolve(fresh(1))
    const [againA, againB] = await during
    expect(againA).toBeDefined()
    expect(againB).toBeDefined()
    expect(r.reasons).toEqual(['unauthorized'])

    // c was sent before that refresh and hears its 401 after it.
    const c = flowFor(r.service)
    const sentBefore = r.service.seamCredentials(ID)
    const stale = new ProviderRequestFlow({ credentials: { ...sentBefore, epoch: () => 0 } }, facts, new AbortController().signal)
    const firstC = await stale.prepare(request)
    const againC = await stale.recoverAfter(unauthorized, firstC)
    expect(againC).toBeDefined()
    expect(r.reasons).toEqual(['unauthorized'])
    void c
  })
})

describe('the adapter credentials', () => {
  const runtimeWith = (known: boolean | undefined): ProviderSeamRuntime => ({
    call: async () => ({ raised: false }),
    hasHook: (_id, event) => (event === 'provider.refresh' ? known : undefined),
    whenLoaded: async () => {},
  })
  const credentials = rig().service.seamCredentials(ID)

  it('are on the seam unless the loaded module is known not to refresh', () => {
    expect(createProviderSeam(runtimeWith(undefined), ID, {}, credentials).credentials).toBe(credentials)
    expect(createProviderSeam(runtimeWith(true), ID, {}, credentials).credentials).toBe(credentials)
    expect(createProviderSeam(runtimeWith(false), ID, {}, credentials).credentials).toBeUndefined()
  })

  it('a provider that does not sign in has none, and the seam is as it was', () => {
    const seam = createProviderSeam(runtimeWith(undefined), ID, {})
    expect(seam.credentials).toBeUndefined()
  })
})
