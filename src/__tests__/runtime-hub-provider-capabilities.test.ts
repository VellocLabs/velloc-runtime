/**
 * The provider capabilities on the runtime hub: `providerUsage`,
 * `providerUpdates` and `providerLogin`, each driven through a loopback
 * connection as a client would.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { TOPICS_SUBSCRIBE_ROUTE } from '../browser/runtimeProtocol'
import { registerProviderUsageCapability } from '../browser/runtimeHub/providerUsageCapability'
import { registerProviderLoginCapability } from '../browser/runtimeHub/providerLoginCapability'
import { ProviderCredentials } from '../mods/provider/login/providerCredentials'
import type { BrowserBridgeTransport } from '../browser/bridge/browserBridgeProtocol'
import { resetProviderUsage } from '../models/drivers/providerUsageService'
import { flush, makeRig } from './_helpers/runtimeHubRig'

beforeEach(() => {
  vi.useRealTimers()
})
afterEach(() => {
  vi.restoreAllMocks()
})

// ---- providerUsage: the usage table topic + its refresh action ----------------

describe('providerUsage capability', () => {
  afterEach(() => resetProviderUsage())

  /** A host that answers the Vercel credits document over rawStream*. */
  function creditsHost(): BrowserBridgeTransport {
    const body = new TextEncoder().encode('{"balance":"12.00","total_used":"3"}')
    return {
      async request(req: any) {
        if (req.route.action === 'rawStreamOpen') {
          return { ok: true, result: { streamId: 's', status: 200, statusText: 'OK', finalUrl: req.payload.url, headers: {} } } as any
        }
        if (req.route.action === 'rawStreamRead') return { ok: true, result: { done: true, chunk: body } } as any
        return { ok: true, result: { ok: true } } as any
      },
    }
  }

  function usageRig(scopeCeiling: 'observe' | 'control') {
    const rig = makeRig()
    registerProviderUsageCapability(rig.registry, rig.broker, () => creditsHost())
    return { ...rig, ready: rig.client.hello({ scopeCeiling }) }
  }

  it('an observer may read the table but not trigger a fetch (refresh is control)', async () => {
    const { client, ready } = usageRig('observe')
    await ready
    const sub = await client.request(TOPICS_SUBSCRIBE_ROUTE, { topics: [{ topic: 'providers/usage' }] })
    expect(sub.ok).toBe(true)
    const refused = await client.request('providerUsage.refresh', { providerId: 'vercel-ai-gateway' })
    expect(refused.ok === false && refused.error.code).toBe('forbidden_scope')
  })

  it('refresh validates its payload, fetches through the provider, and publishes the table', async () => {
    const { client, ready } = usageRig('control')
    await ready
    await client.request(TOPICS_SUBSCRIBE_ROUTE, { topics: [{ topic: 'providers/usage' }] })
    const bad = await client.request('providerUsage.refresh', {})
    expect(bad.ok === false && bad.error.code).toBe('bad_payload')
    const res = await client.request('providerUsage.refresh', { providerId: 'vercel-ai-gateway' })
    expect(res.ok === true && res.result).toMatchObject({
      usage: { amounts: [{ kind: 'balance', amount: 12 }, { kind: 'spent', amount: 3 }] },
    })
    const events = await client.eventsFor('providers/usage', 2)
    expect(events.at(-1)!.payload).toMatchObject({
      'vercel-ai-gateway': { usage: { amounts: [{ kind: 'balance', amount: 12 }, { kind: 'spent', amount: 3 }] } },
    })
    // A provider with no usage source answers null and publishes nothing new.
    const none = await client.request('providerUsage.refresh', { providerId: 'glm' })
    expect(none.ok === true && none.result).toBeNull()
  })
})

// ---- providerUpdates: the update service's topic + its five actions -----------

describe('providerUpdates capability', () => {
  const ACTIONS = ['check', 'consent', 'decline', 'rollback', 'baseline'] as const
  const PAYLOADS: Record<(typeof ACTIONS)[number], Record<string, unknown>> = {
    check: { pluginId: 'acme@shop' },
    consent: { pluginId: 'acme@shop', version: '2.0.0' },
    decline: { pluginId: 'acme@shop', version: '2.0.0' },
    rollback: { pluginId: 'acme@shop' },
    baseline: { pluginId: 'acme@shop' },
  }
  const status = (over: Record<string, unknown> = {}) => ({
    pluginId: 'acme@shop',
    state: 'up-to-date',
    grant: { providers: {} },
    ...over,
  })

  function fakeService() {
    const listeners = new Set<() => void>()
    const calls: Array<[string, ...unknown[]]> = []
    let rows = [status()]
    const service = {
      status: async () => rows,
      checkNow: async (id?: string) => {
        calls.push(['checkNow', id])
        return rows
      },
      checkDue: async () => rows,
      recordConsent: async (id: string, version: string) => {
        calls.push(['recordConsent', id, version])
        if (version === '9.9.9') throw new Error(`${id} has no parked update ${version} waiting for consent`)
        return status({ activeVersion: version })
      },
      decline: async (id: string, version: string) => {
        calls.push(['decline', id, version])
        return status()
      },
      rollback: async (id: string) => {
        calls.push(['rollback', id])
        return status()
      },
      recordInitialConsent: async (id: string) => {
        calls.push(['recordInitialConsent', id])
        return status()
      },
      subscribe: (listener: () => void) => {
        listeners.add(listener)
        return () => listeners.delete(listener)
      },
    }
    return {
      service,
      calls,
      change: (next: ReturnType<typeof status>[]) => {
        rows = next
        for (const listener of [...listeners]) listener()
      },
    }
  }

  async function updatesRig(scopeCeiling: 'observe' | 'control' | 'manager' | 'full', withService = true) {
    const fake = fakeService()
    const rig = makeRig()
    const { registerProviderUpdatesCapability } = await import('../browser/runtimeHub/providerUpdatesCapability')
    let notify = () => {}
    const handle = registerProviderUpdatesCapability(rig.registry, rig.broker, {
      acquire: async () => (withService ? (fake.service as never) : null),
      onChanged: listener => {
        notify = listener
        return () => {}
      },
      report: () => {},
    })
    await rig.client.hello({ scopeCeiling })
    return { ...rig, fake, handle, notify: () => notify() }
  }

  it('every action is full: control and manager connections are refused, and are not even advertised the capability', async () => {
    for (const ceiling of ['observe', 'control', 'manager'] as const) {
      const { client, registry } = await updatesRig(ceiling)
      for (const act of ACTIONS) {
        const refused = await client.request(`providerUpdates.${act}`, PAYLOADS[act])
        expect([ceiling, act, refused.ok === false && refused.error.code]).toEqual([ceiling, act, 'forbidden_scope'])
      }
      expect(registry.advertise({ mode: ceiling, sessions: 'all' }).find(a => a.cap === 'providerUpdates')).toBeUndefined()
    }
    const { registry } = await updatesRig('full')
    expect([...(registry.advertise({ mode: 'full', sessions: 'all' }).find(a => a.cap === 'providerUpdates')?.acts ?? [])].sort()).toEqual(
      [...ACTIONS].sort(),
    )
  })

  it('the scope table is the declared one, all full', async () => {
    const { PROVIDER_UPDATES_ACTION_SCOPES } = await import('../pluginHost/providerUpdatesProtocol')
    expect(Object.values(PROVIDER_UPDATES_ACTION_SCOPES)).toEqual(ACTIONS.map(() => 'full'))
    expect(Object.keys(PROVIDER_UPDATES_ACTION_SCOPES).sort()).toEqual([...ACTIONS].sort())
  })

  it('an observer reads the status off the topic: the snapshot, then a delta on every change', async () => {
    const { client, fake, notify } = await updatesRig('observe')
    const sub = await client.request(TOPICS_SUBSCRIBE_ROUTE, { topics: [{ topic: 'plugins/providerUpdates' }] })
    expect(sub.ok).toBe(true)
    const first = await client.eventsFor('plugins/providerUpdates', 1)
    expect(first[0]!.payload).toEqual({ plugins: [status()] })
    fake.change([status({ state: 'needs-consent', pending: { version: '2.0.0' } })])
    notify()
    const next = await client.eventsFor('plugins/providerUpdates', 2)
    expect((next.at(-1)!.payload as { plugins: Array<{ state: string }> }).plugins[0]!.state).toBe('needs-consent')
  })

  it('with no provider plugin the topic is empty and an action is host_unavailable', async () => {
    const { client } = await updatesRig('full', false)
    await client.request(TOPICS_SUBSCRIBE_ROUTE, { topics: [{ topic: 'plugins/providerUpdates' }] })
    expect((await client.eventsFor('plugins/providerUpdates', 1))[0]!.payload).toEqual({ plugins: [] })
    const res = await client.request('providerUpdates.check', {})
    expect(res.ok === false && res.error.code).toBe('host_unavailable')
  })

  it('a full connection reaches the service with the plugin id and version only', async () => {
    const { client, fake } = await updatesRig('full')
    expect((await client.request('providerUpdates.check', {})).ok).toBe(true)
    expect((await client.request('providerUpdates.check', { pluginId: 'acme@shop' })).ok).toBe(true)
    const consent = await client.request('providerUpdates.consent', { pluginId: 'acme@shop', version: '2.0.0' })
    expect(consent.ok === true && consent.result).toMatchObject({ status: { activeVersion: '2.0.0' } })
    await client.request('providerUpdates.decline', { pluginId: 'acme@shop', version: '2.0.0' })
    await client.request('providerUpdates.rollback', { pluginId: 'acme@shop' })
    await client.request('providerUpdates.baseline', { pluginId: 'acme@shop' })
    expect(fake.calls).toEqual([
      ['checkNow', undefined],
      ['checkNow', 'acme@shop'],
      ['recordConsent', 'acme@shop', '2.0.0'],
      ['decline', 'acme@shop', '2.0.0'],
      ['rollback', 'acme@shop'],
      ['recordInitialConsent', 'acme@shop'],
    ])
  })

  it('a call the service cannot apply answers conflict with the service words', async () => {
    const { client } = await updatesRig('full')
    const res = await client.request('providerUpdates.consent', { pluginId: 'acme@shop', version: '9.9.9' })
    expect(res.ok === false && res.error.code).toBe('conflict')
    expect(res.ok === false && res.error.message).toMatch(/no parked update 9\.9\.9/)
  })

  it('payload guards: only a plugin id and a version, nothing else - no path, url, code or credential', async () => {
    const { client, fake } = await updatesRig('full')
    const bad: Array<[string, unknown]> = [
      ['check', { pluginId: 42 }],
      ['check', { pluginId: 'acme@shop', url: 'https://evil.example/a.tgz' }],
      ['check', 'acme@shop'],
      ['consent', { pluginId: 'acme@shop' }],
      ['consent', { pluginId: 'acme@shop', version: '' }],
      ['consent', { pluginId: 'acme@shop', version: '2.0.0', installPath: '/etc' }],
      ['decline', { version: '2.0.0' }],
      ['rollback', {}],
      ['rollback', { pluginId: 'acme@shop', version: '1.0.0' }],
      ['baseline', { pluginId: '', grant: { providers: {} } }],
      ['baseline', { pluginId: 'x'.repeat(301) }],
    ]
    for (const [act, payload] of bad) {
      const res = await client.request(`providerUpdates.${act}`, payload)
      expect([act, JSON.stringify(payload), res.ok === false && res.error.code]).toEqual([act, JSON.stringify(payload), 'bad_payload'])
    }
    expect(fake.calls).toEqual([])
  })

  it('the test helper scope tables carry the capability: never at manager, all five at full', async () => {
    const { advertsForScope } = await import('./_helpers/capabilityQuery')
    expect(advertsForScope('manager').find(a => a.cap === 'providerUpdates')).toBeUndefined()
    expect([...(advertsForScope('full').find(a => a.cap === 'providerUpdates')?.acts ?? [])].sort()).toEqual([...ACTIONS].sort())
  })
})

// ---- providerLogin: the sign-in dialog as published state + its actions ----------

describe('providerLogin capability', () => {
  const PROVIDER = 'mod.acme.main'

  function loginRig(scopeCeiling: 'observe' | 'control' | 'manager') {
    const rig = makeRig()
    const calls: string[] = []
    const service = new ProviderCredentials({
      runtime: () => ({
        hasHook: () => undefined,
        call: (async (_id: string, event: string) => {
          calls.push(event)
          return new Promise(() => {})
        }) as never,
      }),
      describe: id => (id === PROVIDER ? { secrets: ['access_token'], methods: ['login'] } : undefined),
      storedConfigOf: () => ({ source: 'mod' }),
      writeConfig: async () => {},
      report: () => {},
    })
    registerProviderLoginCapability(rig.registry, rig.broker, service)
    return { ...rig, service, calls, ready: rig.client.hello({ scopeCeiling }) }
  }

  const ACTIONS: Array<[string, unknown]> = [
    ['providerLogin.start', { providerId: PROVIDER }],
    ['providerLogin.answer', { loginId: 'login-1', stepId: 'login-1:1', value: { kind: 'ack' } }],
    ['providerLogin.cancel', { loginId: 'login-1' }],
    ['providerLogin.signOut', { providerId: PROVIDER }],
  ]

  it('every action is manager: observe and control connections are refused, and nothing ran', async () => {
    for (const ceiling of ['observe', 'control'] as const) {
      const { client, ready, service, calls } = loginRig(ceiling)
      await ready
      for (const [route, payload] of ACTIONS) {
        const refused = await client.request(route, payload)
        expect(refused.ok === false && refused.error.code, `${ceiling} ${route}`).toBe('forbidden_scope')
      }
      expect(calls).toEqual([])
      expect(service.state().logins).toEqual({})
    }
  })

  it('the topic (a device code and a sign-in link) is readable by a manager only', async () => {
    for (const ceiling of ['observe', 'control'] as const) {
      const { client, ready } = loginRig(ceiling)
      await ready
      const refused = await client.request(TOPICS_SUBSCRIBE_ROUTE, { topics: [{ topic: 'providers/login' }] })
      expect(refused.ok === false && refused.error.code, ceiling).toBe('forbidden_scope')
    }
    const { client, ready } = loginRig('manager')
    await ready
    const ok = await client.request(TOPICS_SUBSCRIBE_ROUTE, { topics: [{ topic: 'providers/login' }] })
    expect(ok.ok).toBe(true)
  })

  it('start publishes the session; answers are validated, stale ones refused; cancel removes it', async () => {
    const { client, ready } = loginRig('manager')
    await ready
    await client.request(TOPICS_SUBSCRIBE_ROUTE, { topics: [{ topic: 'providers/login' }] })

    const started = await client.request('providerLogin.start', { providerId: PROVIDER })
    expect(started.ok).toBe(true)
    const { loginId } = (started as { result: { loginId: string; joined: boolean } }).result
    // A second start joins the one session.
    const again = await client.request('providerLogin.start', { providerId: PROVIDER })
    expect(again.ok === true && again.result).toEqual({ loginId, joined: true })

    const events = await client.eventsFor('providers/login', 2)
    const last = events.at(-1)!.payload as { seq: number; logins: Record<string, { loginId: string; step: { kind: string } }> }
    expect(last.logins[PROVIDER]).toMatchObject({ loginId, step: { kind: 'working' } })

    const stale = await client.request('providerLogin.answer', { loginId, stepId: `${loginId}:77`, value: { kind: 'ack' } })
    expect(stale.ok === false && stale.error.code).toBe('stale')
    const gone = await client.request('providerLogin.answer', { loginId: 'login-gone', stepId: 'login-gone:1', value: { kind: 'ack' } })
    expect(gone.ok === false && gone.error.code).toBe('not_found')
    const bad = await client.request('providerLogin.answer', { loginId, stepId: `${loginId}:1`, value: { kind: 'run', code: 'x' } })
    expect(bad.ok === false && bad.error.code).toBe('bad_payload')

    const cancelled = await client.request('providerLogin.cancel', { loginId })
    expect(cancelled.ok).toBe(true)
    const after = await client.eventsFor('providers/login', 3)
    expect((after.at(-1)!.payload as { logins: object }).logins).toEqual({})
  })

  it('payload guards: ids must be ids, an unknown provider is not_found', async () => {
    const { client, ready } = loginRig('manager')
    await ready
    for (const [route, payload] of [
      ['providerLogin.start', {}],
      ['providerLogin.start', { providerId: 5 }],
      ['providerLogin.start', { providerId: 'a b' }],
      ['providerLogin.cancel', { loginId: '' }],
      ['providerLogin.cancel', { loginId: 'x'.repeat(200) }],
      ['providerLogin.signOut', { providerId: '../x' }],
    ] as Array<[string, unknown]>) {
      const res = await client.request(route, payload)
      expect(res.ok === false && res.error.code, `${route} ${JSON.stringify(payload)}`).toBe('bad_payload')
    }
    const unknown = await client.request('providerLogin.start', { providerId: 'mod.nobody.x' })
    expect(unknown.ok === false && unknown.error.code).toBe('not_found')
    const signOut = await client.request('providerLogin.signOut', { providerId: 'mod.nobody.x' })
    expect(signOut.ok === false && signOut.error.code).toBe('not_found')
  })

  it('a secret prompt answer reaches the module and is in no published event', async () => {
    const rig = makeRig()
    const written: unknown[] = []
    const service: ProviderCredentials = new ProviderCredentials({
      runtime: () => ({
        hasHook: () => undefined,
        call: (async (_id: string, _event: string, e: { loginId: string }) => {
          const answer = await service.interact(e.loginId, [PROVIDER], { kind: 'prompt', label: 'Token', secret: true })
          return { raised: true, value: { secrets: { access_token: `got:${String(answer)}` }, account: 'zed' } }
        }) as never,
      }),
      describe: id => (id === PROVIDER ? { secrets: ['access_token'], methods: ['login'] } : undefined),
      storedConfigOf: () => ({ source: 'mod' }),
      writeConfig: async (_id, config) => void written.push(config),
      report: () => {},
    })
    registerProviderLoginCapability(rig.registry, rig.broker, service)
    await rig.client.hello({ scopeCeiling: 'manager' })
    await rig.client.request(TOPICS_SUBSCRIBE_ROUTE, { topics: [{ topic: 'providers/login' }] })
    const started = await rig.client.request('providerLogin.start', { providerId: PROVIDER })
    const { loginId } = (started as { result: { loginId: string } }).result
    await flush()
    const stepId = service.state().logins[PROVIDER]!.stepId
    const sent = await rig.client.request('providerLogin.answer', { loginId, stepId, value: { kind: 'text', text: 'TOP-SECRET-TOKEN' } })
    expect(sent.ok).toBe(true)
    await flush()
    expect(service.state().logins[PROVIDER]!.step).toMatchObject({ kind: 'done' })
    expect(JSON.stringify(rig.client.events)).not.toContain('TOP-SECRET-TOKEN')
    expect(JSON.stringify(rig.client.events)).not.toContain('got:')
    expect(written).toHaveLength(1)
  })
})
