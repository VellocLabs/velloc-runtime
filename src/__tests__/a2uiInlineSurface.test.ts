import { describe, expect, it } from 'vitest'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { A2uiInlineSurface } from '../browser/webview/a2ui/A2uiInlineSurface'

/**
 * An inline surface tool-UI rendered before the lazy A2uiProviderHost mounts its providers renders nothing
 * instead of throwing. Uses createElement (not JSX) to match the `*.test.ts` include glob.
 */
describe('A2uiInlineSurface without a provider', () => {
  it('renders nothing instead of throwing', () => {
    const render = () =>
      renderToStaticMarkup(
        createElement(A2uiInlineSurface, { surfaceId: 's1', toolCallId: 'tc1' }),
      )
    expect(render).not.toThrow()
    expect(render()).toBe('')
  })
})
