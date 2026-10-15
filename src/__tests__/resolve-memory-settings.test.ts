import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { RuntimeFs } from '../utils/fs/runtimeFs'
import {
  NEXUS_LOCAL_SETTINGS_FILE_NAME,
  NEXUS_SETTINGS_FILE_NAME,
  wipeSettingsMemos,
} from '../settings/settingsStore'
import { resolveMemorySettings } from '../memory/resolveMemorySettings'
import { parseMemoryMaintenance } from '../memory/memoryPaths'

/**
 * Pins the provenance rule for `resolveMemorySettings`: the three toggles may
 * come from the merged effective settings (project scope allowed), but
 * `directory` is read from TRUSTED sources only — `projectSettings` is
 * EXCLUDED so a checked-in repo `.velloc/settings.json` can't redirect the
 * agent's memory writes to an arbitrary path.
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
    writeFile: vi.fn(async () => {}),
    mkdir: vi.fn(async () => {}),
  }
  return fs as RuntimeFs
}

const HOME = '/home/user'
const PROJECT = '/home/user/project'
const USER_PATH = `${HOME}/.velloc/${NEXUS_SETTINGS_FILE_NAME}`
const PROJECT_PATH = `${PROJECT}/.velloc/${NEXUS_SETTINGS_FILE_NAME}`
const LOCAL_PATH = `${PROJECT}/.velloc/${NEXUS_LOCAL_SETTINGS_FILE_NAME}`

beforeEach(() => {
  wipeSettingsMemos()
})

describe('resolveMemorySettings', () => {
  it('returns an empty snapshot when no settings exist', async () => {
    const fs = makeMemoryFs()
    const resolved = await resolveMemorySettings({ homeDir: HOME }, fs)
    expect(resolved).toEqual({})
  })

  it('reads toggles + directory from userSettings', async () => {
    const fs = makeMemoryFs({
      [USER_PATH]: JSON.stringify({
        version: 1,
        autoMemoryEnabled: false,
        memoryRecallEnabled: false,
        autoMemoryDirectory: '/u/mem',
      }),
    })
    const resolved = await resolveMemorySettings({ homeDir: HOME }, fs)
    expect(resolved).toEqual({
      autoMemoryEnabled: false,
      memoryRecallEnabled: false,
      autoMemoryDirectory: '/u/mem',
    })
  })

  it('honors a TOGGLE from projectSettings (project scope allowed)', async () => {
    const fs = makeMemoryFs({
      [PROJECT_PATH]: JSON.stringify({
        version: 1,
        memoryMaintenance: 'periodic',
        autoExtractEnabled: true,
      }),
    })
    const resolved = await resolveMemorySettings(
      { homeDir: HOME, projectRoot: PROJECT },
      fs,
    )
    expect(resolved.memoryMaintenance).toBe('periodic')
    expect(resolved.autoExtractEnabled).toBe(true)
  })

  it('ignores the retired autoDreamEnabled key (no migration)', async () => {
    const fs = makeMemoryFs({
      [USER_PATH]: JSON.stringify({ version: 1, autoDreamEnabled: true }),
    })
    const resolved = await resolveMemorySettings({ homeDir: HOME }, fs)
    expect(resolved.memoryMaintenance).toBeUndefined()
  })

  it('reads the memoryMaintenance enum', async () => {
    const fs = makeMemoryFs({
      [USER_PATH]: JSON.stringify({ version: 1, memoryMaintenance: 'dailyLog' }),
    })
    const resolved = await resolveMemorySettings({ homeDir: HOME }, fs)
    expect(resolved.memoryMaintenance).toBe('dailyLog')
  })

  it('leaves memoryMaintenance undefined when neither key is set', async () => {
    const fs = makeMemoryFs({
      [USER_PATH]: JSON.stringify({ version: 1, autoMemoryEnabled: true }),
    })
    const resolved = await resolveMemorySettings({ homeDir: HOME }, fs)
    expect(resolved.memoryMaintenance).toBeUndefined()
  })

  it('IGNORES autoMemoryDirectory from projectSettings (security — untrusted)', async () => {
    const fs = makeMemoryFs({
      [PROJECT_PATH]: JSON.stringify({
        version: 1,
        autoMemoryEnabled: false,
        autoMemoryDirectory: '/home/user/.ssh',
      }),
    })
    const resolved = await resolveMemorySettings(
      { homeDir: HOME, projectRoot: PROJECT },
      fs,
    )
    // The toggle is honored from projectSettings...
    expect(resolved.autoMemoryEnabled).toBe(false)
    // ...but the directory is NOT (projectSettings is untrusted for it).
    expect(resolved.autoMemoryDirectory).toBeUndefined()
  })

  it('localSettings directory overrides userSettings directory', async () => {
    const fs = makeMemoryFs({
      [USER_PATH]: JSON.stringify({
        version: 1,
        autoMemoryDirectory: '/u/mem',
      }),
      [LOCAL_PATH]: JSON.stringify({
        version: 1,
        autoMemoryDirectory: '/local/mem',
      }),
    })
    const resolved = await resolveMemorySettings(
      { homeDir: HOME, projectRoot: PROJECT },
      fs,
    )
    expect(resolved.autoMemoryDirectory).toBe('/local/mem')
  })

  it('falls back to userSettings directory when localSettings has none', async () => {
    const fs = makeMemoryFs({
      [USER_PATH]: JSON.stringify({
        version: 1,
        autoMemoryDirectory: '/u/mem',
      }),
      [LOCAL_PATH]: JSON.stringify({
        version: 1,
        memoryRecallEnabled: false,
      }),
    })
    const resolved = await resolveMemorySettings(
      { homeDir: HOME, projectRoot: PROJECT },
      fs,
    )
    expect(resolved.autoMemoryDirectory).toBe('/u/mem')
    expect(resolved.memoryRecallEnabled).toBe(false)
  })
})

describe('parseMemoryMaintenance', () => {
  it('returns a valid mode, else undefined', () => {
    expect(parseMemoryMaintenance('dailyLog')).toBe('dailyLog')
    expect(parseMemoryMaintenance('periodic')).toBe('periodic')
    expect(parseMemoryMaintenance('off')).toBe('off')
    expect(parseMemoryMaintenance(undefined)).toBeUndefined()
    expect(parseMemoryMaintenance(true)).toBeUndefined()
    expect(parseMemoryMaintenance('autoDream')).toBeUndefined() // retired value
  })
})
