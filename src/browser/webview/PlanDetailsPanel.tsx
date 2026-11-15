import { useEffect } from 'react'
import type { PlanPanelEntry } from '@/components/assistant-ui/plan-panel-context'
import { StaticMarkdown } from '@/components/assistant-ui/static-markdown'
import { useT } from './i18n'
import { useSessionAreaVisible } from './sessionAreaVisibility'

/**
 * Right-side pane showing the FULL plan for the active session's pending
 * ExitPlanMode approval (F-13). Display only: Reject / Revise / Accept live on
 * the plan card that stands in for the composer. Renders chrome-free — the only
 * mount is inside RightPanel, which owns the width/border and the tab strip
 * (with its own close). Esc still closes via `onClose`.
 */
export function PlanDetailsPanel({
  entry,
  onClose,
}: {
  entry: PlanPanelEntry
  onClose: () => void
}) {
  const t = useT()

  // Esc closes — only while the panel is on screen. The shell keeps the
  // session area mounted under Settings, so this listener stayed live there
  // and an Escape meant for Settings closed a panel the user could not see.
  const sessionAreaVisible = useSessionAreaVisible()
  useEffect(() => {
    if (!sessionAreaVisible) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [onClose, sessionAreaVisible])

  const { planText } = entry.request

  return (
    <div
      data-testid="plan-details-panel"
      aria-label={t('planApproval.panelTitle')}
      className="flex h-full min-h-0 flex-col bg-background"
    >
      <div className="min-h-0 flex-1 overflow-auto px-3 py-2">
        {planText ? <StaticMarkdown content={planText} /> : null}
      </div>
    </div>
  )
}
