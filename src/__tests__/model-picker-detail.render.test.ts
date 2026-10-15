// @vitest-environment happy-dom
import { createElement } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'

import { ModelQuickPicker } from '../browser/webview/ModelQuickPicker'
import {
  ProviderUsageStore,
  resetProviderUsageStoreForTests,
} from '../browser/webview/providerUsageStore'
import type { RuntimeConnection } from '../browser/runtimeClient/RuntimeConnection'
import type { BrowserLlmCatalog, BrowserLlmModel } from '../browser/bridge/protocol/nexus_llm'
import type { ProviderUsageState } from '../models/usage/providerUsageState'

/**
 * The quick picker's footer: the provider-settings action is an icon, and
 * the rest of the row describes a model — the hovered row, else the active
 * one — by its context window, its price per 1M tokens (or Free) and its
 * provider's quota: the paid plan's windows and balance for a paid model,
 * the free-request quota for a free one.
 */

afterEach(() => {
  cleanup()
  resetProviderUsageStoreForTests()
})

const model = (id: string, label: string, extra: Partial<BrowserLlmModel> = {}): BrowserLlmModel => ({
  id,
  label,
  enabled: true,
  supportsStreaming: true,
  ...extra,
})

const CATALOG: BrowserLlmCatalog = {
  providers: [
    {
      id: 'openrouter',
      label: 'OpenRouter',
      iconSvg: '',
      enabled: true,
      models: [
        model('openai/gpt-6-luna', 'GPT-6 Luna', { contextWindow: 1_050_000, price: { input: 0.1, output: 0.5 } }),
        model('openai/gpt-6-luna:batch', 'GPT-6 Luna (batch)', { contextWindow: 1_050_000, price: { input: 0.05, output: 0.25 } }),
        model('acme/zeta:free', 'Acme: Zeta (free)', { contextWindow: 32_000, free: true, price: { input: 0, output: 0 } }),
      ],
    },
  ],
} as BrowserLlmCatalog

function seedUsage(state: ProviderUsageState): void {
  const store = new ProviderUsageStore()
  const connection = {
    subscribe: (_topic: string, listener: (event: { payload: unknown }) => void) => {
      listener({ payload: state })
      return () => {}
    },
    request: vi.fn(async () => ({})),
  } as unknown as RuntimeConnection
  store.attach(async () => connection)
  resetProviderUsageStoreForTests(store)
}

function open(onOpenSettings?: () => void) {
  render(
    createElement(ModelQuickPicker, {
      catalog: CATALOG,
      selection: { providerId: 'openrouter', modelId: 'openai/gpt-6-luna' },
      onSelect: vi.fn(),
      onOpenSettings,
    }),
  )
  fireEvent.click(screen.getByTestId('nexus-model-picker-trigger'))
}

/** Each quota item as [label, value, tooltip]. */
const quotaItems = () =>
  Array.from(screen.getByTestId('nexus-model-detail-quota').children).map((item) => [
    item.children[0]!.textContent,
    item.children[1]!.textContent,
    item.getAttribute('title'),
  ])

const row = (id: string) =>
  screen.getByTestId(`nexus-model-option-openrouter-${id}`).parentElement as HTMLElement

describe('quick picker — the free mark', () => {
  it('a free row carries the free icon instead of the "(free)" in its name; a paid row neither', async () => {
    open()
    const free = await screen.findByTestId('nexus-model-option-openrouter-acme/zeta:free')
    expect(free.textContent).toContain('Acme: Zeta')
    expect(free.textContent).not.toContain('(free)')
    expect(free.querySelector('[data-slot="free-model-icon"]')?.getAttribute('aria-label')).toBe('Free')
    const paid = screen.getByTestId('nexus-model-option-openrouter-openai/gpt-6-luna')
    expect(paid.querySelector('[data-slot="free-model-icon"]')).toBeNull()
  })

  it('the trigger of a free selection carries it too', () => {
    render(
      createElement(ModelQuickPicker, {
        catalog: CATALOG,
        selection: { providerId: 'openrouter', modelId: 'acme/zeta:free' },
        onSelect: vi.fn(),
      }),
    )
    const trigger = screen.getByTestId('nexus-model-picker-trigger')
    expect(trigger.textContent).toContain('Acme: Zeta')
    expect(trigger.textContent).not.toContain('(free)')
    expect(trigger.querySelector('[data-slot="free-model-icon"]')).not.toBeNull()
  })
})

describe('quick picker — the detail footer', () => {
  it('settings is an icon with an accessible name, and opens the settings', async () => {
    const onOpenSettings = vi.fn()
    open(onOpenSettings)
    const button = await screen.findByTestId('nexus-model-picker-provider-settings')
    expect(button.textContent).toBe('')
    expect(button.getAttribute('aria-label')).toBe('Provider settings…')
    fireEvent.click(button)
    expect(onOpenSettings).toHaveBeenCalledTimes(1)
  })

  it('describes the active model, then whichever row the pointer is over', async () => {
    seedUsage({
      openrouter: {
        checkedAt: 1,
        usage: {
          windows: [
            { kind: 'five_hour', usedPercent: 32 },
            { kind: 'daily', subject: 'free_requests', usedPercent: 80 },
          ],
          amounts: [{ kind: 'balance', amount: 95.5, currency: 'USD' }],
        },
      },
    })
    open(vi.fn())
    const detail = await screen.findByTestId('nexus-model-detail')
    expect(screen.getByTestId('nexus-model-detail-label').textContent).toBe('GPT-6 Luna')
    // One line: the name, then each figure as an icon and a number — the
    // words and the unit in the tooltip.
    const context = screen.getByTestId('nexus-model-detail-context')
    expect(context.textContent).toBe('1.1M')
    expect(context.getAttribute('title')).toBe('1.1M context')
    const price = screen.getByTestId('nexus-model-detail-price')
    expect(price.textContent).toBe('0.1 in · 0.5 out')
    expect(price.getAttribute('title')).toBe('$0.10 in · $0.50 out per 1M tokens')
    expect(context.parentElement).toBe(screen.getByTestId('nexus-model-detail-label').parentElement)
    // The quota: short `label value` items, the full wording their tooltips.
    await waitFor(() => expect(quotaItems()).toEqual([
      ['5h', '32%', '32% of 5-hour limit'],
      ['Available', '$95.50', 'Available $95.50'],
    ]))
    expect(detail.getAttribute('title')).toBe('openai/gpt-6-luna')

    // Hovering the batch twin: its own (half) price.
    fireEvent.mouseEnter(row('openai/gpt-6-luna:batch'))
    expect(screen.getByTestId('nexus-model-detail-label').textContent).toBe('GPT-6 Luna (batch)')
    expect(screen.getByTestId('nexus-model-detail-price').textContent).toBe('0.05 in · 0.25 out')

    // A free model: Free and the free-request quota — not the paid plan
    // (OpenRouter's display rules choose the quota).
    fireEvent.mouseEnter(row('acme/zeta:free'))
    expect(screen.getByTestId('nexus-model-detail-label').textContent).toBe('Acme: Zeta')
    // A free model: the free mark where the price would be.
    expect(screen.getByTestId('nexus-model-detail-context').textContent).toBe('32K')
    expect(screen.queryByTestId('nexus-model-detail-price')).toBeNull()
    expect(screen.getByTestId('nexus-model-detail').querySelector('[data-slot="free-model-icon"]')).not.toBeNull()
    expect(quotaItems()).toEqual([['Free req.', '80%', '80% of free-model requests']])

    // Leaving the list falls back to the active model.
    fireEvent.mouseLeave(row('acme/zeta:free').parentElement!.parentElement!)
    expect(screen.getByTestId('nexus-model-detail-label').textContent).toBe('GPT-6 Luna')
  })

  it('every provider\'s quota reads the same way — a plan\'s windows and its spend', async () => {
    seedUsage({
      kimi: {
        checkedAt: 1,
        usage: {
          windows: [
            { kind: 'five_hour', usedPercent: 12 },
            { kind: 'weekly', usedPercent: 40 },
            { kind: 'monthly', usedPercent: 25 },
          ],
          amounts: [
            { kind: 'limit_remaining', amount: 37.5, currency: 'USD' },
            { kind: 'spent', period: 'day', amount: 1, currency: 'USD' },
          ],
        },
      },
    })
    render(
      createElement(ModelQuickPicker, {
        catalog: {
          providers: [{ id: 'kimi', label: 'Kimi', iconSvg: '', enabled: true, models: [model('kimi-k3', 'Kimi K3', { contextWindow: 256_000 })] }],
        } as BrowserLlmCatalog,
        selection: { providerId: 'kimi', modelId: 'kimi-k3' },
        onSelect: vi.fn(),
      }),
    )
    fireEvent.click(screen.getByTestId('nexus-model-picker-trigger'))
    await waitFor(() => expect(quotaItems()).toEqual([
      ['5h', '12%', '12% of 5-hour limit'],
      ['Week', '40%', '40% of weekly limit'],
      ['Month', '25%', '25% of monthly limit'],
      ['Key limit left', '$37.50', 'Key limit remaining $37.50'],
      ['Today', '$1.00', 'Spent today $1.00'],
    ]))
  })

  // OpenRouter's balance and key limit fold into one Available (the lower).
  // Without the balance there is no Available: a key's cap read "Available
  // $100" on a $0 account. Why the balance is missing, and the key limit,
  // are the usage popover's to say, not this line's.
  it('openrouter: balance and key limit read as one Available, the lower of the two', async () => {
    seedUsage({
      openrouter: {
        checkedAt: 1,
        usage: {
          windows: [],
          amounts: [
            { kind: 'limit_remaining', amount: 100, currency: 'USD' },
            { kind: 'spent', period: 'day', amount: 0.07, currency: 'USD' },
          ],
          balanceNote: 'needs_key',
        },
      },
    })
    open()
    await waitFor(() => expect(quotaItems()).toEqual([
      ['Today', '$0.07', 'Spent today $0.07'],
    ]))
    cleanup()
    seedUsage({
      openrouter: {
        checkedAt: 1,
        usage: {
          windows: [],
          amounts: [
            { kind: 'balance', amount: 4.2, currency: 'USD' },
            { kind: 'limit_remaining', amount: 99.93, currency: 'USD' },
            { kind: 'spent', period: 'day', amount: 0.07, currency: 'USD' },
          ],
        },
      },
    })
    open()
    await waitFor(() => expect(quotaItems()).toEqual([
      ['Available', '$4.20', 'Available $4.20'],
      ['Today', '$0.07', 'Spent today $0.07'],
    ]))
  })

  it('a model with no known figures shows its name alone', async () => {
    render(
      createElement(ModelQuickPicker, {
        catalog: {
          providers: [{ id: 'openai', label: 'OpenAI', iconSvg: '', enabled: true, models: [model('gpt-x', 'GPT X')] }],
        } as BrowserLlmCatalog,
        selection: { providerId: 'openai', modelId: 'gpt-x' },
        onSelect: vi.fn(),
      }),
    )
    fireEvent.click(screen.getByTestId('nexus-model-picker-trigger'))
    await screen.findByTestId('nexus-model-detail')
    expect(screen.getByTestId('nexus-model-detail-label').textContent).toBe('GPT X')
    expect(screen.queryByTestId('nexus-model-detail-context')).toBeNull()
    expect(screen.queryByTestId('nexus-model-detail-price')).toBeNull()
    expect(screen.queryByTestId('nexus-model-detail-quota')).toBeNull()
    // No settings callback: no settings icon.
    expect(screen.queryByTestId('nexus-model-picker-provider-settings')).toBeNull()
  })
})
