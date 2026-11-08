/**
 * The apps' background modules, booted with the realm (F-40): the runtime is
 * created only once a published app has a background module, synced with the
 * apps on each publish, and the refs name the app's folder and state file.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { AppBackgroundRef, AppBackgroundRuntime } from '../mods/app/AppBackgroundRuntime'
import { appBackgroundRef, appBackgroundRuntime, bootAppBackground, resetAppBackgroundBootForTests } from '../mods/app/appBackgroundBoot'
import type { AppBackgroundTemplate } from '../mods/ui/contributionsHost'

afterEach(() => resetAppBackgroundBootForTests())

const template = (appId: string, data?: string): AppBackgroundTemplate => ({
  appId,
  type: `pay:${appId}`,
  plugin: 'pay',
  root: 'C:/plugins/pay',
  module: 'C:/plugins/pay/bg.js',
  owner: 'pay@mkt',
  decl: { seed: './app', seedVersion: 1, entry: 'app.a2ui', background: './bg.js', ...(data ? { data } : {}) },
  mcp: MCP_OWNER,
})

const MCP_OWNER = {
  name: 'pay',
  path: 'C:/plugins/pay',
  manifest: { name: 'pay' } as never,
  mcpServers: { docs: { type: 'http' as const, url: 'https://docs.test/mcp' } },
}

function fakeRuntime() {
  const synced: AppBackgroundRef[][] = []
  const runtime = {
    sync: vi.fn((refs: readonly AppBackgroundRef[]) => void synced.push([...refs])),
    dispose: vi.fn(async () => undefined),
  } as unknown as AppBackgroundRuntime
  return { runtime, synced }
}

const deps = { homeDir: 'C:/home', fs: {} as never, transport: () => null }

describe('the ref', () => {
  it('names the app folder, the data file as the state file, or data/state.json without one', () => {
    const slash = (path: string) => path.split('\\').join('/')
    const ref = appBackgroundRef('C:/home', template('pay-board', 'data/latest.json'), 'exempt')
    expect(ref).toMatchObject({ plugin: 'pay', path: 'C:/plugins/pay/bg.js', root: 'C:/plugins/pay', provenance: 'pay@mkt', appId: 'pay-board' })
    expect(slash(ref.folder)).toBe('C:/home/.velloc/shared-workspace/app-pay-board')
    expect(slash(ref.stateFile)).toBe('C:/home/.velloc/shared-workspace/app-pay-board/data/latest.json')
    expect(slash(appBackgroundRef('C:/home', template('pay-board'), 'exempt').stateFile)).toBe('C:/home/.velloc/shared-workspace/app-pay-board/data/state.json')
    expect(ref.mcpOwner).toBe(MCP_OWNER)
  })
})

describe('the boot', () => {
  it('creates no runtime while no app has a background module, then one, synced on each change', async () => {
    const { runtime, synced } = fakeRuntime()
    const createRuntime = vi.fn(async () => runtime)
    let apps: AppBackgroundTemplate[] = []
    let notify: (() => void) | undefined
    await bootAppBackground(deps, {
      apps: () => apps,
      onChanged: listener => {
        notify = listener
        return () => undefined
      },
      createRuntime,
    })
    expect(createRuntime).not.toHaveBeenCalled()
    expect(appBackgroundRuntime()).toBeNull()

    apps = [template('pay-board')]
    notify?.()
    await vi.waitFor(() => expect(synced).toHaveLength(1))
    expect(createRuntime).toHaveBeenCalledTimes(1)
    expect(synced[0]!.map(ref => ref.appId)).toEqual(['pay-board'])
    expect(appBackgroundRuntime()).toBe(runtime)

    apps = []
    notify?.()
    await vi.waitFor(() => expect(synced).toHaveLength(2))
    expect(synced[1]).toEqual([])
    expect(createRuntime).toHaveBeenCalledTimes(1)
  })

  it('a second boot is a no-op; a runtime that cannot be created is reported and tried again', async () => {
    const reports: string[] = []
    const { runtime } = fakeRuntime()
    const createRuntime = vi.fn().mockRejectedValueOnce(new Error('no kernel')).mockResolvedValue(runtime)
    let notify: (() => void) | undefined
    await bootAppBackground(
      { ...deps, report: line => reports.push(line) },
      { apps: () => [template('a')], onChanged: l => ((notify = l), () => undefined), createRuntime },
    )
    expect(reports).toEqual(['the app background runtime could not start (no kernel)'])
    await bootAppBackground(deps, { apps: () => [], onChanged: () => () => undefined, createRuntime })
    notify?.()
    await vi.waitFor(() => expect(appBackgroundRuntime()).toBe(runtime))
    expect(createRuntime).toHaveBeenCalledTimes(2)
  })
})

describe('the declared folders', () => {
  const slash = (path: string) => path.split('\\').join('/')
  const declaring = (): AppBackgroundTemplate => {
    const app = template('pay-board')
    app.decl.backgroundFs = { read: ['~/Downloads'], write: ['~/Documents/invoices'] }
    return app
  }
  const expanded = { read: ['C:/home/Downloads'], write: ['C:/home/Documents/invoices'] }
  const foldersOf = (ref: AppBackgroundRef) => ref.folders && { read: ref.folders.read.map(slash), write: ref.folders.write.map(slash) }

  it('a hand-placed plugin is exempt; a marketplace plugin gets them only as approved, expanded under the home', () => {
    expect(foldersOf(appBackgroundRef('C:/home', declaring(), 'exempt'))).toEqual(expanded)
    expect(foldersOf(appBackgroundRef('C:/home', declaring(), undefined))).toBeUndefined()
    expect(foldersOf(appBackgroundRef('C:/home', declaring(), { read: ['~/Downloads'], write: [] }))).toBeUndefined()
    expect(foldersOf(appBackgroundRef('C:/home', declaring(), { read: [], write: ['~/Documents/invoices', '~/Downloads'] }))).toEqual(expanded)
    expect(appBackgroundRef('C:/home', template('pay-board'), undefined).folders).toBeUndefined()
  })

  it('the boot reads the consent file for a marketplace plugin and reports folders it does not cover', async () => {
    const { runtime, synced } = fakeRuntime()
    const reports: string[] = []
    let consent: unknown = { version: 1, plugins: { 'pay@mkt': { consent: { version: '1', at: 'x', grant: { providers: {}, folders: { read: [], write: ['~/Documents/invoices', '~/Downloads'] } } } } } }
    const fs = { readFile: async () => JSON.stringify(consent) } as never
    const app = { ...declaring(), consentId: 'pay@mkt' }
    let notify: (() => void) | undefined
    await bootAppBackground(
      { ...deps, fs, report: line => reports.push(line) },
      { apps: () => [app], onChanged: listener => ((notify = listener), () => undefined), createRuntime: async () => runtime },
    )
    await vi.waitFor(() => expect(synced).toHaveLength(1))
    expect(foldersOf(synced[0]![0]!)).toEqual(expanded)
    expect(reports).toEqual([])
    consent = { version: 1, plugins: {} }
    notify?.()
    await vi.waitFor(() => expect(synced).toHaveLength(2))
    expect(synced[1]![0]!.folders).toBeUndefined()
    expect(reports).toEqual(["pay: the folders pay-board declares are not approved; its $.fs stays in the app's folder"])
  })
})
