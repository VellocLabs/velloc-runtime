/**
 * `session.compact` (F-25) through a real `ModRuntime`: the
 * transcript as the hook sees it (handles), what a hook may do on the way
 * down (instructions, the messages compacted) and on the way up (what is
 * kept after the boundary, its own messages, a skip), and that a failing
 * hook or a refused list leaves the engine's own compaction. The call sites
 * are `query-engine-mods.test.ts` (manual) and `auto-compact.test.ts` (auto).
 */
import { afterEach, describe, expect, it } from 'vitest'
import { ModRuntime, type ModModuleRef, type ModWorkerHandle } from '../mods/ModRuntime'
import { installModWorkerHost } from '../mods/ModWorkerHost'
import type { StoredRow } from '../mods/sessionAppendEvent'
import {
  buildRow,
  isSessionCompactResult,
  rowsOf,
  sessionMessagesOf,
  type SessionCompactCore,
  type SessionCompactCoreInput,
} from '../mods/sessionCompactEvent'

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

const ROWS: StoredRow[] = [
  { type: 'user', uuid: 'u1', message: { role: 'user', content: 'read the file' } },
  {
    type: 'assistant',
    uuid: 'a1',
    message: {
      role: 'assistant',
      content: [
        { type: 'text', text: 'Reading.' },
        { type: 'tool-call', toolCallId: 'c1', toolName: 'Read', args: { file_path: '/a' } },
      ],
    },
  },
  {
    type: 'user',
    uuid: 'u2',
    message: { role: 'user', content: [{ type: 'tool-result', toolCallId: 'c1', result: 'FILE BODY', isError: false }] },
  },
  { type: 'system', uuid: 's1', subtype: 'informational', message: 'a notice' },
  { type: 'assistant', uuid: 'a2', message: { role: 'assistant', content: [{ type: 'text', text: 'Done.' }] } },
]

/** A core that records what it ran over and answers a fixed summary. */
function fakeCore(options: { error?: string } = {}) {
  const runs: SessionCompactCoreInput[] = []
  let n = 0
  const core: SessionCompactCore = {
    run: async e => {
      runs.push(e)
      if (options.error) return { error: options.error }
      n += 1
      return {
        boundaryMarker: { type: 'system', uuid: `b${n}`, subtype: 'compact_boundary', message: 'Conversation compacted', compactMetadata: { trigger: 'manual', preTokens: 1234 } },
        summaryMessages: [
          { type: 'user', uuid: `sum${n}`, isMeta: true, message: { role: 'user', content: `SUMMARY of ${e.messages.length} rows${e.instructions ? ` (${e.instructions})` : ''}` } },
        ],
      }
    },
    boundary: rows => ({ type: 'system', uuid: 'own-boundary', subtype: 'compact_boundary', message: 'Conversation compacted', compactMetadata: { trigger: 'manual', preTokens: rows.length } }),
  }
  return { core, runs }
}

describe('sessionMessagesOf / rowsOf — the transcript as a hook reads it, and back', () => {
  it('user and assistant rows become messages with handles; notices are left out; tool blocks are summarized', () => {
    const { messages, byHandle } = sessionMessagesOf(ROWS)
    expect(messages).toEqual([
      { role: 'user', text: 'read the file', toolUses: [], handle: 'h0:u1' },
      { role: 'assistant', text: 'Reading.', toolUses: [{ tool_use_id: 'c1', tool: 'Read', input: { file_path: '/a' } }], handle: 'h1:a1' },
      { role: 'user', text: '', toolUses: [], toolResults: [{ tool_use_id: 'c1', text: 'FILE BODY', isError: false, result: 'FILE BODY' }], handle: 'h2:u2' },
      { role: 'assistant', text: 'Done.', toolUses: [], handle: 'h4:a2' },
    ])
    expect(byHandle.get('h2:u2')).toBe(ROWS[2])
  })

  it('a message with a handle resolves to the row itself; one without is built; a handle never given is refused', () => {
    const { messages, byHandle } = sessionMessagesOf(ROWS)
    const resolved = rowsOf([messages[3]!, { role: 'user', text: 'kept note', toolUses: [] }], byHandle, () => 'new-1')
    expect('rows' in resolved && resolved.rows[0]).toBe(ROWS[4])
    expect('rows' in resolved && resolved.rows[1]).toMatchObject({ type: 'user', uuid: 'new-1', message: { role: 'user', content: 'kept note' } })
    expect(rowsOf([{ role: 'user', text: 'x', toolUses: [], handle: 'nope' }], byHandle, () => 'n')).toEqual({
      refused: 'handle nope is not one the engine gave',
    })
  })

  it('buildRow: an assistant message with tool uses, a user message with tool results', () => {
    expect(
      buildRow({ role: 'assistant', text: 'I ran it', toolUses: [{ tool_use_id: 'c9', tool: 'Bash', input: { command: 'ls' } }] }, 'a9'),
    ).toMatchObject({
      type: 'assistant',
      uuid: 'a9',
      message: { role: 'assistant', content: [{ type: 'text', text: 'I ran it' }, { type: 'tool-call', toolCallId: 'c9', toolName: 'Bash', args: { command: 'ls' } }] },
    })
    expect(
      buildRow({ role: 'user', text: '', toolUses: [], toolResults: [{ tool_use_id: 'c9', text: 'a b', isError: true }] }, 'u9'),
    ).toMatchObject({ message: { role: 'user', content: [{ type: 'tool-result', toolCallId: 'c9', result: 'a b', isError: true }] } })
  })

  it('the result shape: { messages } of messages, or a non-empty skip', () => {
    expect(isSessionCompactResult({ messages: [{ role: 'user', text: 'x', toolUses: [] }] })).toBe(true)
    expect(isSessionCompactResult({ messages: [] })).toBe(true)
    expect(isSessionCompactResult({ skip: 'off' })).toBe(true)
    expect(isSessionCompactResult({ skip: '' })).toBe(false)
    expect(isSessionCompactResult({ messages: [{ role: 'system', text: 'x' }] })).toBe(false)
    expect(isSessionCompactResult({ messages: 'x' })).toBe(false)
  })
})

describe('session.compact through the runtime', () => {
  it('without a hook the engine compacts as it would, once', async () => {
    const { runtime } = world({ 'other/hooks/register.js': `export function register(on) { on('prompt.submit', ($, e, next) => next(e)) }` })
    await runtime.ready
    const { core, runs } = fakeCore()
    expect(runtime.hasSessionCompactHooks()).toBe(false)
    const settled = await runtime.sessionCompact({ trigger: 'manual', instructions: 'keep names', messages: ROWS }, core)
    expect(runs).toEqual([{ instructions: 'keep names', messages: ROWS }])
    expect(settled).toMatchObject({ summaryMessages: [{ uuid: 'sum1' }] })
  })

  it("a hook rewrites the instructions and narrows the messages on the way down; next(e) resolves to core's summary with tokensBefore; what it relays is core's compaction", async () => {
    const { runtime, reports } = world({
      'focus/hooks/register.js': `
        export function register(on) {
          on('session.compact', { trigger: 'manual' }, async ($, e, next) => {
            const result = await next({
              ...e,
              instructions: (e.instructions ?? '') + ' and tool names',
              messages: e.messages.filter(m => m.role === 'assistant'),
            });
            await $.ui.log('up ' + JSON.stringify(result));
            return result;
          });
        }
      `,
    })
    await runtime.ready
    const { core, runs } = fakeCore()
    const settled = await runtime.sessionCompact({ trigger: 'manual', instructions: 'keep names', messages: ROWS }, core)
    expect(runs).toHaveLength(1)
    expect(runs[0]!.instructions).toBe('keep names and tool names')
    expect(runs[0]!.messages).toEqual([ROWS[1], ROWS[4]])
    expect(settled).toMatchObject({ boundaryMarker: { uuid: 'b1' }, summaryMessages: [{ uuid: 'sum1' }] })
    expect(reports).toEqual([
      expect.stringMatching(/^focus: up \{"messages":\[\{"role":"user","text":"SUMMARY of 2 rows \(keep names and tool names\)","toolUses":\[\],"handle":"s:h0:sum1"\}\],"tokensBefore":1234\}$/),
    ])
  })

  it('a hook keeps a row after the boundary and adds a message of its own: a copy with an id of its own, a built row, after the summary', async () => {
    const { runtime } = world({
      'keep/hooks/register.js': `
        export function register(on) {
          on('session.compact', async ($, e, next) => {
            const last = e.messages[e.messages.length - 1];
            const result = await next(e);
            return { messages: [...result.messages, last, { role: 'user', text: 'Remember: be brief.', toolUses: [] }] };
          });
        }
      `,
    })
    await runtime.ready
    const { core } = fakeCore()
    const settled = await runtime.sessionCompact({ trigger: 'manual', messages: ROWS }, core)
    expect('summaryMessages' in settled).toBe(true)
    const rows = (settled as { summaryMessages: StoredRow[] }).summaryMessages
    expect(rows).toHaveLength(3)
    expect(rows[0]).toMatchObject({ uuid: 'sum1' })
    expect(rows[1]).toMatchObject({ type: 'assistant', message: { content: [{ type: 'text', text: 'Done.' }] } })
    expect(rows[1]!.uuid).not.toBe('a2')
    expect(rows[2]).toMatchObject({ type: 'user', message: { role: 'user', content: 'Remember: be brief.' } })
    expect((settled as { boundaryMarker: StoredRow }).boundaryMarker).toMatchObject({ uuid: 'b1' })
  })

  it("a hook answers { messages } of its own without next: no summarizer call, the site's boundary, the built rows", async () => {
    const { runtime } = world({
      'own/hooks/register.js': `
        export function register(on) {
          on('session.compact', ($, e) => ({
            messages: [{ role: 'user', text: 'Earlier: ' + e.messages.map(m => m.text).filter(Boolean).join(' | '), toolUses: [] }],
          }));
        }
      `,
    })
    await runtime.ready
    const { core, runs } = fakeCore()
    const settled = await runtime.sessionCompact({ trigger: 'auto', messages: ROWS }, core)
    expect(runs).toEqual([])
    expect(settled).toMatchObject({
      boundaryMarker: { uuid: 'own-boundary' },
      summaryMessages: [{ type: 'user', message: { role: 'user', content: 'Earlier: read the file | Reading. | Done.' } }],
    })
  })

  it('a skip leaves the conversation as it is, with the reason, and is reported', async () => {
    const { runtime, reports } = world({
      'off/hooks/register.js': `
        export function register(on) {
          on('session.compact', { trigger: 'auto' }, () => ({ skip: 'compaction is off in this project' }));
        }
      `,
    })
    await runtime.ready
    const { core, runs } = fakeCore()
    expect(await runtime.sessionCompact({ trigger: 'auto', messages: ROWS }, core)).toEqual({ skip: 'compaction is off in this project' })
    expect(runs).toEqual([])
    expect(reports).toEqual(['mods: session.compact (auto) skipped by a hook: compaction is off in this project'])
    // The matcher: a manual compaction is not selected.
    expect(await runtime.sessionCompact({ trigger: 'manual', messages: ROWS }, core)).toMatchObject({ summaryMessages: [{ uuid: 'sum1' }] })
  })

  it("a hook that throws, one that hands down a handle the engine never gave, one that moves the trigger: the engine's own compaction, each named", async () => {
    const { runtime, reports } = world({
      'bad/hooks/register.js': `
        export function register(on) {
          on('session.compact', ($, e, next) => {
            if (e.instructions === 'throw') throw new Error('boom');
            if (e.instructions === 'handle') return next({ ...e, messages: [{ role: 'user', text: 'x', toolUses: [], handle: 'ghost' }] });
            if (e.instructions === 'trigger') return next({ ...e, trigger: 'plugin' });
            if (e.instructions === 'empty') return next(e).then(() => ({ messages: [] }));
            return next(e);
          });
        }
      `,
    })
    await runtime.ready
    for (const instructions of ['throw', 'handle', 'trigger', 'empty']) {
      const { core, runs } = fakeCore()
      const settled = await runtime.sessionCompact({ trigger: 'manual', instructions, messages: ROWS }, core)
      expect(settled, instructions).toMatchObject({ summaryMessages: [{ uuid: 'sum1' }] })
      expect(runs, instructions).toHaveLength(1)
    }
    expect(reports).toEqual([
      // A hook that throws before next is skipped by the chain, which runs
      // core in its place: the chain's own report, nothing more.
      expect.stringMatching(/^bad: session\.compact .*boom/),
      // A rewritten event core refuses rejects up through the hook; the
      // runtime then compacts as it would.
      'mods: session.compact (manual) failed: the rewritten event is refused: handle ghost is not one the engine gave; the engine compacts as it would',
      'mods: session.compact (manual) failed: the rewritten event is refused: trigger is pinned; the engine compacts as it would',
      "mods: session.compact (manual): a hook handed back no messages; the engine's own compaction stands",
    ])
  })

  it("core's error is the compaction's when the hook relays it; a hook may answer messages of its own in its place", async () => {
    const { runtime } = world({
      'relay/hooks/register.js': `
        export function register(on) {
          on('session.compact', ($, e, next) => e.instructions === 'rescue'
            ? next(e).catch(() => ({ messages: [{ role: 'user', text: 'pretend', toolUses: [] }] }))
            : next(e));
        }
      `,
    })
    await runtime.ready
    const { core } = fakeCore({ error: 'the model returned an empty summary' })
    expect(await runtime.sessionCompact({ trigger: 'manual', messages: ROWS }, core)).toEqual({ error: 'the model returned an empty summary' })
    expect(await runtime.sessionCompact({ trigger: 'manual', instructions: 'rescue', messages: ROWS }, core)).toMatchObject({
      boundaryMarker: { uuid: 'own-boundary' },
      summaryMessages: [{ message: { content: 'pretend' } }],
    })
  })
})
