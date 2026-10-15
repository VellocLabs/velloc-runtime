// @vitest-environment happy-dom
import { createElement } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'

import { NexusModelPicker } from '../browser/webview/topbar/NexusModelPicker'
import { SettingsBridgeContext, type NexusSettingsBridge } from '../browser/webview/nexusSettingsBridge'
import type {
  BrowserLlmCatalog,
  BrowserLlmModel,
  BrowserLlmProvider,
} from '../browser/bridge/protocol/nexus_llm'
import type { ScopeMode } from '../browser/runtimeProtocol'
import { RuntimeCapabilitiesContext } from '../browser/webview/useCan'
import { advertsForScope, queryFor } from './_helpers/capabilityQuery'

/**
 * The quick picker with model entries: one row per entry — a family's Latest
 * names the version it means today, a pinned version carries a pin, a preview
 * a badge — and each provider heading's `⋯` menu, which pins another version
 * of one of its families as a row of its own (selected as soon as the catalog
 * carries it) and opens the provider's settings page. There is no removal in
 * the picker.
 */

afterEach(cleanup)

const entryRow = (
  version: string,
  label: string,
  resolvedVersion: string,
  preview = false,
): BrowserLlmModel => ({
  id: `claude-opus-*@${version}`,
  label,
  enabled: true,
  supportsStreaming: true,
  defaultThinkingTier: 'high',
  availableThinkingTiers: ['low', 'high'],
  entry: {
    kind: version === 'latest' ? 'latest' : 'pinned',
    family: 'claude-opus-*',
    familyLabel: 'Claude Opus',
    version,
    resolvedVersion,
    resolvedId: `claude-opus-${resolvedVersion.replace('.', '-')}`,
    preview,
  },
})

function anthropic(models: BrowserLlmModel[], pinned: string[] = []): BrowserLlmProvider {
  return {
    id: 'anthropic',
    label: 'Anthropic',
    iconSvg: '',
    enabled: true,
    models,
    entryFamilies: [{
      family: 'claude-opus-*',
      familyLabel: 'Claude Opus',
      versions: [
        { versionLabel: '5.5', id: 'claude-opus-5-5', preview: false, pinned: pinned.includes('5.5') },
        { versionLabel: '5', id: 'claude-opus-5', preview: false, pinned: pinned.includes('5') },
        { versionLabel: '6-preview', id: 'claude-opus-6-preview', preview: true, pinned: false },
      ],
    }],
  }
}

const catalogOf = (provider: BrowserLlmProvider): BrowserLlmCatalog =>
  ({ providers: [provider] }) as unknown as BrowserLlmCatalog

function setup(scope: ScopeMode = 'full') {
  const calls: Array<{ action: string; payload: any }> = []
  const bridge = {
    request: vi.fn(async (route: { action: string }, payload: unknown) => {
      calls.push({ action: route.action, payload })
      if (route.action === 'list') {
        return { configs: { anthropic: { modelEntries: [{ family: 'claude-opus-*', version: 'latest' }, { family: 'gone-*', version: '1' }] } }, source: 'file', order: [] }
      }
      return { ok: true, configs: {} }
    }),
  } as unknown as NexusSettingsBridge
  const onSelect = vi.fn()
  const onOpenProviderSettings = vi.fn()
  const props = {
    selection: { providerId: 'anthropic', modelId: 'claude-opus-*@latest' },
    onSelect,
    onOpenSettings: () => {},
    onOpenProviderSettings,
  }
  const tree = (catalog: BrowserLlmCatalog, openToken: number) =>
    createElement(
      RuntimeCapabilitiesContext.Provider,
      { value: queryFor(advertsForScope(scope)) },
      createElement(
        SettingsBridgeContext.Provider,
        { value: bridge },
        createElement(NexusModelPicker, { ...props, catalog, openToken }),
      ),
    )
  const first = catalogOf(anthropic([entryRow('latest', 'Claude Opus', '5.5'), entryRow('6-preview', 'Claude Opus 6-preview', '6-preview', true)]))
  const view = render(tree(first, 1))
  return {
    calls,
    onSelect,
    onOpenProviderSettings,
    rerender: (catalog: BrowserLlmCatalog) => view.rerender(tree(catalog, 1)),
  }
}

async function openMenu() {
  fireEvent.keyDown(await screen.findByTestId('nexus-provider-menu-anthropic'), { key: 'Enter' })
}

describe('quick picker — model entries', () => {
  it('an entry row says what it is: Latest and its version, a pin, a preview badge', async () => {
    setup()
    const latest = await screen.findByTestId('nexus-model-option-anthropic-claude-opus-*@latest')
    expect(latest.textContent).toBe('Claude OpusLatest · 5.5')
    const preview = screen.getByTestId('nexus-model-option-anthropic-claude-opus-*@6-preview')
    expect(preview.textContent).toContain('Preview')
    expect(preview.querySelector('[aria-label="Pinned version"]')).not.toBeNull()
  })

  it('⋯ pins a version — appended to the STORED entries — and selects it once the catalog has it', async () => {
    const { calls, onSelect, rerender } = setup()
    await openMenu()
    const family = await screen.findByTestId('nexus-pin-family-anthropic-claude-opus-*')
    fireEvent.keyDown(family, { key: 'ArrowRight' })
    const item = await screen.findByTestId('nexus-pin-version-anthropic-claude-opus-*@5')
    // The previews sit in their own section; an added version is locked.
    expect(document.body.textContent).toContain('Previews')
    fireEvent.click(item)

    await waitFor(() => expect(calls.some(c => c.action === 'setModelEntries')).toBe(true))
    expect(calls.find(c => c.action === 'setModelEntries')!.payload).toEqual({
      id: 'anthropic',
      entries: [
        { family: 'claude-opus-*', version: 'latest' },
        { family: 'gone-*', version: '1' },
        { family: 'claude-opus-*', version: '5', id: 'claude-opus-5' },
      ],
    })
    expect(onSelect).not.toHaveBeenCalled()
    // The write's providers.changed refreshes the catalog: now it is a row.
    await act(async () => {
      rerender(catalogOf(anthropic([entryRow('latest', 'Claude Opus', '5.5'), entryRow('5', 'Claude Opus 5', '5')], ['5'])))
    })
    expect(onSelect).toHaveBeenCalledWith({ providerId: 'anthropic', modelId: 'claude-opus-*@5', thinkingTier: 'high' })
  })

  it('a version already pinned is shown added and cannot be picked again', async () => {
    const bridge = { request: vi.fn(async () => ({})) } as unknown as NexusSettingsBridge
    render(
      createElement(
        SettingsBridgeContext.Provider,
        { value: bridge },
        createElement(NexusModelPicker, {
          catalog: catalogOf(anthropic([entryRow('latest', 'Claude Opus', '5.5'), entryRow('5.5', 'Claude Opus 5.5', '5.5')], ['5.5'])),
          selection: null,
          onSelect: () => {},
          onOpenSettings: () => {},
          openToken: 1,
        }),
      ),
    )
    await openMenu()
    fireEvent.keyDown(await screen.findByTestId('nexus-pin-family-anthropic-claude-opus-*'), { key: 'ArrowRight' })
    const added = await screen.findByTestId('nexus-pin-version-anthropic-claude-opus-*@5.5')
    expect(added.hasAttribute('data-disabled')).toBe(true)
    expect(added.textContent).toContain('Added')
    fireEvent.click(added)
    expect(bridge.request).not.toHaveBeenCalled()
  })

  it('Edit… opens the provider settings page', async () => {
    const { onOpenProviderSettings } = setup()
    await openMenu()
    fireEvent.click(await screen.findByTestId('nexus-provider-edit-anthropic'))
    expect(onOpenProviderSettings).toHaveBeenCalledWith('anthropic')
  })

  it('a connection without the providers writes gets no menu', async () => {
    setup('control')
    await screen.findByTestId('nexus-model-option-anthropic-claude-opus-*@latest')
    expect(screen.queryByTestId('nexus-provider-menu-anthropic')).toBeNull()
  })
})
