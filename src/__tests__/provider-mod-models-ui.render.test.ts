// @vitest-environment happy-dom
import { createElement } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'

import { ProviderModelEntries } from '../browser/webview/settings/sections/ProviderModelEntries'
import type { NexusSettingsBridge } from '../browser/webview/nexusSettingsBridge'
import type { BrowserLlmProvider } from '../browser/bridge/protocol/nexus_llm'
import type { ProviderFamilyDetail, ProviderModelFamilies } from '../models/drivers/modelFamilies'
import type { ProviderModelsUi } from '../mods/provider/providerManifest'
import type { NexusProviderConfig } from '../settings/settingsTypes'

/**
 * A provider mod's aggregated "Add models" page, drawn from its manifest's
 * `modelsUi`: its own groups (labeled, ordered), badges on rows, an intro and
 * links, an empty-list text, and the "Add custom model" flow that writes the
 * whole list with `providers.setUserModels`.
 */

afterEach(cleanup)

const FAMILIES: ProviderFamilyDetail[] = [
  {
    family: 'zen-chat',
    familyLabel: 'Zen Chat',
    group: 'chat',
    versions: [
      {
        versionLabel: '',
        id: 'zen-chat',
        preview: false,
        reasoning: false,
        tags: ['beta'],
        free: true,
        description: { en: 'Quick answers', 'zh-CN': '快速回答' },
      },
    ],
  },
  {
    family: 'zen-anthropic',
    familyLabel: 'Zen Anthropic',
    group: 'anthropic',
    versions: [{ versionLabel: '', id: 'zen-anthropic', preview: false, reasoning: true, deprecated: true }],
  },
  {
    family: 'mine',
    familyLabel: 'Mine',
    group: 'custom',
    versions: [{ versionLabel: '', id: 'mine', preview: false, reasoning: false, userAdded: true, tags: ['custom'] }],
  },
]

const UI: ProviderModelsUi = {
  intro: { en: 'Models from two OpenCode services.' },
  empty: { en: 'Nothing listed yet.' },
  links: [{ label: { en: 'Pricing' }, url: 'https://acme.example/pricing' }],
  groups: {
    anthropic: { label: { en: 'Claude line' }, order: 1 },
    chat: { label: { en: 'Chat line' }, order: 2 },
  },
  tags: { beta: { label: { en: 'Early access' } } },
  filters: ['beta'],
  customModels: { formats: ['openai-chat', 'anthropic-messages'] },
}

function setup(families: ProviderModelFamilies, saved: NexusProviderConfig = { hasApiKey: true }, ui = UI) {
  const calls: Array<{ action: string; payload: any }> = []
  const bridge = {
    subscribeEvents: () => () => {},
    request: vi.fn(async (route: { action: string }, payload: unknown) => {
      calls.push({ action: route.action, payload })
      if (route.action === 'modelFamilies') return families
      return { ok: true, configs: {} }
    }),
  } as unknown as NexusSettingsBridge
  const provider: BrowserLlmProvider = { id: 'mod.acme.main', label: 'Acme', iconSvg: '', enabled: true, models: [] }
  render(
    createElement(ProviderModelEntries, {
      bridge,
      providerId: 'mod.acme.main',
      providerLabel: 'Acme',
      ui,
      saved,
      provider,
      onChanged: vi.fn(),
    }),
  )
  return { calls }
}

describe('provider mod models page (modelsUi)', () => {
  it('shows the declared intro and links on the page', async () => {
    setup({ ok: true, families: FAMILIES })
    const note = await screen.findByTestId('model-entries-ui-note')
    expect(note.textContent).toContain('Models from two OpenCode services.')
    expect(note.querySelector('a')?.getAttribute('href')).toBe('https://acme.example/pricing')
  })

  it('groups by the listing\'s group, in the declared order and labels, with badges', async () => {
    setup({ ok: true, families: FAMILIES })
    fireEvent.click(await screen.findByTestId('model-entries-add'))
    const picker = await screen.findByTestId('model-entry-picker')
    await waitFor(() => expect(screen.getByTestId('model-family-zen-chat')).toBeTruthy())
    const text = picker.textContent ?? ''
    // Declared order first (Claude line, Chat line), then the undeclared "custom" group.
    expect(text.indexOf('Claude line')).toBeGreaterThan(-1)
    expect(text.indexOf('Claude line')).toBeLessThan(text.indexOf('Chat line'))
    expect(text.indexOf('Chat line')).toBeLessThan(text.indexOf('Custom'))
    // The tag shows its declared label; an undeclared tag falls back to its name.
    expect(screen.getByTestId('model-family-zen-chat').textContent).toContain('Early access')
    expect(screen.getByTestId('model-family-mine').textContent).toContain('custom')
  })

  it('uses the declared empty text when the provider lists nothing', async () => {
    setup({ ok: true, families: [] })
    fireEvent.click(await screen.findByTestId('model-entries-add'))
    expect((await screen.findByTestId('model-entry-picker-empty')).textContent).toBe('Nothing listed yet.')
  })

  it('offers no custom-model button unless the manifest allows it', async () => {
    setup({ ok: true, families: FAMILIES }, { hasApiKey: true }, { ...UI, customModels: undefined })
    await screen.findByTestId('model-entries-add')
    expect(screen.queryByTestId('model-entries-add-custom')).toBeNull()
  })

  it('adds a custom model: one setUserModels write with the whole list', async () => {
    const { calls } = setup({ ok: true, families: FAMILIES }, { hasApiKey: true, userModels: [{ id: 'old' }] })
    expect(screen.getByTestId('user-model-row-old')).toBeTruthy()
    fireEvent.click(await screen.findByTestId('model-entries-add-custom'))
    fireEvent.change(await screen.findByTestId('user-model-id'), { target: { value: 'new-model' } })
    fireEvent.change(screen.getByTestId('user-model-context'), { target: { value: '128000' } })
    fireEvent.click(screen.getByTestId('user-model-reasoning'))
    fireEvent.click(screen.getByTestId('user-model-save'))
    await waitFor(() => expect(calls.some(c => c.action === 'setUserModels')).toBe(true))
    expect(calls.find(c => c.action === 'setUserModels')!.payload).toEqual({
      id: 'mod.acme.main',
      models: [{ id: 'old' }, { id: 'new-model', contextWindow: 128000, reasoning: true }],
    })
  })

  it('refuses an id with a space and an id that already exists', async () => {
    const { calls } = setup({ ok: true, families: FAMILIES })
    fireEvent.click(await screen.findByTestId('model-entries-add-custom'))
    fireEvent.change(await screen.findByTestId('user-model-id'), { target: { value: 'two words' } })
    fireEvent.click(screen.getByTestId('user-model-save'))
    expect((await screen.findByTestId('user-model-error')).textContent).toContain('no spaces')
    fireEvent.change(screen.getByTestId('user-model-id'), { target: { value: 'zen-chat' } })
    fireEvent.click(screen.getByTestId('user-model-save'))
    expect((await screen.findByTestId('user-model-error')).textContent).toContain('already exists')
    expect(calls.some(c => c.action === 'setUserModels')).toBe(false)
  })

  it('removes a custom model with one write of the rest', async () => {
    const { calls } = setup(
      { ok: true, families: FAMILIES },
      { hasApiKey: true, userModels: [{ id: 'a' }, { id: 'b' }] },
    )
    fireEvent.click(await screen.findByTestId('user-model-remove-a'))
    await waitFor(() => expect(calls.some(c => c.action === 'setUserModels')).toBe(true))
    expect(calls.find(c => c.action === 'setUserModels')!.payload.models).toEqual([{ id: 'b' }])
  })

  it('shows the description of a row and marks a deprecated model', async () => {
    setup({ ok: true, families: FAMILIES })
    fireEvent.click(await screen.findByTestId('model-entries-add'))
    const chat = await screen.findByTestId('model-family-zen-chat')
    expect(chat.textContent).toContain('Quick answers')
    expect(screen.getByTestId('model-family-zen-anthropic').textContent).toContain('Deprecated')
  })

  it('a filter chip narrows the list to models with that tag, and All brings the rest back', async () => {
    setup({ ok: true, families: FAMILIES })
    fireEvent.click(await screen.findByTestId('model-entries-add'))
    await screen.findByTestId('model-family-zen-anthropic')
    fireEvent.click(screen.getByTestId('model-entry-filter-beta'))
    await waitFor(() => expect(screen.queryByTestId('model-family-zen-anthropic')).toBeNull())
    expect(screen.getByTestId('model-free-family-zen-chat')).toBeTruthy()
    expect(screen.getByTestId('model-entry-filter-beta').textContent).toBe('Early access')
    fireEvent.click(screen.getByTestId('model-entry-filter-all'))
    await screen.findByTestId('model-family-zen-anthropic')
  })

  it('a free model is offered once, the platform way: Add free models and the Free mark', async () => {
    setup({ ok: true, families: FAMILIES })
    // The page's own entry to free models, as for any gateway.
    fireEvent.click(await screen.findByTestId('model-entries-add-free'))
    const freeOption = await screen.findByTestId('model-free-option-zen-chat@latest')
    expect(freeOption.querySelector('[data-slot="free-model-icon"]')).toBeTruthy()
    fireEvent.click(screen.getByTestId('model-entry-picker-cancel'))
    // Add models carries the mark on the row and offers no second Free view.
    fireEvent.click(screen.getByTestId('model-entries-add'))
    const chat = await screen.findByTestId('model-family-zen-chat')
    expect(chat.querySelector('[data-slot="free-model-icon"]')).toBeTruthy()
    expect(screen.queryByTestId('model-entry-filter-free')).toBeNull()
  })

  it('a family offered only in preview wears the Free mark when all of it is free', async () => {
    const preview = (family: string, free: boolean): ProviderFamilyDetail => ({
      family,
      familyLabel: family,
      versions: [{ versionLabel: '5-preview', id: `${family}-5-preview`, preview: true, reasoning: false, free }],
    })
    setup({ ok: true, families: [preview('step', true), preview('paid', false)] })
    fireEvent.click(await screen.findByTestId('model-entries-add'))
    const step = await screen.findByTestId('model-family-step')
    expect(step.querySelector('[data-slot="free-model-icon"]')).toBeTruthy()
    expect(screen.getByTestId('model-family-paid').querySelector('[data-slot="free-model-icon"]')).toBeNull()
  })
})
