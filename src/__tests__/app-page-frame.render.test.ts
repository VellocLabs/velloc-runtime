// @vitest-environment happy-dom
/**
 * The frame an app page is drawn in (F-42): sandboxed to scripts only, the page
 * inlined, a capped port handed to it once it loads, the connection ended and
 * the frame removed when the pane goes, and a failure shown instead of a page.
 * The pane watches the page with pings, stops one that no longer answers,
 * releases one hidden too long, and brings a stopped one back through Retry.
 */
import { createElement } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { I18nProvider } from '../browser/webview/i18n'
import { APP_PAGE_CSP, APP_PAGE_PRELUDE } from '../browser/webview/apps/appPageCsp'
import { APP_PAGE_HIDDEN_RELEASE_MS, appPageHiddenReleaseMs } from '../browser/webview/apps/appPageWatch'

const opened: { topics: readonly string[]; port: MessagePort; other: MessagePort }[] = []
vi.mock('../browser/runtimeClient/observerPorts', () => ({
  openObserverPort: (topics: readonly string[]) => {
    const channel = new MessageChannel()
    opened.push({ topics, port: channel.port1, other: channel.port2 })
    return channel.port1
  },
}))

const { AppPageFrame, APP_PAGE_FRAME_NAME } = await import('../browser/webview/apps/AppPageFrame')

// One stand-in window per frame, so a message can name the frame as its source.
const post = vi.fn()
type StandInPage = { postMessage: (...args: unknown[]) => void }
const pages = new WeakMap<HTMLIFrameElement, StandInPage>()
vi.spyOn(HTMLIFrameElement.prototype, 'contentWindow', 'get').mockImplementation(function (this: HTMLIFrameElement) {
  const known = pages.get(this)
  if (known) return known as never
  const page: StandInPage = { postMessage: (...args: unknown[]) => post(...args) }
  pages.set(this, page)
  return page as never
})

let visibility: DocumentVisibilityState = 'visible'
Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => visibility })
function setVisibility(next: DocumentVisibilityState) {
  visibility = next
  act(() => {
    document.dispatchEvent(new Event('visibilitychange'))
  })
}

afterEach(() => {
  post.mockClear()
  cleanup()
  vi.useRealTimers()
  visibility = 'visible'
  window.history.replaceState(null, '', '/')
  for (const entry of opened.splice(0)) {
    entry.port.close()
    entry.other.close()
  }
})

function show(readPage: () => Promise<unknown>) {
  return render(createElement(I18nProvider, { locale: 'en' as const }, createElement(AppPageFrame, { readPage: readPage as never })))
}

const portPosts = () => post.mock.calls.filter(([message]) => (message as { kind?: string }).kind === 'velloc.runtimePort')
const pings = () => post.mock.calls.filter(([message]) => (message as { kind?: string }).kind === 'velloc.ping')
const stateOf = (view: ReturnType<typeof show>) => view.container.querySelector('[data-slot="app-page"]')!.getAttribute('data-state')

async function runningFrame(view: ReturnType<typeof show>) {
  const frame = await waitFor(() => {
    const found = view.container.querySelector('iframe[data-slot="app-page-frame"]') as HTMLIFrameElement | null
    expect(found).not.toBeNull()
    return found!
  })
  await waitFor(() => expect(stateOf(view)).toBe('running'))
  return frame
}

function pong(frame: HTMLIFrameElement, n: number, source: unknown = frame.contentWindow) {
  act(() => {
    window.dispatchEvent(new MessageEvent('message', { data: { kind: 'velloc.pong', n }, source: source as never }))
  })
}

function byeOn(port: MessagePort) {
  return new Promise(resolve => {
    port.onmessage = event => resolve(event.data)
  })
}

const page = async () => ({ ok: true, html: '<p/>', topics: ['sessions'] })

describe('AppPageFrame', () => {
  it('draws the page in a scripts-only sandbox and hands it a capped port on load', async () => {
    const view = show(async () => ({ ok: true, html: '<p>office</p>', topics: ['sessions', 'tasks'] }))
    const frame = await runningFrame(view)
    expect(frame.getAttribute('sandbox')).toBe('allow-scripts')
    expect(frame.getAttribute('name')).toBe(APP_PAGE_FRAME_NAME)
    expect(frame.getAttribute('csp')).toBe(APP_PAGE_CSP)
    expect(frame.getAttribute('srcdoc')).toBe(`<meta http-equiv="Content-Security-Policy" content="${APP_PAGE_CSP}">${APP_PAGE_PRELUDE}<p>office</p>`)
    expect(frame.title).toBe('App page')

    expect(opened).toHaveLength(1)
    expect(opened[0]!.topics).toEqual(['sessions', 'tasks'])
    expect(portPosts()).toHaveLength(1)
    const [message, target, transfer] = portPosts()[0]!
    expect(message).toEqual({ kind: 'velloc.runtimePort' })
    expect(target).toBe('*')
    expect(transfer).toHaveLength(1)
  })

  it('names the frame before adding it, the name the host keys its block on', async () => {
    const append = vi.spyOn(HTMLElement.prototype, 'appendChild')
    try {
      show(page)
      await waitFor(() => expect(append.mock.calls.some(([node]) => node instanceof HTMLIFrameElement)).toBe(true))
      const [added] = append.mock.calls.find(([node]) => node instanceof HTMLIFrameElement)!
      expect((added as HTMLIFrameElement).name).toBe('velloc-app-page')
    } finally {
      append.mockRestore()
    }
  })

  it('ends the connection and removes the frame when the pane goes', async () => {
    const view = show(page)
    const frame = await runningFrame(view)
    const bye = byeOn(opened[0]!.other)
    view.unmount()
    expect(await bye).toEqual({ kind: 'bye', code: 'shutting_down' })
    expect(frame.isConnected).toBe(false)
  })

  it('ends the connection and shows the failure when the frame loads another document', async () => {
    const view = show(page)
    const frame = await runningFrame(view)
    const bye = byeOn(opened[0]!.other)
    frame.dispatchEvent(new Event('load'))
    expect(await bye).toEqual({ kind: 'bye', code: 'shutting_down' })
    expect(opened).toHaveLength(1)
    expect(portPosts()).toHaveLength(1)
    expect(frame.isConnected).toBe(false)
    expect((await screen.findByRole('alert')).textContent).toBe('The app page could not be opened.')
    expect(stateOf(view)).toBe('failed')
  })

  it('keeps the page when the language changes, renaming only the frame', async () => {
    const readPage = vi.fn(page)
    const view = show(readPage)
    const frame = await runningFrame(view)
    view.rerender(createElement(I18nProvider, { locale: 'de' as const }, createElement(AppPageFrame, { readPage: readPage as never })))
    await waitFor(() => expect(frame.title).toBe('App-Seite'))
    expect(frame.isConnected).toBe(true)
    expect(readPage).toHaveBeenCalledTimes(1)
    expect(opened).toHaveLength(1)
  })

  it('shows why there is no page when it cannot be read, with Retry', async () => {
    const view = show(async () => ({ ok: false, message: 'missing' }))
    expect((await screen.findByRole('alert')).textContent).toBe('The app page could not be opened.')
    expect(screen.getByTestId('app-page-retry').textContent).toBe('Retry')
    expect(opened).toHaveLength(0)
    expect(stateOf(view)).toBe('failed')
  })
})

describe('AppPageFrame watch', () => {
  it('pings the page once it loads and keeps it while it answers', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] })
    const view = show(page)
    const frame = await runningFrame(view)
    expect(pings().map(([message]) => message)).toEqual([{ kind: 'velloc.ping', n: 1 }])
    for (let n = 1; n <= 4; n += 1) {
      pong(frame, n)
      act(() => vi.advanceTimersByTime(2_000))
    }
    expect(pings()).toHaveLength(5)
    expect(stateOf(view)).toBe('running')
    expect(frame.isConnected).toBe(true)
  })

  it('stops a page that leaves three pings unanswered: frame removed, connection ended, Retry shown', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] })
    const view = show(page)
    const frame = await runningFrame(view)
    const bye = byeOn(opened[0]!.other)
    act(() => vi.advanceTimersByTime(4_000))
    expect(stateOf(view)).toBe('running')
    act(() => vi.advanceTimersByTime(2_000))
    expect(stateOf(view)).toBe('stopped')
    expect(await bye).toEqual({ kind: 'bye', code: 'shutting_down' })
    expect(frame.isConnected).toBe(false)
    expect(screen.getByRole('alert').textContent).toBe('This app stopped responding.')
    expect(screen.getByTestId('app-page-retry')).toBeTruthy()
    act(() => vi.advanceTimersByTime(10_000))
    expect(pings()).toHaveLength(3)
  })

  it('counts no pong from another source, nor one with an old number', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] })
    const view = show(page)
    const frame = await runningFrame(view)
    pong(frame, 1, {})
    act(() => vi.advanceTimersByTime(2_000))
    pong(frame, 1)
    act(() => vi.advanceTimersByTime(4_000))
    expect(stateOf(view)).toBe('stopped')
  })

  it('neither pings nor counts while hidden, and counts afresh when shown', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] })
    const view = show(page)
    await runningFrame(view)
    setVisibility('hidden')
    act(() => vi.advanceTimersByTime(20_000))
    expect(pings()).toHaveLength(1)
    expect(stateOf(view)).toBe('running')
    setVisibility('visible')
    expect(pings()).toHaveLength(2)
    act(() => vi.advanceTimersByTime(4_000))
    expect(stateOf(view)).toBe('running')
  })

  it('gives a page shown again three full intervals before it is stopped', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] })
    const view = show(page)
    const frame = await runningFrame(view)
    pong(frame, 1)
    act(() => vi.advanceTimersByTime(1_950))
    setVisibility('hidden')
    setVisibility('visible')
    act(() => vi.advanceTimersByTime(5_900))
    expect(stateOf(view)).toBe('running')
    act(() => vi.advanceTimersByTime(100))
    expect(stateOf(view)).toBe('stopped')
  })

  it('Retry on a stopped page reads it again into a new frame with a new port and watch', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] })
    const readPage = vi.fn(page)
    const view = show(readPage)
    const first = await runningFrame(view)
    act(() => vi.advanceTimersByTime(6_000))
    expect(stateOf(view)).toBe('stopped')

    fireEvent.click(screen.getByTestId('app-page-retry'))
    const second = await runningFrame(view)
    expect(second).not.toBe(first)
    expect(readPage).toHaveBeenCalledTimes(2)
    expect(opened).toHaveLength(2)
    expect(screen.queryByRole('alert')).toBeNull()
    expect(pings().at(-1)![0]).toEqual({ kind: 'velloc.ping', n: 1 })

    act(() => vi.advanceTimersByTime(6_000))
    expect(stateOf(view)).toBe('stopped')
    expect(readPage).toHaveBeenCalledTimes(2)
  })

  it('disables Retry while its read is in flight, so a second press reads nothing', async () => {
    let finish: (value: unknown) => void = () => {}
    const readPage = vi
      .fn<() => Promise<unknown>>()
      .mockResolvedValueOnce({ ok: false, message: 'missing' })
      .mockImplementationOnce(() => new Promise(resolve => (finish = resolve)))
    const view = show(readPage)
    const retry = await screen.findByTestId('app-page-retry')
    fireEvent.click(retry)
    await waitFor(() => expect((screen.getByTestId('app-page-retry') as HTMLButtonElement).disabled).toBe(true))
    fireEvent.click(screen.getByTestId('app-page-retry'))
    expect(readPage).toHaveBeenCalledTimes(2)
    finish({ ok: true, html: '<p/>', topics: ['sessions'] })
    await runningFrame(view)
  })
})

describe('AppPageFrame hidden release', () => {
  it('releases a page hidden past the delay and rebuilds it when shown', async () => {
    window.history.replaceState(null, '', '/?appPageHiddenReleaseMs=30')
    const readPage = vi.fn(page)
    const view = show(readPage)
    const first = await runningFrame(view)
    const bye = byeOn(opened[0]!.other)
    setVisibility('hidden')
    await waitFor(() => expect(stateOf(view)).toBe('released'))
    expect(await bye).toEqual({ kind: 'bye', code: 'shutting_down' })
    expect(first.isConnected).toBe(false)
    expect(view.container.querySelector('iframe')).toBeNull()
    expect(screen.queryByRole('alert')).toBeNull()
    expect(readPage).toHaveBeenCalledTimes(1)

    setVisibility('visible')
    const second = await runningFrame(view)
    expect(second).not.toBe(first)
    expect(readPage).toHaveBeenCalledTimes(2)
    expect(opened).toHaveLength(2)
  })

  it('keeps the frame of a page shown again before the delay', async () => {
    window.history.replaceState(null, '', '/?appPageHiddenReleaseMs=80')
    const readPage = vi.fn(page)
    const view = show(readPage)
    const frame = await runningFrame(view)
    setVisibility('hidden')
    setVisibility('visible')
    await new Promise(resolve => setTimeout(resolve, 160))
    expect(frame.isConnected).toBe(true)
    expect(stateOf(view)).toBe('running')
    expect(readPage).toHaveBeenCalledTimes(1)
  })

  it('does not rebuild a stopped page when it is shown again', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] })
    window.history.replaceState(null, '', '/?appPageHiddenReleaseMs=30')
    const readPage = vi.fn(page)
    const view = show(readPage)
    await runningFrame(view)
    act(() => vi.advanceTimersByTime(6_000))
    expect(stateOf(view)).toBe('stopped')
    setVisibility('hidden')
    await new Promise(resolve => setTimeout(resolve, 80))
    setVisibility('visible')
    await new Promise(resolve => setTimeout(resolve, 30))
    expect(stateOf(view)).toBe('stopped')
    expect(readPage).toHaveBeenCalledTimes(1)
    expect(screen.getByRole('alert').textContent).toBe('This app stopped responding.')
  })

  it('draws the skeleton while a released page is read again', async () => {
    window.history.replaceState(null, '', '/?appPageHiddenReleaseMs=30')
    let finish: (value: unknown) => void = () => {}
    const readPage = vi
      .fn<() => Promise<unknown>>()
      .mockImplementationOnce(page)
      .mockImplementationOnce(() => new Promise(resolve => (finish = resolve)))
    const view = show(readPage)
    await runningFrame(view)
    setVisibility('hidden')
    await waitFor(() => expect(stateOf(view)).toBe('released'))
    expect(screen.getByRole('status')).toBeTruthy()
    setVisibility('visible')
    await waitFor(() => expect(readPage).toHaveBeenCalledTimes(2))
    expect(stateOf(view)).toBe('loading')
    expect(screen.getByRole('status')).toBeTruthy()
    finish({ ok: true, html: '<p/>', topics: ['sessions'] })
    await runningFrame(view)
    expect(screen.queryByRole('status')).toBeNull()
  })

  it('releases a page hidden while its Retry read is in flight, dropping the old message', async () => {
    window.history.replaceState(null, '', '/?appPageHiddenReleaseMs=30')
    const readPage = vi
      .fn<() => Promise<unknown>>()
      .mockResolvedValueOnce({ ok: false, message: 'missing' })
      .mockImplementationOnce(() => new Promise(() => {}))
      .mockImplementation(page)
    const view = show(readPage)
    fireEvent.click(await screen.findByTestId('app-page-retry'))
    setVisibility('hidden')
    await waitFor(() => expect(stateOf(view)).toBe('released'))
    expect(screen.queryByRole('alert')).toBeNull()
    expect(screen.queryByTestId('app-page-retry')).toBeNull()
    setVisibility('visible')
    await runningFrame(view)
    expect(readPage).toHaveBeenCalledTimes(3)
  })

  it('takes a delay from the guest URL only when it is shorter', () => {
    expect(appPageHiddenReleaseMs('?appPageHiddenReleaseMs=1500')).toBe(1500)
    expect(appPageHiddenReleaseMs('')).toBe(APP_PAGE_HIDDEN_RELEASE_MS)
    expect(appPageHiddenReleaseMs('?appPageHiddenReleaseMs=0')).toBe(APP_PAGE_HIDDEN_RELEASE_MS)
    expect(appPageHiddenReleaseMs('?appPageHiddenReleaseMs=90000')).toBe(APP_PAGE_HIDDEN_RELEASE_MS)
    expect(appPageHiddenReleaseMs('?appPageHiddenReleaseMs=1e3')).toBe(APP_PAGE_HIDDEN_RELEASE_MS)
    expect(appPageHiddenReleaseMs('?appPageHiddenReleaseMs=-5')).toBe(APP_PAGE_HIDDEN_RELEASE_MS)
  })
})
