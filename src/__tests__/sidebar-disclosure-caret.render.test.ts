// @vitest-environment happy-dom
import { createElement } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { ProjectSection } from '../browser/webview/ProjectSection'
import { writeProjectsCollapsed } from '../browser/webview/projectsStorage'
import { Sidebar, type SessionListItem } from '../browser/webview/Sidebar'
import { en } from '../browser/webview/i18n/messages/en'
import { de } from '../browser/webview/i18n/messages/de'
import { es } from '../browser/webview/i18n/messages/es'
import { fr } from '../browser/webview/i18n/messages/fr'
import { ja } from '../browser/webview/i18n/messages/ja'
import { ko } from '../browser/webview/i18n/messages/ko'
import { zh } from '../browser/webview/i18n/messages/zh'

// Every collapsible sidebar item uses one outline chevron, drawn after its
// label, with a hover tip and a hover background: right while collapsed,
// down while expanded, never a filled triangle.

const memoryStorage = new Map<string, string>()
vi.stubGlobal('localStorage', {
  getItem: (k: string) => memoryStorage.get(k) ?? null,
  setItem: (k: string, v: string) => void memoryStorage.set(k, String(v)),
  removeItem: (k: string) => void memoryStorage.delete(k),
  clear: () => memoryStorage.clear(),
})

const NOW = Date.now()
const item = (sessionId: string, extra: Partial<SessionListItem> = {}): SessionListItem =>
  ({ sessionId, title: sessionId, previewText: '', updatedAt: NOW - 1000, ...extra })

const expectChevron = (caret: Element, dir: 'right' | 'down') => {
  const svg = caret.querySelector('svg')!
  expect(svg.getAttribute('class')).toContain(`lucide-chevron-${dir}`)
  expect(svg.getAttribute('class')).not.toContain('fill-current')
}

/** True when `a` comes before `b` in document order. */
const precedes = (a: Element, b: Element) =>
  Boolean(a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING)

beforeEach(() => localStorage.clear())
afterEach(() => {
  cleanup()
  writeProjectsCollapsed(true)
})

describe('nested-session toggle', () => {
  function renderTree() {
    return render(createElement(Sidebar, {
      title: 'Conversation', sessionId: 'none', activeSessionId: 'none',
      sessions: [item('p'), item('c', { parentSessionId: 'p', lineageKind: 'side_session' })],
      collapsed: false,
    }))
  }
  const toggle = () => screen.getByTestId('sidebar-children-toggle')

  it('sits after the parent title and tips "Hide nested sessions" while expanded', () => {
    renderTree()
    const title = screen.getByTestId('sidebar-row-p').querySelector('[data-slot="session-row-title"]')!
    expect(precedes(title, toggle())).toBe(true)
    expect(toggle().getAttribute('title')).toBe(en['sidebar.hideNestedSessions'])
    expect(toggle().className).toContain('hover:bg-muted')
  })

  it('tips "Show nested sessions" once collapsed', () => {
    renderTree()
    fireEvent.click(toggle())
    expect(toggle().getAttribute('aria-expanded')).toBe('false')
    expect(toggle().getAttribute('title')).toBe(en['sidebar.showNestedSessions'])
  })

  it('draws the Recents header caret after its label, tipped "Expand", only while collapsed', () => {
    renderTree()
    const header = screen.getByTestId('sidebar-recents-toggle')
    expect(header.querySelector('[data-slot="disclosure-caret"]')).toBeNull()
    fireEvent.click(header)
    const caret = header.querySelector('[data-slot="disclosure-caret"]')!
    expect(caret.getAttribute('title')).toBe(en['sidebar.expandSection'])
    expect(header.lastElementChild).toBe(caret)
    expectChevron(caret, 'right')
  })

  it('draws the nested-session toggle as a down chevron, right once collapsed', () => {
    renderTree()
    expectChevron(toggle(), 'down')
    fireEvent.click(toggle())
    expectChevron(toggle(), 'right')
  })
})

describe('workspace disclosure', () => {
  const PROJECT = '/work/alpha'
  function renderProjects() {
    return render(createElement(ProjectSection, {
      sessions: [], activeSessionId: 'none',
      addedProjectPaths: [PROJECT],
      addedProjectOrder: new Map<string, number>([[PROJECT, 1]]),
    }))
  }

  it('tips the collapsed section header "Expand" with a trailing caret', () => {
    renderProjects()
    const header = screen.getByTestId('sidebar-projects-toggle')
    const caret = header.querySelector('[data-slot="disclosure-caret"]')!
    expect(caret.getAttribute('title')).toBe(en['sidebar.expandSection'])
    expect(header.lastElementChild).toBe(caret)
    expectChevron(caret, 'right')
  })

  it('puts the project caret after the name and flips its tip on toggle', () => {
    renderProjects()
    fireEvent.click(screen.getByTestId('sidebar-projects-toggle'))
    const row = screen.getByTestId('sidebar-project-row')
    const caret = row.querySelector('[data-slot="disclosure-caret"]')!
    const name = Array.from(row.querySelectorAll('span')).find(s => s.textContent === 'alpha')!
    expect(precedes(name, caret)).toBe(true)
    expect(row.lastElementChild).toBe(caret)
    expect(caret.getAttribute('title')).toBe(en['sidebar.expandProject'])
    expect(caret.className).toContain('hover:bg-muted')
    expectChevron(caret, 'right')
    fireEvent.click(row)
    const open = row.querySelector('[data-slot="disclosure-caret"]')!
    expect(open.getAttribute('title')).toBe(en['sidebar.collapseProject'])
    expectChevron(open, 'down')
  })
})

describe('workspace row caret tips', () => {
  // The tips name the row with the same noun as the Workspaces section.
  const workspaceNoun = {
    en: /workspace/i, de: /Arbeitsbereich/, es: /espacios? de trabajo/i, fr: /espaces? de travail/i,
    ja: /ワークスペース/, ko: /워크스페이스/, zh: /工作区/,
  } as const
  const catalogs = { en, de, es, fr, ja, ko, zh } as const

  it.each(Object.keys(catalogs) as (keyof typeof catalogs)[])('%s uses the workspace noun', loc => {
    const cat = catalogs[loc]
    expect(cat['sidebar.projects']).toMatch(workspaceNoun[loc])
    expect(cat['sidebar.expandProject']).toMatch(workspaceNoun[loc])
    expect(cat['sidebar.collapseProject']).toMatch(workspaceNoun[loc])
  })
})

describe('docked sidebar inset', () => {
  it('keeps rows off the sidebar edges with a horizontal inset', () => {
    render(createElement(Sidebar, {
      title: 'Conversation', sessionId: 'p', activeSessionId: 'p',
      sessions: [item('p')], collapsed: false,
    }))
    const body = document.querySelector('[data-slot="sidebar-body"]')!
    expect(body.contains(screen.getByTestId('sidebar-row-p'))).toBe(true)
    const bodyClasses = body.className.split(/\s+/)
    expect(bodyClasses).toContain('ps-2')
    expect(bodyClasses).toContain('pe-0')
    const scroller = screen.getByTestId('sidebar-row-p').closest('.overflow-y-auto')!
    const scrollClasses = scroller.className.split(/\s+/)
    expect(scrollClasses).toContain('pe-0.5')
    expect(scrollClasses).toContain('[scrollbar-gutter:stable]')
  })

  it('scrolls the launchers and the rows in one region and rounds rows to 8px', () => {
    render(createElement(Sidebar, {
      title: 'Conversation', sessionId: 'p', activeSessionId: 'p',
      sessions: [item('p')], collapsed: false,
    }))
    const rowScroller = screen.getByTestId('sidebar-row-p').closest('.overflow-y-auto')!
    const launcherScroller = screen.getByTestId('sidebar-new-thread').closest('.overflow-y-auto')
    expect(launcherScroller).toBe(rowScroller)
    expect(rowScroller.parentElement).toBe(document.querySelector('[data-slot="sidebar-body"]'))
    const rowClasses = screen.getByTestId('sidebar-row-p').className.split(/\s+/)
    expect(rowClasses).toContain('rounded-md')
  })
})
