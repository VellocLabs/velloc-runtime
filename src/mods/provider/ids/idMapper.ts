/**
 * Contract: the id mapper, run by Velloc, not the mod (F-27). Per request, between
 * the codec and the `request` hook: list the body's ids (`idSites`), map each from the
 * (session, provider) map or by its rule (in process under the provider's id key, or
 * batched into ONE `provider.ids` call), rewrite the body. `decode` maps response ids
 * back; an unknown id passes through. Security: fails closed: a rule that cannot run,
 * a missing / throwing / overrunning / miscounting hook, or two ids mapping to one
 * rejects `prepare`, and the request is not sent.
 */

import type { DriverHttpRequest, DriverStreamEvent, IdSite, ProviderDriver } from '../../../models/drivers/driverTypes'
import { deriveId, encryptId } from '../nouns/idKit'
import {
  BODY_ID_KINDS,
  compileIdRules,
  type ChainField,
  type CompiledIdRule,
  type IdAlphabet,
  type IdKind,
  type IdPart,
  type IdRuleShape,
} from './idRules'
import type { IdMap, IdMapStores } from './idMapStore'

export class ProviderIdMapError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ProviderIdMapError'
  }
}

/** One id handed to `provider.ids`. */
export type IdHookItem = {
  kind: IdKind
  value: string
  index: number
  role: string
  contentSha256: string
  prev: string
}

/** `provider.ids`: the module's answer, unchecked (the mapper checks it). */
export type IdHook = (items: IdHookItem[], context: Record<string, unknown>, signal?: AbortSignal) => Promise<unknown>

export type ContextIds = { session?: string; request?: string }
export type DecodeIds = (events: DriverStreamEvent[]) => DriverStreamEvent[]

export type IdMapperOptions = {
  providerId: string
  rules: Partial<Record<IdKind, IdRuleShape>>
  /** The provider's id key (`ProviderKeyVault.idKey`). */
  idKey: () => Promise<CryptoKey>
  stores: IdMapStores
  /** `provider.ids`. Absent: a `hook` rule fails the request. */
  hook?: IdHook
}

export type PrepareIdsInput = {
  sessionId?: string
  request: DriverHttpRequest
  idSites?: ProviderDriver['idSites']
  /** The hooks' context for this attempt (`provider.ids` gets it too). */
  context: Record<string, unknown>
  requestId: string
  nowMs: number
  signal?: AbortSignal
  /** Map the body's ids only: the request built again within one attempt,
   *  whose `context.ids` are already made. */
  bodyOnly?: boolean
}

export type PreparedIds = {
  request: DriverHttpRequest
  ids: ContextIds
  /** Present when the provider maps tool call ids: decodes a response's events. */
  decode?: DecodeIds
}

export type ContextIdsInput = Pick<PrepareIdsInput, 'sessionId' | 'context' | 'requestId' | 'nowMs' | 'signal'>

type Item = {
  kind: IdKind
  value: string
  index: number
  role: string
  site?: IdSite
  mapped?: string
}

const textEncoder = new TextEncoder()
const MAX_HOOK_ID_CHARS = 1024

function hex(bytes: Uint8Array): string {
  return Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('')
}

async function sha256Text(text: string): Promise<string> {
  return hex(new Uint8Array(await crypto.subtle.digest('SHA-256', textEncoder.encode(text) as BufferSource)))
}

const BASE62 = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz'
const BASE64URL = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_'

function randomRun(alphabet: IdAlphabet, width: number): string {
  let out = ''
  if (alphabet === 'hex') {
    const bytes = crypto.getRandomValues(new Uint8Array(Math.ceil(width / 2)))
    return hex(bytes).slice(0, width)
  }
  const chars = alphabet === 'base62' ? BASE62 : BASE64URL
  // Rejection sampling keeps base62 uniform (248 = 4 x 62).
  const limit = alphabet === 'base62' ? 248 : 256
  while (out.length < width) {
    for (const byte of crypto.getRandomValues(new Uint8Array(width * 2))) {
      if (byte < limit) out += chars[byte % chars.length]
      if (out.length === width) break
    }
  }
  return out
}

function timeRun(nowMs: number, alphabet: 'hex' | 'base62', width: number): string {
  if (alphabet === 'hex') return Math.max(0, Math.floor(nowMs)).toString(16).padStart(width, '0').slice(-width)
  let value = Math.max(0, Math.floor(nowMs))
  let out = ''
  while (value > 0) {
    out = BASE62[value % 62]! + out
    value = Math.floor(value / 62)
  }
  return out.padStart(width, '0').slice(-width)
}

function valueAt(root: unknown, path: ReadonlyArray<string | number>): unknown {
  let node = root
  for (const key of path) {
    if (typeof node !== 'object' || node === null) return undefined
    node = (node as Record<string | number, unknown>)[key]
  }
  return node
}

function setAt(root: unknown, path: ReadonlyArray<string | number>, value: string): void {
  const parent = valueAt(root, path.slice(0, -1))
  if (typeof parent === 'object' && parent !== null) (parent as Record<string | number, unknown>)[path[path.length - 1]!] = value
}

export class ProviderIdMapper {
  private readonly rules: Partial<Record<IdKind, CompiledIdRule>>
  /** Body kinds that are mapped at all (a `keep` is not). */
  private readonly bodyKinds: ReadonlySet<IdKind>

  constructor(private readonly options: IdMapperOptions) {
    this.rules = compileIdRules(options.rules)
    this.bodyKinds = new Set(BODY_ID_KINDS.filter(kind => this.rules[kind] !== undefined && this.rules[kind]!.derive !== 'keep'))
  }

  /** Whether a response's tool call ids can need decoding. */
  get mapsToolCalls(): boolean {
    return this.bodyKinds.has('toolCall')
  }

  /** Map the request's ids and make its `context.ids`. */
  async prepare(input: PrepareIdsInput): Promise<PreparedIds> {
    let body: unknown
    let sites: IdSite[] = []
    if (this.bodyKinds.size > 0 && input.idSites) {
      try {
        body = JSON.parse(new TextDecoder().decode(input.request.body))
      } catch {
        body = undefined
      }
      if (body !== undefined) sites = input.idSites(body).filter(site => this.bodyKinds.has(site.kind))
    }
    const contextItems = input.bodyOnly ? [] : this.contextItems(input)
    const items: Item[] = [...contextItems, ...sites.map(site => ({ kind: site.kind, value: site.value, index: site.index, role: site.role, site }))]
    if (items.length === 0) {
      return { request: input.request, ids: input.bodyOnly ? {} : this.keptContextIds(input) }
    }
    const map = await this.options.stores.open(this.options.providerId, input.sessionId)
    await this.resolve(items, map, body, input)
    const request = this.rewrite(input.request, body, items)
    return { request, ids: input.bodyOnly ? {} : this.contextIdsOf(items, input), ...this.decoderFor(map) }
  }

  /** `context.ids` alone, for a re-send (a new request id). */
  async contextIds(input: ContextIdsInput): Promise<ContextIds> {
    const items = this.contextItems(input)
    if (items.length === 0) return this.keptContextIds(input)
    const map = await this.options.stores.open(this.options.providerId, input.sessionId)
    await this.resolve(items, map, undefined, input)
    return this.contextIdsOf(items, input)
  }

  // ── context ids ──

  private contextItems(input: ContextIdsInput): Item[] {
    const items: Item[] = []
    const session = this.rules.session
    if (session && session.derive !== 'keep' && input.sessionId) {
      items.push({ kind: 'session', value: input.sessionId, index: -1, role: '' })
    }
    const request = this.rules.request
    if (request && request.derive !== 'keep') items.push({ kind: 'request', value: input.requestId, index: -1, role: '' })
    return items
  }

  /** The `keep` rules' context ids (the id itself). */
  private keptContextIds(input: ContextIdsInput): ContextIds {
    return {
      ...(this.rules.session?.derive === 'keep' && input.sessionId ? { session: input.sessionId } : {}),
      ...(this.rules.request?.derive === 'keep' ? { request: input.requestId } : {}),
    }
  }

  private contextIdsOf(items: readonly Item[], input: ContextIdsInput): ContextIds {
    const ids = this.keptContextIds(input)
    for (const item of items) {
      if (item.index >= 0 || item.mapped === undefined) continue
      if (item.kind === 'session') ids.session = item.mapped
      else if (item.kind === 'request') ids.request = item.mapped
    }
    return ids
  }

  // ── resolving ──

  private async resolve(items: Item[], map: IdMap, body: unknown, input: ContextIdsInput): Promise<void> {
    const prevOf = this.prevIndexes(items)
    const shas = new Map<string, Promise<string>>()
    const contentSha = (item: Item): Promise<string> => {
      if (!item.site) return Promise.resolve('')
      const key = item.site.messagePath.join('/')
      let sha = shas.get(key)
      if (!sha) {
        sha = sha256Text(JSON.stringify(valueAt(body, item.site.messagePath) ?? null))
        shas.set(key, sha)
      }
      return sha
    }
    const cacheable = (item: Item): boolean => item.kind !== 'request'
    const mappedPrev = (i: number): string | undefined => {
      const at = prevOf[i]!
      return at < 0 ? '' : items[at]!.mapped
    }

    const batch: Array<{ key: string; first: number }> = []
    const batchKeys = new Map<string, number>()
    const deferred: number[] = []

    for (let i = 0; i < items.length; i++) {
      const item = items[i]!
      const rule = this.rules[item.kind]!
      if (cacheable(item)) {
        const hit = map.lookup(item.kind, item.value)
        if (hit !== undefined) {
          item.mapped = hit
          continue
        }
      }
      if (rule.derive === 'hook') {
        const key = `${item.kind}\u0000${item.value}`
        if (!batchKeys.has(key) || !cacheable(item)) {
          batchKeys.set(key, batch.length)
          batch.push({ key, first: i })
        }
        continue
      }
      if (rule.derive === 'chain' && rule.over.includes('prev') && mappedPrev(i) === undefined) {
        deferred.push(i)
        continue
      }
      await this.makeInProcess(item, rule, mappedPrev(i) ?? '', contentSha, input, map)
    }

    if (batch.length > 0) await this.askHook(items, batch.map(entry => entry.first), mappedPrev, contentSha, input, map)

    for (const i of deferred) {
      const item = items[i]!
      if (item.mapped !== undefined) continue
      const hit = cacheable(item) ? map.lookup(item.kind, item.value) : undefined
      if (hit !== undefined) {
        item.mapped = hit
        continue
      }
      await this.makeInProcess(item, this.rules[item.kind]!, mappedPrev(i) ?? '', contentSha, input, map)
    }

    // A repeat of an id that was on the hook shares its answer.
    for (const item of items) {
      if (item.mapped === undefined) item.mapped = map.lookup(item.kind, item.value)
    }
  }

  /** For each item, the index of the last item of the closest earlier
   *  message (-1: none). Context items (index < 0) are not messages. */
  private prevIndexes(items: readonly Item[]): number[] {
    const out: number[] = new Array(items.length).fill(-1)
    let tail = -1 // last item of the most recent finished message
    let currentIndex = Number.NaN
    let currentLast = -1
    for (let i = 0; i < items.length; i++) {
      const item = items[i]!
      if (item.index < 0) continue
      if (item.index !== currentIndex) {
        if (currentLast >= 0) tail = currentLast
        currentIndex = item.index
      }
      out[i] = tail
      currentLast = i
    }
    return out
  }

  private async makeInProcess(
    item: Item,
    rule: CompiledIdRule,
    prev: string,
    contentSha: (item: Item) => Promise<string>,
    input: ContextIdsInput,
    map: IdMap,
  ): Promise<void> {
    const scope = `ids/${item.kind}`
    let mapped: string
    if (rule.derive === 'encrypt') {
      mapped = rule.prefix + (await encryptId(await this.options.idKey(), scope, item.value))
    } else if (rule.derive === 'random') {
      mapped = rule.prefix + (await this.render(rule.parts, async part => randomRun(part.alphabet, part.width), input.nowMs))
    } else if (rule.derive === 'hmac') {
      const key = await this.options.idKey()
      mapped = rule.prefix + (await this.render(rule.parts, part => deriveId(key, `${scope}#${part.slot}`, item.value, { format: part.alphabet, length: part.width }), input.nowMs))
    } else if (rule.derive === 'chain') {
      const key = await this.options.idKey()
      const fields: Record<ChainField, unknown> = {
        prev,
        contentSha256: rule.over.includes('contentSha256') ? await contentSha(item) : '',
        index: item.index,
        role: item.role,
        value: item.value,
      }
      const text = JSON.stringify(rule.over.map(field => fields[field]))
      mapped = rule.prefix + (await this.render(rule.parts, part => deriveId(key, `${scope}/chain#${part.slot}`, text, { format: part.alphabet, length: part.width }), input.nowMs))
    } else {
      throw new ProviderIdMapError(`ids.${item.kind}: "${rule.derive}" cannot be run in process`)
    }
    item.mapped = mapped
    if (item.kind !== 'request') map.add(item.kind, item.value, mapped)
  }

  private async render(
    parts: readonly IdPart[],
    run: (part: { alphabet: IdAlphabet; width: number; slot: number }) => Promise<string>,
    nowMs: number,
  ): Promise<string> {
    let out = ''
    let slot = 0
    for (const part of parts) {
      if (part.type === 'literal') out += part.text
      else if (part.type === 'time') out += timeRun(nowMs, part.alphabet, part.width)
      else out += await run({ alphabet: part.alphabet, width: part.width, slot: slot++ })
    }
    return out
  }

  private async askHook(
    items: Item[],
    firsts: readonly number[],
    mappedPrev: (i: number) => string | undefined,
    contentSha: (item: Item) => Promise<string>,
    input: ContextIdsInput,
    map: IdMap,
  ): Promise<void> {
    const hook = this.options.hook
    if (!hook) throw new ProviderIdMapError('an id rule says "hook", but this provider has no provider.ids hook')
    const asked: IdHookItem[] = []
    for (const i of firsts) {
      const item = items[i]!
      asked.push({
        kind: item.kind,
        value: item.value,
        index: item.index,
        role: item.role,
        contentSha256: await contentSha(item),
        prev: mappedPrev(i) ?? '',
      })
    }
    const answer = await hook(asked, input.context, input.signal)
    if (!Array.isArray(answer)) throw new ProviderIdMapError('provider.ids did not answer a list')
    if (answer.length !== asked.length) {
      throw new ProviderIdMapError(`provider.ids answered ${answer.length} ids for ${asked.length} asked`)
    }
    answer.forEach((mapped, n) => {
      if (typeof mapped !== 'string' || mapped === '' || mapped.length > MAX_HOOK_ID_CHARS) {
        throw new ProviderIdMapError(`provider.ids answer ${n} is not a non-empty string of at most ${MAX_HOOK_ID_CHARS} characters`)
      }
    })
    firsts.forEach((i, n) => {
      const item = items[i]!
      item.mapped = answer[n] as string
      if (item.kind !== 'request') map.add(item.kind, item.value, item.mapped)
    })
  }

  // ── the body ──

  private rewrite(request: DriverHttpRequest, body: unknown, items: readonly Item[]): DriverHttpRequest {
    let changed = false
    for (const item of items) {
      if (!item.site || item.mapped === undefined || item.mapped === item.value) continue
      setAt(body, item.site.path, item.mapped)
      changed = true
    }
    if (!changed) return request
    return { ...request, body: textEncoder.encode(JSON.stringify(body)) }
  }

  // ── the response ──

  private decoderFor(map: IdMap | undefined): { decode?: DecodeIds } {
    if (!map || !this.mapsToolCalls) return {}
    return {
      decode: events => {
        if (map.size === 0) return events
        let out: DriverStreamEvent[] | undefined
        events.forEach((event, i) => {
          if (
            (event.type === 'tool_call_start' || event.type === 'tool_call_delta' || event.type === 'tool_call')
            && typeof event.id === 'string'
            && event.id !== ''
          ) {
            const original = map.original(event.id)
            if (original && original.kind === 'toolCall') {
              out ??= events.slice()
              out[i] = { ...event, id: original.value }
            }
          }
        })
        return out ?? events
      },
    }
  }
}
