/**
 * The emulator's colours from the guest's own tokens (F-31): the pane's
 * card colours for the screen, cursor and selection, and a fixed ANSI
 * palette per scheme. Pure given a token resolver; `resolveCssToken` is
 * the DOM-backed one.
 */

/** The xterm `ITheme` fields this view sets. */
export interface TerminalTheme {
  background: string
  foreground: string
  cursor: string
  cursorAccent: string
  selectionBackground: string
  selectionInactiveBackground: string
  black: string
  red: string
  green: string
  yellow: string
  blue: string
  magenta: string
  cyan: string
  white: string
  brightBlack: string
  brightRed: string
  brightGreen: string
  brightYellow: string
  brightBlue: string
  brightMagenta: string
  brightCyan: string
  brightWhite: string
}

export type TerminalScheme = 'light' | 'dark'

/** The CSS custom properties the theme reads, by role. */
export const TERMINAL_THEME_TOKENS = {
  background: '--card',
  foreground: '--card-foreground',
  cursor: '--foreground',
  cursorAccent: '--card',
} as const

/** `#rrggbb` fallbacks for a token that does not resolve (tests, a detached document). */
const FALLBACK: Record<TerminalScheme, Record<keyof typeof TERMINAL_THEME_TOKENS, string>> = {
  light: { background: '#ffffff', foreground: '#1b1b1f', cursor: '#1b1b1f', cursorAccent: '#ffffff' },
  dark: { background: '#2b2b2b', foreground: '#e6e6e6', cursor: '#e6e6e6', cursorAccent: '#2b2b2b' },
}

const ANSI: Record<TerminalScheme, Omit<TerminalTheme, keyof typeof TERMINAL_THEME_TOKENS | 'selectionBackground' | 'selectionInactiveBackground'>> = {
  light: {
    black: '#000000',
    red: '#c91b00',
    green: '#00894b',
    yellow: '#a26e00',
    blue: '#0451a5',
    magenta: '#a3137f',
    cyan: '#007587',
    white: '#c7c7c7',
    brightBlack: '#6f6f6f',
    brightRed: '#e03131',
    brightGreen: '#1a9c57',
    brightYellow: '#b58500',
    brightBlue: '#1a73e8',
    brightMagenta: '#c026a3',
    brightCyan: '#0598a6',
    brightWhite: '#ffffff',
  },
  dark: {
    black: '#000000',
    red: '#f0524f',
    green: '#5cb85c',
    yellow: '#e5c07b',
    blue: '#61afef',
    magenta: '#c678dd',
    cyan: '#56b6c2',
    white: '#cccccc',
    brightBlack: '#7f7f7f',
    brightRed: '#ff7b72',
    brightGreen: '#7ee787',
    brightYellow: '#f2cc60',
    brightBlue: '#79c0ff',
    brightMagenta: '#d2a8ff',
    brightCyan: '#80d0dd',
    brightWhite: '#ffffff',
  },
}

/** `#rrggbb` → `#rrggbbaa` with `alpha` in 0..1. */
export function withAlpha(hex: string, alpha: number): string {
  const a = Math.round(Math.max(0, Math.min(1, alpha)) * 255)
    .toString(16)
    .padStart(2, '0')
  return `${hex.slice(0, 7)}${a}`
}

/**
 * The theme for `scheme`. `resolve` answers a token as `#rrggbb` or null;
 * null falls back to the scheme's defaults so the screen is always readable.
 */
export function buildTerminalTheme(
  scheme: TerminalScheme,
  resolve: (token: string) => string | null,
): TerminalTheme {
  const pick = (role: keyof typeof TERMINAL_THEME_TOKENS): string =>
    resolve(TERMINAL_THEME_TOKENS[role]) ?? FALLBACK[scheme][role]
  const foreground = pick('foreground')
  return {
    background: pick('background'),
    foreground,
    cursor: pick('cursor'),
    cursorAccent: pick('cursorAccent'),
    selectionBackground: withAlpha(foreground, scheme === 'dark' ? 0.3 : 0.2),
    selectionInactiveBackground: withAlpha(foreground, 0.12),
    ...ANSI[scheme],
  }
}

/** The scheme the document shows: the `dark` class the host theme sets on `<html>`. */
export function documentScheme(doc: Document | undefined = globalThis.document): TerminalScheme {
  return doc?.documentElement.classList.contains('dark') ? 'dark' : 'light'
}

let probeCanvas: HTMLCanvasElement | null = null

/**
 * A token's computed colour as `#rrggbb`, through a canvas so any CSS colour
 * syntax (`oklch`, `rgb`, names) resolves; null without a document, a 2D
 * context, or when the token is unset.
 */
export function resolveCssToken(token: string, doc: Document | undefined = globalThis.document): string | null {
  if (!doc?.documentElement) return null
  const value = getComputedStyle(doc.documentElement).getPropertyValue(token).trim()
  if (!value) return null
  try {
    probeCanvas ??= doc.createElement('canvas')
    probeCanvas.width = 1
    probeCanvas.height = 1
    const ctx = probeCanvas.getContext('2d', { willReadFrequently: true })
    if (!ctx) return null
    ctx.clearRect(0, 0, 1, 1)
    ctx.fillStyle = '#000000'
    ctx.fillStyle = value
    ctx.fillRect(0, 0, 1, 1)
    const [r, g, b] = ctx.getImageData(0, 0, 1, 1).data
    return `#${[r, g, b].map(n => (n ?? 0).toString(16).padStart(2, '0')).join('')}`
  } catch {
    return null
  }
}

/** The guest's monospace font stack, from its `--font-mono` token. */
export function resolveMonoFont(doc: Document | undefined = globalThis.document): string {
  const fallback = 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace'
  if (!doc?.documentElement) return fallback
  const value = getComputedStyle(doc.documentElement).getPropertyValue('--font-mono').trim()
  return value || fallback
}

/**
 * Call `onChange` when `<html>`'s class list changes (the host theme toggles
 * `dark`). Returns the release.
 */
export function watchDocumentScheme(onChange: (scheme: TerminalScheme) => void, doc: Document | undefined = globalThis.document): () => void {
  if (!doc?.documentElement || typeof MutationObserver === 'undefined') return () => {}
  let last = documentScheme(doc)
  const observer = new MutationObserver(() => {
    const next = documentScheme(doc)
    if (next !== last) {
      last = next
      onChange(next)
    }
  })
  observer.observe(doc.documentElement, { attributes: true, attributeFilter: ['class'] })
  return () => observer.disconnect()
}
