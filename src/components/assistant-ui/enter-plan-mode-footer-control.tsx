import { useState } from 'react'
import { MapIcon } from 'lucide-react'
import { useT } from '@/browser/webview/i18n'
import { useEnterPlanApproval } from './enter-plan-approval-context'

/**
 * Composer-footer control for the EnterPlanMode permission request, read from
 * EnterPlanApprovalContext. Approve lets EnterPlanMode's call() flip the mode; reject
 * sends a declined tool result. Wording uses the i18n `{product}` token, never a vendor.
 */
export function EnterPlanModeFooterControl() {
  const t = useT()
  const { pending, resolve } = useEnterPlanApproval()
  const [busy, setBusy] = useState(false)

  if (!pending) return null

  const act = async (decision: 'approve' | 'reject') => {
    if (busy) return
    setBusy(true)
    try {
      await resolve?.(decision)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div
      data-slot="enter-plan-mode-control"
      // Halted on the user: an attention reveal targets this (attentionSource.ts).
      data-attention-source="enter-plan-mode"
      data-tool-name="EnterPlanMode"
      className="flex w-full flex-col gap-2 rounded-lg border border-info/40 bg-info/10 px-3 py-1.5 text-sm"
    >
      <div className="flex items-center gap-2">
        <MapIcon
          className="size-4 shrink-0 text-info"
          aria-hidden="true"
        />
        <span className="font-medium text-info-emphasis">
          {t('planEnter.title')}
        </span>
      </div>
      <div className="text-xs text-info-emphasis/90">
        {t('planEnter.body')}
      </div>
      <div className="flex items-center justify-end gap-2">
        <button
          type="button"
          data-slot="enter-plan-mode-reject"
          disabled={busy}
          onClick={() => act('reject')}
          className="shrink-0 rounded-md border px-2.5 py-1 text-xs font-medium hover:bg-muted disabled:opacity-50"
        >
          {t('planEnter.reject')}
        </button>
        <button
          type="button"
          data-slot="enter-plan-mode-approve"
          disabled={busy}
          onClick={() => act('approve')}
          className="shrink-0 rounded-md bg-primary px-3 py-1 text-xs font-medium text-primary-foreground hover:opacity-90 disabled:opacity-50"
        >
          {t('planEnter.approve')}
        </button>
      </div>
    </div>
  )
}
