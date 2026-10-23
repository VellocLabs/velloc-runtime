// @vitest-environment happy-dom
/**
 * Settings · Plugins · a mod's Options (F-25): a `required` field with no
 * value and no default is marked as missing until it is set — the mark a
 * person who skipped the setup dialog finds the field by.
 */
import { createElement } from 'react'
import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'

import type { ModsUserConfig } from '../browser/runtimeProtocol'
import { isMissingRequired } from '../browser/webview/settings/modOptionsDraft'
import { ModOptionsForm } from '../browser/webview/settings/sections/ModOptionsForm'

const FIELDS = {
  region: { type: 'string', title: 'Region', description: '', required: true },
  token: { type: 'string', title: 'Token', description: '', required: true, sensitive: true },
  depth: { type: 'number', title: 'Depth', description: '', required: true, default: 2 },
  note: { type: 'string', title: 'Note', description: '' },
} as ModsUserConfig['fields']

afterEach(cleanup)

describe('missing required options', () => {
  it('counts a required field missing only with no value and no default', () => {
    const config: ModsUserConfig = { fields: FIELDS, values: { token: '••••' } }
    expect(Object.keys(FIELDS).filter(name => isMissingRequired(config, name))).toEqual(['region'])
    expect(isMissingRequired({ fields: FIELDS, values: { region: '', token: '' } }, 'token')).toBe(true)
  })

  it('marks the missing ones beside their label, and drops the mark once set', () => {
    render(createElement(ModOptionsForm, { plugin: 'acme', config: { fields: FIELDS, values: {} } }))
    expect(screen.getByTestId('mod-option-acme-region-missing').textContent).toBe('Required, not set')
    expect(screen.getByTestId('mod-option-acme-token-missing')).toBeTruthy()
    expect(screen.queryByTestId('mod-option-acme-depth-missing')).toBeNull()
    expect(screen.queryByTestId('mod-option-acme-note-missing')).toBeNull()
    cleanup()
    render(createElement(ModOptionsForm, { plugin: 'acme', config: { fields: FIELDS, values: { region: 'eu', token: '••••' } } }))
    expect(screen.queryByTestId('mod-option-acme-region-missing')).toBeNull()
    expect(screen.queryByTestId('mod-option-acme-token-missing')).toBeNull()
  })
})
