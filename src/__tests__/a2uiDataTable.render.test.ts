// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from 'vitest'
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { A2uiSurface, type ReactCatalogComponent } from '@a2ui/react'
import { MessageProcessor } from '@a2ui/web_core/v1_0'
import { sameTableRow, TABLE_ROW_CHUNK, TABLE_ROW_LIMIT, TableRow, vellocCatalog } from '../browser/webview/a2ui/catalog/vellocCatalog'
import { createA2uiExpressCompiler } from '../toolkit/builtin/a2ui/express/a2uiExpressCompiler'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const COLUMNS = '[{key: "id", label: "Order"}, {key: "status", label: "Status", badge: {Paid: "success", Failed: "danger"}}]'

const ordersOf = (count: number, status: (index: number) => string = () => 'Paid') =>
  `$/orders = [${Array.from({ length: count }, (_, i) => `{id: "#${i}", status: "${status(i)}"}`).join(', ')}]`

let root: Root | null = null
afterEach(() => {
  act(() => root?.unmount())
  root = null
  document.body.innerHTML = ''
})

function setUp() {
  const processor = new MessageProcessor<ReactCatalogComponent>([vellocCatalog], () => {})
  const compiler = createA2uiExpressCompiler(vellocCatalog)
  const compile = (body: string) => expect(compiler.compile(body, compiler.stateFor(processor))).toMatchObject({ ok: true })
  const container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  const draw = async () => {
    await act(async () => root!.render(createElement(A2uiSurface, { surface: processor.getSurface('orders')! })))
  }
  const rows = () => [...container.querySelectorAll('[data-slot="a2ui-table"] tbody tr')]
  // Waits until no row is added for 50 ms; the chunks arrive one task apart.
  const settle = async () => {
    for (let count = -1, rounds = 0; rows().length !== count && rounds < 200; rounds++) {
      count = rows().length
      await act(async () => new Promise(resolve => setTimeout(resolve, 50)))
    }
  }
  return { compile, container, draw, settle, rows }
}

describe('the A2UI DataTable', () => {
  it('draws a long table a chunk at a time, first chunk first, and ends with every row in order', async () => {
    const { compile, container, draw, settle, rows } = setUp()
    compile(['surface("orders")', ordersOf(250), 'root = Column([orders])', `orders = DataTable(${COLUMNS}, $/orders)`].join('\n'))
    const seen: number[] = []
    const observer = new MutationObserver(() => {
      const count = rows().length
      if (count > 0 && seen[seen.length - 1] !== count) seen.push(count)
    })
    observer.observe(container, { childList: true, subtree: true })
    await draw()
    await settle()
    observer.disconnect()
    expect(seen[0], 'the first commit draws one chunk').toBe(TABLE_ROW_CHUNK)
    expect(seen[seen.length - 1], 'then every row').toBe(250)
    expect(seen.every((count, i) => i === 0 || count > seen[i - 1]!), 'rows are only added').toBe(true)
    expect(rows().map(row => row.querySelector('td')?.textContent), 'in the data\'s order').toEqual(
      Array.from({ length: 250 }, (_, i) => `#${i}`),
    )
  })

  it('a table over the row limit draws the limit and says how many rows there are', async () => {
    const { compile, container, draw, settle, rows } = setUp()
    const total = 1234
    compile(['surface("orders")', ordersOf(total), 'root = Column([orders])', `orders = DataTable(${COLUMNS}, $/orders)`].join('\n'))
    await draw()
    await settle()
    expect(rows()).toHaveLength(TABLE_ROW_LIMIT)
    expect(rows().at(-1)?.querySelector('td')?.textContent, 'the first rows, in order').toBe(`#${TABLE_ROW_LIMIT - 1}`)
    expect(container.querySelector('[data-slot="a2ui-table-truncated"]')?.textContent)
      .toBe(`Showing the first ${TABLE_ROW_LIMIT} of 1,234 rows.`)
  })

  it('a table within the limit has no count line', async () => {
    const { compile, container, draw, settle } = setUp()
    compile(['surface("orders")', ordersOf(TABLE_ROW_LIMIT), 'root = Column([orders])', `orders = DataTable(${COLUMNS}, $/orders)`].join('\n'))
    await draw()
    await settle()
    expect(container.querySelector('[data-slot="a2ui-table-truncated"]')).toBeNull()
  })

  it('a short table draws every row in its first commit', async () => {
    const { compile, draw, rows } = setUp()
    compile(['surface("orders")', ordersOf(3), 'root = Column([orders])', `orders = DataTable(${COLUMNS}, $/orders)`].join('\n'))
    await draw()
    expect(rows()).toHaveLength(3)
  })

  it('rows that arrive after the table is drawn appear in the same commit', async () => {
    const { compile, draw, rows } = setUp()
    compile(['surface("orders")', '$/orders = []', 'root = Column([orders])', `orders = DataTable(${COLUMNS}, $/orders)`].join('\n'))
    await draw()
    expect(rows()).toHaveLength(0)
    act(() => compile(['surface("orders")', ordersOf(3)].join('\n')))
    expect(rows()).toHaveLength(3)
  })

  it('an update reaches the cells it changes, the badge\'s tone with them, and keeps the rows it does not', async () => {
    const { compile, draw, settle, rows } = setUp()
    compile(['surface("orders")', ordersOf(4), 'root = Column([orders])', `orders = DataTable(${COLUMNS}, $/orders)`].join('\n'))
    await draw()
    await settle()
    const before = rows()
    await act(async () => compile(['surface("orders")', ordersOf(4, i => (i === 2 ? 'Failed' : 'Paid'))].join('\n')))
    await settle()
    const after = rows()
    expect(after.map(row => row.querySelector('[data-slot="a2ui-badge"]')?.getAttribute('data-tone'))).toEqual(
      ['success', 'success', 'danger', 'success'],
    )
    expect(after[2]!.textContent).toContain('Failed')
    expect(after.every((row, i) => row === before[i]), 'the same row elements are kept').toBe(true)
  })

  it('a row is the same while its columns and the text of its cells are; a field no column shows does not count', () => {
    const columns = [{ key: 'id', label: 'Order' }, { key: 'status', label: 'Status' }]
    const columnsKey = JSON.stringify(columns)
    const row = { id: '1', status: 'Paid', note: 'a' }
    const base = { columns, columnsKey, row }
    expect(sameTableRow(base, { ...base, row: { ...row } })).toBe(true)
    expect(sameTableRow(base, { ...base, row: { ...row, note: 'b' } }), 'a field no column shows').toBe(true)
    expect(sameTableRow(base, { ...base, row: { ...row, id: 1 } }), 'the same text from a number').toBe(true)
    expect(sameTableRow(base, { ...base, row: { ...row, status: 'Failed' } }), 'a changed cell').toBe(false)
    expect(sameTableRow(base, { ...base, columnsKey: '[]' }), 'changed columns').toBe(false)
  })

  it('a row redraws only by that comparison', () => {
    const row = TableRow as unknown as { $$typeof: symbol; compare: unknown }
    expect(row.$$typeof).toBe(Symbol.for('react.memo'))
    expect(row.compare).toBe(sameTableRow)
  })

  it('an A2UI badge has no colour transition', async () => {
    const { compile, draw, container } = setUp()
    compile(['surface("orders")', ordersOf(1), 'root = Column([orders])', `orders = DataTable(${COLUMNS}, $/orders)`].join('\n'))
    await draw()
    const badge = container.querySelector('[data-slot="a2ui-badge"]')!
    expect(badge.className).toContain('transition-none')
    expect(badge.className).not.toContain('transition-colors')
  })
})
