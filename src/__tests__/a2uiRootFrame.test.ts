// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from 'vitest'
import { adoptRootCardSheet, watchRootCardFrame } from '../browser/webview/a2ui/a2uiRootFrame'

type Holder = { adoptedStyleSheets: CSSStyleSheet[] }

function card(withShadow = true): HTMLElement & { shadowRoot: Holder | null } {
  const element = document.createElement('a2ui-card') as HTMLElement & { shadowRoot: Holder | null }
  Object.defineProperty(element, 'shadowRoot', {
    configurable: true,
    value: withShadow ? { adoptedStyleSheets: [] } : null,
  })
  return element
}

const sheet = { id: 'frameless' } as unknown as CSSStyleSheet

afterEach(() => {
  document.body.innerHTML = ''
})

describe('root card frame (F-1)', () => {
  it('adopts the sheet into the root card only, once', () => {
    const surface = document.createElement('div')
    surface.appendChild(document.createElement('div'))
    const root = card()
    const nested = card()
    root.appendChild(nested)
    surface.appendChild(root)

    expect(adoptRootCardSheet(surface, sheet)).toBe(true)
    expect(adoptRootCardSheet(surface, sheet)).toBe(true)
    expect(root.shadowRoot!.adoptedStyleSheets).toEqual([sheet])
    expect(nested.shadowRoot!.adoptedStyleSheets).toEqual([])
  })

  it('leaves a surface whose root is not a card untouched', () => {
    const surface = document.createElement('div')
    const column = document.createElement('a2ui-column')
    const inner = card()
    column.appendChild(inner)
    surface.appendChild(column)

    expect(adoptRootCardSheet(surface, sheet)).toBe(true)
    expect(inner.shadowRoot!.adoptedStyleSheets).toEqual([])
  })

  it('reports a root card whose shadow root is not created yet', () => {
    const surface = document.createElement('div')
    surface.appendChild(card(false))
    expect(adoptRootCardSheet(surface, sheet)).toBe(false)
  })

  it('reaches a root card rendered after the watch starts', async () => {
    const surface = document.createElement('div')
    document.body.appendChild(surface)
    const dispose = watchRootCardFrame(surface, sheet)
    const root = card()
    surface.appendChild(root)
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(root.shadowRoot!.adoptedStyleSheets).toEqual([sheet])
    dispose()
  })
})
