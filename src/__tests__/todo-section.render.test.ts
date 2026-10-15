// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from 'vitest'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { cleanup, fireEvent, render as renderDom } from '@testing-library/react'

import {
  TodoItemRow,
  TodoSection,
  summarizeTodos,
} from '../components/assistant-ui/todo-section'
import { I18nProvider } from '../browser/webview/i18n'
import { StepGlyph } from '../components/tool-ui/plan/parts/StatusIcon'
import type { TaskListEntry } from '../runtime/RuntimeTypes'

/**
 * The TodoSection header verb ("Working" / "Done"); an `in_progress` step renders live, background or settled by
 * the owning turn's phase. `summarizeTodos` is tested directly; the verb via a static render.
 */

const todo = (
  status: 'pending' | 'in_progress' | 'completed',
  name = 'X',
): TaskListEntry => ({
  content: `do ${name}`,
  activeForm: `doing ${name}`,
  status,
})

afterEach(() => cleanup())

describe('summarizeTodos phase → status', () => {
  const todos = [todo('completed', 'A'), todo('in_progress', 'B')]

  it('maps an in_progress step to "running" while live', () => {
    expect(summarizeTodos(todos, 'live').status).toBe('running')
  })

  it('maps an in_progress step to "background" while a backgrounded tool runs', () => {
    expect(summarizeTodos(todos, 'background').status).toBe('background')
  })

  it('maps an in_progress step to "paused" once settled', () => {
    expect(summarizeTodos(todos, 'settled').status).toBe('paused')
  })

  it('reports "complete" when all steps are done, for every phase', () => {
    const done = [todo('completed', 'A'), todo('completed', 'B')]
    for (const phase of ['live', 'background', 'settled'] as const) {
      expect(summarizeTodos(done, phase).status).toBe('complete')
    }
  })

  it('defaults the phase to live', () => {
    expect(summarizeTodos([todo('in_progress', 'A')]).status).toBe('running')
  })
})

describe('TodoSection header verb', () => {
  const todos = [todo('completed', 'A'), todo('in_progress', 'B')]

  const render = (
    props: { isLive?: boolean; isBackground?: boolean },
    key: string,
  ): string =>
    renderToStaticMarkup(
      createElement(
        I18nProvider,
        null,
        createElement(TodoSection, { persistKey: key, todos, ...props }),
      ),
    )

  it('reads "Working" while the turn is live', () => {
    const html = render({ isLive: true }, 'k-live')
    expect(html).toContain('Working')
  })

  it('keeps the compact header at "Working" when a backgrounded tool still executes', () => {
    const html = render({ isLive: false, isBackground: true }, 'k-bg')
    expect(html).toContain('Working')
    expect(html).not.toContain('Running')
    expect(html).not.toContain('Paused')
  })

  it('keeps the compact header at "Working" when settled and not running in the background', () => {
    const html = render({ isLive: false, isBackground: false }, 'k-paused')
    expect(html).toContain('Working')
    expect(html).not.toContain('Paused')
    expect(html).not.toContain('Running')
  })

  it('reads "Done" once every step is done', () => {
    const html = renderToStaticMarkup(
      createElement(
        I18nProvider,
        null,
        createElement(TodoSection, {
          persistKey: 'k-done',
          todos: [todo('completed', 'A'), todo('completed', 'B')],
          isLive: false,
        }),
      ),
    )
    expect(html).toContain('Done')
  })

  it('localizes the verb + summary chips in a non-English locale', () => {
    const html = renderToStaticMarkup(
      createElement(
        I18nProvider,
        { locale: 'zh-CN' },
        createElement(TodoSection, {
          persistKey: 'k-zh',
          todos,
          isLive: true,
          toolSummary: {
            callTotal: 18,
            fileOperations: { read: 4, edited: 2, deleted: 1 },
            currentOrLastTarget: 'Launcher.cpp',
          },
        }),
      ),
    )
    expect(html).toContain('工作中')
    expect(html).toContain('18 个工具')
    // The task-count chip ("Y tasks") is gone: the total no longer renders.
    expect(html).not.toContain('个任务')
    expect(html).toContain('已读取 4 个')
    expect(html).toContain('已编辑 2 个')
    expect(html).toContain('已删除 1 个')
    expect(html).not.toContain('Working')
    expect(html).not.toContain('tools')
    expect(html).not.toContain('Edited 2')
    expect(html).toContain('Launcher.cpp')
  })

  it('shows the compact header summary and current update text in the running top bar', () => {
    const updateText =
      'Reading the component tree and applying the focused todo top-bar update'
    // The section mounts collapsed; open it the way a user does — one click
    // on the trigger — so the body (and the child marker) is under test.
    const { container } = renderDom(
      createElement(
        TodoSection,
        {
          persistKey: 'k-live-update',
          todos,
          isLive: true,
          toolSummary: {
            callTotal: 18,
            fileOperations: { read: 4, edited: 2, deleted: 1 },
            currentOrLastTarget: 'Launcher.cpp',
          },
          currentUpdateText: updateText,
        },
        createElement('div', null, 'TODO-CONTENT-MARKER'),
      ),
    )
    expect(container.innerHTML).not.toContain('TODO-CONTENT-MARKER')
    const trigger = container.querySelector('[data-slot="todo-section-trigger"]')
    expect(trigger).not.toBeNull()
    fireEvent.click(trigger!)
    const html = container.innerHTML

    expect(html).toContain('Working')
    expect(html).toContain('18 tools')
    // No task-count chip and no "x/Y" fraction — totals are hidden because
    // models skip/reorder steps, so a running count misrepresents the plan.
    expect(html).not.toContain('tasks')
    expect(html).not.toContain('1/2')
    expect(html).toContain('Read 4')
    expect(html).toContain('Edited 2')
    expect(html).toContain('Deleted 1')
    expect(html).not.toContain('Edit 2')
    expect(html).not.toContain('Delete 1')
    expect(html).toContain('Launcher.cpp')
    expect(html).not.toContain('ran 18 tools')
    expect(html).toContain(updateText)
    expect(html).toContain('todo-section-current-update')
    expect(html).toContain('line-clamp-4')
    expect(html).not.toContain('font-semibold')
    expect(html).toContain('shimmer')
    expect(html).toContain('TODO-CONTENT-MARKER')
  })

  it('mounts COLLAPSED while live — the steps stay behind the chevron', () => {
    // The todo section used to mount open (`defaultOpen`), so a live plan
    // unrolled every step into the conversation. It now mounts closed like
    // every other multi-tool card: the header (verb + narration) is visible,
    // the children are not rendered until the user opens it.
    const html = renderToStaticMarkup(
      createElement(
        I18nProvider,
        null,
        createElement(
          TodoSection,
          { persistKey: 'k-live-collapsed', todos, isLive: true },
          createElement('div', null, 'LIVE-CHILD-MARKER'),
        ),
      ),
    )
    expect(html).toContain('Working')
    expect(html).toContain('data-slot="todo-section-trigger"')
    expect(html).toContain('data-state="closed"')
    expect(html).not.toContain('data-state="open"')
    expect(html).not.toContain('LIVE-CHILD-MARKER')
  })

  it('removes the current update text when paused or completed', () => {
    const paused = renderToStaticMarkup(
      createElement(
        I18nProvider,
        null,
        createElement(TodoSection, {
          persistKey: 'k-paused-update',
          todos,
          isLive: false,
          toolSummary: {
            callTotal: 1,
            fileOperations: { read: 0, edited: 0, deleted: 0 },
          },
          currentUpdateText: 'Should be hidden while paused',
        }),
      ),
    )
    const completed = renderToStaticMarkup(
      createElement(
        I18nProvider,
        null,
        createElement(TodoSection, {
          persistKey: 'k-complete-update',
          todos: [todo('completed', 'A'), todo('completed', 'B')],
          isLive: false,
          currentUpdateText: 'Should be hidden when completed',
        }),
      ),
    )

    expect(paused).toContain('Working')
    expect(paused).not.toContain('Paused')
    expect(paused).toContain('1 tool')
    expect(paused).not.toContain('Should be hidden while paused')
    expect(completed).toContain('Done')
    expect(completed).not.toContain('Should be hidden when completed')
  })
})

describe('TodoSection sticky current-update text', () => {
  // The header's second line must only CHANGE when new non-empty narration
  // arrives — never blank out mid-run. Regression: a completed-only TodoWrite
  // (no item `in_progress`) or an empty text part removed the line until the
  // next narration streamed in. The narration memory is module-level (keyed by
  // persistKey), so consecutive static renders with the same key model the
  // re-renders of one live section.

  it('keeps the last narration when a TodoWrite leaves no item in_progress mid-turn', () => {
    const key = 'k-sticky-idle'
    const first = renderToStaticMarkup(
      createElement(
        I18nProvider,
        null,
        createElement(TodoSection, {
          persistKey: key,
          todos: [todo('in_progress', 'A'), todo('pending', 'B')],
          isLive: true,
          currentUpdateText: 'Analyzing the config',
        }),
      ),
    )
    expect(first).toContain('Analyzing the config')

    // The model marks A completed WITHOUT starting B (completed-only
    // TodoWrite): no running item, no fresh narration — the line must hold.
    const second = renderToStaticMarkup(
      createElement(
        I18nProvider,
        null,
        createElement(TodoSection, {
          persistKey: key,
          todos: [todo('completed', 'A'), todo('pending', 'B')],
          isLive: true,
        }),
      ),
    )
    expect(second).toContain('Working')
    expect(second).toContain('Analyzing the config')
  })

  it('ignores an empty update and replaces the line only on new non-empty text', () => {
    const key = 'k-sticky-empty'
    const todos = [todo('completed', 'A'), todo('in_progress', 'B')]
    renderToStaticMarkup(
      createElement(
        I18nProvider,
        null,
        createElement(TodoSection, {
          persistKey: key,
          todos,
          isLive: true,
          currentUpdateText: 'Editing the parser',
        }),
      ),
    )
    const empty = renderToStaticMarkup(
      createElement(
        I18nProvider,
        null,
        createElement(TodoSection, {
          persistKey: key,
          todos,
          isLive: true,
          currentUpdateText: '',
        }),
      ),
    )
    expect(empty).toContain('Editing the parser')

    const replaced = renderToStaticMarkup(
      createElement(
        I18nProvider,
        null,
        createElement(TodoSection, {
          persistKey: key,
          todos,
          isLive: true,
          currentUpdateText: 'Wiring the new tests',
        }),
      ),
    )
    expect(replaced).toContain('Wiring the new tests')
    expect(replaced).not.toContain('Editing the parser')
  })

  it('still hides the line once settled or complete, even with a remembered narration', () => {
    const key = 'k-sticky-settled'
    const todos = [todo('completed', 'A'), todo('in_progress', 'B')]
    renderToStaticMarkup(
      createElement(
        I18nProvider,
        null,
        createElement(TodoSection, {
          persistKey: key,
          todos,
          isLive: true,
          currentUpdateText: 'Should not leak',
        }),
      ),
    )
    const paused = renderToStaticMarkup(
      createElement(
        I18nProvider,
        null,
        createElement(TodoSection, { persistKey: key, todos, isLive: false }),
      ),
    )
    expect(paused).not.toContain('Should not leak')

    const completed = renderToStaticMarkup(
      createElement(
        I18nProvider,
        null,
        createElement(TodoSection, {
          persistKey: key,
          todos: [todo('completed', 'A'), todo('completed', 'B')],
          isLive: false,
        }),
      ),
    )
    expect(completed).not.toContain('Should not leak')
  })
})

describe('TodoItemRow plain rendering (no pending-question special-casing)', () => {
  // The old buried-question era force-expanded a step holding a pending
  // AskUserQuestion and flashed it (`.nexus-todo-awaiting`). A question is
  // now hoisted OUT of the plan into a top-level `hoisted` segment for its
  // whole life (buildTodoSections `hoistedIndices`, decided from the tool
  // name), styled like any other card — so a step renders plain: collapsed
  // by default, no attention flash. This pins the removal so the flash can't
  // quietly return.
  it('renders a step collapsed by default and without any attention flash', () => {
    const html = renderToStaticMarkup(
      createElement(
        TodoItemRow,
        {
          persistKey: 'item-plain',
          item: todo('in_progress', 'B'),
          hasChildren: true,
        },
        createElement('div', null, 'COLLAPSED-CHILD-CONTENT'),
      ),
    )
    expect(html).not.toContain('nexus-todo-awaiting')
    // Collapsed by default — the child content is not force-expanded into view.
    expect(html).not.toContain('COLLAPSED-CHILD-CONTENT')
  })

  it('renders a step without a position-number prefix', () => {
    const html = renderToStaticMarkup(
      createElement(TodoItemRow, {
        persistKey: 'item-no-number',
        item: todo('completed', 'C'),
        hasChildren: false,
      }),
    )
    // Steps no longer carry a "1."/"2." ordinal prefix.
    expect(html).not.toContain('tabular-nums')
    expect(html).toContain('do C')
  })
})

describe('StepGlyph paused vs animated', () => {
  // A frozen spinner frame reads as a stuck animation. The non-animated
  // in_progress state must render a distinct pause glyph, not a static Loader2.
  it('renders a pause icon (not a spinner) when animated=false and in_progress', () => {
    const html = renderToStaticMarkup(
      createElement(StepGlyph, { status: 'in_progress', animated: false }),
    )
    // The Pause icon renders with muted styling; the spinner animation is absent.
    expect(html).toContain('bg-muted')
    expect(html).not.toContain('animate-spin')
  })

  it('renders a spinning loader when animated=true and in_progress', () => {
    const html = renderToStaticMarkup(
      createElement(StepGlyph, { status: 'in_progress', animated: true }),
    )
    expect(html).toContain('animate-spin')
    expect(html).not.toContain('bg-muted')
  })
})
