// @vitest-environment happy-dom
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'

const layouts = vi.hoisted(() => [] as Array<{ nodes: Array<{ id: string }>; nodeSort?: unknown }>)

vi.mock('@tanstack/charts/network/sankey', async importOriginal => {
  const real = await importOriginal<typeof import('@tanstack/charts/network/sankey')>()
  return {
    ...real,
    sankeyDiagram: ((options: { nodes: Iterable<{ id: string }>; nodeSort?: unknown }) => {
      layouts.push({ nodes: [...options.nodes], nodeSort: options.nodeSort })
      return real.sankeyDiagram(options as Parameters<typeof real.sankeyDiagram>[0])
    }) as typeof real.sankeyDiagram,
  }
})

const { chartRenderers } = await import('../browser/webview/a2ui/studio/vendor/catalog/renderers/charts')

/** Uses createElement (not JSX) to match the `*.test.ts` include glob. */
describe('studio SankeyChart node order', () => {
  it('keeps each column in the order its nodes first appear in the links, so the author decides it', () => {
    // Models grouped under their provider, though a smaller model of the first
    // provider comes before a larger one of the second: the layout must not
    // reorder them by size, or their flows cross.
    const links = [
      { source: 'All', target: 'P1', value: 200 },
      { source: 'All', target: 'P2', value: 110 },
      { source: 'P1', target: 'P1 · big', value: 190 },
      { source: 'P1', target: 'P1 · small', value: 10 },
      { source: 'P2', target: 'P2 · big', value: 100 },
      { source: 'P2', target: 'P2 · small', value: 10 },
    ]
    const Sankey = chartRenderers.SankeyChart as unknown as (input: { props: Record<string, unknown> }) => ReturnType<typeof createElement>
    layouts.length = 0
    renderToStaticMarkup(createElement(() => Sankey({ props: { links } })))
    expect(layouts.length).toBeGreaterThan(0)
    const [layout] = layouts
    expect(layout.nodes.map(node => node.id)).toEqual(['All', 'P1', 'P2', 'P1 · big', 'P1 · small', 'P2 · big', 'P2 · small'])
    expect(layout.nodeSort).toBeNull()
  })
})
