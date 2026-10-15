import { describe, expect, it, vi } from 'vitest'
import type { BrowserBridgeTransport } from '../browser/bridge/browserBridgeProtocol'
import { __test_only_directPortRoutePolicy } from '../browser/bridge/DirectPortBridgeTransport'
import {
  openRawProviderStream,
  RAW_STREAM_MAX_IDLE_TIMEOUT_MS,
  RawProviderStreamError,
} from '../browser/bridge/rawProviderStream'

type Call = { action: string; payload: Record<string, any> }
type Reply = { ok: true; result: any } | { ok: false; error: { code: string; message: string } }

// Scripted host: `open` answers rawStreamOpen, `reads` answer successive
// rawStreamRead calls, cancel always succeeds.
function fakeHost(open: Reply, reads: Reply[]) {
  const calls: Call[] = []
  const transport: BrowserBridgeTransport = {
    async request(req: any) {
      const action = req.route.action as string
      calls.push({ action, payload: req.payload })
      if (req.route.capability !== 'model') throw new Error('wrong capability')
      if (action === 'rawStreamOpen') return open as any
      if (action === 'rawStreamCancel') return { ok: true, result: { ok: true } } as any
      const next = reads.shift()
      if (!next) throw new Error('unexpected read')
      return next as any
    },
  }
  return { transport, calls }
}

const OPENED: Reply = {
  ok: true,
  result: {
    streamId: 's1',
    status: 200,
    statusText: 'OK',
    finalUrl: 'https://agent.example.com/svc.Agent/Run',
    headers: { 'content-type': 'application/connect+proto' },
  },
}
const bytes = (...b: number[]) => new Uint8Array(b)
const read = (chunk: Uint8Array, done = false, extra: object = {}): Reply => ({
  ok: true,
  result: { done, chunk, ...extra },
})

async function collect(body: AsyncIterable<Uint8Array>): Promise<number[]> {
  const out: number[] = []
  for await (const c of body) out.push(...c)
  return out
}

describe('raw provider stream', () => {
  it('a reply that is not the host shape fails loudly instead of reading forever', async () => {
    // An open with no stream id / status: an error, not a stream.
    const notOpened = fakeHost({ ok: true, result: { providers: [] } }, [])
    await expect(openRawProviderStream(notOpened.transport, { providerId: 'p', url: 'https://h.example.com/x' }))
      .rejects.toMatchObject({ code: 'PROTOCOL' })
    // A read with no `done`: the body throws on the first one (it used to spin).
    const { transport, calls } = fakeHost(OPENED, [{ ok: true, result: { providers: [] } }])
    const stream = await openRawProviderStream(transport, { providerId: 'p', url: 'https://h.example.com/x' })
    await expect(collect(stream.body)).rejects.toMatchObject({ code: 'PROTOCOL' })
    expect(calls.filter(c => c.action === 'rawStreamRead')).toHaveLength(1)
  })

  it('ships the request body on a port and stitches each read chunk back', () => {
    const model = (__test_only_directPortRoutePolicy as any).model
    expect(model.rawStreamOpen).toEqual({ mode: 'request_port', requestBinaryField: 'body' })
    expect(model.rawStreamRead).toEqual({ mode: 'response_port', resultBinaryFields: ['chunk'] })
  })

  it('opens with the provider scope and yields bytes in order until done', async () => {
    const { transport, calls } = fakeHost(OPENED, [
      read(bytes(0, 0, 0, 0, 2)),
      read(bytes()),
      read(bytes(8, 1), true),
    ])
    const stream = await openRawProviderStream(transport, {
      providerId: 'cursor',
      url: 'https://agent.example.com/svc.Agent/Run',
      headers: {
        'content-type': 'application/connect+proto',
        authorization: 'Bearer {{secret:access_token}}',
      },
      body: bytes(1, 2, 3),
    })
    expect(stream.status).toBe(200)
    expect(stream.headers['content-type']).toBe('application/connect+proto')
    expect(await collect(stream.body)).toEqual([0, 0, 0, 0, 2, 8, 1])

    const open = calls[0]!
    expect(open.action).toBe('rawStreamOpen')
    expect(open.payload.providerId).toBe('cursor')
    expect(Array.from(open.payload.body)).toEqual([1, 2, 3])
    // Only the placeholder travels guest -> host; the host substitutes it.
    expect(open.payload.headers.authorization).toBe('Bearer {{secret:access_token}}')
    expect(calls.filter(c => c.action === 'rawStreamRead').every(c => c.payload.streamId === 's1')).toBe(true)
    // Ended normally: no cancel.
    expect(calls.some(c => c.action === 'rawStreamCancel')).toBe(false)
  })

  it('passes query params and secret captures through, and exposes the sealed captures', async () => {
    const { transport, calls } = fakeHost(OPENED, [
      read(bytes(123, 125), true, { captured: { access_token: 'NEXUSENC1:abc' } }),
    ])
    const stream = await openRawProviderStream(transport, {
      providerId: 'google',
      url: 'https://generativelanguage.googleapis.com/v1beta/models/x:streamGenerateContent',
      queryParams: { key: '{{secret:api_key}}', alt: 'sse' },
      captureSecrets: [{ pointer: '/accessToken', secret: 'access_token' }],
    })
    expect(stream.captured()).toBeUndefined()
    await collect(stream.body)
    expect(stream.captured()).toEqual({ access_token: 'NEXUSENC1:abc' })
    expect(calls[0]!.payload.queryParams).toEqual({ key: '{{secret:api_key}}', alt: 'sse' })
    expect(calls[0]!.payload.captureSecrets).toEqual([
      { pointer: '/accessToken', secret: 'access_token' },
    ])
    expect('authHeader' in calls[0]!.payload).toBe(false)
  })

  it('clamps the idle timeout under the model route fallback', async () => {
    const { transport, calls } = fakeHost(OPENED, [read(bytes(), true)])
    const stream = await openRawProviderStream(transport, {
      providerId: 'p',
      url: 'https://x.example.com',
      idleTimeoutMs: 600_000,
    })
    await collect(stream.body)
    expect(calls[0]!.payload.idleTimeoutMs).toBe(RAW_STREAM_MAX_IDLE_TIMEOUT_MS)
    expect(Array.from(calls[0]!.payload.body)).toEqual([])
  })

  it('surfaces a host refusal at open as a typed error', async () => {
    const { transport } = fakeHost(
      { ok: false, error: { code: 'TARGET_NOT_ALLOWED', message: 'outside domain' } },
      [],
    )
    await expect(
      openRawProviderStream(transport, { providerId: 'p', url: 'https://evil.org' }),
    ).rejects.toMatchObject({ code: 'TARGET_NOT_ALLOWED' })
  })

  it('throws after delivering the bytes when the stream ends abnormally', async () => {
    const { transport } = fakeHost(OPENED, [
      read(bytes(7)),
      read(bytes(), true, { errorCode: 'TIMEOUT', errorMessage: 'idle' }),
    ])
    const stream = await openRawProviderStream(transport, { providerId: 'p', url: 'https://x.example.com' })
    const got: number[] = []
    await expect(async () => {
      for await (const c of stream.body) got.push(...c)
    }).rejects.toBeInstanceOf(RawProviderStreamError)
    expect(got).toEqual([7])
  })

  it('cancels upstream when the consumer stops early', async () => {
    const { transport, calls } = fakeHost(OPENED, [read(bytes(1)), read(bytes(2))])
    const stream = await openRawProviderStream(transport, { providerId: 'p', url: 'https://x.example.com' })
    for await (const _ of stream.body) break
    expect(calls.filter(c => c.action === 'rawStreamCancel')).toHaveLength(1)
  })

  it('cancels upstream once on abort', async () => {
    const controller = new AbortController()
    const { transport, calls } = fakeHost(OPENED, [read(bytes(1))])
    const stream = await openRawProviderStream(transport, {
      providerId: 'p',
      url: 'https://x.example.com',
      signal: controller.signal,
    })
    controller.abort()
    await stream.cancel()
    await expect(collect(stream.body)).rejects.toThrow()
    expect(calls.filter(c => c.action === 'rawStreamCancel')).toHaveLength(1)
  })

  it('detaches its abort listener on cancel() even when the body is never iterated', async () => {
    const controller = new AbortController()
    const removeSpy = vi.spyOn(controller.signal, 'removeEventListener')
    const { transport, calls } = fakeHost(OPENED, [read(bytes(1))])
    const stream = await openRawProviderStream(transport, {
      providerId: 'p',
      url: 'https://x.example.com',
      signal: controller.signal,
    })
    expect(removeSpy).not.toHaveBeenCalledWith('abort', expect.any(Function))
    await stream.cancel()
    // Only body()'s finally used to detach it; a consumer that cancels without
    // iterating left the listener on the caller's (possibly long-lived) signal.
    expect(removeSpy).toHaveBeenCalledWith('abort', expect.any(Function))
    expect(calls.filter(c => c.action === 'rawStreamCancel')).toHaveLength(1)
    // The detached listener must not fire a second cancel.
    controller.abort()
    await Promise.resolve()
    expect(calls.filter(c => c.action === 'rawStreamCancel')).toHaveLength(1)
  })
})

// A host whose open answers only when the test says so: the wait for the
// response head, made explicit.
function deferredOpenHost() {
  const calls: Call[] = []
  let settle: ((reply: Reply | Error) => void) | undefined
  const transport: BrowserBridgeTransport = {
    async request(req: any) {
      const action = req.route.action as string
      calls.push({ action, payload: req.payload })
      if (action === 'rawStreamOpen') {
        const reply = await new Promise<Reply | Error>(resolve => {
          settle = resolve
        })
        if (reply instanceof Error) throw reply
        return reply as any
      }
      if (action === 'rawStreamCancel') return { ok: true, result: { ok: true } } as any
      return read(bytes(), true) as any
    },
  }
  const openPayload = () => calls.find(c => c.action === 'rawStreamOpen')!.payload
  const cancels = () => calls.filter(c => c.action === 'rawStreamCancel').map(c => c.payload.streamId)
  const answer = (reply: Reply | Error) => settle!(reply)
  return { transport, calls, openPayload, cancels, answer }
}
const openedAs = (streamId: string): Reply => ({
  ok: true,
  result: { ...(OPENED as any).result, streamId },
})
const flush = () => new Promise(resolve => setTimeout(resolve, 0))

describe('raw provider stream - cancel before the response head', () => {
  it('names the stream itself and accepts the echo', async () => {
    const host = deferredOpenHost()
    const pending = openRawProviderStream(host.transport, { providerId: 'p', url: 'https://x.example.com' })
    await flush()
    const id = host.openPayload().streamId
    // The host's IsValidClientStreamId: 8-64 chars of [A-Za-z0-9_-].
    expect(id).toMatch(/^[A-Za-z0-9_-]{8,64}$/)
    host.answer(openedAs(id))
    const stream = await pending
    expect(await collect(stream.body)).toEqual([])
    expect(host.calls.filter(c => c.action === 'rawStreamRead').every(c => c.payload.streamId === id)).toBe(true)
    expect(host.cancels()).toEqual([])
  })

  it('an abort while the open waits sends the cancel by the client id before the open settles', async () => {
    const controller = new AbortController()
    const host = deferredOpenHost()
    const pending = openRawProviderStream(host.transport, {
      providerId: 'p',
      url: 'https://x.example.com',
      signal: controller.signal,
    })
    await flush()
    const id = host.openPayload().streamId
    controller.abort()
    await flush()
    // The open has not settled yet, and the host already has the cancel.
    expect(host.cancels()).toEqual([id])
    // A new host fails the pending open CANCELLED: that is the abort, not a
    // stream error.
    host.answer({ ok: false, error: { code: 'CANCELLED', message: 'Stream was cancelled before it opened.' } })
    const error = await pending.catch(e => e)
    expect(error).not.toBeInstanceOf(RawProviderStreamError)
    expect(error).toBe(controller.signal.reason)
    expect(host.cancels()).toEqual([id])
  })

  it('the cancel lost the race to the head: one cancel, nothing read', async () => {
    const controller = new AbortController()
    const host = deferredOpenHost()
    const pending = openRawProviderStream(host.transport, {
      providerId: 'p',
      url: 'https://x.example.com',
      signal: controller.signal,
    })
    await flush()
    const id = host.openPayload().streamId
    controller.abort()
    host.answer(openedAs(id))
    const stream = await pending
    await expect(collect(stream.body)).rejects.toThrow()
    await stream.cancel()
    expect(host.calls.some(c => c.action === 'rawStreamRead')).toBe(false)
    expect(host.cancels()).toEqual([id])
  })

  it('an older host ignores the id: one cancel per id, the early one and the late one', async () => {
    const controller = new AbortController()
    const host = deferredOpenHost()
    const pending = openRawProviderStream(host.transport, {
      providerId: 'p',
      url: 'https://x.example.com',
      signal: controller.signal,
    })
    await flush()
    const id = host.openPayload().streamId
    controller.abort()
    await flush()
    // Today's host keeps waiting for the head, then answers with its own id.
    host.answer(openedAs('host-minted-id'))
    const stream = await pending
    await expect(collect(stream.body)).rejects.toThrow()
    await stream.cancel()
    await flush()
    expect(host.cancels()).toEqual([id, 'host-minted-id'])
  })

  it.each([
    ['a timed-out envelope', { ok: false, error: { code: 'bridge_timeout', message: 'timed out after 100000ms' } } as Reply],
    ['a rejected request', new Error('[MessagePortBridgeTransport] request timed out')],
  ])('a transport failure on the open cancels by the client id (%s)', async (_label, failure) => {
    const host = deferredOpenHost()
    const pending = openRawProviderStream(host.transport, { providerId: 'p', url: 'https://x.example.com' })
    await flush()
    const id = host.openPayload().streamId
    host.answer(failure)
    await expect(pending).rejects.toBeDefined()
    await flush()
    // Without it the host would run the request under an id nobody knows.
    expect(host.cancels()).toEqual([id])
  })

  it('a refused id is a plain open error, and cancels nothing', async () => {
    const host = deferredOpenHost()
    const pending = openRawProviderStream(host.transport, { providerId: 'p', url: 'https://x.example.com' })
    await flush()
    host.answer({ ok: false, error: { code: 'INVALID_ARGS', message: 'stream id in use' } })
    await expect(pending).rejects.toMatchObject({ code: 'INVALID_ARGS' })
    await flush()
    // A cancel by an in-use id would hit the OTHER stream.
    expect(host.cancels()).toEqual([])
  })
})
