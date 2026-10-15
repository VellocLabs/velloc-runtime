/**
 * In-memory settings caches, cleared together by `wipeSettingsMemos()` after
 * every successful write: `layerMemo` (per source) and `docMemo` (per file
 * path).
 */

import type { SettingsLayer } from './settingSources'
import type { LoadResult } from './settingsTypes'

// `undefined` = miss. A present entry includes the defaults fallback. Keyed by
// source AND resolved file path: project/local files differ per project root.
const layerMemo = new Map<string, LoadResult>()

function perSourceKey(source: SettingsLayer, path: string): string {
  return `${source}::${path}`
}

export function memoLayerGet(
  source: SettingsLayer,
  path: string,
): LoadResult | undefined {
  return layerMemo.get(perSourceKey(source, path))
}

export function memoLayerPut(
  source: SettingsLayer,
  path: string,
  value: LoadResult,
): void {
  layerMemo.set(perSourceKey(source, path), value)
}

const docMemo = new Map<string, LoadResult>()

export function memoDocGet(path: string): LoadResult | undefined {
  return docMemo.get(path)
}

export function memoDocPut(path: string, value: LoadResult): void {
  docMemo.set(path, value)
}

/**
 * Clear every cached settings result. Called after any successful write
 * via `setSettingsForSource`, by tests that mutate the cache state, and
 * by future sources that change the on-disk picture (e.g. when a project
 * is added). One knob clears everything.
 */
export function wipeSettingsMemos(): void {
  layerMemo.clear()
  docMemo.clear()
}
