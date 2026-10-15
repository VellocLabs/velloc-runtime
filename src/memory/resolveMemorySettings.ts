/**
 * Resolve the flat auto-memory keys into `ResolvedMemorySettings` at boot.
 * Security: the toggles may come from merged settings, but
 * `autoMemoryDirectory` only from `userSettings` / `localSettings`, so a
 * repo's settings cannot redirect memory writes.
 */

import type { RuntimeFs } from '../utils/fs/runtimeFs'
import { parseMemoryMaintenance, type ResolvedMemorySettings } from './memoryPaths'
import {
  readLayer,
  loadEffectiveSettings,
  type SettingsPathContext,
  type SettingsLayer,
} from '../settings/settingsStore'

/**
 * Read the flat auto-memory keys and produce the boot snapshot. Non-throwing —
 * any read failure yields an empty snapshot (env vars + defaults then decide).
 */
export async function resolveMemorySettings(
  ctx: SettingsPathContext,
  fs: RuntimeFs,
): Promise<ResolvedMemorySettings> {
  const resolved: ResolvedMemorySettings = {}

  // Toggles: from the merged effective settings (project settings allowed).
  try {
    const { settings } = await loadEffectiveSettings(ctx, fs)
    if (typeof settings.autoMemoryEnabled === 'boolean') {
      resolved.autoMemoryEnabled = settings.autoMemoryEnabled
    }
    const mode = parseMemoryMaintenance(settings.memoryMaintenance)
    if (mode !== undefined) resolved.memoryMaintenance = mode
    if (typeof settings.autoExtractEnabled === 'boolean') {
      resolved.autoExtractEnabled = settings.autoExtractEnabled
    }
    if (typeof settings.memoryRecallEnabled === 'boolean') {
      resolved.memoryRecallEnabled = settings.memoryRecallEnabled
    }
  } catch {
    /* non-fatal — leave toggles unset (env + default decide) */
  }

  // Directory: TRUSTED sources only. Highest precedence first
  // (localSettings overrides userSettings); projectSettings is NEVER read.
  const trustedDirSources: SettingsLayer[] = ctx.projectRoot
    ? ['localSettings', 'userSettings']
    : ['userSettings']
  for (const source of trustedDirSources) {
    try {
      const { settings } = await readLayer(source, ctx, fs)
      const dir = settings.autoMemoryDirectory
      if (typeof dir === 'string' && dir.length > 0) {
        resolved.autoMemoryDirectory = dir
        break
      }
    } catch {
      /* skip this source — try the next, then fall back to env/default */
    }
  }

  return resolved
}

/**
 * Security: an UNTRUSTED-provider child's memory snapshot: every memory
 * feature off (explicit `false` / `'off'`; absent means on), since memory
 * content is outside its read roots and the prompt is uploaded.
 */
export const UNTRUSTED_CHILD_MEMORY_SETTINGS: Readonly<ResolvedMemorySettings> = {
  autoMemoryEnabled: false,
  memoryMaintenance: 'off',
  autoExtractEnabled: false,
  memoryRecallEnabled: false,
}
