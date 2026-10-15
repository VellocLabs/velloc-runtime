/**
 * A provider's non-model documents — its model listing, its key probe, its
 * usage / balance — fetched over the host's `model.rawStream*` (the host
 * substitutes the stored key and keeps the request on the provider's domain)
 * and read by the provider's OWN parser (its directory's `models.ts` /
 * `usage.ts`, exported on its `ProviderDefinition`). Provider-neutral: nothing
 * here knows any provider's field names or paths.
 */
import type { BrowserBridgeTransport } from '../../browser/bridge/browserBridgeProtocol'
import {
  openRawProviderStream,
  RawProviderStreamError,
} from '../../browser/bridge/rawProviderStream'
import { getProviderDefinition } from '../../config/nexusModelConfig/providers'
import type {
  ProviderDocumentSource,
  ProviderModelInfo,
  ProviderVerifyResult,
} from '../../config/nexusModelConfig/providerDefinition'
import type { PlanUsageAmount, PlanUsageSnapshot } from '../usage/planUsage'
import { traceLine } from '../../utils/debugLog'
// A provider with a runtime wire builds its request through its codec.
import './builtinDrivers'
import { extractApiErrorMessage } from './hostCallOptions'
import { createModelProvider, mergeHeaders, ProviderConfigError } from './modelProvider'
import { resolveProviderSpec } from './driverRegistry'

/** A listing is a few hundred KB (OpenRouter: ~0.8 MB for 464 models). */
const MAX_DOCUMENT_BYTES = 8 * 1024 * 1024

function documentRequest(providerId: string, path: string) {
  // The catalog wire only: a per-session override is a test seam for model
  // calls, not a different provider. A provider with documents speaks a
  // wire, so its documents carry its codec's auth and its spec's headers.
  const spec = resolveProviderSpec(providerId)
  if (!spec) throw new ProviderConfigError(`provider ${providerId} has no runtime wire`)
  return createModelProvider(spec).documentRequest(path)
}

type DocumentRequest = ReturnType<typeof documentRequest>

/**
 * The request minus every header / query value that substitutes a secret. The
 * host refuses a `{{secret:…}}` template with no key stored
 * (`SECRET_UNAVAILABLE`), and a provider may 401 a junk key even on a public
 * document — so a document that needs no key is asked for without one.
 */
function withoutSecrets(request: DocumentRequest): DocumentRequest {
  const keep = (map: Record<string, string>) =>
    Object.fromEntries(Object.entries(map).filter(([, value]) => !value.includes('{{secret:')))
  const queryParams = request.queryParams ? keep(request.queryParams) : undefined
  return {
    url: request.url,
    headers: keep(request.headers),
    ...(queryParams && Object.keys(queryParams).length > 0 ? { queryParams } : {}),
  }
}

/** One GET, read whole. A transport refusal rejects (`RawProviderStreamError`). */
export async function getProviderDocument(
  transport: BrowserBridgeTransport,
  providerId: string,
  path: string,
  options: {
    signal?: AbortSignal
    maxBytes?: number
    anonymous?: boolean
    /** Over the request's own headers (`ProviderDocumentSource.headers`). */
    headers?: Record<string, string>
  } = {},
): Promise<{ status: number; bodyText: string }> {
  const request = options.anonymous
    ? withoutSecrets(documentRequest(providerId, path))
    : documentRequest(providerId, path)
  const stream = await openRawProviderStream(transport, {
    providerId,
    url: request.url,
    method: 'GET',
    headers: mergeHeaders(request.headers, options.headers),
    ...(request.queryParams ? { queryParams: request.queryParams } : {}),
    maxResponseBytes: options.maxBytes ?? MAX_DOCUMENT_BYTES,
    ...(options.signal ? { signal: options.signal } : {}),
  })
  const decoder = new TextDecoder()
  let bodyText = ''
  for await (const bytes of stream.body) bodyText += decoder.decode(bytes, { stream: true })
  return { status: stream.status, bodyText: bodyText + decoder.decode() }
}

/** A document request the provider answered with a non-2xx status. */
class DocumentHttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message)
  }
}

/** A 2xx JSON document, else a rejection naming the status / problem. */
async function getJson(
  transport: BrowserBridgeTransport,
  providerId: string,
  path: string,
  options: { signal?: AbortSignal; anonymous?: boolean; headers?: Record<string, string> } = {},
): Promise<unknown> {
  const { status, bodyText } = await getProviderDocument(transport, providerId, path, options)
  if (status < 200 || status >= 300) {
    throw new DocumentHttpError(status, `HTTP ${status}: ${extractApiErrorMessage(bodyText) || 'request failed'}`)
  }
  try {
    return JSON.parse(bodyText) as unknown
  } catch {
    throw new Error(`${path} did not answer with JSON`)
  }
}

/**
 * The provider's models, normalized by its own listing parser. Rejects when
 * the provider lists no models, the request fails, or the body is not a
 * listing — never answers a failure with `[]`, so a caller can tell "the
 * provider offers nothing" from "we could not find out".
 */
export async function listProviderModels(
  transport: BrowserBridgeTransport,
  providerId: string,
  options: { signal?: AbortSignal; now?: number } = {},
): Promise<ProviderModelInfo[]> {
  const definition = getProviderDefinition(providerId)
  // A provider mod's listing is its module's answer, not a document.
  if (definition?.codeListing) return definition.codeListing.list(transport, providerId, options)
  const source = definition?.models
  if (!source) throw new ProviderConfigError(`provider ${providerId} lists no models`)
  // A public listing (a gateway's) is read without the key, so the list
  // opens before any key is entered; a vendor's own listing needs it.
  const document = await getJson(transport, providerId, source.path, {
    ...options,
    anonymous: source.public === true,
  })
  return source.parse(document, options.now ?? Date.now())
}

/**
 * Does the STORED key work? A GET on the definition's probe path (else its
 * listing), judged by status alone: 2xx = valid, 401 / 403 = the key is
 * wrong. Never rejects.
 */
export async function verifyProvider(
  transport: BrowserBridgeTransport,
  providerId: string,
  options: { signal?: AbortSignal } = {},
): Promise<ProviderVerifyResult> {
  const definition = getProviderDefinition(providerId)
  const core = () => probeStoredKey(transport, providerId, options)
  // A provider mod's own check, when its module has one; else the core probe.
  if (definition?.codeListing?.verify) {
    return definition.codeListing.verify(transport, providerId, { ...options, core })
  }
  return core()
}

/** The core probe: a GET of the probe (else listing) path with the stored key. */
async function probeStoredKey(
  transport: BrowserBridgeTransport,
  providerId: string,
  options: { signal?: AbortSignal },
): Promise<ProviderVerifyResult> {
  const definition = getProviderDefinition(providerId)
  const path = definition?.verify?.path ?? definition?.models?.path ?? '/models'
  try {
    const { status, bodyText } = await getProviderDocument(transport, providerId, path, {
      ...options,
      maxBytes: 1024 * 1024,
    })
    if (status >= 200 && status < 300) return { ok: true }
    return {
      ok: false,
      code:
        status === 401 ? 'auth_unauthorized'
        : status === 403 ? 'auth_forbidden'
        : 'system_unexpected',
      message: extractApiErrorMessage(bodyText) || `HTTP ${status}`,
      httpStatus: status,
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    if (error instanceof RawProviderStreamError) {
      // No key stored yet — the same verdict as a 401.
      if (error.code === 'SECRET_UNAVAILABLE') return { ok: false, code: 'auth_unauthorized', message }
      if (error.code === 'TIMEOUT') return { ok: false, code: 'network_timeout', message }
      if (error.code === 'NETWORK_ERROR') return { ok: false, code: 'network_unreachable', message }
    }
    return { ok: false, code: 'system_unexpected', message }
  }
}

/** Whether the provider reports usage at all (its definition has a source). */
export function reportsUsage(providerId: string | undefined): boolean {
  const definition = getProviderDefinition(providerId)
  if (definition?.codeListing?.usage) return definition.codeListing.usage.reports()
  return !!definition?.usage
}

/**
 * The provider's usage / balance, read by its own parser. Undefined when the
 * provider reports none or its document yields nothing; rejects when the
 * request fails.
 */
export async function fetchProviderUsage(
  transport: BrowserBridgeTransport,
  providerId: string,
  options: { signal?: AbortSignal; now?: number } = {},
): Promise<PlanUsageSnapshot | undefined> {
  const definition = getProviderDefinition(providerId)
  // A provider mod's usage is its module's answer, not a document.
  if (definition?.codeListing?.usage) return definition.codeListing.usage.fetch(transport, providerId, options)
  const source = definition?.usage
  if (!source) return undefined
  const now = options.now ?? Date.now()
  const document = await getJson(transport, providerId, source.path, {
    ...options,
    ...(source.headers ? { headers: source.headers } : {}),
  })
  const usage = source.parse(document, now)
  if (!definition.balance) return usage
  const balance = await readBalance(transport, providerId, definition.balance, { ...options, now })
  const base: PlanUsageSnapshot = usage ?? { windows: [] }
  if ('note' in balance) return { ...base, balanceNote: balance.note }
  // The balance leads: it is what pays, and a key's cap must not read as it.
  return { ...base, amounts: [...balance.amounts, ...(base.amounts ?? [])] }
}

/**
 * The account balance, or why there is none. Never rejects on a failed read (an abort
 * propagates). Only a 401 / 403 reads as `unavailable`; a transient failure leaves
 * the balance out of this snapshot.
 */
async function readBalance(
  transport: BrowserBridgeTransport,
  providerId: string,
  source: ProviderDocumentSource<PlanUsageAmount[]>,
  options: { signal?: AbortSignal; now: number },
): Promise<{ amounts: PlanUsageAmount[] } | { note: 'needs_key' | 'unavailable' }> {
  try {
    const document = await getJson(transport, providerId, source.path, {
      ...(options.signal ? { signal: options.signal } : {}),
      ...(source.headers ? { headers: source.headers } : {}),
    })
    return { amounts: source.parse(document, options.now) }
  } catch (error) {
    // The host refuses a `{{secret:…}}` it holds no value for — the user
    // stored no credential for the balance. Expected, not a failure.
    if (error instanceof RawProviderStreamError && error.code === 'SECRET_UNAVAILABLE') {
      return { note: 'needs_key' }
    }
    if (options.signal?.aborted) throw error
    const message = error instanceof Error ? error.message : String(error)
    traceLine(`[providers] balance fetch failed provider=${providerId}: ${message}`, {
      level: 'warn',
    })
    const refused = error instanceof DocumentHttpError && (error.status === 401 || error.status === 403)
    return refused ? { note: 'unavailable' } : { amounts: [] }
  }
}
