/**
 * Provider mods, the sign-in window - `interact.openWindow`: the request checks, the
 * sign-in service against a fake window opener, the shared window opener
 * against a fake host, and the manifest field. The real worker's handle is
 * in `provider-mod-login.test.ts`.
 */
import { describe, expect, it } from 'vitest'
import { createNativePrimitives } from '../browser/bridge/nativePrimitives'
import type { BridgeEventEnvelope, BrowserBridgeRequest, BrowserBridgeTransport } from '../browser/bridge/browserBridgeProtocol'
import {
  SignInWindowClosedError,
  hostOpensSignInWindows,
  openSignInWindow,
  type SignInCapture,
  type SignInWindowRequest,
} from '../browser/bridge/signInWindow'
import { captureRedirectProblem, loginWindowProblem } from '../mods/provider/login/loginWindowRequest'
import { ProviderCredentials, type CredentialRuntime } from '../mods/provider/login/providerCredentials'
import { PROVIDER_WIRE_FORMATS } from '../mods/provider/providerManifest'
import { checkPluginDescriptor } from '../pluginHost/manifestValidator'
import type { NexusProviderConfig } from '../settings/settingsTypes'

const ID = 'mod.acme.main'
const OWN = [ID]
const PAGE = 'https://accounts.vendor-a.test/authorize?state=s1'
const REDIRECT = 'http://127.0.0.1:53682/callback'
const CAPTURED = `${REDIRECT}?code=c1&state=s1`

const flush = async () => {
  for (let i = 0; i < 12; i += 1) await Promise.resolve()
}

describe('the request checks', () => {
  const allow = ['accounts.vendor-a.test']
  const ok = { url: PAGE, captureRedirect: REDIRECT }

  it('accepts a page on an allowed host, or a sub-domain of one, with a loopback redirect', () => {
    expect(loginWindowProblem(ok, allow)).toBeNull()
    expect(loginWindowProblem({ ...ok, url: 'https://eu.accounts.vendor-a.test/a', title: 'Sign in', profile: 'temporary' }, allow)).toBeNull()
  })

  it('refuses a page on any other host, and a manifest that allows none', () => {
    expect(loginWindowProblem({ ...ok, url: 'https://vendor-a.test/authorize' }, allow)?.name).toBe('NotAllowedError')
    expect(loginWindowProblem({ ...ok, url: 'https://accounts.vendor-a.test.evil.test/' }, allow)?.name).toBe('NotAllowedError')
    expect(loginWindowProblem(ok, [])?.message).toMatch(/declares no credentials.loginWindow.allow/)
  })

  it('refuses a plain http page except on a loopback host', () => {
    expect(loginWindowProblem({ ...ok, url: 'http://accounts.vendor-a.test/authorize' }, allow)).toBeInstanceOf(TypeError)
    expect(loginWindowProblem({ ...ok, url: 'http://localhost:8080/authorize' }, ['localhost'])).toBeNull()
  })

  it('refuses a url that is not http or https, or carries credentials', () => {
    expect(loginWindowProblem({ ...ok, url: 'file:///c:/x.html' }, allow)).toBeInstanceOf(TypeError)
    expect(loginWindowProblem({ ...ok, url: 'https://u:p@accounts.vendor-a.test/' }, allow)).toBeInstanceOf(TypeError)
    expect(loginWindowProblem({ captureRedirect: REDIRECT }, allow)).toBeInstanceOf(TypeError)
  })

  it.each([
    ['a real site', 'https://accounts.vendor-a.test/callback'],
    ['https on loopback', 'https://127.0.0.1:53682/callback'],
    ['a private address', 'http://192.168.1.4:53682/callback'],
    ['no port', 'http://127.0.0.1/callback'],
    ['nothing', undefined],
  ])('refuses a redirect that is %s', (_what, captureRedirect) => {
    expect(captureRedirectProblem(captureRedirect)).not.toBeNull()
    expect(loginWindowProblem({ ...ok, captureRedirect }, allow)).toBeInstanceOf(TypeError)
  })

  it('accepts each loopback spelling', () => {
    for (const host of ['127.0.0.1', 'localhost', '[::1]']) expect(captureRedirectProblem(`http://${host}:8123/cb`)).toBeNull()
  })

  it('refuses a title or a profile of the wrong type', () => {
    expect(loginWindowProblem({ ...ok, title: 7 }, allow)).toBeInstanceOf(TypeError)
    expect(loginWindowProblem({ ...ok, profile: 7 }, allow)).toBeInstanceOf(TypeError)
  })
})

/** A fake window: `capture` / `close` settle the open the service is waiting on. */
function fakeWindow() {
  const requests: SignInWindowRequest[] = []
  const finished: unknown[] = []
  let closedByService = 0
  let settle: { resolve: (capture: SignInCapture) => void; reject: (error: unknown) => void } | undefined
  const open = (request: SignInWindowRequest): Promise<SignInCapture> => {
    requests.push(request)
    return new Promise<SignInCapture>((resolve, reject) => {
      settle = { resolve, reject }
      request.signal.addEventListener('abort', () => reject(request.signal.reason))
    })
  }
  return {
    open,
    requests,
    finished,
    closedByService: () => closedByService,
    capture: () =>
      settle!.resolve({
        url: CAPTURED,
        finish: outcome => void finished.push(outcome),
        close: () => void (closedByService += 1),
      }),
    personCloses: () => settle!.reject(new SignInWindowClosedError()),
  }
}

type Login = (e: Record<string, unknown>) => Promise<unknown>

function rig(login: Login, options: { allow?: string[]; noWindows?: boolean; noIsolation?: boolean } = {}) {
  const window = fakeWindow()
  const writes: NexusProviderConfig[] = []
  const runtime: CredentialRuntime = {
    hasHook: () => true,
    call: (async (_id: string, event: string, e: Record<string, unknown> = {}) =>
      event === 'provider.login' ? { raised: true, value: await login(e) } : { raised: false }) as CredentialRuntime['call'],
  }
  const service = new ProviderCredentials({
    runtime: () => runtime,
    describe: id =>
      id === ID
        ? { secrets: ['access_token'], methods: ['login'], loginWindow: options.allow ?? ['accounts.vendor-a.test'] }
        : undefined,
    storedConfigOf: () => ({ source: 'mod', modVersion: '1.0.0' }),
    writeConfig: async (_id, config) => void writes.push(config),
    report: () => {},
    ...(options.noWindows
      ? {}
      : {
          openWindow: (request: SignInWindowRequest) =>
            options.noIsolation && request.isolated
              ? Promise.reject(Object.assign(new Error('no isolated sessions'), { name: 'NotSupportedError' }))
              : window.open(request),
        }),
  })
  return { service, window, writes }
}

const stepOf = (service: ProviderCredentials) => service.state().logins[ID]?.step
const pending = () => new Promise<never>(() => {})

describe('interact.openWindow in a sign-in', () => {
  it('gives the module the captured URL and nothing else, and the window the outcome', async () => {
    let got: unknown
    const r = rig(async e => {
      got = await r.service.openWindow(e.loginId, OWN, { url: PAGE, captureRedirect: REDIRECT, title: 'Sign in to A' })
      return { secrets: { access_token: 'AT-1' }, account: 'a@vendor-a.test' }
    })
    r.service.startLogin(ID)
    await flush()
    expect(r.window.requests).toHaveLength(1)
    expect(r.window.requests[0]).toMatchObject({ url: PAGE, redirectUri: REDIRECT, title: 'Sign in to A' })
    expect(r.window.requests[0]).not.toHaveProperty('isolated')
    expect(stepOf(r.service)).toEqual({ kind: 'working' })

    r.window.capture()
    await flush()
    expect(got).toEqual({ url: CAPTURED })
    expect(stepOf(r.service)).toEqual({ kind: 'done', account: 'a@vendor-a.test' })
    expect(r.writes).toHaveLength(1)
    expect(r.window.finished).toEqual([{ ok: true }])
  })

  it('asks for a session of its own only when the module asks for the temporary profile', async () => {
    const r = rig(async e => {
      await r.service.openWindow(e.loginId, OWN, { url: PAGE, captureRedirect: REDIRECT, profile: 'temporary' })
      return pending()
    })
    r.service.startLogin(ID)
    await flush()
    expect(r.window.requests[0]).toMatchObject({ isolated: true })
  })

  it('a sign-in that fails for a reason of its own shows the window no runtime text', async () => {
    const r = rig(async e => {
      await r.service.openWindow(e.loginId, OWN, { url: PAGE, captureRedirect: REDIRECT })
      return { secrets: { undeclared: 'x' } }
    })
    r.service.startLogin(ID)
    await flush()
    r.window.capture()
    await flush()
    expect(stepOf(r.service)).toMatchObject({ kind: 'failed', code: 'invalid_result' })
    expect(r.window.finished).toEqual([{ ok: false, reason: undefined }])
  })

  it('a sign-in that fails after the capture tells the window why', async () => {
    const r = rig(async e => {
      await r.service.openWindow(e.loginId, OWN, { url: PAGE, captureRedirect: REDIRECT })
      throw new Error('the token exchange was refused')
    })
    r.service.startLogin(ID)
    await flush()
    r.window.capture()
    await flush()
    expect(stepOf(r.service)).toMatchObject({ kind: 'failed', reason: 'the token exchange was refused' })
    expect(r.window.finished).toEqual([{ ok: false, reason: 'the token exchange was refused' }])
    expect(r.writes).toEqual([])
  })

  it('the person closing the window cancels the sign-in: the call rejects, nothing is stored, the dialog is gone', async () => {
    let failure: unknown
    const r = rig(async e => {
      await r.service.openWindow(e.loginId, OWN, { url: PAGE, captureRedirect: REDIRECT }).catch(error => {
        failure = error
        throw error
      })
      return { secrets: { access_token: 'never' } }
    })
    r.service.startLogin(ID)
    await flush()
    r.window.personCloses()
    await flush()
    expect((failure as Error).name).toBe('AbortError')
    expect(r.service.state().logins).toEqual({})
    expect(r.writes).toEqual([])
  })

  it('cancelling the sign-in closes a window still waiting, and one already captured', async () => {
    const waiting = rig(async e => {
      await waiting.service.openWindow(e.loginId, OWN, { url: PAGE, captureRedirect: REDIRECT })
      return pending()
    })
    const first = waiting.service.startLogin(ID)
    await flush()
    waiting.service.cancel(first.loginId)
    expect(waiting.window.requests[0]!.signal.aborted).toBe(true)

    const captured = rig(async e => {
      await captured.service.openWindow(e.loginId, OWN, { url: PAGE, captureRedirect: REDIRECT })
      return pending()
    })
    const second = captured.service.startLogin(ID)
    await flush()
    captured.window.capture()
    await flush()
    captured.service.cancel(second.loginId)
    expect(captured.window.closedByService()).toBe(1)
    expect(captured.window.finished).toEqual([])
  })

  it('a sign-in that ends while its window waits closes the window', async () => {
    const r = rig(async e => {
      void r.service.openWindow(e.loginId, OWN, { url: PAGE, captureRedirect: REDIRECT }).catch(() => {})
      throw new Error('gave up')
    })
    r.service.startLogin(ID)
    await flush()
    expect(stepOf(r.service)).toMatchObject({ kind: 'failed' })
    expect(r.window.requests[0]!.signal.aborted).toBe(true)
  })

  it('a window the host refused to open does not use up the sign-in\'s window', async () => {
    const outcomes: unknown[] = []
    let refuse = true
    const r = rig(
      async e => {
        for (let i = 0; i < 2; i += 1) {
        outcomes.push(
          await r.service
            .openWindow(e.loginId, OWN, { url: PAGE, captureRedirect: REDIRECT, ...(refuse ? { profile: 'temporary' } : {}) })
            .catch(error => (error as Error).name),
        )
        refuse = false
      }
      return pending()
      },
      { noIsolation: true },
    )
    r.service.startLogin(ID)
    await flush()
    r.window.capture()
    await flush()
    expect(outcomes).toEqual(['NotSupportedError', { url: CAPTURED }])
  })

  it('opens one window per sign-in', async () => {
    let second: unknown
    const r = rig(async e => {
      void r.service.openWindow(e.loginId, OWN, { url: PAGE, captureRedirect: REDIRECT }).catch(() => {})
      second = await r.service.openWindow(e.loginId, OWN, { url: PAGE, captureRedirect: REDIRECT }).catch(error => error)
      return pending()
    })
    r.service.startLogin(ID)
    await flush()
    expect((second as Error).name).toBe('NotAllowedError')
    expect(r.window.requests).toHaveLength(1)
  })

  it('opens nothing for a refused request, and a refused request does not use up the window', async () => {
    const refusals: unknown[] = []
    const r = rig(async e => {
      const attempt = (spec: unknown) => r.service.openWindow(e.loginId, OWN, spec).catch(error => refusals.push(error))
      await attempt({ url: 'https://elsewhere.test/authorize', captureRedirect: REDIRECT })
      await attempt({ url: PAGE, captureRedirect: 'https://accounts.vendor-a.test/callback' })
      await attempt('https://accounts.vendor-a.test/')
      expect(r.window.requests).toEqual([])
      void r.service.openWindow(e.loginId, OWN, { url: PAGE, captureRedirect: REDIRECT }).catch(() => {})
      return pending()
    })
    r.service.startLogin(ID)
    await flush()
    expect(refusals.map(error => (error as Error).name)).toEqual(['NotAllowedError', 'TypeError', 'TypeError'])
    expect(r.window.requests).toHaveLength(1)
  })

  it('refuses a module that does not own the sign-in, a sign-in that is over, and a host with no windows', async () => {
    let loginId = ''
    const r = rig(async e => {
      loginId = String(e.loginId)
      return pending()
    })
    r.service.startLogin(ID)
    await flush()
    const spec = { url: PAGE, captureRedirect: REDIRECT }
    await expect(r.service.openWindow(loginId, ['mod.other.x'], spec)).rejects.toMatchObject({ name: 'NotAllowedError' })
    await expect(r.service.openWindow('login-none', OWN, spec)).rejects.toMatchObject({ name: 'NotAllowedError' })
    r.service.cancel(loginId)
    await expect(r.service.openWindow(loginId, OWN, spec)).rejects.toMatchObject({ name: 'NotAllowedError' })

    const bare = rig(async e => {
      loginId = String(e.loginId)
      return pending()
    }, { noWindows: true })
    bare.service.startLogin(ID)
    await flush()
    await expect(bare.service.openWindow(loginId, OWN, spec)).rejects.toMatchObject({ name: 'NotSupportedError' })
  })
})

/** A host whose `open` answers window 7; `emit` pushes a window event. */
function fakeHost(primitives: string[]) {
  const requests: BrowserBridgeRequest[] = []
  const listeners = new Set<(event: BridgeEventEnvelope) => void>()
  const transport: BrowserBridgeTransport = {
    async request(request) {
      requests.push(request as BrowserBridgeRequest)
      return { id: request.id, route: request.route, ok: true, result: { windowId: 7, ok: true } } as never
    },
    subscribeEvents: listener => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
  }
  const manifest = { capabilities: ['webWindow'], primitives }
  let next = 0
  const { webWindow } = createNativePrimitives({ transport, createRequestId: () => `r${next++}`, manifest })
  const emit = (action: string, payload: unknown) => {
    for (const listener of listeners) {
      listener({ route: { namespace: 'nexus', capability: 'webWindow', action }, payload } as BridgeEventEnvelope)
    }
  }
  const sent = (action: string) =>
    requests.filter(r => r.route.capability === 'webWindow' && r.route.action === action).map(r => r.payload)
  return { webWindow, manifest, emit, sent }
}

describe('the shared sign-in window', () => {
  const request = (over: Partial<SignInWindowRequest> = {}): SignInWindowRequest => ({
    url: PAGE,
    redirectUri: REDIRECT,
    signal: new AbortController().signal,
    ...over,
  })

  it('opens in the person\'s profile unless a session of its own is asked for', async () => {
    const host = fakeHost(['webWindow.captureRedirect', 'webWindow.isolatedSession'])
    void openSignInWindow(host.webWindow, host.manifest, request()).catch(() => {})
    await flush()
    expect(host.sent('open')[0]).toMatchObject({ url: PAGE, captureRedirect: REDIRECT })
    expect(host.sent('open')[0]).not.toHaveProperty('isolatedSession')

    void openSignInWindow(host.webWindow, host.manifest, request({ isolated: true })).catch(() => {})
    await flush()
    expect(host.sent('open')[1]).toMatchObject({ isolatedSession: true })
  })

  it('a host that cannot isolate refuses an isolated window and opens none', async () => {
    const host = fakeHost(['webWindow.captureRedirect'])
    await expect(openSignInWindow(host.webWindow, host.manifest, request({ isolated: true }))).rejects.toMatchObject({
      name: 'NotSupportedError',
    })
    expect(host.sent('open')).toEqual([])
  })

  it('resolves with the captured URL of its own window only', async () => {
    const host = fakeHost(['webWindow.captureRedirect'])
    const opened = openSignInWindow(host.webWindow, host.manifest, request())
    await flush()
    host.emit('onRedirectCaptured', { windowId: 8, url: 'http://127.0.0.1:1/other' })
    host.emit('onRedirectCaptured', { windowId: 7, url: CAPTURED })
    expect((await opened).url).toBe(CAPTURED)
  })

  it('rejects when the person closes the window, and closes it when the signal aborts', async () => {
    const host = fakeHost(['webWindow.captureRedirect'])
    const closed = openSignInWindow(host.webWindow, host.manifest, request())
    await flush()
    host.emit('onClosed', { windowId: 7, reason: 'user' })
    await expect(closed).rejects.toBeInstanceOf(SignInWindowClosedError)

    const controller = new AbortController()
    const aborted = openSignInWindow(host.webWindow, host.manifest, request({ signal: controller.signal }))
    await flush()
    const why = new Error('over')
    controller.abort(why)
    await expect(aborted).rejects.toBe(why)
    expect(host.sent('close')).toEqual([{ windowId: 7 }])
  })

  it('reads whether a host has sign-in windows from its manifest', () => {
    expect(hostOpensSignInWindows({ capabilities: ['webWindow'], primitives: ['webWindow.captureRedirect'] })).toBe(true)
    expect(hostOpensSignInWindows({ capabilities: ['webWindow'], primitives: [] })).toBe(false)
    expect(hostOpensSignInWindows({ capabilities: [], primitives: ['webWindow.captureRedirect'] })).toBe(false)
    expect(hostOpensSignInWindows(undefined)).toBe(false)
  })
})

describe('credentials.loginWindow in the manifest', () => {
  const check = (credentials: unknown, domains = ['api.vendor-a.test', 'accounts.vendor-a.test']) => {
    const { manifest, errors } = checkPluginDescriptor({
      name: 'acme',
      version: '1.0.0',
      providers: {
        main: {
          providerApi: 1,
          displayName: 'Acme',
          defaultBaseUrl: 'https://api.vendor-a.test/v1',
          domains,
          format: PROVIDER_WIRE_FORMATS[0],
          credentials,
          module: './providers/main.js',
        },
      },
    })
    return { providers: manifest?.providers, errors }
  }
  const secrets = [{ name: 'access_token' }]

  it('keeps the allowed hosts, lower-cased and once each', () => {
    const { providers, errors } = check({
      methods: ['login'],
      secrets,
      loginWindow: { allow: ['Accounts.Vendor-A.test', 'accounts.vendor-a.test'] },
    })
    expect(errors).toEqual([])
    expect(providers?.main?.credentials.loginWindow).toEqual({ allow: ['accounts.vendor-a.test'] })
  })

  it.each([
    ['a host outside the declared domains', { methods: ['login'], secrets, loginWindow: { allow: ['idp.elsewhere.test'] } }, /not among the declared domains/],
    ['a provider with no sign-in', { methods: ['apiKey'], loginWindow: { allow: ['accounts.vendor-a.test'] } }, /include "login"/],
    ['an empty list', { methods: ['login'], secrets, loginWindow: { allow: [] } }, /1 to 8 host names/],
    ['a URL in place of a host', { methods: ['login'], secrets, loginWindow: { allow: ['https://accounts.vendor-a.test'] } }, /not a plain host name/],
    ['an unknown key', { methods: ['login'], secrets, loginWindow: { allow: ['accounts.vendor-a.test'], pageScript: 'x' } }, /pageScript/],
  ])('refuses %s', (_what, credentials, message) => {
    const { providers, errors } = check(credentials)
    expect(errors.join('\n')).toMatch(message)
    expect(providers?.main).toBeUndefined()
  })
})

describe('the sign-in window says when it is gone', () => {
  const request = (onGone: () => void, signal = new AbortController().signal) => ({
    url: 'https://accounts.vendor-a.test/authorize',
    redirectUri: 'http://127.0.0.1:53682/callback',
    signal,
    onGone,
  })

  it('after the capture, only when the window itself closes', async () => {
    const host = fakeHost(['webWindow.captureRedirect', 'webWindow.signInResult'])
    let gone = 0
    const capture = openSignInWindow(host.webWindow, host.manifest, request(() => (gone += 1)))
    await Promise.resolve()
    await Promise.resolve()
    host.emit('onRedirectCaptured', { windowId: 7, url: 'http://127.0.0.1:53682/callback?code=c' })
    ;(await capture).finish({ ok: false, reason: 'no' })
    host.emit('onClosed', { windowId: 8, reason: 'user' })
    expect(gone).toBe(0)
    host.emit('onClosed', { windowId: 7, reason: 'user' })
    host.emit('onClosed', { windowId: 7, reason: 'user' })
    expect(gone).toBe(1)
  })

  it('at once when the host cannot open it in the session asked for', async () => {
    const host = fakeHost(['webWindow.captureRedirect'])
    let gone = 0
    await openSignInWindow(host.webWindow, host.manifest, { ...request(() => (gone += 1)), partition: 'vellocprofileb' }).catch(() => {})
    await openSignInWindow(host.webWindow, host.manifest, { ...request(() => (gone += 1)), isolated: true }).catch(() => {})
    expect(gone).toBe(2)
  })

  it('at once when the window never opened', async () => {
    const host = fakeHost(['webWindow.captureRedirect'])
    const aborted = new AbortController()
    aborted.abort()
    let gone = 0
    await openSignInWindow(host.webWindow, host.manifest, request(() => (gone += 1), aborted.signal)).catch(() => {})
    expect(gone).toBe(1)
  })
})
