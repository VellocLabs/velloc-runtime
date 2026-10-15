// @vitest-environment happy-dom
import { createElement } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'

import { ImportSessionsTab } from '../browser/webview/sessionImport/ImportSessionsTab'
import type { NexusSettingsBridge } from '../browser/webview/nexusSettingsBridge'
import type { ImportSessionListRow } from '../browser/bridge/protocol/sessionImport'

/**
 * Paging must not collapse the dialog. `useSessionImport` flips `list.status`
 * to "loading" on a page change; the tab used to answer that by replacing the
 * whole list + pager with a tiny centered "Loading…" line, so the dialog shrank
 * to a few pixels and snapped back to full height on every page click. The fix
 * keeps the previous page on screen (dimmed, aria-busy) until the next arrives.
 */

afterEach(() => {
  cleanup()
})

function row(id: string): ImportSessionListRow {
  return {
    source: 'claude-code',
    path: `C:/.claude/projects/x/${id}.jsonl`,
    sessionId: `sess-${id}`,
    title: `Session ${id}`,
    projectPath: 'C:/proj',
    createdAt: '2026-08-01T00:00:00.000Z',
    mtimeMs: 1_700_000_000_000,
    size: 1234,
    importable: true,
    alreadyImported: false,
  }
}

describe('ImportSessionsTab paging', () => {
  it('keeps the previous page visible while the next page loads', async () => {
    // Page 1's request hangs so the "loading" state is observable — that is
    // exactly the window in which the old code collapsed the dialog.
    let resolvePage1: (value: unknown) => void = () => {}
    const page1 = new Promise((resolve) => {
      resolvePage1 = resolve
    })
    const request = vi.fn((_route: unknown, params: { page: number }) => {
      if (params.page === 0) {
        return Promise.resolve({
          source: 'claude-code',
          rootPath: 'C:/.claude/projects',
          total: 60, // > pageSize (50) so a second page + "next" button exist
          page: 0,
          pageSize: 50,
          rows: [row('a')],
        })
      }
      return page1
    })
    const bridge = { request } as unknown as NexusSettingsBridge

    render(
      createElement(ImportSessionsTab, {
        bridge,
        source: 'claude-code',
        open: true,
        onOpenSession: vi.fn(),
      }),
    )

    // Page 0 loaded: rows visible, no full-loading placeholder.
    await screen.findByTestId('import-session-list')
    expect(screen.getByText('Session a')).toBeTruthy()
    expect(screen.queryByTestId('import-loading')).toBeNull()

    // Go to page 2 (index 1) — its request is still pending.
    fireEvent.click(screen.getByTestId('import-page-next'))
    await waitFor(() => {
      expect(request).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ page: 1 }),
      )
    })

    // The regression: this is where the list used to be swapped for the tiny
    // "Loading…" line. The previous page must stay mounted (marked busy).
    expect(screen.queryByTestId('import-loading')).toBeNull()
    const list = screen.getByTestId('import-session-list')
    expect(list.getAttribute('aria-busy')).toBe('true')
    expect(screen.getByText('Session a')).toBeTruthy()

    // Once page 1 resolves, its rows replace the previous page and busy clears.
    resolvePage1({
      source: 'claude-code',
      rootPath: 'C:/.claude/projects',
      total: 60,
      page: 1,
      pageSize: 50,
      rows: [row('b')],
    })
    await screen.findByText('Session b')
    expect(
      screen.getByTestId('import-session-list').getAttribute('aria-busy'),
    ).toBe('false')
  })
})
