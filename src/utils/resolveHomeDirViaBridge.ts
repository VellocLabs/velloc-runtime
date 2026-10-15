import type { BrowserBridgeTransport } from '../browser/bridge/browserBridgeProtocol'
import { createBridgeRoute } from '../browser/bridge/browserBridgeProtocol'

/**
 * The user's home directory from the host (`fs.userHome`, falling back to
 * `fs.cwd`): the reliable source for `~/.velloc` paths, since the SharedWorker
 * env is empty. `null` on any failure or no transport.
 */
export async function resolveHomeDirViaBridge(
  transport: BrowserBridgeTransport | undefined,
): Promise<string | null> {
  if (!transport) return null
  const idPrefix = `home-${Date.now().toString(36)}`
  try {
    const userHomeResponse = await transport.request({
      id: `${idPrefix}-uh`,
      route: createBridgeRoute('fs', 'userHome'),
      payload: {},
    })
    if (userHomeResponse.ok) {
      const home = userHomeResponse.result as string
      if (home && home.length > 0) {
        return home
      }
    }
  } catch {
    // Transport error / older host without `fs.userHome` — try cwd.
  }

  try {
    const cwdResponse = await transport.request({
      id: `${idPrefix}-cwd`,
      route: createBridgeRoute('fs', 'cwd'),
      payload: {},
    })
    if (cwdResponse.ok) {
      const cwd = cwdResponse.result as string
      if (cwd && cwd.length > 0) {
        return cwd
      }
    }
  } catch {
    // Both routes failed — caller degrades to the legacy layout.
  }
  return null
}

/**
 * Boot-safe {@link resolveHomeDirViaBridge}: races the probe against a timeout
 * so boot cannot stall on a host that never answers. The timer is always
 * cleared; `timedOut: true` only when the timer actually wins.
 */
export async function resolveHomeDirViaBridgeBounded(
  transport: BrowserBridgeTransport | undefined,
  timeoutMs: number,
): Promise<{ home: string | null; timedOut: boolean }> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<'timeout'>(resolve => {
    timer = setTimeout(() => resolve('timeout'), timeoutMs)
  })
  try {
    const result = await Promise.race([
      resolveHomeDirViaBridge(transport).then(home => ({ home }) as const),
      timeout,
    ])
    return result === 'timeout'
      ? { home: null, timedOut: true }
      : { home: result.home, timedOut: false }
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}
