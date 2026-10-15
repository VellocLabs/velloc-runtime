// Renders two system-prompt sections: `system-prompt-tools` (browser prose for
// the `{{system-prompt-tools}}` slot) and `using-your-tools` (the
// `{{TOOL_CATALOG}}` block, fetch+split / flash path only). The .md files
// beside this module are the only copies; `promptSectionRenderer.test.ts`
// pins the output.

import { BROWSER_SYSTEM_PROMPT_CATALOG } from '../../toolkit/builtin/glic/browserSkillCatalog'
import fileShellToolsMd from './file-shell-tools.md?raw'
import parallelismMd from './parallelism.md?raw'
import skillsMd from './skills.md?raw'
import systemPromptToolsMd from './system-prompt-tools.md?raw'
import taskTrackingMd from './task-tracking.md?raw'

export type PromptSectionName = 'system-prompt-tools' | 'using-your-tools'

export const PROMPT_SECTION_NAMES: readonly PromptSectionName[] = [
  'using-your-tools',
  'system-prompt-tools',
]

/**
 * The C++ codegen stripped exactly one trailing newline from each .md
 * (`generate.py` `_resolve_prose_field` / `emit_system_prompt_tools`), and the
 * compiler normalised CRLF source line endings to LF. Same here.
 */
function asEmbedded(md: string): string {
  const lf = md.replace(/\r\n/g, '\n')
  return lf.endsWith('\n') ? lf.slice(0, -1) : lf
}

export const SYSTEM_PROMPT_TOOLS_CONTENT = asEmbedded(systemPromptToolsMd)
export const FILE_SHELL_TOOLS_CONTENT = asEmbedded(fileShellToolsMd)
export const TASK_TRACKING_CONTENT = asEmbedded(taskTrackingMd)
export const SKILLS_CONTENT = asEmbedded(skillsMd)
export const PARALLELISM_CONTENT = asEmbedded(parallelismMd)
/** `kBrowserToolsContent` — the guest copy, already trimmed of its newline. */
export const BROWSER_TOOLS_CONTENT = BROWSER_SYSTEM_PROMPT_CATALOG

/**
 * `kBrowserToolWireNames`: every tool in the C++ `browser_tool/` category.
 * The C++ list is generated from the declarations; the browser tools are all
 * `Browser*` plus `Done`, so the same probe the rest of the guest uses
 * (`isBrowserToolName`) plus `Done` reproduces it without a list to drift.
 */
function isBrowserCategoryTool(name: string): boolean {
  return name.startsWith('Browser') || name === 'Done'
}

/** `kFileShellToolWireNames`: the `file_tool/` + `process_tool/` categories. */
const FILE_SHELL_TOOL_NAMES: ReadonlySet<string> = new Set([
  'Bash',
  'BashOutput',
  'Edit',
  'Glob',
  'Grep',
  'PowerShell',
  'Read',
  'Write',
])

// JS-only tools the C++ renderer checked by literal name.
const TODO_WRITE_NAME = 'TodoWrite'
const SKILL_NAME = 'Skill'

function renderUsingYourTools(activeToolIds: readonly string[]): string {
  const enabled = new Set(activeToolIds)
  const sections: string[] = []
  if (activeToolIds.some(isBrowserCategoryTool)) {
    sections.push(BROWSER_TOOLS_CONTENT)
  }
  if (activeToolIds.some(n => FILE_SHELL_TOOL_NAMES.has(n))) {
    sections.push(FILE_SHELL_TOOLS_CONTENT)
  }
  if (enabled.has(TODO_WRITE_NAME)) sections.push(TASK_TRACKING_CONTENT)
  if (enabled.has(SKILL_NAME)) sections.push(SKILLS_CONTENT)
  if (sections.length === 0) return ''
  // Always-on trailer, emitted only alongside another section.
  sections.push(PARALLELISM_CONTENT)
  // Header + sections joined by a single newline — the sections carry no
  // trailing newline, so this is NOT a blank line between them (the C++
  // `out.append("\n")` join, reproduced exactly).
  return `# Using your tools\n\n${sections.join('\n')}`
}

/**
 * Render a named prompt section. Pure and synchronous. Unknown names render
 * empty, as the C++ renderer did.
 */
export function renderPromptSection(params: {
  name: string
  enabledToolNames: readonly string[]
}): { text: string } {
  switch (params.name) {
    case 'using-your-tools':
      return { text: renderUsingYourTools(params.enabledToolNames) }
    case 'system-prompt-tools':
      // Cross-cutting prose; the tool set is ignored (as in C++).
      return { text: SYSTEM_PROMPT_TOOLS_CONTENT }
    default:
      return { text: '' }
  }
}
