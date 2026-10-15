// Per-type `skills:` allowlist (F-19): `all` (and absence) ⇒ every skill; `[]` ⇒ deny-all; `[ids]` ⇒ exact
// allowlist by stable `<source>:<name>`, never the display name; a malformed id throws at template load, an
// unresolved one is reported at skill resolution; no `skills` tool group ⇒ no skills at all.

import { describe, expect, it } from 'vitest'
import { parseManifest } from '../prompting/templateParsing'
import {
  __templateBundleForTest,
  getTemplate,
  isMcpServerSkillCommand,
  skillId,
  templateAllowsSkill,
  unresolvedSkillIds,
} from '../prompting/templateRegistry'
import {
  isSkillDeniedByTemplate,
  partitionSkillsForSession,
  resolveInvocationForSession,
} from '../skillLibrary/skillDiscovery'
import {
  getBundledSkillCommands,
  getBundledSkillRequiredTools,
  isBundledSkillModelInvocableIn,
} from '../skillLibrary/builtinSkills'
import { installStockSkills } from '../skillLibrary/builtin/catalog'
import { expandGroups } from '../toolkit/builtin/toolGroups'

const manifest = (frontmatter: string) =>
  parseManifest('t', `---\ntype: t\n${frontmatter}\n---\n\n## prompt\n!t_intro\n\n## begin\n`)

const skill = (source: string, name: string) => ({ name, source })

/** The skills a manifest may name in `deferredTools:` (the rest are tool groups). */
const DEFERRABLE_SKILLS = ['browser', 'a2ui', 'agent-teams']

describe('skills: — stage one (template load: syntax + namespace)', () => {
  it('absent or `all` ⇒ no allowlist (every skill)', () => {
    expect(manifest('description: x').config.skills).toBeUndefined()
    expect(manifest('skills: all').config.skills).toBe('all')
  })

  it('an empty list is an explicit deny-all, not "absent"', () => {
    // The distinction matters: `undefined` means "no boundary", `[]` means
    // "this type may use no skills at all".
    expect(manifest('skills: []').config.skills).toEqual([])
  })

  it('accepts every known source namespace', () => {
    expect(
      manifest('skills: [bundled:browser, project:deploy, user:notes, plugin:x]').config
        .skills,
    ).toEqual(['bundled:browser', 'project:deploy', 'user:notes', 'plugin:x'])
  })

  it('rejects an unknown namespace, a bare name, and a non-list — loudly', () => {
    // A silently-dropped id would turn a capability boundary into a typo.
    expect(() => manifest('skills: [foo:bar]')).toThrow(/is not a skill id/)
    expect(() => manifest('skills: [browser]')).toThrow(/is not a skill id/)
    expect(() => manifest('skills: [bundled:]')).toThrow(/is not a skill id/)
    expect(() => manifest('skills: [7]')).toThrow(/is not a skill id/)
    expect(() => manifest('skills: everything')).toThrow(/must be "all" or a list/)
    expect(() => manifest('skills: true')).toThrow(/must be "all" or a list/)
  })

  it('a BLANK `skills:` fails closed — it is not "absent" (allow-all)', () => {
    // YAML reads `skills:` with no value as null; mapping that to "no
    // allowlist" turned an author's half-written deny-all into allow-all.
    expect(() => manifest('skills:')).toThrow(/skills: has no value/)
    expect(() => manifest('skills: ~')).toThrow(/skills: has no value/)
  })

  it('names the offending id and the type in the error', () => {
    expect(() => manifest('skills: [nope:x]')).toThrow(/template "t": skills: "nope:x"/)
  })
})

describe('skills: — the allowlist predicate', () => {
  const listed = { type: 't', skills: ['bundled:browser'] }

  it('no allowlist / `all` admits everything', () => {
    for (const config of [{ type: 't' }, { type: 't', skills: 'all' as const }]) {
      expect(templateAllowsSkill(config, skill('bundled', 'browser'))).toBe(true)
      expect(templateAllowsSkill(config, skill('project', 'anything'))).toBe(true)
    }
    expect(templateAllowsSkill(undefined, skill('user', 'x'))).toBe(true)
  })

  it('an exact list admits only its ids — by identity, not display name', () => {
    expect(templateAllowsSkill(listed, skill('bundled', 'browser'))).toBe(true)
    // Same NAME, different source ⇒ a different skill ⇒ denied.
    expect(templateAllowsSkill(listed, skill('project', 'browser'))).toBe(false)
    expect(templateAllowsSkill(listed, skill('bundled', 'other'))).toBe(false)
  })

  it('`[]` denies every skill', () => {
    expect(templateAllowsSkill({ type: 't', skills: [] }, skill('bundled', 'browser'))).toBe(
      false,
    )
  })

  it('an MCP server skill bypasses the allowlist — it has its own gate', () => {
    // Server names come from the user's settings, so no template could
    // enumerate them; `noExecution` / `templateAllowsMcp` governs them.
    const mcp = skill('bundled', 'mcp__my-server')
    expect(isMcpServerSkillCommand(mcp)).toBe(true)
    expect(templateAllowsSkill({ type: 't', skills: [] }, mcp)).toBe(true)
    expect(templateAllowsSkill(listed, mcp)).toBe(true)
  })

  it('a workspace/user skill NAMED `mcp__x` gets no bypass — deny-all still denies it', () => {
    // Only the bundled MCP server entry points are exempt; the prefix alone
    // let a project skill directory called `mcp__x` past safe_code's `[]`.
    for (const source of ['project', 'user', 'plugin']) {
      const impostor = skill(source, 'mcp__x')
      expect(isMcpServerSkillCommand(impostor), source).toBe(false)
      expect(templateAllowsSkill({ type: 't', skills: [] }, impostor), source).toBe(false)
    }
  })

  it('skillId is `<source>:<name>`', () => {
    expect(skillId(skill('user', 'notes'))).toBe('user:notes')
  })
})

describe('skills: — stage two (session skill resolution)', () => {
  const loaded = [skill('bundled', 'browser'), skill('project', 'deploy')]

  it('reports a well-formed id that names no loaded skill', () => {
    expect(
      unresolvedSkillIds({ type: 't', skills: ['bundled:browser', 'project:gone'] }, loaded),
    ).toEqual(['project:gone'])
  })

  it('reports nothing when every id resolves, or when there is no allowlist', () => {
    expect(unresolvedSkillIds({ type: 't', skills: ['project:deploy'] }, loaded)).toEqual([])
    expect(unresolvedSkillIds({ type: 't', skills: 'all' }, loaded)).toEqual([])
    expect(unresolvedSkillIds(undefined, loaded)).toEqual([])
  })

  it('an unresolved id is reported, NOT treated as a grant', () => {
    const config = { type: 't', skills: ['project:gone'] }
    expect(unresolvedSkillIds(config, loaded)).toEqual(['project:gone'])
    // …and it admits nothing, so the boundary holds either way.
    for (const s of loaded) expect(templateAllowsSkill(config, s)).toBe(false)
  })
})

describe('skills: — the partition reports a name only when nothing by that name survives', () => {
  it('drops a denied name that another source still provides, and reports each name once', () => {
    // `user:review` is denied but `bundled:review` is allowed: `/review`
    // works, so "review" is not a denied NAME. The session-types gate's names
    // are merged the same way, and never twice.
    const { allowed, deniedNames } = partitionSkillsForSession(
      { type: 't', skills: ['bundled:review'] },
      [skill('user', 'review'), skill('bundled', 'review'), skill('user', 'notes')],
      ['notes', 'notes', 'other'],
    )
    expect(allowed.map(skillId)).toEqual(['bundled:review'])
    expect(deniedNames).toEqual(['notes', 'other'])
  })

  it('a gate-denied name is not reported when the allowlist admits a same-named skill', () => {
    const { deniedNames } = partitionSkillsForSession(
      { type: 't', skills: ['bundled:review'] },
      [skill('bundled', 'review')],
      ['review'],
    )
    expect(deniedNames).toEqual([])
  })
})

describe('skills: — the dispatch surfaces say "denied", not "unknown"', () => {
  const context = (deniedSkillNames?: string[]) =>
    ({ options: { commands: [], deniedSkillNames } }) as never

  it('recognises a denied name with a leading slash — exact-case, like the lookup it explains', () => {
    expect(isSkillDeniedByTemplate(context(['browser']), 'browser')).toBe(true)
    expect(isSkillDeniedByTemplate(context(['browser']), '/browser')).toBe(true)
    expect(isSkillDeniedByTemplate(context(['browser']), 'other')).toBe(false)
    // `findCommandByName` is exact-case, so `Browser` would never have
    // matched an allowed skill either: it is "unknown", not "denied". A
    // case-insensitive denial here would explain a miss the lookup never
    // classified that way.
    expect(isSkillDeniedByTemplate(context(['browser']), 'Browser')).toBe(false)
  })

  it('reports nothing when the type denied nothing', () => {
    expect(isSkillDeniedByTemplate(context(), 'browser')).toBe(false)
    expect(isSkillDeniedByTemplate(context([]), 'browser')).toBe(false)
  })
})

describe('skills: — the bundled manifests', () => {
  it('safe_code denies every skill, and has no Skill tool either', () => {
    const config = getTemplate('safe_code')!.config
    expect(config.skills).toEqual([])
    // Belt AND braces: the allowlist is the declared boundary, and the
    // missing `skills` group means the Skill tool never reaches the session.
    expect(expandGroups(config.tools ?? []).has('Skill')).toBe(false)
  })

  it('a type never DEFERS a skill its allowlist denies — that would be a contradiction', () => {
    // `deferredTools` says "activate this on demand"; activation IS a
    // `Skill('<name>')` call, which the allowlist gates. A manifest that
    // defers a skill it denies advertises a door that is bricked up.
    // Every BUNDLED type, read from the registry — a new type is covered the
    // day it lands, without editing a list here.
    for (const type of __templateBundleForTest().templateTypes) {
      const config = getTemplate(type)!.config
      for (const deferred of config.deferredTools ?? []) {
        // Only SKILLS are gated (a deferred tool GROUP like `shell` is not a
        // skill); bundled skills are the only deferrable ones today.
        if (!DEFERRABLE_SKILLS.includes(deferred)) continue
        expect(
          templateAllowsSkill(config, { name: deferred, source: 'bundled' }),
          `${type} defers "${deferred}" but its skills: allowlist denies it`,
        ).toBe(true)
      }
    }
  })

  it('the open types stay open — no accidental boundary', () => {
    for (const type of ['code', 'agent', 'chat']) {
      expect(getTemplate(type)!.config.skills, type).toBeUndefined()
    }
  })

  it('no type admits a bundled skill whose `requiredTools` it cannot run', () => {
    // A type that sees a bundled skill (presence, not model-invocability) must register every tool the skill
    // requires (`requiredTools`); checked for every bundled type.
    installStockSkills()
    const types = __templateBundleForTest().templateTypes
    expect(types.length).toBeGreaterThan(0)
    const checked: string[] = []
    for (const type of types) {
      const config = getTemplate(type)!.config
      // Tools the session can reach: the loaded groups plus the deferred
      // ones (a deferred group is registered and surfaces on activation).
      const reachable = expandGroups([
        ...(config.tools ?? []),
        ...(config.deferredTools ?? []),
      ])
      for (const command of getBundledSkillCommands()) {
        const required = getBundledSkillRequiredTools(command.name)
        if (!required) continue
        const admitted =
          resolveInvocationForSession(command, type).present
          && templateAllowsSkill(config, command)
        if (!admitted) continue
        checked.push(`${type}:${command.name}`)
        for (const tool of required) {
          expect(
            reachable.has(tool),
            `${type} admits bundled:${command.name}, which requires ${tool}, but its tool set cannot reach it`,
          ).toBe(true)
        }
      }
    }
    // The guard bites: the skills that declare requirements are admitted
    // somewhere (otherwise a typo in a gate would silently pass this), and
    // NOT admitted by the type that cannot run them.
    expect(checked).toContain('code:simplify')
    expect(checked).toContain('code:batch')
    expect(checked).toContain('team:simplify')
    expect(checked).toContain('team:batch')
    expect(checked).not.toContain('chat:simplify')
    expect(checked).not.toContain('chat:batch')
  })
})
