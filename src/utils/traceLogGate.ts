/**
 * Page-realm gate for boot/diagnostic console logging: opt-in only via
 * `?log=1` / `?trace=1` / `?traceModelRequests=1` (these lines fire before
 * settings load). Not cached.
 */
export function isTraceLogUrlFlagEnabled(): boolean {
  try {
    const params = new URLSearchParams(globalThis.location?.search ?? '')
    return (
      params.get('log') === '1'
      || params.get('trace') === '1'
      || params.get('traceModelRequests') === '1'
    )
  } catch {
    return false
  }
}
