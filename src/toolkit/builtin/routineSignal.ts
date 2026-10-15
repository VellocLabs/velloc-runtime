import type { ToolContract, InputCheck } from '../toolContract'
import type { ToolCallContext } from '../toolCallContext'
import { declareTool } from '../toolContract'
import { getRoutineRegistry } from '../../routines/RoutineRegistry'
import type { RoutineSignal } from '../../routines/routineTypes'

export const ROUTINE_SIGNAL_TOOL_NAME = 'RoutineSignal'

export type RoutineSignalInput = {
  priority?: 'low' | 'normal' | 'urgent'
  message?: string
}

export type RoutineSignalOutput = string

const VALID_PRIORITIES: RoutineSignal['priority'][] = [
  'low',
  'normal',
  'urgent',
]

/** Fields set when the SharedWorkerSessionManager spawns a headless routine session. */
type HeadlessRoutineContext = {
  isHeadless?: boolean
  routineId?: string
}

export const RoutineSignalTool: ToolContract<RoutineSignalInput, RoutineSignalOutput> =
  declareTool({
    name: ROUTINE_SIGNAL_TOOL_NAME,
    discoveryHint: 'escalate a finding from a headless routine to the user',
    argsSchema: {
      type: 'object',
      properties: {
        priority: {
          type: 'string',
          enum: VALID_PRIORITIES as unknown as string[],
          description:
            '"low" = in-app indicator only. "normal" = in-app + OS push. "urgent" = push + in-conversation reminder. Default "normal".',
        },
        message: {
          type: 'string',
          description:
            'The user-facing message. Concise — this is shown verbatim in notifications. The fork\'s full output is still available via the routines panel.',
        },
      },
      required: ['message'],
    },
    description: async () =>
      'Escalate a finding from this headless routine run to the user',
    parallelSafe: () => true,
    readsOnly: () => true,
    async checkInput(
      input: RoutineSignalInput,
      context: ToolCallContext,
    ): Promise<InputCheck> {
      if (
        typeof input.message !== 'string' ||
        input.message.trim().length === 0
      ) {
        return {
          result: false,
          message: 'message is required and must be a non-empty string.',
          errorCode: 1,
        }
      }
      if (
        input.priority !== undefined &&
        !VALID_PRIORITIES.includes(input.priority)
      ) {
        return {
          result: false,
          message: `priority must be one of: ${VALID_PRIORITIES.join(', ')}.`,
          errorCode: 2,
        }
      }
      // Reject outside headless contexts. The tool surface is registered
      // globally so it shows up in `ToolSearch` for discoverability, but
      // calling it from a normal session is meaningless.
      const options = context.options as HeadlessRoutineContext
      if (!options.isHeadless) {
        return {
          result: false,
          message:
            'RoutineSignal is only callable inside headless routine sessions (cron / scheduled / remote-triggered). It has no effect in a normal chat session.',
          errorCode: 3,
        }
      }
      return { result: true }
    },
    async call(input: RoutineSignalInput, context: ToolCallContext) {
      const options = context.options as HeadlessRoutineContext
      const signal: RoutineSignal = {
        priority: input.priority ?? 'normal',
        message: input.message ?? '',
        emittedAt: Date.now(),
      }

      // Persisted to the registry, the durable source of truth: `HeadlessRunner`
      // reads `routine.lastRunSignal` after the run, and it survives a worker crash.
      const registry = getRoutineRegistry()
      const routineId = options.routineId
      if (registry && routineId) {
        try {
          await registry.update(routineId, { lastRunSignal: signal })
        } catch {
          // Best-effort — registry write failures don't void the run.
          // The signal will still be visible in the headless session
          // transcript even if the routing miss.
        }
      }

      return {
        data: `Signal emitted (priority=${signal.priority}). The user will be notified per the routine's notify_on policy.`,
      }
    },
  })
