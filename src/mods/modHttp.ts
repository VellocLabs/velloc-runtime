/**
 * Security: `$.http.fetch` (F-25) goes through the host's `network.httpRequest`
 * under the C++ egress policy: the address reached, at the first response and every
 * redirect, must be publicly routable (no loopback, private, link-local, CGNAT or
 * multicast; `EGRESS_BLOCKED`), and `allowPrivateNetwork` is never set. The user's
 * WebFetch deny rules also refuse it (`NotAllowedError`); nothing prompts. `auth` and
 * `socketPath` reject `NotSupportedError`.
 */
import { holdsHostPlaceholder } from '../browser/bridge/hostPlaceholders'
import { parseRuleText } from '../permissions/ruleText'
import { webFetchRuleContentMatches } from '../permissions/webFetchRuleMatching'
import type { RulesByOrigin } from '../toolkit/permissionVerdict'
import type { BridgeHttpGetResult, BridgeHttpRequestPayload } from '../browser/bridge/browserBridgeProtocol'

const WEB_FETCH = 'WebFetch'
/** Redirects the loader follows, each hop judged by the egress policy. */
export const HTTP_MAX_REDIRECTS = 10
/** The loader's own ceiling (`SimpleURLLoader::DownloadToString`): a longer
 *  body rejects rather than arriving cut. */
export const HTTP_MAX_RESPONSE_BYTES = 5 * 1024 * 1024

export type ModHttpInit = {
  method?: string
  headers?: Record<string, string>
  body?: string
  auth?: string
  socketPath?: string
}

export type ModHttpResponse = {
  status: number
  ok: boolean
  headers: Record<string, string>
  text: string
}

export type ModHttpFetchInput = { url: string; init?: ModHttpInit }

/** What `$.http` needs of the session. */
export type ModHttpHost = {
  fetch(input: ModHttpFetchInput, options: { signal?: AbortSignal }): Promise<ModHttpResponse>
}

/** The bridge route `$.http.fetch` goes over. */
export type ModHttpRequest = (request: BridgeHttpRequestPayload, options: { signal?: AbortSignal }) => Promise<BridgeHttpGetResult>

function named(name: string, message: string): Error {
  const error = new Error(message)
  error.name = name
  return error
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

const METHOD_TOKEN = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/
const HEADER_NAME = METHOD_TOKEN

/** Security: the host fills a secret or OAuth placeholder in for any URL; a
 *  mod never owns one. */
function hostPlaceholderError(where: string): Error {
  return named(
    'NotAllowedError',
    `$.http.fetch: ${where} holds a host placeholder ({{secret:...}} / {{oauth:...}}), which a mod cannot send`,
  )
}

function checkUrl(url: unknown): string {
  if (typeof url !== 'string' || url === '') throw new TypeError('$.http.fetch(url, init): url must be a non-empty string')
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    throw new TypeError(`$.http.fetch: ${url} is not a URL`)
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new TypeError(`$.http.fetch: ${parsed.protocol} is not http or https`)
  }
  if (parsed.username !== '' || parsed.password !== '') {
    throw new TypeError('$.http.fetch: a URL carries no credentials')
  }
  if (holdsHostPlaceholder(url)) throw hostPlaceholderError('the URL')
  return url
}

function checkInit(init: unknown): ModHttpInit | undefined {
  if (init === undefined) return undefined
  if (!isRecord(init)) throw new TypeError('$.http.fetch(url, init): init must be an object')
  const out: ModHttpInit = {}
  if (init.method !== undefined) {
    if (typeof init.method !== 'string' || !METHOD_TOKEN.test(init.method)) {
      throw new TypeError('$.http.fetch: init.method must be an HTTP method')
    }
    out.method = init.method
  }
  if (init.headers !== undefined) {
    if (!isRecord(init.headers)) throw new TypeError('$.http.fetch: init.headers must be an object')
    const headers: Record<string, string> = {}
    for (const [name, value] of Object.entries(init.headers)) {
      if (!HEADER_NAME.test(name) || typeof value !== 'string') {
        throw new TypeError(`$.http.fetch: init.headers.${name} must be a string under a header name`)
      }
      if (holdsHostPlaceholder(value)) throw hostPlaceholderError(`init.headers.${name}`)
      headers[name] = value
    }
    out.headers = headers
  }
  if (init.body !== undefined) {
    if (typeof init.body !== 'string') throw new TypeError('$.http.fetch: init.body must be a string')
    out.body = init.body
  }
  if (init.auth !== undefined) {
    if (typeof init.auth !== 'string') throw new TypeError('$.http.fetch: init.auth must be a handle')
    out.auth = init.auth
  }
  if (init.socketPath !== undefined) {
    if (typeof init.socketPath !== 'string') throw new TypeError('$.http.fetch: init.socketPath must be a path')
    out.socketPath = init.socketPath
  }
  return out
}

/** The event's `e` from `$.http.fetch(url, init)`'s arguments, checked. */
export function httpFetchInput(args: readonly unknown[]): ModHttpFetchInput {
  const url = checkUrl(args[0])
  const init = checkInit(args[1])
  return { url, ...(init !== undefined ? { init } : {}) }
}

/** `e` as it arrived at core — a hook above may have rewritten it — checked again. */
export function checkHttpFetchInput(e: unknown): ModHttpFetchInput {
  if (!isRecord(e)) throw new TypeError('$.http.fetch: the event must be { url, init? }')
  return httpFetchInput([e.url, e.init])
}

/**
 * The deny rule that refuses a fetch of `url`, or undefined: a tool-wide
 * `WebFetch` rule, or `WebFetch(domain:<host>)` naming the URL's host, matched
 * as the WebFetch tool matches it (case and a trailing dot aside).
 */
export function webFetchDenyRule(denyRules: RulesByOrigin | undefined, url: string): string | undefined {
  for (const rules of Object.values(denyRules ?? {})) {
    for (const rule of rules ?? []) {
      const value = parseRuleText(rule)
      if (value.toolName !== WEB_FETCH) continue
      if (value.ruleContent === undefined) return rule
      const content = value.ruleContent.trim()
      if (!content.toLowerCase().startsWith('domain:')) continue
      if (webFetchRuleContentMatches(`domain:${content.slice('domain:'.length).trim()}`, url)) return rule
    }
  }
  return undefined
}

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308])
/** Sent to the origin the mod named, not carried to another one. */
const CREDENTIAL_HEADERS = new Set(['authorization', 'cookie', 'proxy-authorization'])

/** The bridge's answer as `HttpResponse`: the body read as UTF-8 text, the
 *  header names lower-cased. */
export function httpResponseOf(result: BridgeHttpGetResult): ModHttpResponse {
  const headers: Record<string, string> = {}
  for (const [name, value] of Object.entries(result.headers ?? {})) headers[name.toLowerCase()] = String(value)
  const body = result.body instanceof Uint8Array ? result.body : new Uint8Array(0)
  return {
    status: result.status,
    ok: result.status >= 200 && result.status <= 299,
    headers,
    text: new TextDecoder('utf-8').decode(body),
  }
}

function headerOf(headers: Record<string, string> | undefined, name: string): string | undefined {
  for (const [key, value] of Object.entries(headers ?? {})) if (key.toLowerCase() === name) return String(value)
  return undefined
}

/** A bridge rejection `"<CODE>: <message>"` as the error the plugin reads. */
function bridgeError(error: unknown, url: string): Error {
  const message = error instanceof Error ? error.message : String(error)
  if (message.startsWith('EGRESS_BLOCKED')) {
    return named('NotAllowedError', `$.http.fetch: ${url} is refused: only a publicly routable host is reached (${message})`)
  }
  if (message.startsWith('AbortError')) return named('AbortError', '$.http.fetch: aborted')
  return new Error(`$.http.fetch: ${message}`)
}

function abortError(): Error {
  return named('AbortError', '$.http.fetch: aborted')
}

/** `$.http` over the bridge's `network.httpRequest` and the session's deny rules. */
export function hostModHttp(options: {
  request: ModHttpRequest
  denyRules: () => RulesByOrigin | undefined
}): ModHttpHost {
  return {
    async fetch(input, { signal }) {
      const { url, init } = input
      if (init?.auth !== undefined) {
        throw named('NotSupportedError', '$.http.fetch: init.auth is not supported: this engine has no $.session.authorize')
      }
      if (init?.socketPath !== undefined) {
        throw named('NotSupportedError', '$.http.fetch: init.socketPath is not supported: no Unix sockets from the browser')
      }
      const denyRules = options.denyRules()
      const refusal = (target: string): Error | undefined => {
        const rule = webFetchDenyRule(denyRules, target)
        return rule === undefined ? undefined : named('NotAllowedError', `$.http.fetch: ${target} is refused by the deny rule ${rule}`)
      }
      const refused = refusal(url)
      if (refused) throw refused
      if (signal?.aborted) throw abortError()
      // Security: redirects are followed here, one hop at a time, so the deny
      // rules judge every URL reached, not only the first (the egress policy
      // still judges each address in C++).
      const follow = async (): Promise<ModHttpResponse> => {
        let current = url
        let method = (init?.method ?? 'GET').toUpperCase()
        let body = init?.body
        let headers = init?.headers
        for (let hops = 0; ; hops++) {
          const request: BridgeHttpRequestPayload = {
            url: current,
            method,
            ...(headers ? { headers } : {}),
            ...(body !== undefined ? { body: new TextEncoder().encode(body) } : {}),
            followRedirects: false,
            maxResponseBytes: HTTP_MAX_RESPONSE_BYTES,
          }
          let result: BridgeHttpGetResult
          try {
            result = await options.request(request, signal ? { signal } : {})
          } catch (error) {
            throw bridgeError(error, current)
          }
          const location = REDIRECT_STATUSES.has(result.status) ? headerOf(result.headers, 'location') : undefined
          if (location === undefined) return httpResponseOf(result)
          if (hops >= HTTP_MAX_REDIRECTS) {
            throw new Error(`$.http.fetch: more than ${HTTP_MAX_REDIRECTS} redirects from ${url}`)
          }
          const target = new URL(location, current)
          if (target.protocol !== 'http:' && target.protocol !== 'https:') {
            throw new TypeError(`$.http.fetch: ${current} redirected to ${target.protocol}, not http or https`)
          }
          const hopRefused = refusal(target.toString())
          if (hopRefused) throw hopRefused
          // As a browser does: 303, and 301/302 after a POST, go on as a GET.
          const toGet = result.status === 303 ? method !== 'HEAD' : (result.status === 301 || result.status === 302) && method === 'POST'
          if (toGet) {
            method = 'GET'
            body = undefined
          }
          if (headers && target.origin !== new URL(current).origin) {
            headers = Object.fromEntries(Object.entries(headers).filter(([name]) => !CREDENTIAL_HEADERS.has(name.toLowerCase())))
          }
          current = target.toString()
        }
      }
      // A bridge call cannot be torn down once sent: an abort releases the
      // caller, and the loader runs out on its own.
      const sent = follow()
      if (!signal) return sent
      return new Promise<ModHttpResponse>((resolve, reject) => {
        const onAbort = () => reject(abortError())
        signal.addEventListener('abort', onAbort, { once: true })
        sent.then(
          value => {
            signal.removeEventListener('abort', onAbort)
            resolve(value)
          },
          error => {
            signal.removeEventListener('abort', onAbort)
            reject(error)
          },
        )
      })
    },
  }
}
