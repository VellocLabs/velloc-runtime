import { beforeEach, describe, expect, it } from 'vitest'
import { providersHandlers } from '../browser/bridge/adapter/providersBridgeAdapter'
import { NEXUS_SETTINGS_FILE_NAME, wipeSettingsMemos } from '../settings/settingsStore'
import type { RuntimeFs } from '../utils/fs/runtimeFs'

/**
 * PM-7: `tokenExpiresAt` is a settings.json field of a provider entry (when the
 * stored sign-in token stops working), through the write path and the loader's
 * allow-list; a malformed one is refused on write and dropped on read.
 */

const HOME = '/home/u'
const ID = 'mod.acme.sso'
const SETTINGS = `${HOME}/.velloc/${NEXUS_SETTINGS_FILE_NAME}`

function memoryFs() {
  const files = new Map<string, string>()
  const fs = {
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
  return { fs, files }
}

describe('tokenExpiresAt in settings.json', () => {
  beforeEach(() => wipeSettingsMemos())

  it('round-trips with source, modVersion, modOwner, account and signedIn through a write and a fresh read', async () => {
    const { fs, files } = memoryFs()
    const config = { source: 'mod' as const, modVersion: '2.0.0', modOwner: 'zed@shop', account: 'zed', signedIn: true as const, tokenExpiresAt: 1_900_000_000_000 }
    await providersHandlers.upsert({ id: ID, config }, { homeDir: HOME, fs })
    expect(JSON.parse(files.get(SETTINGS)!).providers.configs[ID]).toEqual(config)
    wipeSettingsMemos()
    expect((await providersHandlers.list({ homeDir: HOME, fs })).configs[ID]).toEqual(config)
  })

  it('an upsert without it clears it (the entry is replaced whole)', async () => {
    const { fs } = memoryFs()
    await providersHandlers.upsert({ id: ID, config: { source: 'mod', account: 'zed', tokenExpiresAt: 1_900_000_000_000 } }, { homeDir: HOME, fs })
    await providersHandlers.upsert({ id: ID, config: { source: 'mod', account: 'zed' } }, { homeDir: HOME, fs })
    wipeSettingsMemos()
    expect((await providersHandlers.list({ homeDir: HOME, fs })).configs[ID]!.tokenExpiresAt).toBeUndefined()
  })

  it('refuses a non-number or non-positive value on write, and drops one on load', async () => {
    const { fs, files } = memoryFs()
    for (const bad of ['soon', 0, -5, Number.NaN, Infinity]) {
      await expect(
        providersHandlers.upsert({ id: ID, config: { source: 'mod', tokenExpiresAt: bad as never } }, { homeDir: HOME, fs }),
        String(bad),
      ).rejects.toThrow(/tokenExpiresAt/)
    }
    await providersHandlers.upsert({ id: ID, config: { source: 'mod', account: 'zed' } }, { homeDir: HOME, fs })
    const doc = JSON.parse(files.get(SETTINGS)!)
    doc.providers.configs[ID].tokenExpiresAt = 'tomorrow'
    files.set(SETTINGS, JSON.stringify(doc))
    wipeSettingsMemos()
    expect((await providersHandlers.list({ homeDir: HOME, fs })).configs[ID]).toEqual({ source: 'mod', account: 'zed' })
  })
})
