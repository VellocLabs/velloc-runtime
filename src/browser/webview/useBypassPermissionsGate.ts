import { useCallback, useEffect, useState } from 'react'
import { shouldGateBypassSwitch } from './BypassPermissionsDialog'
import type { AssistantUiThreadProps } from './AssistantUiThreadProps'

// The startup bypass-warning gate (F-13) fires at most once PER SESSION. Keyed
// by sessionId — NOT a per-instance ref — so it survives MultiSessionShell's LRU
// mount/unmount churn: a session that boots in the background and later
// foregrounds, or one evicted and remounted, must not re-warn. Keying on
// sessionId means this module-global does not leak across sessions (each session
// reads only its own key — cf. the multi-session global-state caveat).
const startupBypassGatedSessions = new Set<string>()

/** The Bypass-Permissions warning gate (F-13) for live mode switches and the startup case. */
export function useBypassPermissionsGate({
  state,
  permissionMode,
  isForegroundSession,
  setPermissionMode,
  setSkipDangerousMode,
}: {
  state: AssistantUiThreadProps['state']
  permissionMode: string
  isForegroundSession: boolean
  setPermissionMode: AssistantUiThreadProps['setPermissionMode']
  setSkipDangerousMode: AssistantUiThreadProps['setSkipDangerousMode']
}) {
  // Bypass-Permissions warning gate (F-13). A switch INTO bypassPermissions
  // is intercepted before it applies; `bypassPending` holds the prior mode to
  // restore on cancel (null for a live switch — it was never applied; 'default'
  // for the startup case below — it WAS applied at boot).
  const skipDangerousFlag =
    state.snapshot?.skipDangerousModePermissionPrompt === true
  const [bypassPending, setBypassPending] = useState<
    { revertTo: string | null } | null
  >(null)
  const handleSetPermissionMode = useCallback(
    (mode: string) => {
      if (
        shouldGateBypassSwitch({
          next: mode,
          current: permissionMode,
          skipFlag: skipDangerousFlag,
        })
      ) {
        setBypassPending({ revertTo: null }) // not applied yet; cancel = no-op
        return
      }
      void setPermissionMode?.(mode)
    },
    [setPermissionMode, permissionMode, skipDangerousFlag],
  )

  // Startup gate — the primary trigger: a session that boots already in
  // bypassPermissions without a prior acknowledgment shows the warning once.
  // Unlike a live switch, the mode was already applied, so cancel reverts to
  // `default`. Guarded per-session (module Set) so it fires at most once per
  // session even across LRU mount/unmount churn.
  const snapshotSessionId = state.snapshot?.sessionId
  useEffect(() => {
    if (!isForegroundSession || !snapshotSessionId) return
    if (startupBypassGatedSessions.has(snapshotSessionId)) return
    if (permissionMode === 'bypassPermissions' && !skipDangerousFlag) {
      startupBypassGatedSessions.add(snapshotSessionId)
      setBypassPending({ revertTo: 'default' })
    }
  }, [isForegroundSession, snapshotSessionId, permissionMode, skipDangerousFlag])

  // Isolate the dialog per session: a thread leaving the foreground with a
  // warning pending must not re-show it on switch-back (the accept/cancel
  // handlers only run on interaction with the now-unmounted dialog).
  useEffect(() => {
    if (!isForegroundSession) setBypassPending(null)
  }, [isForegroundSession])

  const handleBypassAccept = useCallback(async () => {
    try {
      // Mark this session gated BEFORE any await: a stale `worker.state` can predate the
      // persisted skip flag and re-open the dialog. Accepting IS the ack.
      if (snapshotSessionId) startupBypassGatedSessions.add(snapshotSessionId)
      // Persist the acknowledgment FIRST so the snapshot's skip-flag is true
      // BEFORE bypass becomes the active mode. Apply the mode only for a live
      // switch (startup is already in bypass). Keep the dialog open if a step
      // throws (no silent success).
      await setSkipDangerousMode?.(true)
      if (permissionMode !== 'bypassPermissions') {
        await setPermissionMode?.('bypassPermissions')
      }
      setBypassPending(null)
    } catch (err) {
      console.error('[bypass] failed to apply bypassPermissions', err)
    }
  }, [setSkipDangerousMode, setPermissionMode, permissionMode, snapshotSessionId])

  const handleBypassCancel = useCallback(() => {
    const revertTo = bypassPending?.revertTo
    setBypassPending(null)
    if (revertTo) {
      void Promise.resolve(setPermissionMode?.(revertTo)).catch(err =>
        console.error('[bypass] failed to revert permission mode', err),
      )
    }
  }, [bypassPending, setPermissionMode])

  return { bypassPending, handleSetPermissionMode, handleBypassAccept, handleBypassCancel }
}
