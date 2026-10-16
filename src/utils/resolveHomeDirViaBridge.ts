import type { BrowserBridgeTransport } from '../browser/bridge/browserBridgeProtocol'
import { createBridgeRoute } from '../browser/bridge/browserBridgeProtocol'

/**
 * The user's home directory from the host's `fs.userHome` (the SharedWorker
 * env is empty). A failed answer is asked once more; `null` when neither names
 * a home, or with no transport. Never the host's `fs.cwd`: that is the
 * browser's own folder, where no other runtime reads user state. Request ids
 * are unique per call: sessions booting together share one host port, whose
 * pending replies are keyed by id.
 */
export async function resolveHomeDirViaBridge(
  transport: BrowserBridgeTransport | undefined,
): Promise<string | null> {
  if (!transport) return null
  const idPrefix = `home-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
  for (const attempt of ['uh', 'uh2']) {
    try {
      const response = await transport.request({
        id: `${idPrefix}-${attempt}`,
        route: createBridgeRoute('fs', 'userHome'),
        payload: {},
      })
      if (response.ok) {
        const home = response.result as unknown
        return typeof home === 'string' && home.length > 0 ? home : null
      }
    } catch {
      // Transport error — ask again.
    }
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
