import type { BrowserBridgeTransport } from '../browser/bridge/browserBridgeProtocol'
import { createBridgeRoute } from '../browser/bridge/browserBridgeProtocol'
import type { RuntimeConfig } from '../runtime/interfaces/RuntimeConfig'

/**
 * Resolve the runtime cwd against the host once at boot: an absolute
 * `initialCwd` is trusted as an override; otherwise `fs.cwd`. An empty or failed
 * answer throws: refusing to boot beats advertising `'.'` to the model. No
 * JS-side fallback.
 */
export async function resolveRuntimeCwd(args: {
  initialCwd: string | undefined
  bridgeTransport: BrowserBridgeTransport
  runtimeConfig: RuntimeConfig
}): Promise<string> {
  if (args.initialCwd && isAbsolutePath(args.initialCwd)) {
    return args.initialCwd
  }

  const hostCwd = await fetchHostCwd(args.bridgeTransport, args.runtimeConfig)
  if (hostCwd && isAbsolutePath(hostCwd)) {
    return hostCwd
  }

  throw new Error(
    'runtime_cwd_unresolved: no absolute cwd available from initPayload.cwd ' +
      'or the `fs.cwd` bridge route. Refusing to boot the runtime with a ' +
      'relative working directory — the model would advertise a relative ' +
      'path in its system prompt and every Write/Bash/Edit call would ' +
      'fail validation downstream. Fix: ensure the C++ host populates ' +
      '`NexusFsHost::cwd_` (typically from the profile path in ' +
      'nexus_bridge_port_service.cc) before the SharedWorker connects.',
  )
}

/**
 * Cross-platform absolute-path check. POSIX paths start with `/`;
 * Windows paths start with `<letter>:\` or `<letter>:/` or UNC `\\`.
 * Keep this in sync with `base::FilePath::IsAbsolute()` on the C++
 * side — both layers reject the same non-absolute shapes so the
 * model sees a single consistent policy.
 */
function isAbsolutePath(path: string): boolean {
  if (path.startsWith('/')) return true
  if (/^[A-Za-z]:[\\/]/.test(path)) return true
  if (path.startsWith('\\\\')) return true
  return false
}

async function fetchHostCwd(
  transport: BrowserBridgeTransport,
  runtimeConfig: RuntimeConfig,
): Promise<string | undefined> {
  try {
    const response = await transport.request({
      id: runtimeConfig.createUUID(),
      route: createBridgeRoute('fs', 'cwd'),
      payload: {},
    })
    if (response.ok && typeof response.result === 'string') {
      return response.result
    }
    return undefined
  } catch {
    return undefined
  }
}
