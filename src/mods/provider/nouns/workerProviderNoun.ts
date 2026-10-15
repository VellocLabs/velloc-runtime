/**
 * `$.provider` inside the module's worker: plain calls cross as they are; `keypair`,
 * `sessionStore` and `fetch` results are assembled here from flat calls. Anything
 * else falls through to the generic call ("not implemented by this engine").
 */

export type ProviderCaller = (method: string, args: unknown[]) => Promise<unknown>

type FetchedAnswer = {
  status: number
  statusText: string
  ok: boolean
  url: string
  headers: Record<string, string>
  body: Uint8Array
}

/** The host's answer to `fetch` (a body as bytes) as a response with readers. */
function fetchResponse(answer: FetchedAnswer): unknown {
  const bytes = answer.body instanceof Uint8Array ? answer.body : new Uint8Array(0)
  const text = (): string => new TextDecoder('utf-8').decode(bytes)
  return Object.freeze({
    status: answer.status,
    statusText: answer.statusText,
    ok: answer.ok,
    url: answer.url,
    headers: Object.freeze({ ...answer.headers }),
    text: async (): Promise<string> => text(),
    json: async (): Promise<unknown> => JSON.parse(text()),
    bytes: async (): Promise<Uint8Array> => bytes.slice(),
  })
}

/**
 * The `interact` handle of a `provider.login` hook; each method is one flat host call
 * and rejects on cancel or timeout. `openUrl` asks the PAGE to offer the link and
 * resolves once the person clicked it.
 */
export function makeInteractHandle(call: ProviderCaller, loginId: unknown): unknown {
  return Object.freeze({
    openUrl: (url: unknown): Promise<unknown> => call('interactOpenUrl', [loginId, url]),
    showCode: (options: unknown): Promise<unknown> => call('interactShowCode', [loginId, options]),
    prompt: (options: unknown): Promise<unknown> => call('interactPrompt', [loginId, options]),
    choose: (options: unknown): Promise<unknown> => call('interactChoose', [loginId, options]),
    progress: (text: unknown): Promise<unknown> => call('interactProgress', [loginId, text]),
  })
}

export function makeProviderNoun(call: ProviderCaller): unknown {
  const noun = {
    keypair: async (name: unknown, options?: unknown): Promise<unknown> => {
      const { publicKeyJwk } = (await call('keypair', options === undefined ? [name] : [name, options])) as {
        publicKeyJwk: unknown
      }
      return Object.freeze({
        publicKeyJwk,
        sign: (bytes: unknown): Promise<unknown> =>
          call('keypairSign', options === undefined ? [name, bytes] : [name, bytes, options]),
      })
    },
    fetch: async (target: unknown, init?: unknown): Promise<unknown> =>
      fetchResponse((await call('fetch', init === undefined ? [target] : [target, init])) as FetchedAnswer),
    sessionStore: (sessionId: unknown, options?: unknown): unknown => {
      const withOptions = (...args: unknown[]): unknown[] => (options === undefined ? args : [...args, options])
      return Object.freeze({
        get: (key: unknown) => call('sessionGet', withOptions(sessionId, key)),
        set: (key: unknown, value: unknown) => call('sessionSet', withOptions(sessionId, key, value)),
        delete: (key: unknown) => call('sessionDelete', withOptions(sessionId, key)),
        keys: () => call('sessionKeys', withOptions(sessionId)),
      })
    },
  }
  return new Proxy(Object.freeze(noun), {
    get: (target, method) => {
      if (typeof method !== 'string' || method === 'then') return undefined
      if (Object.prototype.hasOwnProperty.call(target, method)) return target[method as keyof typeof target]
      return (...args: unknown[]) => call(method, args)
    },
  })
}
