// @vitest-environment happy-dom
import { createElement } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { ToolCallMessagePartStatus } from '@assistant-ui/react'

import { ToolCallDetailBody } from '../components/assistant-ui/tool-call-detail-body'
import { ToolCallDetailProvider } from '../components/assistant-ui/tool-call-detail-context'
import {
  RightPanelContentContext,
  type RightPanelContentContextValue,
} from '../components/assistant-ui/right-panel-content-context'
import type { BrowserToolCallDetailRecord } from '../utils/toolCallDetails'
import { ModToolUseRewriteContext } from '../components/assistant-ui/mod-ui-context'

// The streaming Plan surface (ToolCallDetailBody) must render the SAME
// dedicated Read/Edit views as the legacy card — not the generic JSON tree —
// so a Read on the Plan surface gets a clickable path → Files panel + content.

afterEach(() => cleanup())

const COMPLETE = { type: 'complete' } as ToolCallMessagePartStatus

function renderBody(
  detail: BrowserToolCallDetailRecord,
  ctx: RightPanelContentContextValue = {},
) {
  const loadToolCallDetail = vi.fn(async () => detail)
  const body = createElement(ToolCallDetailBody, {
    toolCallId: detail.toolCallId,
    toolName: detail.toolName,
    args: undefined,
    result: undefined,
    status: COMPLETE,
    open: true,
  })
  const provider = createElement(ToolCallDetailProvider, {
    loadToolCallDetail,
    children: body,
  })
  const utils = render(
    createElement(RightPanelContentContext.Provider, {
      value: ctx,
      children: provider,
    }),
  )
  return { ...utils, loadToolCallDetail }
}

describe('ToolCallDetailBody — Plan surface file views', () => {
  it('renders ReadToolView (clickable path + content) for Read, not the JSON tree', async () => {
    const openFile = vi.fn()
    renderBody(
      {
        toolCallId: 't-read',
        toolName: 'Read',
        args: { file_path: '/repo/a.ts' },
        result: '1\thello\n2\tworld',
      },
      { openFile },
    )
    // Content + line-numbered view appear once the lazy detail loads.
    await waitFor(() => expect(screen.getByText('hello')).toBeTruthy())
    expect(screen.getByText('world')).toBeTruthy()
    expect(document.querySelector('[data-slot="file-content-view"]')).not.toBeNull()
    // The path is clickable → Files panel (the "{path}" jump).
    fireEvent.click(screen.getByRole('button', { name: '/repo/a.ts' }))
    expect(openFile).toHaveBeenCalledWith({ path: '/repo/a.ts' })
    // Read folds args+result into one view — no generic "Args:"/"Result:" labels.
    expect(screen.queryByText('Args:')).toBeNull()
    expect(screen.queryByText('Result:')).toBeNull()
  })

  it('still renders the diff view for Edit on the Plan surface', async () => {
    renderBody({
      toolCallId: 't-edit',
      toolName: 'Edit',
      args: { file_path: '/repo/b.ts', old_string: 'a\nb\nc\n', new_string: 'a\nB\nc\n' },
    })
    await waitFor(() =>
      expect(document.querySelector('.aui-edit-diff-body')).not.toBeNull(),
    )
  })
})

describe('ToolCallDetailBody — a mod ToolUse rewrite (F-25)', () => {
  it("draws the rewritten result over the sidecar's, which still loads", async () => {
    const loadToolCallDetail = vi.fn(async () => ({
      toolCallId: 't-read',
      toolName: 'Read',
      args: { file_path: '/repo/a.ts' },
      result: '1\tsecret',
    }))
    const body = createElement(ToolCallDetailBody, {
      toolCallId: 't-read',
      toolName: 'Read',
      args: undefined,
      result: undefined,
      status: COMPLETE,
      open: true,
    })
    render(
      createElement(ModToolUseRewriteContext.Provider, {
        value: { output: '1\tredacted' },
        children: createElement(ToolCallDetailProvider, { loadToolCallDetail, children: body }),
      }),
    )
    await waitFor(() => expect(screen.getByText('redacted')).toBeTruthy())
    expect(loadToolCallDetail).toHaveBeenCalled()
    expect(screen.queryByText('secret')).toBeNull()
  })
})
