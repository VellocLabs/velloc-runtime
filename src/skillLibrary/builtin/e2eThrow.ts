/**
 * Test-only fixture skill whose dynamic body deliberately throws, producing a
 * `failed` skill-invocation event. Kept out of production: `e2eOnly: true`
 * drops it unless the e2e trace flag is set, and a sentinel session type plus
 * `userCallable: false` keep it off every listing.
 */

import { addStockSkill } from '../builtinSkills'

/** Model-facing name the event-log spec invokes. */
export const E2E_THROW_SKILL_NAME = 'e2e-throw'

/** Message the thrown error carries — the spec's `failed` row shows it. */
export const E2E_THROW_SKILL_ERROR =
  'e2e-throw: intentional skill-body failure (test fixture)'

export function registerE2eThrowSkill(): void {
  addStockSkill({
    name: E2E_THROW_SKILL_NAME,
    description:
      'E2E-only fixture: deliberately throws while building its body to exercise the Skills-tab failed-event path. Never reaches a production session.',
    // `e2eOnly` alone keeps the fixture out of every production command list
    // AND out of the model's advertised listing — no sentinel session type is
    // needed for that any more (see `getModelInvocableCommands`).
    e2eOnly: true,
    // Model-only: the scripted tool call must pass SkillRunTool.validateInput and
    // reach `call`; `userInvocation: []` keeps it out of the user slash picker.
    userInvocation: [],
    // The throw lands inside SkillRunTool.call's body-build try/catch, which
    // records a `failed` skill-invocation event before re-throwing.
    dynamicContent: async () => {
      throw new Error(E2E_THROW_SKILL_ERROR)
    },
  })
}
