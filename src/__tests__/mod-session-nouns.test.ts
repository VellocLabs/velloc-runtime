/**
 * `$.session.messages` and `$.session.usage` (F-25): the transcript as `ModTranscriptEntry`s (the newest 4096) and
 * as `ApiMessage`s (from the last compaction on), the usage figures, and both nouns through a real `ModRuntime`,
 * including a guard scrubbing another plugin's read and the refusals.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ModRuntime, type ModModuleRef, type ModWorkerHandle } from '../mods/ModRuntime'
import { installModWorkerHost } from '../mods/ModWorkerHost'
import type { ModNounHost } from '../mods/modNouns'
import { RAISED_EVENTS } from '../mods/modAdmission'
import type { StoredRow } from '../mods/sessionAppendEvent'
import {
  SESSION_MESSAGES_CAP,
  agentDeny,
  apiMessageRows,
  sessionMessageRows,
  sessionMessagesArgsOf,
  sessionUsageArgsOf,
  sessionUsageOf,
  type ModTranscriptHost,
} from '../mods/sessionNouns'
import { breakdownWindow } from '../mods/windowBreakdown'

const open: MessagePort[] = []
const runtimes: ModRuntime[] = []
afterEach(() => {
  for (const runtime of runtimes.splice(0)) runtime.dispose()
  for (const port of open.splice(0)) port.close()
})

/** A turn as the engine stores it: a prompt, a tool call, its result, an answer. */
const TURN: StoredRow[] = [
  { type: 'user', uuid: 'u1', timestamp: '2026-10-04T10:00:00.000Z', message: { role: 'user', content: 'read it' } },
  {
    type: 'assistant',
    uuid: 'a1',
    timestamp: '2026-10-04T10:00:01.000Z',
    message: {
      role: 'assistant',
      model: 'claude-sonnet-5',
      content: [
        { type: 'text', text: 'Reading.' },
        { type: 'tool-call', toolCallId: 't1', toolName: 'Read', args: { file_path: '/a.md' } },
      ],
      usage: { input_tokens: 100, cache_creation_input_tokens: 20, cache_read_input_tokens: 30, output_tokens: 9 },
    },
  },
  {
    type: 'user',
    uuid: 'u2',
    timestamp: '2026-10-04T10:00:02.000Z',
    message: { role: 'user', content: [{ type: 'tool-result', toolCallId: 't1', toolName: 'Read', result: 'hello' }] },
  },
  {
    type: 'assistant',
    uuid: 'a2',
    timestamp: '2026-10-04T10:00:03.000Z',
    message: {
      role: 'assistant',
      model: 'claude-sonnet-5',
      content: [{ type: 'text', text: 'It says hello.' }],
      usage: { input_tokens: 1000, cache_creation_input_tokens: 0, cache_read_input_tokens: 500, output_tokens: 7 },
    },
  },
  { type: 'system', uuid: 's1', subtype: 'informational', content: 'a notice' },
]

const BOUNDARY: StoredRow = { type: 'system', uuid: 'b1', subtype: 'compact_boundary', timestamp: '2026-10-04T11:00:00.000Z' }

describe('the arguments', () => {
  it('messages takes { agentId?, as? }; usage takes { breakdown?, columns? }; a wrong field is named', () => {
    expect(sessionMessagesArgsOf(undefined)).toEqual({})
    expect(sessionMessagesArgsOf({ as: 'api', agentId: 'subagent-1' })).toEqual({ as: 'api', agentId: 'subagent-1' })
    expect(() => sessionMessagesArgsOf({ as: 'rows' })).toThrow(/as must be "api"/)
    expect(() => sessionMessagesArgsOf({ agentId: '' })).toThrow(/agentId/)
    expect(() => sessionMessagesArgsOf('x')).toThrow(/args must be/)
    expect(sessionUsageArgsOf(undefined)).toEqual({})
    expect(sessionUsageArgsOf({ breakdown: 'summary', columns: 80 })).toEqual({ breakdown: 'summary', columns: 80 })
    expect(() => sessionUsageArgsOf({ breakdown: 'all' })).toThrow(/breakdown/)
    expect(() => sessionUsageArgsOf({ columns: 0 })).toThrow(/columns/)
  })
})

describe('the rows as SessionMessages', () => {
  it('user and assistant rows only, no handles, a tool use with its outcome paired by id', () => {
    expect(sessionMessageRows(TURN)).toEqual([
      { role: 'user', text: 'read it', toolUses: [] },
      {
        role: 'assistant',
        text: 'Reading.',
        toolUses: [{ tool_use_id: 't1', tool: 'Read', input: { file_path: '/a.md' }, result: 'hello', text: 'hello' }],
      },
      { role: 'user', text: '', toolUses: [], toolResults: [{ tool_use_id: 't1', text: 'hello', isError: false, result: 'hello' }] },
      { role: 'assistant', text: 'It says hello.', toolUses: [] },
    ])
  })

  it('an errored call carries isError: true; one in flight carries no outcome', () => {
    const rows: StoredRow[] = [
      { type: 'assistant', uuid: 'a', message: { role: 'assistant', content: [{ type: 'tool-call', toolCallId: 'x', toolName: 'Bash', args: {} }, { type: 'tool-call', toolCallId: 'y', toolName: 'Read', args: {} }] } },
      { type: 'user', uuid: 'u', message: { role: 'user', content: [{ type: 'tool-result', toolCallId: 'x', result: 'boom', isError: true }] } },
    ]
    const [assistant] = sessionMessageRows(rows)
    expect(assistant!.toolUses).toEqual([
      { tool_use_id: 'x', tool: 'Bash', input: {}, result: 'boom', text: 'boom', isError: true },
      { tool_use_id: 'y', tool: 'Read', input: {} },
    ])
  })

  it("an Edit or Write result is { filePath, structuredPatch } (a create adds type and content), off the diff on the row's tool detail", () => {
    const hunk = { oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, lines: ['-a', '+b'] }
    const created = { oldStart: 0, oldLines: 0, newStart: 1, newLines: 1, lines: ['+new'] }
    const rows: StoredRow[] = [
      {
        type: 'assistant',
        uuid: 'a',
        message: {
          role: 'assistant',
          content: [
            { type: 'tool-call', toolCallId: 'e', toolName: 'Edit', args: { file_path: '/w/a.txt' } },
            { type: 'tool-call', toolCallId: 'w', toolName: 'Write', args: { file_path: '/w/n.txt', content: 'new' } },
          ],
        },
      },
      {
        type: 'user',
        uuid: 'u1',
        message: { role: 'user', content: [{ type: 'tool-result', toolCallId: 'e', result: 'The file /w/a.txt has been updated.' }] },
        toolCallDetail: { toolCallId: 'e', toolName: 'Edit', args: {}, editDiff: { filePath: '/w/a.txt', patchHunks: [hunk], fileWasCreated: false, plusLines: 1, minusLines: 1 } },
      },
      {
        type: 'user',
        uuid: 'u2',
        message: { role: 'user', content: [{ type: 'tool-result', toolCallId: 'w', result: 'File created.' }] },
        toolCallDetail: { toolCallId: 'w', toolName: 'Write', args: { file_path: '/w/n.txt', content: 'new' }, editDiff: { filePath: '/w/n.txt', patchHunks: [created], fileWasCreated: true, plusLines: 1, minusLines: 0 } },
      },
    ]
    const [assistant, first] = sessionMessageRows(rows)
    expect(assistant!.toolUses.map(use => use.result)).toEqual([
      { filePath: '/w/a.txt', structuredPatch: [hunk] },
      { filePath: '/w/n.txt', structuredPatch: [created], type: 'create', content: 'new' },
    ])
    // The text stays the model's; the result paired in the user row agrees.
    expect(assistant!.toolUses[0]!.text).toBe('The file /w/a.txt has been updated.')
    expect(first!.toolResults![0]!.result).toEqual({ filePath: '/w/a.txt', structuredPatch: [hunk] })
  })

  it('the newest 4096', () => {
    const rows: StoredRow[] = Array.from({ length: SESSION_MESSAGES_CAP + 3 }, (_, i) => ({
      type: 'user',
      uuid: `u${i}`,
      message: { role: 'user', content: `m${i}` },
    }))
    const out = sessionMessageRows(rows)
    expect(out).toHaveLength(SESSION_MESSAGES_CAP)
    expect(out[0]!.text).toBe('m3')
    expect(out.at(-1)!.text).toBe(`m${SESSION_MESSAGES_CAP + 2}`)
  })
})

describe('the rows as ApiMessages', () => {
  it('Messages API blocks, notices left out', () => {
    expect(apiMessageRows(TURN)).toEqual([
      { role: 'user', content: [{ type: 'text', text: 'read it' }] },
      {
        role: 'assistant',
        content: [
          { type: 'text', text: 'Reading.' },
          { type: 'tool_use', id: 't1', name: 'Read', input: { file_path: '/a.md' } },
        ],
      },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'hello' }] },
      { role: 'assistant', content: [{ type: 'text', text: 'It says hello.' }] },
    ])
  })

  it('from the last compaction on; adjacent rows of one role joined; opening on a user message', () => {
    const rows: StoredRow[] = [
      ...TURN,
      BOUNDARY,
      { type: 'assistant', uuid: 'x', message: { role: 'assistant', content: 'stray' } },
      { type: 'user', uuid: 'sum', isMeta: true, message: { role: 'user', content: 'Summary: read a.md' } },
      { type: 'user', uuid: 'p', message: { role: 'user', content: 'next' } },
    ]
    expect(apiMessageRows(rows)).toEqual([
      { role: 'user', content: [{ type: 'text', text: 'Summary: read a.md' }, { type: 'text', text: 'next' }] },
    ])
  })
})

describe('the usage figures', () => {
  it('startedAt the earliest row; tokens the input side of the last response; percent of the window; no rate limits; the cost when given', () => {
    expect(sessionUsageOf({ rows: TURN, window: 200_000, fallbackStartedAt: 5, costUsd: 0.25 })).toEqual({
      startedAt: Date.parse('2026-10-04T10:00:00.000Z'),
      context: { tokens: 1500, window: 200_000, percent: 1 },
      rateLimits: [],
      cost: { usd: 0.25 },
    })
  })

  it('a fresh session: the fallback start, no tokens or percent, no cost — left out, never zeroed', () => {
    expect(sessionUsageOf({ rows: [], window: 1_000_000, fallbackStartedAt: 42 })).toEqual({
      startedAt: 42,
      context: { window: 1_000_000 },
      rateLimits: [],
    })
  })

  it('just compacted: no tokens until the next response', () => {
    const usage = sessionUsageOf({ rows: [...TURN, BOUNDARY, { type: 'user', uuid: 'p', message: { role: 'user', content: 'go' } }], window: 200_000, fallbackStartedAt: 0 })
    expect(usage.context).toEqual({ window: 200_000 })
  })
})

describe('the nouns through the runtime', () => {
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

  const transcript: ModTranscriptHost = {
    rows: () => TURN,
    agentRows: async agentId =>
      agentId === 'subagent-1'
        ? [{ type: 'user', uuid: 'c1', message: { role: 'user', content: 'child prompt' } }]
        : agentDeny(agentId, "not one of this session's agents"),
    usage: () => sessionUsageOf({ rows: TURN, window: 200_000, fallbackStartedAt: 0 }),
  }

  it('both events are raised', () => {
    expect(RAISED_EVENTS).toContain('session.messages')
    expect(RAISED_EVENTS).toContain('session.usage')
  })

  it('a mod reads the rows, the API form, an agent\'s rows and a deny, and the usage; a breakdown is refused by name', async () => {
    const { runtime, reports } = world(
      {
        lab: `
          export function register(on) {
            on('prompt.submit', async ($, e, next) => {
              const rows = await $.session.messages();
              const api = await $.session.messages({ as: 'api' });
              const child = await $.session.messages({ agentId: 'subagent-1' });
              const denied = await $.session.messages({ agentId: 'nobody' });
              const usage = await $.session.usage();
              const breakdown = await $.session.usage({ breakdown: 'full' }).catch(err => err.name);
              const bad = await $.session.messages({ as: 'xml' }).catch(err => err.name + ': ' + err.message);
              await $.ui.log(JSON.stringify({ last: rows.at(-1).text, uses: rows[1].toolUses[0].text, apiRoles: api.map(m => m.role), child: child.map(m => m.text), denied, percent: usage.context.percent, breakdown, bad }));
              return next(e);
            });
          }
        `,
      },
      { transcript },
    )
    await runtime.ready
    await runtime.promptSubmit('go')
    const line = reports.find(r => r.startsWith('lab: {'))!
    expect(JSON.parse(line.slice('lab: '.length))).toEqual({
      last: 'It says hello.',
      uses: 'hello',
      apiRoles: ['user', 'assistant', 'user', 'assistant'],
      child: ['child prompt'],
      denied: { deny: "agent nobody: not one of this session's agents" },
      percent: 1,
      breakdown: 'NotSupportedError',
      bad: 'TypeError: $.session.messages: as must be "api" or absent',
    })
  })

  it("a failed $ call is logged to the worker's console under the plugin's name, even when the module catches it", async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const { runtime, reports } = world(
        {
          lab: `
            export function register(on) {
              on('prompt.submit', async ($, e, next) => {
                const caught = await $.session.messages({ as: 'xml' }).catch(err => err.name);
                await $.ui.log('caught ' + caught);
                return next(e);
              });
            }
          `,
        },
        { transcript },
      )
      await runtime.ready
      await runtime.promptSubmit('go')
      expect(reports).toContain('lab: caught TypeError')
      const lines = warn.mock.calls.map(call => String(call[0]))
      expect(lines).toContain('[mod lab] $.session.messages failed: TypeError: $.session.messages: as must be "api" or absent')
      expect(warn.mock.calls.find(call => String(call[0]).startsWith('[mod lab]'))?.[1]).toBeInstanceOf(Error)
    } finally {
      warn.mockRestore()
    }
  })

  it('a breakdown asked of a host that measures one comes back on context.breakdown, the columns passed through', async () => {
    const asked: Array<{ columns?: number }> = []
    const measured = breakdownWindow({
      model: 'model-a',
      window: 200_000,
      systemChars: 4_000,
      tools: [],
      memoryFiles: [],
      memorySectionChars: 0,
      skillListings: [],
      messageChars: 8_000,
      compaction: { enabled: true, threshold: 167_000 },
    })
    const { runtime, reports } = world(
      {
        lab: `
          export function register(on) {
            on('prompt.submit', async ($, e, next) => {
              const usage = await $.session.usage({ breakdown: 'summary', columns: 60 });
              const b = usage.context.breakdown;
              await $.ui.log(JSON.stringify({ window: usage.context.window, rows: b.categories.map(c => c.name + ':' + c.kind), total: b.totalTokens }));
              return next(e);
            });
          }
        `,
      },
      {
        transcript: {
          ...transcript,
          breakdown: async args => {
            asked.push(args)
            return measured
          },
        },
      },
    )
    await runtime.ready
    await runtime.promptSubmit('go')
    const line = reports.find(r => r.startsWith('lab: {'))!
    expect(JSON.parse(line.slice('lab: '.length))).toEqual({
      window: 200_000,
      rows: ['System prompt:used', 'Messages:used', 'Autocompact buffer:buffer', 'Free space:free'],
      total: 3_000,
    })
    expect(asked).toEqual([{ columns: 60 }])
  })

  it("a guard above scrubs what another plugin reads, and denies another plugin's usage", async () => {
    const { runtime, reports } = world(
      {
        guard: `
          export function register(on) {
            on('session.messages', async ($, e, next) => {
              const found = await next(e);
              if (!Array.isArray(found.value)) return found;
              return { value: found.value.map(m => ({ ...m, text: '[scrubbed]' })) };
            });
            on('session.usage', () => ({ deny: 'usage is private' }));
          }
        `,
        reader: `
          export function register(on) {
            on('prompt.submit', async ($, e, next) => {
              const rows = await $.session.messages();
              const usage = await $.session.usage().catch(err => err.name + ': ' + err.message);
              await $.ui.log(JSON.stringify({ texts: rows.map(m => m.text), usage }));
              return next(e);
            });
          }
        `,
      },
      { transcript },
    )
    await runtime.ready
    await runtime.promptSubmit('go')
    const line = reports.find(r => r.startsWith('reader: {'))!
    expect(JSON.parse(line.slice('reader: '.length))).toEqual({
      texts: ['[scrubbed]', '[scrubbed]', '[scrubbed]', '[scrubbed]'],
      usage: 'DeniedError: usage is private',
    })
  })

  it('a host without a transcript refuses both by name', async () => {
    const { runtime, reports } = world({
      probe: `
        export function register(on) {
          on('prompt.submit', async ($, e, next) => {
            await $.ui.log(await $.session.messages().catch(err => err.name + ': ' + err.message));
            await $.ui.log(await $.session.usage().catch(err => err.name + ': ' + err.message));
            return next(e);
          });
        }
      `,
    })
    await runtime.ready
    await runtime.promptSubmit('go')
    expect(reports).toEqual([
      'probe: NotSupportedError: $.session.messages is not available: this session has no transcript to read',
      'probe: NotSupportedError: $.session.usage is not available: this session has no transcript to read',
    ])
  })
})
