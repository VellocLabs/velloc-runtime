/**
 * An app session's surfaces (F-40), runtime half: the build of the app's
 * entry file, the BuildApp tool, the silent turn-end build, the data re-read
 * on a plugin's write, the prompt block, the `mods/app/<sessionId>` topic,
 * `mods.buildApp` and the protocol helpers.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { Message } from '../runtime/RuntimeTypes'
import {
  MODS_APP_STATE_EVENT,
  isAppSurfaceState,
  isModsBuildAppPayload,
  modsAppTopic,
  modsAppTopicSession,
  type AppSurfaceState,
} from '../browser/runtimeProtocol/modApps'
import { MODS_ACTION_SCOPES } from '../browser/runtimeProtocol/mods'
import { appPromptBlock, BUILD_APP_TOOL_NAME, createAppSurfaceHost, replyDrawsAppSurface } from '../mods/app/appSurfaceHost'
import {
  appSurfaceState,
  buildRegisteredApp,
  onAppSurfaceChanged,
  setAppBuilder,
  setAppSurfaceState,
} from '../mods/app/appSurfaceRegistry'
import type { AppSessionInfo } from '../mods/app/appSession'
import { modsAppTopicProvider, registerModsAppTopic } from '../browser/runtimeHub/modsAppTopic'
import type { ConnectionInfo } from '../browser/runtimeHub/types'

const FOLDER = 'C:/home/.velloc/shared-workspace/app-pay-board'
const BOARD = ['surface("overview")', 'root = Card(col)', 'col = Column([title])', 'title = Text("Payments")'].join('\n')
const TWO = `${BOARD}\nsurface("refunds")\nroot = Text("Refunds")`

const slash = (path: string) => path.split('\\').join('/')

function memoryFs(files: Record<string, string>) {
  const store = new Map(Object.entries(files).map(([path, text]) => [`${FOLDER}/${path}`, { text, mtimeMs: 1000 }]))
  let clock = 1000
  return {
    write(path: string, text: string) {
      store.set(`${FOLDER}/${path}`, { text, mtimeMs: ++clock })
    },
    fs: {
      stat: async (path: string) => {
        const file = store.get(slash(path))
        if (!file) throw Object.assign(new Error(`ENOENT ${path}`), { code: 'ENOENT' })
        return { isFile: () => true, isDirectory: () => false, size: file.text.length, mtimeMs: file.mtimeMs } as never
      },
      readFileBytes: async (path: string) => new TextEncoder().encode(store.get(slash(path))!.text),
    },
  }
}

const app = (extra: Partial<AppSessionInfo['decl']> = {}, conflicts: string[] = []): AppSessionInfo => ({
  appId: 'pay-board',
  plugin: 'pay',
  folder: FOLDER,
  decl: { seed: './app', seedVersion: 1, entry: 'app.a2ui', data: 'data/latest.json', ...extra },
  seed: { version: 1, written: [], conflicts },
})

/** Every body compiled, so a test can tell a build from a skipped one. */
const compiled: string[] = []
/** A compile that refuses any body holding BROKEN and reads surface ids by pattern. */
const compile = async (body: string) => {
  compiled.push(body)
  if (body.includes('BROKEN')) return { ok: false as const, message: 'line 2: unknown component BROKEN' }
  return { ok: true as const, surfaceIds: [...body.matchAll(/surface\("([^"]+)"\)/g)].map(m => m[1]!) }
}

function rig(files: Record<string, string>, decl?: Partial<AppSessionInfo['decl']>, conflicts?: string[]) {
  const disk = memoryFs(files)
  const published: Array<AppSurfaceState | null> = []
  const builds = new Map<string, unknown>()
  const host = createAppSurfaceHost({
    fs: disk.fs,
    app: app(decl, conflicts),
    sessionId: 's1',
    compile,
    publish: (_id, state) => published.push(state),
    registerBuild: (id, build) => {
      builds.set(id, build)
      return () => builds.delete(id)
    },
  })
  return { disk, host, published, builds }
}

const note = (text: string): Message => ({ type: 'user', uuid: `n-${text.length}`, message: { role: 'user', content: text } }) as never
const reply = (text: string): Message => ({ type: 'assistant', uuid: 'r1', message: { role: 'assistant', content: [{ type: 'text', text }] } }) as never
const noInner = async () => [] as Message[]
const callTool = (host: ReturnType<typeof rig>['host']) =>
  host.tool.call({} as never, {} as never, (async () => ({})) as never, {} as never)

afterEach(() => {
  setAppSurfaceState('s1', null)
  setAppBuilder('s1', async () => ({ ok: false, message: 'reset' }))()
  compiled.length = 0
})

describe('the app built from its entry file', () => {
  it('the build and its data, published once while nothing changes; seed conflicts ride along', async () => {
    const { host, published } = rig({ 'app.a2ui': BOARD, 'data/latest.json': '{"count":3}' }, undefined, ['app.a2ui'])
    const state = await host.start()
    expect(state.surface).toMatchObject({ body: BOARD, surfaceIds: ['overview'] })
    expect(state.surface?.hash).toMatch(/^[0-9a-f]{64}$/)
    expect(state).toMatchObject({ appId: 'pay-board', data: { count: 3 }, dataAt: 1000, refreshing: false, seedConflicts: ['app.a2ui'] })
    expect(state.errors).toBeUndefined()
    expect(await host.build()).toEqual({ ok: true, surfaceIds: ['overview'] })
    expect(published).toHaveLength(1)
    expect(compiled).toHaveLength(1)
  })

  it('one file may draw several surfaces, in its order', async () => {
    const { host } = rig({ 'app.a2ui': TWO })
    expect((await host.start()).surface?.surfaceIds).toEqual(['overview', 'refunds'])
  })

  it('a failed build is published as an error beside the build before it; the next good build clears it', async () => {
    const { disk, host, published } = rig({ 'app.a2ui': BOARD })
    const first = await host.start()
    disk.write('app.a2ui', `${BOARD}\nBROKEN()`)
    expect(await host.build()).toEqual({ ok: false, message: 'app.a2ui did not build: line 2: unknown component BROKEN' })
    const broken = published.at(-1) as AppSurfaceState
    expect(broken.surface).toEqual(first.surface)
    expect(broken.errors).toEqual([{ kind: 'build', message: 'app.a2ui did not build: line 2: unknown component BROKEN' }])
    disk.write('app.a2ui', TWO)
    expect(await host.build()).toEqual({ ok: true, surfaceIds: ['overview', 'refunds'] })
    expect((published.at(-1) as AppSurfaceState).errors).toBeUndefined()
    expect(published).toHaveLength(3)
  })

  it('a missing entry is a build error and no surface; without a data file there is no data and no error', async () => {
    const missing = rig({})
    const none = await missing.host.start()
    expect(none.surface).toBeNull()
    expect(none.errors).toEqual([{ kind: 'build', message: 'app.a2ui is missing' }])
    const plain = rig({ 'app.a2ui': BOARD }, { data: undefined })
    const state = await plain.host.start()
    expect(state.data).toBeUndefined()
    expect(state.errors).toBeUndefined()
  })

  it('bad data is an error of kind data, and the last data stays', async () => {
    const { disk, host, published } = rig({ 'app.a2ui': BOARD, 'data/latest.json': '{"count":3}' })
    await host.start()
    disk.write('data/latest.json', '{"count":')
    await host.build()
    const bad = published.at(-1) as AppSurfaceState
    expect(bad.data).toEqual({ count: 3 })
    expect(bad.errors?.map(e => e.kind)).toEqual(['data'])
  })

  it("a plugin's write to the data file reads the data again, not the entry; other writes do nothing", async () => {
    const { disk, host, published } = rig({ 'app.a2ui': BOARD, 'data/latest.json': '{"count":3}' })
    await host.start()
    disk.write('data/latest.json', '{"count":4}')
    disk.write('app.a2ui', TWO)
    host.noteWrite('C:/home/elsewhere/latest.json')
    host.noteWrite(`${FOLDER}/app.a2ui`)
    await vi.waitFor(() => Promise.resolve())
    expect(published).toHaveLength(1)
    host.noteWrite(`${FOLDER}/data/latest.json`)
    host.noteWrite(`${FOLDER}\\data\\latest.json`)
    await vi.waitFor(() => expect(published).toHaveLength(2))
    expect(published[1]).toMatchObject({ data: { count: 4 }, surface: { surfaceIds: ['overview'] } })
  })

  it('closed: the state and the build leave the registry, once', async () => {
    const { host, published, builds } = rig({ 'app.a2ui': BOARD })
    await host.start()
    expect(builds.has('s1')).toBe(true)
    host.dispose()
    host.dispose()
    expect(builds.has('s1')).toBe(false)
    expect(published.at(-1)).toBeNull()
    expect(published).toHaveLength(2)
  })

  it('the defaults are the realm registry: mods.buildApp reaches the session that is open', async () => {
    const disk = memoryFs({ 'app.a2ui': BOARD })
    const host = createAppSurfaceHost({ fs: disk.fs, app: app({ data: undefined }), sessionId: 's1', compile })
    await host.start()
    expect(appSurfaceState('s1')?.surface?.body).toBe(BOARD)
    disk.write('app.a2ui', TWO)
    expect(await buildRegisteredApp('s1')).toEqual({ ok: true, surfaceIds: ['overview', 'refunds'] })
    expect(buildRegisteredApp('s9')).toBeUndefined()
    host.dispose()
    expect(appSurfaceState('s1')).toBeNull()
    expect(buildRegisteredApp('s1')).toBeUndefined()
  })

  it('a superseded host of the same session, closed after the newer one opened, leaves the newer one registered', async () => {
    const disk = memoryFs({ 'app.a2ui': BOARD })
    const older = createAppSurfaceHost({ fs: disk.fs, app: app({ data: undefined }), sessionId: 's1', compile })
    const newer = createAppSurfaceHost({ fs: disk.fs, app: app({ data: undefined }), sessionId: 's1', compile })
    await newer.start()
    older.dispose()
    expect(appSurfaceState('s1')?.surface?.body).toBe(BOARD)
    expect(await buildRegisteredApp('s1')).toEqual({ ok: true, surfaceIds: ['overview'] })
    newer.dispose()
    expect(appSurfaceState('s1')).toBeNull()
  })

  it('the runtime compiler: several surfaces in one file, a Tabs container, a broken file and a delete refused', async () => {
    const tabs = [
      'surface("main")',
      'root = Tabs([{title: "Overview", child: a}, {title: "Refunds", child: b}])',
      'a = Text("A")',
      'b = Text("B")',
    ].join('\n')
    const disk = memoryFs({ 'app.a2ui': TWO })
    const host = createAppSurfaceHost({
      fs: disk.fs,
      app: app({ data: undefined }),
      sessionId: 's1',
      publish: () => {},
      registerBuild: () => () => true,
    })
    expect((await host.start()).surface?.surfaceIds).toEqual(['overview', 'refunds'])
    disk.write('app.a2ui', tabs)
    expect(await host.build()).toEqual({ ok: true, surfaceIds: ['main'] })
    disk.write('app.a2ui', `${BOARD}\nroot = NoSuchThing(`)
    const broken = await host.build()
    expect(!broken.ok && broken.message).toMatch(/^app\.a2ui did not build: /)
    disk.write('app.a2ui', `${BOARD}\ndeleteSurface("overview")`)
    const deleting = await host.build()
    expect(!deleting.ok && deleting.message).toContain('may not delete a surface')
  })
})

describe('the BuildApp tool', () => {
  it('builds and reports the surfaces; a failure is an error result with the message to fix', async () => {
    const { disk, host } = rig({ 'app.a2ui': BOARD })
    await host.start()
    expect(host.tool.name).toBe(BUILD_APP_TOOL_NAME)
    expect(host.tool.readsOnly({} as never)).toBe(true)
    disk.write('app.a2ui', TWO)
    const ok = await callTool(host)
    expect(ok.data).toBe('Built app.a2ui: surface("overview"), surface("refunds"). The person sees it now.')
    expect(ok.isError).toBeUndefined()
    disk.write('app.a2ui', `${BOARD}\nBROKEN()`)
    const bad = await callTool(host)
    expect(bad.isError).toBe(true)
    expect(bad.data).toContain('app.a2ui did not build: line 2: unknown component BROKEN')
    expect(bad.data).toContain('previous build')
  })

  it('a data error rides along on a good build', async () => {
    const { host } = rig({ 'app.a2ui': BOARD, 'data/latest.json': 'nope' })
    await host.start()
    expect((await callTool(host)).data).toContain('data/latest.json is not JSON')
  })
})

describe("the app session's turn end", () => {
  it('builds silently when the entry changed since the last build, and not again when it did not', async () => {
    const { disk, host, published } = rig({ 'app.a2ui': BOARD })
    await host.start()
    const check = host.wrapTurnEndCheck(noInner, note)
    expect(await check({ messages: [], assistantMessages: [reply('done')] })).toEqual([])
    expect(compiled).toHaveLength(1)
    disk.write('app.a2ui', `${BOARD}\nBROKEN()`)
    expect(await check({ messages: [], assistantMessages: [reply('changed it')] })).toEqual([])
    expect(compiled).toHaveLength(2)
    expect((published.at(-1) as AppSurfaceState).errors?.[0]?.kind).toBe('build')
    expect(await check({ messages: [], assistantMessages: [reply('again')] })).toEqual([])
    expect(compiled).toHaveLength(2)
  })

  it("a reply drawing one of the app's surfaces in chat is told to change the file; the inner check's notes come first", async () => {
    const { host } = rig({ 'app.a2ui': TWO })
    await host.start()
    const inner = async () => [note('inner')]
    const drew = reply('Here:\n<a2ui>\nsurface("refunds")\nroot = Text("x")\n</a2ui>')
    expect(replyDrawsAppSurface([drew], ['overview', 'refunds'])).toEqual(['refunds'])
    expect(replyDrawsAppSurface([reply('<a2ui>\nsurface("chart")\nroot = Text("x")\n</a2ui>')], ['overview'])).toEqual([])
    const notes = await host.wrapTurnEndCheck(inner, note)({ messages: [], assistantMessages: [drew] })
    expect(notes).toHaveLength(2)
    expect((notes[0]!.message as { content: string }).content).toBe('inner')
    expect((notes[1]!.message as { content: string }).content).toContain('built from app.a2ui alone')
  })
})

describe('the app prompt block', () => {
  it('names the entry file, one surface with Tabs for its pages, the skill, BuildApp, the data file and its binding', () => {
    const block = appPromptBlock(app())
    expect(block).toContain('# This session is an app')
    expect(block).toContain('"pay-board"')
    expect(block).toContain('`app.a2ui`')
    expect(block).toContain('with one surface("...")')
    expect(block).toContain('pages are a Tabs component in that surface')
    expect(block).toContain('Tabs([{title: "Overview", child: overview}')
    expect(block).not.toContain('several surface')
    expect(block).toContain('Load the a2ui skill')
    expect(block).toContain(`call ${BUILD_APP_TOOL_NAME}`)
    expect(block).toContain('`data/latest.json`, set under $/data')
    expect(appPromptBlock(app({ data: undefined }))).toContain('has no data file')
  })
})

describe('the mods/app topic', () => {
  it('ids, the payload check', () => {
    expect(modsAppTopic('s1')).toBe('mods/app/s1')
    expect(() => modsAppTopic('a/b')).toThrow(RangeError)
    expect(modsAppTopicSession('mods/app/s1')).toBe('s1')
    expect(modsAppTopicSession('mods/app/')).toBeUndefined()
    expect(modsAppTopicSession('mods/app/a/b')).toBeUndefined()
    expect(modsAppTopicSession('mods/ui/s1')).toBeUndefined()
    const good: AppSurfaceState = { appId: 'a', surface: { body: 'b', hash: 'h', surfaceIds: ['x'] }, data: { x: 1 }, refreshing: false, errors: [{ kind: 'data', message: 'm' }] }
    expect(isAppSurfaceState(good)).toBe(true)
    expect(isAppSurfaceState({ ...good, surface: null })).toBe(true)
    expect(isAppSurfaceState(null)).toBe(false)
    expect(isAppSurfaceState({ ...good, surface: { body: 1 } })).toBe(false)
    expect(isAppSurfaceState({ ...good, surface: { body: 'b', hash: 'h', surfaceIds: [] } })).toBe(false)
    expect(isModsBuildAppPayload({ sessionId: 's1' })).toBe(true)
    expect(isModsBuildAppPayload({ sessionId: '' })).toBe(false)
    expect(MODS_ACTION_SCOPES.buildApp).toBe('control')
    expect(isAppSurfaceState({ ...good, errors: [{ kind: 'other', message: 'm' }] })).toBe(false)
  })

  it('session-bound: a connection sees the boards of its sessions; the snapshot is the registry\'s, null for no app', async () => {
    setAppSurfaceState('s1', { appId: 'a', surface: null, refreshing: false })
    const provider = modsAppTopicProvider()
    expect(provider.matches('mods/app/s1')).toBe(true)
    expect(provider.matches('mods/ui/s1')).toBe(false)
    const all = { scope: { mode: 'observe', sessions: 'all' } } as unknown as ConnectionInfo
    const bound = { scope: { mode: 'observe', sessions: ['s2'] } } as unknown as ConnectionInfo
    expect(provider.authorize('mods/app/s1', all)).toBe(true)
    expect(provider.authorize('mods/app/s1', bound)).toBe(false)
    expect(provider.authorize('mods/app/s2', bound)).toBe(true)
    const pages: unknown[] = []
    for await (const page of provider.snapshot('mods/app/s1', all)) pages.push(page)
    for await (const page of provider.snapshot('mods/app/s9', all)) pages.push(page)
    expect(pages).toEqual([
      { type: MODS_APP_STATE_EVENT, payload: { appId: 'a', surface: null, refreshing: false } },
      { type: MODS_APP_STATE_EVENT, payload: null },
    ])
  })

  it('each board change is published to its session\'s topic until stopped', () => {
    const publish = vi.fn()
    const stop = registerModsAppTopic({ registerProvider: vi.fn(), publish } as never)
    const state: AppSurfaceState = { appId: 'a', surface: null, refreshing: false }
    setAppSurfaceState('s1', state)
    setAppSurfaceState('s1', null)
    setAppSurfaceState('s1', null)
    expect(publish.mock.calls).toEqual([
      ['mods/app/s1', state, { type: MODS_APP_STATE_EVENT }],
      ['mods/app/s1', null, { type: MODS_APP_STATE_EVENT }],
    ])
    stop()
    setAppSurfaceState('s1', state)
    expect(publish).toHaveBeenCalledTimes(2)
    const seen: unknown[] = []
    const off = onAppSurfaceChanged((id, s) => seen.push([id, s]))
    setAppSurfaceState('s1', null)
    off()
    expect(seen).toEqual([['s1', null]])
  })
})
