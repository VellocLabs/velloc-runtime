import type { ToolContract, InputCheck } from '../toolContract'
import type { ToolCallContext } from '../toolCallContext'
import { declareTool } from '../toolContract'
import { getRoutineRegistry } from '../../routines/RoutineRegistry'
import type {
  Routine,
  RoutineKind,
} from '../../routines/routineTypes'

export const SCHEDULE_LIST_TOOL_ID = 'CronList'

export type CronListInput = {
  kind?: RoutineKind
  enabled_only?: boolean
}

export type CronListOutput = string

function clockLabel(ms: number | undefined): string {
  if (typeof ms !== 'number') return '—'
  return new Date(ms).toISOString()
}

function formatScheduleHint(routine: Routine): string {
  if (routine.kind === 'cron') {
    const tz = routine.timezone ? ` (${routine.timezone})` : ''
    return `cron \`${routine.schedule}\`${tz}`
  }
  // remote_trigger
  return `trigger \`${routine.trigger.type}\``
}

function renderRoutineRow(routine: Routine): string {
  const state = routine.enabled ? 'enabled' : 'paused'
  const oneShot = routine.oneShot ? ' (one-shot)' : ''
  const lastRun =
    routine.lastRunStatus !== undefined
      ? `${routine.lastRunStatus} @ ${clockLabel(routine.lastRunAt)}`
      : '—'
  return [
    `- **${routine.name}** \`${routine.id}\` — ${state}${oneShot}`,
    `  ${formatScheduleHint(routine)} · notify_on: \`${routine.notifyOn}\``,
    `  last run: ${lastRun}`,
  ].join('\n')
}

export const ScheduleListTool: ToolContract<CronListInput, CronListOutput> = declareTool({
  name: SCHEDULE_LIST_TOOL_ID,
  discoveryHint: 'list scheduled cron / remote-trigger routines',
  argsSchema: {
    type: 'object',
    properties: {
      kind: {
        type: 'string',
        enum: ['cron', 'remote_trigger'],
        description:
          'Optional. Filter to one routine kind. When omitted, both kinds are returned.',
      },
      enabled_only: {
        type: 'boolean',
        description:
          'Optional. When true, paused routines are hidden. Defaults to false.',
      },
    },
  },
  description: async () => 'List scheduled cron / remote-trigger routines',
  parallelSafe: () => true,
  readsOnly: () => true,
  async checkInput(
    _input: CronListInput,
    _context: ToolCallContext,
  ): Promise<InputCheck> {
    // No input validation beyond the schema enum/type checks.
    return { result: true }
  },
  async call(input: CronListInput, _context: ToolCallContext) {
    const registry = getRoutineRegistry()
    if (!registry) {
      return {
        data:
          'Routine registry not initialized. The background runtime has not booted the routines subsystem yet. Try again in a moment, or report a bug if this persists.',
      }
    }

    const routines = registry.list({
      kind: input.kind,
      enabledOnly: input.enabled_only ?? false,
    })

    if (routines.length === 0) {
      return { data: 'No routines registered.' }
    }

    // Stable order: by createdAt ascending so older routines float to
    // the top. This matches the user's mental model of "what did I set
    // up first."
    const sorted = [...routines].sort((a, b) => a.createdAt - b.createdAt)
    const body = sorted.map(renderRoutineRow).join('\n\n')
    const count = sorted.length
    const header =
      `${count} routine${count === 1 ? '' : 's'} registered` +
      (input.enabled_only ? ' (enabled only)' : '') +
      (input.kind ? ` filtered to kind=${input.kind}` : '') +
      ':'
    return { data: `${header}\n\n${body}` }
  },
})
