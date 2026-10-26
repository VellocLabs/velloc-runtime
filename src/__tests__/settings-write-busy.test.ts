/**
 * A settings write that meets a file another process holds open (the host's
 * `EBUSY` code) is retried briefly instead of being lost.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  setSettingsForSource,
  updateUserModelAutoCompactWindow,
  wipeSettingsMemos,
} from '../settings/settingsStore'
import type { NexusSettingsV1 } from '../settings/settingsTypes'
import { unconfiguredFs, type RuntimeFs } from '../utils/fs/runtimeFs'

const CTX = { homeDir: '/home/u' }
const SETTINGS = { version: 1 } as NexusSettingsV1
const BUSY = 'Failed to write file (EBUSY: file is in use or locked)'

function fsFailing(failures: string[]) {
  const writes: string[] = []
  let attempts = 0
  const fs: RuntimeFs = {
    ...unconfiguredFs,
    mkdir: async () => {},
    writeFile: async (path: string) => {
      attempts += 1
      const failure = failures.shift()
      if (failure) throw new Error(failure)
      writes.push(path)
    },
  } as RuntimeFs
  return { fs, writes, attempts: () => attempts }
}

describe('setSettingsForSource — a file held open elsewhere', () => {
  afterEach(() => {
    vi.useRealTimers()
    wipeSettingsMemos()
  })

  it('writes once the file is free again', async () => {
    vi.useFakeTimers()
    const f = fsFailing([BUSY, BUSY])
    const done = setSettingsForSource('userSettings', CTX, f.fs, SETTINGS)
    await vi.runAllTimersAsync()
    await done
    expect(f.writes).toEqual(['/home/u/.velloc/settings.json'])
    expect(f.attempts()).toBe(3)
  })

  it('gives up with the host error when the file stays held', async () => {
    vi.useFakeTimers()
    const f = fsFailing(Array(20).fill(BUSY))
    const done = setSettingsForSource('userSettings', CTX, f.fs, SETTINGS)
    const outcome = expect(done).rejects.toThrow(/EBUSY/)
    await vi.runAllTimersAsync()
    await outcome
    expect(f.writes).toEqual([])
    expect(f.attempts()).toBeLessThan(20)
  })

  it('does not retry any other failure', async () => {
    const f = fsFailing(['Failed to write file (EACCES: permission denied)'])
    await expect(setSettingsForSource('userSettings', CTX, f.fs, SETTINGS)).rejects.toThrow(/EACCES/)
    expect(f.attempts()).toBe(1)
  })
})

describe('two saves while the first waits out a held file', () => {
  afterEach(() => {
    vi.useRealTimers()
    wipeSettingsMemos()
  })

  it('keeps both: the second reads what the first wrote', async () => {
    vi.useFakeTimers()
    const files = new Map<string, string>()
    let busyOnce = true
    const fs: RuntimeFs = {
      ...unconfiguredFs,
      mkdir: async () => {},
      existsSync: (path: string) => files.has(path),
      readFile: async (path: string) => {
        const body = files.get(path)
        if (body === undefined) throw new Error('ENOENT: no such file or directory')
        return body
      },
      writeFile: async (path: string, body: string) => {
        if (busyOnce) {
          busyOnce = false
          throw new Error(BUSY)
        }
        files.set(path, body)
      },
    } as unknown as RuntimeFs

    const first = updateUserModelAutoCompactWindow('/home/u', fs, 'model-a', 100_000)
    const second = updateUserModelAutoCompactWindow('/home/u', fs, 'model-b', 200_000)
    await vi.runAllTimersAsync()
    await Promise.all([first, second])

    const saved = JSON.parse(files.get('/home/u/.velloc/settings.json')!)
    expect(saved.modelSettings).toEqual({
      'model-a': { autoCompactWindow: 100_000 },
      'model-b': { autoCompactWindow: 200_000 },
    })
  })
})
