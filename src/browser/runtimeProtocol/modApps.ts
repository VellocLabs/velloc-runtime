/**
 * UI ⇄ Runtime protocol — `mods/app/<sessionId>` (F-40): the app session's
 * surfaces as its entry file last built. The runtime reads and builds the
 * files; a page draws what it is sent. Session-bound and `observe`: a connection sees the
 * topic of a session in its scope alone. The payload is `null` for a session
 * that is not an app's.
 */

import type { TopicId } from './frames'
import { isTopicSegment } from './topics'

export const MODS_APP_TOPIC_PREFIX = 'mods/app/'
export const MODS_APP_STATE_EVENT = 'state'

export type AppSurfaceErrorKind = 'build' | 'data'

/** Why the newest build or data file is not what the page draws; English, for the model and logs. */
export type AppSurfaceError = { kind: AppSurfaceErrorKind; message: string }

/** One build of the app's entry file: its text and the surfaces it draws, in order. */
export type AppSurfaceBuild = { body: string; hash: string; surfaceIds: string[] }

/** One change to the app's data: an RFC 6901 pointer from the data's root (`""` the root) and its new value, or a removal when `value` is absent. */
export type AppDataPatch = { path: string; value?: unknown }

export type AppSurfaceState = {
  appId: string
  /** The latest successful build; null before one has succeeded. */
  surface: AppSurfaceBuild | null
  /** The data file's value, set under `/data` on each of the app's surfaces. */
  data?: unknown
  /** When the data file was last written (epoch ms). */
  dataAt?: number
  /** Counts the data changes this host published; with `data`. */
  dataSeq?: number
  /** The patches that took the data of the board with `dataSeq === from` to this one; absent when the data was read whole. */
  dataPatches?: { from: number; patches: AppDataPatch[] }
  /** The plugin's own text in the session's language, set under `/text` on each of the app's surfaces; absent when the plugin ships none. */
  text?: Record<string, string>
  /** The app's background module is handling an action of the person's (`mods.appAction`). */
  refreshing: boolean
  /** The latest build failed, or the data file could not be read. */
  errors?: AppSurfaceError[]
  /** Files the person edited that a newer seed would have replaced. */
  seedConflicts?: string[]
  /** The surface actions the manifest names as the plugin's own: the page offers each to `mods.appAction` before the model. */
  localActions?: string[]
}

/** `mods.buildApp`: build the app's entry file again and redraw it. */
export type ModsBuildAppPayload = { sessionId: string }

export type ModsBuildAppResult = { ok: true; surfaceIds: string[] } | { ok: false; message: string }

/** `mods.appAction`: an action on one of the app's own surfaces, offered to the app's background module. */
export type ModsAppActionPayload = { sessionId: string; action: string; context?: unknown }

/** `handled`: the module took the action; false sends it to the model as any surface action. */
export type ModsAppActionResult = { handled: boolean }

const ACTION_NAME = /^[A-Za-z0-9_-]{1,64}$/
/** How an app's pane is drawn: over the chat (`full`) or beside it (`beside`). */
export type AppViewLayout = 'full' | 'beside'

/** `mods.appView`: this client shows the session's app in `layout`, or no longer shows it (null). */
export type ModsAppViewPayload = { sessionId: string; layout: AppViewLayout | null }

/** How the person pressed an app's topbar icon: the icon, its context menu, or an item of a menu the module answered with. */
export const APP_PRESS_TRIGGERS = ['primary', 'context', 'menu'] as const
export type AppPressTrigger = (typeof APP_PRESS_TRIGGERS)[number]

/** `mods.appPress`: a press on an app's topbar icon, offered to the app's background module. `item` names the menu item of a `menu` press. */
export type ModsAppPressPayload = { appId: string; trigger: AppPressTrigger; item?: string }

/** A menu item's label: the plugin's own text, plain or one per locale tag. */
export type AppPressMenuLabel = string | { readonly [locale: string]: string }

export type AppPressMenuItem = { id: string; label: AppPressMenuLabel; disabled?: boolean }

/** What the module wants done with a press; the page carries it out. `url` is one of the plugin's own MCP servers. */
export type AppPressIntent =
  | { kind: 'open' }
  | { kind: 'signIn'; url: string; thenOpen: boolean }
  | { kind: 'signOut'; url: string }
  | { kind: 'menu'; items: AppPressMenuItem[] }
  | { kind: 'handled' }

/** No `intent`: the module gave no answer, and the press does what it does without a module. */
export type ModsAppPressResult = { intent?: AppPressIntent }

export const APP_PRESS_MENU_MAX_ITEMS = 12
export const APP_PRESS_MENU_LABEL_MAX_CHARS = 80
const APP_ID = /^[a-z0-9][a-z0-9-]{0,62}$/

/** The bytes an action's context may take on the wire, as UTF-8 JSON. */
export const APP_ACTION_CONTEXT_MAX_BYTES = 64 * 1024
const contextEncoder = new TextEncoder()

export function modsAppTopic(sessionId: string): TopicId {
  if (!isTopicSegment(sessionId)) {
    throw new RangeError(`[protocol] topic sessionId must be non-empty and contain no '/': ${JSON.stringify(sessionId)}`)
  }
  return `${MODS_APP_TOPIC_PREFIX}${sessionId}`
}

/** The session of a `mods/app/<sessionId>` id; undefined for anything else. */
export function modsAppTopicSession(id: string): string | undefined {
  if (!id.startsWith(MODS_APP_TOPIC_PREFIX)) return undefined
  const rest = id.slice(MODS_APP_TOPIC_PREFIX.length)
  return isTopicSegment(rest) ? rest : undefined
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

/** A page's check of a delivered payload (null is a session with no app). */
export function isAppSurfaceState(value: unknown): value is AppSurfaceState {
  if (!isRecord(value)) return false
  if (typeof value.appId !== 'string' || typeof value.refreshing !== 'boolean') return false
  const surface = value.surface
  if (surface !== null) {
    if (!isRecord(surface) || typeof surface.body !== 'string' || typeof surface.hash !== 'string') return false
    const ids = surface.surfaceIds
    if (!Array.isArray(ids) || ids.length === 0 || !ids.every(id => typeof id === 'string')) return false
  }
  if (value.text !== undefined && !(isRecord(value.text) && Object.values(value.text).every(text => typeof text === 'string'))) return false
  if (value.dataAt !== undefined && typeof value.dataAt !== 'number') return false
  if (value.dataSeq !== undefined && typeof value.dataSeq !== 'number') return false
  if (value.dataPatches !== undefined) {
    const patches = value.dataPatches
    if (!isRecord(patches) || typeof patches.from !== 'number' || !Array.isArray(patches.patches)) return false
    if (!patches.patches.every(p => isRecord(p) && typeof p.path === 'string')) return false
  }
  if (value.errors !== undefined) {
    if (!Array.isArray(value.errors)) return false
    const ok = value.errors.every(e => isRecord(e) && (e.kind === 'build' || e.kind === 'data') && typeof e.message === 'string')
    if (!ok) return false
  }
  if (value.seedConflicts !== undefined && !(Array.isArray(value.seedConflicts) && value.seedConflicts.every(p => typeof p === 'string'))) {
    return false
  }
  if (value.localActions !== undefined && !(Array.isArray(value.localActions) && value.localActions.every(p => typeof p === 'string'))) {
    return false
  }
  return true
}

export function isModsBuildAppPayload(value: unknown): value is ModsBuildAppPayload {
  return isRecord(value) && typeof value.sessionId === 'string' && value.sessionId.length > 0
}

/** Security: the action name has the manifest's form and the context is bounded JSON; anything else is refused at the wire. */
export function isModsAppActionPayload(value: unknown): value is ModsAppActionPayload {
  if (!isRecord(value) || typeof value.sessionId !== 'string' || value.sessionId.length === 0) return false
  if (typeof value.action !== 'string' || !ACTION_NAME.test(value.action)) return false
  if (value.context === undefined) return true
  try {
    const json = JSON.stringify(value.context)
    return json !== undefined && contextEncoder.encode(json).byteLength <= APP_ACTION_CONTEXT_MAX_BYTES
  } catch {
    return false
  }
}

/** Security: the app id and the item have their declared forms; anything else is refused at the wire. */
export function isModsAppPressPayload(value: unknown): value is ModsAppPressPayload {
  if (!isRecord(value) || typeof value.appId !== 'string' || !APP_ID.test(value.appId)) return false
  if (!(APP_PRESS_TRIGGERS as readonly unknown[]).includes(value.trigger)) return false
  if (value.trigger === 'menu') return typeof value.item === 'string' && ACTION_NAME.test(value.item)
  return value.item === undefined
}

const LOCALE_TAG = /^[A-Za-z]{2,3}(?:[-_][A-Za-z0-9]{2,8})*$/
const isLabelText = (text: unknown): text is string =>
  typeof text === 'string' && text.trim() !== '' && text.length <= APP_PRESS_MENU_LABEL_MAX_CHARS

function readAppPressMenuLabel(value: unknown): AppPressMenuLabel | null {
  if (typeof value === 'string') return isLabelText(value) ? value : null
  if (!isRecord(value)) return null
  const entries = Object.entries(value)
  if (entries.length === 0 || !entries.every(([locale, text]) => LOCALE_TAG.test(locale) && isLabelText(text))) return null
  return Object.fromEntries(entries) as { [locale: string]: string }
}

/** One menu item as a module may state it and a page may draw it, or null. */
export function readAppPressMenuItem(value: unknown): AppPressMenuItem | null {
  if (!isRecord(value) || typeof value.id !== 'string' || !ACTION_NAME.test(value.id)) return null
  const label = readAppPressMenuLabel(value.label)
  if (label === null) return null
  if (value.disabled !== undefined && typeof value.disabled !== 'boolean') return null
  return { id: value.id, label, ...(value.disabled === true ? { disabled: true } : {}) }
}

/** A menu's items, or null: 1 to `APP_PRESS_MENU_MAX_ITEMS` well-formed items with distinct ids. */
export function readAppPressMenuItems(value: unknown): AppPressMenuItem[] | null {
  if (!Array.isArray(value) || value.length === 0 || value.length > APP_PRESS_MENU_MAX_ITEMS) return null
  const items = value.map(readAppPressMenuItem)
  if (!items.every((item): item is AppPressMenuItem => item !== null)) return null
  return new Set(items.map(item => item.id)).size === items.length ? items : null
}

/** The intent of a `mods.appPress` answer as a page reads it, or null for none or a shape it does not know. */
export function readAppPressIntent(value: unknown): AppPressIntent | null {
  const intent = isRecord(value) ? value.intent : undefined
  if (!isRecord(intent)) return null
  switch (intent.kind) {
    case 'open':
    case 'handled':
      return { kind: intent.kind }
    case 'signIn':
      return typeof intent.url === 'string' && intent.url !== '' ? { kind: 'signIn', url: intent.url, thenOpen: intent.thenOpen === true } : null
    case 'signOut':
      return typeof intent.url === 'string' && intent.url !== '' ? { kind: 'signOut', url: intent.url } : null
    case 'menu': {
      const items = readAppPressMenuItems(intent.items)
      return items ? { kind: 'menu', items } : null
    }
    default:
      return null
  }
}

export function isModsAppViewPayload(value: unknown): value is ModsAppViewPayload {
  if (!isRecord(value) || typeof value.sessionId !== 'string' || value.sessionId === '') return false
  return value.layout === null || value.layout === 'full' || value.layout === 'beside'
}
