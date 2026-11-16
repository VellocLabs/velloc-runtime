/**
 * How a page paints the session's mod theme (F-25 `$.theme.set`): the palette
 * onto Velloc's own CSS tokens, a still ground as CSS, a scene's glass. Pure.
 * Security: any loaded mod sets the theme, so every value is judged here
 * before it reaches a style: palette entries six-digit hex alone, ground
 * colors raw or a known name, path data whole.
 */

import { isPathData, isRawThemeColor, isThemeColor } from '@/mods/modTheme'

export type ThemeMode = 'light' | 'dark'

/** A palette's design-system slots, by the gray stop that holds each in a mode. */
const GRAY_SLOTS: Record<ThemeMode, Record<string, string>> = {
  light: {
    surface0: 'gray-20',
    surface1: 'gray-10',
    surface2: 'gray-0',
    surface3: 'gray-0',
    textPrimary: 'gray-900',
    textSecondary: 'gray-600',
    textMuted: 'gray-400',
  },
  dark: {
    surface0: 'gray-900',
    surface1: 'gray-850',
    surface2: 'gray-830',
    surface3: 'gray-800',
    textPrimary: 'gray-50',
    textSecondary: 'gray-200',
    textMuted: 'gray-400',
  },
}

/** The role stop read as text on a surface, and as strong text on a tint. */
const ROLE_TEXT_STOP: Record<ThemeMode, string> = { light: '600', dark: '250' }
const ROLE_EMPHASIS_STOP: Record<ThemeMode, string> = { light: '700', dark: '100' }

type Source = { key: (mode: ThemeMode) => string; alpha?: number }

const gray = (slot: string): Source => ({ key: mode => GRAY_SLOTS[mode][slot]! })
const role = (name: string, stop: 'text' | 'emphasis' | 'fill'): Source => ({
  key: mode =>
    stop === 'fill'
      ? `role-${name}-fill`
      : `role-${name}-${(stop === 'text' ? ROLE_TEXT_STOP : ROLE_EMPHASIS_STOP)[mode]}`,
})
const literal = (key: string): Source => ({ key: () => key })
const faded = (source: Source, alpha: number): Source => ({ ...source, alpha })

/** Velloc token → the palette entry that paints it. A token whose entry the
 *  palette leaves out keeps the app's own color. */
const TOKEN_SOURCES: ReadonlyArray<[string, Source]> = [
  ['--background', gray('surface0')],
  ['--base', gray('surface0')],
  ['--sidebar', gray('surface0')],
  ['--toolbar', gray('surface1')],
  ['--card', gray('surface1')],
  ['--popover', gray('surface3')],
  ['--muted', gray('surface2')],
  ['--secondary', gray('surface2')],
  ['--accent', gray('surface2')],
  ['--sidebar-accent', gray('surface2')],
  ['--foreground', gray('textPrimary')],
  ['--card-foreground', gray('textPrimary')],
  ['--popover-foreground', gray('textPrimary')],
  ['--secondary-foreground', gray('textPrimary')],
  ['--accent-foreground', gray('textPrimary')],
  ['--sidebar-foreground', gray('textPrimary')],
  ['--sidebar-accent-foreground', gray('textPrimary')],
  ['--muted-foreground', gray('textSecondary')],
  ['--primary', gray('textPrimary')],
  ['--sidebar-primary', gray('textPrimary')],
  ['--primary-foreground', gray('surface0')],
  ['--sidebar-primary-foreground', gray('surface0')],
  ['--border', faded(gray('textMuted'), 0.2)],
  ['--sidebar-border', faded(gray('textMuted'), 0.2)],
  ['--input', faded(gray('textMuted'), 0.3)],
  ['--ring', gray('textMuted')],
  ['--sidebar-ring', gray('textMuted')],
  ['--focus-ring', role('accent', 'fill')],
  ['--destructive', role('danger', 'fill')],
  ['--success', role('success', 'text')],
  ['--success-emphasis', role('success', 'emphasis')],
  ['--warning', role('warning', 'text')],
  ['--warning-emphasis', role('warning', 'emphasis')],
  ['--info', role('accent', 'text')],
  ['--info-emphasis', role('accent', 'emphasis')],
  ['--diff-added', literal('text-git-added')],
  ['--diff-removed', literal('text-git-removed')],
  ['--syntax-comment', gray('textMuted')],
  ['--syntax-keyword', role('accent', 'text')],
  ['--syntax-link', role('accent', 'text')],
  ['--syntax-string', role('success', 'text')],
  ['--syntax-number', role('pro', 'text')],
  ['--syntax-constant', role('pro', 'text')],
  ['--syntax-function', role('danger', 'text')],
  ['--syntax-tag', role('danger', 'text')],
  ['--syntax-property', role('warning', 'text')],
  ['--syntax-type', role('warning', 'text')],
]

/** Every token a theme may set, so the page can copy the app's own values
 *  back where the app's look must stand. */
export const THEME_TOKENS: readonly string[] = [...new Set(TOKEN_SOURCES.map(([token]) => token))]

/** The surface tokens a scene's glass frosts. */
export const GLASS_TOKENS: readonly string[] = ['--background', '--base', '--toolbar', '--card', '--sidebar']

/** Velloc's floor for primary text on each surface; under it the whole
 *  palette is refused. */
export const MIN_TEXT_CONTRAST = 4.5

const HEX6 = /^#[0-9a-fA-F]{6}$/

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function luminance(hex: string): number {
  const channel = (start: number): number => {
    const c = parseInt(hex.slice(start, start + 2), 16) / 255
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
  }
  return 0.2126 * channel(1) + 0.7152 * channel(3) + 0.0722 * channel(5)
}

/** WCAG contrast ratio of two six-digit hex colors. */
export function contrastRatio(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number]
  return (hi + 0.05) / (lo + 0.05)
}

/** The palette's colors for `mode`: six-digit hex entries alone. Absent:
 *  the palette gives none for that mode. */
export function paletteInputsOf(colors: unknown, mode: ThemeMode): Record<string, string> | undefined {
  if (!isRecord(colors) || colors.v !== 1 || !isRecord(colors.inputs)) return undefined
  const inputs = colors.inputs[mode]
  if (!isRecord(inputs)) return undefined
  const out: Record<string, string> = {}
  for (const [key, value] of Object.entries(inputs)) {
    if (typeof value === 'string' && HEX6.test(value)) out[key] = value
  }
  return out
}

/** What a palette paints in one mode: tokens, nothing (it gives no colors
 *  for that mode, so the app keeps its own), or refused whole. */
export type PaintedPalette =
  | { kind: 'painted'; tokens: Record<string, string> }
  | { kind: 'none' }
  | { kind: 'refused'; reason: string }

/** The tokens `colors` paints in the page's `mode`, or why none. A palette
 *  that gives only the other mode paints nothing here. */
export function paletteTokensOf(colors: unknown, mode: ThemeMode): PaintedPalette {
  const inputs = paletteInputsOf(colors, mode)
  if (!inputs || Object.keys(inputs).length === 0) return { kind: 'none' }
  const text = inputs[GRAY_SLOTS[mode].textPrimary!]
  if (text) {
    for (const slot of ['surface0', 'surface1', 'surface2', 'surface3']) {
      const surface = inputs[GRAY_SLOTS[mode][slot]!]
      if (surface && contrastRatio(text, surface) < MIN_TEXT_CONTRAST) {
        return { kind: 'refused', reason: `text on ${slot} is under ${MIN_TEXT_CONTRAST}:1` }
      }
    }
  }
  const tokens: Record<string, string> = {}
  for (const [token, source] of TOKEN_SOURCES) {
    const value = inputs[source.key(mode)]
    if (!value) continue
    tokens[token] =
      source.alpha === undefined ? value : `color-mix(in srgb, ${value} ${Math.round(source.alpha * 100)}%, transparent)`
  }
  return { kind: 'painted', tokens }
}

/** A design-system color name → the Velloc token that shows it, so a ground
 *  follows the painted palette, or the app's own colors where none is. */
function namedColor(name: string): string {
  const exact: Record<string, string> = {
    'surface-0': 'var(--background)',
    'surface-1': 'var(--card)',
    'surface-2': 'var(--muted)',
    'surface-3': 'var(--popover)',
    'text-primary': 'var(--foreground)',
    'text-secondary': 'var(--muted-foreground)',
    'text-muted': 'var(--muted-foreground)',
    'text-disabled': 'var(--muted-foreground)',
    'fill-primary': 'var(--primary)',
    'on-primary': 'var(--primary-foreground)',
    border: 'var(--border)',
    'border-strong': 'var(--input)',
    'border-stronger': 'var(--ring)',
  }
  if (exact[name]) return exact[name]
  const [part, roleName] = name.split('-') as [string, string]
  const hue = { accent: '--info', danger: '--destructive', success: '--success', warning: '--warning', pro: '--chart-4' }[roleName]
  if (!hue) return 'transparent'
  if (part === 'bg') return `color-mix(in srgb, var(${hue}) 15%, transparent)`
  if (part === 'on') return 'var(--background)'
  return `var(${hue})`
}

/** A ground's color as CSS, or undefined where it is none the page takes. */
export function groundColorOf(value: unknown): string | undefined {
  if (!isThemeColor(value)) return undefined
  if (isRawThemeColor(value) || value === 'transparent') return value
  return namedColor(value)
}

function tilingStyle(value: Record<string, unknown>): { backgroundSize: string; backgroundRepeat: string } {
  const size = value.size
  const box =
    Array.isArray(size) && size.length === 2 && size.every(side => typeof side === 'number' && side >= 1 && side <= 256)
      ? `${size[0]}px ${size[1]}px`
      : '100% 100%'
  return { backgroundSize: box, backgroundRepeat: value.repeat === true ? 'repeat' : 'no-repeat' }
}

/** A still color or gradient ground as CSS; undefined for anything else. */
export function groundStyleOf(backdrop: unknown): Record<string, string> | undefined {
  if (!isRecord(backdrop)) return undefined
  if (backdrop.color !== undefined) {
    const color = groundColorOf(backdrop.color)
    return color ? { backgroundColor: color } : undefined
  }
  const gradient = backdrop.gradient
  if (!isRecord(gradient) || !Array.isArray(gradient.stops) || gradient.stops.length < 2) return undefined
  const count = gradient.stops.length
  const stops: string[] = []
  for (const [index, stop] of gradient.stops.entries()) {
    const at = isRecord(stop) ? stop.at : index / (count - 1)
    const color = groundColorOf(isRecord(stop) ? stop.color : stop)
    if (!color || typeof at !== 'number' || !(at >= 0 && at <= 1)) return undefined
    stops.push(`${color} ${Math.round(at * 10_000) / 100}%`)
  }
  const angle = typeof gradient.angle === 'number' && Math.abs(gradient.angle) <= 360 ? gradient.angle : 180
  const image =
    gradient.shape === 'radial'
      ? `radial-gradient(ellipse farthest-corner, ${stops.join(', ')})`
      : `linear-gradient(${angle}deg, ${stops.join(', ')})`
  return { backgroundImage: image, ...tilingStyle(gradient) }
}

/** One path of a vector ground, judged: its data, and how it is drawn. */
export type GroundPath = { d: string; color: string; strokeWidth?: number }

/** A vector ground, judged; undefined where it draws nothing. */
export type GroundVector = {
  width: number
  height: number
  size?: [number, number]
  repeat: boolean
  paths: GroundPath[]
}

export function groundVectorOf(backdrop: unknown): GroundVector | undefined {
  if (!isRecord(backdrop) || !isRecord(backdrop.vector)) return undefined
  const vector = backdrop.vector
  const box = vector.viewBox
  const [width, height] =
    typeof box === 'number' ? [box, box] : Array.isArray(box) && box.length === 2 ? [box[0], box[1]] : [NaN, NaN]
  if (![width, height].every(side => typeof side === 'number' && side >= 1 && side <= 256)) return undefined
  if (!Array.isArray(vector.paths)) return undefined
  const fallback = vector.color === undefined ? undefined : groundColorOf(vector.color)
  const paths: GroundPath[] = []
  for (const path of vector.paths.slice(0, 64)) {
    const d = typeof path === 'string' ? path : isRecord(path) ? path.d : undefined
    if (!isPathData(d)) return undefined
    const own = isRecord(path) && path.color !== undefined ? groundColorOf(path.color) : undefined
    const color = own ?? fallback
    if (!color) continue
    const stroke = isRecord(path) && typeof path.strokeWidth === 'number' && path.strokeWidth > 0 && path.strokeWidth <= 64
      ? path.strokeWidth
      : undefined
    paths.push({ d, color, ...(stroke !== undefined ? { strokeWidth: stroke } : {}) })
  }
  if (paths.length === 0) return undefined
  const size = vector.size
  return {
    width: width as number,
    height: height as number,
    ...(Array.isArray(size) && size.length === 2 && size.every(side => typeof side === 'number' && side >= 1 && side <= 256)
      ? { size: [size[0] as number, size[1] as number] as [number, number] }
      : {}),
    repeat: vector.repeat === true,
    paths,
  }
}

/** A scene's glass, judged: blur in px, the veil's color and opacity. */
export type PaintedGlass = { blur: number; tint?: string; opacity: number }

export function sceneGlassOf(backdrop: unknown): PaintedGlass | undefined {
  if (!isRecord(backdrop) || typeof backdrop.scene !== 'string' || !isRecord(backdrop.glass)) return undefined
  const { blur, tint, opacity } = backdrop.glass
  if (typeof blur !== 'number' || !(blur >= 0 && blur <= 64)) return undefined
  if (typeof opacity !== 'number' || !(opacity >= 0 && opacity <= 1)) return undefined
  return { blur, opacity, ...(isRawThemeColor(tint) ? { tint } : {}) }
}

/** The surface tokens a glass paints: each surface (the palette's where it
 *  painted one, else the app's own, `own`) or the tint, at the glass's
 *  opacity. */
export function glassTokensOf(
  glass: PaintedGlass,
  painted: Record<string, string>,
  own: Record<string, string>,
): Record<string, string> {
  const tokens: Record<string, string> = {}
  for (const token of GLASS_TOKENS) {
    const base = glass.tint ?? painted[token] ?? own[token]
    if (!base) continue
    tokens[token] = `color-mix(in srgb, ${base} ${Math.round(glass.opacity * 100)}%, transparent)`
  }
  return tokens
}
