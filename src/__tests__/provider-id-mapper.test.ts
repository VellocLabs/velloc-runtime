/**
 * Provider mods PM-6b - the id mapper: every rule kind with fixed vectors,
 * the cache, the batched `provider.ids` call, failing closed, the response
 * direction. The key is fixed (32 bytes of 0x07), so the vectors are too.
 */
import { createHash } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'
import type { DriverHttpRequest, DriverStreamEvent } from '../models/drivers/driverTypes'
import { chatIdSites } from '../models/drivers/idSites'
import { IdCollisionError, IdMapStores } from '../mods/provider/ids/idMapStore'
import {
  ProviderIdMapError,
  ProviderIdMapper,
  type IdHook,
  type IdHookItem,
  type PrepareIdsInput,
} from '../mods/provider/ids/idMapper'
import type { IdKind, IdRuleShape } from '../mods/provider/ids/idRules'
import { decryptId } from '../mods/provider/nouns/idKit'
import { MemorySessionStores } from '../mods/provider/nouns/sessionStore'

const KEY = await crypto.subtle.importKey('raw', new Uint8Array(32).fill(7), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
const NOW = 1_700_000_000_000

const enc = (value: unknown) => new TextEncoder().encode(JSON.stringify(value))
const dec = (bytes: Uint8Array) => JSON.parse(new TextDecoder().decode(bytes))
const sha = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex')

const request = (body: unknown): DriverHttpRequest => ({
  url: 'https://api.example/v1/chat/completions',
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: enc(body),
})

/** A chat history: user, then one assistant turn per id with its result. */
function history(...ids: string[]) {
  const messages: unknown[] = [{ role: 'user', content: 'go' }]
  for (const id of ids) {
    messages.push({ role: 'assistant', content: '', tool_calls: [{ id, type: 'function', function: { name: 'Read', arguments: '{}' } }] })
    messages.push({ role: 'tool', tool_call_id: id, content: `result of ${id}` })
  }
  return { model: 'm', messages }
}

type Setup = {
  rules: Partial<Record<IdKind, IdRuleShape>>
  hook?: IdHook
  stores?: IdMapStores
}

function setup({ rules, hook, stores }: Setup) {
  const idStores = stores ?? new IdMapStores(new MemorySessionStores(), { flushDelayMs: 1 })
  const mapper = new ProviderIdMapper({
    providerId: 'mod.acme.zen',
    rules,
    idKey: async () => KEY,
    stores: idStores,
    ...(hook ? { hook } : {}),
  })
  const run = (body: unknown, extra: Partial<PrepareIdsInput> = {}) =>
    mapper.prepare({
      sessionId: 'sess-1',
      request: request(body),
      idSites: chatIdSites,
      context: { purpose: 'turn' },
      requestId: 'req-1',
      nowMs: NOW,
      ...extra,
    })
  return { mapper, stores: idStores, run }
}

const wireIds = (r: DriverHttpRequest): string[] =>
  chatIdSites(dec(r.body)).map(site => site.value)

describe('the in-process rules', () => {
  it('hmac: deterministic, the same id on the call and its result, a fresh mapper gives the same ids', async () => {
    const rule: IdRuleShape = { derive: 'hmac', prefix: 'call_', alphabet: 'base62', length: 24 }
    const a = await setup({ rules: { toolCall: rule } }).run(history('toolu_1', 'toolu_2'))
    const ids = wireIds(a.request)
    expect(ids).toHaveLength(4)
    expect(ids[0]).toBe(ids[1])
    expect(ids[2]).toBe(ids[3])
    expect(ids[0]).not.toBe(ids[2])
    for (const id of [ids[0]!, ids[2]!]) expect(id).toMatch(/^call_[0-9A-Za-z]{24}$/)
    // A different instance, an empty map: the rule alone gives the same ids.
    const b = await setup({ rules: { toolCall: rule } }).run(history('toolu_1', 'toolu_2'))
    expect(wireIds(b.request)).toEqual(ids)
    // The rest of the body is untouched.
    expect(dec(a.request.body).messages[0]).toEqual({ role: 'user', content: 'go' })
    expect(dec(a.request.body).messages[2].content).toBe('result of toolu_1')
  })

  it('hmac vectors (fixed key; HMAC-SHA-256 over the framed scope and id, checked independently)', async () => {
    const { run } = setup({ rules: { toolCall: { derive: 'hmac', prefix: 'call_', alphabet: 'base62', length: 24 } } })
    expect(wireIds((await run(history('toolu_1'))).request)[0]).toBe('call_PJiMGfTzxsAjGGl7pwGb01cU')
    const hex = setup({ rules: { toolCall: { derive: 'hmac', alphabet: 'hex', length: 16 } } })
    expect(wireIds((await hex.run(history('toolu_1'))).request)[0]).toBe('6ac49e7afed6b836')
  })

  it('hmac with a template: fixed widths, parts derived apart', async () => {
    const { run } = setup({ rules: { toolCall: { derive: 'hmac', prefix: 'ses_', template: '{hex:12}{base62:14}' } } })
    const id = wireIds((await run(history('toolu_1'))).request)[0]!
    expect(id).toMatch(/^ses_[0-9a-f]{12}[0-9A-Za-z]{14}$/)
  })

  it('encrypt: reversible by the map, and by the key under the kind\'s scope', async () => {
    const { run, stores } = setup({ rules: { toolCall: { derive: 'encrypt', prefix: 'e_' } } })
    const prepared = await run(history('toolu_1'))
    const mapped = wireIds(prepared.request)[0]!
    expect(mapped.startsWith('e_')).toBe(true)
    expect(mapped).not.toContain('toolu_1')
    const map = await stores.open('mod.acme.zen', 'sess-1')
    expect(map.original(mapped)).toEqual({ kind: 'toolCall', value: 'toolu_1' })
    await expect(decryptId(KEY, 'ids/toolCall', mapped.slice(2))).resolves.toBe('toolu_1')
    // Deterministic: the same token from a fresh mapper.
    const again = await setup({ rules: { toolCall: { derive: 'encrypt', prefix: 'e_' } } }).run(history('toolu_1'))
    expect(wireIds(again.request)[0]).toBe(mapped)
  })

  it('chain: each id depends on the previous one\'s mapped id, and extends from the cache', async () => {
    const rule: IdRuleShape = { derive: 'chain', over: ['prev', 'contentSha256', 'index', 'role'], prefix: 'c_', length: 20 }
    const full = await setup({ rules: { toolCall: rule } }).run(history('A', 'B', 'C'))
    const fullIds = wireIds(full.request)
    // A, A, B, B, C, C
    expect(fullIds[0]).toBe(fullIds[1])
    expect(new Set(fullIds).size).toBe(3)

    // Incremental: two turns first, then the third on top of the cache.
    const inc = setup({ rules: { toolCall: rule } })
    const first = await inc.run(history('A', 'B'))
    const second = await inc.run(history('A', 'B', 'C'))
    expect(wireIds(first.request)).toEqual(fullIds.slice(0, 4))
    expect(wireIds(second.request)).toEqual(fullIds)

    // Change the FIRST id: the later ones change too, though their own content did not.
    const other = await setup({ rules: { toolCall: rule } }).run(history('A2', 'B', 'C'))
    const otherIds = wireIds(other.request)
    expect(otherIds[0]).not.toBe(fullIds[0])
    expect(otherIds[2]).not.toBe(fullIds[2])
  })

  it('chain: two tool calls in one message do not collide when the chain includes the id itself; without it they fail loudly', async () => {
    const twoCalls = {
      model: 'm',
      messages: [
        { role: 'user', content: 'go' },
        {
          role: 'assistant',
          content: '',
          tool_calls: [
            { id: 'X', type: 'function', function: { name: 'Read', arguments: '{}' } },
            { id: 'Y', type: 'function', function: { name: 'Read', arguments: '{}' } },
          ],
        },
      ],
    }
    const withValue = await setup({ rules: { toolCall: { derive: 'chain', over: ['prev', 'contentSha256', 'value'] } } }).run(twoCalls)
    const ids = wireIds(withValue.request)
    expect(ids[0]).not.toBe(ids[1])
    await expect(
      setup({ rules: { toolCall: { derive: 'chain', over: ['prev', 'contentSha256'] } } }).run(twoCalls),
    ).rejects.toBeInstanceOf(IdCollisionError)
  })

  it('keep: the request is returned as it is', async () => {
    const built = request(history('toolu_1'))
    const { mapper } = setup({ rules: { toolCall: { derive: 'keep' }, message: { derive: 'keep' } } })
    const prepared = await mapper.prepare({
      sessionId: 'sess-1',
      request: built,
      idSites: chatIdSites,
      context: {},
      requestId: 'r',
      nowMs: NOW,
    })
    expect(prepared.request).toBe(built)
    expect(prepared.decode).toBeUndefined()
  })

  it('reasoning and message kinds are mapped from their own sites', async () => {
    const { mapper } = setup({ rules: { message: { derive: 'hmac', prefix: 'm_', length: 10 }, reasoning: { derive: 'hmac', prefix: 'r_', length: 10 } } })
    const body = { input: [{ type: 'reasoning', id: 'rs_1' }, { type: 'message', role: 'assistant', id: 'msg_1', content: 'x' }] }
    const { responsesIdSites } = await import('../models/drivers/idSites')
    const prepared = await mapper.prepare({
      sessionId: 's',
      request: request(body),
      idSites: responsesIdSites,
      context: {},
      requestId: 'r',
      nowMs: NOW,
    })
    const out = dec(prepared.request.body)
    expect(out.input[0].id).toMatch(/^r_[0-9A-Za-z]{10}$/)
    expect(out.input[1].id).toMatch(/^m_[0-9A-Za-z]{10}$/)
  })
})

describe('the session and request classes', () => {
  const rules: Partial<Record<IdKind, IdRuleShape>> = {
    session: { derive: 'hmac', prefix: 'ses_', template: '{hex:12}{base62:14}' },
    request: { derive: 'random', prefix: 'msg_', template: '{time:hex:12}{base62:14}' },
  }

  it('session: stable for a session, across mapper instances; request: fresh for every attempt', async () => {
    const one = setup({ rules })
    const a = await one.run(history('A'))
    const b = await one.run(history('A'), { requestId: 'req-2' })
    expect(a.ids.session).toMatch(/^ses_[0-9a-f]{12}[0-9A-Za-z]{14}$/)
    expect(b.ids.session).toBe(a.ids.session)
    expect(a.ids.request).toMatch(/^msg_[0-9a-f]{12}[0-9A-Za-z]{14}$/)
    expect(a.ids.request).not.toBe(b.ids.request)
    // The clock part is the time given.
    expect(a.ids.request!.slice(4, 16)).toBe(NOW.toString(16).padStart(12, '0'))
    // Another instance, empty map: the same session id from the rule.
    const other = await setup({ rules }).run(history('A'))
    expect(other.ids.session).toBe(a.ids.session)
    // A different session gets a different one.
    expect((await one.run(history('A'), { sessionId: 'sess-2' })).ids.session).not.toBe(a.ids.session)
    // Nothing from the request kind is kept in the map.
    const map = await one.stores.open('mod.acme.zen', 'sess-1')
    expect(map.size).toBe(1)
  })

  it('contextIds makes the ids of a re-send alone: the same session, a new request id', async () => {
    const { mapper, run } = setup({ rules })
    const first = await run(history('A'))
    const again = await mapper.contextIds({ sessionId: 'sess-1', context: {}, requestId: 'req-2', nowMs: NOW + 1000 })
    expect(again.session).toBe(first.ids.session)
    expect(again.request).not.toBe(first.ids.request)
    expect(again.request).toMatch(/^msg_/)
  })

  it('a session rule with no session id, and keep rules', async () => {
    const none = await setup({ rules }).run(history('A'), { sessionId: undefined })
    expect(none.ids.session).toBeUndefined()
    expect(none.ids.request).toBeDefined()
    const kept = await setup({ rules: { session: { derive: 'keep' }, request: { derive: 'keep' } } }).run(history('A'))
    expect(kept.ids).toEqual({ session: 'sess-1', request: 'req-1' })
  })

  it('a provider with only these rules never reads the body', async () => {
    const sites = vi.fn(chatIdSites)
    const built = request(history('A'))
    const { mapper } = setup({ rules })
    const prepared = await mapper.prepare({ sessionId: 's', request: built, idSites: sites, context: {}, requestId: 'r', nowMs: NOW })
    expect(sites).not.toHaveBeenCalled()
    expect(prepared.request).toBe(built)
  })

  it('request ids on the hook go through provider.ids, uncached', async () => {
    const hook = vi.fn(async (items: IdHookItem[]) => items.map(item => `${item.kind}:${item.value}`))
    const { run, stores } = setup({ rules: { request: { derive: 'hook' }, session: { derive: 'hook' } }, hook })
    const a = await run(history('A'))
    expect(hook).toHaveBeenCalledTimes(1)
    expect(hook.mock.calls[0]![0].map(i => [i.kind, i.value, i.index])).toEqual([
      ['session', 'sess-1', -1],
      ['request', 'req-1', -1],
    ])
    expect(a.ids).toEqual({ session: 'session:sess-1', request: 'request:req-1' })
    // The next request: the session is cached, the request is asked again.
    const b = await run(history('A'), { requestId: 'req-2' })
    expect(hook).toHaveBeenCalledTimes(2)
    expect(hook.mock.calls[1]![0].map(i => i.kind)).toEqual(['request'])
    expect(b.ids.session).toBe('session:sess-1')
    expect((await stores.open('mod.acme.zen', 'sess-1')).size).toBe(1)
  })
})

describe('the cache and the batched hook', () => {
  const hookRules: Partial<Record<IdKind, IdRuleShape>> = { toolCall: { derive: 'hook' } }
  const answer = (items: IdHookItem[]) => items.map(item => `w-${item.value}`)

  it('one provider.ids call per request, for the new ids only, in request order, with what a scheme uses', async () => {
    const hook = vi.fn(async (items: IdHookItem[], _context?: Record<string, unknown>) => answer(items))
    const { run } = setup({ rules: hookRules, hook })

    const a = await run(history('A', 'B'))
    expect(hook).toHaveBeenCalledTimes(1)
    const asked = hook.mock.calls[0]![0]
    // The call and its result share one id: asked once.
    expect(asked.map(i => [i.kind, i.value, i.index, i.role])).toEqual([
      ['toolCall', 'A', 1, 'assistant'],
      ['toolCall', 'B', 3, 'assistant'],
    ])
    const messages = history('A', 'B').messages
    expect(asked[0]!.contentSha256).toBe(sha(messages[1]))
    expect(asked[1]!.contentSha256).toBe(sha(messages[3]))
    // The first has nothing before it; the second's prev is the mapped id of the closest earlier id.
    // (A's result at index 2 is the previous message's tail.)
    expect(asked[0]!.prev).toBe('')
    expect(asked[1]!.prev).toBe('')
    expect(wireIds(a.request)).toEqual(['w-A', 'w-A', 'w-B', 'w-B'])
    expect(hook.mock.calls[0]![1]).toEqual({ purpose: 'turn' })

    // The same history again: nothing asked, the same wire ids.
    const again = await run(history('A', 'B'))
    expect(hook).toHaveBeenCalledTimes(1)
    expect(wireIds(again.request)).toEqual(wireIds(a.request))

    // One new id: only it is asked; prev is the MAPPED id of the previous message's id.
    const grown = await run(history('A', 'B', 'C'))
    expect(hook).toHaveBeenCalledTimes(2)
    expect(hook.mock.calls[1]![0].map(i => [i.value, i.index, i.prev])).toEqual([['C', 5, 'w-B']])
    expect(wireIds(grown.request)).toEqual(['w-A', 'w-A', 'w-B', 'w-B', 'w-C', 'w-C'])
  })

  it('every id of a mixed history: rules in process for one kind, the hook for the other, one call', async () => {
    const hook = vi.fn(async (items: IdHookItem[]) => answer(items))
    const { run } = setup({
      rules: { toolCall: { derive: 'hmac', prefix: 'c_', length: 8 }, message: { derive: 'hook' } },
      hook,
    })
    const { responsesIdSites } = await import('../models/drivers/idSites')
    const body = {
      input: [
        { type: 'message', role: 'assistant', id: 'msg_1', content: 'x' },
        { type: 'function_call', call_id: 'call_1', name: 'T', arguments: '{}' },
        { type: 'function_call_output', call_id: 'call_1', output: 'ok' },
        { type: 'message', role: 'assistant', id: 'msg_2', content: 'y' },
      ],
    }
    const prepared = await run(body, { idSites: responsesIdSites })
    expect(hook).toHaveBeenCalledTimes(1)
    expect(hook.mock.calls[0]![0].map(i => i.value)).toEqual(['msg_1', 'msg_2'])
    const out = dec(prepared.request.body)
    expect(out.input[0].id).toBe('w-msg_1')
    expect(out.input[3].id).toBe('w-msg_2')
    expect(out.input[1].call_id).toMatch(/^c_[0-9A-Za-z]{8}$/)
    expect(out.input[2].call_id).toBe(out.input[1].call_id)
  })

  it('a chain after a hooked id waits for its answer', async () => {
    const hook = vi.fn(async (items: IdHookItem[]) => answer(items))
    const { run } = setup({
      rules: { message: { derive: 'hook' }, toolCall: { derive: 'chain', over: ['prev'], length: 12 } },
      hook,
    })
    const { responsesIdSites } = await import('../models/drivers/idSites')
    const body = (messageId: string) => ({
      input: [
        { type: 'message', role: 'assistant', id: messageId, content: 'x' },
        { type: 'function_call', call_id: 'call_1', name: 'T', arguments: '{}' },
      ],
    })
    const a = await run(body('msg_1'), { idSites: responsesIdSites })
    const b = await setup({ rules: { message: { derive: 'hook' }, toolCall: { derive: 'chain', over: ['prev'], length: 12 } }, hook })
      .run(body('msg_2'), { idSites: responsesIdSites })
    // The chained id was made from the hook's answer, so it follows it.
    expect(dec(a.request.body).input[1].call_id).not.toBe(dec(b.request.body).input[1].call_id)
  })

  it('a hit costs a lookup: no hashing, no hook, however many turns', async () => {
    const hook = vi.fn(async (items: IdHookItem[]) => answer(items))
    const { run } = setup({ rules: hookRules, hook })
    await run(history('A', 'B', 'C'))
    const digest = vi.spyOn(crypto.subtle, 'digest')
    const sign = vi.spyOn(crypto.subtle, 'sign')
    for (let i = 0; i < 5; i++) await run(history('A', 'B', 'C'))
    expect(hook).toHaveBeenCalledTimes(1)
    expect(digest).not.toHaveBeenCalled()
    expect(sign).not.toHaveBeenCalled()
    digest.mockRestore()
    sign.mockRestore()
  })

  it('a re-sent body that was built again maps to the same ids without a call (bodyOnly)', async () => {
    const hook = vi.fn(async (items: IdHookItem[]) => answer(items))
    const { run } = setup({ rules: hookRules, hook })
    const a = await run(history('A'))
    const b = await run(history('A'), { bodyOnly: true })
    expect(hook).toHaveBeenCalledTimes(1)
    expect(wireIds(b.request)).toEqual(wireIds(a.request))
    expect(b.ids).toEqual({})
  })

  it('a request with no session id keeps no map, and maps by the rule', async () => {
    const hook = vi.fn(async (items: IdHookItem[]) => answer(items))
    const { run } = setup({ rules: hookRules, hook })
    await run(history('A'), { sessionId: undefined })
    await run(history('A'), { sessionId: undefined })
    expect(hook).toHaveBeenCalledTimes(2)
  })
})

describe('failing closed', () => {
  const rules: Partial<Record<IdKind, IdRuleShape>> = { toolCall: { derive: 'hook' } }

  it('a hook that throws: the request is not mapped', async () => {
    const { run } = setup({ rules, hook: async () => { throw new Error('boom') } })
    await expect(run(history('A'))).rejects.toThrow('boom')
  })

  it('no hook at all', async () => {
    const { run } = setup({ rules })
    await expect(run(history('A'))).rejects.toThrow(/no provider\.ids hook/)
  })

  it('a short answer, a long answer, a non-list, a non-string', async () => {
    for (const [what, result, message] of [
      ['short', [], /answered 0 ids for 1 asked/],
      ['long', ['a', 'b'], /answered 2 ids for 1 asked/],
      ['non-list', 'abc', /did not answer a list/],
      ['non-string', [3], /answer 0 is not a non-empty string/],
      ['empty', [''], /answer 0 is not a non-empty string/],
    ] as const) {
      const { run } = setup({ rules, hook: async () => result as unknown })
      await expect(run(history('A')), what).rejects.toThrow(message)
    }
  })

  it('failures leave nothing mapped: the next request asks again', async () => {
    let fail = true
    const hook = vi.fn(async (items: IdHookItem[]) => {
      if (fail) throw new Error('down')
      return items.map(item => `w-${item.value}`)
    })
    const { run } = setup({ rules, hook })
    await expect(run(history('A'))).rejects.toThrow('down')
    fail = false
    const ok = await run(history('A'))
    expect(wireIds(ok.request)).toEqual(['w-A', 'w-A'])
  })

  it('two ids answered with one string collide', async () => {
    const { run } = setup({ rules, hook: async items => items.map(() => 'same') })
    await expect(run(history('A', 'B'))).rejects.toBeInstanceOf(IdCollisionError)
  })

  it('the abort signal reaches the hook', async () => {
    const seen: Array<AbortSignal | undefined> = []
    const controller = new AbortController()
    const { run } = setup({ rules, hook: async (items, _context, signal) => { seen.push(signal); return items.map(i => i.value) } })
    await run(history('A'), { signal: controller.signal })
    expect(seen[0]).toBe(controller.signal)
  })

  it('ProviderIdMapError names its kind of failure', async () => {
    const { run } = setup({ rules })
    await expect(run(history('A'))).rejects.toBeInstanceOf(ProviderIdMapError)
  })
})

describe('the response direction', () => {
  const tool = (type: 'tool_call_start' | 'tool_call_delta' | 'tool_call', id: string | undefined): DriverStreamEvent =>
    ({ type, ...(id !== undefined ? { id } : {}) }) as DriverStreamEvent

  it('puts the engine\'s ids back on events that carry a mapped one; unknown ids pass through', async () => {
    const { run } = setup({ rules: { toolCall: { derive: 'hmac', prefix: 'call_', length: 12 } } })
    const prepared = await run(history('toolu_1'))
    const mapped = wireIds(prepared.request)[0]!
    const events: DriverStreamEvent[] = [
      tool('tool_call_start', mapped),
      tool('tool_call_delta', mapped),
      tool('tool_call', mapped),
      tool('tool_call_start', 'call_vendor_new'),
      tool('tool_call_delta', undefined),
      { type: 'text_delta', text: mapped },
      { type: 'finish', finishReason: 'tool_calls' },
    ]
    const out = prepared.decode!(events)
    expect(out.map(e => ('id' in e ? e.id : undefined))).toEqual([
      'toolu_1', 'toolu_1', 'toolu_1', 'call_vendor_new', undefined, undefined, undefined,
    ])
    // Events that need no change are the same objects; the input is not edited.
    expect(out[3]).toBe(events[3])
    expect(out[5]).toBe(events[5])
    expect((events[0] as { id?: string }).id).toBe(mapped)
    // Nothing to decode: the very array comes back.
    const plain = [events[3]!, events[6]!]
    expect(prepared.decode!(plain)).toBe(plain)
  })

  it('a provider that maps no tool call ids has no decoder', async () => {
    const { run } = setup({ rules: { session: { derive: 'hmac' } } })
    expect((await run(history('A'))).decode).toBeUndefined()
  })

  it('decodes ids mapped by the hook, from an earlier request of the session', async () => {
    const { run } = setup({ rules: { toolCall: { derive: 'hook' } }, hook: async items => items.map(i => `H${i.value}`) })
    await run(history('A'))
    const later = await run(history('A', 'B'))
    expect(later.decode!([tool('tool_call', 'HA')])[0]).toMatchObject({ id: 'A' })
  })
})
