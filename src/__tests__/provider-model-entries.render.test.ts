// @vitest-environment happy-dom
import { createElement } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'

import { ProviderModelEntries } from '../browser/webview/settings/sections/ProviderModelEntries'
import type { NexusSettingsBridge } from '../browser/webview/nexusSettingsBridge'
import type { BrowserLlmModel, BrowserLlmProvider } from '../browser/bridge/protocol/nexus_llm'
import type {
  ProviderFamilyDetail,
  ProviderModelFamilies,
} from '../models/drivers/modelFamilies'
import type { NexusProviderConfig } from '../settings/settingsTypes'

/**
 * The settings page's model entries for a provider: a family's Latest (which
 * follows upgrades) or a pinned version. The section lists the entries as the
 * catalog resolved them, adds more from the provider's families (searchable,
 * vendor-grouped, versions under each family with previews apart), removes
 * one, sets the default, and shows the entries a gateway dropped. Every write
 * is one `providers.setModelEntries` with the whole list — never the key.
 */

afterEach(cleanup)

const FAMILIES: ProviderFamilyDetail[] = [
  {
    family: 'anthropic/claude-opus-*',
    familyLabel: 'Claude Opus',
    versions: [
      { versionLabel: '5.1', id: 'anthropic/claude-opus-5.1', preview: false, reasoning: true, contextWindow: 1_000_000 },
      { versionLabel: '5.0', id: 'anthropic/claude-opus-5.0', preview: false, reasoning: true },
      { versionLabel: '5.2-preview', id: 'anthropic/claude-opus-5.2-preview', preview: true, reasoning: true },
    ],
  },
  {
    family: 'openai/gpt-*-astra',
    familyLabel: 'GPT Astra',
    versions: [{ versionLabel: '6', id: 'openai/gpt-6-astra', preview: false, reasoning: false, vision: true }],
  },
]

// A family whose 6.x versions are free (and whose newest, 7, is not), one family
// free as a whole, and one unversioned free model.
const FREE_FAMILIES: ProviderFamilyDetail[] = [
  {
    family: 'acme/zeta-*',
    familyLabel: 'Zeta',
    versions: [
      { versionLabel: '7', id: 'acme/zeta-7', preview: false, reasoning: false },
      { versionLabel: '6.1', id: 'acme/zeta-6.1:free', preview: false, reasoning: true, free: true },
      { versionLabel: '6.0', id: 'acme/zeta-6.0:free', preview: false, reasoning: false, free: true },
    ],
  },
  {
    family: 'stealth/space-bunny-alpha',
    familyLabel: 'Space Bunny',
    versions: [{ versionLabel: '', id: 'stealth/space-bunny-alpha', preview: false, reasoning: false, free: true }],
  },
  {
    family: 'paid/only-*',
    familyLabel: 'Paid Only',
    versions: [{ versionLabel: '1', id: 'paid/only-1', preview: false, reasoning: false }],
  },
]

const row = (id: string, label: string, entry: BrowserLlmModel['entry']): BrowserLlmModel => ({
  id,
  label,
  enabled: true,
  supportsStreaming: true,
  entry,
})

const OPUS_LATEST = row('anthropic/claude-opus-*@latest', 'Claude Opus', {
  kind: 'latest',
  family: 'anthropic/claude-opus-*',
  familyLabel: 'Claude Opus',
  version: 'latest',
  resolvedVersion: '5.1',
  resolvedId: 'anthropic/claude-opus-5.1',
  preview: false,
})
const OPUS_PREVIEW = row('anthropic/claude-opus-*@5.2-preview', 'Claude Opus 5.2-preview', {
  kind: 'pinned',
  family: 'anthropic/claude-opus-*',
  familyLabel: 'Claude Opus',
  version: '5.2-preview',
  resolvedVersion: '5.2-preview',
  resolvedId: 'anthropic/claude-opus-5.2-preview',
  preview: true,
})

function setup(
  saved: NexusProviderConfig | undefined,
  models: BrowserLlmModel[],
  families: ProviderModelFamilies = { ok: true, families: FAMILIES },
  options: { connected?: boolean } = {},
) {
  const calls: Array<{ action: string; payload: any }> = []
  const listeners = new Set<(envelope: unknown) => void>()
  let current = families
  const bridge = {
    request: vi.fn(async (route: { action: string }, payload: unknown) => {
      calls.push({ action: route.action, payload })
      if (route.action === 'modelFamilies') return current
      return { ok: true, configs: {} }
    }),
    subscribeEvents: (handler: (envelope: unknown) => void) => {
      listeners.add(handler)
      return () => listeners.delete(handler)
    },
  } as unknown as NexusSettingsBridge
  const provider: BrowserLlmProvider = { id: 'openrouter', label: 'OpenRouter', iconSvg: '', enabled: true, models }
  render(
    createElement(ProviderModelEntries, {
      bridge,
      providerId: 'openrouter',
      providerLabel: 'OpenRouter',
      saved,
      provider,
      onChanged: vi.fn(),
      ...(options.connected !== undefined ? { connected: options.connected } : {}),
    }),
  )
  const writes = () => calls.filter(c => c.action === 'setModelEntries').map(c => c.payload)
  return {
    calls,
    writes,
    /** The runtime replaced these providers' listings (the model catalog changed). */
    relist: (next: ProviderModelFamilies, ids: string[]) => {
      current = next
      const envelope = {
        route: { namespace: 'nexus', capability: 'providers', action: 'changed' },
        payload: { reason: 'listing', listedProviderIds: ids, configs: {}, order: [] },
      }
      for (const l of [...listeners]) l(envelope)
    },
  }
}

describe('provider model entries (settings)', () => {
  it('lists each entry as resolved: Latest names its version, a pinned preview is marked', async () => {
    setup(
      {
        hasApiKey: true,
        modelEntries: [
          { family: 'anthropic/claude-opus-*', version: 'latest' },
          { family: 'anthropic/claude-opus-*', version: '5.2-preview' },
          { family: 'x/gone-*', version: '3', id: 'x/gone-3' },
        ],
      },
      [OPUS_LATEST, OPUS_PREVIEW],
    )
    const latest = await screen.findByTestId('model-entry-row-anthropic/claude-opus-*@latest')
    expect(latest.textContent).toContain('Latest · now 5.1')
    expect(latest.textContent).toContain('anthropic/claude-opus-5.1')
    const preview = screen.getByTestId('model-entry-row-anthropic/claude-opus-*@5.2-preview')
    expect(preview.textContent).toContain('Preview')
    expect(preview.textContent).toContain('Pinned version')
    // An entry nothing resolves stays listed, so the user can see and remove it.
    expect(screen.getByTestId('model-entry-row-x/gone-*@3').textContent).toContain('Not available right now')
    expect(screen.getByTestId('model-entries-count').textContent).toBe('3')
  })

  it('before the first edit the catalog rows ARE the entries; empty without any', async () => {
    const { writes } = setup({ hasApiKey: true }, [OPUS_LATEST])
    fireEvent.click(await screen.findByTestId('model-entry-remove-anthropic/claude-opus-*@latest'))
    await waitFor(() => expect(writes()).toHaveLength(1))
    expect(writes()[0]).toEqual({ id: 'openrouter', entries: [] })
    cleanup()
    setup({ hasApiKey: true }, [])
    expect(screen.getByTestId('model-entries-empty').textContent).toBe('No models added yet.')
    // No count and no Latest/pinned explanation while there is nothing to count.
    expect(screen.queryByTestId('model-entries-count')).toBeNull()
    expect(screen.queryByTestId('model-entries-hint')).toBeNull()
  })

  it('a provider that needs a key to list is locked until one is saved: no error, a key hint, nothing to add', async () => {
    const { calls } = setup(undefined, [], { ok: false, error: 'HTTP 401', families: [] }, { connected: false })
    await waitFor(() => expect(calls.some(c => c.action === 'modelFamilies')).toBe(true))
    expect((await screen.findByTestId('model-entries-empty')).textContent)
      .toBe('Add your API key above to load the model list.')
    expect(screen.queryByTestId('model-entries-list-error')).toBeNull()
    expect((screen.getByTestId('model-entries-add') as HTMLButtonElement).disabled).toBe(true)
    expect(screen.queryByTestId('model-entries-count')).toBeNull()
  })

  it('a listing that answers without a key is not locked', async () => {
    setup(undefined, [], { ok: true, families: FAMILIES }, { connected: false })
    await waitFor(() =>
      expect((screen.getByTestId('model-entries-add') as HTMLButtonElement).disabled).toBe(false),
    )
    expect(screen.getByTestId('model-entries-empty').textContent).toBe('No models added yet.')
  })

  it('a key saved while the page is open unlocks it and lists again', async () => {
    let current: ProviderModelFamilies = { ok: false, error: 'HTTP 401', families: [] }
    const request = vi.fn(async (route: { action: string }) =>
      route.action === 'modelFamilies' ? current : { ok: true, configs: {} },
    )
    const bridge = { request, subscribeEvents: () => () => {} } as unknown as NexusSettingsBridge
    const provider: BrowserLlmProvider = { id: 'mod.acme.main', label: 'Acme', iconSvg: '', enabled: false, models: [] }
    const props = (connected: boolean, saved: NexusProviderConfig | undefined) => ({
      bridge, providerId: 'mod.acme.main', providerLabel: 'Acme', saved, provider, onChanged: vi.fn(), connected,
    })
    const view = render(createElement(ProviderModelEntries, props(false, undefined)))
    await waitFor(() => expect((screen.getByTestId('model-entries-add') as HTMLButtonElement).disabled).toBe(true))
    current = { ok: true, families: FAMILIES }
    view.rerender(createElement(ProviderModelEntries, props(true, { hasApiKey: true })))
    await waitFor(() =>
      expect((screen.getByTestId('model-entries-add') as HTMLButtonElement).disabled).toBe(false),
    )
    expect(request.mock.calls.filter(([route]) => route.action === 'modelFamilies')).toHaveLength(2)
  })

  it('adds a Latest and a pinned version from the families: search, versions under the family, previews apart', async () => {
    const { writes } = setup(
      { hasApiKey: true, modelEntries: [{ family: 'anthropic/claude-opus-*', version: 'latest' }] },
      [OPUS_LATEST],
    )
    fireEvent.click(screen.getByTestId('model-entries-add'))
    const picker = await screen.findByTestId('model-entry-picker')
    await waitFor(() => expect(picker.textContent).toContain('GPT Astra'))
    expect(picker.textContent).toContain('anthropic')
    expect(picker.textContent).toContain('openai')
    // The family's Latest is already an entry: locked.
    const latest = screen.getByTestId('model-family-latest-anthropic/claude-opus-*').querySelector('input')!
    expect(latest.checked && latest.disabled).toBe(true)
    expect(screen.getByTestId('model-family-latest-anthropic/claude-opus-*').textContent).toContain('Latest · now 5.1')

    // Versions open under the family, the preview in its own section.
    expect(screen.queryByTestId('model-version-option-anthropic/claude-opus-*@5.0')).toBeNull()
    fireEvent.click(screen.getByTestId('model-family-expand-anthropic/claude-opus-*'))
    const family = screen.getByTestId('model-family-anthropic/claude-opus-*')
    expect(family.textContent).toContain('Previews')
    expect(screen.getByTestId('model-version-option-anthropic/claude-opus-*@5.2-preview').textContent).toContain('Preview')
    fireEvent.click(screen.getByTestId('model-version-option-anthropic/claude-opus-*@5.0').querySelector('input')!)

    // A search that matches a version id opens its family by itself.
    fireEvent.change(screen.getByTestId('model-entry-picker-search'), { target: { value: 'gpt-6' } })
    expect(screen.queryByTestId('model-family-anthropic/claude-opus-*')).toBeNull()
    fireEvent.click(screen.getByTestId('model-family-latest-openai/gpt-*-astra').querySelector('input')!)
    expect(screen.getByTestId('model-entry-picker-add').textContent).toBe('Add selected (2)')
    fireEvent.click(screen.getByTestId('model-entry-picker-add'))

    await waitFor(() => expect(writes()).toHaveLength(1))
    expect(writes()[0]).toEqual({
      id: 'openrouter',
      entries: [
        { family: 'anthropic/claude-opus-*', version: 'latest' },
        { family: 'anthropic/claude-opus-*', version: '5.0', id: 'anthropic/claude-opus-5.0' },
        { family: 'openai/gpt-*-astra', version: 'latest', id: 'openai/gpt-6-astra' },
      ],
    })
  })

  it('an added entry shows what it runs on today: its window and its price, or Free', async () => {
    const luna = row('openai/gpt-*-luna@latest', 'OpenAI: GPT Luna', {
      kind: 'latest', family: 'openai/gpt-*-luna', familyLabel: 'OpenAI: GPT Luna', version: 'latest',
      resolvedVersion: '6', resolvedId: 'openai/gpt-6-luna', preview: false,
    })
    luna.contextWindow = 1_050_000
    luna.price = { input: 0.1, output: 0.5 }
    const zeta = row('acme/zeta-*@6.1', 'Zeta 6.1 (free)', {
      kind: 'pinned', family: 'acme/zeta-*', familyLabel: 'Zeta', version: '6.1',
      resolvedVersion: '6.1', resolvedId: 'acme/zeta-6.1:free', preview: false,
    })
    zeta.free = true
    setup(
      { hasApiKey: true, modelEntries: [
        { family: 'openai/gpt-*-luna', version: 'latest' },
        { family: 'acme/zeta-*', version: '6.1' },
      ] },
      [luna, zeta, OPUS_LATEST],
    )
    expect(screen.getByTestId('model-entry-figures-openai/gpt-*-luna@latest').textContent)
      .toBe('1.1M context · $0.10 in · $0.50 out per 1M tokens')
    expect(screen.getByTestId('model-entry-figures-acme/zeta-*@6.1').textContent).toBe('Free')
    // The free icon, not "(free)" in the name; the paid entry has none.
    const freeRow = screen.getByTestId('model-entry-row-acme/zeta-*@6.1')
    expect(freeRow.textContent).not.toContain('(free)')
    expect(freeRow.textContent).toContain('Zeta 6.1')
    expect(freeRow.querySelector('[data-slot="free-model-icon"]')).not.toBeNull()
    expect(screen.getByTestId('model-entry-row-openai/gpt-*-luna@latest').querySelector('[data-slot="free-model-icon"]')).toBeNull()
  })

  it('each option shows the exact id and the price, so look-alike families can be told apart', async () => {
    const LOOK_ALIKES: ProviderFamilyDetail[] = [
      {
        family: 'openai/gpt-*-luna',
        familyLabel: 'OpenAI: GPT Luna',
        versions: [
          { versionLabel: '6', id: 'openai/gpt-6-luna', preview: false, reasoning: true, price: { input: 0.1, output: 0.5 } },
        ],
      },
      {
        family: 'openai/gpt-*-luna:batch',
        familyLabel: 'OpenAI: GPT Luna (batch)',
        versions: [
          { versionLabel: '6', id: 'openai/gpt-6-luna:batch', preview: false, reasoning: true, price: { input: 0.05, output: 0.25 } },
        ],
      },
      {
        family: 'acme/zeta-*',
        familyLabel: 'Zeta (free)',
        versions: [{ versionLabel: '6.1', id: 'acme/zeta-6.1:free', preview: false, reasoning: false, free: true, price: { input: 0, output: 0 } }],
      },
    ]
    setup({ hasApiKey: true }, [], { ok: true, families: LOOK_ALIKES })
    fireEvent.click(screen.getByTestId('model-entries-add'))
    await screen.findByTestId('model-entry-picker')
    const plain = await screen.findByTestId('model-family-latest-openai/gpt-*-luna')
    const batch = screen.getByTestId('model-family-latest-openai/gpt-*-luna:batch')
    expect(screen.getByTestId('resolved-id-model-family-latest-openai/gpt-*-luna').textContent).toBe('openai/gpt-6-luna')
    expect(screen.getByTestId('resolved-id-model-family-latest-openai/gpt-*-luna:batch').textContent).toBe('openai/gpt-6-luna:batch')
    expect(plain.textContent).toContain('$0.10 in · $0.50 out per 1M tokens')
    expect(batch.textContent).toContain('$0.05 in · $0.25 out per 1M tokens')
    // A free model says Free, not "$0.00", and wears the free icon instead of
    // "(free)" in its name.
    const free = screen.getByTestId('model-family-latest-acme/zeta-*')
    expect(free.textContent).toContain('Free')
    expect(free.textContent).not.toContain('$0.00')
    expect(free.textContent).not.toContain('(free)')
    expect(free.querySelector('[data-slot="free-model-icon"]')).not.toBeNull()
    expect(plain.querySelector('[data-slot="free-model-icon"]')).toBeNull()
  })

  it('a free PREVIEW version reads like every other option: no "(free)", the free icon', async () => {
    const PREVIEWS: ProviderFamilyDetail[] = [
      {
        family: 'acme/zeta-*',
        familyLabel: 'Zeta (free)',
        versions: [
          { versionLabel: '6.1', id: 'acme/zeta-6.1:free', preview: false, reasoning: false, free: true },
          { versionLabel: '7-preview', id: 'acme/zeta-7-preview:free', preview: true, reasoning: false, free: true },
        ],
      },
    ]
    setup({ hasApiKey: true }, [], { ok: true, families: PREVIEWS })
    fireEvent.click(screen.getByTestId('model-entries-add'))
    await screen.findByTestId('model-family-expand-acme/zeta-*')
    fireEvent.click(screen.getByTestId('model-family-expand-acme/zeta-*'))
    const preview = screen.getByTestId('model-version-option-acme/zeta-*@7-preview')
    expect(preview.textContent).toContain('Zeta 7-preview')
    expect(preview.textContent).not.toContain('(free)')
    expect(preview.querySelector('[data-slot="free-model-icon"]')).not.toBeNull()
  })

  it('Free models: only free versions, each PINNED (a Latest could follow into a paid version)', async () => {
    const { writes } = setup({ hasApiKey: true }, [], { ok: true, families: FREE_FAMILIES })
    fireEvent.click(await screen.findByTestId('model-entries-add-free'))
    const picker = await screen.findByTestId('model-entry-picker')
    expect(picker.textContent).toContain('Add free OpenRouter models')
    await waitFor(() => expect(picker.textContent).toContain('Zeta 6.1'))
    expect(picker.textContent).toContain('Zeta 6.0')
    expect(picker.textContent).toContain('Space Bunny')
    // Neither the paid newest version, the paid-only family, nor any Latest row.
    expect(picker.textContent).not.toContain('Zeta 7')
    expect(picker.textContent).not.toContain('Paid Only')
    expect(screen.queryByTestId('model-family-latest-acme/zeta-*')).toBeNull()

    fireEvent.click(screen.getByTestId('model-free-option-acme/zeta-*@6.1').querySelector('input')!)
    fireEvent.click(screen.getByTestId('model-free-option-stealth/space-bunny-alpha@latest').querySelector('input')!)
    fireEvent.click(screen.getByTestId('model-entry-picker-add'))
    await waitFor(() => expect(writes()).toHaveLength(1))
    expect(writes()[0]).toEqual({
      id: 'openrouter',
      entries: [
        { family: 'acme/zeta-*', version: '6.1', id: 'acme/zeta-6.1:free' },
        { family: 'stealth/space-bunny-alpha', version: 'latest', id: 'stealth/space-bunny-alpha' },
      ],
    })
  })

  it('Other models: collapsed under the curated ones, pinned when added, marked unverified once added', async () => {
    const others: ProviderFamilyDetail[] = [
      {
        family: 'acme-chat-*',
        familyLabel: 'Acme Chat',
        versions: [
          { versionLabel: '3', id: 'acme-chat-3', preview: false, reasoning: false },
          { versionLabel: '2', id: 'acme-chat-2', preview: false, reasoning: false },
        ],
      },
    ]
    const { writes } = setup({ hasApiKey: true }, [], { ok: true, families: FAMILIES, others })
    fireEvent.click(await screen.findByTestId('model-entries-add'))
    const picker = await screen.findByTestId('model-entry-picker')
    const toggle = await screen.findByTestId('model-other-toggle')
    expect(toggle.textContent).toBe('Other models (1, unverified)')
    // Collapsed: nothing of it is offered until the user opens it.
    expect(screen.queryByTestId('model-other-option-acme-chat-*@3')).toBeNull()
    expect(picker.textContent).not.toContain('Acme Chat 3')
    fireEvent.click(toggle)
    expect(picker.textContent).toContain('Not in the curated list')
    fireEvent.click(screen.getByTestId('model-other-option-acme-chat-*@2').querySelector('input')!)
    fireEvent.click(screen.getByTestId('model-entry-picker-add'))
    await waitFor(() => expect(writes()).toHaveLength(1))
    expect(writes()[0]).toEqual({
      id: 'openrouter',
      entries: [{ family: 'acme-chat-*', version: '2', id: 'acme-chat-2' }],
    })
  })

  it('an entry on an uncurated model wears the Unverified badge', async () => {
    const unverified = row('acme-chat-*@2', 'Acme Chat 2', {
      kind: 'pinned',
      family: 'acme-chat-*',
      familyLabel: 'Acme Chat',
      version: '2',
      resolvedVersion: '2',
      resolvedId: 'acme-chat-2',
      preview: false,
      unverified: true,
    })
    setup({ hasApiKey: true, modelEntries: [{ family: 'acme-chat-*', version: '2', id: 'acme-chat-2' }] }, [unverified])
    expect((await screen.findByTestId('model-entry-unverified-acme-chat-*@2')).textContent).toBe('Unverified')
  })

  it('Free models is offered only when the listing has a free model', async () => {
    setup({ hasApiKey: true }, [])
    await screen.findByTestId('model-entries-add')
    await waitFor(() => expect(screen.getByTestId('model-entries-add')).toBeTruthy())
    expect(screen.queryByTestId('model-entries-add-free')).toBeNull()
  })

  it('shows a refreshed listing without a reload when the runtime says this provider was listed again', async () => {
    const t = setup({ hasApiKey: true }, [])
    await screen.findByTestId('model-entries-add')
    expect(screen.queryByTestId('model-entries-add-free')).toBeNull()
    const asked = t.calls.filter(c => c.action === 'modelFamilies').length
    // Another provider's listing changed: nothing is read again.
    t.relist({ ok: true, families: FREE_FAMILIES }, ['someone-else'])
    await new Promise(r => setTimeout(r, 20))
    expect(t.calls.filter(c => c.action === 'modelFamilies').length).toBe(asked)
    expect(screen.queryByTestId('model-entries-add-free')).toBeNull()
    t.relist({ ok: true, families: FREE_FAMILIES }, ['openrouter'])
    await screen.findByTestId('model-entries-add-free')
    expect(t.calls.filter(c => c.action === 'modelFamilies').length).toBe(asked + 1)
  })

  it('the default model is chosen among the entries', async () => {
    const { writes } = setup(
      {
        hasApiKey: true,
        modelEntries: [
          { family: 'anthropic/claude-opus-*', version: 'latest' },
          { family: 'anthropic/claude-opus-*', version: '5.2-preview' },
        ],
        defaultModel: 'anthropic/claude-opus-*@latest',
      },
      [OPUS_LATEST, OPUS_PREVIEW],
    )
    const select = await screen.findByTestId('model-entries-default')
    expect(select.textContent).toContain('Claude Opus')
    expect(writes()).toEqual([])
  })

  it('shows the entries the provider dropped until dismissed; a failed listing offers a retry', async () => {
    const { calls } = setup(
      { hasApiKey: true, modelEntries: [] },
      [],
      { ok: true, families: FAMILIES, removed: { ids: ['Claude Opus 4.8'], at: 1 } },
    )
    const notice = await screen.findByTestId('model-entries-removed')
    expect(notice.textContent).toContain('OpenRouter no longer offers 1 of your models, so they were removed: Claude Opus 4.8')
    fireEvent.click(screen.getByTestId('model-entries-removed-dismiss'))
    await waitFor(() => expect(calls.some(c => c.action === 'dismissRemoved')).toBe(true))
    cleanup()
    const failed = setup({ hasApiKey: true, modelEntries: [] }, [], { ok: false, error: 'HTTP 500', families: [] })
    expect((await screen.findByTestId('model-entries-list-error')).textContent)
      .toContain("Couldn't load the OpenRouter model list.")
    fireEvent.click(screen.getByText('Retry'))
    await waitFor(() =>
      expect(failed.calls.filter(c => c.action === 'modelFamilies').map(c => c.payload.force)).toEqual([false, true]),
    )
  })

  it('an edit before the page copy refreshes never writes back an entry the runtime removed', async () => {
    // `saved` is stale: the runtime already dropped the Opus 5.0 pin on this
    // listing (the removal carries its entry id).
    const { writes } = setup(
      {
        hasApiKey: true,
        modelEntries: [
          { family: 'anthropic/claude-opus-*', version: '4.8', id: 'anthropic/claude-opus-4.8' },
          { family: 'anthropic/claude-opus-*', version: 'latest' },
        ],
        defaultModel: 'anthropic/claude-opus-*@4.8',
      },
      [OPUS_LATEST],
      {
        ok: true,
        families: FAMILIES,
        removed: { ids: ['Claude Opus 4.8'], entryIds: ['anthropic/claude-opus-*@4.8'], at: 1 },
      },
    )
    await screen.findByTestId('model-entries-removed')
    expect(screen.queryByTestId('model-entry-row-anthropic/claude-opus-*@4.8')).toBeNull()
    expect(screen.getByTestId('model-entries-count').textContent).toBe('1')
    fireEvent.click(screen.getByTestId('model-entry-remove-anthropic/claude-opus-*@latest'))
    await waitFor(() => expect(writes()).toHaveLength(1))
    expect(writes()[0]).toEqual({ id: 'openrouter', entries: [] })
  })
})
