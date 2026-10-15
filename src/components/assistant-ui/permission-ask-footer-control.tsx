import { useState } from 'react'
import { ShieldAlertIcon } from 'lucide-react'
import { useT } from '@/browser/webview/i18n'
import {
  usePermissionAsk,
  type ApprovalPick,
} from './permission-ask-context'
import { ModNoticeLine } from './mod-ui'

/**
 * Permission ask control in the composer footer, for THIS session's pending permission
 * only. The `data-slot` names (`permission-banner`, `permission-*` buttons) stay stable
 * because the e2e specs key on them.
 */
export function PermissionAskFooterControl() {
  const t = useT()
  const { pending, resolve, canAllowFolder } = usePermissionAsk()
  const [busy, setBusy] = useState(false)
  // Tab-to-amend feedback (spec 5-10-3): free-text the user types to steer
  // the model alongside their allow/deny decision. Empty = no feedback.
  const [feedback, setFeedback] = useState('')

  if (!pending) return null
  const { request } = pending

  const act = async (decision: ApprovalPick) => {
    if (busy) return
    setBusy(true)
    try {
      await resolve?.(decision, feedback.trim() || undefined)
      setFeedback('')
    } finally {
      setBusy(false)
    }
  }

  // Split the translated template on `{tool}` so the tool name keeps its styled
  // <code> box while the surrounding words honor the locale's word order.
  const [allowBefore, allowAfter] = t('permission.allowToRun').split('{tool}')

  return (
    <div
      data-slot="permission-banner"
      data-tool-name={request.toolName}
      // The session is HALTED on this control, so it is what an attention
      // reveal scrolls to and focuses (see webview/attentionSource.ts).
      data-attention-source="permission"
      // Full width so its edges align with the composer, like the plan-approval control;
      // amber/warning scheme.
      className="flex w-full flex-col gap-2 rounded-lg border border-warning/40 bg-warning/10 px-3 py-1.5 text-sm"
    >
      <div className="flex items-center gap-2">
        <ShieldAlertIcon
          className="size-4 shrink-0 text-warning"
          aria-hidden="true"
        />
        <span className="font-medium text-warning-emphasis">
          {allowBefore}
          <code className="rounded bg-warning/20 px-1">
            {request.toolName}
          </code>
          {allowAfter}
        </span>
      </div>
      {/* A mod's line under this dialog (F-25 `$.ui.notice`). */}
      <ModNoticeLine toolUseId={pending.toolCallId} />
      {request.summary ? (
        <pre className="max-h-32 overflow-auto whitespace-pre-wrap rounded-md bg-background/70 px-3 py-2 font-mono text-xs">
          {request.summary}
        </pre>
      ) : null}
      {/* Tab-to-amend feedback (spec 5-10-3): optional note to steer the
          model. Sent alongside whichever allow/deny button the user clicks. */}
      <input
        type="text"
        data-slot="permission-feedback"
        value={feedback}
        disabled={busy}
        onChange={e => setFeedback(e.target.value)}
        placeholder={t('permission.feedbackPlaceholder')}
        className="w-full rounded-md border bg-background px-2 py-1 text-xs outline-none focus:ring-1 focus:ring-warning disabled:opacity-50"
      />
      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          data-slot="permission-deny"
          disabled={busy}
          onClick={() => act('deny')}
          className="rounded-md border px-3 py-1 text-xs font-medium hover:bg-muted disabled:opacity-50"
        >
          {t('permission.deny')}
        </button>
        {canAllowFolder ? (
          <button
            type="button"
            data-slot="permission-allow-folder"
            disabled={busy}
            onClick={() => act('allow-folder')}
            className="rounded-md border px-3 py-1 text-xs font-medium hover:bg-muted disabled:opacity-50"
          >
            {t('permission.allowFolder')}
          </button>
        ) : null}
        <button
          type="button"
          data-slot="permission-allow-once"
          disabled={busy}
          onClick={() => act('allow-once')}
          className="rounded-md border px-3 py-1 text-xs font-medium hover:bg-muted disabled:opacity-50"
        >
          {t('permission.allowOnce')}
        </button>
        <button
          type="button"
          data-slot="permission-allow-always"
          disabled={busy}
          onClick={() => act('allow-always')}
          className="rounded-md bg-primary px-3 py-1 text-xs font-medium text-primary-foreground hover:opacity-90 disabled:opacity-50"
        >
          {t('permission.alwaysAllow')}
        </button>
      </div>
    </div>
  )
}
