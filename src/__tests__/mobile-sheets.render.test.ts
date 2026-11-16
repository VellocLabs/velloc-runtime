// @vitest-environment happy-dom
/**
 * The phone shell's sheets (F-24): the usage sheet draws only the sections it has figures for and
 * marks a used-up plan window; the details sheet names the computer (address when the machine name
 * is unknown), copies the project's full path, and shows the branch only when known; the tasks
 * sheet offers Stop only on running tasks; the model sheet lists the set-up models and picks one;
 * the session menu offers Background tasks and Model for the open session only.
 */
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { createElement, type ReactElement } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { BrowserLlmCatalog } from '../browser/bridge/browserBridgeProtocol'
import type { NexusTaskSummaryRow } from '../browser/bridge/protocol/ui'
import { I18nProvider } from '../browser/webview/i18n'
import { MobileModelSheet } from '../mobile/MobileModelSheet'
import { MobileSessionDetailsSheet } from '../mobile/MobileSessionDetailsSheet'
import { MobileSessionMenu } from '../mobile/MobileSessionMenu'
import { MobileTasksSheet } from '../mobile/MobileTasksSheet'
import { MobileUsageSheet } from '../mobile/MobileUsageSheet'
import type { PlanUsageSnapshot } from '../models/usage/planUsage'

afterEach(cleanup)

function renderEn(element: ReactElement) {
  render(createElement(I18nProvider, { locale: 'en' as const }, element))
}

const NOW = 1_800_000_000_000
const context = { usedTokens: 84_000, windowTokens: 200_000, percent: 42, warning: 'none' as const }
const plan: PlanUsageSnapshot = {
  planName: 'Pro',
  windows: [
    { kind: 'five_hour', usedPercent: 30, resetsAt: NOW + 90 * 60_000 },
    { kind: 'weekly', usedPercent: 100 },
  ],
}

describe('MobileUsageSheet', () => {
  const base = { open: true, onOpenChange: vi.fn(), now: NOW }

  it('shows the context percentage, bar and tokens, and every plan window', () => {
    renderEn(createElement(MobileUsageSheet, { ...base, context, planUsage: plan, onRefresh: vi.fn() }))
    expect(screen.getByTestId('mobile-usage-context-percent').textContent).toBe('42%')
    expect(screen.getByTestId('mobile-usage-context-tokens').textContent).toBe('84k / 200k tokens')
    expect(screen.getByTestId('mobile-usage-context-bar').getAttribute('aria-valuenow')).toBe('42')
    expect(screen.getByTestId('mobile-usage-plan').textContent).toContain('Pro')
    const fiveHour = screen.getByTestId('mobile-usage-window-five_hour')
    expect(fiveHour.textContent).toContain('30%')
    expect(fiveHour.textContent).toContain('Resets in 1 hr 30 min')
    expect(screen.queryByTestId('mobile-usage-empty')).toBeNull()
  })

  it('draws a used-up window in the warning colour, and only that one', () => {
    renderEn(createElement(MobileUsageSheet, { ...base, context, planUsage: plan }))
    const weekly = screen.getByTestId('mobile-usage-window-weekly')
    expect(weekly.getAttribute('data-exhausted')).toBe('true')
    expect(weekly.className).toContain('text-warning')
    expect(screen.getByTestId('mobile-usage-window-weekly-bar').getAttribute('data-tone')).toBe('warning')
    const fiveHour = screen.getByTestId('mobile-usage-window-five_hour')
    expect(fiveHour.getAttribute('data-exhausted')).toBeNull()
    expect(screen.getByTestId('mobile-usage-window-five_hour-bar').getAttribute('data-tone')).toBe('primary')
  })

  it('colours a nearly full context by its warning level', () => {
    renderEn(createElement(MobileUsageSheet, { ...base, context: { ...context, percent: 95, warning: 'danger' } }))
    expect(screen.getByTestId('mobile-usage-context-bar').getAttribute('data-tone')).toBe('destructive')
  })

  it('leaves out the context section without context figures', () => {
    renderEn(createElement(MobileUsageSheet, { ...base, planUsage: plan }))
    expect(screen.queryByTestId('mobile-usage-context')).toBeNull()
    expect(screen.getByTestId('mobile-usage-plan')).toBeTruthy()
  })

  it('leaves out the plan section without plan figures, or with no windows', () => {
    renderEn(createElement(MobileUsageSheet, { ...base, context, planUsage: { windows: [] } }))
    expect(screen.queryByTestId('mobile-usage-plan')).toBeNull()
    expect(screen.getByTestId('mobile-usage-context')).toBeTruthy()
  })

  it('says so when it has no figures at all', () => {
    renderEn(createElement(MobileUsageSheet, base))
    expect(screen.queryByTestId('mobile-usage-context')).toBeNull()
    expect(screen.queryByTestId('mobile-usage-plan')).toBeNull()
    expect(screen.getByTestId('mobile-usage-empty')).toBeTruthy()
  })

  it('refreshes on tap, and has no refresh button without a provider to ask', () => {
    const onRefresh = vi.fn()
    renderEn(createElement(MobileUsageSheet, { ...base, context, onRefresh }))
    fireEvent.click(screen.getByTestId('mobile-usage-refresh'))
    expect(onRefresh).toHaveBeenCalledTimes(1)
    cleanup()
    renderEn(createElement(MobileUsageSheet, { ...base, context }))
    expect(screen.queryByTestId('mobile-usage-refresh')).toBeNull()
  })
})

describe('MobileSessionDetailsSheet', () => {
  const base = { open: true, onOpenChange: vi.fn() }

  it('names the computer and its OS, the project, and the branch', () => {
    renderEn(
      createElement(MobileSessionDetailsSheet, {
        ...base,
        host: { address: '192.168.1.20:7777', hostName: 'STUDIO-PC', osName: 'Windows 11' },
        projectRoot: 'C:\\work\\holiday',
        branch: 'feature/trip',
      }),
    )
    const computer = screen.getByTestId('mobile-details-computer').textContent
    expect(computer).toContain('STUDIO-PC')
    expect(computer).toContain('Windows 11')
    expect(computer).not.toContain('192.168.1.20')
    expect(screen.getByTestId('mobile-details-project').textContent).toContain('holiday')
    expect(screen.getByTestId('mobile-details-branch').textContent).toContain('feature/trip')
  })

  it('names the computer by its address when the machine name is unknown', () => {
    renderEn(createElement(MobileSessionDetailsSheet, { ...base, host: { address: '192.168.1.20:7777' } }))
    expect(screen.getByTestId('mobile-details-computer').textContent).toContain('192.168.1.20:7777')
  })

  it('has no branch row when the branch is unknown, and no project row outside a project', () => {
    renderEn(createElement(MobileSessionDetailsSheet, { ...base, host: { address: 'a:1' } }))
    expect(screen.queryByTestId('mobile-details-branch')).toBeNull()
    expect(screen.queryByTestId('mobile-details-project')).toBeNull()
  })

  it('copies the full path on a tap, and says so when the copy fails', async () => {
    const writeText = vi.fn(async () => true)
    renderEn(createElement(MobileSessionDetailsSheet, { ...base, projectRoot: 'C:\\work\\holiday', writeText }))
    await act(async () => {
      fireEvent.click(screen.getByTestId('mobile-details-project'))
    })
    expect(writeText).toHaveBeenCalledWith('C:\\work\\holiday')
    expect(screen.getByTestId('mobile-details-project').textContent).toContain('Full path copied')
    cleanup()

    renderEn(
      createElement(MobileSessionDetailsSheet, {
        ...base,
        projectRoot: 'C:\\work\\holiday',
        writeText: vi.fn(async () => false),
      }),
    )
    await act(async () => {
      fireEvent.click(screen.getByTestId('mobile-details-project'))
    })
    expect(screen.getByTestId('mobile-details-copy-failed')).toBeTruthy()
  })
})

describe('MobileTasksSheet', () => {
  const row = (over: Partial<NexusTaskSummaryRow>): NexusTaskSummaryRow => ({
    sessionId: 't',
    spawnerSessionId: 's1',
    status: 'running',
    description: 'Research flights',
    ...over,
  })

  it('shows title, state and elapsed time, and Stop only on running tasks', () => {
    const onStop = vi.fn()
    renderEn(
      createElement(MobileTasksSheet, {
        open: true,
        onOpenChange: vi.fn(),
        now: NOW,
        onStop,
        rows: [
          row({ sessionId: 'run-1', startedAt: NOW - 65_000 }),
          row({ sessionId: 'done-1', status: 'success', description: 'Book hotel', startedAt: NOW - 60_000, finishedAt: NOW - 48_000 }),
          row({ sessionId: 'sh-1', status: 'stopped', type: 'local_bash', description: '', command: 'npm test' }),
        ],
      }),
    )
    const rows = screen.getAllByTestId('mobile-task-row')
    expect(rows.map(r => r.getAttribute('data-task-id'))).toEqual(['run-1', 'done-1', 'sh-1'])
    expect(rows[0].textContent).toContain('Research flights')
    expect(rows[0].textContent).toContain('running')
    expect(rows[0].textContent).toContain('1m 5s')
    expect(rows[1].textContent).toContain('Book hotel')
    expect(rows[1].textContent).toContain('12s')
    expect(rows[2].textContent).toContain('npm test')
    expect(rows[2].querySelector('[data-testid="mobile-task-elapsed"]')).toBeNull()

    const stops = screen.getAllByTestId('mobile-task-stop')
    expect(stops).toHaveLength(1)
    expect(rows[0].contains(stops[0])).toBe(true)
    fireEvent.click(stops[0])
    expect(onStop).toHaveBeenCalledWith('run-1')
  })

  it('says so when the session has no background tasks', () => {
    renderEn(createElement(MobileTasksSheet, { open: true, onOpenChange: vi.fn(), rows: [], onStop: vi.fn() }))
    expect(screen.getByTestId('mobile-tasks-empty')).toBeTruthy()
    expect(screen.queryByTestId('mobile-task-stop')).toBeNull()
  })
})

describe('MobileModelSheet', () => {
  const catalog = {
    providers: [
      {
        id: 'alpha',
        label: 'Alpha',
        iconSvg: '',
        enabled: true,
        models: [
          { id: 'a-fast', label: 'Alpha Fast', enabled: true },
          { id: 'a-deep', label: 'Alpha Deep', enabled: true, defaultThinkingTier: 'high' },
          { id: 'a-off', label: 'Alpha Off', enabled: false },
          { id: 'a-alias', label: 'Alpha Alias', enabled: true, pickerAliasId: 'a-fast' },
        ],
      },
      { id: 'beta', label: 'Beta', iconSvg: '', enabled: false, models: [{ id: 'b1', label: 'Beta One', enabled: true }] },
    ],
  } as unknown as BrowserLlmCatalog

  it('lists the enabled models of enabled providers and marks the current one', () => {
    renderEn(
      createElement(MobileModelSheet, {
        open: true,
        onOpenChange: vi.fn(),
        catalog,
        selection: { providerId: 'alpha', modelId: 'a-fast' },
        onSelect: vi.fn(),
      }),
    )
    const options = screen.getAllByTestId('mobile-model-option')
    expect(options.map(o => o.textContent)).toEqual(['Alpha Fast', 'Alpha Deep'])
    expect(options.map(o => o.getAttribute('aria-checked'))).toEqual(['true', 'false'])
    expect(screen.getByTestId('mobile-model-sheet').textContent).toContain('Alpha')
    expect(screen.getByTestId('mobile-model-sheet').textContent).not.toContain('Beta')
  })

  it('picks a model with its default reasoning tier', () => {
    const onSelect = vi.fn()
    renderEn(createElement(MobileModelSheet, { open: true, onOpenChange: vi.fn(), catalog, onSelect }))
    fireEvent.click(screen.getAllByTestId('mobile-model-option')[1])
    expect(onSelect).toHaveBeenCalledWith({ providerId: 'alpha', modelId: 'a-deep', thinkingTier: 'high' })
  })

  it('says so when no model is set up', () => {
    renderEn(createElement(MobileModelSheet, { open: true, onOpenChange: vi.fn(), catalog: null, onSelect: vi.fn() }))
    expect(screen.getByTestId('mobile-model-empty')).toBeTruthy()
  })
})

describe('MobileSessionMenu, the open session', () => {
  const menu = (current: boolean) => ({
    target: { sessionId: 's1', title: 'Trip', current, modelLabel: current ? 'Alpha Fast' : undefined },
    onClose: vi.fn(),
    onRename: vi.fn(),
    onArchive: vi.fn(),
    onBackgroundTasks: vi.fn(),
    onModel: vi.fn(),
  })

  it('offers Background tasks and Model, with the model named', () => {
    const props = menu(true)
    renderEn(createElement(MobileSessionMenu, props))
    expect(screen.getByTestId('mobile-menu-model').textContent).toContain('Alpha Fast')
    fireEvent.click(screen.getByTestId('mobile-menu-background-tasks'))
    expect(props.onBackgroundTasks).toHaveBeenCalled()
    fireEvent.click(screen.getByTestId('mobile-menu-model'))
    expect(props.onModel).toHaveBeenCalled()
  })

  it('offers neither for a drawer row that is not the open session', () => {
    renderEn(createElement(MobileSessionMenu, menu(false)))
    expect(screen.queryByTestId('mobile-menu-background-tasks')).toBeNull()
    expect(screen.queryByTestId('mobile-menu-model')).toBeNull()
  })
})
