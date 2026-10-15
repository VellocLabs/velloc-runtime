/**
 * Bundled `batch` skill (slash-only): decomposes a large change into
 * independent units and spawns one background sub-agent per unit, each in its
 * own git worktree. `dynamicContent` refuses a missing instruction and a cwd
 * outside a git repo.
 */

import { SPAWN_TOOL_ID } from '../../toolkit/builtin/subagentLaunch'
import { ASK_TOOL_ID } from '../../toolkit/builtin/askUser'
import { PLAN_ON_TOOL_ID } from '../../toolkit/builtin/planEnter'
import { PLAN_OFF_TOOL_ID } from '../../toolkit/builtin/planExit'
import { SKILL_TOOL_NAME } from '../../prompting/skillToolName'
import { fsForContext, type RuntimeFs } from '../../utils/fs/runtimeFs'
import { addStockSkill } from '../builtinSkills'

const MIN_AGENTS = 5
const MAX_AGENTS = 30

const FANOUT_WORKER_BRIEF = `Once your unit is implemented, finish it with these steps, in order:

1. Tidy the change: call the ${SKILL_TOOL_NAME} tool with \`skill: "simplify"\` and apply what it finds.
2. Run the project's unit tests. Find the command in the package scripts, the Makefile or the usual runner for this language; fix every failure your change introduced.
3. Prove the change works end to end by following the verification recipe in this brief. If the recipe says this unit is exempt, skip this step and say that you skipped it.
4. Commit with a clear message, push the branch, and open a PR with \`gh pr create\` and a descriptive title. If \`gh\` is not installed or the push fails, say so plainly.
5. Make the very last line of your final message exactly \`PR: <url>\`, or \`PR: none — <reason>\` when no PR exists.`

/** Builds the `/batch` prompt for one instruction. */
function buildPrompt(instruction: string): string {
  return `# Coordinator brief: one large change, many parallel workers

You coordinate a change that is too big for a single agent. You plan it, split it into independent units, hand each unit to a background worker in its own git worktree, and track the pull requests that come back. You do not implement units yourself.

## The instruction

${instruction}

## Stage 1: Plan in plan mode

Call ${PLAN_ON_TOOL_ID} before anything else. Then:

1. **Research.** Launch one or more foreground subagents (you need their results before you can plan) to find every file, pattern and call site the instruction touches, and the local conventions that govern them: naming, test layout, lint and formatting, commit style.

2. **Split into units.** Divide the work into between ${MIN_AGENTS} and ${MAX_AGENTS} units. Every unit must be:
   - doable alone, in its own git worktree, without edits outside its slice;
   - mergeable on its own, never waiting on a sibling PR;
   - similar in size to the other units.
   Scale the count to the real size of the change: a handful of files sits near ${MIN_AGENTS}, hundreds of files near ${MAX_AGENTS}. Slice by directory or module, not by arbitrary lists of files.

3. **Decide how a worker proves its change.** Unit tests alone do not count. Look for something concrete in this repository:
   - a browser-automation skill or tool for UI flows (drive the flow, take a screenshot);
   - a terminal or CLI runner skill for command-line behaviour;
   - a dev server plus HTTP calls for APIs;
   - an existing integration or end-to-end suite.
   If nothing concrete turns up, ask the user with ${ASK_TOOL_ID}: offer two or three specific options you found in the repository, plus the option that unit tests suffice. This step cannot be skipped, because workers run in the background and cannot ask the user anything. Write the answer down as a recipe of short executable steps, including any setup.

4. **Write the plan file.** It holds: the research summary; the numbered units, each with a title, its files or directories, and a one-line description of the change; the verification recipe, or the reason to skip it; and the exact instructions every worker will share.

5. Call ${PLAN_OFF_TOOL_ID} to get the plan approved.

## Stage 2: Launch the workers

After approval, launch one background agent per unit with ${SPAWN_TOOL_ID}. Every call uses \`isolation: "worktree"\` and \`run_in_background: true\`. Put all the calls in one message so the workers start together. Use \`subagent_type: "general-purpose"\` unless a better-suited type exists.

Each worker prompt is self-contained, because the worker sees nothing else. Include:
- the overall goal;
- this unit's title, files and change, copied from the plan;
- the conventions the research found;
- the verification recipe, or the reason this unit skips it;
- the worker brief below, reproduced exactly inside a fenced block.

\`\`\`
${FANOUT_WORKER_BRIEF}
\`\`\`

## Stage 3: Track the results

Show a markdown table with the columns #, Unit, Status, PR. Every row starts as running with an empty PR cell. As each worker's completion notice arrives, read its final \`PR: <url>\` line, set the status to done or failed, and fill in the link. Keep a one-line note for every unit that ended without a PR. When all notices are in, show the final table and a one-line tally such as "N of M units opened PRs".`
}

/** Guard message — appears when the user types `/batch` with no args. */
const FANOUT_NEEDS_GOAL_TEXT = `\`/batch\` needs an instruction: describe the sweeping change you want split across parallel workers.

Examples:
- \`/batch migrate every API handler from callbacks to async/await\`
- \`/batch replace the hand-rolled console logging under packages/ with the shared logger\`
- \`/batch add JSDoc to every exported function in src/core\`

Give me the change and I will research it, propose the split for your approval, then launch the workers.`

/** Guard message — appears when /batch is run outside a git repo. */
const FANOUT_NEEDS_REPO_TEXT = `\`/batch\` only works inside a git repository. Every unit runs in its own isolated git worktree and ends by opening a pull request, so without a repository there is nothing to branch from and nowhere to push.

Run \`git init\` here (and add a remote), or change into a folder that is already a repository, then run \`/batch\` again.`

/**
 * Answers "are we inside a git repo?". Nexus has no child-process
 * primitive in the SharedWorker, so this probes the cwd's `.git` directory
 * via the bridge fs instead of running git.
 */
async function isCwdGitRepo(cwd: string, fs: RuntimeFs): Promise<boolean> {
  // Walk up the directory tree looking for `.git` with a small loop. Cap at 12 levels
  // to bound the walk (deeper-than-12 nested git repos are pathological).
  let current = cwd
  for (let i = 0; i < 12; i++) {
    try {
      // The fs facade exposes `stat` on some implementations; fall back
      // to `readdir` if stat is unavailable. Either succeeds when the
      // `.git` directory exists.
      const gitPath = current.endsWith('/') || current.endsWith('\\')
        ? `${current}.git`
        : `${current}/.git`
      // readdir throws ENOENT if .git is missing → caught below.
      await fs.readdir(gitPath)
      return true
    } catch {
      // Strip last segment and continue.
      const lastSepIdx = Math.max(
        current.lastIndexOf('/'),
        current.lastIndexOf('\\'),
      )
      if (lastSepIdx <= 0) return false
      const next = current.slice(0, lastSepIdx)
      if (next === current) return false
      current = next
    }
  }
  return false
}

export function addFanoutSkill(): void {
  addStockSkill({
    name: 'batch',
    description: 'Splits a large, repetitive change into independent units and runs one background worker per unit in parallel, each in its own git worktree and ending in a pull request. Use for sweeping edits across many files or modules.',
    useWhen: 'Use for a sweeping, repository-wide change that would take one agent far too long and divides cleanly by directory or module: migrations, renames, mass annotations. Not for small or tightly coupled changes.',
    argumentHint: '<instruction>',
    // No model invocation → batch is `/batch` only.
    modelInvocation: [],
    // Auto-registers feature `bundled-skills.batch`.
    default: true,
    featureTitle: 'Batch — parallel workers for large changes',
    featureDescription: 'Adds the /batch command: plans a sweeping change, splits it into independent units, and runs one background worker per unit in its own worktree, each opening a PR.',
    // Offered only where it can run: it requires the `plan` and `subagent` groups,
    // also stated as data for the `templateSkillsAllowlist` guard.
    userInvocation: ['agent', 'code', 'team'],
    requiredTools: ['Agent', 'EnterPlanMode', 'ExitPlanMode'],
    // dynamicContent builds the prompt at invocation time, behind both
    // guards (missing instruction + not-a-git-repo).
    dynamicContent: async (args, ctx) => {
      const instruction = args.trim()
      if (!instruction) {
        return FANOUT_NEEDS_GOAL_TEXT
      }
      const cwd = ctx.options.cwd ?? '.'
      const isGit = await isCwdGitRepo(cwd, fsForContext(ctx))
      if (!isGit) {
        return FANOUT_NEEDS_REPO_TEXT
      }
      return buildPrompt(instruction)
    },
  })
}
