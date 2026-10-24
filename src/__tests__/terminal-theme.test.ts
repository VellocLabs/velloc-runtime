/** The emulator theme from the guest's tokens (F-31): every field set in both schemes, fallbacks when a token is missing. */
import { describe, expect, it } from 'vitest'

import {
  TERMINAL_THEME_TOKENS,
  buildTerminalTheme,
  withAlpha,
} from '@/browser/webview/terminal/xtermTheme'

const HEX = /^#[0-9a-f]{6}$/
const HEX_ALPHA = /^#[0-9a-f]{8}$/

describe('buildTerminalTheme', () => {
  it.each(['light', 'dark'] as const)('%s: every field is a colour, from the tokens where they resolve', scheme => {
    const asked: string[] = []
    const theme = buildTerminalTheme(scheme, token => {
      asked.push(token)
      return token === '--card' ? '#112233' : token === '--card-foreground' ? '#eeeeee' : null
    })
    for (const token of Object.values(TERMINAL_THEME_TOKENS)) expect(asked).toContain(token)
    expect(theme.background).toBe('#112233')
    expect(theme.foreground).toBe('#eeeeee')
    expect(theme.cursorAccent).toBe('#112233')
    // Unresolved tokens fall back to a readable default.
    expect(theme.cursor).toMatch(HEX)
    expect(theme.selectionBackground).toMatch(HEX_ALPHA)
    expect(theme.selectionInactiveBackground).toMatch(HEX_ALPHA)
    for (const slider of [
      theme.scrollbarSliderBackground,
      theme.scrollbarSliderHoverBackground,
      theme.scrollbarSliderActiveBackground,
    ]) {
      expect(slider).toMatch(HEX_ALPHA)
    }
    const ansi = [
      theme.black, theme.red, theme.green, theme.yellow, theme.blue, theme.magenta, theme.cyan, theme.white,
      theme.brightBlack, theme.brightRed, theme.brightGreen, theme.brightYellow, theme.brightBlue,
      theme.brightMagenta, theme.brightCyan, theme.brightWhite,
    ]
    for (const colour of ansi) expect(colour).toMatch(HEX)
  })

  it('the two schemes differ where it matters: screen and palette', () => {
    const none = (): null => null
    const light = buildTerminalTheme('light', none)
    const dark = buildTerminalTheme('dark', none)
    expect(light.background).not.toBe(dark.background)
    expect(light.foreground).not.toBe(dark.foreground)
    expect(light.red).not.toBe(dark.red)
  })
})

describe('withAlpha', () => {
  it('appends the alpha byte and clamps', () => {
    expect(withAlpha('#ffffff', 0.5)).toBe('#ffffff80')
    expect(withAlpha('#000000', 2)).toBe('#000000ff')
    expect(withAlpha('#000000', -1)).toBe('#00000000')
    expect(withAlpha('#12345678', 1)).toBe('#123456ff')
  })
})

describe('the scrollbar colours', () => {
  it('come from the muted foreground, stronger on hover and while dragged', () => {
    const theme = buildTerminalTheme('light', token => (token === '--muted-foreground' ? '#445566' : null))
    expect(theme.scrollbarSliderBackground.slice(0, 7)).toBe('#445566')
    const alpha = (hex: string) => parseInt(hex.slice(7), 16)
    expect(alpha(theme.scrollbarSliderHoverBackground)).toBeGreaterThan(alpha(theme.scrollbarSliderBackground))
    expect(alpha(theme.scrollbarSliderActiveBackground)).toBeGreaterThan(alpha(theme.scrollbarSliderHoverBackground))
  })
})
