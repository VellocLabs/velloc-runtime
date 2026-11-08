/**
 * An app's state as patches (F-40): the diff between two JSON values as
 * RFC 6901 pointers, and the application of such a patch to a value without
 * touching the value it was applied to. Shared by the worker shim (`$.app`)
 * and the runtime's state document, so what the module diffs is what the
 * document applies.
 *
 * Security: a pointer segment that names a prototype member is refused, so a
 * patch can never reach past the state's own keys.
 */

import type { AppDataPatch } from '../../browser/runtimeProtocol/modApps'

/** Patches a single `$.app.publish` may carry. */
export const APP_PATCH_BATCH_MAX = 256
/** The state's size, in UTF-8 bytes of the file it is written to; the same cap as an app file. */
export const APP_STATE_MAX_BYTES = 1024 * 1024

/** The state as the document writes it, pretty-printed. */
export const appStateText = (value: unknown): string => JSON.stringify(value, null, 2) ?? ''

/** The UTF-8 size of `appStateText(value)`. */
export const appStateBytes = (value: unknown): number => new TextEncoder().encode(appStateText(value)).length

const FORBIDDEN_SEGMENTS: ReadonlySet<string> = new Set(['__proto__', 'constructor', 'prototype'])

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const unescape = (segment: string): string => segment.replace(/~1/g, '/').replace(/~0/g, '~')
const escape = (segment: string): string => segment.replace(/~/g, '~0').replace(/\//g, '~1')

/** The segments of an RFC 6901 pointer; null when it is not one, or names a forbidden key. */
export function parseAppPointer(path: string): string[] | null {
  if (path === '') return []
  if (!path.startsWith('/')) return null
  const segments = path.slice(1).split('/').map(unescape)
  return segments.some(segment => FORBIDDEN_SEGMENTS.has(segment)) ? null : segments
}

/** Why `value` is not a patch batch the document takes, or null. */
export function checkAppPatches(value: unknown): string | null {
  if (!Array.isArray(value)) return '$.app.publish(patches): patches must be an array'
  if (value.length > APP_PATCH_BATCH_MAX) return `$.app.publish(patches): at most ${APP_PATCH_BATCH_MAX} patches a call`
  for (const patch of value) {
    if (!isObject(patch) || typeof patch.path !== 'string') return '$.app.publish(patches): each patch is {path, value?}'
    const segments = parseAppPointer(patch.path)
    if (segments === null) return `$.app.publish(patches): "${patch.path}" is not a JSON pointer the state takes`
    if (segments.length === 0 && !('value' in patch)) return '$.app.publish(patches): the root cannot be removed; set it to {}'
  }
  return null
}

/**
 * The patches that turn `before` into `after`: objects by key (a key gone is
 * a removal), arrays of one length by index, anything else replaced whole
 * when it is not the same value.
 */
export function diffJson(before: unknown, after: unknown, base = ''): AppDataPatch[] {
  if (before === after) return []
  if (isObject(before) && isObject(after)) {
    const patches: AppDataPatch[] = []
    for (const key of Object.keys(before)) {
      if (!(key in after)) patches.push({ path: `${base}/${escape(key)}` })
    }
    for (const key of Object.keys(after)) {
      if (FORBIDDEN_SEGMENTS.has(key)) continue
      patches.push(...diffJson(before[key], after[key], `${base}/${escape(key)}`))
    }
    return patches
  }
  if (Array.isArray(before) && Array.isArray(after) && before.length === after.length) {
    const patches: AppDataPatch[] = []
    for (let i = 0; i < after.length; i++) patches.push(...diffJson(before[i], after[i], `${base}/${i}`))
    return patches
  }
  if (typeof after === 'number' && typeof before === 'number' && Number.isNaN(after) && Number.isNaN(before)) return []
  return [{ path: base, value: after }]
}

/**
 * `root` with `patch` applied, the containers along the path copied and
 * everything else shared: the value given is not changed. A missing
 * container on the way is created (an object, or an array when the next
 * segment is an index). Throws when the path runs through a primitive or
 * past an array's end.
 */
export function applyAppPatch(root: unknown, patch: AppDataPatch): unknown {
  const segments = parseAppPointer(patch.path)
  if (segments === null) throw new RangeError(`the path "${patch.path}" is not one the state takes`)
  const remove = !('value' in patch)
  if (segments.length === 0) return remove ? {} : patch.value
  return applyAt(root, segments, 0, remove ? undefined : patch.value, remove, patch.path)
}

function applyAt(node: unknown, segments: readonly string[], index: number, value: unknown, remove: boolean, path: string): unknown {
  const segment = segments[index]!
  const last = index === segments.length - 1
  if (Array.isArray(node)) {
    const at = segment === '-' ? node.length : /^(0|[1-9]\d*)$/.test(segment) ? Number(segment) : -1
    if (at < 0 || at > node.length || (at === node.length && remove)) {
      throw new RangeError(`the path "${path}" is outside the array at its segment "${segment}"`)
    }
    const copy = node.slice()
    if (last) {
      if (remove) copy.splice(at, 1)
      else copy[at] = value
      return copy
    }
    copy[at] = applyAt(at === node.length ? undefined : node[at], segments, index + 1, value, remove, path)
    return copy
  }
  if (node !== undefined && node !== null && !isObject(node)) {
    throw new RangeError(`the path "${path}" runs through a value that is not an object or array at "${segment}"`)
  }
  const current = node ?? undefined
  if (last) {
    if (remove) {
      if (!current || !(segment in current)) return current ?? {}
      const { [segment]: _gone, ...rest } = current
      return rest
    }
    return { ...(current ?? {}), [segment]: value }
  }
  const child = current?.[segment]
  if (remove && (current === undefined || !(segment in current))) return current ?? {}
  const next = segments[index + 1]!
  const seed = child !== undefined ? child : /^(0|[1-9]\d*|-)$/.test(next) ? [] : undefined
  return { ...(current ?? {}), [segment]: applyAt(seed, segments, index + 1, value, remove, path) }
}

/** `root` with every patch of `patches` applied in order. */
export function applyAppPatches(root: unknown, patches: readonly AppDataPatch[]): unknown {
  let value = root
  for (const patch of patches) value = applyAppPatch(value, patch)
  return value
}
