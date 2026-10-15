import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { WorkingState } from '../runtime/RuntimeTypes'
import type { RuntimeFs } from '../utils/fs/runtimeFs'
import type { BrowserBridgeRequest } from '../browser/bridge/protocol'
import {
  __resetFeatureRegistryForTests,
  registerFeature,
} from '../skillLibrary/builtinSkills'
import {
  featuresHandlers,
  handleFeaturesBridgeRequest,
  seedAppStateFromSettings,
} from '../browser/bridge/adapter/featuresBridgeAdapter'
import {
  NEXUS_SETTINGS_FILE_NAME,
  wipeSettingsMemos,
} from '../settings/settingsStore'

function makeMemoryFs(initial: Record<string, string> = {}) {
  const files = new Map<string, string>(Object.entries(initial))
  const fs: Partial<RuntimeFs> = {
    readFile: vi.fn(async (path: string) => {
      const content = files.get(path)
      if (content === undefined) {
        const err = new Error(`ENOENT: ${path}`) as Error & { code?: string }
        err.code = 'ENOENT'
        throw err
      }
      return content
    }),
    writeFile: vi.fn(async (path: string, data: string | Uint8Array) => {
      files.set(path, typeof data === 'string' ? data : new TextDecoder().decode(data))
    }),
    mkdir: vi.fn(async () => {}),
  }
  return { fs: fs as RuntimeFs, files }
}

function makeAdapterCtx(opts: {
  homeDir?: string
  fs: RuntimeFs
}) {
  let appState: WorkingState = {
    permissionRules: { mode: 'default' },
    enabledFeatures: {},
  } as never as WorkingState
  return {
    ctx: {
      homeDir: opts.homeDir ?? '/home/user',
      fs: opts.fs,
      setAppState: (updater: (prev: WorkingState) => WorkingState) => {
        appState = updater(appState)
      },
    },
    getAppState: () => appState,
  }
}

beforeEach(() => {
  __resetFeatureRegistryForTests()
  // Settings cache is module-global — reset between tests so a cached
  // result from one fs fixture doesn't leak into the next.
  wipeSettingsMemos()
})

describe('featuresHandlers.catalog', () => {
  it('returns the sorted catalog snapshot + registryVersion', async () => {
    registerFeature({ id: 'b', title: 'B', description: '', default: true })
    registerFeature({ id: 'a', title: 'A', description: '', default: false })
    const result = await featuresHandlers.catalog()
    expect(result.features.map(f => f.id)).toEqual(['a', 'b'])
    expect(typeof result.registryVersion).toBe('string')
    expect(result.registryVersion.length).toBeGreaterThan(0)
  })
})

describe('featuresHandlers.snapshot', () => {
  it('returns the file contents when present', async () => {
    const { fs } = makeMemoryFs({
      [`/home/user/.velloc/${NEXUS_SETTINGS_FILE_NAME}`]: JSON.stringify({
        version: 1,
        features: { 'a.b': true },
      }),
    })
    const { ctx } = makeAdapterCtx({ fs })
    const result = await featuresHandlers.snapshot(ctx)
    expect(result.source).toBe('file')
    expect(result.enabled).toEqual({ 'a.b': true })
  })

  it("returns defaults + source: 'default' when the file is missing", async () => {
    const { fs } = makeMemoryFs()
    const { ctx } = makeAdapterCtx({ fs })
    const result = await featuresHandlers.snapshot(ctx)
    expect(result.source).toBe('default')
    expect(result.enabled).toEqual({})
  })
})

describe('featuresHandlers.setEnabled', () => {
  it('writes the patch + flips WorkingState live', async () => {
    const { fs, files } = makeMemoryFs()
    const { ctx, getAppState } = makeAdapterCtx({ fs })
    const result = await featuresHandlers.setEnabled(
      { patch: { 'a.b': true, 'c.d': false } },
      ctx,
    )
    expect(result.ok).toBe(true)
    expect(result.effective).toEqual({ 'a.b': true, 'c.d': false })
    // WorkingState reflects it immediately.
    expect(getAppState().enabledFeatures).toEqual({
      'a.b': true,
      'c.d': false,
    })
    // File on disk reflects it.
    expect(
      JSON.parse(files.get(`/home/user/.velloc/${NEXUS_SETTINGS_FILE_NAME}`)!)
        .features,
    ).toEqual({ 'a.b': true, 'c.d': false })
  })

  it('a null value clears the entry (reverts to default)', async () => {
    const { fs, files } = makeMemoryFs({
      [`/home/user/.velloc/${NEXUS_SETTINGS_FILE_NAME}`]: JSON.stringify({
        version: 1,
        features: { 'a.b': true, 'c.d': false },
      }),
    })
    const { ctx } = makeAdapterCtx({ fs })
    const result = await featuresHandlers.setEnabled({ patch: { 'a.b': null } }, ctx)
    expect(result.effective).toEqual({ 'c.d': false })
    expect(
      JSON.parse(files.get(`/home/user/.velloc/${NEXUS_SETTINGS_FILE_NAME}`)!)
        .features,
    ).toEqual({ 'c.d': false })
  })

  it('silently drops malformed values (a misbehaving caller does not break the whole patch)', async () => {
    const { fs } = makeMemoryFs()
    const { ctx } = makeAdapterCtx({ fs })
    // Construct via `unknown` cast so a misbehaving caller's type-violating
    // payload reaches the handler at runtime — the production guard against
    // it lives inside `handleSetEnabled`, not at the TS boundary.
    const patch = { good: true, bad: 'string-value' } as unknown as Record<
      string,
      boolean | null
    >
    const result = await featuresHandlers.setEnabled({ patch }, ctx)
    expect(result.effective).toEqual({ good: true })
  })
})

describe('handleFeaturesBridgeRequest', () => {
  function makeRequest(
    action: 'catalog' | 'snapshot' | 'setEnabled',
    payload: unknown = {},
    id = 'req-1',
  ): BrowserBridgeRequest {
    return {
      id,
      route: { namespace: 'nexus', capability: 'features', action },
      payload: payload as never,
    } as never as BrowserBridgeRequest
  }

  it('routes catalog → ok envelope with features', async () => {
    registerFeature({ id: 'x', title: '', description: '', default: true })
    const { fs } = makeMemoryFs()
    const { ctx } = makeAdapterCtx({ fs })
    const response = await handleFeaturesBridgeRequest(makeRequest('catalog'), ctx)
    expect(response.ok).toBe(true)
    expect(response.id).toBe('req-1')
    if (response.ok) {
      expect((response.result as { features: unknown[] }).features).toHaveLength(1)
    }
  })

  it('routes snapshot → ok envelope', async () => {
    const { fs } = makeMemoryFs()
    const { ctx } = makeAdapterCtx({ fs })
    const response = await handleFeaturesBridgeRequest(makeRequest('snapshot'), ctx)
    expect(response.ok).toBe(true)
    if (response.ok) {
      expect((response.result as { source: string }).source).toBe('default')
    }
  })

  it('routes setEnabled → ok envelope + side effects', async () => {
    const { fs, files } = makeMemoryFs()
    const { ctx, getAppState } = makeAdapterCtx({ fs })
    const response = await handleFeaturesBridgeRequest(
      makeRequest('setEnabled', { patch: { 'a': true } }),
      ctx,
    )
    expect(response.ok).toBe(true)
    expect(files.size).toBe(1)
    expect(getAppState().enabledFeatures).toEqual({ a: true })
  })

  it('returns unknown_action for a non-existent action', async () => {
    const { fs } = makeMemoryFs()
    const { ctx } = makeAdapterCtx({ fs })
    const response = await handleFeaturesBridgeRequest(
      // @ts-expect-error — deliberately invalid action
      makeRequest('does-not-exist'),
      ctx,
    )
    expect(response.ok).toBe(false)
    if (!response.ok) {
      expect(response.error.code).toBe('unknown_action')
    }
  })

  it('catches handler errors → features_handler_error envelope', async () => {
    const { fs } = makeMemoryFs()
    // Make writeFile throw to simulate disk failure.
    ;(fs.writeFile as ReturnType<typeof vi.fn>).mockImplementation(async () => {
      throw new Error('disk full')
    })
    const { ctx } = makeAdapterCtx({ fs })
    const response = await handleFeaturesBridgeRequest(
      makeRequest('setEnabled', { patch: { 'a': true } }),
      ctx,
    )
    expect(response.ok).toBe(false)
    if (!response.ok) {
      expect(response.error.code).toBe('features_handler_error')
      expect(response.error.message).toContain('disk full')
    }
  })
})

describe('seedAppStateFromSettings', () => {
  it('writes the file features into appState.enabledFeatures', async () => {
    const { fs } = makeMemoryFs({
      [`/home/user/.velloc/${NEXUS_SETTINGS_FILE_NAME}`]: JSON.stringify({
        version: 1,
        features: { 'seeded.feature': true },
      }),
    })
    let appState: WorkingState = {
      permissionRules: { mode: 'default' },
      enabledFeatures: {},
    } as never as WorkingState
    await seedAppStateFromSettings(
      updater => {
        appState = updater(appState)
      },
      { homeDir: '/home/user', fs },
    )
    expect(appState.enabledFeatures).toEqual({ 'seeded.feature': true })
  })

  it('leaves enabledFeatures empty when the file is missing', async () => {
    const { fs } = makeMemoryFs()
    let appState: WorkingState = {
      permissionRules: { mode: 'default' },
      enabledFeatures: { 'pre.existing': true },
    } as never as WorkingState
    await seedAppStateFromSettings(
      updater => {
        appState = updater(appState)
      },
      { homeDir: '/home/user', fs },
    )
    // No file means we overwrite with {} — the seed function is meant to
    // be authoritative.
    expect(appState.enabledFeatures).toEqual({})
  })
})
