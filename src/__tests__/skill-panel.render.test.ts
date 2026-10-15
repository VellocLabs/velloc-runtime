// @vitest-environment happy-dom
import { createElement } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'

import {
  SkillPanel,
  stripFrontmatter,
  stripSkillTagHeader,
} from '../browser/webview/SkillPanel'
import { SkillToolUI } from '../browser/webview/SkillToolUI'
import { RightPanelContentContext } from '../components/assistant-ui/right-panel-content-context'

// The right-panel Skill view: lazy-loads the `skill:<uuid>` sidecar through
// loadToolCallDetail and renders the SKILL.md body (tags stripped) as markdown;
// a pre-sidecar target renders its inline body without a fetch.

// A skill body can contain a Graphviz DOT fence; StaticMarkdown routes it to
// the lazy-loaded GraphvizDiagram. Mock the heavyweight WASM engine so the
// panel tests don't pull the real ~1.2 MB chunk.
vi.mock('@viz-js/viz', () => ({
  instance: vi.fn(async () => ({
    renderSVGElement: (_code: string) =>
      document.createElementNS('http://www.w3.org/2000/svg', 'svg'),
  })),
}))

afterEach(() => cleanup())

const TEXT =
  '<command-message>superpowers:writing-plans</command-message>\n'
  + '<command-name>/superpowers:writing-plans</command-name>\n\n'
  + '# Writing Plans\n\nWrite comprehensive plans.'

describe('SkillPanel', () => {
  it('shows the empty state with no target', () => {
    render(createElement(SkillPanel, { target: null }))
    expect(screen.getByTestId('skill-panel-empty')).toBeTruthy()
  })

  it('loads the sidecar by detailId and renders the body without the tag header', async () => {
    const loadToolCallDetail = vi.fn(async (id: string) => ({
      toolCallId: id,
      toolName: 'Skill',
      result: TEXT,
    }))
    render(
      createElement(SkillPanel, {
        target: { name: 'superpowers:writing-plans', args: 'go', detailId: 'skill:u1', inlineBody: null },
        loadToolCallDetail,
      }),
    )
    await waitFor(() => expect(screen.getByText('Writing Plans')).toBeTruthy())
    expect(loadToolCallDetail).toHaveBeenCalledWith('skill:u1')
    expect(screen.getByText('Write comprehensive plans.')).toBeTruthy()
    expect(screen.queryByText(/command-message/)).toBeNull()
    expect(screen.getByText(/Arguments: go/)).toBeTruthy()
  })

  it('renders a bare DOT fence in a skill body as a graph, not raw text', () => {
    // The reported bug: a skill (e.g. brainstorming) whose SKILL.md pastes a
    // bare ```digraph { … }``` fence showed the DOT as text. It must now render
    // as a graph via GraphvizDiagram (bare-fence content sniff).
    const body =
      '# Brainstorming\n\nUse this flow:\n\n'
      + '```\ndigraph brainstorming {\n  A -> B\n}\n```'
    render(
      createElement(SkillPanel, {
        target: { name: 'superpowers:brainstorming', detailId: null, inlineBody: body },
      }),
    )
    expect(screen.getByText('Brainstorming')).toBeTruthy()
    // Rendered as a diagram slot — and NOT left as a raw <pre> code block.
    const slot = document.querySelector('[data-slot="graphviz-diagram"]')
    expect(slot).not.toBeNull()
    expect(slot!.closest('pre')).toBeNull()
    expect(screen.queryByText(/digraph brainstorming/)).toBeNull()
  })

  it('renders an inline body (pre-sidecar transcript) without fetching', () => {
    const loadToolCallDetail = vi.fn(async () => null)
    render(
      createElement(SkillPanel, {
        target: { name: 'x', detailId: null, inlineBody: TEXT },
        loadToolCallDetail,
      }),
    )
    expect(screen.getByText('Writing Plans')).toBeTruthy()
    expect(loadToolCallDetail).not.toHaveBeenCalled()
  })

  it('reports a failed / missing sidecar', async () => {
    render(
      createElement(SkillPanel, {
        target: { name: 'x', detailId: 'skill:missing', inlineBody: null },
        loadToolCallDetail: async () => null,
      }),
    )
    await waitFor(() =>
      expect(screen.getByText('Failed to load skill instructions.')).toBeTruthy(),
    )
  })

  it('stripSkillTagHeader drops only the leading tag block', () => {
    expect(stripSkillTagHeader(TEXT)).toBe('# Writing Plans\n\nWrite comprehensive plans.')
    expect(stripSkillTagHeader('no tags here')).toBe('no tags here')
  })

  it('stripFrontmatter drops a leading YAML block and leaves bodies untouched', () => {
    expect(
      stripFrontmatter('---\nname: x\ndescription: y\n---\n# Body\n\ntext'),
    ).toBe('# Body\n\ntext')
    // CRLF frontmatter.
    expect(
      stripFrontmatter('---\r\nname: x\r\n---\r\n# Body'),
    ).toBe('# Body')
    // No frontmatter → unchanged.
    expect(stripFrontmatter('# Body\n\ntext')).toBe('# Body\n\ntext')
    // A leading `---` thematic break (HR followed by a blank line) is NOT
    // frontmatter — the body between the two rules must be preserved.
    const hr = '---\n\nIntro paragraph\n\n---\n\nRest'
    expect(stripFrontmatter(hr)).toBe(hr)
  })

  it('lists the loaded skills and selects a row in place on click (no new tab)', () => {
    const onSelectSkill = vi.fn()
    render(
      createElement(SkillPanel, {
        target: null,
        loadedSkills: [
          { name: 'plugin:build', description: 'Builds', path: '/s/build/SKILL.md' },
          { name: 'plugin:test', path: '/s/test/SKILL.md' },
        ],
        onSelectSkill,
      }),
    )
    const items = screen.getAllByTestId('skill-panel-loaded-item')
    expect(items).toHaveLength(2)
    expect(items[0]!.textContent).toContain('plugin:build')
    fireEvent.click(items[1]!)
    expect(onSelectSkill).toHaveBeenCalledWith({
      name: 'plugin:test',
      path: '/s/test/SKILL.md',
    })
    // A loaded list with no opened skill is NOT the empty state.
    expect(screen.queryByTestId('skill-panel-empty')).toBeNull()
    expect(screen.getByTestId('skill-panel-loaded-list')).toBeTruthy()
  })

  it('renders a selected skill\'s SKILL.md from disk (frontmatter stripped)', async () => {
    const readFileText = vi.fn(async (_path: string) =>
      '---\nname: build\ndescription: Builds\n---\n# Build\n\nRun the build.',
    )
    render(
      createElement(SkillPanel, {
        target: { name: 'build', path: '/s/build/SKILL.md', detailId: null, inlineBody: null },
        loadedSkills: [{ name: 'build', path: '/s/build/SKILL.md' }],
        readFileText,
      }),
    )
    await waitFor(() => expect(screen.getByText('Build')).toBeTruthy())
    expect(readFileText).toHaveBeenCalledWith('/s/build/SKILL.md')
    expect(screen.getByText('Run the build.')).toBeTruthy()
    // The stripped YAML frontmatter must not leak into the rendered view.
    expect(screen.queryByText(/description: Builds/)).toBeNull()
    // The clicked skill's row is highlighted as active.
    const active = screen.getByTestId('skill-panel-loaded-item')
    expect(active.className).toContain('bg-muted/60')
  })

  it('still shows the empty state when there is neither a target nor a loaded list', () => {
    render(createElement(SkillPanel, { target: null, loadedSkills: [] }))
    expect(screen.getByTestId('skill-panel-empty')).toBeTruthy()
  })

  it('shows each row\'s size and a header total (count + size)', () => {
    render(
      createElement(SkillPanel, {
        target: null,
        loadedSkills: [
          { name: 'plugin:build', path: '/s/build/SKILL.md', size: 512 },
          { name: 'plugin:test', path: '/s/test/SKILL.md', size: 1536 },
        ],
      }),
    )
    const sizes = screen.getAllByTestId('skill-panel-item-size')
    expect(sizes.map(el => el.textContent)).toEqual(['512 B', '1.5 KB'])
    // Header totals both skills' sizes (512 + 1536 = 2048 B = 2.0 KB) and
    // counts the list.
    expect(screen.getByTestId('skill-panel-list-stats').textContent).toBe(
      '2 skills · 2.0 KB',
    )
  })

  it('omits a row\'s size when the summary carries none (defensive)', () => {
    render(
      createElement(SkillPanel, {
        target: null,
        loadedSkills: [{ name: 'plugin:build', path: '/s/build/SKILL.md' }],
      }),
    )
    expect(screen.queryByTestId('skill-panel-item-size')).toBeNull()
    // Falls back to a 0 B total rather than throwing on the missing size.
    expect(screen.getByTestId('skill-panel-list-stats').textContent).toBe(
      '1 skills · 0 B',
    )
  })

  it('caps the loaded-skills list at 40% of the viewport height', () => {
    render(
      createElement(SkillPanel, {
        target: null,
        loadedSkills: [{ name: 'plugin:build', path: '/s/build/SKILL.md' }],
      }),
    )
    const list = screen.getByTestId('skill-panel-loaded-list').querySelector('ul')
    expect(list?.className).toContain('max-h-[40vh]')
    expect(list?.className).toContain('overflow-y-auto')
  })
})

describe('SkillPanel — event log rows', () => {
  it('renders a status badge per invocation (loaded / failed)', () => {
    render(
      createElement(SkillPanel, {
        target: null,
        loadedSkills: [
          { name: 'pdf', path: '/s/pdf/SKILL.md', id: 'e2', status: 'failed', invokedAt: 2, error: 'boom' },
          { name: 'pdf', path: '/s/pdf/SKILL.md', id: 'e1', status: 'loaded', invokedAt: 1, size: 100 },
        ],
      }),
    )
    const badges = screen.getAllByTestId('skill-panel-item-status')
    expect(badges.map(b => b.getAttribute('data-status'))).toEqual([
      'failed',
      'loaded',
    ])
    expect(badges.map(b => b.textContent)).toEqual([
      'Failed',
      'Loaded',
    ])
    // Only the loaded row carries a size badge; the failed one does not.
    expect(screen.getAllByTestId('skill-panel-item-size')).toHaveLength(1)
    // Every row that has a time shows one.
    expect(screen.getAllByTestId('skill-panel-item-time')).toHaveLength(2)
  })

  it('header counts DISTINCT skills and sums loaded bodies', () => {
    render(
      createElement(SkillPanel, {
        target: null,
        loadedSkills: [
          // Two invocations of pdf (both loaded — no dedup) + one docx.
          { name: 'pdf', path: '/s/pdf/SKILL.md', id: 'e2', status: 'loaded', size: 1024 },
          { name: 'pdf', path: '/s/pdf/SKILL.md', id: 'e3', status: 'loaded', size: 1024 },
          { name: 'docx', path: '/s/docx/SKILL.md', id: 'e1', status: 'loaded', size: 1024 },
        ],
      }),
    )
    // 2 distinct skills; size sums all three LOADED rows (3072 = 3.0 KB).
    expect(screen.getByTestId('skill-panel-list-stats').textContent).toBe(
      '2 skills · 3.0 KB',
    )
  })

  it('shows a failed invocation\'s error in the detail view (no body fetch)', async () => {
    const readFileText = vi.fn(async () => 'never')
    render(
      createElement(SkillPanel, {
        target: {
          name: 'pdf',
          detailId: null,
          inlineBody: null,
          status: 'failed',
          error: 'shell boom',
        },
        readFileText,
      }),
    )
    await waitFor(() =>
      expect(screen.getByTestId('skill-panel-failed')).toBeTruthy(),
    )
    expect(screen.getByText('This skill failed to load.')).toBeTruthy()
    expect(screen.getByText('shell boom')).toBeTruthy()
    // A failed event has no body — the panel must not try to read one.
    expect(readFileText).not.toHaveBeenCalled()
  })

  it('highlights the specific invocation by event id (rows can share a name)', () => {
    render(
      createElement(SkillPanel, {
        target: {
          name: 'pdf',
          detailId: 'skill:u1',
          inlineBody: null,
          eventId: 'e1',
          status: 'loaded',
        },
        loadedSkills: [
          { name: 'pdf', path: '/s/pdf/SKILL.md', id: 'e2', status: 'loaded' },
          { name: 'pdf', path: '/s/pdf/SKILL.md', id: 'e1', status: 'loaded' },
        ],
        loadToolCallDetail: async () => null,
      }),
    )
    const items = screen.getAllByTestId('skill-panel-loaded-item')
    // Only the row whose id matches the target.eventId is active.
    expect(items[0]!.className).not.toContain('bg-muted/60')
    expect(items[1]!.className).toContain('bg-muted/60')
  })

  it('highlights exactly one row for a card-opened target with no event id', () => {
    // A transcript skill card opens the panel without an event id; every list
    // row has one. The sidecar id picks the invocation; with no match, the
    // newest row of that name (the list is newest-first) is the one.
    const { unmount } = render(
      createElement(SkillPanel, {
        target: { name: 'pdf', detailId: 'skill:u1', inlineBody: null },
        loadedSkills: [
          { name: 'pdf', path: '/s/pdf/SKILL.md', id: 'e2', detailId: 'skill:u2' },
          { name: 'pdf', path: '/s/pdf/SKILL.md', id: 'e1', detailId: 'skill:u1' },
        ],
        loadToolCallDetail: async () => null,
      }),
    )
    let items = screen.getAllByTestId('skill-panel-loaded-item')
    expect(items[0]!.className).not.toContain('bg-muted/60')
    expect(items[1]!.className).toContain('bg-muted/60')
    unmount()

    render(
      createElement(SkillPanel, {
        target: { name: 'pdf', detailId: 'skill:gone', inlineBody: null },
        loadedSkills: [
          { name: 'pdf', path: '/s/pdf/SKILL.md', id: 'e2' },
          { name: 'pdf', path: '/s/pdf/SKILL.md', id: 'e1' },
        ],
        loadToolCallDetail: async () => null,
      }),
    )
    items = screen.getAllByTestId('skill-panel-loaded-item')
    expect(items[0]!.className).toContain('bg-muted/60')
    expect(items[1]!.className).not.toContain('bg-muted/60')
  })
})

describe('SkillToolUI card', () => {
  // makeAssistantToolUI needs the assistant-ui runtime to mount; exercise the
  // render function directly the way the runtime would.
  const renderCard = (
    props: { args: unknown; result: unknown; isError?: boolean },
    openSkill?: (t: unknown) => void,
    status: { type: string; reason?: string; error?: unknown } = {
      type: 'complete',
    },
  ) => {
    const Render = (SkillToolUI as unknown as { unstable_tool: { render: (p: unknown) => unknown } })
      .unstable_tool.render as (p: unknown) => React.ReactElement
    return render(
      createElement(
        RightPanelContentContext.Provider,
        { value: { openSkill: openSkill as never } },
        createElement(Render as never, {
          ...props,
          toolCallId: 'c1',
          toolName: 'Skill',
          status,
          addResult: () => {},
        }),
      ),
    )
  }

  it('names the skill and opens the body in the panel via "View skill"', () => {
    const openSkill = vi.fn()
    renderCard(
      {
        args: { skill: 'a:b' },
        result: { skillBodyRef: { name: 'a:b', args: 'zz', detailId: 'skill:u', inlineBody: null } },
      },
      openSkill,
    )
    expect(screen.getByText('Skill: a:b')).toBeTruthy()
    fireEvent.click(screen.getByTestId('skill-view-in-panel'))
    expect(openSkill).toHaveBeenCalledWith({
      name: 'a:b',
      args: 'zz',
      detailId: 'skill:u',
      inlineBody: null,
    })
  })

  it('offers no ">>" jump when the body ref has not arrived (live, pre-reconcile)', () => {
    renderCard({ args: { skill: 'a:b' }, result: undefined }, vi.fn())
    expect(screen.getByText('Skill: a:b')).toBeTruthy()
    expect(screen.queryByTestId('skill-view-in-panel')).toBeNull()
  })

  it('shows a loading label while the injecting turn is still running', () => {
    renderCard(
      {
        args: { skill: 'a:b' },
        result: { skillBodyRef: { name: 'a:b', detailId: 'skill:u', inlineBody: null } },
      },
      vi.fn(),
      { type: 'running' },
    )
    // The running trigger renders the label twice (visible + shimmer overlay).
    expect(screen.getAllByText('Loading Skill: a:b').length).toBeGreaterThan(0)
    expect(screen.queryByText('Skill: a:b')).toBeNull()
  })

  it('keeps the one-liner but becomes expandable to reveal args + error when the skill fails', () => {
    renderCard(
      { args: { skill: 'a:b', args: 'go' }, result: undefined },
      vi.fn(),
      { type: 'incomplete', reason: 'error', error: 'boom' },
    )
    // Label stays the friendly one-liner (not a raw "Skill" + args dump).
    expect(screen.getByText('Skill: a:b')).toBeTruthy()
    // Collapsed by default: the args/error body is not mounted yet.
    expect(screen.queryByText(/boom/)).toBeNull()
    // Expanding the row reveals the original function format: args + error.
    fireEvent.click(screen.getByTestId('tool-row-Skill'))
    expect(screen.getByText(/Args:/)).toBeTruthy()
    expect(screen.getByText(/boom/)).toBeTruthy()
  })

  it('expands a SOFT-failed skill (status complete + isError), matching the Plan surface', () => {
    renderCard(
      { args: { skill: 'a:b', args: 'go' }, result: 'ok-ish', isError: true },
      vi.fn(),
      { type: 'complete' },
    )
    expect(screen.getByText('Skill: a:b')).toBeTruthy()
    // A soft failure is no longer a silent one-liner — it can expand to its args.
    fireEvent.click(screen.getByTestId('tool-row-Skill'))
    expect(screen.getByText(/Args:/)).toBeTruthy()
  })

  it('a cancelled skill (user stop) is expandable to its call args, like every tool node', () => {
    renderCard(
      { args: { skill: 'a:b' }, result: undefined },
      vi.fn(),
      { type: 'incomplete', reason: 'cancelled' },
    )
    expect(screen.getByText('Skill: a:b')).toBeTruthy()
    // Unified design: every tool node carries the ">" collapse chevron beside
    // its ">>" jump; the expand reveals the call args. (Previously cancelled /
    // settled-OK skills were body-less one-liners — now only the SKILL.md BODY
    // stays out of line, reached via ">>".)
    expect(screen.queryByTestId('tool-row-Skill')?.querySelector(
      '[data-slot="tool-fallback-trigger-chevron"]',
    )).toBeTruthy()
    fireEvent.click(screen.getByTestId('tool-row-Skill'))
    expect(screen.getByText(/Args:/)).toBeTruthy()
  })
})

// The bundled-skill body safety net (`loadBundledSkillBody` — the
// worker.getSkillBody round-trip): the body source of last resort when a
// bundled skill's invocation left no usable `skill:<uuid>` sidecar.
describe('SkillPanel bundled-skill body fallback', () => {
  it('resolves a target with NO sidecar via the worker registry (static body)', async () => {
    const loadBundledSkillBody = vi.fn(async (_name: string) => ({
      kind: 'static' as const,
      body: '# Commit helper\n\nStage and commit.',
    }))
    render(
      createElement(SkillPanel, {
        // A legacy pre-sidecar invocation: bundled row, detailId null.
        target: { name: 'commit-helper', detailId: null, inlineBody: null },
        loadBundledSkillBody,
      }),
    )
    await waitFor(() => expect(screen.getByText('Commit helper')).toBeTruthy())
    expect(loadBundledSkillBody).toHaveBeenCalledWith('commit-helper')
    expect(screen.getByText('Stage and commit.')).toBeTruthy()
    // A resolved body is not the failure state.
    expect(screen.queryByText('Failed to load skill instructions.')).toBeNull()
  })

  it('falls back to the registry when the sidecar load fails', async () => {
    const loadToolCallDetail = vi.fn(async () => null) // sidecar missing
    const loadBundledSkillBody = vi.fn(async () => ({
      kind: 'static' as const,
      body: '# Commit helper\n\nStage and commit.',
    }))
    render(
      createElement(SkillPanel, {
        target: { name: 'commit-helper', detailId: 'skill:gone', inlineBody: null },
        loadToolCallDetail,
        loadBundledSkillBody,
      }),
    )
    await waitFor(() => expect(screen.getByText('Commit helper')).toBeTruthy())
    expect(loadToolCallDetail).toHaveBeenCalledWith('skill:gone')
    expect(loadBundledSkillBody).toHaveBeenCalledWith('commit-helper')
  })

  it('never reads a synthetic bundled: path from disk', async () => {
    const readFileText = vi.fn(async () => 'never')
    const loadBundledSkillBody = vi.fn(async () => ({
      kind: 'static' as const,
      body: 'from registry',
    }))
    render(
      createElement(SkillPanel, {
        target: {
          name: 'commit-helper',
          path: 'bundled:commit-helper',
          detailId: null,
          inlineBody: null,
        },
        readFileText,
        loadBundledSkillBody,
      }),
    )
    await waitFor(() => expect(screen.getByText('from registry')).toBeTruthy())
    expect(readFileText).not.toHaveBeenCalled()
  })

  it('shows the "generated at invocation time" notice for a never-invoked dynamic skill', async () => {
    render(
      createElement(SkillPanel, {
        target: { name: 'debug', detailId: null, inlineBody: null },
        loadBundledSkillBody: async () => ({ kind: 'dynamic' as const }),
      }),
    )
    await waitFor(() =>
      expect(screen.getByTestId('skill-panel-dynamic-note')).toBeTruthy(),
    )
    // A notice, not the error state.
    expect(screen.queryByText('Failed to load skill instructions.')).toBeNull()
  })

  it('renders a dynamic skill\'s last-invoked body with the snapshot note', async () => {
    render(
      createElement(SkillPanel, {
        target: { name: 'debug', detailId: null, inlineBody: null },
        loadBundledSkillBody: async () => ({
          kind: 'invoked' as const,
          body: '<command-message>debug</command-message>\n\n# Log tail\n\nlines',
          invokedAt: 123,
        }),
      }),
    )
    await waitFor(() => expect(screen.getByText('Log tail')).toBeTruthy())
    expect(screen.getByTestId('skill-panel-invoked-note')).toBeTruthy()
    // The loading-metadata tag header is stripped like the sidecar path's.
    expect(screen.queryByText(/command-message/)).toBeNull()
  })

  it('keeps the error state when the registry does not know the name', async () => {
    render(
      createElement(SkillPanel, {
        target: { name: 'vanished', detailId: 'skill:gone', inlineBody: null },
        loadToolCallDetail: async () => null,
        loadBundledSkillBody: async () => ({ kind: 'not_found' as const }),
      }),
    )
    await waitFor(() =>
      expect(screen.getByText('Failed to load skill instructions.')).toBeTruthy(),
    )
  })

  it('keeps the pre-existing error state when the fallback is not wired', async () => {
    render(
      createElement(SkillPanel, {
        target: { name: 'x', detailId: 'skill:gone', inlineBody: null },
        loadToolCallDetail: async () => null,
      }),
    )
    await waitFor(() =>
      expect(screen.getByText('Failed to load skill instructions.')).toBeTruthy(),
    )
  })
})
