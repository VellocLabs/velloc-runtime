import { useState } from 'react'
import { makeAssistantToolUI } from '@assistant-ui/react'
import { CodeIcon } from 'lucide-react'
import { CONTINUE_IN_CODE_TOOL_ID } from '@/toolkit/builtin/continueInCode'
import { useMessageActionsContext } from '@/components/assistant-ui/message-actions-context'
import { Button } from '@/components/ui/button'
import { useT } from './i18n'

type ContinueInCodeArgs = { reason?: string }

/**
 * The card for a chat's `ContinueInCode` offer: the model's reason, "Continue
 * in Code" (opens the thread's folder chooser) and "Stay in chat" (folds the
 * card). Read-only threads get no buttons. (F-17)
 */
export const ContinueInCodeToolUI = makeAssistantToolUI<ContinueInCodeArgs, unknown>({
  toolName: CONTINUE_IN_CODE_TOOL_ID,
  render: function ContinueInCodeCard({ args, toolCallId, status }) {
    const t = useT()
    const { onRequestContinueInCode, continuedInCode } = useMessageActionsContext()
    const [dismissed, setDismissed] = useState(false)
    const continued = continuedInCode?.has(toolCallId) === true
    const reason = typeof args?.reason === 'string' ? args.reason.trim() : ''
    const ready = status?.type !== 'running'

    if (dismissed || continued) {
      return (
        <div className="aui-continue-in-code-card-folded my-2 text-muted-foreground text-xs" data-tool-call-id={toolCallId}>
          {continued ? t('continueInCode.continued') : t('continueInCode.stayed')}
        </div>
      )
    }
    return (
      <div
        className="aui-continue-in-code-card my-2 flex flex-col gap-2 rounded-xl border bg-muted/30 p-3"
        role="group"
        aria-label={t('continueInCode.title')}
        data-tool-call-id={toolCallId}
      >
        <div className="flex items-center gap-2 font-medium text-sm">
          <CodeIcon className="size-4 text-primary" aria-hidden="true" />
          {t('continueInCode.title')}
        </div>
        <p className="text-muted-foreground text-sm">{reason || t('continueInCode.description')}</p>
        {onRequestContinueInCode && (
          <div className="flex gap-2">
            <Button
              size="sm"
              className="aui-continue-in-code-accept"
              disabled={!ready}
              onClick={() => onRequestContinueInCode(toolCallId)}
            >
              {t('continueInCode.accept')}
            </Button>
            <Button
              size="sm"
              variant="ghost"
              className="aui-continue-in-code-dismiss"
              onClick={() => setDismissed(true)}
            >
              {t('continueInCode.dismiss')}
            </Button>
          </div>
        )}
      </div>
    )
  },
})
