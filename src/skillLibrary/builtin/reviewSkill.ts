import { addStockSkill } from '../builtinSkills'

/** Preload metadata only; execution uses the runtime's trusted invocation gateway. */
export function registerReviewSkill(): void {
  for (const name of ['code-review', 'review']) addStockSkill({
    name,
    description: 'Review local code changes, a branch, range, path or change request. Levels: low, medium, high, xhigh, max. -C <dir> reviews the repository in that folder below the session root. Read-only unless the user explicitly authorizes --fix or --comment.',
    argumentHint: '[low|medium|high|xhigh|max] [-C dir] [target] [--fix] [--comment] [--max-findings n|all|default]',
    content: 'Local code review is executed by the runtime review gateway. Preloading this description does not start a review or change preferences.',
    ...(name === 'review' ? { hiddenFromPicker: true } : {}),
  })
}
