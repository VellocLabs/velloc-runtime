/**
 * The open session's sheets in the phone shell (F-24): usage, session details, background tasks
 * and model. It reads the session's client state and the runtime's feeds the shell passes in, and
 * computes a sheet's figures only while that sheet is open.
 */
import { useEffect, useMemo } from 'react'

import type { NexusTaskSummaryRow } from '../browser/bridge/protocol/ui'
import type { BrowserLlmSelection } from '../browser/bridge/browserBridgeProtocol'
import type { SessionListChannel } from '../browser/runtimeClient'
import type { BrowserRuntimeClientState } from '../browser/webview/browserRuntimeClientState'
import { contextUsageFigures } from '../browser/webview/contextUsage'
import { createConfiguredModelCatalog } from '../browser/webview/modelCatalog'
import { getProviderUsageStore, useProviderUsage } from '../browser/webview/providerUsageStore'
import type { DrivenDesktop } from '../browser/webview/remote/hostIdentity'
import { usageForModel } from '../config/nexusModelConfig/modelDisplay'
import { MobileModelSheet } from './MobileModelSheet'
import { MobileSessionDetailsSheet } from './MobileSessionDetailsSheet'
import { MobileTasksSheet } from './MobileTasksSheet'
import { MobileUsageSheet } from './MobileUsageSheet'

export type MobileSheetKind = 'usage' | 'details' | 'tasks' | 'model'

export type MobileShellSheetsProps = {
  sheet: MobileSheetKind | null
  onClose: () => void
  sessionId: string
  state: BrowserRuntimeClientState
  /** The session's background tasks (`subAgentRowsForSession`). */
  taskRows: readonly NexusTaskSummaryRow[]
  onStopTask: (taskId: string) => void
  onSelectModel: (sessionId: string, selection: BrowserLlmSelection) => void
  host?: DrivenDesktop
  /** The session's project folder; absent for the shared workspace. */
  projectRoot?: string
  sessionChannel?: SessionListChannel
}

export function MobileShellSheets({
  sheet,
  onClose,
  sessionId,
  state,
  taskRows,
  onStopTask,
  onSelectModel,
  host,
  projectRoot,
  sessionChannel,
}: MobileShellSheetsProps) {
  const snapshot = state.snapshot
  const selection = snapshot?.currentSelection
  const providerId = selection?.providerId ?? snapshot?.currentProviderId
  const modelId = selection?.modelId ?? snapshot?.activeModelId
  const onOpenChange = (open: boolean) => {
    if (!open) onClose()
  }

  const usageOpen = sheet === 'usage'
  const providerUsage = useProviderUsage(usageOpen ? providerId : undefined)
  // The figures read the transcript, the model and the auto-compact switch; a new snapshot object
  // arrives on every worker push, so it must not be a dependency.
  const hasSnapshot = snapshot !== undefined
  const autoCompactEnabled = snapshot?.autoCompact?.enabled
  const autoCompactWindow = snapshot?.autoCompact?.windowTokens
  const context = useMemo(
    () =>
      usageOpen && hasSnapshot && modelId
        ? contextUsageFigures({
            messages: state.transcriptMessages,
            liveEvents: state.liveEvents,
            modelId,
            providerId: selection?.providerId,
            autoCompact: snapshot?.autoCompact,
          })
        : undefined,
    [
      usageOpen,
      hasSnapshot,
      autoCompactEnabled,
      autoCompactWindow,
      modelId,
      selection?.providerId,
      state.transcriptMessages,
      state.liveEvents,
    ],
  )

  const configuredCatalog = useMemo(
    () => (usageOpen || sheet === 'model') && snapshot ? createConfiguredModelCatalog(snapshot.modelCatalog) : undefined,
    [usageOpen, sheet, snapshot],
  )
  const modelFree = configuredCatalog?.providers
    .find(p => p.id === selection?.providerId)
    ?.models.find(m => m.id === selection?.modelId)?.free
  const planUsage = providerUsage?.usage
    ? usageForModel(providerId, providerUsage.usage, { free: modelFree })
    : undefined

  const tasksOpen = sheet === 'tasks'
  // Tasks a restart left behind are rebuilt from the transcript only when someone looks.
  useEffect(() => {
    if (!tasksOpen || !sessionId) return
    sessionChannel?.request('task.recoverBackground', { sessionId })
  }, [tasksOpen, sessionId, sessionChannel])

  return (
    <>
      <MobileUsageSheet
        open={usageOpen}
        onOpenChange={onOpenChange}
        context={context}
        planUsage={planUsage}
        onRefresh={providerId ? () => getProviderUsageStore().refresh(providerId, true) : undefined}
      />
      <MobileSessionDetailsSheet
        open={sheet === 'details'}
        onOpenChange={onOpenChange}
        host={host}
        projectRoot={projectRoot}
        branch={snapshot?.projectBranch || undefined}
      />
      <MobileTasksSheet open={tasksOpen} onOpenChange={onOpenChange} rows={taskRows} onStop={onStopTask} />
      <MobileModelSheet
        open={sheet === 'model'}
        onOpenChange={onOpenChange}
        catalog={configuredCatalog}
        selection={selection}
        onSelect={next => {
          onSelectModel(sessionId, next)
          onClose()
        }}
      />
    </>
  )
}
