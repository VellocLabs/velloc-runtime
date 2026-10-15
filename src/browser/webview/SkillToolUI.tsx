import { useState } from 'react'
import { makeAssistantToolUI } from '@assistant-ui/react'
import { SKILL_TOOL_NAME } from '@/prompting/skillToolName'
import {
  ToolFallbackArgs,
  ToolFallbackContent,
  ToolFallbackError,
  ToolFallbackRoot,
  ToolFallbackTrigger,
} from '@/components/assistant-ui/tool-fallback'
import { PanelJumpChevron } from '@/components/assistant-ui/panel-jump-chevron'
import { useRightPanelContent } from '@/components/assistant-ui/right-panel-content-context'
import { readSkillBodyRef } from './assistantUiAdapterParts'
import { useT } from './i18n'

type SkillArgs = { skill?: string; args?: string }

/**
 * The conversation card for a skill invocation (the `Skill` tool call, or `/skill` via
 * `skillInvocationThreadMessage`). ">>" opens the SKILL.md in the Skill tab once the body
 * ref (`readSkillBodyRef`) lands; expand shows the args, plus the error for a failed call.
 */
export const SkillToolUI = makeAssistantToolUI<SkillArgs, unknown>({
  toolName: SKILL_TOOL_NAME,
  render: function SkillUI({ args, result, status, isError }) {
    const t = useT()
    const { openSkill } = useRightPanelContent()
    const [open, setOpen] = useState(false)
    const ref = readSkillBodyRef(result)
    const name = ref?.name ?? args?.skill ?? ''
    const isRunning = status?.type === 'running'
    // Two failure shapes, matching the Plan surface's `planStatus === 'failed'`:
    //   - a HARD error surfaces as `incomplete` with any reason but `cancelled`
    //     (a user/system stop);
    //   - a SOFT failure runs to `complete` but the result envelope reports
    //     `isError` (`ok:false`).
    // Either drops the body-less one-liner for an expandable card that shows the
    // args (and, for a hard error, the error reason).
    const isFailed =
      (status?.type === 'incomplete' && status.reason !== 'cancelled') ||
      (status?.type === 'complete' && isError === true)
    const canOpen =
      !!openSkill && !!ref && (ref.detailId !== null || ref.inlineBody !== null)

    const openInPanel = () => {
      if (!canOpen || !ref) return
      openSkill!({
        name: ref.name,
        ...(ref.args !== undefined ? { args: ref.args } : {}),
        detailId: ref.detailId,
        inlineBody: ref.inlineBody,
      })
    }

    const label = name
      ? isRunning
        ? t('skill.cardLabelLoading', { name })
        : t('skill.cardLabel', { name })
      : t('skill.cardLabelUnnamed')

    const jumpAction = canOpen ? (
      <PanelJumpChevron
        onOpen={openInPanel}
        label={t('skill.viewInPanel')}
        dataTestId="skill-view-in-panel"
      />
    ) : undefined

    if (isFailed) {
      return (
        <div className="my-2" data-testid="skill-card">
          <ToolFallbackRoot open={open} onOpenChange={setOpen}>
            <ToolFallbackTrigger
              toolName={SKILL_TOOL_NAME}
              args={undefined}
              labelOverride={label}
              status={status}
              isError={isError ?? true}
              trailingAction={jumpAction}
            />
            <ToolFallbackContent>
              <ToolFallbackArgs value={args} />
              <ToolFallbackError status={status} />
            </ToolFallbackContent>
          </ToolFallbackRoot>
        </div>
      )
    }

    return (
      <div className="my-2" data-testid="skill-card">
        <ToolFallbackRoot open={open} onOpenChange={setOpen}>
          <ToolFallbackTrigger
            toolName={SKILL_TOOL_NAME}
            args={undefined}
            labelOverride={label}
            status={isRunning ? status : { type: 'complete' }}
            trailingAction={jumpAction}
          />
          <ToolFallbackContent>
            <ToolFallbackArgs value={args} />
          </ToolFallbackContent>
        </ToolFallbackRoot>
      </div>
    )
  },
})
