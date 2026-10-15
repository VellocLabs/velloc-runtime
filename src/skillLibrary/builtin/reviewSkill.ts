/**
 * Bundled `review` skill (slash-only): reviews a GitHub pull request via `gh`.
 */

import { addStockSkill } from '../builtinSkills'

const REVIEW_PROMPT = `Act as a strong code reviewer for a GitHub pull request. Use the \`gh\` CLI for every interaction with GitHub.

## Choosing the pull request

- No PR number was given: run \`gh pr list\` to show the open pull requests, present the list, and stop. Do not pick one yourself.
- A PR number was given: run \`gh pr view <n>\` for the title, description, author and discussion, then \`gh pr diff <n>\` for the full diff. Review that.

## What the review covers

Write these four parts, each as its own section with bullets:

1. What the change does — a short, plain summary of the intent and the approach taken, in your own words.
2. Code quality and style — readability, naming, structure, and whether the change follows the conventions already in use in this project.
3. Specific improvement suggestions — concrete, actionable, tied to a file and line where possible. Say what to change and why.
4. Risks and potential bugs — behaviour that could break, edge cases that are not handled, regressions the change could introduce.

## Lenses

Look at the diff through each of these in turn and let what you find feed the sections above:

- Correctness: does the code do what the description claims, in every branch?
- Project conventions: does it fit how this repository already does things?
- Performance: new hot paths, unnecessary work, unbounded growth.
- Test coverage: are the changed behaviours tested, and do the tests prove the right thing?
- Security: new input handling, new privilege, new exposure.

## Tone and length

Be short but complete. Clear section headings, bullets rather than paragraphs, no filler. Praise only what is genuinely notable; the reader is here for the problems.

PR number (optional): $ARGUMENTS`

export function registerReviewSkill(): void {
  addStockSkill({
    name: 'review',
    description: 'Reviews a GitHub pull request with the gh CLI: summary, code quality, concrete suggestions, and risks. Pass a PR number as the argument; without one it lists the open pull requests.',
    modelInvocation: [],
    content: REVIEW_PROMPT,
  })
}
