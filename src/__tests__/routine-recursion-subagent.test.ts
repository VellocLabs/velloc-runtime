/**
 * Recursion guard, the sub-agent (and teammate) hop: `routineOriginId` survives a spawn that clears
 * `isHeadless`/`routineId`. Security-shaped: otherwise only `shouldAvoidPermissionPrompts` stands in the way, which
 * an allow-rule defeats. Propagation is in `sub-agent-spawn.test.ts`.
 */
import { describe, expect, it } from 'vitest'
import {
  isRoutineOriginated,
  routineOriginIdOf,
  UNATTRIBUTED_ROUTINE_ORIGIN,
} from '../routines/routineOrigin'
import { ScheduleAddTool } from '../toolkit/builtin/cronCreate'
import { ScheduleCronTool } from '../toolkit/builtin/scheduleCron'
import { RoutineFireTool } from '../toolkit/builtin/remoteTrigger'
import type { ToolCallContext } from '../toolkit/toolCallContext'
import type { InputCheck } from '../toolkit/toolContract'
import {
  beginRoutineFireTurn,
  endRoutineFireTurn,
} from '../routines/routineTurnScope'
import {
  NoopPlatformCapabilities,
  createEmptyAppState,
  createNoopToolUseContext,
} from '../runtime/testing/noopAdapters'

/** Extra init-payload fields that ride the runtime's `{ ...payload }` spread
 *  into `options` and so aren't on the static options type (same cast the
 *  tools themselves use). */
type RoutineContextFields = {
  isHeadless?: boolean
  routineId?: string
  routineOriginId?: string
}

function ctx(
  extra: RoutineContextFields = {},
  sessionId = 'session-1',
): ToolCallContext {
  const c = createNoopToolUseContext({
    tools: [],
    platformCapabilities: new NoopPlatformCapabilities(),
    appState: createEmptyAppState(),
    setAppState: () => {},
    sessionId,
  })
  Object.assign(c.options as unknown as RoutineContextFields, extra)
  return c
}

/** `Tool.validateInput` is optional on the interface; every tool under test
 *  defines it, so a missing one is a test-setup failure, not a skip. */
async function validate(
  tool: {
    checkInput?: (
      input: never,
      context: ToolCallContext,
    ) => Promise<InputCheck>
  },
  input: unknown,
  context: ToolCallContext,
): Promise<InputCheck> {
  const validateInput = tool.checkInput
  if (!validateInput) throw new Error('tool under test has no validateInput')
  return validateInput(input as never, context)
}

/** Narrow a result to the denial arm so `message` / `errorCode` are readable
 *  (an `expect` call is not a type guard). */
function expectDenied(
  result: InputCheck,
): { result: false; message: string; errorCode: number } {
  expect(result.result).toBe(false)
  if (result.result !== false) throw new Error('expected a denial')
  return result
}

// The three registering tools, with the minimum VALID input that reaches the
// guard (every earlier validation branch must pass, or a test would "deny" for
// the wrong reason) and the error code each has always used for a denial.
const REGISTERING_TOOLS = [
  {
    name: 'CronCreate',
    tool: ScheduleAddTool,
    input: {
      name: 'nightly-digest',
      schedule: '0 3 * * *',
      prompt: 'summarize the day',
    },
    errorCode: 6,
  },
  {
    name: 'ScheduleCron',
    tool: ScheduleCronTool,
    input: { name: 'one-shot', at: 'in 30m', prompt: 'check the deploy' },
    errorCode: 6,
  },
  {
    name: 'RemoteTrigger.register',
    tool: RoutineFireTool,
    input: {
      action: 'register',
      name: 'on-push',
      trigger_type: 'manual',
      prompt: 'run the smoke tests',
    },
    errorCode: 8,
  },
] as const

describe('routineOriginIdOf / isRoutineOriginated', () => {
  it('an ordinary user session has no routine origin', () => {
    expect(routineOriginIdOf({})).toBeUndefined()
    expect(routineOriginIdOf({ isHeadless: false })).toBeUndefined()
    expect(isRoutineOriginated({ sessionId: 'plain' })).toBe(false)
  })

  it('a headless routine session reports its routineId (the guard arm that already existed)', () => {
    expect(routineOriginIdOf({ isHeadless: true, routineId: 'cron-7' })).toBe(
      'cron-7',
    )
  })

  it('a headless session with NO routineId still counts as routine-originated', () => {
    // Attribution is optional; the guard is a boolean. Degrading to "not a
    // routine" because the id is missing would reopen the hole.
    expect(routineOriginIdOf({ isHeadless: true })).toBe(
      UNATTRIBUTED_ROUTINE_ORIGIN,
    )
  })

  it('an inherited routineOriginId counts even with isHeadless cleared — the sub-agent shape', () => {
    // Exactly the context a worker-hosted sub-agent of a routine gets:
    // isHeadless/routineId stripped by SubAgentCoordinator, origin inherited.
    expect(
      routineOriginIdOf({ routineOriginId: 'cron-7', isHeadless: undefined }),
    ).toBe('cron-7')
    expect(isRoutineOriginated({ routineOriginId: 'cron-7' })).toBe(true)
  })

  it('ignores an empty-string origin rather than treating it as truthy-by-presence', () => {
    expect(routineOriginIdOf({ routineOriginId: '' })).toBeUndefined()
    // …but a blank origin on a headless session still falls through to the
    // isHeadless arm.
    expect(routineOriginIdOf({ routineOriginId: '', isHeadless: true })).toBe(
      UNATTRIBUTED_ROUTINE_ORIGIN,
    )
  })

  it('tolerates a null/undefined options bag', () => {
    expect(routineOriginIdOf(undefined)).toBeUndefined()
    expect(routineOriginIdOf(null)).toBeUndefined()
  })

  it('a SESSION-delivered fire turn reads as an origin via the turn-scope marker', () => {
    // The third root (merge-time composition with routine-session-delivery):
    // a session fire marks the TURN, not the payload, so the predicate reads
    // routineTurnScope by session id. This is what lets an Agent spawn made
    // during such a turn stamp its sub-agent — and the guard deny inside it.
    beginRoutineFireTurn('sess-fire', 'cron-9')
    try {
      expect(routineOriginIdOf({ sessionId: 'sess-fire' })).toBe('cron-9')
      expect(isRoutineOriginated({ sessionId: 'sess-fire' })).toBe(true)
      // Scoped: a different session is untouched.
      expect(routineOriginIdOf({ sessionId: 'other' })).toBeUndefined()
    } finally {
      endRoutineFireTurn('sess-fire')
    }
    expect(routineOriginIdOf({ sessionId: 'sess-fire' })).toBeUndefined()
  })
})

describe('recursion guard — the three registering tools', () => {
  for (const { name, tool, input, errorCode } of REGISTERING_TOOLS) {
    it(`${name} is allowed in an ordinary session`, async () => {
      const r = await validate(tool, input, ctx())
      expect(r.result, `${name} must stay usable outside routine runs`).toBe(
        true,
      )
    })

    it(`${name} is denied inside a headless routine session (pre-existing arm)`, async () => {
      const denial = expectDenied(
        await validate(tool, input, ctx({ isHeadless: true, routineId: 'cron-7' })),
      )
      expect(denial.errorCode).toBe(errorCode)
      expect(denial.message).toMatch(/recursion guard/i)
    })

    it(`${name} is denied inside a SUB-AGENT spawned by a routine (the closed hole)`, async () => {
      // The sub-agent's own context: no isHeadless, no routineId, its own
      // sessionId — only the inherited origin marks it.
      const r = await validate(
        tool,
        input,
        ctx({ routineOriginId: 'cron-7' }, 'subagent-abc'),
      )
      expect(
        r.result,
        `${name} must refuse a routine's sub-agent, not just the routine`,
      ).toBe(false)
      const denial = expectDenied(r)
      expect(denial.errorCode).toBe(errorCode)
      expect(denial.message).toMatch(/recursion guard/i)
      // The denial has to say WHY, or the model reads it as a transient fault
      // and retries the registration in a loop.
      expect(denial.message).toMatch(/sub-agent/i)
    })
  }

  it('the guard does not block RemoteTrigger actions other than register', async () => {
    // Only registration recurses. A routine's sub-agent may still fire or
    // delete an EXISTING trigger — deny=register is the whole rule, and
    // widening it silently would be a regression of its own.
    const r = await validate(
      RoutineFireTool,
      { action: 'fire', id: 'rt-1' },
      ctx({ routineOriginId: 'cron-7' }, 'subagent-abc'),
    )
    expect(r.result).toBe(true)
  })
})
