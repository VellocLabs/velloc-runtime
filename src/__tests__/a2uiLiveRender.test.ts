// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest'
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { A2uiSurface, type ReactCatalogComponent } from '@a2ui/react'
import { MessageProcessor } from '@a2ui/web_core/v1_0'
import { vellocCatalog } from '../browser/webview/a2ui/catalog/vellocCatalog'
import { createA2uiLiveBlocks } from '../browser/webview/a2ui/a2uiLiveBlock'
import { createA2uiExpressCompiler } from '../toolkit/builtin/a2ui/express/a2uiExpressCompiler'
import { splitA2uiText } from '../toolkit/builtin/a2ui/express/a2uiBlocks'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const settle = () => act(async () => new Promise(resolve => setTimeout(resolve, 20)))

/** The reply as the model writes it, held before the second Text. */
const REPLY = [
  'Building it now.',
  '<a2ui>',
  'surface("live")',
  'root = Card(col)',
  'col = Column([title, more])',
  'title = Text("Drawn while streaming")',
  'more = Text("Second line")',
  '</a2ui>',
  'live-done',
].join('\n')

/** The open block's body at `text`, as the chat hands it to the live reader. */
function openBody(text: string): string {
  const block = splitA2uiText(text).find(segment => segment.kind === 'block')
  return block?.kind === 'block' ? block.body : ''
}

describe('a block drawn while it streams', () => {
  it('shows a Column\'s first child before its second child is written', async () => {
    const processor = new MessageProcessor<ReactCatalogComponent>([vellocCatalog], () => {})
    const compiler = createA2uiExpressCompiler(vellocCatalog)
    const state = compiler.stateFor(processor)
    const live = createA2uiLiveBlocks(() => compiler.stream(state))
    const container = document.createElement('div')
    document.body.appendChild(container)
    let root: Root | null = null
    try {
      // Fed as the text grows, a few characters at a time, up to the hold.
      const hold = REPLY.indexOf('more = Text')
      for (let end = 1; end <= hold; end += 3) {
        live.feed('m:0', openBody(REPLY.slice(0, Math.min(end, hold))), false)
        const surface = processor.getSurface('live')
        if (surface && !root) {
          root = createRoot(container)
          await act(async () => root!.render(createElement(A2uiSurface, { surface })))
        }
      }
      live.feed('m:0', openBody(REPLY.slice(0, hold)), false)
      await settle()
      const midway = container.textContent ?? ''
      expect(midway).toContain('Drawn while streaming')
      expect(midway).not.toContain('Second line')

      const closeAt = REPLY.indexOf('</a2ui>') + '</a2ui>'.length
      live.feed('m:0', openBody(REPLY.slice(0, closeAt - 1)), false)
      const body = openBody(REPLY.slice(0, closeAt))
      live.feed('m:0', body, true)
      expect(live.finish('m:0', 'live', body)).toEqual({ kind: 'drawn' })
      await settle()
      expect(container.textContent).toContain('Second line')
    } finally {
      root?.unmount()
      container.remove()
    }
  })
})
