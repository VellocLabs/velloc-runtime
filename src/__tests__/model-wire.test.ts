/**
 * A model's own wire (`ProviderModelInfo.wire`): reading it defensively,
 * holding it to its provider's origin, laying it over the provider's spec,
 * the codec switches it picks (`compat`), its persistence with the listing,
 * and a provider whose two models go out in two formats to two paths.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type {
  BrowserBridgeTransport,
  BridgeModelRequestPayload,
} from '../browser/bridge/browserBridgeProtocol'
import { listedFigures, recordListedFigures, resetListedFigures } from '../config/nexusModelConfig/familyRows'
import type { CodecCompat, ProviderModelInfo } from '../config/nexusModelConfig/providerDefinition'
import { resolveProviderSpec } from '../models/drivers/driverRegistry'
import { createModelProviderCache, withModelProviders } from '../models/drivers/driverTransport'
import { encodeReasoningReplaySignature } from '../models/drivers/hostCallOptions'
import { parseHostJson, type HostDict } from '../models/drivers/hostValue'
import {
  applyModelWire,
  confineModelWire,
  isSafeWirePath,
  mergeSpecHeaders,
  parseModelWire,
  resetModelWireLog,
  sanitizeModelWire,
} from '../models/drivers/modelWire'
import { anthropicMessagesDriver } from '../models/drivers/anthropicMessagesDriver'
import { geminiDriver } from '../models/drivers/geminiDriver'
import { ollamaChatDriver } from '../models/drivers/ollamaChatDriver'
import { openaiChatDriver } from '../models/drivers/openaiChatDriver'
import { openaiResponsesDriver } from '../models/drivers/openaiResponsesDriver'
import {
  configureRuntimeProviders,
  dismissRemovedNotice,
  refreshConfiguredRuntimeProviderModels,
  resetRuntimeProviders,
  setRuntimeProviderConfigs,
  type RuntimeProvidersHost,
} from '../models/drivers/runtimeProviders'
import { traceLine } from '../utils/debugLog'
import '../models/drivers/builtinDrivers'
import type { DriverStreamEvent, ProviderSpec } from '../models/drivers/driverTypes'

vi.mock('../utils/debugLog', async importOriginal => ({
  ...(await importOriginal<typeof import('../utils/debugLog')>()),
  traceLine: vi.fn(),
}))

const warnings = () => vi.mocked(traceLine).mock.calls.map(call => String(call[0]))

beforeEach(() => {
  resetModelWireLog()
  vi.mocked(traceLine).mockClear()
})
afterEach(() => {
  resetListedFigures()
  resetRuntimeProviders()
})

const ORIGIN = 'https://wire.example.test'
const env = (spec: Record<string, unknown>) =>
  ({ getEnv: (name: string) => (name === 'providerDrivers' ? JSON.stringify(spec) : undefined) }) as never
const WIRE_TEST = { format: 'openai-chat', baseUrl: `${ORIGIN}/zen/v1` }
const resolve = (model: string | undefined, provider: Record<string, unknown> = WIRE_TEST) =>
  resolveProviderSpec('wire-test', env({ 'wire-test': provider }), model)
const row = (id: string, wire?: unknown): ProviderModelInfo =>
  ({ id, supportsTools: true, ...(wire !== undefined ? { wire } : {}) }) as ProviderModelInfo

// ── Reading a wire ────────────────────────────────────────────────────────

describe('parseModelWire', () => {
  it('keeps every well-formed field', () => {
    const wire = {
      format: 'anthropic-messages',
      baseUrl: `${ORIGIN}/zen/`,
      path: '/v1/messages?beta=1',
      headers: { 'X-Team': 'core', authorization: '', 'x-key': '{{secret:api_key}}' },
      compat: { maxTokensField: 'max_tokens', developerRole: false, reasoningEffortField: false, reasoningReplay: 'none' },
    }
    expect(parseModelWire('p', wire)).toEqual({ ...wire, baseUrl: `${ORIGIN}/zen` })
  })

  it('drops what is malformed and keeps the rest; nothing usable is undefined', () => {
    expect(parseModelWire('p', { format: 'not a codec!', path: 'v1/x', baseUrl: 'ftp://h/x', headers: 'x', compat: 5 }))
      .toBeUndefined()
    expect(parseModelWire('p', { format: 'openai-chat', path: '//evil/x' })).toEqual({ format: 'openai-chat' })
    for (const junk of ['text', 7, true, [], null, undefined]) expect(parseModelWire('p', junk)).toBeUndefined()
  })

  it('filters headers: bad names and values, OAuth placeholders and CR/LF are dropped', () => {
    expect(parseModelWire('p', {
      headers: {
        'good-one': 'v',
        'bad name': 'v',
        'x-nl': 'a\r\nb: c',
        'x-oauth': 'Bearer {{oauth:access_token}}',
        'x-num': 5,
        'x-drop': '',
      },
    })).toEqual({ headers: { 'good-one': 'v', 'x-drop': '' } })
  })

  it('compat is a closed set: an unknown key is ignored and logged once, a bad value likewise', () => {
    const wire = { compat: { maxTokensField: 'tokens', extraSwitch: true, developerRole: true } }
    expect(parseModelWire('p', wire)).toEqual({ compat: { developerRole: true } })
    parseModelWire('p', wire)
    expect(warnings().filter(line => line.includes('unknown compat key "extraSwitch"'))).toHaveLength(1)
    expect(warnings().filter(line => line.includes('compat maxTokensField has an invalid value'))).toHaveLength(1)
  })
})

describe('isSafeWirePath', () => {
  it('accepts a path, with a query', () => {
    for (const ok of ['/v1/messages', '/chat/completions?x=1', '/a/b.c/d', '/models/x:stream']) {
      expect(isSafeWirePath(ok)).toBe(true)
    }
  })

  it('refuses a scheme, a host, `..`, encoded dots, backslashes, controls, fragments', () => {
    for (const bad of [
      '', 'v1/x', 'https://evil.example/x', '//evil.example/x', '/a/../b', '/a/./b', '/%2e%2e/x', '/%252e%252e/x',
      '/a/%2E%2e/b', '/a\\b', '/a\nb', '/a#b', '/x%zz', '/%5c..%5cx', `/${'a'.repeat(600)}`,
    ]) {
      expect(isSafeWirePath(bad), bad).toBe(false)
    }
    expect(isSafeWirePath(undefined)).toBe(false)
    expect(isSafeWirePath(7)).toBe(false)
  })
})

describe('the baseUrl origin guard', () => {
  const provider = `${ORIGIN}/zen/v1`

  it('keeps a base URL on the provider origin, whatever its path', () => {
    expect(confineModelWire('p', { baseUrl: `${ORIGIN}/zen` }, provider)).toEqual({ baseUrl: `${ORIGIN}/zen` })
    // The default port is the same origin.
    expect(confineModelWire('p', { baseUrl: `${ORIGIN}:443/zen` }, provider)).toBeDefined()
  })

  it('drops it — and only it — for another host, scheme or port, and logs', () => {
    for (const other of [
      'https://evil.example/zen',
      'http://wire.example.test/zen',
      'https://wire.example.test:8443/zen',
      'https://wire.example.test.evil.example/zen',
      'https://sub.wire.example.test/zen',
    ]) {
      expect(confineModelWire('p', { baseUrl: other, path: '/m', compat: { developerRole: true } }, provider), other)
        .toEqual({ path: '/m', compat: { developerRole: true } })
    }
    expect(warnings().some(line => line.includes('leaves the provider') && line.includes('evil.example'))).toBe(true)
    expect(confineModelWire('p', { baseUrl: 'https://evil.example/zen' }, provider)).toBeUndefined()
  })

  it('a provider with no base URL cannot vouch for one', () => {
    expect(confineModelWire('p', { baseUrl: `${ORIGIN}/zen` }, undefined)).toBeUndefined()
  })

  it('credentials, query and fragment in the URL are refused at parse time', () => {
    for (const bad of [`https://u:p@wire.example.test/zen`, `${ORIGIN}/zen?x=1`, `${ORIGIN}/zen#f`, `${ORIGIN}/a/../b`]) {
      expect(parseModelWire('p', { baseUrl: bad, path: '/ok' }), bad).toEqual({ path: '/ok' })
    }
  })

  it('resolveProviderSpec re-checks it on every resolution', () => {
    recordListedFigures('wire-test', [
      row('inside', { baseUrl: `${ORIGIN}/zen`, path: '/v1/messages' }),
      row('outside', { baseUrl: 'https://evil.example/zen', path: '/v1/messages' }),
    ])
    expect(resolve('inside')).toMatchObject({ baseUrl: `${ORIGIN}/zen`, path: '/v1/messages' })
    // Dropped, not unserved: the row keeps its other overrides.
    expect(resolve('outside')).toMatchObject({ baseUrl: `${ORIGIN}/zen/v1`, path: '/v1/messages' })
    // The user pointed the provider elsewhere afterwards: the old override no longer fits.
    expect(resolve('inside', { ...WIRE_TEST, baseUrl: 'https://relay.example.test/zen/v1' }))
      .toMatchObject({ baseUrl: 'https://relay.example.test/zen/v1' })
  })
})

// ── Merging over the provider's spec ──────────────────────────────────────

describe('resolveProviderSpec(provider, config, model)', () => {
  const provider: Record<string, unknown> = {
    ...WIRE_TEST,
    path: '/chat/completions',
    userAgent: 'Velloc',
    headers: { 'X-Team': 'core', Authorization: 'Bearer {{secret:api_key}}' },
    queryParams: { v: '1' },
    idleTimeoutMs: 5000,
  }

  it('without a model, or a model without a wire, the spec is the provider\'s', () => {
    recordListedFigures('wire-test', [row('plain'), row('other', { path: '/x' })])
    const bare = resolve(undefined, provider)
    expect(bare).toEqual({ ...provider, id: 'wire-test' })
    expect(resolve('plain', provider)).toEqual(bare)
    expect(resolve('not-listed', provider)).toEqual(bare)
  })

  it('format, base URL and path override; a format change without a path drops the provider path', () => {
    recordListedFigures('wire-test', [
      row('both', { format: 'anthropic-messages', baseUrl: `${ORIGIN}/zen`, path: '/v1/messages' }),
      row('format-only', { format: 'anthropic-messages' }),
      row('path-only', { path: '/other' }),
      row('same-format', { format: 'openai-chat' }),
    ])
    expect(resolve('both', provider)).toMatchObject({ format: 'anthropic-messages', baseUrl: `${ORIGIN}/zen`, path: '/v1/messages' })
    const formatOnly = resolve('format-only', provider)!
    expect(formatOnly.format).toBe('anthropic-messages')
    expect(formatOnly).not.toHaveProperty('path')
    expect(resolve('path-only', provider)).toMatchObject({ format: 'openai-chat', path: '/other' })
    expect(resolve('same-format', provider)).toMatchObject({ path: '/chat/completions' })
  })

  it('headers merge over the provider\'s case-insensitively; an empty value drops; secrets pass', () => {
    recordListedFigures('wire-test', [
      row('h', { headers: { 'x-team': 'model', authorization: '', 'x-signature': '{{secret:signing_key}}' } }),
    ])
    expect(resolve('h', provider)!.headers).toEqual({
      'x-team': 'model',
      authorization: '',
      'x-signature': '{{secret:signing_key}}',
    })
    expect(resolve('h', provider)).toMatchObject({ userAgent: 'Velloc', queryParams: { v: '1' }, idleTimeoutMs: 5000 })
    expect(mergeSpecHeaders({ A: '1', b: '2' }, { a: '3' })).toEqual({ a: '3', b: '2' })
    expect(mergeSpecHeaders(undefined, undefined)).toBeUndefined()
  })

  it('compat merges over the provider\'s own, switch by switch', () => {
    const spec: ProviderSpec = { id: 'p', format: 'openai-chat', compat: { developerRole: true, maxTokensField: 'max_tokens' } }
    expect(applyModelWire(spec, { compat: { maxTokensField: 'max_completion_tokens' } }).compat)
      .toEqual({ developerRole: true, maxTokensField: 'max_completion_tokens' })
  })

  it('a format this bundle has no codec for is not served', () => {
    recordListedFigures('wire-test', [row('x', { format: 'no-such-codec' })])
    expect(resolve('x', provider)).toBeUndefined()
  })

  it('a wire with nothing usable leaves the spec alone', () => {
    recordListedFigures('wire-test', [row('junk', { path: '/../x' })])
    expect(resolve('junk', provider)).toEqual(resolve(undefined, provider))
  })

  it('sanitizeModelWire reports nothing for a wire that is entirely refused', () => {
    expect(sanitizeModelWire('p', { path: 'x' }, `${ORIGIN}/v1`)).toBeUndefined()
  })
})

// ── The ModelProvider cache ───────────────────────────────────────────────

describe('the ModelProvider cache', () => {
  const base: ProviderSpec = { id: 'wire-test', format: 'openai-chat', baseUrl: `${ORIGIN}/zen/v1` }

  it('a model without a wire shares the provider\'s one instance', () => {
    const providerFor = createModelProviderCache()
    recordListedFigures('wire-test', [row('a'), row('b')])
    const first = providerFor(resolve('a')!)
    expect(providerFor(resolve('b')!)).toBe(first)
    expect(providerFor(resolve(undefined)!)).toBe(first)
    expect(providerFor({ ...base })).toBe(first)
  })

  it('a different format, base URL or path is a different instance; the same wire shares', () => {
    const providerFor = createModelProviderCache()
    recordListedFigures('wire-test', [
      row('a'),
      row('anthropic', { format: 'anthropic-messages', baseUrl: `${ORIGIN}/zen` }),
      row('anthropic-2', { format: 'anthropic-messages', baseUrl: `${ORIGIN}/zen` }),
      row('pathed', { path: '/custom' }),
    ])
    const plain = providerFor(resolve('a')!)
    const anthropic = providerFor(resolve('anthropic')!)
    const pathed = providerFor(resolve('pathed')!)
    expect(new Set([plain, anthropic, pathed]).size).toBe(3)
    expect(providerFor(resolve('anthropic-2')!)).toBe(anthropic)
    expect(anthropic.format).toBe('anthropic-messages')
    expect(anthropic.context('anthropic').baseUrl).toBe(`${ORIGIN}/zen`)
  })

  it('codec switches reach the codec through the instance\'s context', () => {
    const providerFor = createModelProviderCache()
    recordListedFigures('wire-test', [row('c', { compat: { maxTokensField: 'max_tokens' } })])
    expect(providerFor(resolve('c')!).context('c').compat).toEqual({ maxTokensField: 'max_tokens' })
    expect(providerFor(resolve('zzz')!).context('zzz')).not.toHaveProperty('compat')
  })
})

// ── The codec switches ────────────────────────────────────────────────────

const context = (compat?: CodecCompat) => ({
  providerId: 'acme',
  baseUrl: 'https://api.example.com/v1',
  model: 'gpt-x',
  ...(compat ? { compat } : {}),
})
const enc = new TextEncoder()
const bodyOf = (driver: { buildRequest: Function }, payload: BridgeModelRequestPayload, compat?: CodecCompat) =>
  new TextDecoder().decode(driver.buildRequest(payload, context(compat)).body)
const jsonOf = (text: string) => JSON.parse(text) as Record<string, any>

const PAYLOAD = {
  systemPrompt: ['You are X.'],
  messages: [{ role: 'user', content: 'hi' }],
  maxOutputTokens: 100,
  providerBodyExtension: { reasoning_effort: 'high', reasoning: { effort: 'high' } },
} as unknown as BridgeModelRequestPayload

describe('openai-chat codec switches', () => {
  it('no switch, or an empty compat, is today\'s request byte for byte', () => {
    const today = bodyOf(openaiChatDriver, PAYLOAD)
    expect(bodyOf(openaiChatDriver, PAYLOAD, {})).toBe(today)
    const parsed = jsonOf(today)
    expect(parsed.max_completion_tokens).toBe(100)
    expect(parsed.messages[0].role).toBe('system')
    expect(parsed.reasoning_effort).toBe('high')
    expect(parsed.reasoning).toEqual({ effort: 'high' })
  })

  it('maxTokensField names the cap\'s key', () => {
    const parsed = jsonOf(bodyOf(openaiChatDriver, PAYLOAD, { maxTokensField: 'max_tokens' }))
    expect(parsed.max_tokens).toBe(100)
    expect(parsed).not.toHaveProperty('max_completion_tokens')
    expect(jsonOf(bodyOf(openaiChatDriver, PAYLOAD, { maxTokensField: 'max_completion_tokens' })).max_completion_tokens).toBe(100)
  })

  it('developerRole true sends system text as `developer`; false is the default role', () => {
    expect(jsonOf(bodyOf(openaiChatDriver, PAYLOAD, { developerRole: true })).messages[0])
      .toEqual({ role: 'developer', content: 'You are X.' })
    expect(bodyOf(openaiChatDriver, PAYLOAD, { developerRole: false })).toBe(bodyOf(openaiChatDriver, PAYLOAD))
    // Only system moves: the user message stays a user message.
    expect(jsonOf(bodyOf(openaiChatDriver, PAYLOAD, { developerRole: true })).messages[1].role).toBe('user')
  })

  it('reasoningEffortField false leaves the effort / reasoning field out; true keeps it', () => {
    const parsed = jsonOf(bodyOf(openaiChatDriver, PAYLOAD, { reasoningEffortField: false }))
    expect(parsed).not.toHaveProperty('reasoning_effort')
    expect(parsed).not.toHaveProperty('reasoning')
    expect(parsed.max_completion_tokens).toBe(100)
    expect(bodyOf(openaiChatDriver, PAYLOAD, { reasoningEffortField: true })).toBe(bodyOf(openaiChatDriver, PAYLOAD))
  })

  describe('reasoningReplay', () => {
    const decode = (compat: CodecCompat | undefined, ...frames: unknown[]): DriverStreamEvent[] => {
      const decoder = openaiChatDriver.createDecoder(context(compat))
      const text = frames.map(f => `data: ${JSON.stringify(f)}\n\n`).join('')
      return [...decoder.push(enc.encode(text)), ...decoder.end()]
    }
    const delta = (d: Record<string, unknown>, finish: string | null = null) => ({
      choices: [{ index: 0, delta: d, finish_reason: finish }],
    })
    const stream = [
      delta({ reasoning_content: 'weigh ' }),
      delta({ reasoning_content: 'it', content: 'Pick B.' }),
      delta({ reasoning_details: [{ type: 'reasoning.encrypted', data: 'opaque', index: 0 }] }, 'stop'),
    ]
    const signatureOf = (compat: CodecCompat | undefined) =>
      (decode(compat, ...stream).find(e => e.type === 'reasoning_signature') as { signature: string } | undefined)?.signature
    const assistantWith = (signature: string): BridgeModelRequestPayload => ({
      messages: [
        { role: 'user', content: 'q' },
        { role: 'assistant', content: [{ type: 'thinking', thinking: 'weigh it', signature }, { type: 'text', text: 'Pick B.' }] },
        { role: 'user', content: 'go on' },
      ],
    }) as unknown as BridgeModelRequestPayload
    const assistantOf = (signature: string, compat?: CodecCompat) =>
      jsonOf(bodyOf(openaiChatDriver, assistantWith(signature), compat)).messages[1]

    it('the default replays the provider\'s reasoning_details and never the text field', () => {
      const signature = signatureOf(undefined)!
      expect(signature).toContain('"field":"reasoning_details"')
      expect(assistantOf(signature)).toEqual({
        role: 'assistant',
        content: 'Pick B.',
        reasoning_details: [{ data: 'opaque', index: 0, type: 'reasoning.encrypted' }],
      })
    })

    for (const field of ['reasoning_content', 'reasoning'] as const) {
      it(`${field} sends the reasoning text under that field, and only that field`, () => {
        const compat: CodecCompat = { reasoningReplay: field }
        const signature = signatureOf(compat)!
        expect(signature).toContain(`"field":"${field}"`)
        expect(signature).toContain('"value":"weigh it"')
        expect(assistantOf(signature, compat)).toEqual({ role: 'assistant', content: 'Pick B.', [field]: 'weigh it' })
        // A text made for the other field is not sent under this one.
        const other = field === 'reasoning' ? 'reasoning_content' : 'reasoning'
        expect(assistantOf(signatureOf({ reasoningReplay: other })!, compat)).toEqual({ role: 'assistant', content: 'Pick B.' })
      })
    }

    it('none emits no replay and sends none, even for an envelope an older request made', () => {
      expect(signatureOf({ reasoningReplay: 'none' })).toBeUndefined()
      const old = signatureOf(undefined)!
      expect(assistantOf(old, { reasoningReplay: 'none' })).toEqual({ role: 'assistant', content: 'Pick B.' })
    })

    it('a reasoning-less response emits no text replay', () => {
      expect(
        decode({ reasoningReplay: 'reasoning_content' }, delta({ content: 'hi' }, 'stop'))
          .some(e => e.type === 'reasoning_signature'),
      ).toBe(false)
    })

    it('an envelope for the wrong model is dropped in every mode', () => {
      const stray = encodeReasoningReplaySignature(
        'acme',
        'other-model',
        parseHostJson('{"field":"reasoning","value":"x"}') as HostDict,
      )!
      expect(assistantOf(stray, { reasoningReplay: 'reasoning' })).toEqual({ role: 'assistant', content: 'Pick B.' })
    })
  })
})

describe('openai-responses codec switches', () => {
  const responsesBody = (compat?: CodecCompat) => jsonOf(bodyOf(openaiResponsesDriver, PAYLOAD, compat))

  it('no switch is today\'s request byte for byte', () => {
    const today = bodyOf(openaiResponsesDriver, PAYLOAD)
    expect(bodyOf(openaiResponsesDriver, PAYLOAD, {})).toBe(today)
    expect(bodyOf(openaiResponsesDriver, PAYLOAD, { developerRole: false })).toBe(today)
    const parsed = jsonOf(today)
    expect(parsed.instructions).toBe('You are X.')
    expect(parsed.reasoning).toEqual({ effort: 'high' })
    expect(parsed.max_output_tokens).toBe(100)
  })

  it('developerRole true sends the system text as a developer message instead of instructions', () => {
    const parsed = responsesBody({ developerRole: true })
    expect(parsed).not.toHaveProperty('instructions')
    expect(parsed.input[0]).toEqual({ type: 'message', role: 'developer', content: 'You are X.' })
  })

  it('reasoningEffortField false leaves `reasoning` out', () => {
    expect(responsesBody({ reasoningEffortField: false })).not.toHaveProperty('reasoning')
  })

  it('maxTokensField and reasoningReplay are ignored: this API has its own field and replays no text', () => {
    const today = bodyOf(openaiResponsesDriver, PAYLOAD)
    expect(bodyOf(openaiResponsesDriver, PAYLOAD, { maxTokensField: 'max_tokens', reasoningReplay: 'reasoning' })).toBe(today)
  })
})

describe('codecs that implement none of the switches', () => {
  const everything: CodecCompat = {
    maxTokensField: 'max_tokens',
    developerRole: true,
    reasoningEffortField: false,
    reasoningReplay: 'reasoning',
  }
  for (const [name, driver] of [
    ['anthropic-messages', anthropicMessagesDriver],
    ['gemini', geminiDriver],
    ['ollama-chat', ollamaChatDriver],
  ] as const) {
    it(`${name} sends the same bytes with every switch set`, () => {
      expect(bodyOf(driver, PAYLOAD, everything)).toBe(bodyOf(driver, PAYLOAD))
    })
  }
})

// ── Persistence ───────────────────────────────────────────────────────────

describe('the wire rides the listing cache', () => {
  function host(cache: Record<string, string>) {
    const provider: RuntimeProvidersHost = {
      writeProviderConfig: async () => {},
      readCache: async id => cache[id],
      writeCache: async (id, text) => {
        cache[id] = text
      },
    }
    configureRuntimeProviders(provider)
  }
  const OR = 'https://openrouter.ai'
  const cachedListing = (models: unknown[], extra: Record<string, unknown> = {}) =>
    JSON.stringify({ models, fetchedAt: Date.now(), ...extra })
  const coldStart = async () => {
    setRuntimeProviderConfigs({ openrouter: { hasApiKey: true, enabledModels: ['a/plain'] } })
    const request = vi.fn()
    await refreshConfiguredRuntimeProviderModels({ request } as unknown as BrowserBridgeTransport)
    // A fresh cached listing needs no fetch.
    expect(request).not.toHaveBeenCalled()
  }
  const good = {
    format: 'anthropic-messages',
    baseUrl: `${OR}/api/anthropic`,
    path: '/messages',
    headers: { 'x-t': '1' },
    compat: { maxTokensField: 'max_tokens' },
  }

  it('a restart replays it: the cached row routes the model again', async () => {
    host({ openrouter: cachedListing([row('a/plain'), row('a/wired', good)]) })
    await coldStart()
    expect(listedFigures('openrouter', 'a/wired')?.wire).toEqual(good)
    expect(resolveProviderSpec('openrouter', undefined, 'a/wired')).toMatchObject({
      format: 'anthropic-messages',
      baseUrl: `${OR}/api/anthropic`,
      path: '/messages',
      headers: { 'x-t': '1' },
      compat: { maxTokensField: 'max_tokens' },
    })
    expect(resolveProviderSpec('openrouter', undefined, 'a/plain')).toMatchObject({ format: 'openai-chat' })
    expect(resolveProviderSpec('openrouter', undefined, 'a/plain')).not.toHaveProperty('compat')
  })

  it('the cache file keeps the row\'s wire when the listing is written back', async () => {
    const cache = {
      openrouter: cachedListing([row('a/wired', good)], { removed: { ids: ['gone'], at: 1 } }),
    }
    host(cache)
    await coldStart()
    dismissRemovedNotice('openrouter')
    expect(JSON.parse(cache.openrouter).models[0].wire).toEqual(good)
  })

  it('an off-origin base URL is dropped when the row is applied; the row and its other fields stay', async () => {
    host({
      openrouter: cachedListing([
        row('a/evil', { baseUrl: 'https://evil.example/v1', path: '/messages', compat: { developerRole: true } }),
      ]),
    })
    await coldStart()
    expect(listedFigures('openrouter', 'a/evil')?.wire).toEqual({ path: '/messages', compat: { developerRole: true } })
    expect(resolveProviderSpec('openrouter', undefined, 'a/evil')).toMatchObject({ path: '/messages' })
    expect(resolveProviderSpec('openrouter', undefined, 'a/evil')?.baseUrl).toBeUndefined()
  })

  it('a corrupt wire is dropped without losing the row; other rows are untouched', async () => {
    host({
      openrouter: cachedListing([
        row('a/str', 'garbage'),
        row('a/null', null),
        row('a/array', [1, 2]),
        row('a/partial', { format: 42, path: '/ok', headers: { 'bad name': 'x' }, compat: { nope: 1 } }),
        row('a/wired', good),
        null,
        { id: 7, supportsTools: true },
      ]),
    })
    await coldStart()
    for (const id of ['a/str', 'a/null', 'a/array']) {
      expect(listedFigures('openrouter', id)?.wire, id).toBeUndefined()
      expect(resolveProviderSpec('openrouter', undefined, id), id).toMatchObject({ format: 'openai-chat' })
    }
    expect(listedFigures('openrouter', 'a/partial')?.wire).toEqual({ path: '/ok' })
    expect(listedFigures('openrouter', 'a/wired')?.wire).toEqual(good)
  })

  it('a cache that is not JSON is ignored', async () => {
    host({ openrouter: '{not json' })
    setRuntimeProviderConfigs({ openrouter: { hasApiKey: true, enabledModels: ['a/plain'] } })
    const request = vi.fn(async () => ({ ok: false, error: { code: 'x', message: 'no network' } }))
    await expect(
      refreshConfiguredRuntimeProviderModels({ request } as unknown as BrowserBridgeTransport),
    ).resolves.toBeUndefined()
  })
})

// ── Two models of one provider, two formats, two paths ────────────────────

describe('withModelProviders: one provider, two wires', () => {
  const OK = { ok: true, result: { streamId: 'raw-x', status: 200, statusText: 'OK', finalUrl: 'u', headers: {} } }

  function fakeHost() {
    const opens: Array<{ url: string; headers: Record<string, string>; body: Uint8Array; providerId: string }> = []
    const transport: BrowserBridgeTransport = {
      async request(req: any) {
        const reply = (body: object) => ({ id: req.id, route: req.route, ...body }) as any
        if (req.route.action === 'rawStreamOpen') {
          opens.push(req.payload)
          return reply(OK)
        }
        if (req.route.action === 'rawStreamRead') return reply({ ok: true, result: { done: true, chunk: new Uint8Array(0) } })
        return reply({ ok: true, result: { ok: true } })
      },
    }
    return { transport, opens }
  }

  const start = (wrapped: BrowserBridgeTransport, model: string) =>
    wrapped.request({
      id: `r-${model}`,
      route: { capability: 'model', action: 'streamStart' },
      payload: { ...(PAYLOAD as object), providerId: 'wire-test', model },
    } as never) as Promise<any>

  it('sends an Anthropic-format model under /zen and a chat model under /zen/v1', async () => {
    recordListedFigures('wire-test', [
      row('messages-model', { format: 'anthropic-messages', baseUrl: `${ORIGIN}/zen`, headers: { 'x-api-key': '', authorization: 'Bearer {{secret:api_key}}' } }),
      row('chat-model', { compat: { maxTokensField: 'max_tokens' } }),
      row('plain'),
    ])
    const { transport, opens } = fakeHost()
    const wrapped = withModelProviders(transport, env({ 'wire-test': WIRE_TEST }))

    for (const model of ['messages-model', 'chat-model', 'plain']) expect((await start(wrapped, model)).ok, model).toBe(true)
    await new Promise(resolve => setTimeout(resolve, 10))

    const byModel = Object.fromEntries(
      opens.map(open => [jsonOf(new TextDecoder().decode(open.body)).model, open]),
    )
    expect(byModel['messages-model']!.url).toBe(`${ORIGIN}/zen/v1/messages`)
    expect(byModel['chat-model']!.url).toBe(`${ORIGIN}/zen/v1/chat/completions`)
    expect(byModel.plain!.url).toBe(`${ORIGIN}/zen/v1/chat/completions`)
    // Each in its own format's body, with its own headers.
    const messagesBody = jsonOf(new TextDecoder().decode(byModel['messages-model']!.body))
    expect(messagesBody).toMatchObject({ system: expect.anything(), max_tokens: 100 })
    expect(Object.keys(byModel['messages-model']!.headers).map(name => name.toLowerCase()).sort())
      .toEqual(['anthropic-version', 'authorization', 'content-type'])
    const gpt = jsonOf(new TextDecoder().decode(byModel['chat-model']!.body))
    expect(gpt.max_tokens).toBe(100)
    expect(gpt).not.toHaveProperty('max_completion_tokens')
    expect(jsonOf(new TextDecoder().decode(byModel.plain!.body)).max_completion_tokens).toBe(100)
    expect(opens.every(open => open.providerId === 'wire-test')).toBe(true)
  })

  it('a row naming another host still goes to the provider\'s own', async () => {
    recordListedFigures('wire-test', [row('sneaky', { baseUrl: 'https://evil.example/zen', path: '/steal' })])
    const { transport, opens } = fakeHost()
    const wrapped = withModelProviders(transport, env({ 'wire-test': WIRE_TEST }))
    expect((await start(wrapped, 'sneaky')).ok).toBe(true)
    await new Promise(resolve => setTimeout(resolve, 10))
    expect(opens.map(open => open.url)).toEqual([`${ORIGIN}/zen/v1/steal`])
  })

  it('a model whose format has no codec answers provider_error and sends nothing', async () => {
    recordListedFigures('wire-test', [row('odd', { format: 'no-such-codec' })])
    const { transport, opens } = fakeHost()
    const wrapped = withModelProviders(transport, env({ 'wire-test': WIRE_TEST }))
    expect(await start(wrapped, 'odd')).toMatchObject({ ok: false, error: { code: 'provider_error' } })
    expect(opens).toEqual([])
  })
})
