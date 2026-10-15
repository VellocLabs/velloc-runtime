/**
 * Model-facing denial texts for permission refusals.
 *
 * These are the strings the MODEL sees as the `tool_result` when a permission
 * check refuses a call, so their wording is load-bearing: the workaround
 * guidance is what keeps the model from either giving up silently or brute
 * -forcing around the denial.
 */

export const REFUSAL_NEXT_STEP_HINT =
  `IMPORTANT: You *may* attempt to accomplish this action using other tools that might naturally be used to accomplish this goal, ` +
  `e.g. using head instead of cat. But you *should not* attempt to work around this denial in malicious ways, ` +
  `e.g. do not use your ability to run tests to execute non-test actions. ` +
  `You should only try to work around this restriction in reasonable ways that do not attempt to bypass the intent behind this denial. ` +
  `If you believe this capability is essential to complete the user's request, STOP and explain to the user ` +
  `what you were trying to do and why you need this permission. Let the user decide how to proceed.`

/**
 * A permission prompt was required but this context cannot show one
 * (background / headless / async sub-agent). We auto-deny rather than block
 * on a dialog nobody can answer.
 */
export function autoRejectMessage(toolName: string): string {
  return `Permission to use ${toolName} has been denied. ${REFUSAL_NEXT_STEP_HINT}`
}

/** `dontAsk` mode converts every would-be prompt into a denial. */
export function dontAskRejectMessage(toolName: string): string {
  return `Permission to use ${toolName} has been denied because prompts are disabled (don't ask mode). ${REFUSAL_NEXT_STEP_HINT}`
}
