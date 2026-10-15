// A2UI as a JS-defined DEFERRED skill (F-1). Its prose is split by audience:
// a2ui-description.md (skill-menu line), a2ui-catalog.md (system-prompt catalog,
// emitted when a2ui is visible), a2ui-playbook.md (injected on `Skill('a2ui')`).

import type { HostedSkillDefinition } from '../../../browser/bridge/protocol/manifest'
import { A2UI_SKILL_NAME, A2UI_TOOL_NAMES } from './a2uiToolNames'
import a2uiDescriptionMd from './prompts/a2ui-description.md?raw'
import a2uiPlaybookMd from './prompts/a2ui-playbook.md?raw'
import a2uiCatalogMd from './prompts/a2ui-catalog.md?raw'

const A2UI_DESCRIPTION = a2uiDescriptionMd.trim()

// Position 3 — the activation playbook ONLY (the reference moved to the
// system-prompt catalog below, mirroring the browser skill).
const A2UI_INSTRUCTIONS = a2uiPlaybookMd.trimEnd()

// Position 2 — the system-prompt catalog. The holder name follows the
// `skill.<name>.<role>` convention; loadSystemPromptHolders ships it as
// `{ h, default }`, so the host resolves a registry override (per
// provider/locale) when one exists, else the carried default content.
export const A2UI_CATALOG_HOLDER = 'skill.a2ui.catalog'
export const A2UI_SYSTEM_PROMPT_CATALOG = a2uiCatalogMd.trimEnd()

export const A2UI_HOSTED_SKILL: HostedSkillDefinition = {
  name: A2UI_SKILL_NAME,
  description: A2UI_DESCRIPTION,
  instructions: A2UI_INSTRUCTIONS,
  // Whether a2ui defers is decided SOLELY by the session template's
  // `deferredTools` (resolveDeferrableSkills) — `chat`/`code`/`agent` list a2ui,
  // so its a2ui_* tools stay out of the model's set until Skill('a2ui') /
  // ToolSearch activates them. No per-skill deferral marker.
  toolNames: [...A2UI_TOOL_NAMES],
}
