import { useEffect, useState } from 'react'
import type { PlanPanelEntry } from '@/components/assistant-ui/plan-panel-context'
import { StaticMarkdown } from '@/components/assistant-ui/static-markdown'
import { useT } from './i18n'
import { useSessionAreaVisible } from './sessionAreaVisibility'

/**
 * Right-side panel showing the FULL plan for the active session's pending
 * ExitPlanMode approval — opened from the footer plan control's "View plan".
 * Always renders chrome-free (body + approve/keep-planning actions only): the
 * only mount is inside RightPanel, which owns the outer width/border + the tab
 * strip (with its own close). Esc still closes via `onClose`.
 */
export function PlanDetailsPanel({
  entry,
  onResolve,
  onClose,
}: {
  entry: PlanPanelEntry
  onResolve: (
    decision: 'approve' | 'reject',
    feedback?: string,
  ) => void | Promise<void>
  onClose: () => void
}) {
  const t = useT()
  const [feedback, setFeedback] = useState('')
  const [busy, setBusy] = useState(false)

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

  const act = async (decision: 'approve' | 'reject') => {
    if (busy) return
    setBusy(true)
    try {
      await onResolve(decision, feedback)
      onClose()
    } finally {
      setBusy(false)
    }
  }

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

      <div className="flex flex-col gap-2 border-t px-3 py-2">
        <textarea
          data-slot="plan-panel-feedback"
          value={feedback}
          onChange={e => setFeedback(e.target.value)}
          placeholder={t('planApproval.feedbackPlaceholder')}
          disabled={busy}
          rows={2}
          className="w-full resize-y rounded-md border bg-background px-2 py-1 text-body disabled:opacity-50"
        />
        <div className="flex gap-2">
          <button
            type="button"
            data-slot="plan-panel-approve"
            disabled={busy}
            onClick={() => act('approve')}
            className="flex-1 rounded-md bg-primary px-3 py-1.5 text-body font-medium text-primary-foreground hover:opacity-90 disabled:opacity-50"
          >
            {t('planApproval.approve')}
          </button>
          <button
            type="button"
            data-slot="plan-panel-keep-planning"
            disabled={busy}
            onClick={() => act('reject')}
            className="rounded-md border px-3 py-1.5 text-body font-medium hover:bg-muted disabled:opacity-50"
          >
            {t('planApproval.keepPlanning')}
          </button>
        </div>
      </div>
    </div>
  )
}
