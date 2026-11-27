/**
 * A runtime model provider: a `ProviderSpec` bound to a wire-format codec. Providers
 * differ only in their spec. Security: the host substitutes `{{secret:NAME}}`,
 * keeps the request on the provider's domain, and never shows the secret to the
 * runtime.
 */
import type { BridgeModelRequestPayload } from '../../browser/bridge/browserBridgeProtocol'
import { providerHasStoredApiKey } from '../endpoints/endpointTrust'
import { getProviderDriver, resolveDriverBaseUrl } from './driverRegistry'
import type {
  DriverHttpRequest,
  DriverRequestContext,
  DriverResponseDecoder,
  DriverStreamEvent,
  ProviderDriver,
  ProviderSpec,
} from './driverTypes'
import { hostToolNames, readToolAliases, wireToolNames } from './toolAliases'

export class ProviderConfigError extends Error {
  constructor(message: string) {
    super(`provider_error: ${message}`)
    this.name = 'ProviderConfigError'
  }
}

/** Case-insensitive header merge; an empty override value removes. */
export function mergeHeaders(
  base: Record<string, string>,
  overrides: Record<string, string> | undefined,
): Record<string, string> {
  const out = new Map<string, [string, string]>()
  for (const [name, value] of Object.entries(base)) out.set(name.toLowerCase(), [name, value])
  for (const [name, value] of Object.entries(overrides ?? {})) {
    if (value === '') out.delete(name.toLowerCase())
    else out.set(name.toLowerCase(), [name, value])
  }
  return Object.fromEntries(out.values())
}

const API_KEY_TEMPLATE = '{{secret:api_key}}'

/**
 * A keyless call (`ProviderSpec.apiKeyOptional`, no key stored): the API-key
 * template becomes the empty credential the host class sends for a provider
 * built with `requires_api_key=false` — `"Bearer " + ""`, `x-api-key: ""` —
 * and a query parameter carrying it is dropped. Any other secret is kept.
 */
function withoutApiKey(
  headers: Record<string, string>,
  queryParams: Record<string, string> | undefined,
): { headers: Record<string, string>; queryParams?: Record<string, string> } {
  const outHeaders = Object.fromEntries(
    Object.entries(headers).map(([name, value]) => [name, value.split(API_KEY_TEMPLATE).join('')]),
  )
  if (!queryParams) return { headers: outHeaders }
  const outQuery = Object.fromEntries(
    Object.entries(queryParams).filter(([, value]) => !value.includes(API_KEY_TEMPLATE)),
  )
  return { headers: outHeaders, ...(Object.keys(outQuery).length > 0 ? { queryParams: outQuery } : {}) }
}

/** The format's own auth entries (those carrying the key) leave `queryParams`;
 *  called when the headers already carry the credential. */
function withoutHeaderCarriedAuth(
  queryParams: Record<string, string> | undefined,
  explicit: Record<string, string> | undefined,
): Record<string, string> | undefined {
  if (!queryParams) return queryParams
  const out = Object.fromEntries(
    Object.entries(queryParams).filter(
      ([name, value]) => !value.includes(API_KEY_TEMPLATE) || (explicit !== undefined && name in explicit),
    ),
  )
  return Object.keys(out).length > 0 ? out : undefined
}

/** The format's own API-key headers leave the request; one the provider
 *  declared itself stays. Called when the headers already carry the credential.
 *  Security: a header naming a secret the provider does not hold makes the
 *  host refuse the whole request, so the default must not ride along. */
function withoutDefaultKeyHeaders(
  headers: Record<string, string>,
  explicit: Record<string, string> | undefined,
): Record<string, string> {
  const declared = new Set(Object.keys(explicit ?? {}).map(name => name.toLowerCase()))
  return Object.fromEntries(
    Object.entries(headers).filter(([name, value]) => !value.includes(API_KEY_TEMPLATE) || declared.has(name.toLowerCase())),
  )
}

/** Swap the path (and drop the query) of an absolute URL. */
function withPath(url: string, path: string): string {
  const parsed = new URL(url)
  const [pathname, search] = path.split('?', 2)
  parsed.pathname = pathname!.startsWith('/') ? pathname! : `/${pathname}`
  parsed.search = search ? `?${search}` : ''
  return parsed.toString()
}

export class ModelProvider {
  constructor(
    readonly spec: ProviderSpec,
    private readonly codec: ProviderDriver,
    private readonly baseUrl: string,
  ) {}

  get id(): string {
    return this.spec.id
  }

  get format(): string {
    return this.codec.id
  }

  /**
   * The spec's headers / User-Agent / query over the codec's, with the auth
   * rules every request shares: when the merged headers carry the credential
   * and the provider holds no key, the format's default key entries leave;
   * a keyless call (`ProviderSpec.apiKeyOptional`, no key stored) sends the
   * empty credential. The key store is read per request: a key stored or
   * removed later applies to the next call.
   */
  private withSpecAuth(
    baseHeaders: Record<string, string>,
    baseQuery: Record<string, string> | undefined,
  ): { headers: Record<string, string>; queryParams?: Record<string, string> } {
    const keyed = providerHasStoredApiKey(this.spec.id)
    const merged = mergeHeaders(baseHeaders, {
      ...(this.spec.userAgent ? { 'user-agent': this.spec.userAgent } : {}),
      ...this.spec.headers,
    })
    const query = baseQuery || this.spec.queryParams ? { ...baseQuery, ...this.spec.queryParams } : undefined
    const headerCarried = !keyed && !!this.codec.authCarriedByHeaders?.(merged)
    const headers = headerCarried ? withoutDefaultKeyHeaders(merged, this.spec.headers) : merged
    const queryParams = headerCarried ? withoutHeaderCarriedAuth(query, this.spec.queryParams) : query
    if (this.spec.apiKeyOptional && !keyed) return withoutApiKey(headers, queryParams)
    return { headers, ...(queryParams ? { queryParams } : {}) }
  }

  context(model: string): DriverRequestContext {
    return {
      providerId: this.spec.id,
      baseUrl: this.baseUrl,
      model,
      ...(this.spec.compat ? { compat: this.spec.compat } : {}),
    }
  }

  /** The HTTP request for one model call, spec applied over the codec. */
  buildRequest(payload: BridgeModelRequestPayload, model: string): DriverHttpRequest {
    const request = this.codec.buildRequest(wireToolNames(payload, this.spec.toolAliases), this.context(model))
    const url = this.spec.path
      ? withPath(`${this.baseUrl}/`, joinPath(this.baseUrl, this.spec.path))
      : request.url
    const { queryParams: _dropped, ...rest } = request
    return { ...rest, url, ...this.withSpecAuth(request.headers, request.queryParams) }
  }

  /** Where the codec carries ids in its JSON body (`ProviderDriver.idSites`);
   *  undefined for a codec whose wire has none. */
  get idSites(): ProviderDriver['idSites'] {
    const codec = this.codec
    if (!codec.idSites) return undefined
    return body => codec.idSites!(body, this.spec.compat)
  }

  /** Whether a response with this status is decoded as a stream. */
  isStreamStatus(status: number): boolean {
    return this.codec.isStreamStatus
      ? this.codec.isStreamStatus(status)
      : status >= 200 && status < 300
  }

  createDecoder(model: string): DriverResponseDecoder {
    return hostToolNames(this.codec.createDecoder(this.context(model)), this.spec.toolAliases)
  }

  errorFromResponse(
    response: Parameters<ProviderDriver['errorFromResponse']>[0],
  ): Extract<DriverStreamEvent, { type: 'error' }> {
    return this.codec.errorFromResponse(response)
  }

  /**
   * A non-model request relative to the base URL (the model listing, the key
   * probe, the usage document): the same URL rules, the format's auth
   * templates and the spec's headers / User-Agent / query as a model call,
   * without a body. Sent by `providerDocuments.ts`.
   */
  documentRequest(path: string): {
    url: string
    headers: Record<string, string>
    queryParams?: Record<string, string>
  } {
    const auth = this.codec.auth
    return { url: resolveRelativeUrl(this.baseUrl, path), ...this.withSpecAuth(auth.headers ?? {}, auth.queryParams) }
  }
}

/** `path` under `baseUrl`, keeping the base URL's own path
 *  (`/models` under `https://h/api/v1` → `https://h/api/v1/models`). */
export function resolveRelativeUrl(baseUrl: string, path: string): string {
  return withPath(`${baseUrl}/`, joinPath(baseUrl, path))
}

// `/v1/x` under `https://h/api` → `/api/v1/x`: the spec path is relative to
// the base URL's own path, as the codecs' default paths are.
function joinPath(baseUrl: string, path: string): string {
  const basePath = new URL(`${baseUrl}/`).pathname.replace(/\/+$/, '')
  return `${basePath}${path.startsWith('/') ? path : `/${path}`}`
}

/** Security: a spec reaches here from paths that do not all read its alias map
 *  (a session override), so the map is read again; an unusable one refuses the spec. */
function withCheckedToolAliases(spec: ProviderSpec): ProviderSpec {
  if (spec.toolAliases === undefined) return spec
  const { toolAliases, ...rest } = spec
  const read = readToolAliases(toolAliases)
  if (read.problem) throw new ProviderConfigError(`toolAliases for ${spec.id}: ${read.problem}`)
  return read.aliases ? { ...rest, toolAliases: { ...read.aliases } } : rest
}

export function createModelProvider(spec: ProviderSpec): ModelProvider {
  const codec = getProviderDriver(spec.format)
  if (!codec) throw new ProviderConfigError(`unknown wire format "${spec.format}" for ${spec.id}`)
  const baseUrl = (spec.baseUrl?.trim().replace(/\/+$/, '') || resolveDriverBaseUrl(spec.id))
  if (!baseUrl) throw new ProviderConfigError(`provider ${spec.id} has no base URL`)
  return new ModelProvider(withCheckedToolAliases(spec), codec, baseUrl)
}
