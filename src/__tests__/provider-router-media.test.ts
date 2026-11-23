/**
 * The images and documents of a routed request (F-27): what the router is
 * told, what a target without that input is sent, and the one re-send after a
 * target that stated nothing refuses the request for its media.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { registerProviderDriver } from '../models/drivers/driverRegistry'
import type { ProviderDriver } from '../models/drivers/driverTypes'
import type { ModelProvider } from '../models/drivers/modelProvider'
import type { FailureEvent } from '../models/drivers/providerClassify'
import { routeCallOf } from '../models/drivers/providerRouteCall'
import { routeCall } from '../models/drivers/providerRouteResolution'
import type { ProviderRouter, RouteAnswer, RouteEvent } from '../models/drivers/providerRouter'
import { recordProviderVerdict } from '../models/drivers/providerHealthLedger'
import {
  __resetMediaRefusalsForTest,
  mediaIn,
  mediaOmittedFor,
  mediaRefusedBy,
  statedMediaSupport,
  withoutMedia,
  type MediaSupport,
} from '../models/drivers/routedMedia'
import { resetRuntimeProviders, setRuntimeProviderConfigs } from '../models/drivers/runtimeProviders'
import { DefaultRuntimeConfig } from '../runtime/testing/noopAdapters'

const stated = vi.hoisted(() => ({ support: {} as Record<string, MediaSupport> }))
vi.mock('../models/drivers/routedMedia', async original => {
  const real = await original<typeof import('../models/drivers/routedMedia')>()
  return {
    ...real,
    statedMediaSupport: (provider: string, model: string) =>
      stated.support[provider] ?? real.statedMediaSupport(provider, model),
  }
})
vi.mock('../models/drivers/providerHealthLedger', async original => {
  const real = await original<typeof import('../models/drivers/providerHealthLedger')>()
  return { ...real, recordProviderVerdict: vi.fn(real.recordProviderVerdict) }
})

const driver: ProviderDriver = {
  id: 'media-json',
  auth: { headers: {} },
  buildRequest: (_payload, context) => ({ url: `${context.baseUrl}/v1`, method: 'POST', headers: {}, body: new Uint8Array() }),
  createDecoder: () => ({ push: () => [], end: () => [] }),
  errorFromResponse: ({ status, bodyText }) => ({ type: 'error', message: bodyText, httpStatus: status }),
}
registerProviderDriver(driver)

const ROUTER = 'media-router'
const A = 'media-a'
const B = 'media-b'
const config = new DefaultRuntimeConfig({
  providerDrivers: JSON.stringify({
    [A]: { format: 'media-json', baseUrl: 'https://a.vendor.example' },
    [B]: { format: 'media-json', baseUrl: 'https://b.vendor.example' },
  }),
})
const entry = (id: string) => ({ family: id, version: '1', id })
const toA: RouteAnswer = { provider: A, model: 'm-a' }
const toB: RouteAnswer = { provider: B, model: 'm-b' }

const IMAGE = { type: 'image', image: 'data:image/png;base64,AAAA' }
const DOCUMENT = { type: 'document', data: 'JVBERi0=', mediaType: 'application/pdf' }
const IMAGE_GONE = { type: 'text', text: '[image omitted: the selected model does not support image input]' }
const DOCUMENT_GONE = { type: 'text', text: '[document omitted: the selected model does not support document input]' }

const messages = () => [
  { role: 'user', content: [{ type: 'text', text: 'look' }, IMAGE] },
  { role: 'assistant', content: [{ type: 'tool-call', toolCallId: 't1', toolName: 'read', args: {} }] },
  { role: 'tool', content: [{ type: 'tool-result', toolCallId: 't1', toolName: 'read', result: [{ type: 'text', text: 'page' }, IMAGE, DOCUMENT] }] },
  { type: 'user', message: { role: 'user', content: [DOCUMENT] } },
  { role: 'user', content: 'plain' },
]

const payload = (extra: Record<string, unknown> = {}) => ({
  providerId: ROUTER,
  model: 'route-row',
  messages: messages(),
  maxOutputTokens: 1000,
  ...extra,
})

function routing(answers: RouteAnswer[], body: Record<string, unknown> = payload()) {
  const events: RouteEvent[] = []
  const router: ProviderRouter = {
    async route(e) {
      events.push(structuredClone(e))
      return answers.length > 1 ? answers.shift() : answers[0]
    },
  }
  const route = routeCall(ROUTER, router, { routesTo: '*' }, body as never, {
    runtimeConfig: config,
    providerFor: () => ({}) as ModelProvider,
  })
  return { route, events, body }
}

const signal = () => new AbortController().signal
const legOf = async (route: ReturnType<typeof routing>['route']) => {
  const first = await route.resolve(signal())
  if (!('leg' in first)) throw new Error('the router stopped the request')
  return first.leg
}
const refusal = (message: string, httpStatus = 404): FailureEvent => ({ type: 'error', message, httpStatus })
const NO_IMAGE_ENDPOINT = 'API Error: 404 {"error":{"message":"No endpoints found that support image input","code":404}}'

beforeEach(() => {
  stated.support = {}
  vi.mocked(recordProviderVerdict).mockClear()
  setRuntimeProviderConfigs({
    [A]: { apiKey: 'k', modelEntries: [entry('m-a')] },
    [B]: { apiKey: 'k', modelEntries: [entry('m-b')] },
  } as never)
})

afterEach(() => {
  __resetMediaRefusalsForTest()
  resetRuntimeProviders()
})

describe('the media of a request', () => {
  it('is counted at the top level, inside a tool result and on a nested message', () => {
    expect(mediaIn(messages() as never)).toEqual({ images: true, documents: true })
    expect(mediaIn([{ role: 'user', content: [IMAGE] }] as never)).toEqual({ images: true, documents: false })
    expect(mediaIn([{ role: 'tool', content: [{ type: 'tool-result', result: [DOCUMENT] }] }] as never)).toEqual({ images: false, documents: true })
    expect(mediaIn([{ type: 'user', message: { role: 'user', content: [IMAGE] } }] as never)).toEqual({ images: true, documents: false })
    expect(mediaIn([{ role: 'user', content: 'an image of text' }] as never)).toEqual({ images: false, documents: false })
    expect(mediaIn(undefined)).toEqual({ images: false, documents: false })
  })

  it('becomes placeholders of the kinds asked, in a copy', () => {
    const before = messages()
    const kept = structuredClone(before)
    const out = withoutMedia(before as never, { images: true, documents: false }) as any[]

    expect(before).toEqual(kept)
    expect(out[0].content).toEqual([{ type: 'text', text: 'look' }, IMAGE_GONE])
    expect(out[2].content[0].result).toEqual([{ type: 'text', text: 'page' }, IMAGE_GONE, DOCUMENT])
    expect(out[3].message.content).toEqual([DOCUMENT])
    // A message with nothing to replace is the same object.
    expect(out[1]).toBe(before[1])
    expect(out[4]).toBe(before[4])

    const both = withoutMedia(before as never, { images: true, documents: true }) as any[]
    expect(both[2].content[0].result).toEqual([{ type: 'text', text: 'page' }, IMAGE_GONE, DOCUMENT_GONE])
    expect(both[3].message.content).toEqual([DOCUMENT_GONE])
    expect(withoutMedia(before as never, { images: false, documents: false })).toBe(before)
  })
})

describe('a refusal for media', () => {
  const both = { images: true, documents: true }
  const none = { images: false, documents: false }

  it('is read from a client error that names the kind as not supported', () => {
    expect(mediaRefusedBy(refusal(NO_IMAGE_ENDPOINT), both)).toEqual({ images: true, documents: false })
    expect(mediaRefusedBy(refusal('This model does not support image_url content', 400), both)).toEqual({ images: true, documents: false })
    expect(mediaRefusedBy(refusal('Unsupported input: PDF documents are not supported', 400), both)).toEqual({ images: false, documents: true })
    expect(mediaRefusedBy({ type: 'error', message: 'vision is not enabled for this model' }, both)).toEqual({ images: true, documents: false })
  })

  it('is not read from another status, another complaint, or media that was not sent', () => {
    expect(mediaRefusedBy(refusal(NO_IMAGE_ENDPOINT, 500), both)).toEqual(none)
    expect(mediaRefusedBy(refusal(NO_IMAGE_ENDPOINT, 429), both)).toEqual(none)
    expect(mediaRefusedBy(refusal('The image is too large', 400), both)).toEqual(none)
    expect(mediaRefusedBy(refusal('model not found', 404), both)).toEqual(none)
    expect(mediaRefusedBy(refusal('tools are not supported', 400), both)).toEqual(none)
    expect(mediaRefusedBy(refusal(NO_IMAGE_ENDPOINT), none)).toEqual(none)
    expect(mediaRefusedBy(refusal(NO_IMAGE_ENDPOINT), { images: false, documents: true })).toEqual(none)
  })
})

describe('what a target states about media', () => {
  it("reads a custom provider's own model, and nothing for a model that states nothing", () => {
    setRuntimeProviderConfigs({
      custom: {
        isCustomProvider: true,
        customModels: [
          { modelId: 'text-only', capabilities: { vision: false } },
          { modelId: 'sees', capabilities: { vision: true } },
          { modelId: 'silent' },
        ],
      },
    } as never)
    expect(statedMediaSupport('custom', 'text-only')).toEqual({ images: false })
    expect(statedMediaSupport('custom', 'sees')).toEqual({ images: true })
    expect(statedMediaSupport('custom', 'silent')).toEqual({})
    expect(statedMediaSupport('nobody', 'm')).toEqual({})
  })

  it('leaves out only what is stated as unsupported', () => {
    expect(mediaOmittedFor(A, 'm-a', {})).toEqual({ images: false, documents: false })
    expect(mediaOmittedFor(A, 'm-a', { images: true })).toEqual({ images: false, documents: false })
    expect(mediaOmittedFor(A, 'm-a', { images: false, documents: true })).toEqual({ images: true, documents: false })
  })
})

describe('a routed request with media', () => {
  it('tells the router which kinds it carries', async () => {
    const withBoth = routing([toA])
    const withNone = routing([toA], payload({ messages: [{ role: 'user', content: 'x' }] }))
    const withImage = routing([toA], payload({ messages: [{ role: 'user', content: [IMAGE] }] }))
    await legOf(withBoth.route)
    await legOf(withNone.route)
    await legOf(withImage.route)

    expect(withBoth.events[0]!.request).toEqual({ tools: false, images: true, documents: true })
    expect(withNone.events[0]!.request).toEqual({ tools: false, images: false, documents: false })
    expect(withImage.events[0]!.request).toEqual({ tools: false, images: true, documents: false })
  })

  it('reaches a target that takes media, or states nothing, as it was built', async () => {
    stated.support = { [A]: { images: true, documents: true } }
    const sees = routing([toA])
    expect((await legOf(sees.route)).payload.messages).toBe(sees.body.messages)

    const silent = routing([toB])
    expect((await legOf(silent.route)).payload.messages).toBe(silent.body.messages)
  })

  it("reaches a target without image input with placeholders, and leaves the call's payload alone", async () => {
    stated.support = { [B]: { images: false } }
    const { route, body } = routing([toB])
    const kept = structuredClone(body.messages)

    const sent = (await legOf(route)).payload.messages as any[]

    expect(sent[0].content).toEqual([{ type: 'text', text: 'look' }, IMAGE_GONE])
    expect(sent[2].content[0].result).toEqual([{ type: 'text', text: 'page' }, IMAGE_GONE, DOCUMENT])
    expect(sent[3].message.content).toEqual([DOCUMENT])
    expect(body.messages).toEqual(kept)
  })

  it('is sent once more to the same target without the media it refused, and the router is not asked', async () => {
    const { route, events, body } = routing([toA])
    const first = await legOf(route)
    expect(first.payload.messages).toBe(body.messages)

    const decision = await route.after(refusal(NO_IMAGE_ENDPOINT), false, signal())

    expect(decision.kind).toBe('switch')
    if (decision.kind !== 'switch') return
    expect(decision.leg.target).toEqual(toA)
    const sent = decision.leg.payload.messages as any[]
    expect(sent[0].content[1]).toEqual(IMAGE_GONE)
    // The documents were not what it refused.
    expect(sent[3].message.content).toEqual([DOCUMENT])
    expect(events).toHaveLength(1)
    expect(routeCallOf(body).sends).toBe(2)
    expect(routeCallOf(body).lastFailure).toBeUndefined()
    // Not a failure of the target: nothing is held against it.
    expect(recordProviderVerdict).not.toHaveBeenCalled()
  })

  it('puts a second refusal of the same call to the router like any failure', async () => {
    const { route, events } = routing([toA, toB])
    await legOf(route)
    await route.after(refusal(NO_IMAGE_ENDPOINT), false, signal())

    const again = await route.after(refusal(NO_IMAGE_ENDPOINT), false, signal())

    expect(events).toHaveLength(2)
    expect(again.kind === 'switch' ? again.leg.target : undefined).toEqual(toB)
  })

  it('remembers the refusal: the next call to that target starts without the media', async () => {
    const one = routing([toA])
    await legOf(one.route)
    await one.route.after(refusal(NO_IMAGE_ENDPOINT), false, signal())

    const two = routing([toA])
    const sent = (await legOf(two.route)).payload.messages as any[]
    expect(sent[0].content[1]).toEqual(IMAGE_GONE)
    // The router is still told what the request carries.
    expect(two.events[0]!.request.images).toBe(true)

    const other = routing([toB])
    expect((await legOf(other.route)).payload.messages).toBe(other.body.messages)
  })

  it('leaves a refusal alone once a reply had started, and one that is not about media', async () => {
    const started = routing([toA])
    await legOf(started.route)
    const afterStart = await started.route.after(refusal(NO_IMAGE_ENDPOINT), true, signal())
    expect(afterStart.kind === 'switch' ? afterStart.leg.payload.messages : started.body.messages).toBe(started.body.messages)

    const other = routing([toA])
    await legOf(other.route)
    const unrelated = await other.route.after(refusal('rate limited', 429), false, signal())
    expect(unrelated.kind === 'switch' ? unrelated.leg.payload.messages : other.body.messages).toBe(other.body.messages)

    const next = routing([toA])
    expect((await legOf(next.route)).payload.messages).toBe(next.body.messages)
  })
})
