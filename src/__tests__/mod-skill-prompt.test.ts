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
import { skillPromptInputOf, skillPromptThroughMods } from '../skillLibrary/skillPromptThroughMods'
import { authoredFrontmatterOf } from '../skillLibrary/skillDiscovery'
import { readMarkdownHeader } from '../utils/frontmatter'
import type { SkillPromptInput } from '../mods/toolCallEvent'

/** A user skill's `e`, its header empty. */
const sp = (skill: string, text: string): SkillPromptInput => ({ skill, text, frontmatter: {}, source: 'userSettings' })

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
          on('skill.prompt', { skill: 'commit' }, ($, e, next) => ({ text: 'A poem about ' + e.text.length + ' chars.' }));
          on('skill.prompt', { skill: 'review' }, async ($, e, next) => {
            const computed = await next(e);
            return { text: computed.text + '\\nBe kind.' };
          });
        }
      `,
    })
    await runtime.ready
    expect(runtime.hasSkillPromptHooks()).toBe(true)
    expect(await runtime.skillPrompt(sp('commit', 'Create a commit.'))).toBe('A poem about 16 chars.')
    expect(await runtime.skillPrompt(sp('review', 'Review the diff.'))).toBe('Review the diff.\nBe kind.')
    expect(await runtime.skillPrompt(sp('debug', 'Tail the log.'))).toBe('Tail the log.')
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
    expect(await runtime.skillPrompt(sp('throws', 'as computed'))).toBe('as computed')
    expect(await runtime.skillPrompt(sp('shape', 'as computed'))).toBe('as computed')
    expect(reports).toEqual([
      expect.stringMatching(/^bad: skill\.prompt .*no/),
      expect.stringMatching(/^bad: skill\.prompt .*does not take/),
    ])
  })

  it('a runtime without the hook sends the text as computed, with no dispatch', async () => {
    const { runtime } = world({ 'other/hooks/register.js': `export function register(on) { on('prompt.submit', ($, e, next) => next(e)) }` })
    await runtime.ready
    expect(runtime.hasSkillPromptHooks()).toBe(false)
    expect(await runtime.skillPrompt(sp('commit', 'x'))).toBe('x')
  })
})

describe('skillPromptThroughMods — the sites\' helper', () => {
  it('no holder, a holder without the method, a holder with no hook: the text as computed; otherwise the hook\'s; a rejection passes through', async () => {
    expect(await skillPromptThroughMods(undefined, sp('a', 't'))).toBe('t')
    expect(await skillPromptThroughMods({}, sp('a', 't'))).toBe('t')
    let calls = 0
    expect(
      await skillPromptThroughMods(
        { hasSkillPromptHooks: () => false, skillPrompt: async () => (calls++, 'never') },
        sp('a', 't'),
      ),
    ).toBe('t')
    expect(calls).toBe(0)
    expect(await skillPromptThroughMods({ skillPrompt: async input => `${input.skill}:${input.text}!` }, sp('a', 't'))).toBe('a:t!')
    expect(
      await skillPromptThroughMods(
        {
          skillPrompt: async () => {
            throw new Error('port gone')
          },
        },
        sp('a', 't'),
      ),
    ).toBe('t')
  })

  it('both expansion sites raise it, after the body is built and before it reaches the model', () => {
    const root = join(__dirname, '..')
    for (const [file, skillName] of [
      ['toolkit/builtin/skill.ts', 'command'],
      ['input/skillSlashCommand.ts', 'skill'],
    ] as const) {
      const source = readFileSync(join(root, file), 'utf8')
      const expanded = source.indexOf('expandSkillBodyShell(')
      const raised = source.indexOf('skillPromptThroughMods(', expanded)
      expect(expanded, file).toBeGreaterThan(0)
      expect(raised, file).toBeGreaterThan(expanded)
      expect(source.slice(raised, raised + 400), file).toContain(`skillPromptInputOf(${skillName}, body)`)
    }
  })
})

describe('skill.prompt — the header, the source, the file', () => {
  it('a hook reads the frontmatter, source, plugin and path; the pinned fields refuse a rewrite, text and frontmatter do not', async () => {
    const { runtime, reports } = world({
      'reader/hooks/register.js': `
        export function register(on) {
          on('skill.prompt', { skill: 'seen' }, ($, e) => ({
            text: [e.frontmatter.model, e.source, e.pluginName, e.path, e.frontmatterProblem ?? 'none'].join('|'),
          }));
          on('skill.prompt', { skill: 'moved' }, ($, e, next) => next({ ...e, source: 'built-in' }));
          on('skill.prompt', { skill: 'rewritten' }, ($, e, next) => next({ ...e, text: 'other', frontmatter: { model: 'x' } }));
        }
      `,
    })
    await runtime.ready
    const input: SkillPromptInput = {
      skill: 'seen',
      text: 't',
      frontmatter: { model: 'fast' },
      source: 'plugin',
      pluginName: 'kit',
      path: '/home/me/.velloc/plugins/kit/skills/seen/SKILL.md',
    }
    expect(await runtime.skillPrompt(input)).toBe('fast|plugin|kit|/home/me/.velloc/plugins/kit/skills/seen/SKILL.md|none')
    expect(await runtime.skillPrompt({ ...input, skill: 'moved' })).toBe('t')
    expect(reports.some(line => /source is pinned/.test(line))).toBe(true)
    reports.length = 0
    expect(await runtime.skillPrompt({ ...input, skill: 'rewritten' })).toBe('t')
    expect(reports).toEqual([])
  })

  it("the site's input: the source in the event's words, no path for a built-in, the header and its problem as loaded", () => {
    const header = { name: 'x', description: 'd', model: 'fast' }
    expect(
      skillPromptInputOf(
        { name: 'x', source: 'project', path: '/repo/.velloc/skills/x/SKILL.md', frontmatter: header },
        'body',
      ),
    ).toEqual({ skill: 'x', text: 'body', frontmatter: header, source: 'projectSettings', path: '/repo/.velloc/skills/x/SKILL.md' })
    expect(skillPromptInputOf({ name: 'b', source: 'bundled', path: 'bundled:b' }, 'body')).toEqual({
      skill: 'b',
      text: 'body',
      frontmatter: {},
      source: 'built-in',
    })
    expect(
      skillPromptInputOf({ name: 'p', source: 'plugin', path: '/p/SKILL.md', pluginName: 'kit', frontmatterProblem: 'why' }, 'b'),
    ).toMatchObject({ source: 'plugin', pluginName: 'kit', frontmatterProblem: 'why' })
    expect(skillPromptInputOf({ name: 'u', source: 'user', path: '/u.md' }, 'b').source).toBe('userSettings')
  })

  it('the header as a hook reads it: JSON values, no prototype keys, a parse failure leaves it empty and says why', () => {
    const parsed = JSON.parse('{"model":"fast","constructor":"c","__proto__":{"polluted":true},"tags":["a"]}')
    const authored = authoredFrontmatterOf(parsed)
    expect(authored.frontmatter).toEqual({ model: 'fast', tags: ['a'] })
    expect(Object.getPrototypeOf(authored.frontmatter)).toBe(Object.prototype)
    expect(authored.problem).toBe('left out of the frontmatter: constructor')
    expect(authoredFrontmatterOf({ model: 'fast' })).toEqual({ frontmatter: { model: 'fast' } })
    const broken = readMarkdownHeader(['---', 'key: [unclosed', '  - : :', '---', 'body', ''].join('\n'))
    expect(broken.frontmatter).toEqual({})
    expect(broken.problem).toMatch(/^the frontmatter is not valid YAML: /)
    expect(authoredFrontmatterOf(broken.frontmatter, broken.problem)).toEqual({ frontmatter: {}, problem: broken.problem })
    const listed = readMarkdownHeader(['---', '- a', '- b', '---', 'body', ''].join('\n'))
    expect(listed.frontmatter).toEqual({})
    expect(listed.problem).toBe('the frontmatter is not a mapping of keys to values')
    expect(readMarkdownHeader(['---', '---', 'body', ''].join('\n')).problem).toBeUndefined()
  })
})
