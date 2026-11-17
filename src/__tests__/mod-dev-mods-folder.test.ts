/**
 * The session's dev mods folder (F-25): found at a turn end, turned on once
 * (asked, or at once with a notice in the bypass mode), never in `dontAsk` or
 * where nobody can be asked; a later change to its plugins reconciles; and
 * the question reaches the session's pages through the registry.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createDevModsFolder, type DevModsAnswer, type DevModsFolderOptions } from '../mods/devModsFolder'
import { answerDevModsAsk, modSlotUiState, onModUiEvents, openDevModsAsk, showDevModsNotice } from '../mods/modSlotRegistry'
import type { ActivePlugin } from '../pluginHost/pluginModel'
import type { RuntimeFsEntry } from '../utils/fs/runtimeFs'

const dir = (name: string): RuntimeFsEntry => ({
  name,
  isFile: () => false,
  isDirectory: () => true,
  isSymbolicLink: () => false,
})

function folderWorld(
  options: {
    mode?: string | (() => string)
    canAsk?: boolean
    answer?: DevModsAnswer
    installed?: string[]
    changed?: () => Promise<void>
    loaded?: (plugins: readonly ActivePlugin[]) => Promise<void>
  } = {},
) {
  /** folder name → manifest mtime (absent: no manifest). */
  const manifests = new Map<string, number>()
  /** folder name → hooks/hooks.json mtime. */
  const hooks = new Map<string, number>()
  const reports: string[] = []
  const asked: string[][] = []
  const notified: string[][] = []
  let answer: (value: DevModsAnswer) => void = () => {}
  const changed = vi.fn(options.changed ?? (async () => {}))
  const opts: DevModsFolderOptions = {
    folder: '/home/.velloc/dev-mods/s1',
    readdir: async () => [...manifests.keys(), 'loose'].map(dir),
    mtime: async path => {
      const name = path.split('/')[5]
      if (path.endsWith('/plugin.json')) return manifests.get(name)
      return path.endsWith('/hooks/hooks.json') ? hooks.get(name) : undefined
    },
    join: (base, ...segments) => [base, ...segments].join('/'),
    assemble: async (pluginDir, folderName) =>
      ({
        name: `${folderName}-mod`,
        path: pluginDir,
        manifest: { name: `${folderName}-mod` },
        hookModules: [`${pluginDir}/hooks/register.ts`],
      }) as unknown as ActivePlugin,
    isInstalled: name => (options.installed ?? []).includes(name),
    permissionMode: () => (typeof options.mode === 'function' ? options.mode() : (options.mode ?? 'default')),
    canAsk: options.canAsk ?? true,
    ask: plugins => {
      asked.push([...plugins])
      if (options.answer) return Promise.resolve(options.answer)
      return new Promise(resolve => {
        answer = resolve
      })
    },
    notifyOn: plugins => notified.push([...plugins]),
    onPluginsChanged: changed,
    ...(options.loaded ? { onLoaded: options.loaded } : {}),
    report: line => reports.push(line),
  }
  const folder = createDevModsFolder(opts)
  return { folder, manifests, hooks, reports, asked, notified, changed, answer: (value: DevModsAnswer) => answer(value) }
}

const settle = () => new Promise(resolve => setTimeout(resolve, 0))

describe('createDevModsFolder', () => {
  it('an empty folder asks nothing and loads nothing', async () => {
    const w = folderWorld()
    await w.folder.afterTurn()
    expect(w.asked).toEqual([])
    expect(w.folder.state()).toBe('unasked')
    expect(w.folder.plugins()).toEqual([])
  })

  it('a manifest asks once without holding the turn; "on" loads the folder', async () => {
    const w = folderWorld()
    w.manifests.set('panel', 1)
    await w.folder.afterTurn()
    expect(w.asked).toEqual([['panel-mod']])
    expect(w.folder.state()).toBe('asking')
    await w.folder.afterTurn()
    expect(w.asked).toHaveLength(1)
    w.answer('on')
    await settle()
    await settle()
    expect(w.folder.state()).toBe('on')
    expect(w.folder.plugins().map(p => [p.name, p.installIdentifier, p.enabled])).toEqual([
      ['panel-mod', 'panel-mod@dev', true],
    ])
    expect(w.changed).toHaveBeenCalledTimes(1)
  })

  it('a folder without a manifest is not a plugin', async () => {
    const w = folderWorld({ mode: 'bypassPermissions' })
    await w.folder.afterTurn()
    expect(w.folder.state()).toBe('unasked')
  })

  it('declined: never asked again, nothing loads', async () => {
    const w = folderWorld({ answer: 'declined' })
    w.manifests.set('panel', 1)
    await w.folder.afterTurn()
    await settle()
    await w.folder.afterTurn()
    expect(w.asked).toHaveLength(1)
    expect(w.folder.state()).toBe('declined')
    expect(w.folder.plugins()).toEqual([])
  })

  it('dismissed: asked again at the next turn end', async () => {
    const w = folderWorld({ answer: 'dismissed' })
    w.manifests.set('panel', 1)
    await w.folder.afterTurn()
    await settle()
    expect(w.folder.state()).toBe('unasked')
    await w.folder.afterTurn()
    expect(w.asked).toHaveLength(2)
  })

  it('bypassPermissions turns it on without asking, and the notice names each plugin it loaded', async () => {
    const w = folderWorld({ mode: 'bypassPermissions', installed: ['clash-mod'] })
    w.manifests.set('panel', 1)
    w.manifests.set('band', 1)
    w.manifests.set('clash', 1)
    await w.folder.afterTurn()
    expect(w.asked).toEqual([])
    expect(w.folder.state()).toBe('on')
    expect(w.folder.plugins().map(p => p.name)).toEqual(['band-mod', 'panel-mod'])
    expect(w.notified).toEqual([['band-mod', 'panel-mod']])
    w.manifests.set('panel', 2)
    await w.folder.afterTurn()
    expect(w.notified).toHaveLength(1)
    w.manifests.set('extra', 1)
    await w.folder.afterTurn()
    expect(w.notified).toEqual([['band-mod', 'panel-mod'], ['extra-mod']])
  })

  it('auto asks, and loads nothing until the answer', async () => {
    const w = folderWorld({ mode: 'auto' })
    w.manifests.set('panel', 1)
    await w.folder.afterTurn()
    expect(w.asked).toEqual([['panel-mod']])
    expect(w.folder.state()).toBe('asking')
    expect(w.folder.plugins()).toEqual([])
    expect(w.changed).not.toHaveBeenCalled()
    await w.folder.afterTurn()
    expect(w.folder.plugins()).toEqual([])
    w.answer('on')
    await settle()
    await settle()
    expect(w.folder.plugins().map(p => p.name)).toEqual(['panel-mod'])
    expect(w.notified).toEqual([])
  })

  it('dontAsk, or nobody to ask: off, said once in the report', async () => {
    for (const w of [folderWorld({ mode: 'dontAsk' }), folderWorld({ canAsk: false })]) {
      w.manifests.set('panel', 1)
      await w.folder.afterTurn()
      await w.folder.afterTurn()
      expect(w.asked).toEqual([])
      expect(w.folder.state()).toBe('off')
      expect(w.reports).toHaveLength(1)
    }
  })

  it('while on, a new plugin or a rewritten manifest reconciles; no change does not', async () => {
    const w = folderWorld({ mode: 'bypassPermissions' })
    w.manifests.set('panel', 1)
    await w.folder.afterTurn()
    expect(w.changed).toHaveBeenCalledTimes(1)
    await w.folder.afterTurn()
    expect(w.changed).toHaveBeenCalledTimes(1)
    w.manifests.set('band', 1)
    await w.folder.afterTurn()
    expect(w.folder.plugins().map(p => p.name)).toEqual(['band-mod', 'panel-mod'])
    w.manifests.set('panel', 2)
    await w.folder.afterTurn()
    expect(w.changed).toHaveBeenCalledTimes(3)
  })

  it('a hooks.json written after the manifest loads the plugin at the next turn end', async () => {
    const w = folderWorld({ mode: 'bypassPermissions' })
    w.manifests.set('panel', 1)
    await w.folder.afterTurn()
    expect(w.changed).toHaveBeenCalledTimes(1)
    w.hooks.set('panel', 5)
    await w.folder.afterTurn()
    expect(w.changed).toHaveBeenCalledTimes(2)
    w.hooks.set('panel', 6)
    await w.folder.afterTurn()
    expect(w.changed).toHaveBeenCalledTimes(3)
  })

  it('a dev plugin named like an installed one is left out, and the report says so', async () => {
    const w = folderWorld({ mode: 'bypassPermissions', installed: ['panel-mod'] })
    w.manifests.set('panel', 1)
    w.manifests.set('band', 1)
    await w.folder.afterTurn()
    expect(w.folder.plugins().map(p => p.name)).toEqual(['band-mod'])
    expect(w.reports.some(line => line.includes('panel-mod') && line.includes('installed'))).toBe(true)
  })

  it('off in dontAsk, then asked once the mode can ask', async () => {
    let mode = 'dontAsk'
    const w = folderWorld({ mode: () => mode })
    w.manifests.set('panel', 1)
    await w.folder.afterTurn()
    expect(w.folder.state()).toBe('off')
    mode = 'default'
    await w.folder.afterTurn()
    expect(w.asked).toEqual([['panel-mod']])
    expect(w.folder.state()).toBe('asking')
  })

  it('"on" whose load fails is reported, never an unhandled rejection', async () => {
    const unhandled = vi.fn()
    process.on('unhandledRejection', unhandled)
    try {
      const w = folderWorld({
        answer: 'on',
        changed: async () => {
          throw new Error('reconcile broke')
        },
      })
      w.manifests.set('panel', 1)
      await w.folder.afterTurn()
      await settle()
      await settle()
      expect(w.reports.some(line => line.includes('reconcile broke'))).toBe(true)
      expect(unhandled).not.toHaveBeenCalled()
    } finally {
      process.off('unhandledRejection', unhandled)
    }
  })
})

describe('the dev mods question on mods/ui/<sessionId>', () => {
  const undo: Array<() => void> = []
  afterEach(() => {
    for (const fn of undo.splice(0)) fn()
  })

  it('is in the session state until answered, and only for that session', async () => {
    const events: Array<{ sessionId: string; asked: boolean }> = []
    undo.push(
      onModUiEvents((sessionId, event) => {
        if (event.kind === 'state') events.push({ sessionId, asked: event.state.devModsAsk !== undefined })
      }),
    )
    const asking = openDevModsAsk('dev-s1', ['panel-mod'])
    const ask = modSlotUiState('dev-s1').devModsAsk!
    expect(ask.plugins).toEqual(['panel-mod'])
    expect(modSlotUiState('dev-s2').devModsAsk).toBeUndefined()
    expect(answerDevModsAsk('dev-s2', ask.requestId, 'on')).toBe(false)
    expect(answerDevModsAsk('dev-s1', 'wrong', 'on')).toBe(false)
    expect(answerDevModsAsk('dev-s1', ask.requestId, 'on')).toBe(true)
    await expect(asking).resolves.toBe('on')
    expect(modSlotUiState('dev-s1').devModsAsk).toBeUndefined()
    expect(answerDevModsAsk('dev-s1', ask.requestId, 'on')).toBe(false)
    expect(events).toEqual([
      { sessionId: 'dev-s1', asked: true },
      { sessionId: 'dev-s1', asked: false },
    ])
  })

  it('the turned-on notice names every plugin, grows with new ones, and a page dismisses it', async () => {
    const events: boolean[] = []
    undo.push(
      onModUiEvents((sessionId, event) => {
        if (sessionId === 'dev-n1' && event.kind === 'state') events.push(event.state.devModsOn !== undefined)
      }),
    )
    showDevModsNotice('dev-n1', ['band-mod', 'panel-mod'])
    expect(modSlotUiState('dev-n1').devModsOn?.plugins).toEqual(['band-mod', 'panel-mod'])
    expect(modSlotUiState('dev-n2').devModsOn).toBeUndefined()
    showDevModsNotice('dev-n1', ['extra-mod'])
    const notice = modSlotUiState('dev-n1').devModsOn!
    expect(notice.plugins).toEqual(['band-mod', 'panel-mod', 'extra-mod'])
    expect(answerDevModsAsk('dev-n1', notice.requestId, 'on')).toBe(false)
    expect(answerDevModsAsk('dev-n2', notice.requestId, 'dismissed')).toBe(false)
    expect(answerDevModsAsk('dev-n1', notice.requestId, 'dismissed')).toBe(true)
    expect(modSlotUiState('dev-n1').devModsOn).toBeUndefined()
    expect(events).toEqual([true, true, false])
  })

  it('an aborted session drops the notice', () => {
    const controller = new AbortController()
    showDevModsNotice('dev-n3', ['x'], controller.signal)
    controller.abort()
    expect(modSlotUiState('dev-n3').devModsOn).toBeUndefined()
  })

  it('an aborted session settles it dismissed', async () => {
    const controller = new AbortController()
    const asking = openDevModsAsk('dev-s3', ['x'], controller.signal)
    controller.abort()
    await expect(asking).resolves.toBe('dismissed')
    expect(modSlotUiState('dev-s3').devModsAsk).toBeUndefined()
  })
})

describe('the dev mods folder hands its loaded plugins on', () => {
  it('after each load, not when nothing changed; a failure is a report line', async () => {
    const seen: string[][] = []
    let fail = false
    const w = folderWorld({
      mode: 'bypassPermissions',
      loaded: async plugins => {
        if (fail) throw new Error('disk full')
        seen.push(plugins.map(p => p.path))
      },
    })
    w.manifests.set('panel', 1)
    await w.folder.afterTurn()
    expect(seen).toEqual([['/home/.velloc/dev-mods/s1/panel']])
    await w.folder.afterTurn()
    expect(seen).toHaveLength(1)
    w.manifests.set('panel', 2)
    fail = true
    await w.folder.afterTurn()
    expect(w.reports).toContain('dev mods: disk full')
    expect(w.folder.plugins().map(p => p.name)).toEqual(['panel-mod'])
  })
})
