import type { BrowserBridgeRequestPayload } from '../../bridge/protocol/core'
import type {
  BridgeProxyMode,
  BridgeProxySettings,
} from '../../bridge/protocol/network'

/**
 * The proxy form of the Network settings page (F-18), apart from the page so
 * its rules are testable without a renderer. The host checks every write
 * again; these checks only let the page name the field at fault before one
 * is sent.
 */

export type ProxyForm = {
  mode: BridgeProxyMode
  server: string
  bypassList: string
  pacUrl: string
}

export type ProxyFormProblem = {
  field: 'server' | 'bypassList' | 'pacUrl'
  reason: 'required' | 'malformed' | 'scheme' | 'credentials' | 'tooLong'
}

export const PROXY_MODES: readonly BridgeProxyMode[] = [
  'system',
  'direct',
  'fixed',
  'pac',
  'autoDetect',
]

export const MAX_BYPASS_LIST_CHARS = 4096

const SERVER_SCHEMES = new Set(['http', 'https', 'socks4', 'socks5'])
const PAC_SCHEMES = new Set(['http:', 'https:'])
const AUTHORITY = /^(\[[0-9a-f:.]+\]|[a-z0-9._-]+)(?::(\d{1,5}))?$/i

export function formFromSettings(settings: BridgeProxySettings): ProxyForm {
  return {
    mode: settings.mode,
    server: settings.server ?? '',
    bypassList: settings.bypassList ?? '',
    pacUrl: settings.pacUrl ?? '',
  }
}

function checkServer(text: string): ProxyFormProblem['reason'] | null {
  if (text === '') return 'required'
  const split = /^([a-z][a-z0-9+.-]*):\/\/(.*)$/i.exec(text)
  if (!split) return 'malformed'
  if (!SERVER_SCHEMES.has(split[1]!.toLowerCase())) return 'scheme'
  const rest = split[2]!.replace(/\/$/, '')
  if (rest.includes('@')) return 'credentials'
  const authority = AUTHORITY.exec(rest)
  if (!authority) return 'malformed'
  if (authority[2] !== undefined) {
    const port = Number(authority[2])
    if (port < 1 || port > 65535) return 'malformed'
  }
  return null
}

function checkPacUrl(text: string): ProxyFormProblem['reason'] | null {
  if (text === '') return 'required'
  let url: URL
  try {
    url = new URL(text)
  } catch {
    return 'malformed'
  }
  if (!PAC_SCHEMES.has(url.protocol)) return 'scheme'
  if (url.username !== '' || url.password !== '') return 'malformed'
  return null
}

/** The first field the host would refuse, or null when the form may be sent. */
export function checkProxyForm(form: ProxyForm): ProxyFormProblem | null {
  if (form.mode === 'fixed') {
    const reason = checkServer(form.server.trim())
    if (reason) return { field: 'server', reason }
    if (form.bypassList.trim().length > MAX_BYPASS_LIST_CHARS) {
      return { field: 'bypassList', reason: 'tooLong' }
    }
  }
  if (form.mode === 'pac') {
    const reason = checkPacUrl(form.pacUrl.trim())
    if (reason) return { field: 'pacUrl', reason }
  }
  return null
}

/** What `proxySet` is sent: only the fields the chosen mode reads. */
export function payloadFromForm(
  form: ProxyForm,
): BrowserBridgeRequestPayload<'network', 'proxySet'> {
  if (form.mode === 'fixed') {
    const bypassList = form.bypassList.trim()
    return {
      mode: 'fixed',
      server: form.server.trim(),
      ...(bypassList ? { bypassList } : {}),
    }
  }
  if (form.mode === 'pac') return { mode: 'pac', pacUrl: form.pacUrl.trim() }
  return { mode: form.mode }
}

/** Whether sending the form would change the setting in force. */
export function isProxyFormChanged(
  form: ProxyForm,
  settings: BridgeProxySettings,
): boolean {
  const next = payloadFromForm(form)
  const current = payloadFromForm(formFromSettings(settings))
  return (
    next.mode !== current.mode ||
    (next.server ?? '') !== (current.server ?? '') ||
    (next.bypassList ?? '') !== (current.bypassList ?? '') ||
    (next.pacUrl ?? '') !== (current.pacUrl ?? '')
  )
}
