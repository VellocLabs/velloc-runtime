// @vitest-environment happy-dom
/**
 * The platform's dialog for a key a router's settings app asked for (F-27
 * RP-22): what it shows for a waiting, a busy and an ended request, and that
 * the typed key leaves the page only as the answer.
 */
import { createElement } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import type { RuntimeConnection } from '../browser/runtimeClient/RuntimeConnection'
import {
  ProviderKeyRequestStore,
  resetProviderKeyRequestStoreForTests,
} from '../browser/webview/providerKeyRequestStore'
import {
  ProviderKeyRequestDialog,
  ProviderKeyRequestHost,
} from '../browser/webview/settings/sections/ProviderKeyRequestDialog'
import {
  PROVIDER_KEY_REQUEST_TOPIC,
  type ProviderKeyRequest,
  type ProviderKeyRequestState,
} from '../mods/provider/keyRequest/keyRequestProtocol'

const KEY = 'sk-test-AAAA-1111'
const REQUEST: ProviderKeyRequest = {
  requestId: 'req-1',
  routerId: 'mod.hub.router',
  routerLabel: { en: 'Hub' },
  plugin: 'vendor-a',
  definitionId: 'mod.vendor-a.main',
  label: { en: 'Vendor A' },
}

/** A store on a connection that records what the page sends and lets the test publish. */
function connected() {
  const sent: Array<[string, unknown]> = []
  let publish: (payload: unknown) => void = () => {}
  const subscribed: string[] = []
  const connection = {
    subscribe: (topic: string, listener: (event: { payload: unknown }) => void) => {
      subscribed.push(topic)
      publish = payload => listener({ payload })
      return () => {}
    },
    request: async (route: string, payload: unknown) => {
      sent.push([route, payload])
      return { accepted: true }
    },
  } as unknown as RuntimeConnection
  const store = new ProviderKeyRequestStore()
  store.attach(async () => connection)
  resetProviderKeyRequestStoreForTests(store)
  return { sent, subscribed, publish: (state: ProviderKeyRequestState) => act(async () => publish(state)) }
}

afterEach(() => {
  cleanup()
  resetProviderKeyRequestStoreForTests()
})

const input = () => screen.getByTestId('provider-key-request-input') as HTMLInputElement
const submit = () => screen.getByTestId('provider-key-request-submit') as HTMLButtonElement

describe('the key request dialog', () => {
  it('shows nothing when no key is asked for', () => {
    connected()
    render(createElement(ProviderKeyRequestDialog, { request: undefined }))
    expect(screen.queryByTestId('provider-key-request-dialog')).toBeNull()
  })

  it('names the provider, hides what is typed, and sends the key only as the answer', async () => {
    const { sent } = connected()
    render(createElement(ProviderKeyRequestDialog, { request: REQUEST }))
    expect(screen.getByTestId('provider-key-request-dialog').textContent).toContain('Add a key for Vendor A')
    expect(screen.getByLabelText('API key')).toBe(input())
    expect(input().type).toBe('password')
    expect(submit().disabled).toBe(true)
    fireEvent.change(input(), { target: { value: `  ${KEY} ` } })
    expect(submit().disabled).toBe(false)
    await act(async () => void fireEvent.submit(screen.getByTestId('provider-key-request-form')))
    expect(sent).toEqual([['providerKeyRequest.answer', { requestId: 'req-1', key: KEY }]])
    // The field is emptied once the key is on its way.
    expect(input().value).toBe('')
  })

  it('names the router that asked and the plugin whose module gets the key; a router with no name is shown by its id', () => {
    connected()
    const view = render(createElement(ProviderKeyRequestDialog, { request: REQUEST }))
    expect(screen.getByTestId('provider-key-request-asked-by').textContent).toBe('Asked for by Hub. Requests with this key are sent by the vendor-a plugin.')
    const { routerLabel: _label, ...unnamed } = REQUEST
    view.rerender(createElement(ProviderKeyRequestDialog, { request: unnamed }))
    expect(screen.getByTestId('provider-key-request-asked-by').textContent).toContain('mod.hub.router')
  })

  it('a key for a provider the product itself serves says no plugin sends the requests', () => {
    connected()
    const { plugin: _plugin, ...builtIn } = REQUEST
    render(createElement(ProviderKeyRequestDialog, { request: builtIn }))
    const shown = screen.getByTestId('provider-key-request-asked-by').textContent ?? ''
    expect(shown).toMatch(/^Asked for by Hub\. Requests with this key are sent by .+ itself, not by a plugin\.$/)
    expect(shown).not.toContain('{product}')
  })

  it('labels the field with the provider\'s own wording when it has one', () => {
    connected()
    render(createElement(ProviderKeyRequestDialog, { request: { ...REQUEST, prompt: { en: 'Access token' } } }))
    expect(screen.getByLabelText('Access token')).toBe(input())
  })

  it('sends nothing for an empty field', async () => {
    const { sent } = connected()
    render(createElement(ProviderKeyRequestDialog, { request: REQUEST }))
    fireEvent.change(input(), { target: { value: '   ' } })
    await act(async () => void fireEvent.submit(screen.getByTestId('provider-key-request-form')))
    expect(sent).toEqual([])
  })

  it('cancel tells the runtime, and sends no key', async () => {
    const { sent } = connected()
    render(createElement(ProviderKeyRequestDialog, { request: REQUEST }))
    fireEvent.change(input(), { target: { value: KEY } })
    await act(async () => void fireEvent.click(screen.getByTestId('provider-key-request-cancel')))
    expect(sent).toEqual([['providerKeyRequest.cancel', { requestId: 'req-1' }]])
  })

  it('while the key is stored, nothing can be sent or cancelled', () => {
    connected()
    render(createElement(ProviderKeyRequestDialog, { request: { ...REQUEST, busy: true } }))
    expect(input().disabled).toBe(true)
    expect(submit().disabled).toBe(true)
    expect(submit().textContent).toBe('Adding…')
    expect((screen.getByTestId('provider-key-request-cancel') as HTMLButtonElement).disabled).toBe(true)
  })

  it('a key already in use says under which name, and offers only to close', async () => {
    const { sent } = connected()
    render(createElement(ProviderKeyRequestDialog, { request: { ...REQUEST, ended: { kind: 'duplicate', name: 'Work' } } }))
    expect(screen.getByTestId('provider-key-request-ended').textContent).toBe('This key is already in use as Work. Nothing was added.')
    expect(screen.queryByTestId('provider-key-request-input')).toBeNull()
    expect(screen.queryByTestId('provider-key-request-reason')).toBeNull()
    await act(async () => void fireEvent.click(screen.getByTestId('provider-key-request-close')))
    expect(sent).toEqual([['providerKeyRequest.cancel', { requestId: 'req-1' }]])
  })

  it('a key that could not be stored says so in the person\'s language', () => {
    connected()
    render(createElement(ProviderKeyRequestDialog, { request: { ...REQUEST, ended: { kind: 'failed' } } }))
    expect(screen.getByTestId('provider-key-request-ended').textContent).toBe("The key couldn't be saved.")
  })

  it('a key typed for one request is not carried to the next', () => {
    connected()
    const view = render(createElement(ProviderKeyRequestDialog, { request: REQUEST }))
    fireEvent.change(input(), { target: { value: KEY } })
    view.rerender(createElement(ProviderKeyRequestDialog, { request: { ...REQUEST, requestId: 'req-2' } }))
    expect(input().value).toBe('')
  })
})

describe('the dialog\'s host', () => {
  it('opens with the runtime\'s published request and closes when it is gone', async () => {
    const { subscribed, publish } = connected()
    render(createElement(ProviderKeyRequestHost))
    await act(async () => {})
    expect(subscribed).toEqual([PROVIDER_KEY_REQUEST_TOPIC])
    expect(screen.queryByTestId('provider-key-request-dialog')).toBeNull()
    await publish({ seq: 1, requests: { 'req-1': REQUEST } })
    expect(screen.getByTestId('provider-key-request-dialog').textContent).toContain('Vendor A')
    await publish({ seq: 2, requests: {} })
    expect(screen.queryByTestId('provider-key-request-dialog')).toBeNull()
    // An older publication arriving late changes nothing.
    await publish({ seq: 1, requests: { 'req-1': REQUEST } })
    expect(screen.queryByTestId('provider-key-request-dialog')).toBeNull()
  })

  it('an open question comes before an ended one the person has not closed yet', async () => {
    const { publish } = connected()
    render(createElement(ProviderKeyRequestHost))
    await act(async () => {})
    const stale = { ...REQUEST, ended: { kind: 'duplicate' as const, name: 'Work' } }
    const live = { ...REQUEST, requestId: 'req-2', label: { en: 'Vendor B' } }
    await publish({ seq: 1, requests: { 'req-1': stale, 'req-2': live } })
    expect(screen.getByTestId('provider-key-request-dialog').textContent).toContain('Vendor B')
    expect(screen.getByTestId('provider-key-request-input')).toBeTruthy()
    await publish({ seq: 2, requests: { 'req-1': stale } })
    expect(screen.getByTestId('provider-key-request-ended').textContent).toContain('Work')
    // With every request ended, the latest is the one shown.
    await publish({ seq: 3, requests: { 'req-1': stale, 'req-2': { ...live, ended: { kind: 'failed' } } } })
    expect(screen.getByTestId('provider-key-request-ended').textContent).toBe("The key couldn't be saved.")
  })

  it('holds one subscription while mounted, however often the runtime publishes', async () => {
    // The topic answers each subscription with a snapshot, as the broker does;
    // capped, so a host that re-subscribes on every render fails instead of spinning.
    let subscribes = 0
    const connection = {
      subscribe: (_topic: string, listener: (event: { payload: unknown }) => void) => {
        subscribes += 1
        if (subscribes <= 25) queueMicrotask(() => listener({ payload: { seq: 0, requests: {} } }))
        return () => {}
      },
      request: async () => ({}),
    } as unknown as RuntimeConnection
    const store = new ProviderKeyRequestStore()
    store.attach(async () => connection)
    resetProviderKeyRequestStoreForTests(store)
    render(createElement(ProviderKeyRequestHost))
    for (let tick = 0; tick < 10; tick += 1) {
      await act(async () => {
        await new Promise(resolve => setTimeout(resolve, 0))
      })
    }
    expect(subscribes).toBe(1)
  })

  it('shows nothing on a page that may not read the topic', async () => {
    const store = new ProviderKeyRequestStore()
    store.attach(async () => {
      throw new Error('forbidden')
    })
    resetProviderKeyRequestStoreForTests(store)
    const failed = vi.fn()
    process.once('unhandledRejection', failed)
    render(createElement(ProviderKeyRequestHost))
    await act(async () => {})
    expect(screen.queryByTestId('provider-key-request-dialog')).toBeNull()
    process.off('unhandledRejection', failed)
    expect(failed).not.toHaveBeenCalled()
  })
})
