/**
 * Provider mods — PM-8 end to end: a real `ProviderModRuntime` over a real
 * `ModWorkerHost` on a MessageChannel (the pattern of
 * `provider-mod-runtime.test.ts`; vitest's node environment drops transferred
 * ports, so only the control channel is a real one). A provider module calls
 * `$.provider.*` and returns what it derived.
 */
import { afterEach, describe, expect, it } from 'vitest'
import { installModWorkerHost } from '../mods/ModWorkerHost'
import type { ModWorkerHandle } from '../mods/ModRuntime'
import { ProviderModRuntime } from '../mods/provider/ProviderModRuntime'
import { createMemoryKeyVault } from '../mods/provider/nouns/keyVault'
import { createProviderNouns } from '../mods/provider/nouns/providerNounTable'
import { MemorySessionStores } from '../mods/provider/nouns/sessionStore'

const openPorts: MessagePort[] = []
const runtimes: ProviderModRuntime[] = []
afterEach(() => {
  for (const runtime of runtimes.splice(0)) runtime.dispose()
  for (const port of openPorts.splice(0)) port.close()
})

const MODULE = `
  export function register(on) {
    on('provider.usage', async ($, e) => {
      const installId = await $.provider.installId()
      const again = await $.provider.installId()
      const device = await $.provider.device()
      const id = await $.provider.deriveId('user', e.user, { format: 'base62', length: 16 })
      const token = await $.provider.encryptId('conversation', e.user)
      const back = await $.provider.decryptId('conversation', token)
      let wrongScope = 'accepted'
      try { await $.provider.decryptId('message', token) } catch (error) { wrongScope = 'rejected' }
      const pair = await $.provider.keypair('main')
      const signature = await pair.sign(new TextEncoder().encode('hello'))
      const store = $.provider.sessionStore(e.session)
      await store.set('turn', 3)
      const turn = await store.get('turn')
      const keys = await store.keys()
      await $.provider.setSecrets({ apiKey: 'sk-live' })
      let undeclared = 'accepted'
      try { await $.provider.setSecrets({ nope: 'x' }) } catch (error) { undeclared = error.name }
      let secret = 'present'
      try { await $.provider.secret('apiKey') } catch (error) { secret = error.name }
      return {
        installId, same: installId === again, device, id, token, back, wrongScope,
        jwk: pair.publicKeyJwk, signature: Array.from(signature), turn, keys, undeclared, secret,
      }
    })
    on('provider.sessionEnd', async ($, e) => { await $.provider.sessionStore(e.session).delete('turn') })
  }
`

function build() {
  const written: Array<[string, Record<string, string>]> = []
  const sessions = new MemorySessionStores()
  const nouns = createProviderNouns({
    vault: createMemoryKeyVault(),
    sessions,
    device: () => ({ userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)', appVersion: '9.9.9', locale: 'fr-FR' }),
    declaredSecrets: () => ['apiKey'],
    writeProviderSecrets: async (id, record) => {
      written.push([id, { ...record }])
    },
  })
  const runtime = new ProviderModRuntime({
    readModule: async () => `${MODULE}\n// ${Math.random()}`,
    openWorker: async () => {
      const channel = new MessageChannel()
      openPorts.push(channel.port1, channel.port2)
      installModWorkerHost(channel.port2)
      const handle: ModWorkerHandle = {
        port: channel.port1,
        closed: new Promise(() => {}),
        close() {},
      }
      return handle
    },
    window: { available: () => true, attached: async () => {} },
    providerNouns: nouns.table,
    report: () => {},
  })
  runtimes.push(runtime)
  runtime.register('acme', [{ plugin: 'acme', path: 'acme/providers/zen.js', providers: ['mod.acme.zen'] }])
  return { runtime, written, nouns, sessions }
}

describe('PM-8 over a real worker host', () => {
  it('a provider module derives ids, seals and signs through $.provider', async () => {
    const { runtime, written } = build()
    const answer = (await runtime.call('mod.acme.zen', 'provider.usage', { user: 'alice', session: 's1' })) as {
      raised: boolean
      value: any
    }
    expect(answer.raised).toBe(true)
    const v = answer.value
    expect(v.same).toBe(true)
    expect(v.installId).toMatch(/^[0-9a-f-]{36}$/)
    expect(v.device).toEqual({ os: 'windows', arch: 'x64', appVersion: '9.9.9', locale: 'fr-FR' })
    expect(v.id).toMatch(/^[0-9A-Za-z]{16}$/)
    expect(v.back).toBe('alice')
    expect(v.wrongScope).toBe('rejected')
    expect(v.turn).toBe(3)
    expect(v.keys).toEqual(['turn'])
    expect(v.undeclared).toBe('NotAllowedError')
    expect(v.secret).toBeDefined()
    expect(v.secret).not.toBe('present')
    expect(written).toEqual([['mod.acme.zen', { apiKey: 'sk-live' }]])

    const verifier = await crypto.subtle.importKey('jwk', v.jwk, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify'])
    expect(
      await crypto.subtle.verify(
        { name: 'ECDSA', hash: 'SHA-256' },
        verifier,
        new Uint8Array(v.signature),
        new TextEncoder().encode('hello'),
      ),
    ).toBe(true)

    // The same module, asked again, derives the same values (the key is kept).
    const second = (await runtime.call('mod.acme.zen', 'provider.usage', { user: 'alice', session: 's1' })) as { value: any }
    expect(second.value.id).toBe(v.id)
    expect(second.value.token).toBe(v.token)
    expect(second.value.installId).toBe(v.installId)
    expect(second.value.jwk).toEqual(v.jwk)
  })

  it('provider.sessionEnd runs in the module, then the session is deleted', async () => {
    const { runtime, nouns, sessions } = build()
    await runtime.call('mod.acme.zen', 'provider.usage', { user: 'bob', session: 's2' })
    const store = sessions.open('mod.acme.zen', 's2')
    expect(await store.keys()).toEqual(['turn'])
    await runtime.call('mod.acme.zen', 'provider.sessionEnd', { session: 's2' })
    expect(await store.keys()).toEqual([])
    await store.set('left-behind', 1)
    await nouns.endProviderSession('s2')
    expect(await sessions.open('mod.acme.zen', 's2').keys()).toEqual([])
  })
})
