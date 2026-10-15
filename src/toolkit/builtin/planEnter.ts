import type { ToolContract, InputCheck } from '../toolContract'
import type { ToolCallContext } from '../toolCallContext'
import { declareTool } from '../toolContract'
import { ensurePlanDirectoryExists } from '../../utils/planFiles'

export const PLAN_ON_TOOL_ID = 'EnterPlanMode'

export type EnterPlanModeInput = Record<string, never>

// The model-facing result is the plan-mode instructions prose.
// previousMode is not emitted to the model.
export type EnterPlanModeOutput = string

const PLAN_MODE_INSTRUCTIONS = [
  'Plan mode is on. Until the plan is approved, read and think; do not write.',
  '',
  'Spend this phase on:',
  '1. reading the code paths the task touches, and how similar things are done already;',
  '2. weighing more than one approach, with its costs;',
  '3. settling on a concrete sequence of changes;',
  '4. calling ExitPlanMode to put the plan in front of the user.',
  '',
  'No file may be created or edited while plan mode is on.',
].join('\n')

export const PlanOnTool: ToolContract<EnterPlanModeInput, EnterPlanModeOutput> =
  declareTool({
    name: PLAN_ON_TOOL_ID,
    discoveryHint: 'switch to plan mode to design an approach before coding',
    argsSchema: {
      type: 'object',
      properties: {},
    },
    // No trailing period.
    description: async () =>
      'Asks the user to switch the session into plan mode, a read-only phase for studying the code and designing an approach. For work that is large or unclear enough to need exploration and design before the first change; not for a simple, well-understood edit',
    parallelSafe: () => true,
    readsOnly: () => true,
    // Model-invoked EnterPlanMode is gated behind a user approval, raised
    // through the interactive-confirm queue (the same HALT ExitPlanMode
    // uses). The mode flip stays inside call(), so it
    // only happens after the user approves.
    haltsForUser: () => true,
    async checkInput(
      _input: EnterPlanModeInput,
      context: ToolCallContext,
    ): Promise<InputCheck> {
      if (context.agentId) {
        return {
          result: false,
          message: 'EnterPlanMode cannot be used inside a subagent context.',
          errorCode: 1,
        }
      }
      const currentMode = context.readAppState().permissionRules.mode
      if (currentMode === 'plan') {
        return {
          result: false,
          message: 'Already in plan mode. Use ExitPlanMode to present the plan when ready.',
          errorCode: 2,
        }
      }
      return { result: true }
    },
    call: async (_input: EnterPlanModeInput, context: ToolCallContext) => {
      const previousMode = context.readAppState().permissionRules.mode

      context.writeAppState(prev => ({
        ...prev,
        permissionRules: {
          ...prev.permissionRules,
          mode: 'plan',
          modeBeforePlan: prev.permissionRules.mode,
        },
      }))

      // Best-effort — the plan directory will be created on demand by ExitPlanMode
      // if this fails (e.g. browser bridge not yet ready in tests).
      await ensurePlanDirectoryExists(context).catch(() => {})

      // Emit PLAN_MODE_INSTRUCTIONS as the tool_result string directly. `previousMode` was diagnostic-only and isn't
      // needed by any consumer beyond the model's understanding of the
      // mode switch; the instructions block already conveys that.
      void previousMode
      return {
        data: PLAN_MODE_INSTRUCTIONS,
      }
    },
  })
