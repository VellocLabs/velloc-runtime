import type { BrowserContextSnapshot } from '../bridge/BrowserHostBridge'

export type BuildBrowserUserContextParams = {
  snapshot: BrowserContextSnapshot
  /**
   * Local ISO date (YYYY-MM-DD) captured once at session bootstrap and frozen so
   * the cached system prefix stays byte-stable; rollover is the `date_change`
   * attachment's job.
   */
  sessionStartDate: string
}

/**
 * The dict under the "User context:" heading of the merged system instruction:
 * only `currentDate`, fixed at session start for cache stability (F-19).
 */
export function buildBrowserUserContext(
  params: BuildBrowserUserContextParams,
): Record<string, string> {
  return {
    currentDate: `Today's date is ${params.sessionStartDate}.`,
  }
}
