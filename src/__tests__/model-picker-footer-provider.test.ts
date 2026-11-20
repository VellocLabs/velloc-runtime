// @vitest-environment happy-dom
/**
 * The topbar picker's settings footer opens the SELECTED provider (F-27, F-40):
 * its published settings app when it names one and the page can open apps,
 * else that provider's settings page, else Settings → Models.
 */
import { createElement as h } from 'react'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'

import type { BrowserLlmCatalog, BrowserLlmProvider, BrowserLlmSelection } from '../browser/bridge/protocol/nexus_llm'
import { EMPTY_MOD_CONTRIBUTIONS, type ModContributionsState } from '../browser/runtimeProtocol/modContributions'
import { ProviderAppOpenerContext, providerSettingsTarget, type ProviderAppOpener } from '../browser/webview/apps/providerSettingsApp'
import { setModContributions } from '../browser/webview/mods/modContributionsView'
import { NexusModelPicker } from '../browser/webview/topbar/NexusModelPicker'

const providers = [
  { id: 'plain', label: 'Plain', enabled: true, iconSvg: '', defaultModelId: 'a', models: [{ id: 'a', label: 'A', enabled: true }] },
  {
    id: 'switch', label: 'Switch', enabled: true, iconSvg: '', defaultModelId: 'b',
    mod: { plugin: 'switch', settingsApp: 'switch-console' },
    models: [{ id: 'b', label: 'B', enabled: true }],
  },
] as unknown as BrowserLlmProvider[]
const catalog = { providers, defaultSelection: { providerId: 'plain', modelId: 'a' } } as unknown as BrowserLlmCatalog

const APPS: ModContributionsState = {
  ...EMPTY_MOD_CONTRIBUTIONS,
  apps: [{ type: 'switch:console', appId: 'switch-console', plugin: 'switch', title: 'Switchboard', topbar: false }],
}

afterEach(() => {
  cleanup()
  act(() => setModContributions(EMPTY_MOD_CONTRIBUTIONS))
})

function pressFooter(selection: BrowserLlmSelection, opener: ProviderAppOpener | undefined, withPage = true) {
  const calls: string[] = []
  const picker = h(NexusModelPicker, {
    catalog,
    selection,
    onSelect: () => {},
    onOpenSettings: () => calls.push('models'),
    ...(withPage ? { onOpenProviderSettings: (id: string) => calls.push(`page:${id}`) } : {}),
    openToken: 1,
  })
  render(opener ? h(ProviderAppOpenerContext.Provider, { value: opener }, picker) : picker)
  fireEvent.click(screen.getByTestId('nexus-model-picker-provider-settings'))
  return calls
}

describe('the picker footer opens the selected provider', () => {
  it("opens the provider's settings app when it names a published one", () => {
    act(() => setModContributions(APPS))
    const opened: string[] = []
    const calls = pressFooter({ providerId: 'switch', modelId: 'b' }, app => opened.push(app.type))
    expect(opened).toEqual(['switch:console'])
    expect(calls).toEqual([])
  })

  it("opens the provider's settings page when its app is not published (stable)", () => {
    const calls = pressFooter({ providerId: 'switch', modelId: 'b' }, () => { throw new Error('no app') })
    expect(calls).toEqual(['page:switch'])
  })

  it("opens the provider's settings page when the page cannot open apps", () => {
    act(() => setModContributions(APPS))
    expect(pressFooter({ providerId: 'switch', modelId: 'b' }, undefined)).toEqual(['page:switch'])
  })

  it("opens a provider with no app at its settings page", () => {
    expect(pressFooter({ providerId: 'plain', modelId: 'a' }, undefined)).toEqual(['page:plain'])
  })

  it('falls back to Settings → Models without a page opener', () => {
    expect(pressFooter({ providerId: 'plain', modelId: 'a' }, undefined, false)).toEqual(['models'])
  })
})

describe('providerSettingsTarget', () => {
  it('is the Models page when no provider is selected', () => {
    expect(providerSettingsTarget(undefined, APPS.apps, true)).toEqual({ kind: 'models' })
  })
  it("ignores an app id another plugin holds", () => {
    expect(providerSettingsTarget({ id: 'x', mod: { plugin: 'other', settingsApp: 'switch-console' } }, APPS.apps, true))
      .toEqual({ kind: 'page', providerId: 'x' })
  })
})
