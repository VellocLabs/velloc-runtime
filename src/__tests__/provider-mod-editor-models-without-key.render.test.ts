// @vitest-environment happy-dom
import { createElement } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'

import { ModProviderEditor } from '../browser/webview/settings/sections/ModProviderEditor'
import type { NexusSettingsBridge } from '../browser/webview/nexusSettingsBridge'
import type { BrowserLlmProvider } from '../browser/bridge/protocol/nexus_llm'
import { I18nProvider } from '../browser/webview/i18n'
import type { NexusProviderConfig } from '../settings/settingsTypes'

/**
 * The models section of a provider mod's editor needs a connection, except for
 * a plugin that lets the person add models of their own: its section is there
 * before a key is saved, locked until the listing has something to add from.
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
  it('is there, locked, when the plugin lets the person add models: a listing that needs the key lists nothing', async () => {
    mount(row({ customModels: { formats: ['openai-chat'] } }), undefined)
    expect(await screen.findByTestId('model-entries')).toBeTruthy()
    await waitFor(() =>
      expect((screen.getByTestId('model-entries-add-custom') as HTMLButtonElement).disabled).toBe(true),
    )
    expect((screen.getByTestId('model-entries-add') as HTMLButtonElement).disabled).toBe(true)
    expect(screen.getByTestId('model-entries-empty').textContent).toBe('Add your API key above to load the model list.')
  })

  it('a saved key the check rejected is not read as a missing key: the listing error and Retry show', async () => {
    const request = vi.fn(async (route: { action: string }) => {
      if (route.action === 'verify') return { ok: false, errorCode: 'auth_invalid' }
      if (route.action === 'modelFamilies') return { ok: false, error: 'HTTP 401', families: [] }
      return { ok: true, options: {}, storedSensitive: [], configs: {} }
    })
    const bridge = { request, subscribeEvents: () => () => {} } as unknown as NexusSettingsBridge
    render(
      createElement(
        I18nProvider,
        { locale: 'en' },
        createElement(ModProviderEditor, {
          provider: row({ customModels: { formats: ['gemini'] } }),
          saved: { hasApiKey: true },
          bridge,
          onChanged: vi.fn(async () => {}),
        }),
      ),
    )
    fireEvent.change(await screen.findByTestId('mod-prompt-api_key'), { target: { value: 'sk-wrong' } })
    fireEvent.submit(screen.getByTestId('mod-prompt-form'))
    expect(await screen.findByTestId('mod-verify-failed')).toBeTruthy()
    expect(await screen.findByTestId('model-entries-list-error')).toBeTruthy()
    expect(screen.getByTestId('model-entries-empty').textContent).toBe('No models added yet.')
    expect((screen.getByTestId('model-entries-add-custom') as HTMLButtonElement).disabled).toBe(false)
  })

  it('is not there for a plugin that does not, until a key makes a connection', async () => {
    mount(row({ intro: { en: 'hi' } }), undefined)
    await screen.findByTestId('mod-provider-status')
    expect(screen.queryByTestId('model-entries')).toBeNull()
  })
})
