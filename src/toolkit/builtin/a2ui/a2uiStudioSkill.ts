// The a2ui skill of a studio app's session (F-1): the same name and menu line,
// teaching the studio component set the app's entry file is written for.

import type { HostedSkillDefinition } from '../../../browser/bridge/protocol/manifest'
import { A2UI_SKILL_NAME } from './a2uiToolNames'
import a2uiDescriptionMd from './prompts/a2ui-description.md?raw'
import a2uiStudioAppMd from './prompts/a2ui-studio-app.md?raw'
import a2uiExpressStudioMd from './prompts/a2ui-express-studio.md?raw'

export const A2UI_STUDIO_INSTRUCTIONS = `${a2uiStudioAppMd.trimEnd()}\n\n${a2uiExpressStudioMd.trimEnd()}`

export const A2UI_STUDIO_HOSTED_SKILL: HostedSkillDefinition = {
  name: A2UI_SKILL_NAME,
  description: a2uiDescriptionMd.trim(),
  instructions: A2UI_STUDIO_INSTRUCTIONS,
  toolNames: [],
}
