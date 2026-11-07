/**
 * A plugin's UI contributions as its manifest declares them (F-25): `templates`
 * (session types offered in the launcher list) and `ui.topbar` (command items in
 * the topbar). Read from `plugin.json` alone: nothing here starts a worker.
 * An entry with any bad field is dropped whole and each problem is reported;
 * the other entries stay. Pure.
 */

import type { UpdateChannel } from '../../branding/updateChannels'
import { isLocalizedText, whyNotLocalizedText, type LocalizedText } from '../../config/localizedText'

/** Where a template's launcher is offered: the sidebar list, the project
 *  folder menu, both, or neither (creatable by id only). */
export const TEMPLATE_LAUNCHER_PLACES = ['both', 'sidebar', 'menu', 'hidden'] as const
export type TemplateLauncherPlace = (typeof TEMPLATE_LAUNCHER_PLACES)[number]

/** An icon a manifest names: a plugin-relative `.svg` (full colour, or a mask
 *  drawn in the text colour), or a name from Velloc's curated icon set. */
export type ModUiIconDecl =
  | { kind: 'lucide'; name: string }
  | { kind: 'file'; src: string; dark?: string; mask: boolean }

export type PluginTemplateDecl = {
  title: LocalizedText
  description?: LocalizedText
  icon?: ModUiIconDecl
  launcher: TemplateLauncherPlace
  /** `required`: a session of this type works in a project folder the person
   *  picks, as `code` does, never in the shared workspace. */
  projectFolder?: 'required'
  /** Plugin-relative folder holding `template.md`, `./`-prefixed. */
  path: string
  /** The template is an app (beta only): a topbar icon opens it in its own folder. */
  app?: PluginAppDecl
}

/**
 * An app's files (F-40). Paths other than `seed` are relative to the app's
 * folder, `shared-workspace/app-<appId>`, and never reach outside it or into
 * its `.velloc/`.
 */
export type PluginAppDecl = {
  /** Plugin-relative folder copied into the app's folder, `./`-prefixed. */
  seed: string
  /** Raised when `seed` changes, so an open brings in the files the person did not edit. */
  seedVersion: number
  /** The Express file the app's dashboard is drawn from. */
  surface: string
  /** A JSON file the dashboard reads under `/data`. */
  data?: string
  /** Dashboard event names the plugin answers itself, without the model. */
  localActions?: string[]
}

export type PluginTopbarItemDecl = {
  title: LocalizedText
  icon?: ModUiIconDecl
  /** One of this plugin's commands, as typed after `/` without the plugin
   *  prefix: `review` for `commands/review.md` or a registered `review`. */
  command: string
  args?: string
}

export type PluginUiDecl = {
  topbar?: Record<string, PluginTopbarItemDecl>
}

/** A contribution's key: unique within its plugin by construction. */
export const UI_KEY = /^[a-z0-9][a-z0-9_-]{0,31}$/
/** A plugin name that can form a contribution id. */
export const UI_PLUGIN_NAME = /^[A-Za-z0-9_-]+$/
const COMMAND = /^[A-Za-z0-9_-]{1,64}(?::[A-Za-z0-9_-]{1,64}){0,3}$/
const ARGS_MAX = 500
/** A plugin offers at most this many topbar items; the topbar is shared. */
export const TOPBAR_ITEMS_PER_PLUGIN = 4
/** A plugin offers at most this many apps; each one is a topbar icon. */
export const APPS_PER_PLUGIN = 2
/** An app id: the last segment of its folder name. */
export const APP_ID = /^[a-z0-9][a-z0-9-]{0,62}$/
/** A path inside an app's folder: no segment starts with `.`, so none is `..` or `.velloc`. */
const APP_PATH = /^[A-Za-z0-9_][A-Za-z0-9_.-]*(?:\/[A-Za-z0-9_][A-Za-z0-9_.-]*)*$/
const APP_PATH_MAX = 200
const LOCAL_ACTION = /^[A-Za-z0-9_-]{1,64}$/
const LOCAL_ACTIONS_MAX = 16
const SEED_VERSION_MAX = 1_000_000

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v)
const insidePlugin = (p: string): boolean => p.startsWith('./') && !p.includes('..') && !p.includes('\\')
const svgPath = (p: unknown): p is string => typeof p === 'string' && insidePlugin(p) && /\.svg$/i.test(p)

/** `<plugin>:<key>` — the id of a template, a topbar item or a settings page.
 *  Bundled template ids never hold `:`, so a plugin cannot shadow one. */
export function modUiId(plugin: string, key: string): string {
  return `${plugin}:${key}`
}

/** Whether a template id names a plugin's template (not a bundled type). */
export function isPluginTemplateId(type: string | undefined): type is string {
  if (!type) return false
  const at = type.indexOf(':')
  return at > 0 && UI_PLUGIN_NAME.test(type.slice(0, at)) && UI_KEY.test(type.slice(at + 1))
}

/** The plugin half of a plugin template id. */
export function pluginOfTemplateId(type: string): string {
  return type.slice(0, type.indexOf(':'))
}

/** The id of `plugin`'s app `key`: lower case, `_` read as `-`. Not always an
 *  `APP_ID`; the manifest check refuses one that is not. */
export function appIdOf(plugin: string, key: string): string {
  return `${plugin}-${key}`.toLowerCase().replace(/_/g, '-')
}

type Bad = (message: string) => void

function readIcon(value: unknown, label: string, bad: Bad): ModUiIconDecl | undefined | null {
  if (value === undefined) return undefined
  if (typeof value === 'string') {
    if (value.startsWith('lucide:')) {
      const name = value.slice('lucide:'.length)
      if (/^[a-z0-9-]{1,40}$/.test(name)) return { kind: 'lucide', name }
      bad(`${label}: "${value}" is not an icon name`)
      return null
    }
    if (svgPath(value)) return { kind: 'file', src: value, mask: false }
    bad(`${label}: expected "./path.svg", "lucide:<name>", { "src", "dark"? } or { "mask" }`)
    return null
  }
  if (isRecord(value)) {
    if (value.mask !== undefined) {
      if (svgPath(value.mask)) return { kind: 'file', src: value.mask, mask: true }
      bad(`${label}.mask: must be a "./path.svg" inside the plugin`)
      return null
    }
    if (!svgPath(value.src)) {
      bad(`${label}.src: must be a "./path.svg" inside the plugin`)
      return null
    }
    if (value.dark !== undefined && !svgPath(value.dark)) {
      bad(`${label}.dark: must be a "./path.svg" inside the plugin`)
      return null
    }
    return { kind: 'file', src: value.src, mask: false, ...(typeof value.dark === 'string' ? { dark: value.dark } : {}) }
  }
  bad(`${label}: expected "./path.svg", "lucide:<name>", { "src", "dark"? } or { "mask" }`)
  return null
}

function readText(value: unknown, label: string, bad: Bad, required: boolean): LocalizedText | undefined | null {
  if (value === undefined) {
    if (required) bad(`${label}: required`)
    return required ? null : undefined
  }
  if (isLocalizedText(value)) return value
  bad(`${label} ${whyNotLocalizedText(value)}`)
  return null
}

function readAppPath(value: unknown, label: string, bad: Bad, extension: string): string | null {
  if (typeof value === 'string' && value.length <= APP_PATH_MAX && APP_PATH.test(value) && value.toLowerCase().endsWith(extension)) {
    return value
  }
  bad(`${label}: expected a "${extension}" path inside the app's folder, without "..", a leading "." segment or "\\"`)
  return null
}

function readApp(value: unknown, label: string, appId: string, bad: Bad): PluginAppDecl | null {
  if (!isRecord(value)) {
    bad(`${label}: expected an object`)
    return null
  }
  if (!APP_ID.test(appId)) bad(`${label}: the app id "${appId}" (plugin name and key) must be 1-63 letters, digits and "-", starting with a letter or digit`)
  let seed: string | null = null
  if (typeof value.seed === 'string' && insidePlugin(value.seed)) seed = value.seed.replace(/\/+$/, '')
  else bad(`${label}.seed: must be a relative folder starting with "./" and without ".."`)
  let seedVersion = 1
  if (value.seedVersion !== undefined) {
    const v = value.seedVersion
    if (typeof v === 'number' && Number.isInteger(v) && v >= 1 && v <= SEED_VERSION_MAX) seedVersion = v
    else bad(`${label}.seedVersion: expected a whole number from 1 to ${SEED_VERSION_MAX}`)
  }
  const surface = readAppPath(value.surface, `${label}.surface`, bad, '.a2ui')
  const data = value.data === undefined ? undefined : readAppPath(value.data, `${label}.data`, bad, '.json')
  let localActions: string[] | undefined
  if (value.localActions !== undefined) {
    const list = value.localActions
    if (Array.isArray(list) && list.length <= LOCAL_ACTIONS_MAX && list.every(name => typeof name === 'string' && LOCAL_ACTION.test(name))) {
      localActions = [...new Set(list as string[])]
    } else {
      bad(`${label}.localActions: expected at most ${LOCAL_ACTIONS_MAX} event names of letters, digits, "_" and "-"`)
    }
  }
  if (!seed || !surface || data === null) return null
  return {
    seed,
    seedVersion,
    surface,
    ...(data ? { data } : {}),
    ...(localActions && localActions.length > 0 ? { localActions } : {}),
  }
}

function keyed(
  field: string,
  pluginName: string,
  value: unknown,
  errors: string[],
): Array<[string, Record<string, unknown>]> | undefined {
  if (!isRecord(value)) {
    errors.push(`${field}: expected an object keyed by name`)
    return undefined
  }
  if (!UI_PLUGIN_NAME.test(pluginName)) {
    errors.push(`${field}: the plugin name "${pluginName}" cannot form an id — use letters, digits, "_" and "-" only`)
    return undefined
  }
  const out: Array<[string, Record<string, unknown>]> = []
  for (const [key, raw] of Object.entries(value)) {
    if (!UI_KEY.test(key)) {
      errors.push(`${field}.${key}: the key must be 1-32 lower-case letters, digits, "_" and "-", starting with a letter or digit`)
    } else if (!isRecord(raw)) {
      errors.push(`${field}.${key}: expected an object`)
    } else {
      out.push([key, raw])
    }
  }
  return out
}

/** Validate a manifest's `templates` map. An app template is beta only: on
 *  another channel it is reported and left out. */
export function checkTemplateDecls(
  pluginName: string,
  value: unknown,
  errors: string[],
  channel: UpdateChannel,
): Record<string, PluginTemplateDecl> | undefined {
  const entries = keyed('templates', pluginName, value, errors)
  if (!entries) return undefined
  const out: Record<string, PluginTemplateDecl> = {}
  let apps = 0
  const appIds = new Map<string, string>()
  for (const [key, raw] of entries) {
    const label = `templates.${key}`
    let ok = true
    const bad: Bad = message => {
      ok = false
      errors.push(message)
    }
    let app: PluginAppDecl | null | undefined
    if (raw.app !== undefined) {
      if (channel !== 'beta') {
        errors.push(`${label}.app: apps are served on the beta channel only; the template is left out`)
        continue
      }
      if (apps >= APPS_PER_PLUGIN) {
        errors.push(`${label}: a plugin offers at most ${APPS_PER_PLUGIN} apps; this one is left out`)
        continue
      }
      const appId = appIdOf(pluginName, key)
      const twin = appIds.get(appId)
      if (twin !== undefined) {
        errors.push(`${label}.app: its app id "${appId}" is also templates.${twin}'s; this one is left out`)
        continue
      }
      app = readApp(raw.app, `${label}.app`, appId, bad)
      if (raw.launcher !== undefined && raw.launcher !== 'hidden') bad(`${label}.launcher: an app opens from its topbar icon; expected "hidden" or no launcher`)
      if (raw.projectFolder !== undefined) bad(`${label}.projectFolder: an app works in its own folder; leave projectFolder out`)
    }
    const title = readText(raw.title, `${label}.title`, bad, true)
    const description = readText(raw.description, `${label}.description`, bad, false)
    const icon = readIcon(raw.icon, `${label}.icon`, bad)
    let launcher: TemplateLauncherPlace = app ? 'hidden' : 'both'
    if (raw.launcher !== undefined && raw.app === undefined) {
      if ((TEMPLATE_LAUNCHER_PLACES as readonly unknown[]).includes(raw.launcher)) launcher = raw.launcher as TemplateLauncherPlace
      else bad(`${label}.launcher: expected one of ${TEMPLATE_LAUNCHER_PLACES.join(', ')}`)
    }
    if (raw.projectFolder !== undefined && raw.projectFolder !== 'required' && raw.app === undefined) {
      bad(`${label}.projectFolder: expected "required"`)
    }
    let path = `./templates/${key}`
    if (raw.path !== undefined) {
      if (typeof raw.path === 'string' && insidePlugin(raw.path)) path = raw.path.replace(/\/+$/, '')
      else bad(`${label}.path: must be a relative path starting with "./" and without ".."`)
    }
    if (!ok || !title || app === null) continue
    if (app) {
      apps += 1
      appIds.set(appIdOf(pluginName, key), key)
    }
    out[key] = {
      title,
      ...(description ? { description } : {}),
      ...(icon ? { icon } : {}),
      launcher,
      ...(raw.projectFolder === 'required' && !app ? { projectFolder: 'required' as const } : {}),
      path,
      ...(app ? { app } : {}),
    }
  }
  return Object.keys(out).length > 0 ? out : undefined
}

/** Validate a manifest's `ui` object: `topbar` is built, `settingsPages` is
 *  a reserved name (reported, ignored), anything else is ignored. */
export function checkUiDecl(pluginName: string, value: unknown, errors: string[]): PluginUiDecl | undefined {
  if (!isRecord(value)) {
    errors.push('ui: expected an object')
    return undefined
  }
  if (value.settingsPages !== undefined) {
    errors.push('ui.settingsPages: settings pages are not available yet; ignored')
  }
  if (value.topbar === undefined) return undefined
  const entries = keyed('ui.topbar', pluginName, value.topbar, errors)
  if (!entries) return undefined
  const topbar: Record<string, PluginTopbarItemDecl> = {}
  for (const [key, raw] of entries) {
    const label = `ui.topbar.${key}`
    let ok = true
    const bad: Bad = message => {
      ok = false
      errors.push(message)
    }
    const title = readText(raw.title, `${label}.title`, bad, true)
    const icon = readIcon(raw.icon, `${label}.icon`, bad)
    if (typeof raw.command !== 'string' || !COMMAND.test(raw.command)) {
      bad(`${label}.command: expected one of this plugin's command names, without "/" or the plugin prefix`)
    }
    if (raw.args !== undefined && (typeof raw.args !== 'string' || raw.args.length > ARGS_MAX || /[\r\n]/.test(raw.args))) {
      bad(`${label}.args: expected one line of at most ${ARGS_MAX} characters`)
    }
    if (!ok || !title) continue
    if (Object.keys(topbar).length >= TOPBAR_ITEMS_PER_PLUGIN) {
      errors.push(`${label}: a plugin offers at most ${TOPBAR_ITEMS_PER_PLUGIN} topbar items; this one is left out`)
      continue
    }
    topbar[key] = {
      title,
      ...(icon ? { icon } : {}),
      command: raw.command as string,
      ...(typeof raw.args === 'string' && raw.args.trim() !== '' ? { args: raw.args.trim() } : {}),
    }
  }
  return Object.keys(topbar).length > 0 ? { topbar } : undefined
}
