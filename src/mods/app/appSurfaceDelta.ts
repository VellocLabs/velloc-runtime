/**
 * Contract: the change between two boards of one app session (F-40), so a
 * page that holds a board is sent what changed and not the board again.
 * `appSurfaceDelta(before, after)` gives the change, `null` when the boards
 * are the same, or `undefined` when only the whole board will do (the data
 * was read whole, or the app changed). `applyAppSurfaceDelta` gives the board
 * after, or `undefined` when the delta's data does not follow the board held.
 * Neither touches its arguments.
 *
 * Security: a delta's patches are applied with `applyAppPatches`, which
 * refuses a pointer that reaches past the data's own keys.
 */

import {
  APP_SURFACE_PLAIN_KEYS,
  type AppSurfaceDelta,
  type AppSurfacePlainKey,
  type AppSurfaceState,
} from '../../browser/runtimeProtocol/modApps'
import { applyAppPatches } from './appStateDiff'

const same = (a: unknown, b: unknown): boolean => a === b || JSON.stringify(a) === JSON.stringify(b)

export function appSurfaceDelta(before: AppSurfaceState, after: AppSurfaceState): AppSurfaceDelta | null | undefined {
  if (before.appId !== after.appId) return undefined
  const delta: AppSurfaceDelta = {}
  const set: Record<string, unknown> = {}
  const unset: AppSurfacePlainKey[] = []
  for (const key of APP_SURFACE_PLAIN_KEYS) {
    if (same(before[key], after[key])) continue
    if (after[key] === undefined) unset.push(key)
    else set[key] = after[key]
  }
  if (Object.keys(set).length > 0) delta.set = set as AppSurfaceDelta['set']
  if (unset.length > 0) delta.unset = unset
  if (before.dataSeq !== after.dataSeq) {
    const patches = after.dataPatches
    if (!patches || patches.from !== before.dataSeq || after.dataSeq === undefined) return undefined
    delta.data = { from: patches.from, dataSeq: after.dataSeq, dataAt: after.dataAt ?? 0, patches: patches.patches }
  }
  return delta.set || delta.unset || delta.data ? delta : null
}

export function applyAppSurfaceDelta(state: AppSurfaceState, delta: AppSurfaceDelta): AppSurfaceState | undefined {
  const { dataPatches: _patches, ...held } = state
  const next: AppSurfaceState = { ...held, ...delta.set }
  for (const key of delta.unset ?? []) delete next[key]
  const data = delta.data
  if (!data) return next
  if (state.dataSeq !== data.from) return undefined
  try {
    next.data = applyAppPatches(state.data, data.patches)
  } catch {
    return undefined
  }
  next.dataSeq = data.dataSeq
  next.dataAt = data.dataAt
  next.dataPatches = { from: data.from, patches: data.patches }
  return next
}
