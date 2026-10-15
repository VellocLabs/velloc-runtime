/**
 * `$.command.register` / `$.command.list` / `$.command.run` and the
 * `command.run` event (F-25): a mod declares `/<name>`, serves
 * it with a hook, and the roster follows the mod's life in the slot.
 *
 * Real module text, loaded by `ModWorkerHost` on a MessageChannel. A mod
 * reports through `$.ui.log`, which lands in `reports`.
 */
import { afterEach, describe, expect, it } from 'vitest'
import { RAISED_EVENTS } from '../mods/modAdmission'
import {
  ModCommandRegistry,
  commandRunArgsOf,
  commandRunEventOf,
  isBuiltinCommandName,
  isCommandRunResult,
  modCommandSpecOf,
} from '../mods/modCommands'
import { implementedNouns } from '../mods/modNouns'
import { ModRuntime, type ModModuleRef, type ModWorkerHandle } from '../mods/ModRuntime'
import { installModWorkerHost } from '../mods/ModWorkerHost'

const sleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms))

async function until(check: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!check()) {
    if (Date.now() > deadline) throw new Error('timed out waiting')
    await sleep(5)
  }
}

let uniqueLoad = 0
const open: MessagePort[] = []
const runtimes: ModRuntime[] = []
afterEach(() => {
  for (const runtime of runtimes.splice(0)) runtime.dispose()
  for (const port of open.splice(0)) port.close()
})

type Worker = ModWorkerHandle & { crash(): void }

function world(modules: Record<string, string>, options: { engineCommands?: boolean } = {}) {
  const reports: string[] = []
  const changes: number[] = []
  const toasts: Array<{ plugin: string; text: string }> = []
  const workers: Record<string, Worker[]> = {}
  const refs: ModModuleRef[] = Object.keys(modules).map(plugin => ({
    plugin,
    path: `/plugins/${plugin}/hooks/register.js`,
  }))
  const runtime = new ModRuntime({
    modules: refs,
    readModule: async path =>
      `export function register(on) {\n${modules[path.split('/')[2]!]}\n}\n// load ${++uniqueLoad}`,
    openWorker: async (plugin): Promise<ModWorkerHandle> => {
      const channel = new MessageChannel()
      open.push(channel.port1, channel.port2)
      installModWorkerHost(channel.port2)
      let settle!: (closed: { reason: 'closed' | 'crashed' }) => void
      const closed = new Promise<{ reason: 'closed' | 'crashed' }>(resolve => {
        settle = resolve
      })
      const worker: Worker = {
        port: channel.port1,
        closed,
        close: () => settle({ reason: 'closed' }),
        crash: () => settle({ reason: 'crashed' }),
      }
      ;(workers[plugin] ??= []).push(worker)
      return worker
    },
    session: { id: () => 'sess-cmd', cwd: () => '/work/project' },
    report: line => reports.push(line),
    respawnBackoffMs: [10],
    onCommandsChanged: () => changes.push(Date.now()),
    onUiChanged: event => {
      if (event.kind === 'toast') toasts.push({ plugin: event.toast.plugin, text: event.toast.text })
    },
    ...(options.engineCommands
      ? {
          engineCommands: () => [
            { name: 'help', description: 'Show the commands', source: 'builtin' as const },
            { name: 'review', description: 'Review the diff', source: 'user' as const },
          ],
        }
      : {}),
  })
  runtimes.push(runtime)
  return { runtime, reports, workers, changes, toasts }
}

const logging = (expr: string): string => `
  on('prompt.submit', async ($, e, next) => {
    try {
      await $.ui.log(JSON.stringify(await (${expr})))
    } catch (error) {
      await $.ui.log('ERR ' + error.name + ': ' + error.message)
    }
    return next(e)
  })
`

describe('the events are listed', () => {
  it('command.run, command.register and command.list are raised', () => {
    for (const noun of ['command.register', 'command.list', 'command.run']) {
      expect(implementedNouns(), noun).toContain(noun)
      expect(RAISED_EVENTS, noun).toContain(noun)
    }
  })
})

describe('modCommandSpecOf', () => {
  it('takes a spec, refuses a bad name, a bad description and a built-in\'s name', () => {
    expect(modCommandSpecOf({ name: 'hello', description: 'Says hi.' })).toEqual({ name: 'hello', description: 'Says hi.' })
    expect(modCommandSpecOf({ name: 'a_b-1', description: 'x', argumentHint: '[n]', immediate: true })).toEqual({
      name: 'a_b-1',
      description: 'x',
      argumentHint: '[n]',
      immediate: true,
    })
    expect(() => modCommandSpecOf({ name: '/hello', description: 'x' })).toThrow(TypeError)
    expect(() => modCommandSpecOf({ name: 'a'.repeat(65), description: 'x' })).toThrow(TypeError)
    expect(() => modCommandSpecOf({ name: 'hello' })).toThrow(TypeError)
    expect(() => modCommandSpecOf({ name: 'hello', description: 'x', immediate: false })).toThrow(TypeError)
    expect(() => modCommandSpecOf('hello')).toThrow(TypeError)
    expect(() => modCommandSpecOf({ name: 'help', description: 'x' })).toThrow(/built-in/)
    expect(() => modCommandSpecOf({ name: 'debug', description: 'x' })).toThrow(/built-in/)
    expect(isBuiltinCommandName('clear')).toBe(true)
    expect(isBuiltinCommandName('hello')).toBe(false)
  })
})

describe('ModCommandRegistry', () => {
  it('registers, replaces by name, lists in order, and loses a seat\'s commands', () => {
    let changed = 0
    const registry = new ModCommandRegistry(() => (changed += 1))
    registry.register({ name: 'b', description: 'B' }, 'p', 'p')
    registry.register({ name: 'a', description: 'A' }, 'q', 'q')
    registry.register({ name: 'b', description: 'B2' }, 'p', 'p')
    expect(registry.list().map(c => [c.name, c.description, c.plugin])).toEqual([['b', 'B2', 'p'], ['a', 'A', 'q']])
    registry.unregisterSeat('p')
    expect(registry.list().map(c => c.name)).toEqual(['a'])
    registry.unregisterSeat('nobody')
    expect(changed).toBe(4)
    registry.clear()
    expect(registry.list()).toEqual([])
  })
})

describe('the command.run shapes', () => {
  it('builds the event with origin and the pinned presentation; args rewrite only', () => {
    const e = commandRunEventOf('hello', 'there')
    expect(e).toEqual({ command: 'hello', args: 'there', origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 80 } })
    expect(commandRunArgsOf({ ...e, args: 'you', command: 'other' }, 'there')).toBe('you')
    expect(commandRunArgsOf({ ...e, args: 5 }, 'there')).toBe('there')
    expect(commandRunArgsOf('junk', 'there')).toBe('there')
  })

  it('accepts { text }, {}, context and an exit code; refuses the rest', () => {
    expect(isCommandRunResult({ text: 'hi' })).toBe(true)
    expect(isCommandRunResult({})).toBe(true)
    expect(isCommandRunResult({ text: 'hi', context: ['note'], exitCode: 3, ref: 1 })).toBe(true)
    expect(isCommandRunResult({ text: 5 })).toBe(false)
    expect(isCommandRunResult({ context: 'note' })).toBe(false)
    expect(isCommandRunResult({ exitCode: 300 })).toBe(false)
    expect(isCommandRunResult(undefined)).toBe(false)
    expect(isCommandRunResult('hi')).toBe(false)
  })
})

describe('$.command.register / list', () => {
  it('a command registered in session.start is listed, with the engine\'s own first; the picker is told', async () => {
    const { runtime, reports, changes } = world(
      {
        greeter: `
          on('session.start', async ($, e, next) => {
            const registered = await $.command.register({ name: 'hello', description: 'Says hi.', argumentHint: '[name]' })
            await $.ui.log('registered ' + JSON.stringify(registered))
            return next(e)
          })
          ${logging('$.command.list()')}
        `,
      },
      { engineCommands: true },
    )
    await runtime.ready
    await runtime.promptSubmit('hi')
    expect(reports).toEqual([
      'greeter: registered {"command":"hello"}',
      'greeter: [{"name":"help","description":"Show the commands","source":"builtin"},{"name":"review","description":"Review the diff","source":"user"},{"name":"hello","description":"Says hi.","source":"plugin","plugin":"greeter"}]',
    ])
    expect(changes.length).toBeGreaterThanOrEqual(1)
    expect(runtime.registeredCommand('hello')).toEqual({ name: 'hello', description: 'Says hi.', argumentHint: '[name]' })
    expect(runtime.listRegisteredCommands()).toEqual([
      { name: 'hello', description: 'Says hi.', argumentHint: '[name]', plugin: 'greeter' },
    ])
  })

  it('a built-in\'s name is refused; registering again replaces', async () => {
    const { runtime, reports } = world({
      p: logging(`(async () => {
        const refused = await $.command.register({ name: 'help', description: 'mine' }).catch(e => e.name)
        await $.command.register({ name: 'hello', description: 'first' })
        await $.command.register({ name: 'hello', description: 'second' })
        return [refused, (await $.command.list()).map(c => c.name + ':' + c.description)]
      })()`),
    })
    await runtime.ready
    await runtime.promptSubmit('hi')
    expect(reports).toEqual(['p: ["NotAllowedError",["hello:second"]]'])
  })

  it('is an event: another mod may rewrite the description, never the name', async () => {
    const { runtime, reports } = world({
      brander: `on('command.register', ($, e, next) => next({ ...e, name: 'other', description: '[acme] ' + e.description }))`,
      p: logging(`(async () => { await $.command.register({ name: 'hello', description: 'Says hi.' }); return $.command.list() })()`),
    })
    await runtime.ready
    await runtime.promptSubmit('hi')
    expect(reports).toEqual(['p: [{"name":"hello","description":"[acme] Says hi.","source":"plugin","plugin":"p"}]'])
  })
})

describe('command.run — a typed /name args', () => {
  it('is not raised for a command nobody registered or hooks', async () => {
    const { runtime } = world({ quiet: `on('session.start', ($, e, next) => next(e))` })
    await runtime.ready
    expect(runtime.hasCommandRunHooks()).toBe(false)
    let coreRan = 0
    const settlement = await runtime.commandRun({ command: 'status', args: '' }, async () => {
      coreRan += 1
      return { text: 'status' }
    })
    expect(settlement).toEqual({ settled: false })
    expect(coreRan).toBe(0)
  })

  it('a registered command: the hook\'s { text } is the output; one no hook answers is unanswered', async () => {
    const { runtime } = world({
      greeter: `
        on('session.start', async ($, e, next) => {
          await $.command.register({ name: 'hello', description: 'Says hi.' })
          await $.command.register({ name: 'silent', description: 'Nobody serves it.' })
          return next(e)
        })
        on('command.run', { command: 'hello' }, ($, e) => ({ text: 'hello ' + (e.args || 'world'), context: ['said hello'] }))
      `,
    })
    await runtime.ready
    await expect(runtime.commandRun({ command: 'hello', args: 'max' }, undefined)).resolves.toEqual({
      settled: true,
      result: { text: 'hello max', context: ['said hello'] },
      unanswered: false,
    })
    await expect(runtime.commandRun({ command: 'silent', args: '' }, undefined)).resolves.toEqual({
      settled: true,
      result: { ref: 1, text: undefined },
      unanswered: true,
    })
  })

  it('an engine command: a hook rewrites args with next, core runs on them, and a text after next replaces the output', async () => {
    const { runtime, reports } = world({
      p: `
        on('command.run', { command: 'status' }, async ($, e, next) => {
          await $.ui.log('saw ' + JSON.stringify({ command: e.command, args: e.args, origin: e.origin, columns: e.presentation.columns }))
          const ran = await next({ ...e, args: e.args + ' --verbose', command: 'other' })
          await $.ui.log('core said ' + JSON.stringify(ran))
          return { ...ran, text: ran.text.toUpperCase() }
        })
      `,
    })
    await runtime.ready
    expect(runtime.hasCommandRunHooks()).toBe(true)
    const coreArgs: string[] = []
    const settlement = await runtime.commandRun({ command: 'status', args: 'now' }, async args => {
      coreArgs.push(args)
      return { text: `status(${args})` }
    })
    expect(coreArgs).toEqual(['now --verbose'])
    expect(settlement).toEqual({ settled: true, result: { ref: 1, text: 'STATUS(NOW --VERBOSE)' }, unanswered: false })
    expect(reports).toEqual([
      'p: saw {"command":"status","args":"now","origin":{"kind":"composer"},"columns":80}',
      'p: core said {"text":"status(now --verbose)","ref":1}',
    ])
  })

  it('a hook answering for itself on an engine command: core never runs', async () => {
    const { runtime } = world({ p: `on('command.run', { command: 'clear' }, () => ({ text: 'not today' }))` })
    await runtime.ready
    let coreRan = 0
    const settlement = await runtime.commandRun({ command: 'clear', args: '' }, async () => {
      coreRan += 1
      return { text: 'cleared' }
    })
    expect(coreRan).toBe(0)
    expect(settlement).toEqual({ settled: true, result: { text: 'not today' }, unanswered: false })
  })

  it('a hook that fails is skipped and the command runs as typed; a wrong shape too', async () => {
    const { runtime, reports } = world({
      p: `
        on('command.run', { command: 'status' }, () => { throw new Error('boom') })
        on('command.run', { command: 'status' }, () => 'bare text')
      `,
    })
    await runtime.ready
    const settlement = await runtime.commandRun({ command: 'status', args: '' }, async args => ({ text: `status(${args})` }))
    expect(settlement).toEqual({ settled: true, result: { ref: 1, text: 'status()' }, unanswered: false })
    expect(reports.filter(l => l.includes('skipped'))).toHaveLength(2)
  })

  it('a lost worker takes its commands with it; the restart registers them again', async () => {
    const { runtime, workers } = world({
      greeter: `on('session.start', async ($, e, next) => { await $.command.register({ name: 'hello', description: 'Says hi.' }); return next(e) })`,
    })
    await runtime.ready
    expect(runtime.registeredCommand('hello')).toBeDefined()
    workers.greeter![0]!.crash()
    await until(() => runtime.registeredCommand('hello') === undefined)
    await until(() => runtime.registeredCommand('hello') !== undefined)
    expect(runtime.status()).toMatchObject([{ state: 'loaded', generation: 2 }])
    runtime.dispose()
    expect(runtime.listRegisteredCommands()).toEqual([])
  })
})

describe('an immediate command typed mid-turn', () => {
  it('only a registered command that declared immediate is one', async () => {
    const { runtime } = world({
      quick: `
        on('session.start', async ($, e, next) => {
          await $.command.register({ name: 'now', description: 'Runs at once.', immediate: true })
          await $.command.register({ name: 'later', description: 'Waits.' })
          return next(e)
        })
      `,
    })
    await runtime.ready
    expect(runtime.isImmediateCommand('now')).toBe(true)
    expect(runtime.isImmediateCommand('later')).toBe(false)
    expect(runtime.isImmediateCommand('status')).toBe(false)
    expect(runtime.registeredCommand('now')).toMatchObject({ immediate: true })
  })

  it('runs its command.run chain; { text } is the plugin toast, a dropped context is reported', async () => {
    const { runtime, toasts, reports } = world({
      quick: `
        on('session.start', async ($, e, next) => {
          await $.command.register({ name: 'now', description: 'Runs at once.', immediate: true })
          await $.command.register({ name: 'mute', description: 'Nobody serves it.', immediate: true })
          return next(e)
        })
        on('command.run', { command: 'now' }, ($, e) => ({ text: 'ran ' + e.args, context: ['for the model'] }))
      `,
    })
    await runtime.ready
    await runtime.commandRunImmediate({ command: 'now', args: 'x' })
    expect(toasts).toEqual([{ plugin: 'quick', text: 'ran x' }])
    expect(reports.some(r => r.includes('/now ran while a turn was in flight'))).toBe(true)
    await runtime.commandRunImmediate({ command: 'mute', args: '' })
    expect(toasts).toHaveLength(1)
    expect(reports.some(r => r.includes('no hook answered /mute'))).toBe(true)
  })
})

describe('$.command.run from a hook', () => {
  it('runs a registered command through the chain with the plugin as origin, the calling hook skipped', async () => {
    const { runtime, reports } = world({
      server: `
        on('session.start', async ($, e, next) => { await $.command.register({ name: 'hello', description: 'Says hi.' }); return next(e) })
        on('command.run', { command: 'hello' }, ($, e) => ({ text: 'hello from ' + e.origin.kind + ':' + (e.origin.name ?? '') + ' args=' + e.args }))
      `,
      caller: `
        on('command.run', { command: 'hello' }, async ($, e, next) => {
          await $.ui.log('caller saw its own run? ' + e.origin.kind)
          return next(e)
        })
        ${logging("$.command.run({ command: 'hello', args: 'x' })")}
      `,
    })
    await runtime.ready
    await runtime.promptSubmit('hi')
    // The caller's own hook on command.run is skipped for its own call.
    expect(reports).toEqual(['caller: {"text":"hello from plugin:caller args=x"}'])
  })

  it('rejects an unknown name, and an engine command by name', async () => {
    const { runtime, reports } = world(
      {
        p: logging(`(async () => [
          await $.command.run({ command: 'nope' }).catch(e => e.message),
          await $.command.run({ command: 'help' }).catch(e => e.name),
          await $.command.run({ command: '' }).catch(e => e.name),
        ])()`),
      },
      { engineCommands: true },
    )
    await runtime.ready
    await runtime.promptSubmit('hi')
    expect(reports).toEqual(['p: ["$.command.run: no command is named \\"nope\\"","NotSupportedError","TypeError"]'])
  })
})
