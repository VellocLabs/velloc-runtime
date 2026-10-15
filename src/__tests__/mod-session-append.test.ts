/**
 * `session.append` (F-25) through a real `ModRuntime`: the
 * row each kind of stored message becomes on `e`, what a hook may rewrite,
 * the pins that fail a hook, what is put back, and that a failing or
 * non-relaying hook leaves the row as made. The engine's call site is
 * `query-engine-mods.test.ts`.
 */
import { afterEach, describe, expect, it } from 'vitest'
import { ModRuntime, type ModModuleRef, type ModWorkerHandle } from '../mods/ModRuntime'
import { installModWorkerHost } from '../mods/ModWorkerHost'
import {
  applyAppendRewrite,
  describeAppendRow,
  isSessionAppendResult,
  type StoredRow,
} from '../mods/sessionAppendEvent'

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

const PROMPT: StoredRow = { type: 'user', uuid: 'u1', message: { role: 'user', content: 'hello world' } }
const COMMAND: StoredRow = { type: 'user', uuid: 'u2', message: { role: 'user', content: '/compact keep the plan' } }
const META: StoredRow = {
  type: 'user',
  uuid: 'u3',
  isMeta: true,
  message: { role: 'user', content: [{ type: 'text', text: '<system-reminder>be brief</system-reminder>' }] },
}
const DELIVERY: StoredRow = { type: 'user', uuid: 'u4', origin: 'mailbox', message: { role: 'user', content: 'from a peer' } }
const RESPONSE: StoredRow = {
  type: 'assistant',
  uuid: 'a1',
  message: {
    role: 'assistant',
    model: 'claude-opus-5-5',
    content: [
      { type: 'thinking', thinking: 'hmm' },
      { type: 'text', text: 'I will read it.' },
      { type: 'tool-call', toolCallId: 'call-1', toolName: 'Read', args: { file_path: '/a' } },
    ],
  },
}
const TOOL_RESULT: StoredRow = {
  type: 'user',
  uuid: 'u5',
  message: {
    role: 'user',
    content: [{ type: 'tool-result', toolCallId: 'call-1', result: 'SECRET=1\nname=a' }],
  },
  toolUseResult: 'SECRET=1\nname=a',
  toolCallDetailRef: { toolCallId: 'call-1', toolName: 'Read' },
  // The sidecar the store rebuilds the result from on every later turn.
  toolCallDetail: { toolCallId: 'call-1', toolName: 'Read', args: { file_path: '/p/.env' }, result: 'SECRET=1\nname=a' },
}
const NOTICE: StoredRow = { type: 'system', uuid: 's1', subtype: 'informational', message: 'Compacted.', i18nContent: [] }
const BOUNDARY: StoredRow = { type: 'system', uuid: 's2', subtype: 'compact_boundary', message: 'boundary' }
const ATTACHMENT: StoredRow = { type: 'attachment', uuid: 't1', attachment: { type: 'directory', path: '/p', content: 'a\nb' } }

describe('describeAppendRow — a stored row as the declaration hands it', () => {
  it('a prompt, a command, a meta row, a delivery, a response, a tool result, a notice, a boundary, an attachment', () => {
    expect(describeAppendRow(PROMPT)).toEqual({
      message: { type: 'user', role: 'user', content: [{ type: 'text', text: 'hello world' }] },
      door: 'prompt',
      origin: { kind: 'composer' },
      uuid: 'u1',
    })
    expect(describeAppendRow(COMMAND)).toMatchObject({ door: 'command', origin: { kind: 'composer' } })
    expect(describeAppendRow(META)).toMatchObject({
      message: { type: 'user', role: 'user', isMeta: true },
      door: 'attachment',
      origin: { kind: 'engine' },
    })
    expect(describeAppendRow(DELIVERY)).toMatchObject({ door: 'delivery', origin: { kind: 'peer' } })
    expect(describeAppendRow(RESPONSE)).toEqual({
      message: {
        type: 'assistant',
        role: 'assistant',
        content: [
          { type: 'thinking', thinking: 'hmm' },
          { type: 'text', text: 'I will read it.' },
          { type: 'tool_use', id: 'call-1', name: 'Read', input: { file_path: '/a' } },
        ],
      },
      door: 'response',
      origin: { kind: 'model', model: 'claude-opus-5-5' },
      uuid: 'a1',
    })
    expect(describeAppendRow(TOOL_RESULT)).toEqual({
      message: {
        type: 'user',
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: 'call-1', content: 'SECRET=1\nname=a' }],
      },
      door: 'tool-result',
      origin: { kind: 'tool', tool: 'Read' },
      uuid: 'u5',
    })
    expect(describeAppendRow(NOTICE)).toEqual({
      message: { type: 'system', name: 'informational', content: [{ type: 'text', text: 'Compacted.' }] },
      door: 'notice',
      origin: { kind: 'engine' },
      uuid: 's1',
    })
    expect(describeAppendRow(BOUNDARY)).toMatchObject({ door: 'compaction', message: { name: 'compact_boundary' } })
    expect(describeAppendRow(ATTACHMENT)).toMatchObject({
      message: { type: 'attachment', name: 'directory', content: [{ type: 'text', text: 'a\nb' }] },
      door: 'attachment',
    })
    expect(describeAppendRow(PROMPT, 'agent-7')?.agentId).toBe('agent-7')
  })

  it('a row with no uuid, or of a kind no conversation keeps, is not raised', () => {
    expect(describeAppendRow({ type: 'user', message: { role: 'user', content: 'x' } })).toBeNull()
    expect(describeAppendRow({ type: 'stream_event', uuid: 'e1' })).toBeNull()
    expect(describeAppendRow({ type: 'tombstone', uuid: 'e2' })).toBeNull()
  })

  it('the result shape: { message, uuid }, or a deny', () => {
    expect(isSessionAppendResult({ message: { type: 'user', content: [] }, uuid: 'u' })).toBe(true)
    expect(isSessionAppendResult({ deny: 'no' })).toBe(true)
    expect(isSessionAppendResult({ message: { type: 'user', content: 'x' }, uuid: 'u' })).toBe(false)
    expect(isSessionAppendResult({ uuid: 'u' })).toBe(false)
    expect(isSessionAppendResult('x')).toBe(false)
  })
})

describe('applyAppendRewrite — the pins and what is put back', () => {
  const input = describeAppendRow(RESPONSE)!
  const rewrite = (message: Record<string, unknown>, extra: Record<string, unknown> = {}) =>
    applyAppendRewrite(RESPONSE, input, { ...input, ...extra, message: { ...input.message, ...message } })

  it('a text block is rewritten; thinking and tool_use are put back whole, in order', () => {
    const applied = rewrite({
      content: [
        { type: 'thinking', thinking: 'CHANGED' },
        { type: 'text', text: 'I will read the file.' },
        { type: 'tool_use', id: 'other', name: 'Bash', input: {} },
      ],
    })
    expect(applied).toEqual({
      row: {
        ...RESPONSE,
        message: {
          ...RESPONSE.message as object,
          content: [
            { type: 'thinking', thinking: 'hmm' },
            { type: 'text', text: 'I will read the file.' },
            { type: 'tool-call', toolCallId: 'call-1', toolName: 'Read', args: { file_path: '/a' } },
          ],
        },
      },
    })
  })

  it('a pinned field moved fails the hook, by name', () => {
    expect(rewrite({ type: 'system' })).toEqual({ refused: 'message.type is pinned' })
    expect(rewrite({ role: 'user' })).toEqual({ refused: 'message.role is pinned' })
    expect(rewrite({ isMeta: true })).toEqual({ refused: 'message.isMeta is pinned' })
    expect(rewrite({}, { door: 'note' })).toEqual({ refused: 'door is pinned' })
    expect(rewrite({}, { uuid: 'x' })).toEqual({ refused: 'uuid is pinned' })
    expect(rewrite({}, { origin: { kind: 'engine' } })).toEqual({ refused: 'origin is pinned' })
    expect(rewrite({ content: 'x' })).toEqual({ refused: 'message.content is not an array' })
    // Left out, a pin is kept.
    const kept = applyAppendRewrite(RESPONSE, input, { message: { content: input.message.content } })
    expect('row' in kept).toBe(true)
  })

  it('a block added is refused; one of a kind the row has not is refused', () => {
    expect(rewrite({ content: [...input.message.content, { type: 'tool_use', id: 'n', name: 'X', input: {} }] })).toEqual({
      refused: 'a tool_use block was added',
    })
    expect(rewrite({ content: [{ type: 'image', source: {} }] })).toEqual({ refused: 'a image block was added or changed' })
    expect(rewrite({ content: [{ type: 'text' }] })).toEqual({ refused: 'a text block has no text' })
    expect(rewrite({ content: [{ foo: 1 }] })).toEqual({ refused: 'a block has no type' })
  })

  it("a tool_result's content and is_error are rewritten, under its own tool_use_id; the transcript mirror follows", () => {
    const toolInput = describeAppendRow(TOOL_RESULT)!
    const applied = applyAppendRewrite(TOOL_RESULT, toolInput, {
      message: {
        content: [{ type: 'tool_result', tool_use_id: 'call-1', content: 'SECRET=[redacted]\nname=a', is_error: true }],
      },
    })
    expect(applied).toEqual({
      row: {
        ...TOOL_RESULT,
        message: {
          role: 'user',
          content: [{ type: 'tool-result', toolCallId: 'call-1', result: 'SECRET=[redacted]\nname=a', isError: true }],
        },
        toolUseResult: 'SECRET=[redacted]\nname=a',
        toolCallDetail: {
          toolCallId: 'call-1',
          toolName: 'Read',
          args: { file_path: '/p/.env' },
          result: 'SECRET=[redacted]\nname=a',
          isError: true,
        },
      },
    })
    expect(
      applyAppendRewrite(TOOL_RESULT, toolInput, {
        message: { content: [{ type: 'tool_result', tool_use_id: 'other', content: 'x' }] },
      }),
    ).toEqual({ refused: 'tool_result other is not one of the row\'s' })
  })

  it('a media block may be dropped or moved, not changed', () => {
    const row: StoredRow = {
      type: 'user',
      uuid: 'm1',
      message: {
        role: 'user',
        content: [
          { type: 'text', text: 'see' },
          { type: 'image', image: 'AAAA', mimeType: 'image/png' },
        ],
      },
    }
    const described = describeAppendRow(row)!
    const moved = applyAppendRewrite(row, described, {
      message: { content: [{ type: 'image', image: 'AAAA', mimeType: 'image/png' }, { type: 'text', text: 'see' }] },
    })
    expect(moved).toEqual({
      row: { ...row, message: { role: 'user', content: [{ type: 'image', image: 'AAAA', mimeType: 'image/png' }, { type: 'text', text: 'see' }] } },
    })
    // Dropped: a row whose content was parts keeps parts.
    expect(applyAppendRewrite(row, described, { message: { content: [{ type: 'text', text: 'see' }] } })).toEqual({
      row: { ...row, message: { role: 'user', content: [{ type: 'text', text: 'see' }] } },
    })
    // Relayed unchanged: the same object.
    expect(applyAppendRewrite(row, described, { message: { content: described.message.content } })).toEqual({ row })
    expect((applyAppendRewrite(row, described, { message: { content: described.message.content } }) as { row: unknown }).row).toBe(row)
    expect(
      applyAppendRewrite(row, described, {
        message: { content: [{ type: 'image', image: 'BBBB', mimeType: 'image/png' }] },
      }),
    ).toEqual({ refused: 'a image block was added or changed' })
  })

  it('of two blocks of a kind, the one the hook kept is the one put back', () => {
    const response: StoredRow = {
      type: 'assistant',
      uuid: 'a2',
      message: {
        role: 'assistant',
        content: [
          { type: 'tool-call', toolCallId: 'call-1', toolName: 'Read', args: { file_path: '/a' } },
          { type: 'tool-call', toolCallId: 'call-2', toolName: 'Read', args: { file_path: '/b' } },
        ],
      },
    }
    const described = describeAppendRow(response)!
    expect(applyAppendRewrite(response, described, { message: { content: [described.message.content[1]] } })).toEqual({
      row: { ...response, message: { role: 'assistant', content: [(response.message as { content: unknown[] }).content[1]] } },
    })
    const photos: StoredRow = {
      type: 'user',
      uuid: 'm2',
      message: {
        role: 'user',
        content: [
          { type: 'image', image: 'AAAA', mimeType: 'image/png' },
          { type: 'image', image: 'BBBB', mimeType: 'image/png' },
        ],
      },
    }
    const shown = describeAppendRow(photos)!
    expect(applyAppendRewrite(photos, shown, { message: { content: [shown.message.content[1]] } })).toEqual({
      row: { ...photos, message: { role: 'user', content: [{ type: 'image', image: 'BBBB', mimeType: 'image/png' }] } },
    })
  })

  it('a string prompt stays a string; a notice loses its translation when rewritten', () => {
    const promptInput = describeAppendRow(PROMPT)!
    expect(applyAppendRewrite(PROMPT, promptInput, { message: { content: [{ type: 'text', text: 'hello there' }] } })).toEqual({
      row: { ...PROMPT, message: { role: 'user', content: 'hello there' } },
    })
    const noticeInput = describeAppendRow(NOTICE)!
    expect(applyAppendRewrite(NOTICE, noticeInput, { message: { content: [{ type: 'text', text: 'Squashed.' }] } })).toEqual({
      row: { type: 'system', uuid: 's1', subtype: 'informational', message: 'Squashed.' },
    })
  })
})

describe('session.append through the runtime', () => {
  it('a hook on the tool-result door scrubs the result the model and the transcript read; a prompt passes untouched', async () => {
    const { runtime, reports } = world({
      'scrub/hooks/register.js': `
        export function register(on) {
          on('session.append', { door: 'tool-result' }, ($, e, next) => next({
            ...e,
            message: {
              ...e.message,
              content: e.message.content.map(block =>
                block.type === 'tool_result'
                  ? { ...block, content: block.content.replace(/SECRET=\\S+/g, 'SECRET=[redacted]') }
                  : block),
            },
          }))
        }
      `,
    })
    await runtime.ready
    expect(runtime.hasSessionAppendHooks()).toBe(true)
    const stored = await runtime.sessionAppend(TOOL_RESULT)
    expect(stored).toMatchObject({
      message: { content: [{ type: 'tool-result', toolCallId: 'call-1', result: 'SECRET=[redacted]\nname=a' }] },
      toolUseResult: 'SECRET=[redacted]\nname=a',
    })
    expect(await runtime.sessionAppend(PROMPT)).toBe(PROMPT)
    expect(reports).toEqual([])
  })

  it('what next(e) resolves to is the row as stored, with its uuid; the hook sees door, origin and uuid', async () => {
    const { runtime } = world({
      'watch/hooks/register.js': `
        export function register(on) {
          on('session.append', async ($, e, next) => {
            const stored = await next({ ...e, message: { ...e.message, content: [{ type: 'text', text: e.door + ' ' + e.origin.kind + ' ' + e.uuid }] } });
            await $.ui.log('stored ' + stored.uuid + ' ' + JSON.stringify(stored.message.content));
            return stored;
          });
        }
      `,
    })
    await runtime.ready
    const stored = await runtime.sessionAppend(PROMPT)
    expect(stored).toEqual({ ...PROMPT, message: { role: 'user', content: 'prompt composer u1' } })
  })

  it('a hook that answers without next, one that moves a pin, one that throws: the row is stored as made, and each is named', async () => {
    const { runtime, reports } = world({
      'quiet/hooks/register.js': `
        export function register(on) {
          on('session.append', { door: 'prompt' }, ($, e) => ({ message: e.message, uuid: e.uuid }));
          on('session.append', { door: 'command' }, ($, e, next) => next({ ...e, message: { ...e.message, role: 'assistant' } }));
          on('session.append', { door: 'notice' }, () => { throw new Error('no') });
        }
      `,
    })
    await runtime.ready
    expect(await runtime.sessionAppend(PROMPT)).toBe(PROMPT)
    expect(await runtime.sessionAppend(COMMAND)).toBe(COMMAND)
    expect(await runtime.sessionAppend(NOTICE)).toBe(NOTICE)
    expect(reports).toEqual([
      'mods: session.append (prompt): a hook answered without next; the row is stored as made',
      'mods: session.append (command): message.role is pinned; the row is stored as made',
      expect.stringMatching(/^quiet: session\.append .*no/),
    ])
  })

  it('a row the event does not describe, and a runtime without the hook, cost nothing', async () => {
    const { runtime } = world({
      'other/hooks/register.js': `export function register(on) { on('prompt.submit', ($, e, next) => next(e)) }`,
    })
    await runtime.ready
    expect(runtime.hasSessionAppendHooks()).toBe(false)
    expect(await runtime.sessionAppend(PROMPT)).toBe(PROMPT)
    const frame: StoredRow = { type: 'stream_event', uuid: 'e1' }
    expect(await runtime.sessionAppend(frame)).toBe(frame)
  })
})
