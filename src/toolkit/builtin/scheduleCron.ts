import { routineRecursionDenial } from './routineRecursionGuard'
import type { ToolContract, InputCheck } from '../toolContract'
import type { ToolCallContext } from '../toolCallContext'
import { declareTool } from '../toolContract'
import { ONE_SHOT_TIMEZONE, parseOneShotAt } from '../../routines/oneShotSchedule'
import { newRoutineId } from '../../routines/routineId'
import {
  getRoutineRegistry,
  RoutineNameInvalidError,
  RoutineNameTakenError,
} from '../../routines/RoutineRegistry'
import type {
  CronRoutine,
  NotifyPolicy,
} from '../../routines/routineTypes'

export const SCHEDULE_CRON_TOOL_NAME = 'ScheduleCron'

export type ScheduleCronInput = {
  name?: string
  at?: string
  prompt?: string
  allowed_tools?: string[]
  model?: string
  notify_on?: NotifyPolicy
}

export type ScheduleCronOutput = string

const NOTIFY_POLICIES: NotifyPolicy[] = [
  'always',
  'on_error',
  'on_signal',
  'silent',
]

export const ScheduleCronTool: ToolContract<ScheduleCronInput, ScheduleCronOutput> =
  declareTool({
    name: SCHEDULE_CRON_TOOL_NAME,
    discoveryHint: 'schedule a one-shot background run at a specific time',
    argsSchema: {
      type: 'object',
      properties: {
        name: {
          type: 'string',
          description:
            'Stable handle for the routine (1-64 chars, [a-z0-9_-]). Must be unique.',
        },
        at: {
          type: 'string',
          description:
            'When to run. Accepts an ISO timestamp ("2026-05-16T09:00:00Z") OR a relative offset ("in 30m", "in 2h", "in 1d"). Must be in the future.',
        },
        prompt: {
          type: 'string',
          description:
            'The directive sent as the first user message of the headless run. Complete and self-contained — the headless agent has no prior context.',
        },
        allowed_tools: {
          type: 'array',
          items: { type: 'string' },
          description:
            'Optional tool allowlist for the headless run. When omitted, inherits the default preset.',
        },
        model: {
          type: 'string',
          description:
            'Optional model override for the headless run.',
        },
        notify_on: {
          type: 'string',
          enum: NOTIFY_POLICIES,
          description:
            'When to surface the result. Default: "always" for one-shot runs (the user explicitly asked for this to happen).',
        },
      },
      required: ['name', 'at', 'prompt'],
    },
    description: async () =>
      'Schedule a one-shot background run at a specific time',
    parallelSafe: () => false,
    readsOnly: () => false,
    async selfVerdict(input, _context) {
      return {
        behavior: 'ask',
        message: `Schedule one-shot routine "${input.name ?? '(unnamed)'}" at ${input.at ?? ''}?`,
        updatedInput: input,
      }
    },
    async checkInput(
      input: ScheduleCronInput,
      context: ToolCallContext,
    ): Promise<InputCheck> {
      if (typeof input.name !== 'string' || input.name.trim().length === 0) {
        return { result: false, message: 'name is required.', errorCode: 1 }
      }
      if (typeof input.at !== 'string' || input.at.trim().length === 0) {
        return { result: false, message: 'at is required.', errorCode: 2 }
      }
      if (typeof input.prompt !== 'string' || input.prompt.trim().length === 0) {
        return { result: false, message: 'prompt is required.', errorCode: 3 }
      }
      const parsed = parseOneShotAt(input.at)
      if (!parsed.ok) {
        return { result: false, message: parsed.message, errorCode: 4 }
      }
      if (
        input.notify_on !== undefined &&
        !NOTIFY_POLICIES.includes(input.notify_on)
      ) {
        return {
          result: false,
          message: `notify_on must be one of: ${NOTIFY_POLICIES.join(', ')}.`,
          errorCode: 5,
        }
      }
      // Same recursion guard as CronCreate — routine-driven work can't
      // schedule more routines, whether it is the headless routine session
      // itself, a session-delivered fire, or a sub-agent / teammate a
      // routine spawned. See routineRecursionGuard.ts.
      const options = context.options as {
        isHeadless?: boolean
        sessionId?: string
      }
      const denial = routineRecursionDenial(options, 'ScheduleCron', 6)
      if (denial) return denial
      return { result: true }
    },
    async call(input: ScheduleCronInput, context: ToolCallContext) {
      const registry = getRoutineRegistry()
      if (!registry) {
        return {
          data:
            'Routine registry not initialized — the background runtime has not booted the routines subsystem yet.',
        }
      }

      const parsed = parseOneShotAt(input.at ?? '')
      if (!parsed.ok) {
        return { data: parsed.message }
      }

      const now = Date.now()
      const routine: CronRoutine = {
        kind: 'cron',
        id: newRoutineId(),
        name: (input.name ?? '').trim(),
        schedule: parsed.schedule,
        prompt: input.prompt ?? '',
        permittedTools: input.allowed_tools,
        model: input.model,
        notifyOn: input.notify_on ?? 'always',
        createdAt: now,
        createdBySessionId: context.options.sessionId ?? 'unknown',
        enabled: true,
        oneShot: true,
        timezone: ONE_SHOT_TIMEZONE,
      }

      try {
        await registry.create(routine)
      } catch (err) {
        if (err instanceof RoutineNameTakenError) {
          return {
            data: `Routine name "${routine.name}" is already in use. Pick a different name.`,
          }
        }
        if (err instanceof RoutineNameInvalidError) {
          return { data: err.message }
        }
        const message = err instanceof Error ? err.message : String(err)
        return { data: `Failed to schedule routine: ${message}` }
      }

      return {
        data: `One-shot routine "${routine.name}" scheduled for ${parsed.target.toISOString()} (id ${routine.id}). It will auto-disable after firing.`,
      }
    },
  })
