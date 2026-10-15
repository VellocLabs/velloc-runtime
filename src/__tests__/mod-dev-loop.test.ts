/**
 * The dev loop (F-25): "poll the dev folder's mtimes at turn
 * end through the fs bridge; no watcher API is needed". `ModRuntime.afterTurn`
 * stats each loaded module's files — the compile graph, or the entry — and a
 * time that moved is a `reload`, which reloads what really changed. A real
 * `ModRuntime` and real module text on a MessageChannel.
 */
import { afterEach, describe, expect, it } from 'vitest'
import { ModRuntime, type ModModuleRef, type ModWorkerHandle } from '../mods/ModRuntime'
import { installModWorkerHost } from '../mods/ModWorkerHost'

const open: MessagePort[] = []
const runtimes: ModRuntime[] = []
afterEach(() => {
  for (const runtime of runtimes.splice(0)) runtime.dispose()
  for (const port of open.splice(0)) port.close()
})

const sleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms))

/** A slot over mutable files with mtimes; `compile` reports the graph. */
function world(options: { withStat?: boolean; failStat?: Set<string>; brokenHelper?: boolean; second?: boolean } = {}) {
  const files = new Map<string, { text: string; mtime: number }>()
  const entry = '/plugins/dev/hooks/register.ts'
  const helper = '/plugins/dev/hooks/helper.js'
  const tag = (word: string) => `
    export function register(on) {
      on('prompt.submit', ($, e, next) => next({ ...e, text: e.text + ' [${word}]' }))
    }
  `
  files.set(entry, { text: tag('one'), mtime: 1_000 })
  files.set(helper, { text: options.brokenHelper ? '// BROKEN' : '// helper v1', mtime: 1_000 })
  const reports: string[] = []
  const stats: string[] = []
  const ref: ModModuleRef = { plugin: 'dev', path: entry, root: '/plugins/dev' }
  // A second plugin, its own one-file graph, when asked for.
  const other = '/plugins/other/hooks/register.ts'
  if (options.second) files.set(other, { text: 'export function register(on) {}', mtime: 1_000 })
  const compiles: string[] = []
  const runtime = new ModRuntime({
    modules: options.second ? [ref, { plugin: 'other', path: other, root: '/plugins/other' }] : [ref],
    readModule: async path => {
      const file = files.get(path)
      if (!file) throw new Error('ENOENT')
      return file.text
    },
    // "Compiles" by appending the helper's text, and names the graph; a
    // helper that says BROKEN does not compile.
    compile: async (compiled, source) => {
      compiles.push(compiled.path)
      if (compiled.path === other) return { source, files: [other] }
      if (files.get(helper)?.text.includes('BROKEN')) throw new Error('helper.js: syntax error')
      return { source: `${source}\n${files.get(helper)?.text ?? ''}`, files: [entry, helper] }
    },
    ...(options.withStat === false
      ? {}
      : {
          statModule: async path => {
            stats.push(path)
            if (options.failStat?.has(path)) throw new Error('EACCES')
            return files.get(path)?.mtime
          },
        }),
    openWorker: async (): Promise<ModWorkerHandle> => {
      const channel = new MessageChannel()
      open.push(channel.port1, channel.port2)
      installModWorkerHost(channel.port2)
      let settle!: (closed: { reason: 'closed' | 'crashed' }) => void
      const closed = new Promise<{ reason: 'closed' | 'crashed' }>(resolve => {
        settle = resolve
      })
      return { port: channel.port1, closed, close: () => settle({ reason: 'closed' }) }
    },
    session: { id: () => 'sess-dev', cwd: () => '/work' },
    report: line => reports.push(line),
  })
  runtimes.push(runtime)
  const touch = (path: string, text?: string) => {
    const file = files.get(path)!
    files.set(path, { text: text ?? file.text, mtime: file.mtime + 1 })
  }
  return { runtime, reports, stats, files, touch, entry, helper, tag, other, compiles }
}

describe('ModRuntime.afterTurn — the dev loop', () => {
  it('polls every file of the graph; nothing moved, nothing reloads', async () => {
    const { runtime, stats, entry, helper } = world()
    await runtime.ready
    await sleep(20)
    stats.length = 0
    expect(await runtime.afterTurn()).toEqual({ polled: 2, reloaded: [] })
    expect(stats).toEqual([entry, helper])
    expect(runtime.status()[0]).toMatchObject({ state: 'loaded', generation: 1 })
  })

  it('a changed entry reloads the module once the turn ends; the next prompt runs the new text', async () => {
    const { runtime, touch, entry, tag } = world()
    await runtime.ready
    await sleep(20)
    expect(await runtime.promptSubmit('hi')).toMatchObject({ entered: true, text: 'hi [one]' })
    touch(entry, tag('two'))
    const outcome = await runtime.afterTurn()
    expect(outcome.reloaded).toEqual([entry])
    expect(runtime.status()[0]).toMatchObject({ state: 'loaded', generation: 2 })
    expect(await runtime.promptSubmit('hi')).toMatchObject({ entered: true, text: 'hi [two]' })
  })

  it('a changed imported file reloads too; a touch that changed nothing does not', async () => {
    const { runtime, touch, entry, helper } = world()
    await runtime.ready
    await sleep(20)
    touch(entry)
    expect((await runtime.afterTurn()).reloaded).toEqual([])
    expect(runtime.status()[0]).toMatchObject({ generation: 1 })
    touch(helper, '// helper v2')
    expect((await runtime.afterTurn()).reloaded).toEqual([entry])
    expect(runtime.status()[0]).toMatchObject({ generation: 2 })
    // The baseline moved with the reload: polling again is quiet.
    expect((await runtime.afterTurn()).reloaded).toEqual([])
  })

  it('a stat that fails is a time that cannot be read; it reloads only when it changes, and never throws', async () => {
    const { runtime, touch, entry } = world({ failStat: new Set(['/plugins/dev/hooks/helper.js']) })
    await runtime.ready
    await sleep(20)
    expect((await runtime.afterTurn()).reloaded).toEqual([])
    touch(entry)
    expect((await runtime.afterTurn()).reloaded).toEqual([])
  })

  it('an imported file that breaks the compile stays watched: fixing it reloads the module', async () => {
    const { runtime, touch, entry, helper } = world()
    await runtime.ready
    await sleep(20)
    touch(helper, '// BROKEN')
    expect((await runtime.afterTurn()).reloaded).toEqual([entry])
    expect(runtime.status()[0]).toMatchObject({ state: 'refused' })
    await sleep(20)
    // Still broken: polled, but no reload.
    expect((await runtime.afterTurn()).reloaded).toEqual([])
    touch(helper, '// helper v2')
    expect((await runtime.afterTurn()).reloaded).toEqual([entry])
    expect(runtime.status()[0]).toMatchObject({ state: 'loaded', generation: 3 })
  })

  it('a module that did not compile at the start is picked up once its import is fixed', async () => {
    const { runtime, touch, entry, helper } = world({ brokenHelper: true })
    await runtime.ready
    await sleep(20)
    expect(runtime.status()[0]).toMatchObject({ state: 'refused' })
    touch(helper, '// helper v1')
    expect((await runtime.afterTurn()).reloaded).toEqual([entry])
    expect(runtime.status()[0]).toMatchObject({ state: 'loaded' })
    expect(await runtime.promptSubmit('hi')).toMatchObject({ entered: true, text: 'hi [one]' })
  })

  it('only the module whose files moved is compiled again; the others are left alone', async () => {
    const { runtime, touch, entry, helper, other, compiles } = world({ second: true })
    await runtime.ready
    await sleep(20)
    compiles.length = 0
    touch(helper, '// helper v2')
    expect((await runtime.afterTurn()).reloaded).toEqual([entry])
    expect(compiles).not.toContain(other)
  })

  it('without a statModule the loop polls nothing', async () => {
    const { runtime, touch, entry, tag } = world({ withStat: false })
    await runtime.ready
    touch(entry, tag('two'))
    expect(await runtime.afterTurn()).toEqual({ polled: 0, reloaded: [] })
    expect(await runtime.promptSubmit('hi')).toMatchObject({ entered: true, text: 'hi [one]' })
  })
})
