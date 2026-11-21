// @vitest-environment happy-dom
/**
 * The topbar picker's settings footer always opens Settings → Models, never a
 * provider's page or app — the per-provider gear covers that (F-27, F-40).
 */
import { createElement as h } from 'react'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'

import type { BrowserLlmCatalog, BrowserLlmProvider, BrowserLlmSelection } from '../browser/bridge/protocol/nexus_llm'
import { EMPTY_MOD_CONTRIBUTIONS, type ModContributionsState } from '../browser/runtimeProtocol/modContributions'
import { ProviderAppOpenerContext, type ProviderAppOpener } from '../browser/webview/apps/providerSettingsApp'
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

describe('the picker footer opens Settings → Models', () => {
  it('for a provider that names a published settings app', () => {
    act(() => setModContributions(APPS))
    const opened: string[] = []
    const calls = pressFooter({ providerId: 'switch', modelId: 'b' }, app => opened.push(app.type))
    expect(opened).toEqual([])
    expect(calls).toEqual(['models'])
  })

  it('for a plain provider, even with a page opener', () => {
    expect(pressFooter({ providerId: 'plain', modelId: 'a' }, undefined)).toEqual(['models'])
  })

  it('without a page opener', () => {
    expect(pressFooter({ providerId: 'plain', modelId: 'a' }, undefined, false)).toEqual(['models'])
  })
})
