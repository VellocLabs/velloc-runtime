/**
 * `$.ui.ask` (F-25): a `tool.call` of `AskUserQuestion` through every hook but the caller's, resolving to the
 * chosen label (multi-select comma-joined) or "Other" text; rejects when dismissed or in a `-p` run. Covers the
 * slot's dialog (`ModUiState.openAsk`), and that no hook budget or `session.start` bound cuts a mod off while the
 * person is asked, while `session.end` refuses a question. The page's half is `mod-ask-page.render`.
 */
import { afterEach, describe, expect, it } from 'vitest'
import { ModRuntime, type ModModuleRef, type ModRuntimeOptions, type ModWorkerHandle } from '../mods/ModRuntime'
import { installModWorkerHost } from '../mods/ModWorkerHost'
import { ModUiState, uiAskArgsOf, type ModUiAsk, type ModUiEvent } from '../mods/modUi'
import {
  MOD_ASK_DEFAULT_HEADER,
  askArgsOfArrived,
  askCoreAnswered,
  askCoreDismissed,
  askOutcomeOf,
  askToolEventOf,
} from '../mods/modAsk'

const open: MessagePort[] = []
const runtimes: ModRuntime[] = []
afterEach(() => {
  for (const runtime of runtimes.splice(0)) runtime.dispose()
  for (const port of open.splice(0)) port.close()
})

describe('the arguments', () => {
  it('labels, or { options, header, multiSelect }; fewer than two padded with Yes/No', () => {
    expect(uiAskArgsOf('How careful?', ['Bold', 'Careful'])).toEqual({
      question: 'How careful?',
      options: [{ label: 'Bold' }, { label: 'Careful' }],
      multiSelect: false,
    })
    expect(uiAskArgsOf('Go on?', undefined)).toEqual({
      question: 'Go on?',
      options: [
        { label: 'Yes', engine: 'yes' },
        { label: 'No', engine: 'no' },
      ],
      multiSelect: false,
    })
    expect(uiAskArgsOf('Ship?', { options: ['Yes'], header: 'Release', multiSelect: true })).toEqual({
      question: 'Ship?',
      header: 'Release',
      options: [{ label: 'Yes' }, { label: 'No', engine: 'no' }],
      multiSelect: true,
    })
    expect(uiAskArgsOf('Which?', ['Only'])).toMatchObject({ options: [{ label: 'Only' }, { label: 'Yes', engine: 'yes' }] })
  })

  it('a blank question, more than four options, a repeated or blank label, a bad header or flag are refused', () => {
    expect(() => uiAskArgsOf('  ', [])).toThrow('question must be a non-empty string')
    expect(() => uiAskArgsOf('Q?', ['a', 'b', 'c', 'd', 'e'])).toThrow('at most 4 options')
    expect(() => uiAskArgsOf('Q?', ['a', 'a'])).toThrow('unique')
    expect(() => uiAskArgsOf('Q?', ['a', ''])).toThrow('non-empty strings')
    expect(() => uiAskArgsOf('Q?', { header: 3 })).toThrow('header must be a string')
    expect(() => uiAskArgsOf('Q?', { multiSelect: 'yes' })).toThrow('multiSelect')
    expect(() => uiAskArgsOf('Q?', 'Bold')).toThrow('options must be')
  })
})

describe("the slot's questions", () => {
  const args = uiAskArgsOf('How careful?', ['Bold', 'Careful'])
  function state(canAsk = true) {
    const events: ModUiEvent[] = []
    const ui = new ModUiState(event => events.push(event), { canAsk })
    const asks = (): ModUiAsk[] | undefined => ui.snapshot().asks
    return { ui, events, asks }
  }

  it('shown until answered; the first answer settles it, a late or empty one is refused', async () => {
    const { ui, events, asks } = state()
    const asked = ui.openAsk('careful', args)
    expect(asks()).toEqual([{ ...args, requestId: 'a1', plugin: 'careful' }])
    expect(events.at(-1)).toMatchObject({ kind: 'state', state: { asks: [{ requestId: 'a1' }] } })
    expect(ui.answerAsk({ requestId: 'a1', answer: '   ' })).toBe(false)
    expect(ui.answerAsk({ requestId: 'a1', answer: 'Bold' })).toBe(true)
    expect(ui.answerAsk({ requestId: 'a1', answer: 'Careful' })).toBe(false)
    await expect(asked).resolves.toBe('Bold')
    expect(asks()).toBeUndefined()
    expect(events.at(-1)).toEqual({ kind: 'state', state: { status: [], notices: [] } })
  })

  it('dismissed rejects with DismissedError; an abandoned call rejects and leaves', async () => {
    const { ui, asks } = state()
    const dismissed = ui.openAsk('careful', args)
    expect(ui.answerAsk({ requestId: 'a1', dismissed: true })).toBe(true)
    await expect(dismissed).rejects.toMatchObject({ name: 'DismissedError' })
    const abort = new AbortController()
    const abandoned = ui.openAsk('careful', args, abort.signal)
    abort.abort()
    await expect(abandoned).rejects.toMatchObject({ name: 'AbortError' })
    expect(asks()).toBeUndefined()
  })

  it("a plugin's seat going takes its questions alone; the session ending takes every one", async () => {
    const { ui, asks } = state()
    const mine = ui.openAsk('careful', args)
    const theirs = ui.openAsk('other', args)
    ui.clearPlugin('careful')
    await expect(mine).rejects.toThrow('the plugin was unloaded')
    expect(asks()?.map(ask => ask.plugin)).toEqual(['other'])
    ui.clear()
    await expect(theirs).rejects.toThrow('the session ended')
    expect(asks()).toBeUndefined()
  })

  it('a session no page draws has no one to ask: the call rejects and nothing is shown', async () => {
    const { ui, events } = state(false)
    await expect(ui.openAsk('careful', args)).rejects.toMatchObject({ name: 'NotSupportedError' })
    expect(events).toEqual([])
  })
})


describe('a question open is a wait on the person', () => {
  it('onAsking at the open; its release once, whether answered, dismissed, abandoned or dropped', async () => {
    let open = 0
    let releases = 0
    const ui = new ModUiState(() => {}, {
      canAsk: true,
      onAsking: () => {
        open += 1
        return () => {
          releases += 1
        }
      },
    })
    const args = uiAskArgsOf('How careful?', ['Bold', 'Careful'])
    const answered = ui.openAsk('careful', args)
    const dismissed = ui.openAsk('careful', args)
    const abort = new AbortController()
    const abandoned = ui.openAsk('careful', args, abort.signal)
    const dropped = ui.openAsk('other', args)
    expect([open, releases]).toEqual([4, 0])
    ui.answerAsk({ requestId: 'a1', answer: 'Bold' })
    ui.answerAsk({ requestId: 'a2', dismissed: true })
    abort.abort()
    ui.clearPlugin('other')
    await Promise.allSettled([answered, dismissed, abandoned, dropped])
    expect([open, releases]).toEqual([4, 4])
  })
})

describe("the tool.call shapes $.ui.ask makes", () => {
  const args = uiAskArgsOf('Go on?', { header: 'A very long chip' })

  it("AskUserQuestion's input: one question, a 12-character chip ('Plugin' when none), empty descriptions", () => {
    expect(args.header).toBe('A very long ')
    expect(askToolEventOf(args, 'modask_1')).toEqual({
      tool: 'AskUserQuestion',
      tool_use_id: 'modask_1',
      questions: [
        {
          question: 'Go on?',
          header: 'A very long ',
          options: [
            { label: 'Yes', description: '' },
            { label: 'No', description: '' },
          ],
          multiSelect: false,
        },
      ],
    })
    const plain = uiAskArgsOf('Which?', ['A', 'B'])
    expect((askToolEventOf(plain, 'x').questions as Array<{ header: string }>)[0]!.header).toBe(MOD_ASK_DEFAULT_HEADER)
  })

  it('the question as it arrived: a rewrite is drawn; what the dialog cannot draw is the call as made', () => {
    const plain = uiAskArgsOf('Which?', ['A', 'B'])
    const event = askToolEventOf(plain, 'x')
    // Unchanged: the call as made — the default chip is not drawn as one.
    expect(askArgsOfArrived(event, plain)).toEqual(plain)
    const rewritten = {
      ...event,
      questions: [{ question: 'Which, really?', header: 'Policy', options: [{ label: 'A' }, { label: 'C' }], multiSelect: true }],
    }
    expect(askArgsOfArrived(rewritten, plain)).toEqual({
      question: 'Which, really?',
      header: 'Policy',
      options: [{ label: 'A' }, { label: 'C' }],
      multiSelect: true,
    })
    expect(askArgsOfArrived({ ...event, questions: [{ question: 'Q?', options: [{ label: 'A' }] }] }, plain)).toEqual(plain)
    expect(askArgsOfArrived({ ...event, questions: 'none' }, plain)).toEqual(plain)
    // A padded label keeps its mark while it is still offered.
    expect(askArgsOfArrived(askToolEventOf(args, 'x'), args).options).toEqual([
      { label: 'Yes', engine: 'yes' },
      { label: 'No', engine: 'no' },
    ])
  })

  it("the answer read back: result.answers[question], a list comma-joined; else the deny, the text, or 'the dialog was dismissed'", () => {
    const plain = uiAskArgsOf('Which?', ['A', 'B'])
    expect(askOutcomeOf(askCoreAnswered(plain, 'B'), 'Which?')).toEqual({ answer: 'B' })
    expect(askOutcomeOf({ result: { answers: { 'Which?': ['A', 'B'] } } }, 'Which?')).toEqual({ answer: 'A, B' })
    // A hook reworded the question: its one answer still comes back.
    expect(askOutcomeOf({ result: { answers: { 'Which, really?': 'A' } } }, 'Which?')).toEqual({ answer: 'A' })
    expect(askOutcomeOf({ deny: 'not now' }, 'Which?')).toEqual({ noAnswer: 'not now' })
    expect(askOutcomeOf(askCoreDismissed(plain), 'Which?')).toEqual({ noAnswer: 'the dialog was dismissed' })
    expect(askOutcomeOf({ result: 'odd' }, 'Which?')).toEqual({ noAnswer: 'the dialog was dismissed' })
  })
})

let uniq = 0
type Page = (ask: ModUiAsk) => { answer: string } | { dismissed: true }
function world(
  modules: Record<string, string>,
  page: Page | null,
  extra: {
    answerAfterMs?: number
    options?: Partial<ModRuntimeOptions>
    session?: (runtime: () => ModRuntime) => Record<string, unknown>
  } = {},
) {
  const reports: string[] = []
  const shown: ModUiAsk[] = []
  let runtime!: ModRuntime
  const refs: ModModuleRef[] = Object.keys(modules).map(plugin => ({ plugin, path: `/plugins/${plugin}/hooks/register.js` }))
  runtime = new ModRuntime({
    modules: refs,
    readModule: async path => `${modules[path.split('/')[2]!]}\n// load ${++uniq}`,
    // The scan, as far as these modules need it: the `$` calls they make.
    scan: async (_ref, source) => ({
      events: [],
      calls: [...new Set([...source.matchAll(/\$\.(\w+)\.(\w+)\(/g)].map(m => `${m[1]}.${m[2]}`))],
    }),
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
    session: { id: () => 's', cwd: () => '/work/project', ...(extra.session?.(() => runtime) ?? {}) },
    report: line => reports.push(line),
    ...(page ? { drawsComposer: true } : {}),
    onUiChanged: (event: ModUiEvent) => {
      if (event.kind !== 'state' || !page) return
      for (const ask of event.state.asks ?? []) {
        if (shown.some(seen => seen.requestId === ask.requestId)) continue
        shown.push(ask)
        // The person answers on a later tick, as a page would.
        setTimeout(() => runtime.askAnswer({ requestId: ask.requestId, ...page(ask) }), extra.answerAfterMs ?? 0)
      }
    },
    ...extra.options,
  })
  runtimes.push(runtime)
  return {
    runtime,
    shown,
    reports,
    logs: (plugin = 'asker') =>
      reports.filter(r => r.startsWith(`${plugin}: {`)).map(r => JSON.parse(r.slice(plugin.length + 2))),
  }
}

const asker = `
  export function register(on) {
    on('session.start', async ($, e, next) => {
      try {
        const answer = await $.ui.ask('How careful?', { options: ['Bold', 'Careful'], header: 'Mode' });
        await $.ui.log(JSON.stringify({ answer }));
      } catch (error) {
        await $.ui.log(JSON.stringify({ error: error.name, message: error.message }));
      }
      return next(e);
    });
  }
`

/** A plugin whose tool.call hook logs every call it sees and lets it run —
 *  or, by the question, answers or denies it itself. */
const watcher = `
  export function register(on) {
    on('tool.call', async ($, e, next) => {
      const q = e.questions && e.questions[0];
      await $.ui.log(JSON.stringify({ saw: e.tool, question: q && q.question, header: q && q.header, labels: q && q.options.map(o => o.label + '|' + o.description) }));
      if (q && q.question === 'Answer for me?') return { result: { answers: { [q.question]: 'Bold' } } };
      if (q && q.question === 'Deny me?') return { deny: 'the watcher refuses' };
      return next(e);
    });
  }
`

describe('the call through the runtime', () => {
  it('a module calling $.ui.ask loads; the page draws the question and the answer is what the call resolves to', async () => {
    const { runtime, shown, logs } = world({ asker }, () => ({ answer: 'Careful' }))
    await runtime.ready
    expect(runtime.status().map(row => row.state)).toEqual(['loaded'])
    expect(shown).toEqual([
      {
        requestId: 'a1',
        plugin: 'asker',
        question: 'How careful?',
        header: 'Mode',
        options: [{ label: 'Bold' }, { label: 'Careful' }],
        multiSelect: false,
      },
    ])
    expect(logs()).toEqual([{ answer: 'Careful' }])
    expect(runtime.uiSnapshot().asks).toBeUndefined()
  })

  it('dismissed, the call rejects with DismissedError', async () => {
    const { runtime, logs } = world({ asker }, () => ({ dismissed: true }))
    await runtime.ready
    expect(logs()).toEqual([{ error: 'DismissedError', message: 'asker: $.ui.ask: no answer (the dialog was dismissed)' }])
  })

  it('a session no page draws: the call rejects, no one to ask', async () => {
    const { runtime, logs } = world({ asker }, null)
    await runtime.ready
    expect(runtime.status().map(row => row.state)).toEqual(['loaded'])
    expect(logs()).toEqual([
      { error: 'NotSupportedError', message: 'asker: $.ui.ask: no one to ask — this session is drawn on no page' },
    ])
  })

  it("raised as a tool.call of AskUserQuestion: other hooks see the AskUserQuestion input — the asker's own tool.call hook too; the calling hook alone is skipped", async () => {
    const selfWatcher = asker.replace(
      "on('session.start'",
      "on('tool.call', async ($, e, next) => { await $.ui.log(JSON.stringify({ own: e.tool })); return next(e); });\n      on('session.start'",
    )
    const { runtime, logs } = world({ asker: selfWatcher, watcher }, () => ({ answer: 'Bold' }))
    await runtime.ready
    expect(logs('watcher')).toEqual([
      { saw: 'AskUserQuestion', question: 'How careful?', header: 'Mode', labels: ['Bold|', 'Careful|'] },
    ])
    // "Every hook but the calling one": the session.start hook that asked is
    // skipped, the same plugin's tool.call hook is not.
    expect(logs()).toEqual([{ own: 'AskUserQuestion' }, { answer: 'Bold' }])
  })

  it('a hook may answer for the person (no dialog is drawn), or deny the question (the call rejects naming why)', async () => {
    const asking = (question: string) =>
      asker.replace("'How careful?'", `'${question}'`)
    const answered = world({ asker: asking('Answer for me?'), watcher }, () => ({ answer: 'Careful' }))
    await answered.runtime.ready
    expect(answered.shown).toEqual([])
    expect(answered.logs()).toEqual([{ answer: 'Bold' }])
    const denied = world({ asker: asking('Deny me?'), watcher }, () => ({ answer: 'Careful' }))
    await denied.runtime.ready
    expect(denied.shown).toEqual([])
    expect(denied.logs()).toEqual([{ error: 'Error', message: 'asker: $.ui.ask: no answer (the watcher refuses)' }])
  })
})

describe('no clock cuts a mod off while the person is asked', () => {
  // A hook budget of 60 ms and a session.start bound of 60 ms; the person
  // takes 300 ms to answer.
  const tight = { budgetMs: 60, startTimeoutMs: 60 }

  it("an open question stops the hook's budget and session.start's bound: the late answer arrives", async () => {
    const { runtime, logs, reports } = world({ asker }, () => ({ answer: 'Careful' }), {
      answerAfterMs: 300,
      options: tight,
    })
    await runtime.ready
    expect(logs()).toEqual([{ answer: 'Careful' }])
    expect(reports.filter(r => /did not finish within|ran out|skipped/.test(r))).toEqual([])
  })

  it('negative control: a hook that waits on its own timer past the bound is cut off', async () => {
    const sleeper = `
      export function register(on) {
        on('session.start', async ($, e, next) => {
          await new Promise(resolve => setTimeout(resolve, 300));
          return next(e);
        });
      }
    `
    const { runtime, reports } = world({ sleeper }, () => ({ answer: 'x' }), { options: { startTimeoutMs: 60 } })
    await runtime.ready
    expect(reports.some(r => r.includes('session.start did not finish within 60ms'))).toBe(true)
  })

  it("a plugin's $.tool.call whose permission prompt is open stops session.start's bound too", async () => {
    const caller = `
      export function register(on) {
        on('session.start', async ($, e, next) => {
          const ran = await $.tool.call({ tool: 'Bash', command: 'ls' });
          await $.ui.log(JSON.stringify({ ran }));
          return next(e);
        });
      }
    `
    const { runtime, logs, reports } = world({ caller }, null, {
      options: { startTimeoutMs: 60 },
      session: rt => ({
        tools: {
          list: async () => [],
          check: async () => ({ decision: 'allow' }),
          // As QueryEngine wraps the permission check: the person is asked
          // for 300 ms, then the tool runs.
          call: () => rt().whileAskingPerson(() => new Promise(resolve => setTimeout(() => resolve('allowed'), 300))),
        },
      }),
    })
    await runtime.ready
    expect(logs('caller')).toEqual([{ ran: 'allowed' }])
    expect(reports.some(r => r.includes('did not finish within'))).toBe(false)
  })

  it("at session.end, whose one short bound is not paused, the question is refused, not cut off", async () => {
    const ender = `
      export function register(on) {
        on('session.end', async ($, e, next) => {
          try {
            await $.ui.ask('Save first?');
          } catch (error) {
            await $.ui.log(JSON.stringify({ error: error.name, message: error.message }));
          }
          return next(e);
        });
      }
    `
    const { runtime, shown, logs } = world({ ender }, () => ({ answer: 'Yes' }))
    await runtime.ready
    await runtime.sessionEnd('clear')
    expect(shown).toEqual([])
    expect(logs('ender')).toEqual([
      { error: 'NotSupportedError', message: 'ender: $.ui.ask: the session is ending — no one is asked' },
    ])
  })
})
