// @vitest-environment happy-dom
import { createElement } from 'react'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'

import { I18nProvider } from '../browser/webview/i18n'
import type { SessionListItem } from '../browser/webview/SessionRows'
import { NexusTopBar, type NexusTopBarProps } from '../browser/webview/topbar/NexusTopBar'
import { planTopbarFit } from '../browser/webview/topbar/topbarFit'

/**
 * A topbar too narrow for all of it gives way in one order (F-9): the centre
 * strip hides, then right-group toggles fold into the More menu, then
 * left-group extras do. No column is ever laid over another.
 */

const unit = (key: string, width = 32) => ({ key, width })

describe('planTopbarFit', () => {
  const base = {
    leftFixed: 100,
    left: [unit('import:a')],
    rightFixed: 40,
    right: [unit('pane:files'), unit('pane:diff'), unit('rail')],
    stripMin: 72,
  }
  // left = 132, right = 136

  it('everything fits: the strip gets what keeps it on the centre line', () => {
    expect(planTopbarFit({ ...base, inner: 600 })).toEqual({
      centerBudget: 600 - 2 * 136,
      showStrip: true,
      folded: new Set(),
    })
  })

  it('the strip hides first, before any control folds', () => {
    const fit = planTopbarFit({ ...base, inner: 300 })
    expect(fit.showStrip).toBe(false)
    expect(fit.centerBudget).toBe(0)
    expect(fit.folded).toEqual(new Set())
  })

  it('then the right group folds, first unit first, only as far as needed', () => {
    expect(planTopbarFit({ ...base, inner: 240 }).folded).toEqual(new Set(['pane:files']))
    expect(planTopbarFit({ ...base, inner: 210 }).folded).toEqual(new Set(['pane:files', 'pane:diff']))
  })

  it('the left group folds only once the right group has nothing left to give', () => {
    expect(planTopbarFit({ ...base, inner: 172 }).folded).toEqual(new Set(['pane:files', 'pane:diff', 'rail']))
    expect(planTopbarFit({ ...base, inner: 171 }).folded).toEqual(
      new Set(['pane:files', 'pane:diff', 'rail', 'import:a']),
    )
  })

  it('a strip budget under the minimum hides it even though the controls fit', () => {
    expect(planTopbarFit({ ...base, inner: 2 * 136 + 71 }).showStrip).toBe(false)
    expect(planTopbarFit({ ...base, inner: 2 * 136 + 72 }).showStrip).toBe(true)
  })
})

// happy-dom has no layout: give every button 32px, a box the sum of its
// children, and the header the width under test.
let headerWidth = 1000
const BUTTON = 32
const saved: Record<string, PropertyDescriptor | undefined> = {}
beforeAll(() => {
  for (const prop of ['offsetWidth', 'clientWidth'] as const) {
    saved[prop] = Object.getOwnPropertyDescriptor(HTMLElement.prototype, prop)
  }
  Object.defineProperty(HTMLElement.prototype, 'offsetWidth', {
    configurable: true,
    get(this: HTMLElement): number {
      if (this.tagName === 'BUTTON') return BUTTON
      return Array.from(this.children).reduce((total, child) => total + (child as HTMLElement).offsetWidth, 0)
    },
  })
  Object.defineProperty(HTMLElement.prototype, 'clientWidth', {
    configurable: true,
    get(this: HTMLElement): number {
      return this.getAttribute('data-slot') === 'nexus-topbar' ? headerWidth : this.offsetWidth
    },
  })
})
afterAll(() => {
  for (const [prop, descriptor] of Object.entries(saved)) {
    if (descriptor) Object.defineProperty(HTMLElement.prototype, prop, descriptor)
  }
})
afterEach(() => cleanup())

const TAB = { sessionId: 's1', title: 'Fix the parser' } as SessionListItem

function renderBar(width: number, props: Partial<NexusTopBarProps> = {}) {
  headerWidth = width
  const handlers = { onTogglePane: vi.fn(), onOpenImport: vi.fn(), onToggleRail: vi.fn() }
  render(
    createElement(
      I18nProvider,
      { locale: 'en' as const },
      createElement(NexusTopBar, {
        catalog: null,
        selection: null,
        onSelectModel: () => {},
        onOpenSettings: () => {},
        onToggleSidebar: () => {},
        sessionTabs: [TAB],
        activeSessionId: 's1',
        onSelectSessionTab: () => {},
        onTogglePane: handlers.onTogglePane,
        sessionOverview: { shown: true, onToggle: handlers.onToggleRail },
        importSources: [{ source: 'acme-agent' as never, label: 'Acme' }],
        onOpenImport: handlers.onOpenImport,
        ...props,
      }),
    ),
  )
  return handlers
}

function openMore() {
  const trigger = screen.getByTestId('topbar-more-panes')
  fireEvent.pointerDown(trigger)
  fireEvent.click(trigger)
}

describe('NexusTopBar on a narrow window', () => {
  it('wide: the strip and every control are in the bar', () => {
    renderBar(1200)
    expect(screen.queryByTestId('session-tab-strip')).not.toBeNull()
    for (const id of ['topbar-session-rail', 'topbar-pane-terminal', 'topbar-pane-files', 'topbar-import-acme-agent']) {
      expect(screen.queryByTestId(id), id).not.toBeNull()
    }
  })

  it('the strip goes first; the controls stay', () => {
    // left 4 buttons = 128; right rail + 4 panes + More = 192 (the divider has no children).
    renderBar(330)
    expect(screen.queryByTestId('session-tab-strip')).toBeNull()
    expect(screen.queryByTestId('topbar-pane-files')).not.toBeNull()
    expect(screen.queryByTestId('topbar-import-acme-agent')).not.toBeNull()
  })

  it('then the outermost pane toggle moves into the More menu, still a toggle', async () => {
    const { onTogglePane } = renderBar(300)
    expect(screen.queryByTestId('topbar-pane-files')).toBeNull()
    expect(screen.queryByTestId('topbar-pane-browser')).not.toBeNull()
    openMore()
    const row = await screen.findByTestId('topbar-pane-row-files')
    expect(row.getAttribute('data-folded')).toBe('true')
    fireEvent.click(row)
    expect(onTogglePane).toHaveBeenCalledWith('files')
  })

  it('narrowest: the right group is down to More, then the left extras fold too', async () => {
    const { onOpenImport, onToggleRail } = renderBar(150)
    for (const id of ['topbar-session-rail', 'topbar-pane-terminal', 'topbar-import-acme-agent']) {
      expect(screen.queryByTestId(id), id).toBeNull()
    }
    expect(screen.queryByTestId('topbar-settings')).not.toBeNull()
    expect(screen.queryByTestId('topbar-more-panes')).not.toBeNull()
    openMore()
    fireEvent.click(await screen.findByTestId('topbar-folded-rail'))
    expect(onToggleRail).toHaveBeenCalled()
    openMore()
    fireEvent.click(await screen.findByTestId('topbar-folded-import-acme-agent'))
    expect(onOpenImport).toHaveBeenCalledWith('acme-agent')
  })

  it('without a More menu nothing folds', () => {
    renderBar(150, { onTogglePane: undefined })
    expect(screen.queryByTestId('topbar-session-rail')).not.toBeNull()
    expect(screen.queryByTestId('topbar-import-acme-agent')).not.toBeNull()
  })
})
