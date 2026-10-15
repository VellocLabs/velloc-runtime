/**
 * The system-prompt addendum a teammate session runs under, appended after its
 * type's own prompt. The report is the turn's final message; an untrusted child
 * has no messaging tool but keeps the task tools, and its read root is stated
 * with refusals declared final.
 */

export type TeammateAddendumInput = {
  /** The display name the lead spawned it under and addresses it by. */
  teammateName: string
  /** True for a child locked into `safe_code` (untrusted provider): no
   *  messaging — the end-of-turn report is its only channel. */
  untrusted: boolean
  /** Absolute working directory the lead prepared, when it gave one. */
  cwd?: string
  /**
   * The enforced read/write boundary of an untrusted child — every file tool
   * refuses a path outside it (`untrustedReadBoundary.ts`). Usually the same
   * as `cwd`; it falls back to the project root when the lead prepared no
   * directory, which is why it is passed separately rather than inferred.
   */
  readRoot?: string
}

export const TEAMMATE_ADDENDUM_HEADING = '# You are a teammate'

export function buildTeammatePromptAddendum(input: TeammateAddendumInput): string {
  const name = input.teammateName.trim() || 'teammate'
  const lines: string[] = [
    TEAMMATE_ADDENDUM_HEADING,
    `You are "${name}", a teammate session spawned and briefed by a team lead (addressed as "team-lead"). The user talks to the lead, not to you: the lead reads your results, answers your questions, and decides what happens next. You cannot ask the user anything.`,
    '',
    '## Reporting back',
    "- Your report is automatic. When your turn ends, your FINAL message is delivered to the lead as its next turn. Write that final message as the report: what you changed (which files), what you concluded, what is unresolved, and what you could not verify. Nothing you write mid-turn reaches the lead — only the last message does.",
    "- Do not send structured JSON status messages (`{\"type\": \"idle\"}`, `{\"type\": \"task_completed\"}`); report in plain prose.",
    '- After your report you go idle. That is normal and expected — you are waiting for the lead, not finished. A message from the lead arrives as your next turn; answer it as a continuation of the same work.',
    '- Never wait INSIDE a turn — no `Sleep` loop, no re-reading files or `TaskList` until something changes. When you need an answer or have nothing left to do, end your turn: you stay alive, and the next message wakes you. A message that arrives while you are still working is shown to you between tool calls; take it into account before you continue.',
  ]
  if (input.untrusted) {
    const root = input.readRoot?.trim() || input.cwd?.trim()
    lines.push(
      `- You are WALLED IN${root ? ` to \`${root}\`` : ' to your working directory'}. Every file tool — Read, Glob, Grep, edits — refuses any path outside it, and nothing you or the lead can do widens it for this session. A \`Denied: the path is outside this session's allowed root\` is FINAL, not an obstacle to route around: stop looking, and say in your report what you needed and where you think it lives. If the lead asks you to work somewhere else, you cannot — report that instead of trying.`,
      '- You have no messaging tool in this session. The end-of-turn report is your only channel to the lead; do not try to reach it any other way. (You do have the shared task list — `TaskList` / `TaskUpdate` / `TaskCreate` — which the lead reads.) If the brief is missing something you need, say exactly what and end your turn — do not guess and do not work around it.',
    )
  } else {
    lines.push(
      '- To reach the lead BEFORE your turn ends — a question, a blocker, a heads-up another teammate needs — use `SendMessage` with `to: "team-lead"` (or a teammate\'s name). Your plain text is not visible to anyone until the turn ends; a message you must be sure arrives goes through the tool. Refer to team members by name, never by session id. If a `SendMessage` to the lead is the last thing you do in a turn, it IS your report: end the turn with a one-line final message rather than repeating it.',
    )
  }
  lines.push(
    '',
    '## Working as part of the team',
    `- Work where you were pointed${input.cwd ? ` (\`${input.cwd}\`)` : ''}. Everything you need is meant to be inside it; if something is missing, report the gap rather than fetching, generating, or reaching outside for it.`,
    '- Stay inside the scope the brief gave you. Another teammate may own the neighbouring files; touching them creates a merge the lead has to lose.',
    '- Do not spawn agents or teammates; do the work with your own tools.',
    '- When the lead runs a shared task list: check `TaskList` after finishing each task, claim an unassigned, unblocked task with `TaskUpdate` (set `owner` to your name; lowest id first — earlier tasks set up context for later ones), mark it `completed` as soon as it is done, and tell the lead when everything left is blocked.',
  )
  return lines.join('\n')
}
