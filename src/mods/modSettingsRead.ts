/**
 * `$.settings.read`'s argument and the layers the engine puts on its event
 * before any hook runs (F-25).
 */

import type { ModNounHost, ModSettingsSource } from './modNouns'

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

const SETTINGS_SOURCES: readonly string[] = ['user', 'project', 'local', 'flag', 'policy']

/** `$.settings.read`'s argument: `{ source? }`, a source of the five. */
export function settingsReadArgsOf(value: unknown): { source?: ModSettingsSource } {
  const source = isRecord(value) ? value.source : undefined
  if (source !== undefined && !SETTINGS_SOURCES.includes(source as string)) {
    throw new TypeError(`$.settings.read: source must be one of ${SETTINGS_SOURCES.join(', ')}`)
  }
  return source !== undefined ? { source: source as ModSettingsSource } : {}
}

/** One layer a settings read is made of. */
export type ModSettingsLayer = { source: ModSettingsSource; settings: Record<string, unknown> }

/**
 * The layers a read is made of, lowest precedence first: Velloc loads one
 * settings file, the user's, so a read of every source and a read of `user`
 * are its one layer, and a read of any other source has none. A source with
 * no settings is left out.
 */
export async function settingsLayersOf(session: ModNounHost, source: ModSettingsSource | undefined): Promise<ModSettingsLayer[]> {
  if (!session.settings || (source !== undefined && source !== 'user')) return []
  const settings = await session.settings({ source: 'user' })
  return isRecord(settings) && Object.keys(settings).length > 0 ? [{ source: 'user', settings }] : []
}
