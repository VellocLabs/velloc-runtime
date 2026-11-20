/**
 * An app that names the studio catalog (F-1, F-40), runtime half: the manifest
 * field, the build checked against that catalog, the board saying which
 * catalog it was built for, and what the session's model is told.
 */
import { describe, expect, it } from 'vitest'

import { checkTemplateDecls } from '../mods/ui/uiManifest'
import { isAppSurfaceState, type AppSurfaceState } from '../browser/runtimeProtocol/modApps'
import { appPromptBlock, BUILD_APP_TOOL_NAME, createAppSurfaceHost } from '../mods/app/appSurfaceHost'
import type { AppSessionInfo } from '../mods/app/appSession'
import { A2UI_HOSTED_SKILL } from '../toolkit/builtin/a2ui/a2uiSkill'
import { A2UI_STUDIO_HOSTED_SKILL } from '../toolkit/builtin/a2ui/a2uiStudioSkill'
import { DASHBOARD_EXPRESS, DASHBOARD_SURFACE_ID } from '../browser/webview/a2ui/studio/dev/dashboardFixture'

const FOLDER = 'C:/home/.velloc/shared-workspace/app-pay-board'
const APP = { seed: './app' }
const VELLOC_ONLY = ['surface("main")', 'root = Metric("Total", "3")'].join('\n')

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

const app = (extra: Partial<AppSessionInfo['decl']> = {}): AppSessionInfo => ({
  appId: 'pay-board',
  plugin: 'pay',
  folder: FOLDER,
  decl: { seed: './app', seedVersion: 1, entry: 'app.a2ui', ...extra },
  seed: { version: 1, written: [], conflicts: [] },
})

function host(files: Record<string, string>, decl?: Partial<AppSessionInfo['decl']>) {
  const disk = memoryFs(files)
  const published: Array<AppSurfaceState | null> = []
  const surface = createAppSurfaceHost({
    fs: disk.fs,
    app: app(decl),
    sessionId: 'studio-1',
    publish: (_id, state) => published.push(state),
    registerBuild: () => () => true,
  })
  return { disk, surface, published }
}

describe('app.catalog in the manifest', () => {
  it('takes "studio"; an app without the field carries none', () => {
    const errors: string[] = []
    const decls = checkTemplateDecls('pay', { board: { title: 'P', app: { ...APP, catalog: 'studio' } }, plain: { title: 'Q', app: APP } }, errors, 'beta')
    expect(errors).toEqual([])
    expect(decls?.board?.app?.catalog).toBe('studio')
    expect(decls?.plain?.app).toEqual({ seed: './app', seedVersion: 1, entry: 'app.a2ui' })
  })

  it('refuses the template naming the field for any other value', () => {
    for (const bad of ['velloc', 'Studio', '', 3, true, null, ['studio']]) {
      const errors: string[] = []
      expect(checkTemplateDecls('pay', { board: { title: 'P', app: { ...APP, catalog: bad } } }, errors, 'beta')).toBeUndefined()
      expect(errors).toEqual(['templates.board.app.catalog: expected "studio"'])
    }
  })

  it('refuses a catalog on an app that draws its own page', () => {
    const errors: string[] = []
    const page = { file: './page/index.html', topics: [] }
    expect(checkTemplateDecls('pay', { board: { title: 'P', app: { ...APP, page, catalog: 'studio' } } }, errors, 'beta')).toBeUndefined()
    expect(errors).toEqual(['templates.board.app.catalog: an app with "page" draws its own page and names no catalog'])
  })
})

describe('a studio app built by the runtime', () => {
  it('checks the entry against the studio catalog and says so on the board', async () => {
    const { surface, published } = host({ 'app.a2ui': DASHBOARD_EXPRESS }, { catalog: 'studio' })
    const state = await surface.start()
    expect(state.surface?.surfaceIds).toEqual([DASHBOARD_SURFACE_ID])
    expect(state.catalog).toBe('studio')
    expect(published.at(-1)?.catalog).toBe('studio')
    surface.dispose()
  })

  it('refuses a component only the Velloc catalog has, and keeps the build before it', async () => {
    const { disk, surface } = host({ 'app.a2ui': DASHBOARD_EXPRESS }, { catalog: 'studio' })
    await surface.start()
    disk.write('app.a2ui', VELLOC_ONLY)
    const broken = await surface.build()
    expect(!broken.ok && broken.message).toMatch(/^app\.a2ui did not build: /)
    surface.dispose()
  })

  it('an app without the field is checked against the Velloc catalog as before', async () => {
    const plain = host({ 'app.a2ui': VELLOC_ONLY })
    const state = await plain.surface.start()
    expect(state.surface?.surfaceIds).toEqual(['main'])
    expect('catalog' in state).toBe(false)
    plain.surface.dispose()

    const studioBody = host({ 'app.a2ui': DASHBOARD_EXPRESS })
    expect((await studioBody.surface.start()).surface).toBeNull()
    studioBody.surface.dispose()
  })
})

describe('the board protocol', () => {
  const state: AppSurfaceState = { appId: 'pay-board', surface: null, refreshing: false }

  it('takes a board with the studio catalog and refuses a name it does not know', () => {
    expect(isAppSurfaceState({ ...state, catalog: 'studio' })).toBe(true)
    expect(isAppSurfaceState({ ...state, catalog: 'other' })).toBe(false)
    expect(isAppSurfaceState({ ...state, catalog: 1 })).toBe(false)
  })
})

describe('what a studio app session is told', () => {
  it('names the studio component set, the skill and the build tool, and forbids chat blocks', () => {
    const block = appPromptBlock(app({ catalog: 'studio', data: 'data/latest.json' }))
    expect(block).toContain('# This session is an app')
    expect(block).toContain('written for the studio component set')
    expect(block).toContain('Load the a2ui skill')
    expect(block).toContain(`call ${BUILD_APP_TOOL_NAME}`)
    expect(block).toContain('Never write an <a2ui> block in chat in this session')
    expect(block).toContain('`data/latest.json`, set under $/data')
    expect(block).not.toContain('Tabs([{title: "Overview"')
    expect(appPromptBlock(app({ catalog: 'studio' }))).toContain('has no data file')
  })

  it('the skill keeps its name and menu line and teaches the studio components', () => {
    expect(A2UI_STUDIO_HOSTED_SKILL.name).toBe(A2UI_HOSTED_SKILL.name)
    expect(A2UI_STUDIO_HOSTED_SKILL.description).toBe(A2UI_HOSTED_SKILL.description)
    expect(A2UI_STUDIO_HOSTED_SKILL.toolNames).toEqual([])
    const text = A2UI_STUDIO_HOSTED_SKILL.instructions
    expect(text.indexOf('# The studio component set')).toBe(0)
    expect(text).toContain('• Stat(')
    expect(text).toContain('• Modal(')
    expect(text).not.toContain('• Metric(')
  })
})
