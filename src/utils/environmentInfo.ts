/**
 * Renders the `# Environment` block at the tail of the system prompt; each line
 * only when its value is known. Platform / osVersion / shell come from the host
 * (`fs.systemInfo`), with no JS-side fallback.
 */

import type { Platform } from './hostPlatform'
import { formatShellLine } from './hostPlatform'

export type EnvironmentInfo = {
  cwd?: string
  extraWorkspaceRoots?: string[]
  /** Whether the primary working directory is a git repository; omitted when
   *  not yet known. */
  gitRepository?: boolean
  platform?: Platform
  osVersion?: string
  shell?: string
  mainLoopModel?: string
}

function asBulletLines(items: ReadonlyArray<string | null | string[]>): string[] {
  const out: string[] = []
  for (const item of items) {
    if (item === null) continue
    if (Array.isArray(item)) {
      for (const sub of item) out.push(`  - ${sub}`)
      continue
    }
    out.push(`- ${item}`)
  }
  return out
}

/**
 * Build the `# Environment` block. Returns null when there is nothing
 * useful to surface — caller should skip appending in that case so the
 * cached system prefix stays byte-stable rather than carrying an empty
 * header.
 */
export function buildEnvironmentInfo(info: EnvironmentInfo): string | null {
  const items: Array<string | null | string[]> = []

  if (info.cwd && info.cwd.length > 0 && info.cwd !== '.') {
    items.push(`Primary working directory: ${info.cwd}`)
  }
  if (info.extraWorkspaceRoots && info.extraWorkspaceRoots.length > 0) {
    items.push('Additional working directories:')
    items.push(info.extraWorkspaceRoots)
  }
  if (info.gitRepository !== undefined) {
    items.push(`Git repository: ${info.gitRepository ? 'yes' : 'no'}`)
  }
  if (info.platform) {
    items.push(`Platform: ${info.platform}`)
  }
  const shellLine = formatShellLine(info.platform, info.shell)
  if (shellLine) {
    items.push(shellLine)
  }
  if (info.osVersion) {
    items.push(`OS Version: ${info.osVersion}`)
  }
  if (info.mainLoopModel) {
    items.push(`Model running this session: ${info.mainLoopModel}`)
  }

  if (items.length === 0) {
    return null
  }

  return [
    '# Environment',
    'This session is running in the following environment:',
    ...asBulletLines(items),
  ].join('\n')
}
