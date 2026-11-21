// @vitest-environment happy-dom
// A studio app surface redraws a cell a data patch changes deep inside a bound list (F-1).
import { afterEach, expect, it } from 'vitest'
import { createElement } from 'react'
import { cleanup, render, waitFor } from '@testing-library/react'
import { StudioAppSurface } from '../browser/webview/a2ui/studio/StudioAppSurface'
import type { AppSurfaceState } from '../browser/runtimeProtocol/modApps'

afterEach(() => cleanup())
const BODY = 'surface("s")\nroot = DataTable(columns=$/data/columns, rows=$/data/rows)'
const columns = [{ key: 'mark', label: 'On' }, { key: 'name', label: 'Name' }]
const rows = [{ name: 'Alpha', mark: '' }, { name: 'Beta', mark: '' }]
const board = (extra: Partial<AppSurfaceState>): AppSurfaceState => ({
  appId: 'a', catalog: 'studio', surface: { body: BODY, hash: 'h', surfaceIds: ['s'] },
  data: { columns, rows }, dataSeq: 1, refreshing: false, ...extra,
})

it('a patch inside a row redraws that cell', async () => {
  const view = render(createElement(StudioAppSurface, { board: board({}), surfaceId: 's', onEvent: () => undefined }))
  await waitFor(() => expect(view.container.textContent).toContain('Beta'))
  const next = { columns, rows: [{ name: 'Alpha', mark: '' }, { name: 'Beta', mark: 'YES' }] }
  view.rerender(createElement(StudioAppSurface, { board: board({ data: next, dataSeq: 2, dataPatches: { from: 1, patches: [{ path: '/rows/1/mark', value: 'YES' }] } }), surfaceId: 's', onEvent: () => undefined }))
  await waitFor(() => expect(view.container.textContent).toContain('YES'), { timeout: 3000 })
})
