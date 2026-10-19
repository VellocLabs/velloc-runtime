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

type Hue = 'black' | 'red' | 'green' | 'yellow' | 'blue' | 'magenta' | 'cyan' | 'white'
type BrightHue = `bright${Capitalize<Hue>}`

/**
 * Our ANSI palettes: per hue, its normal and its bright colour. Tuned for
 * the pane's card — the normal eight read on a light card, the bright eight
 * on a dark one — and each hue keeps its place from one scheme to the other.
 */
const ANSI_PALETTE: Record<TerminalScheme, Record<Hue, readonly [normal: string, bright: string]>> = {
  light: {
    black: ['#1f2328', '#5c6370'],
    red: ['#b3261e', '#d6453d'],
    green: ['#1e7f3c', '#2a9d4f'],
    yellow: ['#8a6d00', '#b08900'],
    blue: ['#1f5fbf', '#3b7ddd'],
    magenta: ['#8f3fa8', '#b05ac7'],
    cyan: ['#0b7a8c', '#1595a8'],
    white: ['#b8bcc4', '#f4f5f7'],
  },
  dark: {
    black: ['#1e1e24', '#868b96'],
    red: ['#e5635c', '#f28b84'],
    green: ['#6fcf7a', '#8fe59a'],
    yellow: ['#e2c46a', '#f0d58a'],
    blue: ['#6ea6f5', '#8fc0ff'],
    magenta: ['#c98ae6', '#dcaaf2'],
    cyan: ['#62c4d3', '#86dbe8'],
    white: ['#d4d6db', '#ffffff'],
  },
}

/** The scheme's palette spread over the `ITheme` slots: `red` and `brightRed` from the `red` pair, and so on. */
function ansiColours(scheme: TerminalScheme): Record<Hue | BrightHue, string> {
  const out: Partial<Record<Hue | BrightHue, string>> = {}
  for (const [hue, [normal, bright]] of Object.entries(ANSI_PALETTE[scheme]) as [Hue, readonly [string, string]][]) {
    out[hue] = normal
    out[`bright${hue.charAt(0).toUpperCase()}${hue.slice(1)}` as BrightHue] = bright
  }
  return out as Record<Hue | BrightHue, string>
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
    ...ansiColours(scheme),
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
 * Call `onChange` with the rebuilt theme whenever `<html>`'s class or inline
 * style changes the result: the host theme toggles `dark` and writes the
 * colour tokens inline, and a new palette in the same scheme touches only
 * the tokens. Returns the release.
 */
export function watchDocumentTheme(
  onChange: (theme: TerminalTheme) => void,
  doc: Document | undefined = globalThis.document,
  resolve: (token: string, doc: Document) => string | null = resolveCssToken,
): () => void {
  if (!doc?.documentElement || typeof MutationObserver === 'undefined') return () => {}
  const build = (): TerminalTheme => buildTerminalTheme(documentScheme(doc), token => resolve(token, doc))
  let last = JSON.stringify(build())
  const observer = new MutationObserver(() => {
    const theme = build()
    const key = JSON.stringify(theme)
    if (key !== last) {
      last = key
      onChange(theme)
    }
  })
  observer.observe(doc.documentElement, { attributes: true, attributeFilter: ['class', 'style'] })
  return () => observer.disconnect()
}
