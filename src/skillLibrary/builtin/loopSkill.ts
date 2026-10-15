/**
 * Bundled `loop` skill: `/loop [interval] <prompt>` tells the model to register
 * a recurring `CronCreate` routine delivered to the current session. Always
 * enabled. The routine survives a tab close and never auto-expires; the body
 * asks the model to say so.
 */

import { addStockSkill } from '../builtinSkills'
import { SCHEDULE_ADD_TOOL_ID } from '../../toolkit/builtin/cronCreate'
import { SCHEDULE_DROP_TOOL_ID } from '../../toolkit/builtin/cronDelete'
import { SCHEDULE_LIST_TOOL_ID } from '../../toolkit/builtin/cronList'
import { SCHEDULE_CRON_TOOL_NAME } from '../../toolkit/builtin/scheduleCron'

const LOOP_FALLBACK_CADENCE = '10m'

const LOOP_HELP_TEXT = `Usage: \`/loop [interval] <prompt>\`

Re-runs a prompt on a schedule, as a background routine of this conversation.

Interval syntax: \`Ns\` seconds, \`Nm\` minutes, \`Nh\` hours, \`Nd\` days; for example \`30s\`, \`5m\`, \`2h\`, \`1d\`. The floor is one minute (seconds round up to whole minutes). When the interval is omitted, the routine runs every ${LOOP_FALLBACK_CADENCE}.

Examples:
- \`/loop 5m check whether the deploy pipeline is green\`
- \`/loop 1h summarise new issues on the tracker\`
- \`/loop 2d run the dependency audit and report anything new\`
- \`/loop watch the open PRs and tell me when one needs review\` (runs every ${LOOP_FALLBACK_CADENCE})
- \`/loop remind me to stretch every 20m\` (the trailing clause sets the interval)`

function buildPrompt(args: string): string {
  return `# Loop: register a recurring routine

Turn the input at the end of this message into \`[interval] <prompt>\` and register it with ${SCHEDULE_ADD_TOOL_ID}, so the prompt is re-run on a schedule inside this conversation.

## Parse the input

Apply these rules in order; the first that matches wins.

1. If the first token matches \`^\\d+[smhd]$\`, it is the interval and the rest is the prompt.
2. Otherwise, if the input ends with a clause "every <N><unit>" or "every <N> <unit word>" (seconds, minutes, hours, days), that clause is the interval and is stripped from the prompt. This applies only when a time expression follows "every": "check every PR" contains no interval.
3. Otherwise the interval is ${LOOP_FALLBACK_CADENCE} and the whole input is the prompt.

If the prompt is empty after parsing, show the usage line \`/loop [interval] <prompt>\` and stop. Do not call any tool.

Worked examples:
- \`5m check the build\` → interval 5m, prompt "check the build" (rule 1)
- \`2h summarise the error log\` → interval 2h, prompt "summarise the error log" (rule 1)
- \`look at the queue depth every 15 minutes\` → interval 15m, prompt "look at the queue depth" (rule 2)
- \`ping the staging server every 1h\` → interval 1h, prompt "ping the staging server" (rule 2)
- \`check every PR for a missing changelog entry\` → interval ${LOOP_FALLBACK_CADENCE}, prompt unchanged; "every PR" is not a time expression (rule 3)
- \`watch the deploy\` → interval ${LOOP_FALLBACK_CADENCE}, prompt "watch the deploy" (rule 3)
- \`10m\` → interval 10m, empty prompt: show the usage line and stop

## Interval to cron

| Interval | Cron |
|---|---|
| N minutes, N ≤ 59 | \`*/N * * * *\` |
| N minutes, N ≥ 60 | hourly, \`0 */H * * *\` with H = N/60 and H dividing 24 |
| N hours, N ≤ 23 | \`0 */N * * *\` |
| N days | \`0 0 */N * *\` |
| N seconds | round up to whole minutes (minimum one), then use the minutes row |

When the number does not divide its unit evenly (7 minutes, 90 minutes, 5 hours), the cron would fire unevenly at the wrap-around. Pick the nearest interval that does divide evenly (7m → 6m or 10m, 90m → 1h or 2h) and tell the user which one you chose before scheduling.

## Keep the prompt in the user's words

Each fire runs as a hidden turn inside this very conversation, with all of its context available. So the \`prompt\` stays close to the user's own words. Do not inflate it into a self-contained brief that names the repository, the command to run and the success criteria. That expansion is right only for \`deliver_to: "headless"\`, which starts from nothing; here it would discard the context each fire already has and freeze facts that should be re-read at every fire.

## Register, confirm, run once

1. Call ${SCHEDULE_ADD_TOOL_ID} with:
   - \`name\`: kebab-case derived from the prompt, prefixed \`loop-\`, 1–64 characters, only \`[a-z0-9_-]\`, unique among existing routines (add a short suffix on collision);
   - \`schedule\`: the cron expression from the table;
   - \`prompt\`: the prompt, near-verbatim;
   - \`deliver_to: "session"\`: this is what routes each fire into this conversation instead of a fresh agent.
2. Confirm to the user in a few lines: what will run, the routine name, the cron expression, and the cadence in words. Say that it runs in this conversation with the prompt hidden and only the answers appearing, and that it persists until the conversation is deleted; closing the tab does not stop it. Mention that ${SCHEDULE_LIST_TOOL_ID} lists it and ${SCHEDULE_DROP_TOOL_ID} cancels it.
3. Run the prompt once right now rather than waiting for the first fire.

## Limits

- ${SCHEDULE_ADD_TOOL_ID} cannot be called from inside a fired turn: a recursion guard refuses it. Never re-register a routine from one.
- A one-shot request ("at 3pm", "in two hours") is not a loop, because routines repeat until deleted. Use ${SCHEDULE_CRON_TOOL_NAME} for a single scheduled run instead.

## Raw input

${args}`
}

export function addRepeatSkill(): void {
  addStockSkill({
    name: 'loop',
    description: 'Runs a prompt on a recurring interval as a background routine of this conversation, for example /loop 5m check the deploy. Omit the interval for the default cadence.',
    useWhen: 'Use when the user wants something re-run on a schedule or polled repeatedly: status checks, watching a queue, periodic reminders. Do not use for one-off tasks or a single scheduled run.',
    argumentHint: '[interval] <prompt>',
    // `/loop` only: starting a recurring background routine is a user
    // decision, not something the model should reach for on its own.
    modelInvocation: [],
    // Always enabled: no `default` (no Features-page toggle) and no
    // `isEnabled`. See the module docstring for why.
    dynamicContent: async (args) => {
      const trimmed = args.trim()
      if (!trimmed) return LOOP_HELP_TEXT
      return buildPrompt(trimmed)
    },
  })
}
