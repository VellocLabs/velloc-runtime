// Soft-nudge text generators. The agent loop never blocks the model
// directly — at each threshold we splice a short piece of text into the
// next turn's userContext and let the model decide whether the repeat
// is intentional progress or genuine stuckness.

export type NudgeKind =
  | 'LOOP_5'
  | 'LOOP_8'
  | 'LOOP_12'
  | 'STAGNATION_5'
  | 'BUDGET_75'
  | 'LAST_STEP_FORCE_DONE'
  | 'MAX_FAILURES'

export type NudgeContext = {
  repetitionCount?: number
  windowSize?: number
  stagnantPages?: number
  turnCount?: number
  maxTurns?: number
  failureCount?: number
}

export function renderNudge(kind: NudgeKind, ctx: NudgeContext = {}): string {
  switch (kind) {
    case 'LOOP_5':
      return (
        `Heads up: you have repeated a similar action ${ctx.repetitionCount} times ` +
        `in the last ${ctx.windowSize} actions. ` +
        `If this is intentional and making progress, carry on. ` +
        `If not, it might be worth reconsidering your approach.`
      )
    case 'LOOP_8':
      return (
        `Heads up: you have repeated a similar action ${ctx.repetitionCount} times ` +
        `in the last ${ctx.windowSize} actions. ` +
        `Are you still making progress with each attempt? ` +
        `If so, carry on. Otherwise, it might be worth trying a different approach.`
      )
    case 'LOOP_12':
      return (
        `Heads up: you have repeated a similar action ${ctx.repetitionCount} times ` +
        `in the last ${ctx.windowSize} actions. ` +
        `If you are making progress with each repetition, keep going. ` +
        `If not, a different approach might get you there faster.`
      )
    case 'STAGNATION_5':
      return (
        `The page content has not changed across ${ctx.stagnantPages} consecutive actions. ` +
        `Your actions might not be having the intended effect. ` +
        `It could be worth trying a different element or approach.`
      )
    case 'BUDGET_75': {
      const used = ctx.turnCount ?? 0
      const total = ctx.maxTurns ?? 0
      const remaining = Math.max(0, total - used)
      const pct = total > 0 ? Math.round((used / total) * 100) : 0
      return (
        `BUDGET WARNING: You have used ${used}/${total} steps (${pct}%). ${remaining} steps remaining. ` +
        `If the task cannot be completed in the remaining steps, prioritize: ` +
        `(1) consolidate your results, (2) finish with what you have. ` +
        `Partial results are far more valuable than exhausting all steps with nothing saved.`
      )
    }
    case 'LAST_STEP_FORCE_DONE':
      return (
        `You reached max_steps - this is your last step. No tools are available. ` +
        `Provide your final response now. ` +
        `If the task is not yet fully finished as requested by the user, say so explicitly. ` +
        `Include everything you found out for the ultimate task in this final response.`
      )
    case 'MAX_FAILURES':
      return (
        `You failed ${ctx.failureCount ?? 'several'} times consecutively. ` +
        `No tools are available for this final response. ` +
        `Summarize what you accomplished and what remains unfinished. ` +
        `Partial results are valuable.`
      )
  }
}
