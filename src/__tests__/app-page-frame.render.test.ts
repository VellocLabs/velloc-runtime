// @vitest-environment happy-dom
/**
 * The frame an app page is drawn in (F-42): sandboxed to scripts only, the page
 * inlined, a capped port handed to it once it loads, the connection ended and
 * the frame removed when the pane goes, and a failure shown instead of a page.
 */
import { createElement } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import { I18nProvider } from '../browser/webview/i18n'

const opened: { topics: readonly string[]; port: MessagePort; other: MessagePort }[] = []
vi.mock('../browser/runtimeClient/observerPorts', () => ({
  openObserverPort: (topics: readonly string[]) => {
    const channel = new MessageChannel()
    opened.push({ topics, port: channel.port1, other: channel.port2 })
    return channel.port1
  },
}))

const { AppPageFrame } = await import('../browser/webview/apps/AppPageFrame')

const post = vi.fn()
vi.spyOn(HTMLIFrameElement.prototype, 'contentWindow', 'get').mockImplementation(() => ({ postMessage: post }) as never)

afterEach(() => {
  post.mockClear()
  cleanup()
  for (const entry of opened.splice(0)) {
    entry.port.close()
    entry.other.close()
  }
})

function show(readPage: () => Promise<unknown>) {
  return render(createElement(I18nProvider, { locale: 'en' as const }, createElement(AppPageFrame, { readPage: readPage as never })))
}

describe('AppPageFrame', () => {
  it('draws the page in a scripts-only sandbox and hands it a capped port on load', async () => {
    const view = show(async () => ({ ok: true, html: '<p>office</p>', topics: ['sessions', 'tasks'] }))
    const frame = await waitFor(() => {
      const found = view.container.querySelector('iframe[data-slot="app-page-frame"]') as HTMLIFrameElement | null
      expect(found).not.toBeNull()
      return found!
    })
    expect(frame.getAttribute('sandbox')).toBe('allow-scripts')
    expect(frame.getAttribute('srcdoc')).toBe('<p>office</p>')
    expect(frame.title).toBe('App page')

    frame.dispatchEvent(new Event('load'))
    frame.dispatchEvent(new Event('load'))
    await waitFor(() => expect(opened).toHaveLength(1))
    expect(opened[0]!.topics).toEqual(['sessions', 'tasks'])
    expect(post).toHaveBeenCalledTimes(1)
    const [message, target, transfer] = post.mock.calls[0]!
    expect(message).toEqual({ kind: 'velloc.runtimePort' })
    expect(target).toBe('*')
    expect(transfer).toHaveLength(1)
  })

  it('ends the connection and removes the frame when the pane goes', async () => {
    const view = show(async () => ({ ok: true, html: '<p/>', topics: ['sessions'] }))
    const frame = await waitFor(() => {
      const found = view.container.querySelector('iframe')
      expect(found).not.toBeNull()
      return found!
    })
    frame.dispatchEvent(new Event('load'))
    await waitFor(() => expect(opened).toHaveLength(1))
    const runtimeEnd = opened[0]!.other
    const bye = new Promise(resolve => {
      runtimeEnd.onmessage = event => resolve(event.data)
    })
    view.unmount()
    expect(await bye).toEqual({ kind: 'bye', code: 'shutting_down' })
    expect(frame.isConnected).toBe(false)
  })

  it('shows why there is no page when it cannot be read', async () => {
    show(async () => ({ ok: false, message: 'missing' }))
    expect((await screen.findByRole('alert')).textContent).toBe('The app page could not be opened.')
    expect(opened).toHaveLength(0)
  })
})
