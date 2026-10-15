import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import {
  ToolDetailTree,
  extractScreenshotImages,
} from '../components/assistant-ui/tool-detail-tree'
import { shouldLazyLoadToolDetail } from '../utils/toolCallDetails'

describe('shouldLazyLoadToolDetail — inline-args allowlist', () => {
  it('keeps the Agent (sub-agent) tool inline so its label args survive', () => {
    // Regression (nexus-agents.spec.ts:250): lazy-loading strips the Agent
    // tool's args to {} before tool-fallback.tsx's formatAgentToolLabel reads
    // `description`/`subagent_type`, rendering the bare "Sub-agent" fallback
    // instead of "Sub-agent (Explore): <description>". The args are tiny +
    // essential to the card title, so Agent must stay inline.
    expect(shouldLazyLoadToolDetail('Agent')).toBe(false)
  })

  it('keeps TodoWrite + AskUserQuestion inline (their UIs render args)', () => {
    expect(shouldLazyLoadToolDetail('TodoWrite')).toBe(false)
    expect(shouldLazyLoadToolDetail('AskUserQuestion')).toBe(false)
  })

  it('lazy-loads ordinary heavy-payload tools', () => {
    // A tool with no dedicated inline-rendering UI defers its detail payload.
    expect(shouldLazyLoadToolDetail('BrowserReadPage')).toBe(true)
  })
})

class BrowserObserveArgsLike {
  toJSON() {
    return {
      tab_id: 7,
    }
  }
}

describe('ToolDetailTree', () => {
  it('does not render object-like values as [object Object]', () => {
    const html = renderToStaticMarkup(
      createElement(ToolDetailTree, {
        value: new BrowserObserveArgsLike(),
      }),
    )

    expect(html).toContain('{&quot;tab_id&quot;:7}')
    expect(html).not.toContain('[object Object]')
  })

  it('shows browser element text and titles in collapsed previews', () => {
    const html = renderToStaticMarkup(
      createElement(ToolDetailTree, {
        value: [
          {
            node_id: 4,
            type: 'anchor',
            text: '贴吧',
            href: 'http://tieba.baidu.com/',
          },
          {
            node_id: 11,
            type: 'form_control',
            title: 'Search Baidu',
            form: {
              type: 'search',
              placeholder: 'Search Baidu',
            },
          },
        ],
      }),
    )

    expect(html).toContain('anchor text: &quot;贴吧&quot;')
    expect(html).toContain('form_control title: &quot;Search Baidu&quot;')
  })

  it('shows tab previews for simple tool tab_id entries', () => {
    const html = renderToStaticMarkup(
      createElement(ToolDetailTree, {
        value: [
          {
            tab_id: 10,
            active: true,
          },
        ],
      }),
    )

    expect(html).toContain('tab 10 active')
  })

  it('wraps long unbroken leaf tokens instead of overflowing the parent', () => {
    // Regression: a leaf value with no spaces (base64 blob / long URL / CJK
    // run) used `break-words`, which never breaks such tokens, so the row
    // overflowed past the tool card. `break-all` wraps at any character.
    const html = renderToStaticMarkup(
      createElement(ToolDetailTree, {
        value: { blob: 'a'.repeat(400) },
      }),
    )

    expect(html).toContain('break-all')
    expect(html).not.toContain('break-words')
  })

  it('clips long collapsed node previews inside the row', () => {
    // Regression: the collapsed-node preview span had a bare `truncate` with no
    // `min-w-0`, so a long title preview stretched the button past the card.
    // A nested (collapsed-by-default) node is what renders the preview span.
    const html = renderToStaticMarkup(
      createElement(ToolDetailTree, {
        value: { nested: { title: 'x'.repeat(400) } },
      }),
    )

    expect(html).toContain('min-w-0 truncate')
  })
})

describe('ToolDetailTree screenshot rendering', () => {
  const PNG_1PX =
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=='

  it('renders an <img> for a multimodal content-part array result', () => {
    const html = renderToStaticMarkup(
      createElement(ToolDetailTree, {
        value: [
          { type: 'text', text: '{"action":"screenshot","ok":true}' },
          { type: 'image', image: PNG_1PX, mimeType: 'image/png' },
        ],
      }),
    )
    expect(html).toContain(`data:image/png;base64,${PNG_1PX}`)
    expect(html).toContain('<img')
    // Decode-memory contract: a screenshot is a full-resolution bitmap shown
    // as a 256px thumb — it must defer decode until near the viewport.
    expect(html).toContain('loading="lazy"')
    expect(html).toContain('decoding="async"')
  })

  it('renders an <img> for a raw observation screenshot result', () => {
    const html = renderToStaticMarkup(
      createElement(ToolDetailTree, {
        value: {
          action: 'screenshot',
          ok: true,
          observation: {
            tabs: [
              {
                tab_id: 11,
                screenshot: { mime: 'image/jpeg', data_base64: PNG_1PX },
              },
            ],
          },
        },
      }),
    )
    expect(html).toContain(`data:image/jpeg;base64,${PNG_1PX}`)
    expect(html).toContain('<img')
  })

  it('leaves non-screenshot results untouched (no <img>)', () => {
    const html = renderToStaticMarkup(
      createElement(ToolDetailTree, {
        value: { action: 'click', ok: true, observation: { tabs: [] } },
      }),
    )
    expect(html).not.toContain('<img')
  })
})

describe('extractScreenshotImages', () => {
  it('finds images in both content-array and raw-observation shapes', () => {
    const arr = extractScreenshotImages([
      { type: 'text', text: 'x' },
      { type: 'image', image: 'AAA', mimeType: 'image/png' },
    ])
    expect(arr).toEqual([{ src: 'data:image/png;base64,AAA', mime: 'image/png' }])

    const obs = extractScreenshotImages({
      observation: { tabs: [{ screenshot: { mime: 'image/jpeg', data_base64: 'BBB' } }] },
    })
    expect(obs).toEqual([{ src: 'data:image/jpeg;base64,BBB', mime: 'image/jpeg' }])

    expect(extractScreenshotImages({ action: 'click' })).toEqual([])
  })

  it('passes through data: and http(s) image URLs unchanged', () => {
    const dataUri = extractScreenshotImages([
      { type: 'image', image: 'data:image/png;base64,ZZZ', mimeType: 'image/png' },
    ])
    expect(dataUri[0]?.src).toBe('data:image/png;base64,ZZZ')
  })
})
