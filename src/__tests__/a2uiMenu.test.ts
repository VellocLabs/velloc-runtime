// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from 'vitest'
import { act, createElement, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { renderToStaticMarkup } from 'react-dom/server'
import { chartCatalogDefinitions } from '../browser/webview/a2ui/catalog/chartCatalogDefinitions'
import { MenuView, vellocCatalog } from '../browser/webview/a2ui/catalog/vellocCatalog'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const clicked: string[] = []
const buildChild = (id: string): ReactNode =>
  createElement('button', { 'data-id': id, onClick: () => clicked.push(id) }, id)

let root: Root | null = null
afterEach(() => {
  act(() => root?.unmount())
  root = null
  document.body.innerHTML = ''
  clicked.length = 0
})

function mount(defaultOpen: boolean): HTMLElement {
  const host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  act(() => root!.render(createElement(MenuView, { label: 'More', children: ['undo', 'delete'], buildChild, defaultOpen })))
  return host
}

describe('Menu', () => {
  it('is a catalog component with a label and a child list', () => {
    expect(vellocCatalog.components.has('Menu')).toBe(true)
    const menu = chartCatalogDefinitions.Menu.schema
    expect(menu.safeParse({ label: 'More', children: ['undo', 'delete'] }).success).toBe(true)
    expect(menu.safeParse({ children: ['undo'] }).success, 'the label is required').toBe(false)
  })

  it('shows only a three-dot button named by its label while closed', () => {
    const html = renderToStaticMarkup(createElement(MenuView, { label: 'More', children: ['undo'], buildChild }))
    expect(html).toMatch(/<button[^>]*data-slot="a2ui-menu"[^>]*aria-label="More"/)
    expect(html).not.toContain('data-id="undo"')
  })

  it('lists its items in order inside the surface, and closes once one is clicked', () => {
    const host = mount(true)
    const items = [...host.querySelectorAll('[data-slot=a2ui-menu-content] [data-id]')].map(e => e.getAttribute('data-id'))
    expect(items, 'not portaled out of the surface').toEqual(['undo', 'delete'])
    act(() => (host.querySelector('[data-id=delete]') as HTMLElement).click())
    expect(clicked).toEqual(['delete'])
    expect(host.querySelector('[data-slot=a2ui-menu-content]')).toBeNull()
    expect(host.querySelector('[data-slot=a2ui-menu]')!.getAttribute('aria-expanded')).toBe('false')
  })
})
