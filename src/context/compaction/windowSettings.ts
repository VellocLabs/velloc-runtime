// Where the auto-compact window and switch come from: settings.json keys
// `autoCompaction`, `autoCompactWindow`, `modelSettings.<modelId>.autoCompactWindow`.
// The highest-precedence file that sets a window decides; within a file the
// per-model entry wins. Re-read on every trigger attempt; the composer uses the
// last read.

import type { RuntimeFs } from '../../utils/fs/runtimeFs'
import type { SettingsLayer } from '../../settings/settingSources'
import type { NexusSettingsV1 } from '../../settings/settingsTypes'
import {
  loadSettingsBySourceHighFirst,
  updateUserModelAutoCompactWindow,
} from '../../settings/settingsStore'
import { resolveModelId } from '../../config/nexusModelConfig/modelEntryResolution'
import {
  isAutoCompactWindow,
  MAX_AUTO_COMPACT_WINDOW,
  MIN_AUTO_COMPACT_WINDOW,
} from '../../settings/modelSettings'

export { MAX_AUTO_COMPACT_WINDOW, MIN_AUTO_COMPACT_WINDOW }

export type AutoCompactWindowInput =
  | { kind: 'auto' }
  | { kind: 'tokens'; tokens: number }
  | { kind: 'invalid' }

/**
 * Parse a user-typed window: `auto`; a plain token count (`200000`); a `k` /
 * `m` suffix (`400k`, `1M`, `1.5m`); or a bare 100–1000, read as thousands
 * (`300` = 300 000). The result must land in 100K–1M.
 */
export function parseAutoCompactWindowInput(text: string): AutoCompactWindowInput {
  const value = text.trim().toLowerCase()
  if (value === 'auto') return { kind: 'auto' }
  const match = /^(\d+(?:\.\d+)?)\s*([km])?$/.exec(value)
  if (!match) return { kind: 'invalid' }
  let tokens = Number(match[1])
  if (match[2] === 'k') tokens *= 1_000
  else if (match[2] === 'm') tokens *= 1_000_000
  else if (Number.isInteger(tokens) && tokens >= 100 && tokens <= 1_000) tokens *= 1_000
  tokens = Math.round(tokens)
  return isAutoCompactWindow(tokens) ? { kind: 'tokens', tokens } : { kind: 'invalid' }
}

export type AutoCompactChoice = {
  /** Automatic compaction is on. Absent everywhere = on. */
  enabled: boolean
  /** The window that applies, when any file sets one. */
  windowTokens?: number
  /** The file it came from. */
  windowSource?: SettingsLayer
  /** Whether it is the model's own entry or the every-model key. */
  windowScope?: 'model' | 'allModels'
}

type SettingsFile = { source: SettingsLayer; settings: NexusSettingsV1 }

/** Pure resolution over files ordered highest precedence first. */
export function chooseAutoCompactWindow(
  filesHighFirst: readonly SettingsFile[],
  modelId: string | undefined,
): AutoCompactChoice {
  let enabled: boolean | undefined
  let window: Omit<AutoCompactChoice, 'enabled'> | undefined
  for (const { source, settings } of filesHighFirst) {
    if (enabled === undefined && typeof settings.autoCompaction === 'boolean') {
      enabled = settings.autoCompaction
    }
    if (window) continue
    const own = modelId ? settings.modelSettings?.[modelId]?.autoCompactWindow : undefined
    if (own !== undefined) {
      window = { windowTokens: own, windowSource: source, windowScope: 'model' }
    } else if (settings.autoCompactWindow !== undefined) {
      window = {
        windowTokens: settings.autoCompactWindow,
        windowSource: source,
        windowScope: 'allModels',
      }
    }
  }
  return { enabled: enabled ?? true, ...window }
}

/**
 * The id a model's settings are kept under: the concrete model, so a model
 * entry the picker offers (`<family>@latest`) and an explicit pin of the
 * model it resolves to share one entry.
 */
export function modelSettingsKey(
  modelId: string | undefined,
  providerId: string | undefined,
): string | undefined {
  return modelId ? resolveModelId(providerId, modelId) : undefined
}

export type AutoCompactWindowSettings = {
  /** Read the settings files without resolving. The runtime awaits this once
   *  when it is built, so its first snapshot already carries the user's
   *  switch and window. Never throws. */
  load(): Promise<void>
  /** Re-read the settings files and resolve for the model. Never throws: a
   *  failed read resolves to the defaults (on, model window). */
  resolve(modelId: string | undefined, providerId?: string): Promise<AutoCompactChoice>
  /** Resolve for the model from the files last read, without I/O. */
  current(modelId: string | undefined, providerId?: string): AutoCompactChoice
  /** False when the host has no settings file to save into. */
  readonly canSave: boolean
  /** Save (`tokens`) or clear (`'auto'`) the model's window in the user
   *  settings file, then re-read. Throws on a failed write. */
  saveForModel(
    modelId: string,
    providerId: string | undefined,
    value: number | 'auto',
  ): Promise<AutoCompactChoice>
}

export function createAutoCompactWindowSettings(deps: {
  homeDir: string | null
  projectRoot: () => string | undefined
  fs: () => RuntimeFs
}): AutoCompactWindowSettings {
  let files: readonly SettingsFile[] = []

  const reload = async (): Promise<void> => {
    if (!deps.homeDir) return
    try {
      files = await loadSettingsBySourceHighFirst(
        { homeDir: deps.homeDir, projectRoot: deps.projectRoot() },
        deps.fs(),
      )
    } catch {
      files = []
    }
  }

  return {
    load: reload,
    async resolve(modelId, providerId) {
      await reload()
      return chooseAutoCompactWindow(files, modelSettingsKey(modelId, providerId))
    },
    current(modelId, providerId) {
      return chooseAutoCompactWindow(files, modelSettingsKey(modelId, providerId))
    },
    canSave: deps.homeDir !== null,
    async saveForModel(modelId, providerId, value) {
      if (!deps.homeDir) throw new Error('no settings file on this host')
      const key = modelSettingsKey(modelId, providerId)!
      await updateUserModelAutoCompactWindow(
        deps.homeDir,
        deps.fs(),
        key,
        value === 'auto' ? null : value,
      )
      await reload()
      return chooseAutoCompactWindow(files, key)
    },
  }
}
