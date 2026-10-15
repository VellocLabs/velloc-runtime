/**
 * The connect-screen states meaning "this page cannot reach the desktop right now"
 * (`failed`, `runtime_offline`, `host_gone`). Free of React: the boot path reads it
 * before the screen's module graph loads.
 */
import type { RemoteConnectState } from './RemoteConnectScreen'

export const UNREACHABLE_STATES: ReadonlySet<RemoteConnectState> = new Set<RemoteConnectState>([
  'failed',
  'runtime_offline',
  'host_gone',
])
