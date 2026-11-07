/**
 * Mod apps in the manifest (F-40): the beta-only `apps` feature, a template's
 * `app` block, and the apps the contributions host publishes.
 */
import { afterEach, describe, expect, it } from 'vitest'

import { appIdOf, checkTemplateDecls } from '../mods/ui/uiManifest'
import { checkRequires, knownFeatures } from '../pluginHost/pluginRequirements'
import { checkPluginDescriptor } from '../pluginHost/manifestValidator'
import { ModUiContributionsHost, type ContributingPlugin } from '../mods/ui/contributionsHost'
import type { ProviderGateState } from '../pluginHost/pluginRequirements'
import { resetModContributionsState } from '../mods/ui/contributionsState'
import { isModContributionsState } from '../browser/webview/mods/modContributionsView'

afterEach(() => resetModContributionsState())

const APP = { seed: './app', entry: 'board.a2ui', data: 'data/latest.json', localActions: ['refresh', 'refresh'] }

describe('the apps feature', () => {
  it('is served on beta only; on stable a plugin naming it waits with a reason', () => {
    expect(knownFeatures('beta')).toContain('apps')
    expect(knownFeatures('stable')).not.toContain('apps')
    expect(knownFeatures('stable')).toContain('session-type')

    const onBeta: string[] = []
    expect(checkRequires({ features: ['apps'] }, [], onBeta, 'beta')).toEqual({ features: ['apps'] })
    expect(onBeta).toEqual([])

    const onStable: string[] = []
    expect(checkRequires({ features: ['apps', 'session-type'] }, [], onStable, 'stable')).toEqual({
      features: ['session-type'],
      unknown: ['features:apps'],
    })
    expect(onStable).toEqual(['requires.features: "apps" is served on the beta channel only; the plugin stays waiting'])
  })
})

describe('an app template in the manifest', () => {
  it('takes an app on beta, hidden from the launcher list, with its defaults', () => {
    const errors: string[] = []
    const decls = checkTemplateDecls('pay', { board: { title: 'Payments', app: APP } }, errors, 'beta')
    expect(errors).toEqual([])
    expect(decls).toEqual({
      board: {
        title: 'Payments',
        launcher: 'hidden',
        path: './templates/board',
        app: { seed: './app', seedVersion: 1, entry: 'board.a2ui', data: 'data/latest.json', localActions: ['refresh'] },
      },
    })
  })

  it('leaves an app out on stable and keeps the other templates', () => {
    const errors: string[] = []
    const decls = checkTemplateDecls('pay', { board: { title: 'Payments', app: APP }, notes: { title: 'Notes' } }, errors, 'stable')
    expect(Object.keys(decls ?? {})).toEqual(['notes'])
    expect(errors).toEqual(['templates.board.app: apps are served on the beta channel only; the template is left out'])
  })

  it('refuses a path that leaves the app\'s folder or the plugin, with a reason per problem', () => {
    for (const entry of ['../x.a2ui', '.velloc/x.a2ui', 'ui/.hidden.a2ui', 'a\\b.a2ui', '/abs.a2ui', 'board.json']) {
      const errors: string[] = []
      expect(checkTemplateDecls('pay', { board: { title: 'P', app: { ...APP, entry } } }, errors, 'beta')).toBeUndefined()
      expect(errors).toHaveLength(1)
      expect(errors[0]).toMatch(/^templates\.board\.app\.entry: /)
    }
    const errors: string[] = []
    const bad = { seed: '../elsewhere', entry: 'd.a2ui', data: 'd.txt', seedVersion: 0, localActions: ['a b'] }
    expect(checkTemplateDecls('pay', { board: { title: 'P', app: bad } }, errors, 'beta')).toBeUndefined()
    expect(errors.map(line => line.split(':')[0])).toEqual([
      'templates.board.app.seed',
      'templates.board.app.seedVersion',
      'templates.board.app.data',
      'templates.board.app.localActions',
    ])
  })

  it('refuses a launcher place or a project folder on an app, and an id that cannot name a folder', () => {
    const errors: string[] = []
    expect(checkTemplateDecls('pay', { a: { title: 'P', launcher: 'both', app: APP } }, errors, 'beta')).toBeUndefined()
    expect(checkTemplateDecls('pay', { a: { title: 'P', projectFolder: 'required', app: APP } }, errors, 'beta')).toBeUndefined()
    expect(checkTemplateDecls('_pay', { a: { title: 'P', app: APP } }, errors, 'beta')).toBeUndefined()
    expect(errors).toEqual([
      'templates.a.launcher: an app opens from its topbar icon; expected "hidden" or no launcher',
      'templates.a.projectFolder: an app works in its own folder; leave projectFolder out',
      'templates.a.app: the app id "-pay-a" (plugin name and key) must be 1-63 letters, digits and "-", starting with a letter or digit',
    ])
    // A hidden launcher said out loud is the same app.
    expect(checkTemplateDecls('pay', { a: { title: 'P', launcher: 'hidden', app: APP } }, [], 'beta')?.a?.launcher).toBe('hidden')
  })

  it('takes at most two apps a plugin; a bad one does not count', () => {
    const errors: string[] = []
    const decls = checkTemplateDecls(
      'pay',
      {
        broken: { title: 'B', app: { entry: 'x.a2ui' } },
        one: { title: '1', app: APP },
        two: { title: '2', app: APP },
        three: { title: '3', app: APP },
      },
      errors,
      'beta',
    )
    expect(Object.keys(decls ?? {})).toEqual(['one', 'two'])
    expect(errors).toEqual([
      'templates.broken.app.seed: must be a relative folder starting with "./" and without ".."',
      'templates.three: a plugin offers at most 2 apps; this one is left out',
    ])
  })

  it('an app without an entry builds from app.a2ui', () => {
    const errors: string[] = []
    const decls = checkTemplateDecls('pay', { board: { title: 'P', app: { seed: './app' } } }, errors, 'beta')
    expect(errors).toEqual([])
    expect(decls?.board?.app).toEqual({ seed: './app', seedVersion: 1, entry: 'app.a2ui' })
  })

  it('an app id is the plugin name and key in lower case, "_" read as "-"', () => {
    expect(appIdOf('PayPal_Tools', 'month_board')).toBe('paypal-tools-month-board')
  })

  it('two keys of one plugin giving one app id: the second is reported and left out', () => {
    const errors: string[] = []
    const decls = checkTemplateDecls('pay', { a_b: { title: '1', app: APP }, 'a-b': { title: '2', app: APP } }, errors, 'beta')
    expect(Object.keys(decls ?? {})).toEqual(['a_b'])
    expect(errors).toEqual(['templates.a-b.app: its app id "pay-a-b" is also templates.a_b\'s; this one is left out'])
  })

  it('the descriptor check reads the channel it is given', () => {
    const value = { name: 'pay', templates: { board: { title: 'P', app: APP } }, requires: { features: ['apps'] } }
    const beta = checkPluginDescriptor(value, 'beta')
    expect(beta.errors).toEqual([])
    expect(beta.manifest?.templates?.board?.app?.entry).toBe('board.a2ui')
    const stable = checkPluginDescriptor(value, 'stable')
    expect(stable.manifest?.templates).toBeUndefined()
    expect(stable.manifest?.requires).toEqual({ unknown: ['features:apps'] })
    expect(stable.errors).toHaveLength(2)
  })
})

const SVG = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16"><path d="M0 0h16v16z"/></svg>'

function host(files: Record<string, string> = {}) {
  const reports: string[] = []
  let gate: ProviderGateState = { loaded: true, isSetUp: () => true, owner: () => '' }
  const contributions = new ModUiContributionsHost()
  contributions.configure({
    readText: async path => {
      const text = files[path.replace(/\\/g, '/')]
      if (text === undefined) throw new Error('ENOENT')
      return text
    },
    listFiles: async () => [],
    gate: () => gate,
    report: line => reports.push(line),
  })
  return { contributions, reports, setGate: (next: ProviderGateState) => (gate = next) }
}

function appPlugin(name: string, key: string, extra: Partial<ContributingPlugin> = {}): ContributingPlugin {
  return {
    name,
    path: `/plugins/${name}`,
    source: `marketplace:${name}@mkt`,
    installIdentifier: `${name}@mkt`,
    manifest: { name },
    templates: [
      {
        key,
        type: `${name}:${key}`,
        decl: {
          title: 'Payments',
          icon: { kind: 'lucide', name: 'wallet' },
          launcher: 'hidden',
          path: `./templates/${key}`,
          app: { seed: './app', seedVersion: 1, entry: 'app.a2ui' },
        },
        dir: `/plugins/${name}/templates/${key}`,
      },
    ],
    ...extra,
  }
}

describe('the apps the contributions host publishes', () => {
  it('lists each app with its id and icon, and keeps its template hidden', async () => {
    const { contributions } = host()
    await contributions.sync({ enabled: [appPlugin('pay', 'board')] })
    const state = contributions.state()
    expect(state.apps).toEqual([
      { type: 'pay:board', appId: 'pay-board', plugin: 'pay', title: 'Payments', icon: { lucide: 'wallet' } },
    ])
    expect(state.templates.map(template => [template.type, template.launcher])).toEqual([['pay:board', 'hidden']])
  })

  it('carries no apps key when no plugin offers one', async () => {
    const { contributions } = host()
    await contributions.sync({ enabled: [{ ...appPlugin('notes', 'x'), templates: [] }] })
    expect('apps' in contributions.state()).toBe(false)
  })

  it('two apps naming one folder: the first in scan order keeps it, the other is reported once', async () => {
    const { contributions, reports } = host()
    const first = appPlugin('acme', 'pay_x')
    const second = appPlugin('acme-pay', 'x')
    await contributions.sync({ enabled: [first, second] })
    await contributions.sync({ enabled: [first, second] })
    expect(contributions.state().apps?.map(app => app.type)).toEqual(['acme:pay_x'])
    expect(contributions.state().templates.map(template => template.type)).toEqual(['acme:pay_x'])
    expect(reports).toEqual(['acme-pay: app "x" is left out; its id "acme-pay-x" is acme\'s'])
    expect(contributions.templateStatus('acme-pay:x')).toEqual({ state: 'absent', plugin: 'acme-pay' })
    expect(contributions.templateStatus('acme:pay_x').state).toBe('ready')
  })

  it('a waiting plugin earlier in scan order still holds its app id', async () => {
    const { contributions, setGate } = host()
    setGate({ loaded: true, isSetUp: () => false, owner: () => undefined })
    const first = appPlugin('acme', 'pay_x', {
      manifest: { name: 'acme', requires: { providers: ['main'] } },
      providers: [{ key: 'main', id: 'mod.acme.main', manifest: {} as never, modulePath: '/p' }],
    })
    const second = appPlugin('acme-pay', 'x')
    await contributions.sync({ enabled: [first, second] })
    expect('apps' in contributions.state()).toBe(false)
    expect(contributions.templateStatus('acme-pay:x').state).toBe('absent')
    setGate({ loaded: true, isSetUp: () => true, owner: () => 'acme@mkt' })
    contributions.recheckGate()
    expect(contributions.state().apps?.map(app => app.type)).toEqual(['acme:pay_x'])
  })

  it('the icon of a left-out app is not published', async () => {
    const { contributions } = host({ '/plugins/acme-pay/pay.svg': SVG })
    const second = appPlugin('acme-pay', 'x')
    second.templates![0]!.decl.icon = { kind: 'file', src: './pay.svg', mask: false }
    await contributions.sync({ enabled: [appPlugin('acme', 'pay_x'), second] })
    expect(contributions.state().icons).toEqual({})
  })

  it('the page takes a state with or without apps, and refuses apps that are not a list', () => {
    const base = { templates: [], topbar: [], icons: {}, waiting: [] }
    expect(isModContributionsState(base)).toBe(true)
    expect(isModContributionsState({ ...base, apps: [] })).toBe(true)
    expect(isModContributionsState({ ...base, apps: {} })).toBe(false)
  })
})
