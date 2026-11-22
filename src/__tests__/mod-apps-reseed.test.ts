/**
 * `$.app.reseed()` (F-40): the seed copied
 * again over edited files with the person's config and data kept, the page
 * rebuilt or the build error named, the registry by app id, and the runtime's
 * `reseed` call.
 */
import { describe, expect, it } from 'vitest'

import { isModsAppRefreshPayload, type AppSurfaceState, type ModsBuildAppResult } from '../browser/runtimeProtocol/modApps'
import { MODS_ACTION_SCOPES } from '../browser/runtimeProtocol/mods'
import { keptBySeed, seedAppFolder, type AppSeedFs } from '../mods/app/appSeed'
import { appReseedKeep } from '../mods/app/appReseed'
import { createAppSurfaceHost } from '../mods/app/appSurfaceHost'
import { reseedRegisteredApp, setAppReseeder } from '../mods/app/appSurfaceRegistry'
import type { AppSessionInfo } from '../mods/app/appSession'
import { refuseAppBackgroundCall } from '../mods/app/appBackgroundEvents'
import { makeWorkerAppState } from '../mods/app/workerAppNoun'

const enc = new TextEncoder()
const dec = new TextDecoder()

function memoryFs(initial: Record<string, string>) {
  const files = new Map(Object.entries(initial).map(([path, text]) => [path, enc.encode(text)]))
  const entry = (name: string, kind: 'file' | 'dir') => ({ name, isFile: () => kind === 'file', isDirectory: () => kind === 'dir', isSymbolicLink: () => false })
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
      files.set(path, typeof data === 'string' ? enc.encode(data) : new Uint8Array(data))
    },
    mkdir: async () => undefined,
    stat: async path => {
      const bytes = files.get(path)
      if (!bytes) throw new Error(`ENOENT ${path}`)
      return { size: bytes.length, mtimeMs: 1, isFile: () => true, isDirectory: () => false } as never
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
  }
  return { fs, files, text: (path: string) => (files.has(path) ? dec.decode(files.get(path)!) : undefined), write: (path: string, text: string) => files.set(path, enc.encode(text)) }
}

const SEED = '/plugins/router/app'
const APP = '/home/.velloc/shared-workspace/app-router'
const seed = {
  [`${SEED}/AGENTS.md`]: 'v1 agents',
  [`${SEED}/app.a2ui`]: 'surface("main")\nroot = Text("v1")\n',
  [`${SEED}/config.json`]: '{"seeded":true}',
  [`${SEED}/data/state.json`]: '{"seeded":true}',
  [`${SEED}/latest.json`]: '{"seeded":true}',
}
const base = (fs: AppSeedFs) => ({ fs, seedDir: SEED, appDir: APP, appId: 'router', plugin: 'router', seedVersion: 1 })

describe('a reseed of the app folder', () => {
  it('writes every seed file again, edited or not, and never the config, data folder or data file', async () => {
    const disk = memoryFs(seed)
    await seedAppFolder(base(disk.fs))
    disk.write(`${APP}/AGENTS.md`, 'edited by hand')
    disk.write(`${APP}/config.json`, '{"mine":1}')
    disk.write(`${APP}/data/state.json`, '{"mine":2}')
    disk.write(`${APP}/latest.json`, '{"mine":3}')
    disk.write(`${APP}/notes.md`, 'not in the seed')
    disk.write(`${SEED}/app.a2ui`, 'surface("main")\nroot = Text("v2")\n')
    disk.write(`${SEED}/AGENTS.md`, 'v2 agents')

    // A plain open at the same version writes nothing.
    expect((await seedAppFolder(base(disk.fs))).written).toEqual([])

    const result = await seedAppFolder({ ...base(disk.fs), reseed: { keep: appReseedKeep({ data: './latest.json' }) } })
    expect(result.written.sort()).toEqual(['AGENTS.md', 'app.a2ui'])
    expect(result.conflicts).toEqual([])
    expect(disk.text(`${APP}/app.a2ui`)).toContain('v2')
    expect(disk.text(`${APP}/AGENTS.md`)).toBe('v2 agents')
    expect(disk.text(`${APP}/config.json`)).toBe('{"mine":1}')
    expect(disk.text(`${APP}/data/state.json`)).toBe('{"mine":2}')
    expect(disk.text(`${APP}/latest.json`)).toBe('{"mine":3}')
    expect(disk.text(`${APP}/notes.md`)).toBe('not in the seed')
  })

  it('keeps by exact file or by folder prefix, without case', () => {
    const keep = appReseedKeep({ data: 'board/latest.json' })
    expect(keep).toEqual(['config.json', 'data/', 'board/latest.json'])
    expect(keptBySeed('Config.json', keep)).toBe(true)
    expect(keptBySeed('data/a/b.json', keep)).toBe(true)
    expect(keptBySeed('board/latest.json', keep)).toBe(true)
    expect(keptBySeed('board/other.json', keep)).toBe(false)
    expect(keptBySeed('database.json', keep)).toBe(false)
    expect(keptBySeed('sub/config.json', keep)).toBe(false)
  })
})

const compile = async (body: string) =>
  body.includes('BROKEN')
    ? { ok: false as const, message: 'line 2: unknown component BROKEN' }
    : { ok: true as const, surfaceIds: [...body.matchAll(/surface\("([^"]+)"\)/g)].map(m => m[1]!) }

function hostRig() {
  const disk = memoryFs(seed)
  const published: Array<AppSurfaceState | null> = []
  let reseed: (() => Promise<void>) | undefined
  let registeredFor: string | undefined
  let refresh: ((reinstall: boolean) => Promise<ModsBuildAppResult>) | undefined
  const shownAgain: string[] = []
  const info: AppSessionInfo = {
    appId: 'router',
    plugin: 'router',
    folder: APP,
    decl: { seed: './app', seedVersion: 1, entry: 'app.a2ui' },
    seed: { version: 1, written: [], conflicts: [] },
    seedDir: SEED,
  }
  const host = createAppSurfaceHost({
    fs: disk.fs,
    seedFs: disk.fs,
    app: info,
    sessionId: 's1',
    compile,
    publish: (_id, state) => published.push(state),
    registerBuild: () => () => true,
    registerActor: () => () => true,
    registerReseeder: (_id, appId, fn) => {
      registeredFor = appId
      reseed = fn
      return () => true
    },
    registerRefresher: (_id, fn) => {
      refresh = fn
      return () => true
    },
    showAgain: async appId => void shownAgain.push(appId),
    liveData: { snapshot: () => undefined, subscribe: () => () => undefined } as never,
  })
  return { disk, host, published, shownAgain, refresh: (reinstall: boolean) => refresh!(reinstall), reseed: () => reseed!(), registeredFor: () => registeredFor }
}

describe('the surface host reseed', () => {
  it('copies the seed and redraws the page from the new entry', async () => {
    const rig = hostRig()
    await seedAppFolder(base(rig.disk.fs))
    await rig.host.start()
    expect(rig.registeredFor()).toBe('router')
    rig.disk.write(`${APP}/app.a2ui`, 'surface("old")\nroot = Text("edited")\n')
    rig.disk.write(`${SEED}/app.a2ui`, 'surface("fresh")\nroot = Text("v2")\n')
    await rig.reseed()
    expect(rig.disk.text(`${APP}/app.a2ui`)).toContain('fresh')
    expect(rig.published.at(-1)?.surface?.surfaceIds).toEqual(['fresh'])
  })

  it('rejects with AppBuildError when the new entry does not build, and keeps the previous page', async () => {
    const rig = hostRig()
    await seedAppFolder(base(rig.disk.fs))
    await rig.host.start()
    rig.disk.write(`${SEED}/app.a2ui`, 'surface("x")\nBROKEN\n')
    await expect(rig.reseed()).rejects.toMatchObject({ name: 'AppBuildError', message: expect.stringContaining('BROKEN') })
    expect(rig.published.at(-1)?.surface?.surfaceIds).toEqual(['main'])
  })
})

describe('the reseed registry', () => {
  it('runs every open session of the app and is undefined for none', async () => {
    const ran: string[] = []
    const a = setAppReseeder('s-a', 'router', async () => void ran.push('a'))
    const b = setAppReseeder('s-b', 'router', async () => void ran.push('b'))
    const c = setAppReseeder('s-c', 'other', async () => void ran.push('c'))
    await reseedRegisteredApp('router')
    expect(ran.sort()).toEqual(['a', 'b'])
    expect(reseedRegisteredApp('nobody')).toBeUndefined()
    a()
    b()
    c()
    expect(reseedRegisteredApp('router')).toBeUndefined()
  })
})

describe('$.app.reseed in the script', () => {
  it('is an allowed app method and calls the runtime', async () => {
    expect(refuseAppBackgroundCall('app', 'reseed', undefined, false)).toBeNull()
    expect(refuseAppBackgroundCall('app', 'reseed')).toBeNull()
    const calls: string[] = []
    const noun = makeWorkerAppState().noun(async method => void calls.push(method)) as { reseed(): Promise<unknown> }
    await noun.reseed()
    expect(calls).toEqual(['reseed'])
  })
})

describe('Refresh and Reinstall in the pane header', () => {
  it('Refresh builds the entry from the folder and raises app.show again', async () => {
    const rig = hostRig()
    await seedAppFolder(base(rig.disk.fs))
    await rig.host.start()
    rig.disk.write(`${APP}/app.a2ui`, 'surface("edited")\n')
    expect(await rig.refresh(false)).toEqual({ ok: true, surfaceIds: ['edited'] })
    expect(rig.shownAgain).toEqual(['router'])
  })

  it('Reinstall copies the seed, keeps config and data, redraws, then raises app.show', async () => {
    const rig = hostRig()
    await seedAppFolder(base(rig.disk.fs))
    await rig.host.start()
    rig.disk.write(`${APP}/config.json`, '{"mine":1}')
    rig.disk.write(`${APP}/data/state.json`, '{"mine":2}')
    rig.disk.write(`${SEED}/app.a2ui`, 'surface("fresh")\n')
    expect(await rig.refresh(true)).toEqual({ ok: true, surfaceIds: ['fresh'] })
    expect(rig.disk.text(`${APP}/config.json`)).toBe('{"mine":1}')
    expect(rig.disk.text(`${APP}/data/state.json`)).toBe('{"mine":2}')
    expect(rig.shownAgain).toEqual(['router'])
  })

  it('a Reinstall that does not build keeps the page, gives the error, and raises nothing', async () => {
    const rig = hostRig()
    await seedAppFolder(base(rig.disk.fs))
    await rig.host.start()
    rig.disk.write(`${SEED}/app.a2ui`, 'surface("x")\nBROKEN\n')
    const result = await rig.refresh(true)
    expect(result.ok).toBe(false)
    expect(!result.ok && result.message).toContain('BROKEN')
    expect(rig.published.at(-1)?.surface?.surfaceIds).toEqual(['main'])
    expect(rig.published.at(-1)?.errors?.[0]?.kind).toBe('build')
    expect(rig.shownAgain).toEqual([])
  })

  it('mods.appRefresh is a control action with an optional boolean reinstall', () => {
    expect(MODS_ACTION_SCOPES.appRefresh).toBe('control')
    expect(isModsAppRefreshPayload({ sessionId: 's' })).toBe(true)
    expect(isModsAppRefreshPayload({ sessionId: 's', reinstall: true })).toBe(true)
    expect(isModsAppRefreshPayload({ sessionId: 's', reinstall: 'yes' })).toBe(false)
    expect(isModsAppRefreshPayload({ sessionId: '' })).toBe(false)
  })
})
