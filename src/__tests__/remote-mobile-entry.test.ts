/**
 * Which shell a remote page boots (F-24): the phone entry for a touch device with a small screen,
 * a stored choice overriding the guess, and no navigation when the listener does not serve the
 * phone entry.
 */
import { describe, expect, it, vi } from 'vitest'
import {
  MOBILE_SHELL_MAX_SCREEN_PX,
  REMOTE_SHELL_CHOICE_KEY,
  offersPhoneShell,
  openMobileEntryIfWanted,
  readDeviceTraits,
  readRemoteShellChoice,
  switchToDesktopShell,
  switchToMobileShell,
  wantsMobileShell,
  writeRemoteShellChoice,
  type MobileEntryEnv,
} from '../browser/boot/mobileEntry'

function memoryStorage(initial: Record<string, string> = {}) {
  const data = new Map(Object.entries(initial))
  return {
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => void data.set(key, value),
    data,
  }
}

const PHONE = { coarsePointer: true, screenShortSide: 390 }
const TABLET = { coarsePointer: true, screenShortSide: 820 }
const DESKTOP = { coarsePointer: false, screenShortSide: 1080 }

describe('wantsMobileShell', () => {
  it('picks the phone shell only for a coarse pointer on a small screen', () => {
    expect(wantsMobileShell(PHONE, null)).toBe(true)
    expect(wantsMobileShell(TABLET, null)).toBe(false)
    expect(wantsMobileShell(DESKTOP, null)).toBe(false)
    expect(wantsMobileShell({ coarsePointer: false, screenShortSide: 390 }, null)).toBe(false)
  })

  it('uses the screen short side, so the threshold is exclusive', () => {
    expect(wantsMobileShell({ coarsePointer: true, screenShortSide: MOBILE_SHELL_MAX_SCREEN_PX - 1 }, null)).toBe(true)
    expect(wantsMobileShell({ coarsePointer: true, screenShortSide: MOBILE_SHELL_MAX_SCREEN_PX }, null)).toBe(false)
  })

  it('lets a stored choice override the device in both directions', () => {
    expect(wantsMobileShell(PHONE, 'desktop')).toBe(false)
    expect(wantsMobileShell(DESKTOP, 'mobile')).toBe(true)
  })
})

describe('readDeviceTraits', () => {
  it('reads the short side whatever the orientation', () => {
    const win = {
      matchMedia: (q: string) => ({ matches: q === '(pointer: coarse)' }) as MediaQueryList,
      screen: { width: 844, height: 390 } as Screen,
    }
    expect(readDeviceTraits(win)).toEqual({ coarsePointer: true, screenShortSide: 390 })
  })

  it('reads a window whose matchMedia throws as a fine pointer', () => {
    const win = {
      matchMedia: () => {
        throw new Error('no media queries')
      },
      screen: { width: 1920, height: 1080 } as Screen,
    }
    expect(readDeviceTraits(win as unknown as Pick<Window, 'matchMedia' | 'screen'>).coarsePointer).toBe(false)
  })
})

describe('the stored choice', () => {
  it('round-trips and ignores unknown values', () => {
    const storage = memoryStorage()
    expect(readRemoteShellChoice(storage)).toBeNull()
    writeRemoteShellChoice('desktop', storage)
    expect(storage.data.get(REMOTE_SHELL_CHOICE_KEY)).toBe('desktop')
    expect(readRemoteShellChoice(storage)).toBe('desktop')
    storage.data.set(REMOTE_SHELL_CHOICE_KEY, 'tablet')
    expect(readRemoteShellChoice(storage)).toBeNull()
  })

  it('treats storage that throws as no choice', () => {
    const broken = {
      getItem: () => {
        throw new Error('blocked')
      },
      setItem: () => {
        throw new Error('blocked')
      },
    }
    expect(readRemoteShellChoice(broken)).toBeNull()
    expect(() => writeRemoteShellChoice('mobile', broken)).not.toThrow()
  })
})

describe('openMobileEntryIfWanted', () => {
  function env(overrides: {
    traits?: typeof PHONE
    pathname?: string
    ok?: boolean
    fetchThrows?: boolean
    storage?: ReturnType<typeof memoryStorage>
  } = {}) {
    const traits = overrides.traits ?? PHONE
    const replace = vi.fn()
    const fetchImpl = vi.fn(async () => {
      if (overrides.fetchThrows) throw new TypeError('network')
      return { ok: overrides.ok ?? true, body: null }
    })
    const value: MobileEntryEnv = {
      win: {
        matchMedia: (q: string) => ({ matches: q === '(pointer: coarse)' && traits.coarsePointer }) as MediaQueryList,
        screen: { width: traits.screenShortSide, height: 900 } as Screen,
        location: { pathname: overrides.pathname ?? '/', replace },
      },
      baseUri: 'http://192.168.1.10:47615/v1/b/20261115T000000000Z/',
      fetch: fetchImpl,
      storage: overrides.storage ?? memoryStorage(),
    }
    return { value, replace, fetchImpl }
  }

  it('navigates a phone to the sibling mobile.html once the listener serves it', async () => {
    const { value, replace, fetchImpl } = env()
    await expect(openMobileEntryIfWanted(value)).resolves.toBe(true)
    const target = 'http://192.168.1.10:47615/v1/b/20261115T000000000Z/mobile.html'
    expect(fetchImpl).toHaveBeenCalledWith(target, expect.objectContaining({ method: 'GET' }))
    expect(replace).toHaveBeenCalledWith(target)
  })

  it('stays on the desktop shell when the listener does not serve mobile.html', async () => {
    const { value, replace } = env({ ok: false })
    await expect(openMobileEntryIfWanted(value)).resolves.toBe(false)
    expect(replace).not.toHaveBeenCalled()
  })

  it('stays when the probe fails', async () => {
    const { value, replace } = env({ fetchThrows: true })
    await expect(openMobileEntryIfWanted(value)).resolves.toBe(false)
    expect(replace).not.toHaveBeenCalled()
  })

  it('does not probe for a desktop, or for a phone that chose the desktop shell', async () => {
    const desktop = env({ traits: DESKTOP })
    await expect(openMobileEntryIfWanted(desktop.value)).resolves.toBe(false)
    expect(desktop.fetchImpl).not.toHaveBeenCalled()

    const chose = env({ storage: memoryStorage({ [REMOTE_SHELL_CHOICE_KEY]: 'desktop' }) })
    await expect(openMobileEntryIfWanted(chose.value)).resolves.toBe(false)
    expect(chose.fetchImpl).not.toHaveBeenCalled()
  })

  it('does not navigate from the phone entry itself', async () => {
    const { value, fetchImpl } = env({ pathname: '/v1/b/20261115T000000000Z/mobile.html' })
    await expect(openMobileEntryIfWanted(value)).resolves.toBe(false)
    expect(fetchImpl).not.toHaveBeenCalled()
  })
})

describe('switching shells', () => {
  const ENTRY = 'http://192.168.1.10:47615/v1/b/20261115T000000000Z/'

  it('the desktop view stores the choice and loads index.html beside the phone entry', () => {
    const storage = memoryStorage()
    const replace = vi.fn()
    switchToDesktopShell({ win: { location: { replace } }, baseUri: `${ENTRY}mobile.html`, storage })
    expect(storage.data.get(REMOTE_SHELL_CHOICE_KEY)).toBe('desktop')
    expect(replace).toHaveBeenCalledWith(`${ENTRY}index.html`)
  })

  it('the phone view stores the choice and loads mobile.html once the listener serves it', async () => {
    const storage = memoryStorage({ [REMOTE_SHELL_CHOICE_KEY]: 'desktop' })
    const replace = vi.fn()
    const fetchImpl = vi.fn(async () => ({ ok: true, body: null }))
    await expect(
      switchToMobileShell({ win: { location: { replace } }, baseUri: ENTRY, fetch: fetchImpl, storage }),
    ).resolves.toBe(true)
    expect(fetchImpl).toHaveBeenCalledWith(`${ENTRY}mobile.html`, { method: 'GET', credentials: 'same-origin' })
    expect(storage.data.get(REMOTE_SHELL_CHOICE_KEY)).toBe('mobile')
    expect(replace).toHaveBeenCalledWith(`${ENTRY}mobile.html`)
  })

  it('the phone view stores nothing and stays when the listener does not serve it', async () => {
    for (const fetchImpl of [
      vi.fn(async () => ({ ok: false, body: null })),
      vi.fn(async () => {
        throw new TypeError('network')
      }),
    ]) {
      const storage = memoryStorage({ [REMOTE_SHELL_CHOICE_KEY]: 'desktop' })
      const replace = vi.fn()
      await expect(
        switchToMobileShell({ win: { location: { replace } }, baseUri: ENTRY, fetch: fetchImpl, storage }),
      ).resolves.toBe(false)
      expect(storage.data.get(REMOTE_SHELL_CHOICE_KEY)).toBe('desktop')
      expect(replace).not.toHaveBeenCalled()
    }
  })

  it('offers the phone view on any touch-first device, whatever its screen or the stored choice', () => {
    const win = (coarse: boolean, short: number) => ({
      matchMedia: (q: string) => ({ matches: q === '(pointer: coarse)' && coarse }) as MediaQueryList,
      screen: { width: short, height: 900 } as Screen,
    })
    expect(offersPhoneShell(win(true, 390))).toBe(true)
    expect(offersPhoneShell(win(true, 1024))).toBe(true)
    expect(offersPhoneShell(win(false, 390))).toBe(false)
  })
})
