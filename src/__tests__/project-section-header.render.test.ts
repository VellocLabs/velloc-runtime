// @vitest-environment happy-dom
import { createElement } from 'react'
import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import type { ScopeMode } from '../browser/runtimeProtocol'
import { ProjectSection } from '../browser/webview/ProjectSection'
import { writeProjectsCollapsed } from '../browser/webview/projectsStorage'
import {
  RuntimeCapabilitiesContext,
  type CapabilityQuery,
} from '../browser/webview/useCan'
import { advertsForScope, queryFor } from './_helpers/capabilityQuery'

/**
 * The sidebar section header. The section is named "Workspaces" (not
 * "Projects"), and its add control is a folder-with-plus glyph tipped
 * "Add workspace" — a bare "+" did not say that the thing being added is a
 * folder on disk. The label and the tooltip come from the catalog, so this
 * also pins that the `sidebar.projects` / `sidebar.addProject` keys still
 * carry the workspace wording.
 */

function renderSection(onAddProject?: () => void) {
  return render(
    createElement(ProjectSection, {
      sessions: [],
      activeSessionId: 'none',
      addedProjectPaths: [],
      addedProjectOrder: new Map<string, number>(),
      onAddProject,
    }),
  )
}

afterEach(() => {
  cleanup()
  // The section's collapsed state persists; put it back to the default
  // (collapsed) so no test depends on the order they run in.
  writeProjectsCollapsed(true)
})

describe('sidebar workspaces section header', () => {
  it('labels the section "Workspaces"', () => {
    renderSection()
    const toggle = document.querySelector('[data-testid="sidebar-projects-toggle"]')
    expect(toggle?.textContent).toContain('Workspaces')
    expect(toggle?.textContent).not.toContain('Projects')
  })

  it('tips the add control "Add workspace" and draws it as a folder-plus', () => {
    renderSection(() => {})
    const add = document.querySelector('[data-testid="sidebar-add-project"]')
    expect(add).not.toBeNull()
    expect(add?.getAttribute('aria-label')).toBe('Add workspace')
    expect(add?.getAttribute('title')).toBe('Add workspace')
    // lucide stamps the icon name onto the rendered <svg>; a bare PlusIcon
    // would read `lucide-plus` here.
    const icon = add?.querySelector('svg')
    expect(icon?.getAttribute('class') ?? '').toContain('folder-plus')
  })

  it('says "No workspaces yet" when the expanded section is empty', () => {
    renderSection()
    // Collapsed by default (`readProjectsCollapsed`) — open it to reach the
    // empty state.
    fireEvent.click(
      document.querySelector('[data-testid="sidebar-projects-toggle"]')!,
    )
    const empty = document.querySelector('[data-testid="sidebar-projects-empty"]')
    expect(empty?.textContent).toContain('No workspaces yet')
  })
})

/**
 * Two of the section's controls act on the HOST machine: "+" opens its folder
 * picker (`ui.pickProjectFolder`) and registers the new host path
 * (`workspace.addProject`); a project's "Show in Explorer" opens its file
 * manager (`ui.revealProjectFolder`). All three are `full`. A scoped
 * connection used to see both and be refused on click; now it sees neither.
 * Copy path and the launchers stay. The grants come from the real scope tables.
 */
describe('sidebar workspaces — host-machine controls follow the grant', () => {
  const PROJECT = '/work/alpha'

  function renderWithProject(capabilities?: CapabilityQuery) {
    const section = createElement(ProjectSection, {
      sessions: [],
      activeSessionId: 'none',
      addedProjectPaths: [PROJECT],
      addedProjectOrder: new Map<string, number>([[PROJECT, 1]]),
      onAddProject: () => {},
      onDeleteProject: () => {},
      onRevealProject: () => {},
      onCopyProjectPath: () => {},
    })
    return render(
      capabilities
        ? createElement(RuntimeCapabilitiesContext.Provider, { value: capabilities }, section)
        : section,
    )
  }

  /** Expand the section and open the project row's ⋯ menu. */
  async function openProjectMenu(): Promise<void> {
    fireEvent.click(screen.getByTestId('sidebar-projects-toggle'))
    const trigger = await screen.findByTestId('sidebar-project-actions')
    fireEvent.pointerDown(trigger)
    fireEvent.click(trigger)
    await screen.findByTestId('sidebar-project-copy-path')
  }

  it.each([
    ['with no capability provider (the desktop tree)', undefined],
    ['for a full grant', queryFor(advertsForScope('full'))],
  ])('offers "+" and Show in Explorer %s', async (_label, capabilities) => {
    renderWithProject(capabilities)
    expect(screen.queryByTestId('sidebar-add-project')).not.toBeNull()
    await openProjectMenu()
    expect(screen.queryByTestId('sidebar-project-reveal')).not.toBeNull()
  })

  it.each<ScopeMode>(['manager', 'control', 'observe'])(
    'offers neither for a %s grant, and keeps Copy path',
    async mode => {
      renderWithProject(queryFor(advertsForScope(mode)))
      expect(screen.queryByTestId('sidebar-add-project')).toBeNull()
      await openProjectMenu()
      expect(screen.queryByTestId('sidebar-project-reveal')).toBeNull()
      expect(screen.queryByTestId('sidebar-project-copy-path')).not.toBeNull()
    },
  )

  /**
   * Delete deletes the folder's sessions (`session.delete`, `control`) and then
   * forgets the folder (`workspace.removeProject`, `manager`). A control or
   * observe grant used to be offered it: the sessions went, the forget was
   * refused, and a folder the user had added came back empty. Now it needs the
   * forget. A manager keeps it.
   */
  it.each([
    ['with no capability provider (the desktop tree)', undefined],
    ['for a full grant', queryFor(advertsForScope('full'))],
    ['for a manager grant', queryFor(advertsForScope('manager'))],
  ])('offers Delete %s', async (_label, capabilities) => {
    renderWithProject(capabilities)
    await openProjectMenu()
    expect(screen.queryByTestId('sidebar-project-delete')).not.toBeNull()
  })

  it.each<ScopeMode>(['control', 'observe'])(
    'offers no Delete for a %s grant, and keeps Copy path',
    async mode => {
      renderWithProject(queryFor(advertsForScope(mode)))
      await openProjectMenu()
      expect(screen.queryByTestId('sidebar-project-delete')).toBeNull()
      expect(screen.queryByTestId('sidebar-project-copy-path')).not.toBeNull()
    },
  )

  it('needs BOTH the picker and addProject for "+"', () => {
    // The picker alone would hand back a path the runtime then refuses to add.
    renderWithProject(
      queryFor([{ cap: 'ui', acts: ['pickProjectFolder', 'revealProjectFolder'] }]),
    )
    expect(screen.queryByTestId('sidebar-add-project')).toBeNull()
  })
})
