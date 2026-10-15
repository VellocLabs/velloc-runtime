import { describe, expect, it } from 'vitest'
import { RUNTIME_DIR_NAME } from '../branding/runtimeDir'
import {
  NEXUS_DIR_NAME,
  NEXUS_LOCAL_SETTINGS_FILE_NAME,
  NEXUS_SETTINGS_FILE_NAME,
  SETTINGS_LAYERS,
  type WritableSettingsLayer,
  type SettingsLayer,
} from '../settings/settingSources'

describe('settingSources', () => {
  it('lists sources lowest to highest precedence', () => {
    expect([...SETTINGS_LAYERS]).toEqual([
      'policySettings', 'userSettings', 'projectSettings', 'localSettings', 'flagSettings',
    ])
  })

  it('editable sources are user/project/local', () => {
    const editable: WritableSettingsLayer[] = ['userSettings', 'projectSettings', 'localSettings']
    // @ts-expect-error policy is not editable
    const bad: WritableSettingsLayer = 'policySettings'
    const s: SettingsLayer = editable[0]
    expect(SETTINGS_LAYERS).toContain(s)
    expect(bad).toBeDefined()
  })

  it('file and directory names', () => {
    expect(NEXUS_SETTINGS_FILE_NAME).toBe('settings.json')
    expect(NEXUS_LOCAL_SETTINGS_FILE_NAME).toBe('settings.local.json')
    expect(NEXUS_DIR_NAME).toBe(RUNTIME_DIR_NAME)
  })
})
