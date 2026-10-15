// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { BrowserBridgeTransport } from '../browser/bridge/browserBridgeProtocol'
import {
  APPEARANCE_MIGRATION_SENTINEL_KEY,
  migrateAppearanceFromHostPrefs,
} from '../browser/boot/appearanceMigration'
import {
  GUEST_ACCENT_STORAGE_KEY,
  GUEST_PALETTE_STORAGE_KEY,
  readGuestAccent,
  readGuestPalette,
} from '../browser/boot/guestPalette'
import {
  GUEST_COLOR_SCHEME_STORAGE_KEY,
  readGuestColorScheme,
} from '../browser/boot/guestColorScheme'

// Map-backed localStorage stub, same pattern as the other boot tests.
const memoryStorage = new Map<string, string>()
vi.stubGlobal('localStorage', {
  getItem: (k: string) => memoryStorage.get(k) ?? null,
  setItem: (k: string, v: string) => void memoryStorage.set(k, String(v)),
  removeItem: (k: string) => void memoryStorage.delete(k),
  clear: () => memoryStorage.clear(),
})

afterEach(() => {
  memoryStorage.clear()
})

function transportReturning(snapshot: unknown) {
  return {
    request: vi.fn(async () => ({ ok: true, result: snapshot })),
    subscribeEvents: () => () => {},
  } as unknown as BrowserBridgeTransport
}

function transportRejecting() {
  return {
    request: vi.fn(async () => ({
      ok: false,
      error: { code: 'unknown_route', message: 'no such route' },
    })),
    subscribeEvents: () => () => {},
  } as unknown as BrowserBridgeTransport
}

describe('migrateAppearanceFromHostPrefs', () => {
  it('copies scheme and a recognised seed into localStorage, and marks done', async () => {
    const transport = transportReturning({
      locale: 'en',
      scheme: 'dark',
      color: '#0b57d0',
      variant: 'tonalSpot',
    })
    const migrated = await migrateAppearanceFromHostPrefs(transport)
    expect(migrated).toBe(true)
    expect(readGuestColorScheme()).toBe('dark')
    expect(localStorage.getItem(GUEST_COLOR_SCHEME_STORAGE_KEY)).toBe('dark')
    expect(readGuestPalette()).toBe('chrome')
    expect(readGuestAccent()).toEqual({ seed: '#0b57d0', variant: 'tonalSpot' })
    expect(localStorage.getItem(APPEARANCE_MIGRATION_SENTINEL_KEY)).toBe('1')
  })

  it('runs once: a second call is a no-op even if the host changed', async () => {
    const first = transportReturning({ locale: 'en', scheme: 'dark' })
    expect(await migrateAppearanceFromHostPrefs(first)).toBe(true)
    const second = transportReturning({ locale: 'en', scheme: 'light' })
    expect(await migrateAppearanceFromHostPrefs(second)).toBe(false)
    expect(readGuestColorScheme()).toBe('dark')
    // The second transport was never asked — the sentinel short-circuits.
    expect((second.request as ReturnType<typeof vi.fn>).mock.calls.length).toBe(0)
  })

  it('marks done without writing when the host has nothing to migrate', async () => {
    const transport = transportReturning({ locale: 'en' })
    const migrated = await migrateAppearanceFromHostPrefs(transport)
    expect(migrated).toBe(false)
    expect(readGuestColorScheme()).toBe('system')
    expect(readGuestPalette()).toBe('classic')
    expect(localStorage.getItem(APPEARANCE_MIGRATION_SENTINEL_KEY)).toBe('1')
  })

  it('a remote client (route absent) marks done and migrates nothing', async () => {
    const transport = transportRejecting()
    const migrated = await migrateAppearanceFromHostPrefs(transport)
    expect(migrated).toBe(false)
    expect(readGuestColorScheme()).toBe('system')
    expect(localStorage.getItem(APPEARANCE_MIGRATION_SENTINEL_KEY)).toBe('1')
  })

  it('a TRANSIENT failure leaves the sentinel unset, so the next boot retries and migrates', async () => {
    const failing = {
      request: vi.fn(async () => {
        throw new Error('transport dropped')
      }),
      subscribeEvents: () => () => {},
    } as unknown as BrowserBridgeTransport
    expect(await migrateAppearanceFromHostPrefs(failing)).toBe(false)
    expect(localStorage.getItem(APPEARANCE_MIGRATION_SENTINEL_KEY)).toBeNull()

    const busy = {
      request: vi.fn(async () => ({ ok: false, error: { code: 'internal', message: 'not yet' } })),
      subscribeEvents: () => () => {},
    } as unknown as BrowserBridgeTransport
    expect(await migrateAppearanceFromHostPrefs(busy)).toBe(false)
    expect(localStorage.getItem(APPEARANCE_MIGRATION_SENTINEL_KEY)).toBeNull()

    expect(await migrateAppearanceFromHostPrefs(transportReturning({ scheme: 'dark', locale: 'en' }))).toBe(true)
    expect(readGuestColorScheme()).toBe('dark')
  })

  it('a default profile (variant but NO user colour) stays on the Default palette', async () => {
    // What a fresh profile's host actually answers: `variant` is always there.
    const transport = transportReturning({ scheme: 'dark', variant: 'system', locale: 'en' })
    expect(await migrateAppearanceFromHostPrefs(transport)).toBe(true) // the scheme
    expect(readGuestColorScheme()).toBe('dark')
    expect(readGuestPalette()).toBe('classic')
    expect(localStorage.getItem(GUEST_PALETTE_STORAGE_KEY)).toBeNull()
  })

  it('an unrecognised host colour migrates as chrome palette with NO seed', async () => {
    const transport = transportReturning({
      locale: 'en',
      scheme: 'light',
      color: '#123456', // not one of THEME_SWATCHES
      variant: 'tonalSpot',
    })
    const migrated = await migrateAppearanceFromHostPrefs(transport)
    expect(migrated).toBe(true)
    expect(readGuestPalette()).toBe('chrome')
    expect(readGuestAccent()).toEqual({})
  })

  it('ignores an unparseable scheme but still migrates the colour', async () => {
    const transport = transportReturning({
      locale: 'en',
      scheme: 'purple',
      color: '#146c2e',
      variant: 'tonalSpot',
    })
    await migrateAppearanceFromHostPrefs(transport)
    expect(readGuestColorScheme()).toBe('system')
    expect(readGuestPalette()).toBe('chrome')
    expect(readGuestAccent()).toEqual({ seed: '#146c2e', variant: 'tonalSpot' })
  })

  it('does not clobber a choice the user already made locally', async () => {
    // A local choice exists (the user picked on this build, or migrated by
    // hand): the host pref is stale by definition, so the migration leaves
    // the local values alone.
    memoryStorage.set(GUEST_COLOR_SCHEME_STORAGE_KEY, 'light')
    memoryStorage.set(GUEST_PALETTE_STORAGE_KEY, 'classic')
    const transport = transportReturning({
      locale: 'en',
      scheme: 'dark',
      color: '#0b57d0',
      variant: 'tonalSpot',
    })
    await migrateAppearanceFromHostPrefs(transport)
    expect(readGuestColorScheme()).toBe('light')
    expect(readGuestPalette()).toBe('classic')
    // The sentinel still trips — the migration ran, it just had nothing to do.
    expect(localStorage.getItem(APPEARANCE_MIGRATION_SENTINEL_KEY)).toBe('1')
  })
})
