import { describe, expect, it } from 'vitest'

import type { BridgeProxySettings } from '../browser/bridge/protocol/network'
import { HOST_PROXY_TABLE } from '../browser/runtimeHub/hostProxyTable'
import {
  MAX_BYPASS_LIST_CHARS,
  MAX_PROXY_SIGN_IN_CHARS,
  checkProxyForm,
  formFromSettings,
  isProxyFormChanged,
  payloadFromForm,
  type ProxyForm,
} from '../browser/webview/settings/proxyForm'

function form(patch: Partial<ProxyForm>): ProxyForm {
  return { mode: 'system', server: '', bypassList: '', pacUrl: '', username: '', password: '', ...patch }
}

function settings(patch: Partial<BridgeProxySettings>): BridgeProxySettings {
  return { mode: 'system', source: 'default', editable: true, ...patch }
}

function serverReason(server: string) {
  return checkProxyForm(form({ mode: 'fixed', server }))?.reason ?? null
}

describe('proxy form', () => {
  it('accepts the four proxy schemes with a host and an optional port', () => {
    expect(serverReason('http://127.0.0.1:8080')).toBeNull()
    expect(serverReason('HTTPS://proxy.example.com')).toBeNull()
    expect(serverReason('socks4://proxy.example.com:1080/')).toBeNull()
    expect(serverReason('  socks5://[::1]:1080  ')).toBeNull()
  })

  it('names why a server address is refused', () => {
    expect(serverReason('')).toBe('required')
    expect(serverReason('proxy.example.com:8080')).toBe('malformed')
    expect(serverReason('http://')).toBe('malformed')
    expect(serverReason('http://proxy.example.com/path')).toBe('malformed')
    expect(serverReason('http://proxy.example.com:0')).toBe('malformed')
    expect(serverReason('http://proxy.example.com:70000')).toBe('malformed')
    expect(serverReason('ftp://proxy.example.com')).toBe('scheme')
    expect(serverReason('http://user:pass@proxy.example.com')).toBe('credentials')
  })

  it('checks only the fields the chosen mode reads', () => {
    expect(checkProxyForm(form({ mode: 'direct', server: 'nonsense' }))).toBeNull()
    expect(checkProxyForm(form({ mode: 'system', pacUrl: 'nonsense' }))).toBeNull()
    expect(checkProxyForm(form({ mode: 'pac', pacUrl: '' }))).toEqual({
      field: 'pacUrl',
      reason: 'required',
    })
    expect(checkProxyForm(form({ mode: 'pac', pacUrl: 'ftp://example.com/p.pac' }))).toEqual({
      field: 'pacUrl',
      reason: 'scheme',
    })
    expect(checkProxyForm(form({ mode: 'pac', pacUrl: 'file:///C:/corp/proxy.pac' }))).toEqual({
      field: 'pacUrl',
      reason: 'scheme',
    })
    expect(
      checkProxyForm(form({ mode: 'pac', pacUrl: 'https://example.com/proxy.pac' })),
    ).toBeNull()
  })

  it('refuses a bypass list past the limit the host accepts', () => {
    const server = 'http://proxy.example.com'
    const atLimit = 'a'.repeat(MAX_BYPASS_LIST_CHARS)
    expect(checkProxyForm(form({ mode: 'fixed', server, bypassList: atLimit }))).toBeNull()
    expect(
      checkProxyForm(form({ mode: 'fixed', server, bypassList: `${atLimit}a` })),
    ).toEqual({ field: 'bypassList', reason: 'tooLong' })
  })

  it('sends only what the mode reads, trimmed', () => {
    expect(
      payloadFromForm(
        form({
          mode: 'fixed',
          server: ' http://proxy.example.com:3128 ',
          bypassList: ' localhost, *.internal ',
          pacUrl: 'https://example.com/proxy.pac',
        }),
      ),
    ).toEqual({
      mode: 'fixed',
      server: 'http://proxy.example.com:3128',
      bypassList: 'localhost, *.internal',
    })
    expect(
      payloadFromForm(form({ mode: 'fixed', server: 'http://p.example.com', bypassList: ' ' })),
    ).toEqual({ mode: 'fixed', server: 'http://p.example.com' })
    expect(
      payloadFromForm(form({ mode: 'pac', server: 'x', pacUrl: ' https://example.com/p.pac ' })),
    ).toEqual({ mode: 'pac', pacUrl: 'https://example.com/p.pac' })
    expect(payloadFromForm(form({ mode: 'direct', server: 'x', pacUrl: 'y' }))).toEqual({
      mode: 'direct',
    })
  })

  it('is changed only when a field the mode reads differs from the setting', () => {
    const current = settings({ mode: 'fixed', server: 'http://proxy.example.com:3128' })
    const shown = formFromSettings(current)
    expect(shown).toEqual({
      mode: 'fixed',
      server: 'http://proxy.example.com:3128',
      bypassList: '',
      pacUrl: '',
      username: '',
      password: '',
    })
    expect(isProxyFormChanged(shown, current)).toBe(false)
    expect(isProxyFormChanged({ ...shown, pacUrl: 'https://example.com/p.pac' }, current)).toBe(
      false,
    )
    expect(isProxyFormChanged({ ...shown, server: `${shown.server} ` }, current)).toBe(false)
    expect(isProxyFormChanged({ ...shown, bypassList: 'localhost' }, current)).toBe(true)
    expect(isProxyFormChanged({ ...shown, mode: 'direct' }, current)).toBe(true)
  })
})

describe('proxy sign-in', () => {
  const HTTP = 'http://proxy.example.com:3128'
  const problem = (patch: Partial<ProxyForm>, current?: BridgeProxySettings) => {
    const found = checkProxyForm(form({ mode: 'fixed', server: HTTP, ...patch }), current)
    return found ? `${found.field}:${found.reason}` : null
  }
  const stored = settings({ mode: 'fixed', server: HTTP, username: 'me', hasPassword: true, source: 'user' })

  it('needs both halves, on an http or https proxy only', () => {
    expect(problem({})).toBeNull()
    expect(problem({ username: 'me', password: 'pw' })).toBeNull()
    expect(problem({ server: 'HTTPS://proxy.example.com', username: 'me', password: 'pw' })).toBeNull()
    expect(problem({ password: 'pw' })).toBe('username:required')
    expect(problem({ username: 'me' })).toBe('password:required')
    expect(problem({ server: 'socks5://proxy.example.com', username: 'me', password: 'pw' })).toBe('username:scheme')
    expect(problem({ username: 'a:b', password: 'pw' })).toBe('username:malformed')
    expect(problem({ username: 'a'.repeat(MAX_PROXY_SIGN_IN_CHARS + 1), password: 'pw' })).toBe('username:tooLong')
    expect(problem({ username: 'me', password: 'a'.repeat(MAX_PROXY_SIGN_IN_CHARS + 1) })).toBe('password:tooLong')
  })

  it('an empty password keeps the stored one only for the same server and user name', () => {
    expect(problem({ username: 'me' }, stored)).toBeNull()
    expect(problem({ server: `${HTTP}/`, username: ' me ' }, stored)).toBeNull()
    expect(problem({ username: 'you' }, stored)).toBe('password:required')
    expect(problem({ server: 'http://other.example.com:3128', username: 'me' }, stored)).toBe('password:required')
    expect(problem({ username: 'me' }, settings({ mode: 'fixed', server: HTTP, username: 'me' }))).toBe('password:required')
  })

  it('never shows a stored password and sends one only when typed', () => {
    expect(formFromSettings(stored)).toMatchObject({ username: 'me', password: '' })
    expect(payloadFromForm(form({ mode: 'fixed', server: HTTP, username: ' me ' }))).toEqual({
      mode: 'fixed', server: HTTP, username: 'me',
    })
    expect(payloadFromForm(form({ mode: 'fixed', server: HTTP, username: 'me', password: ' p w ' }))).toEqual({
      mode: 'fixed', server: HTTP, username: 'me', password: ' p w ',
    })
    expect(payloadFromForm(form({ mode: 'fixed', server: HTTP, password: 'pw' }))).toEqual({ mode: 'fixed', server: HTTP })
    expect(payloadFromForm(form({ mode: 'direct', username: 'me', password: 'pw' }))).toEqual({ mode: 'direct' })
  })

  it('is a change when the user name differs or a password was typed', () => {
    const same = form({ mode: 'fixed', server: HTTP, username: 'me' })
    expect(isProxyFormChanged(same, stored)).toBe(false)
    expect(isProxyFormChanged({ ...same, password: 'new' }, stored)).toBe(true)
    expect(isProxyFormChanged({ ...same, username: '' }, stored)).toBe(true)
  })
})

describe('proxy setting scope', () => {
  // Security: the setting reroutes the desktop's own traffic and shows its
  // proxy address, so neither half is open to a remote client's lesser grant.
  it('keeps both halves local-only', () => {
    expect(HOST_PROXY_TABLE.network).toEqual({ proxyGet: 'full', proxySet: 'full' })
  })
})
