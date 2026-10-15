/**
 * Where settings come from, and the on-disk names of the settings files.
 */
import { RUNTIME_DIR_NAME } from '../branding/runtimeDir'

/** Settings sources, lowest to highest merge precedence. Only `userSettings` is wired today. */
export const SETTINGS_LAYERS = [
  'policySettings',
  'userSettings',
  'projectSettings',
  'localSettings',
  'flagSettings',
] as const

export type SettingsLayer = (typeof SETTINGS_LAYERS)[number]

/** Sources a user can write to. */
export type WritableSettingsLayer = Extract<
  SettingsLayer,
  'userSettings' | 'projectSettings' | 'localSettings'
>

/** File for user and project settings. */
export const NEXUS_SETTINGS_FILE_NAME = 'settings.json'
/** File for local (uncommitted) settings. */
export const NEXUS_LOCAL_SETTINGS_FILE_NAME = 'settings.local.json'
/** Directory holding the settings files. */
export const NEXUS_DIR_NAME = RUNTIME_DIR_NAME
