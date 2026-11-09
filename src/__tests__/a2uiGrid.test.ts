// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest'
import { createElement, type ReactNode } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { chartCatalogDefinitions, gridMinWidth } from '../browser/webview/a2ui/catalog/chartCatalogDefinitions'
import { AddCardView, GridView, HoverBarView, vellocCatalog } from '../browser/webview/a2ui/catalog/vellocCatalog'
import { commandsToA2uiMessages } from '../browser/webview/a2ui/toA2uiMessages'
import { VELLOC_CATALOG_ID } from '../browser/webview/a2ui/catalog/chartCatalogDefinitions'

/** Builds each child as a tag naming its id and data path, so the markup shows what went where. */
const buildChild = (id: string, basePath?: string): ReactNode =>
  createElement('i', { 'data-id': id, 'data-path': basePath ?? '' }, id)

describe('Grid and HoverBar', () => {
  it('are catalog components that take a template child list', () => {
    expect(vellocCatalog.components.has('Grid')).toBe(true)
    expect(vellocCatalog.components.has('HoverBar')).toBe(true)
    const grid = chartCatalogDefinitions.Grid.schema
    expect(grid.safeParse({ children: { path: '/alerts', componentId: 'card' }, minWidth: 300 }).success).toBe(true)
    expect(grid.safeParse({ children: ['a', 'b'] }).success).toBe(true)
    expect(grid.safeParse({ children: ['a'], columns: 3 }).success, 'unknown props are rejected').toBe(false)
    expect(chartCatalogDefinitions.HoverBar.schema.safeParse({ children: ['edit', 'delete'] }).success).toBe(true)
    expect(grid.safeParse({ children: ['a'], after: 'add' }).success).toBe(true)
    expect(vellocCatalog.components.has('AddCard')).toBe(true)
    expect(chartCatalogDefinitions.AddCard.schema.safeParse({ label: 'Add alert', action: { event: { name: 'add' } } }).success).toBe(true)
  })

  it('keeps a Grid template as a template when a surface is created', () => {
    const [, update] = commandsToA2uiMessages(
      [{ name: 'a2ui_create_surface', args: { surfaceId: 's', components: [
        { id: 'root', component: 'Grid', children: { path: '/alerts', componentId: 'card' } },
        { id: 'card', component: 'Card', child: 'name' },
        { id: 'name', component: 'Text', text: { '@path': 'name' } },
      ] } }],
      VELLOC_CATALOG_ID,
    )
    const root = (update as { updateComponents: { components: Record<string, unknown>[] } }).updateComponents.components
      .find(c => c.id === 'root')!
    expect(root.children).toEqual({ path: '/alerts', componentId: 'card' })
  })

  it('lays cells out in equal columns that wrap at the minimum width', () => {
    const html = renderToStaticMarkup(createElement(GridView, {
      children: [{ id: 'card', basePath: '/alerts/0' }, { id: 'card', basePath: '/alerts/1' }, 'footer', 42],
      minWidth: 300,
      buildChild,
    }))
    expect(html).toContain('grid-template-columns:repeat(auto-fill, minmax(min(100%, 300px), 1fr))')
    expect(html.match(/data-slot="a2ui-grid-cell"/g)).toHaveLength(3)
    expect(html).toContain('data-id="card" data-path="/alerts/1"')
    expect(html).toContain('data-id="footer" data-path=""')
    expect(gridMinWidth(undefined)).toBe(280)
    expect(gridMinWidth(10)).toBe(120)
    expect(gridMinWidth(5000)).toBe(800)
  })

  it('ends the cells with the after child, once', () => {
    const html = renderToStaticMarkup(createElement(GridView, {
      children: [{ id: 'card', basePath: '/alerts/0' }],
      after: 'add',
      buildChild,
    }))
    expect(html.match(/data-slot="a2ui-grid-cell"/g)).toHaveLength(2)
    expect(html.indexOf('data-path="/alerts/0"')).toBeLessThan(html.indexOf('data-id="add"'))
  })

  it('draws an AddCard as a dashed plus button named by its label, disabled without an action', () => {
    const html = renderToStaticMarkup(createElement(AddCardView, { label: 'Add alert with AI', action: () => {} }))
    expect(html).toMatch(/<button[^>]*data-slot="a2ui-add-card"[^>]*aria-label="Add alert with AI"[^>]*border-dashed/)
    expect(html).toContain('<svg')
    expect(html).not.toContain('disabled=')
    expect(renderToStaticMarkup(createElement(AddCardView, { label: 'Add' }))).toContain('disabled=')
  })

  it('pins a HoverBar to its grid cell corner, shown on hover, and leaves it inline elsewhere', () => {
    const bar = createElement(HoverBarView, { children: ['edit', 'delete'], buildChild })
    const inGrid = renderToStaticMarkup(createElement(GridView, {
      children: ['cell'],
      buildChild: () => bar,
    }))
    expect(inGrid).toMatch(/data-slot="a2ui-grid-cell" class="group\/cell relative/)
    expect(inGrid).toMatch(/data-slot="a2ui-hover-bar" data-pinned="true" class="[^"]*--a2ui-icon-size:14px[^"]*absolute -top-3 right-3[^"]*opacity-0[^"]*group-hover\/cell:opacity-100/)
    expect(inGrid.indexOf('data-id="edit"')).toBeLessThan(inGrid.indexOf('data-id="delete"'))
    const alone = renderToStaticMarkup(bar)
    expect(alone).toContain('data-pinned="false"')
    expect(alone).not.toContain('absolute')
  })
})
