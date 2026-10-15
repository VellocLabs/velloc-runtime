// @vitest-environment happy-dom
// The lone card's result block as a `ToolResult` site (F-25): hooked,
// it asks with the result the card loaded and draws the hook's rewrite in
// the result's place — the generic block and Read's own view alike.
import { createElement, type ComponentType } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen, waitFor } from '@testing-library/react'

import { ToolFallback, __setToolFallbackOpenStateForTests } from '../components/assistant-ui/tool-fallback'
import { ToolCallDetailProvider } from '../components/assistant-ui/tool-call-detail-context'
import { EMPTY_MOD_UI, ModUiContext, type ModUiContextValue } from '../components/assistant-ui/mod-ui-context'
import type { BrowserToolCallDetailRecord } from '../utils/toolCallDetails'

afterEach(() => cleanup())

type CardProps = {
  toolCallId: string
  toolName: string
  args?: unknown
  result?: unknown
  isError?: boolean
  status?: { type: string; reason?: string }
}
const Card = ToolFallback as unknown as ComponentType<CardProps>

function renderOpenCard(props: CardProps, detail: BrowserToolCallDetailRecord, ui: Partial<ModUiContextValue>) {
  __setToolFallbackOpenStateForTests(props.toolCallId, true)
  const loadToolCallDetail = vi.fn(async () => detail)
  return render(
    createElement(ModUiContext.Provider, {
      value: { ...EMPTY_MOD_UI, ...ui },
      children: createElement(ToolCallDetailProvider, { loadToolCallDetail, children: createElement(Card, props) }),
    }),
  )
}

describe('ToolFallback — the result block as ToolResult (F-25)', () => {
  it('hooked, it asks with the loaded result and draws the rewrite in its place', async () => {
    const renderSite = vi.fn(async () => ({ kind: 'engine' as const, rewrite: { output: 'MASKED_RESULT' } }))
    renderOpenCard(
      { toolCallId: 'g-1', toolName: 'Grep', args: {}, result: '', status: { type: 'complete' } },
      { toolCallId: 'g-1', toolName: 'Grep', args: { pattern: 'x' }, result: 'SECRET_MATCH' },
      { render: renderSite, hooked: [{ plugin: 'p', component: 'ToolResult' }] },
    )
    await waitFor(() => expect(screen.getByText(/MASKED_RESULT/)).toBeTruthy())
    expect(screen.queryByText(/SECRET_MATCH/)).toBeNull()
    expect(renderSite).toHaveBeenCalledWith(
      expect.objectContaining({
        component: 'ToolResult',
        requestId: 'g-1',
        props: { tool_use_id: 'g-1', tool: 'Grep', output: 'SECRET_MATCH', isErrored: false },
      }),
    )
  })

  it("Read's own view is its result block", async () => {
    const renderSite = vi.fn(async () => ({ kind: 'engine' as const, rewrite: { output: '1\tREDACTED_LINE' } }))
    renderOpenCard(
      { toolCallId: 'r-1', toolName: 'Read', args: {}, result: '', status: { type: 'complete' } },
      { toolCallId: 'r-1', toolName: 'Read', args: { file_path: '/repo/a.ts' }, result: '1\tSECRET_LINE' },
      { render: renderSite, hooked: [{ plugin: 'p', component: 'ToolResult' }] },
    )
    await waitFor(() => expect(screen.getByText('REDACTED_LINE')).toBeTruthy())
    expect(screen.queryByText('SECRET_LINE')).toBeNull()
  })

  it('unhooked (or hooked on ToolUse alone), the block asks nothing for it', async () => {
    const renderSite = vi.fn(async () => ({ kind: 'engine' as const }))
    renderOpenCard(
      { toolCallId: 'g-2', toolName: 'Grep', args: {}, result: '', status: { type: 'complete' } },
      { toolCallId: 'g-2', toolName: 'Grep', args: { pattern: 'x' }, result: 'PLAIN_MATCH' },
      { render: renderSite, hooked: [{ plugin: 'p', component: 'ToolUse', requestId: 'other' }] },
    )
    await waitFor(() => expect(screen.getByText(/PLAIN_MATCH/)).toBeTruthy())
    expect(renderSite).not.toHaveBeenCalled()
  })
})
