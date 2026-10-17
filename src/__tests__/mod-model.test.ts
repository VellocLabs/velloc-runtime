/**
 * `$.model` (F-25) — the argument checks, `modModelHost` over a
 * fake runner (the arms, the timeout, the plugin's signal, a thrown
 * transport), `classify` over `complete` (the fixed prompt, the label read,
 * a failed completion rejecting), and the noun through a real `ModRuntime`:
 * a guard hooking `model.complete` by its model, bad arguments refused by
 * name, a host without a transport refusing the noun.
 */
import { afterEach, describe, expect, it } from 'vitest'
import { ModRuntime, type ModModuleRef, type ModWorkerHandle } from '../mods/ModRuntime'
import { installModWorkerHost } from '../mods/ModWorkerHost'
import type { ModNounHost } from '../mods/modNouns'
import {
  MODEL_DEFAULT_MAX_TOKENS,
  classifierPrompt,
  classifyWith,
  labelOf,
  modModelHost,
  modelClassifyInput,
  modelCompleteInput,
  modelForkInput,
  sendableBlocks,
  usageOf,
  zeroUsage,
  type ModModelRunner,
  type ModelForkOutcome,
  type ModelOneShot,
  type ModelOneShotOutcome,
} from '../mods/modModel'

const open: MessagePort[] = []
const runtimes: ModRuntime[] = []
afterEach(() => {
  for (const runtime of runtimes.splice(0)) runtime.dispose()
  for (const port of open.splice(0)) port.close()
})

const USAGE = { input_tokens: 10, output_tokens: 3, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }

function fakeRunner(
  answer: (ask: ModelOneShot) => ModelOneShotOutcome | Promise<ModelOneShotOutcome> = () => ({ kind: 'answered', text: 'hello', usage: USAGE }),
  fork: (ask: { prompt: string }) => ModelForkOutcome = () => ({ kind: 'nothing-to-fork' }),
) {
  const asks: ModelOneShot[] = []
  const forks: string[] = []
  const runner: ModModelRunner = {
    complete: async ask => {
      asks.push(ask)
      return answer(ask)
    },
    fork: async ask => {
      forks.push(ask.prompt)
      return fork(ask)
    },
    fastModel: () => 'fast-1',
  }
  return { runner, asks, forks }
}

describe('the inputs', () => {
  it('complete: the request checked field by field, copied', () => {
    expect(modelCompleteInput([{ model: 'haiku', prompt: 'p', system: 's', maxTokens: 5, effort: 'low', timeoutMs: 100, extra: 1 }])).toEqual({
      model: 'haiku',
      prompt: 'p',
      system: 's',
      maxTokens: 5,
      effort: 'low',
      timeoutMs: 100,
    })
    expect(() => modelCompleteInput(['p'])).toThrow(TypeError)
    expect(() => modelCompleteInput([{ prompt: 'p' }])).toThrow(/request\.model/)
    expect(() => modelCompleteInput([{ model: 'm', prompt: 'p', maxTokens: 64001 }])).toThrow(/maxTokens/)
    expect(() => modelCompleteInput([{ model: 'm', prompt: 'p', effort: 'huge' }])).toThrow(/effort/)
    expect(() => modelCompleteInput([{ model: 'm', prompt: 'p', timeoutMs: 1.5 }])).toThrow(/timeoutMs/)
  })

  it('complete: prompt and system as blocks, joined with nothing between, the blocks kept beside', () => {
    const blocks = [{ text: 'RULES\n', cache: true }, { text: 'diff' }]
    expect(modelCompleteInput([{ model: 'm', prompt: blocks, system: [{ text: 'be ' }, { text: 'brief', cache: true }] }])).toEqual({
      model: 'm',
      prompt: 'RULES\ndiff',
      promptBlocks: [{ text: 'RULES\n', cache: true }, { text: 'diff' }],
      system: 'be brief',
      systemBlocks: [{ text: 'be ' }, { text: 'brief', cache: true }],
    })
    // A hook's `e` passed down: the string with its blocks beside it.
    expect(modelCompleteInput([{ model: 'm', prompt: 'RULES\ndiff', promptBlocks: blocks }])).toMatchObject({ prompt: 'RULES\ndiff', promptBlocks: blocks })
    expect(modelCompleteInput([{ model: 'm', prompt: 'p' }])).not.toHaveProperty('promptBlocks')
    for (const none of [null, false]) expect(modelCompleteInput([{ model: 'm', prompt: 'p', system: none }])).toEqual({ model: 'm', prompt: 'p' })
    expect(() => modelCompleteInput([{ model: 'm', prompt: [{ text: 1 }] }])).toThrow('$.model.complete: request.prompt[0].text must be a string')
    expect(() => modelCompleteInput([{ model: 'm', prompt: [{ text: 'a', cache: false }] }])).toThrow('request.prompt[0].cache must be true or left out')
    expect(() => modelCompleteInput([{ model: 'm', prompt: 3 }])).toThrow('request.prompt must be a string or a list of { text, cache? }')
    expect(() => modelCompleteInput([{ model: 'm', prompt: 'p', promptBlocks: 'x' }])).toThrow('request.promptBlocks must be')
  })

  it('the blocks sent: those that still open the prompt, marks kept; the rest one unmarked block', () => {
    const blocks = [{ text: 'RULES', cache: true as const }, { text: ' and ' }, { text: 'diff', cache: true as const }]
    expect(sendableBlocks('RULES and diff', blocks)).toEqual(blocks)
    expect(sendableBlocks('RULES and diff' + ' NOTE', blocks)).toEqual([...blocks, { text: ' NOTE' }])
    expect(sendableBlocks('RULES and patch', blocks)).toEqual([blocks[0], blocks[1], { text: 'patch' }])
    expect(sendableBlocks('NEW RULES and diff', blocks)).toEqual([{ text: 'NEW RULES and diff' }])
    expect(sendableBlocks('RULES', blocks)).toEqual([blocks[0]])
  })

  it('classify and fork', () => {
    expect(modelClassifyInput(['t', ['a', 'b'], { model: 'x' }])).toEqual({ text: 't', labels: ['a', 'b'], options: { model: 'x' } })
    expect(modelClassifyInput(['t', ['a', 'b']])).toEqual({ text: 't', labels: ['a', 'b'] })
    expect(() => modelClassifyInput(['t', ['a']])).toThrow(/labels/)
    expect(() => modelClassifyInput(['t', ['a', 'A']])).toThrow(/labels/)
    expect(modelForkInput([{ prompt: 'q' }])).toEqual({ prompt: 'q' })
    expect(() => modelForkInput([{}])).toThrow(/prompt/)
  })

  it('usage: the four counts, a missing one zero', () => {
    expect(usageOf({ input_tokens: 4, output_tokens: 'x', other: 1 })).toEqual({ ...zeroUsage(), input_tokens: 4 })
  })
})

describe('modModelHost', () => {
  it('fills the cap, forwards the request, and answers each arm', async () => {
    const { runner, asks } = fakeRunner()
    const host = modModelHost(runner)
    expect(await host.complete({ model: 'haiku', prompt: 'p' }, {})).toEqual({ isAnswered: true, text: 'hello', usage: USAGE })
    expect(asks[0]).toMatchObject({ model: 'haiku', prompt: 'p', maxTokens: MODEL_DEFAULT_MAX_TOKENS })
    expect(asks[0]!.signal).toBeInstanceOf(AbortSignal)
    const failing = modModelHost(fakeRunner(() => ({ kind: 'api-error', error: 'rate_limit', status: 429, usage: zeroUsage() })).runner)
    expect(await failing.complete({ model: 'm', prompt: 'p' }, {})).toEqual({
      isAnswered: false,
      reason: 'api-error',
      status: 429,
      error: 'rate_limit',
      usage: zeroUsage(),
    })
    const silent = modModelHost(fakeRunner(() => ({ kind: 'empty-reply', usage: USAGE })).runner)
    expect(await silent.complete({ model: 'm', prompt: 'p' }, {})).toEqual({ isAnswered: false, reason: 'empty-reply', usage: USAGE })
  })

  it("forwards the prompt's blocks as sent; a plain string sends none", async () => {
    const { runner, asks } = fakeRunner()
    const host = modModelHost(runner)
    await host.complete({ model: 'm', prompt: 'RULES diff NOTE', promptBlocks: [{ text: 'RULES ', cache: true }, { text: 'diff' }] }, {})
    await host.complete({ model: 'm', prompt: 'p' }, {})
    expect(asks[0]!.prompt).toBe('RULES diff NOTE')
    expect(asks[0]!.promptBlocks).toEqual([{ text: 'RULES ', cache: true }, { text: 'diff' }, { text: ' NOTE' }])
    expect(asks[1]).not.toHaveProperty('promptBlocks')
  })

  it('a bad request rejects by name; a transport that throws is an api-error, not a rejection', async () => {
    const thrower = modModelHost(fakeRunner(() => Promise.reject(new Error('socket closed'))).runner)
    await expect(thrower.complete({ model: 'm', prompt: 1 as unknown as string }, {})).rejects.toThrow(TypeError)
    expect(await thrower.complete({ model: 'm', prompt: 'p' }, {})).toMatchObject({ isAnswered: false, reason: 'api-error', error: 'unknown', status: null })
  })

  it("`timeoutMs` and the call's signal cut it: `aborted`, the runner's signal fired", async () => {
    const slow = fakeRunner(
      ask =>
        new Promise<ModelOneShotOutcome>((resolve, reject) => {
          ask.signal.addEventListener('abort', () => reject(new Error('cut')))
          setTimeout(() => resolve({ kind: 'answered', text: 'late', usage: USAGE }), 500)
        }),
    )
    const host = modModelHost(slow.runner)
    expect(await host.complete({ model: 'm', prompt: 'p', timeoutMs: 10 }, {})).toEqual({ isAnswered: false, reason: 'aborted', usage: zeroUsage() })
    expect(slow.asks[0]!.signal.aborted).toBe(true)
    const controller = new AbortController()
    const pending = host.complete({ model: 'm', prompt: 'p' }, { signal: controller.signal })
    controller.abort()
    expect(await pending).toMatchObject({ reason: 'aborted' })
    // Already aborted: no request is made.
    const count = slow.asks.length
    expect(await host.complete({ model: 'm', prompt: 'p' }, { signal: controller.signal })).toMatchObject({ reason: 'aborted' })
    expect(slow.asks).toHaveLength(count)
  })

  it('fork: nothing-to-fork, else the completion', async () => {
    const { runner, forks } = fakeRunner(undefined, () => ({ kind: 'answered', text: 'forked', usage: USAGE }))
    const host = modModelHost(runner)
    expect(await host.fork({ prompt: 'q' }, {})).toEqual({ isAnswered: true, text: 'forked', usage: USAGE })
    expect(forks).toEqual(['q'])
    const empty = modModelHost(fakeRunner().runner)
    expect(await empty.fork({ prompt: 'q' }, {})).toEqual({ isAnswered: false, reason: 'nothing-to-fork' })
  })
})

describe('classify over complete', () => {
  const classify = (host: ReturnType<typeof modModelHost>, input: Parameters<typeof classifyWith>[2]) =>
    classifyWith(request => host.complete(request, {}), host.fastModel(), input)

  it('the fixed prompt on the fast model at low effort; the label read case-insensitively; none → undefined', async () => {
    const { runner, asks } = fakeRunner(() => ({ kind: 'answered', text: ' "Bug". \n', usage: USAGE }))
    const host = modModelHost(runner)
    expect(await classify(host, { text: 'it crashes', labels: ['bug', 'feature'] })).toBe('bug')
    expect(asks[0]).toMatchObject({ model: 'fast-1', effort: 'low', ...classifierPrompt('it crashes', ['bug', 'feature']) })
    expect(asks[0]!.prompt).toContain('<<<\nit crashes\n>>>')
    const other = modModelHost(fakeRunner(() => ({ kind: 'answered', text: 'neither of those', usage: USAGE })).runner)
    expect(await classify(other, { text: 't', labels: ['bug', 'feature'], options: { model: 'big' } })).toBeUndefined()
    expect(labelOf('feature\nbecause…', ['bug', 'feature'])).toBe('feature')
    expect(labelOf('', ['bug', 'feature'])).toBeUndefined()
  })

  it('a completion that did not answer rejects, naming the cause', async () => {
    const host = modModelHost(fakeRunner(() => ({ kind: 'api-error', error: 'overloaded', status: 529, usage: zeroUsage() })).runner)
    await expect(classify(host, { text: 't', labels: ['a', 'b'] })).rejects.toThrow(/api-error \(overloaded 529\)/)
  })
})

describe('$.model through the runtime', () => {
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

  it("a mod completes and classifies; another plugin's model.complete hook rewrites the model or denies by it; the signal option does not cross; bad arguments are refused by name", async () => {
    const { runner, asks } = fakeRunner(ask => ({ kind: 'answered', text: ask.prompt.startsWith('Labels:') ? 'b' : `${ask.model} says hi`, usage: USAGE }))
    const { runtime, reports } = world(
      {
        guard: `
          export function register(on) {
            on('model.complete', ($, e, next) => e.model === 'opus' ? { deny: 'GUARD: too dear' } : next({ ...e, model: 'cheap-' + e.model }));
          }
        `,
        asker: `
          export function register(on) {
            on('prompt.submit', async ($, e, next) => {
              const stop = new AbortController();
              const ok = await $.model.complete({ model: 'haiku', prompt: 'hi', maxTokens: 8 }, { signal: stop.signal });
              const denied = await $.model.complete({ model: 'opus', prompt: 'hi' }).catch(err => err.message);
              const kind = await $.model.classify('it broke', ['a', 'b']);
              const forked = await $.model.fork({ prompt: 'q' });
              const bad = await $.model.complete({ prompt: 'no model' }).catch(err => err.name + ': ' + err.message);
              await $.ui.log(JSON.stringify({ ok, denied, kind, forked, bad }));
              return next(e);
            });
          }
        `,
      },
      { completions: modModelHost(runner) },
    )
    await runtime.ready
    await runtime.promptSubmit('go')
    const line = reports.find(r => r.startsWith('asker: {'))!
    expect(JSON.parse(line.slice('asker: '.length))).toEqual({
      ok: { isAnswered: true, text: 'cheap-haiku says hi', usage: USAGE },
      denied: 'GUARD: too dear',
      kind: 'b',
      forked: { isAnswered: false, reason: 'nothing-to-fork' },
      bad: 'TypeError: $.model.complete: request.model must be a model alias or id',
    })
    // The denied request never reached the transport; the classify ran on the fast model.
    expect(asks.map(a => [a.model, a.maxTokens])).toEqual([
      ['cheap-haiku', 8],
      ['cheap-fast-1', 1024],
    ])
  })

  it('a hook reads the prompt joined and the blocks beside it; text it adds after them leaves their marks', async () => {
    const { runner, asks } = fakeRunner()
    const { runtime, reports } = world(
      {
        guard: `
          export function register(on) {
            on('model.complete', async ($, e, next) => {
              await $.ui.log(JSON.stringify({ prompt: e.prompt, promptBlocks: e.promptBlocks, system: e.system, systemBlocks: e.systemBlocks }));
              return next({ ...e, prompt: e.prompt + ' NOTE' });
            });
          }
        `,
        asker: `
          export function register(on) {
            on('prompt.submit', async ($, e, next) => {
              await $.model.complete({ model: 'm', prompt: [{ text: 'RULES', cache: true }, { text: ' diff' }], system: 'brief' });
              return next(e);
            });
          }
        `,
      },
      { completions: modModelHost(runner) },
    )
    await runtime.ready
    await runtime.promptSubmit('go')
    const line = reports.find(r => r.startsWith('guard: {'))!
    expect(JSON.parse(line.slice('guard: '.length))).toEqual({
      prompt: 'RULES diff',
      promptBlocks: [{ text: 'RULES', cache: true }, { text: ' diff' }],
      system: 'brief',
    })
    expect(asks[0]).toMatchObject({
      prompt: 'RULES diff NOTE',
      promptBlocks: [{ text: 'RULES', cache: true }, { text: ' diff' }, { text: ' NOTE' }],
      system: 'brief',
    })
  })

  it("the plugin's own signal resolves the call `aborted` in the hook — mid-call or already aborted — never a throw", async () => {
    const { runner } = fakeRunner(
      ask =>
        new Promise((_resolve, reject) => {
          ask.signal.addEventListener('abort', () => reject(new Error('cut')))
        }),
    )
    const { runtime, reports } = world(
      {
        stopper: `
          export function register(on) {
            on('prompt.submit', async ($, e, next) => {
              const stop = new AbortController();
              setTimeout(() => stop.abort(), 20);
              const mid = await $.model.complete({ model: 'haiku', prompt: 'slow' }, { signal: stop.signal }).catch(err => 'threw ' + err.name);
              const before = await $.model.complete({ model: 'haiku', prompt: 'p' }, { signal: stop.signal }).catch(err => 'threw ' + err.name);
              await $.ui.log(JSON.stringify({ mid: mid.reason ?? mid, before: before.reason ?? before }));
              return next(e);
            });
          }
        `,
      },
      { completions: modModelHost(runner) },
    )
    await runtime.ready
    await runtime.promptSubmit('go')
    const line = reports.find(r => r.startsWith('stopper: {'))!
    expect(JSON.parse(line.slice('stopper: '.length))).toEqual({ mid: 'aborted', before: 'aborted' })
  })

  it('a host without a transport refuses the noun by name', async () => {
    const { runtime, reports } = world({
      probe: `
        export function register(on) {
          on('prompt.submit', async ($, e, next) => {
            await $.ui.log(await $.model.complete({ model: 'haiku', prompt: 'p' }).catch(err => err.name + ': ' + err.message));
            return next(e);
          });
        }
      `,
    })
    await runtime.ready
    await runtime.promptSubmit('go')
    expect(reports).toEqual(['probe: NotSupportedError: $.model is not available: this session has no model transport'])
  })
})
