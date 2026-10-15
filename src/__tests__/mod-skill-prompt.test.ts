/**
 * `skill.prompt` (F-25) through a real `ModRuntime`, and the
 * helper the two expansion sites share: a hook replaces the text the model
 * reads for a skill, a matcher narrows on the skill, a failing hook or a bad
 * answer passes the text through, a holder without the method costs nothing.
 * The two sites are pinned by their source, as `mod-slot` pins the boot.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { ModRuntime, type ModModuleRef, type ModWorkerHandle } from '../mods/ModRuntime'
import { installModWorkerHost } from '../mods/ModWorkerHost'
import { skillPromptThroughMods } from '../skillLibrary/skillPromptThroughMods'

const open: MessagePort[] = []
const runtimes: ModRuntime[] = []
afterEach(() => {
  for (const runtime of runtimes.splice(0)) runtime.dispose()
  for (const port of open.splice(0)) port.close()
})

let uniq = 0

function world(sources: Record<string, string>) {
  const reports: string[] = []
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
  })
  runtimes.push(runtime)
  return { runtime, reports }
}

describe('skill.prompt through the runtime', () => {
  it('a hook replaces the text for the skill it matches, sees the computed text, and passes the others through', async () => {
    const { runtime, reports } = world({
      'haiku/hooks/register.js': `
        export function register(on) {
          on('skill.prompt', { skill: 'commit' }, ($, e, next) => ({ text: 'A haiku about ' + e.text.length + ' chars.' }));
          on('skill.prompt', { skill: 'review' }, async ($, e, next) => {
            const computed = await next(e);
            return { text: computed.text + '\\nBe kind.' };
          });
        }
      `,
    })
    await runtime.ready
    expect(runtime.hasSkillPromptHooks()).toBe(true)
    expect(await runtime.skillPrompt({ skill: 'commit', text: 'Create a commit.' })).toBe('A haiku about 16 chars.')
    expect(await runtime.skillPrompt({ skill: 'review', text: 'Review the diff.' })).toBe('Review the diff.\nBe kind.')
    expect(await runtime.skillPrompt({ skill: 'debug', text: 'Tail the log.' })).toBe('Tail the log.')
    expect(reports).toEqual([])
  })

  it('a hook that throws, or answers something that is not { text }, passes the text through', async () => {
    const { runtime, reports } = world({
      'bad/hooks/register.js': `
        export function register(on) {
          on('skill.prompt', { skill: 'throws' }, () => { throw new Error('no') });
          on('skill.prompt', { skill: 'shape' }, () => ({ text: 42 }));
        }
      `,
    })
    await runtime.ready
    expect(await runtime.skillPrompt({ skill: 'throws', text: 'as computed' })).toBe('as computed')
    expect(await runtime.skillPrompt({ skill: 'shape', text: 'as computed' })).toBe('as computed')
    expect(reports).toEqual([
      expect.stringMatching(/^bad: skill\.prompt .*no/),
      expect.stringMatching(/^bad: skill\.prompt .*does not take/),
    ])
  })

  it('a runtime without the hook sends the text as computed, with no dispatch', async () => {
    const { runtime } = world({ 'other/hooks/register.js': `export function register(on) { on('prompt.submit', ($, e, next) => next(e)) }` })
    await runtime.ready
    expect(runtime.hasSkillPromptHooks()).toBe(false)
    expect(await runtime.skillPrompt({ skill: 'commit', text: 'x' })).toBe('x')
  })
})

describe('skillPromptThroughMods — the sites\' helper', () => {
  it('no holder, a holder without the method, a holder with no hook: the text as computed; otherwise the hook\'s; a rejection passes through', async () => {
    expect(await skillPromptThroughMods(undefined, { skill: 'a', text: 't' })).toBe('t')
    expect(await skillPromptThroughMods({}, { skill: 'a', text: 't' })).toBe('t')
    let calls = 0
    expect(
      await skillPromptThroughMods(
        { hasSkillPromptHooks: () => false, skillPrompt: async () => (calls++, 'never') },
        { skill: 'a', text: 't' },
      ),
    ).toBe('t')
    expect(calls).toBe(0)
    expect(await skillPromptThroughMods({ skillPrompt: async input => `${input.skill}:${input.text}!` }, { skill: 'a', text: 't' })).toBe('a:t!')
    expect(
      await skillPromptThroughMods(
        {
          skillPrompt: async () => {
            throw new Error('port gone')
          },
        },
        { skill: 'a', text: 't' },
      ),
    ).toBe('t')
  })

  it('both expansion sites raise it, after the body is built and before it reaches the model', () => {
    const root = join(__dirname, '..')
    for (const [file, skillName] of [
      ['toolkit/builtin/skill.ts', 'command.name'],
      ['input/skillSlashCommand.ts', 'skill.name'],
    ] as const) {
      const source = readFileSync(join(root, file), 'utf8')
      const expanded = source.indexOf('expandSkillBodyShell(')
      const raised = source.indexOf('skillPromptThroughMods(', expanded)
      expect(expanded, file).toBeGreaterThan(0)
      expect(raised, file).toBeGreaterThan(expanded)
      expect(source.slice(raised, raised + 400), file).toContain(`{ skill: ${skillName}, text: body }`)
    }
  })
})
