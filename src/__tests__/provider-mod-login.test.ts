/**
 * Provider mods PM-7 - the whole path: a real provider module in a real mod
 * worker host (MessageChannel), the real `ProviderModRuntime`, the real
 * `ProviderCredentials` with the real `$.provider.interact*` nouns, and the
 * real `DriverStreamHost` against a fake endpoint that applies the secrets the
 * way the host does (`{{secret:NAME}}` substituted per send from what the
 * settings write path stored).
 */
import { afterEach, describe, expect, it } from 'vitest'
import type { BrowserBridgeTransport } from '../browser/bridge/browserBridgeProtocol'
import { registerProviderDriver } from '../models/drivers/driverRegistry'
import { DriverStreamHost } from '../models/drivers/driverStreamHost'
import { createModelProvider } from '../models/drivers/modelProvider'
import type { DriverStreamEvent, ProviderDriver } from '../models/drivers/driverTypes'
import { registerProviderRequestSeam, resetProviderRequestSeams } from '../models/drivers/providerRequestSeam'
import type { ModWorkerHandle } from '../mods/ModRuntime'
import { installModWorkerHost } from '../mods/ModWorkerHost'
import { ProviderModRuntime, type ProviderModuleRef } from '../mods/provider/ProviderModRuntime'
import { createLoginNouns } from '../mods/provider/login/providerLoginNouns'
import { ProviderCredentials } from '../mods/provider/login/providerCredentials'
import type { ProviderLoginState } from '../mods/provider/login/loginProtocol'
import { createProviderSeam } from '../mods/provider/providerSeamAdapter'
import type { NexusProviderConfig } from '../settings/settingsTypes'

const ID = 'mod.acme.sso'
const BASE = 'https://api.sso.example'

const codec: ProviderDriver = {
  id: 'sso-json',
  auth: { headers: { authorization: 'Bearer {{secret:access_token}}' } },
  buildRequest: (_payload, context) => ({
    url: `${context.baseUrl}/v1/chat`,
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: 'Bearer {{secret:access_token}}' },
    body: new TextEncoder().encode(JSON.stringify({ model: context.model })),
  }),
  createDecoder: () => {
    const decoder = new TextDecoder()
    let buffered = ''
    const drain = (): DriverStreamEvent[] => {
      const lines = buffered.split('\n')
      buffered = lines.pop() ?? ''
      return lines.filter(Boolean).map(line => JSON.parse(line) as DriverStreamEvent)
    }
    return {
      push: bytes => {
        buffered += decoder.decode(bytes, { stream: true })
        return drain()
      },
      end: () => {
        buffered += '\n'
        return drain()
      },
    }
  },
  errorFromResponse: ({ status, bodyText }) => ({ type: 'error', message: `API Error: ${status} ${bodyText}`, httpStatus: status }),
}
registerProviderDriver(codec)

const lines = (events: DriverStreamEvent[]) => new TextEncoder().encode(events.map(e => JSON.stringify(e)).join('\n') + '\n')
const OK_BODY = lines([{ type: 'text_delta', text: 'hi' }, { type: 'finish', finishReason: 'stop' }])
const FAR = 4_102_444_800_000

// ── the store the secrets live in, and the endpoint that reads them ──

function world(initial: { secrets?: Record<string, string>; config?: NexusProviderConfig } = {}) {
  const secrets: Record<string, string> = { ...initial.secrets }
  let config: NexusProviderConfig = initial.config ?? { source: 'mod', modVersion: '1.0.0' }
  const writes: NexusProviderConfig[] = []
  return {
    secrets,
    writes,
    config: () => config,
    storedConfigOf: (): NexusProviderConfig => config,
    writeConfig: async (_id: string, next: NexusProviderConfig) => {
      writes.push(next)
      for (const [name, value] of Object.entries(next.secrets ?? {})) {
        if (value === '') delete secrets[name]
        else secrets[name] = value
      }
      const { secrets: _s, ...rest } = next
      config = rest
    },
  }
}

/** The fake endpoint: `accepts` decides whether a bearer token works; every open is recorded WITH the secret applied. */
function endpoint(store: ReturnType<typeof world>, accepts: (token: string) => boolean) {
  const opens: Array<{ headers: Record<string, string>; token: string }> = []
  const bodies = new Map<string, Uint8Array>()
  const transport: BrowserBridgeTransport = {
    async request(req: any) {
      const action = req.route.action
      if (action === 'rawStreamOpen') {
        const headers: Record<string, string> = {}
        for (const [name, value] of Object.entries(req.payload.headers as Record<string, string>)) {
          headers[name] = value.replace(/\{\{secret:([A-Za-z0-9_.-]+)\}\}/g, (_m, key: string) => store.secrets[key] ?? '')
        }
        const token = (headers.authorization ?? '').replace(/^Bearer /, '')
        opens.push({ headers, token })
        const ok = accepts(token)
        const streamId = `raw-${opens.length}`
        bodies.set(streamId, ok ? OK_BODY : new TextEncoder().encode('token expired'))
        return {
          ok: true,
          result: { streamId, status: ok ? 200 : 401, statusText: 'S', finalUrl: req.payload.url, headers: {} },
        } as any
      }
      if (action === 'rawStreamCancel') return { ok: true, result: { ok: true } } as any
      const body = bodies.get(req.payload.streamId) ?? new Uint8Array()
      bodies.set(req.payload.streamId, new Uint8Array())
      return { ok: true, result: { done: true, chunk: body } } as any
    },
  }
  return { transport, opens }
}

// ── the runtime over a real worker host ──

let uniqueLoad = 0
const openPorts: MessagePort[] = []
const runtimes: ProviderModRuntime[] = []
afterEach(() => {
  resetProviderRequestSeams()
  for (const runtime of runtimes.splice(0)) runtime.dispose()
  for (const port of openPorts.splice(0)) port.close()
})

function setup(
  source: string,
  options: {
    world?: ReturnType<typeof world>
    wallMs?: number
    idleMs?: number
    idleCheckMs?: number
  } = {},
) {
  const store = options.world ?? world()
  const log: string[] = []
  let opened = 0
  let credentials!: ProviderCredentials
  const ref: ProviderModuleRef = { plugin: 'acme', path: 'acme/providers/sso.js', providers: [ID] }
  const runtime = new ProviderModRuntime({
    readModule: async () => `${source}\n// load ${++uniqueLoad}`,
    openWorker: async () => {
      opened += 1
      const channel = new MessageChannel()
      openPorts.push(channel.port1, channel.port2)
      installModWorkerHost(channel.port2)
      let settle!: (closed: { reason: 'closed' | 'crashed'; message?: string }) => void
      const closed = new Promise<{ reason: 'closed' | 'crashed'; message?: string }>(resolve => {
        settle = resolve
      })
      const worker: ModWorkerHandle = { port: channel.port1, closed, close: () => settle({ reason: 'closed' }) }
      return worker
    },
    window: { available: () => true, attached: async () => {} },
    report: line => log.push(line),
    respawnBackoffMs: [10],
    providerNouns: createLoginNouns({
      interact: (id, owned, spec) => credentials.interact(id, owned, spec),
      moduleFailed: (id, owned, message) => credentials.moduleFailed(id, owned, message),
    }),
    ...(options.idleMs !== undefined ? { idleMs: options.idleMs } : {}),
    ...(options.idleCheckMs !== undefined ? { idleCheckMs: options.idleCheckMs } : {}),
  })
  runtimes.push(runtime)
  runtime.register('acme', [ref])
  credentials = new ProviderCredentials({
    runtime: () => runtime,
    describe: id => (id === ID ? { secrets: ['access_token', 'refresh_token'], methods: ['login'] } : undefined),
    storedConfigOf: () => store.storedConfigOf(),
    writeConfig: store.writeConfig,
    report: line => log.push(line),
    ...(options.wallMs !== undefined ? { wallMs: options.wallMs } : {}),
  })
  const states: ProviderLoginState[] = []
  credentials.subscribe(state => states.push(state))
  registerProviderRequestSeam(ID, createProviderSeam(runtime, ID, {}, credentials.seamCredentials(ID)))
  return { runtime, credentials, store, log, states, opened: () => opened }
}

async function until(check: () => boolean, what: string, ms = 3000): Promise<void> {
  const deadline = Date.now() + ms
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`)
    await new Promise(resolve => setTimeout(resolve, 5))
  }
}

const stepOf = (c: ProviderCredentials) => c.state().logins[ID]?.step
const kinds = (states: ProviderLoginState[]) => {
  const out: string[] = []
  for (const state of states) {
    const kind = state.logins[ID]?.step.kind
    if (kind && out.at(-1) !== kind) out.push(kind)
  }
  return out
}

async function drain(host: DriverStreamHost, streamId: string) {
  const all: any[] = []
  for (let i = 0; i < 50; i += 1) {
    const read = await host.read(streamId, 5000)
    all.push(...read.chunks)
    if (read.done) return all
  }
  throw new Error('stream never finished')
}

async function stream(transport: BrowserBridgeTransport) {
  const host = new DriverStreamHost(transport)
  const provider = createModelProvider({ id: ID, format: 'sso-json', baseUrl: BASE })
  const { streamId } = host.start(
    provider,
    { messages: [{ role: 'user', content: 'x' }], systemPrompt: 's', maxOutputTokens: 100 } as never,
    'm-1',
  )
  return drain(host, streamId)
}
const errorOf = (chunks: any[]): string | undefined => chunks.find(c => c.type === 'error')?.error?.message

const LOGIN = `
  export function register(on) {
    on('provider.login', async ($, e) => {
      await e.interact.progress({ en: 'Contacting the vendor', de: 'Kontaktiere den Anbieter' })
      await e.interact.openUrl('https://auth.acme.example/start')
      const workspace = await e.interact.choose({
        label: 'Which workspace?',
        options: [{ label: 'Personal', value: 'ws-p' }, { label: 'Team', value: 'ws-t' }],
      })
      const pasted = await e.interact.prompt({ label: 'Paste the code', secret: true })
      await e.interact.showCode({ code: 'AB-12', url: 'https://auth.acme.example/device' })
      return {
        secrets: { access_token: 'AT-' + pasted, refresh_token: 'RT-' + workspace },
        account: 'zed@acme.example',
        expiresAt: ${FAR},
      }
    })
  }
`

describe('provider.login with the interact handle', () => {
  it('drives every step as published state; the secret answer never appears in it; the result is written', async () => {
    const t = setup(LOGIN)
    const started = t.credentials.startLogin(ID)
    expect(started.joined).toBe(false)

    await until(() => stepOf(t.credentials)?.kind === 'openUrl', 'the openUrl step')
    expect(stepOf(t.credentials)).toEqual({ kind: 'openUrl', url: 'https://auth.acme.example/start' })
    t.credentials.answer({ loginId: started.loginId, stepId: t.credentials.state().logins[ID]!.stepId, value: { kind: 'ack' } })

    await until(() => stepOf(t.credentials)?.kind === 'choose', 'the choose step')
    t.credentials.answer({ loginId: started.loginId, stepId: t.credentials.state().logins[ID]!.stepId, value: { kind: 'choice', index: 1 } })

    await until(() => stepOf(t.credentials)?.kind === 'prompt', 'the prompt step')
    expect(stepOf(t.credentials)).toEqual({ kind: 'prompt', label: 'Paste the code', secret: true })
    t.credentials.answer({ loginId: started.loginId, stepId: t.credentials.state().logins[ID]!.stepId, value: { kind: 'text', text: 'PASTED-9X' } })

    await until(() => stepOf(t.credentials)?.kind === 'done', 'done')
    expect(stepOf(t.credentials)).toEqual({ kind: 'done', account: 'zed@acme.example' })

    // The steps the page was shown, in order. (`working` sits between an answer and the next ask.)
    const shown = kinds(t.states)
    expect(shown).toEqual(expect.arrayContaining(['working', 'progress', 'openUrl', 'choose', 'prompt', 'code', 'done']))
    expect(shown.indexOf('openUrl')).toBeLessThan(shown.indexOf('choose'))
    expect(shown.indexOf('choose')).toBeLessThan(shown.indexOf('prompt'))
    expect(shown.indexOf('prompt')).toBeLessThan(shown.indexOf('code'))
    // The vendor's localized progress text crossed as given.
    expect(t.states.some(s => JSON.stringify(s.logins[ID]?.step).includes('Kontaktiere den Anbieter'))).toBe(true)

    // Nothing published - not one state, not the module's token - carries the answer or the credentials.
    const everything = JSON.stringify(t.states)
    for (const secret of ['PASTED-9X', 'AT-PASTED-9X', 'RT-ws-t', 'ws-t']) expect(everything).not.toContain(secret)

    // The result: sealed named secrets, the account, the expiry.
    expect(t.store.secrets).toEqual({ access_token: 'AT-PASTED-9X', refresh_token: 'RT-ws-t' })
    expect(t.store.config()).toMatchObject({ source: 'mod', modVersion: '1.0.0', account: 'zed@acme.example', tokenExpiresAt: FAR })
  })

  it('a module that throws shows its own words; the dialog is a failed step', async () => {
    const t = setup(`
      export function register(on) {
        on('provider.login', async () => { throw new Error('Your plan does not include this model') })
      }`)
    t.credentials.startLogin(ID)
    await until(() => stepOf(t.credentials)?.kind === 'failed', 'failure')
    expect(stepOf(t.credentials)).toEqual({ kind: 'failed', code: 'module', reason: 'Your plan does not include this model' })
    expect(t.store.writes).toHaveLength(0)
  })

  it('openUrl of another scheme is refused to the module, and the page never sees the link', async () => {
    const t = setup(`
      export function register(on) {
        on('provider.login', async ($, e) => {
          try { await e.interact.openUrl('javascript:alert(1)') } catch (error) { $.log.info('refused: ' + error.message) }
          try { await e.interact.openUrl('file:///etc/passwd') } catch (error) { $.log.info('refused: ' + error.message) }
          return { secrets: { access_token: 'AT-1' } }
        })
      }`)
    t.credentials.startLogin(ID)
    await until(() => stepOf(t.credentials)?.kind === 'done', 'done')
    expect(t.log.filter(line => line.includes('refused:') && line.includes('only http and https'))).toHaveLength(2)
    expect(kinds(t.states)).not.toContain('openUrl')
    expect(JSON.stringify(t.states)).not.toMatch(/javascript:|file:/)
  })

  it('cancel rejects the module\'s pending prompt and drops the session', async () => {
    const t = setup(`
      export function register(on) {
        on('provider.login', async ($, e) => {
          try { await e.interact.prompt({ label: 'Code' }) } catch (error) { $.log.info('prompt ended: ' + error.name) ; throw error }
        })
      }`)
    const { loginId } = t.credentials.startLogin(ID)
    await until(() => stepOf(t.credentials)?.kind === 'prompt', 'the prompt')
    t.credentials.cancel(loginId)
    expect(t.credentials.state().logins[ID]).toBeUndefined()
    await until(() => t.log.some(line => line.includes('prompt ended: AbortError')), 'the module hearing the cancel')
  })

  it('the wall clock ends the sign-in while the person is still being asked', async () => {
    const t = setup(
      `export function register(on) {
        on('provider.login', async ($, e) => {
          try { await e.interact.prompt({ label: 'Code' }) } catch (error) { $.log.info('prompt ended: ' + error.name); throw error }
        })
      }`,
      { wallMs: 80 },
    )
    t.credentials.startLogin(ID)
    await until(() => stepOf(t.credentials)?.kind === 'failed', 'the timeout')
    expect(stepOf(t.credentials)).toMatchObject({ kind: 'failed', code: 'timeout' })
    await until(() => t.log.some(line => line.includes('prompt ended')), 'the module hearing it')
  })

  it('a loop that polls on after the sign-in was cancelled is stopped: its next $ call is refused', async () => {
    const t = setup(`
      export function register(on) {
        on('provider.login', async ($, e) => {
          await e.interact.showCode({ code: 'AB-12', url: 'https://auth.acme.example/device' })
          try {
            for (;;) {
              await new Promise(resolve => $.clock.after(15, resolve))
              await $.store.set('tick', Date.now())
              $.log.info('tick')
            }
          } catch (error) {
            $.log.info('poll stopped: ' + error.name)
            throw error
          }
        })
      }`)
    const { loginId } = t.credentials.startLogin(ID)
    await until(() => t.log.filter(line => line.endsWith('tick')).length >= 2, 'the polling')
    t.credentials.cancel(loginId)
    await until(() => t.log.some(line => line.includes('poll stopped: AbortError')), 'the loop being stopped')
    const ticks = t.log.filter(line => line.endsWith('tick')).length
    await new Promise(resolve => setTimeout(resolve, 150))
    expect(t.log.filter(line => line.endsWith('tick')).length, 'no further tick after the stop').toBe(ticks)
  })

  it('a module cannot drive the dialog of another provider\'s sign-in', async () => {
    const t = setup(`
      export function register(on) {
        on('provider.login', async ($, e) => {
          try { await $.provider.interactPrompt('login-forged', { label: 'x' }) } catch (error) { $.log.info('forged: ' + error.name) }
          return { secrets: {} , account: 'zed' }
        })
      }`)
    t.credentials.startLogin(ID)
    await until(() => stepOf(t.credentials)?.kind === 'done', 'done')
    expect(t.log.some(line => line.includes('forged: NotAllowedError'))).toBe(true)
  })

  it('a sign-in outlives the module\'s idle exit: the stored credentials need no worker', async () => {
    const t = setup(
      `export function register(on) {
        on('provider.login', async () => ({ secrets: { access_token: 'AT-1', refresh_token: 'RT-1' }, account: 'zed', expiresAt: ${FAR} }))
        on('provider.refresh', async () => ({ secrets: { access_token: 'AT-2', refresh_token: 'RT-2' }, expiresAt: ${FAR} }))
      }`,
      { idleMs: 30, idleCheckMs: 10 },
    )
    t.credentials.startLogin(ID)
    await until(() => stepOf(t.credentials)?.kind === 'done', 'done')
    await until(() => t.runtime.status()[0]!.exits >= 1, 'the idle exit')
    expect(t.runtime.status()[0]!.crashes).toBe(0)
    // Nothing of the sign-in was lost with the worker.
    expect(t.store.secrets.access_token).toBe('AT-1')
    expect(t.credentials.tokenExpiresAt(ID)).toBe(FAR)
    // And the module is brought back on demand for a refresh.
    expect(await t.credentials.refresh(ID, 'expiry')).toBe('refreshed')
    expect(t.store.secrets.access_token).toBe('AT-2')
    expect(t.opened()).toBeGreaterThanOrEqual(2)
  })
})

const REFRESHING = `
  let count = 0
  export function register(on) {
    on('provider.refresh', async ($, e) => {
      count += 1
      $.log.info('refresh ' + e.reason + ' #' + count)
      await new Promise(resolve => $.clock.after(20, resolve))
      if (e.reason === 'unauthorized' && globalThis.__never) return { signedOut: true }
      return { secrets: { access_token: 'AT-' + (count + 1), refresh_token: 'RT-' + (count + 1) }, expiresAt: ${FAR} }
    })
    on('provider.logout', async ($) => { $.log.info('logout hook') })
  }
`
const refreshCalls = (log: string[]) => log.filter(line => /\brefresh (expiry|unauthorized) #/.test(line))

describe('the request path: refresh, 401, one re-send', () => {
  it('a 401 refreshes once and the request is re-sent with the NEW secret', async () => {
    const store = world({ secrets: { access_token: 'AT-1', refresh_token: 'RT-1' }, config: { source: 'mod', account: 'zed', tokenExpiresAt: FAR } })
    const t = setup(REFRESHING, { world: store })
    const { transport, opens } = endpoint(store, token => token === 'AT-2')

    const chunks = await stream(transport)

    expect(errorOf(chunks)).toBeUndefined()
    expect(chunks.map(c => c.type)).toContain('message_stop')
    expect(opens.map(o => o.token)).toEqual(['AT-1', 'AT-2'])
    expect(refreshCalls(t.log)).toEqual([expect.stringContaining('refresh unauthorized #1')])
    expect(store.config().tokenExpiresAt).toBe(FAR)
  })

  it('a second 401 is the response\'s error - no second re-send, no second refresh', async () => {
    const store = world({ secrets: { access_token: 'AT-1' }, config: { source: 'mod', account: 'zed' } })
    const t = setup(REFRESHING, { world: store })
    const { transport, opens } = endpoint(store, () => false)

    const chunks = await stream(transport)

    expect(opens).toHaveLength(2)
    expect(errorOf(chunks)).toMatch(/401/)
    expect(refreshCalls(t.log)).toHaveLength(1)
  })

  it('an expiring token is refreshed BEFORE the first send', async () => {
    const store = world({
      secrets: { access_token: 'AT-1' },
      config: { source: 'mod', account: 'zed', tokenExpiresAt: Date.now() + 20_000 },
    })
    const t = setup(REFRESHING, { world: store })
    const { transport, opens } = endpoint(store, token => token === 'AT-2')

    const chunks = await stream(transport)

    expect(errorOf(chunks)).toBeUndefined()
    expect(opens.map(o => o.token)).toEqual(['AT-2'])
    expect(refreshCalls(t.log)).toEqual([expect.stringContaining('refresh expiry #1')])
  })

  it('three requests that all hit the expired token make ONE refresh', async () => {
    const store = world({ secrets: { access_token: 'AT-1' }, config: { source: 'mod', account: 'zed', tokenExpiresAt: FAR } })
    const t = setup(REFRESHING, { world: store })
    const { transport, opens } = endpoint(store, token => token === 'AT-2')

    const results = await Promise.all([stream(transport), stream(transport), stream(transport)])

    for (const chunks of results) expect(errorOf(chunks)).toBeUndefined()
    expect(refreshCalls(t.log)).toHaveLength(1)
    expect(opens.filter(o => o.token === 'AT-2')).toHaveLength(3)
  })

  it('a refresh that says signedOut ends the request with the sign-in sentence, marks the provider, and sends nothing more', async () => {
    const store = world({ secrets: { access_token: 'AT-1', refresh_token: 'RT-1' }, config: { source: 'mod', account: 'zed', tokenExpiresAt: FAR } })
    const t = setup(
      `export function register(on) { on('provider.refresh', async () => ({ signedOut: true })) }`,
      { world: store },
    )
    const { transport, opens } = endpoint(store, () => false)

    const chunks = await stream(transport)

    expect(opens).toHaveLength(1)
    expect(errorOf(chunks)).toMatch(/Sign in again/)
    // A refusal (401), so the engine does not retry it as a broken connection.
    expect(chunks.find(c => c.type === 'error')?.error?.httpStatus).toBe(401)
    expect(t.credentials.state().signedOut[ID]).toBeDefined()
    // The dead token is gone from the store; the account stays so the page says "sign in again".
    expect(store.secrets).toEqual({})
    expect(store.config().account).toBe('zed')
  })

  it('a provider whose module has no refresh hook behaves as before: the 401 is the error', async () => {
    const store = world({ secrets: { access_token: 'AT-1' }, config: { source: 'mod', account: 'zed' } })
    setup(`export function register(on) { on('provider.logout', async () => {}) }`, { world: store })
    const { transport, opens } = endpoint(store, () => false)
    const chunks = await stream(transport)
    expect(opens).toHaveLength(1)
    expect(errorOf(chunks)).toMatch(/401/)
  })
})

describe('sign-out', () => {
  it('runs the module\'s provider.logout and clears the declared secrets, the account and the expiry', async () => {
    const store = world({ secrets: { access_token: 'AT-1', refresh_token: 'RT-1' }, config: { source: 'mod', modVersion: '3.0.0', account: 'zed', tokenExpiresAt: FAR } })
    const t = setup(REFRESHING, { world: store })
    await t.credentials.signOut(ID)
    expect(t.log.some(line => line.includes('logout hook'))).toBe(true)
    expect(store.secrets).toEqual({})
    expect(store.config()).toMatchObject({ source: 'mod', modVersion: '3.0.0' })
    expect(store.config().account).toBeUndefined()
    expect(store.config().tokenExpiresAt).toBeUndefined()
  })

  it('clears them anyway when the logout hook throws', async () => {
    const store = world({ secrets: { access_token: 'AT-1' }, config: { source: 'mod', account: 'zed' } })
    const t = setup(`export function register(on) { on('provider.logout', async () => { throw new Error('vendor offline') }) }`, { world: store })
    await t.credentials.signOut(ID)
    expect(store.secrets).toEqual({})
    expect(store.config().account).toBeUndefined()
  })
})
