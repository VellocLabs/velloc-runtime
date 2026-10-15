/**
 * `session.send` and `session.receive` (F-25) through a real
 * `ModRuntime`: a message leaving for a teammate stamped, readdressed or
 * refused; a delivery rewritten or consumed as it reaches the session; the
 * pins; a failing hook leaving the message as it was. The engine's delivered
 * turn is `query-engine-mods.test.ts`.
 */
import { afterEach, describe, expect, it } from 'vitest'
import { ModRuntime, type ModModuleRef, type ModWorkerHandle } from '../mods/ModRuntime'
import { installModWorkerHost } from '../mods/ModWorkerHost'
import {
  isSessionReceiveResult,
  isSessionSendResult,
  promptTextOf,
  receiveInputProblem,
  sendInputProblem,
  withPromptText,
  type SessionSendInput,
} from '../mods/sessionMessageEvents'

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

const SEND: SessionSendInput = { to: 'reader', text: 'please start', origin: { kind: 'model' } }

describe('the shapes', () => {
  it('results and pins', () => {
    expect(isSessionSendResult({ isDelivered: true })).toBe(true)
    expect(isSessionSendResult({ isDelivered: false, reason: 'no' })).toBe(true)
    expect(isSessionSendResult({ isDelivered: false })).toBe(false)
    expect(isSessionReceiveResult({ text: 'x' })).toBe(true)
    expect(isSessionReceiveResult({ consumed: 'muted' })).toBe(true)
    expect(isSessionReceiveResult({ consumed: '' })).toBe(false)
    expect(sendInputProblem(SEND, { ...SEND, text: 'x', to: 'lead' })).toBeNull()
    expect(sendInputProblem(SEND, { ...SEND, origin: { kind: 'plugin', name: 'p' } })).toBe('origin is pinned')
    expect(sendInputProblem(SEND, { ...SEND, agentId: 'a' })).toBe('agentId is pinned')
    expect(sendInputProblem(SEND, { ...SEND, to: ' ' })).toBe('to is not a name')
    expect(sendInputProblem(SEND, { ...SEND, text: '' })).toBe('text is not a non-empty string')
    const receive = { origin: { kind: 'peer' as const }, text: 'hi' }
    expect(receiveInputProblem(receive, { ...receive, text: 'hello' })).toBeNull()
    expect(receiveInputProblem(receive, { ...receive, origin: { kind: 'task-notification' } })).toBe('origin is pinned')
    expect(receiveInputProblem(receive, { ...receive, text: 1 })).toBe('text is not a string')
  })

  it('the prompt text helpers: a string, text blocks joined; a rewrite keeps a string a string and places the text in the first text block', () => {
    expect(promptTextOf('hi')).toBe('hi')
    expect(promptTextOf([{ type: 'text', text: 'a' }, { type: 'image', image: 'x' }, { type: 'text', text: 'b' }])).toBe('ab')
    expect(withPromptText('hi', 'yo')).toBe('yo')
    expect(withPromptText([{ type: 'text', text: 'a' }, { type: 'image', image: 'x' }, { type: 'text', text: 'b' }], 'yo')).toEqual([
      { type: 'text', text: 'yo' },
      { type: 'image', image: 'x' },
    ])
    expect(withPromptText([{ type: 'image', image: 'x' }], 'yo')).toEqual([{ type: 'text', text: 'yo' }, { type: 'image', image: 'x' }])
  })
})

describe('session.send through the runtime', () => {
  it('a hook stamps the text and readdresses on the way down; core delivers what it is handed; next resolves what the messenger answered', async () => {
    const { runtime } = world({
      'stamp/hooks/register.js': `
        export function register(on) {
          on('session.send', async ($, e, next) => {
            const result = await next({ ...e, text: e.text + ' [stamped]', to: e.to === 'nobody' ? 'team-lead' : e.to });
            await $.ui.log('delivered=' + result.isDelivered + (result.reason ? ' ' + result.reason : ''));
            return result;
          });
        }
      `,
    })
    await runtime.ready
    expect(runtime.hasSessionSendHooks()).toBe(true)
    const delivered: Array<{ to: string; text: string }> = []
    const core = async (e: { to: string; text: string }) => {
      delivered.push(e)
      return e.to === 'team-lead' ? ({ isDelivered: false as const, reason: 'nobody by that name' }) : ({ isDelivered: true as const })
    }
    expect(await runtime.sessionSend(SEND, core)).toEqual({ isDelivered: true })
    expect(await runtime.sessionSend({ ...SEND, to: 'nobody' }, core)).toEqual({ isDelivered: false, reason: 'nobody by that name' })
    expect(delivered).toEqual([
      { to: 'reader', text: 'please start [stamped]' },
      { to: 'team-lead', text: 'please start [stamped]' },
    ])
  })

  it('a refusal without next delivers nothing; a pin moved or a throw delivers as typed, each named; no hook costs nothing', async () => {
    const { runtime, reports } = world({
      'guard/hooks/register.js': `
        export function register(on) {
          on('session.send', ($, e, next) => {
            if (/FORBIDDEN/.test(e.text)) return { isDelivered: false, reason: 'not that' };
            if (/PIN/.test(e.text)) return next({ ...e, origin: { kind: 'plugin', name: 'guard' } });
            if (/THROW/.test(e.text)) throw new Error('boom');
            return next(e);
          });
        }
      `,
    })
    await runtime.ready
    const delivered: string[] = []
    const core = async (e: { to: string; text: string }) => (delivered.push(e.text), { isDelivered: true as const })
    expect(await runtime.sessionSend({ ...SEND, text: 'FORBIDDEN x' }, core)).toEqual({ isDelivered: false, reason: 'not that' })
    expect(await runtime.sessionSend({ ...SEND, text: 'PIN x' }, core)).toEqual({ isDelivered: true })
    expect(await runtime.sessionSend({ ...SEND, text: 'THROW x' }, core)).toEqual({ isDelivered: true })
    expect(delivered).toEqual(['PIN x', 'THROW x'])
    expect(reports).toEqual([
      'mods: session.send (reader) failed: the rewritten event is refused: origin is pinned; the message is sent as typed',
      expect.stringMatching(/^guard: session\.send .*boom/),
    ])
  })

  it('a send aborted after core delivered it still answers delivered — the model must not send it twice', async () => {
    const { runtime } = world({
      'slow/hooks/register.js': `
        export function register(on) {
          on('session.send', async ($, e, next) => {
            const result = await next(e);
            await new Promise(resolve => setTimeout(resolve, 5_000));
            return result;
          });
        }
      `,
    })
    await runtime.ready
    const controller = new AbortController()
    const core = async () => {
      setTimeout(() => controller.abort(), 10)
      return { isDelivered: true as const }
    }
    expect(await runtime.sessionSend(SEND, core, controller.signal)).toEqual({ isDelivered: true })
  })
})

describe('session.receive through the runtime', () => {
  it('a hook rewrites a peer frame and consumes a muted one; a notification is not selected by its matcher', async () => {
    const { runtime, reports } = world({
      'inbox/hooks/register.js': `
        export function register(on) {
          on('session.receive', { origin: { kind: 'peer' } }, ($, e, next) => {
            if (/MUTE/.test(e.text)) return { consumed: 'muted by inbox' };
            return next({ ...e, text: e.text + ' [seen]' });
          });
        }
      `,
    })
    await runtime.ready
    expect(runtime.hasSessionReceiveHooks()).toBe(true)
    expect(await runtime.sessionReceive({ origin: { kind: 'peer' }, text: 'hello lead' })).toEqual({ text: 'hello lead [seen]' })
    expect(await runtime.sessionReceive({ origin: { kind: 'peer' }, text: 'MUTE me' })).toEqual({ consumed: 'muted by inbox' })
    expect(await runtime.sessionReceive({ origin: { kind: 'task-notification' }, text: '<task-notification/>' })).toEqual({
      text: '<task-notification/>',
    })
    expect(reports).toEqual(['mods: session.receive (peer) consumed by a hook: muted by inbox'])
  })

  it('a pin moved or a throw queues the delivery as it arrived, each named; no hook costs nothing', async () => {
    const { runtime, reports } = world({
      'bad/hooks/register.js': `
        export function register(on) {
          on('session.receive', ($, e, next) => /PIN/.test(e.text) ? next({ ...e, agentId: 'other' }) : (() => { throw new Error('boom') })());
        }
      `,
    })
    await runtime.ready
    expect(await runtime.sessionReceive({ origin: { kind: 'peer' }, text: 'PIN x' })).toEqual({ text: 'PIN x' })
    expect(await runtime.sessionReceive({ origin: { kind: 'peer' }, text: 'x' })).toEqual({ text: 'x' })
    expect(reports).toEqual([
      'mods: session.receive (peer) failed: the rewritten event is refused: agentId is pinned; the delivery is queued as it arrived',
      expect.stringMatching(/^bad: session\.receive .*boom/),
    ])
    const { runtime: quiet } = world({ 'q/hooks/register.js': `export function register(on) { on('prompt.submit', ($, e, next) => next(e)) }` })
    await quiet.ready
    expect(quiet.hasSessionReceiveHooks()).toBe(false)
    expect(await quiet.sessionReceive({ origin: { kind: 'peer' }, text: 'x' })).toEqual({ text: 'x' })
  })
})
