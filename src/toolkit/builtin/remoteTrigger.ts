import { routineRecursionDenial } from './routineRecursionGuard'
import type { ToolContract, InputCheck } from '../toolContract'
import type { ToolCallContext } from '../toolCallContext'
import { declareTool } from '../toolContract'
import { newRoutineId } from '../../routines/routineId'
import {
  getRoutineRegistry,
  RoutineNameInvalidError,
  RoutineNameTakenError,
} from '../../routines/RoutineRegistry'
import { getRoutineRunnerSingleton } from '../../routines/runtimeSingletons'
import type {
  NotifyPolicy,
  RemoteTriggerRoutine,
} from '../../routines/routineTypes'

export const ROUTINE_FIRE_TOOL_ID = 'RemoteTrigger'

export type RemoteTriggerAction = 'register' | 'list' | 'delete' | 'fire'
export type RemoteTriggerKind = 'webhook' | 'github_event' | 'manual'

export type RemoteTriggerInput = {
  action?: RemoteTriggerAction
  // register
  name?: string
  trigger_type?: RemoteTriggerKind
  prompt?: string
  allowed_tools?: string[]
  model?: string
  notify_on?: NotifyPolicy
  webhook_secret?: string
  github_repo?: string
  github_event_type?: string
  // delete / fire
  id?: string
}

export type RemoteTriggerOutput = string

const NOTIFY_POLICIES: NotifyPolicy[] = [
  'always',
  'on_error',
  'on_signal',
  'silent',
]
const VALID_ACTIONS: RemoteTriggerAction[] = [
  'register',
  'list',
  'delete',
  'fire',
]
const VALID_TRIGGER_KINDS: RemoteTriggerKind[] = [
  'webhook',
  'github_event',
  'manual',
]

export const RoutineFireTool: ToolContract<RemoteTriggerInput, RemoteTriggerOutput> =
  declareTool({
    name: ROUTINE_FIRE_TOOL_ID,
    discoveryHint:
      'register, list, delete, or fire a remote-triggered background routine',
    argsSchema: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: VALID_ACTIONS as unknown as string[],
          description:
            '"register" creates a new trigger. "list" enumerates existing triggers. "delete" removes one. "fire" manually invokes a registered trigger (typically used for testing or one-off runs).',
        },
        // register-only
        name: {
          type: 'string',
          description:
            '(register) Stable handle for the trigger (1-64 chars, [a-z0-9_-]).',
        },
        trigger_type: {
          type: 'string',
          enum: VALID_TRIGGER_KINDS as unknown as string[],
          description:
            '(register) "webhook" assigns a URL the user POSTs to. "github_event" registers a GitHub-event filter. "manual" can only fire via this tool\'s "fire" action.',
        },
        prompt: {
          type: 'string',
          description:
            '(register) The directive sent to the headless agent when the trigger fires. Self-contained — the agent has no prior conversation context.',
        },
        allowed_tools: {
          type: 'array',
          items: { type: 'string' },
          description: '(register) Optional tool allowlist for the headless run.',
        },
        model: {
          type: 'string',
          description: '(register) Optional model override.',
        },
        notify_on: {
          type: 'string',
          enum: NOTIFY_POLICIES,
          description:
            '(register) Notification policy. Defaults to "always" for remote triggers since an external event is by definition noteworthy.',
        },
        webhook_secret: {
          type: 'string',
          description:
            '(register, trigger_type=webhook) Optional shared secret for HMAC verification. When omitted, the assigned URL is the only secret.',
        },
        github_repo: {
          type: 'string',
          description:
            '(register, trigger_type=github_event) GitHub repo in "owner/name" form.',
        },
        github_event_type: {
          type: 'string',
          description:
            '(register, trigger_type=github_event) Event type to subscribe to (e.g. "push", "pull_request", "workflow_run").',
        },
        id: {
          type: 'string',
          description:
            '(delete / fire) The routine id (rt_...) or name to target.',
        },
      },
      required: ['action'],
    },
    description: async () =>
      'Manage remote-triggered background routines (webhook / GitHub event / manual fire)',
    parallelSafe: () => false,
    readsOnly: () => false,
    async selfVerdict(input, _context) {
      // Read-only actions don't need approval; mutating ones do.
      if (input.action === 'list') {
        return { behavior: 'allow', updatedInput: input }
      }
      const summary =
        input.action === 'register'
          ? `Register remote trigger "${input.name ?? '(unnamed)'}" (${input.trigger_type ?? '?'})?`
          : input.action === 'delete'
            ? `Delete trigger ${input.id ?? '(unspecified)'}?`
            : input.action === 'fire'
              ? `Fire trigger ${input.id ?? '(unspecified)'} now?`
              : `Run RemoteTrigger.${input.action ?? '?'}?`
      return {
        behavior: 'ask',
        message: summary,
        updatedInput: input,
      }
    },
    async checkInput(
      input: RemoteTriggerInput,
      context: ToolCallContext,
    ): Promise<InputCheck> {
      if (
        typeof input.action !== 'string' ||
        !VALID_ACTIONS.includes(input.action)
      ) {
        return {
          result: false,
          message: `action must be one of: ${VALID_ACTIONS.join(', ')}.`,
          errorCode: 1,
        }
      }
      if (input.action === 'register') {
        if (typeof input.name !== 'string' || input.name.trim().length === 0) {
          return {
            result: false,
            message: 'name is required for action=register.',
            errorCode: 2,
          }
        }
        if (
          typeof input.trigger_type !== 'string' ||
          !VALID_TRIGGER_KINDS.includes(input.trigger_type)
        ) {
          return {
            result: false,
            message: `trigger_type must be one of: ${VALID_TRIGGER_KINDS.join(', ')}.`,
            errorCode: 3,
          }
        }
        if (typeof input.prompt !== 'string' || input.prompt.trim().length === 0) {
          return {
            result: false,
            message: 'prompt is required for action=register.',
            errorCode: 4,
          }
        }
        if (input.trigger_type === 'github_event') {
          if (
            typeof input.github_repo !== 'string' ||
            input.github_repo.trim().length === 0
          ) {
            return {
              result: false,
              message: 'github_repo is required when trigger_type=github_event.',
              errorCode: 5,
            }
          }
          if (
            typeof input.github_event_type !== 'string' ||
            input.github_event_type.trim().length === 0
          ) {
            return {
              result: false,
              message:
                'github_event_type is required when trigger_type=github_event.',
              errorCode: 6,
            }
          }
        }
        if (
          input.notify_on !== undefined &&
          !NOTIFY_POLICIES.includes(input.notify_on)
        ) {
          return {
            result: false,
            message: `notify_on must be one of: ${NOTIFY_POLICIES.join(', ')}.`,
            errorCode: 7,
          }
        }
        const options = context.options as {
          isHeadless?: boolean
          sessionId?: string
        }
        const denial = routineRecursionDenial(
          options,
          'RemoteTrigger.register',
          8,
        )
        if (denial) return denial
      } else if (input.action === 'delete' || input.action === 'fire') {
        if (typeof input.id !== 'string' || input.id.trim().length === 0) {
          return {
            result: false,
            message: `id is required for action=${input.action}.`,
            errorCode: 9,
          }
        }
      }
      return { result: true }
    },
    async call(input: RemoteTriggerInput, context: ToolCallContext) {
      const registry = getRoutineRegistry()
      if (!registry) {
        return {
          data:
            'Routine registry not initialized — the background runtime has not booted the routines subsystem yet.',
        }
      }

      switch (input.action) {
        case 'list': {
          const triggers = registry.list({ kind: 'remote_trigger' })
          if (triggers.length === 0) {
            return { data: 'No remote triggers registered.' }
          }
          const lines = triggers
            .sort((a, b) => a.createdAt - b.createdAt)
            .map((r) => {
              const trig = r.kind === 'remote_trigger' ? r.trigger : null
              const triggerKind = trig?.type ?? '(unknown)'
              const state = r.enabled ? 'enabled' : 'paused'
              return `- **${r.name}** \`${r.id}\` — ${state}, trigger=\`${triggerKind}\`, notify_on=\`${r.notifyOn}\``
            })
            .join('\n')
          return { data: `${triggers.length} remote trigger(s):\n\n${lines}` }
        }

        case 'register': {
          const now = Date.now()
          const triggerType = input.trigger_type!
          const trigger =
            triggerType === 'webhook'
              ? { type: 'webhook' as const, secret: input.webhook_secret }
              : triggerType === 'github_event'
                ? {
                    type: 'github_event' as const,
                    repo: input.github_repo!,
                    event_type: input.github_event_type!,
                  }
                : { type: 'manual' as const }
          const routine: RemoteTriggerRoutine = {
            kind: 'remote_trigger',
            id: newRoutineId(),
            name: (input.name ?? '').trim(),
            trigger,
            prompt: input.prompt ?? '',
            permittedTools: input.allowed_tools,
            model: input.model,
            notifyOn: input.notify_on ?? 'always',
            createdAt: now,
            createdBySessionId: context.options.sessionId ?? 'unknown',
            enabled: true,
          }
          try {
            await registry.create(routine)
          } catch (err) {
            if (err instanceof RoutineNameTakenError) {
              return {
                data: `Trigger name "${routine.name}" is already in use.`,
              }
            }
            if (err instanceof RoutineNameInvalidError) {
              return { data: err.message }
            }
            const message = err instanceof Error ? err.message : String(err)
            return { data: `Failed to register trigger: ${message}` }
          }
          const followUp =
            triggerType === 'webhook'
              ? ' (webhook URL will be assigned by the host; check the routines panel)'
              : triggerType === 'github_event'
                ? ' (GitHub-event polling is a follow-up; the trigger persists but does not yet wake on events)'
                : ' (fires only via RemoteTrigger.fire)'
          return {
            data: `Remote trigger "${routine.name}" registered (id ${routine.id}).${followUp}`,
          }
        }

        case 'delete': {
          const target = (input.id ?? '').trim()
          const routine = registry.resolve(target)
          if (!routine) {
            return { data: `Remote trigger "${target}" not found.` }
          }
          if (routine.kind !== 'remote_trigger') {
            return {
              data: `Refusing to delete "${target}" — it is a cron routine. Use CronDelete instead.`,
            }
          }
          const runner = getRoutineRunnerSingleton()
          runner?.abort(routine.id)
          await registry.delete(routine.id)
          return { data: `Remote trigger "${routine.name}" deleted.` }
        }

        case 'fire': {
          const target = (input.id ?? '').trim()
          const routine = registry.resolve(target)
          if (!routine) {
            return { data: `Remote trigger "${target}" not found.` }
          }
          if (routine.kind !== 'remote_trigger') {
            return {
              data: `Refusing to fire "${target}" — it is a cron routine, not a remote trigger.`,
            }
          }
          if (!routine.enabled) {
            return { data: `Remote trigger "${routine.name}" is paused.` }
          }
          const runner = getRoutineRunnerSingleton()
          if (!runner) {
            return {
              data:
                'Routine runner not initialized — the background runtime has not booted.',
            }
          }
          const sessionId = runner.enqueue(routine)
          // Best-effort: record the manual fire on the routine so
          // CronList shows it. The runner will overwrite this with
          // lastRunStatus when the headless run finishes.
          await registry
            .update(routine.id, { lastFiredAt: Date.now() })
            .catch(() => {})
          return {
            data: `Remote trigger "${routine.name}" fired. Headless session ${sessionId}.`,
          }
        }

        default:
          // Unreachable given validation above, but satisfies the type checker.
          return { data: 'Unknown action.' }
      }
    },
  })
