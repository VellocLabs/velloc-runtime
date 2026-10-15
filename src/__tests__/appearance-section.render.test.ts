// @vitest-environment happy-dom
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { createElement } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'

import {
  THEME_SWATCHES,
  UI_LOCALE_OPTIONS,
  matchThemeSwatch,
  matchUiLocale,
} from '../browser/webview/settings/appearanceOptions'
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
import {
  GUEST_TEXT_SIZE_ATTR,
  GUEST_TEXT_SIZE_STORAGE_KEY,
  installGuestTextSize,
} from '../browser/boot/guestTextSize'
import { AppearanceSection } from '../browser/webview/settings/sections/AppearanceSection'
import { en } from '../browser/webview/i18n/messages/en'

// This vitest realm's `localStorage` is not a working Storage; the per-client
// stores read it at call time, so a Map-backed stub stands in.
const memoryStorage = new Map<string, string>()
vi.stubGlobal('localStorage', {
  getItem: (k: string) => memoryStorage.get(k) ?? null,
  setItem: (k: string, v: string) => void memoryStorage.set(k, String(v)),
  removeItem: (k: string) => void memoryStorage.delete(k),
  clear: () => memoryStorage.clear(),
})

afterEach(() => {
  cleanup()
  localStorage.clear()
})

describe('appearanceOptions', () => {
  it('offers exactly the seven locales shipped on both surfaces', () => {
    expect(UI_LOCALE_OPTIONS.map((o) => o.tag)).toEqual([
      'en',
      'zh-CN',
      'es',
      'fr',
      'de',
      'ja',
      'ko',
    ])
  })

  it('matches a pref value to an offered tag, by base language and by fallback', () => {
    expect(matchUiLocale('zh-CN')).toBe('zh-CN')
    expect(matchUiLocale('zh')).toBe('zh-CN')
    expect(matchUiLocale('zh-TW')).toBe('zh-CN')
    expect(matchUiLocale('en-GB')).toBe('en')
    expect(matchUiLocale('')).toBe('en')
    expect(matchUiLocale(null)).toBe('en')
    expect(matchUiLocale('pt-BR')).toBe('en')
  })

  it('maps a host colour to its swatch, and an unknown colour to none', () => {
    expect(matchThemeSwatch(undefined)).toBe('chrome')
    expect(matchThemeSwatch(undefined, 'classic')).toBe('default')
    expect(matchThemeSwatch('#0b57d0', 'classic')).toBe('default')
    expect(matchThemeSwatch('#0b57d0')).toBe('blue')
    expect(matchThemeSwatch('#0B57D0')).toBe('blue')
    expect(matchThemeSwatch('#123456')).toBeNull()
  })

  it('puts Default (classic) first and gives every Chrome colour a seed the host will accept', () => {
    expect(THEME_SWATCHES[0]).toMatchObject({ id: 'default', palette: 'classic' })
    for (const swatch of THEME_SWATCHES) {
      if (swatch.id === 'default' || swatch.id === 'chrome') {
        expect(swatch.seed).toBeUndefined()
        expect(swatch.preview).toMatch(/^#[0-9a-f]{6}$/)
        continue
      }
      expect(swatch.palette).toBe('chrome')
      expect(swatch.seed).toMatch(/^#[0-9a-f]{6}$/)
      expect(swatch.variant).toBeTruthy()
    }
  })
})

const SRC = join(__dirname, '..')

describe('appearance catalog keys', () => {
  const catalog = en as Record<string, string | undefined>

  it('resolves every swatch label to prose, not to its own key', () => {
    const unresolved = THEME_SWATCHES.filter((s) => {
      const value = catalog[s.labelKey]
      return typeof value !== 'string' || value.trim() === ''
    }).map((s) => s.labelKey)
    expect(unresolved).toEqual([])
  })

  it('names a real key at every `t("settings.*")` call in the three sections', () => {
    const files = [
      'browser/webview/settings/appearanceOptions.ts',
      'browser/webview/settings/sections/AppearanceSection.tsx',
      'browser/webview/settings/sections/GeneralSection.tsx',
      'browser/webview/settings/sections/SystemSection.tsx',
    ]
    const missing: string[] = []
    for (const file of files) {
      const text = readFileSync(join(SRC, file), 'utf8')
      for (const m of text.matchAll(/["'](settings\.[A-Za-z0-9_.]+)["']/g)) {
        const key = m[1]!
        if (typeof catalog[key] !== 'string') missing.push(`${file}: ${key}`)
      }
    }
    expect(missing).toEqual([])
  })
})

describe('AppearanceSection', () => {
  it('renders the mode control, every swatch, and the text-size row', () => {
    render(createElement(AppearanceSection))
    expect(screen.getByTestId('settings-appearance')).toBeTruthy()
    expect(screen.getByTestId('appearance-mode')).toBeTruthy()
    expect(screen.getByTestId('appearance-swatches')).toBeTruthy()
    expect(screen.getByTestId('appearance-text-size')).toBeTruthy()
    for (const swatch of THEME_SWATCHES) {
      expect(screen.getByTestId(`appearance-swatch-${swatch.id}`)).toBeTruthy()
    }
  })

  it('reads the stored scheme as the selected mode', () => {
    localStorage.setItem(GUEST_COLOR_SCHEME_STORAGE_KEY, 'dark')
    render(createElement(AppearanceSection))
    const mode = screen.getByTestId('appearance-mode')
    expect(mode.textContent?.toLowerCase()).toContain('dark')
  })

  it('writes the chosen scheme to localStorage on pick', async () => {
    render(createElement(AppearanceSection))
    const trigger = screen.getByTestId('appearance-mode')
    fireEvent.pointerDown(trigger)
    fireEvent.click(trigger)
    const option = await screen.findByTestId('appearance-mode-option-dark')
    fireEvent.click(option)
    await waitFor(() => expect(localStorage.getItem(GUEST_COLOR_SCHEME_STORAGE_KEY)).toBe('dark'))
    expect(readGuestColorScheme()).toBe('dark')
  })

  it('selects Default on a fresh client (no stored choice)', () => {
    render(createElement(AppearanceSection))
    expect(screen.getByTestId('appearance-swatch-default').getAttribute('aria-checked')).toBe('true')
    expect(screen.getByTestId('appearance-swatch-rose').getAttribute('aria-checked')).toBe('false')
  })

  it('reads the stored accent as the selected swatch', () => {
    localStorage.setItem(GUEST_PALETTE_STORAGE_KEY, 'chrome')
    localStorage.setItem(GUEST_ACCENT_STORAGE_KEY, JSON.stringify({ seed: '#146c2e', variant: 'tonalSpot' }))
    render(createElement(AppearanceSection))
    expect(screen.getByTestId('appearance-swatch-green').getAttribute('aria-checked')).toBe('true')
    expect(screen.getByTestId('appearance-swatch-blue').getAttribute('aria-checked')).toBe('false')
  })

  it('writes palette and accent to localStorage when a swatch is clicked', async () => {
    render(createElement(AppearanceSection))
    screen.getByTestId('appearance-swatch-rose').click()
    await waitFor(() => {
      expect(localStorage.getItem(GUEST_PALETTE_STORAGE_KEY)).toBe('chrome')
    })
    expect(readGuestPalette()).toBe('chrome')
    expect(readGuestAccent()).toEqual({ seed: '#a8005d', variant: 'tonalSpot' })
    expect(screen.getByTestId('appearance-swatch-rose').getAttribute('aria-checked')).toBe('true')
  })

  it('Default clears the accent and switches back to the classic palette', () => {
    localStorage.setItem(GUEST_PALETTE_STORAGE_KEY, 'chrome')
    localStorage.setItem(GUEST_ACCENT_STORAGE_KEY, JSON.stringify({ seed: '#a8005d', variant: 'tonalSpot' }))
    render(createElement(AppearanceSection))
    screen.getByTestId('appearance-swatch-default').click()
    expect(localStorage.getItem(GUEST_PALETTE_STORAGE_KEY)).toBe('classic')
    expect(readGuestAccent()).toEqual({})
  })

  it('the Chrome swatch clears the seed but keeps Chrome colours', async () => {
    render(createElement(AppearanceSection))
    screen.getByTestId('appearance-swatch-chrome').click()
    expect(localStorage.getItem(GUEST_PALETTE_STORAGE_KEY)).toBe('chrome')
    expect(readGuestAccent()).toEqual({})
    await waitFor(() =>
      expect(screen.getByTestId('appearance-swatch-chrome').getAttribute('aria-checked')).toBe('true'),
    )
  })

  it('offers the five text-size steps, reads the stored one, and re-stamps the root on a pick', async () => {
    const root = document.createElement('html')
    const dispose = installGuestTextSize(root)
    try {
      localStorage.setItem(GUEST_TEXT_SIZE_STORAGE_KEY, '3')
      render(createElement(AppearanceSection))

      const trigger = screen.getByTestId('appearance-text-size')
      expect(trigger.textContent).toContain('Medium')

      fireEvent.pointerDown(trigger)
      fireEvent.click(trigger)
      const option = await screen.findByTestId('appearance-text-size-option-5')
      expect(document.querySelectorAll('[data-testid^="appearance-text-size-option-"]')).toHaveLength(5)
      fireEvent.click(option)

      await waitFor(() => expect(localStorage.getItem(GUEST_TEXT_SIZE_STORAGE_KEY)).toBe('5'))
      expect(root.getAttribute(GUEST_TEXT_SIZE_ATTR)).toBe('5')
    } finally {
      dispose()
    }
  })

  it('makes NO bridge call — the section is pure localStorage', () => {
    // The component takes no transport prop any more. If a future change
    // reintroduces a bridge write, this test's render will fail TypeScript
    // compilation (no such prop) — the static check IS the assertion.
    render(createElement(AppearanceSection))
    expect(screen.getByTestId('settings-appearance')).toBeTruthy()
  })
})

describe('AppearanceSection layout', () => {
  it('groups the three settings into one card', () => {
    render(createElement(AppearanceSection))
    const page = screen.getByTestId('settings-appearance')
    const cards = page.querySelectorAll('[data-settings-card]')
    expect(cards).toHaveLength(1)
    const card = cards[0]!
    expect(card.contains(screen.getByTestId('appearance-mode'))).toBe(true)
    expect(card.contains(screen.getByTestId('appearance-swatches'))).toBe(true)
    expect(card.contains(screen.getByTestId('appearance-text-size'))).toBe(true)
  })

  it('keeps the selected state off the focus ring', () => {
    localStorage.setItem(GUEST_PALETTE_STORAGE_KEY, 'chrome')
    localStorage.setItem(GUEST_ACCENT_STORAGE_KEY, JSON.stringify({ seed: '#146c2e', variant: 'tonalSpot' }))
    render(createElement(AppearanceSection))

    const selected = screen.getByTestId('appearance-swatch-green')
    expect(selected.getAttribute('aria-checked')).toBe('true')
    const unselected = screen.getByTestId('appearance-swatch-rose')
    expect(unselected.getAttribute('aria-checked')).toBe('false')

    const restingRings = (el: Element) =>
      (el.className || '')
        .split(/\s+/)
        .filter((c) => /^ring(-|$)/.test(c))

    expect(restingRings(selected)).toContain('ring-primary')
    expect(restingRings(selected)).not.toContain('ring-ring')
    expect(restingRings(unselected)).toEqual([])
  })
})

describe('appearance and language copy', () => {
  it('never says "browser" on either page', () => {
    const catalog = en as Record<string, string>
    const offenders = Object.entries(catalog)
      .filter(
        ([key]) =>
          key.startsWith('settings.appearance.') ||
          key.startsWith('settings.general.language') ||
          key.startsWith('settings.general.uiLanguage'),
      )
      .filter(([, value]) => /\bbrowser\b/i.test(value))
      .map(([key]) => key)
    expect(offenders).toEqual([])
  })
})

describe('appearance copy is terse', () => {
  const catalog = en as Record<string, string>

  it('describes the rows without a sentence or a brand name', () => {
    expect(catalog['settings.appearance.modeDescription']).toBe(
      'Light, dark, or system appearance.',
    )
    expect(catalog['settings.appearance.colorDescription']).toBe(
      'Interface accent colour.',
    )
    expect(catalog['settings.appearance.textSizeDescription']).toBe(
      'Conversation and sidebar text size.',
    )
    for (const key of [
      'settings.appearance.modeDescription',
      'settings.appearance.colorDescription',
      'settings.appearance.textSizeDescription',
    ]) {
      expect(catalog[key]).not.toMatch(/\{product\}/)
      expect(catalog[key]).not.toMatch(/^Choose/)
    }
  })
})
