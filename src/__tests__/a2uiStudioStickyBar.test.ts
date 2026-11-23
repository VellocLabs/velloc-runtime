// StickyBar (F-1): a studio layout that stays at the top or bottom edge of the
// page while the page scrolls.
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { createElement, type ReactElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
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
      'root = Column([bar, body])',
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
