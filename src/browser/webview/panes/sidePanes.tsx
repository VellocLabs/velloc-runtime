import type { ReactElement } from 'react'

import type { PlanPanelEntry } from '@/components/assistant-ui/plan-panel-context'
import type {
  RightPanelDiffTarget,
  RightPanelFileTarget,
  RightPanelSkillTarget,
} from '@/components/assistant-ui/right-panel-content-context'
import type { BrowserToolCallDetailRecord } from '@/utils/toolCallDetails'
import type { BundledSkillBodyResult } from '@/skillLibrary/builtinSkillBody'
import type { LoadAgentTurnDiffDetail, LoadTurnDiffDetail } from '@/components/assistant-ui/TurnDiffSummary'
import type { TurnDiffMeta } from '@/utils/turnDiffs'

import type { NexusAgentChangeSection, NexusTaskDetail, NexusTaskSummaryRow } from '../../bridge/protocol/ui'
import { BackgroundTasksDrawer } from '../BackgroundTasksDrawer'
import { A2uiPaneSlot } from '../a2ui/A2uiPaneSlot'
import { DiffPanel } from '../DiffPanel'
import { useT } from '../i18n'
import type { SidePaneKind } from '../layout/paneLayout'
import { PlanDetailsPanel } from '../PlanDetailsPanel'
import type { SkillPanelListRow } from '../sessionSkills'
import { SkillPanel } from '../SkillPanel'

/** The content the shell threads into the pane bodies (F-9). */
export type SidePaneContentProps = {
  planEntry: PlanPanelEntry | null
  onPlanResolve: (decision: 'approve' | 'reject', feedback?: string) => void | Promise<void>
  onClosePlan: () => void
  taskRows: readonly NexusTaskSummaryRow[]
  taskFocusSessionId?: string | null
  onTaskFocusConsumed?: () => void
  taskListRequest?: number
  /** Escape at the Tasks list closes the Tasks pane. */
  onCloseTasks: () => void
  onTaskStop: (subAgentSessionId: string) => void
  onTaskResume: (subAgentSessionId: string, prompt: string) => void
  loadTaskTranscript: (subAgentSessionId: string) => Promise<NexusTaskDetail | null>
  diffTarget?: RightPanelDiffTarget | null
  /** The person went back from the shown file diff to the history. */
  onDismissDiffTarget?: () => void
  skillTarget?: RightPanelSkillTarget | null
  loadedSkills?: readonly SkillPanelListRow[]
  onSelectSkill?: (skill: SkillPanelListRow) => void
  loadToolCallDetail?: (toolCallId: string) => Promise<BrowserToolCallDetailRecord | null>
  loadBundledSkillBody?: (name: string) => Promise<BundledSkillBodyResult | null>
  readFileText?: (path: string) => Promise<string | null>
  turnDiffHistory?: TurnDiffMeta[] | null
  loadTurnDiffDetail?: LoadTurnDiffDetail
  requestTurnDiffHistory?: () => void
  agentChanges?: readonly NexusAgentChangeSection[]
  loadAgentTurnDiffDetail?: LoadAgentTurnDiffDetail
  onOpenFile?: (target: RightPanelFileTarget) => void
  /**
   * The foreground session: the A2UI pane shows its surfaces, and every other
   * body's own view state belongs to it.
   */
  activeSessionId?: string | null
}

function EmptyState({ label }: { label: string }): ReactElement {
  return (
    <div className="flex h-full items-center justify-center px-4 text-center text-body text-muted-foreground">
      {label}
    </div>
  )
}

type SidePaneBodyKind = Exclude<SidePaneKind, 'files' | 'browser' | 'mods' | 'terminal' | 'sidechat'>
type SidePaneBodyProps = SidePaneContentProps & { kind: SidePaneBodyKind }

/**
 * One pane's body by kind; the Files, Plugins and Terminal panes draw their
 * own (`FilesPane`, `ModsPane`, `TerminalPane`) and the browser pane's body
 * is the native view's placeholder (`WebviewArea`).
 *
 * Contract: a body's own view state (the open detail, a pending load)
 * belongs to the session it was opened in. Another session becoming the
 * foreground one starts the body fresh; none of that state is carried
 * across. The Plan feedback draft is the plan's, not the body's: it lives in
 * `planFeedbackDrafts` under the plan's tool call id. The A2UI body holds no
 * such state and stays mounted, so the element its session draws into is
 * kept.
 */
export function SidePaneBody(props: SidePaneBodyProps): ReactElement {
  const scope = props.kind === 'a2ui' ? 'a2ui' : `${props.kind}:${props.activeSessionId ?? ''}`
  return <SessionPaneBody key={scope} {...props} />
}

function SessionPaneBody({ kind, ...props }: SidePaneBodyProps): ReactElement {
  const t = useT()
  switch (kind) {
    case 'tasks':
      return (
        <BackgroundTasksDrawer
          rows={props.taskRows}
          focusSessionId={props.taskFocusSessionId}
          onFocusConsumed={props.onTaskFocusConsumed}
          listRequest={props.taskListRequest}
          onClose={props.onCloseTasks}
          onStop={props.onTaskStop}
          onResume={props.onTaskResume}
          loadTranscript={props.loadTaskTranscript}
        />
      )
    case 'plan':
      return props.planEntry ? (
        <PlanDetailsPanel
          key={props.planEntry.toolCallId}
          entry={props.planEntry}
          onResolve={props.onPlanResolve}
          onClose={props.onClosePlan}
        />
      ) : (
        <EmptyState label={t('pane.noActivePlan')} />
      )
    case 'diff':
      return (
        <DiffPanel
          target={props.diffTarget ?? null}
          onDismissTarget={props.onDismissDiffTarget}
          turnDiffHistory={props.turnDiffHistory}
          loadTurnDiffDetail={props.loadTurnDiffDetail}
          requestTurnDiffHistory={props.requestTurnDiffHistory}
          agentChanges={props.agentChanges}
          loadAgentTurnDiffDetail={props.loadAgentTurnDiffDetail}
          onOpenFile={props.onOpenFile}
        />
      )
    case 'a2ui':
      return <A2uiPaneSlot sessionId={props.activeSessionId ?? null} />
    case 'skill':
      return (
        <SkillPanel
          target={props.skillTarget ?? null}
          loadedSkills={props.loadedSkills}
          onSelectSkill={props.onSelectSkill}
          readFileText={props.readFileText}
          loadToolCallDetail={props.loadToolCallDetail}
          loadBundledSkillBody={props.loadBundledSkillBody}
        />
      )
  }
}
