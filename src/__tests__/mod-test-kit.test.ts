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
    expect(formatModTestReport(await runModTests({ folder: '/nothing', fs, openWorker }))).toContain('No test files')
  })
})
