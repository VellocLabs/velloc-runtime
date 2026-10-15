/**
 * F-24: a remote page can boot a build older than the desktop's; `switchToDesktopBuild` moves it (a reload at the
 * bare address, a direct jump elsewhere) at most once a minute per tab, so it cannot loop.
 */
import { describe, expect, it, vi } from 'vitest'
import {
  BUILD_SWITCH_GUARD_MS,
  BUILD_SWITCH_KEY,
  claimAutomaticBuildSwitch,
  switchToDesktopBuild,
} from '../browser/boot/remoteBuildSwitch'

function memoryStorage(): Pick<Storage, 'getItem' | 'setItem'> & {
  data: Map<string, string>
} {
  const data = new Map<string, string>()
  return {
    data,
    getItem: key => data.get(key) ?? null,
    setItem: (key, value) => {
      data.set(key, value)
    },
  }
}

function fakeLocation(pathname: string) {
  return { pathname, reload: vi.fn(), replace: vi.fn() }
}

const TARGET = 'http://192.168.1.10:47615/v1/b/20260925T101500000Z/'

describe('claimAutomaticBuildSwitch', () => {
  it('grants the first switch and records it', () => {
    const storage = memoryStorage()
    expect(claimAutomaticBuildSwitch(storage, 1_000_000)).toBe(true)
    expect(storage.data.get(BUILD_SWITCH_KEY)).toBe('1000000')
  })

  it('refuses a second switch inside the guard window, grants it after', () => {
    const storage = memoryStorage()
    expect(claimAutomaticBuildSwitch(storage, 1_000_000)).toBe(true)
    expect(claimAutomaticBuildSwitch(storage, 1_000_000 + BUILD_SWITCH_GUARD_MS - 1)).toBe(false)
    expect(claimAutomaticBuildSwitch(storage, 1_000_000 + BUILD_SWITCH_GUARD_MS)).toBe(true)
  })

  it('refuses when there is nowhere to record the attempt', () => {
    expect(claimAutomaticBuildSwitch(null, 1)).toBe(false)
    const throwing = {
      getItem: () => {
        throw new Error('blocked')
      },
      setItem: () => {
        throw new Error('blocked')
      },
    }
    expect(claimAutomaticBuildSwitch(throwing, 1)).toBe(false)
  })

  it('ignores a garbled record', () => {
    const storage = memoryStorage()
    storage.data.set(BUILD_SWITCH_KEY, 'not-a-number')
    expect(claimAutomaticBuildSwitch(storage, 5)).toBe(true)
  })
})

describe('switchToDesktopBuild', () => {
  it('reloads at the bare address, so the cached redirect is revalidated', () => {
    const location = fakeLocation('/')
    expect(switchToDesktopBuild(TARGET, { location, storage: memoryStorage(), now: 1 })).toBe(true)
    expect(location.reload).toHaveBeenCalledTimes(1)
    expect(location.replace).not.toHaveBeenCalled()
  })

  it('reloads at the bare address even when the runtime named no entry', () => {
    const location = fakeLocation('/')
    expect(switchToDesktopBuild(null, { location, storage: memoryStorage(), now: 1 })).toBe(true)
    expect(location.reload).toHaveBeenCalledTimes(1)
  })

  it("jumps straight to the runtime's entry from a copied build link", () => {
    const location = fakeLocation('/v1/b/20260901T080000000Z/')
    expect(switchToDesktopBuild(TARGET, { location, storage: memoryStorage(), now: 1 })).toBe(true)
    expect(location.replace).toHaveBeenCalledWith(TARGET)
    expect(location.reload).not.toHaveBeenCalled()
  })

  it('does nothing off the bare address without a target', () => {
    const location = fakeLocation('/v1/b/20260901T080000000Z/')
    const storage = memoryStorage()
    expect(switchToDesktopBuild(null, { location, storage, now: 1 })).toBe(false)
    expect(location.replace).not.toHaveBeenCalled()
    // Nothing navigated, so the tab's one switch is still unspent.
    expect(storage.data.has(BUILD_SWITCH_KEY)).toBe(false)
  })

  it('stops a loop: the second switch in a minute is refused', () => {
    const storage = memoryStorage()
    const first = fakeLocation('/')
    expect(switchToDesktopBuild(TARGET, { location: first, storage, now: 10_000 })).toBe(true)
    // The reloaded page booted and STILL mismatches.
    const second = fakeLocation('/')
    expect(switchToDesktopBuild(TARGET, { location: second, storage, now: 20_000 })).toBe(false)
    expect(second.reload).not.toHaveBeenCalled()
    expect(second.replace).not.toHaveBeenCalled()
  })
})
