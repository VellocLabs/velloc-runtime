/**
 * A token refresh changes only the secrets it answers (F-27):
 * `ProviderCredentials` over the settings write path itself, with an
 * in-memory file and a fake sealer, so what is asserted is what is stored.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { providersHandlers } from '../browser/bridge/adapter/providersBridgeAdapter'
import {
  ProviderCredentials,
  type CredentialDeps,
  type CredentialRuntime,
} from '../mods/provider/login/providerCredentials'
import { ProviderSignInRequiredError } from '../models/drivers/providerRequestSeam'
import { NEXUS_SETTINGS_FILE_NAME, wipeSettingsMemos } from '../settings/settingsStore'
import type { NexusProviderConfig } from '../settings/settingsTypes'
import type { RuntimeFs } from '../utils/fs/runtimeFs'

const ID = 'mod.acme.main'
const HOME = '/home/test'
const SETTINGS_PATH = `${HOME}/.velloc/${NEXUS_SETTINGS_FILE_NAME}`
const SEALED = 'NEXUSENC1:'

type Answer = Record<string, unknown>

function rig() {
  const files = new Map<string, string>()
  const fs = {
    readFile: async (path: string) => {
      const content = files.get(path)
      if (content === undefined) throw Object.assign(new Error(`ENOENT: ${path}`), { code: 'ENOENT' })
      return content
    },
    writeFile: async (path: string, data: string | Uint8Array) => {
      files.set(path, typeof data === 'string' ? data : new TextDecoder().decode(data))
    },
    mkdir: async () => {},
  } as unknown as RuntimeFs
  const seal = async (plaintext: string): Promise<string> => SEALED + Buffer.from(plaintext).toString('base64')
  const entry = (): NexusProviderConfig | undefined => {
    const text = files.get(SETTINGS_PATH)
    return text === undefined ? undefined : JSON.parse(text).providers?.configs?.[ID]
  }
  /** The stored secrets, unsealed: name to plaintext. */
  const stored = (): Record<string, string> =>
    Object.fromEntries(
      Object.entries(entry()?.secrets ?? {}).map(([name, value]) => [
        name,
        Buffer.from(value.slice(SEALED.length), 'base64').toString(),
      ]),
    )
  const logins: Answer[] = []
  const refreshes: Answer[] = []
  const refreshCalls = vi.fn()
  const runtime: CredentialRuntime = {
    hasHook: () => undefined,
    call: (async (_id: string, event: string) => {
      if (event === 'provider.login') return { raised: true, value: logins.shift() }
      if (event === 'provider.refresh') {
        refreshCalls()
        return { raised: true, value: refreshes.shift() }
      }
      return { raised: false }
    }) as CredentialRuntime['call'],
  }
  const upsertDeps = { homeDir: HOME, fs, encryptSecret: seal }
  const deps: CredentialDeps = {
    runtime: () => runtime,
    describe: id => (id === ID ? { secrets: ['access_token', 'refresh_token'], methods: ['login'] } : undefined),
    storedConfigOf: id => (id === ID ? entry() : undefined),
    writeConfig: async (id, config) => {
      await providersHandlers.upsert({ id, config }, upsertDeps)
    },
    report: () => {},
  }
  const service = new ProviderCredentials(deps)
  const signIn = async (answer: Answer): Promise<void> => {
    logins.push(answer)
    const { loginId } = service.startLogin(ID)
    await vi.waitFor(() => expect(service.state().logins[ID]?.step.kind).toBe('done'))
    service.cancel(loginId)
  }
  const refresh = (answer: Answer): Promise<'refreshed' | 'unhooked'> => {
    refreshes.push(answer)
    return service.refresh(ID, 'expiry')
  }
  return { service, signIn, refresh, stored, entry, refreshCalls, upsertDeps }
}

beforeEach(() => {
  wipeSettingsMemos()
})

describe('a refresh changes only the secrets it answers', () => {
  it('keeps the stored refresh token when the answer has only a new access token, refresh after refresh', async () => {
    const r = rig()
    await r.signIn({ secrets: { access_token: 'at-1', refresh_token: 'rt-1' }, account: 'ada' })
    expect(r.stored()).toEqual({ access_token: 'at-1', refresh_token: 'rt-1' })

    await expect(r.refresh({ secrets: { access_token: 'at-2' }, expiresAt: 2e12 })).resolves.toBe('refreshed')
    expect(r.stored()).toEqual({ access_token: 'at-2', refresh_token: 'rt-1' })

    await expect(r.refresh({ secrets: { access_token: 'at-3' } })).resolves.toBe('refreshed')
    expect(r.stored()).toEqual({ access_token: 'at-3', refresh_token: 'rt-1' })
    expect(r.refreshCalls).toHaveBeenCalledTimes(2)
    expect(r.entry()?.account).toBe('ada')
  })

  it('stores a rotated refresh token beside the new access token', async () => {
    const r = rig()
    await r.signIn({ secrets: { access_token: 'at-1', refresh_token: 'rt-1' } })
    await r.refresh({ secrets: { access_token: 'at-2', refresh_token: 'rt-2' } })
    expect(r.stored()).toEqual({ access_token: 'at-2', refresh_token: 'rt-2' })
  })

  it('removes a secret the answer names as empty, and only that one', async () => {
    const r = rig()
    await r.signIn({ secrets: { access_token: 'at-1', refresh_token: 'rt-1' } })
    await r.refresh({ secrets: { access_token: 'at-2', refresh_token: '' } })
    expect(r.stored()).toEqual({ access_token: 'at-2' })
  })

  it('an answer with no secrets at all leaves both as they were', async () => {
    const r = rig()
    await r.signIn({ secrets: { access_token: 'at-1', refresh_token: 'rt-1' } })
    await r.refresh({ secrets: {}, expiresAt: 2e12 })
    expect(r.stored()).toEqual({ access_token: 'at-1', refresh_token: 'rt-1' })
    expect(r.entry()?.tokenExpiresAt).toBe(2e12)
  })

  it('{ signedOut: true } removes every declared secret', async () => {
    const r = rig()
    await r.signIn({ secrets: { access_token: 'at-1', refresh_token: 'rt-1' }, account: 'ada' })
    await expect(r.refresh({ signedOut: true })).rejects.toBeInstanceOf(ProviderSignInRequiredError)
    expect(r.stored()).toEqual({})
    expect(r.entry()?.secrets).toBeUndefined()
  })
})

describe('a sign-in over an earlier one', () => {
  it('replaces every secret it answers', async () => {
    const r = rig()
    await r.signIn({ secrets: { access_token: 'at-1', refresh_token: 'rt-1' }, account: 'ada' })
    await r.refresh({ secrets: { access_token: 'at-2' } })
    await r.signIn({ secrets: { access_token: 'at-9', refresh_token: 'rt-9' }, account: 'grace' })
    expect(r.stored()).toEqual({ access_token: 'at-9', refresh_token: 'rt-9' })
    expect(r.entry()?.account).toBe('grace')
  })

  it('a re-sign-in that omits a name clears it', async () => {
    const r = rig()
    await r.signIn({ secrets: { access_token: 'at-1', refresh_token: 'rt-1' } })
    await r.signIn({ secrets: { access_token: 'at-2' } })
    expect(r.stored()).toEqual({ access_token: 'at-2' })
  })

  it('a sign-in as another account leaves none of the earlier account\'s secrets', async () => {
    const r = rig()
    await r.signIn({ secrets: { access_token: 'at-1', refresh_token: 'rt-1' }, account: 'ada' })
    await r.signIn({ secrets: { access_token: 'at-9' }, account: 'grace' })
    expect(r.stored()).toEqual({ access_token: 'at-9' })
    expect(r.entry()?.account).toBe('grace')
  })

  it('clears only the provider\'s declared names', async () => {
    const r = rig()
    await r.signIn({ secrets: { access_token: 'at-1', refresh_token: 'rt-1' } })
    await providersHandlers.upsert(
      { id: ID, config: { ...r.entry()!, secrets: { extra: 'kept' } } },
      r.upsertDeps,
    )
    await r.signIn({ secrets: { access_token: 'at-2' } })
    expect(r.stored()).toEqual({ access_token: 'at-2', extra: 'kept' })
  })

  it('after a sign-out starts from nothing: a name the new sign-in leaves out is not the old one', async () => {
    const r = rig()
    await r.signIn({ secrets: { access_token: 'at-1', refresh_token: 'rt-1' }, account: 'ada' })
    await r.service.signOut(ID)
    expect(r.stored()).toEqual({})
    await r.signIn({ secrets: { access_token: 'at-9' }, account: 'grace' })
    expect(r.stored()).toEqual({ access_token: 'at-9' })
  })
})
