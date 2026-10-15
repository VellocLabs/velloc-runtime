import { useState } from 'react'
import { ChevronRightIcon, ClipboardListIcon } from 'lucide-react'
import { useT } from '@/browser/webview/i18n'
import { usePlanPanel } from './plan-panel-context'

/**
 * Plan-approval control in the composer footer: status + "View plan" (opens
 * PlanDetailsPanel), then feedback input + Keep planning / Approve. Reads THIS
 * session's pending approval only; a background session's plan must not surface here.
 */
export function PlanApprovalFooterControl() {
  const t = useT()
  const { pending, resolve, openPanel } = usePlanPanel()
  const [feedback, setFeedback] = useState('')
  const [busy, setBusy] = useState(false)

  if (!pending) return null

  const act = async (decision: 'approve' | 'reject') => {
    if (busy) return
    setBusy(true)
    try {
      await resolve?.(decision, feedback)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div
      data-slot="plan-approval-control"
      // Halted on the user: an attention reveal targets this (attentionSource.ts).
      data-attention-source="plan-approval"
      data-tool-name={pending.request.toolName}
      // Full width (w-full, no mx) so its edges align with the composer below —
      // same horizontal extent as the other footer bars. Keep the sky style +
      // color; the border SHAPE uses the standard rounded-lg (like the other
      // cards/panels), NOT the composer's big pill radius (--composer-radius).
      className="flex w-full flex-col gap-2 rounded-lg border border-info/40 bg-info/10 px-3 py-1.5 text-sm"
    >
      <div className="flex items-center gap-2">
        <ClipboardListIcon
          className="size-4 shrink-0 text-info"
          aria-hidden="true"
        />
        <span className="font-medium text-info-emphasis">
          {t('planApproval.title')}
        </span>
        <span className="flex-1" />
        <button
          type="button"
          data-slot="plan-approval-view"
          onClick={() => openPanel?.()}
          className="flex items-center gap-0.5 rounded-md px-2 py-0.5 text-xs text-info hover:bg-info/15"
        >
          {t('planApproval.viewPlan')}
          <ChevronRightIcon className="size-3.5" aria-hidden="true" />
        </button>
      </div>
      <div className="flex items-center gap-2">
        <input
          type="text"
          data-slot="plan-approval-feedback"
          value={feedback}
          onChange={e => setFeedback(e.target.value)}
          placeholder={t('planApproval.feedbackPlaceholder')}
          disabled={busy}
          className="min-w-0 flex-1 rounded-md border bg-background px-2 py-1 text-xs outline-none focus:border-ring disabled:opacity-50"
        />
        <button
          type="button"
          data-slot="plan-approval-keep-planning"
          disabled={busy}
          onClick={() => act('reject')}
          className="shrink-0 rounded-md border px-2.5 py-1 text-xs font-medium hover:bg-muted disabled:opacity-50"
        >
          {t('planApproval.keepPlanning')}
        </button>
        <button
          type="button"
          data-slot="plan-approval-approve"
          disabled={busy}
          onClick={() => act('approve')}
          className="shrink-0 rounded-md bg-primary px-3 py-1 text-xs font-medium text-primary-foreground hover:opacity-90 disabled:opacity-50"
        >
          {t('planApproval.approve')}
        </button>
      </div>
    </div>
  )
}
