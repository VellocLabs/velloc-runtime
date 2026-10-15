/**
 * Security: `$.provider.fetch` goes through the host's provider transport, which
 * substitutes `{{secret:NAME}}` (only `api_key` or a declared secret) and holds the
 * provider's domain. Relative targets join the BASE URL; absolute ones only on its
 * origin or exactly a DECLARED `domains` host (https, default port). No CONNECT /
 * TRACE / TRACK; `cookie`, `host`, `content-length`, `proxy-authorization` refused;
 * 4 MiB body caps both ways; 30 s time cap (120 s max).
 */

import { openRawProviderStream, RawProviderStreamError, type RawProviderStream } from '../../../browser/bridge/rawProviderStream'
import type { BrowserBridgeTransport } from '../../../browser/bridge/browserBridgeProtocol'
import type { ProviderNounCall } from '../ProviderModRuntime'
import { providerOf } from './providerNounTable'

export const PROVIDER_FETCH_MAX_BYTES = 4 * 1024 * 1024
export const PROVIDER_FETCH_MAX_REQUEST_BYTES = 4 * 1024 * 1024
export const PROVIDER_FETCH_DEFAULT_TIMEOUT_MS = 30_000
export const PROVIDER_FETCH_MAX_TIMEOUT_MS = 120_000

/** Never set by a module, whatever the host would do with them. */
export const FORBIDDEN_FETCH_HEADERS: readonly string[] = Object.freeze([
  'cookie',
  'host',
  'content-length',
  'proxy-authorization',
])

const REFUSED_METHODS = ['CONNECT', 'TRACE', 'TRACK']
const METHOD_TOKEN = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/
const SECRET_NAME = /^[A-Za-z0-9_.-]{1,64}$/
const ABSOLUTE = /^[A-Za-z][A-Za-z0-9+.-]*:/
const KNOWN_INIT_KEYS = ['method', 'headers', 'body', 'query', 'timeoutMs', 'provider']

/** What the fetch needs to know about one provider. */
export type ProviderFetchTarget = {
  /** The base URL in effect: the stored override, else the manifest's default. */
  baseUrl: string
  /** The manifest's declared domains (lower case). */
  domains: readonly string[]
  /** The secret names the manifest declares; `api_key` is always allowed. */
  secrets: readonly string[]
}

export type ProviderFetchResult = {
  status: number
  statusText: string
  ok: boolean
  /** Where the request ended up (after redirects the host followed). */
  url: string
  /** Names lower-cased. */
  headers: Record<string, string>
  body: Uint8Array
}

export type ProviderFetchDeps = {
  /** The direct bridge transport, or null when there is none. */
  transport: () => BrowserBridgeTransport | null
  /** Absent: the provider is not one this realm knows. */
  targetOf: (providerId: string) => ProviderFetchTarget | undefined
  /** Test seam: the default is `openRawProviderStream`. */
  open?: typeof openRawProviderStream
}

function named(name: string, message: string): Error {
  const error = new Error(message)
  error.name = name
  return error
}

function refusal(message: string): Error {
  return named('NotAllowedError', message)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * The URL a target names, or a refusal. Exported for tests.
 *
 * The URL parser decides what the host is — the same parser, with the same
 * answers, a browser uses — so `https://api.example.com@evil.test/`,
 * `https://api.example.com.evil.test/` and `https://evil.test\@api.example.com/`
 * all read as what they reach, never as what they start with.
 */
export function resolveFetchTarget(input: unknown, target: ProviderFetchTarget): URL {
  if (typeof input !== 'string' || input === '') {
    throw new TypeError('$.provider.fetch(pathOrUrl, init): pathOrUrl must be a non-empty string')
  }
  // eslint-disable-next-line no-control-regex
  if (/[\\\u0000- \u007f]/.test(input)) {
    throw new TypeError('$.provider.fetch: the target has no backslash, space or control character')
  }
  let base: URL
  try {
    base = new URL(target.baseUrl)
  } catch {
    throw named('NotSupportedError', '$.provider.fetch: the provider has no usable base URL')
  }
  if (base.protocol !== 'http:' && base.protocol !== 'https:') {
    throw named('NotSupportedError', '$.provider.fetch: the provider has no usable base URL')
  }

  if (!ABSOLUTE.test(input)) {
    // Relative: joined to the base URL's path. `//host/x` is a network-path
    // reference — it would leave the base — so it is not a path.
    if (input.startsWith('//')) throw refusal('$.provider.fetch: a target starting with "//" names another host')
    const rest = input.startsWith('/') ? input : `/${input}`
    const joined = new URL(`${base.origin}${base.pathname.replace(/\/+$/, '')}${rest}`)
    if (joined.origin !== base.origin || joined.username !== '' || joined.password !== '') {
      throw refusal('$.provider.fetch: the target leaves the provider')
    }
    return joined
  }

  let url: URL
  try {
    url = new URL(input)
  } catch {
    throw new TypeError(`$.provider.fetch: ${input} is not a URL`)
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw refusal(`$.provider.fetch: ${url.protocol} is not http or https`)
  }
  if (url.username !== '' || url.password !== '') {
    throw refusal('$.provider.fetch: a URL carries no credentials')
  }
  if (url.origin === base.origin) return url
  const declared = target.domains.includes(url.hostname)
  if (!declared || url.protocol !== 'https:' || url.port !== '') {
    throw refusal(
      `$.provider.fetch: ${url.hostname} is not one of this provider's domains` +
        (target.domains.length > 0 ? ` (${target.domains.join(', ')})` : ''),
    )
  }
  return url
}

/** `{{secret:NAME}}` is the only template; a name must be allowed. */
function checkTemplates(where: string, value: string, allowed: ReadonlySet<string>): void {
  for (const match of value.matchAll(/\{\{([^{}]*)\}\}/g)) {
    const inner = match[1]!
    const secret = /^secret:(.*)$/.exec(inner)
    if (!secret || !SECRET_NAME.test(secret[1]!)) {
      throw refusal(`$.provider.fetch: ${where} carries {{${inner}}}, which is not a {{secret:NAME}} template`)
    }
    if (!allowed.has(secret[1]!)) {
      throw refusal(
        `$.provider.fetch: ${where} names the secret ${secret[1]!}, which this provider does not declare ` +
          `(it declares ${[...allowed].join(', ')})`,
      )
    }
  }
}

function checkHeaders(init: Record<string, unknown>, allowed: ReadonlySet<string>): Record<string, string> | undefined {
  if (init.headers === undefined) return undefined
  if (!isRecord(init.headers)) throw new TypeError('$.provider.fetch: init.headers must be an object')
  const headers: Record<string, string> = {}
  const seen = new Set<string>()
  for (const [name, value] of Object.entries(init.headers)) {
    if (!METHOD_TOKEN.test(name)) throw new TypeError(`$.provider.fetch: "${name}" is not a header name`)
    const lower = name.toLowerCase()
    if (FORBIDDEN_FETCH_HEADERS.includes(lower)) {
      throw refusal(`$.provider.fetch: the ${lower} header is not set by a provider module`)
    }
    if (seen.has(lower)) throw new TypeError(`$.provider.fetch: the ${lower} header is given twice`)
    seen.add(lower)
    if (typeof value !== 'string' || /[\r\n\u0000]/.test(value)) {
      throw new TypeError(`$.provider.fetch: init.headers.${name} must be a one-line string`)
    }
    checkTemplates(`the ${lower} header`, value, allowed)
    headers[name] = value
  }
  return headers
}

function checkQuery(init: Record<string, unknown>, allowed: ReadonlySet<string>): Record<string, string> | undefined {
  if (init.query === undefined) return undefined
  if (!isRecord(init.query)) throw new TypeError('$.provider.fetch: init.query must be an object')
  const query: Record<string, string> = {}
  for (const [name, value] of Object.entries(init.query)) {
    if (typeof value !== 'string') throw new TypeError(`$.provider.fetch: init.query.${name} must be a string`)
    checkTemplates(`the ${name} query value`, value, allowed)
    query[name] = value
  }
  return query
}

function checkBody(init: Record<string, unknown>, method: string): Uint8Array | undefined {
  if (init.body === undefined || init.body === null) return undefined
  let bytes: Uint8Array
  if (typeof init.body === 'string') bytes = new TextEncoder().encode(init.body)
  else if (init.body instanceof Uint8Array) bytes = init.body
  else if (init.body instanceof ArrayBuffer) bytes = new Uint8Array(init.body)
  else throw new TypeError('$.provider.fetch: init.body must be a string or bytes')
  if (method === 'GET' || method === 'HEAD') throw new TypeError(`$.provider.fetch: a ${method} request has no body`)
  if (bytes.byteLength > PROVIDER_FETCH_MAX_REQUEST_BYTES) {
    throw new RangeError(`$.provider.fetch: the body is over ${PROVIDER_FETCH_MAX_REQUEST_BYTES} bytes`)
  }
  return bytes
}

function checkTimeout(init: Record<string, unknown>): number {
  if (init.timeoutMs === undefined) return PROVIDER_FETCH_DEFAULT_TIMEOUT_MS
  const value = init.timeoutMs
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    throw new TypeError('$.provider.fetch: init.timeoutMs must be a positive number')
  }
  return Math.min(value, PROVIDER_FETCH_MAX_TIMEOUT_MS)
}

export function createProviderFetch(deps: ProviderFetchDeps): (call: ProviderNounCall) => Promise<ProviderFetchResult> {
  const open = deps.open ?? openRawProviderStream
  return async call => {
    const input = call.args[1]
    if (input !== undefined && !isRecord(input)) throw new TypeError('$.provider.fetch(pathOrUrl, init): init must be an object')
    const init: Record<string, unknown> = input ?? {}
    for (const key of Object.keys(init)) {
      if (!KNOWN_INIT_KEYS.includes(key)) throw new TypeError(`$.provider.fetch: init.${key} is not an option (${KNOWN_INIT_KEYS.join(', ')})`)
    }
    const providerId = providerOf(call, init)
    const target = deps.targetOf(providerId)
    if (!target) throw named('NotSupportedError', `$.provider.fetch: ${providerId} is not registered`)
    const url = resolveFetchTarget(call.args[0], target)

    let method = 'GET'
    if (init.method !== undefined) {
      if (typeof init.method !== 'string' || !METHOD_TOKEN.test(init.method)) {
        throw new TypeError('$.provider.fetch: init.method must be an HTTP method')
      }
      method = init.method.toUpperCase()
      if (REFUSED_METHODS.includes(method)) throw refusal(`$.provider.fetch: ${method} is not allowed`)
    }
    const allowed = new Set<string>(['api_key', ...target.secrets])
    const headers = checkHeaders(init, allowed)
    const queryParams = checkQuery(init, allowed)
    const body = checkBody(init, method)
    const timeoutMs = checkTimeout(init)

    const transport = deps.transport()
    if (!transport) throw named('NotSupportedError', '$.provider.fetch: the host is not connected')

    const controller = new AbortController()
    let timedOut = false
    let stream: RawProviderStream | undefined
    // The time cap holds even over a transport that ignores the signal: the
    // call is released at the cap, and the request closed behind it.
    let release: (error: Error) => void = () => {}
    const cut = new Promise<never>((_resolve, reject) => {
      release = reject
    })
    const timer = setTimeout(() => {
      timedOut = true
      controller.abort()
      release(named('TimeoutError', `$.provider.fetch: no complete answer within ${timeoutMs} ms`))
    }, timeoutMs)
    const work = async (): Promise<ProviderFetchResult> => {
      stream = await open(transport, {
        providerId,
        url: url.href,
        method,
        ...(headers ? { headers } : {}),
        ...(queryParams ? { queryParams } : {}),
        ...(body ? { body } : {}),
        idleTimeoutMs: timeoutMs,
        maxResponseBytes: PROVIDER_FETCH_MAX_BYTES,
        signal: controller.signal,
      })
      const chunks: Uint8Array[] = []
      let total = 0
      for await (const chunk of stream.body) {
        total += chunk.byteLength
        if (total > PROVIDER_FETCH_MAX_BYTES) {
          throw named('ResponseTooLargeError', `$.provider.fetch: the answer is over ${PROVIDER_FETCH_MAX_BYTES} bytes`)
        }
        chunks.push(chunk)
      }
      const bytes = new Uint8Array(total)
      let at = 0
      for (const chunk of chunks) {
        bytes.set(chunk, at)
        at += chunk.byteLength
      }
      const responseHeaders: Record<string, string> = {}
      for (const [name, value] of Object.entries(stream.headers ?? {})) responseHeaders[name.toLowerCase()] = String(value)
      return {
        status: stream.status,
        statusText: stream.statusText,
        ok: stream.status >= 200 && stream.status <= 299,
        url: stream.finalUrl,
        headers: responseHeaders,
        body: bytes,
      }
    }
    const working = work()
    // The loser of the race must not surface as an unhandled rejection.
    working.catch(() => {})
    // The calling hook's dispatch was abandoned (a sign-in cancelled, a wall
    // clock out): the request is closed and the call released at once.
    const abandon = (): void => {
      controller.abort()
      release(named('AbortError', '$.provider.fetch: the calling hook was abandoned'))
    }
    if (call.signal?.aborted) abandon()
    else call.signal?.addEventListener('abort', abandon, { once: true })
    try {
      return await Promise.race([working, cut])
    } catch (error) {
      await stream?.cancel().catch(() => {})
      if (timedOut) throw named('TimeoutError', `$.provider.fetch: no complete answer within ${timeoutMs} ms`)
      if (error instanceof RawProviderStreamError) {
        if (error.code === 'TARGET_NOT_ALLOWED') throw refusal(`$.provider.fetch: ${error.message}`)
        throw new Error(`$.provider.fetch: ${error.message}`)
      }
      throw error
    } finally {
      clearTimeout(timer)
      call.signal?.removeEventListener('abort', abandon)
      cut.catch(() => {})
    }
  }
}
