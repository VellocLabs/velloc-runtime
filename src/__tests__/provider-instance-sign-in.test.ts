/**
 * Router providers RP-23 - `addInstance` of a definition whose method is
 * `login`: the platform runs the sign-in for a just-made instance, keeps the
 * instance only when the sign-in is done, and tells the app the instance id
 * and nothing else.
 */
import { describe, expect, it, vi } from 'vitest'
import { ProviderCredentials, type CredentialRuntime } from '../mods/provider/login/providerCredentials'
import type { ProviderLoginAskedBy, ProviderLoginState } from '../mods/provider/login/loginProtocol'
import {
  createInstanceCalls,
  type InstanceCallsDeps,
  type SignInEnded,
  type SignInQuestion,
  signInThrough,
} from '../mods/provider/providerInstanceCalls'
import { instanceSlotOf } from '../mods/provider/providerInstances'
import { PROVIDER_WIRE_FORMATS, resolveProviders } from '../mods/provider/providerManifest'
import { checkPluginDescriptor } from '../pluginHost/manifestValidator'
import type { NexusProviderConfig } from '../settings/settingsTypes'

const HUB = 'hub'
const ROUTER = `mod.${HUB}.router`
const OWNER = `${HUB}@inline`
const SIGNIN = `mod.${HUB}.signin`
const ONE = `mod.${HUB}.one`
const FIRST = `${SIGNIN}.aaaa`
const NOW = Date.UTC(2026, 10, 26, 12, 0, 0)
const TOKEN = 'tok-secret-AAAA-1111'

function entry(over: Record<string, unknown> = {}) {
  return {
    providerApi: 1,
    displayName: { en: 'Cloud', de: 'Wolke' },
    defaultBaseUrl: 'https://api.vendor-a.test/v1',
    domains: ['api.vendor-a.test'],
    format: PROVIDER_WIRE_FORMATS[0],
    credentials: { methods: ['login'], secrets: [{ name: 'access_token' }] },
    managedBy: 'router',
    instances: 'multiple',
    module: './providers/pool.js',
    ...over,
  }
}

function definitions() {
  const { manifest, errors } = checkPluginDescriptor({
    name: HUB,
    version: '1.0.0',
    providers: {
      router: { providerApi: 1, kind: 'router', routesTo: '*', displayName: 'Router', credentials: { methods: ['anonymous'] }, module: './providers/router.js' },
      signin: entry(),
      one: entry({ instances: undefined, displayName: 'One' }),
    },
  })
  expect(errors).toEqual([])
  return resolveProviders(HUB, `/plugins/${HUB}`, manifest!.providers!)
}

type Asked = { question: SignInQuestion; signal?: AbortSignal; end: (ended: SignInEnded) => void; fail: (error: Error) => void }

function rig(over: Partial<InstanceCallsDeps> = {}, seed: Record<string, NexusProviderConfig> = {}) {
  const configs: Record<string, NexusProviderConfig> = { ...seed }
  const retired: Record<string, string[]> = {}
  const log: string[] = []
  const asked: Asked[] = []
  let draws = 0
  const deps: InstanceCallsDeps = {
    managedBy: routerId => (routerId === ROUTER ? definitions().filter(p => p.manifest.managedBy === 'router').map(provider => ({ provider, owner: OWNER })) : []),
    configs: () => configs,
    retiredSlots: definitionId => retired[definitionId] ?? [],
    writeConfig: async (id, config) => {
      log.push(`write ${id}`)
      // The write path keeps what an entry had sealed when a write sends none.
      const kept = configs[id]?.storedSecrets
      configs[id] = { ...config, ...(kept ? { storedSecrets: kept } : {}) }
    },
    removeConfig: async id => {
      log.push(`remove ${id}`)
      const definition = configs[id]!.definition!
      ;(retired[definition] ??= []).push(instanceSlotOf(definition, id)!)
      delete configs[id]
    },
    resync: async () => void log.push('resync'),
    forgetState: id => void log.push(`forget ${id}`),
    relist: async id => void log.push(`relist ${id}`),
    listModels: async id => void log.push(`list ${id}`),
    isSetUp: id => (configs[id]?.storedSecrets ?? []).length > 0,
    models: () => [],
    locale: () => 'en',
    now: () => NOW,
    random: () => (Math.floor(draws++ / 4) % 26) / 36,
    signIn: (question, signal) =>
      new Promise((end, fail) => {
        asked.push({ question, ...(signal ? { signal } : {}), end, fail })
      }),
    ...over,
  }
  const calls = createInstanceCalls(deps)
  const opened = (count = 1) => vi.waitFor(() => expect(asked.length).toBe(count))
  /** What the sign-in service writes once the person is through. */
  const signedIn = (id: string, account?: string) => {
    configs[id] = { ...configs[id]!, storedSecrets: ['access_token'], ...(account ? { account } : { signedIn: true }) }
    asked.at(-1)!.end({ kind: 'done', ...(account ? { account } : {}) })
  }
  return { calls, configs, retired, log, asked, opened, signedIn }
}

describe('addInstance of a provider that needs a sign-in', () => {
  it('runs the sign-in for a new instance and tells the app only its id', async () => {
    const { calls, configs, log, asked, opened, signedIn } = rig({ routerLabel: () => ({ en: 'Free Router' }) })
    const adding = calls.add(ROUTER, { definition: 'signin' }, 'action')
    await opened()
    expect(asked[0]!.question).toEqual({
      providerId: FIRST,
      routerId: ROUTER,
      routerLabel: { en: 'Free Router' },
      plugin: HUB,
      definitionId: SIGNIN,
      label: { en: 'Cloud', de: 'Wolke' },
    })
    // Registered so that its sign-in can run, with no credential and not yet the router's to route to.
    expect(configs[FIRST]).toEqual({ source: 'mod', modOwner: OWNER, definition: SIGNIN, name: 'Cloud', createdAt: NOW })
    expect(log).toEqual([`write ${FIRST}`, 'resync'])
    expect(calls.instances(ROUTER)).toEqual([])
    signedIn(FIRST, 'ada@example.test')
    expect(await adding).toEqual({ id: FIRST })
    expect(configs[FIRST]).toMatchObject({ name: 'Cloud · ada@example.test', account: 'ada@example.test', storedSecrets: ['access_token'], definition: SIGNIN })
    expect(log).toEqual([`write ${FIRST}`, 'resync', `write ${FIRST}`, `list ${FIRST}`, 'resync', `relist ${ROUTER}`])
    expect(calls.instances(ROUTER)).toMatchObject([{ id: FIRST, definition: SIGNIN, name: 'Cloud · ada@example.test', account: 'ada@example.test', connected: true }])
  })

  it('a listing that fails after the sign-in still gives the app the instance', async () => {
    const { calls, opened, signedIn } = rig({
      listModels: async () => {
        throw new Error('the module is not loaded')
      },
    })
    const adding = calls.add(ROUTER, { definition: 'signin' }, 'action')
    await opened()
    signedIn(FIRST, 'ada@example.test')
    expect(await adding).toEqual({ id: FIRST })
    expect(calls.instances(ROUTER)).toMatchObject([{ id: FIRST, connected: true }])
  })

  it('a listing slower than the wait does not hold back the answer, and lands when it answers', async () => {
    let finish: () => void = () => {}
    const { calls, opened, signedIn } = rig({
      listWaitMs: 5,
      listModels: () => new Promise<void>(resolve => (finish = resolve)),
    })
    const adding = calls.add(ROUTER, { definition: 'signin' }, 'action')
    await opened()
    signedIn(FIRST, 'ada@example.test')
    expect(await adding).toEqual({ id: FIRST })
    finish()
  })

  it('keeps the name the app gave, and the plain name when the sign-in names no account', async () => {
    const named = rig()
    const adding = named.calls.add(ROUTER, { definition: 'signin', name: 'Work' }, 'action')
    await named.opened()
    named.signedIn(FIRST, 'ada@example.test')
    await adding
    expect(named.configs[FIRST]).toMatchObject({ name: 'Work', account: 'ada@example.test' })

    const plain = rig()
    const second = plain.calls.add(ROUTER, { definition: 'signin' }, 'action')
    await plain.opened()
    plain.signedIn(FIRST)
    await second
    expect(plain.configs[FIRST]).toMatchObject({ name: 'Cloud', signedIn: true })
    expect(plain.log.filter(line => line.startsWith('write'))).toHaveLength(1)
  })

  it('cancelled by the person: `{ cancelled: true }`, and no instance is left', async () => {
    const { calls, configs, retired, log, asked, opened } = rig()
    const adding = calls.add(ROUTER, { definition: 'signin' }, 'action')
    await opened()
    asked[0]!.end({ kind: 'cancelled' })
    expect(await adding).toEqual({ cancelled: true })
    expect(configs).toEqual({})
    expect(calls.instances(ROUTER)).toEqual([])
    expect(log.slice(2)).toEqual([`remove ${FIRST}`, `forget ${FIRST}`, 'resync', `relist ${ROUTER}`])
    // Its slot is given up, so nothing kept under the id is read as a later instance's.
    expect(retired[SIGNIN]).toEqual(['aaaa'])
  })

  it('a sign-in that fails: `failed` with the code and none of the module\'s words, and no instance is left', async () => {
    const { calls, configs, asked, opened } = rig()
    const adding = calls.add(ROUTER, { definition: 'signin' }, 'action')
    await opened()
    asked[0]!.end({ kind: 'failed', code: 'invalid_result' })
    const answer = await adding
    expect(answer).toEqual({ error: { kind: 'failed', message: `$.provider.addInstance: the sign-in to ${SIGNIN} failed (invalid_result)` } })
    expect(configs).toEqual({})
  })

  it('a sign-in that cannot be started rejects the call, leaves no instance and frees the router', async () => {
    const { calls, configs, asked, opened, signedIn } = rig()
    const adding = calls.add(ROUTER, { definition: 'signin' }, 'action')
    await opened()
    asked[0]!.fail(new Error('the provider module runtime is not running'))
    await expect(adding).rejects.toThrow('the provider module runtime is not running')
    expect(configs).toEqual({})
    const again = calls.add(ROUTER, { definition: 'signin' }, 'action')
    await opened(2)
    signedIn(`${SIGNIN}.bbbb`, 'ada@example.test')
    expect(await again).toEqual({ id: `${SIGNIN}.bbbb` })
  })

  it('a registration that fails after the instance was stored takes it back and frees the router', async () => {
    let failing = true
    const { calls, configs, asked, opened, signedIn } = rig({
      resync: async () => {
        if (failing) throw new Error('the host could not register it')
      },
    })
    await expect(calls.add(ROUTER, { definition: 'signin' }, 'action')).rejects.toThrow('the host could not register it')
    expect(configs).toEqual({})
    expect(asked).toEqual([])
    failing = false
    const again = calls.add(ROUTER, { definition: 'signin' }, 'action')
    await opened()
    signedIn(`${SIGNIN}.bbbb`)
    expect(await again).toEqual({ id: `${SIGNIN}.bbbb` })
  })

  it('an instance that cannot be taken back is listed as not connected, and the app still gets how the sign-in ended', async () => {
    const { calls, asked, opened } = rig({
      removeConfig: async () => {
        throw new Error('settings.json is locked')
      },
    })
    const adding = calls.add(ROUTER, { definition: 'signin' }, 'action')
    await opened()
    asked[0]!.end({ kind: 'cancelled' })
    expect(await adding).toEqual({ cancelled: true })
    expect(calls.instances(ROUTER)).toMatchObject([{ id: FIRST, connected: false }])
  })

  it('a done sign-in whose new name cannot be written keeps the instance under its first name and lists it', async () => {
    let writes = 0
    const stored: Record<string, NexusProviderConfig> = {}
    const { calls, opened, signedIn } = rig(
      {
        writeConfig: async (id, config) => {
          writes += 1
          if (writes > 1) throw new Error('settings.json is locked')
          stored[id] = config
        },
        configs: () => stored,
      },
    )
    const adding = calls.add(ROUTER, { definition: 'signin' }, 'action')
    await opened()
    stored[FIRST] = { ...stored[FIRST]!, storedSecrets: ['access_token'], account: 'ada@example.test' }
    signedIn(FIRST, 'ada@example.test')
    expect(await adding).toEqual({ id: FIRST })
    expect(calls.instances(ROUTER)).toMatchObject([{ id: FIRST, name: 'Cloud', connected: true }])
  })

  it('one at a time for a router: a second add while the sign-in is open is answered `busy`; a rename is not held up', async () => {
    const seed = { [`${SIGNIN}.own1`]: { source: 'mod' as const, modOwner: OWNER, definition: SIGNIN, name: 'Old', createdAt: NOW - 1 } }
    const { calls, configs, asked, opened } = rig({}, seed)
    const adding = calls.add(ROUTER, { definition: 'signin' }, 'action')
    await opened()
    expect(await calls.add(ROUTER, { definition: 'signin' }, 'action')).toMatchObject({ error: { kind: 'busy' } })
    expect(await calls.remove(ROUTER, { provider: `${SIGNIN}.own1` }, 'action')).toMatchObject({ error: { kind: 'busy' } })
    expect(await calls.rename(ROUTER, { provider: `${SIGNIN}.own1`, name: 'Renamed' })).toEqual({ ok: true })
    expect(configs[`${SIGNIN}.own1`]!.name).toBe('Renamed')
    expect(asked).toHaveLength(1)
    asked[0]!.end({ kind: 'cancelled' })
    await adding
    expect(await calls.remove(ROUTER, { provider: `${SIGNIN}.own1` }, 'action')).toEqual({ ok: true })
  })

  it('is refused before the person is asked: outside their action, or with no room for one more', async () => {
    const seed = { [`${ONE}.own1`]: { source: 'mod' as const, modOwner: OWNER, definition: ONE, name: 'One', createdAt: NOW } }
    const { calls, configs, asked } = rig({}, seed)
    for (const phase of ['start', 'other'] as const) {
      await expect(calls.add(ROUTER, { definition: 'signin' }, phase)).rejects.toMatchObject({ name: 'NotAllowedError' })
    }
    expect(await calls.add(ROUTER, { definition: 'one' }, 'action')).toMatchObject({ error: { kind: 'single' } })
    expect(asked).toEqual([])
    expect(Object.keys(configs)).toEqual([`${ONE}.own1`])
  })

  it('answers `unsupported` where no sign-in can be asked for, and stores nothing', async () => {
    const { calls, configs } = rig({ signIn: undefined })
    expect(await calls.add(ROUTER, { definition: 'signin' }, 'action')).toMatchObject({ error: { kind: 'unsupported' } })
    expect(configs).toEqual({})
  })

  it('waits with the calling hook\'s clock stopped, and is handed the hook\'s signal', async () => {
    const { calls, asked, opened } = rig()
    const held: string[] = []
    const gone = new AbortController()
    const adding = calls.add(ROUTER, { definition: 'signin' }, 'action', {
      whileAsking: async work => {
        held.push('stopped')
        try {
          return await work()
        } finally {
          held.push('running')
        }
      },
      signal: gone.signal,
    })
    await opened()
    expect(held).toEqual(['stopped'])
    expect(asked[0]!.signal).toBe(gone.signal)
    asked[0]!.end({ kind: 'cancelled' })
    await adding
    expect(held).toEqual(['stopped', 'running'])
  })
})

describe('a sign-in a settings app asked for, in the sign-in service', () => {
  const ASKED_BY: ProviderLoginAskedBy = { routerId: ROUTER, plugin: HUB, label: { en: 'Cloud' } }

  function service(login: (e: Record<string, unknown>, signal?: AbortSignal) => Promise<unknown>) {
    const configs: Record<string, NexusProviderConfig> = { [FIRST]: { source: 'mod', definition: SIGNIN, name: 'Cloud' } }
    const sealed: Record<string, Record<string, string>> = {}
    const runtime: CredentialRuntime = {
      hasHook: () => true,
      call: (async (_id: string, _event: string, e: Record<string, unknown> = {}, options: { signal?: AbortSignal } = {}) => ({
        raised: true,
        value: await login(e, options.signal),
      })) as CredentialRuntime['call'],
    }
    const credentials = new ProviderCredentials({
      runtime: () => runtime,
      describe: id => (id === FIRST ? { secrets: ['access_token'], methods: ['login'], accountRequired: true } : undefined),
      storedConfigOf: id => configs[id],
      writeConfig: async (id, config) => {
        const { secrets, ...rest } = config
        sealed[id] = { ...sealed[id], ...secrets }
        configs[id] = { ...rest, storedSecrets: Object.keys(sealed[id]!) }
      },
      report: () => {},
    })
    const states: ProviderLoginState[] = []
    credentials.subscribe(state => states.push(state))
    return { credentials, configs, sealed, states }
  }

  it('is published with who asked on every step, and ends `done` with the account alone', async () => {
    let finish!: (value: unknown) => void
    const { credentials, states, sealed } = service(() => new Promise(resolve => (finish = resolve)))
    const { loginId } = credentials.startLogin(FIRST, ASKED_BY)
    const over = credentials.whenOver(loginId)
    expect(credentials.state().logins[FIRST]!.askedBy).toEqual(ASKED_BY)
    void credentials.interact(loginId, [FIRST], { kind: 'progress', text: 'Contacting the vendor' })
    expect(credentials.state().logins[FIRST]).toMatchObject({ step: { kind: 'progress' }, askedBy: ASKED_BY })
    finish({ secrets: { access_token: TOKEN }, account: 'ada@example.test' })
    expect(await over).toEqual({ kind: 'done', account: 'ada@example.test' })
    expect(sealed[FIRST]).toEqual({ access_token: TOKEN })
    expect(states.at(-1)!.logins[FIRST]).toMatchObject({ step: { kind: 'done' }, askedBy: ASKED_BY })
    expect(JSON.stringify(states)).not.toContain(TOKEN)
    // One already over is told the same.
    expect(await credentials.whenOver(loginId)).toEqual({ kind: 'done', account: 'ada@example.test' })
  })

  it('one the Models page started carries no asker', () => {
    const { credentials } = service(() => new Promise(() => {}))
    credentials.startLogin(FIRST)
    expect(credentials.state().logins[FIRST]).not.toHaveProperty('askedBy')
  })

  it('a failure is told by its code, not the module\'s words', async () => {
    const { credentials } = service(async () => ({ secrets: { nope: 'x' } }))
    const { loginId } = credentials.startLogin(FIRST, ASKED_BY)
    const ended = await credentials.whenOver(loginId)
    expect(ended).toEqual({ kind: 'failed', code: 'invalid_result' })
  })

  it('closed by the person, or its asker gone: `cancelled`, the hook is abandoned and nothing is written', async () => {
    const seen: AbortSignal[] = []
    const hang = (_e: Record<string, unknown>, signal?: AbortSignal) => {
      if (signal) seen.push(signal)
      return new Promise(() => {})
    }
    const closed = service(hang)
    const first = closed.credentials.startLogin(FIRST, ASKED_BY)
    const over = closed.credentials.whenOver(first.loginId)
    closed.credentials.cancel(first.loginId)
    expect(await over).toEqual({ kind: 'cancelled' })
    expect(closed.sealed).toEqual({})

    const gone = new AbortController()
    const left = service(hang)
    const second = left.credentials.startLogin(FIRST, ASKED_BY)
    const waiting = left.credentials.whenOver(second.loginId, gone.signal)
    gone.abort()
    expect(await waiting).toEqual({ kind: 'cancelled' })
    expect(left.credentials.state().logins).toEqual({})
    expect(seen.every(signal => signal.aborted)).toBe(true)
    expect(await left.credentials.whenOver('login-unknown')).toEqual({ kind: 'cancelled' })
  })
})

describe('the calls over the real sign-in service', () => {
  it('the token goes from the module to the instance\'s sealed entry and nowhere the app can read', async () => {
    const configs: Record<string, NexusProviderConfig> = {}
    const sealed: Record<string, Record<string, string>> = {}
    const registered = new Set<string>()
    const loggedIn: string[] = []
    const write = async (id: string, config: NexusProviderConfig) => {
      const { secrets, ...rest } = config
      if (secrets) sealed[id] = { ...sealed[id], ...secrets }
      configs[id] = { ...rest, ...(sealed[id] ? { storedSecrets: Object.keys(sealed[id]!) } : {}) }
    }
    const runtime: CredentialRuntime = {
      hasHook: () => true,
      call: (async (id: string) => {
        loggedIn.push(id)
        return { raised: true, value: { secrets: { access_token: TOKEN }, account: 'ada@example.test' } }
      }) as CredentialRuntime['call'],
    }
    const credentials = new ProviderCredentials({
      runtime: () => runtime,
      describe: id => (registered.has(id) ? { secrets: ['access_token'], methods: ['login'], accountRequired: true } : undefined),
      storedConfigOf: id => configs[id],
      writeConfig: write,
      report: () => {},
    })
    const calls = createInstanceCalls({
      managedBy: routerId => (routerId === ROUTER ? definitions().filter(p => p.manifest.managedBy === 'router').map(provider => ({ provider, owner: OWNER })) : []),
      configs: () => configs,
      retiredSlots: () => [],
      writeConfig: write,
      removeConfig: async id => void delete configs[id],
      resync: async () => {
        registered.clear()
        for (const id of Object.keys(configs)) registered.add(id)
      },
      forgetState: () => {},
      relist: async () => {},
      isSetUp: id => (configs[id]?.storedSecrets ?? []).length > 0,
      models: () => [],
      locale: () => 'en',
      now: () => NOW,
      random: () => 0,
      signIn: signInThrough(() => credentials),
    })
    const made = await calls.add(ROUTER, { definition: 'signin' }, 'action')
    expect(made).toEqual({ id: FIRST })
    expect(loggedIn).toEqual([FIRST])
    expect(sealed).toEqual({ [FIRST]: { access_token: TOKEN } })
    expect(configs[FIRST]).toMatchObject({ definition: SIGNIN, modOwner: OWNER, account: 'ada@example.test', name: 'Cloud · ada@example.test', storedSecrets: ['access_token'] })
    expect(JSON.stringify([made, calls.instances(ROUTER), configs])).not.toContain(TOKEN)
    // A finished sign-in leaves the published state, so its dialog closes.
    expect(credentials.state().logins).toEqual({})
  })
})
