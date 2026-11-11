// @vitest-environment happy-dom
/**
 * An app's own text in the person's language (F-40): the plugin's language
 * files merged into one table, published with the app's board and set under
 * `/text` on each of its surfaces, where the entry file binds to it.
 */
import { cleanup, render } from '@testing-library/react'
import { createElement as h } from 'react'
import type { ReactCatalogComponent } from '@a2ui/react'
import { MessageProcessor } from '@a2ui/web_core/v1_0'
import { afterEach, describe, expect, it } from 'vitest'

import { isAppSurfaceState, type AppSurfaceState } from '../browser/runtimeProtocol/modApps'
import { AppSurfaceFeeder } from '../browser/webview/a2ui/AppSurfaceFeeder'
import { vellocCatalog } from '../browser/webview/a2ui/catalog/vellocCatalog'
import type { AppSessionInfo } from '../mods/app/appSession'
import { createAppSurfaceHost } from '../mods/app/appSurfaceHost'
import { APP_TEXT_MAX_KEYS, appTextEntries, appTextFiles, readAppText } from '../mods/app/appText'
import { createA2uiExpressCompiler } from '../toolkit/builtin/a2ui/express/a2uiExpressCompiler'

afterEach(() => cleanup())

const ROOT = 'C:/plugins/pay'
const FOLDER = 'C:/home/.velloc/shared-workspace/app-pay-board'
const slash = (path: string) => path.split('\\').join('/')

const reader = (files: Record<string, string>) => async (path: string) => files[slash(path)]

describe("the plugin's language files", () => {
  it('are read English first, then the language, then the tag as given', () => {
    expect(appTextFiles('zh-CN')).toEqual(['en', 'zh', 'zh-CN'])
    expect(appTextFiles('pt_BR')).toEqual(['en', 'pt', 'pt-BR'])
    expect(appTextFiles('en')).toEqual(['en'])
    expect(appTextFiles(undefined)).toEqual(['en'])
    expect(appTextFiles('not a tag')).toEqual(['en'])
  })

  it('give text entries alone, by a key that is one segment of a data path and is not manifest text', () => {
    expect(
      appTextEntries({
        title: 'Payments',
        'board.empty': 'Nothing yet',
        'plugin.description': 'A dashboard',
        'a/b': 'x',
        'a~b': 'x',
        '': 'x',
        count: 3,
        nested: { a: 'b' },
        long: 'x'.repeat(2001),
      }),
    ).toEqual([
      ['title', 'Payments'],
      ['board.empty', 'Nothing yet'],
    ])
    expect(appTextEntries(['a'])).toEqual([])
    expect(appTextEntries(null)).toEqual([])
  })

  it("merge into one table, the person's language over English; a missing or broken file counts as empty", async () => {
    const files = {
      [`${ROOT}/locales/en.json`]: JSON.stringify({ title: 'Payments', refunds: 'Refunds' }),
      [`${ROOT}/locales/zh.json`]: JSON.stringify({ title: '收款' }),
      [`${ROOT}/locales/zh-TW.json`]: 'not json',
    }
    expect(await readAppText(reader(files), ROOT, 'zh-CN')).toEqual({ title: '收款', refunds: 'Refunds' })
    expect(await readAppText(reader(files), ROOT, 'zh-TW')).toEqual({ title: '收款', refunds: 'Refunds' })
    expect(await readAppText(reader(files), ROOT, 'fr')).toEqual({ title: 'Payments', refunds: 'Refunds' })
    expect(await readAppText(reader({}), ROOT, 'zh-CN')).toBeUndefined()
  })

  it('hold a bounded number of entries, a later file still replacing one it has', async () => {
    const en = Object.fromEntries(Array.from({ length: APP_TEXT_MAX_KEYS + 5 }, (_, i) => [`k${i}`, 'en']))
    const text = await readAppText(reader({ [`${ROOT}/locales/en.json`]: JSON.stringify(en), [`${ROOT}/locales/zh.json`]: JSON.stringify({ k0: '中', extra: '多' }) }), ROOT, 'zh')
    expect(Object.keys(text!)).toHaveLength(APP_TEXT_MAX_KEYS)
    expect(text!.k0).toBe('中')
    expect(text!.extra).toBeUndefined()
  })
})

describe("the app's board", () => {
  const app = (root?: string): AppSessionInfo => ({
    appId: 'pay-board',
    plugin: 'pay',
    folder: FOLDER,
    decl: { seed: './app', seedVersion: 1, entry: 'app.a2ui' },
    seed: { version: 1, written: [], conflicts: [] },
    ...(root !== undefined ? { root } : {}),
  })

  function disk(files: Record<string, string>) {
    return {
      stat: async (path: string) => {
        const text = files[slash(path)]
        if (text === undefined) throw Object.assign(new Error(`ENOENT ${path}`), { code: 'ENOENT' })
        return { isFile: () => true, isDirectory: () => false, size: text.length, mtimeMs: 1 } as never
      },
      readFileBytes: async (path: string) => new TextEncoder().encode(files[slash(path)]!),
    }
  }

  const host = (files: Record<string, string>, locale: string | undefined, root: string | undefined, published: AppSurfaceState[]) =>
    createAppSurfaceHost({
      fs: disk(files),
      app: app(root),
      sessionId: 's1',
      compile: async () => ({ ok: true, surfaceIds: ['app'] }),
      publish: (_id, state) => {
        if (state) published.push(state)
      },
      registerBuild: () => () => true,
      registerActor: () => () => true,
      liveData: { snapshot: () => undefined, subscribe: () => () => undefined },
      ...(locale !== undefined ? { locale } : {}),
    })

  it("carries the plugin's text in the session's language, read again at each build; none when the plugin ships none", async () => {
    const files: Record<string, string> = {
      [`${FOLDER}/app.a2ui`]: 'surface("app")\nroot = Text($/text/title)',
      [`${ROOT}/locales/en.json`]: JSON.stringify({ title: 'Payments' }),
      [`${ROOT}/locales/zh.json`]: JSON.stringify({ title: '收款' }),
    }
    const published: AppSurfaceState[] = []
    const made = host(files, 'zh-CN', ROOT, published)
    expect((await made.start()).text).toEqual({ title: '收款' })
    files[`${ROOT}/locales/zh.json`] = JSON.stringify({ title: '付款' })
    await made.build()
    expect(published.at(-1)?.text).toEqual({ title: '付款' })
    made.dispose()

    const english = host(files, undefined, ROOT, [])
    expect((await english.start()).text).toEqual({ title: 'Payments' })
    english.dispose()

    const none = host({ [`${FOLDER}/app.a2ui`]: 'surface("app")\nroot = Text("x")' }, 'zh-CN', ROOT, [])
    expect((await none.start()).text).toBeUndefined()
    none.dispose()
    const rootless = host(files, 'zh-CN', undefined, [])
    expect((await rootless.start()).text).toBeUndefined()
    rootless.dispose()
  })

  it('is a board a page accepts with text, and refuses with text that is not text', () => {
    const base = { appId: 'pay-board', surface: null, refreshing: false }
    expect(isAppSurfaceState({ ...base, text: { title: '收款' } })).toBe(true)
    expect(isAppSurfaceState({ ...base, text: { title: 3 } })).toBe(false)
    expect(isAppSurfaceState({ ...base, text: 'x' })).toBe(false)
  })
})

describe('the text on the surfaces', () => {
  const BOARD = ['surface("dashboard")', 'root = Card(col)', 'col = Column([title])', 'title = Text($/text/title)'].join('\n')
  const board = (hash: string, text?: Record<string, string>, data?: unknown): AppSurfaceState => ({
    appId: 'pay-board',
    surface: { body: BOARD, hash, surfaceIds: ['dashboard'] },
    refreshing: false,
    ...(text ? { text } : {}),
    ...(data !== undefined ? { data, dataSeq: 1 } : {}),
  })

  it('is set under /text beside the data, follows a new table, and goes when the plugin ships none', () => {
    const processor = new MessageProcessor<ReactCatalogComponent>([vellocCatalog], () => {})
    const compiler = createA2uiExpressCompiler(vellocCatalog)
    const view = (state: AppSurfaceState) => h(AppSurfaceFeeder, { board: state, processor, compiler, epoch: 0 })
    const at = (path: string) => processor.getSurface('dashboard')?.dataModel.get(path)
    const zh = { title: '收款' }
    const { rerender } = render(view(board('h1', zh, { count: 3 })))
    expect(at('/text')).toEqual(zh)
    expect(at('/text/title')).toBe('收款')
    expect(at('/data')).toEqual({ count: 3 })
    rerender(view(board('h1', { title: '付款' }, { count: 3 })))
    expect(at('/text/title')).toBe('付款')
    expect(at('/data')).toEqual({ count: 3 })
    rerender(view(board('h2', { title: '付款' }, { count: 3 })))
    expect(at('/text/title')).toBe('付款')
    rerender(view(board('h2', undefined, { count: 3 })))
    expect(at('/text')).toBeUndefined()
    expect(at('/data')).toEqual({ count: 3 })
  })
})
