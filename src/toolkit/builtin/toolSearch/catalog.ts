/**
 * Which tools the deferred-tool loader may surface, and the catalog text
 * listing them.
 */
import type { ToolContract, ToolContractList } from '../../toolContract'
import {
  groupUnitForTool,
  isSkillDeferred,
  isSkillSealed,
  type DeferralKey,
} from '../../run/deferredTools'

/** The unit (skill, else tool group) that owns a tool under `key`. */
export function owningUnit(tool: ToolContract, key: DeferralKey): string | undefined {
  return tool.skill ?? groupUnitForTool(tool.name, key)
}

/** True when either of the tool's units is sealed under `key`. */
export function isToolSealed(tool: ToolContract, key: DeferralKey): boolean {
  return (
    isSkillSealed(tool.skill, key) ||
    isSkillSealed(groupUnitForTool(tool.name, key), key)
  )
}

/** Deferred and not sealed: the tools the loader may list and load. */
export function loadableTools(tools: ToolContractList, key: DeferralKey): ToolContract[] {
  return tools.filter(tool => {
    if (isToolSealed(tool, key)) return false
    return (
      isSkillDeferred(tool.skill, key) ||
      isSkillDeferred(groupUnitForTool(tool.name, key), key)
    )
  })
}

export const EMPTY_CATALOG_TEXT = 'No deferred tools are currently available.'
const CATALOG_HEADER =
  'Deferred tools (names known, schemas NOT loaded — call ToolSearch to load before invoking):'

/** Render the catalog of loadable tools in tool-list order. */
export function renderCatalog(tools: ToolContractList, key: DeferralKey): string {
  const loadable = loadableTools(tools, key)
  if (loadable.length === 0) return EMPTY_CATALOG_TEXT
  const lines = loadable.map(t =>
    t.discoveryHint ? `- ${t.name} — ${t.discoveryHint}` : `- ${t.name}`,
  )
  return [CATALOG_HEADER, ...lines].join('\n')
}
