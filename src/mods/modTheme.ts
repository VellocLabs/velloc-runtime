/**
 * `$.theme.set` / `$.theme.clear` (F-25): the session's one theme, the latest
 * set by any plugin; a set replaces it whole, a clear removes any plugin's.
 * Op events: a hook above may rewrite, deny or answer them. Display only, and
 * gone with the plugin that set it.
 * Security: shape and size are checked here alone; `colors` is held as bounded
 * JSON and never read, and the page judges every value it paints.
 */

import { isPaneId } from './modRender'

/** The design system's color names a still ground may use for a color. */
export const THEME_COLOR_NAMES = [
  'surface-0', 'surface-1', 'surface-2', 'surface-3',
  'text-primary', 'text-secondary', 'text-muted', 'text-disabled',
  'fill-primary', 'on-primary', 'border', 'border-strong', 'border-stronger',
  'fill-accent', 'text-accent', 'bg-accent', 'on-accent', 'border-accent',
  'fill-danger', 'text-danger', 'bg-danger', 'on-danger', 'border-danger',
  'fill-success', 'text-success', 'bg-success', 'on-success', 'border-success',
  'fill-warning', 'text-warning', 'bg-warning', 'on-warning', 'border-warning',
  'fill-pro', 'text-pro', 'bg-pro', 'on-pro', 'border-pro',
] as const

export type ThemeGlass = { blur?: number; tint?: string; opacity?: number }
export type ThemeTiling = { size?: [number, number]; repeat?: boolean }
export type ThemeGradientStop = string | { at: number; color: string }
export type ThemeVectorPath = string | { d: string; strokeWidth?: number; color?: string }

export type ThemeScene = { scene: string; glass?: ThemeGlass | false }
export type ThemeGround =
  | { color: string }
  | { gradient: ThemeTiling & { stops: ThemeGradientStop[]; angle?: number; shape?: 'linear' | 'radial' } }
  | { vector: ThemeTiling & { viewBox: number | [number, number]; paths: ThemeVectorPath[]; color?: string } }
  | { image: ThemeTiling & { source: string } }

/** `$.theme.set`'s argument, checked. `backdrop: false` is the app's own. */
export type ThemeSetArgs = {
  backdrop?: ThemeScene | ThemeGround | false
  overrideColorScheme?: 'light' | 'dark'
  colors?: Record<string, unknown>
}

/** What `$.theme.set` / `$.theme.clear` resolve to. */
export type ThemeResult =
  | { isDrawn: true; requestId: string }
  | { isDrawn: false; requestId?: string; reason: string }

/** A scene's glass with the defaults filled in, or `false`. */
export type ThemeFilledGlass = { blur: number; tint?: string; opacity: number } | false

/** The standing theme as a page reads it: who set it, and what it holds. A
 *  scene carries its glass filled in; `backdrop: false` is left out. */
export type ModThemeSnapshot = {
  plugin: string
  requestId: string
  backdrop?: { scene: string; glass: ThemeFilledGlass } | ThemeGround
  overrideColorScheme?: 'light' | 'dark'
  colors?: Record<string, unknown>
}

/** `RenderPropsOf['Backdrop']`. */
export type BackdropRenderProps = {
  scene: string
  plugin: string
  glass: ThemeFilledGlass
  overrideColorScheme?: 'light' | 'dark'
}

/** The `requestId` of a scene's `ui.render` instance, and of a theme with none. */
export const BACKDROP_REQUEST_ID = 'backdrop'
export const THEME_REQUEST_ID = 'theme'

export const THEME_GLASS_DEFAULT = { blur: 16, opacity: 0.6 } as const

/** Velloc's bound on the whole theme as JSON text, so each published ui state
 *  stays small. */
export const THEME_MAX_JSON_CHARS = 262_144
const COLORS_MAX_DEPTH = 8
const PATH_MAX_CHARS = 16_384
const PATH_MAX_NUMBER = 1_000_000
const UNSAFE_KEYS = new Set(['__proto__', 'constructor', 'prototype'])

const RAW_HEX = /^#(?:[0-9a-fA-F]{3,4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/
const RAW_FUNCTION = /^(?:rgba?|hsla?)\(\s*[-+0-9.eE%\s,/]*(?:deg)?[-+0-9.eE%\s,/]*\)$/
const PATH_DATA = /^[MmZzLlHhVvCcSsQqTtAa0-9eE.,+\-\s]+$/
const IMAGE_SOURCE = /^(?:[A-Za-z0-9_.-]+\/)*[A-Za-z0-9_.-]+\.(?:png|jpe?g)$/i

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function fail(message: string): never {
  throw new TypeError(`$.theme.set: ${message}`)
}

function isNumberIn(value: unknown, low: number, high: number): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= low && value <= high
}

/** A color written as is: `#hex`, or an rgb, rgba, hsl or hsla function of numbers. */
export function isRawThemeColor(value: unknown): value is string {
  return typeof value === 'string' && (RAW_HEX.test(value) || RAW_FUNCTION.test(value))
}

/** A ground's color: raw, `transparent`, or a design-system name. */
export function isThemeColor(value: unknown): value is string {
  return (
    isRawThemeColor(value) ||
    value === 'transparent' ||
    (typeof value === 'string' && (THEME_COLOR_NAMES as readonly string[]).includes(value))
  )
}

function onlyKeys(value: Record<string, unknown>, allowed: readonly string[], where: string): void {
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) fail(`${where} takes no key named "${key}"`)
  }
}

function colorOf(value: unknown, where: string): string {
  if (!isThemeColor(value)) fail(`${where} must be a raw color, "transparent" or a design-system color name`)
  return value
}

function tilingOf(value: Record<string, unknown>, where: string): ThemeTiling {
  const out: ThemeTiling = {}
  if (value.size !== undefined) {
    const size = value.size
    if (!Array.isArray(size) || size.length !== 2 || !size.every(side => isNumberIn(side, 1, 256))) {
      fail(`${where}.size must be [width, height], each from 1 to 256`)
    }
    out.size = [size[0] as number, size[1] as number]
  }
  if (value.repeat !== undefined) {
    if (typeof value.repeat !== 'boolean') fail(`${where}.repeat must be a boolean`)
    out.repeat = value.repeat
  }
  return out
}

function glassOf(value: unknown): ThemeGlass | false {
  if (value === false) return false
  if (!isRecord(value)) fail('backdrop.glass must be { blur?, tint?, opacity? } or false')
  onlyKeys(value, ['blur', 'tint', 'opacity'], 'backdrop.glass')
  const glass: ThemeGlass = {}
  if (value.blur !== undefined) {
    if (!isNumberIn(value.blur, 0, 64)) fail('backdrop.glass.blur must be from 0 to 64')
    glass.blur = value.blur
  }
  if (value.tint !== undefined) {
    if (!isRawThemeColor(value.tint)) fail('backdrop.glass.tint must be a raw color: #hex, or an rgb, rgba, hsl or hsla function of numbers')
    glass.tint = value.tint
  }
  if (value.opacity !== undefined) {
    if (!isNumberIn(value.opacity, 0, 1)) fail('backdrop.glass.opacity must be from 0 to 1')
    glass.opacity = value.opacity
  }
  return glass
}

function gradientOf(value: unknown): ThemeGround {
  if (!isRecord(value)) fail('backdrop.gradient must be an object')
  onlyKeys(value, ['stops', 'angle', 'shape', 'size', 'repeat'], 'backdrop.gradient')
  const stops = value.stops
  if (!Array.isArray(stops) || stops.length < 2 || stops.length > 16) fail('backdrop.gradient.stops must hold 2 to 16 colors')
  let last = -1
  const checked: ThemeGradientStop[] = stops.map((stop: unknown, index: number) => {
    if (isRecord(stop)) {
      onlyKeys(stop, ['at', 'color'], `backdrop.gradient.stops[${index}]`)
      if (!isNumberIn(stop.at, 0, 1)) fail(`backdrop.gradient.stops[${index}].at must be from 0 to 1`)
      if (stop.at < last) fail('backdrop.gradient.stops must run in order')
      last = stop.at
      return { at: stop.at, color: colorOf(stop.color, `backdrop.gradient.stops[${index}].color`) }
    }
    const at = index / (stops.length - 1)
    if (at < last) fail('backdrop.gradient.stops must run in order')
    last = at
    return colorOf(stop, `backdrop.gradient.stops[${index}]`)
  })
  const gradient: ThemeTiling & { stops: ThemeGradientStop[]; angle?: number; shape?: 'linear' | 'radial' } = {
    stops: checked,
    ...tilingOf(value, 'backdrop.gradient'),
  }
  if (value.angle !== undefined) {
    if (!isNumberIn(value.angle, -360, 360)) fail('backdrop.gradient.angle must be from -360 to 360')
    gradient.angle = value.angle
  }
  if (value.shape !== undefined) {
    if (value.shape !== 'linear' && value.shape !== 'radial') fail('backdrop.gradient.shape must be "linear" or "radial"')
    gradient.shape = value.shape
  }
  return { gradient }
}

/** Whole SVG path data: path letters and numbers alone, bounded. */
export function isPathData(value: unknown): value is string {
  if (typeof value !== 'string' || value.length === 0 || value.length > PATH_MAX_CHARS) return false
  if (!PATH_DATA.test(value) || !/^\s*[Mm]/.test(value)) return false
  const numbers = value.match(/[-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?/g) ?? []
  return numbers.every(text => Math.abs(Number(text)) <= PATH_MAX_NUMBER)
}

function vectorOf(value: unknown): ThemeGround {
  if (!isRecord(value)) fail('backdrop.vector must be an object')
  onlyKeys(value, ['viewBox', 'paths', 'color', 'size', 'repeat'], 'backdrop.vector')
  const box = value.viewBox
  const viewBox =
    isNumberIn(box, 1, 256)
      ? box
      : Array.isArray(box) && box.length === 2 && box.every(side => isNumberIn(side, 1, 256))
        ? ([box[0], box[1]] as [number, number])
        : fail('backdrop.vector.viewBox must be a side, or [width, height], from 1 to 256')
  const paths = value.paths
  if (!Array.isArray(paths) || paths.length === 0 || paths.length > 64) fail('backdrop.vector.paths must hold 1 to 64 paths')
  const checked: ThemeVectorPath[] = paths.map((path: unknown, index: number) => {
    const where = `backdrop.vector.paths[${index}]`
    if (typeof path === 'string') {
      if (!isPathData(path)) fail(`${where} is not whole path data`)
      return path
    }
    if (!isRecord(path)) fail(`${where} must be path data or { d, strokeWidth?, color? }`)
    onlyKeys(path, ['d', 'strokeWidth', 'color'], where)
    if (!isPathData(path.d)) fail(`${where}.d is not whole path data`)
    const out: { d: string; strokeWidth?: number; color?: string } = { d: path.d }
    if (path.strokeWidth !== undefined) {
      if (!isNumberIn(path.strokeWidth, 0, 64) || path.strokeWidth === 0) fail(`${where}.strokeWidth must be above 0 and at most 64`)
      out.strokeWidth = path.strokeWidth
    }
    if (path.color !== undefined) out.color = colorOf(path.color, `${where}.color`)
    return out
  })
  const vector: ThemeTiling & { viewBox: number | [number, number]; paths: ThemeVectorPath[]; color?: string } = {
    viewBox,
    paths: checked,
    ...tilingOf(value, 'backdrop.vector'),
  }
  if (value.color !== undefined) vector.color = colorOf(value.color, 'backdrop.vector.color')
  return { vector }
}

function imageOf(value: unknown): ThemeGround {
  if (!isRecord(value)) fail('backdrop.image must be an object')
  onlyKeys(value, ['source', 'size', 'repeat'], 'backdrop.image')
  const source = value.source
  if (typeof source !== 'string' || !IMAGE_SOURCE.test(source) || source.split('/').some(part => part === '..' || part === '.')) {
    fail('backdrop.image.source must be a .png or .jpg path inside the mod folder, with / between folders and no ..')
  }
  return { image: { source, ...tilingOf(value, 'backdrop.image') } }
}

const GROUND_KEYS = ['color', 'gradient', 'vector', 'image'] as const

function backdropOf(value: unknown): ThemeScene | ThemeGround | false {
  if (value === false) return false
  if (!isRecord(value)) fail('backdrop must be a scene, a still ground or false')
  const kinds = ['scene', ...GROUND_KEYS].filter(key => value[key] !== undefined)
  if (kinds.length !== 1) fail('backdrop must name exactly one of scene, color, gradient, vector or image')
  const kind = kinds[0]
  if (kind === 'scene') {
    // `id` is accepted as an alias of `scene` for mods that target several engines, and ignored.
    onlyKeys(value, ['scene', 'glass', 'id'], 'backdrop')
    if (!isPaneId(value.scene)) fail('backdrop.scene must be 1-64 of letters, digits, _ and -')
    return value.glass === undefined ? { scene: value.scene } : { scene: value.scene, glass: glassOf(value.glass) }
  }
  onlyKeys(value, [kind!], 'backdrop')
  if (kind === 'color') return { color: colorOf(value.color, 'backdrop.color') }
  if (kind === 'gradient') return gradientOf(value.gradient)
  if (kind === 'vector') return vectorOf(value.vector)
  return imageOf(value.image)
}

/** `colors` held to bounded JSON data: no unsafe key, no named key on a list. */
function boundedJsonProblem(value: unknown, depth: number): string | undefined {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return undefined
  if (typeof value === 'number') return Number.isFinite(value) ? undefined : 'holds a number that is not finite'
  if (depth > COLORS_MAX_DEPTH) return `nests deeper than ${COLORS_MAX_DEPTH}`
  if (Array.isArray(value)) {
    const keys = Object.keys(value)
    if (keys.length !== value.length || keys.some((key, index) => key !== String(index))) return 'has a named key on a list'
    for (const item of value) {
      const problem = boundedJsonProblem(item, depth + 1)
      if (problem) return problem
    }
    return undefined
  }
  if (typeof value !== 'object') return 'holds a value that is not JSON data'
  const proto = Object.getPrototypeOf(value)
  if (proto !== Object.prototype && proto !== null) return 'holds an object that is not plain data'
  for (const key of Object.keys(value)) {
    if (UNSAFE_KEYS.has(key)) return `has the key "${key}"`
    const problem = boundedJsonProblem((value as Record<string, unknown>)[key], depth + 1)
    if (problem) return problem
  }
  return undefined
}

const ATTRIBUTES = ['backdrop', 'overrideColorScheme', 'colors'] as const

/** `$.theme.set`'s argument checked: an unknown attribute is refused by name. */
export function themeSetArgsOf(value: unknown): ThemeSetArgs {
  if (!isRecord(value)) fail('takes one object of attributes: backdrop, overrideColorScheme, colors')
  for (const key of Object.keys(value)) {
    if (!(ATTRIBUTES as readonly string[]).includes(key)) fail(`unknown attribute "${key}"`)
  }
  const args: ThemeSetArgs = {}
  if (value.backdrop !== undefined) args.backdrop = backdropOf(value.backdrop)
  if (value.overrideColorScheme !== undefined) {
    if (value.overrideColorScheme !== 'light' && value.overrideColorScheme !== 'dark') {
      fail('overrideColorScheme must be "light" or "dark"')
    }
    args.overrideColorScheme = value.overrideColorScheme
  }
  if (value.colors !== undefined) {
    if (!isRecord(value.colors)) fail('colors must be an object')
    const problem = boundedJsonProblem(value.colors, 0)
    if (problem) fail(`colors ${problem}`)
    args.colors = value.colors
  }
  if (Object.keys(args).length === 0) fail('names no attribute')
  if (JSON.stringify(args).length > THEME_MAX_JSON_CHARS) fail(`the theme is longer than ${THEME_MAX_JSON_CHARS} characters as JSON`)
  return args
}

/** Whether a hook's answer is one `theme.set` / `theme.clear` takes. */
export function isThemeResult(value: unknown): value is ThemeResult {
  if (!isRecord(value)) return false
  if (value.isDrawn === true) return typeof value.requestId === 'string' && value.requestId !== ''
  return (
    value.isDrawn === false &&
    typeof value.reason === 'string' &&
    (value.requestId === undefined || (typeof value.requestId === 'string' && value.requestId !== ''))
  )
}

function snapshotOf(plugin: string, args: ThemeSetArgs): ModThemeSnapshot {
  const backdrop = args.backdrop
  const isScene = backdrop !== undefined && backdrop !== false && 'scene' in backdrop
  const snapshot: ModThemeSnapshot = { plugin, requestId: isScene ? BACKDROP_REQUEST_ID : THEME_REQUEST_ID }
  if (isScene) {
    const glass = backdrop.glass
    snapshot.backdrop = {
      scene: backdrop.scene,
      glass:
        glass === false
          ? false
          : {
              blur: glass?.blur ?? THEME_GLASS_DEFAULT.blur,
              ...(glass?.tint !== undefined ? { tint: glass.tint } : {}),
              opacity: glass?.opacity ?? THEME_GLASS_DEFAULT.opacity,
            },
    }
  } else if (backdrop !== undefined && backdrop !== false) {
    snapshot.backdrop = backdrop
  }
  if (args.overrideColorScheme) snapshot.overrideColorScheme = args.overrideColorScheme
  if (args.colors) snapshot.colors = args.colors
  return snapshot
}

/**
 * The session's one theme; `changed` runs after each change. The theme each
 * other plugin last set is kept behind it, so when the standing theme's
 * plugin unloads the latest of those stands again.
 */
export class ModThemeState {
  private standing: ModThemeSnapshot | undefined
  /** Replaced themes, one per plugin, oldest first. */
  private behind: ModThemeSnapshot[] = []

  constructor(private readonly changed: () => void) {}

  current(): ModThemeSnapshot | undefined {
    return this.standing
  }

  /** Whether the standing theme draws a scene. */
  hasScene(): boolean {
    const backdrop = this.standing?.backdrop
    return backdrop !== undefined && 'scene' in backdrop
  }

  /** `plugin`'s theme replaces whatever stood. */
  set(plugin: string, args: ThemeSetArgs): ModThemeSnapshot {
    const replaced = this.standing
    this.behind = this.behind.filter(each => each.plugin !== plugin && each.plugin !== replaced?.plugin)
    if (replaced && replaced.plugin !== plugin) this.behind.push(replaced)
    this.standing = snapshotOf(plugin, args)
    this.changed()
    return this.standing
  }

  /** Clears the standing theme, whoever set it, and every theme behind it. Whether one stood. */
  clear(): boolean {
    this.behind = []
    if (!this.standing) return false
    this.standing = undefined
    this.changed()
    return true
  }

  /** `plugin` unloaded: its theme goes, and the latest theme behind it stands. Whether the standing theme changed. */
  clearPlugin(plugin: string): boolean {
    this.behind = this.behind.filter(each => each.plugin !== plugin)
    if (this.standing?.plugin !== plugin) return false
    this.standing = this.behind.pop()
    this.changed()
    return true
  }
}

export const THEME_UNDRAWN_REASON = 'no page draws this session'
export const THEME_CLEARED_REASON = 'the theme was cleared'

/** Core of `theme.set`: the theme stands; it is drawn where a page draws the
 *  session, and waits for one otherwise. */
export function themeSetCore(state: ModThemeState, plugin: string, args: ThemeSetArgs, drawn: boolean): ThemeResult {
  const { requestId } = state.set(plugin, args)
  return drawn ? { isDrawn: true, requestId } : { isDrawn: false, requestId, reason: THEME_UNDRAWN_REASON }
}

/** Core of `theme.clear`. */
export function themeClearCore(state: ModThemeState): ThemeResult {
  state.clear()
  return { isDrawn: false, reason: THEME_CLEARED_REASON }
}
