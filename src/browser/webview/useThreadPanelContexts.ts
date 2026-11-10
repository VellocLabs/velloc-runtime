import { useMemo } from 'react'
import type { ShellCommandContextValue } from '@/components/assistant-ui/shell-command'
import { TERMINAL_CAPABILITY, type TerminalRunResult } from '@/terminal/protocol'
import { createFilePathProbe } from '@/components/assistant-ui/file-path-context'
import type { SessionMcpServerView } from '../worker/workerProtocol'
import { findWorkspaceDiffFile } from '../../utils/turnDiffs'
import { useMcpAuth } from './mcpAuthView'
import { useResolvedConnection, useTerminalsState } from './terminal/useTerminals'
import type { AssistantUiThreadProps } from './AssistantUiThreadProps'

/** The context values a thread hands its cards: background tasks, connectors, the right panel, shell commands and file paths. */
export function useThreadPanelContexts({
  state,
  readOnly,
  runtimeConnection,
  onOpenBackgroundTasks,
  runningBackgroundTaskCount,
  backgroundTaskRows,
  onStopBackgroundTask,
  onOpenBackgroundTasksList,
  openSettings,
  loadTurnDiffDetail,
  onOpenDiffInPanel,
  onOpenFileInPanel,
  onOpenSkillInPanel,
  onOpenTerminalInPanel,
  statFilePaths,
}: {
  state: AssistantUiThreadProps['state']
  readOnly: boolean
  runtimeConnection: AssistantUiThreadProps['runtimeConnection']
  onOpenBackgroundTasks: AssistantUiThreadProps['onOpenBackgroundTasks']
  runningBackgroundTaskCount: AssistantUiThreadProps['runningBackgroundTaskCount']
  backgroundTaskRows: AssistantUiThreadProps['backgroundTaskRows']
  onStopBackgroundTask: AssistantUiThreadProps['onStopBackgroundTask']
  onOpenBackgroundTasksList: AssistantUiThreadProps['onOpenBackgroundTasksList']
  openSettings: AssistantUiThreadProps['openSettings']
  loadTurnDiffDetail: AssistantUiThreadProps['loadTurnDiffDetail']
  onOpenDiffInPanel: AssistantUiThreadProps['onOpenDiffInPanel']
  onOpenFileInPanel: AssistantUiThreadProps['onOpenFileInPanel']
  onOpenSkillInPanel: AssistantUiThreadProps['onOpenSkillInPanel']
  onOpenTerminalInPanel: AssistantUiThreadProps['onOpenTerminalInPanel']
  statFilePaths: AssistantUiThreadProps['statFilePaths']
}) {
  // Handle for the conversation's Agent tool cards to open the global Background
  // Tasks drawer (the "jump to background task" affordance), provided via
  // BackgroundTasksContext. Memoized so the context value is referentially
  // stable across renders.
  const backgroundTasksValue = useMemo(
    () => ({
      openTasksDrawer: onOpenBackgroundTasks,
      runningTaskCount: runningBackgroundTaskCount,
      taskRows: backgroundTaskRows,
      stopTask: onStopBackgroundTask,
      openTasksList: onOpenBackgroundTasksList,
    }),
    [
      onOpenBackgroundTasks,
      runningBackgroundTaskCount,
      backgroundTaskRows,
      onStopBackgroundTask,
      onOpenBackgroundTasksList,
    ],
  )
  // Every snapshot is a new object; the Connectors card re-renders only when
  // the list itself changes.
  const sessionConnectorsKey = JSON.stringify(state.snapshot?.mcpServers ?? [])
  const openMcpSettings = useMemo(
    () =>
      openSettings
        ? () => {
            void openSettings('mcp').catch((error: unknown) => {
              console.error('Failed to open MCP settings:', error)
            })
          }
        : undefined,
    [openSettings],
  )
  const mcpAuth = useMcpAuth(runtimeConnection)
  const sessionConnectors = useMemo(
    () => ({
      servers: JSON.parse(sessionConnectorsKey) as SessionMcpServerView[],
      ...(openMcpSettings ? { openMcpSettings } : {}),
      auth: mcpAuth,
    }),
    [sessionConnectorsKey, openMcpSettings, mcpAuth],
  )
  // Handle for the conversation's Read/Edit tool cards to open a file or diff in
  // the global Right Panel (Files / Diff views), provided via
  // RightPanelContentContext. Memoized for referential stability.
  // WorkspaceDiff card title → the Diff view. With a path: resolve that
  // file's whole-session snapshot diff (sentinel turn 0 — served by the
  // worker for fileSnapshots sessions) and open it as a `file` target; a
  // path-less call, an unresolvable path, or a load failure all land on the
  // turn-history tab — never a dead click.
  const onOpenWorkspaceDiff = useMemo(() => {
    if (!onOpenDiffInPanel) return undefined
    return (path?: string) => {
      void (async () => {
        if (path && path.trim() && loadTurnDiffDetail) {
          try {
            const files = await loadTurnDiffDetail(0)
            const match = findWorkspaceDiffFile(files, path)
            if (match) {
              onOpenDiffInPanel({
                kind: 'file',
                filePath: match.filePath,
                hunks: match.hunks,
                plusLines: match.plusLines,
                minusLines: match.minusLines,
              })
              return
            }
          } catch {
            // fall through to the turn-history tab
          }
        }
        onOpenDiffInPanel({ kind: 'turnHistory' })
      })()
    }
  }, [onOpenDiffInPanel, loadTurnDiffDetail])

  const rightPanelContentValue = useMemo(
    () => ({
      openFile: onOpenFileInPanel,
      openDiff: onOpenDiffInPanel,
      openSkill: onOpenSkillInPanel,
      openWorkspaceDiff: onOpenWorkspaceDiff,
    }),
    [onOpenFileInPanel, onOpenDiffInPanel, onOpenSkillInPanel, onOpenWorkspaceDiff],
  )
  // One-line shell blocks run in this session's terminal (F-31): offered only
  // with the `terminal.run` grant, on a host that has terminals, in a thread
  // that can act.
  const shellConnection = useResolvedConnection(runtimeConnection)
  const terminalsAvailable = useTerminalsState(shellConnection)?.available === true
  const shellSessionId = state.snapshot?.sessionId ?? null
  const shellCommandValue = useMemo<ShellCommandContextValue>(() => {
    const canRun =
      !readOnly &&
      shellConnection !== null &&
      shellSessionId !== null &&
      terminalsAvailable &&
      shellConnection.can(TERMINAL_CAPABILITY, 'run')
    return {
      connection: shellConnection,
      sessionId: shellSessionId,
      ...(canRun
        ? {
            run: (command: string) =>
              shellConnection.request<TerminalRunResult>(`${TERMINAL_CAPABILITY}.run`, {
                sessionId: shellSessionId,
                command,
              }),
          }
        : {}),
      ...(onOpenTerminalInPanel && shellSessionId !== null
        ? { openTerminal: (terminalId: string) => onOpenTerminalInPanel(shellSessionId, terminalId) }
        : {}),
    }
  }, [readOnly, shellConnection, shellSessionId, terminalsAvailable, onOpenTerminalInPanel])
  // Auto-detected file paths in the transcript: the project root is the ONE
  // base a relative mention is resolved against (no searching), and the probe
  // is the batched existence check that decides whether a path becomes an
  // openable `>>` affordance. One probe per host `statPaths` function, so its
  // cache is shared by every message in this thread.
  const filePathProbe = useMemo(
    () => (statFilePaths ? createFilePathProbe(statFilePaths) : undefined),
    [statFilePaths],
  )
  const filePathContextValue = useMemo(
    () => ({ projectRoot: state.snapshot?.projectRoot, probe: filePathProbe }),
    [state.snapshot?.projectRoot, filePathProbe],
  )

  return { backgroundTasksValue, sessionConnectors, rightPanelContentValue, shellCommandValue, filePathContextValue }
}
