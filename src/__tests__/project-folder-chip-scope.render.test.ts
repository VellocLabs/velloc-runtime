// @vitest-environment happy-dom
/**
 * The project-folder chip menu, gated by capability: "Show in Explorer" (`ui.revealProjectFolder`) and "Open
 * folder…" (`ui.pickProjectFolder`) are `full` and hidden from a scoped connection, which keeps Copy path and the
 * folders. Grants come from the real scope tables (`advertsForScope`).
 */
import { createElement } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'

import type { ScopeMode } from '../browser/runtimeProtocol'
import { addRecentFolder } from '../browser/webview/recentFoldersStorage'
import {
  RuntimeCapabilitiesContext,
  type CapabilityQuery,
} from '../browser/webview/useCan'
import {
  WorkspaceStore,
  resetWorkspaceStoreForTests,
} from '../browser/webview/workspaceStore'
import {
  CurrentProjectFolderChip,
  ProjectFolderProvider,
  type ProjectFolderControls,
} from '../components/assistant-ui/thread'
import { advertsForScope, queryFor } from './_helpers/capabilityQuery'

const CURRENT = '/work/alpha'
const RECENT = '/work/beta'

beforeEach(() => {
  // A fresh, unattached workspace store (no runtime, no storage) holding one
  // recent folder besides the current one, so the switcher has something to
  // list under every grant.
  resetWorkspaceStoreForTests(new WorkspaceStore(() => undefined))
  addRecentFolder(RECENT)
})

afterEach(() => {
  cleanup()
  resetWorkspaceStoreForTests()
})

function controls(): ProjectFolderControls {
  return {
    templateType: 'agent',
    canPick: true,
    projectRoot: CURRENT,
    needsProjectFolder: false,
    locked: false,
    onSelectFolder: vi.fn(),
    onOpenFolder: vi.fn(),
    onRevealFolder: vi.fn(),
  }
}

/** Render the chip and open its menu; returns the menu element. */
function openMenu(capabilities?: CapabilityQuery): HTMLElement {
  const chip = createElement(
    ProjectFolderProvider,
    { value: controls() },
    createElement(CurrentProjectFolderChip),
  )
  render(
    capabilities
      ? createElement(RuntimeCapabilitiesContext.Provider, { value: capabilities }, chip)
      : chip,
  )
  fireEvent.click(screen.getByRole('button', { name: /alpha/ }))
  return screen.getByRole('menu')
}

function itemLabels(menu: HTMLElement): string[] {
  return Array.from(
    menu.querySelectorAll('[role="menuitem"], [role="menuitemradio"]'),
  ).map(el => el.textContent ?? '')
}

describe('CurrentProjectFolderChip — host-machine items follow the grant', () => {
  it.each([
    ['with no capability provider (the desktop tree)', undefined],
    ['for a full grant', queryFor(advertsForScope('full'))],
  ])('lists Show in Explorer and Open folder %s', (_label, capabilities) => {
    const menu = openMenu(capabilities)
    expect(itemLabels(menu)).toEqual([
      'Show in Explorer',
      'Copy path',
      'alpha',
      'beta',
      'Open folder…',
    ])
  })

  it.each<ScopeMode>(['manager', 'control', 'observe'])(
    'lists neither for a %s grant, and keeps Copy path and the folders',
    mode => {
      const menu = openMenu(queryFor(advertsForScope(mode)))
      expect(itemLabels(menu)).toEqual(['Copy path', 'alpha', 'beta'])
      // No rule is left dangling where "Open folder…" used to follow one.
      expect(menu.lastElementChild?.getAttribute('aria-hidden')).not.toBe('true')
    },
  )
})
