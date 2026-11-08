// @vitest-environment happy-dom
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { A2uiSurface, type ReactCatalogComponent } from '@a2ui/react'
import { MessageProcessor } from '@a2ui/web_core/v1_0'
import { vellocCatalog } from '../browser/webview/a2ui/catalog/vellocCatalog'
import { createA2uiExpressCompiler } from '../toolkit/builtin/a2ui/express/a2uiExpressCompiler'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const CARD_ROOT = 'surface("s")\nroot = Card(col)\ncol = Column([hi, inner])\nhi = Text("hello")\ninner = Card(t2)\nt2 = Text("nested")\n'
const COLUMN_ROOT = 'surface("s")\nroot = Column([hi, inner])\nhi = Text("hello")\ninner = Card(t2)\nt2 = Text("nested")\n'

const surfaceCss = readFileSync(join(__dirname, '..', 'browser', 'webview', 'a2ui', 'a2ui-surface.css'), 'utf8')

function framelessSelector(): string {
  const rule = surfaceCss.split('}').find(block => block.includes('data-maximized'))
  expect(rule, 'the maximized rule is in a2ui-surface.css').toBeDefined()
  const selector = rule!.slice(0, rule!.indexOf('{')).replace(/\/\*[\s\S]*?\*\//g, '').trim()
  for (const prop of ['border: none', 'border-radius: 0', 'box-shadow: none', 'margin: 0', 'padding: 0']) {
    expect(rule, prop).toContain(prop)
  }
  return selector
}

let root: Root | null = null
afterEach(() => {
  act(() => root?.unmount())
  root = null
  document.body.innerHTML = ''
})

async function drawInPane(body: string, maximized: boolean): Promise<HTMLElement> {
  const processor = new MessageProcessor<ReactCatalogComponent>([vellocCatalog], () => {})
  const compiler = createA2uiExpressCompiler(vellocCatalog)
  expect(compiler.compile(body, compiler.stateFor(processor))).toMatchObject({ ok: true })
  const pane = document.createElement('section')
  pane.dataset.pane = 'a2ui'
  if (maximized) pane.dataset.maximized = 'true'
  const surface = document.createElement('div')
  surface.dataset.slot = 'a2ui-surface'
  pane.appendChild(surface)
  document.body.appendChild(pane)
  root = createRoot(surface)
  await act(async () => root!.render(createElement(A2uiSurface, { surface: processor.getSurface('s')! })))
  await act(async () => new Promise(resolve => setTimeout(resolve, 20)))
  return surface
}

describe('a maximized A2UI pane drops the root Card frame (F-1)', () => {
  it('selects the root card frame only, not a nested card', async () => {
    const surface = await drawInPane(CARD_ROOT, true)
    const frames = surface.querySelectorAll('.a2ui-card')
    expect(frames).toHaveLength(2)
    expect(Array.from(document.querySelectorAll(framelessSelector()))).toEqual([frames[0]])
  })

  it('leaves the card framed while the pane is not maximized', async () => {
    await drawInPane(CARD_ROOT, false)
    expect(document.querySelectorAll(framelessSelector())).toHaveLength(0)
  })

  it('leaves a card inside a non-card root framed', async () => {
    const surface = await drawInPane(COLUMN_ROOT, true)
    expect(surface.querySelectorAll('.a2ui-card')).toHaveLength(1)
    expect(document.querySelectorAll(framelessSelector())).toHaveLength(0)
  })
})
