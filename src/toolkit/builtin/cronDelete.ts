import type { ToolContract, InputCheck } from '../toolContract'
import type { ToolCallContext } from '../toolCallContext'
import { declareTool } from '../toolContract'
import {
  getRoutineRegistry,
  RoutineNotFoundError,
} from '../../routines/RoutineRegistry'
import {
  getRoutineRunnerSingleton,
} from '../../routines/runtimeSingletons'

export const SCHEDULE_DROP_TOOL_ID = 'CronDelete'

export type CronDeleteInput = {
  id?: string
  name?: string
}

export type CronDeleteOutput = string

export const ScheduleDropTool: ToolContract<CronDeleteInput, CronDeleteOutput> =
  declareTool({
    name: SCHEDULE_DROP_TOOL_ID,
    discoveryHint: 'delete a registered cron or remote-trigger routine',
    argsSchema: {
      type: 'object',
      properties: {
        id: {
          type: 'string',
          description:
            'The routine id (rt_...). Either id or name must be provided.',
        },
        name: {
          type: 'string',
          description:
            'The routine name. Either id or name must be provided; if both are provided, id wins.',
        },
      },
    },
    description: async () =>
      'Delete a registered cron / remote-trigger routine',
    parallelSafe: () => false,
    readsOnly: () => false,
    async selfVerdict(input, _context) {
      return {
        behavior: 'ask',
        message: `Delete routine ${input.id ?? input.name ?? '(unspecified)'}?`,
        updatedInput: input,
      }
    },
    async checkInput(
      input: CronDeleteInput,
      _context: ToolCallContext,
    ): Promise<InputCheck> {
      const hasId = typeof input.id === 'string' && input.id.trim().length > 0
      const hasName =
        typeof input.name === 'string' && input.name.trim().length > 0
      if (!hasId && !hasName) {
        return {
          result: false,
          message: 'Either id or name must be provided.',
          errorCode: 1,
        }
      }
      return { result: true }
    },
    async call(input: CronDeleteInput, _context: ToolCallContext) {
      const registry = getRoutineRegistry()
      if (!registry) {
        return {
          data:
            'Routine registry not initialized — the background runtime has not booted the routines subsystem yet.',
        }
      }

      const target = input.id ?? input.name
      if (!target) {
        return { data: 'Either id or name must be provided.' }
      }
      const routine = registry.resolve(target.trim())
      if (!routine) {
        return { data: `Routine "${target}" not found.` }
      }

      // Abort any in-flight headless run for this routine BEFORE
      // tombstoning the registry record — that way the runner can
      // clean up using the still-existing routine state, and the
      // deletion is the final write.
      const runner = getRoutineRunnerSingleton()
      runner?.abort(routine.id)

      try {
        await registry.delete(routine.id)
      } catch (err) {
        if (err instanceof RoutineNotFoundError) {
          // Already gone (race with another delete). Treat as success.
          return { data: `Routine "${routine.name}" already deleted.` }
        }
        const message = err instanceof Error ? err.message : String(err)
        return { data: `Failed to delete routine: ${message}` }
      }

      return {
        data: `Routine "${routine.name}" (id ${routine.id}) deleted.`,
      }
    },
  })
