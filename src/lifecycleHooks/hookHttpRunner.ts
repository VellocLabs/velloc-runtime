/**
 * Security: hook HTTP runner, POSTs the hook input via `network.httpRequest`
 * under the C++ egress policy, except a host that is loopback by name
 * (`localhost`, `*.localhost`, `127.0.0.0/8`, `[::1]`), which opts out;
 * redirects are not followed. `$VAR` in headers reads only names listed in
 * `allowedEnvVars`, from `shell.env`; an older host falls back to the safe
 * shell env, where such a token reads as ''.
 */

import type { ToolCallContext } from '../toolkit/toolCallContext'
import { NativePrimitiveUnsupportedError } from '../browser/bridge/nativePrimitives'
import type { BridgeHttpRequestPayload } from '../browser/bridge/protocol/network'
import type { HookCommandRunner } from './hookCommandRunner'
import { createBashHookCommandRunner } from './hookCommandRunner'

export type HookHttpPostInput = {
  url: string
  /** The hook input JSON, already serialized. */
  body: string
  headers: Record<string, string>
  timeoutMs: number
  signal: AbortSignal
}

export type HookHttpPostResult = {
  status: number
  body: string
}

export type HookHttpRunner = {
  post(input: HookHttpPostInput): Promise<HookHttpPostResult>
  /** The browser process environment's values for `names` (an unset one
   *  is `''`). Names are already checked against `ENV_NAME`. */
  readEnv(names: readonly string[]): Promise<Record<string, string>>
}

/** The env names a header may interpolate (`$NAME` / `${NAME}`). */
export const ENV_NAME = /^[A-Z_][A-Z0-9_]*$/

/** A response body larger than this is cut (the verdict is a small JSON). */
export const HOOK_HTTP_MAX_RESPONSE_BYTES = 1024 * 1024

/**
 * Whether `url`'s host is loopback by name or literal — the hosts an http
 * hook may reach that Nexus's egress policy would otherwise refuse.
 */
export function isLoopbackHookUrl(url: string): boolean {
  let host: string
  try {
    host = new URL(url).hostname.toLowerCase()
  } catch {
    return false
  }
  if (host === 'localhost' || host.endsWith('.localhost')) return true
  if (host === '[::1]') return true
  const v4 = /^127\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host)
  return v4 !== null && v4.slice(1).every(part => Number(part) <= 255)
}

/** The bridge payload for one hook POST. */
export function hookHttpRequestOf(input: HookHttpPostInput): BridgeHttpRequestPayload {
  return {
    url: input.url,
    method: 'POST',
    headers: input.headers,
    body: new TextEncoder().encode(input.body),
    timeoutMs: input.timeoutMs,
    maxResponseBytes: HOOK_HTTP_MAX_RESPONSE_BYTES,
    followRedirects: false,
    ...(isLoopbackHookUrl(input.url) ? { allowPrivateNetwork: true } : {}),
  }
}

/**
 * Read `names` from the host environment through the command runner: bash
 * first, PowerShell when the host has no bash. The values come back
 * NUL-separated, one per name, in order.
 */
export async function readEnvThroughShell(
  runner: HookCommandRunner,
  names: readonly string[],
): Promise<Record<string, string>> {
  for (const name of names) {
    if (!ENV_NAME.test(name)) throw new TypeError(`not an environment variable name: ${name}`)
  }
  if (names.length === 0) return {}
  const forBash = `printf '%s\\0' ${names.map(name => `"\${${name}-}"`).join(' ')}`
  const forPowerShell =
    `[Console]::Out.Write(((${names.map(name => `[string]$env:${name}`).join(', ')}) -join [char]0) + [char]0)`
  let output: string
  try {
    output = (await runner({ command: forBash, shell: 'bash', stdin: '', env: {}, timeoutMs: 10_000 })).stdout
  } catch {
    output = (await runner({ command: forPowerShell, shell: 'powershell', stdin: '', env: {}, timeoutMs: 10_000 })).stdout
  }
  const values = output.split('\0')
  const env: Record<string, string> = {}
  names.forEach((name, index) => {
    env[name] = values[index] ?? ''
  })
  return env
}

/**
 * Build a runner over the session's network capability, or `undefined` when
 * this runtime has no `network.httpRequest` (a mock host, a host whose
 * bridge predates the route) — the executor then leaves http hooks
 * unexecuted (`not_implemented`), as it does the other types.
 */
export function createNetworkHookHttpRunner(
  context: ToolCallContext,
): HookHttpRunner | undefined {
  const capabilities = context.platformCapabilities
  const network = capabilities?.network
  const request = network?.httpRequest?.bind(network)
  if (!request) return undefined
  const readHostEnv = capabilities?.readHostEnv?.bind(capabilities)
  const commandRunner = createBashHookCommandRunner(context)
  return {
    async post(input) {
      const result = await request(hookHttpRequestOf(input), { signal: input.signal })
      const body = result.body instanceof Uint8Array ? result.body : new Uint8Array(0)
      return { status: result.status, body: new TextDecoder('utf-8').decode(body) }
    },
    async readEnv(names) {
      if (readHostEnv) {
        try {
          const values = await readHostEnv([...names])
          return Object.fromEntries(names.map(name => [name, values[name] ?? '']))
        } catch (error) {
          // A host older than `shell.env`: the shell below. Any other
          // failure is the hook's error.
          if (!(error instanceof NativePrimitiveUnsupportedError)) throw error
        }
      }
      // No shell: nothing to read the environment through, so every
      // reference resolves to ''.
      if (!commandRunner) return Object.fromEntries(names.map(name => [name, '']))
      return readEnvThroughShell(commandRunner, names)
    },
  }
}
