import type {
  ChromiumCommandLoadedFrom,
  ChromiumCommandMetadata,
  ChromiumSkillSource,
  ChromiumSkillSummary,
} from '../runtime/CommandTypes'
import type { RuntimeConfig } from '../runtime/interfaces/RuntimeConfig'
import type { ToolCallContext } from '../toolkit/toolCallContext'
import { processFs, type RuntimeFs } from '../utils/fs/runtimeFs'
import { RUNTIME_DIR_NAME } from '../branding/runtimeDir'
import { hasTemplate, templateAllowsSkill } from '../prompting/templateRegistry'
import type { TemplateConfig } from '../prompting/templateParsing'
import {
  basenameRuntimePath,
  dirnameRuntimePath,
  extnameRuntimePath,
  joinRuntimePath,
  normalizeRuntimePath,
  sanitizePathSegment,
} from '../utils/runtimePaths'
import { declaredArgLabels } from '../utils/promptArgs'
import {
  descriptionAsText,
  headerFlag,
  readMarkdownHeader,
  headerGlobList,
  type HeaderFields,
} from '../utils/frontmatter'
import { parseHooksSettings } from '../lifecycleHooks/hookTypes'
import { visitMarkdownFiles } from '../pluginHost/markdownTree'
import {
  getBundledSkillCommands,
  getBundledSkillIsEnabled,
  invocationAllows,
  invocationExcludedByType,
  isBundledSkillE2eOnly,
  normalizeInvocation,
  type NormalizedInvocation,
} from './builtinSkills'
import { installStockSkills } from './builtin/catalog'

const SKILL_FILE_NAME = 'SKILL.md'

function asString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined
}

function asStringOrArray(value: unknown): string | string[] | undefined {
  if (typeof value === 'string') {
    return value
  }
  if (Array.isArray(value)) {
    return value.filter((entry): entry is string => typeof entry === 'string')
  }
  return undefined
}

function parseToolList(value: unknown): string[] {
  const normalized = asStringOrArray(value)
  if (normalized === undefined) {
    return []
  }
  const entries = typeof normalized === 'string' ? [normalized] : normalized
  return entries
    .flatMap(entry => entry.split(','))
    .map(entry => entry.trim())
    .filter(entry => entry.length > 0)
}

function skillGlobList(frontmatter: HeaderFields): string[] | undefined {
  if (!frontmatter.paths) {
    return undefined
  }
  const patterns = headerGlobList(frontmatter.paths)
    .map(pattern => (pattern.endsWith('/**') ? pattern.slice(0, -3) : pattern))
    .filter(pattern => pattern.length > 0)
  if (patterns.length === 0 || patterns.every(pattern => pattern === '**')) {
    return undefined
  }
  return patterns
}

export function parseSessionTypes(raw: unknown): string[] | undefined {
  if (raw === undefined || raw === null) return undefined
  const input =
    typeof raw === 'string' || Array.isArray(raw)
      ? (raw as string | readonly string[])
      : undefined
  const types = normalizeInvocation(input)
  return types && types.length > 0 ? [...types] : undefined
}

function invocationFromFrontmatter(
  disabled: boolean,
  sessionTypes: string[] | undefined,
): NormalizedInvocation {
  if (disabled) return Object.freeze([])
  if (sessionTypes && sessionTypes.length > 0) return Object.freeze([...sessionTypes])
  return undefined
}

// Splits skills into those offered in the current session type and the rest.
export function partitionSkillsForSession<T extends { name: string; source: string }>(
  config: TemplateConfig | undefined,
  list: readonly T[],
  sessionTypeDenied: readonly string[],
): { allowed: T[]; deniedNames: string[] } {
  const allowed: T[] = []
  const dropped = new Set<string>()
  for (const command of list) {
    if (templateAllowsSkill(config, command)) allowed.push(command)
    else dropped.add(command.name)
  }
  for (const name of sessionTypeDenied) dropped.add(name)
  const surviving = new Set(allowed.map(command => command.name))
  const deniedNames = [...dropped].filter(name => !surviving.has(name))
  return { allowed, deniedNames }
}

export function resolveInvocationForSession(
  command: Pick<ChromiumCommandMetadata, 'modelInvocation' | 'userInvocation'>,
  templateType: string | undefined,
): { present: boolean; hiddenFromModel: boolean; userCallable: boolean } {
  const modelGate = command.modelInvocation
  const userGate = command.userInvocation
  const modelAllows = invocationAllows(modelGate, templateType)
  const userAllows = invocationAllows(userGate, templateType)
  const typeShutSomething =
    invocationExcludedByType(modelGate, templateType)
    || invocationExcludedByType(userGate, templateType)
  return {
    present: modelAllows || userAllows || !typeShutSomething,
    hiddenFromModel: !modelAllows,
    userCallable: userAllows,
  }
}

function deriveDescription(body: string, nameIfMissing: string): string {
  for (const raw of body.split(/\r?\n/)) {
    const trimmed = raw.trim()
    if (trimmed.length === 0) {
      continue
    }
    const headerMatch = trimmed.match(/^#+\s+(.+)$/)
    const text = headerMatch ? headerMatch[1]!.trim() : trimmed
    return text.length > 100 ? `${text.slice(0, 97)}...` : text
  }
  return `Local skill ${nameIfMissing}`
}

function toCommand(
  name: string,
  filePath: string,
  baseDir: string,
  source: ChromiumSkillSource,
  loadedFrom: ChromiumCommandLoadedFrom,
  rawContent: string,
  pluginName?: string,
): ChromiumCommandMetadata {
  const { frontmatter, content: body } = readMarkdownHeader(rawContent, filePath)

  const userSpecifiedDescription = descriptionAsText(
    frontmatter.description,
    name,
  )
  const description =
    userSpecifiedDescription
    ?? deriveDescription(body, sanitizePathSegment(name))
  const useWhen =
    asString(frontmatter.when_to_use) ?? asString(frontmatter.whenToUse)
  const argNames = declaredArgLabels(
    asStringOrArray(
      frontmatter.arguments ?? frontmatter.argNames ?? frontmatter.arg_names,
    ),
  )
  const argumentHint =
    asString(frontmatter['argument-hint'])
    ?? asString(frontmatter.argumentHint)
    ?? asString(frontmatter.argument_hint)
  const permittedTools = parseToolList(
    frontmatter['allowed-tools']
    ?? frontmatter.allowedTools
    ?? frontmatter.allowed_tools,
  )
  const model = (asString(frontmatter.model) ?? '').trim() || undefined
  const version = (asString(frontmatter.version) ?? '').trim() || undefined
  const paths = skillGlobList(frontmatter)
  const contextRaw = (asString(frontmatter.context) ?? '').trim().toLowerCase()
  const context =
    contextRaw === 'fork' ? 'fork' : contextRaw === 'inline' ? 'inline' : undefined
  const agent = (asString(frontmatter.agent) ?? '').trim() || undefined
  const effort = (asString(frontmatter.effort) ?? '').trim() || undefined

  const disableModelInvocationRaw =
    frontmatter['disable-model-invocation']
    ?? frontmatter.disableModelInvocation
    ?? frontmatter.disable_model_invocation
  const userInvocableRaw =
    frontmatter['user-invocable']
    ?? frontmatter.userInvocable
    ?? frontmatter.user_invocable
  const sessionTypes = parseSessionTypes(
    frontmatter['session-types']
    ?? frontmatter.sessionTypes
    ?? frontmatter.session_types,
  )
  const modelInvocation = invocationFromFrontmatter(
    headerFlag(disableModelInvocationRaw),
    sessionTypes,
  )
  const userInvocation = invocationFromFrontmatter(
    userInvocableRaw !== undefined && !headerFlag(userInvocableRaw),
    sessionTypes,
  )

  return {
    type: 'prompt',
    name,
    description,
    describedByAuthor: userSpecifiedDescription != null,
    content: body.trim() || rawContent.trim(),
    path: filePath,
    useWhen: useWhen || undefined,
    hiddenFromModel: modelInvocation?.length === 0,
    userCallable: userInvocation?.length !== 0,
    ...(modelInvocation ? { modelInvocation } : {}),
    ...(userInvocation ? { userInvocation } : {}),
    loadedFrom,
    source,
    baseDir,
    argNames: argNames.length > 0 ? argNames : undefined,
    argumentHint: argumentHint || undefined,
    permittedTools: permittedTools.length > 0 ? permittedTools : undefined,
    model,
    version,
    paths: paths && paths.length > 0 ? paths : undefined,
    hooks: parseHooksSettings(frontmatter.hooks) ?? undefined,
    context,
    agent,
    effort,
    pluginName,
  }
}

async function loadSkillFile(params: {
  filePath: string
  source: ChromiumSkillSource
  loadedFrom: ChromiumCommandLoadedFrom
  pluginName?: string
  fs: RuntimeFs
}): Promise<ChromiumCommandMetadata | null> {
  const fs = params.fs
  const base = basenameRuntimePath(params.filePath)
  const isSkillFile = base.toLowerCase() === SKILL_FILE_NAME.toLowerCase()
  if (!isSkillFile && extnameRuntimePath(base).toLowerCase() !== '.md') {
    return null
  }
  const baseName = isSkillFile
    ? sanitizePathSegment(basenameRuntimePath(dirnameRuntimePath(params.filePath)))
    : base.replace(/\.md$/i, '')
  const name = params.pluginName ? `${params.pluginName}:${baseName}` : baseName
  try {
    const content = await fs.readFile(params.filePath, { encoding: 'utf-8' })
    return toCommand(
      name,
      params.filePath,
      dirnameRuntimePath(params.filePath),
      params.source,
      params.loadedFrom,
      content,
      params.pluginName,
    )
  } catch {
    return null
  }
}

const SKILL_FILE_RE = /^skill\.md$/i

async function loadPluginCommandsTree(params: {
  dirPath: string
  source: ChromiumSkillSource
  loadedFrom: ChromiumCommandLoadedFrom
  pluginName: string
  fs: RuntimeFs
}): Promise<ChromiumCommandMetadata[]> {
  const fs = params.fs
  const collected: Array<{ fullPath: string; namespace: string[] }> = []
  await visitMarkdownFiles(
    params.dirPath,
    async (fullPath, namespace) => {
      collected.push({ fullPath, namespace })
    },
    { skillDirsAreLeaves: true, fs },
  )

  const byDir = new Map<string, Array<{ fullPath: string; namespace: string[] }>>()
  for (const file of collected) {
    const dir = dirnameRuntimePath(file.fullPath)
    const group = byDir.get(dir)
    if (group) group.push(file)
    else byDir.set(dir, [file])
  }
  const survivors: Array<{ fullPath: string; namespace: string[] }> = []
  for (const group of byDir.values()) {
    const skillFile = group.find(file =>
      SKILL_FILE_RE.test(basenameRuntimePath(file.fullPath)),
    )
    if (skillFile) survivors.push(skillFile)
    else survivors.push(...group)
  }

  const commands: ChromiumCommandMetadata[] = []
  for (const { fullPath, namespace } of survivors) {
    const base = basenameRuntimePath(fullPath)
    const segments = SKILL_FILE_RE.test(base)
      ? namespace.length > 0
        ? namespace
        : [basenameRuntimePath(params.dirPath)]
      : [...namespace, base.replace(/\.md$/i, '')]
    const name = [params.pluginName, ...segments].join(':')
    try {
      const content = await fs.readFile(fullPath, { encoding: 'utf-8' })
      commands.push(
        toCommand(
          name,
          fullPath,
          dirnameRuntimePath(fullPath),
          params.source,
          params.loadedFrom,
          content,
          params.pluginName,
        ),
      )
    } catch {
      continue
    }
  }
  return commands
}

// Each subdirectory holding a SKILL.md becomes one skill command.
async function scanSkillFolder(params: {
  dirPath: string
  source: ChromiumSkillSource
  loadedFrom: ChromiumCommandLoadedFrom
  pluginName?: string
  kind?: 'commands' | 'skills'
  fs: RuntimeFs
}): Promise<ChromiumCommandMetadata[]> {
  const fs = params.fs

  try {
    const stat = await fs.stat(params.dirPath)
    if (stat.isFile()) {
      const command = await loadSkillFile({
        filePath: params.dirPath,
        source: params.source,
        loadedFrom: params.loadedFrom,
        pluginName: params.pluginName,
        fs,
      })
      return command ? [command] : []
    }
  } catch {
  }

  if (params.pluginName && params.kind === 'commands') {
    return loadPluginCommandsTree({
      dirPath: params.dirPath,
      source: params.source,
      loadedFrom: params.loadedFrom,
      pluginName: params.pluginName,
      fs,
    })
  }

  let entries
  try {
    entries = await fs.readdir(params.dirPath)
  } catch {
    return []
  }

  const commands: ChromiumCommandMetadata[] = []

  const prefixName = (name: string): string =>
    params.pluginName ? `${params.pluginName}:${name}` : name
  for (const entry of entries) {
    if (entry.isDirectory()) {
      const skillDir = joinRuntimePath(params.dirPath, entry.name)
      const skillPath = joinRuntimePath(skillDir, SKILL_FILE_NAME)
      try {
        const content = await fs.readFile(skillPath, { encoding: 'utf-8' })
        commands.push(
          toCommand(
            prefixName(entry.name),
            skillPath,
            skillDir,
            params.source,
            params.loadedFrom,
            content,
            params.pluginName,
          ),
        )
      } catch {
        continue
      }
      continue
    }

    if (!entry.isFile()) {
      continue
    }

    if (entry.name.toLowerCase() !== SKILL_FILE_NAME.toLowerCase()
      && extnameRuntimePath(entry.name).toLowerCase() !== '.md') {
      continue
    }

    const filePath = joinRuntimePath(params.dirPath, entry.name)
    const name = prefixName(
      entry.name.toLowerCase() === SKILL_FILE_NAME.toLowerCase()
        ? sanitizePathSegment(basenameRuntimePath(params.dirPath))
        : basenameRuntimePath(entry.name).replace(/\.md$/i, ''),
    )
    const baseDir = dirnameRuntimePath(filePath)

    try {
      const content = await fs.readFile(filePath, { encoding: 'utf-8' })
      commands.push(
        toCommand(
          name,
          filePath,
          baseDir,
          params.source,
          params.loadedFrom,
          content,
          params.pluginName,
        ),
      )
    } catch {
      continue
    }
  }

  return commands
}

function getUserSkillsDirs(
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
    joinRuntimePath(homeDir, RUNTIME_DIR_NAME, 'skills'),
    joinRuntimePath(homeDir, '.claude', 'skills'),
  ]
}

// Collects skills and commands from user, project and plugin locations plus
// the bundled set. Skills with `paths` are held back as conditional.
export async function loadLocalPromptCommands(params: {
  cwd: string
  runtimeConfig: RuntimeConfig
  homeDir?: string
  pluginSkillDirs?: Array<{
    dirPath: string
    pluginName: string
    kind?: 'commands' | 'skills'
  }>
  includeBundled?: boolean
  appState?: Pick<import('../runtime/RuntimeTypes').WorkingState, 'enabledFeatures'>
  templateType?: string
  onSessionTypeDenied?: (name: string) => void
  templateConfig?: TemplateConfig
  fs?: RuntimeFs
}): Promise<ChromiumCommandMetadata[]> {
  const fs = params.fs ?? processFs()
  const sources: Array<{
    dirPath: string
    source: ChromiumSkillSource
    loadedFrom: ChromiumCommandLoadedFrom
    pluginName?: string
    kind?: 'commands' | 'skills'
  }> = []

  const bundledSkillsDir = params.runtimeConfig.getEnv('NEXUS_BUNDLED_SKILLS_DIR')
  if (bundledSkillsDir) {
    sources.push({
      dirPath: bundledSkillsDir,
      source: 'bundled',
      loadedFrom: 'bundled',
    })
  }

  for (const userSkillsDir of getUserSkillsDirs(
    params.runtimeConfig,
    params.homeDir,
  )) {
    sources.push({
      dirPath: userSkillsDir,
      source: 'user',
      loadedFrom: 'skills',
    })
  }

  sources.push({
    dirPath: joinRuntimePath(params.cwd, RUNTIME_DIR_NAME, 'skills'),
    source: 'project',
    loadedFrom: 'skills',
  })

  for (const pluginSkillDir of params.pluginSkillDirs ?? []) {
    sources.push({
      dirPath: pluginSkillDir.dirPath,
      source: 'plugin',
      loadedFrom: 'plugin',
      pluginName: pluginSkillDir.pluginName,
      kind: pluginSkillDir.kind ?? 'skills',
    })
  }

  const commands = (
    await Promise.all(
      sources.map(source => scanSkillFolder({ ...source, fs })),
    )
  ).flat()

  const resolveKey = async (
    command: ChromiumCommandMetadata,
  ): Promise<string> => {
    if (fs.realpath) {
      try {
        return await fs.realpath(command.path)
      } catch {
      }
    }
    return normalizeRuntimePath(command.path)
  }
  const dedupKeys = await Promise.all(commands.map(resolveKey))

  const seenPaths = new Set<string>()
  const pathDeduped: ChromiumCommandMetadata[] = []
  for (let i = 0; i < commands.length; i++) {
    const key = dedupKeys[i]!
    if (seenPaths.has(key)) {
      continue
    }
    seenPaths.add(key)
    pathDeduped.push(commands[i]!)
  }

  if (params.includeBundled !== false) {
    installStockSkills()
    const includeE2eOnly = params.runtimeConfig.flagOn('e2eTrace')
    for (const command of getBundledSkillCommands()) {
      if (isBundledSkillE2eOnly(command.name) && !includeE2eOnly) {
        continue
      }
      const isEnabled = getBundledSkillIsEnabled(command.name)
      if (isEnabled && params.appState && !isEnabled(params.appState as never)) {
        continue
      }
      pathDeduped.push(command)
    }
  }

  const deduped = new Map<string, ChromiumCommandMetadata>()
  const droppedNames = new Set<string>()
  for (const command of pathDeduped) {
    const unknownTypes = [
      ...(command.modelInvocation ?? []),
      ...(command.userInvocation ?? []),
    ].filter(t => !hasTemplate(t))
    if (unknownTypes.length > 0) {
      console.warn(
        `[loadLocalPromptCommands] skill "${command.name}" (${command.path}) lists ` +
          `session types that are not registered templates: ${[...new Set(unknownTypes)].join(', ')}. ` +
          'It will not load into any session of those types.',
      )
    }
    const resolved = resolveInvocationForSession(command, params.templateType)
    if (!resolved.present) {
      droppedNames.add(command.name)
      continue
    }
    if (!templateAllowsSkill(params.templateConfig, command)) {
      droppedNames.add(command.name)
      continue
    }
    if (!deduped.has(command.name)) {
      deduped.set(command.name, {
        ...command,
        hiddenFromModel: resolved.hiddenFromModel,
        userCallable: resolved.userCallable,
      })
    }
  }
  for (const name of droppedNames) {
    if (!deduped.has(name)) params.onSessionTypeDenied?.(name)
  }

  const sorted = [...deduped.values()].sort((left, right) =>
    left.name.localeCompare(right.name),
  )
  const unconditional: ChromiumCommandMetadata[] = []
  pathTriggeredSkills.clear()
  for (const command of sorted) {
    if (command.paths && command.paths.length > 0) {
      pathTriggeredSkills.set(command.name, command)
      continue
    }
    unconditional.push(command)
  }

  return unconditional
}

// Skills that only activate once a matching file is touched.
const pathTriggeredSkills = new Map<string, ChromiumCommandMetadata>()

export function getConditionalSkills(): ChromiumCommandMetadata[] {
  return [...pathTriggeredSkills.values()]
}

export function normalizeSkillName(name: string): string {
  return name.trim().replace(/^\/+/, '')
}

export function isSkillDeniedByTemplate(
  context: ToolCallContext,
  name: string,
): boolean {
  const denied = context.options.deniedSkillNames
  if (!denied || denied.length === 0) return false
  const wanted = normalizeSkillName(name)
  return denied.includes(wanted)
}

export function skillDeniedMessage(name: string): string {
  return `Skill ${normalizeSkillName(name)} is not available in this session type.`
}

// Commands the model may call itself; the input to the skill listing.
export function getModelInvocableCommands(
  commands: readonly ChromiumCommandMetadata[],
): ChromiumCommandMetadata[] {
  return commands.filter(command => {
    if (command.hiddenFromModel) {
      return false
    }
    if (isBundledSkillE2eOnly(command.name)) {
      return false
    }
    const fromTrustedDir =
      command.loadedFrom === 'bundled' || command.loadedFrom === 'skills'
    if (
      !fromTrustedDir &&
      !command.describedByAuthor &&
      !command.useWhen
    ) {
      return false
    }
    return true
  })
}

function tokenize(value: string): string[] {
  return value
    .toLowerCase()
    .split(/[^a-z0-9]+/g)
    .filter(token => token.length >= 3)
}

// Ranks skills by word overlap with the query text.
export function discoverRelevantSkills(
  input: string,
  commands: readonly ChromiumCommandMetadata[],
  limit = 5,
): ChromiumSkillSummary[] {
  const searchTokens = new Set(tokenize(input))
  if (searchTokens.size === 0) {
    return []
  }

  const scored = commands
    .map(command => {
      const haystack = `${command.name} ${command.description} ${command.useWhen ?? ''}`.toLowerCase()
      let score = 0
      for (const token of searchTokens) {
        if (haystack.includes(token)) {
          score += 1
        }
      }
      if (command.name.toLowerCase().includes(input.toLowerCase())) {
        score += 2
      }
      return { command, score }
    })
    .filter(entry => entry.score > 0)
    .sort((left, right) =>
      right.score - left.score || left.command.name.localeCompare(right.command.name),
    )
    .slice(0, limit)

  return scored.map(({ command }) => ({
    name: command.name,
    description: command.description,
    path: command.path,
    shortId: command.name,
  }))
}

export function findCommandByName(
  commands: readonly ChromiumCommandMetadata[],
  targetName: string,
): ChromiumCommandMetadata | undefined {
  const normalizedTarget = normalizeSkillName(targetName)
  return commands.find(command => command.name === normalizedTarget)
}
