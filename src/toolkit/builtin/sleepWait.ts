// Sleep: an interruptible wait. The tool is exposed in every preset; the
// prompt scopes *when* to use it. It takes one input, `seconds`.

import type { ToolContract, InputCheck } from '../toolContract'
import type { ToolCallContext } from '../toolCallContext'
import { declareTool } from '../toolContract'

export const PAUSE_TOOL_ID = 'Sleep'

// Upper bound on a single wait. Beyond ~1 hour the prompt cache is long
// gone and a durable scheduler (ScheduleCron / RemoteTrigger) is the
// right tool, not a held-open agent turn.
const MAX_SLEEP_SECONDS = 3600

export type SleepInput = {
  seconds: number
}

// The model-facing result is a plain prose string, like the other tools'
// results.
export type SleepOutput = string

/** How often a running Sleep checks for parked user input. */
const WAKE_POLL_MS = 250

/** Why a Sleep ended: its full duration, an abort (Stop), or user input. */
type SleepEnd = 'elapsed' | 'aborted' | 'user_input'

/**
 * Wait `ms` milliseconds, ending early if `signal` aborts (Stop) or, when
 * `shouldWake` is given, as soon as it returns true (polled every
 * {@link WAKE_POLL_MS}; checked once up front, so input parked before the
 * Sleep began wakes it at once). Never rejects — an early end is a normal,
 * expected outcome.
 */
function sleepInterruptible(
  ms: number,
  signal: AbortSignal | undefined,
  shouldWake?: () => boolean,
): Promise<SleepEnd> {
  return new Promise<SleepEnd>(resolve => {
    if (signal?.aborted) {
      resolve('aborted')
      return
    }
    if (shouldWake?.()) {
      resolve('user_input')
      return
    }
    let poll: ReturnType<typeof setInterval> | undefined
    const finish = (end: SleepEnd) => {
      clearTimeout(timer)
      if (poll !== undefined) clearInterval(poll)
      signal?.removeEventListener('abort', onAbort)
      resolve(end)
    }
    const onAbort = () => finish('aborted')
    const timer = setTimeout(() => finish('elapsed'), ms)
    if (shouldWake) {
      poll = setInterval(() => {
        if (shouldWake()) finish('user_input')
      }, WAKE_POLL_MS)
    }
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

export const SleepTool: ToolContract<SleepInput, SleepOutput> = declareTool({
  name: PAUSE_TOOL_ID,
  discoveryHint: 'wait for a specified duration; interruptible by the user',
  argsSchema: {
    type: 'object',
    properties: {
      seconds: {
        type: 'number',
        description:
          'How long to wait, in seconds. The wait can be interrupted at any time by user input.',
      },
    },
    required: ['seconds'],
  },
  description: async () => 'Wait for a specified duration',
  // Sleeping changes nothing and is safe to run alongside other tools.
  parallelSafe: () => true,
  readsOnly: () => true,
  async checkInput(input: SleepInput): Promise<InputCheck> {
    if (typeof input.seconds !== 'number' || !Number.isFinite(input.seconds)) {
      return {
        result: false,
        message: 'seconds is required and must be a finite number.',
        errorCode: 1,
      }
    }
    if (input.seconds <= 0) {
      return {
        result: false,
        message: 'seconds must be greater than 0.',
        errorCode: 2,
      }
    }
    if (input.seconds > MAX_SLEEP_SECONDS) {
      return {
        result: false,
        message: `seconds must be at most ${MAX_SLEEP_SECONDS} (1 hour). For longer waits, use a scheduled routine instead.`,
        errorCode: 3,
      }
    }
    return { result: true }
  },
  async call(input: SleepInput, context: ToolCallContext) {
    const requested = input.seconds
    const ms = Math.round(requested * 1000)
    const start = Date.now()
    // A message the user sends mid-turn wakes an in-progress Sleep call
    // and lands between this tool result and the next model
    // call (the main query loop drains it right after the tool round). Only
    // the MAIN agent drains inject messages, so a fork's Sleep — which
    // inherits `options` by reference — must not wake on them.
    const hasPendingInput = context.options.hasPendingInjectMessages
    const end = await sleepInterruptible(
      ms,
      context.cancelSource?.signal,
      hasPendingInput && !context.agentId ? hasPendingInput : undefined,
    )
    if (end === 'user_input') {
      const elapsed = ((Date.now() - start) / 1000).toFixed(1)
      return {
        data: `Sleep ended after ${elapsed}s (requested ${requested}s): the user sent a new message.`,
      }
    }
    if (end === 'aborted') {
      const elapsed = ((Date.now() - start) / 1000).toFixed(1)
      return {
        data: `Sleep interrupted after ${elapsed}s (requested ${requested}s).`,
      }
    }
    return { data: `Slept for ${requested}s.` }
  },
})
