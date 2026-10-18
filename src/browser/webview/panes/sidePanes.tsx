import type { ReactElement } from 'react'

import type { PlanPanelEntry } from '@/components/assistant-ui/plan-panel-context'
import type {
  RightPanelDiffTarget,
  RightPanelFileTarget,
  RightPanelSkillTarget,
} from '@/components/assistant-ui/right-panel-content-context'
import type { BrowserToolCallDetailRecord } from '@/utils/toolCallDetails'
import type { BundledSkillBodyResult } from '@/skillLibrary/builtinSkillBody'
import type { LoadTurnDiffDetail } from '@/components/assistant-ui/TurnDiffSummary'
import type { TurnDiffMeta } from '@/utils/turnDiffs'

import type { NexusTaskDetail, NexusTaskSummaryRow } from '../../bridge/protocol/ui'
import { BackgroundTasksDrawer } from '../BackgroundTasksDrawer'
import { DiffPanel } from '../DiffPanel'
import { useT } from '../i18n'
import type { SidePaneKind } from '../layout/paneLayout'
import { PANE_LABEL_KEY } from './paneKinds'
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
  skillTarget?: RightPanelSkillTarget | null
  loadedSkills?: readonly SkillPanelListRow[]
  onSelectSkill?: (skill: SkillPanelListRow) => void
  loadToolCallDetail?: (toolCallId: string) => Promise<BrowserToolCallDetailRecord | null>
  loadBundledSkillBody?: (name: string) => Promise<BundledSkillBodyResult | null>
  readFileText?: (path: string) => Promise<string | null>
  turnDiffHistory?: TurnDiffMeta[] | null
  loadTurnDiffDetail?: LoadTurnDiffDetail
  requestTurnDiffHistory?: () => void
  onOpenFile?: (target: RightPanelFileTarget) => void
}

function EmptyState({ label }: { label: string }): ReactElement {
  return (
    <div className="flex h-full items-center justify-center px-4 text-center text-body text-muted-foreground">
      {label}
    </div>
  )
}

/**
 * One pane's body by kind; the Files and Plugins panes draw their own
 * (`FilesPane`, `ModsPane`) and the browser pane's body is the native view's
 * placeholder (`WebviewArea`).
 */
export function SidePaneBody({
  kind,
  ...props
}: SidePaneContentProps & { kind: Exclude<SidePaneKind, 'files' | 'browser' | 'mods'> }): ReactElement {
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
          turnDiffHistory={props.turnDiffHistory}
          loadTurnDiffDetail={props.loadTurnDiffDetail}
          requestTurnDiffHistory={props.requestTurnDiffHistory}
          onOpenFile={props.onOpenFile}
        />
      )
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
    case 'terminal':
      return <EmptyState label={t(PANE_LABEL_KEY[kind])} />
  }
}
