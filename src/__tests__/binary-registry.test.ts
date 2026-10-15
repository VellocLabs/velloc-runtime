import { readFileSync } from 'node:fs'
import { describe, it, expect, beforeEach, vi } from 'vitest'
import {
  validateManagedBinaryRegistry,
  resolveManagedBinariesUrl,
  fetchManagedBinaryRegistry,
  __resetBinaryRegistryCacheForTests,
  type ManagedBinaryRegistryWire,
} from '../utils/binaryRegistry'

const VALID_ASSET = {
  platform: 'win32',
  arch: 'x64',
  url: 'https://example.test/rg.zip',
  sha256: 'd0f534024c42afd6cb4d38907c25cd2b249b79bbe6cc1dbee8e3e37c2b6e25a1',
  format: 'zip',
  member: 'pkg/rg.exe',
}

function makeResponse(body: unknown, ok = true): Response {
  return {
    ok,
    json: async () => body,
  } as unknown as Response
}

describe('validateManagedBinaryRegistry', () => {
  it('accepts a well-formed registry', () => {
    const { registry, errors } = validateManagedBinaryRegistry({
      binaries: [{ id: 'rg', label: 'ripgrep', version: '1.0', assets: [VALID_ASSET] }],
    })
    expect(errors).toEqual([])
    expect(registry?.binaries).toHaveLength(1)
    expect(registry?.binaries[0]!.assets[0]!.url).toBe(VALID_ASSET.url)
  })

  it('drops individual malformed assets but keeps valid ones', () => {
    const { registry } = validateManagedBinaryRegistry({
      binaries: [
        {
          id: 'rg',
          assets: [
            { ...VALID_ASSET, sha256: 'nothex' }, // bad sha
            { ...VALID_ASSET, url: 'http://insecure/rg.zip' }, // not https
            { ...VALID_ASSET, platform: 'plan9' }, // bad platform
            { ...VALID_ASSET, arch: 'arm64', member: 'pkg/rg2.exe' }, // valid
          ],
        },
      ],
    })
    expect(registry?.binaries[0]!.assets).toHaveLength(1)
    expect(registry?.binaries[0]!.assets[0]!.arch).toBe('arm64')
  })

  it('allows http only for loopback hosts', () => {
    const { registry } = validateManagedBinaryRegistry({
      binaries: [
        {
          id: 'rg',
          assets: [
            { ...VALID_ASSET, url: 'http://127.0.0.1:8080/rg.zip' }, // ok
            { ...VALID_ASSET, arch: 'arm64', url: 'http://localhost/rg.zip', member: 'a' }, // ok
            { ...VALID_ASSET, platform: 'linux', url: 'http://evil.example/rg.zip', member: 'b' }, // not loopback
          ],
        },
      ],
    })
    expect(registry?.binaries[0]!.assets).toHaveLength(2)
    expect(registry?.binaries[0]!.assets.every(a => a.url.includes('127.0.0.1') || a.url.includes('localhost'))).toBe(true)
  })

  it('drops a binary with no valid assets', () => {
    const { registry } = validateManagedBinaryRegistry({
      binaries: [{ id: 'rg', assets: [{ ...VALID_ASSET, sha256: 'x' }] }],
    })
    expect(registry).toBeNull()
  })

  it('rejects a non-object / shapeless root', () => {
    expect(validateManagedBinaryRegistry(null).registry).toBeNull()
    expect(validateManagedBinaryRegistry({ nope: true }).registry).toBeNull()
    expect(validateManagedBinaryRegistry({ binaries: 'x' }).registry).toBeNull()
  })
})

describe('shipped public/managed-binaries.json', () => {
  // ripgrep ships with the installer next to chrome.dll; the online registry
  // must not publish a download for it (the host would fetch it when rg is
  // missing from both the version dir and PATH).
  it('publishes no rg download', () => {
    const raw = JSON.parse(
      readFileSync(new URL('../../public/managed-binaries.json', import.meta.url), 'utf8'),
    ) as { binaries: Array<{ id: string }> }
    expect(raw.binaries.map((b) => b.id)).not.toContain('rg')
    expect(validateManagedBinaryRegistry(raw).errors).toEqual([])
  })
})

describe('resolveManagedBinariesUrl', () => {
  it('builds a same-origin URL', () => {
    expect(resolveManagedBinariesUrl('https://app.velloc.app')).toBe(
      'https://app.velloc.app/managed-binaries.json',
    )
  })
  it('returns null without an origin', () => {
    expect(resolveManagedBinariesUrl('')).toBeNull()
  })
})

describe('fetchManagedBinaryRegistry', () => {
  beforeEach(() => __resetBinaryRegistryCacheForTests())

  const good: ManagedBinaryRegistryWire = {
    binaries: [{ id: 'rg', assets: [VALID_ASSET as never] }],
  }

  it('fetches + validates from the same origin', async () => {
    const fetchImpl = vi.fn(async () => makeResponse(good))
    const reg = await fetchManagedBinaryRegistry({
      fetchImpl: fetchImpl as unknown as typeof fetch,
      origin: 'https://app.velloc.app',
      now: () => 1000,
    })
    expect(reg?.binaries[0]!.id).toBe('rg')
    expect(fetchImpl).toHaveBeenCalledWith(
      'https://app.velloc.app/managed-binaries.json',
      expect.objectContaining({ credentials: 'omit' }),
    )
  })

  it('returns null on a non-OK response', async () => {
    const fetchImpl = vi.fn(async () => makeResponse({}, false))
    const reg = await fetchManagedBinaryRegistry({
      fetchImpl: fetchImpl as unknown as typeof fetch,
      origin: 'https://app.velloc.app',
      now: () => 1000,
    })
    expect(reg).toBeNull()
  })

  it('returns null (no throw) when fetch rejects', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error('network down')
    })
    const reg = await fetchManagedBinaryRegistry({
      fetchImpl: fetchImpl as unknown as typeof fetch,
      origin: 'https://app.velloc.app',
      now: () => 1000,
    })
    expect(reg).toBeNull()
  })

  it('caches within the TTL (no second fetch)', async () => {
    const fetchImpl = vi.fn(async () => makeResponse(good))
    const opts = {
      fetchImpl: fetchImpl as unknown as typeof fetch,
      origin: 'https://app.velloc.app',
      now: () => 5000,
    }
    await fetchManagedBinaryRegistry(opts)
    await fetchManagedBinaryRegistry(opts)
    expect(fetchImpl).toHaveBeenCalledTimes(1)
  })

  it('returns null without an origin', async () => {
    const fetchImpl = vi.fn(async () => makeResponse(good))
    const reg = await fetchManagedBinaryRegistry({
      fetchImpl: fetchImpl as unknown as typeof fetch,
      origin: '',
      now: () => 1000,
    })
    expect(reg).toBeNull()
    expect(fetchImpl).not.toHaveBeenCalled()
  })
})
