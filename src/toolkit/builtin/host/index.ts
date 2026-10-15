// The host tools: the runtime's definitions of the tools the host executes (file,
// shell, browser). This module is the index: catalog order, the route lookup the
// bridge uses, and the availability rule a host manifest resolves against.
import type { HostedSkillDefinition } from '../../../browser/bridge/protocol/manifest'
import { BROWSER_HOST_TOOLS } from './browser'
import { EXEC_HOST_TOOLS } from './exec'
import { FILES_HOST_TOOLS } from './files'
import type { HostShells, HostToolDefinition, HostToolRoute } from './types'
import browserSkillDescriptionMd from './prompts/browser-skill-description.md?raw'
import browserSkillInstructionsMd from './prompts/browser-skill-instructions.md?raw'

export type { HostShells, HostToolCapability, HostToolDefinition, HostToolRoute } from './types'

/**
 * Every host tool, in the order the host's catalog listed them: by the
 * declaration file name across all three families (`activate_tab`, `back`,
 * `bash`, `click`, …). Consumers that care about order — the tool list sent
 * to the model — see the same sequence a catalog-serving host produced.
 */
const CATALOG_ORDER: readonly string[] = [
  'BrowserActivateTab', 'BrowserBack', 'Bash', 'BrowserClick',
  'BrowserCloseTab', 'Done', 'BrowserDownload', 'BrowserDragAndDrop',
  'Edit', 'BrowserEvaluate', 'BrowserFillForm', 'BrowserFindText',
  'Glob', 'Grep', 'BrowserHover', 'BrowserType',
  'BrowserMediaControl', 'BrowserMediaState', 'BrowserNavigate', 'PowerShell',
  'Read', 'BrowserReadElement', 'BrowserReadPage', 'BrowserScreenshot',
  'BrowserScroll', 'BrowserScrollToElement', 'BrowserSearch', 'BrowserSelectOption',
  'BrowserUpload', 'Write',
]

function inCatalogOrder(tools: readonly HostToolDefinition[]): HostToolDefinition[] {
  const index = new Map(CATALOG_ORDER.map((name, i) => [name, i] as const))
  return [...tools].sort(
    (a, b) => (index.get(a.name) ?? CATALOG_ORDER.length) - (index.get(b.name) ?? CATALOG_ORDER.length),
  )
}

export const HOST_TOOL_DEFINITIONS: readonly HostToolDefinition[] = inCatalogOrder([
  ...BROWSER_HOST_TOOLS,
  ...FILES_HOST_TOOLS,
  ...EXEC_HOST_TOOLS,
])

const ROUTE_BY_NAME: ReadonlyMap<string, HostToolRoute> = new Map(
  HOST_TOOL_DEFINITIONS.map(tool => [tool.name, tool.host] as const),
)

/** The host action behind a tool name, or undefined for a tool the host does not run. */
export function hostRouteFor(toolName: string): HostToolRoute | undefined {
  return ROUTE_BY_NAME.get(toolName)
}

/**
 * The reflection fields every browser tool's schema declares first and
 * requires. They are the runtime's — the host's browser actions do not take
 * them — so the runtime enforces them before dispatch, in schema order.
 */
const BROWSER_REFLECTION_FIELDS = ['evaluation_previous_goal', 'memory', 'next_goal'] as const

const REFLECTED_TOOLS: ReadonlySet<string> = new Set(
  HOST_TOOL_DEFINITIONS
    .filter(tool => {
      const required = (tool.parameters as { required?: unknown }).required
      return Array.isArray(required) &&
        BROWSER_REFLECTION_FIELDS.every(field => required.includes(field))
    })
    .map(tool => tool.name),
)

/**
 * Why a host tool's arguments must not reach the host, or undefined when they
 * may. Only the fields the runtime adds are checked here; the host validates
 * the action's own parameters. The message is the `invalid_args` detail the
 * model reads: `missing required string '<field>'`.
 */
export function hostToolArgsError(
  toolName: string,
  args: Record<string, unknown>,
): string | undefined {
  if (!REFLECTED_TOOLS.has(toolName)) return undefined
  const missing = BROWSER_REFLECTION_FIELDS.find(field => typeof args[field] !== 'string')
  return missing === undefined ? undefined : `missing required string '${missing}'`
}

export const BASH_HOST_TOOL = 'Bash'
export const POWERSHELL_HOST_TOOL = 'PowerShell'

/**
 * The host tools a host offers: those whose family the manifest advertises,
 * and of the shell tools only the ones `exec.listShells` reported runnable.
 * A host without `exec` offers no shell tool; one that has not answered
 * `listShells` (shells undefined) offers none either — the runtime never
 * advertises a shell the host would refuse.
 */
export function hostedToolsForHost(
  capabilities: readonly string[],
  shells: HostShells | undefined,
): HostToolDefinition[] {
  const offered = new Set(capabilities)
  return HOST_TOOL_DEFINITIONS.filter(tool => {
    if (!offered.has(tool.host.capability)) return false
    if (tool.name === BASH_HOST_TOOL) return shells?.bash === true
    if (tool.name === POWERSHELL_HOST_TOOL) return shells?.powershell === true
    return true
  })
}

function trimOneTrailingNewline(text: string): string {
  return text.endsWith('\n') ? text.slice(0, -1) : text
}

export const BROWSER_SKILL_NAME = 'browser'

/**
 * The browser skill: the one host-declared skill, now a runtime definition.
 * Its tools are every browser tool bound to it (`skill: 'browser'`), in
 * catalog order — the same list the host's `listSkills` produced.
 */
export const BROWSER_HOSTED_SKILL: HostedSkillDefinition = {
  name: BROWSER_SKILL_NAME,
  description: trimOneTrailingNewline(browserSkillDescriptionMd),
  instructions: trimOneTrailingNewline(browserSkillInstructionsMd),
  toolNames: HOST_TOOL_DEFINITIONS.filter(tool => tool.skill === BROWSER_SKILL_NAME).map(
    tool => tool.name,
  ),
}

/** The skills a host's tool set brings with it. */
export function hostedSkillsForHost(
  tools: readonly Pick<HostToolDefinition, 'skill'>[],
): HostedSkillDefinition[] {
  return tools.some(tool => tool.skill === BROWSER_SKILL_NAME) ? [BROWSER_HOSTED_SKILL] : []
}
