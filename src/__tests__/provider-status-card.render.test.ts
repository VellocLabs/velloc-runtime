// @vitest-environment happy-dom
import { createElement } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'

import { I18nProvider } from '../browser/webview/i18n'
import type { RuntimeConnection } from '../browser/runtimeClient/RuntimeConnection'
import {
  ProviderStatusStore,
  resetProviderStatusStoreForTests,
} from '../browser/webview/providerStatusStore'
import {
  ModProviderStatusCard,
  formatStatusDuration,
} from '../browser/webview/settings/sections/ModProviderStatusCard'
import type { ProviderStatusEntry } from '../mods/provider/providerStatusState'

/**
 * The status card of a provider mod's settings page (F-27): fixed element
 * kinds drawn from the runtime's published entry, plugin text as text only,
 * and buttons that ask the runtime to run a declared job.
 */

const ID = 'mod.acme.main'

const ENTRY: ProviderStatusEntry = {
  readAt: Date.UTC(2026, 10, 10, 8, 0),
  rows: [
    { key: 'state', label: { en: 'Status', de: 'Zustand' }, kind: 'value', cell: { format: 'badge', text: 'Healthy', tone: 'ok' } },
    { key: 'exposed', label: 'Exposed', kind: 'value', cell: { format: 'count', value: 12345 } },
    { key: 'took', label: 'Took', kind: 'value', cell: { format: 'duration', ms: 1500 } },
    { key: 'health', label: 'Health', kind: 'value', cell: { format: 'percent', value: 97.5 } },
    { key: 'lastError', label: 'Last error', kind: 'value', cell: { format: 'text', text: '<img src=x onerror=alert(1)>' } },
    { key: 'lastProbe', label: 'Last probe', kind: 'value' },
    {
      key: 'decisions',
      label: 'Recent decisions',
      kind: 'list',
      columns: [
        { key: 'target', format: 'text', label: { en: 'Target' } },
        { key: 'reason', format: 'text' },
      ],
      items: [
        [{ format: 'text', text: 'alpha' }, { format: 'text', text: 'rate limited' }],
        [{ format: 'text', text: 'beta' }, null],
      ],
      total: 7,
    },
  ],
  actions: [{ job: 'probe', label: { en: 'Probe now' } }],
}

function mount(entry: ProviderStatusEntry | undefined, options: { can?: boolean; outcome?: unknown; locale?: string } = {}) {
  const request = vi.fn(async (route: string) => (route.endsWith('.runJob') ? { outcome: options.outcome ?? 'unavailable' } : null))
  const connection = {
    subscribe: () => () => {},
    request,
    can: () => options.can ?? true,
  } as unknown as RuntimeConnection
  const store = new ProviderStatusStore()
  resetProviderStatusStoreForTests(store)
  store.attach(async () => connection)
  const view = render(
    createElement(I18nProvider, { locale: (options.locale ?? 'en') as 'en' }, createElement(ModProviderStatusCard, { providerId: ID })),
  )
  const publish = (next: ProviderStatusEntry | undefined) => act(() => store.replace(next ? { [ID]: next } : {}))
  return { request, store, view, publish, ready: publish(entry) }
}

afterEach(() => {
  cleanup()
  resetProviderStatusStoreForTests(null)
})

describe('the status card of a provider mod', () => {
  it('draws nothing for a provider with no published entry', async () => {
    const { view } = mount(undefined)
    await act(async () => {})
    expect(view.container.querySelector('[data-testid="mod-status-card"]')).toBeNull()
  })

  it('draws each row by its format and asks for a fresh read on mount', async () => {
    const { request } = mount(ENTRY)
    const card = await screen.findByTestId('mod-status-card')
    expect(card.getAttribute('data-provider')).toBe(ID)
    const row = (key: string) => card.querySelector(`[data-testid="mod-status-row"][data-key="${key}"]`)!
    expect(row('state').textContent).toBe('Healthy')
    expect(row('state').querySelector('[data-tone]')!.getAttribute('data-tone')).toBe('ok')
    expect(row('exposed').textContent).toBe('12,345')
    expect(row('took').textContent).toBe(formatStatusDuration(1500, 'en'))
    expect(row('health').textContent).toBe('97.5%')
    expect(row('lastProbe').textContent).toBe('Not reported')
    expect(screen.getByTestId('mod-status-updated').textContent).toMatch(/^Updated /)
    await waitFor(() => expect(request).toHaveBeenCalledWith('providerStatus.refresh', { providerId: ID }))
  })

  it('shows plugin text as text: markup in a value creates no element', async () => {
    mount(ENTRY)
    const card = await screen.findByTestId('mod-status-card')
    expect(card.querySelector('img')).toBeNull()
    expect(card.querySelector('[data-key="lastError"]')!.textContent).toBe('<img src=x onerror=alert(1)>')
  })

  it('draws a list as a table with its headings, an empty cell for a missing value, and the cut', async () => {
    mount(ENTRY)
    const list = await screen.findByTestId('mod-status-list')
    expect([...list.querySelectorAll('th')].map(th => th.textContent)).toEqual(['Target', ''])
    const items = screen.getAllByTestId('mod-status-list-item')
    expect(items.map(item => [...item.querySelectorAll('td')].map(td => td.textContent))).toEqual([
      ['alpha', 'rate limited'],
      ['beta', ''],
    ])
    expect(screen.getByTestId('mod-status-list-more').textContent).toBe('Showing 2 of 7')
  })

  it('says so when the provider has reported nothing, and when the read failed', async () => {
    const { publish } = mount({ ...ENTRY, empty: true })
    expect((await screen.findByTestId('mod-status-empty')).textContent).toBe('This provider hasn\'t reported anything yet.')
    expect(screen.queryByTestId('mod-status-row')).toBeNull()
    await publish({ ...ENTRY, error: true })
    expect(screen.getByTestId('mod-status-read-failed').textContent).toBe('Couldn\'t read this provider\'s status.')
  })

  it('picks the plugin\'s label for the page locale', async () => {
    mount(ENTRY, { locale: 'de' })
    const card = await screen.findByTestId('mod-status-card')
    expect(card.querySelector('dt')!.textContent).toBe('Zustand')
  })

  it('a button asks the runtime to run its job and shows the answer; "unavailable" reads as such', async () => {
    const { request } = mount(ENTRY)
    const button = await screen.findByTestId('mod-status-action')
    expect(button.textContent).toBe('Probe now')
    expect(button.getAttribute('data-job')).toBe('probe')
    fireEvent.click(button)
    const answer = await screen.findByTestId('mod-status-action-answer')
    expect(request).toHaveBeenCalledWith('providerStatus.runJob', { providerId: ID, job: 'probe' })
    expect(answer.getAttribute('data-answer')).toBe('unavailable')
    expect(answer.textContent).toBe('This action isn\'t available in this version.')
    expect((button as HTMLButtonElement).disabled).toBe(false)
  })

  it('reports a started job, and an answer of an unknown shape as a failure', async () => {
    mount(ENTRY, { outcome: 'started' })
    fireEvent.click(await screen.findByTestId('mod-status-action'))
    expect((await screen.findByTestId('mod-status-action-answer')).textContent).toBe('Started.')
    cleanup()
    mount(ENTRY, { outcome: 'exploded' })
    fireEvent.click(await screen.findByTestId('mod-status-action'))
    expect((await screen.findByTestId('mod-status-action-answer')).getAttribute('data-answer')).toBe('failed')
  })

  it('drops the answer of a job started for a provider the card no longer shows', async () => {
    let answer!: (value: { outcome: string }) => void
    const { request, view } = mount(ENTRY)
    request.mockImplementationOnce(() => new Promise(resolve => (answer = resolve)))
    fireEvent.click(await screen.findByTestId('mod-status-action'))
    const OTHER = 'mod.acme.other'
    const store = new ProviderStatusStore()
    act(() => {
      resetProviderStatusStoreForTests(store)
    })
    store.attach(async () => ({ subscribe: () => () => {}, request, can: () => true }) as unknown as RuntimeConnection)
    act(() => store.replace({ [OTHER]: ENTRY }))
    view.rerender(createElement(I18nProvider, { locale: 'en' }, createElement(ModProviderStatusCard, { providerId: OTHER })))
    await screen.findByTestId('mod-status-action')
    await act(async () => answer({ outcome: 'started' }))
    expect(screen.queryByTestId('mod-status-action-answer')).toBeNull()
  })

  it('a connection whose scope does not reach the actions gets the values but no buttons', async () => {
    mount(ENTRY, { can: false })
    await screen.findByTestId('mod-status-card')
    expect(screen.queryByTestId('mod-status-action')).toBeNull()
    expect(screen.queryByTestId('mod-status-refresh')).toBeNull()
    expect(screen.getAllByTestId('mod-status-row').length).toBeGreaterThan(0)
  })
})

describe('formatStatusDuration', () => {
  it('uses the two largest units that say something', () => {
    expect(formatStatusDuration(250, 'en')).toBe('250ms')
    expect(formatStatusDuration(1500, 'en')).toBe('1.5s')
    expect(formatStatusDuration(45_000, 'en')).toBe('45s')
    expect(formatStatusDuration(59_800, 'en')).toBe('1m')
    expect(formatStatusDuration(9_960, 'en')).toBe('10s')
    expect(formatStatusDuration(125_000, 'en')).toBe('2m 5s')
    expect(formatStatusDuration(3 * 3_600_000 + 60_000, 'en')).toBe('3h 1m')
    expect(formatStatusDuration(72 * 3_600_000, 'en')).toBe('3d')
  })
})
