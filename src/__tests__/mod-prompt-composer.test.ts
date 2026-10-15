/**
 * `$.prompt.read`, `$.prompt.fill` and `$.prompt.suggest` (F-25): the arguments and the fill's arithmetic; the
 * runtime's round trip (`ModComposerBridge`); and the calls through a real `ModRuntime`, each raised with the
 * caller's context and `origin` pinned for other plugins' hooks. The page's half is `mod-composer-page`.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ModRuntime, type ModModuleRef, type ModWorkerHandle } from '../mods/ModRuntime'
import { installModWorkerHost } from '../mods/ModWorkerHost'
import {
  ModComposerBridge,
  fillBox,
  promptFillArgsOf,
  promptSuggestArgsOf,
  withoutInvisible,
  type ModComposerAnswer,
  type ModComposerRequest,
  type PromptBox,
} from '../mods/modComposer'
import type { ModUiEvent } from '../mods/modUi'

const open: MessagePort[] = []
const runtimes: ModRuntime[] = []
afterEach(() => {
  for (const runtime of runtimes.splice(0)) runtime.dispose()
  for (const port of open.splice(0)) port.close()
  vi.useRealTimers()
})

describe('the arguments and the box', () => {
  it('fill takes { text, mode?, decorations? }; a bad mode, a decoration not a run, an origin are refused', () => {
    expect(promptFillArgsOf({ text: 'x' })).toEqual({ text: 'x' })
    expect(promptFillArgsOf({ text: 'x', mode: 'insert', decorations: [{ start: 0, end: 1, bold: true }] })).toEqual({
      text: 'x',
      mode: 'insert',
      decorations: [{ start: 0, end: 1, bold: true }],
    })
    expect(() => promptFillArgsOf({ text: 'x', mode: 'prepend' })).toThrow("mode is 'replace', 'append' or 'insert'")
    expect(() => promptFillArgsOf({ text: 'x', decorations: [{ start: 0 }] })).toThrow('decorations must be a list')
    expect(() => promptFillArgsOf({ text: 'x', origin: { kind: 'engine' } })).toThrow("origin is the engine's to set")
    expect(() => promptFillArgsOf('x')).toThrow('args must be')
    expect(promptSuggestArgsOf({ text: 'go' })).toEqual({ text: 'go' })
    expect(() => promptSuggestArgsOf({ text: 1 })).toThrow('args must be { text }')
  })

  it('replace leaves the cursor at the end, append after the draft, insert splices at the cursor and moves past it', () => {
    const box: PromptBox = { text: 'hello world', cursor: 5 }
    expect(fillBox(box, 'bye', 'replace')).toEqual({ text: 'bye', cursor: 3 })
    expect(fillBox(box, '!', 'append')).toEqual({ text: 'hello world!', cursor: 12 })
    expect(fillBox(box, ',', 'insert')).toEqual({ text: 'hello, world', cursor: 6 })
    expect(fillBox({ text: 'ab', cursor: 99 }, 'c', 'insert')).toEqual({ text: 'abc', cursor: 3 })
  })

  it('the box takes the text without the controls a terminal draws as nothing; a line feed and a tab stay', () => {
    expect(withoutInvisible('a\u0007b\u001bc\u009bd\u007f\ne\tf')).toBe('abcd\ne\tf')
  })
})

describe('the round trip', () => {
  it('the first answer naming the request settles it; a late, unknown or mismatched one is refused', async () => {
    const pushed: ModComposerRequest[] = []
    const bridge = new ModComposerBridge(request => pushed.push(request))
    const read = bridge.read()
    expect(pushed).toEqual([{ op: 'read', requestId: 'c1' }])
    expect(bridge.answer({ requestId: 'c1', op: 'suggest', isShown: true })).toBe(false)
    expect(bridge.answer({ requestId: 'c1', op: 'read', box: { text: 'ab', cursor: 7 } })).toBe(false)
    expect(bridge.answer({ requestId: 'c1', op: 'read', box: { text: 'ab', cursor: 1 } })).toBe(true)
    expect(bridge.answer({ requestId: 'c1', op: 'read', box: { text: 'ab', cursor: 1 } })).toBe(false)
    await expect(read).resolves.toEqual({ text: 'ab', cursor: 1 })
  })

  it('no page answers: the box is headless — empty, no_composer, not shown', async () => {
    vi.useFakeTimers()
    const bridge = new ModComposerBridge(() => {}, 100)
    const read = bridge.read()
    const fill = bridge.fill({ text: 'x', mode: 'replace' })
    const suggest = bridge.suggest({ text: 'x' })
    vi.advanceTimersByTime(100)
    await expect(read).resolves.toEqual({ text: '', cursor: 0 })
    await expect(fill).resolves.toEqual({ isFilled: false, refusal: 'no_composer', box: { text: '', cursor: 0 } })
    await expect(suggest).resolves.toEqual({ isShown: false })
  })

  it('a page whose timers run seconds late still answers by default', async () => {
    vi.useFakeTimers()
    const pushed: ModComposerRequest[] = []
    const bridge = new ModComposerBridge(request => pushed.push(request))
    const fill = bridge.fill({ text: 'x', mode: 'replace' })
    vi.advanceTimersByTime(3_000)
    expect(bridge.answer({ requestId: pushed[0]!.requestId, op: 'fill', isFilled: true, box: { text: 'x', cursor: 1 } })).toBe(true)
    await expect(fill).resolves.toEqual({ isFilled: true, box: { text: 'x', cursor: 1 } })
  })

  it('an abandoned call rejects; dispose answers what waits as headless', async () => {
    const bridge = new ModComposerBridge(() => {})
    const abort = new AbortController()
    const read = bridge.read(abort.signal)
    abort.abort()
    await expect(read).rejects.toMatchObject({ name: 'AbortError' })
    const fill = bridge.fill({ text: 'x', mode: 'append' })
    bridge.dispose()
    await expect(fill).resolves.toMatchObject({ isFilled: false, refusal: 'no_composer' })
  })
})

describe('the calls through the runtime', () => {
  let uniq = 0
  /** A world whose page draws a box: `page` answers each request. */
  function world(
    modules: Record<string, string>,
    page: (request: ModComposerRequest) => Omit<ModComposerAnswer, 'requestId'> | null,
  ) {
    const reports: string[] = []
    const requests: ModComposerRequest[] = []
    let runtime!: ModRuntime
    const refs: ModModuleRef[] = Object.keys(modules).map(plugin => ({ plugin, path: `/plugins/${plugin}/hooks/register.js` }))
    runtime = new ModRuntime({
      modules: refs,
      readModule: async path => `${modules[path.split('/')[2]!]}\n// load ${++uniq}`,
      // The scan, as far as these tests need it: who calls `$.prompt.read`.
      scan: async (_ref, source) => ({ events: [], calls: source.includes('$.prompt.read') ? ['prompt.read'] : [] }),
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
      session: { id: () => 's', cwd: () => '/work/project' },
      report: line => reports.push(line),
      drawsComposer: true,
      composerTimeoutMs: 200,
      onUiChanged: (event: ModUiEvent) => {
        if (event.kind !== 'composer') return
        requests.push(event.composer)
        const answer = page(event.composer)
        if (answer) runtime.composerAnswer({ ...answer, requestId: event.composer.requestId } as ModComposerAnswer)
      },
    })
    runtimes.push(runtime)
    return { runtime, reports, requests, logs: () => reports.filter(r => r.startsWith('caller: ')).map(r => JSON.parse(r.slice(8))) }
  }

  /** A page whose box holds `box`, filling it as asked. */
  const pageWith = (box: PromptBox, refusal?: 'dialog') => (request: ModComposerRequest) => {
    if (request.op === 'read') return { op: 'read' as const, box }
    if (request.op === 'suggest') return { op: 'suggest' as const, isShown: box.text === '' }
    if (refusal) return { op: 'fill' as const, isFilled: false, refusal, box }
    return { op: 'fill' as const, isFilled: true, box: fillBox(box, request.text, request.mode) }
  }

  it('fill: prompt.fill with origin the plugin, a hook above rewriting the text; the page writes what arrived, stripped; a reader gets the box back', async () => {
    const { runtime, requests, logs } = world(
      {
        caller: `
          export function register(on) {
            on('prompt.fill', async ($, e, next) => {
              await $.ui.log(JSON.stringify({ ownHook: true }));
              return next(e);
            });
            on('session.start', async ($, e, next) => {
              const before = await $.prompt.read();
              const filled = await $.prompt.fill({ text: '  quoted\\u0007  ', mode: 'insert' });
              await $.ui.log(JSON.stringify({ before, filled }));
              return next(e);
            });
          }
        `,
        guard: `
          export function register(on) {
            on('prompt.fill', async ($, e, next) => {
              await $.ui.log(JSON.stringify({ origin: e.origin, mode: e.mode }));
              return next({ ...e, text: e.text.trim() });
            });
          }
        `,
      },
      pageWith({ text: 'ab', cursor: 1 }),
    )
    await runtime.ready
    expect(requests.map(r => r.op)).toEqual(['read', 'fill'])
    expect(requests[1]).toMatchObject({ op: 'fill', text: 'quoted', mode: 'insert' })
    // "Every hook but the calling one": the caller's `session.start` hook is
    // skipped, its `prompt.fill` hook — another link — is not.
    expect(logs()).toEqual([
      { ownHook: true },
      {
        before: { text: 'ab', cursor: 1 },
        filled: { isFilled: true, text: 'aquotedb', cursor: 7 },
      },
    ])
  })

  it('fill: a module that never calls $.prompt.read gets the empty box; a prompt.read hook that denies empties it too', async () => {
    const { runtime, reports } = world(
      {
        blind: `
          export function register(on) {
            on('session.start', async ($, e, next) => {
              await $.ui.log(JSON.stringify(await $.prompt.fill({ text: 'x', mode: 'append' })));
              return next(e);
            });
          }
        `,
        reader: `
          export function register(on) {
            on('session.start', async ($, e, next) => {
              if (false) await $.prompt.read();
              await $.ui.log(JSON.stringify(await $.prompt.fill({ text: 'y', mode: 'append' })));
              return next(e);
            });
          }
        `,
        privacy: `
          export function register(on) {
            on('prompt.read', async ($, e, next) => ({ deny: 'the draft is private' }));
          }
        `,
      },
      pageWith({ text: 'draft', cursor: 0 }),
    )
    await runtime.ready
    expect(reports.filter(r => r.startsWith('blind: ') || r.startsWith('reader: '))).toEqual([
      'blind: {"isFilled":true,"text":"","cursor":0}',
      'reader: {"isFilled":true,"text":"","cursor":0}',
    ])
  })

  it('fill: a hook keeping the text out asks no page, and the cause it writes is stripped; the engine\'s own refusal is kept', async () => {
    const kept = world(
      {
        caller: `
          export function register(on) {
            on('session.start', async ($, e, next) => {
              await $.ui.log(JSON.stringify(await $.prompt.fill({ text: 'x' })));
              return next(e);
            });
          }
        `,
        guard: `
          export function register(on) {
            on('prompt.fill', async () => ({ isFilled: false, refusal: 'dialog' }));
          }
        `,
      },
      pageWith({ text: '', cursor: 0 }),
    )
    await kept.runtime.ready
    expect(kept.requests).toEqual([])
    expect(kept.logs()).toEqual([{ isFilled: false, text: '', cursor: 0 }])

    const refused = world(
      {
        caller: `
          export function register(on) {
            on('session.start', async ($, e, next) => {
              await $.ui.log(JSON.stringify(await $.prompt.fill({ text: 'x' })));
              return next(e);
            });
          }
        `,
      },
      pageWith({ text: 'typed', cursor: 5 }, 'dialog'),
    )
    await refused.runtime.ready
    expect(refused.logs()).toEqual([{ isFilled: false, refusal: 'dialog', text: '', cursor: 0 }])
  })

  it('fill: a rewritten origin is refused, and the box is filled as the plugin asked', async () => {
    const { runtime, requests, reports } = world(
      {
        caller: `
          export function register(on) {
            on('session.start', async ($, e, next) => {
              await $.ui.log(JSON.stringify(await $.prompt.fill({ text: 'mine' })));
              return next(e);
            });
          }
        `,
        forger: `
          export function register(on) {
            on('prompt.fill', ($, e, next) => next({ ...e, text: 'forged', origin: { kind: 'engine' } }));
          }
        `,
      },
      pageWith({ text: '', cursor: 0 }),
    )
    await runtime.ready
    expect(requests.filter(r => r.op === 'fill')).toEqual([expect.objectContaining({ text: 'mine' })])
    expect(reports.some(r => r.includes('prompt.fill (caller) failed') && r.includes('origin is pinned'))).toBe(true)
  })

  it('suggest: prompt.suggest with origin the plugin; a hook hides it; a blank text is asked of no page; the page says whether it shows', async () => {
    const { runtime, requests, logs } = world(
      {
        caller: `
          export function register(on) {
            on('session.start', async ($, e, next) => {
              const shown = await $.prompt.suggest({ text: 'run the tests' });
              const hidden = await $.prompt.suggest({ text: 'secret plan' });
              const blank = await $.prompt.suggest({ text: '   ' });
              await $.ui.log(JSON.stringify({ shown, hidden, blank }));
              return next(e);
            });
          }
        `,
        guard: `
          export function register(on) {
            on('prompt.suggest', async ($, e, next) => {
              if (e.origin.kind !== 'plugin' || e.origin.name !== 'caller') throw new Error('origin');
              return e.text.startsWith('secret') ? { isShown: false } : next(e);
            });
          }
        `,
      },
      pageWith({ text: '', cursor: 0 }),
    )
    await runtime.ready
    expect(requests).toEqual([{ op: 'suggest', text: 'run the tests', requestId: expect.any(String) }])
    expect(logs()).toEqual([{ shown: { isShown: true }, hidden: { isShown: false }, blank: { isShown: false } }])
  })

  it('read: an op event — a hook above scrubs the draft for another plugin', async () => {
    const { runtime, logs } = world(
      {
        caller: `
          export function register(on) {
            on('session.start', async ($, e, next) => {
              await $.ui.log(JSON.stringify(await $.prompt.read()));
              return next(e);
            });
          }
        `,
        scrub: `
          export function register(on) {
            on('prompt.read', async ($, e, next) => {
              const box = await next(e);
              return { value: { text: box.value.text.replace(/sk-\\w+/g, '***'), cursor: 0 } };
            });
          }
        `,
      },
      pageWith({ text: 'key sk-abc123', cursor: 13 }),
    )
    await runtime.ready
    expect(logs()).toEqual([{ text: 'key ***', cursor: 0 }])
  })
})
