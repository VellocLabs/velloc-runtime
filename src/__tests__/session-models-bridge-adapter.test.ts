import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { RuntimeFs } from '../utils/fs/runtimeFs'
import type { BrowserBridgeRequest } from '../browser/bridge/protocol'
import {
  NEXUS_SETTINGS_FILE_NAME,
  wipeSettingsMemos,
} from '../settings/settingsStore'
import {
  sessionModelsHandlers,
  handleSessionModelsBridgeRequest,
} from '../browser/bridge/adapter/sessionModelsBridgeAdapter'
import {
  recordPinCandidateFailure,
  resetPinFailureLog,
} from '../models/pinFailureLog'
import {
  resetSessionModelSettingsSnapshot,
  setSessionModelSettingsSnapshot,
} from '../models/tierSettingsSnapshot'

/**
 * Unit-level pinning for the `sessionModels` capability handlers (the
 * Settings → Session models page). Mirrors `memory-bridge-adapter.test.ts`.
 * The sections are SPARSE: snapshot always presents both keys (empty objects
 * when unset) so the form binds; setField re-validates through the shared
 * normalizers, so malformed patch entries drop instead of persisting.
 */

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
      files.set(
        path,
        typeof data === 'string' ? data : new TextDecoder().decode(data),
      )
    }),
    mkdir: vi.fn(async () => {}),
  }
  return { fs: fs as RuntimeFs, files }
}

const HOME = '/home/test'
const SETTINGS_PATH = `${HOME}/.velloc/${NEXUS_SETTINGS_FILE_NAME}`

beforeEach(() => {
  wipeSettingsMemos()
})

describe('sessionModelsHandlers.snapshot', () => {
  it('returns empty sections + source "default" when nothing is configured', async () => {
    const { fs } = makeMemoryFs()
    const result = await sessionModelsHandlers.snapshot({ homeDir: HOME, fs })
    expect(result.values).toEqual({ modelTiers: {}, sessionModelPolicy: {} })
    expect(result.source).toBe('default')
  })

  it('returns the stored sections as-is with source "file"', async () => {
    const { fs } = makeMemoryFs({
      [SETTINGS_PATH]: JSON.stringify({
        version: 1,
        modelTiers: {
          fast: { providerId: 'deepseek', modelId: 'deepseek-v4-flash' },
        },
        sessionModelPolicy: {
          compact: { mode: 'same-as-parent' },
        },
      }),
    })
    const result = await sessionModelsHandlers.snapshot({ homeDir: HOME, fs })
    expect(result.values).toEqual({
      modelTiers: {
        fast: { providerId: 'deepseek', modelId: 'deepseek-v4-flash' },
      },
      sessionModelPolicy: { compact: { mode: 'same-as-parent' } },
    })
    expect(result.source).toBe('file')
  })
})

describe('sessionModelsHandlers.setField', () => {
  it('merges pins/policies, clears with null, and fires broadcastChanged with the new values', async () => {
    const { fs } = makeMemoryFs({
      [SETTINGS_PATH]: JSON.stringify({
        version: 1,
        modelTiers: {
          fast: { providerId: 'deepseek', modelId: 'deepseek-v4-flash' },
        },
        sessionModelPolicy: { compact: { mode: 'same-as-parent' } },
      }),
    })
    const broadcasts: unknown[] = []
    const result = await sessionModelsHandlers.setField(
      {
        patch: {
          modelTiers: {
            best: {
              providerId: 'anthropic',
              modelId: 'claude-fable-5',
              thinkingTier: 'max',
            },
          },
          sessionModelPolicy: {
            compact: null,
            session_title: { mode: 'tier', tier: 'balanced' },
          },
        },
      },
      {
        homeDir: HOME,
        fs,
        broadcastChanged: p => broadcasts.push(p),
      },
    )
    expect(result.ok).toBe(true)
    expect(result.values).toEqual({
      modelTiers: {
        fast: { providerId: 'deepseek', modelId: 'deepseek-v4-flash' },
        best: {
          providerId: 'anthropic',
          modelId: 'claude-fable-5',
          thinkingTier: 'max',
        },
      },
      sessionModelPolicy: {
        session_title: { mode: 'tier', tier: 'balanced' },
      },
    })
    expect(broadcasts).toEqual([{ values: result.values }])
  })

  it('drops malformed patch entries via the shared normalizers instead of persisting them', async () => {
    const { fs, files } = makeMemoryFs()
    const result = await sessionModelsHandlers.setField(
      {
        patch: {
          modelTiers: {
            // missing modelId → dropped
            fast: { providerId: 'deepseek' } as never,
          },
          sessionModelPolicy: {
            // unknown tier → dropped
            compact: { mode: 'tier', tier: 'hyper' } as never,
            // valid — must survive
            web_fetch: { mode: 'same-as-parent' },
          },
        },
      },
      { homeDir: HOME, fs },
    )
    expect(result.values).toEqual({
      modelTiers: {},
      sessionModelPolicy: { web_fetch: { mode: 'same-as-parent' } },
    })
    const onDisk = JSON.parse(files.get(SETTINGS_PATH) ?? '{}') as Record<
      string,
      unknown
    >
    expect('modelTiers' in onDisk).toBe(false)
    expect(onDisk.sessionModelPolicy).toEqual({
      web_fetch: { mode: 'same-as-parent' },
    })
  })
})

describe('pin health through the bridge', () => {
  afterEach(() => {
    resetPinFailureLog()
    resetSessionModelSettingsSnapshot()
  })

  it('snapshot carries the runtime pin health; setField clears the patched keys', async () => {
    const { fs } = makeMemoryFs({
      [SETTINGS_PATH]: JSON.stringify({
        version: 1,
        modelTiers: {
          fast: { providerId: 'deepseek', modelId: 'ds-flash' },
          best: { providerId: 'anthropic', modelId: 'claude-fable-5' },
        },
      }),
    })
    // Mirror the runtime: the realm snapshot holds the pins the failure
    // sites attribute against.
    setSessionModelSettingsSnapshot({
      modelTiers: {
        fast: { providerId: 'deepseek', modelId: 'ds-flash' },
        best: { providerId: 'anthropic', modelId: 'claude-fable-5' },
      },
    })
    recordPinCandidateFailure(
      { providerId: 'deepseek', modelId: 'ds-flash' },
      'invalid api key',
    )
    recordPinCandidateFailure(
      { providerId: 'anthropic', modelId: 'claude-fable-5' },
      'quota exceeded',
    )

    const snap = await sessionModelsHandlers.snapshot({ homeDir: HOME, fs })
    expect(snap.pinHealth.modelTiers.fast).toMatchObject({
      count: 1,
      lastError: 'invalid api key',
    })
    expect(snap.pinHealth.modelTiers.best).toMatchObject({ count: 1 })

    // Editing (or clearing) a pin clears ITS health — the other survives.
    await sessionModelsHandlers.setField(
      { patch: { modelTiers: { fast: null } } },
      { homeDir: HOME, fs },
    )
    const after = await sessionModelsHandlers.snapshot({ homeDir: HOME, fs })
    expect(after.pinHealth.modelTiers.fast).toBeUndefined()
    expect(after.pinHealth.modelTiers.best).toMatchObject({ count: 1 })
  })
})

describe('handleSessionModelsBridgeRequest', () => {
  it('wraps handlers in the standard envelope and rejects unknown actions', async () => {
    const { fs } = makeMemoryFs()
    const ok = await handleSessionModelsBridgeRequest(
      {
        id: 'r1',
        route: {
          namespace: 'nexus',
          capability: 'sessionModels',
          action: 'snapshot',
        },
        payload: {},
      } as unknown as BrowserBridgeRequest,
      { homeDir: HOME, fs },
    )
    expect(ok.ok).toBe(true)

    const bad = await handleSessionModelsBridgeRequest(
      {
        id: 'r2',
        route: {
          namespace: 'nexus',
          capability: 'sessionModels',
          action: 'nope',
        },
        payload: {},
      } as unknown as BrowserBridgeRequest,
      { homeDir: HOME, fs },
    )
    expect(bad.ok).toBe(false)
    if (!bad.ok) {
      expect(bad.error.code).toBe('unknown_action')
    }
  })
})
