/**
 * `SpawnTeammate`, the team lead's tool for starting a teammate. Strict schema, every
 * field required; "none" is `""`, not `null`, because a nullable property is flattened
 * and dropped from `required` on the wire. The spawn is `spawnTeammateSession` (F-20).
 */

import type { ToolContract, InputCheck } from '../toolContract'
import type { ToolCallContext } from '../toolCallContext'
import { declareTool } from '../toolContract'
import type { ToolArgsJsonShape } from '../toolContract'
import { AGENT_TEAMS_SKILL_NAME } from './teamTools'
import { spawnTeammateSession } from './team/spawnTeammate'

export const SPAWN_TEAMMATE_TOOL_NAME = 'SpawnTeammate'

export type SpawnTeammateInput = {
  /** Display name — a short person name, any language. */
  name: string
  /** The self-contained brief. */
  prompt: string
  /** Provider id from `TeamProviders`. */
  provider_id: string
  /** Exact model id enabled on that provider (from `TeamProviders`). */
  model: string
  /** Working directory the lead PREPARED, or "" for the project directory.
   *  `null` is tolerated for older transcripts / lenient models. */
  cwd: string | null
  /** One of the effort tiers `TeamProviders` lists for `model`, or "" for
   *  the model's default (the only choice when it lists none). */
  effort: string | null
}

const DESCRIPTION =
  'Spawn a TEAMMATE: a long-running child session with its own transcript, ' +
  'provider and model, working in the background. Every field is required — ' +
  'pick provider_id and model from TeamProviders; cwd is the directory you ' +
  'prepared for it ("" = your project directory); effort is one of the ' +
  'tiers TeamProviders lists for that model ("" = the model\'s default, and ' +
  'the only valid value when it lists none). The teammate reports at the end ' +
  'of each of its turns as a NEW turn in this session, so after spawning, end ' +
  'your turn rather than polling. Follow up with SendMessage; end it with ' +
  'Shutdown. A teammate on an untrusted provider is confined to a read/edit-only ' +
  'session inside cwd; you cannot change that.'

const SCHEMA: ToolArgsJsonShape = {
  type: 'object',
  properties: {
    name: {
      type: 'string',
      description:
        'Display name for the teammate — a short PERSON name, the way you would refer to a colleague: "Ada", "小民", "Mira". Any language; distinct from your other teammates. Not an identifier-style slug ("settings-designer"): the user reads this on the teammate\'s tab and on every report it sends, and it should read as someone working, not as a machine id. You address it with SendMessage / Shutdown by this name.',
    },
    prompt: {
      type: 'string',
      description:
        'A self-contained brief: the goal, the constraints, the assigned scope, what "done" means, and the absolute path it works in. The teammate cannot see your transcript and cannot ask the user anything.',
    },
    provider_id: {
      type: 'string',
      description:
        'The provider the teammate runs on — an id from TeamProviders. Its TRUST setting decides the lockdown: an untrusted provider gets a read/edit-only session confined to cwd.',
    },
    model: {
      type: 'string',
      description:
        'Exact model id enabled on provider_id (from TeamProviders) — not a tier.',
    },
    cwd: {
      type: 'string',
      description:
        'The working directory you PREPARED for this teammate — e.g. a git worktree you created — so parallel teammates never edit one tree. Must already exist. Empty string = the teammate works in this session\'s project directory.',
    },
    effort: {
      type: 'string',
      description:
        'Reasoning-effort tier to pin on model — one of the tiers TeamProviders lists for it. Empty string = the model\'s default effort, and the only valid value when TeamProviders lists no tiers for the model.',
    },
  },
  required: ['name', 'prompt', 'provider_id', 'model', 'cwd', 'effort'],
  additionalProperties: false,
}

function isNonEmptyString(v: unknown): v is string {
  return typeof v === 'string' && v.trim().length > 0
}

export const SpawnTeammateTool: ToolContract<SpawnTeammateInput, string> = declareTool({
  name: SPAWN_TEAMMATE_TOOL_NAME,
  skill: AGENT_TEAMS_SKILL_NAME,
  discoveryHint: 'spawn a long-running teammate session on a chosen provider and model',
  argsSchema: SCHEMA,
  // Identical: the strict subset forbids nothing this schema uses, and a
  // strict-capable provider then samples the required fields, while every
  // other provider sees the same required list in the ordinary schema.
  inputJSONSchemaStrict: SCHEMA,
  strict: true,
  description: async () => DESCRIPTION,
  parallelSafe: () => false,
  readsOnly: () => false,
  async checkInput(
    input: SpawnTeammateInput,
    _context: ToolCallContext,
  ): Promise<InputCheck> {
    for (const [field, code] of [
      ['name', 1],
      ['prompt', 2],
      ['provider_id', 3],
      ['model', 4],
    ] as const) {
      if (!isNonEmptyString((input as Record<string, unknown>)[field])) {
        return {
          result: false,
          message: `${field} is required and must be a non-empty string.`,
          errorCode: code,
        }
      }
    }
    for (const [field, code] of [
      ['cwd', 5],
      ['effort', 6],
    ] as const) {
      const v = (input as Record<string, unknown>)[field]
      if (v !== null && typeof v !== 'string') {
        return {
          result: false,
          message: `${field} is required: a string, or "" for none.`,
          errorCode: code,
        }
      }
    }
    return { result: true }
  },
  async call(input: SpawnTeammateInput, context: ToolCallContext) {
    // Both "none" fields are blank-means-absent: `""` is what the schema
    // asks for, and `null` is tolerated for older transcripts and models
    // that emit it anyway. `spawnTeammateSession` already treats a blank
    // cwd / effort as absent.
    return spawnTeammateSession(
      {
        name: input.name,
        prompt: input.prompt,
        provider_id: input.provider_id,
        child_model: input.model,
        ...(input.cwd ? { cwd: input.cwd } : {}),
        ...(input.effort ? { child_effort: input.effort } : {}),
      },
      context,
    )
  },
})
