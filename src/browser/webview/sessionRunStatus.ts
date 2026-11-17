/**
 * The one status a session shows wherever its run state is drawn: the session
 * list row, the transcript's run-status row and the floating scroll button
 * (F-17). Derived from what the runtime publishes per session; never from the
 * reasoning stream.
 */
import type { NexusSessionActivity, NexusTurnEnding } from '../bridge/protocol/ui'
import { useSessionStatus } from './sessionStatusStore'

/**
 * - `thinking`: a model request is in flight, from submit until its reply arrives.
 * - `tools`: the reply's tool calls execute, or other work (a background
 *   task, a busy CLI) keeps the session running.
 * - `awaiting`: halted on the person; wins, as a permission ask keeps its tool in flight.
 * - `paused`: stopped with nothing pending, and Continue would resume it.
 */
export type SessionRunStatus = 'thinking' | 'tools' | 'awaiting' | 'paused'

export type SessionRunStatusInput = {
  running?: boolean
  needsAnswer?: boolean
  activity?: NexusSessionActivity
  ending?: NexusTurnEnding
  /** The open session's own resumability; absent, a stopped ending stands for it. */
  resumable?: boolean
}

/** Null when the session is done or idle: the caller shows no status. */
export function sessionRunStatusOf(input: SessionRunStatusInput): SessionRunStatus | null {
  if (input.needsAnswer) return 'awaiting'
  const activity = input.activity
  if (activity) return activity.kind === 'tool' ? 'tools' : 'thinking'
  if (input.running) return 'tools'
  const resumable = input.resumable ?? input.ending === 'stopped'
  return resumable ? 'paused' : null
}

/**
 * The status of one listed session, re-rendering only when it changes. `known`
 * adds what the caller already holds: a true `running` / `needsAnswer` from a
 * wider source, and the open session's exact resumability.
 */
export function useSessionRunStatus(
  sessionId: string | null | undefined,
  known?: Pick<SessionRunStatusInput, 'running' | 'needsAnswer' | 'resumable'>,
): SessionRunStatus | null {
  const entry = useSessionStatus(sessionId)
  // A run the caller sees before the published list does is a turn that has
  // just been submitted: its request is what is in flight.
  const justSubmitted = !!known?.running && !entry?.running
  return sessionRunStatusOf({
    running: known?.running || entry?.running,
    needsAnswer: known?.needsAnswer || entry?.needsAnswer,
    activity: entry?.activity ?? (justSubmitted ? { kind: 'responding' } : undefined),
    ending: entry?.ending,
    resumable: known?.resumable,
  })
}
