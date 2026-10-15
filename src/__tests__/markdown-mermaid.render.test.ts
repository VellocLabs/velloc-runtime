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
  MermaidDiagram,
  createMermaidLoader,
} from '../components/assistant-ui/mermaid-diagram'

/**
 * ```mermaid in markdown surfaces: plan/file surfaces render through `StaticMarkdown` and `MermaidDiagram` is
 * hooked into both renderers. The mermaid library is mocked; these tests assert the wiring.
 */

const { initializeMock, renderMock } = vi.hoisted(() => {
  const renderMock = vi.fn(async (_id: string, code: string) => {
    if (code.includes('INVALID')) throw new Error('mock parse error')
    return { svg: '<svg data-testid="mock-mermaid-svg"></svg>' }
  })
  return { initializeMock: vi.fn(), renderMock }
})

vi.mock('mermaid', () => ({
  default: { initialize: initializeMock, render: renderMock },
}))

const MERMAID_MD = '```mermaid\ngraph TD\n  A --> B\n```'
const INVALID_MERMAID_MD = '```mermaid\ngraph TD INVALID %%%\n```'
const TS_MD = '```ts\nconst x: number = 1\n```'

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

describe('StaticMarkdown (plan panel / .md file preview renderer)', () => {
  it('renders a ```mermaid fence as a diagram (not a code block)', async () => {
    render(createElement(StaticMarkdown, { content: MERMAID_MD }))
    const slot = document.querySelector('[data-slot="mermaid-diagram"]')
    expect(slot).not.toBeNull()
    // The diagram must NOT be boxed inside a styled code <pre>.
    expect(slot!.closest('pre')).toBeNull()
    await waitFor(() =>
      expect(
        slot!.querySelector('[data-testid="mock-mermaid-svg"]'),
      ).not.toBeNull(),
    )
    // mermaid.render got the fence body and a selector-safe (colon-free) id.
    const [id, code] = renderMock.mock.calls[0]!
    expect(id).not.toContain(':')
    expect(code).toContain('graph TD')
  })

  it('renders a non-mermaid fence as a normal <pre><code> block', () => {
    render(createElement(StaticMarkdown, { content: TS_MD }))
    expect(document.querySelector('[data-slot="mermaid-diagram"]')).toBeNull()
    const code = document.querySelector('pre > code')
    expect(code).not.toBeNull()
    expect(code!.textContent).toContain('const x: number = 1')
    expect(renderMock).not.toHaveBeenCalled()
  })

  it('renders images with lazy loading + async decode, and nothing else changed', () => {
    // Decode-memory contract: a markdown image keeps EXACTLY its default
    // rendering (no sizing classes injected — display must not change) but
    // carries loading=lazy + decoding=async so scrolled-away images stay
    // undecoded (~4 bytes/px per decoded bitmap otherwise, however small it
    // displays).
    render(
      createElement(StaticMarkdown, {
        content: '![a chart](data:image/png;base64,AAAA)',
      }),
    )
    const img = document.querySelector('img')
    expect(img).not.toBeNull()
    expect(img!.getAttribute('loading')).toBe('lazy')
    expect(img!.getAttribute('decoding')).toBe('async')
    expect(img!.getAttribute('alt')).toBe('a chart')
    expect(img!.getAttribute('class')).toBeNull()
  })

  it('renders headings and lists (plan surfaces get real markdown, not raw text)', () => {
    render(
      createElement(StaticMarkdown, {
        content: '# Plan title\n\n- first step\n- second step',
      }),
    )
    const h1 = document.querySelector('h1')
    expect(h1).not.toBeNull()
    expect(h1!.textContent).toBe('Plan title')
    expect(document.querySelectorAll('ul > li').length).toBe(2)
  })

  it('falls back to the raw source when mermaid fails to parse', async () => {
    render(createElement(StaticMarkdown, { content: INVALID_MERMAID_MD }))
    await waitFor(() =>
      expect(
        document.querySelector('[data-slot="mermaid-diagram-fallback"]'),
      ).not.toBeNull(),
    )
    expect(
      document.querySelector('[data-slot="mermaid-diagram-fallback"]')!
        .textContent,
    ).toContain('graph TD INVALID')
  })
})

describe('MermaidDiagram error recovery', () => {
  it('recovers from a parse error once the code becomes valid (streaming)', async () => {
    // Regression: a >debounce mid-stream pause renders a PARTIAL fence →
    // parse error. The error state must not be a one-way trap — when the
    // fence completes and renders successfully, the diagram must replace the
    // raw-source fallback. Pre-fix, the fallback unmounted the ref'd
    // container, so the success path bailed at `!containerRef.current`
    // forever.
    const { rerender } = render(
      createElement(MermaidDiagram, { code: 'graph TD INVALID %%%' }),
    )
    await waitFor(() =>
      expect(
        document.querySelector('[data-slot="mermaid-diagram-fallback"]'),
      ).not.toBeNull(),
    )

    // The stream completes the fence with valid code.
    rerender(createElement(MermaidDiagram, { code: 'graph TD\n  A --> B' }))
    await waitFor(() =>
      expect(
        document.querySelector('[data-testid="mock-mermaid-svg"]'),
      ).not.toBeNull(),
    )
    // Fallback cleared, diagram visible.
    expect(
      document.querySelector('[data-slot="mermaid-diagram-fallback"]'),
    ).toBeNull()
    const slot = document.querySelector('[data-slot="mermaid-diagram"]')
    expect(slot).not.toBeNull()
    expect(slot!.classList.contains('hidden')).toBe(false)
  })
})

describe('createMermaidLoader retry contract', () => {
  it('a rejected import is not cached — the next call retries', async () => {
    // Regression: `mermaidPromise ??= import(...)` cached a REJECTED promise,
    // so one transient chunk-load failure poisoned every future diagram for
    // the page lifetime.
    const fakeModule = { initialize: vi.fn(), render: vi.fn() }
    const importer = vi
      .fn<() => Promise<{ default: unknown }>>()
      .mockRejectedValueOnce(new Error('chunk load failed'))
      .mockResolvedValue({ default: fakeModule })
    const load = createMermaidLoader(
      importer as unknown as Parameters<typeof createMermaidLoader>[0],
    )

    await expect(load()).rejects.toThrow('chunk load failed')
    // Pre-fix this returned the same rejected promise without re-importing.
    await expect(load()).resolves.toBe(fakeModule)
    expect(importer).toHaveBeenCalledTimes(2)
    // And a SUCCESSFUL load stays cached — no third import.
    await load()
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
  it('renders a ```mermaid fence in an assistant message as a diagram', async () => {
    render(createElement(makeChatHarness(`Here is the flow:\n\n${MERMAID_MD}`)))
    const slot = document.querySelector('[data-slot="mermaid-diagram"]')
    expect(slot).not.toBeNull()
    await waitFor(() =>
      expect(
        slot!.querySelector('[data-testid="mock-mermaid-svg"]'),
      ).not.toBeNull(),
    )
    // No code header (language/copy row) above the diagram.
    expect(document.querySelector('.aui-code-header-root')).toBeNull()
  })

  it('keeps normal fences as <pre><code> with the language header', () => {
    render(createElement(makeChatHarness(TS_MD)))
    expect(document.querySelector('[data-slot="mermaid-diagram"]')).toBeNull()
    const code = document.querySelector('pre > code')
    expect(code).not.toBeNull()
    expect(code!.textContent).toContain('const x: number = 1')
    const header = document.querySelector('.aui-code-header-root')
    expect(header).not.toBeNull()
    expect(header!.textContent).toContain('ts')
  })

  it('code-block copy uses the robust clipboard util and gates on success', async () => {
    const util = await import('../utils/clipboard')
    const writeSpy = vi.spyOn(util, 'writeClipboard')

    render(createElement(makeChatHarness(TS_MD)))
    const button = document.querySelector(
        '.aui-code-header-root button',
    ) as HTMLButtonElement | null
    expect(button).not.toBeNull()

    // Success → copied state (check icon) appears.
    writeSpy.mockResolvedValueOnce(true)
    button!.click()
    // The fenced code's content carries a trailing newline.
    expect(writeSpy).toHaveBeenCalledWith('const x: number = 1\n')
    await waitFor(() => {
      expect(button!.querySelector('svg.lucide-check')).not.toBeNull()
    })

    // The click is NOT locked out during the copied window — a second click
    // re-copies (idempotent).
    writeSpy.mockClear()
    writeSpy.mockResolvedValueOnce(true)
    button!.click()
    expect(writeSpy).toHaveBeenCalledWith('const x: number = 1\n')
  })

  it('a failed copy does not flip to the "copied" state', async () => {
    const util = await import('../utils/clipboard')
    const writeSpy = vi.spyOn(util, 'writeClipboard')

    render(createElement(makeChatHarness(TS_MD)))
    const button = document.querySelector(
        '.aui-code-header-root button',
    ) as HTMLButtonElement | null
    expect(button).not.toBeNull()

    // From idle: a failed write must NOT set the copied state.
    writeSpy.mockResolvedValueOnce(false)
    button!.click()
    expect(writeSpy).toHaveBeenCalledWith('const x: number = 1\n')
    await new Promise((r) => setTimeout(r, 10))
    expect(button!.querySelector('svg.lucide-check')).toBeNull()

    // And the button stays clickable (no lock).
    writeSpy.mockResolvedValueOnce(true)
    button!.click()
    expect(writeSpy).toHaveBeenCalledWith('const x: number = 1\n')
    await waitFor(() => {
      expect(button!.querySelector('svg.lucide-check')).not.toBeNull()
    })
  })
})
