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

/** The format's own auth entries (those carrying the key) leave `queryParams`
 *  when the merged headers already carry the credential. */
function withoutHeaderCarriedAuth(
  codec: ProviderDriver,
  headers: Record<string, string>,
  queryParams: Record<string, string> | undefined,
  explicit: Record<string, string> | undefined,
): Record<string, string> | undefined {
  if (!queryParams || !codec.authCarriedByHeaders?.(headers)) return queryParams
  const out = Object.fromEntries(
    Object.entries(queryParams).filter(
      ([name, value]) => !value.includes(API_KEY_TEMPLATE) || (explicit !== undefined && name in explicit),
    ),
  )
  return Object.keys(out).length > 0 ? out : undefined
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

  /** No key is stored for a provider that may run without one. Read per
   *  request: a key stored or removed later applies to the next call. */
  private get keyless(): boolean {
    return !!this.spec.apiKeyOptional && !providerHasStoredApiKey(this.spec.id)
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
    const request = this.codec.buildRequest(payload, this.context(model))
    const url = this.spec.path
      ? withPath(`${this.baseUrl}/`, joinPath(this.baseUrl, this.spec.path))
      : request.url
    const headers = mergeHeaders(request.headers, {
      ...(this.spec.userAgent ? { 'user-agent': this.spec.userAgent } : {}),
      ...this.spec.headers,
    })
    const queryParams = withoutHeaderCarriedAuth(
      this.codec,
      headers,
      request.queryParams || this.spec.queryParams
        ? { ...request.queryParams, ...this.spec.queryParams }
        : undefined,
      this.spec.queryParams,
    )
    const { queryParams: _dropped, ...rest } = request
    if (this.keyless) return { ...rest, url, ...withoutApiKey(headers, queryParams) }
    return { ...rest, url, headers, ...(queryParams ? { queryParams } : {}) }
  }

  /** Where the codec carries ids in its JSON body (`ProviderDriver.idSites`);
   *  undefined for a codec whose wire has none. */
  get idSites(): ProviderDriver['idSites'] {
    return this.codec.idSites?.bind(this.codec)
  }

  /** Whether a response with this status is decoded as a stream. */
  isStreamStatus(status: number): boolean {
    return this.codec.isStreamStatus
      ? this.codec.isStreamStatus(status)
      : status >= 200 && status < 300
  }

  createDecoder(model: string): DriverResponseDecoder {
    return this.codec.createDecoder(this.context(model))
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
    const headers = mergeHeaders(auth.headers ?? {}, {
      ...(this.spec.userAgent ? { 'user-agent': this.spec.userAgent } : {}),
      ...this.spec.headers,
    })
    const queryParams = withoutHeaderCarriedAuth(
      this.codec,
      headers,
      auth.queryParams || this.spec.queryParams
        ? { ...auth.queryParams, ...this.spec.queryParams }
        : undefined,
      this.spec.queryParams,
    )
    const url = resolveRelativeUrl(this.baseUrl, path)
    if (this.keyless) return { url, ...withoutApiKey(headers, queryParams) }
    return { url, headers, ...(queryParams ? { queryParams } : {}) }
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

export function createModelProvider(spec: ProviderSpec): ModelProvider {
  const codec = getProviderDriver(spec.format)
  if (!codec) throw new ProviderConfigError(`unknown wire format "${spec.format}" for ${spec.id}`)
  const baseUrl = (spec.baseUrl?.trim().replace(/\/+$/, '') || resolveDriverBaseUrl(spec.id))
  if (!baseUrl) throw new ProviderConfigError(`provider ${spec.id} has no base URL`)
  return new ModelProvider(spec, codec, baseUrl)
}
