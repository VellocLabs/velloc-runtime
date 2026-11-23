// @vitest-environment happy-dom
// StickyBar (F-1): a studio layout that stays at the top or bottom edge of the
// page while the page scrolls.
import { afterEach, describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { createElement, type ReactElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { cleanup, render as mount, waitFor } from '@testing-library/react'
import { exportA2UICatalog } from '@copilotkit/react-core/v2/generative-ui'
import { studioUI } from '../browser/webview/a2ui/studio/studioCatalog'
import { StudioSurfaceHost } from '../browser/webview/a2ui/studio/StudioSurfaceHost'
import description from '../toolkit/builtin/a2ui/express/studio-catalog.json'
import { createStudioExpressCompiler } from '../toolkit/builtin/a2ui/express/studioExpress'
import { layoutRenderers } from '../browser/webview/a2ui/studio/vendor/catalog/renderers/layout'

type Created = { createSurface?: { components: { id: string; component: string; children?: unknown; edge?: unknown }[] } }

const compiler = createStudioExpressCompiler(description as unknown as Record<string, unknown>)
const CSS = readFileSync(
  resolve(__dirname, '../browser/webview/a2ui/studio/vendor/catalog/renderers/renderers.css'),
  'utf8',
)

function render(props: Record<string, unknown>): string {
  const StickyBar = layoutRenderers.StickyBar as unknown as (input: { props: Record<string, unknown> }) => ReactElement
  return renderToStaticMarkup(createElement(() => StickyBar({ props })))
}

describe('studio StickyBar (F-1)', () => {
  it('compiles with its children and edge', () => {
    const result = compiler.compile([
      'surface("page")',
      'root = Column([body, bar])',
      'bar = StickyBar([save], edge="bottom")',
      'save = Button("Save")',
      'body = Text("long page")',
    ].join('\n'))
    if (!result.ok) throw new Error(result.message)
    const list = (result.messages as Created[]).flatMap(message => message.createSurface?.components ?? [])
    const bar = list.find(entry => entry.id === 'bar')
    expect(bar).toMatchObject({ component: 'StickyBar', children: ['save'], edge: 'bottom' })
  })

  it('refuses an edge that is neither top nor bottom', () => {
    const result = compiler.compile(['surface("page")', 'root = StickyBar([t], edge="left")', 't = Text("a")'].join('\n'))
    expect(result.ok).toBe(false)
  })

  it('renders at the top edge unless told bottom', () => {
    expect(render({ children: 'x' })).toContain('data-edge="top"')
    expect(render({ children: 'x', edge: 'bottom' })).toContain('data-edge="bottom"')
    expect(render({ children: 'x' })).toContain('a2-sticky-bar')
  })

  it('is positioned sticky at its edge, over an opaque background', () => {
    const rule = /\.a2-sticky-bar \{([^}]*)\}/.exec(CSS)?.[1] ?? ''
    expect(rule).toMatch(/position:\s*sticky/)
    expect(rule).toMatch(/background:\s*var\(--background\)/)
    expect(CSS).toMatch(/\.a2-sticky-bar\[data-edge="top"\] \{\s*top:\s*0/)
    expect(CSS).toMatch(/\.a2-sticky-bar\[data-edge="bottom"\] \{\s*bottom:\s*0/)
  })
})

describe('an empty studio StickyBar (F-1)', () => {
  const surfaceCompiler = createStudioExpressCompiler(exportA2UICatalog(studioUI as never) as Record<string, unknown>)
  const emptyRule = /\.a2-sticky-bar(:[^{]+?)\s*\{([^}]*)\}/.exec(CSS)
  const emptySelector = emptyRule?.[1] ?? ''

  afterEach(() => cleanup())

  async function bar(lines: string[], rows: unknown[] = []): Promise<Element> {
    const result = surfaceCompiler.compile(['surface("p")', 'root = Column([body, bar])', 'body = Text("page")', ...lines].join('\n'))
    if (!result.ok) throw new Error(result.message)
    const operations = [...result.messages, { version: '1.0', updateDataModel: { surfaceId: 'p', path: '/data', value: { rows } } }]
    const view = mount(createElement(StudioSurfaceHost, { surfaceId: 'p', operations }))
    return waitFor(() => {
      const found = view.container.querySelector('.a2-sticky-bar')
      if (!found) throw new Error('no bar yet')
      return found
    })
  }

  it('drops its padding and background', () => {
    expect(emptySelector).not.toBe('')
    expect(emptyRule?.[2]).toMatch(/padding-block:\s*0/)
    expect(emptyRule?.[2]).toMatch(/background:\s*transparent/)
  })

  it('is empty when its template list has no rows, directly or inside a Column', async () => {
    const direct = await bar(['bar = StickyBar(_template($/data/rows, row), edge="bottom")', 'row = Alert("note")'])
    expect(direct.matches(emptySelector)).toBe(true)
    cleanup()
    const nested = await bar(['bar = StickyBar([list], edge="bottom")', 'list = Column(_template($/data/rows, row))', 'row = Alert("note")'])
    expect(nested.matches(emptySelector)).toBe(true)
  })

  it('is not empty when it shows something, even something drawn only with divs', async () => {
    const notice = await bar(['bar = StickyBar(_template($/data/rows, row), edge="bottom")', 'row = Alert("note")'], [{ id: 1 }])
    expect(notice.matches(emptySelector)).toBe(false)
    cleanup()
    const loading = await bar(['bar = StickyBar([s])', 's = Skeleton()'])
    expect(loading.matches(emptySelector)).toBe(false)
    cleanup()
    const rule = await bar(['bar = StickyBar([d])', 'd = Divider()'])
    expect(rule.matches(emptySelector)).toBe(false)
  })
})
