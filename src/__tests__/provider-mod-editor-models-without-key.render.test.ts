// @vitest-environment happy-dom
import { createElement } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'

import { ModProviderEditor } from '../browser/webview/settings/sections/ModProviderEditor'
import type { NexusSettingsBridge } from '../browser/webview/nexusSettingsBridge'
import type { BrowserLlmProvider } from '../browser/bridge/protocol/nexus_llm'
import { I18nProvider } from '../browser/webview/i18n'
import type { NexusProviderConfig } from '../settings/settingsTypes'

/**
 * The models section of a provider mod's editor needs a connection, except for
 * a plugin that lets the person add models of their own: that needs no key, so
 * its section (and the Add custom model button) is there before one is saved.
 */

const row = (modelsUi?: Record<string, unknown>): BrowserLlmProvider => ({
  id: 'mod.acme.main',
  label: 'Acme',
  iconSvg: '<svg viewBox="0 0 1 1"></svg>',
  enabled: false,
  models: [],
  mod: {
    state: 'ready',
    plugin: 'acme',
    version: '1.0.0',
    configId: 'acme@inline',
    displayName: 'Acme AI',
    credentialMethods: ['apiKey'],
    secrets: [],
    ...(modelsUi ? { modelsUi } : {}),
  } as BrowserLlmProvider['mod'],
})

function mount(provider: BrowserLlmProvider, saved: NexusProviderConfig | undefined) {
  const bridge = {
    request: vi.fn(async () => ({ ok: true, options: {}, storedSensitive: [], families: [] })),
    subscribeEvents: () => () => {},
  } as unknown as NexusSettingsBridge
  render(
    createElement(
      I18nProvider,
      { locale: 'en' },
      createElement(ModProviderEditor, { provider, saved, bridge, onChanged: vi.fn(async () => {}) }),
    ),
  )
}

afterEach(cleanup)

describe('a provider mod editor\'s models section without a key', () => {
  it('is there, with Add custom model, when the plugin lets the person add models', async () => {
    mount(row({ customModels: { formats: ['openai-chat'] } }), undefined)
    expect(await screen.findByTestId('model-entries')).toBeTruthy()
    expect(screen.getByTestId('model-entries-add-custom')).toBeTruthy()
  })

  it('is not there for a plugin that does not, until a key makes a connection', async () => {
    mount(row({ intro: { en: 'hi' } }), undefined)
    await screen.findByTestId('mod-provider-status')
    expect(screen.queryByTestId('model-entries')).toBeNull()
  })
})
