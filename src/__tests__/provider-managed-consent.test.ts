// @vitest-environment happy-dom
/**
 * Consent for a router that manages providers (F-27 RP-18): what a person consents to for a router that manages
 * providers: the grant (the manager, the sign-in window hosts), when an
 * update widens it, what the consent dialog and the update notice say, the
 * account a managed sign-in must name, and the `autoCreate` manifest field.
 */
import { createElement } from 'react'
import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import { createTranslate } from '../browser/webview/i18n'
import {
  ProviderConsentDialog,
  grantDeltaLines,
  managedDefinitionsText,
} from '../browser/webview/settings/sections/ProviderModUpdates'
import { ProviderCredentials, type CredentialRuntime } from '../mods/provider/login/providerCredentials'
import { PROVIDER_WIRE_FORMATS } from '../mods/provider/providerManifest'
import { checkPluginDescriptor } from '../pluginHost/manifestValidator'
import { pluginGrantOf, widened, type Grant } from '../pluginHost/providerGrant'
import type { ProviderModUpdateStatus } from '../pluginHost/providerModUpdates'

afterEach(cleanup)

const t = createTranslate('en')

const ROUTER = {
  providerApi: 1,
  kind: 'router',
  displayName: 'Hub',
  routesTo: '*',
  credentials: { methods: ['anonymous'] },
  module: './providers/router.js',
}
const FREE = {
  providerApi: 1,
  managedBy: 'router',
  displayName: 'Free',
  defaultBaseUrl: 'https://api.vendor-a.test/v1',
  domains: ['api.vendor-a.test'],
  format: PROVIDER_WIRE_FORMATS[0],
  credentials: { methods: ['anonymous'] },
  module: './providers/pool.js',
}
const LOGIN = {
  ...FREE,
  displayName: 'Account',
  instances: 'multiple',
  defaultBaseUrl: 'https://api.vendor-b.test/v1',
  domains: ['api.vendor-b.test', 'accounts.vendor-b.test'],
  credentials: {
    methods: ['login'],
    secrets: [{ name: 'access_token' }],
    loginWindow: { allow: ['accounts.vendor-b.test'] },
  },
}

function check(providers: Record<string, unknown>) {
  const { manifest, errors } = checkPluginDescriptor({ name: 'hub', version: '1.0.0', providers })
  return { manifest, providers: manifest?.providers, errors: errors.join('\n') }
}

function grantOfPlugin(providers: Record<string, unknown>): Grant {
  const { manifest, errors } = check(providers)
  expect(errors).toBe('')
  return pluginGrantOf(manifest)
}

describe('the grant of a router that manages providers', () => {
  it('names each managed definition\'s manager, domains and sign-in window hosts', () => {
    const grant = grantOfPlugin({ router: ROUTER, free: FREE, login: LOGIN })
    expect(grant.providers.router).toMatchObject({ kind: 'router', routesTo: '*' })
    expect(grant.providers.router).not.toHaveProperty('managedBy')
    expect(grant.providers.free).toMatchObject({ managedBy: 'router', domains: ['api.vendor-a.test'] })
    expect(grant.providers.free).not.toHaveProperty('loginWindow')
    expect(grant.providers.login).toMatchObject({
      managedBy: 'router',
      domains: ['accounts.vendor-b.test', 'api.vendor-b.test'],
      loginWindow: ['accounts.vendor-b.test'],
    })
  })

  it('is one grant per definition: `instances` does not enter it, so every instance is covered', () => {
    const single = grantOfPlugin({ router: ROUTER, login: { ...LOGIN, instances: 'single' } })
    const multiple = grantOfPlugin({ router: ROUTER, login: LOGIN })
    expect(multiple).toEqual(single)
    expect(widened(single, multiple).widened).toBe(false)
  })
})

describe('an update of a router that manages providers', () => {
  const before = grantOfPlugin({ router: ROUTER, free: FREE })

  it('a new managed definition widens, and only it is named', () => {
    const delta = widened(before, grantOfPlugin({ router: ROUTER, free: FREE, login: LOGIN }))
    expect(delta.widened).toBe(true)
    expect(delta.added.providers).toEqual(['login'])
    expect(Object.keys(delta.added.perProvider)).toEqual(['login'])
    expect(delta.added.perProvider.login).toMatchObject({
      domains: ['accounts.vendor-b.test', 'api.vendor-b.test'],
      loginWindow: ['accounts.vendor-b.test'],
    })
  })

  it('a managed definition\'s new domain widens, and only that domain is named', () => {
    const next = grantOfPlugin({ router: ROUTER, free: { ...FREE, domains: ['api.vendor-a.test', 'cdn.vendor-a.test'] } })
    const delta = widened(before, next)
    expect(delta.added.providers).toEqual([])
    expect(delta.added.perProvider).toEqual({
      free: { domains: ['cdn.vendor-a.test'], secrets: [], readsSecrets: false, requestNeeds: [] },
    })
  })

  it('a new sign-in window host widens even when its domain was already agreed to', () => {
    const agreed = grantOfPlugin({ router: ROUTER, login: { ...LOGIN, credentials: { ...LOGIN.credentials, loginWindow: undefined } } })
    const delta = widened(agreed, grantOfPlugin({ router: ROUTER, login: LOGIN }))
    expect(delta.widened).toBe(true)
    expect(delta.added.perProvider.login).toEqual({
      domains: [],
      loginWindow: ['accounts.vendor-b.test'],
      secrets: [],
      readsSecrets: false,
      requestNeeds: [],
    })
  })

  it('a provider the person set up that turns managed widens, and names its router', () => {
    const plain = grantOfPlugin({ router: ROUTER, free: { ...FREE, managedBy: undefined } })
    const delta = widened(plain, before)
    expect(delta.widened).toBe(true)
    expect(delta.added.providers).toEqual([])
    expect(delta.added.perProvider).toEqual({
      free: { domains: [], managedBy: 'router', secrets: [], readsSecrets: false, requestNeeds: [] },
    })
  })

  it('a managed provider moved to another router of the plugin widens', () => {
    const two = grantOfPlugin({ router: ROUTER, other: ROUTER, free: FREE })
    const moved = grantOfPlugin({ router: ROUTER, other: ROUTER, free: { ...FREE, managedBy: 'other' } })
    expect(widened(two, moved).added.perProvider.free).toMatchObject({ managedBy: 'other' })
  })

  it('a managed provider handed back to the person is not wider', () => {
    const plain = grantOfPlugin({ router: ROUTER, free: { ...FREE, managedBy: undefined } })
    expect(widened(before, plain).widened).toBe(false)
  })

  it('nothing new is not wider; a dropped sign-in window or managed definition is silent', () => {
    const full = grantOfPlugin({ router: ROUTER, free: FREE, login: LOGIN })
    expect(widened(full, full).widened).toBe(false)
    expect(widened(full, before)).toMatchObject({ widened: false, removed: ['login'] })
  })
})

function status(grant: Grant, over: Partial<ProviderModUpdateStatus> = {}): ProviderModUpdateStatus {
  return {
    pluginId: 'hub@shop',
    state: 'up-to-date',
    grant,
    consented: false,
    activeVersion: '1.0.0',
    ...over,
  } as ProviderModUpdateStatus
}

describe('the consent dialog', () => {
  const open = (grant: Grant) =>
    render(
      createElement(ProviderConsentDialog, {
        target: { name: 'hub', status: status(grant) },
        busy: false,
        error: null,
        onEnable: () => {},
        onCancel: () => {},
        t,
      }),
    )

  it('lists, under the router, the definitions it manages with their domains, after its routes line', () => {
    open(grantOfPlugin({ router: ROUTER, free: FREE, login: LOGIN }))
    const routes = screen.getByTestId('consent-routes-router')
    const manages = screen.getByTestId('consent-manages-router')
    expect(manages.textContent).toBe(
      'Sets up providers of its own and sends your requests through them: free (api.vendor-a.test); login (accounts.vendor-b.test, api.vendor-b.test)',
    )
    expect(routes.compareDocumentPosition(manages) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  })

  it('says of a managed definition who sets it up, and where its sign-in window opens', () => {
    open(grantOfPlugin({ router: ROUTER, free: FREE, login: LOGIN }))
    expect(screen.getByTestId('consent-managed-by-login').textContent).toBe(
      'Set up by router, and used only through it. Agreeing covers every account or key added to it.',
    )
    expect(screen.getByTestId('consent-login-window-login').textContent).toBe(
      'Its sign-in opens a window on: accounts.vendor-b.test',
    )
    expect(screen.getByTestId('consent-domains-login')).toBeTruthy()
    expect(screen.queryByTestId('consent-login-window-free')).toBeNull()
    expect(screen.queryByTestId('consent-managed-by-router')).toBeNull()
  })

  it('a router that manages nothing, and a provider nobody manages, get neither line', () => {
    open(grantOfPlugin({ router: ROUTER, plain: { ...FREE, managedBy: undefined } }))
    expect(screen.queryByTestId('consent-manages-router')).toBeNull()
    expect(screen.queryByTestId('consent-managed-by-plain')).toBeNull()
  })

  it('names only the definitions of the router asked about', () => {
    const grant = grantOfPlugin({ router: ROUTER, other: ROUTER, free: FREE, login: { ...LOGIN, managedBy: 'other' } })
    const rows = Object.entries(grant.providers)
    expect(managedDefinitionsText('router', rows)).toEqual(['free (api.vendor-a.test)'])
    expect(managedDefinitionsText('other', rows)).toEqual(['login (accounts.vendor-b.test, api.vendor-b.test)'])
  })
})

describe('the update notice', () => {
  it('names the router that newly manages a provider', () => {
    const agreed = grantOfPlugin({ router: ROUTER, free: { ...FREE, managedBy: undefined } })
    const next = grantOfPlugin({ router: ROUTER, free: FREE })
    const lines = grantDeltaLines(
      status(agreed, {
        state: 'needs-consent',
        pending: { version: '2.0.0', stagedAt: new Date(0).toISOString(), grant: next, delta: widened(agreed, next) },
      } as Partial<ProviderModUpdateStatus>),
      t,
    )
    expect(lines).toEqual(['free is now set up by router and used only through it'])
  })

  it('names a new sign-in window host', () => {
    const agreed = grantOfPlugin({ router: ROUTER, login: { ...LOGIN, credentials: { ...LOGIN.credentials, loginWindow: undefined } } })
    const next = grantOfPlugin({ router: ROUTER, login: LOGIN })
    const lines = grantDeltaLines(
      status(agreed, {
        state: 'needs-consent',
        pending: { version: '2.0.0', stagedAt: new Date(0).toISOString(), grant: next, delta: widened(agreed, next) },
      } as Partial<ProviderModUpdateStatus>),
      t,
    )
    expect(lines).toEqual(['login may now open a sign-in window on: accounts.vendor-b.test'])
  })
})

describe('the account of a managed sign-in', () => {
  const ID = 'mod.hub.login.ab12'

  function service(accountRequired: boolean, answer: unknown) {
    const writes: unknown[] = []
    const runtime: CredentialRuntime = {
      hasHook: () => true,
      call: (async (_id: string, event: string) =>
        event === 'provider.login' ? { raised: true, value: answer } : { raised: false }) as CredentialRuntime['call'],
    }
    const credentials = new ProviderCredentials({
      runtime: () => runtime,
      describe: id => (id === ID ? { secrets: ['access_token'], methods: ['login'], accountRequired } : undefined),
      storedConfigOf: () => ({ source: 'mod', modVersion: '1.0.0' }),
      writeConfig: async (_id, config) => void writes.push(config),
      report: () => {},
    })
    return { credentials, writes }
  }
  const settle = async () => {
    for (let i = 0; i < 12; i += 1) await Promise.resolve()
  }

  it('a managed provider\'s sign-in that names no account fails and stores nothing', async () => {
    const s = service(true, { secrets: { access_token: 'AT' } })
    s.credentials.startLogin(ID)
    await settle()
    expect(s.credentials.state().logins[ID]?.step).toMatchObject({ kind: 'failed', code: 'invalid_result' })
    expect(s.writes).toEqual([])
  })

  it('with an account it is stored; a provider nobody manages may still name none', async () => {
    const managed = service(true, { secrets: { access_token: 'AT' }, account: 'a@vendor-b.test' })
    managed.credentials.startLogin(ID)
    await settle()
    expect(managed.credentials.state().logins[ID]?.step).toEqual({ kind: 'done', account: 'a@vendor-b.test' })

    const plain = service(false, { secrets: { access_token: 'AT' } })
    plain.credentials.startLogin(ID)
    await settle()
    expect(plain.credentials.state().logins[ID]?.step).toEqual({ kind: 'done' })
    expect(plain.writes).toHaveLength(1)
  })
})

describe('manifest: autoCreate', () => {
  it('is kept on a managed provider that needs no credential', () => {
    const { providers, errors } = check({ router: ROUTER, free: { ...FREE, autoCreate: true } })
    expect(errors).toBe('')
    expect(providers?.free?.autoCreate).toBe(true)
    expect(check({ router: ROUTER, free: { ...FREE, autoCreate: false } }).providers?.free).not.toHaveProperty('autoCreate')
  })

  it.each([
    ['a provider nobody manages', { ...FREE, managedBy: undefined, autoCreate: true }, /only a provider a router manages/],
    ['a provider that signs in', { ...LOGIN, autoCreate: true }, /\["anonymous"\] and nothing else/],
    ['a provider that also takes a key', { ...FREE, credentials: { methods: ['anonymous', 'apiKey'] }, autoCreate: true }, /\["anonymous"\] and nothing else/],
    ['a value that is not a boolean', { ...FREE, autoCreate: 'yes' }, /expected true or false/],
  ])('refuses it on %s, and keeps the other providers', (_what, provider, message) => {
    const { providers, errors } = check({ router: ROUTER, free: provider })
    expect(errors).toMatch(message)
    expect(Object.keys(providers ?? {})).toEqual(['router'])
  })
})
