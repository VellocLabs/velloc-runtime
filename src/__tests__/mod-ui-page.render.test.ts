// @vitest-environment happy-dom
/**
 * The page's half of `$.ui.copy`, `$.ui.focus` and `$.ui.scroll` (F-25): the client store hands `page` requests to
 * the latest responder, which answers from the DOM via `mods.pageAnswer`. copy: clipboard API, then textarea, then
 * once more on refocus (never when the host took it); focus: the plugin's element; scroll: the row window.
 */
import { createElement } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render } from '@testing-library/react'
import type { ModsPageRequest } from '../browser/runtimeProtocol'
import type { RuntimeConnection } from '../browser/runtimeClient/RuntimeConnection'
import { holdModsUiView, modsPageControls } from '../browser/webview/mods/modsUiView'
import { ModRenderTree } from '../components/assistant-ui/mod-render'
import { answerPageRequest, offsetForBlock, type ModPageDeps } from '../components/assistant-ui/use-mod-page'

afterEach(() => {
  cleanup()
  document.body.innerHTML = ''
})

const deps = (over: Partial<ModPageDeps> = {}): ModPageDeps => ({
  copy: async () => true,
  copyWhenFocused: async () => true,
  waitMs: 0,
  focusWaitMs: 10,
  ...over,
})

type Handler = (event: { type?: string; payload: unknown }) => void
function fakeConnection(canAnswer = true) {
  const handlers = new Map<string, Handler>()
  const requests: Array<{ route: string; payload: unknown }> = []
  const connection = {
    subscribe: (topic: string, handler: Handler) => {
      handlers.set(topic, handler)
      return () => handlers.delete(topic)
    },
    request: async (route: string, payload: unknown) => {
      requests.push({ route, payload })
      return { accepted: true }
    },
    can: (_capability: string, action: string) => canAnswer || action !== 'pageAnswer',
  } as unknown as RuntimeConnection
  return { connection, handlers, requests }
}

describe('the client store', () => {
  it('hands each page request to the latest responder and answers with mods.pageAnswer', async () => {
    const { connection, handlers, requests } = fakeConnection()
    const release = holdModsUiView(connection, 's1', () => {})
    const controls = modsPageControls(connection, 's1')
    const first: ModsPageRequest[] = []
    const second: ModsPageRequest[] = []
    const dropFirst = controls.onPageRequest!(request => first.push(request))
    const dropSecond = controls.onPageRequest!(request => second.push(request))
    const request: ModsPageRequest = { requestId: 'p1', op: 'copy', text: 'x', hostCopied: false }
    handlers.get('mods/ui/s1')!({ type: 'page', payload: request })
    handlers.get('mods/ui/s1')!({ type: 'page', payload: { requestId: 'p2', op: 'copy' } })
    expect(first).toEqual([])
    expect(second).toEqual([request])
    dropSecond()
    handlers.get('mods/ui/s1')!({ type: 'page', payload: request })
    expect(first).toEqual([request])
    await controls.answerPage!({ requestId: 'p1', op: 'copy', isCopied: true })
    expect(requests).toEqual([{ route: 'mods.pageAnswer', payload: { sessionId: 's1', requestId: 'p1', op: 'copy', isCopied: true } }])
    dropFirst()
    release()
  })

  it('a connection that may not answer gets no controls', () => {
    expect(modsPageControls(fakeConnection(false).connection, 's1')).toEqual({})
  })
})

describe('copy', () => {
  const copy = (hostCopied: boolean): ModsPageRequest => ({ requestId: 'p1', op: 'copy', text: 'npm test', hostCopied })

  it('the first path that takes it answers', async () => {
    const copyWhenFocused = vi.fn(async () => true)
    expect(await answerPageRequest(copy(false), document, deps({ copyWhenFocused }))).toEqual({ requestId: 'p1', op: 'copy', isCopied: true })
    expect(copyWhenFocused).not.toHaveBeenCalled()
  })

  it('neither the page nor the host took it: tried again once the page has focus', async () => {
    const copyWhenFocused = vi.fn(async () => true)
    const answer = await answerPageRequest(copy(false), document, deps({ copy: async () => false, copyWhenFocused }))
    expect(answer).toEqual({ requestId: 'p1', op: 'copy', isCopied: true })
    expect(copyWhenFocused).toHaveBeenCalledWith('npm test', 10)
  })

  it('the host took it: no late retry that could clobber a copy the person made since', async () => {
    const copyWhenFocused = vi.fn(async () => true)
    const answer = await answerPageRequest(copy(true), document, deps({ copy: async () => false, copyWhenFocused }))
    expect(answer).toEqual({ requestId: 'p1', op: 'copy', isCopied: false })
    expect(copyWhenFocused).not.toHaveBeenCalled()
  })

  it('every path throwing is an honest false', async () => {
    const boom = async (): Promise<boolean> => {
      throw new Error('denied')
    }
    expect(await answerPageRequest(copy(false), document, deps({ copy: boom, copyWhenFocused: boom }))).toEqual({
      requestId: 'p1',
      op: 'copy',
      isCopied: false,
    })
  })
})

const band = (tree: unknown) =>
  createElement(
    'div',
    { 'data-mod-component': 'AbovePrompt', 'data-mod-site': 'band', 'data-testid': 'band' },
    createElement(ModRenderTree, { tree, site: { component: 'AbovePrompt', requestId: 'band', plugin: 'form' } }),
  )
const pane = (id: string, owner: string, tree: unknown) =>
  createElement(
    'div',
    { 'data-mod-component': 'Pane', 'data-mod-site': id, 'data-mod-owner': owner, 'data-testid': `pane-${id}` },
    createElement(ModRenderTree, { tree, site: { component: 'Pane', requestId: id, plugin: owner } }),
  )
const button = (key: string, plugin = 'form') => ({ type: 'Button', props: { key, label: key }, press: { plugin, handle: 1 } })
const input = (key: string) => ({ type: 'Input', props: { key }, press: { plugin: 'form', handle: 2 } })
const box = (key: string, children: unknown[] = []) => ({ type: 'Box', props: { key }, children })

const focus = (over: Partial<Extract<ModsPageRequest, { op: 'focus' }>> = {}): ModsPageRequest => ({
  requestId: 'p1',
  op: 'focus',
  plugin: 'form',
  component: 'Pane',
  site: 'ask',
  key: 'q',
  holdsKeys: true,
  ...over,
})

describe('the drawn elements carry what the page finds them by', () => {
  it('key and owner on boxes, buttons, inputs and selects; the tree marked', () => {
    const { container } = render(
      createElement(ModRenderTree, {
        tree: box('outer', [button('go'), input('q'), { type: 'Select', props: { key: 's', options: [{ value: 'a' }] }, press: { plugin: 'other', handle: 3 } }]),
        site: { component: 'Pane', requestId: 'ask', plugin: 'form' },
      }),
    )
    expect(container.querySelector('[data-mod-tree]')).not.toBeNull()
    expect(container.querySelector('div[data-mod-key="outer"]')?.getAttribute('data-mod-plugin')).toBe('form')
    expect(container.querySelector('button[data-mod-key="go"]')?.getAttribute('data-mod-plugin')).toBe('form')
    expect(container.querySelector('input[data-mod-key="q"]')?.getAttribute('data-mod-plugin')).toBe('form')
    expect(container.querySelector('select[data-mod-key="s"]')?.getAttribute('data-mod-plugin')).toBe('other')
  })
})

describe('focus', () => {
  it("the plugin's element in a site that holds the keys", async () => {
    const { getByTestId } = render(pane('ask', 'form', box('b', [input('q')])))
    expect(await answerPageRequest(focus(), document, deps())).toEqual({ requestId: 'p1', op: 'focus' })
    expect(document.activeElement).toBe(getByTestId('mod-input-q'))
  })

  it('a site that does not hold the keys is denied — unless the focus is already in it', async () => {
    const { getByTestId } = render(pane('ask', 'form', box('b', [button('first'), input('q')])))
    expect(await answerPageRequest(focus({ holdsKeys: false }), document, deps())).toEqual({
      requestId: 'p1',
      op: 'focus',
      deny: 'the site does not hold the keys',
    })
    getByTestId('mod-button-first').focus()
    expect(await answerPageRequest(focus({ holdsKeys: false }), document, deps())).toEqual({ requestId: 'p1', op: 'focus' })
    expect(document.activeElement).toBe(getByTestId('mod-input-q'))
  })

  it("not shown, another plugin's, not drawn or not focusable: each a deny", async () => {
    render(createElement('div', null, pane('ask', 'other', input('q')), band(box('b', [button('theirs', 'other'), box('plain')]))))
    expect((await answerPageRequest(focus(), document, deps())) as { deny?: string }).toMatchObject({ deny: 'the site is not shown' })
    expect(await answerPageRequest(focus({ component: 'AbovePrompt', site: 'band', key: 'theirs' }), document, deps())).toMatchObject({
      deny: 'nothing drawn under key "theirs"',
    })
    expect(await answerPageRequest(focus({ component: 'AbovePrompt', site: 'band', key: 'plain' }), document, deps())).toMatchObject({
      deny: '"plain" cannot take the focus',
    })
  })

  it('an element drawn a moment later is waited for', async () => {
    const view = render(pane('ask', 'form', box('b')))
    setTimeout(() => view.rerender(pane('ask', 'form', box('b', [input('q')]))), 30)
    expect(await answerPageRequest(focus(), document, deps({ waitMs: 1_000 }))).toEqual({ requestId: 'p1', op: 'focus' })
  })
})

/** A window laid out as `rows` rows of 18px, `bodyRows` of them shown. */
function layOut(window: HTMLElement, rows: number, bodyRows: number): void {
  // The trees' 12px type at 1.5em: an 18px row.
  window.querySelector<HTMLElement>('[data-mod-tree]')!.style.lineHeight = '18px'
  Object.defineProperty(window, 'clientHeight', { configurable: true, value: bodyRows * 18 })
  Object.defineProperty(window, 'scrollHeight', { configurable: true, value: rows * 18 })
  window.getBoundingClientRect = () => ({ top: 100, height: bodyRows * 18 }) as DOMRect
}

describe('scroll', () => {
  it('offsetForBlock puts an element where scrollIntoView would', () => {
    const at = { current: 2, bodyRows: 4 }
    expect(offsetForBlock('start', 7, 1, at)).toBe(7)
    expect(offsetForBlock('end', 7, 1, at)).toBe(4)
    expect(offsetForBlock('center', 7, 2, at)).toBe(6)
    expect(offsetForBlock('nearest', 3, 1, at)).toBe(2)
    expect(offsetForBlock('nearest', 0, 1, at)).toBe(0)
    expect(offsetForBlock('nearest', 9, 1, at)).toBe(6)
  })

  it('measures a window in rows: start, end, and a key', async () => {
    const { getByTestId } = render(pane('log', 'form', box('b', [button('row7')])))
    const window = getByTestId('pane-log')
    layOut(window, 10, 4)
    window.scrollTop = 36
    getByTestId('mod-button-row7').getBoundingClientRect = () => ({ top: 100 + 7 * 18 - 36, height: 18 }) as DOMRect
    const measure = (to: Extract<ModsPageRequest, { op: 'scrollMeasure' }>['to'], block = 'nearest' as const) =>
      answerPageRequest({ requestId: 'p1', op: 'scrollMeasure', plugin: 'form', to, in: typeof to === 'string' ? 'log' : undefined, block }, document, deps())
    expect(await measure('start')).toEqual({
      requestId: 'p1',
      op: 'scrollMeasure',
      measured: { component: 'Pane', site: 'log', current: 2, offset: 0, bodyRows: 4, contentRows: 10 },
    })
    expect(await measure('end')).toMatchObject({ measured: { offset: 6 } })
    expect(await measure({ key: 'row7' })).toMatchObject({ measured: { site: 'log', current: 2, offset: 4 } })
    expect(await measure({ key: 'missing' })).toMatchObject({ deny: 'nothing drawn under key "missing"' })
  })

  it('applies an offset in rows; end is held while the tree grows, until the person wheels', async () => {
    const { getByTestId, rerender } = render(pane('log', 'form', box('b', [button('a')])))
    const window = getByTestId('pane-log')
    layOut(window, 10, 4)
    expect(
      await answerPageRequest({ requestId: 'p1', op: 'scrollApply', component: 'Pane', site: 'log', offset: 3, stickToEnd: false }, document, deps()),
    ).toEqual({ requestId: 'p1', op: 'scrollApply' })
    expect(window.scrollTop).toBe(54)

    await answerPageRequest({ requestId: 'p2', op: 'scrollApply', component: 'Pane', site: 'log', offset: 6, stickToEnd: true }, document, deps())
    layOut(window, 14, 4)
    rerender(pane('log', 'form', box('b', [button('a'), button('b')])))
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(window.scrollTop).toBe(14 * 18)

    window.dispatchEvent(new Event('wheel'))
    window.scrollTop = 0
    layOut(window, 20, 4)
    rerender(pane('log', 'form', box('b', [button('a'), button('b'), button('c')])))
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(window.scrollTop).toBe(0)
  })

  it('a transcript row is brought into view where it sits; one not drawn is a deny', async () => {
    const { getByTestId } = render(createElement('div', { 'data-mod-request-id': 'tool-1', 'data-testid': 'row' }))
    const scrollIntoView = vi.fn()
    getByTestId('row').scrollIntoView = scrollIntoView
    expect(await answerPageRequest({ requestId: 'p1', op: 'scrollRow', row: 'tool-1', block: 'center' }, document, deps())).toEqual({
      requestId: 'p1',
      op: 'scrollRow',
    })
    expect(scrollIntoView).toHaveBeenCalledWith({ block: 'center' })
    expect(await answerPageRequest({ requestId: 'p2', op: 'scrollRow', row: 'tool-9', block: 'center' }, document, deps())).toEqual({
      requestId: 'p2',
      op: 'scrollRow',
      deny: 'the row is not drawn',
    })
  })
})
