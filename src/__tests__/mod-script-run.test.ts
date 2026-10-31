/**
 * `$.script.run` (F-25) through a real `ModRuntime` whose workers are
 * `ModWorkerHost` on MessageChannels, the kernel's `runProgram`, and the run_js
 * worker core run in-process behind a stub window.
 */
import { afterEach, describe, expect, it } from 'vitest'
import type * as TS from 'typescript'
import { ModRuntime, type ModModuleRef, type ModWorkerHandle } from '../mods/ModRuntime'
import { installModWorkerHost } from '../mods/ModWorkerHost'
import { loadTypeScript } from '../mods/modCompiler'
import { scanModuleUses } from '../mods/modScan'
import { runProgramInWorker } from '../browser/runJs/runJsWorkerCore'
import { resetRunJsBrokerForTests, setRunJsControlPort } from '../browser/runJs/RunJsBroker'
import type { RunJsScriptInit } from '../browser/runJs/runJsProtocol'

const open: MessagePort[] = []
const runtimes: ModRuntime[] = []
afterEach(() => {
  for (const runtime of runtimes.splice(0)) runtime.dispose()
  for (const port of open.splice(0)) port.close()
  resetRunJsBrokerForTests()
})

let tsModule: typeof TS | undefined
let uniq = 0

/** The window side of the kernel, in this realm: each spawned run_js worker is
 *  the worker core on the transferred port. */
function attachInProcessWindow(): void {
  setRunJsControlPort({
    onmessage: null,
    start() {},
    postMessage(message: { type: string; init?: RunJsScriptInit }, transfer: unknown[] = []) {
      if (message.type === 'worker.spawn') runProgramInWorker(message.init!, transfer[0] as MessagePort)
    },
  } as unknown as MessagePort)
}

function world(sources: Record<string, string>, options: { serveTimeoutMs?: number } = {}) {
  attachInProcessWindow()
  const reports: string[] = []
  const modules: ModModuleRef[] = Object.keys(sources).map(path => ({
    plugin: path.split('/')[0]!,
    path,
    root: `/plugins/${path.split('/')[0]!}`,
    version: '1.0.0',
  }))
  const runtime = new ModRuntime({
    modules,
    readModule: async path => {
      const source = sources[path]
      if (source === undefined) throw new Error('ENOENT')
      return source
    },
    compile: async (_ref, source) => ({ source: `${source}\n// load ${++uniq}`, files: [] }),
    scan: async (ref, source) => {
      tsModule ??= await loadTypeScript()
      return scanModuleUses(tsModule, [{ path: ref.path, text: source }])
    },
    openWorker: async () => {
      const channel = new MessageChannel()
      open.push(channel.port1, channel.port2)
      installModWorkerHost(channel.port2)
      return {
        port: channel.port1,
        closed: new Promise(() => {}),
        close: () => {},
      } satisfies ModWorkerHandle
    },
    session: { id: () => 'session-1', cwd: () => '/work/project' },
    report: line => reports.push(line),
    respawnBackoffMs: [60_000],
    ...(options.serveTimeoutMs !== undefined ? { serveTimeoutMs: options.serveTimeoutMs } : {}),
  })
  runtimes.push(runtime)
  return { runtime, reports }
}

/** A module whose `prompt.submit` hook runs `e.text` as a script with the
 *  nouns `NOUNS` builds, and submits the result as JSON. */
const runner = (nouns: string, extra = ''): string => `
  export function register(on) {
    on('prompt.submit', async ($, e, next) => {
      try {
        const result = await $.script.run({ code: e.text, nouns: ${nouns}${extra} })
        return next({ ...e, text: JSON.stringify(result.ok ? { value: result.value } : { error: result.error }) })
      } catch (error) {
        return next({ ...e, text: JSON.stringify({ rejected: error.name, message: error.message }) })
      }
    })
  }
`

async function submit(runtime: ModRuntime, code: string): Promise<Record<string, unknown>> {
  await runtime.ready
  const out = (await runtime.promptSubmit(code)) as { text: string }
  return JSON.parse(out.text) as Record<string, unknown>
}

describe('$.script.run', () => {
  it('a module that calls it is admitted, and the script reaches the nouns the module serves', async () => {
    const { runtime } = world({
      'runner/hooks/register.js': runner('{ calc: { add: (a, b) => a + b } }'),
    })
    expect(await submit(runtime, 'return [await calc.add(2, 3), typeof workspace, typeof $]')).toEqual({
      value: [5, 'undefined', 'undefined'],
    })
    expect(runtime.status()[0]).toMatchObject({ state: 'loaded' })
  })

  it("a noun method's $ calls are the plugin's own", async () => {
    const { runtime } = world({
      'runner/hooks/register.js': runner('{ host: { session: () => $.session.id() } }'),
    })
    expect(await submit(runtime, 'return await host.session()')).toEqual({ value: 'session-1' })
  })

  it('a script that throws resolves { ok: false } with its own line', async () => {
    const { runtime } = world({ 'runner/hooks/register.js': runner('{ calc: { add: (a, b) => a + b } }') })
    expect(await submit(runtime, 'const a = 1\nnull.x')).toMatchObject({ error: { name: 'TypeError', line: 2 } })
  })

  it('a refused noun method reaches the script as an error it can catch', async () => {
    const { runtime } = world({
      'runner/hooks/register.js': runner('{ calc: { add: () => { const e = new Error("no"); e.name = "RangeError"; throw e } } }'),
    })
    expect(await submit(runtime, 'try { await calc.add() } catch (e) { return e.name }')).toEqual({ value: 'RangeError' })
  })

  it('is an op event: a plugin above sees the code and the noun names, never the run token, and may deny it', async () => {
    const { runtime } = world({
      'guard/hooks/register.js': `
        export function register(on) {
          on('script.run', async ($, e, next) => {
            if (e.code.includes('forbidden')) return { deny: 'not this script: ' + Object.keys(e.nouns).join() + ' ' + ('token' in e) }
            return next(e)
          })
        }
      `,
      'runner/hooks/register.js': runner('{ calc: { add: (a, b) => a + b } }'),
    })
    expect(await submit(runtime, 'return "forbidden"')).toEqual({
      rejected: 'DeniedError',
      message: 'not this script: calc false',
    })
    expect(await submit(runtime, 'return "fine"')).toEqual({ value: 'fine' })
  })

  it('a noun method that waits on $.clock spends its own serve time', async () => {
    const { runtime } = world(
      { 'runner/hooks/register.js': runner('{ slow: { nap: () => $.clock.sleep(200) } }') },
      { serveTimeoutMs: 40 },
    )
    expect(await submit(runtime, 'try { await slow.nap() } catch (e) { return e.name }')).toEqual({
      value: 'TimeoutError',
    })
  })

  it('a noun method that waits on another $ call spends none of it', async () => {
    // Three 30 ms waits: each within its provider's own 50 ms bound, together
    // past the method's.
    const { runtime } = world(
      {
        'slow/hooks/register.js': `
          export function register(on) {
            on('engine.create', async ($, e, next) => ({
              ...(await next(e)),
              slow: { wait: () => new Promise(resolve => setTimeout(resolve, 30)) },
            }))
          }
        `,
        'runner/hooks/register.js': runner(
          '{ work: { step: async () => { for (let n = 0; n < 3; n++) await $.slow.wait(); return "done" } } }',
        ),
      },
      { serveTimeoutMs: 50 },
    )
    expect(await submit(runtime, 'return await work.step()')).toEqual({ value: 'done' })
  })

  it("the call's signal stops the script and rejects AbortError", async () => {
    const { runtime } = world({
      'runner/hooks/register.js': `
        export function register(on) {
          on('prompt.submit', async ($, e, next) => {
            const controller = new AbortController()
            const run = $.script.run({ code: 'await never.wait(); return 1', nouns: { never: { wait: () => new Promise(() => {}) } }, signal: controller.signal })
            setTimeout(() => controller.abort(), 20)
            try { await run; return next({ ...e, text: 'finished' }) }
            catch (error) { return next({ ...e, text: error.name }) }
          })
        }
      `,
    })
    await runtime.ready
    await expect(runtime.promptSubmit('go')).resolves.toMatchObject({ text: 'AbortError' })
  })

  it('refuses a call whose nouns hold no method, before anything runs', async () => {
    const { runtime } = world({ 'runner/hooks/register.js': runner('{ calc: { add: 1 } }') })
    expect(await submit(runtime, 'return 1')).toMatchObject({ rejected: 'TypeError' })
  })
})
