// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from 'vitest'
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { A2uiSurface, type ReactCatalogComponent } from '@a2ui/react'
import { MessageProcessor } from '@a2ui/web_core/v1_0'
import { vellocCatalog } from '../browser/webview/a2ui/catalog/vellocCatalog'
import { createA2uiExpressCompiler } from '../toolkit/builtin/a2ui/express/a2uiExpressCompiler'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const settle = () => act(async () => new Promise(resolve => setTimeout(resolve, 20)))

let root: Root | null = null
afterEach(() => {
  act(() => root?.unmount())
  root = null
  document.body.innerHTML = ''
})

/** Draws `first`, then applies `next` to the same surface in place, as a Reload or an edit does. */
async function drawThenUpdate(first: string, next: string): Promise<HTMLElement> {
  const processor = new MessageProcessor<ReactCatalogComponent>([vellocCatalog], () => {})
  const compiler = createA2uiExpressCompiler(vellocCatalog)
  const state = compiler.stateFor(processor)
  expect(compiler.compile(first, state)).toMatchObject({ ok: true })
  const host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  await act(async () => root!.render(createElement(A2uiSurface, { surface: processor.getSurface('s')! })))
  await settle()
  expect(compiler.compile(next, state)).toMatchObject({ ok: true })
  await settle()
  return host
}

describe('an A2UI component updated in place (F-1)', () => {
  it('drops a prop the new version leaves out', async () => {
    const host = await drawThenUpdate(
      'surface("s")\nroot = Column([h])\nh = Heading("Store sales", 1, "Nov 2 – Nov 8")\n',
      'surface("s")\nroot = Column([h])\nh = Heading("Nov 2 – Nov 8", 3)\n',
    )
    expect(host.querySelectorAll('[data-slot="a2ui-heading-subtitle"]')).toHaveLength(0)
    expect(host.querySelector('[data-slot="a2ui-heading"]')?.textContent).toBe('Nov 2 – Nov 8')
    expect(host.textContent).not.toContain('Store sales')
  })

  it('keeps the props the new version still gives, and takes their new values', async () => {
    const host = await drawThenUpdate(
      'surface("s")\nroot = Column([h])\nh = Heading("Sales", 1, "This week")\n',
      'surface("s")\nroot = Column([h])\nh = Heading("Sales", 1, "Last week")\n',
    )
    expect(host.querySelector('[data-slot="a2ui-heading-subtitle"]')?.textContent).toBe('Last week')
  })
})
