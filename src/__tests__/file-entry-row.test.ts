// @vitest-environment happy-dom
import { createElement } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'

import { FileEntryRow } from '../components/assistant-ui/file-entry-row'

// The canonical "{path} >" row contract: META-ONLY by default (nothing loaded),
// "`>`" lazily loads + shows the capped inline view, "{path}" jumps to the
// right panel WITHOUT loading inline content. These are the behaviours the
// user's spec turns on, so they get deterministic interaction coverage.

afterEach(() => cleanup())

describe('FileEntryRow — strict-lazy {path} > row', () => {
  it('renders meta only and loads NOTHING until acted on', () => {
    const load = vi.fn(async () => ({ kind: 'diff' as const, hunks: [] }))
    render(
      createElement(FileEntryRow, {
        path: '/repo/src/foo.ts',
        kind: 'diff',
        load,
      }),
    )
    // path + toggle present...
    expect(screen.getByTitle('/repo/src/foo.ts')).toBeTruthy()
    expect(screen.getByTestId('file-entry-toggle')).toBeTruthy()
    // ...but the loader was never called and no inline body rendered.
    expect(load).not.toHaveBeenCalled()
    expect(document.querySelector('[data-slot="file-content-view"]')).toBeNull()
    expect(document.querySelector('.aui-edit-diff-body')).toBeNull()
  })

  it('clicking ">" lazily loads once and shows the inline diff', async () => {
    const load = vi.fn(async () => ({
      kind: 'diff' as const,
      hunks: [
        { oldStart: 1, oldLines: 1, newStart: 1, newLines: 2, lines: [' a', '+b'] },
      ],
    }))
    render(
      createElement(FileEntryRow, { path: '/x.ts', kind: 'diff', load }),
    )
    fireEvent.click(screen.getByTestId('file-entry-toggle'))
    await waitFor(() =>
      expect(document.querySelector('.aui-edit-diff-body')).not.toBeNull(),
    )
    expect(load).toHaveBeenCalledTimes(1)
    // collapse + re-expand must NOT reload (single-shot).
    fireEvent.click(screen.getByTestId('file-entry-toggle'))
    fireEvent.click(screen.getByTestId('file-entry-toggle'))
    expect(load).toHaveBeenCalledTimes(1)
  })

  it('clicking "{path}" opens the right panel WITHOUT loading inline content', () => {
    const load = vi.fn(async () => ({ kind: 'file' as const, content: 'x' }))
    const onOpenPath = vi.fn()
    render(
      createElement(FileEntryRow, {
        path: '/repo/a.ts',
        kind: 'file',
        load,
        onOpenPath,
      }),
    )
    fireEvent.click(screen.getByRole('button', { name: '/repo/a.ts' }))
    expect(onOpenPath).toHaveBeenCalledTimes(1)
    expect(load).not.toHaveBeenCalled() // path jump must not trigger the inline load
  })

  it('shows a file payload with line numbers when expanded', async () => {
    const load = vi.fn(async () => ({
      kind: 'file' as const,
      content: 'one\ntwo',
      numbered: false,
    }))
    render(createElement(FileEntryRow, { path: '/f.ts', kind: 'file', load }))
    fireEvent.click(screen.getByTestId('file-entry-toggle'))
    await waitFor(() =>
      expect(document.querySelector('[data-slot="file-content-view"]')).not.toBeNull(),
    )
    expect(screen.getByText('one')).toBeTruthy()
    expect(screen.getByText('two')).toBeTruthy()
  })

  it('renders a non-clickable path when no onOpenPath is provided', () => {
    render(
      createElement(FileEntryRow, {
        path: '/no-panel.ts',
        kind: 'diff',
        load: async () => null,
      }),
    )
    // FilePathHeader renders a plain span (no button) when onOpen is absent.
    expect(screen.queryByRole('button', { name: '/no-panel.ts' })).toBeNull()
    expect(screen.getByTitle('/no-panel.ts')).toBeTruthy()
  })
})
