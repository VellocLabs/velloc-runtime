/**
 * Contract: the provider request seam (F-27), between the codec and the send, in a
 * fixed order: request → sign → send → retry. `request` may change the URL only
 * within the provider's own origin, set or remove headers, patch the JSON body and
 * set the idle timeout; `sign` sees the final request (body as SHA-256) and may only
 * ADD headers; `retry` is raised at most once, for a non-2xx before the stream.
 * Credentials: a near-expiry token is refreshed first; a 401 refreshes once and
 * re-sends once; a request is sent at most twice in all. Security: a `request` /
 * `sign` hook that throws, answers malformed or overruns its budget FAILS CLOSED
 * (not sent). What crosses to the hooks is opt-in (`requestNeeds`, `signNeeds`).
 */
import type { BridgeModelRequestContext } from '../../browser/bridge/browserBridgeProtocol'
import type { DriverHttpRequest, DriverStreamEvent, ProviderDriver } from './driverTypes'
import { mergeHeaders } from './modelProvider'
import {
  holdRequestBody,
  restoreRequestBody,
  type ProviderRequestNeed,
} from '../../mods/provider/providerRequestNeeds'
import type { ContextIds, DecodeIds, ProviderIdMapper } from '../../mods/provider/ids/idMapper'

/** A hook's budget, ms, from the seam being ready. */
export const PROVIDER_HOOK_BUDGET_MS = 2_000

export type ProviderRequestContext = BridgeModelRequestContext & {
  /** Fresh for every send, the re-send `retry` asked for included. */
  requestId: string
  /** 1 for the first send of this request, 2 for the re-send. */
  attempt: number
  nowMs: number
  /** `requestNeeds` `cwd`: the absolute working directory of the session the
   *  request belongs to (the top-level session's). Absent without the need,
   *  and for a session with none. */
  cwd?: string
  /** The `session` and `request` ids the provider's `ids` rules made - for headers. Absent for a provider with no such rule. */
  ids?: ContextIds
}

/** The small request facts every `request` hook gets. */
export type ProviderRequestEvent = {
  provider: string
  model: string
  /** The wire format the request was built for. */
  format: string
  method: string
  url: string
  /** As built: `{{secret:NAME}}` templates are still templates. */
  headers: Record<string, string>
  /** The thinking tier of the call, in the runtime's vocabulary
   *  (none / minimal / low / medium / high / extra-high / max); absent when
   *  the request has none. The hook maps it to its wire fields. */
  effort?: string
  maxOutputTokens?: number
  locale?: string
  /** `requestNeeds` `system`: the system prompt as sent. */
  system?: string
  /** `requestNeeds` `tools`: the tool definitions as sent. */
  tools?: unknown[]
  /** `requestNeeds` `body`: the codec's JSON body, binary parts held as
   *  `{ kind, bytes, ref }`. */
  body?: unknown
  context: ProviderRequestContext
}

/** One JSON Pointer (RFC 6901) edit of the codec's JSON body. */
export type ProviderBodyPatch = {
  op: 'set' | 'remove'
  path: string
  value?: unknown
}

export type ProviderRequestAnswer = {
  url?: string
  /** Set these headers; an empty value removes one. */
  headers?: Record<string, string>
  /** Replaces the system prompt (the request is built again from it). */
  system?: string
  /** Replaces the tool definitions (likewise). */
  tools?: unknown[]
  /** Edits of the body; with `body` declared they address the body as the
   *  hook saw it, placeholders in place, and may not be combined with
   *  `system` / `tools`. */
  patch?: readonly ProviderBodyPatch[]
  /** The whole body — only from a provider that declared `body`; exclusive
   *  with `system`, `tools` and `patch`. Placeholders are restored. */
  body?: unknown
  idleTimeoutMs?: number
}

export type ProviderSignEvent = {
  provider: string
  method: string
  url: string
  headers: Record<string, string>
  /** Lowercase hex SHA-256 of the body bytes that will be sent. */
  bodySha256: string
  bodyLength: number
  /** `signNeeds: 'body'`: the bytes that will be sent. */
  body?: Uint8Array
  context: ProviderRequestContext
}

/** Headers to add; a header the request already has is refused. */
export type ProviderSignAnswer = { headers: Record<string, string> }

export type ProviderRetryEvent = {
  provider: string
  status: number
  headers: Record<string, string>
  bodyText: string
  /** The request that was refused, as sent. */
  request: {
    method: string
    url: string
    headers: Record<string, string>
    /** `requestNeeds` `body`: the refused request's codec JSON, parts held. */
    body?: unknown
  }
  attempt: number
  context: ProviderRequestContext
}

export type ProviderRetryAnswer = {
  retry: {
    headers?: Record<string, string>
    patch?: readonly ProviderBodyPatch[]
    /** The whole body — only from a provider that declared `body`. */
    body?: unknown
  }
}

type Maybe<T> = T | undefined | Promise<T | undefined>

/** A token this close to its expiry (ms) is refreshed before the request goes out. */
export const EXPIRY_MARGIN_MS = 60_000

/** The sentence a request ends with when the sign-in no longer works. */
export const SIGN_IN_AGAIN_MESSAGE = 'Your sign-in to this provider has ended. Sign in again in Settings to continue'

/** The provider's sign-in is over (the refresh failed or said so): the request
 *  is not sent again, and the person must sign in. */
export class ProviderSignInRequiredError extends Error {
  constructor() {
    super(SIGN_IN_AGAIN_MESSAGE)
    this.name = 'ProviderSignInRequiredError'
  }
}

/** What the request flow uses to keep a signed-in provider's token fresh. */
export interface ProviderSeamCredentials {
  /** When the stored token stops working (epoch ms), if known. */
  tokenExpiresAt(): number | undefined
  /** Changes whenever the stored token is replaced. */
  epoch(): number
  /**
   * Refresh the token, single-flight across requests. `since` is the epoch the
   * refused request was sent under: a token replaced since needs no new call.
   * Resolves `'refreshed'` or `'unhooked'` (the module cannot refresh);
   * rejects `ProviderSignInRequiredError` when the sign-in is over.
   */
  refresh(reason: 'expiry' | 'unauthorized', since: number | undefined, signal: AbortSignal): Promise<'refreshed' | 'unhooked'>
}

/** What a provider plugs in. Every hook is optional; an absent one is not raised. */
export interface ProviderRequestSeam {
  /** Resolves once the seam can answer (a worker started). Not budgeted. */
  whenReady?(signal: AbortSignal): Promise<void>
  /** `signal` aborts when the stream is cancelled. */
  request?(e: ProviderRequestEvent, signal?: AbortSignal): Maybe<ProviderRequestAnswer>
  sign?(e: ProviderSignEvent, signal?: AbortSignal): Maybe<ProviderSignAnswer>
  retry?(e: ProviderRetryEvent, signal?: AbortSignal): Maybe<ProviderRetryAnswer>
  /** What `request` (and `retry`) ask to see beyond the small facts. */
  requestNeeds?: readonly ProviderRequestNeed[]
  /** `'body'`: `sign` gets the body bytes, not only their digest. */
  signNeeds?: 'body'
  /** Per-hook budget, ms. Absent = `PROVIDER_HOOK_BUDGET_MS`. */
  budgetMs?: number
  /** The provider's id mapper (mods/provider/ids): maps the ids of the built
   *  request before `request` runs, makes `context.ids`, and decodes the ids a
   *  response carries. Absent = the provider has no `ids` rules; nothing is
   *  collected or allocated. */
  ids?: ProviderIdMapper
  /** A provider that signs in (and whose module refreshes). Read when a
   *  request is about to go out; absent = no refresh, no 401 recovery. */
  readonly credentials?: ProviderSeamCredentials
}

// ── registry ────────────────────────────────────────────────────────────────

const seams = new Map<string, ProviderRequestSeam>()

/** Plug `seam` in for `providerId`; returns the unplug (a no-op once
 *  another seam replaced it). */
export function registerProviderRequestSeam(
  providerId: string,
  seam: ProviderRequestSeam,
): () => void {
  seams.set(providerId, seam)
  return () => {
    if (seams.get(providerId) === seam) seams.delete(providerId)
  }
}

export function providerRequestSeamFor(providerId: string): ProviderRequestSeam | undefined {
  return seams.get(providerId)
}

/** Test hook. */
export function resetProviderRequestSeams(): void {
  seams.clear()
}

// ── body patches ────────────────────────────────────────────────────────────

export class ProviderBodyPatchError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ProviderBodyPatchError'
  }
}

function pointerTokens(path: string): string[] {
  if (path === '') return []
  if (!path.startsWith('/')) throw new ProviderBodyPatchError(`not a JSON Pointer: "${path}"`)
  return path.slice(1).split('/').map(token => token.replace(/~1/g, '/').replace(/~0/g, '~'))
}

function isContainer(value: unknown): value is Record<string, unknown> | unknown[] {
  return typeof value === 'object' && value !== null
}

function arrayIndex(array: unknown[], token: string, path: string, allowEnd: boolean): number {
  if (allowEnd && token === '-') return array.length
  if (!/^(0|[1-9]\d*)$/.test(token)) throw new ProviderBodyPatchError(`bad array index "${token}" in ${path}`)
  const index = Number(token)
  if (index > array.length || (!allowEnd && index === array.length)) {
    throw new ProviderBodyPatchError(`array index ${index} out of range in ${path}`)
  }
  return index
}

/** The container holding the pointer's last token; undefined when a step is missing. */
function parentOf(root: unknown, tokens: string[]): unknown {
  let node = root
  for (const token of tokens.slice(0, -1)) {
    if (Array.isArray(node)) {
      if (!/^(0|[1-9]\d*)$/.test(token) || Number(token) >= node.length) return undefined
      node = node[Number(token)]
    } else if (isContainer(node)) {
      if (!Object.prototype.hasOwnProperty.call(node, token)) return undefined
      node = (node as Record<string, unknown>)[token]
    } else {
      return undefined
    }
  }
  if (!isContainer(node)) return undefined
  return node
}

/**
 * Apply `ops` in order to `root` (edited in place); a `set` of `""` replaces the
 * root. `set` needs an existing parent (on an array: index replaces, length or `-`
 * appends); `remove` of an absent path is a no-op; the root cannot be removed.
 */
export function applyBodyPatch(root: unknown, ops: readonly ProviderBodyPatch[]): unknown {
  let doc = root
  for (const op of ops) {
    if (!op || typeof op !== 'object' || typeof op.path !== 'string') {
      throw new ProviderBodyPatchError('a patch operation needs a string path')
    }
    const tokens = pointerTokens(op.path)
    if (op.op === 'set') {
      if (!('value' in op) || op.value === undefined) {
        throw new ProviderBodyPatchError(`set ${op.path} has no value`)
      }
      const value = cloneJson(op.value, op.path)
      if (tokens.length === 0) {
        doc = value
        continue
      }
      const parent = parentOf(doc, tokens)
      if (parent === undefined) throw new ProviderBodyPatchError(`set ${op.path}: its parent does not exist`)
      const last = tokens[tokens.length - 1]!
      if (Array.isArray(parent)) {
        const index = arrayIndex(parent, last, op.path, true)
        if (index === parent.length) parent.push(value)
        else parent[index] = value
      } else {
        // An own data property even for `__proto__`: never a prototype write.
        Object.defineProperty(parent, last, { value, enumerable: true, writable: true, configurable: true })
      }
    } else if (op.op === 'remove') {
      if (tokens.length === 0) throw new ProviderBodyPatchError('the body itself cannot be removed')
      const parent = parentOf(doc, tokens)
      if (parent === undefined) continue
      const last = tokens[tokens.length - 1]!
      if (Array.isArray(parent)) {
        if (/^(0|[1-9]\d*)$/.test(last) && Number(last) < parent.length) parent.splice(Number(last), 1)
      } else if (Object.prototype.hasOwnProperty.call(parent, last)) {
        delete (parent as Record<string, unknown>)[last]
      }
    } else {
      throw new ProviderBodyPatchError(`unknown patch op "${String((op as { op?: unknown }).op)}"`)
    }
  }
  return doc
}

function cloneJson(value: unknown, path: string): unknown {
  try {
    return JSON.parse(JSON.stringify(value))
  } catch {
    throw new ProviderBodyPatchError(`set ${path}: the value is not JSON`)
  }
}

/** The body bytes with `ops` applied: decoded as JSON, patched, re-serialized. */
export function patchBodyBytes(body: Uint8Array, ops: readonly ProviderBodyPatch[]): Uint8Array {
  if (ops.length === 0) return body
  let json: unknown
  try {
    json = JSON.parse(new TextDecoder().decode(body))
  } catch {
    throw new ProviderBodyPatchError('the request body is not JSON, so it cannot be patched')
  }
  return new TextEncoder().encode(JSON.stringify(applyBodyPatch(json, ops)))
}

// ── hook calls ──────────────────────────────────────────────────────────────

export type ProviderHookName = 'request' | 'sign' | 'retry' | 'ids'

/** A hook failed, overran or answered something unusable; the request is not sent. */
export class ProviderHookError extends Error {
  constructor(
    readonly hook: ProviderHookName,
    readonly providerId: string,
    reason: string,
  ) {
    super(`The ${hook} hook of the provider ${providerId} failed, so the request was not sent: ${reason}`)
    this.name = 'ProviderHookError'
  }
}

class HookAborted extends Error {}

function untilAborted(signal: AbortSignal): { promise: Promise<never>; dispose: () => void } {
  let onAbort: () => void = () => {}
  const promise = new Promise<never>((_, reject) => {
    onAbort = () => reject(new HookAborted('aborted'))
    if (signal.aborted) onAbort()
    else signal.addEventListener('abort', onAbort, { once: true })
  })
  promise.catch(() => {})
  return { promise, dispose: () => signal.removeEventListener('abort', onAbort) }
}

async function callHook<T>(
  seam: ProviderRequestSeam,
  hook: ProviderHookName,
  providerId: string,
  signal: AbortSignal,
  run: () => Maybe<T>,
): Promise<T | undefined> {
  const aborted = untilAborted(signal)
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    if (seam.whenReady) {
      try {
        await Promise.race([seam.whenReady(signal), aborted.promise])
      } catch (error) {
        if (error instanceof HookAborted) throw error
        throw new ProviderHookError(hook, providerId, `not ready (${reasonOf(error)})`)
      }
    }
    const budgetMs = seam.budgetMs ?? PROVIDER_HOOK_BUDGET_MS
    const overrun = new Promise<never>((_, reject) => {
      timer = setTimeout(
        () => reject(new ProviderHookError(hook, providerId, `no answer within ${budgetMs} ms`)),
        budgetMs,
      )
    })
    try {
      return await Promise.race([Promise.resolve().then(run), overrun, aborted.promise])
    } catch (error) {
      if (error instanceof HookAborted || error instanceof ProviderHookError) throw error
      throw new ProviderHookError(hook, providerId, reasonOf(error))
    }
  } finally {
    clearTimeout(timer)
    aborted.dispose()
  }
}

function reasonOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function isAbort(error: unknown): boolean {
  return error instanceof HookAborted
}

// ── answers ─────────────────────────────────────────────────────────────────

function stringRecord(value: unknown, what: string): Record<string, string> | undefined {
  if (value === undefined) return undefined
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${what} is not an object`)
  for (const [name, item] of Object.entries(value)) {
    if (typeof item !== 'string') throw new Error(`${what}.${name} is not a string`)
  }
  return value as Record<string, string>
}

function patchList(value: unknown): readonly ProviderBodyPatch[] | undefined {
  if (value === undefined) return undefined
  if (!Array.isArray(value)) throw new Error('patch is not a list')
  return value as ProviderBodyPatch[]
}

/** `url` must stay on the base URL's origin (scheme, host and port). */
export function checkSeamUrl(url: string, baseUrl: string): string {
  let next: URL
  try {
    next = new URL(url)
  } catch {
    throw new Error(`"${url}" is not an absolute URL`)
  }
  const base = new URL(baseUrl)
  if (next.protocol !== base.protocol || next.host !== base.host) {
    throw new Error(`${next.origin} is outside the provider's origin ${base.origin}`)
  }
  return next.toString()
}

function hex(bytes: ArrayBuffer): string {
  return Array.from(new Uint8Array(bytes), byte => byte.toString(16).padStart(2, '0')).join('')
}

export async function sha256Hex(body: Uint8Array): Promise<string> {
  return hex(await crypto.subtle.digest('SHA-256', body as unknown as ArrayBuffer))
}

function newRequestId(): string {
  return crypto.randomUUID()
}

// ── the flow one stream runs ────────────────────────────────────────────────

/** A request ready to send, and what a re-send starts from. */
export type PreparedProviderRequest = {
  request: DriverHttpRequest
  /** The request before `sign`: a re-send is signed afresh from here. */
  unsigned: DriverHttpRequest
  idleTimeoutMs?: number
  context: ProviderRequestContext
}

/** Pieces of the request the codec built from, so a hook that declared
 *  `system` / `tools` can see them and have them replaced. */
export type ProviderRequestParts = {
  /** The system prompt as the codec sends it. */
  system(): string
  /** The tool definitions as the codec sends them. */
  tools(): unknown[]
  /** The request built again with these parts replaced. */
  rebuild(over: { system?: string; tools?: unknown[] }): DriverHttpRequest
}

export type ProviderRequestFacts = {
  provider: string
  model: string
  format: string
  baseUrl: string
  maxOutputTokens?: number
  /** The call's thinking tier (the runtime's vocabulary); becomes `effort`. */
  thinkingTier?: string
  requestContext?: BridgeModelRequestContext
  /** The session's working directory; set only for a seam that declared `cwd`. */
  cwd?: string
  parts?: ProviderRequestParts
  /** The codec's `idSites`: where the body carries ids, for the id mapper. */
  idSites?: ProviderDriver['idSites']
}

/**
 * The thinking tier a payload carries for the seam (`thinkingTier`, set by
 * the runtime's request builder next to `providerBodyExtension`): the tier
 * actually sent, in the runtime's vocabulary. Not part of the wire payload —
 * no codec reads it.
 */
export function thinkingTierOf(payload: object): string | undefined {
  const tier = (payload as { thinkingTier?: unknown }).thinkingTier
  return typeof tier === 'string' && tier !== '' ? tier : undefined
}

const NO_REQUEST_CONTEXT: BridgeModelRequestContext = { purpose: 'other', querySource: '' }

/** What a hook answered about the body, applied to the body's bytes. */
type BodyEdit = {
  patch?: readonly ProviderBodyPatch[]
  body?: unknown
}

/**
 * The bytes after `edit`. Without `body` declared this is `patchBodyBytes`
 * and nothing more. With it, the hook saw the body with its binary parts held,
 * so a patch addresses that view and a whole `body` is that view's
 * replacement; either way the placeholders are restored from the request's own
 * parts, and one naming a part the request never gave refuses the edit.
 */
function editBody(body: Uint8Array, edit: BodyEdit, sawBody: boolean): Uint8Array {
  if (edit.body !== undefined) {
    if (!sawBody) throw new Error('body is only for a provider that declared requestNeeds "body"')
    if (edit.patch) throw new Error('body and patch cannot both be answered')
    const { held } = holdRequestBody(body)
    return new TextEncoder().encode(JSON.stringify(restoreRequestBody(edit.body, held)))
  }
  if (!edit.patch || edit.patch.length === 0) return body
  if (!sawBody) return patchBodyBytes(body, edit.patch)
  const { view, held } = holdRequestBody(body)
  return new TextEncoder().encode(JSON.stringify(restoreRequestBody(applyBodyPatch(view, edit.patch), held)))
}

/** One stream's walk through a seam. `prepare` and `retryAfter` reject
 *  with `ProviderHookError` (fail closed) or, once `signal` aborts, with an
 *  abort the caller recognises by `signal.aborted`. */
export class ProviderRequestFlow {
  private attempt = 0
  private decode: DecodeIds | undefined
  /** The one re-send of this request has been spent (a refresh's or a retry's). */
  private resent = false
  /** The token epoch the request in flight was sent under. */
  private sentEpoch: number | undefined

  constructor(
    private readonly seam: ProviderRequestSeam,
    private readonly facts: ProviderRequestFacts,
    private readonly signal: AbortSignal,
  ) {}

  private nextContext(): ProviderRequestContext {
    this.attempt += 1
    return {
      ...(this.facts.requestContext ?? NO_REQUEST_CONTEXT),
      ...(this.facts.cwd !== undefined ? { cwd: this.facts.cwd } : {}),
      requestId: newRequestId(),
      attempt: this.attempt,
      nowMs: Date.now(),
    }
  }

  private call<T>(hook: ProviderHookName, run: () => Maybe<T>): Promise<T | undefined> {
    return callHook(this.seam, hook, this.facts.provider, this.signal, run)
  }

  /** Decodes the ids in a response's events back to the engine's; undefined
   *  when nothing is mapped (the stream host then does nothing per chunk). */
  idDecoder(): ((events: DriverStreamEvent[]) => DriverStreamEvent[]) | undefined {
    return this.decode
  }

  /**
   * The id mapper's pass over a built request (and `context.ids` for the
   * attempt). `bodyOnly` is the request built again after a hook replaced its
   * system prompt or tools: its ids map again (all cache hits), the attempt's
   * `context.ids` stays as the hook saw it.
   */
  private async mapIds(built: DriverHttpRequest, context: ProviderRequestContext, bodyOnly = false): Promise<DriverHttpRequest> {
    const mapper = this.seam.ids
    if (!mapper) return built
    const sessionId = this.facts.requestContext?.sessionId
    try {
      const prepared = await mapper.prepare({
        ...(sessionId ? { sessionId } : {}),
        request: built,
        ...(this.facts.idSites ? { idSites: this.facts.idSites } : {}),
        context: { ...context },
        requestId: context.requestId,
        nowMs: context.nowMs,
        signal: this.signal,
        bodyOnly,
      })
      if (!bodyOnly) {
        if (prepared.ids.session !== undefined || prepared.ids.request !== undefined) context.ids = prepared.ids
        this.decode = prepared.decode
      }
      return prepared.request
    } catch (error) {
      if (this.signal.aborted) throw error
      throw new ProviderHookError('ids', this.facts.provider, reasonOf(error))
    }
  }

  /** A new attempt's `context.ids` (the request id is new; the session's is cached). */
  private async attachContextIds(context: ProviderRequestContext): Promise<void> {
    const mapper = this.seam.ids
    if (!mapper) return
    const sessionId = this.facts.requestContext?.sessionId
    const ids = await mapper.contextIds({
      ...(sessionId ? { sessionId } : {}),
      context: { ...context },
      requestId: context.requestId,
      nowMs: context.nowMs,
      signal: this.signal,
    })
    if (ids.session !== undefined || ids.request !== undefined) context.ids = ids
  }

  private needs(need: ProviderRequestNeed): boolean {
    return this.seam.requestNeeds?.includes(need) === true
  }

  /** `request`, then `sign`. */
  async prepare(built: DriverHttpRequest): Promise<PreparedProviderRequest> {
    await this.refreshIfExpiring()
    const context = this.nextContext()
    // The id mapper runs first: the `request` hook sees the ids as they will
    // be sent, and `sign` signs them.
    built = await this.mapIds(built, context)
    let unsigned = built
    let idleTimeoutMs: number | undefined
    const requestHook = this.seam.request
    if (requestHook) {
      const answer = await this.call('request', () =>
        requestHook.call(this.seam, this.requestEvent(built, context), this.signal),
      )
      try {
        const applied = await this.applyRequestAnswer(built, answer, context)
        unsigned = applied.request
        idleTimeoutMs = applied.idleTimeoutMs
      } catch (error) {
        if (error instanceof ProviderHookError || this.signal.aborted) throw error
        throw new ProviderHookError('request', this.facts.provider, reasonOf(error))
      }
    }
    const request = await this.signed(unsigned, context)
    return { request, unsigned, ...(idleTimeoutMs !== undefined ? { idleTimeoutMs } : {}), context }
  }

  private requestEvent(built: DriverHttpRequest, context: ProviderRequestContext): ProviderRequestEvent {
    const event: ProviderRequestEvent = {
      provider: this.facts.provider,
      model: this.facts.model,
      format: this.facts.format,
      method: built.method ?? 'POST',
      url: built.url,
      headers: { ...built.headers },
      ...(this.facts.thinkingTier ? { effort: this.facts.thinkingTier } : {}),
      ...(this.facts.maxOutputTokens !== undefined ? { maxOutputTokens: this.facts.maxOutputTokens } : {}),
      context,
    }
    const needed = this.seam.requestNeeds
    if (needed && needed.length > 0) {
      const parts = this.facts.parts
      if ((needed.includes('system') || needed.includes('tools')) && !parts) {
        throw new Error('this request cannot show its system prompt or tools')
      }
      if (needed.includes('system')) event.system = parts!.system()
      if (needed.includes('tools')) event.tools = parts!.tools()
      if (needed.includes('body')) event.body = holdRequestBody(built.body).view
    }
    return event
  }

  /** Refresh first when the stored token is (nearly) out of time. */
  private async refreshIfExpiring(): Promise<void> {
    const credentials = this.seam.credentials
    if (!credentials) {
      this.sentEpoch = undefined
      return
    }
    const expiresAt = credentials.tokenExpiresAt()
    if (expiresAt !== undefined && expiresAt - Date.now() <= EXPIRY_MARGIN_MS) {
      await credentials.refresh('expiry', undefined, this.signal)
    }
    this.sentEpoch = credentials.epoch()
  }

  /**
   * A non-2xx before the stream: a 401 from a refreshing provider refreshes once
   * (single-flight) and re-sends, else the `retry` hook's re-send. At most one
   * re-send in all; a refresh that cannot be done rejects
   * `ProviderSignInRequiredError`.
   */
  async recoverAfter(
    response: { status: number; headers: Record<string, string>; bodyText: string },
    sent: PreparedProviderRequest,
  ): Promise<PreparedProviderRequest | undefined> {
    const credentials = this.seam.credentials
    if (response.status === 401 && credentials && !this.resent) {
      const outcome = await credentials.refresh('unauthorized', this.sentEpoch, this.signal)
      if (outcome === 'refreshed') {
        this.resent = true
        this.sentEpoch = credentials.epoch()
        const context = this.nextContext()
        // The ids are already mapped in `unsigned`; only the attempt's context is new.
        await this.attachContextIds(context)
        const request = await this.signed(sent.unsigned, context)
        return { request, unsigned: sent.unsigned, ...(sent.idleTimeoutMs !== undefined ? { idleTimeoutMs: sent.idleTimeoutMs } : {}), context }
      }
    }
    return this.retryAfter(response, sent)
  }

  /**
   * A non-2xx before the stream: the re-send `retry` asks for, or undefined
   * (no hook, already retried, no answer, or any failure — the response's
   * error then goes on exactly as without a seam).
   */
  async retryAfter(
    response: { status: number; headers: Record<string, string>; bodyText: string },
    sent: PreparedProviderRequest,
  ): Promise<PreparedProviderRequest | undefined> {
    const retryHook = this.seam.retry
    if (!retryHook || this.resent) return undefined
    this.resent = true
    try {
      const sawBody = this.needs('body')
      const answer = await this.call('retry', () =>
        retryHook.call(
          this.seam,
          {
            provider: this.facts.provider,
            status: response.status,
            headers: { ...response.headers },
            bodyText: response.bodyText,
            request: {
              method: sent.request.method ?? 'POST',
              url: sent.request.url,
              headers: { ...sent.request.headers },
              ...(sawBody ? { body: holdRequestBody(sent.unsigned.body).view } : {}),
            },
            attempt: sent.context.attempt,
            context: sent.context,
          },
          this.signal,
        ),
      )
      if (answer === undefined || answer === null) return undefined
      if (typeof answer !== 'object' || !answer.retry || typeof answer.retry !== 'object') return undefined
      const headers = stringRecord(answer.retry.headers, 'retry.headers')
      const patch = patchList(answer.retry.patch)
      const unsigned: DriverHttpRequest = {
        ...sent.unsigned,
        headers: mergeHeaders(sent.unsigned.headers, headers),
        body: editBody(
          sent.unsigned.body,
          { ...(patch ? { patch } : {}), ...(answer.retry.body !== undefined ? { body: answer.retry.body } : {}) },
          sawBody,
        ),
      }
      const context = this.nextContext()
      await this.attachContextIds(context)
      const request = await this.signed(unsigned, context)
      return { request, unsigned, ...(sent.idleTimeoutMs !== undefined ? { idleTimeoutMs: sent.idleTimeoutMs } : {}), context }
    } catch (error) {
      if (isAbort(error)) throw error
      return undefined
    }
  }

  private async applyRequestAnswer(
    built: DriverHttpRequest,
    answer: ProviderRequestAnswer | undefined,
    context: ProviderRequestContext,
  ): Promise<{ request: DriverHttpRequest; idleTimeoutMs?: number }> {
    if (answer === undefined || answer === null) return { request: built }
    if (typeof answer !== 'object' || Array.isArray(answer)) throw new Error('the answer is not an object')
    const headers = stringRecord(answer.headers, 'headers')
    const patch = patchList(answer.patch)
    if (answer.url !== undefined && typeof answer.url !== 'string') throw new Error('url is not a string')
    if (answer.system !== undefined && typeof answer.system !== 'string') throw new Error('system is not a string')
    if (answer.tools !== undefined && !Array.isArray(answer.tools)) throw new Error('tools is not a list')
    if (
      answer.idleTimeoutMs !== undefined
      && !(typeof answer.idleTimeoutMs === 'number' && Number.isFinite(answer.idleTimeoutMs) && answer.idleTimeoutMs > 0)
    ) {
      throw new Error('idleTimeoutMs is not a positive number')
    }
    const sawBody = this.needs('body')
    const replacesParts = answer.system !== undefined || answer.tools !== undefined
    if (answer.body !== undefined) {
      if (!sawBody) throw new Error('body is only for a provider that declared requestNeeds "body"')
      if (replacesParts || patch) throw new Error('body cannot be combined with system, tools or patch')
    }
    if (replacesParts && patch && sawBody) {
      // The hook's patch paths address the body it was shown; the replaced
      // parts change that body under it.
      throw new Error('patch cannot be combined with system or tools when the provider declared requestNeeds "body"')
    }
    let base = built
    if (replacesParts) {
      if (!this.facts.parts) throw new Error('this request cannot have its system prompt or tools replaced')
      base = await this.mapIds(
        this.facts.parts.rebuild({
          ...(answer.system !== undefined ? { system: answer.system } : {}),
          ...(answer.tools !== undefined ? { tools: answer.tools } : {}),
        }),
        context,
        true,
      )
    }
    const request: DriverHttpRequest = {
      ...base,
      ...(answer.url !== undefined ? { url: checkSeamUrl(answer.url, this.facts.baseUrl) } : {}),
      headers: headers ? mergeHeaders(base.headers, headers) : base.headers,
      body: editBody(
        base.body,
        { ...(patch ? { patch } : {}), ...(answer.body !== undefined ? { body: answer.body } : {}) },
        sawBody,
      ),
    }
    return { request, ...(answer.idleTimeoutMs !== undefined ? { idleTimeoutMs: answer.idleTimeoutMs } : {}) }
  }

  /** `sign` over the final bytes; its headers are added. */
  private async signed(request: DriverHttpRequest, context: ProviderRequestContext): Promise<DriverHttpRequest> {
    const signHook = this.seam.sign
    if (!signHook) return request
    const bodySha256 = await sha256Hex(request.body)
    const answer = await this.call('sign', () =>
      signHook.call(
        this.seam,
        {
          provider: this.facts.provider,
          method: request.method ?? 'POST',
          url: request.url,
          headers: { ...request.headers },
          bodySha256,
          bodyLength: request.body.byteLength,
          ...(this.seam.signNeeds === 'body' ? { body: request.body.slice() } : {}),
          context,
        },
        this.signal,
      ),
    )
    if (answer === undefined || answer === null) return request
    try {
      if (typeof answer !== 'object') throw new Error('the answer is not an object')
      const added = stringRecord(answer.headers, 'headers') ?? {}
      const present = new Set(Object.keys(request.headers).map(name => name.toLowerCase()))
      for (const [name, value] of Object.entries(added)) {
        if (present.has(name.toLowerCase())) throw new Error(`header ${name} is already set; sign may only add headers`)
        if (value === '') throw new Error(`header ${name} is empty; sign may only add headers`)
      }
      return { ...request, headers: { ...request.headers, ...added } }
    } catch (error) {
      throw new ProviderHookError('sign', this.facts.provider, reasonOf(error))
    }
  }
}
