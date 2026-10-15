// @vitest-environment happy-dom
import { createElement, type FC } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, waitFor } from '@testing-library/react'
import {
  AssistantRuntimeProvider,
  MessagePrimitive,
  ThreadPrimitive,
  useExternalStoreRuntime,
  type ThreadMessageLike,
} from '@assistant-ui/react'
import { TooltipProvider } from '../components/ui/tooltip'
import { StaticMarkdown } from '../components/assistant-ui/static-markdown'
import { MarkdownText } from '../components/assistant-ui/markdown-text'
import {
  createGraphvizLoader,
  looksLikeDot,
  sanitizeGraphvizSvg,
} from '../components/assistant-ui/graphviz-diagram'

/**
 * Graphviz DOT in markdown surfaces: `GraphvizDiagram` is hooked into both markdown renderers, dispatching on a
 * `dot`/`graphviz` tag or a bare fence whose body is unambiguous DOT. The @viz-js/viz engine is mocked; these
 * tests assert the wiring.
 */

const { instanceMock, renderMock } = vi.hoisted(() => {
  const renderMock = vi.fn((code: string) => {
    if (code.includes('INVALID')) throw new Error('mock render error')
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
    svg.setAttribute('data-testid', 'mock-graphviz-svg')
    if (code.includes('URL=')) {
      // What Graphviz emits for a node `URL`: a live anchor around the shape.
      const a = document.createElementNS('http://www.w3.org/2000/svg', 'a')
      a.setAttributeNS('http://www.w3.org/1999/xlink', 'xlink:href', 'javascript:alert(1)')
      a.appendChild(document.createElementNS('http://www.w3.org/2000/svg', 'ellipse'))
      svg.appendChild(a)
    }
    return svg
  })
  const instanceMock = vi.fn(async () => ({ renderSVGElement: renderMock }))
  return { instanceMock, renderMock }
})

vi.mock('@viz-js/viz', () => ({ instance: instanceMock }))

const DOT_TAGGED_MD = '```dot\ndigraph { A -> B }\n```'
const GRAPHVIZ_TAGGED_MD = '```graphviz\ndigraph { A -> B }\n```'
// The user's actual case: a bare (untagged) fence holding raw DOT.
const DOT_BARE_MD = '```\ndigraph brainstorming {\n  A -> B\n}\n```'
const INVALID_DOT_MD = '```dot\ndigraph { A -> INVALID %%% }\n```'
const TS_MD = '```ts\nconst x: number = 1\n```'

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

describe('looksLikeDot (bare-fence content sniff)', () => {
  it('matches unambiguous DOT openers', () => {
    expect(looksLikeDot('digraph brainstorming {\n A -> B }')).toBe(true)
    expect(looksLikeDot('digraph { }')).toBe(true)
    expect(looksLikeDot('  strict digraph G { }')).toBe(true)
    expect(looksLikeDot('graph G {\n a -- b\n}')).toBe(true)
  })
  it('does NOT match a bare mermaid flowchart or plain prose/JSON', () => {
    // mermaid `graph TD` has no `{` — must not be mistaken for DOT.
    expect(looksLikeDot('graph TD\n A --> B')).toBe(false)
    expect(looksLikeDot('just some text about a digraph')).toBe(false)
    expect(looksLikeDot('{ "digraph": true }')).toBe(false)
  })
})

describe('StaticMarkdown (SkillPanel / plan / .md preview renderer)', () => {
  it('renders a ```dot fence as a graph (not a code block)', async () => {
    render(createElement(StaticMarkdown, { content: DOT_TAGGED_MD }))
    const slot = document.querySelector('[data-slot="graphviz-diagram"]')
    expect(slot).not.toBeNull()
    // The diagram must NOT be boxed inside a styled code <pre>.
    expect(slot!.closest('pre')).toBeNull()
    await waitFor(() =>
      expect(
        slot!.querySelector('[data-testid="mock-graphviz-svg"]'),
      ).not.toBeNull(),
    )
    expect(renderMock.mock.calls[0]![0]).toContain('digraph')
  })

  it('renders a ```graphviz fence as a graph', async () => {
    render(createElement(StaticMarkdown, { content: GRAPHVIZ_TAGGED_MD }))
    const slot = document.querySelector('[data-slot="graphviz-diagram"]')
    expect(slot).not.toBeNull()
    await waitFor(() =>
      expect(
        slot!.querySelector('[data-testid="mock-graphviz-svg"]'),
      ).not.toBeNull(),
    )
  })

  it('renders a BARE (untagged) DOT fence as a graph — the reported skill case', async () => {
    render(createElement(StaticMarkdown, { content: DOT_BARE_MD }))
    const slot = document.querySelector('[data-slot="graphviz-diagram"]')
    expect(slot).not.toBeNull()
    await waitFor(() =>
      expect(
        slot!.querySelector('[data-testid="mock-graphviz-svg"]'),
      ).not.toBeNull(),
    )
  })

  it('leaves a non-DOT fence as a normal <pre><code> block', () => {
    render(createElement(StaticMarkdown, { content: TS_MD }))
    expect(document.querySelector('[data-slot="graphviz-diagram"]')).toBeNull()
    const code = document.querySelector('pre > code')
    expect(code).not.toBeNull()
    expect(code!.textContent).toContain('const x: number = 1')
    expect(renderMock).not.toHaveBeenCalled()
  })

  it('falls back to the raw source when DOT fails to render', async () => {
    render(createElement(StaticMarkdown, { content: INVALID_DOT_MD }))
    await waitFor(() =>
      expect(
        document.querySelector('[data-slot="graphviz-diagram-fallback"]'),
      ).not.toBeNull(),
    )
    expect(
      document.querySelector('[data-slot="graphviz-diagram-fallback"]')!
        .textContent,
    ).toContain('INVALID')
  })
})

describe('sanitizeGraphvizSvg (model-authored DOT)', () => {
  // DOT comes from the model, and Graphviz turns URL/href attributes into live
  // `<a xlink:href>` anchors (`javascript:` included) and copies id/class onto
  // its groups. Run the REAL engine so the test pins what Graphviz emits.
  const MALICIOUS_DOT =
    'digraph { a [URL="javascript:alert(1)" target="_blank" id="root" class="fixed inset-0"];' +
    ' b [href="https://evil.example"]; a -> b [edgeURL="https://y" labelURL="https://z" label="l"];' +
    ' subgraph cluster_x { URL="https://c"; c } }'

  it('strips every link and page-reaching attribute from real Graphviz output', async () => {
    const actual = await vi.importActual<typeof import('@viz-js/viz')>('@viz-js/viz')
    const viz = await actual.instance()
    const svg = viz.renderSVGElement(MALICIOUS_DOT)
    // Precondition: the engine really emitted the dangerous shapes.
    expect(svg.querySelector('a')).not.toBeNull()
    expect(svg.outerHTML).toContain('javascript:alert(1)')

    sanitizeGraphvizSvg(svg)

    expect(svg.querySelector('a')).toBeNull()
    const html = svg.outerHTML
    expect(html).not.toContain('javascript:')
    expect(html).not.toContain('evil.example')
    expect(html).not.toMatch(/\bhref=/)
    expect(html).not.toMatch(/\btarget=/)
    // ids survive only namespaced, so none can name (or collide with) a page id.
    expect(html).not.toContain('id="root"')
    for (const el of Array.from(svg.querySelectorAll('[id]'))) {
      expect(el.id).toMatch(/^gv\d+-/)
    }
    expect(html).not.toMatch(/\bclass=/)
    // The drawing itself survives: the anchors were unwrapped, not deleted.
    expect(svg.querySelectorAll('ellipse')).toHaveLength(3)
    expect(svg.textContent).toContain('l')
  })

  it('keeps gradient fills working: ids are namespaced and url(#…) follows', async () => {
    const actual = await vi.importActual<typeof import('@viz-js/viz')>('@viz-js/viz')
    const viz = await actual.instance()
    const svg = viz.renderSVGElement('digraph { a [style=filled fillcolor="red:blue"] }')
    const gradient = svg.querySelector('linearGradient')
    // Precondition: the engine draws the fill as a gradient referenced by id.
    expect(gradient?.id).toBeTruthy()

    sanitizeGraphvizSvg(svg)

    const id = gradient!.getAttribute('id')!
    expect(id).toMatch(/^gv\d+-/)
    const filled = Array.from(svg.querySelectorAll('[fill]')).filter((el) =>
      el.getAttribute('fill')!.startsWith('url('),
    )
    expect(filled.length).toBeGreaterThan(0)
    for (const el of filled) expect(el.getAttribute('fill')).toBe(`url(#${id})`)
  })

  it('gives each diagram its own id namespace', () => {
    const make = () =>
      new DOMParser().parseFromString(
        '<svg xmlns="http://www.w3.org/2000/svg"><linearGradient id="g"/><rect fill="url(#g)"/></svg>',
        'image/svg+xml',
      ).documentElement
    const one = make()
    const two = make()
    sanitizeGraphvizSvg(one)
    sanitizeGraphvizSvg(two)
    expect(one.querySelector('linearGradient')!.id).not.toBe(
      two.querySelector('linearGradient')!.id,
    )
  })

  it('drops a url() that does not name an id in the same diagram', () => {
    const svg = new DOMParser().parseFromString(
      '<svg xmlns="http://www.w3.org/2000/svg">' +
        '<rect id="a" fill="url(https://evil.example/x.svg#g)"/>' +
        '<rect stroke="url(#page-id)"/><rect filter="url( \'#a\' )"/></svg>',
      'image/svg+xml',
    ).documentElement
    sanitizeGraphvizSvg(svg)
    const rects = svg.querySelectorAll('rect')
    expect(rects[0].hasAttribute('fill')).toBe(false)
    expect(rects[1].hasAttribute('stroke')).toBe(false)
    expect(rects[2].getAttribute('filter')).toBe(`url(#${rects[0].id})`)
    expect(svg.outerHTML).not.toContain('evil.example')
  })

  it('removes script-capable elements and on* handlers', () => {
    const svg = new DOMParser().parseFromString(
      '<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)">' +
        '<script>alert(2)</script><foreignObject><div/></foreignObject>' +
        '<g onclick="alert(3)"><set attributeName="href" to="javascript:alert(4)"/><text>ok</text></g>' +
        '</svg>',
      'image/svg+xml',
    ).documentElement
    sanitizeGraphvizSvg(svg)
    const html = svg.outerHTML
    expect(html).not.toContain('alert')
    expect(svg.querySelector('script, foreignObject, set')).toBeNull()
    expect(svg.textContent).toBe('ok')
  })

  it('the diagram component inserts the sanitized tree', async () => {
    render(
      createElement(StaticMarkdown, {
        content: '```dot\ndigraph { a [URL="javascript:alert(1)"] }\n```',
      }),
    )
    const slot = document.querySelector('[data-slot="graphviz-diagram"]')
    await waitFor(() =>
      expect(slot!.querySelector('[data-testid="mock-graphviz-svg"]')).not.toBeNull(),
    )
    expect(slot!.querySelector('a')).toBeNull()
    expect(slot!.innerHTML).not.toContain('javascript:')
    expect(slot!.querySelector('ellipse')).not.toBeNull()
  })
})

describe('createGraphvizLoader retry contract', () => {
  it('a rejected import is not cached — the next call retries', async () => {
    // Regression guard mirroring the mermaid loader: `??=` on a REJECTED
    // promise would poison every future graph for the page lifetime.
    const fakeViz = { renderSVGElement: vi.fn() }
    const importer = vi
      .fn<() => Promise<{ instance: () => Promise<unknown> }>>()
      .mockRejectedValueOnce(new Error('chunk load failed'))
      .mockResolvedValue({ instance: () => Promise.resolve(fakeViz) })
    const load = createGraphvizLoader(
      importer as unknown as Parameters<typeof createGraphvizLoader>[0],
    )

    await expect(load()).rejects.toThrow('chunk load failed')
    await expect(load()).resolves.toBe(fakeViz)
    expect(importer).toHaveBeenCalledTimes(2)
    // A SUCCESSFUL load stays cached — no third import.
    await load()
    expect(importer).toHaveBeenCalledTimes(2)
  })

  it('a rejected wasm instance() also clears the cache', async () => {
    // The failure can be in instance() (wasm init), not just the import — the
    // `.catch` after `.then(m => m.instance())` must clear that too.
    const fakeViz = { renderSVGElement: vi.fn() }
    const importer = vi
      .fn<() => Promise<{ instance: () => Promise<unknown> }>>()
      .mockResolvedValueOnce({
        instance: () => Promise.reject(new Error('wasm init failed')),
      })
      .mockResolvedValue({ instance: () => Promise.resolve(fakeViz) })
    const load = createGraphvizLoader(
      importer as unknown as Parameters<typeof createGraphvizLoader>[0],
    )

    await expect(load()).rejects.toThrow('wasm init failed')
    await expect(load()).resolves.toBe(fakeViz)
    expect(importer).toHaveBeenCalledTimes(2)
  })
})

// ---- chat-message renderer (MarkdownTextPrimitive + componentsByLanguage) ----

function makeChatHarness(text: string): FC {
  const AssistantMessage: FC = () =>
    createElement(
      MessagePrimitive.Root,
      null,
      createElement(MessagePrimitive.Parts, {
        components: { Text: MarkdownText },
      }),
    )
  const UserMessage: FC = () => null
  const message: ThreadMessageLike = {
    role: 'assistant',
    content: [{ type: 'text', text }],
  }
  return function Harness() {
    const runtime = useExternalStoreRuntime<ThreadMessageLike>({
      messages: [message],
      convertMessage: (m) => m,
      isRunning: false,
      onNew: async () => {},
    })
    return createElement(
      TooltipProvider,
      null,
      createElement(
        AssistantRuntimeProvider,
        { runtime },
        createElement(
          ThreadPrimitive.Root,
          null,
          createElement(
            ThreadPrimitive.Viewport,
            null,
            createElement(ThreadPrimitive.Messages, {
              components: { AssistantMessage, UserMessage },
            }),
          ),
        ),
      ),
    )
  }
}

describe('MarkdownText (chat messages) componentsByLanguage hook', () => {
  it('renders a ```dot fence in an assistant message as a graph', async () => {
    render(
      createElement(makeChatHarness(`Here is the flow:\n\n${DOT_TAGGED_MD}`)),
    )
    const slot = document.querySelector('[data-slot="graphviz-diagram"]')
    expect(slot).not.toBeNull()
    await waitFor(() =>
      expect(
        slot!.querySelector('[data-testid="mock-graphviz-svg"]'),
      ).not.toBeNull(),
    )
    // No code header (language/copy row) above the diagram.
    expect(document.querySelector('.aui-code-header-root')).toBeNull()
  })
})
