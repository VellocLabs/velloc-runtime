/**
 * Settings / plugin `http` hooks: the request a hook sends (`hookHttpRunner`)
 * and how the executor reads its answer.
 */
import { spawnSync } from 'node:child_process'
import { describe, expect, it, vi } from 'vitest'
import { BrowserHostBridge } from '../browser/bridge/BrowserHostBridge'
import { NativePrimitiveError, NativePrimitiveUnsupportedError } from '../browser/bridge/nativePrimitives'
import type { BrowserBridgeTransport } from '../browser/bridge/protocol'
import { createInitialBrowserAppState } from '../browser/runtime/AgentRuntimeState'
import type { WorkingState } from '../runtime/RuntimeTypes'
import type { ToolCallContext } from '../toolkit/toolCallContext'
import { fireBeforeToolCall, firePromptSubmitted } from '../lifecycleHooks/runHooks'
import type { HookCommandRunner } from '../lifecycleHooks/hookCommandRunner'
import {
  createNetworkHookHttpRunner,
  HOOK_HTTP_MAX_RESPONSE_BYTES,
  hookHttpRequestOf,
  isLoopbackHookUrl,
  readEnvThroughShell,
  type HookHttpPostInput,
  type HookHttpPostResult,
  type HookHttpRunner,
} from '../lifecycleHooks/hookHttpRunner'
import { attachTransientHook } from '../lifecycleHooks/sessionScopedHooks'
import type { LifecycleEventName, HttpHook } from '../lifecycleHooks/hookTypes'

const HAS_BASH = spawnSync('bash', ['-c', 'exit 0']).status === 0

function withHttpHook(
  hook: HttpHook,
  event: LifecycleEventName = 'PreToolUse',
): { appState: WorkingState; setAppState: (u: (p: WorkingState) => WorkingState) => void } {
  let appState: WorkingState = createInitialBrowserAppState()
  const setAppState = (u: (p: WorkingState) => WorkingState) => {
    appState = u(appState)
  }
  attachTransientHook(setAppState, 'sess', event, event === 'PreToolUse' ? 'Bash' : '', hook)
  return { appState, setAppState }
}

type FakeHttp = HookHttpRunner & { posts: HookHttpPostInput[]; envAsked: string[][] }

function fakeHttp(
  answer: HookHttpPostResult | ((input: HookHttpPostInput) => Promise<HookHttpPostResult>),
  env: Record<string, string> = {},
): FakeHttp {
  const posts: HookHttpPostInput[] = []
  const envAsked: string[][] = []
  return {
    posts,
    envAsked,
    async post(input) {
      posts.push(input)
      return typeof answer === 'function' ? answer(input) : answer
    },
    async readEnv(names) {
      envAsked.push([...names])
      return Object.fromEntries(names.map(name => [name, env[name] ?? '']))
    },
  }
}

const URL_ = 'https://policy.example.com/hook'

async function preTool(hook: HttpHook, http: HookHttpRunner | undefined) {
  const { appState, setAppState } = withHttpHook(hook)
  return fireBeforeToolCall({
    toolName: 'Bash',
    sessionId: 'sess',
    appState,
    setAppState,
    ...(http ? { httpRunner: http } : {}),
    hookInput: { cwd: '/w', toolInput: { command: 'ls' }, toolUseId: 'tu1' },
  })
}

describe('the request an http hook sends', () => {
  it('loopback by name or literal is told apart from every other host', () => {
    for (const url of ['http://localhost:8080/h', 'http://api.localhost/h', 'http://127.0.0.1/h', 'http://127.255.0.9:1/', 'http://[::1]:9/h']) {
      expect(isLoopbackHookUrl(url), url).toBe(true)
    }
    for (const url of ['https://example.com/', 'http://10.0.0.1/', 'http://169.254.169.254/', 'http://localhost.example.com/', 'http://127.0.0.256/', 'not a url']) {
      expect(isLoopbackHookUrl(url), url).toBe(false)
    }
  })

  it('a POST of the input, no redirects, the egress policy kept except for loopback', () => {
    const signal = new AbortController().signal
    const remote = hookHttpRequestOf({ url: URL_, body: '{"a":1}', headers: { 'Content-Type': 'application/json' }, timeoutMs: 5000, signal })
    expect(remote).toEqual({
      url: URL_,
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: new TextEncoder().encode('{"a":1}'),
      timeoutMs: 5000,
      maxResponseBytes: HOOK_HTTP_MAX_RESPONSE_BYTES,
      followRedirects: false,
    })
    expect(hookHttpRequestOf({ url: 'http://localhost:3000/h', body: '', headers: {}, timeoutMs: 1, signal }).allowPrivateNetwork).toBe(true)
  })

  it('the runner sends through network.httpRequest and decodes the body; none without the route', async () => {
    const httpRequest = vi.fn(async () => ({ status: 201, headers: {}, body: new TextEncoder().encode('{"ok":true}') }))
    const context = { platformCapabilities: { network: { httpGet: vi.fn(), httpRequest } }, options: {} } as unknown as ToolCallContext
    const runner = createNetworkHookHttpRunner(context)!
    const signal = new AbortController().signal
    await expect(runner.post({ url: URL_, body: '{}', headers: {}, timeoutMs: 10, signal })).resolves.toEqual({ status: 201, body: '{"ok":true}' })
    expect(httpRequest).toHaveBeenCalledWith(expect.objectContaining({ url: URL_, method: 'POST', followRedirects: false }), { signal })
    // No shell on this host: a listed variable reads as '', like an unset one.
    await expect(runner.readEnv(['TOKEN'])).resolves.toEqual({ TOKEN: '' })
    const bare = { platformCapabilities: { network: { httpGet: vi.fn() } }, options: {} } as unknown as ToolCallContext
    expect(createNetworkHookHttpRunner(bare)).toBeUndefined()
  })
})

describe('the environment a header reads', () => {
  it('asks bash for the names, NUL-separated; PowerShell when there is no bash', async () => {
    const calls: Parameters<HookCommandRunner>[0][] = []
    const runner: HookCommandRunner = async input => {
      calls.push(input)
      if (input.shell === 'bash') throw new Error('BINARY_NOT_FOUND: bash')
      return { stdout: 'abc\0\0', exitCode: 0 }
    }
    await expect(readEnvThroughShell(runner, ['TOKEN', 'UNSET'])).resolves.toEqual({ TOKEN: 'abc', UNSET: '' })
    expect(calls.map(c => c.shell)).toEqual(['bash', 'powershell'])
    expect(calls[0]!.command).toBe(`printf '%s\\0' "\${TOKEN-}" "\${UNSET-}"`)
    expect(calls[1]!.command).toContain('$env:TOKEN')
    await expect(readEnvThroughShell(runner, ['a;rm'])).rejects.toThrow('not an environment variable name')
  })

  it.skipIf(!HAS_BASH)('the bash command reads the real environment', async () => {
    const runner: HookCommandRunner = async input => {
      const ran = spawnSync('bash', ['-c', input.command], {
        env: { ...process.env, HOOK_T1: 'va lue "x" \\\\ end', HOOK_T2: '' },
        encoding: 'utf8',
      })
      return { stdout: ran.stdout, exitCode: ran.status ?? 1 }
    }
    await expect(readEnvThroughShell(runner, ['HOOK_T1', 'HOOK_T2', 'HOOK_T3_UNSET'])).resolves.toEqual({
      HOOK_T1: 'va lue "x" \\\\ end',
      HOOK_T2: '',
      HOOK_T3_UNSET: '',
    })
  })
})

describe('fireBeforeToolCall — http execution', () => {
  it('POSTs the hook input as JSON and a block verdict blocks', async () => {
    const http = fakeHttp({ status: 200, body: '{"decision":"block","reason":"policy says no"}' })
    const res = await preTool({ type: 'http', url: URL_ }, http)
    expect(res.blocked).toBe(true)
    expect(res.errors).toEqual(['policy says no'])
    expect(http.posts).toHaveLength(1)
    expect(http.posts[0]!.url).toBe(URL_)
    expect(http.posts[0]!.headers).toEqual({ 'Content-Type': 'application/json' })
    expect(JSON.parse(http.posts[0]!.body)).toMatchObject({
      session_id: 'sess',
      cwd: '/w',
      hook_event_name: 'PreToolUse',
      tool_name: 'Bash',
      tool_input: { command: 'ls' },
      tool_use_id: 'tu1',
    })
  })

  it('interpolates the listed variables alone, asks only for those, and strips CR / LF / NUL', async () => {
    const http = fakeHttp({ status: 200, body: '' }, { TOKEN: 'tok\r\nX-Evil: 1', OTHER: 'nope' })
    const res = await preTool(
      {
        type: 'http',
        url: URL_,
        headers: { Authorization: 'Bearer $TOKEN', 'X-Both': '${TOKEN}/${OTHER}/$UNLISTED' },
        allowedEnvVars: ['TOKEN', 'OTHER_NOT_REFERENCED', 'bad name'],
      },
      http,
    )
    expect(res.results[0]!.outcome).toEqual({ status: 'pass' })
    expect(http.envAsked).toEqual([['TOKEN']])
    expect(http.posts[0]!.headers).toEqual({
      'Content-Type': 'application/json',
      Authorization: 'Bearer tokX-Evil: 1',
      'X-Both': 'tokX-Evil: 1//',
    })
  })

  it('refuses a header carrying a host placeholder before sending', async () => {
    for (const value of ['{{secret:OPENAI_KEY}}', 'Bearer {{oauth:access_token}}']) {
      const http = fakeHttp({ status: 200, body: '' })
      const res = await preTool({ type: 'http', url: URL_, headers: { Authorization: value } }, http)
      expect(res.blocked).toBe(false)
      expect(res.results[0]!.outcome.status).toBe('non_blocking_error')
      expect(res.warnings.join(' ')).toContain('header Authorization holds a host placeholder')
      expect(http.posts).toHaveLength(0)
    }
    // Through an env value too.
    const http = fakeHttp({ status: 200, body: '' }, { T: '{{secret:X}}' })
    const res = await preTool({ type: 'http', url: URL_, headers: { A: '$T' }, allowedEnvVars: ['T'] }, http)
    expect(res.results[0]!.outcome.status).toBe('non_blocking_error')
    expect(http.posts).toHaveLength(0)
  })

  it('a non-2xx status, a non-JSON body, a failed request: non-blocking errors', async () => {
    const status = await preTool({ type: 'http', url: URL_ }, fakeHttp({ status: 503, body: '{"decision":"block"}' }))
    expect(status.blocked).toBe(false)
    expect(status.warnings).toEqual([`HTTP 503 from ${URL_}`])

    const prose = await preTool({ type: 'http', url: URL_ }, fakeHttp({ status: 200, body: 'all good' }))
    expect(prose.blocked).toBe(false)
    expect(prose.warnings).toEqual(['HTTP hook must return JSON, but got non-JSON response body: all good'])

    const failed = await preTool(
      { type: 'http', url: URL_ },
      fakeHttp(async () => {
        throw new Error('EGRESS_BLOCKED: 10.0.0.5 is not publicly routable')
      }),
    )
    expect(failed.blocked).toBe(false)
    expect(failed.warnings).toEqual([`HTTP hook ${URL_}: EGRESS_BLOCKED: 10.0.0.5 is not publicly routable`])
  })

  it('a request outliving the hook timeout times out (blocking, as every type)', async () => {
    const res = await preTool({ type: 'http', url: URL_, timeout: 0.05 }, fakeHttp(() => new Promise(() => {})))
    expect(res.results[0]!.outcome).toEqual({ status: 'timeout', error: `HTTP hook timed out: ${URL_}` })
  })

  it('without a runner it is not_implemented', async () => {
    const res = await preTool({ type: 'http', url: URL_ }, undefined)
    expect(res.results[0]!.outcome).toEqual({ status: 'not_implemented', hookType: 'http' })
  })
})

describe('firePromptSubmitted — http execution', () => {
  it("the JSON's additionalContext and systemMessage reach the result", async () => {
    const { appState, setAppState } = withHttpHook({ type: 'http', url: URL_ }, 'UserPromptSubmit')
    const http = fakeHttp({
      status: 200,
      body: '{"systemMessage":"noted","hookSpecificOutput":{"hookEventName":"UserPromptSubmit","additionalContext":"POLICY_CONTEXT"}}',
    })
    const res = await firePromptSubmitted({
      sessionId: 'sess',
      appState,
      setAppState,
      httpRunner: http,
      hookInput: { cwd: '/w', prompt: 'hello' },
    })
    expect(res.blocked).toBe(false)
    expect(res.additionalContext).toEqual(['POLICY_CONTEXT'])
    expect(res.systemMessages).toEqual(['noted'])
    expect(JSON.parse(http.posts[0]!.body)).toMatchObject({ hook_event_name: 'UserPromptSubmit', prompt: 'hello' })
  })
})

describe('the browser process environment', () => {
  function hostContext(readHostEnv: (names: string[]) => Promise<Record<string, string | null>>) {
    const httpRequest = vi.fn(async (_payload: unknown, _options: unknown) => ({ status: 200, headers: {}, body: new Uint8Array(0) }))
    const context = {
      platformCapabilities: { network: { httpGet: vi.fn(), httpRequest }, readHostEnv },
      options: {},
    } as unknown as ToolCallContext
    return { context, httpRequest }
  }

  it('a listed variable is read through shell.env: an exported token reaches the header', async () => {
    const readHostEnv = vi.fn(async (names: string[]) =>
      Object.fromEntries(names.map(name => [name, name === 'MY_TOKEN' ? 'tok-123' : null])),
    )
    const { context, httpRequest } = hostContext(readHostEnv)
    const http = createNetworkHookHttpRunner(context)!
    const result = await preTool(
      {
        type: 'http',
        url: URL_,
        headers: { Authorization: 'Bearer $MY_TOKEN', 'X-Unset': 'u=${MY_UNSET}', 'X-Unlisted': 'p=$PATH' },
        allowedEnvVars: ['MY_TOKEN', 'MY_UNSET'],
      },
      http,
    )
    expect(result.blocked).toBe(false)
    // Only the listed names a header references are asked for.
    expect(readHostEnv).toHaveBeenCalledTimes(1)
    expect(readHostEnv.mock.calls[0]![0].sort()).toEqual(['MY_TOKEN', 'MY_UNSET'])
    const payload = httpRequest.mock.calls[0]![0] as { headers: Record<string, string> }
    expect(payload.headers).toMatchObject({ Authorization: 'Bearer tok-123', 'X-Unset': 'u=', 'X-Unlisted': 'p=' })
  })

  it('a value carrying a host placeholder is refused, nothing sent', async () => {
    const { context, httpRequest } = hostContext(async () => ({ MY_TOKEN: '{{secret:api_key}}' }))
    const result = await preTool(
      { type: 'http', url: URL_, headers: { Authorization: 'Bearer $MY_TOKEN' }, allowedEnvVars: ['MY_TOKEN'] },
      createNetworkHookHttpRunner(context)!,
    )
    expect(result.blocked).toBe(false)
    expect(httpRequest).not.toHaveBeenCalled()
  })

  it('a host older than shell.env falls back to the shell; any other failure is the hook\'s error', async () => {
    const older = hostContext(async () => {
      throw new NativePrimitiveUnsupportedError('shell.env', 'not in the host manifest')
    })
    // No shell in this context either: '' (an unset variable).
    await expect(createNetworkHookHttpRunner(older.context)!.readEnv(['MY_TOKEN'])).resolves.toEqual({ MY_TOKEN: '' })
    const broken = hostContext(async () => {
      throw new NativePrimitiveError('INVALID_ARGS', 'shell.env: at most 64 names')
    })
    await expect(createNetworkHookHttpRunner(broken.context)!.readEnv(['MY_TOKEN'])).rejects.toThrow('at most 64 names')
  })

  it('the host bridge reads it over shell.env', async () => {
    const requests: Array<{ route: unknown; payload: unknown }> = []
    const transport = {
      async request(message: { route: unknown; payload: unknown }) {
        requests.push({ route: message.route, payload: message.payload })
        return { ok: true, result: { values: { MY_TOKEN: 'tok-123', MY_UNSET: null } } }
      },
    } as unknown as BrowserBridgeTransport
    const bridge = new BrowserHostBridge({ transport })
    await expect(bridge.readHostEnv(['MY_TOKEN', 'MY_UNSET'])).resolves.toEqual({ MY_TOKEN: 'tok-123', MY_UNSET: null })
    expect(requests).toEqual([
      { route: expect.objectContaining({ capability: 'shell', action: 'env' }), payload: { names: ['MY_TOKEN', 'MY_UNSET'] } },
    ])
  })
})
