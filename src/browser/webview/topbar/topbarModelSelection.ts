import type { BrowserLlmSelection } from '../../bridge/protocol/nexus_llm'

/**
 * The selection the topbar model picker shows. While the active session's
 * snapshot has not arrived (a switch or a cold session), it keeps the last
 * selection it showed instead of falling back to "Select model"; once the
 * snapshot is there, the session's own selection wins, absent or not.
 */
export function topbarModelSelection(
  snapshotLoaded: boolean,
  sessionSelection: BrowserLlmSelection | null | undefined,
  lastShown: BrowserLlmSelection | null | undefined,
): BrowserLlmSelection | null | undefined {
  return snapshotLoaded ? sessionSelection : lastShown ?? sessionSelection
}
