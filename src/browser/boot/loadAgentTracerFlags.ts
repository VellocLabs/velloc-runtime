/**
 * Page-thread read of the `agent.log` / `agent.trace` flags from `~/.velloc/settings.json` for the
 * model-upload tracer. Any failure returns `{ log: false, trace: false }`; URL params still apply.
 */

import { createBrowserFsOperations } from '../../utils/BrowserFsOperations'
import type { BrowserBridgeTransport } from '../bridge/protocol/core'
import { resolveHomeDirViaBridge } from '../../utils/resolveHomeDirViaBridge'

export type AgentTracerFlags = {
  /** Maps to `?log=1` — enables the model-upload bus + worker tracer. */
  log: boolean
  /** Maps to `?trace=1` — bus + worker tracer + the floating overlay UI. */
  trace: boolean
}

const FALLBACK_FLAGS: AgentTracerFlags = { log: false, trace: false }


/**
 * Read the `agent` section of `~/.velloc/settings.json` via the bridge (home dir, then a bridge-backed
 * fs). Any failure returns `{ log: false, trace: false }`. The `env` parameter is not read.
 */
export async function loadAgentTracerFlags(
  transport: BrowserBridgeTransport,
): Promise<AgentTracerFlags> {
  // Dynamic import keeps zod off the boot entry chunk; started before the bridge round trips so the
  // fetch overlaps them. The no-op catch avoids an unhandled rejection on early-return paths.
  const settingsModulePromise = import('../../settings/settingsStore')
  settingsModulePromise.catch(() => {})
  try {
    const homeDir = await resolveHomeDirViaBridge(transport)
    if (!homeDir) return FALLBACK_FLAGS

    const fs = createBrowserFsOperations({
      transport,
      createRequestId: () => `boot-tracer-fs-${Date.now().toString(36)}-${
        Math.random().toString(36).slice(2, 8)
      }`,
      initialCwd: homeDir,
    })

    const { readUserLayer } = await settingsModulePromise
    const { settings } = await readUserLayer(homeDir, fs)
    const agent = settings.agent
    return {
      log: agent?.log === true,
      trace: agent?.trace === true,
    }
  } catch {
    return FALLBACK_FLAGS
  }
}

/**
 * Race a tracer-flags read against the boot budget: `FALLBACK_FLAGS` on timeout, then `onLateResolve`
 * when the late read enables anything. The timer is cleared when the read wins.
 */
export async function resolveTracerFlagsWithinBudget(
  flagsPromise: Promise<AgentTracerFlags>,
  timeoutMs: number,
  onLateResolve: (flags: AgentTracerFlags) => void,
): Promise<AgentTracerFlags> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const result = await Promise.race([
    flagsPromise.then(flags => ({ flags }) as const),
    new Promise<'timeout'>(resolve => {
      timer = setTimeout(() => resolve('timeout'), timeoutMs)
    }),
  ])
  if (result !== 'timeout') {
    clearTimeout(timer)
    return result.flags
  }
  // loadAgentTracerFlags never rejects (it degrades to FALLBACK_FLAGS
  // internally), so a bare .then is safe here.
  void flagsPromise.then(flags => {
    if (flags.log || flags.trace) onLateResolve(flags)
  })
  return FALLBACK_FLAGS
}

/**
 * Combine URL-param tracer signals with settings.json values; explicit URL params win. Returns
 * `enableBus` (bus + worker tracer) and `enableOverlay` (also the overlay UI).
 */
export function combineTracerSignals(
  urlParams: { log: boolean; trace: boolean; traceModelRequests: boolean },
  settings: AgentTracerFlags,
): { enableBus: boolean; enableOverlay: boolean } {
  // The bus turns on if ANY signal says so. Matches the existing
  // shouldEnableModelUploadTrace() OR-logic and extends it to settings.
  const enableBus =
    urlParams.log
    || urlParams.trace
    || urlParams.traceModelRequests
    || settings.log
    || settings.trace
  // The overlay is gated on the explicit `trace` signal — `?log=1` /
  // `?traceModelRequests=1` / `agent.log` leave the overlay off so
  // power users can enable just-the-bus without DOM clutter.
  const enableOverlay = urlParams.trace || settings.trace
  return { enableBus, enableOverlay }
}
