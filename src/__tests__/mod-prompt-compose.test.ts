/**
 * The system-prompt events (F-25, first slice) through a real
 * `ModRuntime`: `prompt.section`, `prompt.compose`, `prompt.context` — what
 * a hook may do to each, what the chain refuses, and that a failing hook
 * leaves the prompt as the engine composed it. The engine's call site is
 * `query-engine-mods.test.ts`.
 */
import { afterEach, describe, expect, it } from 'vitest'
import { ModRuntime, type ModModuleRef, type ModWorkerHandle } from '../mods/ModRuntime'
import { installModWorkerHost } from '../mods/ModWorkerHost'
import {
  composeSectionsOf,
  isPromptComposeResult,
  isPromptContextResult,
  type PromptComposeSection,
} from '../mods/promptEvents'

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

const SECTIONS: PromptComposeSection[] = [
  { id: 'intro', text: 'You are an agent.', scope: 'shared' },
  { id: 'tools', text: '# Tools', scope: 'shared' },
  { id: 'env_info', text: '# Environment', scope: 'session' },
]

const INPUT = {
  model: 'claude-opus-5-5',
  promptModel: 'claude-opus-5-5',
  surfaces: ['desktop'],
  tools: ['Read', 'Bash'],
  outputStyle: null,
  traits: ['lean' as const],
}

describe('composeSectionsOf — Velloc\'s named parts as the declaration lists them', () => {
  it('names, uniqueness, the session side', () => {
    expect(
      composeSectionsOf([
        { name: 'code_intro', text: 'a' },
        { text: 'literal' },
        { name: 'system', text: 'b' },
        { name: 'system', text: 'c' },
        { name: 'env_info', text: 'd' },
        { name: 'memory', text: 'e' },
        { name: 'scratchpad', text: 'f' },
      ]),
    ).toEqual([
      { id: 'code_intro', text: 'a', scope: 'shared' },
      { id: 'line_2', text: 'literal', scope: 'shared' },
      { id: 'system', text: 'b', scope: 'shared' },
      { id: 'system#2', text: 'c', scope: 'shared' },
      { id: 'env_info', text: 'd', scope: 'session' },
      { id: 'memory', text: 'e', scope: 'session' },
      { id: 'scratchpad', text: 'f', scope: 'session' },
    ])
  })

  it('the compose answer: ids non-empty and unique, text a string, every shared ahead of every session', () => {
    const ok = (sections: unknown[]) => isPromptComposeResult({ sections })
    expect(ok([{ id: 'a', text: 'x', scope: 'shared' }, { id: 'b', text: 'y', scope: 'session' }])).toBe(true)
    // No scope is session: fine last, not before a shared one.
    expect(ok([{ id: 'a', text: 'x', scope: 'shared' }, { id: 'b', text: 'y' }])).toBe(true)
    expect(ok([{ id: 'b', text: 'y' }, { id: 'a', text: 'x', scope: 'shared' }])).toBe(false)
    expect(ok([{ id: 'a', text: 'x', scope: 'session' }, { id: 'b', text: 'y', scope: 'shared' }])).toBe(false)
    expect(ok([{ id: '', text: 'x', scope: 'shared' }])).toBe(false)
    expect(ok([{ id: 'a', text: 'x', scope: 'shared' }, { id: 'a', text: 'y', scope: 'shared' }])).toBe(false)
    expect(ok([{ id: 'a', text: 1, scope: 'shared' }])).toBe(false)
    expect(ok([{ id: 'a', text: 'x', scope: 'other' }])).toBe(false)
    expect(isPromptComposeResult({ sections: 'x' })).toBe(false)
    expect(isPromptComposeResult(null)).toBe(false)
  })

  it('the context answer: blocks named uniquely, instruction files well formed', () => {
    expect(isPromptContextResult({ blocks: [{ name: 'instructionText', text: 'x' }, { name: 'acme', text: '' }] })).toBe(true)
    expect(isPromptContextResult({ blocks: [{ name: 'a', text: 'x' }, { name: 'a', text: 'y' }] })).toBe(false)
    expect(isPromptContextResult({ blocks: [{ name: '', text: 'x' }] })).toBe(false)
    expect(
      isPromptContextResult({ blocks: [], instructionFiles: [{ path: '/p/CLAUDE.md', kind: 'project', content: 'c' }] }),
    ).toBe(true)
    expect(isPromptContextResult({ blocks: [], instructionFiles: [{ path: '/p', kind: 'other', content: 'c' }] })).toBe(false)
    expect(isPromptContextResult({ blocks: [], instructionFiles: 'x' })).toBe(false)
  })
})

describe('prompt.section', () => {
  it('each named section in turn: a rewrite, a null leaving it out, a pass-through; a matcher narrows on the name', async () => {
    const { runtime, reports } = world({
      'trim/hooks/register.js': `
        export function register(on) {
          on('prompt.section', { name: 'tools' }, ($, e, next) => ({ text: null }))
          on('prompt.section', { name: 'intro' }, async ($, e, next) => {
            const { text } = await next(e)
            return { text: text + ' Be brief.' }
          })
        }
      `,
    })
    await runtime.ready
    expect(await runtime.promptSections(SECTIONS)).toEqual([
      { id: 'intro', text: 'You are an agent. Be brief.', scope: 'shared' },
      { id: 'env_info', text: '# Environment', scope: 'session' },
    ])
    // The one it left out is said, and nothing else is.
    expect(reports).toEqual(['mods: prompt.section dropped the tools section'])
  })

  it('a hook that fails or answers the wrong shape is skipped: the section stands', async () => {
    const { runtime, reports } = world({
      'bad/hooks/register.js': `
        export function register(on) {
          on('prompt.section', { name: 'intro' }, () => { throw new Error('nope') })
          on('prompt.section', { name: 'tools' }, () => ({ text: 42 }))
        }
      `,
    })
    await runtime.ready
    expect(await runtime.promptSections(SECTIONS)).toEqual(SECTIONS)
    expect(reports.filter(line => /prompt\.section hook failed/.test(line))).toHaveLength(2)
  })

  it('no hook on it: the list as it was, with no dispatch', async () => {
    const { runtime } = world({
      'other/hooks/register.js': `export function register(on) { on('prompt.submit', ($, e, next) => next(e)) }`,
    })
    await runtime.ready
    expect(await runtime.promptSections(SECTIONS)).toEqual(SECTIONS)
  })
})

describe('prompt.compose', () => {
  it('the event carries the model, the tools and the traits; next(e) is the engine\'s list; a hook appends as session', async () => {
    const { runtime } = world({
      'policy/hooks/register.js': `
        export function register(on) {
          on('prompt.compose', async ($, e, next) => {
            const { sections } = await next(e)
            return { sections: [...sections, { id: 'policy:acme', text: 'seen ' + JSON.stringify(e), scope: 'session' }] }
          })
        }
      `,
    })
    await runtime.ready
    const sections = await runtime.promptCompose(INPUT, SECTIONS)
    expect(sections.slice(0, 3)).toEqual(SECTIONS)
    expect(sections[3]).toMatchObject({ id: 'policy:acme', scope: 'session' })
    expect(JSON.parse(sections[3]!.text.slice('seen '.length))).toEqual(INPUT)
  })

  it('replace, reorder and drop; a section appended without a scope is session', async () => {
    const { runtime, reports } = world({
      'shape/hooks/register.js': `
        export function register(on) {
          on('prompt.compose', async ($, e, next) => {
            const { sections } = await next(e)
            const tools = sections.find(s => s.id === 'tools')
            const intro = sections.find(s => s.id === 'intro')
            return { sections: [tools, { ...intro, text: 'You are a poet.' }, { id: 'shape:tail', text: 'the end' }] }
          })
        }
      `,
    })
    await runtime.ready
    expect(await runtime.promptCompose(INPUT, SECTIONS)).toEqual([
      { id: 'tools', text: '# Tools', scope: 'shared' },
      { id: 'intro', text: 'You are a poet.', scope: 'shared' },
      { id: 'shape:tail', text: 'the end', scope: 'session' },
    ])
    // A dropped section is said, so what the model was told is auditable.
    expect(reports).toContain('mods: prompt.compose dropped the env_info section(s)')
  })

  it('a list with a shared section after a session one skips the hook; so does a bad shape', async () => {
    const { runtime, reports } = world({
      'disorder/hooks/register.js': `
        export function register(on) {
          on('prompt.compose', async ($, e, next) => {
            const { sections } = await next(e)
            return { sections: [...sections].reverse() }
          })
        }
      `,
      'broken/hooks/register.js': `
        export function register(on) {
          on('prompt.compose', () => ({ sections: [{ id: 'x' }] }))
        }
      `,
    })
    await runtime.ready
    expect(await runtime.promptCompose(INPUT, SECTIONS)).toEqual(SECTIONS)
    expect(reports.filter(line => /prompt\.compose hook failed/.test(line))).toHaveLength(2)
  })

  it('a hook answering without next answers the whole list', async () => {
    const { runtime } = world({
      'bare/hooks/register.js': `
        export function register(on) {
          on('prompt.compose', () => ({ sections: [{ id: 'bare:only', text: 'Just this.', scope: 'shared' }] }))
        }
      `,
    })
    await runtime.ready
    expect(await runtime.promptCompose(INPUT, SECTIONS)).toEqual([{ id: 'bare:only', text: 'Just this.', scope: 'shared' }])
  })
})

describe('prompt.context', () => {
  const CONTEXT = {
    blocks: [
      { name: 'currentDate', text: "Today's date is 2026-10-03." },
      { name: 'instructionText', text: '# CLAUDE.md\nbe nice' },
    ],
    instructionFiles: [{ path: '/work/project/CLAUDE.md', kind: 'project' as const, content: 'be nice' }],
  }

  it('append, drop and rewrite blocks; the files behind instructionText are handed to the hook', async () => {
    const { runtime, reports } = world({
      'ctx/hooks/register.js': `
        export function register(on) {
          on('prompt.context', async ($, e, next) => {
            const { blocks } = await next(e)
            return {
              blocks: [
                ...blocks.filter(b => b.name !== 'currentDate').map(b => b.name === 'instructionText' ? { ...b, text: b.text + '\\nand brief' } : b),
                { name: 'ctx:files', text: e.instructionFiles.map(f => f.kind + ':' + f.path).join(',') },
              ],
            }
          })
        }
      `,
    })
    await runtime.ready
    expect(await runtime.promptContext(CONTEXT)).toEqual({
      blocks: [
        { name: 'instructionText', text: '# CLAUDE.md\nbe nice\nand brief' },
        { name: 'ctx:files', text: 'project:/work/project/CLAUDE.md' },
      ],
    })
    expect(reports).toContain('mods: prompt.context dropped the currentDate block(s)')
  })

  it('a changed file list comes back with the blocks; a failing hook leaves the engine\'s own', async () => {
    const { runtime, reports } = world({
      'files/hooks/register.js': `
        export function register(on) {
          on('prompt.context', async ($, e, next) => {
            const own = await next(e)
            return { ...own, instructionFiles: [...e.instructionFiles, { path: '/org/POLICY.md', kind: 'managed', content: 'no secrets' }] }
          })
          on('prompt.context', () => { throw new Error('down') })
        }
      `,
    })
    await runtime.ready
    const result = await runtime.promptContext(CONTEXT)
    expect(result.blocks).toEqual(CONTEXT.blocks)
    expect(result.instructionFiles).toEqual([
      ...CONTEXT.instructionFiles,
      { path: '/org/POLICY.md', kind: 'managed', content: 'no secrets' },
    ])
    expect(reports.filter(line => /prompt\.context hook failed: down/.test(line))).toHaveLength(1)
  })

  it('what a hook hands down with next({ ...e, … }) is what core answers', async () => {
    const { runtime } = world({
      'down/hooks/register.js': `
        export function register(on) {
          on('prompt.context', ($, e, next) =>
            next({
              ...e,
              blocks: e.blocks.filter(b => b.name !== 'currentDate'),
              instructionFiles: [...e.instructionFiles, { path: '/work/project/AGENTS.md', kind: 'project', content: 'tabs' }],
            }),
          )
        }
      `,
    })
    await runtime.ready
    const result = await runtime.promptContext(CONTEXT)
    expect(result.blocks.map(block => block.name)).toEqual(['instructionText'])
    expect(result.instructionFiles).toEqual([
      ...CONTEXT.instructionFiles,
      { path: '/work/project/AGENTS.md', kind: 'project', content: 'tabs' },
    ])
  })
})
