/**
 * Read-only introspection listings for `/agents`, `/skills`, `/hooks` and
 * `/permissions`: pure functions of already-loaded state, rendered as markdown
 * translatable parts. Grouping headers read off loosely-typed data stay
 * untranslated.
 */

import type { MessageKey } from '../browser/webview/i18n/messages/en'
import type {
  AgentProfile,
  WorkingState,
  SystemMessagePart,
} from '../runtime/RuntimeTypes'
import type { AgentRoster } from '../toolkit/toolCallContext'
import type { ChromiumCommandMetadata } from '../runtime/CommandTypes'
import type { AnyHook, LifecycleEventName } from '../lifecycleHooks/hookTypes'
import { LIFECYCLE_EVENT_NAMES } from '../lifecycleHooks/hookTypes'
import {
  inProcessHooksFor,
  transientHooksFor,
} from '../lifecycleHooks/sessionScopedHooks'
import { FORK_ROUTE_KIND } from '../toolkit/builtin/subagentFork'
import { RUNTIME_DIR_NAME } from '../branding/runtimeDir'
import {
  BLOCK,
  bullet,
  bulletBlock,
  key,
  leadIn,
  paragraph,
  text,
  title,
} from './systemMessageParts'

/** Longest single-line value echoed back into a listing before it is elided. */
const MAX_INLINE_VALUE = 120

/** Collapse a possibly-multiline, possibly-huge value onto one bounded line. */
function oneLine(value: string, limit = MAX_INLINE_VALUE): string {
  const flat = value.replace(/\s+/g, ' ').trim()
  return flat.length > limit ? `${flat.slice(0, limit - 1)}…` : flat
}

/** Read a string property off a loosely-typed definition, or undefined. */
function str(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key]
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

/** Read a string-array property off a loosely-typed definition, or undefined. */
function strArray(
  record: Record<string, unknown>,
  key: string,
): string[] | undefined {
  const value = record[key]
  if (!Array.isArray(value)) return undefined
  const items = value.filter((v): v is string => typeof v === 'string')
  return items.length > 0 ? items : undefined
}

// ---- /agents -------------------------------------------------------------

/**
 * One agent bullet: `- **<name>** (<source>) — <description>` plus model
 * override and tool scope; every field read defensively.
 */
function agentSummaryLine(agent: AgentProfile): string {
  const record = agent as Record<string, unknown>
  const name = str(record, 'name') ?? '(unnamed)'
  const source = str(record, 'source') ?? 'unknown'
  const pluginName = str(record, 'pluginName')
  const origin = pluginName ? `${source}: ${pluginName}` : source

  const facets: string[] = []
  const model = str(record, 'model')
  if (model) facets.push(`model=${model}`)
  const tools = strArray(record, 'tools')
  if (tools) facets.push(`tools=${tools.join(',')}`)
  const disallowed = strArray(record, 'disallowedTools')
  if (disallowed) facets.push(`denied=${disallowed.join(',')}`)
  const facetText = facets.length > 0 ? ` [${facets.join(' ')}]` : ''

  const description = str(record, 'description')
  const descriptionText = description ? ` — ${oneLine(description)}` : ''
  return bullet(`**${name}** (${origin})${facetText}${descriptionText}`)
}

/**
 * `/agents`: the `activeAgents` list `resolveSubagentRoute` resolves against,
 * plus the reserved `fork` route (kept out of the registry).
 */
export function buildAgentsListing(
  agentRoster: AgentRoster | undefined,
): SystemMessagePart[] {
  const agents = agentRoster?.enabledAgents ?? []
  // The reserved route is one bullet under its own lead-in, in both branches —
  // "Always available regardless:" when nothing else is registered, plainly
  // "Reserved:" when it sits below the real buckets.
  const forkNote = (heading: MessageKey): SystemMessagePart[] => [
    ...leadIn(key(heading)),
    text(`${BLOCK}- `),
    key('slash.out.agents.forkNote', { route: FORK_ROUTE_KIND }),
  ]

  if (agents.length === 0) {
    return [
      ...title(key('slash.out.agents.empty')),
      ...paragraph(key('slash.out.agents.authorHint')),
      text(`${BLOCK}- `),
      key('slash.out.agents.userScope', { dir: RUNTIME_DIR_NAME }),
      text('\n- '),
      key('slash.out.agents.projectScope', { dir: RUNTIME_DIR_NAME }),
      text('\n- '),
      key('slash.out.agents.pluginScope'),
      ...forkNote('slash.out.agents.alwaysAvailable'),
    ]
  }

  // Group by source so "what did I author" reads apart from "what shipped".
  const order = ['built-in', 'user', 'project', 'plugin']
  const bySource = new Map<string, AgentProfile[]>()
  for (const agent of agents) {
    const source = str(agent as Record<string, unknown>, 'source') ?? 'unknown'
    const bucket = bySource.get(source)
    if (bucket) bucket.push(agent)
    else bySource.set(source, [agent])
  }
  const sources = [...bySource.keys()].sort((a, b) => {
    const ai = order.indexOf(a)
    const bi = order.indexOf(b)
    return (ai === -1 ? order.length : ai) - (bi === -1 ? order.length : bi)
  })

  const parts: SystemMessagePart[] = title(
    key('slash.out.agents.header', { count: agents.length }),
  )
  for (const source of sources) {
    const bucket = bySource.get(source) ?? []
    parts.push(
      ...leadIn(`${source} (${bucket.length}):`),
      ...bulletBlock(bucket.map(agentSummaryLine)),
    )
  }
  parts.push(...forkNote('slash.out.agents.reservedHeading'))
  return parts
}

// ---- /skills -------------------------------------------------------------

/**
 * How a skill can be reached. Both gates are independent opt-OUTs, so a skill
 * can be slash-only, model-only, both (the default), or — if an author sets
 * both flags — neither, which is worth surfacing rather than hiding.
 */
function skillInvocation(skill: ChromiumCommandMetadata): string {
  const viaSlash = skill.userCallable !== false
  const viaModel = skill.hiddenFromModel !== true
  if (viaSlash && viaModel) return 'slash+model'
  if (viaSlash) return 'slash-only'
  if (viaModel) return 'model-only'
  return 'not invocable'
}

/** A skill's bullet CONTENT (no `- ` prefix): the caller picks the depth. */
function formatSkillLine(skill: ChromiumCommandMetadata): string {
  const facets: string[] = [skillInvocation(skill)]
  if (skill.pluginName) facets.push(`plugin=${skill.pluginName}`)
  if (skill.model) facets.push(`model=${skill.model}`)
  if (skill.context === 'fork') {
    facets.push(skill.agent ? `fork=${skill.agent}` : 'fork')
  }
  if (skill.permittedTools && skill.permittedTools.length > 0) {
    facets.push(`tools=${skill.permittedTools.join(',')}`)
  }
  // Only ever set on a withheld skill (see `buildSkillsListing`) — showing the
  // patterns is the point there, since they are why it is withheld.
  if (skill.paths && skill.paths.length > 0) {
    facets.push(`paths=${skill.paths.join(',')}`)
  }
  const description = skill.description ? ` — ${oneLine(skill.description)}` : ''
  return `**/${skill.name}** [${facets.join(' ')}]${description}`
}

/** Group skills by `source`, most-local-first, name-sorted within a group. */
function groupSkillsBySource(
  skills: readonly ChromiumCommandMetadata[],
): Array<[string, ChromiumCommandMetadata[]]> {
  const order = ['bundled', 'user', 'project', 'plugin']
  const bySource = new Map<string, ChromiumCommandMetadata[]>()
  for (const skill of skills) {
    const bucket = bySource.get(skill.source)
    if (bucket) bucket.push(skill)
    else bySource.set(skill.source, [skill])
  }
  return [...bySource.keys()]
    .sort((a, b) => {
      const ai = order.indexOf(a)
      const bi = order.indexOf(b)
      return (ai === -1 ? order.length : ai) - (bi === -1 ? order.length : bi)
    })
    .map(source => [
      source,
      (bySource.get(source) ?? [])
        .slice()
        .sort((a, b) => a.name.localeCompare(b.name)),
    ])
}

/**
 * `/skills`: every loaded skill grouped by source, plus `withheld` skills
 * (path-gated ones partitioned out of `commands`), so a gated skill is
 * explained rather than invisible.
 */
export function buildSkillsListing(
  commands: readonly ChromiumCommandMetadata[] | undefined,
  withheld: readonly ChromiumCommandMetadata[] = [],
): SystemMessagePart[] {
  const skills = (commands ?? []).filter(command => command.type === 'prompt')
  const gated = withheld.filter(command => command.type === 'prompt')
  if (skills.length === 0 && gated.length === 0) {
    return [key('slash.out.skills.empty', { dir: RUNTIME_DIR_NAME })]
  }

  const parts: SystemMessagePart[] = title(
    gated.length > 0
      ? key('slash.out.skills.headerWithWithheld', {
          loaded: skills.length,
          withheld: gated.length,
        })
      : key('slash.out.skills.header', { loaded: skills.length }),
  )
  for (const [source, bucket] of groupSkillsBySource(skills)) {
    parts.push(
      ...leadIn(`${source} (${bucket.length}):`),
      ...bulletBlock(bucket.map(skill => bullet(formatSkillLine(skill)))),
    )
  }

  if (gated.length > 0) {
    // One list, nested: each source is a top-level bullet and its skills hang
    // under it, so "withheld" reads as one section rather than N stray lists.
    const withheldItems: string[] = []
    for (const [source, bucket] of groupSkillsBySource(gated)) {
      withheldItems.push(bullet(`${source}:`))
      for (const skill of bucket) {
        withheldItems.push(bullet(formatSkillLine(skill), 1))
      }
    }
    parts.push(
      ...leadIn(key('slash.out.skills.withheldHeading', { count: gated.length })),
      ...paragraph(key('slash.out.skills.withheldExplanation')),
      ...bulletBlock(withheldItems),
    )
  }
  return parts
}

// ---- /hooks --------------------------------------------------------------

/** The identifying payload of a hook, by type — what it will actually run. */
function formatHookDetail(hook: AnyHook): string {
  switch (hook.type) {
    case 'command':
      return `command: ${oneLine(hook.command)}`
    case 'prompt':
      return `prompt: ${oneLine(hook.prompt)}`
    case 'agent':
      return `agent: ${oneLine(hook.prompt)}`
    case 'http':
      return `http: ${oneLine(hook.url)}`
    case 'function':
      return `function: ${hook.id ?? '(anonymous)'}`
  }
}

/** A hook's bullet CONTENT (no `- ` prefix): the caller picks the depth. */
function formatHookLine(hook: AnyHook, skillRoot?: string): string {
  const facets: string[] = []
  if ('if' in hook && typeof hook.if === 'string' && hook.if.length > 0) {
    facets.push(`if=${oneLine(hook.if, 40)}`)
  }
  if (typeof hook.timeout === 'number') facets.push(`timeout=${hook.timeout}ms`)
  if ('once' in hook && hook.once === true) facets.push('once')
  if ('async' in hook && hook.async === true) facets.push('async')
  if (skillRoot) facets.push(`from=${skillRoot}`)
  const facetText = facets.length > 0 ? ` [${facets.join(' ')}]` : ''
  return `${formatHookDetail(hook)}${facetText}`
}

/**
 * `/hooks`: this session's registered hooks by event, persistable and in-memory
 * `function` hooks merged. A frontmatter hook of a never-invoked skill is
 * absent.
 */
export function buildHooksListing(
  appState: WorkingState | undefined,
  sessionId: string | undefined,
): SystemMessagePart[] {
  if (!appState || !sessionId) {
    return [key('slash.out.hooks.noSession')]
  }
  const persistable = transientHooksFor(appState, sessionId)
  const functions = inProcessHooksFor(appState, sessionId)

  const body: SystemMessagePart[] = []
  let matcherCount = 0
  let hookCount = 0
  for (const event of LIFECYCLE_EVENT_NAMES as readonly LifecycleEventName[]) {
    const eventMatchers: Array<{
      matcher: string
      skillRoot?: string
      hooks: AnyHook[]
    }> = []
    for (const entry of persistable.get(event) ?? []) {
      eventMatchers.push({ ...entry, hooks: [...entry.hooks] })
    }
    for (const entry of functions.get(event) ?? []) {
      // Same matcher registered on both sides is one logical bundle — merge
      // rather than printing the matcher twice under the same event.
      const existing = eventMatchers.find(m => m.matcher === entry.matcher)
      if (existing) existing.hooks.push(...entry.hooks)
      else eventMatchers.push({ ...entry, hooks: [...entry.hooks] })
    }
    if (eventMatchers.length === 0) continue

    // Event → bold lead-in; matchers are the top-level bullets and their hooks
    // hang one level under, so a matcher owning three hooks reads as one group.
    body.push(...leadIn(`${event}:`), text(BLOCK))
    let firstMatcher = true
    for (const entry of eventMatchers) {
      matcherCount += 1
      hookCount += entry.hooks.length
      body.push(
        text(firstMatcher ? '- ' : '\n- '),
        key('slash.out.hooks.matcherLabel'),
        text(' '),
        entry.matcher.length > 0 ? text(entry.matcher) : key('slash.out.hooks.matchAll'),
      )
      firstMatcher = false
      for (const hook of entry.hooks) {
        body.push(text(`\n${bullet(formatHookLine(hook, entry.skillRoot), 1)}`))
      }
    }
  }

  if (hookCount === 0) {
    return [key('slash.out.hooks.empty')]
  }
  return [
    ...title(
      key(
        matcherCount === 1 ? 'slash.out.hooks.headerOneMatcher' : 'slash.out.hooks.header',
        { hooks: hookCount, matchers: matcherCount },
      ),
    ),
    ...body,
  ]
}

// ---- /permissions --------------------------------------------------------

/** Render `Record<source, rules[]>` as `- <rule> (<source>)` bullets. */
function formatRulesBySource(
  rules: Record<string, string[]> | undefined,
): string[] {
  if (!rules) return []
  const lines: string[] = []
  for (const source of Object.keys(rules).sort()) {
    for (const rule of rules[source] ?? []) {
      lines.push(bullet(`${rule} (${source})`))
    }
  }
  return lines
}

/**
 * `/permissions`: the permission mode plus both rule stores in force
 * (`ruleLists` and the legacy `alwaysAllow/Deny/AskRules`).
 */
export function buildPermissionsListing(
  appState: WorkingState | undefined,
): SystemMessagePart[] {
  const permissions = appState?.permissionRules
  if (!permissions) {
    return [key('slash.out.permissions.noContext')]
  }

  // The mode is the title; the qualifiers that modify it are bullets under it,
  // because each is an independent fact about this session's posture.
  const parts: SystemMessagePart[] = title(
    key('slash.out.permissions.mode', { mode: permissions.mode }),
  )
  const posture: SystemMessagePart[] = []
  if (permissions.modeBeforePlan) {
    posture.push(
      text(posture.length === 0 ? `${BLOCK}- ` : '\n- '),
      key('slash.out.permissions.modeBeforePlan', { mode: permissions.modeBeforePlan }),
    )
  }
  if (permissions.bypassPermissionsModeDisabled) {
    posture.push(
      text(posture.length === 0 ? `${BLOCK}- ` : '\n- '),
      key('slash.out.permissions.bypassDisabled'),
    )
  } else {
    posture.push(
      text(posture.length === 0 ? `${BLOCK}- ` : '\n- '),
      key('slash.out.permissions.bypassAvailable'),
    )
  }
  parts.push(...posture)

  const ruleLists = permissions.ruleLists
  const sections: Array<[MessageKey, string[]]> = [
    ['slash.out.permissions.allowHeading', ruleLists?.allow ?? []],
    ['slash.out.permissions.askHeading', ruleLists?.ask ?? []],
    ['slash.out.permissions.denyHeading', ruleLists?.deny ?? []],
  ]
  const totalDeclarative = sections.reduce(
    (sum, [, rules]) => sum + rules.length,
    0,
  )
  if (totalDeclarative === 0) {
    parts.push(...paragraph(key('slash.out.permissions.noRules')))
  } else {
    for (const [headingKey, rules] of sections) {
      if (rules.length === 0) continue
      parts.push(
        ...leadIn(key(headingKey, { count: rules.length })),
        ...bulletBlock(rules.map(rule => bullet(rule))),
      )
    }
  }

  const legacy: Array<[MessageKey, string[]]> = [
    ['slash.out.permissions.alwaysAllowHeading', formatRulesBySource(permissions.allowRuleBook)],
    ['slash.out.permissions.alwaysAskHeading', formatRulesBySource(permissions.askRuleBook)],
    ['slash.out.permissions.alwaysDenyHeading', formatRulesBySource(permissions.denyRuleBook)],
  ]
  for (const [headingKey, ruleLines] of legacy) {
    if (ruleLines.length === 0) continue
    parts.push(
      ...leadIn(key(headingKey, { count: ruleLines.length })),
      ...bulletBlock(ruleLines),
    )
  }

  const stripped = formatRulesBySource(permissions.setAsideRiskyRules)
  if (stripped.length > 0) {
    parts.push(
      ...leadIn(key('slash.out.permissions.strippedHeading', { count: stripped.length })),
      ...bulletBlock(stripped),
    )
  }

  const dirs = permissions.extraWorkspaceRoots
  if (dirs && dirs.size > 0) {
    parts.push(
      ...leadIn(key('slash.out.permissions.workingDirsHeading', { count: dirs.size })),
      ...bulletBlock(
        [...dirs].map(([path, entry]) => bullet(`${path} (${entry.source})`)),
      ),
    )
  }

  return parts
}
