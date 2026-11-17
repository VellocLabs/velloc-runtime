/**
 * Apps drawn as one sandboxed plugin page (F-42): the manifest's `page`, the
 * `page` flag on the published app, `mods.appPage` reading the plugin's file
 * with the host's topic allowlist, the page-side relay that can always end the
 * connection, the observer-port opener, and the frame code kept behind import().
 */
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { checkTemplateDecls } from '../mods/ui/uiManifest'
import { APP_PAGE_MAX_BYTES, APP_PAGE_TOPICS, allowedPageTopics, readAppPage } from '../mods/app/appPage'
import { CapabilityRegistry } from '../browser/runtimeHub/CapabilityRegistry'
import { TopicBroker } from '../browser/runtimeHub/TopicBroker'
import { registerModsCapability } from '../browser/runtimeHub/modsCapability'
import { MODS_ACTION_SCOPES } from '../browser/runtimeProtocol/mods'
import { isModsAppPagePayload } from '../browser/runtimeProtocol/modApps'
import { relayAppPagePort, APP_PAGE_PORT_MESSAGE } from '../browser/webview/apps/appPageRelay'
import { APP_PAGE_CSP, withAppPageCsp } from '../browser/webview/apps/appPageCsp'
import { openObserverPort, provideObserverPorts, resetObserverPortsForTests } from '../browser/runtimeClient/observerPorts'
import { read, SRC, staticClosure, stripComments } from './_helpers/staticImportGraph'

const APP = { seed: './app', entry: 'board.a2ui' }

describe('an app page in the manifest', () => {
  it('takes a plugin .html file and the topics it asks for, deduplicated', () => {
    const errors: string[] = []
    const decls = checkTemplateDecls(
      'office',
      { floor: { title: 'Office', app: { ...APP, page: { file: './app/office.html', topics: ['sessions', 'tasks', 'sessions'] } } } },
      errors,
      'beta',
    )
    expect(errors).toEqual([])
    expect(decls?.floor?.app?.page).toEqual({ file: './app/office.html', topics: ['sessions', 'tasks'] })
  })

  it('refuses a page outside the plugin, not html, or with bad topics, and keeps the app without it', () => {
    for (const page of [
      { file: '../office.html', topics: [] },
      { file: './app/office.js', topics: [] },
      { file: './app/office.html', topics: ['Sessions!'] },
      { file: './app/office.html', topics: 'sessions' },
      './app/office.html',
    ]) {
      const errors: string[] = []
      const decls = checkTemplateDecls('office', { floor: { title: 'Office', app: { ...APP, page } } }, errors, 'beta')
      expect(errors).toHaveLength(1)
      expect(errors[0]).toMatch(/page/)
      expect(decls?.floor?.app?.page).toBeUndefined()
    }
  })
})

type Published = { appId: string; type: string }

function fakeHost(page: { file: string; topics: string[] } | undefined, root: string | undefined = '/plugins/office') {
  const apps: Published[] = [{ appId: 'office-floor', type: 'office:floor' }]
  return {
    state: () => ({ templates: [], topbar: [], icons: {}, waiting: [], apps: apps.map(app => ({ ...app, plugin: 'office', title: 'Office' })) }) as never,
    appOf: (type: string) =>
      type === 'office:floor'
        ? ({ appId: 'office-floor', plugin: 'office', decl: { seed: './app', seedVersion: 1, entry: 'app.a2ui', ...(page ? { page } : {}) }, seedDir: '/s', root }) as never
        : undefined,
  }
}

function fakeFs(files: Record<string, string | number>) {
  return {
    stat: vi.fn(async (path: string) => {
      const value = files[path]
      if (value === undefined) throw new Error('ENOENT')
      const size = typeof value === 'number' ? value : new TextEncoder().encode(value).length
      return { isFile: () => true, size } as never
    }),
    readFileBytes: vi.fn(async (path: string) => new TextEncoder().encode(String(files[path]))),
  }
}

describe('mods.appPage', () => {
  it('allows only the topics the host names, whatever the manifest asks', () => {
    expect(APP_PAGE_TOPICS).toEqual(['sessions', 'tasks'])
    expect(allowedPageTopics(['tasks', 'settings', 'sessions', 'session'])).toEqual(['tasks', 'sessions'])
  })

  it('reads the page file from the plugin and caps its topics', async () => {
    const fs = fakeFs({ '/plugins/office/app/office.html': '<p>office</p>' })
    const result = await readAppPage('office-floor', fs, fakeHost({ file: './app/office.html', topics: ['sessions', 'notifications'] }))
    expect(result).toEqual({ ok: true, html: '<p>office</p>', topics: ['sessions'] })
  })

  it('refuses an unknown app, a surface app, a missing file and one over the size limit', async () => {
    const page = { file: './app/office.html', topics: ['sessions'] }
    expect((await readAppPage('nope', fakeFs({}), fakeHost(page))).ok).toBe(false)
    expect((await readAppPage('office-floor', fakeFs({}), fakeHost(undefined))).ok).toBe(false)
    expect((await readAppPage('office-floor', fakeFs({}), fakeHost(page))).ok).toBe(false)
    const big = fakeFs({ '/plugins/office/app/office.html': APP_PAGE_MAX_BYTES + 1 })
    const refused = await readAppPage('office-floor', big, fakeHost(page))
    expect(refused).toMatchObject({ ok: false })
    expect(big.readFileBytes).not.toHaveBeenCalled()
  })

  it('is an observe action on an app id, answered by the runtime', async () => {
    expect(MODS_ACTION_SCOPES.appPage).toBe('observe')
    expect(isModsAppPagePayload({ appId: 'office-floor' })).toBe(true)
    expect(isModsAppPagePayload({ appId: '' })).toBe(false)
    expect(isModsAppPagePayload({ sessionId: 's' })).toBe(false)
    const registry = new CapabilityRegistry()
    const appPage = vi.fn(async () => ({ ok: true as const, html: '<p/>', topics: ['sessions'] }))
    const mods = registerModsCapability(registry, new TopicBroker(), { appPage })
    const entry = registry.resolve('mods', 'appPage')!
    expect(entry.spec.scope).toBe('observe')
    expect(entry.spec.sessionOf).toBeUndefined()
    const answer = await entry.handle({ id: '1', route: { cap: 'mods', act: 'appPage' }, payload: { appId: 'office-floor' } } as never, {} as never)
    expect(answer).toEqual({ ok: true, html: '<p/>', topics: ['sessions'] })
    expect(appPage).toHaveBeenCalledWith('office-floor')
    mods.dispose()
  })
})

const ports: MessagePort[] = []
afterEach(() => {
  for (const port of ports.splice(0)) port.close()
  resetObserverPortsForTests()
})

function nextMessage(port: MessagePort): Promise<unknown> {
  return new Promise(resolve => {
    port.onmessage = event => resolve(event.data)
  })
}

describe('the page relay', () => {
  it('forwards both ways, then says goodbye to the runtime and stops on close', async () => {
    const runtime = new MessageChannel()
    ports.push(runtime.port1, runtime.port2)
    const relay = relayAppPagePort(runtime.port1)
    ports.push(relay.pagePort)

    const up = nextMessage(runtime.port2)
    relay.pagePort.postMessage({ kind: 'hello' })
    expect(await up).toEqual({ kind: 'hello' })

    const down = nextMessage(relay.pagePort)
    runtime.port2.postMessage({ kind: 'welcome' })
    expect(await down).toEqual({ kind: 'welcome' })

    const bye = nextMessage(runtime.port2)
    relay.close()
    relay.close()
    expect(await bye).toEqual({ kind: 'bye', code: 'shutting_down' })
    expect(APP_PAGE_PORT_MESSAGE).toBe('velloc.runtimePort')
  })
})

describe('observer ports', () => {
  it('opens nothing before boot binds the opener', () => {
    expect(openObserverPort(['sessions'])).toBeNull()
  })

  it('attaches every port capped to observe on the named topics', () => {
    const posted: Array<{ data: unknown; transfer: unknown[] }> = []
    const sharedWorkerPort = { postMessage: (data: unknown, transfer: unknown[]) => posted.push({ data, transfer }) } as unknown as MessagePort
    provideObserverPorts(sharedWorkerPort, '/home')
    const port = openObserverPort(['sessions', 'tasks'])
    expect(port).not.toBeNull()
    ports.push(port!)
    expect(posted).toHaveLength(1)
    expect(posted[0]!.data).toEqual({
      type: 'bridge.attachRuntimePort',
      homeDir: '/home',
      delegate: { scope: 'observe', topics: ['sessions', 'tasks'] },
    })
    expect(posted[0]!.transfer).toHaveLength(1)
  })
})

describe('the page frame stays out of the static graph', () => {
  const host = join(SRC, 'browser', 'webview', 'a2ui', 'A2uiProviderHost.tsx')
  const frame = join(SRC, 'browser', 'webview', 'apps', 'AppPageFrame.tsx')

  it('is reached from the pane only through import()', () => {
    expect(staticClosure([host]).has(frame)).toBe(false)
    expect(stripComments(read(host))).toContain(`import('../apps/AppPageFrame')`)
  })

  it('is not reached from the shell statically', () => {
    const shell = join(SRC, 'browser', 'webview', 'MultiSessionShell.tsx')
    const opener = join(SRC, 'browser', 'runtimeClient', 'observerPorts.ts')
    expect(staticClosure([shell]).has(opener)).toBe(false)
  })
})

describe('the page policy', () => {
  it('refuses network requests and form posts, and allows what a page inlines', () => {
    const rules = new Map(APP_PAGE_CSP.split('; ').map(rule => [rule.split(' ')[0], rule.split(' ').slice(1)]))
    expect(rules.get('default-src')).toEqual(["'none'"])
    expect(rules.has('connect-src')).toBe(false)
    expect(rules.get('form-action')).toEqual(["'none'"])
    for (const [directive, sources] of rules) {
      for (const source of sources) expect(source, directive).toMatch(/^('[a-z-]+'|data:|blob:)$/)
    }
  })

  it('goes first in the page, after a leading doctype', () => {
    const meta = `<meta http-equiv="Content-Security-Policy" content="${APP_PAGE_CSP}">`
    expect(withAppPageCsp('<p>x</p>')).toBe(`${meta}<p>x</p>`)
    expect(withAppPageCsp('<!DOCTYPE html><html><head><meta http-equiv="Content-Security-Policy" content="default-src *"></head></html>')).toBe(
      `<!DOCTYPE html>${meta}<html><head><meta http-equiv="Content-Security-Policy" content="default-src *"></head></html>`,
    )
    expect(withAppPageCsp('<p><!doctype html></p>')).toBe(`${meta}<p><!doctype html></p>`)
    expect(withAppPageCsp('<!-- licence --><!doctype html><p>x</p>')).toBe(`<!-- licence --><!doctype html>${meta}<p>x</p>`)
  })
})

describe('session detail on an app page (F-42)', () => {
  const ASKED = ['sessions', 'session/*/state', 'turn/*', 'session/s1/state']

  it('the manifest takes the session-detail patterns as topics', () => {
    const errors: string[] = []
    const decls = checkTemplateDecls(
      'office',
      { floor: { title: 'Office', app: { ...APP, page: { file: './app/office.html', topics: ['sessions', 'session/*/state', 'turn/*'] } } } },
      errors,
      'beta',
    )
    expect(errors).toEqual([])
    expect(decls?.floor?.app?.page?.topics).toEqual(['sessions', 'session/*/state', 'turn/*'])
    checkTemplateDecls('office', { floor: { title: 'Office', app: { ...APP, page: { file: './app/office.html', topics: ['session/s1/state'] } } } }, errors, 'beta')
    expect(errors).toHaveLength(1)
  })

  it('allows the patterns only with a grant that has sessionDetail, never a concrete id', () => {
    expect(allowedPageTopics(ASKED)).toEqual(['sessions'])
    expect(allowedPageTopics(ASKED, {})).toEqual(['sessions'])
    expect(allowedPageTopics(ASKED, { sessionDetail: true })).toEqual(['sessions', 'session/*/state', 'turn/*'])
  })

  it('reads the grant on file for a catalog plugin; a hand-placed one is exempt', async () => {
    const fs = fakeFs({ '/plugins/office/app/office.html': '<p>office</p>' })
    const page = { file: './app/office.html', topics: ['sessions', 'session/*/state'] }
    const catalog = () => {
      const host = fakeHost(page)
      return { ...host, appOf: (type: string) => ({ ...(host.appOf(type) as unknown as object), consentId: 'office@mkt' }) as never }
    }
    const grantOf = vi.fn(async (id: string) => (id === 'office@mkt' ? { providers: {} } : undefined))
    expect(await readAppPage('office-floor', fs, catalog(), grantOf)).toMatchObject({ topics: ['sessions'] })
    expect(grantOf).toHaveBeenCalledWith('office@mkt')
    const approved = async () => ({ providers: {}, sessionDetail: true as const })
    expect(await readAppPage('office-floor', fs, catalog(), approved)).toMatchObject({ topics: ['sessions', 'session/*/state'] })
    expect(await readAppPage('office-floor', fs, catalog())).toMatchObject({ topics: ['sessions'] })
    expect(await readAppPage('office-floor', fs, fakeHost(page))).toMatchObject({ topics: ['sessions', 'session/*/state'] })
  })
})
