/**
 * Bundled `simplify` skill: three parallel review agents over the current diff,
 * then fix what they find.
 */

import { SPAWN_TOOL_ID } from '../../toolkit/builtin/subagentLaunch'
import { addStockSkill } from '../builtinSkills'

/** Title of the section appended when the user passes extra focus text. */
export const EXTRA_FOCUS_HEADING = '## Extra attention'

const CLEANUP_REVIEW_BRIEF = `# Tidy pass: review the diff, then fix it

Run a quality pass over the code that changed: find reuse, design and performance problems, then fix them directly. The goal is to leave the change cleaner than you found it.

## Step 1: Collect the changes

Run \`git diff\` to collect the changes. If anything is staged, run \`git diff HEAD\` instead so staged and unstaged edits are both included. When git reports no changes, review the files the user named, or the files you edited earlier in this conversation, and say which set you are reviewing.

## Step 2: Three reviewers at once

Launch three reviewers in a single ${SPAWN_TOOL_ID} message so they run concurrently; give each one the whole diff and one of the briefs below. Every reviewer reports its findings with file, line and a one-line proposed fix.

### Reviewer A: Reuse

Look for code that re-implements something this repository already has. Search the utility and shared directories and the neighbours of the changed files. Flag new functions that duplicate an existing one, and inline logic that an existing helper already covers: string munging, path handling, environment checks, hand-written type guards. For every finding, name the helper to use instead.

### Reviewer B: Design smells

Look for structure that will age badly:
- state that is duplicated or derivable from other state, and effects that could be direct calls;
- parameter lists that keep growing where the shape should be restructured;
- near-copies of code that want a single abstraction;
- internals leaking across module or component boundaries;
- raw strings where a constant, a union or a branded type already exists;
- wrapper elements that add no layout;
- comments that narrate what the code does or how the change came about: delete them, and keep only a non-obvious why.

### Reviewer C: Cost and performance

Look for wasted work:
- repeated computation, reads or requests, and N+1 patterns;
- sequential steps that could run concurrently;
- new blocking work on startup or on hot paths;
- store updates fired unconditionally from timers or handlers with no change check, and wrapper functions that defeat a caller's same-reference no-op signal;
- existence checks before an operation: operate and handle the error instead;
- unbounded growth, missing cleanup, listener leaks;
- reading or loading far more than is needed.

## Step 3: Apply the fixes

Wait for all three reviewers. Merge their findings, drop duplicates, and fix each one directly in the code. When a finding is a false positive or not worth the change, note it in one line and move on without debate. Finish with a brief summary of what you fixed, or a plain statement that nothing needed changing.`

export function addCleanupSkill(): void {
  addStockSkill({
    name: 'simplify',
    description: 'Reviews your changed code for reuse, design and performance cleanups and fixes what it finds: duplicated helpers, design smells, and wasted work.',
    // Auto-registers feature `bundled-skills.simplify`. The skill's
    // `description` above doubles as the settings-UI description; the
    // overrides below polish the feature-toggle headline only.
    default: true,
    featureTitle: 'Simplify — code-quality review',
    featureDescription: 'Adds the simplify skill: three parallel reviewers (reuse, design smells, cost and performance) over the current diff, followed by the fixes.',
    // It spawns sub-agents, so it requires the `subagent` group (`requiredTools`).
    modelInvocation: ['agent', 'code'],
    userInvocation: ['agent', 'code', 'team'],
    requiredTools: ['Agent'],
    // dynamicContent appends the extra-focus section only when args are
    // non-empty.
    dynamicContent: async (args) => {
      let prompt = CLEANUP_REVIEW_BRIEF
      if (args) {
        prompt += `\n\n${EXTRA_FOCUS_HEADING}\n\n${args}`
      }
      return prompt
    },
  })
}
