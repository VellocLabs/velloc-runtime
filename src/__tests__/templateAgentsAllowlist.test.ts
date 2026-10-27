// Per-type `agents:` allowlist: absent / `all` ⇒ every agent; `[]` ⇒ none; `[names]` ⇒ exactly those,
// by the name `subagent_type` resolves. `fork` is never listed. With `mcp: plugin`, a type that offers
// the Agent tool must name its agents. The roster is narrowed in one place (`agentRosterOf`).

import { describe, expect, it } from 'vitest'
import { parseManifest } from '../prompting/templateParsing'
import { getTemplate, templateAgentRoster, unresolvedAgentNames } from '../prompting/templateRegistry'
import { agentRosterOf } from '../engine/callContextFactory'
import { resolveSubagentRoute } from '../agents/builtInAgents'

const manifest = (type: string, frontmatter: string) =>
  parseManifest(type, `---\ntype: ${type}\n${frontmatter}\n---\n\n## prompt\n!t_intro\n\n## begin\n`)

// `systemPrompt` is what marks a roster entry as a full agent definition.
const ROSTER = [
  { name: 'general-purpose', description: 'g', systemPrompt: 'g' },
  { name: 'Explore', description: 'e', systemPrompt: 'e' },
  { name: 'nebius:sandbox-dev', description: 'd', systemPrompt: 'd' },
  { name: 'nebius:sandbox-tester', description: 't', systemPrompt: 't' },
]

describe('agents: — stage one (template load)', () => {
  it('absent or `all` ⇒ no allowlist', () => {
    expect(manifest('t', '').config.agents).toBeUndefined()
    expect(manifest('t', 'agents: all').config.agents).toBeUndefined()
  })

  it('an exact list is kept, deduplicated; an empty list is a deny-all', () => {
    expect(manifest('t', 'agents: [Explore, Explore, acme:dev]').config.agents).toEqual(['Explore', 'acme:dev'])
    expect(manifest('t', 'agents: []').config.agents).toEqual([])
  })

  it('rejects a blank value, a non-name, a non-list and the fork route — loudly', () => {
    expect(() => manifest('t', 'agents:')).toThrow(/has no value/)
    expect(() => manifest('t', 'agents: [" x"]')).toThrow(/is not an agent name/)
    expect(() => manifest('t', 'agents: Explore')).toThrow(/must be "all" or a list/)
    expect(() => manifest('t', 'agents: [fork]')).toThrow(/"fork" is the session's own route/)
  })

  it('mcp: plugin with the subagent group requires an exact agents: list', () => {
    expect(() => manifest('acme:x', 'tools: [read, subagent]\nmcp: plugin\nskills: []')).toThrow(
      /requires an exact agents: list/,
    )
    expect(() => manifest('acme:x', 'tools: [read, Agent]\nmcp: plugin\nskills: []')).toThrow(
      /requires an exact agents: list/,
    )
    // Without the group nothing is offered, so nothing has to be named.
    expect(manifest('acme:x', 'tools: [read]\nmcp: plugin\nskills: []').config.agents).toBeUndefined()
    expect(
      manifest('acme:x', 'tools: [read, subagent]\nmcp: plugin\nskills: []\nagents: [acme:dev]').config.agents,
    ).toEqual(['acme:dev'])
    // Every MCP source: the roster may stay open.
    expect(manifest('t', 'tools: [read, subagent]').config.agents).toBeUndefined()
  })

  it('no bundled type declares agents:', () => {
    for (const type of ['chat', 'code', 'agent', 'safe_code', 'team']) {
      const tmpl = getTemplate(type)
      if (tmpl) expect(tmpl.config.agents, type).toBeUndefined()
    }
  })
})

describe('agents: — the roster', () => {
  it('templateAgentRoster: every agent without a list, exactly the named ones with one, none for []', () => {
    expect(templateAgentRoster(manifest('t', '').config, ROSTER)).toEqual(ROSTER)
    expect(templateAgentRoster(undefined, ROSTER)).toEqual(ROSTER)
    expect(
      templateAgentRoster(manifest('t', 'agents: [nebius:sandbox-dev, nebius:sandbox-tester]').config, ROSTER).map(a => a.name),
    ).toEqual(['nebius:sandbox-dev', 'nebius:sandbox-tester'])
    expect(templateAgentRoster(manifest('t', 'agents: []').config, ROSTER)).toEqual([])
  })

  it('matches by exact name — never case-folded', () => {
    expect(templateAgentRoster(manifest('t', 'agents: [explore]').config, ROSTER)).toEqual([])
  })

  it('unresolvedAgentNames reports a listed name no agent bears', () => {
    expect(unresolvedAgentNames(manifest('t', 'agents: [Explore, acme:missing]').config, ROSTER)).toEqual(['acme:missing'])
    expect(unresolvedAgentNames(manifest('t', '').config, ROSTER)).toEqual([])
  })

  it('agentRosterOf narrows enabledAgents and keeps allAgents whole; the route resolver follows it', () => {
    const open = agentRosterOf({ agents: ROSTER })
    expect(open.enabledAgents).toBe(ROSTER)
    const narrowed = agentRosterOf({ agents: ROSTER, agentAllowlist: ['nebius:sandbox-dev'] })
    expect(narrowed.enabledAgents.map(a => a.name)).toEqual(['nebius:sandbox-dev'])
    expect(narrowed.allAgents).toBe(ROSTER)
    expect(narrowed.restricted).toBe(true)
    expect(open.restricted).toBeUndefined()
    const rosterOnly = { rosterOnly: narrowed.restricted }
    expect(resolveSubagentRoute('nebius:sandbox-dev', narrowed.enabledAgents, rosterOnly).kind).toBe('named')
    // A built-in outside the list is unknown here — no static fallback — and
    // an omitted type (general-purpose) likewise; `fork` stays the session's own.
    expect(resolveSubagentRoute('Explore', narrowed.enabledAgents, rosterOnly).kind).toBe('error')
    expect(resolveSubagentRoute(undefined, narrowed.enabledAgents, rosterOnly).kind).toBe('error')
    expect(resolveSubagentRoute('fork', narrowed.enabledAgents, rosterOnly).kind).toBe('fork')
    // Without the flag the fallback stays, as before.
    expect(resolveSubagentRoute('Explore', narrowed.enabledAgents).kind).toBe('named')
  })
})
