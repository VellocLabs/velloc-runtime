// @vitest-environment happy-dom
import { createElement } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'

import { ModelsSection } from '../browser/webview/settings/sections/ModelsSection'
import { SettingsBridgeContext } from '../browser/webview/nexusSettingsBridge'
import type { NexusSettingsBridge } from '../browser/webview/nexusSettingsBridge'
import type { BrowserBridgeTransport } from '../browser/bridge/browserBridgeProtocol'
import type { BrowserLlmCatalog, BrowserLlmProvider } from '../browser/bridge/protocol/nexus_llm'
import { I18nProvider } from '../browser/webview/i18n'
import type { NexusProviderConfig } from '../settings/settingsTypes'

/**
 * The Settings -> Models page for a provider a plugin adds, drawn from the
 * catalog row's `mod` field alone: its name, credential methods, prompts with
 * `when` rules, declared secrets and settings, and the plugin-missing state.
 * The bridge is a fake of the worker's `providers.*` actions.
 */

const ID = 'mod.acme.main'

function modRow(over: Partial<NonNullable<BrowserLlmProvider['mod']>> = {}, label = 'Acme'): BrowserLlmProvider {
  return {
    id: ID,
    label,
    iconSvg: '<svg viewBox="0 0 1 1"></svg>',
    enabled: false,
    models: [],
    mod: {
      state: 'ready',
      plugin: 'acme',
      version: '1.2.0',
      configId: 'acme@inline',
      displayName: { en: 'Acme AI', de: 'Acme KI' },
      credentialMethods: ['apiKey', 'anonymous', 'login'],
      secrets: [{ name: 'refresh_token', label: { en: 'Refresh token', de: 'Auffrischtoken' }, hint: { en: 'Optional' } }],
      settings: {
        region: {
          type: 'string',
          title: { en: 'Region', de: 'Region (de)' },
          description: { en: 'Where it runs' },
          options: ['us', 'eu'],
        },
      },
      prompts: [
        {
          type: 'select',
          key: 'plan',
          message: { en: 'Plan', de: 'Tarif' },
          options: [
            { label: { en: 'Free', de: 'Gratis' }, value: 'free' },
            { label: 'Team', value: 'team' },
          ],
        },
        {
          type: 'text',
          key: 'team_id',
          message: 'Team id',
          pattern: '^t-[0-9]+$',
          when: { key: 'plan', op: 'eq', value: 'team' },
        },
        { type: 'text', key: 'api_key', message: { en: 'Acme key', de: 'Acme-Schlüssel' }, secret: true },
      ],
      ...over,
    },
  }
}

function harness(
  initialConfigs: Record<string, NexusProviderConfig>,
  catalog: BrowserLlmCatalog,
  options: Record<string, unknown> = {},
  verifyResult: Record<string, unknown> = { ok: true, verifiedAtMs: 1 },
) {
  const verifies: string[] = []
  let configs = { ...initialConfigs }
  const upserts: NexusProviderConfig[] = []
  const optionWrites: Array<Record<string, unknown>> = []
  const bridge = {
    request: vi.fn(async (route: { action: string }, payload: Record<string, unknown>) => {
      switch (route.action) {
        case 'list':
          return { configs, activeProviderId: undefined }
        case 'upsert': {
          const config = payload.config as NexusProviderConfig
          upserts.push(config)
          // The worker's redacted view: a key as `hasApiKey`, secrets as names.
          const { apiKey, secrets, ...rest } = config
          const prev = configs[payload.id as string] ?? {}
          const names = [...new Set([...(prev.storedSecrets ?? []), ...Object.keys(secrets ?? {})])]
          configs = {
            ...configs,
            [payload.id as string]: {
              ...rest,
              ...(apiKey || prev.hasApiKey ? { hasApiKey: true } : {}),
              ...(names.length > 0 ? { storedSecrets: names } : {}),
            },
          }
          return { ok: true, configs }
        }
        case 'modOptions':
          return { ok: true, options, storedSensitive: [] }
        case 'setModOptions':
          optionWrites.push(payload)
          return { ok: true }
        case 'verify':
          verifies.push(payload.id as string)
          return verifyResult
        case 'modelFamilies':
          return { ok: true, families: [] }
        default:
          return {}
      }
    }),
    subscribeEvents: () => () => {},
  } as unknown as NexusSettingsBridge
  const transport = {
    request: vi.fn(async () => ({ ok: true, result: { providers: [] } })),
    subscribeEvents: () => () => {},
  } as unknown as BrowserBridgeTransport
  return { bridge, transport, upserts, optionWrites, verifies, catalog }
}

function mount(h: ReturnType<typeof harness>, locale = 'en') {
  render(
    createElement(
      I18nProvider,
      { locale },
      createElement(
        SettingsBridgeContext.Provider,
        { value: h.bridge },
        createElement(ModelsSection, { catalog: h.catalog, transport: h.transport }),
      ),
    ),
  )
}

afterEach(() => {
  cleanup()
  ;(globalThis as { __nexusUnsavedEdits?: number }).__nexusUnsavedEdits = 0
})

const withRow = (row: BrowserLlmProvider): BrowserLlmCatalog => ({ providers: [row] })

async function openFromAddMenu() {
  fireEvent.keyDown(await screen.findByTestId('models-add-provider'), { key: 'Enter' })
  fireEvent.click(await screen.findByTestId(`models-provider-select-option-${ID}`))
}

describe('Add provider menu', () => {
  it('lists a plugin\'s provider by the vendor name in the person\'s language, in its own group', async () => {
    mount(harness({}, withRow(modRow())), 'de')
    fireEvent.keyDown(await screen.findByTestId('models-add-provider'), { key: 'Enter' })
    const item = await screen.findByTestId(`models-provider-select-option-${ID}`)
    expect(item.textContent).toContain('Acme KI')
    expect(await screen.findByTestId('models-add-group-plugins')).toBeTruthy()
  })

  it('does not list a provider whose plugin is missing (it has no way to be added)', async () => {
    mount(harness({}, withRow(modRow({ state: 'plugin-missing' }))))
    fireEvent.keyDown(await screen.findByTestId('models-add-provider'), { key: 'Enter' })
    await screen.findByTestId('models-add-custom-provider')
    expect(screen.queryByTestId(`models-provider-select-option-${ID}`)).toBeNull()
  })
})

describe('credentials form', () => {
  it('shows the methods, hides a prompt until its when rule holds, and validates the pattern', async () => {
    const h = harness({ [ID]: { source: 'mod', modVersion: '1.2.0', account: 'zed' } }, withRow(modRow()))
    mount(h)
    fireEvent.click(await screen.findByTestId(`models-provider-settings-${ID}`))
    expect(await screen.findByTestId('mod-provider-editor')).toBeTruthy()
    expect(screen.getByTestId('models-editing-provider').textContent).toContain('Acme AI')
    for (const m of ['apiKey', 'anonymous', 'login']) expect(screen.getByTestId(`mod-method-${m}`)).toBeTruthy()
    expect(screen.getByTestId('mod-provider-origin').textContent).toContain('acme')

    // team_id waits for plan = team.
    expect(screen.queryByTestId('mod-prompt-team_id')).toBeNull()
    fireEvent.change(screen.getByTestId('mod-prompt-plan'), { target: { value: 'team' } })
    const teamId = await screen.findByTestId('mod-prompt-team_id')
    fireEvent.change(teamId, { target: { value: 'nope' } })
    fireEvent.change(screen.getByTestId('mod-prompt-api_key'), { target: { value: 'sk-1' } })
    fireEvent.click(screen.getByTestId('mod-credentials-save'))
    expect((await screen.findByTestId('mod-prompt-team_id-error')).textContent).toContain('format')
    expect(h.upserts).toHaveLength(0)

    // Back to a plan that has no team id: the prompt goes away again.
    fireEvent.change(screen.getByTestId('mod-prompt-plan'), { target: { value: 'free' } })
    await waitFor(() => expect(screen.queryByTestId('mod-prompt-team_id')).toBeNull())
  })

  it('saves the key against the stored entry, keeping source / modVersion / account', async () => {
    const h = harness({ [ID]: { source: 'mod', modVersion: '1.2.0', account: 'zed' } }, withRow(modRow()))
    mount(h)
    fireEvent.click(await screen.findByTestId(`models-provider-settings-${ID}`))
    fireEvent.change(await screen.findByTestId('mod-prompt-plan'), { target: { value: 'free' } })
    const key = screen.getByTestId('mod-prompt-api_key') as HTMLInputElement
    expect(key.type).toBe('password')
    fireEvent.change(key, { target: { value: ' sk-live ' } })
    fireEvent.click(screen.getByTestId('mod-credentials-save'))
    await waitFor(() => expect(h.upserts).toHaveLength(1))
    expect(h.upserts[0]).toMatchObject({ source: 'mod', modVersion: '1.2.0', account: 'zed', apiKey: 'sk-live' })
    expect('credentialMode' in h.upserts[0]!).toBe(false)
    // The non-secret answer is a plugin option; the key is not.
    await waitFor(() => expect(h.optionWrites).toHaveLength(1))
    expect(h.optionWrites[0]).toMatchObject({
      plugin: 'acme@inline',
      values: { 'signin.plan': 'free' },
    })
    expect(JSON.stringify(h.optionWrites)).not.toContain('sk-live')
    await waitFor(() => expect(screen.getByTestId('mod-prompt-api_key-saved')).toBeTruthy())
  })

  it('a provider that declares no prompts shows the one key field', async () => {
    const h = harness({ [ID]: { source: 'mod', account: 'zed' } }, withRow(modRow({ prompts: [], credentialMethods: ['apiKey'] })))
    mount(h)
    fireEvent.click(await screen.findByTestId(`models-provider-settings-${ID}`))
    fireEvent.change(await screen.findByTestId('mod-prompt-api_key'), { target: { value: 'sk-x' } })
    fireEvent.click(screen.getByTestId('mod-credentials-save'))
    await waitFor(() => expect(h.upserts).toHaveLength(1))
    expect(h.upserts[0]).toMatchObject({ source: 'mod', account: 'zed', apiKey: 'sk-x' })
    expect(h.optionWrites).toHaveLength(0)
    // One method: no selector.
    expect(screen.queryByTestId('mod-method-group')).toBeNull()
  })

  it('anonymous is an explicit choice stored as the provider being on with no key', async () => {
    const h = harness({ [ID]: { source: 'mod', modVersion: '1.2.0', account: 'zed' } }, withRow(modRow()))
    mount(h)
    fireEvent.click(await screen.findByTestId(`models-provider-settings-${ID}`))
    fireEvent.click(await screen.findByTestId('mod-method-anonymous'))
    fireEvent.click(await screen.findByTestId('mod-anonymous-use'))
    await waitFor(() => expect(h.upserts).toHaveLength(1))
    expect(h.upserts[0]).toMatchObject({ source: 'mod', modVersion: '1.2.0', account: 'zed', credentialMode: 'anonymous' })
    expect(h.upserts[0]!.apiKey).toBeUndefined()
    await screen.findByTestId('mod-anonymous-on')
  })

  it('a login method whose stored sign-in holds no token offers Sign in again, and starts nothing by itself', async () => {
    // The account is stored but the declared `refresh_token` is not: the sign-in ended.
    const h = harness({ [ID]: { source: 'mod', account: 'zed' } }, withRow(modRow()))
    mount(h)
    fireEvent.click(await screen.findByTestId(`models-provider-settings-${ID}`))
    fireEvent.click(await screen.findByTestId('mod-method-login'))
    const signIn = (await screen.findByTestId('mod-login-signin')) as HTMLButtonElement
    expect(signIn.disabled).toBe(false)
    expect(signIn.textContent).toContain('Sign in again')
    expect(screen.getByTestId('mod-login-ended').textContent).toContain('has ended')
    expect(h.upserts).toHaveLength(0)
  })

  it('writes a declared secret on its own, against the stored entry', async () => {
    const h = harness({ [ID]: { source: 'mod', modVersion: '1.2.0', account: 'zed' } }, withRow(modRow()))
    mount(h)
    fireEvent.click(await screen.findByTestId(`models-provider-settings-${ID}`))
    const input = await screen.findByTestId('models-secret-refresh_token-input')
    expect((input as HTMLInputElement).type).toBe('password')
    expect(screen.getByTestId('models-secret-refresh_token').textContent).toContain('Refresh token')
    fireEvent.change(input, { target: { value: 'rt-1' } })
    // One Save for the whole form; an untouched key row writes nothing of its own.
    fireEvent.click(screen.getByTestId('mod-credentials-save'))
    await waitFor(() => expect(h.upserts).toHaveLength(1))
    expect(h.upserts[0]).toMatchObject({
      source: 'mod',
      modVersion: '1.2.0',
      account: 'zed',
      secrets: { refresh_token: 'rt-1' },
    })
    expect(h.upserts[0]!.apiKey).toBeUndefined()
  })

  it('draws the declared settings with the vendor text and stores them per plugin', async () => {
    const h = harness({ [ID]: { source: 'mod', account: 'zed' } }, withRow(modRow()), { region: 'eu' })
    mount(h, 'de')
    fireEvent.click(await screen.findByTestId(`models-provider-settings-${ID}`))
    const select = (await screen.findByTestId('mod-option-acme-region')) as HTMLSelectElement
    await waitFor(() => expect(select.value).toBe('eu'))
    expect(screen.getByTestId('mod-option-acme-region-row').textContent).toContain('Region (de)')
    fireEvent.change(select, { target: { value: 'us' } })
    fireEvent.click(screen.getByTestId('mod-credentials-save'))
    await waitFor(() => expect(h.optionWrites).toHaveLength(1))
    expect(h.optionWrites[0]).toEqual({
      plugin: 'acme@inline',
      owned: ['region'],
      values: { region: 'us' },
    })
  })

  it('picks the vendor text by the person\'s locale', async () => {
    const h = harness({ [ID]: { source: 'mod', account: 'zed' } }, withRow(modRow()))
    mount(h, 'de')
    fireEvent.click(await screen.findByTestId(`models-provider-settings-${ID}`))
    expect((await screen.findByTestId('mod-prompt-plan-row')).textContent).toContain('Tarif')
    expect(screen.getByTestId('mod-prompt-api_key-row').textContent).toContain('Acme-Schlüssel')
    expect(screen.getByTestId('models-editing-provider').textContent).toContain('Acme KI')
  })
})

describe('plugin missing', () => {
  it('shows the kept config and an explanation, and offers nothing to edit', async () => {
    const row = modRow({ state: 'plugin-missing', version: '1.2.0' }, 'mod.acme.main')
    // A missing row carries no manifest fields.
    row.mod = { state: 'plugin-missing', version: '1.2.0' }
    const h = harness(
      { [ID]: { source: 'mod', modVersion: '1.2.0', account: 'zed', hasApiKey: true } },
      withRow(row),
    )
    mount(h)
    fireEvent.click(await screen.findByTestId(`models-provider-settings-${ID}`))
    const panel = await screen.findByTestId('mod-provider-missing')
    expect(panel.textContent).toContain('Plugin missing')
    expect(panel.textContent).toContain('is not installed')
    expect(screen.getByTestId('mod-provider-missing-kept').textContent).toContain('An API key is saved.')
    expect(screen.getByTestId('mod-provider-missing-kept').textContent).toContain('zed')
    expect(screen.queryByTestId('mod-prompt-form')).toBeNull()
    expect(screen.queryByTestId('mod-credentials-save')).toBeNull()
    expect(screen.queryByTestId('models-api-key')).toBeNull()
  })
})

describe('verify after saving, and the model picks', () => {
  const save = async (h: ReturnType<typeof harness>) => {
    mount(h)
    fireEvent.click(await screen.findByTestId(`models-provider-settings-${ID}`))
    fireEvent.change(await screen.findByTestId('mod-prompt-plan'), { target: { value: 'free' } })
    fireEvent.change(screen.getByTestId('mod-prompt-api_key'), { target: { value: 'sk-1' } })
    fireEvent.click(screen.getByTestId('mod-credentials-save'))
  }

  it('checks the saved key and, when it works, offers Add models', async () => {
    const h = harness({ [ID]: { source: 'mod', modVersion: '1.2.0', account: 'zed', storedSecrets: ['refresh_token'] } }, withRow(modRow()))
    await save(h)
    await waitFor(() => expect(h.verifies).toEqual([ID]))
    await screen.findByTestId('mod-prompt-saved')
    expect(screen.getByTestId('mod-provider-status').textContent).toBe('Connected')
    expect(screen.queryByTestId('mod-verify-failed')).toBeNull()
    expect(await screen.findByTestId('model-entries-add')).toBeTruthy()
  })

  it('a key that fails the check reads as failed, not connected, and offers no models', async () => {
    const h = harness(
      { [ID]: { source: 'mod', modVersion: '1.2.0', account: 'zed' } },
      withRow(modRow()),
      {},
      { ok: false, errorCode: 'auth_unauthorized', message: 'no' },
    )
    await save(h)
    const failed = await screen.findByTestId('mod-verify-failed')
    expect(failed.textContent).toBe('Unauthorized - check your API key')
    expect(screen.getByTestId('mod-provider-status').textContent).toBe('Failed')
    expect(screen.queryByTestId('mod-prompt-saved')).toBeNull()
    expect(screen.queryByTestId('model-entries-add')).toBeNull()
  })

  it('the anonymous choice has nothing to check', async () => {
    const h = harness({ [ID]: { source: 'mod', modVersion: '1.2.0', account: 'zed', storedSecrets: ['refresh_token'] } }, withRow(modRow()))
    mount(h)
    fireEvent.click(await screen.findByTestId(`models-provider-settings-${ID}`))
    fireEvent.click(await screen.findByTestId('mod-method-anonymous'))
    fireEvent.click(await screen.findByTestId('mod-anonymous-use'))
    await screen.findByTestId('mod-anonymous-on')
    expect(h.verifies).toHaveLength(0)
    expect(await screen.findByTestId('model-entries-add')).toBeTruthy()
  })

  it('a provider with no connection yet offers no model list', async () => {
    const h = harness({}, withRow(modRow()))
    mount(h)
    await openFromAddMenu()
    await screen.findByTestId('mod-provider-editor')
    expect(screen.queryByTestId('model-entries-add')).toBeNull()
  })
})
