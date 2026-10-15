/**
 * Agent-definition registry: named subagents from plugins, user
 * (`~/.velloc/agents`, `~/.claude/agents`) and project (`<cwd>/.velloc/agents`)
 * dirs. An agent is a markdown file (frontmatter `name`, `description`, `tools`,
 * `model`; the body is its system prompt). Plugin agents register as
 * `<pluginName>:<ns…>:<name>`; user/project agents stay bare.
 */

import type { AgentProfile } from '../runtime/RuntimeTypes'
import type { RuntimeConfig } from '../runtime/interfaces/RuntimeConfig'
import { processFs, type RuntimeFs } from '../utils/fs/runtimeFs'
import { visitMarkdownFiles } from '../pluginHost/markdownTree'
import { RUNTIME_DIR_NAME } from '../branding/runtimeDir'
import {
  basenameRuntimePath,
  extnameRuntimePath,
  joinRuntimePath,
} from '../utils/runtimePaths'

export type AgentSource = 'plugin' | 'user' | 'project' | 'built-in'

/**
 * Concrete agent definition. Structurally satisfies the loose
 * `AgentProfile` (`{ name?, [k] }`) so it slots into
 * `agentDefinitions.activeAgents` without a cast.
 */
export type AgentDefinitionFull = AgentProfile & {
  name: string
  description: string
  systemPrompt: string
  /** Tool-name allowlist; when set, the fork only sees these tools. */
  tools?: string[]
  /**
   * Tool-name denylist; when set, the fork never sees these tools. Applied
   * after `tools`. The read-only built-ins (Explore/Plan) use this to drop
   * the mutating tools while still inheriting the dynamic C++/MCP tool set —
   * an allowlist can't, because it can't name tools it doesn't know about.
   */
  disallowedTools?: string[]
  /** Model override for the fork; defaults to the parent's model. */
  model?: string
  source: AgentSource
  pluginName?: string
}

function stripWrappingQuotes(value: string): string {
  if (value.length < 2) return value
  const first = value[0]
  const last = value[value.length - 1]
  if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
    return value.slice(1, -1)
  }
  return value
}

function parseStringList(value: string | undefined): string[] {
  if (!value) return []
  const trimmed = value.trim()
  if (!trimmed) return []
  if (trimmed.startsWith('[') && trimmed.endsWith(']')) {
    return trimmed
      .slice(1, -1)
      .split(',')
      .map(part => part.trim().replace(/^["']|["']$/g, ''))
      .filter(part => part.length > 0)
  }
  return trimmed
    .split(/[\s,]+/)
    .map(part => part.trim().replace(/^["']|["']$/g, ''))
    .filter(part => part.length > 0)
}

function splitYamlHeader(content: string): {
  frontmatter: Record<string, string>
  body: string
} {
  if (!content.startsWith('---\n')) {
    return { frontmatter: {}, body: content }
  }
  const closingIndex = content.indexOf('\n---\n', 4)
  if (closingIndex === -1) {
    return { frontmatter: {}, body: content }
  }
  const rawFrontmatter = content.slice(4, closingIndex)
  const body = content.slice(closingIndex + 5)
  const frontmatter: Record<string, string> = {}
  for (const line of rawFrontmatter.split(/\r?\n/)) {
    const separatorIndex = line.indexOf(':')
    if (separatorIndex === -1) continue
    const key = line.slice(0, separatorIndex).trim()
    const value = stripWrappingQuotes(line.slice(separatorIndex + 1).trim())
    if (key) frontmatter[key] = value
  }
  return { frontmatter, body }
}

/**
 * Parse one agent markdown file. Returns null when the body is empty (an
 * agent with no system prompt is meaningless).
 */
export function parseAgentMarkdown(params: {
  fallbackName: string
  rawContent: string
  source: AgentSource
  pluginName?: string
}): AgentDefinitionFull | null {
  const { frontmatter, body } = splitYamlHeader(params.rawContent)
  const systemPrompt = body.trim()
  if (!systemPrompt) {
    return null
  }
  const name = (frontmatter.name ?? '').trim() || params.fallbackName
  const description =
    frontmatter.description?.trim() || `Agent ${name}`
  const tools = parseStringList(frontmatter.tools)
  const disallowedTools = parseStringList(frontmatter.disallowedTools)
  const model = (frontmatter.model ?? '').trim() || undefined

  const definition: AgentDefinitionFull = {
    name,
    description,
    systemPrompt,
    source: params.source,
  }
  if (tools.length > 0) definition.tools = tools
  if (disallowedTools.length > 0) definition.disallowedTools = disallowedTools
  if (model) definition.model = model
  if (params.pluginName) definition.pluginName = params.pluginName
  return definition
}

async function scanAgentFolder(params: {
  dirPath: string
  source: AgentSource
  pluginName?: string
  fs: RuntimeFs
}): Promise<AgentDefinitionFull[]> {
  const fs = params.fs

  // Plugin agents recurse and are namespaced:
  // `agents/team/reviewer.md` → `<pluginName>:team:<frontmatter.name || stem>`.
  // A frontmatter `name:` replaces only the BASE segment — the plugin prefix
  // and directory namespace still apply.
  if (params.pluginName) {
    const pluginName = params.pluginName
    const agents: AgentDefinitionFull[] = []
    await visitMarkdownFiles(params.dirPath, async (filePath, namespace) => {
      const fallbackName = basenameRuntimePath(filePath).replace(/\.md$/i, '')
      try {
        const content = await fs.readFile(filePath, { encoding: 'utf-8' })
        const agent = parseAgentMarkdown({
          fallbackName,
          rawContent: content,
          source: params.source,
          pluginName,
        })
        if (agent) {
          agent.name = [pluginName, ...namespace, agent.name].join(':')
          agents.push(agent)
        }
      } catch {
        // Unreadable file — skip, keep loading the rest of the plugin.
      }
    }, { fs })
    return agents
  }

  let entries
  try {
    entries = await fs.readdir(params.dirPath)
  } catch {
    return []
  }

  const agents: AgentDefinitionFull[] = []
  for (const entry of entries) {
    if (!entry.isFile()) continue
    if (extnameRuntimePath(entry.name).toLowerCase() !== '.md') continue
    const filePath = joinRuntimePath(params.dirPath, entry.name)
    const fallbackName = basenameRuntimePath(entry.name).replace(/\.md$/i, '')
    try {
      const content = await fs.readFile(filePath, { encoding: 'utf-8' })
      const agent = parseAgentMarkdown({
        fallbackName,
        rawContent: content,
        source: params.source,
        pluginName: params.pluginName,
      })
      if (agent) agents.push(agent)
    } catch {
      continue
    }
  }
  return agents
}

/**
 * Build the agent registry from a precedence-ordered list of directories.
 * Earlier sources win on name collision (pass user/project before plugin).
 */
export async function buildAgentRegistry(
  sources: Array<{ dirPath: string; source: AgentSource; pluginName?: string }>,
  fs: RuntimeFs = processFs(),
): Promise<AgentDefinitionFull[]> {
  const loaded = (
    await Promise.all(
      sources.map(source => scanAgentFolder({ ...source, fs })),
    )
  ).flat()

  const byName = new Map<string, AgentDefinitionFull>()
  for (const agent of loaded) {
    if (!byName.has(agent.name)) {
      byName.set(agent.name, agent)
    }
  }
  return [...byName.values()]
}

/**
 * User-level agent directories: `.velloc/agents/` first, then `.claude/agents/`;
 * on a name clash the `.velloc` agent wins. Production must pass
 * `explicitHomeDir`: the SharedWorker env has no `HOME`.
 */
function getUserAgentsDirs(
  runtimeConfig: RuntimeConfig,
  explicitHomeDir?: string,
): string[] {
  const homeDir =
    explicitHomeDir
    ?? runtimeConfig.getEnv('HOME')
    ?? runtimeConfig.getEnv('USERPROFILE')
    ?? null

  if (!homeDir) {
    return []
  }

  return [
    joinRuntimePath(homeDir, RUNTIME_DIR_NAME, 'agents'),
    joinRuntimePath(homeDir, '.claude', 'agents'),
  ]
}

/**
 * Assemble the agent registry from user, project, and plugin directories.
 * Sources are ordered user → project → plugin so `buildAgentRegistry`'s
 * first-wins name dedup gives local agents precedence over a same-named
 * plugin agent (and user over project). Mirrors `loadLocalPromptCommands`
 * for skills; the result is still wrapped by `withBuiltInAgents` at the call
 * site so a user/project agent can shadow a built-in.
 */
export async function loadLocalAgents(params: {
  cwd: string
  runtimeConfig: RuntimeConfig
  /** Bridge-resolved user home. Required in production for the user-scope
   *  agent dirs to be scanned — the worker env has no `HOME`/`USERPROFILE`. */
  homeDir?: string
  /** Agent directories contributed by enabled plugins. Appended after the
   *  user/project sources so the name dedup keeps local agents ahead of any
   *  same-named plugin agent. */
  pluginAgentDirs?: Array<{ dirPath: string; pluginName: string }>
  /** THIS runtime's fs; omitted → the realm-global slot (tests). */
  fs?: RuntimeFs
}): Promise<AgentDefinitionFull[]> {
  const sources: Array<{
    dirPath: string
    source: AgentSource
    pluginName?: string
  }> = []

  for (const userAgentsDir of getUserAgentsDirs(
    params.runtimeConfig,
    params.homeDir,
  )) {
    sources.push({ dirPath: userAgentsDir, source: 'user' })
  }

  sources.push({
    dirPath: joinRuntimePath(params.cwd, RUNTIME_DIR_NAME, 'agents'),
    source: 'project',
  })

  for (const pluginAgentDir of params.pluginAgentDirs ?? []) {
    sources.push({
      dirPath: pluginAgentDir.dirPath,
      source: 'plugin',
      pluginName: pluginAgentDir.pluginName,
    })
  }

  return buildAgentRegistry(sources, params.fs ?? processFs())
}

/** Find a named agent in a list (e.g. `agentDefinitions.activeAgents`). */
export function findAgentDefinition(
  agents: readonly AgentProfile[],
  name: string,
): AgentDefinitionFull | undefined {
  const match = agents.find(agent => agent.name === name)
  return match && typeof (match as AgentDefinitionFull).systemPrompt === 'string'
    ? (match as AgentDefinitionFull)
    : undefined
}
