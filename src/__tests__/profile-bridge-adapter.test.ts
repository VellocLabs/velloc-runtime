import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { RuntimeFs } from '../utils/fs/runtimeFs'
import type {
  BrowserBridgeRequest,
  BrowserBridgeRoute,
} from '../browser/bridge/protocol'
import {
  NEXUS_SETTINGS_FILE_NAME,
  wipeSettingsMemos,
} from '../settings/settingsStore'
import {
  profileHandlers,
  handleProfileBridgeRequest,
} from '../browser/bridge/adapter/profileBridgeAdapter'

/**
 * Unit-level pinning for the `profile` capability handlers (the General
 * settings page). Mirrors `agent-bridge-adapter.test.ts` so the migration
 * story stays uniform across capabilities.
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
      files.set(path, typeof data === 'string' ? data : new TextDecoder().decode(data))
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

describe('profileHandlers.snapshot', () => {
  it('returns unset defaults when no settings file exists', async () => {
    const { fs } = makeMemoryFs()
    const result = await profileHandlers.snapshot({ homeDir: HOME, fs })
    expect(result.values).toEqual({
      fullName: '',
      callName: '',
      workRole: '',
    })
    expect(result.source).toBe('default')
  })

  it('returns stored profile values merged over defaults', async () => {
    const { fs } = makeMemoryFs({
      [SETTINGS_PATH]: JSON.stringify({
        version: 1,
        profile: {
          fullName: 'Ada Lovelace',
          // Legacy key from a build that still had a settings-backed
          // instruction store. It must NOT come back — instructions live
          // in `VELLOC.md` now, and a resurfaced value here would be a
          // second store the model is never told about.
          instructions: 'Be concise.',
          workRole: 'engineering',
        },
      }),
    })
    const result = await profileHandlers.snapshot({ homeDir: HOME, fs })
    expect(result.values).toEqual({
      fullName: 'Ada Lovelace', // stored
      callName: '', // unset → default
      workRole: 'engineering', // stored
    })
    expect(result.values).not.toHaveProperty('instructions')
    expect(result.source).toBe('file')
  })
})

describe('profileHandlers.setField', () => {
  it('writes a new field and echoes the effective values', async () => {
    const { fs, files } = makeMemoryFs()
    const result = await profileHandlers.setField(
      { patch: { fullName: 'Grace Hopper' } },
      { homeDir: HOME, fs },
    )
    expect(result.ok).toBe(true)
    expect(result.values.fullName).toBe('Grace Hopper')
    expect(JSON.parse(files.get(SETTINGS_PATH)!)).toEqual({
      version: 1,
      profile: { fullName: 'Grace Hopper' },
    })
  })

  /**
   * A legacy `profile.instructions` on disk is dropped by the settings
   * sanitizer, and writing an unrelated field must not carry it forward:
   * the merge reads the SANITIZED prior value, so the stale key is gone
   * after the next write instead of lingering as an inert field.
   */
  it('drops a legacy instructions key instead of round-tripping it', async () => {
    const { fs, files } = makeMemoryFs({
      [SETTINGS_PATH]: JSON.stringify({
        version: 1,
        profile: { instructions: 'Prefer TypeScript.', fullName: 'Ada' },
      }),
    })
    const result = await profileHandlers.setField(
      { patch: { callName: 'Ada' } },
      { homeDir: HOME, fs },
    )
    expect(result.values).not.toHaveProperty('instructions')
    expect(JSON.parse(files.get(SETTINGS_PATH)!).profile).toEqual({
      fullName: 'Ada',
      callName: 'Ada',
    })
  })

  it('null clears a field (reverts to the unset default)', async () => {
    const { fs, files } = makeMemoryFs({
      [SETTINGS_PATH]: JSON.stringify({
        version: 1,
        profile: { fullName: 'Ada', workRole: 'engineering' },
      }),
    })
    const result = await profileHandlers.setField(
      { patch: { fullName: null } },
      { homeDir: HOME, fs },
    )
    expect(result.values.fullName).toBe('') // reverted to default
    expect(result.values.workRole).toBe('engineering') // unchanged
    expect(JSON.parse(files.get(SETTINGS_PATH)!).profile).toEqual({
      workRole: 'engineering',
    })
  })

  it('an empty string clears a field too (keeps settings.json sparse)', async () => {
    const { fs, files } = makeMemoryFs({
      [SETTINGS_PATH]: JSON.stringify({
        version: 1,
        profile: { callName: 'Ada' },
      }),
    })
    await profileHandlers.setField(
      { patch: { callName: '' } },
      { homeDir: HOME, fs },
    )
    const persisted = JSON.parse(files.get(SETTINGS_PATH)!)
    expect(persisted.profile).toBeUndefined() // section dropped
    expect(persisted.version).toBe(1)
  })

  it('a legacy safeCodeExperimental key on disk is dropped, not carried forward', async () => {
    // The "SafeCode (Experimental)" toggle was removed from Settings → General
    // along with the field; a settings.json written by an older build may
    // still carry `profile.safeCodeExperimental: true`, which used to make
    // the launcher-hidden safe_code type visible in the sidebar. The sanitizer
    // drops the key here so the old value can no longer unhide it.
    const { fs, files } = makeMemoryFs({
      [SETTINGS_PATH]: JSON.stringify({
        version: 1,
        profile: { safeCodeExperimental: true, fullName: 'Ada' },
      }),
    })
    const result = await profileHandlers.snapshot({ homeDir: HOME, fs })
    expect(result.values).not.toHaveProperty('safeCodeExperimental')
    // Writing an unrelated field drops the stale key from disk too (the
    // merge reads the SANITIZED prior value — same pattern as the legacy
    // `instructions` key above).
    await profileHandlers.setField(
      { patch: { callName: 'Ada' } },
      { homeDir: HOME, fs },
    )
    expect(JSON.parse(files.get(SETTINGS_PATH)!).profile).toEqual({
      fullName: 'Ada',
      callName: 'Ada',
    })
  })

  it('multiple fields in one patch are applied together', async () => {
    const { fs, files } = makeMemoryFs()
    const result = await profileHandlers.setField(
      {
        patch: {
          fullName: 'Ada',
          workRole: 'engineering',
          callName: 'Ada L.',
        },
      },
      { homeDir: HOME, fs },
    )
    expect(result.values.fullName).toBe('Ada')
    expect(result.values.workRole).toBe('engineering')
    expect(result.values.callName).toBe('Ada L.')
    expect(JSON.parse(files.get(SETTINGS_PATH)!).profile).toEqual({
      fullName: 'Ada',
      workRole: 'engineering',
      callName: 'Ada L.',
    })
  })

  it('fires broadcastChanged with the effective values after a write', async () => {
    const { fs } = makeMemoryFs()
    const broadcastChanged = vi.fn()
    await profileHandlers.setField(
      { patch: { fullName: 'Ada' } },
      { homeDir: HOME, fs, broadcastChanged },
    )
    expect(broadcastChanged).toHaveBeenCalledTimes(1)
    expect(broadcastChanged).toHaveBeenCalledWith({
      values: {
        fullName: 'Ada',
        callName: '',
        workRole: '',
      },
    })
  })

  it('serializes concurrent sparse writes so one profile field cannot clobber another', async () => {
    let releaseFirstRead: (() => void) | undefined
    const firstReadGate = new Promise<void>(resolve => {
      releaseFirstRead = resolve
    })
    let readCount = 0
    const { fs, files } = makeMemoryFs({
      [SETTINGS_PATH]: JSON.stringify({ version: 1 }),
    })
    ;(fs.readFile as ReturnType<typeof vi.fn>).mockImplementation(async (path: string) => {
      readCount += 1
      if (readCount === 1) {
        await firstReadGate
      }
      const content = files.get(path)
      if (content === undefined) {
        const err = new Error(`ENOENT: ${path}`) as Error & { code?: string }
        err.code = 'ENOENT'
        throw err
      }
      return content
    })

    const first = profileHandlers.setField(
      { patch: { fullName: 'Ada Lovelace' } },
      { homeDir: HOME, fs },
    )
    const second = profileHandlers.setField(
      { patch: { workRole: 'engineering' } },
      { homeDir: HOME, fs },
    )

    releaseFirstRead?.()
    const [firstResult, secondResult] = await Promise.all([first, second])

    expect(firstResult.values.fullName).toBe('Ada Lovelace')
    expect(secondResult.values.fullName).toBe('Ada Lovelace')
    expect(secondResult.values.workRole).toBe('engineering')
    expect(JSON.parse(files.get(SETTINGS_PATH)!).profile).toEqual({
      fullName: 'Ada Lovelace',
      workRole: 'engineering',
    })
  })
})

describe('handleProfileBridgeRequest', () => {
  function makeRequest(
    action: 'snapshot' | 'setField',
    payload: unknown = {},
    id = 'req-1',
  ): BrowserBridgeRequest {
    return {
      id,
      route: {
        namespace: 'nexus',
        capability: 'profile',
        action,
      } as unknown as BrowserBridgeRoute,
      payload: payload as never,
    }
  }

  it('routes snapshot → ok envelope', async () => {
    const { fs } = makeMemoryFs()
    const response = await handleProfileBridgeRequest(makeRequest('snapshot'), {
      homeDir: HOME,
      fs,
    })
    expect(response.ok).toBe(true)
    if (response.ok) {
      const result = response.result as {
        values: { fullName: string }
        source: string
      }
      expect(result.values.fullName).toBe('')
      expect(result.source).toBe('default')
    }
  })

  it('routes setField → ok envelope + persists', async () => {
    const { fs, files } = makeMemoryFs()
    const response = await handleProfileBridgeRequest(
      makeRequest('setField', { patch: { fullName: 'Ada' } }),
      { homeDir: HOME, fs },
    )
    expect(response.ok).toBe(true)
    expect(JSON.parse(files.get(SETTINGS_PATH)!).profile).toEqual({
      fullName: 'Ada',
    })
  })

  it('returns unknown_action for a bad action name', async () => {
    const { fs } = makeMemoryFs()
    const response = await handleProfileBridgeRequest(
      // @ts-expect-error — deliberately invalid
      makeRequest('does-not-exist'),
      { homeDir: HOME, fs },
    )
    expect(response.ok).toBe(false)
    if (!response.ok) {
      expect(response.error.code).toBe('unknown_action')
    }
  })

  it('catches handler errors → profile_handler_error envelope', async () => {
    const { fs } = makeMemoryFs()
    ;(fs.writeFile as ReturnType<typeof vi.fn>).mockImplementation(async () => {
      throw new Error('disk full')
    })
    const response = await handleProfileBridgeRequest(
      makeRequest('setField', { patch: { fullName: 'Ada' } }),
      { homeDir: HOME, fs },
    )
    expect(response.ok).toBe(false)
    if (!response.ok) {
      expect(response.error.code).toBe('profile_handler_error')
      expect(response.error.message).toContain('disk full')
    }
  })
})
