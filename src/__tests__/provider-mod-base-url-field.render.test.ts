// @vitest-environment happy-dom
import { createElement } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'

import { ModBaseUrlField } from '../browser/webview/settings/sections/ModBaseUrlField'
import type { NexusSettingsBridge } from '../browser/webview/nexusSettingsBridge'
import type { BrowserLlmModProvider } from '../browser/bridge/protocol/nexus_llm'
import { I18nProvider, useT } from '../browser/webview/i18n'
import { boundBaseUrlField, optionSettingNames, settingsAsUserConfig } from '../browser/webview/settings/modProviderForm'

/**
 * The provider editor's base URL field: the address in force, its save, the
 * way back to the default, and the confirmation for a host outside the
 * provider's declared domains. The bridge is a fake of `providers.setModBaseUrl`.
 */

const DEFAULT = 'https://api.acme.test/v1'

type Answer = Record<string, unknown>

function mount(stored: string | undefined, answer: (payload: Answer) => Answer) {
  const calls: Answer[] = []
  const onSaved = vi.fn(async () => {})
  const bridge = {
    request: vi.fn(async (route: { action: string }, payload: Answer) => {
      expect(route.action).toBe('setModBaseUrl')
      calls.push(payload)
      return answer(payload)
    }),
  } as unknown as NexusSettingsBridge
  const Field = () =>
    createElement(ModBaseUrlField, {
      providerId: 'mod.acme.main',
      providerName: 'Acme AI',
      fieldName: 'gateway',
      label: 'Gateway URL',
      hint: 'Your own gateway',
      defaultBaseUrl: DEFAULT,
      storedBaseUrl: stored,
      bridge,
      onSaved,
      t: useT(),
    })
  render(createElement(I18nProvider, { locale: 'en' }, createElement(Field)))
  return { calls, onSaved }
}

const input = () => screen.getByTestId('mod-base-url-input') as HTMLInputElement
const type = (value: string) => fireEvent.change(input(), { target: { value } })

afterEach(cleanup)

describe('the base URL field', () => {
  it('shows the default when nothing is stored, with nothing to save or return to', () => {
    mount(undefined, () => ({}))
    expect(input().value).toBe(DEFAULT)
    expect(input().type).toBe('url')
    expect(screen.getByTestId('mod-base-url-row').textContent).toContain('Gateway URL')
    expect(screen.getByTestId('mod-base-url-row').textContent).toContain('Your own gateway')
    expect((screen.getByTestId('mod-base-url-save') as HTMLButtonElement).disabled).toBe(true)
    expect(screen.queryByTestId('mod-base-url-use-default')).toBeNull()
    expect(screen.queryByTestId('mod-base-url-default-hint')).toBeNull()
  })

  it('shows the stored address, names the default, and returns to it', async () => {
    const h = mount('http://127.0.0.1:8123/v1', () => ({ ok: true, baseUrl: DEFAULT, overridden: false }))
    expect(input().value).toBe('http://127.0.0.1:8123/v1')
    expect(screen.getByTestId('mod-base-url-default-hint').textContent).toContain(DEFAULT)
    fireEvent.click(screen.getByTestId('mod-base-url-use-default'))
    await waitFor(() => expect(h.onSaved).toHaveBeenCalledTimes(1))
    expect(h.calls).toEqual([{ id: 'mod.acme.main', baseUrl: null }])
    expect(input().value).toBe(DEFAULT)
  })

  it('saves a typed address and shows the one the runtime stored', async () => {
    const h = mount(undefined, () => ({ ok: true, baseUrl: 'http://127.0.0.1:8123/v1', overridden: true }))
    type(' http://127.0.0.1:8123/v1/ ')
    fireEvent.click(screen.getByTestId('mod-base-url-save'))
    await waitFor(() => expect(h.onSaved).toHaveBeenCalledTimes(1))
    expect(h.calls).toEqual([{ id: 'mod.acme.main', baseUrl: 'http://127.0.0.1:8123/v1/' }])
    expect(input().value).toBe('http://127.0.0.1:8123/v1')
    expect(screen.queryByTestId('mod-base-url-confirm')).toBeNull()
  })

  it('shows the runtime\'s refusal in words and saves nothing', async () => {
    const h = mount(undefined, () => ({ ok: false, reason: 'refused', problem: 'scheme' }))
    type('http://gateway.example/v1')
    fireEvent.click(screen.getByTestId('mod-base-url-save'))
    expect((await screen.findByTestId('mod-base-url-problem')).textContent).toContain('https://')
    expect(h.onSaved).not.toHaveBeenCalled()
    expect(screen.queryByTestId('mod-base-url-confirm')).toBeNull()
  })

  it('asks before a host outside the domains, naming the host, and sends the confirmation', async () => {
    const h = mount(undefined, payload =>
      payload.confirmedHost === 'gateway.example'
        ? { ok: true, baseUrl: 'https://gateway.example/v1', overridden: true }
        : { ok: false, reason: 'needs-confirmation', host: 'gateway.example' },
    )
    type('https://gateway.example/v1')
    fireEvent.click(screen.getByTestId('mod-base-url-save'))
    const dialog = await screen.findByTestId('mod-base-url-confirm-dialog')
    expect(dialog.textContent).toContain('gateway.example')
    expect(dialog.textContent).toContain('Acme AI')
    expect(dialog.textContent).toContain('your key will be sent to gateway.example')
    expect(h.onSaved).not.toHaveBeenCalled()
    fireEvent.click(screen.getByTestId('mod-base-url-confirm'))
    await waitFor(() => expect(h.onSaved).toHaveBeenCalledTimes(1))
    expect(h.calls).toEqual([
      { id: 'mod.acme.main', baseUrl: 'https://gateway.example/v1' },
      { id: 'mod.acme.main', baseUrl: 'https://gateway.example/v1', confirmedHost: 'gateway.example' },
    ])
    await waitFor(() => expect(screen.queryByTestId('mod-base-url-confirm-dialog')).toBeNull())
  })

  it('cancelling the confirmation sends nothing more and keeps the previous address stored', async () => {
    const h = mount('https://eu.acme.test/v1', () => ({ ok: false, reason: 'needs-confirmation', host: 'gateway.example' }))
    type('https://gateway.example/v1')
    fireEvent.click(screen.getByTestId('mod-base-url-save'))
    await screen.findByTestId('mod-base-url-confirm-dialog')
    fireEvent.click(screen.getByTestId('mod-base-url-confirm-cancel'))
    await waitFor(() => expect(screen.queryByTestId('mod-base-url-confirm-dialog')).toBeNull())
    expect(h.calls).toHaveLength(1)
    expect(h.onSaved).not.toHaveBeenCalled()
  })
})

describe('a bound settings field in the form model', () => {
  const mod: BrowserLlmModProvider = {
    state: 'ready',
    settings: {
      gateway: { type: 'string', format: 'url', binds: 'baseUrl', title: { en: 'Gateway URL', de: 'Gateway-URL' } },
      region: { type: 'string', title: 'Region' },
    },
  }

  it('is drawn as the base URL field, not as a plugin option', () => {
    expect(boundBaseUrlField(mod, 'de')).toEqual({ name: 'gateway', label: 'Gateway-URL' })
    expect(optionSettingNames(mod)).toEqual(['region'])
    expect(Object.keys(settingsAsUserConfig(mod, { gateway: 'https://stale.example' }, [], 'en').fields)).toEqual(['region'])
    expect(boundBaseUrlField({ state: 'ready', settings: { region: { type: 'string', title: 'Region' } } }, 'en')).toBeNull()
  })
})
