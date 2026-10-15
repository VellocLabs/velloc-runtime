/**
 * What a module's last load produced, kept so an unchanged module is not
 * read, compiled or scanned again (`mods/modBuildStore.ts`) — F-25, "What a load keeps".
 */

import { afterEach, describe, expect, it } from 'vitest'
import { fileModBuildStore, forgetModBuilds, MOD_BUILD_STAMP, type ModBuild } from '../mods/modBuildStore'
import { RUNTIME_DIR_NAME } from '../branding/runtimeDir'
import { pluginsHandlers } from '../browser/bridge/adapter/pluginsBridgeAdapter'
import { makeMemFs } from './_helpers/memFs'
import { ModRuntime, type ModModuleRef, type ModWorkerHandle } from '../mods/ModRuntime'
import { installModWorkerHost } from '../mods/ModWorkerHost'
import type { ModUses } from '../mods/modScan'
import { ProviderModRuntime } from '../mods/provider/ProviderModRuntime'
import type { RuntimeFs } from '../utils/fs/runtimeFs'

const open: MessagePort[] = []
const disposers: Array<() => void> = []
afterEach(() => {
  for (const dispose of disposers.splice(0)) dispose()
  for (const port of open.splice(0)) port.close()
})
let uniq = 0

/** Files by path with a size and an mtime; `touch` moves a file's mtime;
 *  every stat is counted. */
function memoryFs(initial: Record<string, string> = {}) {
  const files = new Map<string, { text: string; mtimeMs: number }>()
  let clock = 1_000
  for (const [path, text] of Object.entries(initial)) files.set(path, { text, mtimeMs: clock })
  const counts = { stat: 0 }
  const fs = {
    readFile: async (p: string) => {
      const file = files.get(p)
      if (!file) throw Object.assign(new Error(`ENOENT: ${p}`), { code: 'ENOENT' })
      return file.text
    },
    writeFile: async (p: string, text: string) => {
      files.set(p, { text, mtimeMs: ++clock })
    },
    readdir: async (dir: string) =>
      [...new Set([...files.keys()].filter(p => p.startsWith(`${dir}/`)).map(p => p.slice(dir.length + 1).split('/')[0]!))].map(
        name => ({ name, isFile: () => files.has(`${dir}/${name}`), isDirectory: () => !files.has(`${dir}/${name}`), isSymbolicLink: () => false }),
      ),
    unlink: async (p: string) => {
      if (!files.delete(p)) throw Object.assign(new Error(`ENOENT: ${p}`), { code: 'ENOENT' })
    },
    stat: async (p: string) => {
      counts.stat += 1
      const file = files.get(p)
      if (!file) throw Object.assign(new Error(`ENOENT: ${p}`), { code: 'ENOENT' })
      return { size: new TextEncoder().encode(file.text).length, mtimeMs: file.mtimeMs }
    },
  } as unknown as RuntimeFs
  return {
    fs,
    files,
    counts,
    touch: (p: string) => (files.get(p)!.mtimeMs = ++clock),
    edit: (p: string, text: string) => files.set(p, { text, mtimeMs: ++clock }),
  }
}

const ENTRY = '/plugins/acme/hooks/register.ts'
const LIB = '/plugins/acme/hooks/lib.ts'
const USES: ModUses = { events: ['prompt.submit'], calls: ['ui.log'] }
const BUILD: ModBuild = { source: 'compiled', entrySource: 'entry', compiled: true, files: [ENTRY, LIB], uses: USES }

function storeOver(world: ReturnType<typeof memoryFs>) {
  return fileModBuildStore(world.fs, '/home/u/.velloc/mods', { ensureDir: async () => {} })
}

describe('fileModBuildStore', () => {
  const local: ModModuleRef = { plugin: 'acme', path: ENTRY, version: '1.0.0', provenance: 'acme@inline' }

  it('a folder plugin: used while every file it read keeps its size and mtime', async () => {
    const world = memoryFs({ [ENTRY]: 'entry', [LIB]: 'lib' })
    const store = storeOver(world)
    await store.remember(local, BUILD)
    expect(await store.lookup(local)).toEqual(BUILD)
    world.touch(LIB)
    expect(await store.lookup(local), 'an imported file was saved again').toBeNull()
  })

  it('a folder plugin: a changed size, a gone file, another path or another stamp is a miss', async () => {
    const world = memoryFs({ [ENTRY]: 'entry', [LIB]: 'lib' })
    const store = storeOver(world)
    await store.remember(local, BUILD)
    const saved = world.files.get(LIB)!
    world.files.set(LIB, { text: 'lib, longer', mtimeMs: saved.mtimeMs })
    expect(await store.lookup(local), 'same mtime, other size').toBeNull()
    world.files.set(LIB, saved)
    expect(await store.lookup(local)).not.toBeNull()
    world.files.delete(LIB)
    expect(await store.lookup(local)).toBeNull()
    world.files.set(LIB, saved)

    const [recordPath, record] = [...world.files].find(([path]) => path.includes('/.builds/'))!
    const parsed = JSON.parse(record.text)
    world.files.set(recordPath, { ...record, text: JSON.stringify({ ...parsed, stamp: `${MOD_BUILD_STAMP}-old` }) })
    expect(await store.lookup(local), 'an engine whose compiler changed').toBeNull()
    world.files.set(recordPath, { ...record, text: '{ broken' })
    expect(await store.lookup(local)).toBeNull()
  })

  it('an installed plugin: same version, no file looked at; another version checks the files', async () => {
    const installed: ModModuleRef = { plugin: 'acme', path: ENTRY, version: '1.0.0', provenance: 'acme@market' }
    const world = memoryFs({ [ENTRY]: 'entry', [LIB]: 'lib' })
    const store = storeOver(world)
    await store.remember(installed, BUILD)
    world.touch(LIB)
    world.counts.stat = 0
    expect(await store.lookup(installed)).toEqual(BUILD)
    expect(world.counts.stat).toBe(0)
    expect(await store.lookup({ ...installed, version: '1.0.1' }), 'a new version, and a file changed').toBeNull()
    expect(await store.lookup({ ...installed, provenance: 'acme@inline' }), 'a folder plugin is checked by its files').toBeNull()
  })

  it('one record per module, replaced: the store does not grow with each change', async () => {
    const world = memoryFs({ [ENTRY]: 'entry', [LIB]: 'lib' })
    const store = storeOver(world)
    for (let i = 0; i < 5; i++) {
      world.edit(LIB, `lib ${i}`)
      await store.remember(local, { ...BUILD, source: `compiled ${i}` })
    }
    const records = [...world.files.keys()].filter(path => path.includes('/.builds/'))
    expect(records).toHaveLength(1)
    expect((await store.lookup(local))!.source).toBe('compiled 4')
  })

  it('a file that cannot be stat\'ed keeps nothing', async () => {
    const world = memoryFs({ [ENTRY]: 'entry' })
    const store = storeOver(world)
    await store.remember(local, BUILD)
    expect([...world.files.keys()].some(path => path.includes('/.builds/'))).toBe(false)
  })
})

const MODULE = `
  export function register(on) {
    on('prompt.submit', async ($, e, next) => { await $.ui.log('ran'); return next(e) })
  }
`

function openWorker(): Promise<ModWorkerHandle> {
  const channel = new MessageChannel()
  open.push(channel.port1, channel.port2)
  installModWorkerHost(channel.port2)
  let settle!: (closed: { reason: 'closed' | 'crashed' }) => void
  const closed = new Promise<{ reason: 'closed' | 'crashed' }>(resolve => {
    settle = resolve
  })
  return Promise.resolve({ port: channel.port1, closed, close: () => settle({ reason: 'closed' }) })
}

describe('a session runtime over the store', () => {
  function session(world: ReturnType<typeof memoryFs>, calls: string[]) {
    const reports: string[] = []
    const text = `${MODULE}\n// load ${++uniq}`
    const runtime = new ModRuntime({
      modules: [{ plugin: 'acme', path: ENTRY, provenance: 'acme@inline' }],
      readModule: async path => (calls.push(`read ${path}`), String(await world.fs.readFile(path, { encoding: 'utf-8' }))),
      compile: async () => (calls.push('compile'), { source: text, files: [ENTRY, LIB], uses: { events: ['prompt.submit'], calls: ['ui.log'] } }),
      scan: async () => (calls.push('scan'), { events: [], calls: [] }),
      builds: storeOver(world),
      openWorker,
      session: { id: () => 's', cwd: () => '/work' },
      report: line => reports.push(line),
    })
    disposers.push(() => runtime.dispose())
    return { runtime, reports }
  }

  it('the second session of an unchanged module reads, compiles and scans nothing, and the module runs', async () => {
    const world = memoryFs({ [ENTRY]: 'entry text', [LIB]: 'lib text' })
    const first: string[] = []
    const one = session(world, first)
    await one.runtime.ready
    expect(first).toEqual([`read ${ENTRY}`, 'compile'])
    await new Promise(resolve => setTimeout(resolve, 0)) // the record is written after the load

    const second: string[] = []
    const two = session(world, second)
    await two.runtime.ready
    expect(second).toEqual([])
    await two.runtime.promptSubmit('go')
    expect(two.reports).toContain('acme: ran')

    world.touch(LIB)
    const third: string[] = []
    const three = session(world, third)
    await three.runtime.ready
    expect(third, 'an imported file changed: built again').toEqual([`read ${ENTRY}`, 'compile'])
  })
})

describe('a provider runtime over the store', () => {
  const PROVIDER_ENTRY = '/plugins/acme/providers/acme.ts'
  function provider(world: ReturnType<typeof memoryFs>, calls: string[], uses: ModUses) {
    const text = `export function register(on) { on('provider.verify', () => ({ ok: true })) }\n// load ${++uniq}`
    const runtime = new ProviderModRuntime({
      readModule: async path => (calls.push('read'), String(await world.fs.readFile(path, { encoding: 'utf-8' }))),
      compile: async () => (calls.push('compile'), { source: text, files: [PROVIDER_ENTRY], uses }),
      builds: storeOver(world),
      openWorker: () => openWorker(),
      window: { available: () => true, attached: async () => {} },
      report: () => {},
    })
    disposers.push(() => runtime.dispose())
    runtime.register('acme', [{ plugin: 'acme', path: PROVIDER_ENTRY, providers: ['mod.acme.main'] }])
    return runtime
  }

  it('an unchanged module is not read or compiled again; a refusal stands from the kept scan', async () => {
    const world = memoryFs({ [PROVIDER_ENTRY]: 'entry' })
    const first: string[] = []
    expect(await provider(world, first, { events: ['provider.verify'], calls: [] }).call('mod.acme.main', 'provider.verify', {}))
      .toMatchObject({ value: { ok: true } })
    expect(first).toEqual(['read', 'compile'])
    await new Promise(resolve => setTimeout(resolve, 0))
    const second: string[] = []
    expect(await provider(world, second, { events: ['provider.verify'], calls: [] }).call('mod.acme.main', 'provider.verify', {}))
      .toMatchObject({ value: { ok: true } })
    expect(second).toEqual([])

    // A build that calls a session noun is kept, and refused again from the record.
    world.touch(PROVIDER_ENTRY)
    await expect(provider(world, [], { events: ['provider.verify'], calls: ['session.id'] }).call('mod.acme.main', 'provider.verify', {}))
      .rejects.toThrow()
    await new Promise(resolve => setTimeout(resolve, 0))
    const fourth: string[] = []
    await expect(provider(world, fourth, { events: ['provider.verify'], calls: [] }).call('mod.acme.main', 'provider.verify', {}))
      .rejects.toThrow()
    expect(fourth).toEqual([])
  })
})

describe('switching a plugin on or off drops its builds, and nothing else', () => {
  const MODS = '/home/u/.velloc/mods'
  const records = (world: ReturnType<typeof memoryFs>) =>
    [...world.files.keys()].filter(path => path.startsWith(`${MODS}/.builds/`)).sort()

  async function seeded() {
    const world = memoryFs({
      [ENTRY]: 'entry',
      [LIB]: 'lib',
      '/plugins/acme-x/hooks/register.js': 'x',
      // The plugin's own data: never a build.
      [`${MODS}/acme/store.json`]: '{"n":1}',
    })
    const store = storeOver(world)
    await store.remember({ plugin: 'acme', path: ENTRY }, BUILD)
    await store.remember({ plugin: 'acme-x', path: '/plugins/acme-x/hooks/register.js' }, {
      ...BUILD, files: ['/plugins/acme-x/hooks/register.js'],
    })
    expect(records(world)).toHaveLength(2)
    return { world, store }
  }

  it('forget drops the module\'s record', async () => {
    const { world, store } = await seeded()
    await store.forget({ plugin: 'acme', path: ENTRY })
    expect(records(world)).toEqual([expect.stringContaining('/.builds/acme-x@')])
  })

  it('by name: that plugin\'s records alone (not a plugin whose name starts the same), and no data', async () => {
    const { world } = await seeded()
    await forgetModBuilds(world.fs, MODS, { plugin: 'acme' })
    expect(records(world)).toEqual([expect.stringContaining('/.builds/acme-x@')])
    expect(world.files.has(`${MODS}/acme/store.json`)).toBe(true)
  })

  it('by folder: every module under it, nothing outside', async () => {
    const { world } = await seeded()
    await forgetModBuilds(world.fs, MODS, { root: '/plugins/acme' })
    expect(records(world)).toEqual([expect.stringContaining('/.builds/acme-x@')])
    await forgetModBuilds(world.fs, MODS, { root: '/plugins/acme-x' })
    expect(records(world)).toEqual([])
    expect(world.files.has(`${MODS}/acme/store.json`)).toBe(true)
  })

  it('a session that sees the plugin switched off, then on, builds it afresh', async () => {
    const world = memoryFs({ [ENTRY]: 'entry text', [LIB]: 'lib text' })
    const calls: string[] = []
    const text = `${MODULE}\n// load ${++uniq}`
    const ref: ModModuleRef = { plugin: 'acme', path: ENTRY, provenance: 'acme@inline' }
    const runtime = new ModRuntime({
      modules: [ref],
      readModule: async path => (calls.push('read'), String(await world.fs.readFile(path, { encoding: 'utf-8' }))),
      compile: async () => (calls.push('compile'), { source: text, files: [ENTRY, LIB], uses: { events: ['prompt.submit'], calls: ['ui.log'] } }),
      builds: storeOver(world),
      openWorker,
      session: { id: () => 's', cwd: () => '/work' },
      report: () => {},
    })
    disposers.push(() => runtime.dispose())
    await runtime.ready
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(records(world)).toHaveLength(1)
    await runtime.reconcile([])
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(records(world), 'switched off: its build is gone').toEqual([])
    // A record that reappeared meanwhile (another session) is not used either.
    await storeOver(world).remember(ref, { ...BUILD, source: 'stale' })
    calls.length = 0
    await runtime.reconcile([ref])
    expect(calls, 'switched on: built afresh').toEqual(['read', 'compile'])
  })

  it('a provider plugin unregistered drops its builds', async () => {
    const world = memoryFs({ '/plugins/acme/providers/acme.ts': 'entry' })
    const text = `export function register(on) { on('provider.verify', () => ({ ok: true })) }\n// load ${++uniq}`
    const runtime = new ProviderModRuntime({
      readModule: async path => String(await world.fs.readFile(path, { encoding: 'utf-8' })),
      compile: async () => ({ source: text, files: ['/plugins/acme/providers/acme.ts'], uses: { events: ['provider.verify'], calls: [] } }),
      builds: storeOver(world),
      openWorker: () => openWorker(),
      window: { available: () => true, attached: async () => {} },
      report: () => {},
    })
    disposers.push(() => runtime.dispose())
    runtime.register('acme', [{ plugin: 'acme', path: '/plugins/acme/providers/acme.ts', providers: ['mod.acme.main'] }])
    await runtime.call('mod.acme.main', 'provider.verify', {})
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(records(world)).toHaveLength(1)
    runtime.unregister('acme')
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(records(world)).toEqual([])
  })

  it('Settings: switching a folder plugin or an installed plugin drops its builds with no session running', async () => {
    const HOME = '/home/u'
    const ROOT = `${HOME}/${RUNTIME_DIR_NAME}/plugins`
    const BUILDS = `${HOME}/${RUNTIME_DIR_NAME}/mods/.builds`
    const fs = makeMemFs()
    fs.unlink = (path: string) => fs.rm(path)
    await fs.writeFile(`${ROOT}/my-mod/.claude-plugin/plugin.json`, '{"name":"my-mod"}')
    await fs.writeFile(`${HOME}/${RUNTIME_DIR_NAME}/enabled-plugins.json`, JSON.stringify({ enabledPlugins: ['my-mod'] }))
    await fs.writeFile(`${BUILDS}/my-mod@00000001.json`, JSON.stringify({ path: `${ROOT}/my-mod/hooks/register.js` }))
    await fs.writeFile(`${BUILDS}/tagger@00000002.json`, JSON.stringify({ path: '/elsewhere/tagger/hooks/register.js' }))
    await fs.writeFile(`${BUILDS}/other@00000003.json`, JSON.stringify({ path: '/elsewhere/other/hooks/register.js' }))
    // Not named as a record: never deleted, whatever it holds.
    await fs.writeFile(`${BUILDS}/notes.json`, JSON.stringify({ path: `${ROOT}/my-mod/x.js` }))
    await fs.writeFile(`${HOME}/${RUNTIME_DIR_NAME}/mods/my-mod/store.json`, '{}')
    const ctx = { homeDir: HOME, fs, reloadPluginsOnAllSessions: () => {} }

    await pluginsHandlers.setLocalEnabled({ path: `${ROOT}/my-mod`, enabled: false }, ctx)
    await pluginsHandlers.setEnabled({ identifier: 'tagger@market', enabled: false }, ctx)
    expect(fs.dump().filter(path => path.startsWith(BUILDS))).toEqual([`${BUILDS}/notes.json`, `${BUILDS}/other@00000003.json`])
    expect(fs.dump()).toContain(`${HOME}/${RUNTIME_DIR_NAME}/mods/my-mod/store.json`)
  })
})
