// @vitest-environment happy-dom
/**
 * A conversation whose host has no pane or native picker for a control never
 * shows that control as a dead button (F-24): the plan card opens the plan in
 * place when there is no plan pane, and the folder chip drops "Show in
 * Explorer" and "Open folder…" when the host cannot do them.
 */
import { createElement } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { PlanApprovalFooterControl } from '../components/assistant-ui/plan-approval-footer-control'
import {
  PlanPanelContext,
  type PlanPanelContextValue,
  type PlanPanelEntry,
} from '../components/assistant-ui/plan-panel-context'
import {
  CurrentProjectFolderChip,
  ProjectFolderProvider,
  type ProjectFolderControls,
} from '../components/assistant-ui/thread'
import { ComposerCancelStateProvider } from '../components/assistant-ui/thread-contexts'
import { addRecentFolder } from '../browser/webview/recentFoldersStorage'
import { WorkspaceStore, resetWorkspaceStoreForTests } from '../browser/webview/workspaceStore'

const PLAN = '# Ship it\n\n1. Write the migration\n2. Backfill the rows'

function planCard(value: PlanPanelContextValue) {
  return createElement(
    ComposerCancelStateProvider,
    { value: { isStopping: false, onCancel: undefined } },
    createElement(PlanPanelContext.Provider, { value }, createElement(PlanApprovalFooterControl)),
  )
}

const pending = {
  toolCallId: 'tc-touch',
  request: { toolName: 'ExitPlanMode', planText: PLAN, planFilePath: '', restoreMode: 'default' },
} as PlanPanelEntry

const slot = (name: string) => document.querySelector<HTMLElement>(`[data-slot="${name}"]`)

beforeEach(() => {
  resetWorkspaceStoreForTests(new WorkspaceStore(() => undefined))
  addRecentFolder('/work/beta')
})

afterEach(() => {
  cleanup()
  resetWorkspaceStoreForTests()
})

describe('plan card without a plan pane', () => {
  it('Open plan shows the plan inside the card, and Hide plan folds it again', () => {
    render(planCard({ pending, resolve: vi.fn() }))
    const view = slot('plan-approval-view')!
    expect(view.textContent).toBe('Open plan')
    expect(view.getAttribute('aria-expanded')).toBe('false')
    expect(slot('plan-approval-inline-plan')).toBeNull()

    act(() => {
      fireEvent.click(view)
    })
    const inline = slot('plan-approval-inline-plan')!
    expect(inline.textContent).toContain('Write the migration')
    expect(inline.textContent).toContain('Backfill the rows')
    expect(view.textContent).toBe('Hide plan')
    expect(view.getAttribute('aria-expanded')).toBe('true')

    act(() => {
      fireEvent.click(view)
    })
    expect(slot('plan-approval-inline-plan')).toBeNull()
    expect(view.textContent).toBe('Open plan')
  })

  it('offers no Open plan when the approval carries no plan text', () => {
    const empty = {
      ...pending,
      request: { ...pending.request, planText: '' },
    } as PlanPanelEntry
    render(planCard({ pending: empty, resolve: vi.fn() }))
    expect(slot('plan-approval-view')).toBeNull()
    expect(slot('plan-approval-inline-plan')).toBeNull()
  })

  it('with a plan pane, Open plan opens the pane and never the inline plan', () => {
    const openPanel = vi.fn()
    render(planCard({ pending, resolve: vi.fn(), openPanel }))
    const view = slot('plan-approval-view')!
    expect(view.hasAttribute('aria-expanded')).toBe(false)
    act(() => {
      fireEvent.click(view)
    })
    expect(openPanel).toHaveBeenCalledTimes(1)
    expect(slot('plan-approval-inline-plan')).toBeNull()
    expect(view.textContent).toBe('Open plan')
  })
})

describe('folder chip without host folder actions', () => {
  function openMenu(overrides: Partial<ProjectFolderControls>): string[] {
    const controls: ProjectFolderControls = {
      templateType: 'agent',
      canPick: true,
      projectRoot: '/work/alpha',
      needsProjectFolder: false,
      locked: false,
      onSelectFolder: vi.fn(),
      onOpenFolder: vi.fn(),
      onRevealFolder: vi.fn(),
      ...overrides,
    }
    render(createElement(ProjectFolderProvider, { value: controls }, createElement(CurrentProjectFolderChip)))
    fireEvent.click(screen.getByRole('button', { name: /alpha/ }))
    return Array.from(
      screen.getByRole('menu').querySelectorAll('[role="menuitem"], [role="menuitemradio"]'),
    ).map(el => el.textContent ?? '')
  }

  it('drops Show in Explorer and Open folder… when the host offers neither', () => {
    expect(openMenu({ onOpenFolder: undefined, onRevealFolder: undefined })).toEqual([
      'Copy path',
      'alpha',
      'beta',
    ])
  })

  it('keeps both when the host offers them', () => {
    expect(openMenu({})).toEqual(['Show in Explorer', 'Copy path', 'alpha', 'beta', 'Open folder…'])
  })
})
