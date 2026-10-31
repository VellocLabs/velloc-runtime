/**
 * `$.agent` (F-25): `register` a `<plugin>:<name>` agent type, `list` the session's
 * subagents, `spawn` through `agent.spawn` (`{ model, agentId }` or `{ deny }`). The
 * engine-free half: checks, definitions, the registry.
 */

import type { AgentDefinitionFull } from '../agents/agentRegistry'
import type { SubAgentListEntry } from '../team/subAgentController'
import type { DispatchContext } from './modTypes'
import type { ModAgentViewTarget } from './modAgentView'

/** What `$.agent` needs of the session; bound late like `$.tool`. */
export type ModAgentHost = {
  register(spec: ModAgentSpec, plugin: string): string
  forget(plugin: string): void
  list(): ModAgentInfo[]
  /** `$.ui.view`'s lookup: where a subagent's or teammate's transcript is. */
  viewTarget?(agentId: string): ModAgentViewTarget | undefined
  spawn(
    args: ModAgentSpawnArgs,
    raise: { context: DispatchContext; signal?: AbortSignal },
  ): Promise<{ model: string; agentId: string } | { deny: string }>
  /** `$.agent.wait`: resolves when the session's subagent `agentId` ends,
   *  with its outcome; the parent is then not told of that result again.
   *  `signal` abandons the wait and leaves the subagent running. */
  wait(agentId: string, options: { signal?: AbortSignal }): Promise<ModAgentOutcome>
}

/** How a subagent run ended, as `$.agent.wait` answers and `agent.complete`
 *  carries it. `text` is the run's final answer, or its partial output when
 *  it was stopped. */
export type ModAgentOutcome = {
  agentId: string
  status: 'completed' | 'failed' | 'killed'
  text: string
  description: string
  type: string
}

/** The engine's terminal statuses as the declaration spells them. */
export function agentStatusOf(status: string): string {
  return status === 'success' ? 'completed' : status === 'error' ? 'failed' : status === 'stopped' ? 'killed' : status
}

/** A terminal controller snapshot or finished record as a `ModAgentOutcome`. */
export function agentOutcomeOf(run: {
  agentId: string
  status: 'success' | 'error' | 'stopped'
  text: string
  description: string
  agentType?: string
}): ModAgentOutcome {
  return {
    agentId: run.agentId,
    status: agentStatusOf(run.status) as ModAgentOutcome['status'],
    text: run.text,
    description: run.description,
    type: run.agentType ?? 'general-purpose',
  }
}

/** `agent.complete`'s `e` from the coordinator's finished record, keyed by
 *  the public task id the plugin's spawn answered. */
export function agentCompletionOf(record: {
  taskId: string
  status: 'success' | 'error' | 'stopped'
  summary: string
  description: string
  agentType?: string
}): ModAgentOutcome {
  return agentOutcomeOf({
    agentId: record.taskId,
    status: record.status,
    text: record.summary,
    description: record.description,
    ...(record.agentType !== undefined ? { agentType: record.agentType } : {}),
  })
}

export function isModAgentOutcome(value: unknown): boolean {
  return (
    isRecord(value) &&
    typeof value.agentId === 'string' &&
    (value.status === 'completed' || value.status === 'failed' || value.status === 'killed') &&
    typeof value.text === 'string'
  )
}

/** `$.agent.wait(agentId)`'s argument, checked. */
export function modAgentWaitArgsOf(value: unknown): { agentId: string } {
  if (typeof value !== 'string' || value === '') {
    throw new TypeError('$.agent.wait(agentId): agentId must be a non-empty string')
  }
  return { agentId: value }
}

const NAME_PATTERN = /^[A-Za-z0-9_-]{1,64}$/
const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max']
const APPROVAL_MODE_IDS = ['default', 'acceptEdits', 'plan', 'auto', 'dontAsk', 'bypassPermissions']

/** What `$.agent.register` takes, checked. The fields the declaration names;
 *  any other rides into the definition untouched ("any other field of an
 *  agent definition"). */
export type ModAgentSpec = {
  name: string
  description: string
  prompt: string
  tools?: string[]
  disallowedTools?: string[]
  model?: string
  effort?: string | number
  permissionMode?: string
  mcpServers?: Array<string | Record<string, unknown>>
  hooks?: Record<string, unknown>
  maxTurns?: number
  skills?: string[]
  [key: string]: unknown
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function stringList(value: unknown, field: string): string[] | undefined {
  if (value === undefined) return undefined
  if (!Array.isArray(value) || !value.every(item => typeof item === 'string' && item !== '')) {
    throw new TypeError(`$.agent.register: ${field} must be a list of names`)
  }
  return [...(value as string[])]
}

/** The checked spec: each refusal names the field. */
export function modAgentSpecOf(value: unknown): ModAgentSpec {
  if (!isRecord(value)) throw new TypeError('$.agent.register(spec): spec must be { name, description, prompt, … }')
  const { name, description, prompt, tools, disallowedTools, model, effort, permissionMode, mcpServers, hooks, maxTurns, skills, ...rest } = value
  if (typeof name !== 'string' || !NAME_PATTERN.test(name)) {
    throw new TypeError('$.agent.register: name must be letters, digits, "_" or "-", up to 64')
  }
  if (typeof description !== 'string' || description.trim() === '') {
    throw new TypeError('$.agent.register: description must be a non-empty string')
  }
  if (typeof prompt !== 'string' || prompt.trim() === '') {
    throw new TypeError('$.agent.register: prompt must be a non-empty string')
  }
  if (model !== undefined && (typeof model !== 'string' || model === '')) throw new TypeError('$.agent.register: model must be an alias or id')
  if (effort !== undefined && !(typeof effort === 'number' && Number.isInteger(effort) && effort > 0) && !EFFORTS.includes(effort as string)) {
    throw new TypeError(`$.agent.register: effort must be one of ${EFFORTS.join(', ')} or an integer budget`)
  }
  if (permissionMode !== undefined && !APPROVAL_MODE_IDS.includes(permissionMode as string)) {
    throw new TypeError(`$.agent.register: permissionMode must be one of ${APPROVAL_MODE_IDS.join(', ')}`)
  }
  if (mcpServers !== undefined && (!Array.isArray(mcpServers) || !mcpServers.every(s => typeof s === 'string' || isRecord(s)))) {
    throw new TypeError('$.agent.register: mcpServers must be a list of server names or configs')
  }
  if (hooks !== undefined && !isRecord(hooks)) throw new TypeError('$.agent.register: hooks must be an object in settings.json\'s shape')
  if (maxTurns !== undefined && !(typeof maxTurns === 'number' && Number.isInteger(maxTurns) && maxTurns > 0)) {
    throw new TypeError('$.agent.register: maxTurns must be a positive integer')
  }
  const toolList = stringList(tools, 'tools')
  const denied = stringList(disallowedTools, 'disallowedTools')
  const skillList = stringList(skills, 'skills')
  return {
    ...rest,
    name,
    description,
    prompt,
    ...(toolList ? { tools: toolList } : {}),
    ...(denied ? { disallowedTools: denied } : {}),
    ...(model !== undefined ? { model } : {}),
    ...(effort !== undefined ? { effort: effort as string | number } : {}),
    ...(permissionMode !== undefined ? { permissionMode: permissionMode as string } : {}),
    ...(mcpServers !== undefined ? { mcpServers: [...(mcpServers as Array<string | Record<string, unknown>>)] } : {}),
    ...(hooks !== undefined ? { hooks: { ...(hooks as Record<string, unknown>) } } : {}),
    ...(maxTurns !== undefined ? { maxTurns } : {}),
    ...(skillList ? { skills: skillList } : {}),
  }
}

/** The type's full name: `<plugin>:<name>`, "as a plugin's agent file
 *  `agents/<name>.md` names one". */
export function modAgentFullName(plugin: string, name: string): string {
  return `${plugin}:${name}`
}

/** A definition the Agent tool dispatches; `modPlugin` marks it for `forget`. */
export type ModRegisteredAgent = AgentDefinitionFull & { readonly modPlugin: string }

export function isModRegisteredAgent(agent: { modPlugin?: unknown; [key: string]: unknown }): agent is ModRegisteredAgent {
  return typeof agent.modPlugin === 'string'
}

export function buildModAgentDefinition(plugin: string, spec: ModAgentSpec): ModRegisteredAgent {
  const { name, description, prompt, tools, disallowedTools, model, ...rest } = spec
  return {
    ...rest,
    name: modAgentFullName(plugin, name),
    description,
    systemPrompt: prompt,
    ...(tools ? { tools } : {}),
    ...(disallowedTools ? { disallowedTools } : {}),
    ...(model !== undefined ? { model } : {}),
    source: 'plugin',
    pluginName: plugin,
    modPlugin: plugin,
  }
}

/** The engine's registry of plugin agent types: by full name, replaced on a
 *  second registration. */
export class ModRegisteredAgents {
  private readonly agents = new Map<string, ModRegisteredAgent>()

  constructor(private readonly onChanged: (agents: readonly ModRegisteredAgent[]) => void) {}

  register(spec: ModAgentSpec, plugin: string): string {
    const agent = buildModAgentDefinition(plugin, spec)
    this.agents.set(agent.name, agent)
    this.onChanged(this.list())
    return agent.name
  }

  forget(plugin: string): void {
    let changed = false
    for (const [name, agent] of this.agents) {
      if (agent.modPlugin !== plugin) continue
      this.agents.delete(name)
      changed = true
    }
    if (changed) this.onChanged(this.list())
  }

  list(): ModRegisteredAgent[] {
    return [...this.agents.values()]
  }
}

/** What `$.agent.spawn` takes: `prompt`, and the Agent tool's other
 *  parameters as the chain may rewrite them. */
export type ModAgentSpawnArgs = {
  prompt: string
  description?: string
  subagentType?: string
  model?: string
  name?: string
  cwd?: string
  /** `'worktree'`: the subagent works in its own git worktree when the
   *  project is a repository, as the Agent tool's `isolation`. */
  isolation?: 'worktree'
  /** A running `$.task` of the plugin's that the subagent works for: the
   *  task's stop stops it too (`children: 'stop'`). */
  task?: string
}

export function modAgentSpawnArgsOf(value: unknown): ModAgentSpawnArgs {
  if (!isRecord(value) || typeof value.prompt !== 'string' || value.prompt.trim() === '') {
    throw new TypeError('$.agent.spawn(input): input.prompt must be a non-empty string')
  }
  const out: ModAgentSpawnArgs = { prompt: value.prompt }
  for (const field of ['description', 'subagentType', 'model', 'name', 'cwd'] as const) {
    const given = value[field]
    if (given === undefined) continue
    if (typeof given !== 'string' || given === '') throw new TypeError(`$.agent.spawn: input.${field} must be a string`)
    out[field] = given
  }
  if (value.isolation !== undefined) {
    if (value.isolation !== 'worktree') throw new TypeError("$.agent.spawn: input.isolation must be 'worktree'")
    out.isolation = 'worktree'
  }
  if (value.task !== undefined) {
    if (typeof value.task !== 'string' || value.task === '') throw new TypeError('$.agent.spawn: input.task must be a task id')
    out.task = value.task
  }
  return out
}

/** The Agent tool's input for a plugin's spawn: in the background, so the
 *  call resolves once the subagent started; its answer comes through
 *  `$.agent.wait` or `agent.complete`. A `description` the plugin left out
 *  is the prompt's first words. */
export function agentToolInputOf(args: ModAgentSpawnArgs): Record<string, unknown> {
  const description = args.description ?? args.prompt.trim().split(/\s+/).slice(0, 5).join(' ')
  return {
    tool: 'Agent',
    prompt: args.prompt,
    description,
    ...(args.subagentType !== undefined ? { subagent_type: args.subagentType } : {}),
    ...(args.model !== undefined ? { model: args.model } : {}),
    ...(args.isolation !== undefined ? { isolation: args.isolation } : {}),
    run_in_background: true,
  }
}

/** The tool's text when the Agent tool refused to start: "Agent could not
 *  start: <reason>" (an `agent.spawn` deny, a type not offered, a route
 *  error), else undefined. */
export function denialOfLaunch(text: unknown): string | undefined {
  if (typeof text !== 'string') return undefined
  const match = /^Agent could not start: (.*)$/s.exec(text.trim())
  return match?.[1]?.trim()
}

/** `AgentInfo` as the declaration spells it. */
export type ModAgentInfo = {
  id: string
  description: string
  type: string
  status: string
  parentId?: string
  spawnedBy?: string
  name?: string
}

/** A controller row as `$.agent.list` answers it: the engine's statuses
 *  spelled as the declaration's (`success` → `completed`, `error` →
 *  `failed`, `stopped` → `killed`). */
export function agentInfoOf(entry: SubAgentListEntry, spawnedBy?: string): ModAgentInfo {
  const status = agentStatusOf(entry.status)
  return {
    id: entry.sessionId,
    description: entry.description,
    type: entry.agentType ?? 'general-purpose',
    status,
    ...(spawnedBy !== undefined ? { spawnedBy } : {}),
  }
}
