/**
 * A plugin's UI contributions (F-25): the manifest's `templates` and
 * `ui.topbar`, the `requires` gate (F-14), the realm's contributions host,
 * what a topbar press types, and a plugin template session's start.
 */
import { afterEach, describe, expect, it } from 'vitest'

import { checkTemplateDecls, checkUiDecl, isPluginTemplateId, modUiId } from '../mods/ui/uiManifest'
import {
  checkRequires,
  requirementsSignature,
  splitByRequirements,
  type ProviderGateState,
} from '../pluginHost/pluginRequirements'
import { topbarCommandPrompt } from '../mods/ui/topbarCommand'
import { ModUiContributionsHost, type ContributingPlugin } from '../mods/ui/contributionsHost'
import { resolveTopbarItem, resetModContributionsState } from '../mods/ui/contributionsState'
import {
  PluginTemplateUnavailableError,
  checkTemplateOwner,
  openPluginTemplate,
} from '../mods/ui/pluginTemplateSession'
import { __resetPluginTypesForTest, getHolderProse, getTemplate } from '../prompting/templateRegistry'

afterEach(() => {
  resetModContributionsState()
  __resetPluginTypesForTest()
})

describe('templates in the manifest', () => {
  it('takes a well-formed entry with defaults, and every icon form', () => {
    const errors: string[] = []
    const out = checkTemplateDecls(
      'acme',
      {
        review: { title: 'Review', icon: './icon.svg' },
        plan: { title: { en: 'Plan', zh: '计划' }, icon: 'lucide:list-checks', launcher: 'menu', path: './t/plan/' },
        masked: { title: 'M', icon: { mask: './m.svg' } },
        themed: { title: 'T', icon: { src: './l.svg', dark: './d.svg' }, launcher: 'hidden' },
      },
      errors,
    )
    expect(errors).toEqual([])
    expect(out).toEqual({
      review: { title: 'Review', icon: { kind: 'file', src: './icon.svg', mask: false }, launcher: 'both', path: './templates/review' },
      plan: { title: { en: 'Plan', zh: '计划' }, icon: { kind: 'lucide', name: 'list-checks' }, launcher: 'menu', path: './t/plan' },
      masked: { title: 'M', icon: { kind: 'file', src: './m.svg', mask: true }, launcher: 'both', path: './templates/masked' },
      themed: { title: 'T', icon: { kind: 'file', src: './l.svg', mask: false, dark: './d.svg' }, launcher: 'hidden', path: './templates/themed' },
    })
  })

  it('drops a bad entry whole with a reason per problem, and keeps the others', () => {
    const errors: string[] = []
    const out = checkTemplateDecls(
      'acme',
      {
        ok: { title: 'OK' },
        'Bad Key': { title: 'x' },
        escape: { title: 'x', path: '../outside' },
        noTitle: {},
        icon: { title: 'x', icon: 'https://cdn.example/a.svg' },
        place: { title: 'x', launcher: 'everywhere' },
      },
      errors,
    )
    expect(Object.keys(out!)).toEqual(['ok'])
    expect(errors).toHaveLength(5)
    expect(errors.join('\n')).toMatch(/templates\.Bad Key: the key must be/)
    expect(errors.join('\n')).toMatch(/templates\.escape\.path/)
  })

  it('refuses a plugin name that cannot form an id', () => {
    const errors: string[] = []
    expect(checkTemplateDecls('acme corp', { a: { title: 'A' } }, errors)).toBeUndefined()
    expect(errors[0]).toMatch(/cannot form an id/)
  })

  it('ids are <plugin>:<key>; a bundled type never reads as a plugin one', () => {
    expect(modUiId('acme', 'review')).toBe('acme:review')
    expect(isPluginTemplateId('acme:review')).toBe(true)
    expect(isPluginTemplateId('code')).toBe(false)
    expect(isPluginTemplateId('acme:')).toBe(false)
    expect(isPluginTemplateId(':review')).toBe(false)
    expect(isPluginTemplateId(undefined)).toBe(false)
  })
})

describe('ui in the manifest', () => {
  it('takes topbar items, at most four a plugin, and reports the reserved settingsPages', () => {
    const errors: string[] = []
    const topbar = Object.fromEntries(
      ['a', 'b', 'c', 'd', 'e'].map(key => [key, { title: key.toUpperCase(), command: 'review-diff', args: ' --staged ' }]),
    )
    const out = checkUiDecl('acme', { topbar, settingsPages: { main: {} } }, errors)
    expect(Object.keys(out!.topbar!)).toEqual(['a', 'b', 'c', 'd'])
    expect(out!.topbar!.a).toEqual({ title: 'A', command: 'review-diff', args: '--staged' })
    expect(errors).toEqual([
      'ui.settingsPages: settings pages are not available yet; ignored',
      'ui.topbar.e: a plugin offers at most 4 topbar items; this one is left out',
    ])
  })

  it('refuses a command with a slash or a multi-line args', () => {
    const errors: string[] = []
    const out = checkUiDecl(
      'acme',
      { topbar: { a: { title: 'A', command: '/review' }, b: { title: 'B', command: 'x', args: 'one\ntwo' }, c: { title: 'C', command: 'sub:cmd' } } },
      errors,
    )
    expect(Object.keys(out!.topbar!)).toEqual(['c'])
    expect(errors).toHaveLength(2)
  })
})

describe('requires', () => {
  const owned = (id: string): ProviderGateState => ({
    loaded: true,
    isSetUp: providerId => providerId === id,
    owner: () => 'neb@mkt',
  })
  const plugin = (requires: ReturnType<typeof checkRequires>) => ({
    name: 'neb',
    installIdentifier: 'neb@mkt',
    manifest: { name: 'neb', ...(requires ? { requires } : {}) },
    providers: [{ key: 'main', id: 'mod.neb.main', manifest: {} as never, modulePath: '/p' }],
  })

  it('reads providers; an undeclared key or an unknown word is reported and keeps the plugin waiting', () => {
    const errors: string[] = []
    expect(checkRequires({ providers: ['main', 'main'] }, ['main'], errors)).toEqual({ providers: ['main'] })
    expect(errors).toEqual([])
    expect(checkRequires({ providers: ['other'] }, ['main'], errors)).toEqual({ providers: ['other'] })
    expect(checkRequires({ plugins: ['x'] }, ['main'], errors)).toEqual({ unknown: ['plugins'] })
    expect(checkRequires({ providers: [] }, ['main'], errors)).toEqual({ unknown: ['providers'] })
    expect(errors).toHaveLength(3)
  })

  it('is met only once the plugin\'s own provider is set up by this install', () => {
    const p = plugin({ providers: ['main'] })
    expect(splitByRequirements([p], owned('mod.neb.main')).effective).toEqual([p])
    expect(splitByRequirements([p], owned('other')).waiting[0]!.unmet).toEqual([{ kind: 'provider', key: 'main', providerId: 'mod.neb.main' }])
    // Before settings.json is read nothing is met.
    expect(splitByRequirements([p], { ...owned('mod.neb.main'), loaded: false }).effective).toEqual([])
    // An entry another install of the same name set up does not count.
    expect(splitByRequirements([p], { ...owned('mod.neb.main'), owner: () => 'neb@other' }).effective).toEqual([])
    // A plugin without requires is always in effect.
    expect(splitByRequirements([plugin(undefined)], owned('none')).effective).toHaveLength(1)
  })

  it('the signature changes exactly when a plugin moves between in effect and waiting', () => {
    const p = plugin({ providers: ['main'] })
    const before = requirementsSignature([p], owned('other'))
    expect(requirementsSignature([p], owned('other2'))).toBe(before)
    expect(requirementsSignature([p], owned('mod.neb.main'))).not.toBe(before)
  })
})

describe('what a topbar press types', () => {
  const sources = {
    modCommands: [
      { name: 'review', plugin: 'acme' },
      { name: 'deploy', plugin: 'other' },
    ],
    promptCommands: [
      { name: 'acme:review-diff', pluginName: 'acme' },
      { name: 'other:wipe', pluginName: 'other' },
      { name: 'compact' },
    ],
  }

  it('the plugin\'s registered command, then its own commands/ entry', () => {
    expect(topbarCommandPrompt({ plugin: 'acme', command: 'review', args: '--fast' }, sources)).toBe('/review --fast')
    expect(topbarCommandPrompt({ plugin: 'acme', command: 'review-diff' }, sources)).toBe('/acme:review-diff')
  })

  it('never another plugin\'s command or an engine command', () => {
    expect(topbarCommandPrompt({ plugin: 'acme', command: 'deploy' }, sources)).toBeUndefined()
    expect(topbarCommandPrompt({ plugin: 'acme', command: 'wipe' }, sources)).toBeUndefined()
    expect(topbarCommandPrompt({ plugin: 'acme', command: 'compact' }, sources)).toBeUndefined()
  })
})

// ── the contributions host over an in-memory plugin folder ──

const SVG = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16"><path d="M0 0h16v16z"/></svg>'

function rig(files: Record<string, string>, gate: ProviderGateState = { loaded: true, isSetUp: () => true, owner: () => 'acme@mkt' }) {
  const reads: string[] = []
  let current = gate
  const reports: string[] = []
  const host = new ModUiContributionsHost()
  host.configure({
    readText: async path => {
      reads.push(path)
      const text = files[path.replace(/\\/g, '/')]
      if (text === undefined) throw new Error('ENOENT')
      return text
    },
    listFiles: async path => {
      const prefix = `${path.replace(/\\/g, '/')}/`
      return Object.keys(files)
        .filter(file => file.startsWith(prefix) && !file.slice(prefix.length).includes('/'))
        .map(file => file.slice(prefix.length))
    },
    gate: () => current,
    report: line => reports.push(line),
  })
  return { host, reads, reports, setGate: (next: ProviderGateState) => (current = next) }
}

function acme(extra: Partial<ContributingPlugin['manifest']> = {}, source = 'marketplace:acme@mkt'): ContributingPlugin {
  return {
    name: 'acme',
    path: '/plugins/acme',
    source,
    installIdentifier: 'acme@mkt',
    manifest: {
      name: 'acme',
      ui: { topbar: { diff: { title: 'Diff', command: 'review-diff', icon: { kind: 'file', src: './icon.svg', mask: true } } } },
      ...extra,
    },
    providers: [{ key: 'main', id: 'mod.acme.main', manifest: {} as never, modulePath: '/p' }],
    templates: [
      {
        key: 'review',
        type: 'acme:review',
        decl: { title: 'Review', icon: { kind: 'file', src: './icon.svg', mask: false }, launcher: 'both', path: './templates/review' },
        dir: '/plugins/acme/templates/review',
      },
    ],
  }
}

const FILES = {
  '/plugins/acme/icon.svg': SVG,
  '/plugins/acme/templates/review/template.md': '---\ntype: acme:review\ntools: [read]\n---\n\n## prompt\n!review_intro\n!agent_intro\n',
  '/plugins/acme/templates/review/includes/review_intro.md': 'You review diffs.',
  '/plugins/acme/templates/review/welcome.md': '---\ngreeting: Ready\nsuggestions:\n  - title: Review my diff\n---\n',
  '/plugins/acme/templates/review/welcome-zh.md': '---\ngreeting: 就绪\nsuggestions:\n  - title: 审查\n---\n',
}

describe('the contributions host', () => {
  it('publishes the launchers and topbar items with one copy of each icon, keyed by content hash', async () => {
    const { host } = rig(FILES)
    await host.sync({ enabled: [acme()] })
    const state = host.state()
    expect(Object.keys(state.icons)).toHaveLength(1)
    const [hash] = Object.keys(state.icons)
    expect(hash).toMatch(/^[0-9a-f]{24}$/)
    expect(state.icons[hash!]).toBe(SVG)
    expect(state.templates).toEqual([
      {
        type: 'acme:review',
        plugin: 'acme',
        owner: 'acme@mkt',
        title: 'Review',
        icon: { ref: hash },
        launcher: 'both',
        welcome: {
          '': { greeting: 'Ready', suggestions: [{ title: 'Review my diff' }] },
          zh: { greeting: '就绪', suggestions: [{ title: '审查' }] },
        },
      },
    ])
    expect(state.topbar).toEqual([{ id: 'acme:diff', plugin: 'acme', title: 'Diff', icon: { ref: hash, mask: true } }])
    expect(state.waiting).toEqual([])
  })

  it('a project\'s plugin contributes nothing; an unreadable or unsafe icon falls back with a report', async () => {
    const project = rig(FILES)
    await project.host.sync({ enabled: [acme({}, 'project:/work')] })
    expect(project.host.state().templates).toEqual([])
    const unsafe = rig({ ...FILES, '/plugins/acme/icon.svg': '<svg><script>x</script></svg>' })
    await unsafe.host.sync({ enabled: [acme()] })
    expect(unsafe.host.state().templates[0]!.icon).toBeUndefined()
    expect(unsafe.reports.join('\n')).toMatch(/not a plain SVG/)
  })

  it('a plugin waiting on its provider lists as waiting, offers nothing, and comes back when the provider is set up', async () => {
    const off: ProviderGateState = { loaded: true, isSetUp: () => false, owner: () => undefined }
    const { host, setGate } = rig(FILES, off)
    let gateChanges = 0
    host.onGateChanged(() => gateChanges++)
    await host.sync({ enabled: [acme({ requires: { providers: ['main'] } })] })
    expect(host.state().templates).toEqual([])
    expect(host.state().topbar).toEqual([])
    expect(host.state().waiting).toEqual([{ plugin: 'acme', owner: 'acme@mkt', providers: [{ key: 'main', id: 'mod.acme.main' }] }])
    expect(host.templateStatus('acme:review')).toEqual({ state: 'waiting', plugin: 'acme', providers: [{ key: 'main', id: 'mod.acme.main' }] })
    expect(resolveTopbarItem('acme:diff')).toEqual({ kind: 'waiting' })

    host.recheckGate()
    expect(gateChanges).toBe(0)
    setGate({ loaded: true, isSetUp: () => true, owner: () => 'acme@mkt' })
    host.recheckGate()
    expect(gateChanges).toBe(1)
    expect(host.state().templates.map(t => t.type)).toEqual(['acme:review'])
    expect(resolveTopbarItem('acme:diff')).toEqual({ kind: 'run', plugin: 'acme', command: 'review-diff' })
  })

  it('a turned-off plugin is absent; an unknown topbar id resolves to nothing', async () => {
    const { host } = rig(FILES)
    await host.sync({ enabled: [acme()] })
    await host.sync({ enabled: [] })
    expect(host.state().templates).toEqual([])
    expect(host.state().icons).toEqual({})
    expect(host.templateStatus('acme:review')).toEqual({ state: 'absent', plugin: 'acme' })
    expect(resolveTopbarItem('acme:diff')).toEqual({ kind: 'unknown' })
  })

  it('whenSynced waits for the first scan', async () => {
    const { host } = rig(FILES)
    let settled = false
    const waiting = host.whenSynced().then(() => (settled = true))
    await Promise.resolve()
    expect(settled).toBe(false)
    await host.sync({ enabled: [acme()] })
    await waiting
    expect(settled).toBe(true)
    await host.whenSynced()
  })
})

describe('a plugin template session', () => {
  it('registers the type from the plugin\'s files, its own holders first, then the bundled ones', async () => {
    const { host } = rig(FILES)
    await host.sync({ enabled: [acme()] })
    await expect(openPluginTemplate('acme:review', host)).resolves.toEqual({ owner: 'acme@mkt' })
    expect(getTemplate('acme:review')!.config.tools).toEqual(['read'])
    expect(getHolderProse('review_intro', { type: 'acme:review' })).toBe('You review diffs.')
    expect(getHolderProse('agent_intro', { type: 'acme:review' })).toBe(getHolderProse('agent_intro', { type: 'agent' }))
  })

  it('refuses with a code the page shows: plugin off, provider not set up, another install', async () => {
    const off = rig(FILES)
    await off.host.sync({ enabled: [] })
    await expect(openPluginTemplate('acme:review', off.host)).rejects.toMatchObject({ code: 'plugin_template_absent' })

    const waiting = rig(FILES, { loaded: true, isSetUp: () => false, owner: () => undefined })
    await waiting.host.sync({ enabled: [acme({ requires: { providers: ['main'] } })] })
    await expect(openPluginTemplate('acme:review', waiting.host)).rejects.toMatchObject({ code: 'plugin_template_waiting' })
    expect(getTemplate('acme:review')).toBeUndefined()

    expect(() => checkTemplateOwner('acme:review', 'acme@old', 'acme@mkt')).toThrow(PluginTemplateUnavailableError)
    expect(() => checkTemplateOwner('acme:review', 'acme@mkt', 'acme@mkt')).not.toThrow()
    expect(() => checkTemplateOwner('acme:review', undefined, 'acme@mkt')).not.toThrow()
  })
})
