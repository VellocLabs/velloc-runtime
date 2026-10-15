/**
 * `tool.describe` and `command.describe` (F-25) through a real
 * `ModRuntime`: a tool's description rewritten for the model and cached for
 * the session, a command hidden or re-described for the picker with the
 * answers filled in asynchronously and the list republished, both caches
 * cleared by `$.ui.invalidate`, the pins, a failing hook passing through.
 * The two sites are pinned by their source.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { ModRuntime, type ModModuleRef, type ModWorkerHandle } from '../mods/ModRuntime'
import { installModWorkerHost } from '../mods/ModWorkerHost'
import {
  commandDescribeProblem,
  isCommandDescribeResult,
  isToolDescribeResult,
  toolDescribeProblem,
  type CommandDescribeInput,
  type ToolDescribeInput,
} from '../mods/describeEvents'
import { ENGINE_PROVIDER } from '../mods/agentEvents'
import { engineWorld } from './engine-replay/harness/world'

const open: MessagePort[] = []
const runtimes: ModRuntime[] = []
afterEach(() => {
  for (const runtime of runtimes.splice(0)) runtime.dispose()
  for (const port of open.splice(0)) port.close()
})

let uniq = 0

function world(sources: Record<string, string>) {
  const reports: string[] = []
  let commandsChanged = 0
  const modules: ModModuleRef[] = Object.keys(sources).map(path => ({ plugin: path.split('/')[0]!, path }))
  const runtime = new ModRuntime({
    modules,
    readModule: async path => `${sources[path]!}\n// load ${++uniq}`,
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
    session: { id: () => 'session-1', cwd: () => '/work/project' },
    report: line => reports.push(line),
    onCommandsChanged: () => {
      commandsChanged += 1
    },
  })
  runtimes.push(runtime)
  return { runtime, reports, changed: () => commandsChanged }
}

const READ: ToolDescribeInput = { tool: 'Read', description: 'Reads a file.', provider: ENGINE_PROVIDER }
const HELP: CommandDescribeInput = {
  command: 'help',
  description: 'Show help',
  isHidden: false,
  immediate: true,
  provider: ENGINE_PROVIDER,
}
const COMMIT: CommandDescribeInput = {
  command: 'commit',
  description: 'Create a commit',
  argumentHint: '[message]',
  isHidden: false,
  immediate: false,
  provider: ENGINE_PROVIDER,
}

describe('the shapes', () => {
  it('results and pins', () => {
    expect(isToolDescribeResult({ description: 'x' })).toBe(true)
    expect(isToolDescribeResult({ description: 'x', isDeferred: true })).toBe(true)
    expect(isToolDescribeResult({ description: 1 })).toBe(false)
    expect(isCommandDescribeResult({ description: 'x', isHidden: false })).toBe(true)
    expect(isCommandDescribeResult({ description: 'x', isHidden: 'no' })).toBe(false)
    expect(toolDescribeProblem(READ, { ...READ, description: 'y' })).toBeNull()
    expect(toolDescribeProblem(READ, { ...READ, tool: 'Bash' })).toBe('tool is pinned')
    expect(toolDescribeProblem(READ, { ...READ, provider: { plugin: 'p', tier: 'user' } })).toBe('provider is pinned')
    expect(commandDescribeProblem(HELP, { ...HELP, isHidden: true })).toBeNull()
    expect(commandDescribeProblem(HELP, { ...HELP, command: 'x' })).toBe('command is pinned')
    expect(commandDescribeProblem(HELP, { ...HELP, immediate: false })).toBe('immediate is pinned')
    expect(commandDescribeProblem(HELP, { ...HELP, argumentHint: 3 })).toBe('argumentHint is not a string')
  })
})

describe('tool.describe through the runtime', () => {
  it('a hook rewrites one tool, the others pass; the answer is cached until $.ui.invalidate("tool.describe")', async () => {
    const { runtime } = world({
      'desc/hooks/register.js': `
        let n = 0;
        export function register(on) {
          on('tool.describe', { tool: 'Read' }, ($, e) => ({ description: e.description + ' Prefer Grep. #' + (++n) }));
          on('prompt.submit', async ($, e, next) => {
            if (e.text === 'invalidate') await $.ui.invalidate('tool.describe');
            return next(e);
          });
        }
      `,
    })
    await runtime.ready
    expect(runtime.hasToolDescribeHooks()).toBe(true)
    expect(await runtime.toolDescribe(READ)).toBe('Reads a file. Prefer Grep. #1')
    // Cached: the hook is not asked again for the same tool.
    expect(await runtime.toolDescribe(READ)).toBe('Reads a file. Prefer Grep. #1')
    expect(await runtime.toolDescribe({ ...READ, tool: 'Bash', description: 'Runs a command.' })).toBe('Runs a command.')
    await runtime.promptSubmit('invalidate')
    expect(await runtime.toolDescribe(READ)).toBe('Reads a file. Prefer Grep. #2')
  })

  it('a description that changed is asked again (the Agent tool lists what is installed), and a reload clears both caches', async () => {
    const { runtime, changed } = world({
      'desc/hooks/register.js': `
        let n = 0;
        export function register(on) {
          on('tool.describe', ($, e) => ({ description: e.description + ' #' + (++n) }));
          on('command.describe', ($, e) => ({ description: e.description + ' #' + (++n), isHidden: false }));
        }
      `,
    })
    await runtime.ready
    expect(await runtime.toolDescribe(READ)).toBe('Reads a file. #1')
    expect(await runtime.toolDescribe({ ...READ, description: 'Reads a file or two.' })).toBe('Reads a file or two. #2')
    runtime.commandDescriptions([HELP])
    await runtime.whenDescribed()
    expect(runtime.commandDescriptions([HELP]).get('help')?.description).toBe('Show help #3')
    // The same command, declared differently, is asked again.
    runtime.commandDescriptions([{ ...HELP, description: 'Show the help' }])
    await runtime.whenDescribed()
    expect(runtime.commandDescriptions([{ ...HELP, description: 'Show the help' }]).get('help')?.description).toBe('Show the help #4')
    const before = changed()
    // A reload starts a fresh worker (n from 0): nothing cached by the old one survives.
    await runtime.reload()
    expect(changed()).toBeGreaterThan(before)
    expect(await runtime.toolDescribe({ ...READ, description: 'Reads a file or two.' })).toBe('Reads a file or two. #1')
    expect(runtime.commandDescriptions([HELP]).size).toBe(0)
  })

  it('a hook that throws, moves a pin, or answers the wrong shape passes the description through; no hook costs nothing', async () => {
    const { runtime, reports } = world({
      'bad/hooks/register.js': `
        export function register(on) {
          on('tool.describe', { tool: 'A' }, () => { throw new Error('boom') });
          on('tool.describe', { tool: 'B' }, ($, e, next) => next({ ...e, tool: 'C' }));
          on('tool.describe', { tool: 'D' }, () => ({ description: 7 }));
        }
      `,
    })
    await runtime.ready
    for (const tool of ['A', 'B', 'D']) {
      expect(await runtime.toolDescribe({ ...READ, tool, description: `${tool} does` })).toBe(`${tool} does`)
    }
    expect(reports).toHaveLength(3)
    expect(reports[1]).toBe('mods: tool.describe (B) failed: the rewritten event is refused: tool is pinned; the description stands')
    const { runtime: quiet } = world({ 'q/hooks/register.js': `export function register(on) { on('prompt.submit', ($, e, next) => next(e)) }` })
    await quiet.ready
    expect(quiet.hasToolDescribeHooks()).toBe(false)
    expect(await quiet.toolDescribe(READ)).toBe('Reads a file.')
  })
})

describe('command.describe through the runtime', () => {
  it('the first list answers nothing; the answers fill in and the list is republished once; then they are read from the cache', async () => {
    const { runtime, changed } = world({
      'menu/hooks/register.js': `
        export function register(on) {
          on('command.describe', { command: 'commit' }, ($, e, next) => next({ ...e, isHidden: true }));
          on('command.describe', { command: 'help' }, ($, e, next) => next({ ...e, description: 'Help, by a mod', argumentHint: '[topic]' }));
        }
      `,
    })
    await runtime.ready
    expect(runtime.hasCommandDescribeHooks()).toBe(true)
    const before = changed()
    expect(runtime.commandDescriptions([HELP, COMMIT])).toEqual(new Map())
    await runtime.whenDescribed()
    expect(changed()).toBe(before + 1)
    expect(runtime.commandDescriptions([HELP, COMMIT])).toEqual(
      new Map([
        ['help', { description: 'Help, by a mod', argumentHint: '[topic]', isHidden: false }],
        ['commit', { description: 'Create a commit', argumentHint: '[message]', isHidden: true }],
      ]),
    )
    // No further dispatch, no further republish.
    await runtime.whenDescribed()
    expect(changed()).toBe(before + 1)
  })

  it('$.ui.invalidate("command.describe") clears the answers and republishes; a failing hook keeps the command as declared', async () => {
    const { runtime, changed, reports } = world({
      'menu/hooks/register.js': `
        let n = 0;
        export function register(on) {
          on('command.describe', { command: 'help' }, ($, e, next) => next({ ...e, description: 'Help #' + (++n) }));
          on('command.describe', { command: 'commit' }, () => { throw new Error('boom') });
          on('prompt.submit', async ($, e, next) => {
            if (e.text === 'invalidate') await $.ui.invalidate('command.describe');
            return next(e);
          });
        }
      `,
    })
    await runtime.ready
    runtime.commandDescriptions([HELP, COMMIT])
    await runtime.whenDescribed()
    expect(runtime.commandDescriptions([HELP, COMMIT]).get('help')).toEqual({ description: 'Help #1', isHidden: false })
    expect(runtime.commandDescriptions([HELP, COMMIT]).get('commit')).toEqual({ description: 'Create a commit', argumentHint: '[message]', isHidden: false })
    expect(reports).toEqual([expect.stringMatching(/^menu: command\.describe .*boom/)])
    const republished = changed()
    await runtime.promptSubmit('invalidate')
    expect(changed()).toBe(republished + 1)
    expect(runtime.commandDescriptions([HELP])).toEqual(new Map())
    await runtime.whenDescribed()
    expect(runtime.commandDescriptions([HELP]).get('help')).toEqual({ description: 'Help #2', isHidden: false })
  })

  it('a runtime without the hook answers an empty map with no dispatch', async () => {
    const { runtime, changed } = world({ 'q/hooks/register.js': `export function register(on) { on('prompt.submit', ($, e, next) => next(e)) }` })
    await runtime.ready
    expect(runtime.hasCommandDescribeHooks()).toBe(false)
    const before = changed()
    expect(runtime.commandDescriptions([HELP])).toEqual(new Map())
    await runtime.whenDescribed()
    expect(changed()).toBe(before)
  })
})

describe('the sites raise them', () => {
  it('the model reads each tool under the description the mods settle on', async () => {
    const w = engineWorld({
      tools: [{ name: 'Look', readOnly: true }, { name: 'Change' }],
      mods: { toolDescribe: input => (input.tool === 'Look' ? `${input.description} Prefer it over guessing.` : input.description) },
      replies: [{ label: 'answer', text: 'Answer.' }, { label: 'title', querySource: 'rename_generate_name', text: 'A title' }],
    })
    await w.submit('hello')
    const trace = await w.finish()
    const tools = (trace.modelRequests[0] as { tools: Array<{ name: string; description: string }> }).tools
    expect(tools.find(t => t.name === 'Look')?.description).toBe('Look test tool. Prefer it over guessing.')
    expect(tools.find(t => t.name === 'Change')?.description).toBe('Change test tool.')
    const described = (trace.mods as Array<{ event: string; payload?: { tool: string } }>)
      .filter(m => m.event === 'tool.describe')
      .map(m => m.payload!.tool)
    expect(described).toEqual(expect.arrayContaining(['Look', 'Change']))
  })

  it('the worker snapshot overlays the command descriptions', () => {
    // Left as a source check: the worker snapshot has no seam a unit test
    // can drive without the SharedWorker host.
    const snapshot = readFileSync(join(__dirname, '..', 'browser', 'worker', 'workerSnapshot.ts'), 'utf8')
    expect(snapshot).toContain('describeCommands')
  })
})
