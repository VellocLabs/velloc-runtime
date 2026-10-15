/**
 * Security: a model's own wire (`ProviderModelInfo.wire`) comes from outside (a
 * provider mod's listing or the disk cache) and is untrusted. `parseModelWire` keeps
 * well-formed fields; `confineModelWire` drops a `baseUrl` of another origin (the
 * host's domain lock is anchored to the stored base URL); `applyModelWire` merges.
 */
import { traceLine } from '../../utils/debugLog'
import type { CodecCompat, ModelWire } from '../../config/nexusModelConfig/providerDefinition'
import type { ProviderSpec } from './driverTypes'

/** The codec switches a wire may carry — the whole set. */
export const COMPAT_KEYS: readonly (keyof CodecCompat)[] = [
  'maxTokensField',
  'developerRole',
  'reasoningEffortField',
  'reasoningReplay',
]

const MAX_TOKENS_FIELDS: ReadonlySet<unknown> = new Set(['max_tokens', 'max_completion_tokens'])
const REASONING_REPLAYS: ReadonlySet<unknown> = new Set(['none', 'reasoning_content', 'reasoning'])
const FORMAT_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/
const HEADER_NAME = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/
// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/
const MAX_HEADERS = 32
const MAX_PATH = 512

const logged = new Set<string>()

/** One warning per (provider, problem): a listing is re-applied on every
 *  refresh and the same row would otherwise repeat itself. */
function logOnce(providerId: string, problem: string): void {
  const key = `${providerId}\u0000${problem}`
  if (logged.has(key)) return
  logged.add(key)
  traceLine(`[providers] ${providerId}: model wire: ${problem}`, { level: 'warn' })
}

/** Test hook. */
export function resetModelWireLog(): void {
  logged.clear()
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

/**
 * Whether `path` is a request path: starts with one `/`, no scheme or host,
 * no `.` / `..` segment (raw or percent-decoded), no backslash, control
 * character or fragment. A query string is allowed.
 */
export function isSafeWirePath(path: unknown): path is string {
  if (typeof path !== 'string' || path.length === 0 || path.length > MAX_PATH) return false
  if (!path.startsWith('/') || path.startsWith('//')) return false
  if (CONTROL_CHARS.test(path) || path.includes('\\') || path.includes('#')) return false
  const pathname = path.split('?', 1)[0]!
  let decoded = pathname
  // Two rounds: `%252e%252e` decodes to `%2e%2e` and then to `..`.
  for (let round = 0; round < 2; round += 1) {
    try {
      decoded = decodeURIComponent(decoded)
    } catch {
      return false
    }
    if (CONTROL_CHARS.test(decoded) || decoded.includes('\\')) return false
    if (decoded.split('/').some(segment => segment === '..' || segment === '.')) return false
  }
  return true
}

/** A well-formed absolute http(s) URL with no credentials, query or
 *  fragment, as `origin + path` without a trailing slash; else undefined. */
function normalizedBaseUrl(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const text = value.trim()
  if (!text || CONTROL_CHARS.test(text)) return undefined
  // `new URL` would quietly fold a dot segment away; a row that wrote one
  // is refused instead of reinterpreted.
  if (/\/(\.|%2e){1,2}(\/|$)/i.test(text)) return undefined
  let url: URL
  try {
    url = new URL(text)
  } catch {
    return undefined
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return undefined
  if (url.username || url.password || url.search || url.hash) return undefined
  const pathname = url.pathname.replace(/\/+$/, '')
  if (pathname && !isSafeWirePath(pathname)) return undefined
  return `${url.origin}${pathname}`
}

/** The origin (scheme + host + port) of a URL; undefined when it is none. */
export function originOf(url: string | undefined): string | undefined {
  if (!url) return undefined
  try {
    const parsed = new URL(url)
    return parsed.protocol === 'https:' || parsed.protocol === 'http:' ? parsed.origin : undefined
  } catch {
    return undefined
  }
}

function parseCompat(providerId: string, raw: unknown): CodecCompat | undefined {
  if (raw === undefined) return undefined
  if (!isPlainObject(raw)) {
    logOnce(providerId, 'compat is not an object; ignored')
    return undefined
  }
  const out: CodecCompat = {}
  for (const [key, value] of Object.entries(raw)) {
    if (!(COMPAT_KEYS as readonly string[]).includes(key)) {
      logOnce(providerId, `unknown compat key "${key}" ignored`)
      continue
    }
    if (key === 'maxTokensField' && MAX_TOKENS_FIELDS.has(value)) {
      out.maxTokensField = value as CodecCompat['maxTokensField']
    } else if (key === 'reasoningReplay' && REASONING_REPLAYS.has(value)) {
      out.reasoningReplay = value as CodecCompat['reasoningReplay']
    } else if ((key === 'developerRole' || key === 'reasoningEffortField') && typeof value === 'boolean') {
      out[key] = value
    } else {
      logOnce(providerId, `compat ${key} has an invalid value; ignored`)
    }
  }
  return Object.keys(out).length > 0 ? out : undefined
}

function readProviderHeaders(providerId: string, raw: unknown): Record<string, string> | undefined {
  if (raw === undefined) return undefined
  if (!isPlainObject(raw)) {
    logOnce(providerId, 'headers is not an object; ignored')
    return undefined
  }
  const out: Record<string, string> = {}
  for (const [name, value] of Object.entries(raw)) {
    if (Object.keys(out).length >= MAX_HEADERS) {
      logOnce(providerId, `more than ${MAX_HEADERS} headers; the rest ignored`)
      break
    }
    if (!HEADER_NAME.test(name) || typeof value !== 'string' || CONTROL_CHARS.test(value)) {
      logOnce(providerId, `header "${name}" is malformed; ignored`)
      continue
    }
    // The host resolves `{{oauth:…}}` only for the provider's own spec, after
    // checking it can; a model row does not get to ask for it.
    if (value.includes('{{oauth:')) {
      logOnce(providerId, `header "${name}" asks for an OAuth value; ignored`)
      continue
    }
    out[name] = value
  }
  return Object.keys(out).length > 0 ? out : undefined
}

/**
 * The well-formed part of an untrusted `wire`, or undefined when nothing
 * usable is left. Does not look at the provider: `baseUrl` is only checked
 * for being a plain http(s) URL (`confineModelWire` holds it to the origin).
 */
export function parseModelWire(providerId: string, raw: unknown): ModelWire | undefined {
  if (raw === undefined || raw === null) return undefined
  if (!isPlainObject(raw)) {
    logOnce(providerId, 'wire is not an object; ignored')
    return undefined
  }
  const wire: ModelWire = {}
  if (raw.format !== undefined) {
    if (typeof raw.format === 'string' && FORMAT_ID.test(raw.format)) wire.format = raw.format
    else logOnce(providerId, 'wire.format is not a codec id; ignored')
  }
  if (raw.baseUrl !== undefined) {
    const baseUrl = normalizedBaseUrl(raw.baseUrl)
    if (baseUrl) wire.baseUrl = baseUrl
    else logOnce(providerId, 'wire.baseUrl is not a plain http(s) URL; ignored')
  }
  if (raw.path !== undefined) {
    if (isSafeWirePath(raw.path)) wire.path = raw.path
    else logOnce(providerId, 'wire.path is not a safe request path; ignored')
  }
  const headers = readProviderHeaders(providerId, raw.headers)
  if (headers) wire.headers = headers
  const compat = parseCompat(providerId, raw.compat)
  if (compat) wire.compat = compat
  return Object.keys(wire).length > 0 ? wire : undefined
}

/**
 * `wire` held to its provider: a `baseUrl` whose origin is not the origin of
 * `providerBaseUrl` is dropped (and logged once); the rest stands. With no
 * provider base URL to compare against, a `baseUrl` cannot be vouched for
 * and is dropped as well.
 */
export function confineModelWire(
  providerId: string,
  wire: ModelWire,
  providerBaseUrl: string | undefined,
): ModelWire | undefined {
  if (wire.baseUrl === undefined) return wire
  const { baseUrl, ...rest } = wire
  const allowed = originOf(providerBaseUrl)
  if (allowed !== undefined && originOf(baseUrl) === allowed) return wire
  logOnce(providerId, `wire.baseUrl ${baseUrl} leaves the provider's origin; the override is dropped`)
  return Object.keys(rest).length > 0 ? rest : undefined
}

/** Parse, then confine. */
export function sanitizeModelWire(
  providerId: string,
  raw: unknown,
  providerBaseUrl: string | undefined,
): ModelWire | undefined {
  const parsed = parseModelWire(providerId, raw)
  return parsed ? confineModelWire(providerId, parsed, providerBaseUrl) : undefined
}

/**
 * Header merge for specs: case-insensitive, `over` wins, and an empty value is
 * KEPT — it is the instruction to drop a header, and the codec's own headers
 * are only merged later (`ModelProvider.buildRequest`).
 */
export function mergeSpecHeaders(
  base: Record<string, string> | undefined,
  over: Record<string, string> | undefined,
): Record<string, string> | undefined {
  if (!base && !over) return undefined
  const out = new Map<string, [string, string]>()
  for (const [name, value] of Object.entries(base ?? {})) out.set(name.toLowerCase(), [name, value])
  for (const [name, value] of Object.entries(over ?? {})) out.set(name.toLowerCase(), [name, value])
  return Object.fromEntries(out.values())
}

/**
 * `spec` with a (sanitized) model wire laid over it. A model that changes the
 * `format` without naming a `path` loses the provider's `path`: that path was
 * written for the other codec.
 */
export function applyModelWire(spec: ProviderSpec, wire: ModelWire): ProviderSpec {
  const format = wire.format ?? spec.format
  const headers = mergeSpecHeaders(spec.headers, wire.headers)
  const compat: CodecCompat | undefined =
    spec.compat || wire.compat ? { ...spec.compat, ...wire.compat } : undefined
  const { path: providerPath, ...rest } = spec
  const path = wire.path ?? (format === spec.format ? providerPath : undefined)
  return {
    ...rest,
    format,
    ...(wire.baseUrl ? { baseUrl: wire.baseUrl } : {}),
    ...(path ? { path } : {}),
    ...(headers ? { headers } : {}),
    ...(compat ? { compat } : {}),
  }
}
