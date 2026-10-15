/**
 * `$.prompt.submit` and `$.prompt.compose` (F-25): a submit is `prompt.submit` with
 * `origin: { kind: 'plugin', name }` raised with the caller's context (not re-raised to the calling hook) and what
 * arrives is queued; a compose is `prompt.compose` over the engine's sections. The engine's half is `query-engine-mods`.
 */
import { afterEach, describe, expect, it } from 'vitest'
import { ModRuntime, type ModModuleRef, type ModWorkerHandle } from '../mods/ModRuntime'
import { installModWorkerHost } from '../mods/ModWorkerHost'
import type { ModNounHost } from '../mods/modNouns'
import {
  pluginPromptArgsOf,
  pluginPromptText,
  promptComposeArgsOf,
  withoutPluginPromptFrame,
  type ModPromptHost,
  type PluginPromptTurn,
} from '../mods/promptNouns'
import type { PromptComposeSection } from '../mods/promptEvents'

const open: MessagePort[] = []
const runtimes: ModRuntime[] = []
afterEach(() => {
  for (const runtime of runtimes.splice(0)) runtime.dispose()
  for (const port of open.splice(0)) port.close()
})

describe('the arguments and the frame', () => {
  it('submit takes { text, asUser? }; the engine\'s fields are refused by name', () => {
    expect(pluginPromptArgsOf({ text: 'go on' })).toEqual({ text: 'go on' })
    expect(pluginPromptArgsOf({ text: 'go on', asUser: true })).toEqual({ text: 'go on', asUser: true })
    expect(() => pluginPromptArgsOf({ text: ' ' })).toThrow('text must be a non-empty string')
    expect(() => pluginPromptArgsOf({ text: 'x', asUser: false })).toThrow('asUser is true or absent')
    expect(() => pluginPromptArgsOf({ text: 'x', context: ['y'] })).toThrow("context is the engine's to set")
  })

  it('compose takes { model?, tools? }; another fact is refused by name', () => {
    expect(promptComposeArgsOf(undefined)).toEqual({})
    expect(promptComposeArgsOf({ model: 'claude-x', tools: ['Read'] })).toEqual({ model: 'claude-x', tools: ['Read'] })
    expect(() => promptComposeArgsOf({ traits: ['lean'] })).toThrow("the fact traits is the session's own")
    expect(() => promptComposeArgsOf({ tools: 'Read' })).toThrow('tools must be a list of tool names')
  })

  it('the model reads "The <plugin> plugin sent a message: …", or the text bare as the user\'s; the page takes the frame off', () => {
    const framed = pluginPromptText({ text: 'run the tests', plugin: 'lab' })
    expect(framed).toBe('The lab plugin sent a message: run the tests')
    expect(pluginPromptText({ text: 'run the tests', plugin: 'lab', asUser: true })).toBe('run the tests')
    expect(withoutPluginPromptFrame(framed, 'lab')).toBe('run the tests')
    expect(withoutPluginPromptFrame('The other plugin sent a message: x', 'lab')).toBe('The other plugin sent a message: x')
  })
})

describe('the calls through the runtime', () => {
  let uniq = 0
  function world(modules: Record<string, string>, host: Partial<ModNounHost> = {}) {
    const reports: string[] = []
    const refs: ModModuleRef[] = Object.keys(modules).map(plugin => ({ plugin, path: `/plugins/${plugin}/hooks/register.js` }))
    const runtime = new ModRuntime({
      modules: refs,
      readModule: async path => `${modules[path.split('/')[2]!]}\n// load ${++uniq}`,
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
      session: { id: () => 's', cwd: () => '/work/project', ...host },
      report: line => reports.push(line),
    })
    runtimes.push(runtime)
    return { runtime, reports }
  }

  const SECTIONS: PromptComposeSection[] = [
    { id: 'intro', text: 'You are Velloc.', scope: 'shared' },
    { id: 'memory', text: 'Remember things.', scope: 'session' },
  ]

  /** The session's half, as `createAgentRuntime` binds it. */
  function sessionHalf() {
    let runtime!: ModRuntime
    const queued: PluginPromptTurn[] = []
    const prompt: ModPromptHost = {
      submit: (args, raise) => runtime.pluginSubmit(args, turn => {
        queued.push(turn)
      }, raise),
      compose: async (_args, raise) => ({
        sections: await runtime.promptCompose(
          { model: 'claude-x', promptModel: 'claude-x', surfaces: ['desktop'], tools: [], outputStyle: null, traits: [] },
          SECTIONS,
          raise.signal,
          raise.context,
        ),
      }),
    }
    return { prompt, queued, bind: (r: ModRuntime) => { runtime = r } }
  }

  it('submit: prompt.submit with origin the plugin, a hook above rewriting it and attaching context; what arrives is queued; the calling hook is not raised again', async () => {
    const half = sessionHalf()
    const { runtime, reports } = world(
      {
        caller: `
          export function register(on) {
            on('prompt.submit', async ($, e, next) => {
              await $.ui.log(JSON.stringify({ seen: e.origin.kind }));
              if (e.origin.kind === 'composer') {
                const queued = await $.prompt.submit({ text: 'follow up' });
                await $.ui.log(JSON.stringify({ queued }));
              }
              return next(e);
            });
          }
        `,
        stamp: `
          export function register(on) {
            on('prompt.submit', async ($, e, next) => {
              if (e.origin.kind !== 'plugin') return next(e);
              await $.ui.log(JSON.stringify({ origin: e.origin, from: next.origin.plugin }));
              return next({ ...e, text: e.text + ' (stamped)', context: ['STAMP_CONTEXT'] });
            });
          }
        `,
      },
      { prompt: half.prompt },
    )
    half.bind(runtime)
    await runtime.ready
    await runtime.promptSubmit('typed')
    const logs = reports.filter(r => /^(caller|stamp): \{/.test(r)).map(r => JSON.parse(r.slice(r.indexOf('{'))))
    expect(logs).toEqual([
      { seen: 'composer' },
      { origin: { kind: 'plugin', name: 'caller' }, from: 'caller' },
      {
        queued: {
          text: 'follow up (stamped)',
          context: ['STAMP_CONTEXT'],
          origin: { kind: 'plugin', name: 'caller' },
        },
      },
    ])
    expect(half.queued).toEqual([{ text: 'follow up (stamped)', context: ['STAMP_CONTEXT'], plugin: 'caller' }])
  })

  it('submit: a hook\'s drop queues nothing and is the answer; asUser rides the origin; with no hook the prompt is queued as written', async () => {
    const half = sessionHalf()
    const { runtime, reports } = world(
      {
        caller: `
          export function register(on) {
            on('session.start', async ($, e, next) => {
              const dropped = await $.prompt.submit({ text: 'secret plan' });
              const bare = await $.prompt.submit({ text: 'as the person', asUser: true });
              await $.ui.log(JSON.stringify({ dropped, bare }));
              return next(e);
            });
          }
        `,
        guard: `
          export function register(on) {
            on('prompt.submit', ($, e, next) => (e.text.includes('secret') ? { drop: 'no secrets' } : next(e)));
          }
        `,
      },
      { prompt: half.prompt },
    )
    half.bind(runtime)
    await runtime.ready
    const line = reports.find(r => r.startsWith('caller: {'))!
    expect(JSON.parse(line.slice('caller: '.length))).toEqual({
      dropped: { drop: 'no secrets' },
      bare: { text: 'as the person', origin: { kind: 'plugin', name: 'caller', asUser: true } },
    })
    expect(half.queued).toEqual([{ text: 'as the person', context: [], plugin: 'caller', asUser: true }])

    const alone = sessionHalf()
    const solo = world(
      {
        caller: `
          export function register(on) {
            on('session.start', async ($, e, next) => {
              await $.ui.log(JSON.stringify(await $.prompt.submit({ text: 'plain' })));
              return next(e);
            });
          }
        `,
      },
      { prompt: alone.prompt },
    )
    alone.bind(solo.runtime)
    await solo.runtime.ready
    expect(alone.queued).toEqual([{ text: 'plain', context: [], plugin: 'caller' }])
  })

  it('compose: prompt.compose over the engine\'s sections with the caller\'s context; another plugin appends one', async () => {
    const half = sessionHalf()
    const { runtime, reports } = world(
      {
        reader: `
          export function register(on) {
            on('session.start', async ($, e, next) => {
              const { sections } = await $.prompt.compose();
              await $.ui.log(JSON.stringify(sections.map(s => s.id + ':' + s.scope)));
              return next(e);
            });
          }
        `,
        writer: `
          export function register(on) {
            on('prompt.compose', async ($, e, next) => {
              const { sections } = await next(e);
              await $.ui.log(JSON.stringify({ from: next.origin.plugin, model: e.model }));
              return { sections: [...sections, { id: 'writer:note', text: 'A note.', scope: 'session' }] };
            });
          }
        `,
      },
      { prompt: half.prompt },
    )
    half.bind(runtime)
    await runtime.ready
    expect(reports).toContain('writer: {"from":"reader","model":"claude-x"}')
    expect(reports).toContain('reader: ["intro:shared","memory:session","writer:note:session"]')
  })

  it('a host without the prompt noun refuses both by name; the box answers as headless', async () => {
    const { runtime, reports } = world({
      probe: `
        export function register(on) {
          on('session.start', async ($, e, next) => {
            const why = err => err.name + ': ' + err.message;
            await $.ui.log(await $.prompt.submit({ text: 'x' }).catch(why));
            await $.ui.log(await $.prompt.compose().catch(why));
            await $.ui.log(JSON.stringify(await $.prompt.read()));
            await $.ui.log(JSON.stringify(await $.prompt.fill({ text: 'y' })));
            await $.ui.log(JSON.stringify(await $.prompt.suggest({ text: 'z' })));
            return next(e);
          });
        }
      `,
    })
    await runtime.ready
    expect(reports.filter(r => r.startsWith('probe: '))).toEqual([
      'probe: NotSupportedError: $.prompt.submit is not available: this session takes no prompts from plugins',
      'probe: NotSupportedError: $.prompt.compose is not available: this session takes no prompts from plugins',
      // `read` "never rejects": no page draws this session's box.
      'probe: {"text":"","cursor":0}',
      'probe: {"isFilled":false,"refusal":"no_composer","text":"","cursor":0}',
      'probe: {"isShown":false}',
    ])
  })
})
