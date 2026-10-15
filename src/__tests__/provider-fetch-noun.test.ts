/**
 * Provider mods — `$.provider.fetch` (PM-4b): which targets a provider module
 * may reach (relative to the base URL, or a declared domain — never a
 * look-alike or an address with credentials), what it may send (forbidden
 * headers, only declared secret templates), what it reads back (a size cap and
 * a time cap), and that a secret never leaves the host.
 */
import { describe, expect, it, vi } from 'vitest'
import type { BrowserBridgeTransport } from '../browser/bridge/browserBridgeProtocol'
import { RawProviderStreamError, type RawProviderStream, type RawProviderStreamRequest } from '../browser/bridge/rawProviderStream'
import type { ProviderNounCall } from '../mods/provider/ProviderModRuntime'
import {
  createProviderFetch,
  PROVIDER_FETCH_DEFAULT_TIMEOUT_MS,
  PROVIDER_FETCH_MAX_BYTES,
  PROVIDER_FETCH_MAX_TIMEOUT_MS,
  resolveFetchTarget,
  type ProviderFetchTarget,
} from '../mods/provider/nouns/providerFetchNoun'

const TARGET: ProviderFetchTarget = {
  baseUrl: 'https://api.zen.example/v1',
  domains: ['api.zen.example', 'auth.zen.example'],
  secrets: ['session_token'],
}

function reaches(input: string, target: ProviderFetchTarget = TARGET): string {
  return resolveFetchTarget(input, target).href
}

function refused(input: unknown, target: ProviderFetchTarget = TARGET): unknown {
  try {
    resolveFetchTarget(input, target)
  } catch (error) {
    return error
  }
  return undefined
}

describe('the target', () => {
  it('a relative target is joined to the base URL, path and all', () => {
    expect(reaches('/models')).toBe('https://api.zen.example/v1/models')
    expect(reaches('models?limit=5')).toBe('https://api.zen.example/v1/models?limit=5')
    expect(reaches('/')).toBe('https://api.zen.example/v1/')
    expect(reaches('/models', { ...TARGET, baseUrl: 'https://api.zen.example/v1/' })).toBe('https://api.zen.example/v1/models')
  })

  it('a loopback or self-hosted base URL works, any port', () => {
    const local = { ...TARGET, baseUrl: 'http://127.0.0.1:8123' }
    expect(reaches('/v1/chat', local)).toBe('http://127.0.0.1:8123/v1/chat')
    expect(reaches('http://127.0.0.1:8123/other', local)).toBe('http://127.0.0.1:8123/other')
    expect(refused('http://127.0.0.1:9999/other', local)).toMatchObject({ name: 'NotAllowedError' })
    expect(refused('http://localhost:8123/other', local)).toMatchObject({ name: 'NotAllowedError' })
  })

  it('an absolute target on a declared domain is reached, over https on the default port', () => {
    expect(reaches('https://auth.zen.example/token')).toBe('https://auth.zen.example/token')
    expect(reaches('https://API.ZEN.EXAMPLE/x')).toBe('https://api.zen.example/x')
    expect(refused('http://auth.zen.example/token')).toMatchObject({ name: 'NotAllowedError' })
    expect(refused('https://auth.zen.example:8443/token')).toMatchObject({ name: 'NotAllowedError' })
  })

  it.each([
    ['another host', 'https://evil.example/x'],
    ['a sub-domain of a declared domain', 'https://x.api.zen.example/x'],
    ['a declared domain as a prefix', 'https://api.zen.example.evil.example/x'],
    ['a declared domain as a suffix', 'https://evilapi.zen.example/x'],
    ['a declared domain in the path', 'https://evil.example/api.zen.example'],
    ['a declared domain as userinfo', 'https://api.zen.example@evil.example/x'],
    ['a declared domain as userinfo with a password', 'https://api.zen.example:pw@evil.example/x'],
    ['credentials before the declared host', 'https://user:pw@api.zen.example/x'],
    ['a trailing-dot host', 'https://api.zen.example./x'],
    ['an IP literal', 'https://203.0.113.9/x'],
    ['a decimal IP', 'https://3405803785/x'],
    ['a fragment trick', 'https://evil.example#@api.zen.example/'],
    ['a query trick', 'https://evil.example?@api.zen.example/'],
    ['a non-http scheme', 'file:///etc/passwd'],
    ['a javascript scheme', 'javascript:alert(1)'],
    ['a wss scheme', 'wss://api.zen.example/socket'],
  ])('refuses %s', (_label, input) => {
    expect(refused(input)).toMatchObject({ name: 'NotAllowedError' })
  })

  it.each([
    ['a network-path reference', '//evil.example/x'],
    ['a backslash host', '\\\\evil.example\\x'],
    ['a slash-backslash host', '/\\evil.example'],
    ['a backslash in an absolute URL', 'https://evil.example\\@api.zen.example/'],
    ['whitespace', 'https://api.zen.example/a b'],
    ['a newline', '/models\nHost: evil'],
    ['a tab', '/mod\tels'],
  ])('refuses %s as a malformed target', (_label, input) => {
    expect(refused(input)).toBeInstanceOf(Error)
  })

  it('a relative target cannot leave the origin by dot segments or an encoded slash', () => {
    expect(reaches('/../../models')).toBe('https://api.zen.example/models')
    expect(new URL(reaches('/..%2f..%2fx')).origin).toBe('https://api.zen.example')
    expect(new URL(reaches('/@evil.example/x')).host).toBe('api.zen.example')
  })

  it('a target must be a string', () => {
    expect(refused(undefined)).toBeInstanceOf(TypeError)
    expect(refused(42)).toBeInstanceOf(TypeError)
    expect(refused('')).toBeInstanceOf(TypeError)
  })
})

// ── the noun, over a fake transport-level open ──

type Opened = RawProviderStreamRequest

function streamOf(chunks: Uint8Array[], extra: Partial<RawProviderStream> = {}): { stream: RawProviderStream; cancelled: () => number } {
  let cancels = 0
  const stream: RawProviderStream = {
    status: 200,
    statusText: 'OK',
    finalUrl: 'https://api.zen.example/v1/models',
    headers: { 'Content-Type': 'application/json', 'X-Request-Id': 'r1' },
    body: (async function* () {
      for (const chunk of chunks) yield chunk
    })(),
    cancel: async () => {
      cancels += 1
    },
    captured: () => undefined,
    ...extra,
  }
  return { stream, cancelled: () => cancels }
}

function setup(
  stream: () => RawProviderStream | Promise<RawProviderStream> = () => streamOf([new TextEncoder().encode('{"ok":true}')]).stream,
  target: ProviderFetchTarget | undefined = TARGET,
  transport: BrowserBridgeTransport | null = {} as BrowserBridgeTransport,
) {
  const opened: Opened[] = []
  const fetchNoun = createProviderFetch({
    transport: () => transport,
    targetOf: id => (id === 'mod.acme.zen' ? target : undefined),
    open: async (_transport, request) => {
      opened.push(request)
      return stream()
    },
  })
  const call = (target: unknown, init?: unknown, providers: readonly string[] = ['mod.acme.zen']) =>
    fetchNoun({ plugin: 'acme', noun: 'provider', method: 'fetch', args: init === undefined ? [target] : [target, init], providers } as unknown as ProviderNounCall)
  return { call, opened }
}

describe('the request', () => {
  it('opens the provider transport under the provider id with the resolved URL', async () => {
    const { call, opened } = setup()
    const response = await call('/models', {
      method: 'post',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer {{secret:api_key}}', 'X-Token': '{{secret:session_token}}' },
      query: { key: '{{secret:api_key}}', plain: 'x' },
      body: '{"a":1}',
    })
    expect(opened).toHaveLength(1)
    expect(opened[0]).toMatchObject({
      providerId: 'mod.acme.zen',
      url: 'https://api.zen.example/v1/models',
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer {{secret:api_key}}', 'X-Token': '{{secret:session_token}}' },
      queryParams: { key: '{{secret:api_key}}', plain: 'x' },
      maxResponseBytes: PROVIDER_FETCH_MAX_BYTES,
      idleTimeoutMs: PROVIDER_FETCH_DEFAULT_TIMEOUT_MS,
    })
    expect(new TextDecoder().decode(opened[0]!.body)).toBe('{"a":1}')
    expect(opened[0]!.signal).toBeInstanceOf(AbortSignal)
    expect(response).toMatchObject({
      status: 200,
      statusText: 'OK',
      ok: true,
      url: 'https://api.zen.example/v1/models',
      headers: { 'content-type': 'application/json', 'x-request-id': 'r1' },
    })
    expect(new TextDecoder().decode(response.body)).toBe('{"ok":true}')
  })

  it('a refused target opens nothing', async () => {
    const { call, opened } = setup()
    await expect(call('https://evil.example/x')).rejects.toMatchObject({ name: 'NotAllowedError' })
    await expect(call('https://api.zen.example@evil.example/')).rejects.toMatchObject({ name: 'NotAllowedError' })
    expect(opened).toHaveLength(0)
  })

  it('works under the provider named, and only an owned one', async () => {
    const { call } = setup()
    await expect(call('/m', { provider: 'mod.other.zen' })).rejects.toMatchObject({ name: 'NotAllowedError' })
    await expect(call('/m', undefined, ['mod.acme.zen', 'mod.acme.pro'])).rejects.toThrow('say which')
    await expect(call('/m', { provider: 'mod.acme.pro' }, ['mod.acme.zen', 'mod.acme.pro'])).rejects.toMatchObject({ name: 'NotSupportedError' })
    await expect(call('/m', { provider: 'mod.acme.zen' }, ['mod.acme.zen', 'mod.acme.pro'])).resolves.toMatchObject({ status: 200 })
  })

  it('without a host connection it is refused as unsupported', async () => {
    const { call } = setup(undefined, TARGET, null)
    await expect(call('/m')).rejects.toMatchObject({ name: 'NotSupportedError' })
  })

  it.each(['cookie', 'Cookie', 'host', 'HOST', 'content-length', 'Content-Length', 'proxy-authorization', 'Proxy-Authorization'])(
    'refuses the %s header',
    async name => {
      const { call, opened } = setup()
      await expect(call('/m', { headers: { [name]: 'x' } })).rejects.toMatchObject({ name: 'NotAllowedError' })
      expect(opened).toHaveLength(0)
    },
  )

  it('refuses a header twice under different cases, a bad header name, a multi-line value', async () => {
    const { call } = setup()
    await expect(call('/m', { headers: { Accept: 'a', accept: 'b' } })).rejects.toThrow(TypeError)
    await expect(call('/m', { headers: { 'bad name': 'a' } })).rejects.toThrow(TypeError)
    await expect(call('/m', { headers: { Accept: 'a\r\nHost: evil' } })).rejects.toThrow(TypeError)
    await expect(call('/m', { headers: { Accept: 1 } })).rejects.toThrow(TypeError)
  })

  it('allows only secret templates, only declared secret names (and api_key)', async () => {
    const { call, opened } = setup()
    await expect(call('/m', { headers: { A: '{{secret:other}}' } })).rejects.toMatchObject({ name: 'NotAllowedError' })
    await expect(call('/m', { headers: { A: '{{oauth:access_token}}' } })).rejects.toMatchObject({ name: 'NotAllowedError' })
    await expect(call('/m', { headers: { A: '{{ secret:api_key }}' } })).rejects.toMatchObject({ name: 'NotAllowedError' })
    await expect(call('/m', { query: { k: '{{secret:other}}' } })).rejects.toMatchObject({ name: 'NotAllowedError' })
    expect(opened).toHaveLength(0)
    await call('/m', { headers: { A: 'x {{secret:api_key}} {{secret:session_token}}' } })
    expect(opened).toHaveLength(1)
  })

  it('refuses unknown options, a bad method, a body on GET, a body over the cap', async () => {
    const { call } = setup()
    await expect(call('/m', { signal: 1 })).rejects.toThrow('not an option')
    await expect(call('/m', 'GET')).rejects.toThrow(TypeError)
    await expect(call('/m', { method: 'CONNECT' })).rejects.toMatchObject({ name: 'NotAllowedError' })
    await expect(call('/m', { method: 'TRACE' })).rejects.toMatchObject({ name: 'NotAllowedError' })
    await expect(call('/m', { method: 'bad method' })).rejects.toThrow(TypeError)
    await expect(call('/m', { body: 'x' })).rejects.toThrow('has no body')
    await expect(call('/m', { method: 'POST', body: { a: 1 } })).rejects.toThrow(TypeError)
    await expect(call('/m', { method: 'POST', body: new Uint8Array(4 * 1024 * 1024 + 1) })).rejects.toThrow(RangeError)
    await expect(call('/m', { timeoutMs: -1 })).rejects.toThrow(TypeError)
  })

  it('sends a bytes body as it is', async () => {
    const { call, opened } = setup()
    await call('/m', { method: 'PUT', body: new Uint8Array([1, 2, 3]) })
    expect(Array.from(opened[0]!.body!)).toEqual([1, 2, 3])
  })

  it('clamps the timeout to the most', async () => {
    const { call, opened } = setup()
    await call('/m', { timeoutMs: 5_000 })
    await call('/m', { timeoutMs: 10 * 60_000 })
    expect(opened.map(o => o.idleTimeoutMs)).toEqual([5_000, PROVIDER_FETCH_MAX_TIMEOUT_MS])
  })
})

describe('the answer', () => {
  it('joins chunks in order', async () => {
    const { call } = setup(() => streamOf([new Uint8Array([1, 2]), new Uint8Array([3]), new Uint8Array([4, 5])]).stream)
    expect(Array.from((await call('/m')).body)).toEqual([1, 2, 3, 4, 5])
  })

  it('an answer over the cap rejects and closes the request', async () => {
    const big = new Uint8Array(1024 * 1024)
    const made = streamOf([big, big, big, big, big])
    const { call } = setup(() => made.stream)
    await expect(call('/m')).rejects.toMatchObject({ name: 'ResponseTooLargeError' })
    expect(made.cancelled()).toBe(1)
  })

  it('an answer of exactly the cap is read', async () => {
    const { call } = setup(() => streamOf([new Uint8Array(PROVIDER_FETCH_MAX_BYTES)]).stream)
    expect((await call('/m')).body.byteLength).toBe(PROVIDER_FETCH_MAX_BYTES)
  })

  it('an answer that does not finish in time rejects TimeoutError and closes the request', async () => {
    vi.useFakeTimers()
    try {
      let cancels = 0
      const hanging: RawProviderStream = {
        status: 200,
        statusText: 'OK',
        finalUrl: 'https://api.zen.example/v1/m',
        headers: {},
        body: {
          [Symbol.asyncIterator]() {
            return {
              next: () => new Promise<IteratorResult<Uint8Array>>(() => {}),
              return: async () => ({ done: true as const, value: undefined }),
            }
          },
        },
        cancel: async () => {
          cancels += 1
        },
        captured: () => undefined,
      }
      const { call } = setup(() => hanging)
      const pending = call('/m', { timeoutMs: 1_000 })
      const assertion = expect(pending).rejects.toMatchObject({ name: 'TimeoutError' })
      await vi.advanceTimersByTimeAsync(1_001)
      await assertion
      expect(cancels).toBe(1)
    } finally {
      vi.useRealTimers()
    }
  })

  it('an open that never answers is cut at the timeout too', async () => {
    vi.useFakeTimers()
    try {
      const fetchNoun = createProviderFetch({
        transport: () => ({}) as BrowserBridgeTransport,
        targetOf: () => TARGET,
        open: (_t, request) =>
          new Promise<RawProviderStream>((_resolve, reject) => {
            request.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')))
          }),
      })
      const pending = fetchNoun({ plugin: 'acme', noun: 'provider', method: 'fetch', args: ['/m', { timeoutMs: 500 }], providers: ['mod.acme.zen'] } as unknown as ProviderNounCall)
      const assertion = expect(pending).rejects.toMatchObject({ name: 'TimeoutError' })
      await vi.advanceTimersByTimeAsync(501)
      await assertion
    } finally {
      vi.useRealTimers()
    }
  })

  it('the calling hook being abandoned closes the request and releases the call (a cancelled sign-in)', async () => {
    let cancels = 0
    let aborted = false
    const hanging: RawProviderStream = {
      status: 200,
      statusText: 'OK',
      finalUrl: 'https://api.zen.example/v1/m',
      headers: {},
      body: {
        [Symbol.asyncIterator]() {
          return { next: () => new Promise<IteratorResult<Uint8Array>>(() => {}), return: async () => ({ done: true as const, value: undefined }) }
        },
      },
      cancel: async () => {
        cancels += 1
      },
      captured: () => undefined,
    }
    const fetchNoun = createProviderFetch({
      transport: () => ({}) as BrowserBridgeTransport,
      targetOf: () => TARGET,
      open: async (_t, request) => {
        request.signal?.addEventListener('abort', () => (aborted = true))
        return hanging
      },
    })
    const controller = new AbortController()
    const pending = fetchNoun({
      plugin: 'acme', noun: 'provider', method: 'fetch', args: ['/m'], providers: ['mod.acme.zen'], signal: controller.signal,
    } as unknown as ProviderNounCall)
    const assertion = expect(pending).rejects.toMatchObject({ name: 'AbortError' })
    await Promise.resolve()
    controller.abort()
    await assertion
    expect(aborted).toBe(true)
    expect(cancels).toBe(1)
    // A call whose hook is already abandoned sends nothing more.
    const opens: number[] = []
    const again = createProviderFetch({
      transport: () => ({}) as BrowserBridgeTransport,
      targetOf: () => TARGET,
      open: async (_t, request) => {
        opens.push(1)
        if (request.signal?.aborted) throw new DOMException('aborted', 'AbortError')
        return streamOf([]).stream
      },
    })
    await expect(
      again({ plugin: 'acme', noun: 'provider', method: 'fetch', args: ['/m'], providers: ['mod.acme.zen'], signal: controller.signal } as unknown as ProviderNounCall),
    ).rejects.toMatchObject({ name: 'AbortError' })
  })

  it('a host refusal of the target is a NotAllowedError; other host errors keep their code', async () => {
    const refuse = (code: string) => async (): Promise<RawProviderStream> => {
      throw new RawProviderStreamError(code, 'nope')
    }
    const denied = createProviderFetch({ transport: () => ({}) as BrowserBridgeTransport, targetOf: () => TARGET, open: refuse('TARGET_NOT_ALLOWED') })
    const failed = createProviderFetch({ transport: () => ({}) as BrowserBridgeTransport, targetOf: () => TARGET, open: refuse('UPSTREAM_ERROR') })
    const callOf = (fn: typeof denied) =>
      fn({ plugin: 'acme', noun: 'provider', method: 'fetch', args: ['/m'], providers: ['mod.acme.zen'] } as unknown as ProviderNounCall)
    await expect(callOf(denied)).rejects.toMatchObject({ name: 'NotAllowedError' })
    await expect(callOf(failed)).rejects.toThrow('UPSTREAM_ERROR')
  })

  it('a secret value never appears in what the module gets: the module only ever names it', async () => {
    // The request carries the template; the host substitutes. Nothing in the
    // noun reads a secret, so the answer cannot contain one it did not get.
    const { call, opened } = setup()
    const response = await call('/m', { headers: { Authorization: 'Bearer {{secret:api_key}}' } })
    expect(JSON.stringify(opened[0]!.headers)).toContain('{{secret:api_key}}')
    expect(JSON.stringify({ ...response, body: Array.from(response.body) })).not.toContain('sk-')
  })
})
