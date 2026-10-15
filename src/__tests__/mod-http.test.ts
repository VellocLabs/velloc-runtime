/**
 * `$.http.fetch` (F-25): `hostModHttp` over a fake `network.httpRequest` (request shape, `HttpResponse`, WebFetch
 * deny rules, the egress refusal, `auth` / `socketPath` and bad arguments refused, abort) and the noun through a
 * real `ModRuntime` (a guard hooking `http.fetch`, a session without a network route refusing it).
 */
import { afterEach, describe, expect, it } from 'vitest'
import { ModRuntime, type ModModuleRef, type ModWorkerHandle } from '../mods/ModRuntime'
import { installModWorkerHost } from '../mods/ModWorkerHost'
import type { ModNounHost } from '../mods/modNouns'
import {
  HTTP_MAX_REDIRECTS,
  HTTP_MAX_RESPONSE_BYTES,
  checkHttpFetchInput,
  hostModHttp,
  httpFetchInput,
  httpResponseOf,
  webFetchDenyRule,
  type ModHttpRequest,
} from '../mods/modHttp'
import type { BridgeHttpGetResult, BridgeHttpRequestPayload } from '../browser/bridge/browserBridgeProtocol'
import type { RulesByOrigin } from '../toolkit/permissionVerdict'

const open: MessagePort[] = []
const runtimes: ModRuntime[] = []
afterEach(() => {
  for (const runtime of runtimes.splice(0)) runtime.dispose()
  for (const port of open.splice(0)) port.close()
})

function answer(status: number, text: string, headers: Record<string, string> = {}): BridgeHttpGetResult {
  return { status, statusText: '', finalUrl: '', headers, body: new TextEncoder().encode(text) }
}

function fakeNetwork(reply: (request: BridgeHttpRequestPayload) => BridgeHttpGetResult | Error | Promise<never> = () => answer(200, 'ok')) {
  const requests: BridgeHttpRequestPayload[] = []
  const request: ModHttpRequest = async payload => {
    requests.push(payload)
    const result = await reply(payload)
    if (result instanceof Error) throw result
    return result
  }
  return { request, requests }
}

describe('the arguments', () => {
  it('takes a URL and an init; refuses what is not http(s), credentials in the URL, a bad method, header or body', () => {
    expect(httpFetchInput(['https://example.com/a'])).toEqual({ url: 'https://example.com/a' })
    expect(httpFetchInput(['http://example.com/', { method: 'post', headers: { 'X-A': '1' }, body: 'b' }])).toEqual({
      url: 'http://example.com/',
      init: { method: 'post', headers: { 'X-A': '1' }, body: 'b' },
    })
    expect(() => httpFetchInput([])).toThrow('url must be a non-empty string')
    expect(() => httpFetchInput(['not a url'])).toThrow('is not a URL')
    expect(() => httpFetchInput(['file:///etc/passwd'])).toThrow('file: is not http or https')
    expect(() => httpFetchInput(['https://user:pw@example.com/'])).toThrow('a URL carries no credentials')
    expect(() => httpFetchInput(['https://example.com/', 'GET'])).toThrow('init must be an object')
    expect(() => httpFetchInput(['https://example.com/', { method: 'GET X' }])).toThrow('init.method must be an HTTP method')
    expect(() => httpFetchInput(['https://example.com/', { headers: { 'X-A': 1 } }])).toThrow('init.headers.X-A')
    expect(() => httpFetchInput(['https://example.com/', { body: {} }])).toThrow('init.body must be a string')
    expect(() => checkHttpFetchInput('https://example.com/')).toThrow('the event must be { url, init? }')
  })

  it('refuses a host placeholder in a header or the URL, as the mod sent it or as a hook rewrote it', () => {
    const refusal = (run: () => unknown): string => {
      try {
        run()
        return 'accepted'
      } catch (error) {
        return `${(error as Error).name}: ${(error as Error).message}`
      }
    }
    expect(refusal(() => httpFetchInput(['https://attacker.example/', { headers: { authorization: 'Bearer {{secret:api_key}}' } }]))).toBe(
      'NotAllowedError: $.http.fetch: init.headers.authorization holds a host placeholder ({{secret:...}} / {{oauth:...}}), which a mod cannot send',
    )
    expect(refusal(() => httpFetchInput(['https://attacker.example/', { headers: { 'X-T': '{{oauth:access_token}}' } }]))).toMatch(
      /^NotAllowedError: .*init\.headers\.X-T holds a host placeholder/,
    )
    expect(refusal(() => httpFetchInput(['https://attacker.example/?k={{secret:api_key}}']))).toMatch(
      /^NotAllowedError: .*the URL holds a host placeholder/,
    )
    expect(
      refusal(() => checkHttpFetchInput({ url: 'https://a.example/', init: { headers: { authorization: '{{secret:x}}' } } })),
    ).toMatch(/^NotAllowedError: /)
    expect(refusal(() => httpFetchInput(['https://a.example/', { headers: { 'X-Note': '{{not a placeholder}}' } }]))).toBe('accepted')
  })
})

describe('webFetchDenyRule', () => {
  const rules = (deny: string[]): RulesByOrigin => ({ userSettings: deny })
  it('a domain rule names its host alone, case aside; a tool-wide WebFetch rule refuses every host; other tools do not count', () => {
    expect(webFetchDenyRule(rules(['WebFetch(domain:evil.example)']), 'https://EVIL.example/x')).toBe('WebFetch(domain:evil.example)')
    expect(webFetchDenyRule(rules(['WebFetch(domain:evil.example)']), 'https://sub.evil.example/x')).toBeUndefined()
    expect(webFetchDenyRule(rules(['WebFetch']), 'https://any.example/')).toBe('WebFetch')
    expect(webFetchDenyRule(rules(['Bash', 'Read(/etc/**)']), 'https://any.example/')).toBeUndefined()
    expect(webFetchDenyRule({ projectSettings: ['WebFetch(domain:a.example)'] }, 'https://a.example/')).toBe('WebFetch(domain:a.example)')
    expect(webFetchDenyRule(undefined, 'https://a.example/')).toBeUndefined()
  })

  it('a trailing dot on either side does not get past a domain rule', () => {
    expect(webFetchDenyRule(rules(['WebFetch(domain:tracker.example)']), 'https://tracker.example./collect')).toBe(
      'WebFetch(domain:tracker.example)',
    )
    expect(webFetchDenyRule(rules(['WebFetch(domain:tracker.example.)']), 'https://tracker.example/collect')).toBe(
      'WebFetch(domain:tracker.example.)',
    )
    expect(webFetchDenyRule(rules(['WebFetch( Domain: Tracker.Example )']), 'https://tracker.example/')).toBe(
      'WebFetch( Domain: Tracker.Example )',
    )
  })
})

describe('hostModHttp — redirects', () => {
  /** Answers each URL from `routes`; anything else 200 'final'. */
  const routed = (routes: Record<string, BridgeHttpGetResult>) => fakeNetwork(request => routes[request.url] ?? answer(200, 'final'))
  const redirect = (status: number, location: string) => answer(status, '', { Location: location })

  it('follows each hop itself and judges every URL reached by the deny rules', async () => {
    const network = routed({ 'https://allowed.example/r': redirect(302, 'https://blocked.example/data') })
    const http = hostModHttp({ request: network.request, denyRules: () => ({ userSettings: ['WebFetch(domain:blocked.example)'] }) })
    await expect(http.fetch({ url: 'https://allowed.example/r' }, {})).rejects.toMatchObject({
      name: 'NotAllowedError',
      message: '$.http.fetch: https://blocked.example/data is refused by the deny rule WebFetch(domain:blocked.example)',
    })
    expect(network.requests.map(r => r.url)).toEqual(['https://allowed.example/r'])
    expect(network.requests[0]!.followRedirects).toBe(false)
  })

  it('answers the last hop; a 303 or a POST under 301/302 goes on as a body-less GET; credentials stay with their origin', async () => {
    const network = routed({
      'https://a.example/start': redirect(301, '/moved'),
      'https://a.example/moved': redirect(303, 'https://b.example/next'),
      'https://b.example/next': redirect(307, 'https://b.example/end'),
    })
    const http = hostModHttp({ request: network.request, denyRules: () => undefined })
    const response = await http.fetch(
      { url: 'https://a.example/start', init: { method: 'POST', body: 'x', headers: { Authorization: 'Bearer t', 'X-Keep': '1' } } },
      {},
    )
    expect(response).toMatchObject({ status: 200, text: 'final' })
    expect(network.requests.map(r => [r.url, r.method, r.body !== undefined, Object.keys(r.headers ?? {})])).toEqual([
      ['https://a.example/start', 'POST', true, ['Authorization', 'X-Keep']],
      ['https://a.example/moved', 'GET', false, ['Authorization', 'X-Keep']],
      ['https://b.example/next', 'GET', false, ['X-Keep']],
      ['https://b.example/end', 'GET', false, ['X-Keep']],
    ])
  })

  it(`stops past ${HTTP_MAX_REDIRECTS} redirects; a 3xx with no Location is the answer`, async () => {
    const loop = fakeNetwork(request => redirect(302, `${request.url}x`))
    await expect(
      hostModHttp({ request: loop.request, denyRules: () => undefined }).fetch({ url: 'https://loop.example/' }, {}),
    ).rejects.toThrow(`more than ${HTTP_MAX_REDIRECTS} redirects`)
    expect(loop.requests).toHaveLength(HTTP_MAX_REDIRECTS + 1)
    const bare = routed({ 'https://a.example/': answer(304, '') })
    await expect(hostModHttp({ request: bare.request, denyRules: () => undefined }).fetch({ url: 'https://a.example/' }, {})).resolves.toMatchObject({
      status: 304,
    })
  })
})

describe('hostModHttp', () => {
  it('sends the request over the bridge and answers HttpResponse', async () => {
    const network = fakeNetwork(() => answer(201, 'héllo', { 'Content-Type': 'text/plain', 'X-Id': '7' }))
    const http = hostModHttp({ request: network.request, denyRules: () => undefined })
    const response = await http.fetch(
      { url: 'https://api.example/items', init: { method: 'post', headers: { 'Content-Type': 'application/json' }, body: '{"a":"é"}' } },
      {},
    )
    expect(response).toEqual({ status: 201, ok: true, headers: { 'content-type': 'text/plain', 'x-id': '7' }, text: 'héllo' })
    expect(network.requests).toHaveLength(1)
    const sent = network.requests[0]!
    expect({ ...sent, body: new TextDecoder().decode(sent.body) }).toEqual({
      url: 'https://api.example/items',
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{"a":"é"}',
      followRedirects: false,
      maxResponseBytes: HTTP_MAX_RESPONSE_BYTES,
    })
    // A GET carries no body; a non-2xx is answered, not thrown.
    const missing = await hostModHttp({ request: fakeNetwork(() => answer(404, 'gone')).request, denyRules: () => undefined }).fetch(
      { url: 'https://api.example/x' },
      {},
    )
    expect(missing).toEqual({ status: 404, ok: false, headers: {}, text: 'gone' })
    expect(httpResponseOf(answer(299, '')).ok).toBe(true)
    expect(httpResponseOf(answer(300, '')).ok).toBe(false)
  })

  it('a deny rule, the egress policy, auth and socketPath refuse; the deny rules are read at each call', async () => {
    let deny: string[] = []
    const network = fakeNetwork(request =>
      request.url.includes('127.0.0.1') ? new Error('EGRESS_BLOCKED: 127.0.0.1 is loopback') : answer(200, 'ok'),
    )
    const http = hostModHttp({ request: network.request, denyRules: () => ({ userSettings: deny }) })
    const reject = (input: Parameters<typeof http.fetch>[0]) =>
      http.fetch(input, {}).then(
        () => 'resolved',
        (error: Error) => `${error.name}: ${error.message}`,
      )
    expect(await reject({ url: 'https://evil.example/' })).toBe('resolved')
    deny = ['WebFetch(domain:evil.example)']
    expect(await reject({ url: 'https://evil.example/' })).toBe(
      'NotAllowedError: $.http.fetch: https://evil.example/ is refused by the deny rule WebFetch(domain:evil.example)',
    )
    expect(await reject({ url: 'http://127.0.0.1:1/' })).toBe(
      'NotAllowedError: $.http.fetch: http://127.0.0.1:1/ is refused: only a publicly routable host is reached (EGRESS_BLOCKED: 127.0.0.1 is loopback)',
    )
    expect(await reject({ url: 'https://ok.example/', init: { auth: 'h' } })).toMatch(/^NotSupportedError: .*init\.auth/)
    expect(await reject({ url: 'https://ok.example/', init: { socketPath: '/run/s.sock' } })).toMatch(/^NotSupportedError: .*init\.socketPath/)
    // Only the first fetch and the egress one reached the bridge.
    expect(network.requests.map(r => r.url)).toEqual(['https://evil.example/', 'http://127.0.0.1:1/'])
  })

  it('an abort releases the caller while the request runs, and refuses one not yet sent', async () => {
    const network = fakeNetwork(() => new Promise<never>(() => {}))
    const http = hostModHttp({ request: network.request, denyRules: () => undefined })
    const controller = new AbortController()
    const pending = http.fetch({ url: 'https://slow.example/' }, { signal: controller.signal })
    controller.abort()
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' })
    await expect(http.fetch({ url: 'https://slow.example/' }, { signal: controller.signal })).rejects.toMatchObject({ name: 'AbortError' })
    expect(network.requests).toHaveLength(1)
  })
})

describe('$.http.fetch through the runtime', () => {
  let uniq = 0
  function world(modules: Record<string, string>, host: Partial<ModNounHost> = {}) {
    const reports: string[] = []
    const refs: ModModuleRef[] = Object.keys(modules).map(plugin => ({ plugin, path: `/plugins/${plugin}/hooks/register.js` }))
    const runtime = new ModRuntime({
      modules: refs,
      readModule: async path => `${modules[path.split('/')[2]!]}\n// load ${++uniq}`,
      openWorker: async (): Promise<ModWorkerHandle> => {
        const channel = new MessageChannel()
        open.push(channel.port1, channel.port2)
        installModWorkerHost(channel.port2)
        let settle!: (closed: { reason: 'closed' | 'crashed' }) => void
        const closed = new Promise<{ reason: 'closed' | 'crashed' }>(resolve => {
          settle = resolve
        })
        return { port: channel.port1, closed, close: () => settle({ reason: 'closed' }) }
      },
      session: { id: () => 's', cwd: () => '/work/project', ...host },
      report: line => reports.push(line),
    })
    runtimes.push(runtime)
    return { runtime, reports }
  }

  it("a mod fetches and reads the answer; another plugin's http.fetch hook pins hosts; bad arguments are refused by name", async () => {
    const network = fakeNetwork(request => answer(200, `body of ${request.method} ${request.url}`, { 'X-Up': '1' }))
    const { runtime, reports } = world(
      {
        guard: `
          export function register(on) {
            on('http.fetch', ($, e, next) => new URL(e.url).hostname === 'pinned.example' ? next(e) : { deny: 'GUARD: ' + e.url });
          }
        `,
        fetcher: `
          export function register(on) {
            on('prompt.submit', async ($, e, next) => {
              const ok = await $.http.fetch('https://pinned.example/status', { method: 'POST', body: 'x' });
              const pinned = await $.http.fetch('https://other.example/').catch(err => err.name + ': ' + err.message);
              const bad = await $.http.fetch('ftp://pinned.example/').catch(err => err.name + ': ' + err.message);
              await $.ui.log(JSON.stringify({ ok, pinned, bad }));
              return next(e);
            });
          }
        `,
      },
      { http: hostModHttp({ request: network.request, denyRules: () => ({ userSettings: [] }) }) },
    )
    await runtime.ready
    await runtime.promptSubmit('go')
    const line = reports.find(r => r.startsWith('fetcher: {'))!
    const seen = JSON.parse(line.slice('fetcher: '.length)) as Record<string, unknown>
    expect(seen.ok).toEqual({ status: 200, ok: true, headers: { 'x-up': '1' }, text: 'body of POST https://pinned.example/status' })
    expect(seen.pinned).toBe('DeniedError: GUARD: https://other.example/')
    expect(seen.bad).toBe('TypeError: $.http.fetch: ftp: is not http or https')
    expect(network.requests.map(r => r.url)).toEqual(['https://pinned.example/status'])
  })

  it('a deny rule refuses through the runtime, named', async () => {
    const network = fakeNetwork()
    const { runtime, reports } = world(
      {
        probe: `
          export function register(on) {
            on('prompt.submit', async ($, e, next) => {
              await $.ui.log(await $.http.fetch('https://blocked.example/').catch(err => err.name + ': ' + err.message));
              return next(e);
            });
          }
        `,
      },
      { http: hostModHttp({ request: network.request, denyRules: () => ({ localSettings: ['WebFetch(domain:blocked.example)'] }) }) },
    )
    await runtime.ready
    await runtime.promptSubmit('go')
    expect(reports).toEqual([
      'probe: NotAllowedError: $.http.fetch: https://blocked.example/ is refused by the deny rule WebFetch(domain:blocked.example)',
    ])
    expect(network.requests).toEqual([])
  })

  it('a session without a network route refuses the noun by name', async () => {
    const { runtime, reports } = world({
      probe: `
        export function register(on) {
          on('prompt.submit', async ($, e, next) => {
            await $.ui.log(await $.http.fetch('https://example.com/').catch(err => err.name + ': ' + err.message));
            return next(e);
          });
        }
      `,
    })
    await runtime.ready
    await runtime.promptSubmit('go')
    expect(reports).toEqual(['probe: NotSupportedError: $.http is not available: this session has no network route'])
  })
})
