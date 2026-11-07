// A2UI as a JS-defined DEFERRED skill (F-1). The model draws an interface by
// writing an `<a2ui>` block of A2UI Express in its reply; the skill has no
// tools. Its prose: a2ui-description.md (skill-menu line) and, injected on
// `Skill('a2ui')`, a2ui-playbook.md followed by a2ui-express.md — the Express
// output contract generated from the Velloc catalog.

import type { HostedSkillDefinition } from '../../../browser/bridge/protocol/manifest'
import { A2UI_SKILL_NAME } from './a2uiToolNames'
import a2uiDescriptionMd from './prompts/a2ui-description.md?raw'
import a2uiPlaybookMd from './prompts/a2ui-playbook.md?raw'
import a2uiExpressMd from './prompts/a2ui-express.md?raw'

const A2UI_DESCRIPTION = a2uiDescriptionMd.trim()

export const A2UI_INSTRUCTIONS = `${a2uiPlaybookMd.trimEnd()}\n\n${a2uiExpressMd.trimEnd()}`

export const A2UI_HOSTED_SKILL: HostedSkillDefinition = {
  name: A2UI_SKILL_NAME,
  description: A2UI_DESCRIPTION,
  instructions: A2UI_INSTRUCTIONS,
  // Whether a2ui defers is decided by the session template's `deferredTools`.
  toolNames: [],
}
