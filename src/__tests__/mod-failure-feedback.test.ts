/**
 * Mod failures as data (F-25): a hook that throws, a module that does not
 * load, each reported with its plugin, event and the SOURCE line — through a
 * real `ModRuntime`, the real compiler and a real worker host on a
 * MessageChannel. Plus the ledger that bounds what is handed on.
 */
import { afterEach, describe, expect, it } from 'vitest'
import { MOD_API_SPECIFIER as API, builtModuleOf, compileModModule } from '../mods/modCompiler'
import { ModRuntime, type ModModuleRef, type ModWorkerHandle } from '../mods/ModRuntime'
import { installModWorkerHost } from '../mods/ModWorkerHost'
import { moduleFramesOf, sourceLinesOfMappings, sourceLocationOf } from '../mods/modLineMap'
import {
  MOD_FAULT_BATCH_MAX,
  MOD_FAULT_REASON_MAX,
  boundReason,
  createModFaultLedger,
  isDevModFault,
  type ModFault,
} from '../mods/modFault'

const open: MessagePort[] = []
const runtimes: ModRuntime[] = []
afterEach(() => {
  for (const runtime of runtimes.splice(0)) runtime.dispose()
  for (const port of open.splice(0)) port.close()
})

const sleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms))

const ROOT = '/dev-mods/s1/thrower'

/** A runtime over `files`, compiled for real; faults and lines collected. */
function world(files: Record<string, string>, entry = `${ROOT}/hooks/register.ts`) {
  const faults: ModFault[] = []
  const reports: string[] = []
  const ref: ModModuleRef = { plugin: 'thrower', path: entry, root: ROOT, provenance: 'thrower@dev' }
  const runtime = new ModRuntime({
    modules: [ref],
    readModule: async path => {
      const text = files[path]
      if (text === undefined) throw new Error('ENOENT')
      return text
    },
    compile: (module, source) =>
      compileModModule({
        entry: module.path,
        entrySource: source,
        root: ROOT,
        fs: {
          readFile: async path => {
            const text = files[path]
            if (text === undefined) throw new Error(`ENOENT ${path}`)
            return text
          },
        },
      }).then(builtModuleOf),
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
    session: { id: () => 's1', cwd: () => '/work' },
    report: line => reports.push(line),
    onFault: fault => faults.push(fault),
  })
  runtimes.push(runtime)
  return { runtime, faults, reports }
}

describe('the line map', () => {
  it('reads the source line of each generated line, the first segment naming a source winning', () => {
    // AAAA: line 0 → src 0; AACA: +1 → src 1; (empty); AAEA: +2 → src 3.
    expect(sourceLinesOfMappings('AAAA;AACA;;AAEA')).toEqual([1, 2, 0, 4])
    expect(sourceLinesOfMappings('AAAA;!!')).toEqual([1])
  })

  it('maps an output line through the file it belongs to; a linker line is unknown', () => {
    const map = { files: [{ path: '/p/a.ts', start: 10, lines: [1, 0, 5] }] }
    expect(sourceLocationOf(map, 10)).toEqual({ file: '/p/a.ts', line: 1 })
    expect(sourceLocationOf(map, 11)).toBeUndefined()
    expect(sourceLocationOf(map, 12)).toEqual({ file: '/p/a.ts', line: 5 })
    expect(sourceLocationOf(map, 3)).toBeUndefined()
  })

  it('takes the frames of a stack inside the data: module, innermost first', () => {
    const stack = [
      'Error: boom',
      '    at hook (data:text/javascript;base64,QUJD+/=:41:13)',
      '    at node:internal/x:1:1',
      '    at run (data:text/javascript;base64,QUJD:7:2)',
    ].join('\n')
    expect(moduleFramesOf(stack)).toEqual([
      { line: 41, column: 13 },
      { line: 7, column: 2 },
    ])
    expect(moduleFramesOf(undefined)).toEqual([])
  })
})

describe('a failing mod, as data', () => {
  it('a hook that throws names its plugin, event and the TypeScript source line', async () => {
    const { runtime, faults } = world({
      [`${ROOT}/hooks/register.ts`]: [
        'interface Shape {',
        '  a: string',
        '  b: number',
        '}',
        "import { explode } from './explode'",
        'export function register(on: any) {',
        "  on('prompt.submit', ($: any, e: any, next: any) => {",
        '    explode()',
        '    return next(e)',
        '  })',
        '}',
      ].join('\n'),
      [`${ROOT}/hooks/explode.ts`]: [
        'type Unused = { x: 1 }',
        '',
        'export function explode(): never {',
        "  throw new Error('kaboom in explode')",
        '}',
      ].join('\n'),
    })
    await runtime.ready
    await sleep(20)
    expect(runtime.status()[0]).toMatchObject({ state: 'loaded' })
    await runtime.promptSubmit('hi')
    expect(faults).toEqual([
      expect.objectContaining({
        plugin: 'thrower',
        provenance: 'thrower@dev',
        generation: 1,
        kind: 'hook',
        event: 'prompt.submit',
        reason: 'kaboom in explode',
        file: `${ROOT}/hooks/explode.ts`,
        line: 4,
      }),
    ])
  })

  it('a plain module that throws names its own line', async () => {
    const entry = `${ROOT}/hooks/register.js`
    const { runtime, faults } = world(
      {
        [entry]: [
          'export function register(on) {',
          "  on('prompt.submit', ($, e, next) => {",
          '',
          "    throw new Error('plain boom')",
          '  })',
          '}',
        ].join('\n'),
      },
      entry,
    )
    await runtime.ready
    await sleep(20)
    await runtime.promptSubmit('hi')
    expect(faults).toEqual([expect.objectContaining({ kind: 'hook', file: entry, line: 4, reason: 'plain boom' })])
  })

  it('a register that throws is a load fault at its source line', async () => {
    const { runtime, faults } = world({
      [`${ROOT}/hooks/register.ts`]: [
        'const n: number = 1',
        'export function register(on: any): void {',
        "  throw new Error('no register for you')",
        '}',
      ].join('\n'),
    })
    await runtime.ready
    expect(faults).toEqual([
      expect.objectContaining({ kind: 'load', file: `${ROOT}/hooks/register.ts`, line: 3 }),
    ])
    expect(faults[0]!.reason).toContain('no register for you')
  })

  it('a module the verifier refuses is a load fault at the source line', async () => {
    const { runtime, faults } = world({
      [`${ROOT}/hooks/register.ts`]: [
        'type T = string',
        'export function register(on: any) {',
        "  on('prompt.submit', async () => {",
        "    await fetch('https://example.invalid')",
        '  })',
        '}',
      ].join('\n'),
    })
    await runtime.ready
    expect(faults).toEqual([expect.objectContaining({ kind: 'load', file: `${ROOT}/hooks/register.ts`, line: 4 })])
  })
})

describe('the compiler names source lines', () => {
  it('a refusal in an imported file after the API shim names that file and its own line', async () => {
    const entry = `${ROOT}/hooks/register.ts`
    const helper = `${ROOT}/hooks/helper.ts`
    const graph: Record<string, string> = {
      [entry]: [`import * as api from '${API}'`, "import { go } from './helper'", 'export function register(on: any) { void api; go() }'].join('\n'),
      [helper]: ['type A = 1', 'type B = 2', '', 'export function go() {', '  return eval("1")', '}'].join('\n'),
    }
    await expect(
      compileModModule({ entry, root: ROOT, fs: { readFile: async path => graph[path] ?? Promise.reject(new Error('ENOENT')) } }),
    ).rejects.toThrow(`${helper}:5: eval is not available`)
  })
})

describe('the fault ledger', () => {
  const fault = (over: Partial<ModFault> = {}): ModFault => ({
    plugin: 'p',
    provenance: 'p@dev',
    generation: 1,
    kind: 'hook',
    event: 'prompt.submit',
    reason: 'x',
    ...over,
  })

  it('keeps one fault per plugin, load, kind and event', () => {
    const ledger = createModFaultLedger()
    expect(ledger.note(fault())).toBe(true)
    expect(ledger.note(fault({ reason: 'again' }))).toBe(false)
    expect(ledger.note(fault({ event: 'turn.end' }))).toBe(true)
    expect(ledger.note(fault({ generation: 2 }))).toBe(true)
    expect(ledger.take()?.faults).toHaveLength(3)
    expect(ledger.take()).toBeUndefined()
    // Taken is still seen: the same failure is not handed on twice.
    expect(ledger.note(fault())).toBe(false)
  })

  it('caps a batch and counts what it left out', () => {
    const ledger = createModFaultLedger()
    for (let i = 0; i < MOD_FAULT_BATCH_MAX + 3; i += 1) ledger.note(fault({ plugin: `p${i}` }))
    expect(ledger.take()).toMatchObject({ omitted: 3, faults: { length: MOD_FAULT_BATCH_MAX } })
  })

  it('bounds a reason to one line of at most the limit', () => {
    expect(boundReason('a\nb\u0000c')).toBe('a b c')
    const long = boundReason('x'.repeat(MOD_FAULT_REASON_MAX * 2))
    expect(long).toHaveLength(MOD_FAULT_REASON_MAX)
    expect(long.endsWith('…')).toBe(true)
  })

  it('tells a dev-folder fault by its provenance', () => {
    expect(isDevModFault({ provenance: 'p@dev' })).toBe(true)
    expect(isDevModFault({ provenance: 'p@market' })).toBe(false)
    expect(isDevModFault({})).toBe(false)
  })
})
