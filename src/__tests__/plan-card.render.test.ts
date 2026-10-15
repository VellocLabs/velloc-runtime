import { describe, expect, it } from 'vitest'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'

import { PlanCard } from '../components/assistant-ui/plan-card'

/**
 * `PlanCard`, the shell behind `TodoSection` and `ToolPlanStream`: root / trigger / content carry `${slotPrefix}-*`
 * data-slots; body rows live inside `${slotPrefix}-content`, never beside the card; the completion check and
 * progress-bar slot render only when asked.
 */

const CHILD_MARKER = 'PLAN-CARD-ROW-MARKER'
const BEFORE_MARKER = 'PLAN-CARD-BEFORE-BODY-MARKER'
const ICON_MARKER = 'PLAN-CARD-LEADING-ICON'
const ADORNMENT_MARKER = 'PLAN-CARD-ADORNMENT'

const render = (props: Record<string, unknown>): string =>
  renderToStaticMarkup(
    createElement(
      PlanCard,
      {
        header: createElement('span', null, 'HEADER'),
        children: createElement('li', null, CHILD_MARKER),
        ...props,
      } as never,
    ),
  )

describe('PlanCard shell', () => {
  it('reproduces the caller data-slot prefix on root, trigger, and content', () => {
    for (const slotPrefix of ['todo-section', 'tool-plan-stream'] as const) {
      const html = render({ slotPrefix, persistKey: 'k', defaultOpen: true })
      expect(html).toContain(`data-slot="${slotPrefix}-root"`)
      expect(html).toContain(`data-slot="${slotPrefix}-trigger"`)
      expect(html).toContain(`data-slot="${slotPrefix}-content"`)
    }
  })

  it('boxes the rows inside the content element (never as a bare sibling)', () => {
    const html = render({
      slotPrefix: 'todo-section',
      persistKey: 'k',
      defaultOpen: true,
    })
    const contentStart = html.indexOf('data-slot="todo-section-content"')
    const rowAt = html.indexOf(CHILD_MARKER)
    expect(contentStart).toBeGreaterThanOrEqual(0)
    expect(rowAt).toBeGreaterThan(contentStart)
  })

  it('mounts collapsed when `defaultOpen` is omitted (the production default)', () => {
    // Neither production caller passes `defaultOpen` any more — a card is
    // closed on mount, running or settled, until the user toggles it.
    const html = render({
      slotPrefix: 'tool-plan-stream',
      persistKey: 'k-default',
    })
    expect(html).toContain('data-slot="tool-plan-stream-trigger"')
    expect(html).toContain('data-state="closed"')
    expect(html).not.toContain('data-state="open"')
    expect(html).not.toContain(CHILD_MARKER)
  })

  it('does not mount the body while collapsed', () => {
    const html = render({
      slotPrefix: 'tool-plan-stream',
      persistKey: 'k',
      defaultOpen: false,
    })
    // Header is always present; the collapsed body (and its rows) are not.
    expect(html).toContain('data-slot="tool-plan-stream-root"')
    expect(html).not.toContain(CHILD_MARKER)
  })

  it('renders the leading icon and header adornment when provided', () => {
    const html = render({
      slotPrefix: 'todo-section',
      persistKey: 'k',
      defaultOpen: true,
      leadingIcon: createElement('span', null, ICON_MARKER),
      headerAdornment: createElement('span', null, ADORNMENT_MARKER),
    })
    expect(html).toContain(ICON_MARKER)
    expect(html).toContain(ADORNMENT_MARKER)
  })

  it('shows the completion check only when asked', () => {
    const withCheck = render({
      slotPrefix: 'todo-section',
      persistKey: 'k',
      defaultOpen: true,
      showCompletionCheck: true,
    })
    const withoutCheck = render({
      slotPrefix: 'todo-section',
      persistKey: 'k',
      defaultOpen: true,
      showCompletionCheck: false,
    })
    expect(withCheck).toContain('text-success')
    expect(withoutCheck).not.toContain('text-success')
  })

  it('renders the beforeBody slot above the rows inside the panel', () => {
    const html = render({
      slotPrefix: 'tool-plan-stream',
      persistKey: 'k',
      defaultOpen: true,
      beforeBody: createElement('div', null, BEFORE_MARKER),
    })
    const beforeAt = html.indexOf(BEFORE_MARKER)
    const rowAt = html.indexOf(CHILD_MARKER)
    expect(beforeAt).toBeGreaterThan(0)
    expect(rowAt).toBeGreaterThan(beforeAt)
  })

  it('applies start alignment for the two-line todo header', () => {
    const start = render({
      slotPrefix: 'todo-section',
      persistKey: 'k',
      defaultOpen: true,
      align: 'start',
    })
    const center = render({
      slotPrefix: 'tool-plan-stream',
      persistKey: 'k',
      defaultOpen: true,
      align: 'center',
    })
    expect(start).toContain('items-start')
    expect(center).toContain('items-center')
  })
})
