import { useContext, useMemo, useState, type ReactNode } from 'react'
import { useT } from '@/browser/webview/i18n'
import { usePlanPanel, type PlanPanelEntry } from './plan-panel-context'
import {
  dropPlanFeedbackDraft,
  readPlanFeedbackDraft,
  writePlanFeedbackDraft,
} from './planFeedbackDrafts'
import { planHeadline } from './planHeadline'
import { StaticMarkdown } from './static-markdown'
import { ComposerCancelStateContext } from './thread-contexts'

/**
 * Plan-approval card that stands in for the composer while THIS session's
 * ExitPlanMode waits (F-13): headline, "Open plan" (the right-side Plan pane),
 * Reject (ends the turn, as Stop does; a plan staged after its turn ended is
 * cancelled by the runtime with no model turn), Revise… (feedback box, then
 * keep planning with it) and Accept. A background session's plan never shows
 * here.
 */
export function PlanApprovalFooterControl() {
  const { pending } = usePlanPanel()
  if (!pending) return null
  // Keyed by plan: the revise state and draft never carry over to the next plan.
  return <PlanApprovalCard key={pending.toolCallId} pending={pending} />
}

function PlanApprovalCard({ pending }: { pending: PlanPanelEntry }) {
  const t = useT()
  const { resolve, openPanel, cancelStaged } = usePlanPanel()
  const { onCancel, isStopping } = useContext(ComposerCancelStateContext)
  const draftKey = pending.toolCallId
  const [feedback, setDraft] = useState(() => readPlanFeedbackDraft(draftKey))
  const [revising, setRevising] = useState(() => feedback !== '')
  const [busy, setBusy] = useState(false)
  // Without a plan pane the plan opens inside this card (F-24).
  const [planShown, setPlanShown] = useState(false)

  const setFeedback = (text: string) => {
    writePlanFeedbackDraft(draftKey, text)
    setDraft(text)
  }

  const act = async (decision: 'approve' | 'reject', text?: string) => {
    if (busy) return
    setBusy(true)
    try {
      await resolve?.(decision, text)
      dropPlanFeedbackDraft(pending.toolCallId)
    } finally {
      setBusy(false)
    }
  }

  const reject = async () => {
    if (busy || isStopping) return
    if (!cancelStaged) {
      dropPlanFeedbackDraft(pending.toolCallId)
      onCancel?.()
      return
    }
    setBusy(true)
    try {
      await cancelStaged()
      dropPlanFeedbackDraft(pending.toolCallId)
    } finally {
      setBusy(false)
    }
  }

  const headline = useMemo(
    () => planHeadline(pending.request.planText),
    [pending.request.planText],
  )
  const disabled = busy || isStopping
  const secondaryButton =
    'shrink-0 rounded-lg bg-muted px-3.5 py-1.5 text-body font-medium hover:bg-muted/70 disabled:opacity-50'
  const primaryButton =
    'shrink-0 rounded-lg bg-primary px-3.5 py-1.5 text-body font-medium text-primary-foreground hover:opacity-90 disabled:opacity-50'

  return (
    <div
      data-slot="plan-approval-control"
      // Halted on the user: an attention reveal targets this (attentionSource.ts).
      data-attention-source="plan-approval"
      data-tool-name={pending.request.toolName}
      data-revising={revising ? 'true' : undefined}
      className="flex w-full flex-col overflow-hidden rounded-xl border bg-background text-body shadow-sm"
    >
      <div className="flex flex-col gap-0.5 bg-muted/60 px-4 py-3">
        <span className="font-medium text-foreground">
          {t('planApproval.title')}
        </span>
        <div className="flex items-start gap-3">
          <span
            data-slot="plan-approval-headline"
            className="min-w-0 flex-1 line-clamp-2 text-muted-foreground"
          >
            {headline}
          </span>
          {(openPanel || pending.request.planText) && (
            <button
              type="button"
              data-slot="plan-approval-view"
              aria-expanded={openPanel ? undefined : planShown}
              onClick={() => (openPanel ? openPanel() : setPlanShown(shown => !shown))}
              className="shrink-0 text-info underline underline-offset-4 hover:opacity-80"
            >
              {!openPanel && planShown ? t('planApproval.hidePlan') : t('planApproval.openPlan')}
            </button>
          )}
        </div>
      </div>
      {!openPanel && planShown && pending.request.planText && (
        <div
          data-slot="plan-approval-inline-plan"
          className="max-h-[40dvh] overflow-y-auto border-b px-4 py-3"
        >
          <StaticMarkdown content={pending.request.planText} />
        </div>
      )}

      {revising ? (
        <div className="flex flex-col gap-3 px-4 py-3">
          <textarea
            data-slot="plan-approval-feedback"
            aria-label={t('planApproval.feedbackPlaceholder')}
            value={feedback}
            onChange={e => setFeedback(e.target.value)}
            onKeyDown={e => {
              if (e.key === 'Escape') {
                // Back to the three choices only: the Plan pane listens for Escape on document and would close with it.
                e.preventDefault()
                e.stopPropagation()
                setRevising(false)
              }
            }}
            placeholder={t('planApproval.feedbackPlaceholder')}
            disabled={disabled}
            rows={3}
            autoFocus
            className="w-full resize-none rounded-lg border border-input bg-muted/40 px-3 py-2 outline-none focus-visible:focus-ring-inset disabled:opacity-50"
          />
          <div className="flex items-center gap-2">
            <button
              type="button"
              data-slot="plan-approval-back"
              disabled={disabled}
              onClick={() => setRevising(false)}
              className={secondaryButton}
            >
              {t('planApproval.back')}
            </button>
            <span className="flex-1" />
            <button
              type="button"
              data-slot="plan-approval-send-revision"
              disabled={disabled}
              onClick={() => act('reject', feedback)}
              className={primaryButton}
            >
              {t('planApproval.sendRevision')}
            </button>
          </div>
        </div>
      ) : (
        <div className="flex flex-wrap items-center gap-2 px-4 py-3">
          <button
            type="button"
            data-slot="plan-approval-reject"
            disabled={disabled || (!cancelStaged && !onCancel)}
            onClick={reject}
            className={secondaryButton}
          >
            {t('planApproval.reject')}
          </button>
          <button
            type="button"
            data-slot="plan-approval-revise"
            disabled={disabled}
            onClick={() => setRevising(true)}
            className={secondaryButton}
          >
            {t('planApproval.revise')}
          </button>
          <span className="flex-1" />
          <button
            type="button"
            data-slot="plan-approval-approve"
            disabled={disabled}
            onClick={() => act('approve')}
            className={primaryButton}
          >
            {t('planApproval.accept')}
          </button>
        </div>
      )}
    </div>
  )
}

/**
 * Wraps the composer: while this session's plan waits, the plan card is the
 * only input, so the composer stays mounted (draft and attachments survive)
 * but is hidden and inert until the plan is resolved (F-13).
 */
export function PlanGatedComposer({ children }: { children: ReactNode }) {
  const { pending } = usePlanPanel()
  return (
    <div
      data-slot="plan-gated-composer"
      data-plan-pending={pending ? 'true' : undefined}
      hidden={pending ? true : undefined}
      inert={pending ? true : undefined}
      className={pending ? 'hidden' : 'contents'}
    >
      {children}
    </div>
  )
}
