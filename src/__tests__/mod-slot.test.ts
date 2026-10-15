/**
 * Which sessions get a mod runtime. The decision is one small predicate
 * because `createAgentRuntime` is too large to instantiate in a unit test, and
 * getting it wrong is silent: a session that should not have a runtime simply
 * spawns workers and fires `session.start` nobody asserted on.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { isModSlot, selectModModules } from '../mods/modSlot'

const PLUGINS = [
  { name: 'a', hookModules: ['/p/a/hooks/one.js', '/p/a/hooks/two.js'] },
  { name: 'skills-only' },
  { name: 'b', hookModules: ['/p/b/hooks/register.js'] },
  { name: 'empty', hookModules: [] },
]

describe('isModSlot', () => {
  it.each([
    ['a top-level session', {}, true],
    ['a top-level session, flags spelled out', { isSubAgent: false, isHeadless: false, teammateName: '' }, true],
    ['a sub-agent', { isSubAgent: true }, false],
    ['a headless run (a routine)', { isHeadless: true }, false],
    ['a headless run with mods.headless opted in (H-15)', { isHeadless: true, headlessMods: true }, true],
    ['a headless run opted in that is a sub-agent', { isSubAgent: true, isHeadless: true, headlessMods: true }, false],
    ['a top-level session, the opt-in irrelevant', { headlessMods: true }, true],
    // A teammate is a REAL child session with a page of its own: a slot like
    // any top-level session.
    ['a teammate', { isTeammate: true, teammateName: 'researcher' }, true],
    ['a teammate known by its name alone', { teammateName: 'researcher' }, true],
    ['a teammate known by its flag alone', { isTeammate: true }, true],
    ['a teammate that is also flagged a sub-agent', { isSubAgent: true, teammateName: 'researcher' }, false],
    ['a headless sub-agent', { isSubAgent: true, isHeadless: true }, false],
  ])('%s', (_name, session, expected) => {
    expect(isModSlot(session)).toBe(expected)
  })
})

describe('selectModModules', () => {
  it("a top-level session loads every plugin's modules, in plugin order then list order", () => {
    // `options: {}`: a plugin without `userConfig` loads with none;
    // `provenance`: a directory-walk plugin is `<name>@inline`.
    expect(selectModModules({}, PLUGINS)).toEqual([
      { plugin: 'a', path: '/p/a/hooks/one.js', options: {}, provenance: 'a@inline' },
      { plugin: 'a', path: '/p/a/hooks/two.js', options: {}, provenance: 'a@inline' },
      { plugin: 'b', path: '/p/b/hooks/register.js', options: {}, provenance: 'b@inline' },
    ])
  })

  it.each([
    ['a sub-agent', { isSubAgent: true }],
    ['a headless run', { isHeadless: true }],
  ])('%s loads none, whatever plugins are enabled', (_name, session) => {
    expect(selectModModules(session, PLUGINS)).toEqual([])
  })

  it("a teammate loads every plugin's modules, as a top-level session does", () => {
    expect(selectModModules({ isTeammate: true, teammateName: 'researcher' }, PLUGINS)).toEqual(
      selectModModules({}, PLUGINS),
    )
    expect(selectModModules({ isTeammate: true, teammateName: 'researcher' }, PLUGINS)).toHaveLength(3)
  })

  it('no plugin with a module is no module', () => {
    expect(selectModModules({}, [{ name: 'skills-only' }, { name: 'empty', hookModules: [] }])).toEqual([])
    expect(selectModModules({}, [])).toEqual([])
  })
})

describe('createAgentRuntime hands the predicate every fact', () => {
  // The runtime builder cannot be instantiated here, so pin the call site's
  // text: the decision must go through `selectModModules`, and it must be
  // handed the teammate identity — the fact a hand-rolled condition forgot.
  const source = readFileSync(
    join(__dirname, '..', 'browser', 'runtime', 'createAgentRuntime.ts'),
    'utf8',
  )
  // The facts are built once (`modSlotFacts`) and handed to the predicate at
  // boot and again at every plugin reload (`reconcileMods`).
  const factsAt = source.indexOf('const modSlotFacts = {')
  const at = source.indexOf('const modModules = selectModModules(modSlotFacts,', factsAt)
  const call = source.slice(factsAt, at)

  it('calls selectModModules, at boot and at a plugin reload', () => {
    expect(factsAt).toBeGreaterThan(0)
    expect(at).toBeGreaterThan(factsAt)
    expect(source).toContain('selectModModules(modSlotFacts, plugins, await readPluginConfigs(), await readEnabledPlugins())')
  })

  it.each(['isSubAgent', 'isHeadless', 'headlessMods', 'isTeammate', 'teammateName'])('passes %s', fact => {
    expect(call).toContain(fact)
  })

  it('has no second, hand-rolled condition deciding the same thing', () => {
    expect(source).not.toMatch(/isSubAgent === true \|\| isHeadlessSession\s*\n\s*\? \[\]/)
  })
})
