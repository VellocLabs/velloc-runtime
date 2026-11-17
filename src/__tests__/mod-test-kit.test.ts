/**
 * The plugin test kit (F-25): a plugin's `*.test.ts` files, compiled with
 * the kit and run in a mod worker host on a MessageChannel, report each case
 * with its source line. The kit's `$` is a mock: store, state, clock timers,
 * notify, stubs; `mount('desktop', …)` draws and presses.
 */
import { afterEach, describe, expect, it } from 'vitest'
import { MOD_API_SPECIFIER, MOD_TEST_KIT_SPECIFIER } from '../mods/modCompiler'
import type { ModWorkerHandle } from '../mods/ModRuntime'
import { installModWorkerHost } from '../mods/ModWorkerHost'
import { findModTestFiles, formatModTestReport, runModTests, type ModTestFs } from '../mods/testKit/modTestRunner'

const open: MessagePort[] = []
afterEach(() => {
  for (const port of open.splice(0)) port.close()
})

const ROOT = '/dev-mods/s1/counter'
const KIT = MOD_TEST_KIT_SPECIFIER

/** An in-memory folder: paths under ROOT. */
function fsOf(files: Record<string, string>): ModTestFs {
  const entry = (name: string, dir: boolean) => ({ name, isDirectory: () => dir, isFile: () => !dir })
  return {
    readFile: async path => {
      const text = files[path]
      if (text === undefined) throw new Error(`ENOENT ${path}`)
      return text
    },
    readdir: async dir => {
      const prefix = `${dir}/`
      const names = new Map<string, boolean>()
      for (const path of Object.keys(files)) {
        if (!path.startsWith(prefix)) continue
        const [head, ...rest] = path.slice(prefix.length).split('/')
        names.set(head!, rest.length > 0 || names.get(head!) === true)
      }
      if (names.size === 0) throw new Error(`ENOENT ${dir}`)
      return [...names].map(([name, dir]) => entry(name, dir))
    },
  }
}

const openWorker = async (): Promise<ModWorkerHandle> => {
  const channel = new MessageChannel()
  open.push(channel.port1, channel.port2)
  installModWorkerHost(channel.port2)
  let settle!: (closed: { reason: 'closed' | 'crashed' }) => void
  const closed = new Promise<{ reason: 'closed' | 'crashed' }>(resolve => {
    settle = resolve
  })
  return { port: channel.port1, closed, close: () => settle({ reason: 'closed' }) }
}

const REGISTER = [
  `import { atom, read, update } from '${MOD_API_SPECIFIER}'`,
  "const count = atom({ plugin: 'counter', key: 'n' }, 0)",
  'export function register(on: any) {',
  "  on('prompt.submit', async ($: any, e: any, next: any) => {",
  "    const tag = (await $.store.get('tag')) ?? 'x'",
  "    return next({ ...e, text: e.text + ' [' + tag + ']' })",
  '  })',
  "  on('ui.render', { component: 'Pane' }, async ($: any, e: any) => {",
  '    const { Box, Text, Button } = $.ui.resolve(e)',
  '    const n = await read($, count)',
  '    return Box({ children: [',
  "      Text({ children: ['count ' + n] }),",
  "      Button({ label: 'Add', onPress: () => update($, count, (v: number) => v + 1) }),",
  '    ] })',
  '  })',
  "  on('session.start', ($: any) => {",
  "    $.clock.after(1000, () => { void $.ui.toast('later') })",
  '  })',
  '}',
].join('\n')

const TESTS = [
  `import { test, describe, expect, loadPlugin } from '${KIT}'`,
  "import { register } from './register'",
  '',
  "describe('counter', () => {",
  "  test('tags a prompt from the store', async () => {",
  "    const p = loadPlugin(register, { store: { tag: 'dev' } })",
  "    const out = await p.fire('prompt.submit', { text: 'hi' })",
  "    expect(out).toEqual({ text: 'hi [dev]' })",
  "    expect(p.calls('store.get')).toHaveLength(1)",
  '  })',
  "  test('the test hook sits below the plugin', async () => {",
  '    const p = loadPlugin(register)',
  "    p.on('prompt.submit', ($: any, e: any) => ({ seen: e.text }))",
  "    expect(await p.fire('prompt.submit', { text: 'a' })).toEqual({ seen: 'a [x]' })",
  '  })',
  "  test('a pane draws and a press redraws', async () => {",
  '    const p = loadPlugin(register)',
  "    const view = await p.mount('desktop', 'Pane')",
  "    expect(view.text()).toContain('count 0')",
  "    await view.press('Add')",
  "    expect(view.text()).toContain('count 1')",
  '  })',
  "  test('a timer waits for the clock', async () => {",
  '    const p = loadPlugin(register)',
  "    await p.fire('session.start', {})",
  "    await p.clock.advance(999)",
  "    expect(p.calls('ui.toast')).toHaveLength(0)",
  '    await p.clock.advance(1)',
  "    expect(p.calls('ui.toast')).toEqual([{ noun: 'ui', method: 'toast', args: ['later'] }])",
  '  })',
  "  test('another surface is refused', async () => {",
  '    const p = loadPlugin(register)',
  "    await expect(() => p.mount('terminal', 'Pane')).toThrow('desktop surface only')",
  '  })',
  "  test('this one fails', async () => {",
  "    const p = loadPlugin(register)",
  "    const out = await p.fire('prompt.submit', { text: 'hi' })",
  "    expect(out.text).toBe('nope')",
  '  })',
  '})',
].join('\n')

describe('runModTests', () => {
  it('runs each case in a worker and names a failure at its source line', async () => {
    const fs = fsOf({
      [`${ROOT}/hooks/register.ts`]: REGISTER,
      [`${ROOT}/hooks/register.test.ts`]: TESTS,
    })
    const report = await runModTests({ folder: ROOT, fs, openWorker })
    expect(report.files).toHaveLength(1)
    const file = report.files[0]!
    expect(file.error).toBeUndefined()
    expect(file.tests.map(t => [t.name, t.ok])).toEqual([
      ['counter > tags a prompt from the store', true],
      ['counter > the test hook sits below the plugin', true],
      ['counter > a pane draws and a press redraws', true],
      ['counter > a timer waits for the clock', true],
      ['counter > another surface is refused', true],
      ['counter > this one fails', false],
    ])
    const failed = file.tests[5]!
    expect(failed.message).toContain('"hi [x]" to be "nope"')
    expect(failed.at).toEqual({ file: `${ROOT}/hooks/register.test.ts`, line: 38 })
    expect(report).toMatchObject({ passed: 5, failed: 1 })
    expect(formatModTestReport(report)).toContain(`✗ counter > this one fails: expected: "hi [x]" to be "nope" (${ROOT}/hooks/register.test.ts:38)`)
  })

  it('a test file that reaches the network does not compile; nothing runs', async () => {
    const fs = fsOf({
      [`${ROOT}/hooks/register.ts`]: 'export function register() {}',
      [`${ROOT}/hooks/net.test.ts`]: `import { test } from '${KIT}'\ntest('x', async () => { await fetch('https://example.invalid') })`,
    })
    const report = await runModTests({ folder: ROOT, fs, openWorker })
    expect(report.files[0]!.error).toMatch(/net\.test\.ts:2: fetch is not available/)
    expect(report).toMatchObject({ passed: 0, failed: 1 })
  })

  it('a test file without the kit is refused', async () => {
    const fs = fsOf({ [`${ROOT}/hooks/plain.test.ts`]: 'export const x = 1' })
    const report = await runModTests({ folder: ROOT, fs, openWorker })
    expect(report.files[0]!.error).toContain(`a test file imports "${KIT}"`)
  })

  it('finds test files below the folder, skipping dot folders and node_modules', async () => {
    const fs = fsOf({
      [`${ROOT}/hooks/a.test.ts`]: '',
      [`${ROOT}/hooks/register.ts`]: '',
      [`${ROOT}/test/b.test.mjs`]: '',
      [`${ROOT}/.hidden/c.test.ts`]: '',
      [`${ROOT}/node_modules/d/e.test.js`]: '',
    })
    expect(await findModTestFiles(ROOT, fs)).toEqual([`${ROOT}/hooks/a.test.ts`, `${ROOT}/test/b.test.mjs`])
    const empty = fsOf({ [`${ROOT}/hooks/register.ts`]: '' })
    expect(formatModTestReport(await runModTests({ folder: `${ROOT}/hooks`, fs: empty, openWorker }))).toContain('No test files')
  })

  it('reports a folder it cannot list instead of an empty run', async () => {
    await expect(runModTests({ folder: '/missing', fs: fsOf({ [`${ROOT}/a.test.ts`]: '' }), openWorker })).rejects.toThrow('ENOENT /missing')
    const fs = fsOf({ [`${ROOT}/hooks/a.test.ts`]: '' })
    const refusing: ModTestFs = {
      ...fs,
      readdir: async dir => {
        if (dir === `${ROOT}/hooks`) throw new Error('a permission rule denies reading it')
        return fs.readdir(dir)
      },
    }
    const report = await runModTests({ folder: ROOT, fs: refusing, openWorker })
    expect(report.files).toEqual([{ file: `${ROOT}/hooks`, error: 'a permission rule denies reading it', errorKind: 'unreadable', tests: [] }])
    expect(report.failed).toBe(1)
  })
})

const KIT_CASES = [
  `import { test, expect, loadPlugin } from '${KIT}'`,
  'const register = (on: any) => {',
  "  on('session.start', ($: any) => { $.clock.every(1000, () => { void $.ui.toast('tick') }) })",
  "  on('ui.render', { component: 'A' }, ($: any, e: any) => { const { Button } = $.ui.resolve(e); return Button({ label: 'A', onPress: () => { void $.ui.toast('a') } }) })",
  "  on('ui.render', { component: 'B' }, ($: any, e: any) => { const { Button } = $.ui.resolve(e); return Button({ label: 'B', onPress: () => {} }) })",
  '}',
  "test('an un-awaited toThrow fails its case', () => { expect(() => 1).toThrow() })",
  "test('an un-awaited async toThrow fails its case', () => { void expect(async () => 1).toThrow() })",
  "test('a sync toThrow passes', () => { expect(() => { throw new Error('bad input') }).toThrow('bad') })",
  'test(\'every repeats until cancelled\', async () => {',
  '  const p = loadPlugin(register)',
  "  await p.fire('session.start', {})",
  '  await p.clock.advance(3000)',
  "  expect(p.calls('ui.toast')).toHaveLength(3)",
  '})',
  "test('maps compare by entries', () => { expect(loadPlugin(register, { store: { tag: 'dev' } }).store).toEqual(new Map([['tag', 'x']])) })",
  'test(\'two mounted views keep their own presses\', async () => {',
  '  const p = loadPlugin(register)',
  "  const a = await p.mount('desktop', 'A')",
  "  await p.mount('desktop', 'B')",
  "  await a.press('A')",
  "  expect(p.calls('ui.toast')).toHaveLength(1)",
  '})',
  "test('a hung case fails alone', () => new Promise(() => {}))",
  "test('the case after it still runs', () => { expect(1).toBe(1) })",
].join('\n')

describe('kit matchers and mocks', () => {
  it('fails un-awaited throws, repeats every, compares maps, keeps each view\'s handlers, limits a case', async () => {
    const fs = fsOf({ [`${ROOT}/kit.test.ts`]: KIT_CASES })
    const report = await runModTests({ folder: ROOT, fs, openWorker, caseTimeoutMs: 200 })
    const file = report.files[0]!
    expect(file.error).toBeUndefined()
    expect(file.tests.map(t => [t.name, t.ok])).toEqual([
      ['an un-awaited toThrow fails its case', false],
      ['an un-awaited async toThrow fails its case', false],
      ['a sync toThrow passes', true],
      ['every repeats until cancelled', true],
      ['maps compare by entries', false],
      ['two mounted views keep their own presses', true],
      ['a hung case fails alone', false],
      ['the case after it still runs', true],
    ])
    expect(file.tests[0]!.message).toContain('nothing was thrown')
    expect(file.tests[6]!.message).toBe('the test ran past 200 ms')
  })
})

describe('runModTests bounds', () => {
  const ONE = {
    [`${ROOT}/a.test.ts`]: `import { test } from '${KIT}'\ntest('a', () => {})`,
    [`${ROOT}/b.test.ts`]: `import { test } from '${KIT}'\ntest('b', () => {})`,
  }

  it('closes each file\'s worker, and a stop ends the run between files', async () => {
    let closed = 0
    const counting = async (): Promise<ModWorkerHandle> => {
      const worker = await openWorker()
      return { ...worker, close: () => (closed++, worker.close()) }
    }
    const report = await runModTests({ folder: ROOT, fs: fsOf(ONE), openWorker: counting })
    expect(report).toMatchObject({ passed: 2, failed: 0 })
    expect(closed).toBe(2)

    const stop = new AbortController()
    let opened = 0
    const stopping = async (): Promise<ModWorkerHandle> => {
      opened++
      stop.abort()
      return counting()
    }
    await expect(runModTests({ folder: ROOT, fs: fsOf(ONE), openWorker: stopping, signal: stop.signal })).rejects.toThrow()
    expect(opened).toBe(1)
    expect(closed).toBe(3)
  })

  it('a file past its budget is a timeout error and its worker is closed', async () => {
    let closed = 0
    const counting = async (): Promise<ModWorkerHandle> => {
      const worker = await openWorker()
      return { ...worker, close: () => (closed++, worker.close()) }
    }
    const fs = fsOf({ [`${ROOT}/slow.test.ts`]: `import { test } from '${KIT}'\ntest('slow', () => new Promise(() => {}))` })
    const report = await runModTests({ folder: ROOT, fs, openWorker: counting, timeoutMs: 300, caseTimeoutMs: 5_000, fileMarginMs: -5_000 })
    expect(report.files[0]).toMatchObject({ errorKind: 'timeout', error: '300' })
    expect(closed).toBe(1)
  })
})
