/**
 * The remote client's "not connected" overlay over the still-mounted shell (F-24);
 * it also blocks every click that could only fail. It never dials on its own
 * schedule — only "now", on a press or when the page turns visible or the network
 * returns. Renders NOTHING unless the connection is `reconnecting`. No
 * `backdrop-blur`: re-compositing the shell every frame made weak machines stall.
 */
import type { ConnectionState } from '../../runtimeClient/RuntimeConnection'
import { DesktopUnreachableCard } from './DesktopUnreachableCard'

export function RemoteOfflineOverlay({
  state,
  onReconnectNow,
}: {
  state: ConnectionState | null
  onReconnectNow: () => void
}) {
  if (state?.status !== 'reconnecting') return null
  // Due or on the wire: the card says so and the icon turns.
  const dialing = state.nextAttemptAt <= Date.now()

  return (
    <div
      data-testid="remote-offline-overlay"
      data-dialing={dialing ? 'true' : 'false'}
      role="alertdialog"
      aria-modal="true"
      aria-labelledby="remote-offline-title"
      aria-describedby="remote-offline-body"
      className="fixed inset-0 z-[200] grid place-items-center bg-background/90 p-4"
    >
      <DesktopUnreachableCard
        everConnected
        attempt={state.attempt}
        nextAttemptAt={state.nextAttemptAt}
        onRetryNow={onReconnectNow}
      />
    </div>
  )
}
