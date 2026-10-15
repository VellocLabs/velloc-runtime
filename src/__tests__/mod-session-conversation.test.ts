/**
 * `$.session.compact`, `$.session.send` and `$.session.append` (F-25): each is the plugin's own call of its event,
 * raised with the caller's context so every other hook sees it. The engine's half is `query-engine-mods.test.ts`.
 */
import { afterEach, describe, expect, it } from 'vitest'
import { ModRuntime, type ModModuleRef, type ModWorkerHandle } from '../mods/ModRuntime'
import { installModWorkerHost } from '../mods/ModWorkerHost'
import type { ModNounHost } from '../mods/modNouns'
import { describeAppendRow, type StoredRow } from '../mods/sessionAppendEvent'
import { tokensBeforeOf } from '../mods/sessionCompactEvent'
import {
  appendRefusal,
  compactCallResultOf,
  sessionAppendArgsOf,
  sessionCompactArgsOf,
  sessionSendArgsOf,
  type ModConversationHost,
} from '../mods/sessionNouns'

const open: MessagePort[] = []
const runtimes: ModRuntime[] = []
afterEach(() => {
  for (const runtime of runtimes.splice(0)) runtime.dispose()
  for (const port of open.splice(0)) port.close()
})

const ROWS: StoredRow[] = [
  { type: 'user', uuid: 'u1', message: { role: 'user', content: 'Read the file.' } },
  { type: 'assistant', uuid: 'a1', message: { role: 'assistant', content: [{ type: 'text', text: 'It says hello.' }] } },
]
const BOUNDARY: StoredRow = { type: 'system', uuid: 'b1', subtype: 'compact_boundary', compactMetadata: { preTokens: 1200 } }
const SUMMARY: StoredRow = { type: 'user', uuid: 's1', isMeta: true, message: { role: 'user', content: 'SUMMARY' } }

describe('the arguments', () => {
  it('compact takes { instructions? }; send { to, text }, to a name, { sessionId } or { agentId }', () => {
    expect(sessionCompactArgsOf(undefined)).toEqual({})
    expect(sessionCompactArgsOf({ instructions: 'the plan' })).toEqual({ instructions: 'the plan' })
    expect(sessionCompactArgsOf({ instructions: '  ' })).toEqual({})
    expect(() => sessionCompactArgsOf({ instructions: 3 })).toThrow('instructions must be a string')
    expect(sessionSendArgsOf({ to: 'alice', text: 'hi' })).toEqual({ to: 'alice', text: 'hi' })
    expect(sessionSendArgsOf({ to: { agentId: 'teammate-1' }, text: 'hi' })).toEqual({ to: { agentId: 'teammate-1' }, text: 'hi' })
    expect(sessionSendArgsOf({ to: { sessionId: 's2' }, text: 'hi' })).toEqual({ to: { sessionId: 's2' }, text: 'hi' })
    expect(() => sessionSendArgsOf({ to: 'alice', text: ' ' })).toThrow('text must be a non-empty string')
    expect(() => sessionSendArgsOf({ to: { agentId: 'a', sessionId: 'b' }, text: 'hi' })).toThrow('to must be a name')
  })

  it('append takes { message: { type, content }, agentId? }; the bottom refuses all but text blocks, and a notice of more than one', () => {
    const note = { type: 'user' as const, content: [{ type: 'text', text: 'note' }] }
    expect(sessionAppendArgsOf({ message: note })).toEqual({ message: note })
    expect(() => sessionAppendArgsOf({ message: { type: 'assistant', content: [] } })).toThrow('message.type must be "user" or "system"')
    expect(() => sessionAppendArgsOf({ message: note, agentId: '' })).toThrow('agentId must be a non-empty string')
    expect(appendRefusal(note)).toBeNull()
    expect(appendRefusal({ type: 'user', content: [] })).toBe('message.content holds no block')
    expect(appendRefusal({ type: 'user', content: [{ type: 'image', source: {} }] })).toBe(
      'message.content holds a image block: text blocks alone',
    )
    expect(appendRefusal({ type: 'system', content: [{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }] })).toBe(
      'a notice is one text block',
    )
  })

  it("compact's answer is the rows after the boundary, without handles, with the tokens the boundary recorded", () => {
    expect(compactCallResultOf([SUMMARY], tokensBeforeOf(BOUNDARY))).toEqual({
      messages: [{ role: 'user', text: 'SUMMARY', toolUses: [] }],
      tokensBefore: 1200,
    })
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

  /** The engine's half, as `QueryEngine.modConversation` does it, over the
   *  runtime's own event methods. */
  function engineHalf() {
    let runtime!: ModRuntime
    const delivered: Array<{ to: string; text: string }> = []
    const compacted: Array<{ instructions?: string; rows: number }> = []
    const stored: StoredRow[] = []
    const conversation: ModConversationHost = {
      compact: async (args, raise) => {
        const settled = await runtime.sessionCompact(
          { trigger: 'plugin', ...args, messages: ROWS },
          {
            run: async e => {
              compacted.push({ ...(e.instructions !== undefined ? { instructions: e.instructions } : {}), rows: e.messages.length })
              return { boundaryMarker: BOUNDARY, summaryMessages: [SUMMARY] }
            },
            boundary: () => BOUNDARY,
          },
          raise.signal,
          raise.context,
        )
        if ('skip' in settled) return { skip: settled.skip }
        if ('error' in settled) throw new Error(settled.error)
        return compactCallResultOf(settled.summaryMessages, tokensBeforeOf(settled.boundaryMarker))
      },
      send: (args, raise) =>
        runtime.sessionSend(
          { to: String(args.to), text: args.text, origin: { kind: 'plugin', name: raise.context.origin.plugin } },
          e => {
            delivered.push(e)
            return { isDelivered: true }
          },
          raise.signal,
          raise.context,
        ),
      append: async (args, raise) => {
        const row: StoredRow = { type: 'user', uuid: `n${stored.length + 1}`, isMeta: true, message: { role: 'user', content: args.message.content } }
        const outcome = await runtime.appendNote(row, raise)
        if ('deny' in outcome) return { deny: outcome.deny }
        stored.push(outcome.row)
        const described = describeAppendRow(outcome.row)!
        return { message: described.message, uuid: described.uuid }
      },
    }
    return {
      conversation,
      delivered,
      compacted,
      stored,
      bind: (r: ModRuntime) => {
        runtime = r
      },
    }
  }

  it('compact: the event with trigger plugin and the instructions, every hook but the calling one; core compacts; a skip is the answer', async () => {
    const half = engineHalf()
    const { runtime, reports } = world(
      {
        caller: `
          export function register(on) {
            on('prompt.submit', async ($, e, next) => {
              const done = await $.session.compact({ instructions: 'the plan' });
              const vetoed = await $.session.compact({ instructions: 'veto me' });
              await $.ui.log(JSON.stringify({ done, vetoed }));
              return next(e);
            });
          }
        `,
        watcher: `
          export function register(on) {
            on('session.compact', async ($, e, next) => {
              await $.ui.log(JSON.stringify({ trigger: e.trigger, instructions: e.instructions, rows: e.messages.length, origin: next.origin.plugin }));
              if (e.instructions === 'veto me') return { skip: 'not now' };
              return next({ ...e, instructions: e.instructions + ' (and names)' });
            });
          }
        `,
      },
      { conversation: half.conversation },
    )
    half.bind(runtime)
    await runtime.ready
    await runtime.promptSubmit('go')
    const logs = reports.filter(r => r.startsWith('watcher: {') || r.startsWith('caller: {')).map(r => JSON.parse(r.slice(r.indexOf('{'))))
    expect(logs).toEqual([
      { trigger: 'plugin', instructions: 'the plan', rows: 2, origin: 'caller' },
      { trigger: 'plugin', instructions: 'veto me', rows: 2, origin: 'caller' },
      {
        done: { messages: [{ role: 'user', text: 'SUMMARY', toolUses: [] }], tokensBefore: 1200 },
        vetoed: { skip: 'not now' },
      },
    ])
    expect(half.compacted).toEqual([{ instructions: 'the plan (and names)', rows: 2 }])
  })

  it('send: the event with origin the plugin; another hook stamps it; a hook that sends from session.send is not raised again for its own copy', async () => {
    const half = engineHalf()
    const { runtime, reports } = world(
      {
        caller: `
          export function register(on) {
            on('prompt.submit', async ($, e, next) => {
              const sent = await $.session.send({ to: 'alice', text: 'hello' });
              const refused = await $.session.send({ to: 'prod', text: 'deploy' });
              await $.ui.log(JSON.stringify({ sent, refused }));
              return next(e);
            });
          }
        `,
        audit: `
          export function register(on) {
            on('session.send', async ($, e, next) => {
              await $.ui.log(JSON.stringify({ to: e.to, origin: e.origin }));
              if (e.to === 'prod') return { isDelivered: false, reason: 'not from here' };
              if (e.to === 'alice') await $.session.send({ to: 'audit-log', text: 'copy: ' + e.text });
              return next({ ...e, text: '[audited] ' + e.text });
            });
          }
        `,
      },
      { conversation: half.conversation },
    )
    half.bind(runtime)
    await runtime.ready
    await runtime.promptSubmit('go')
    const logs = reports.filter(r => /^(audit|caller): \{/.test(r)).map(r => JSON.parse(r.slice(r.indexOf('{'))))
    expect(logs).toEqual([
      // The copy the audit hook sends is not raised to the audit hook again:
      // it is the calling hook.
      { to: 'alice', origin: { kind: 'plugin', name: 'caller' } },
      { to: 'prod', origin: { kind: 'plugin', name: 'caller' } },
      { sent: { isDelivered: true }, refused: { isDelivered: false, reason: 'not from here' } },
    ])
    expect(half.delivered).toEqual([
      { to: 'audit-log', text: 'copy: hello' },
      { to: 'alice', text: '[audited] hello' },
    ])
  })

  it('append: door note, origin the plugin; a hook above rewrites the text or refuses the row — nothing stored then', async () => {
    const half = engineHalf()
    const { runtime, reports } = world(
      {
        writer: `
          export function register(on) {
            on('prompt.submit', async ($, e, next) => {
              const kept = await $.session.append({ message: { type: 'user', content: [{ type: 'text', text: 'remember the plan' }] } });
              const refused = await $.session.append({ message: { type: 'user', content: [{ type: 'text', text: 'secret' }] } });
              await $.ui.log(JSON.stringify({ kept, refused }));
              return next(e);
            });
          }
        `,
        policy: `
          export function register(on) {
            on('session.append', async ($, e, next) => {
              await $.ui.log(JSON.stringify({ door: e.door, origin: e.origin }));
              if (e.message.content[0].text === 'secret') return { deny: 'no secrets in the transcript' };
              return next({ ...e, message: { ...e.message, content: [{ type: 'text', text: 'NOTE: ' + e.message.content[0].text }] } });
            });
          }
        `,
      },
      { conversation: half.conversation },
    )
    half.bind(runtime)
    await runtime.ready
    await runtime.promptSubmit('go')
    const logs = reports.filter(r => /^(policy|writer): \{/.test(r)).map(r => JSON.parse(r.slice(r.indexOf('{'))))
    expect(logs).toEqual([
      { door: 'note', origin: { kind: 'plugin', name: 'writer' } },
      { door: 'note', origin: { kind: 'plugin', name: 'writer' } },
      {
        kept: {
          message: { type: 'user', role: 'user', isMeta: true, content: [{ type: 'text', text: 'NOTE: remember the plan' }] },
          uuid: 'n1',
        },
        refused: { deny: 'no secrets in the transcript' },
      },
    ])
    expect(half.stored).toHaveLength(1)
  })

  it('append with no hook on the event stores the row as made', async () => {
    const half = engineHalf()
    const { runtime, reports } = world(
      {
        writer: `
          export function register(on) {
            on('prompt.submit', async ($, e, next) => {
              const kept = await $.session.append({ message: { type: 'user', content: [{ type: 'text', text: 'plain' }] } });
              await $.ui.log(kept.message.content[0].text);
              return next(e);
            });
          }
        `,
      },
      { conversation: half.conversation },
    )
    half.bind(runtime)
    await runtime.ready
    await runtime.promptSubmit('go')
    expect(reports).toContain('writer: plain')
    expect(half.stored).toHaveLength(1)
  })

  it('a host without a conversation refuses all three by name', async () => {
    const { runtime, reports } = world({
      probe: `
        export function register(on) {
          on('prompt.submit', async ($, e, next) => {
            const why = err => err.name + ': ' + err.message;
            await $.ui.log(await $.session.compact().catch(why));
            await $.ui.log(await $.session.send({ to: 'a', text: 'b' }).catch(why));
            await $.ui.log(await $.session.append({ message: { type: 'user', content: [{ type: 'text', text: 'n' }] } }).catch(why));
            await $.ui.log(await $.session.send({ to: 3, text: 'b' }).catch(why));
            return next(e);
          });
        }
      `,
    })
    await runtime.ready
    await runtime.promptSubmit('go')
    expect(reports).toEqual([
      'probe: NotSupportedError: $.session.compact is not available: this session has no conversation to change',
      'probe: NotSupportedError: $.session.send is not available: this session has no conversation to change',
      'probe: NotSupportedError: $.session.append is not available: this session has no conversation to change',
      'probe: TypeError: $.session.send: to must be a name, { sessionId } or { agentId }',
    ])
  })
})
