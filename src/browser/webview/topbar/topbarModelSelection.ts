import type { BrowserLlmSelection } from '../../bridge/protocol/nexus_llm'
import type { BrowserRuntimeClientState } from '../browserRuntimeClientState'

/**
 * The selection the topbar model picker shows. Until the active session has
 * settled (snapshot arrived, transcript-only view loaded, or client failed) it
 * keeps the selection it last showed instead of falling back to "Select
 * model"; once settled, the session's own selection wins, absent or not.
 */
export function topbarModelSelection(
  state: Pick<BrowserRuntimeClientState, 'snapshot' | 'transcriptOnly' | 'status'>,
  lastShown: BrowserLlmSelection | null | undefined,
): BrowserLlmSelection | null | undefined {
  const settled = !!state.snapshot || !!state.transcriptOnly || state.status === 'error'
  return settled ? state.snapshot?.currentSelection : lastShown
}
