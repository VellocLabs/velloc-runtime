import { Suspense, type ComponentProps, type ReactNode } from 'react'
import { PlusIcon } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { RightPanelContentContext } from '@/components/assistant-ui/right-panel-content-context'
import { FilePathContext } from '@/components/assistant-ui/file-path-context'
import { setMaximized, type SidePaneKind, type SessionPaneRecord } from './layout/paneLayout'
import { PaneFrame } from './panes/PaneFrame'
import { A2uiPaneActionsSlot } from './a2ui/A2uiPaneSlot'
import { IMMERSIVE_PANES } from './panes/paneKinds'
import { ModsPane } from './panes/ModsPane'
import { SideChatPane } from './panes/SideChatPane'
import { BrowserAddressBar, BrowserTabStrip } from './panes/BrowserPaneChrome'
import { WebviewArea } from './WebviewArea'
import { SessionAreaVisibleContext } from './sessionAreaVisibility'
import { SidePaneBody, FilesPane, TerminalPane } from './coldUi'
import { EMPTY_FILES_PANE } from './shellPaneActions'
import type { BrowserRuntimeClientState } from './BrowserRuntimeClient'
import type { CapabilityQuery } from './useCan'
import type { TranslateFn } from './i18n/translate'
import type { SettingsSectionId } from './settings/SettingsScreen'

type PaneBodyProps = ComponentProps<typeof SidePaneBody>
type FilesProps = ComponentProps<typeof FilesPane>
type SideChatProps = ComponentProps<typeof SideChatPane>
type BrowserTabStripProps = ComponentProps<typeof BrowserTabStrip>

/**
 * Contract: the shell values the side panes read. Each is handed to its pane
 * as-is, so a value's identity is the identity the shell holds.
 */
export interface ShellSidePaneInputs {
  sidePaneName: (kind: SidePaneKind) => string
  paneMaximized: SidePaneKind | null
  updatePaneRecord: (fn: (prev: SessionPaneRecord) => SessionPaneRecord, sessionId?: string) => void
  closePaneFor: (kind: SidePaneKind) => void
  focusPane: (kind: SidePaneKind) => void
  settingsSection: SettingsSectionId | null
  customizeOpen: boolean
  shellRightPanelContentValue: ComponentProps<typeof RightPanelContentContext.Provider>['value']
  shellFilePathContextValue: ComponentProps<typeof FilePathContext.Provider>['value']
  shellModUi: ComponentProps<typeof ModsPane>['modUi']
  handleCloseModTab: ComponentProps<typeof ModsPane>['onCloseTab']
  activeSideChats: SideChatProps['items']
  shownSideChatId: string | null
  handleSelectSideChat: SideChatProps['onSelect']
  canAddSideChat: boolean
  handleAddSideChat: NonNullable<SideChatProps['onAdd']>
  handleDetachSideChat: SideChatProps['onDetach']
  handleArchiveSideChat: SideChatProps['onArchive']
  activeSessionId: string
  renderSessionThread: (sessionId: string, inPane: boolean) => ReactNode
  runtimeConnection: ComponentProps<typeof TerminalPane>['runtimeConnection']
  openTerminalLink: (url: string) => void
  activePaneRecord: SessionPaneRecord
  handleActivateFileTab: FilesProps['onActivate']
  handleCloseFileTab: FilesProps['onCloseTab']
  handleCloseFileTabs: FilesProps['onCloseTabs']
  attachPathToComposer: FilesProps['onAttach']
  runtimeCapabilities: CapabilityQuery
  handleRevealProjectFolder: NonNullable<FilesProps['onShowInFolder']>
  dirtyFilePaths: FilesProps['protectedPaths']
  handleFileDirtyChange: FilesProps['onDirtyChange']
  rightPanelFileReveal: FilesProps['fileReveal']
  readFileText: FilesProps['readFileText'] & PaneBodyProps['readFileText']
  writeFileText: FilesProps['writeFileText']
  runningSessionIds: ReadonlySet<string>
  openFileFromTree: FilesProps['onOpen']
  openFileTabInWindow: NonNullable<FilesProps['onOpenInWindow']>
  listDir: FilesProps['listDir']
  startFileSearch: FilesProps['search']
  filesTreeRoots: FilesProps['roots']
  activeSessionTabs: BrowserTabStripProps['tabs']
  activateBrowserTab: BrowserTabStripProps['onActivate']
  closeBrowserTab: BrowserTabStripProps['onClose']
  activeNexusTabCount: number
  t: TranslateFn
  navigateBrowserTab: ComponentProps<typeof BrowserAddressBar>['onNavigate']
  shellChannel: ComponentProps<typeof WebviewArea>['shell'] | undefined
  openBrowserTab: (sessionId: string) => void
  activePlanEntry: PaneBodyProps['planEntry']
  resolveActivePlan: PaneBodyProps['onPlanResolve']
  activeSessionSubAgentRows: PaneBodyProps['taskRows']
  backgroundTaskFocusSessionId: PaneBodyProps['taskFocusSessionId']
  backgroundTaskListRequest: PaneBodyProps['taskListRequest']
  handleTaskFocusConsumed: PaneBodyProps['onTaskFocusConsumed']
  handleStopBackgroundTask: PaneBodyProps['onTaskStop']
  handleResumeSubAgent: PaneBodyProps['onTaskResume']
  handleLoadSubAgentTranscript: PaneBodyProps['loadTaskTranscript']
  rightPanelDiffTarget: PaneBodyProps['diffTarget']
  rightPanelSkillTarget: PaneBodyProps['skillTarget']
  activeLoadedSkills: PaneBodyProps['loadedSkills']
  handleSelectSkill: PaneBodyProps['onSelectSkill']
  loadToolCallDetail: PaneBodyProps['loadToolCallDetail']
  loadBundledSkillBody: PaneBodyProps['loadBundledSkillBody']
  activeState: BrowserRuntimeClientState
  loadTurnDiffDetail: PaneBodyProps['loadTurnDiffDetail']
  requestTurnDiffHistory: PaneBodyProps['requestTurnDiffHistory']
  loadAgentTurnDiffDetail: PaneBodyProps['loadAgentTurnDiffDetail']
  openFile: PaneBodyProps['onOpenFile']
}

// One pane's frame and body (F-9). The panes render outside the thread
// providers, so each brings the handles the deep cards need.
// A plain render function, not a component: the pane area calls it inline, so
// the element tree is the one the shell would build itself.
export function renderShellSidePane(inputs: ShellSidePaneInputs, kind: SidePaneKind): ReactNode {
  const {
    sidePaneName, paneMaximized, updatePaneRecord, closePaneFor, focusPane, settingsSection,
    customizeOpen, shellRightPanelContentValue, shellFilePathContextValue, shellModUi,
    handleCloseModTab, activeSideChats, shownSideChatId, handleSelectSideChat, canAddSideChat,
    handleAddSideChat, handleDetachSideChat, handleArchiveSideChat, activeSessionId,
    renderSessionThread, runtimeConnection, openTerminalLink, activePaneRecord,
    handleActivateFileTab, handleCloseFileTab, handleCloseFileTabs, attachPathToComposer,
    runtimeCapabilities, handleRevealProjectFolder, dirtyFilePaths, handleFileDirtyChange,
    rightPanelFileReveal, readFileText, writeFileText, runningSessionIds, openFileFromTree,
    openFileTabInWindow, listDir, startFileSearch, filesTreeRoots, activeSessionTabs,
    activateBrowserTab, closeBrowserTab, activeNexusTabCount, t, navigateBrowserTab,
    shellChannel, openBrowserTab, activePlanEntry, resolveActivePlan, activeSessionSubAgentRows,
    backgroundTaskFocusSessionId, backgroundTaskListRequest, handleTaskFocusConsumed,
    handleStopBackgroundTask, handleResumeSubAgent, handleLoadSubAgentTranscript,
    rightPanelDiffTarget, rightPanelSkillTarget, activeLoadedSkills, handleSelectSkill,
    loadToolCallDetail, loadBundledSkillBody, activeState, loadTurnDiffDetail,
    requestTurnDiffHistory, loadAgentTurnDiffDetail, openFile,
  } = inputs
  const name = sidePaneName(kind)
  const frame = (title: ReactNode, body: ReactNode, actions?: ReactNode) => (
    <PaneFrame
      kind={kind}
      name={name}
      title={title}
      actions={actions}
      maximized={paneMaximized === kind}
      immersiveWhenMaximized={IMMERSIVE_PANES.has(kind)}
      onToggleMaximized={() =>
        updatePaneRecord(r => setMaximized(r, r.maximized === kind ? null : kind))
      }
      onClose={() => closePaneFor(kind)}
      onFocus={() => focusPane(kind)}
      className="h-full"
    >
      <SessionAreaVisibleContext.Provider value={!settingsSection && !customizeOpen}>
      <RightPanelContentContext.Provider value={shellRightPanelContentValue}>
      <FilePathContext.Provider value={shellFilePathContextValue}>
      <Suspense fallback={null}>{body}</Suspense>
      </FilePathContext.Provider>
      </RightPanelContentContext.Provider>
      </SessionAreaVisibleContext.Provider>
    </PaneFrame>
  )
  if (kind === 'mods') {
    return (
      <ModsPane
        modUi={shellModUi}
        onCloseTab={handleCloseModTab}
        frame={({ title, body }) => frame(title, body)}
      />
    )
  }
  if (kind === 'sidechat') {
    return (
      <SideChatPane
        items={activeSideChats}
        selectedId={shownSideChatId}
        onSelect={handleSelectSideChat}
        onAdd={canAddSideChat ? handleAddSideChat : undefined}
        onDetach={handleDetachSideChat}
        onArchive={handleArchiveSideChat}
        frame={({ title, actions, body }) => frame(title, body, actions)}
      >
        {shownSideChatId && shownSideChatId !== activeSessionId
          ? renderSessionThread(shownSideChatId, true)
          : null}
      </SideChatPane>
    )
  }
  if (kind === 'terminal') {
    return (
      <Suspense fallback={null}>
        <TerminalPane
          runtimeConnection={runtimeConnection}
          sessionId={activeSessionId}
          openLink={openTerminalLink}
          frame={({ title, actions, body }) => frame(title, body, actions)}
        />
      </Suspense>
    )
  }
  if (kind === 'files') {
    return (
      <Suspense fallback={null}>
        <FilesPane
          state={activePaneRecord.files ?? EMPTY_FILES_PANE}
          sessionKey={activeSessionId}
          onActivate={handleActivateFileTab}
          onCloseTab={handleCloseFileTab}
          onCloseTabs={handleCloseFileTabs}
          onAttach={attachPathToComposer}
          onShowInFolder={
            runtimeCapabilities.can('ui', 'revealProjectFolder') ? handleRevealProjectFolder : undefined
          }
          protectedPaths={dirtyFilePaths}
          onDirtyChange={handleFileDirtyChange}
          fileReveal={rightPanelFileReveal}
          readFileText={readFileText}
          writeFileText={writeFileText}
          // Lock the editor while THIS session's turn is running (the agent
          // may be writing the same files); editing re-enables when it ends.
          editingLocked={runningSessionIds.has(activeSessionId)}
          onOpen={openFileFromTree}
          onOpenInWindow={runtimeCapabilities.can('fsx', 'openInWindow') ? openFileTabInWindow : undefined}
          listDir={listDir}
          search={startFileSearch}
          roots={filesTreeRoots}
          frame={({ title, actions, body }) => frame(title, body, actions)}
        />
      </Suspense>
    )
  }
  const label = (
    <>
      <span className="min-w-0 truncate">{name}</span>
    </>
  )
  if (kind === 'browser') {
    // The title slot is the session's tab strip, the count beside it; the
    // body stacks the address field over the native view's placeholder.
    const activeTab = activeSessionTabs.find(tab => tab.active) ?? null
    return frame(
      <>
        {label}
        <BrowserTabStrip
          tabs={activeSessionTabs}
          onActivate={activateBrowserTab}
          onClose={closeBrowserTab}
        />
        <span
          data-testid="pane-browser-tab-count"
          className="min-w-0 shrink-0 truncate font-normal text-muted-foreground"
        >
          {activeNexusTabCount === 1
            ? t('pane.browser.oneTab')
            : t('pane.browser.tabs', { count: String(activeNexusTabCount) })}
        </span>
      </>,
      <div className="flex h-full min-h-0 flex-col">
        <BrowserAddressBar tab={activeTab} onNavigate={navigateBrowserTab} />
        <WebviewArea active={!customizeOpen} shell={shellChannel ?? null} />
      </div>,
      <Button
        type="button"
        variant="ghost"
        size="icon-xs"
        className="size-7"
        data-testid="pane-browser-new-tab"
        aria-label={t('pane.browser.newTab')}
        title={t('pane.browser.newTab')}
        onClick={() => {
          if (activeSessionId) openBrowserTab(activeSessionId)
        }}
      >
        <PlusIcon className="size-3.5" />
      </Button>,
    )
  }
  return frame(
    label,
    <SidePaneBody
      kind={kind}
      planEntry={activePlanEntry}
      onPlanResolve={resolveActivePlan}
      onClosePlan={() => closePaneFor('plan')}
      taskRows={activeSessionSubAgentRows}
      taskFocusSessionId={backgroundTaskFocusSessionId}
      taskListRequest={backgroundTaskListRequest}
      onTaskFocusConsumed={handleTaskFocusConsumed}
      onCloseTasks={() => closePaneFor('tasks')}
      onTaskStop={handleStopBackgroundTask}
      onTaskResume={handleResumeSubAgent}
      loadTaskTranscript={handleLoadSubAgentTranscript}
      diffTarget={rightPanelDiffTarget}
      skillTarget={rightPanelSkillTarget}
      loadedSkills={activeLoadedSkills}
      onSelectSkill={handleSelectSkill}
      loadToolCallDetail={loadToolCallDetail}
      loadBundledSkillBody={loadBundledSkillBody}
      readFileText={readFileText}
      turnDiffHistory={activeState.turnDiffHistory ?? null}
      loadTurnDiffDetail={loadTurnDiffDetail}
      requestTurnDiffHistory={requestTurnDiffHistory}
      agentChanges={activeState.agentChanges}
      loadAgentTurnDiffDetail={loadAgentTurnDiffDetail}
      onOpenFile={openFile}
      activeSessionId={activeSessionId}
    />,
    kind === 'a2ui' ? <A2uiPaneActionsSlot /> : undefined,
  )
}
