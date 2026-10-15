import { routineRecursionDenial } from './routineRecursionGuard'
import type { ToolContract, InputCheck } from '../toolContract'
import type { ToolCallContext } from '../toolCallContext'
import { declareTool } from '../toolContract'
import {
  computeNextFireAt,
  validateCronExpression,
} from '../../routines/cronExpression'
import { newRoutineId } from '../../routines/routineId'
import {
  isValidTimeZone,
  resolveHostTimeZone,
} from '../../routines/routineTimezone'
import {
  getRoutineRegistry,
  RoutineNameInvalidError,
  RoutineNameTakenError,
} from '../../routines/RoutineRegistry'
import type {
  CronRoutine,
  NotifyPolicy,
} from '../../routines/routineTypes'

export const SCHEDULE_ADD_TOOL_ID = 'CronCreate'

export type CronCreateInput = {
  name?: string
  schedule?: string
  prompt?: string
  timezone?: string
  allowed_tools?: string[]
  model?: string
  notify_on?: NotifyPolicy
  deliver_to?: RoutineDeliveryMode
}

export type CronCreateOutput = string

/** Wire form of `RoutineDelivery.mode`. */
export type RoutineDeliveryMode = 'headless' | 'session'

const DELIVERY_MODES: RoutineDeliveryMode[] = ['headless', 'session']

/**
 * Cap on session-delivered routines per conversation. The recursion guard
 * is the real defense against runaway registration; this is the cheap
 * second line, and it also keeps an over-eager user from stacking a dozen
 * timers on one conversation.
 */
const MAX_SESSION_ROUTINES_PER_SESSION = 5

const NOTIFY_POLICIES: NotifyPolicy[] = [
  'always',
  'on_error',
  'on_signal',
  'silent',
]

export const ScheduleAddTool: ToolContract<CronCreateInput, CronCreateOutput> =
  declareTool({
    name: SCHEDULE_ADD_TOOL_ID,
    discoveryHint: 'register a recurring background routine on a cron schedule',
    argsSchema: {
      type: 'object',
      properties: {
        name: {
          type: 'string',
          description:
            'Stable handle for the routine (1-64 chars, [a-z0-9_-]). Used in CronList output and as the target for CronDelete.',
        },
        schedule: {
          type: 'string',
          description:
            'Cron expression in 5-field form (minute hour day-of-month month day-of-week). Examples: "0 9 * * 1-5" (weekdays at 9am), "*/15 * * * *" (every 15 minutes).',
        },
        prompt: {
          type: 'string',
          description:
            'The directive the routine runs. For deliver_to "headless" (default) it is the first user message of a fresh run with no prior context, so write it as a complete task and state the success criterion explicitly ("Report ... under 200 words" / "Send a Slack DM if X"). For deliver_to "session" it is injected into an existing conversation that already has the context, so keep the user\'s own wording instead of expanding it.',
        },
        timezone: {
          type: 'string',
          description:
            'Optional IANA timezone for the cron expression (e.g. "America/Los_Angeles"). Defaults to the local timezone.',
        },
        allowed_tools: {
          type: 'array',
          items: { type: 'string' },
          description:
            'Optional tool allowlist for the headless run. When omitted, the headless agent inherits the default preset. Use to restrict the routine\'s blast radius (e.g. ["Read", "Grep", "WebFetch"] for a read-only digest).',
        },
        model: {
          type: 'string',
          description:
            'Optional model override for the headless run. When omitted, the runtime default is used.',
        },
        notify_on: {
          type: 'string',
          enum: NOTIFY_POLICIES,
          description:
            'When to surface run results to the user. "always" pushes every run; "on_error" pushes only when the run fails; "on_signal" pushes only when the agent calls RoutineSignal; "silent" stores the result without notifying. Default: "on_error".',
        },
        deliver_to: {
          type: 'string',
          enum: DELIVERY_MODES as unknown as string[],
          description:
            '"headless" (default) runs each fire as a fresh isolated agent with NO conversation context — right for self-contained jobs that must run whether or not anyone is around. "session" instead injects the prompt as a hidden turn in THIS conversation, so it runs with everything above it; use it when the prompt only makes sense alongside the current context ("check the deploy"). A "session" routine is deleted automatically once this session is gone.',
        },
      },
      required: ['name', 'schedule', 'prompt'],
    },
    description: async () =>
      'Register a recurring background routine on a cron schedule',
    parallelSafe: () => false,
    readsOnly: () => false,
    async selfVerdict(input, _context) {
      // Routine creation is high-impact. Always ask the user even when
      // other tools have been auto-approved.
      return {
        behavior: 'ask',
        message: `Register routine "${input.name ?? '(unnamed)'}" with schedule "${input.schedule ?? ''}"?`,
        updatedInput: input,
      }
    },
    async checkInput(
      input: CronCreateInput,
      context: ToolCallContext,
    ): Promise<InputCheck> {
      if (typeof input.name !== 'string' || input.name.trim().length === 0) {
        return {
          result: false,
          message: 'name is required.',
          errorCode: 1,
        }
      }
      if (typeof input.schedule !== 'string' || input.schedule.trim().length === 0) {
        return {
          result: false,
          message: 'schedule is required.',
          errorCode: 2,
        }
      }
      if (typeof input.prompt !== 'string' || input.prompt.trim().length === 0) {
        return {
          result: false,
          message: 'prompt is required.',
          errorCode: 3,
        }
      }
      const requestedZone = input.timezone?.trim()
      if (requestedZone && !isValidTimeZone(requestedZone)) {
        return {
          result: false,
          message: `Unknown timezone: ${JSON.stringify(requestedZone)}. Use an IANA name such as "America/Los_Angeles".`,
          errorCode: 3,
        }
      }
      const cronCheck = validateCronExpression(input.schedule, requestedZone)
      if (!cronCheck.ok) {
        return {
          result: false,
          message: `Invalid cron expression: ${cronCheck.message}`,
          errorCode: 4,
        }
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
      // Block routines from registering more routines. Covers ALL shapes
      // of routine execution — a headless run (session-lifetime
      // `isHeadless`), a session-delivered fire (turn-lifetime marker), and
      // work a routine spawned (inherited `routineOriginId` — the sub-agent
      // / teammate indirection). See routineRecursionGuard.ts.
      const options = context.options as {
        isHeadless?: boolean
        sessionId?: string
      }
      const denial = routineRecursionDenial(options, 'CronCreate', 6)
      if (denial) return denial
      if (
        input.deliver_to !== undefined &&
        !DELIVERY_MODES.includes(input.deliver_to)
      ) {
        return {
          result: false,
          message: `deliver_to must be one of: ${DELIVERY_MODES.join(', ')}.`,
          errorCode: 7,
        }
      }
      if (input.deliver_to === 'session') {
        if (!options.sessionId) {
          return {
            result: false,
            message:
              'deliver_to "session" needs a session to deliver into, and this context has no session id. Use "headless" instead.',
            errorCode: 8,
          }
        }
        // Belt-and-braces on top of the recursion guard: cap how many
        // session-delivered routines one conversation can accumulate, so a
        // misbehaving loop cannot quietly fill a session with timers.
        const registry = getRoutineRegistry()
        const existing = (registry?.list({ kind: 'cron' }) ?? []).filter(
          r =>
            r.delivery?.mode === 'session' &&
            r.delivery.sessionId === options.sessionId,
        ).length
        if (existing >= MAX_SESSION_ROUTINES_PER_SESSION) {
          return {
            result: false,
            message: `This conversation already has ${existing} session-delivered routines (max ${MAX_SESSION_ROUTINES_PER_SESSION}). Delete one with CronDelete first.`,
            errorCode: 9,
          }
        }
      }
      return { result: true }
    },
    async call(input: CronCreateInput, context: ToolCallContext) {
      const registry = getRoutineRegistry()
      if (!registry) {
        return {
          data:
            'Routine registry not initialized — the background runtime has not booted the routines subsystem yet. Try again in a moment.',
        }
      }

      const now = Date.now()
      const requested = input.timezone?.trim()
      const zone = requested ? { zone: requested } : resolveHostTimeZone()
      const routine: CronRoutine = {
        kind: 'cron',
        id: newRoutineId(),
        name: (input.name ?? '').trim(),
        schedule: (input.schedule ?? '').trim(),
        timezone: zone.zone,
        prompt: input.prompt ?? '',
        permittedTools: input.allowed_tools,
        model: input.model,
        notifyOn: input.notify_on ?? 'on_error',
        createdAt: now,
        createdBySessionId: context.options.sessionId ?? 'unknown',
        enabled: true,
        // `createdBySessionId` is provenance; `delivery` is the routing
        // decision. They coincide for session mode, but only this field is
        // ever read as a target — see routineTypes.ts.
        ...(input.deliver_to === 'session' && context.options.sessionId
          ? {
              delivery: {
                mode: 'session' as const,
                sessionId: context.options.sessionId,
              },
            }
          : {}),
      }

      try {
        await registry.create(routine)
      } catch (err) {
        if (err instanceof RoutineNameTakenError) {
          return {
            data: `Routine name "${routine.name}" is already in use. Pick a different name or delete the existing one first.`,
          }
        }
        if (err instanceof RoutineNameInvalidError) {
          return { data: err.message }
        }
        const message = err instanceof Error ? err.message : String(err)
        return { data: `Failed to register routine: ${message}` }
      }

      const nextFireAt = computeNextFireAt(
        routine.schedule,
        routine.timezone,
        now,
      )
      const modeHint =
        routine.delivery?.mode === 'session'
          ? ' Runs in this conversation.'
          : ''
      const nextHint =
        nextFireAt !== null
          ? ` Next run: ${new Date(nextFireAt).toISOString()}.`
          : ' (Could not compute next run time — schedule may be exhausted.)'
      return {
        data: `Routine "${routine.name}" registered (id ${routine.id}, timezone ${routine.timezone}).${nextHint}${modeHint}${zone.diagnostic ? ` ${zone.diagnostic}` : ''}`,
      }
    },
  })
