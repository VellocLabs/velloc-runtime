/**
 * An app's folder (F-40): where it lives, the seed copy and its upgrades, the
 * session-side opener, and the host's app lookup.
 */
import { afterEach, describe, expect, it } from 'vitest'

import { AppSeedError, SEED_MAX_FILES, seedAppFolder, type AppSeedFs } from '../mods/app/appSeed'
import { openAppFolder } from '../mods/app/appSession'
import { ModUiContributionsHost, type ContributingPlugin } from '../mods/ui/contributionsHost'
import { resetModContributionsState } from '../mods/ui/contributionsState'
import { PluginTemplateUnavailableError, openPluginTemplate } from '../mods/ui/pluginTemplateSession'
import { __resetPluginTypesForTest } from '../prompting/templateRegistry'
import { getNexusAppDir, getNexusWorkspaceDirForType, isPerTypeSharedTemplateType } from '../utils/conversationStoragePaths'

afterEach(() => {
  resetModContributionsState()
  __resetPluginTypesForTest()
})

const enc = new TextEncoder()
const dec = new TextDecoder()

/** A folder tree in memory; `links` maps a folder to the real path it resolves to. */
function memoryFs(initial: Record<string, string>, links: Record<string, string> = {}) {
  const files = new Map(Object.entries(initial).map(([path, text]) => [path, enc.encode(text)]))
  const dirs = new Set<string>()
  const addParents = (path: string) => {
    for (let at = path.lastIndexOf('/'); at > 0; at = path.lastIndexOf('/', at - 1)) dirs.add(path.slice(0, at))
  }
  for (const path of files.keys()) addParents(path)
  const writes: string[] = []
  const entry = (name: string, kind: 'file' | 'dir') => ({
    name,
    isFile: () => kind === 'file',
    isDirectory: () => kind === 'dir',
    isSymbolicLink: () => false,
  })
  const fs: AppSeedFs = {
    readFile: async path => {
      const bytes = files.get(path)
      if (!bytes) throw new Error(`ENOENT ${path}`)
      return dec.decode(bytes)
    },
    readFileBytes: async path => {
      const bytes = files.get(path)
      if (!bytes) throw new Error(`ENOENT ${path}`)
      return bytes
    },
    writeFile: async (path, data) => {
      writes.push(path)
      files.set(path, typeof data === 'string' ? enc.encode(data) : new Uint8Array(data))
      addParents(path)
    },
    mkdir: async path => {
      dirs.add(path)
      addParents(path)
    },
    stat: async path => {
      const bytes = files.get(path)
      if (!bytes) throw new Error(`ENOENT ${path}`)
      return { size: bytes.length, isFile: () => true, isDirectory: () => false } as never
    },
    readdir: async path => {
      const names = new Map<string, 'file' | 'dir'>()
      for (const file of files.keys()) {
        if (!file.startsWith(`${path}/`)) continue
        const rest = file.slice(path.length + 1)
        const slash = rest.indexOf('/')
        names.set(slash < 0 ? rest : rest.slice(0, slash), slash < 0 ? 'file' : 'dir')
      }
      return [...names].map(([name, kind]) => entry(name, kind))
    },
    realpath: async (path, options) => {
      // As on Windows: only the link-resolving form follows a link.
      if (!options?.resolveLinks) return path
      for (const [link, target] of Object.entries(links)) if (path === link || path.startsWith(`${link}/`)) return target + path.slice(link.length)
      return path
    },
  }
  return { fs, files, writes, text: (path: string) => (files.has(path) ? dec.decode(files.get(path)!) : undefined) }
}

const SEED = '/plugins/pay/app'
const APP = '/home/.velloc/shared-workspace/app-pay-board'
const seedFiles = {
  [`${SEED}/AGENTS.md`]: 'You run the payments board.',
  [`${SEED}/dashboard.a2ui`]: 'surface("dashboard")\nroot = Text("v1")\n',
  [`${SEED}/data/derive.js`]: 'return {}',
  [`${SEED}/.git/config`]: 'not copied',
  [`${SEED}/.env`]: 'not copied',
}
const request = (fs: AppSeedFs, seedVersion = 1) => ({ fs, seedDir: SEED, appDir: APP, appId: 'pay-board', plugin: 'pay', seedVersion })

describe('an app\'s folder', () => {
  it('is shared-workspace/app-<appId>; no other type\'s folder can be one', () => {
    expect(getNexusAppDir('/home', 'pay-board')).toBe(APP)
    expect(() => getNexusAppDir('/home', '../x')).toThrow('not an app id')
    expect(isPerTypeSharedTemplateType('app-pay-board')).toBe(false)
    expect(getNexusWorkspaceDirForType('/home', 'app-pay-board')).toBe('/home/.velloc/shared-workspace')
    expect(isPerTypeSharedTemplateType('agent')).toBe(true)
  })
})

describe('the seed copy', () => {
  it('copies the seed on the first open, leaves dot-named files out, and records each file\'s hash', async () => {
    const { fs, text } = memoryFs(seedFiles)
    const result = await seedAppFolder(request(fs))
    expect(result).toEqual({ version: 1, written: ['AGENTS.md', 'dashboard.a2ui', 'data/derive.js'], conflicts: [] })
    expect(text(`${APP}/data/derive.js`)).toBe('return {}')
    expect(text(`${APP}/.env`)).toBeUndefined()
    expect(text(`${APP}/.git/config`)).toBeUndefined()
    const record = JSON.parse(text(`${APP}/.velloc/app.json`)!)
    expect(record).toMatchObject({ appId: 'pay-board', plugin: 'pay', seedVersion: 1 })
    expect(Object.keys(record.files)).toEqual(['AGENTS.md', 'dashboard.a2ui', 'data/derive.js'])
  })

  it('a later open of the same version writes nothing, even over an edited or deleted file', async () => {
    const { fs, files, writes, text } = memoryFs(seedFiles)
    await seedAppFolder(request(fs))
    files.set(`${APP}/dashboard.a2ui`, enc.encode('surface("dashboard")\nroot = Text("mine")\n'))
    files.delete(`${APP}/AGENTS.md`)
    writes.length = 0
    expect(await seedAppFolder(request(fs))).toEqual({ version: 1, written: [], conflicts: [] })
    expect(writes).toEqual([])
    expect(text(`${APP}/AGENTS.md`)).toBeUndefined()
  })

  it('a newer seed replaces what the person did not edit, keeps what they did, and adds what is missing', async () => {
    const { fs, files, text } = memoryFs(seedFiles)
    await seedAppFolder(request(fs))
    files.set(`${APP}/dashboard.a2ui`, enc.encode('surface("dashboard")\nroot = Text("mine")\n'))
    files.delete(`${APP}/data/derive.js`)
    files.set(`${SEED}/AGENTS.md`, enc.encode('You run the payments board, v2.'))
    files.set(`${SEED}/dashboard.a2ui`, enc.encode('surface("dashboard")\nroot = Text("v2")\n'))
    files.set(`${SEED}/data/schema.json`, enc.encode('{}'))
    const result = await seedAppFolder(request(fs, 2))
    expect(result).toEqual({
      version: 2,
      upgradedFrom: 1,
      written: ['AGENTS.md', 'data/derive.js', 'data/schema.json'],
      conflicts: ['dashboard.a2ui'],
    })
    expect(text(`${APP}/AGENTS.md`)).toBe('You run the payments board, v2.')
    expect(text(`${APP}/dashboard.a2ui`)).toContain('mine')
    // The edited file stays a conflict at the next version too.
    files.set(`${SEED}/dashboard.a2ui`, enc.encode('surface("dashboard")\nroot = Text("v3")\n'))
    expect((await seedAppFolder(request(fs, 3))).conflicts).toEqual(['dashboard.a2ui'])
    expect(text(`${APP}/dashboard.a2ui`)).toContain('mine')
  })

  it('a folder that already holds a different file keeps it as a conflict', async () => {
    const { fs, text } = memoryFs({ ...seedFiles, [`${APP}/AGENTS.md`]: 'Written by hand.' })
    expect((await seedAppFolder(request(fs))).conflicts).toEqual(['AGENTS.md'])
    expect(text(`${APP}/AGENTS.md`)).toBe('Written by hand.')
  })

  it('never copies through a folder whose real path is outside the seed', async () => {
    const { fs, text } = memoryFs({ ...seedFiles, [`${SEED}/linked/secret.txt`]: 'outside' }, { [`${SEED}/linked`]: '/home/secrets' })
    expect((await seedAppFolder(request(fs))).written).not.toContain('linked/secret.txt')
    expect(text(`${APP}/linked/secret.txt`)).toBeUndefined()
  })

  it('refuses a folder whose record names another plugin, and writes nothing', async () => {
    const { fs, writes } = memoryFs(seedFiles)
    await seedAppFolder(request(fs))
    writes.length = 0
    await expect(seedAppFolder({ ...request(fs, 2), plugin: 'other' })).rejects.toThrow('belongs to the plugin pay')
    expect(writes).toEqual([])
  })

  it('refuses a seed file that grew past the limit after it was measured', async () => {
    const { fs } = memoryFs(seedFiles)
    const grown: AppSeedFs = { ...fs, readFileBytes: async path => (path.startsWith(SEED) ? new Uint8Array(1024 * 1024 + 1) : fs.readFileBytes(path)) }
    await expect(seedAppFolder(request(grown))).rejects.toThrow('larger than')
  })

  it('refuses a seed with too many files or a file too large', async () => {
    const many: Record<string, string> = {}
    for (let i = 0; i <= SEED_MAX_FILES; i++) many[`${SEED}/f${String(i).padStart(3, '0')}.txt`] = 'x'
    await expect(seedAppFolder(request(memoryFs(many).fs))).rejects.toBeInstanceOf(AppSeedError)
    const big = memoryFs({ [`${SEED}/big.bin`]: 'x'.repeat(1024 * 1024 + 1) })
    await expect(seedAppFolder(request(big.fs))).rejects.toThrow('larger than')
  })

  it('two opens at once seed the folder once', async () => {
    const { fs, writes } = memoryFs(seedFiles)
    const [first, second] = await Promise.all([seedAppFolder(request(fs)), seedAppFolder(request(fs))])
    expect(first.written).toHaveLength(3)
    expect(second.written).toEqual([])
    expect(writes.filter(path => path.endsWith('dashboard.a2ui'))).toHaveLength(1)
  })
})

const APP_DECL = { seed: './app', seedVersion: 1, entry: 'app.a2ui' }
const appTemplate = { appId: 'pay-board', plugin: 'pay', decl: APP_DECL, seedDir: SEED }

describe('an app session\'s opener', () => {
  it('seeds the app\'s folder under the home folder', async () => {
    const { fs, text } = memoryFs(seedFiles)
    const info = await openAppFolder({ fs, homeDir: '/home', app: appTemplate })
    expect(info).toMatchObject({ appId: 'pay-board', plugin: 'pay', folder: APP, seed: { version: 1 } })
    expect(text(`${APP}/AGENTS.md`)).toBe('You run the payments board.')
  })

  it('refuses the session with plugin_app_seed when there is no home or the seed fails', async () => {
    const { fs } = memoryFs(seedFiles)
    await expect(openAppFolder({ fs, homeDir: undefined, app: appTemplate })).rejects.toMatchObject({ code: 'plugin_app_seed' })
    const big = memoryFs({ [`${SEED}/big.bin`]: 'x'.repeat(1024 * 1024 + 1) })
    const refusal = openAppFolder({ fs: big.fs, homeDir: '/home', app: appTemplate })
    await expect(refusal).rejects.toBeInstanceOf(PluginTemplateUnavailableError)
    await expect(refusal).rejects.toMatchObject({ code: 'plugin_app_seed' })
  })
})

const TEMPLATE_MD = '---\ntype: TYPE\ntools: [read]\n---\n\n## prompt\n!agent_intro\n'

function host(files: Record<string, string>) {
  const contributions = new ModUiContributionsHost()
  contributions.configure({
    readText: async path => {
      const text = files[path.replace(/\\/g, '/')]
      if (text === undefined) throw new Error('ENOENT')
      return text
    },
    listFiles: async () => [],
    gate: () => ({ loaded: true, isSetUp: () => true, owner: () => '' }),
    report: () => undefined,
  })
  return contributions
}

function appPlugin(name: string, key: string): ContributingPlugin {
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
        decl: { title: 'Payments', launcher: 'hidden', path: `./templates/${key}`, app: APP_DECL },
        dir: `/plugins/${name}/templates/${key}`,
      },
    ],
  }
}

describe('the host\'s app lookup', () => {
  it('a session of an app type learns its app; the seed folder is inside the plugin', async () => {
    const contributions = host({ '/plugins/pay/templates/board/template.md': TEMPLATE_MD.replace('TYPE', 'pay:board') })
    await contributions.sync({ enabled: [appPlugin('pay', 'board')] })
    expect(contributions.appOf('pay:board')).toEqual({ appId: 'pay-board', plugin: 'pay', decl: APP_DECL, seedDir: '/plugins/pay/app' })
    expect(contributions.appOf('pay:other')).toBeUndefined()
    const opened = await openPluginTemplate('pay:board', contributions)
    expect(opened.app?.appId).toBe('pay-board')
  })

  it('an app left out for its id opens nowhere', async () => {
    const contributions = host({})
    await contributions.sync({ enabled: [appPlugin('acme', 'pay_x'), appPlugin('acme-pay', 'x')] })
    expect(contributions.templateStatus('acme-pay:x')).toEqual({ state: 'absent', plugin: 'acme-pay' })
    expect(contributions.appOf('acme-pay:x')).toBeUndefined()
    await expect(openPluginTemplate('acme-pay:x', contributions)).rejects.toMatchObject({ code: 'plugin_template_absent' })
  })
})
