// @vitest-environment happy-dom
import { createElement } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'

import { ModProviderEditor } from '../browser/webview/settings/sections/ModProviderEditor'
import { ProviderSignInDialog } from '../browser/webview/settings/sections/ProviderSignInDialog'
import type { NexusSettingsBridge } from '../browser/webview/nexusSettingsBridge'
import {
  ProviderLoginStore,
  resetProviderLoginStoreForTests,
  useProviderLogin,
} from '../browser/webview/providerLoginStore'
import type { BrowserLlmProvider } from '../browser/bridge/protocol/nexus_llm'
import type { RuntimeConnection } from '../browser/runtimeClient/RuntimeConnection'
import { I18nProvider } from '../browser/webview/i18n'
import type {
  ProviderLoginSession,
  ProviderLoginState,
  ProviderLoginStep,
} from '../mods/provider/login/loginProtocol'
import type { NexusProviderConfig } from '../settings/settingsTypes'

/**
 * The sign-in dialog and the editor's sign-in panel are DRAWN from the
 * runtime's published state; the person's answers are actions. The connection
 * here is a fake that records the actions and lets the test publish state.
 */

const ID = 'mod.acme.main'

function fakeConnection() {
  const requests: Array<{ route: string; payload: any }> = []
  let listener: ((event: { payload: unknown }) => void) | undefined
  let subscribed = 0
  const connection = {
    request: vi.fn(async (route: string, payload: unknown) => {
      requests.push({ route, payload })
      return { accepted: true, ok: true, loginId: 'login-1', joined: false }
    }),
    subscribe: vi.fn((_topic: string, onEvent: (event: { payload: unknown }) => void) => {
      subscribed += 1
      listener = onEvent
      return () => {
        subscribed -= 1
        listener = undefined
      }
    }),
  } as unknown as RuntimeConnection
  let seq = 0
  return {
    connection,
    requests,
    subscribed: () => subscribed,
    publish(state: Partial<ProviderLoginState>) {
      seq += 1
      act(() => listener?.({ payload: { seq, logins: {}, signedOut: {}, ...state } }))
    },
  }
}

function sessionOf(step: ProviderLoginStep, n = 1): ProviderLoginSession {
  return { loginId: 'login-1', providerId: ID, stepId: `login-1:${n}`, step }
}

function Harness({ name = 'Acme AI' }: { name?: string }) {
  const { session } = useProviderLogin(ID)
  return createElement(ProviderSignInDialog, { name, session })
}

let conn: ReturnType<typeof fakeConnection>

/** The shell's own capture-phase handler takes a link click (externalLinkClicks.ts);
 *  here a stand-in keeps happy-dom from really fetching the page. */
const holdLinkClicks = (event: Event): void => {
  if ((event.target as Element | null)?.closest?.('a[href]')) event.preventDefault()
}

function mountDialog(locale = 'en') {
  const store = new ProviderLoginStore()
  resetProviderLoginStoreForTests(store)
  store.attach(async () => conn.connection)
  render(createElement(I18nProvider, { locale }, createElement(Harness)))
}

beforeEach(() => {
  conn = fakeConnection()
  document.addEventListener('click', holdLinkClicks, { capture: true })
})
afterEach(() => {
  document.removeEventListener('click', holdLinkClicks, { capture: true })
  cleanup()
  resetProviderLoginStoreForTests(null)
  ;(globalThis as { __nexusUnsavedEdits?: number }).__nexusUnsavedEdits = 0
})

async function show(step: ProviderLoginStep, n = 1) {
  await waitFor(() => expect(conn.subscribed()).toBe(1))
  conn.publish({ logins: { [ID]: sessionOf(step, n) } })
  return screen.findByTestId('provider-signin-dialog')
}

const answers = () => conn.requests.filter(r => r.route === 'providerLogin.answer').map(r => r.payload)

describe('the dialog draws the published step', () => {
  it('opens only while there is a session, and subscribes only while it is read', async () => {
    mountDialog()
    await waitFor(() => expect(conn.subscribed()).toBe(1))
    expect(screen.queryByTestId('provider-signin-dialog')).toBeNull()
    await show({ kind: 'working' })
    expect(screen.getByTestId('provider-signin-working').textContent).toContain('Working')
    conn.publish({ logins: {} })
    await waitFor(() => expect(screen.queryByTestId('provider-signin-dialog')).toBeNull())
    cleanup()
    expect(conn.subscribed()).toBe(0)
  })

  it('openUrl: shows the host, the link opens through the window\'s opener (a plain http link) and the click is the answer', async () => {
    mountDialog()
    await show({ kind: 'openUrl', url: 'https://auth.acme.example/start?x=1' })
    expect(screen.getByTestId('provider-signin-host').textContent).toBe('auth.acme.example')
    const link = screen.getByTestId('provider-signin-open') as HTMLAnchorElement
    expect(link.getAttribute('href')).toBe('https://auth.acme.example/start?x=1')
    expect(link.getAttribute('rel')).toContain('noopener')
    fireEvent.click(link)
    await waitFor(() => expect(answers()).toHaveLength(1))
    expect(answers()[0]).toEqual({ loginId: 'login-1', stepId: 'login-1:1', value: { kind: 'ack' } })
  })

  it('never draws a link for a scheme other than http / https, even if the state carried one', async () => {
    mountDialog()
    await show({ kind: 'openUrl', url: 'javascript:alert(1)' })
    expect(screen.queryByTestId('provider-signin-open')).toBeNull()
    expect(document.body.innerHTML).not.toContain('javascript:')
    await show({ kind: 'code', code: 'AB-12', url: 'file:///etc/passwd' }, 2)
    expect(screen.getByTestId('provider-signin-code-value').textContent).toBe('AB-12')
    expect(screen.queryByTestId('provider-signin-code-open')).toBeNull()
  })

  it('code: shows the code and a link to where to enter it', async () => {
    mountDialog()
    await show({ kind: 'code', code: 'WXYZ-1234', url: 'https://auth.acme.example/device' })
    expect(screen.getByTestId('provider-signin-code-value').textContent).toBe('WXYZ-1234')
    expect(screen.getByTestId('provider-signin-code-open').getAttribute('href')).toBe('https://auth.acme.example/device')
    expect(answers()).toEqual([])
  })

  it('prompt: a secret is a password field; Continue sends it as an action naming the step; nothing is stored in the page', async () => {
    mountDialog()
    await show({ kind: 'prompt', label: 'Paste the code', secret: true })
    const input = screen.getByTestId('provider-signin-input') as HTMLInputElement
    expect(input.type).toBe('password')
    expect(screen.getByTestId('provider-signin-prompt').textContent).toContain('Paste the code')
    const submit = screen.getByTestId('provider-signin-submit') as HTMLButtonElement
    expect(submit.disabled).toBe(true)
    fireEvent.change(input, { target: { value: 'PAGE-SECRET-77' } })
    // A typed secret holds the background updater's reload while it exists.
    expect((globalThis as { __nexusUnsavedEdits?: number }).__nexusUnsavedEdits ?? 0).toBeGreaterThan(0)
    fireEvent.click(submit)
    await waitFor(() => expect(answers()).toHaveLength(1))
    expect(answers()[0]).toEqual({ loginId: 'login-1', stepId: 'login-1:1', value: { kind: 'text', text: 'PAGE-SECRET-77' } })
    // The runtime moves the step on: the field is gone, and no page storage ever held the secret.
    conn.publish({ logins: { [ID]: sessionOf({ kind: 'working' }, 2) } })
    await waitFor(() => expect(screen.queryByTestId('provider-signin-input')).toBeNull())
    expect(document.body.textContent).not.toContain('PAGE-SECRET-77')
    for (const storage of [localStorage, sessionStorage]) {
      expect(JSON.stringify({ ...storage })).not.toContain('PAGE-SECRET-77')
    }
  })

  it('prompt: a plain prompt is a text field', async () => {
    mountDialog()
    await show({ kind: 'prompt', label: { en: 'Account name', de: 'Kontoname' }, secret: false })
    expect((screen.getByTestId('provider-signin-input') as HTMLInputElement).type).toBe('text')
  })

  it('choose: radio options (the vendor\'s labels), Continue sends the index', async () => {
    mountDialog()
    await show({ kind: 'choose', label: 'Which workspace?', options: [{ label: 'Personal' }, { label: { en: 'Team', de: 'Team (de)' } }] })
    const submit = screen.getByTestId('provider-signin-submit') as HTMLButtonElement
    expect(submit.disabled).toBe(true)
    expect(screen.getByTestId('provider-signin-choose').textContent).toContain('Personal')
    fireEvent.click(screen.getByTestId('provider-signin-option-1'))
    expect(submit.disabled).toBe(false)
    fireEvent.click(submit)
    await waitFor(() => expect(answers()).toHaveLength(1))
    expect(answers()[0].value).toEqual({ kind: 'choice', index: 1 })
  })

  it('progress: the vendor\'s text in the person\'s language', async () => {
    mountDialog('de')
    await show({ kind: 'progress', text: { en: 'Contacting the vendor', de: 'Kontaktiere den Anbieter' } })
    expect(screen.getByTestId('provider-signin-progress').textContent).toBe('Kontaktiere den Anbieter')
  })

  it('done shows the account; failed shows the module\'s own words, or the catalog\'s for a runtime reason', async () => {
    mountDialog()
    await show({ kind: 'done', account: 'zed@acme.example' })
    expect(screen.getByTestId('provider-signin-done').textContent).toContain('zed@acme.example')
    expect(screen.getByTestId('provider-signin-cancel').textContent).toBe('Close')

    await show({ kind: 'failed', code: 'module', reason: 'Your plan does not include this model' }, 2)
    expect(screen.getByTestId('provider-signin-failed').textContent).toContain('Your plan does not include this model')

    await show({ kind: 'failed', code: 'timeout', reason: 'the sign-in took longer than 10 minutes' }, 3)
    const failed = screen.getByTestId('provider-signin-failed')
    expect(failed.textContent).toContain('took too long')
    expect(failed.textContent).not.toContain('10 minutes')
  })

  it('Cancel is always there: it asks the runtime to cancel (or dismiss) the sign-in', async () => {
    mountDialog()
    await show({ kind: 'prompt', label: 'Code', secret: false })
    expect(screen.getByTestId('provider-signin-cancel').textContent).toBe('Cancel')
    fireEvent.click(screen.getByTestId('provider-signin-cancel'))
    await waitFor(() => expect(conn.requests.some(r => r.route === 'providerLogin.cancel')).toBe(true))
    expect(conn.requests.find(r => r.route === 'providerLogin.cancel')!.payload).toEqual({ loginId: 'login-1' })
  })

  it('a refused answer is shown, and the dialog stays on the step', async () => {
    mountDialog()
    await show({ kind: 'openUrl', url: 'https://auth.acme.example/start' })
    ;(conn.connection.request as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error('stale'))
    fireEvent.click(screen.getByTestId('provider-signin-open'))
    expect((await screen.findByTestId('provider-signin-error')).textContent).toContain('stale')
  })
})

// ── the editor's sign-in panel ──

const modRow = (): BrowserLlmProvider => ({
  id: ID,
  label: 'Acme',
  iconSvg: '<svg viewBox="0 0 1 1"></svg>',
  enabled: false,
  models: [],
  mod: {
    state: 'ready',
    plugin: 'acme',
    version: '1.0.0',
    configId: 'acme@inline',
    displayName: 'Acme AI',
    credentialMethods: ['login'],
    secrets: [{ name: 'access_token', label: 'Access token' }],
  },
})

function mountEditor(saved: NexusProviderConfig | undefined, signedOut?: ProviderLoginState['signedOut']) {
  const store = new ProviderLoginStore()
  resetProviderLoginStoreForTests(store)
  store.attach(async () => conn.connection)
  const onChanged = vi.fn(async () => {})
  const bridge = {
    request: vi.fn(async () => ({ ok: true, options: {}, storedSensitive: [] })),
    subscribeEvents: () => () => {},
  } as unknown as NexusSettingsBridge
  render(
    createElement(
      I18nProvider,
      { locale: 'en' },
      createElement(ModProviderEditor, { provider: modRow(), saved, bridge, onChanged }),
    ),
  )
  return { onChanged, signedOut }
}

describe('the editor\'s sign-in panel', () => {
  it('signed out: an enabled Sign in; clicking it asks the runtime to start, and nothing is written by the page', async () => {
    mountEditor(undefined)
    const button = (await screen.findByTestId('mod-login-signin')) as HTMLButtonElement
    expect(button.disabled).toBe(false)
    expect(button.textContent).toBe('Sign in')
    fireEvent.click(button)
    await waitFor(() => expect(conn.requests.map(r => r.route)).toContain('providerLogin.start'))
    expect(conn.requests.find(r => r.route === 'providerLogin.start')!.payload).toEqual({ providerId: ID })
  })

  it('signed in: the account and a Sign out that asks the runtime, then re-reads the stored entry', async () => {
    const { onChanged } = mountEditor({ source: 'mod', account: 'zed@acme.example', storedSecrets: ['access_token'] })
    expect((await screen.findByTestId('mod-login-account')).textContent).toContain('zed@acme.example')
    expect(screen.queryByTestId('mod-login-signin')).toBeNull()
    expect(screen.getByTestId('mod-provider-status').textContent).toContain('Connected')
    fireEvent.click(screen.getByTestId('mod-login-signout'))
    await waitFor(() => expect(conn.requests.map(r => r.route)).toContain('providerLogin.signOut'))
    expect(conn.requests.find(r => r.route === 'providerLogin.signOut')!.payload).toEqual({ providerId: ID })
    await waitFor(() => expect(onChanged).toHaveBeenCalled())
  })

  it('the runtime marked the sign-in ended: "Sign in again", and the provider reads as not connected', async () => {
    mountEditor({ source: 'mod', account: 'zed@acme.example', storedSecrets: ['access_token'] })
    await screen.findByTestId('mod-login-account')
    await waitFor(() => expect(conn.subscribed()).toBe(1))
    conn.publish({ signedOut: { [ID]: { reason: 'the vendor ended the sign-in', at: 1 } } })
    const button = await screen.findByTestId('mod-login-signin')
    expect(button.textContent).toBe('Sign in again')
    expect(screen.getByTestId('mod-login-ended').textContent).toContain('has ended')
    expect(screen.getByTestId('mod-provider-status').textContent).toContain('Not connected')
    expect(screen.queryByTestId('mod-login-signout')).toBeNull()
  })

  it('a sign-in under way opens the dialog on this page and disables a second start; done re-reads the entry', async () => {
    const { onChanged } = mountEditor(undefined)
    await waitFor(() => expect(conn.subscribed()).toBe(1))
    conn.publish({ logins: { [ID]: sessionOf({ kind: 'code', code: 'AB-12', url: 'https://auth.acme.example/device' }) } })
    expect(await screen.findByTestId('provider-signin-dialog')).toBeTruthy()
    expect((screen.getByTestId('mod-login-signin') as HTMLButtonElement).disabled).toBe(true)
    conn.publish({ logins: { [ID]: sessionOf({ kind: 'done', account: 'zed' }, 2) } })
    await waitFor(() => expect(onChanged).toHaveBeenCalled())
  })

  it('a refused start is said, not swallowed', async () => {
    mountEditor(undefined)
    ;(conn.connection.request as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error('forbidden_scope'))
    fireEvent.click(await screen.findByTestId('mod-login-signin'))
    expect((await screen.findByTestId('mod-login-error')).textContent).toContain('forbidden_scope')
  })
})
