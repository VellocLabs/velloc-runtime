/**
 * Validation for the auto-compact keys: `autoCompaction` (absent = on),
 * `autoCompactWindow` and per-model `modelSettings`. A window outside
 * [{@link MIN_AUTO_COMPACT_WINDOW}, {@link MAX_AUTO_COMPACT_WINDOW}] is dropped;
 * normalizers return `undefined` when nothing valid survives.
 */

import type { NexusModelSettings, NexusModelSettingsEntry } from './settingsTypes'

export const MIN_AUTO_COMPACT_WINDOW = 100_000
export const MAX_AUTO_COMPACT_WINDOW = 1_000_000

export function isAutoCompactWindow(value: unknown): value is number {
  return (
    typeof value === 'number'
    && Number.isInteger(value)
    && value >= MIN_AUTO_COMPACT_WINDOW
    && value <= MAX_AUTO_COMPACT_WINDOW
  )
}

function normalizeEntry(raw: unknown): NexusModelSettingsEntry | undefined {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return undefined
  const window = (raw as Record<string, unknown>).autoCompactWindow
  return isAutoCompactWindow(window) ? { autoCompactWindow: window } : undefined
}

export function normalizeModelSettings(raw: unknown): NexusModelSettings | undefined {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return undefined
  const out: NexusModelSettings = {}
  for (const [modelId, entry] of Object.entries(raw as Record<string, unknown>)) {
    if (!modelId) continue
    const normalized = normalizeEntry(entry)
    if (normalized) out[modelId] = normalized
  }
  return Object.keys(out).length > 0 ? out : undefined
}
