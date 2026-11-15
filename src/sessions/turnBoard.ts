/**
 * Contract: a session's turn board (F-41) holds the plan the model keeps
 * while a turn works and the closing it leaves when the turn's work is done.
 * Runtime-owned and in-memory: it lives as long as the realm and is not
 * stored with the session. The latest accepted call is the state: a refused
 * call writes nothing. Every mutation that writes a session's state calls the
 * change listeners once, synchronously, with the session id. Reads return a
 * frozen state; callers never mutate it.
 */

export const TURN_STEP_STATUSES = ['pending', 'in_progress', 'completed'] as const
export type TurnStepStatus = (typeof TURN_STEP_STATUSES)[number]

export type TurnStep = { text: string; status: TurnStepStatus }

export type TurnClosing = {
  summary: string
  /** The one decision left to the person; absent when nothing waits on them. */
  question?: string
  /** Answers to `question`, the recommended one first. */
  replies: readonly string[]
  /** The work cannot go on until the person answers. */
  waiting: boolean
}

export type TurnState = {
  steps: readonly TurnStep[]
  closing: TurnClosing | null
}

export const MAX_TURN_STEPS = 12
export const MAX_TURN_STEP_CHARS = 160

const EMPTY: TurnState = Object.freeze({ steps: Object.freeze([]) as readonly TurnStep[], closing: null })

/** What one update asks for: steps to complete, a step to start (both
 *  1-based), and whether to move on to the next step. */
export type TurnPlanUpdate = { done?: readonly number[]; start?: number; next?: boolean }

export type TurnPlanChange =
  | { ok: true; steps: readonly TurnStep[] }
  /** A step number outside the list of `count` steps; nothing changed. */
  | { ok: false; count: number }

export class TurnBoard {
  private readonly states = new Map<string, TurnState>()
  private readonly listeners = new Set<(sessionId: string) => void>()

  read(sessionId: string): TurnState {
    return this.states.get(sessionId) ?? EMPTY
  }

  onChange(listener: (sessionId: string) => void): () => void {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  private write(sessionId: string, next: TurnState): void {
    if (next.steps.length === 0 && next.closing === null) this.states.delete(sessionId)
    else this.states.set(sessionId, Object.freeze({ steps: Object.freeze([...next.steps]), closing: next.closing }))
    for (const listener of Array.from(this.listeners)) listener(sessionId)
  }

  /** Replace the whole plan. A new plan also clears an earlier closing. */
  setPlan(sessionId: string, steps: readonly TurnStep[]): readonly TurnStep[] {
    const kept = steps.slice(0, MAX_TURN_STEPS).map(step => ({
      text: step.text.slice(0, MAX_TURN_STEP_CHARS),
      status: step.status,
    }))
    this.write(sessionId, { steps: kept, closing: null })
    return this.read(sessionId).steps
  }

  /**
   * Apply an update to the list as the board holds it: complete the `done`
   * steps, start step `start`, then for `next` complete the first step in
   * progress and start the first pending one. A `done` or `start` number that
   * is not a whole step number of the list refuses the whole update. With no
   * list, `next` alone changes nothing and is not refused.
   */
  update(sessionId: string, update: TurnPlanUpdate): TurnPlanChange {
    const { steps, closing } = this.read(sessionId)
    const done = update.done ?? []
    const numbers = update.start === undefined ? done : [...done, update.start]
    if (numbers.some(n => !Number.isInteger(n) || n < 1 || n > steps.length)) {
      return { ok: false, count: steps.length }
    }
    if (steps.length === 0) return { ok: true, steps }
    const next = steps.map(step => ({ ...step }))
    for (const number of done) next[number - 1]!.status = 'completed'
    if (update.start !== undefined) next[update.start - 1]!.status = 'in_progress'
    if (update.next) {
      const current = next.find(step => step.status === 'in_progress')
      if (current) current.status = 'completed'
      const upcoming = next.find(step => step.status === 'pending')
      if (upcoming) upcoming.status = 'in_progress'
    }
    this.write(sessionId, { steps: next, closing })
    return { ok: true, steps: this.read(sessionId).steps }
  }

  /**
   * Record the turn's closing; the steps in progress count as done. Answers
   * whether an earlier closing was still standing, which is a second close
   * with no plan change and no message from the person in between.
   */
  close(sessionId: string, closing: TurnClosing): { repeated: boolean } {
    const before = this.read(sessionId)
    const steps = before.steps.map((step): TurnStep =>
      step.status === 'in_progress' ? { ...step, status: 'completed' } : step,
    )
    this.write(sessionId, { steps, closing: { ...closing, replies: Object.freeze([...closing.replies]) } })
    return { repeated: before.closing !== null }
  }

  /**
   * The person sent a new message: the closing is answered. A message that
   * starts a new turn (`turnStarts`) also drops the plan, which belongs to the
   * turn that set it; one typed into a running turn leaves the plan alone.
   */
  personWrote(sessionId: string, turnStarts = false): void {
    const state = this.states.get(sessionId)
    if (!state) return
    if (turnStarts) {
      this.write(sessionId, EMPTY)
      return
    }
    if (state.closing === null) return
    this.write(sessionId, { steps: state.steps, closing: null })
  }

  /** Drop a session's state; a session that ended has no board. */
  forget(sessionId: string): void {
    if (this.states.has(sessionId)) this.write(sessionId, EMPTY)
  }
}

/** The realm's board: the turn tools write it, the protocol topic reads it. */
export const turnBoard = new TurnBoard()
