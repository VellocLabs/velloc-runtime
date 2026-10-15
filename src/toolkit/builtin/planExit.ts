import type { ToolContract, InputCheck } from '../toolContract'
import type { ToolCallContext } from '../toolCallContext'
import { declareTool } from '../toolContract'
import {
  fsForContext,
  type RuntimeFs,
} from '../../utils/fs/runtimeFs'
import {
  ensurePlanDirectoryExists,
  planDocPath,
  planFileExists,
} from '../../utils/planFiles'
import { buildApprovedPlanMessage } from '../../permissions/planApproval'

export const PLAN_OFF_TOOL_ID = 'ExitPlanMode'

export type ExitPlanModeInput = {
  plan?: string
}

// The model-facing result is a branch-aware prose string
// (the approved plan body when one is present, an "ok" cue for
// agent-context approvals, or a bare acknowledgement). Structured
// fields (planFilePath, planWasWritten, restoredMode, isAgent) live
// on internal state only.
export type ExitPlanModeOutput = string

function isENOENTError(error: unknown): boolean {
  if (!error || typeof error !== 'object') {
    return false
  }
  const err = error as { code?: unknown; message?: unknown }
  if (err.code === 'ENOENT') {
    return true
  }
  return typeof err.message === 'string' && /\bENOENT\b/.test(err.message)
}

async function readExistingPlan(
  fs: RuntimeFs,
  filePath: string,
): Promise<string | null> {
  try {
    return await fs.readFile(filePath, { encoding: 'utf-8' })
  } catch (error) {
    if (isENOENTError(error)) {
      return null
    }
    throw error
  }
}

export const ExitPlanModeTool: ToolContract<ExitPlanModeInput, ExitPlanModeOutput> =
  declareTool({
    name: PLAN_OFF_TOOL_ID,
    discoveryHint: 'present plan for approval and resume implementation',
    argsSchema: {
      type: 'object',
      properties: {
        plan: {
          type: 'string',
          description:
            'The plan to present to the user. If omitted, the persisted plan file (if any) is used.',
        },
      },
    },
    // The description leaves out the permission-mode restoration
    // mechanic, which is implementation detail the model doesn't need.
    description: async () =>
      'Prompts the user to exit plan mode and start coding',
    parallelSafe: () => false,
    readsOnly: () => false,
    // ExitPlanMode HALTS the agent loop for the user (like AskUserQuestion), so
    // the model stops after presenting the plan instead of looping. runToolUse
    // takes the pendingToolUse branch for this (gated on !agentId — an agent
    // context has no interactive surface and falls through to call()). The
    // user's Approve resumes the loop via submitToolResult.
    haltsForUser: () => true,
    async checkInput(
      _input: ExitPlanModeInput,
      context: ToolCallContext,
    ): Promise<InputCheck> {
      const mode = context.readAppState().permissionRules.mode
      if (mode !== 'plan') {
        return {
          result: false,
          message:
            'You are not in plan mode. ExitPlanMode is only valid while plan mode is active.',
          errorCode: 1,
        }
      }
      return { result: true }
    },
    call: async (input: ExitPlanModeInput, context: ToolCallContext) => {
      // call() runs after the queued approval resolves on the main thread. Agent
      // contexts have no interactive surface, so they fall through here and
      // auto-approve.
      const planFilePath = planDocPath(context)
      let planText = ''
      if (typeof input.plan === 'string' && input.plan.length > 0) {
        await ensurePlanDirectoryExists(context)
        const fs = fsForContext(context)
        await fs.writeFile(planFilePath, input.plan, { encoding: 'utf-8' })
        planText = input.plan
      } else {
        planText = (await readExistingPlan(fsForContext(context), planFilePath).catch(() => null)) ?? ''
      }
      context.writeAppState(prev => {
        if (prev.permissionRules.mode !== 'plan') {
          return prev
        }
        return {
          ...prev,
          permissionRules: {
            ...prev.permissionRules,
            mode: prev.permissionRules.modeBeforePlan ?? 'default',
            modeBeforePlan: undefined,
          },
        }
      })
      return {
        data: buildApprovedPlanMessage(planText, planFilePath),
      }
    },
  })
